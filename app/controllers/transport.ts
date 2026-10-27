import crypto from 'node:crypto';
import { WebSocket } from 'ws';
import { PROTOCOL_VERSION, decodeClientMessage, utf8Bytes, type EffectiveLimits, type ServerMessage,
  type ClientMessage, type GapReason } from '@grotesqueries/protocol';
import type { SessionRegistry } from '../models/sessions.js';
import type { ControlLeases, Lease } from './control.js';
import type { InputDelivery } from './input.js';
import { SnapshotPump } from '../models/snapshot.js';

interface Feed {
  generation: number; sent: number; applied: number; ledger: Map<number, number>;
  snapshot?: SnapshotPump; capturing: boolean; retry: number; resumeTarget?: number;
}
const errorMessages: Record<string, string> = {
  PTY_PLATFORM_UNSUPPORTED: 'Native process supervision is unavailable on this system. Check the platform requirements and native helper build.',
  PTY_BOOTSTRAP_CLEANUP_UNVERIFIED: 'Startup failed before your program ran. A stopped bootstrap may remain; inspect the host before retrying.',
  LINUX_SUPERVISION_UNAVAILABLE: 'Linux requires child-subreaper support, procfs and pidfd signaling. Check the platform requirements.',
  CONTROL_BUSY: 'Another view controls this session. Release control there or wait for its connection to expire.',
  CONTROL_REQUIRED: 'Take control deliberately before sending new input.', CONTROL_EXPIRED: 'Control expired. Take control again.',
  ATTACHMENT_NOT_READY: 'Wait for terminal restoration to finish.', STOP_PENDING: 'Process cleanup is still pending.',
  PROCESS_EXITED: 'This process has exited.', SESSION_UNAVAILABLE: 'This session is unavailable. Start a configured profile deliberately.',
  PROFILE_UNAVAILABLE: 'Choose a configured launch profile.', SESSION_CAPACITY: 'Stop a running session before starting another.',
  JOB_NOT_INTERACTIVE: 'A job runs its fixed command to an exit or its bound; it takes no control, input or Stop.',
  INPUT_DELIVERY_UNCERTAIN: 'Input delivery is uncertain. Inspect the terminal; do not automatically resend.',
  INPUT_ID_GAP: 'Input IDs must advance contiguously within the current lease.',
  RESTORATION_LIMIT: 'Restoration exceeds maxSnapshotBytes. Increase that limit or reduce retained history, then restart.',
  TERMINAL_BRIDGE_FAILED: 'The terminal bridge failed. Stop this session deliberately and inspect its failure code.',
  INVALID_SNAPSHOT_CREDIT: 'Snapshot progress does not match a sent parsed chunk.',
  INVALID_STREAM_CREDIT: 'Applied sequence does not match this view’s sent stream.',
  VIEW_CAPACITY: 'This view has too much pending work. Reconcile its visible state before retrying.',
  STOP_FAILED: 'Owned process cleanup could not be verified. Inspect and retry Stop deliberately.',
};
export class ViewConnection {
  readonly id = crypto.randomUUID();
  private readonly feeds = new Map<string, Feed>();
  private readonly completed = new Map<number, ServerMessage>();
  private readonly pending = new Set<number>();
  private highWater = 0; private ready = false; private alive = true;
  private rendererBytes = 0; private queuedBytes = 0; private pendingBytes = 0; private pendingCount = 0; private malformed = 0;
  private lastHeartbeat = performance.now();
  private readonly started = performance.now();
  private readonly disposers: Array<() => void> = [];
  constructor(private readonly options: { socket: WebSocket; hostInstanceId: string; limits: EffectiveLimits;
    sessions: SessionRegistry; control: ControlLeases; input: InputDelivery; log: (code: string, viewId: string) => void;
    closed?: () => void }) {
    const { socket, sessions, control } = options;
    this.disposers.push(sessions.onChange(session => this.send({ type: 'session', session })),
      sessions.onRemoved(sessionId => { this.drop(sessionId); this.send({ type: 'inventory', sessions: sessions.list() }); }),
      sessions.onStream(sessionId => this.advance(sessionId)), control.onChange((sessionId, lease) => this.sendControl(sessionId, lease)));
    socket.on('message', (raw, binary) => this.receive(raw.toString(), binary));
    socket.on('pong', () => { this.lastHeartbeat = performance.now(); control.heartbeat(this.id); });
    socket.on('error', () => { options.log('SOCKET_FAILURE', this.id); this.close(); });
    socket.once('close', () => this.dispose());
    this.send({ type: 'hello', protocol: PROTOCOL_VERSION, hostInstanceId: options.hostInstanceId, viewId: this.id, limits: options.limits });
    this.send({ type: 'inventory', sessions: sessions.list() });
  }
  send(message: ServerMessage): boolean {
    if (!this.alive || this.options.socket.readyState !== WebSocket.OPEN) return false;
    const encoded = JSON.stringify(message); const bytes = utf8Bytes(encoded);
    if (bytes > this.options.limits.transport.maxFrameBytes || this.queuedBytes + this.options.socket.bufferedAmount + bytes > this.options.limits.transport.maxViewQueueBytes) {
      this.options.log('VIEW_QUEUE_OVERFLOW', this.id); this.close(1009, 'View queue limit'); return false;
    }
    this.queuedBytes += bytes;
    try { this.options.socket.send(encoded, error => {
      this.queuedBytes -= bytes; if (error) { this.close(); return; }
      for (const [sessionId, feed] of this.feeds) { if (feed.snapshot) feed.snapshot.pump(); else this.advance(sessionId); }
    }); }
    catch { this.queuedBytes -= bytes; this.close(); return false; }
    return true;
  }
  private reserve(bytes: number): boolean {
    if (this.rendererBytes + bytes > this.options.limits.transport.maxRendererBacklogBytes ||
      this.queuedBytes + this.options.socket.bufferedAmount + bytes > this.options.limits.transport.maxViewQueueBytes - 4096) return false;
    this.rendererBytes += bytes; return true;
  }
  private release(bytes: number): void { this.rendererBytes -= bytes; }
  private receive(raw: string, binary: boolean): void {
    if (!this.alive) return;
    let message: ClientMessage;
    try {
      if (binary || utf8Bytes(raw) > this.options.limits.transport.maxFrameBytes) throw new Error('INVALID_MESSAGE');
      message = decodeClientMessage(JSON.parse(raw), this.options.limits);
    } catch {
      this.send({ type: 'error', code: 'INVALID_MESSAGE', message: 'Use a valid bounded v2 protocol message.' });
      if (++this.malformed >= 8) this.close(1008, 'Invalid traffic'); return;
    }
    this.lastHeartbeat = performance.now(); this.options.control.heartbeat(this.id);
    const requestId = 'requestId' in message ? message.requestId : undefined;
    if (requestId !== undefined) {
      if (requestId <= this.highWater) {
        this.send(this.completed.get(requestId) ?? { type: 'error', requestId,
          code: this.pending.has(requestId) ? 'REQUEST_PENDING' : 'REQUEST_RESULT_UNAVAILABLE',
          message: this.pending.has(requestId) ? 'This request is still pending.' : 'This result was evicted; reconcile inventory without reissuing the operation.' }); return;
      }
      this.highWater = requestId; this.pending.add(requestId);
    }
    const bytes = utf8Bytes(raw);
    if (message.type !== 'release-control' && message.type !== 'detach' &&
      (this.pendingCount >= 32 || this.pendingBytes + bytes > this.options.limits.transport.maxViewQueueBytes)) {
      this.finish(message, this.failure(message, 'VIEW_CAPACITY')); return;
    }
    this.pendingCount++; this.pendingBytes += bytes;
    // Never await here: release/detach and socket revocation must bypass queued native work.
    let operation: Promise<ServerMessage | undefined>;
    try {
      const result = this.dispatch(message);
      if (!(result instanceof Promise)) { if (result) this.finish(message, result); this.pendingCount--; this.pendingBytes -= bytes; return; }
      operation = result;
    }
    catch (error) { operation = Promise.reject(error); }
    void operation.then(result => { if (result) this.finish(message, result); }, error => this.finish(message, this.failure(message, error)))
      .finally(() => { this.pendingCount--; this.pendingBytes -= bytes; });
  }
  private finish(message: ClientMessage, result: ServerMessage): void {
    if ('requestId' in message) {
      this.pending.delete(message.requestId); this.completed.set(message.requestId, result);
      while (this.completed.size > 64) this.completed.delete(this.completed.keys().next().value!);
    }
    this.send(result);
  }
  private failure(message: ClientMessage, error: unknown): ServerMessage {
    const proposed = typeof error === 'string' ? error : error instanceof Error ? error.message.split(':')[0] : '';
    const code = errorMessages[proposed] ? proposed : /^[A-Z][A-Z0-9_]{0,63}$/.test(proposed) &&
      /^INVALID_|^NOT_|^PROTOCOL_|^HOST_CLOSING|^SNAPSHOT_CANCELLED/.test(proposed) ? proposed : 'OPERATION_FAILED';
    this.options.log(code, this.id);
    return { type: 'error', code, message: errorMessages[code] ?? 'The operation failed. Reconcile the visible session state and retry deliberately.',
      ...('requestId' in message ? { requestId: message.requestId } : {}),
      ...('sessionId' in message ? { sessionId: message.sessionId } : {}),
      ...(message.type === 'input' ? { inputId: message.inputId, leaseId: message.leaseId } : {}) };
  }
  private dispatch(message: ClientMessage): ServerMessage | undefined | Promise<ServerMessage | undefined> {
    const { sessions, control, input } = this.options;
    const result = (operation: Extract<ServerMessage, { type: 'operation-result' }>['operation']): ServerMessage => ({
      type: 'operation-result', requestId: (message as { requestId: number }).requestId, operation,
      ...('sessionId' in message ? { sessionId: message.sessionId } : {}) });
    if (message.type === 'ready') {
      if (message.protocol !== PROTOCOL_VERSION || message.hostInstanceId !== this.options.hostInstanceId) throw new Error('PROTOCOL_MISMATCH');
      this.ready = true; return result('ready');
    }
    if (!this.ready) throw new Error('NOT_READY');
    if (message.type === 'ping') return { type: 'pong', requestId: message.requestId };
    if (message.type === 'start') return sessions.start(message.profileId, message.cols, message.rows).then(session => ({ type: 'start-result', requestId: message.requestId, session }));
    const record = sessions.require(message.sessionId);
    switch (message.type) {
      case 'attach': {
        if (this.feeds.has(message.sessionId)) { this.sendControl(message.sessionId, control.current(message.sessionId) ?? null); return result('attach'); }
        const attachment = control.attach(message.sessionId, this.id);
        const feed: Feed = { generation: attachment.generation, sent: 0, applied: 0, ledger: new Map(), capturing: false, retry: 0 };
        this.feeds.set(message.sessionId, feed);
        if (message.resume?.hostInstanceId === this.options.hostInstanceId && record.terminal.output.canResume(message.resume.sequence)) {
          feed.sent = feed.applied = message.resume.sequence; feed.resumeTarget = record.terminal.output.sequence;
          this.advance(message.sessionId);
          if (feed.applied >= feed.resumeTarget) { attachment.restored = true; feed.resumeTarget = undefined; }
          this.sendControl(message.sessionId, control.current(message.sessionId) ?? null); return result('attach');
        }
        return this.restore(message.sessionId).then(() => result('attach'));
      }
      case 'detach': this.drop(message.sessionId); control.detach(message.sessionId, this.id); return result('detach');
      case 'take-control': control.take(message.sessionId, this.id); return result('take-control');
      case 'release-control': control.release(message.sessionId, this.id, message.leaseId); return result('release-control');
      case 'input': return input.write(message.sessionId, this.id, message.leaseId, message.inputId, message.data)
        .then(disposition => ({ type: 'input-ack', sessionId: message.sessionId, leaseId: message.leaseId, inputId: message.inputId, disposition }));
      case 'resize': return input.resize(message.sessionId, this.id, message.leaseId, message.cols, message.rows).then(() => result('resize'));
      case 'stop': return input.stop(message.sessionId, this.id, message.leaseId).then(() => result('stop'));
      case 'resync': if (!this.feeds.has(message.sessionId)) throw new Error('ATTACHMENT_NOT_READY');
        return this.restore(message.sessionId, message.reason).then(() => result('resync'));
      case 'snapshot-applied': {
        const snapshot = this.feeds.get(message.sessionId)?.snapshot;
        if (!snapshot || snapshot.id !== message.snapshotId) throw new Error('INVALID_SNAPSHOT_CREDIT');
        snapshot.progress(message.chunkIndex, message.parsedBytes); return;
      }
      case 'applied': this.applied(message); return;
    }
  }
  private async restore(sessionId: string, reason?: GapReason, reportFailure = false): Promise<void> {
    const record = this.options.sessions.require(sessionId); const feed = this.feeds.get(sessionId);
    const attachment = record.views.get(this.id);
    if (!feed || !attachment) throw new Error('ATTACHMENT_NOT_READY');
    feed.snapshot?.cancel('replaced'); feed.snapshot = undefined;
    for (const cost of feed.ledger.values()) this.release(cost); feed.ledger.clear();
    attachment.restored = false; feed.capturing = true;
    const generation = ++feed.generation;
    try {
      const capture = await record.enqueue(() => record.terminal.capture());
      if (!this.alive || this.feeds.get(sessionId) !== feed || feed.generation !== generation) return;
      feed.capturing = false; feed.sent = feed.applied = capture.sequence;
      feed.snapshot = new SnapshotPump({ sessionId, snapshotId: crypto.randomUUID(), capture, limits: this.options.limits, reason,
        reserve: bytes => this.reserve(bytes), release: bytes => this.release(bytes), send: message => this.send(message) });
      feed.snapshot.pump();
    } catch (error) {
      if (this.alive && this.feeds.get(sessionId) === feed && feed.generation === generation) {
        feed.capturing = false; this.drop(sessionId); this.options.control.detach(sessionId, this.id);
        if (reportFailure) this.send({ type: 'error', sessionId, code: 'RESTORE_FAILED', message: 'Restoration failed. Attach again deliberately.' });
      }
      throw error;
    }
  }
  private applied(message: Extract<ClientMessage, { type: 'applied' }>): void {
    const feed = this.feeds.get(message.sessionId); if (!feed) throw new Error('INVALID_STREAM_CREDIT');
    const record = this.options.sessions.require(message.sessionId);
    if (message.snapshotId !== undefined) {
      const snapshot = feed.snapshot;
      if (!snapshot || snapshot.id !== message.snapshotId || !snapshot.ended || message.sequence !== snapshot.boundary) throw new Error('INVALID_STREAM_CREDIT');
      if (!record.terminal.output.canResume(snapshot.boundary)) { this.restart(message.sessionId); return; }
      feed.snapshot = undefined; record.views.get(this.id)!.restored = true;
      this.sendControl(message.sessionId, this.options.control.current(message.sessionId) ?? null);
    } else {
      if (feed.snapshot || feed.capturing || message.sequence < feed.applied || message.sequence > feed.sent ||
        (message.sequence !== feed.applied && !feed.ledger.has(message.sequence))) throw new Error('INVALID_STREAM_CREDIT');
      for (const [sequence, cost] of feed.ledger) if (sequence <= message.sequence) { this.release(cost); feed.ledger.delete(sequence); }
      feed.applied = message.sequence;
      if (feed.resumeTarget !== undefined && feed.applied >= feed.resumeTarget) { record.views.get(this.id)!.restored = true; feed.resumeTarget = undefined; }
    }
    this.advance(message.sessionId);
  }
  private advance(sessionId: string): void {
    if (!this.alive) return;
    const feed = this.feeds.get(sessionId); if (!feed || feed.capturing) return;
    const record = this.options.sessions.require(sessionId);
    if (feed.snapshot) {
      if (!record.terminal.output.canResume(feed.snapshot.boundary)) this.restart(sessionId);
      return;
    }
    const output = record.terminal.output;
    if (!output.canResume(feed.sent)) { this.restart(sessionId); return; }
    while (feed.sent < output.sequence) {
      // A credit-starved view examines one event, not copies of the whole replay.
      const event = output.next(feed.sent)!;
      const message: ServerMessage = { ...event, sessionId };
      const cost = utf8Bytes(JSON.stringify(message));
      if (feed.ledger.size >= 8192 || !this.reserve(cost)) return;
      feed.ledger.set(event.sequence, cost); feed.sent = event.sequence;
      if (!this.send(message)) return;
    }
  }
  private restart(sessionId: string): void {
    const feed = this.feeds.get(sessionId); if (!feed) return;
    feed.snapshot?.cancel('catch-up-gap'); feed.snapshot = undefined;
    if (++feed.retry > 2) {
      this.send({ type: 'error', sessionId, code: 'RESTORE_FAILED', message: 'This view could not keep up. Attach again deliberately; its process continues.' });
      this.drop(sessionId); this.options.control.detach(sessionId, this.id); return;
    }
    void this.restore(sessionId, 'slow-view', true).catch(() => {});
  }
  private sendControl(sessionId: string, lease: Lease | null): void {
    if (!this.feeds.has(sessionId)) return;
    this.send({ type: 'control', sessionId, controllerViewId: lease?.viewId ?? null,
      leaseId: lease?.viewId === this.id ? lease.id : null });
  }
  private drop(sessionId: string): void {
    const feed = this.feeds.get(sessionId); if (!feed) return;
    feed.generation++; feed.snapshot?.cancel('detached');
    for (const cost of feed.ledger.values()) this.release(cost);
    this.feeds.delete(sessionId);
  }
  tick(): void {
    if (!this.alive) return;
    const now = performance.now();
    if ((!this.ready && now - this.started > 10000) || now - this.lastHeartbeat > this.options.limits.control.timeoutMs) { this.close(1008, 'Connection timeout'); return; }
    for (const [sessionId, feed] of this.feeds) if (feed.snapshot && (now - feed.snapshot.lastProgress > 10000 || now - feed.snapshot.started > 30000)) {
      feed.snapshot.cancel('timeout'); this.send({ type: 'error', sessionId, code: 'RESTORE_TIMEOUT', message: 'Restoration stalled. Attach again deliberately; its process continues.' });
      this.drop(sessionId); this.options.control.detach(sessionId, this.id);
    }
    try { this.options.socket.ping(); } catch { this.close(); }
  }
  close(code = 1011, reason = 'View connection failed'): void {
    this.dispose();
    try { this.options.socket.close(code, reason); this.options.socket.terminate(); } catch { /* Owned socket only. */ }
  }
  private dispose(): void {
    if (!this.alive) return; this.alive = false;
    for (const sessionId of [...this.feeds.keys()]) this.drop(sessionId);
    this.options.control.disconnect(this.id); for (const dispose of this.disposers.splice(0)) dispose();
    this.completed.clear(); this.options.closed?.();
  }
  get accounting(): { rendererBytes: number; queuedBytes: number; pendingBytes: number; pendingCount: number } {
    return { rendererBytes: this.rendererBytes, queuedBytes: this.queuedBytes, pendingBytes: this.pendingBytes, pendingCount: this.pendingCount };
  }
  get connected(): boolean { return this.alive; }
}
