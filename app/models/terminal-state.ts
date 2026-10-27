import { Terminal } from '@xterm/headless';
import { SerializeAddon } from '@xterm/addon-serialize';
import { utf8Bytes, utf8Chunks, type EffectiveLimits } from '@grotesqueries/protocol';
import { serializeSupplement, pinnedCore } from '../../lib/protocol/src/terminal-state-adapter.js';
import { TerminalStream } from '../services/terminal-stream.js';
import { TerminalReplyBridge } from '../services/terminal-replies.js';
import { OutputBuffer, type StreamEvent } from './output-buffer.js';
import { Unicode11Addon } from '@xterm/addon-unicode11';

export interface TerminalCapture { cols: number; rows: number; sequence: number; data: string; historyIncomplete: boolean }
export class TerminalState {
  readonly output: OutputBuffer;
  private readonly terminal: Terminal;
  private readonly serializer = new SerializeAddon();
  private readonly stream: TerminalStream;
  private readonly replies: TerminalReplyBridge;
  private readonly listeners = new Set<(event: StreamEvent) => void>();
  private queue: Promise<void> = Promise.resolve();
  private historyIncomplete = false;
  private disposed = false;
  constructor(private readonly options: { cols: number; rows: number; scrollback: number; limits: EffectiveLimits;
    reply?: (data: string) => void; isRunning?: () => boolean; observerFailure?: () => void }) {
    this.terminal = new Terminal({ cols: options.cols, rows: options.rows, scrollback: options.scrollback,
      allowProposedApi: true, logLevel: 'off', windowOptions: { getWinSizeChars: true, pushTitle: true, popTitle: true } });
    this.terminal.loadAddon(new Unicode11Addon() as unknown as Parameters<Terminal['loadAddon']>[0]);
    this.terminal.unicode.activeVersion = '11';
    this.terminal.loadAddon(this.serializer as unknown as Parameters<Terminal['loadAddon']>[0]);
    const core = pinnedCore(this.terminal);
    this.stream = new TerminalStream(options.limits.terminal.maxIncompleteSequenceBytes, core._inputHandler._parser._transitions.table);
    this.output = new OutputBuffer(options.limits.terminal.recentOutputBytes);
    this.replies = new TerminalReplyBridge(this.terminal, options.reply, options.isRunning);
    let lines: unknown; let trim: { dispose(): void } | undefined;
    const trackHistory = () => {
      const current = core._bufferService.buffers.normal.lines;
      if (current === lines) return;
      trim?.dispose(); lines = current; trim = current.onTrim(() => { this.historyIncomplete = true; });
    };
    trackHistory();
    const activate = core._bufferService.buffers.onBufferActivate(trackHistory);
    const resize = this.terminal.onResize(trackHistory);
    this.trim = () => { trim?.dispose(); activate.dispose(); resize.dispose(); };
  }
  private readonly trim: () => void;
  onCommit(listener: (event: StreamEvent) => void): () => void { this.listeners.add(listener); return () => { this.listeners.delete(listener); }; }
  queryAccounting(): { count: number; sha256: string } { return this.replies.accounting(); }
  private enqueue<T>(operation: () => Promise<T> | T): Promise<T> {
    const work = this.queue.then(() => { if (this.disposed) throw new Error('TERMINAL_DISPOSED'); return operation(); });
    this.queue = work.then(() => {}, () => {}); return work;
  }
  private commit(value: Parameters<OutputBuffer['append']>[0]): void {
    const event = this.output.append(value);
    if (this.historyIncomplete || this.output.historyIncomplete) event.historyIncomplete = true;
    for (const listener of this.listeners) { try { listener(event); } catch { this.options.observerFailure?.(); } }
  }
  applyOutput(data: string, origin: 'live-pty' | 'replay'): Promise<void> {
    return this.enqueue(async () => {
      const complete = this.stream.push(data); if (!complete) return;
      this.replies.begin(origin);
      await new Promise<void>(resolve => this.terminal.write(complete, resolve));
      this.replies.flush();
      for (const part of utf8Chunks(complete, Math.min(16384, Math.floor(this.options.limits.transport.maxFrameBytes / 8)))) this.commit({ type: 'output', data: part });
    });
  }
  resize(cols: number, rows: number, before?: () => void): Promise<void> {
    return this.enqueue(() => { before?.(); this.terminal.resize(cols, rows); this.commit({ type: 'grid', cols, rows }); });
  }
  capture(): Promise<TerminalCapture> {
    return this.enqueue(() => {
      const data = this.serializer.serialize() + this.replies.serializeColors() + serializeSupplement(this.terminal);
      if (utf8Bytes(data) > this.options.limits.transport.maxSnapshotBytes) throw new Error('RESTORATION_LIMIT: Increase maxSnapshotBytes or reduce retained terminal history.');
      return { cols: this.terminal.cols, rows: this.terminal.rows, sequence: this.output.sequence, data,
        historyIncomplete: this.historyIncomplete || this.output.historyIncomplete };
    });
  }
  dispose(): void { if (this.disposed) return; this.disposed = true; this.trim(); this.replies.dispose(); this.terminal.dispose(); this.listeners.clear(); }
}
