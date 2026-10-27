import { utf8Bytes, type EffectiveLimits, type ServerMessage, type ClientMessage, type GapReason, type ViewMode } from '@grotesqueries/protocol';
import { TerminalView } from './view.js';
type RenderMessage = Extract<ServerMessage, { type: 'output' | 'grid' | 'snapshot-begin' | 'snapshot-chunk' | 'snapshot-end' | 'snapshot-cancel' }>;

/** Parser-callback completion is the only source of rendered stream credit. */
export class TerminalStreamView {
  private terminal: TerminalView;
  private generation = 0; private queue = Promise.resolve(); private backlog = 0;
  private snapshot?: { id: string; sequence: number; count: number; bytes: number; received: number; parsed: number; parsedCount: number };
  private applied = 0; private received = 0; private usable = false; private mode: ViewMode = 'observing';
  private accessibility = false;
  historyIncomplete = false; historyReason: GapReason | null = null;
  constructor(private readonly container: HTMLElement, private readonly options: { sessionId: string; cols: number; rows: number; fixedCols?: number; limits: EffectiveLimits;
    send: (message: ClientMessage) => void; resync: (reason: GapReason) => void; changed: () => void;
    input: (data: string) => void; resize: (cols: number, rows: number) => void; problem: (message: string) => void }) {
    this.terminal = this.create(options.cols, options.rows);
  }
  private create(cols: number, rows: number): TerminalView {
    this.container.replaceChildren();
    const view = new TerminalView(this.container, { cols, rows, fixedCols: this.options.fixedCols, scrollback: this.options.limits.terminal.scrollbackLines,
      onInput: this.options.input, onResize: this.options.resize, problem: this.options.problem });
    view.setAccessibility(this.accessibility); return view;
  }
  accept(message: RenderMessage): void {
    if (message.sessionId !== this.options.sessionId) return;
    if (message.type === 'snapshot-begin') {
      this.generation++; this.queue = Promise.resolve(); this.backlog = 0; this.usable = false;
      this.terminal.dispose(); this.terminal = this.create(message.cols, message.rows); this.terminal.beginRestore();
      this.snapshot = { id: message.snapshotId, sequence: message.sequence, count: message.chunkCount, bytes: message.totalBytes, received: 0, parsed: 0, parsedCount: 0 };
      this.applied = this.received = message.sequence; this.historyIncomplete = message.historyIncomplete; this.historyReason = message.historyGapReason;
      this.options.changed(); return;
    }
    if (message.type === 'snapshot-cancel') {
      if (this.snapshot?.id === message.snapshotId) { this.freeze(); this.options.problem('Terminal restoration was cancelled. Retry attachment deliberately.'); }
      return;
    }
    const generation = this.generation; const snapshot = this.snapshot;
    if (message.type === 'snapshot-chunk') {
      if (!snapshot || message.snapshotId !== snapshot.id) return;
      if (message.index !== snapshot.received || message.index >= snapshot.count) { this.fail('sequence-gap'); return; }
      snapshot.received++;
    } else if (message.type === 'snapshot-end') {
      if (!snapshot || message.snapshotId !== snapshot.id) return;
    } else {
      if (!this.usable || snapshot) { this.fail('sequence-gap'); return; }
      if (message.sequence <= this.applied) return;
      if (message.sequence !== this.received + 1) { this.fail('sequence-gap'); return; }
      this.received = message.sequence;
    }
    const cost = utf8Bytes(JSON.stringify(message));
    if (this.backlog + cost > this.options.limits.transport.maxRendererBacklogBytes) { this.fail('renderer-overflow'); return; }
    this.backlog += cost;
    this.queue = this.queue.then(async () => {
      if (generation !== this.generation) return;
      if (message.type === 'snapshot-chunk') {
        await this.terminal.write(message.data); if (generation !== this.generation) return;
        snapshot!.parsed += utf8Bytes(message.data); snapshot!.parsedCount++;
        if (snapshot!.parsed > snapshot!.bytes) throw new Error('Snapshot byte overflow');
        this.options.send({ type: 'snapshot-applied', sessionId: message.sessionId, snapshotId: message.snapshotId,
          chunkIndex: message.index, parsedBytes: snapshot!.parsed });
      } else if (message.type === 'snapshot-end') {
        if (snapshot!.parsedCount !== snapshot!.count || snapshot!.parsed !== snapshot!.bytes || message.sequence !== snapshot!.sequence) throw new Error('Incomplete snapshot');
        this.terminal.completeRestore(); this.snapshot = undefined; this.usable = true;
        this.options.send({ type: 'applied', sessionId: message.sessionId, snapshotId: message.snapshotId, sequence: message.sequence });
        this.setMode(this.mode); this.options.changed();
      } else {
        if (message.type === 'output') await this.terminal.write(message.data);
        else if (message.type === 'grid') this.terminal.setGrid(message.cols, message.rows);
        if (generation !== this.generation) return;
        if (message.historyIncomplete && !this.historyIncomplete) { this.historyIncomplete = true; this.options.changed(); }
        this.applied = message.sequence; this.options.send({ type: 'applied', sessionId: message.sessionId, sequence: message.sequence });
      }
    }).catch(() => { if (generation === this.generation) this.fail('sequence-gap'); }).finally(() => { if (generation === this.generation) this.backlog -= cost; });
  }
  private fail(reason: GapReason): void { this.freeze(); this.options.problem('Terminal stream needs restoration. Input is paused.'); this.options.resync(reason); }
  freeze(): void { this.generation++; this.usable = false; this.snapshot = undefined; this.backlog = 0; this.terminal.setMode('observing'); this.options.changed(); }
  setMode(mode: ViewMode): void { this.mode = mode; this.terminal.setMode(this.usable ? mode : 'observing'); }
  setAccessibility(enabled: boolean): void { this.accessibility = enabled; this.terminal.setAccessibility(enabled); }
  get ready(): boolean { return this.usable; }
  get sequence(): number { return this.applied; }
  focus(): void { this.terminal.focus(); }
  copy(): Promise<void> { return this.terminal.copy(); }
  paste(): Promise<void> { return this.terminal.paste(); }
  dispose(): void { this.freeze(); this.terminal.dispose(); }
}
