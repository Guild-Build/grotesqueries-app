import crypto from 'node:crypto';
import { nativeStopFailure } from '../../lib/local-web/native-command-diagnostics.mjs';
import { utf8Bytes, type SessionSummary } from '@grotesqueries/protocol';
import { revalidateProfile, type Config } from '../../config/application.js';
import type { DiagnosticLogger } from '../services/diagnostics.js';
import type { PtyHandle, PtyLauncher, StopResult } from '../services/pty.js';
import { TerminalState } from './terminal-state.js';
import type { StreamEvent } from './output-buffer.js';

export interface Attachment {
  generation: number; restored: boolean; live: boolean; lastHeartbeat: number;
}

export class SessionRecord {
  readonly views = new Map<string, Attachment>();
  readonly disposers: Array<() => void> = [];
  job = false;
  jobOutputBytes = 0;
  jobTimer?: ReturnType<typeof setTimeout>;
  jobEnd?: 'JOB_TIMEOUT' | 'JOB_OUTPUT_LIMIT';
  nativeRunning = true;
  processGeneration = 1;
  queuedBytes = 0;
  bridgeFailed = false;
  cleanupRequired = false;
  exitOrder = 0;
  stopOperation?: Promise<StopResult>;
  outputHandler?: (data: string) => Promise<void>;
  private queue: Promise<void> = Promise.resolve();
  private outputBatch?: { parts: string[]; bytes: number; completion: Promise<void> };
  constructor(readonly metadata: SessionSummary, readonly pty: PtyHandle, readonly terminal: TerminalState) {}
  summary(): SessionSummary { return { ...this.metadata, attachedViews: this.views.size }; }
  enqueue<T>(operation: () => Promise<T> | T): Promise<T> {
    // Every mutation/capture/exit is a barrier to native-output coalescing.
    this.outputBatch = undefined;
    const pending = this.queue.then(operation);
    this.queue = pending.then(() => {}, () => {});
    return pending;
  }
  enqueueOutput(data: string, apply: (parts: readonly string[]) => Promise<void>): Promise<void> {
    const bytes = utf8Bytes(data); const previous = this.outputBatch;
    if (previous && previous.bytes + bytes <= 65536) {
      previous.parts.push(data); previous.bytes += bytes; return previous.completion;
    }
    const batch = { parts: [data], bytes, completion: Promise.resolve() };
    batch.completion = this.enqueue(() => {
      if (this.outputBatch === batch) this.outputBatch = undefined;
      return apply(batch.parts);
    });
    this.outputBatch = batch; return batch.completion;
  }
  drain(): Promise<void> { return this.queue; }
  dispose(): void { for (const dispose of this.disposers.splice(0)) dispose(); this.terminal.dispose(); }
}

/** Only deliberate start calls the injected native launcher. Views never own PTYs. */
export class SessionRegistry {
  queryAccounting(): Array<{ sessionId: string; count: number; sha256: string }> {
    return [...this.sessions.values()].map(record => ({ sessionId: record.metadata.id, ...record.terminal.queryAccounting() }));
  }
  private readonly sessions = new Map<string, SessionRecord>();
  private readonly changes = new Set<(session: SessionSummary) => void>();
  private readonly outputs = new Set<(sessionId: string, data: string) => void>();
  private readonly exits = new Set<(sessionId: string) => void>();
  private readonly streams = new Set<(sessionId: string, event: StreamEvent) => void>();
  private readonly removals = new Set<(sessionId: string) => void>();
  private readonly pendingStarts = new Set<Promise<SessionSummary>>();
  private reservations = 0;
  private closing = false;
  private exitCounter = 0;
  private shutdownOperation?: Promise<void>;
  private diagnosticHostInstanceId?: string;
  bindDiagnosticHost(hostInstanceId: string): void {
    if (this.diagnosticHostInstanceId !== undefined && this.diagnosticHostInstanceId !== hostInstanceId) throw new Error('SESSION_HOST_ALREADY_BOUND');
    this.diagnosticHostInstanceId = hostInstanceId;
  }
  constructor(private readonly options: { config?: Config; launcher?: PtyLauncher;
    diagnostics?: Pick<DiagnosticLogger, 'log'>; now?: () => Date; id?: () => string;
    shutdownTimeoutMs?: number; jobs?: ReadonlySet<string>; jobLimits?: Config['jobs']; jobStopRetryMs?: number } = {}) {}

  list(): SessionSummary[] { return [...this.sessions.values()].map(record => record.summary()); }
  /** New launches capture this snapshot; live and in-flight sessions retain their own limits/profile. */
  updateConfiguration(config: Config): void { this.options.config = config; }
  find(id: string): SessionSummary | undefined { return this.sessions.get(id)?.summary(); }
  require(id: string): SessionRecord {
    const record = this.sessions.get(id);
    if (!record) throw new Error('SESSION_UNAVAILABLE: That session is unavailable.');
    return record;
  }
  onChange(callback: (session: SessionSummary) => void): () => void { this.changes.add(callback); return () => { this.changes.delete(callback); }; }
  onOutput(callback: (sessionId: string, data: string) => void): () => void { this.outputs.add(callback); return () => { this.outputs.delete(callback); }; }
  onNativeExit(callback: (sessionId: string) => void): () => void { this.exits.add(callback); return () => { this.exits.delete(callback); }; }
  onStream(callback: (sessionId: string, event: StreamEvent) => void): () => void { this.streams.add(callback); return () => { this.streams.delete(callback); }; }
  onRemoved(callback: (sessionId: string) => void): () => void { this.removals.add(callback); return () => { this.removals.delete(callback); }; }
  changed(record: SessionRecord): void {
    for (const callback of this.changes) { try { callback(record.summary()); } catch { this.log('bridge-error', { sessionId: record.metadata.id, code: 'SUBSCRIBER_FAILED' }); } }
  }
  start(profileId: string, cols: number, rows: number): Promise<SessionSummary> {
    const operation = this.launch(profileId, cols, rows);
    this.pendingStarts.add(operation);
    void operation.then(() => this.pendingStarts.delete(operation), () => this.pendingStarts.delete(operation));
    return operation;
  }
  private async launch(profileId: string, cols: number, rows: number): Promise<SessionSummary> {
    if (this.closing) throw new Error('HOST_CLOSING');
    const { config, launcher } = this.options;
    if (!config || !launcher) throw new Error('LAUNCH_NOT_CONFIGURED');
    const configured = config.launchProfiles.find(profile => profile.id === profileId);
    if (!configured) throw new Error('PROFILE_UNAVAILABLE: Choose a configured launch profile.');
    if (!Number.isSafeInteger(cols) || cols < 2 || cols > 300 || !Number.isSafeInteger(rows) || rows < 1 || rows > 200) throw new Error('INVALID_GRID');
    if ([...this.sessions.values()].filter(record => record.metadata.processState === 'running' || record.metadata.stopPending ||
      record.cleanupRequired).length + this.reservations >= config.capacity.maxRunningSessions) throw new Error('SESSION_CAPACITY: Stop a running session or retry failed cleanup before starting another.');
    const profile = revalidateProfile(configured, config);
    cols = profile.columns ?? cols;
    const id = (this.options.id ?? crypto.randomUUID)();
    this.reservations++;
    let pty: PtyHandle;
    try { pty = await launcher.start(profile, cols, rows, id); }
    finally { this.reservations--; }
    let record: SessionRecord;
    const terminal = new TerminalState({ cols, rows, scrollback: config.terminal.scrollbackLines, limits: config,
      reply: data => pty.write(data), isRunning: () => record.nativeRunning && !record.metadata.stopPending,
      observerFailure: () => this.log('bridge-error', { sessionId: id, code: 'OUTPUT_SUBSCRIBER_FAILED' }) });
    record = new SessionRecord({ id, label: profile.label, projectDirectory: profile.projectDirectory,
      profileId, createdAt: (this.options.now?.() ?? new Date()).toISOString(), processState: 'running',
      attachedViews: 0, controllerViewId: null, cols, rows, exitCode: null, agentState: 'unknown',
      providerConversationId: null, stopPending: false, failureCode: pty.cleanupScope ? 'CLEANUP_SCOPE_LIMITED' : null, scrollbackLines: config.terminal.scrollbackLines,
      ...(profile.columns === undefined ? {} : { fixedCols: profile.columns }) }, pty, terminal);
    record.outputHandler = data => terminal.applyOutput(data, 'live-pty');
    record.disposers.push(terminal.onCommit(event => {
      for (const callback of this.streams) {
        try { callback(id, event); } catch { this.log('bridge-error', { sessionId: id, code: 'OUTPUT_SUBSCRIBER_FAILED' }); }
      }
    }));
    this.sessions.set(id, record);
    this.log('session-start', { sessionId: id, profileId });
    // The configured bounds (`jobs`); a test may pass its own.
    const jobLimits = this.options.jobLimits ?? config.jobs;
    if (this.options.jobs?.has(profileId)) {
      record.job = true;
      record.jobTimer = setTimeout(() => this.endJob(record, 'JOB_TIMEOUT'), jobLimits.timeoutMs);
    }
    record.disposers.push(pty.onOutput(data => {
      if (!data || record.bridgeFailed) return;
      const bytes = utf8Bytes(data);
      if (record.job && (record.jobOutputBytes += bytes) > jobLimits.outputBytes) { this.endJob(record, 'JOB_OUTPUT_LIMIT'); return; }
      if (record.queuedBytes + bytes > 4 * 1024 * 1024) {
        record.bridgeFailed = true;
        if (!record.cleanupRequired) record.metadata.failureCode = 'PARSER_BACKLOG_OVERFLOW';
        pty.pause(); this.changed(record);
        this.log('bridge-error', { sessionId: id, code: 'PARSER_BACKLOG_OVERFLOW' }); return;
      }
      record.queuedBytes += bytes;
      if (record.queuedBytes >= 2 * 1024 * 1024) pty.pause();
      void record.enqueueOutput(data, async parts => {
        try {
          await record.outputHandler?.(parts.join(''));
          for (const part of parts) for (const callback of this.outputs) {
            try { callback(id, part); }
            catch { this.log('bridge-error', { sessionId: id, code: 'OUTPUT_SUBSCRIBER_FAILED' }); }
          }
        } finally {
          record.queuedBytes -= parts.reduce((sum, part) => sum + utf8Bytes(part), 0);
          if (record.queuedBytes < 512 * 1024 && !record.bridgeFailed && record.nativeRunning) pty.resume();
        }
      }).catch(() => {
        record.bridgeFailed = true; pty.pause();
        // Cleanup ownership is separate from parser state; its recovery message has priority until verified success.
        if (!record.cleanupRequired) record.metadata.failureCode = 'TERMINAL_BRIDGE_FAILED';
        this.changed(record); this.log('bridge-error', { sessionId: id, code: 'TERMINAL_BRIDGE_FAILED' });
      });
    }));
    record.disposers.push(pty.onExit((exitCode, cleanupRequired) => {
      if (!record.nativeRunning) return;
      record.nativeRunning = false; record.processGeneration++; clearTimeout(record.jobTimer);
      // Root exit does not prove that its owned descendants exited. Keep their record and capacity.
      if (cleanupRequired) { record.cleanupRequired = true; record.metadata.failureCode = 'STOP_FAILED'; }
      record.exitOrder = ++this.exitCounter;
      for (const callback of this.exits) { try { callback(id); } catch { this.log('bridge-error', { sessionId: id, code: 'EXIT_SUBSCRIBER_FAILED' }); } }
      void record.enqueue(() => {
        record.metadata.processState = 'exited'; record.metadata.exitCode = exitCode;
        record.metadata.controllerViewId = null;
        this.changed(record); this.log('session-exit', { sessionId: id, exitCode }); this.evictExited();
      });
      // Jobs have no human Stop control. Their descendants still need host-owned cleanup after the primary exits.
      if (record.job && cleanupRequired && !record.stopOperation && !this.closing) queueMicrotask(() => this.stopJob(record));
    }));
    await record.drain();
    this.changed(record);
    if (this.closing) { await this.stop(id); throw new Error('HOST_CLOSING'); }
    return record.summary();
  }

  stop(id: string): Promise<StopResult> {
    const record = this.require(id);
    if (record.stopOperation) return record.stopOperation;
    record.cleanupRequired = true; record.metadata.stopPending = true; this.changed(record);
    const operation = record.pty.stop().then(async result => {
      await record.drain(); record.cleanupRequired = false; record.metadata.stopPending = false;
      record.metadata.failureCode = record.bridgeFailed ? 'TERMINAL_BRIDGE_FAILED' : record.jobEnd ??
        (result.cleanupScope === 'tracked-descendants' ? 'CLEANUP_SCOPE_LIMITED' : null);
      this.changed(record); this.evictExited(); return result;
    }, error => {
      record.metadata.stopPending = false; record.metadata.failureCode = 'STOP_FAILED';
      record.stopOperation = undefined; this.changed(record);
      this.log('pty-error', { sessionId: id, code: 'STOP_FAILED', nativeFailure: nativeStopFailure(error) }); throw error;
    });
    record.stopOperation = operation;
    return operation;
  }
  private endJob(record: SessionRecord, code: 'JOB_TIMEOUT' | 'JOB_OUTPUT_LIMIT'): void {
    // Set before stop: a PTY may emit its last output while stopping, and that output must not re-enter here.
    if (!record.nativeRunning || record.jobEnd || record.stopOperation) return;
    // The code is set before stop, so no summary reports this exit without it; a failed bridge keeps its own code.
    record.jobEnd = code; if (!record.bridgeFailed) record.metadata.failureCode = code; clearTimeout(record.jobTimer);
    this.log('pty-error', { sessionId: record.metadata.id, code });
    this.stopJob(record);
  }
  /**
   * No view may Stop a job, so failed cleanup is retried until the process and its owned descendants have exited.
   * The wait doubles after each failure, up to a minute, so a stop that keeps failing cannot flood the bounded log.
   */
  private stopJob(record: SessionRecord, wait = this.options.jobStopRetryMs ?? 1000): void {
    void this.stop(record.metadata.id).catch(() => {
      if ((record.nativeRunning || record.cleanupRequired) && !this.closing) record.jobTimer = setTimeout(() => this.stopJob(record, Math.min(wait * 2, 60000)), wait);
    });
  }
  shutdown(): Promise<void> {
    if (this.shutdownOperation) return this.shutdownOperation;
    this.closing = true;
    const cleanup = (async () => {
      await Promise.allSettled([...this.pendingStarts]);
      const results = await Promise.allSettled([...this.sessions.values()].map(record => this.stop(record.metadata.id)));
      if (results.some(result => result.status === 'rejected')) throw new Error('HOST_SHUTDOWN_FAILED: Owned process cleanup could not be verified.');
      for (const record of this.sessions.values()) record.dispose();
    })();
    let timer: ReturnType<typeof setTimeout>;
    const deadline = new Promise<void>((_resolve, reject) => {
      timer = setTimeout(() => reject(new Error('HOST_SHUTDOWN_TIMEOUT: Owned cleanup has not completed; preserve the failure evidence.')),
        this.options.shutdownTimeoutMs ?? 30000);
    });
    this.shutdownOperation = Promise.race([cleanup, deadline]).finally(() => clearTimeout(timer));
    return this.shutdownOperation;
  }
  async forget(id: string): Promise<void> {
    const record = this.require(id);
    await record.enqueue(() => {
      if (record.nativeRunning || record.metadata.processState !== 'exited' || record.metadata.stopPending || record.cleanupRequired)
        throw new Error('SESSION_NOT_FINISHED: Stop the process and finish cleanup before forgetting it.');
      if (this.sessions.get(id) !== record) return;
      this.remove(record);
    });
  }
  private remove(record: SessionRecord): void {
    this.sessions.delete(record.metadata.id);
    for (const callback of this.removals) { try { callback(record.metadata.id); } catch { this.log('bridge-error', { code: 'SUBSCRIBER_FAILED' }); } }
    record.dispose();
  }
  private evictExited(): void {
    const exited = [...this.sessions.values()].filter(record => record.metadata.processState === 'exited' && !record.metadata.stopPending && !record.cleanupRequired)
      .sort((left, right) => left.exitOrder - right.exitOrder);
    const maximum = this.options.config?.capacity.retainedExitedSessions ?? 8;
    while (exited.length > maximum) {
      this.remove(exited.shift()!);
    }
  }
  private log(event: Parameters<DiagnosticLogger['log']>[0], fields: Record<string, unknown>): void {
    try { this.options.diagnostics?.log(event, { ...fields, ...(this.diagnosticHostInstanceId ? { hostInstanceId: this.diagnosticHostInstanceId } : {}) }); } catch { console.error('DIAGNOSTICS_WRITE_FAILED'); }
  }
}
