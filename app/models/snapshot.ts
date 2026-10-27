import { utf8Bytes, utf8Chunks, type EffectiveLimits, type ServerMessage, type GapReason, type CancelReason } from '@grotesqueries/protocol';
import type { TerminalCapture } from './terminal-state.js';

/** One immutable restoration. Credit never crosses its ID/generation boundary. */
export class SnapshotPump {
  readonly id: string;
  readonly boundary: number;
  readonly started: number;
  lastProgress: number;
  ended = false; cancelled = false;
  private chunks: string[];
  private sent = 0; private acked = -1; private prefix = 0;
  private readonly records = new Map<number, { prefix: number; cost: number }>();
  constructor(private readonly options: { sessionId: string; snapshotId: string; capture: TerminalCapture;
    limits: EffectiveLimits; reason?: GapReason; now?: () => number;
    reserve: (bytes: number) => boolean; release: (bytes: number) => void; send: (message: ServerMessage) => boolean }) {
    this.id = options.snapshotId; this.boundary = options.capture.sequence;
    this.started = this.lastProgress = options.now?.() ?? performance.now();
    this.chunks = utf8Chunks(options.capture.data, Math.min(16384, Math.floor(options.limits.transport.maxFrameBytes / 8)));
    options.send({ type: 'snapshot-begin', sessionId: options.sessionId, snapshotId: this.id,
      sequence: this.boundary, cols: options.capture.cols, rows: options.capture.rows,
      totalBytes: utf8Bytes(options.capture.data), chunkCount: this.chunks.length,
      historyIncomplete: options.capture.historyIncomplete,
      historyGapReason: options.reason ?? (options.capture.historyIncomplete ? 'history-evicted' : null) });
  }
  pump(): void {
    if (this.cancelled || this.ended) return;
    while (this.sent < this.chunks.length) {
      const data = this.chunks[this.sent];
      const message: ServerMessage = { type: 'snapshot-chunk', sessionId: this.options.sessionId, snapshotId: this.id, index: this.sent, data };
      const cost = utf8Bytes(JSON.stringify(message));
      if (!this.options.reserve(cost)) return;
      this.prefix += utf8Bytes(data); this.records.set(this.sent, { prefix: this.prefix, cost }); this.sent++;
      if (!this.options.send(message)) { this.cancel('overflow'); return; }
    }
    if (this.acked === this.chunks.length - 1) {
      this.ended = true;
      this.options.send({ type: 'snapshot-end', sessionId: this.options.sessionId, snapshotId: this.id, sequence: this.boundary });
    }
  }
  progress(index: number, parsedBytes: number): void {
    if (this.cancelled) throw new Error('SNAPSHOT_CANCELLED');
    const record = this.records.get(index);
    if (!record || record.prefix !== parsedBytes || index > this.sent - 1 || index > this.acked + 1) throw new Error('INVALID_SNAPSHOT_CREDIT');
    if (index <= this.acked) return;
    this.options.release(record.cost); record.cost = 0; this.acked = index;
    this.lastProgress = this.options.now?.() ?? performance.now(); this.pump();
  }
  cancel(reason: CancelReason): void {
    if (this.cancelled) return; this.cancelled = true;
    for (const record of this.records.values()) if (record.cost) this.options.release(record.cost);
    this.records.clear(); this.chunks = [];
    this.options.send({ type: 'snapshot-cancel', sessionId: this.options.sessionId, snapshotId: this.id, reason });
  }
}
