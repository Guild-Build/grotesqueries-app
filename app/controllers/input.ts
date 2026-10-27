import { utf8Bytes, type EffectiveLimits } from '@grotesqueries/protocol';
import type { SessionRegistry } from '../models/sessions.js';
import type { ControlLeases } from './control.js';
import type { StopResult } from '../services/pty.js';

/** Admission captures authority; only the synchronous execution boundary permits an effect. */
export class InputDelivery {
  constructor(private readonly sessions: SessionRegistry, private readonly control: ControlLeases, private readonly limits: EffectiveLimits) {}
  async write(sessionId: string, viewId: string, leaseId: string, inputId: number, data: string): Promise<'accepted' | 'already-seen'> {
    if (!data || utf8Bytes(data) > this.limits.transport.maxInputBytes || !Number.isSafeInteger(inputId) || inputId < 1) throw new Error('INVALID_INPUT');
    const stamp = this.control.stamp(sessionId, viewId, leaseId);
    return this.sessions.require(sessionId).enqueue(() => {
      const { record, lease } = this.control.requireAtExecution(stamp);
      if (record.bridgeFailed) throw new Error('TERMINAL_BRIDGE_FAILED');
      if (inputId <= lease.inputHighWater) return 'already-seen';
      if (inputId !== lease.inputHighWater + 1) throw new Error('INPUT_ID_GAP');
      lease.inputHighWater = inputId;
      try { record.pty.write(data); }
      catch { this.control.revoke(sessionId); throw new Error('INPUT_DELIVERY_UNCERTAIN'); }
      return 'accepted';
    });
  }
  async resize(sessionId: string, viewId: string, leaseId: string, cols: number, rows: number): Promise<void> {
    if (!Number.isSafeInteger(cols) || cols < 2 || cols > 300 || !Number.isSafeInteger(rows) || rows < 1 || rows > 200) throw new Error('INVALID_GRID');
    const stamp = this.control.stamp(sessionId, viewId, leaseId); const record = this.sessions.require(sessionId);
    cols = record.metadata.fixedCols ?? cols;
    return record.enqueue(() => record.terminal.resize(cols, rows, () => {
      this.control.requireAtExecution(stamp);
      if (record.bridgeFailed) throw new Error('TERMINAL_BRIDGE_FAILED');
      try { record.pty.resize(cols, rows); }
      catch { this.control.revoke(sessionId); throw new Error('RESIZE_FAILED'); }
      record.metadata.cols = cols; record.metadata.rows = rows; this.sessions.changed(record);
    }));
  }
  async stop(sessionId: string, viewId: string, leaseId: string): Promise<StopResult> {
    const stamp = this.control.stamp(sessionId, viewId, leaseId, true); const record = this.sessions.require(sessionId);
    const initiated = await record.enqueue(() => {
      this.control.requireAtExecution(stamp, true);
      record.metadata.stopPending = true; this.control.revoke(sessionId);
      // Release the parser queue after initiation: native exit/final output must drain it.
      return { completion: this.sessions.stop(sessionId) };
    });
    return initiated.completion;
  }
}
