import crypto from 'node:crypto';
import type { SessionRegistry, SessionRecord, Attachment } from '../models/sessions.js';

export interface Lease { id: string; viewId: string; generation: number; inputHighWater: number }
export interface ExecutionStamp { hostInstanceId: string; sessionId: string; processGeneration: number; viewId: string;
  attachmentGeneration: number; leaseId: string; leaseGeneration: number }
export class ControlLeases {
  private readonly leases = new Map<string, Lease>();
  private readonly listeners = new Set<(sessionId: string, lease: Lease | null) => void>();
  private generation = 0;
  private readonly exit: () => void;
  constructor(private readonly options: { sessions: SessionRegistry; hostInstanceId: string; timeoutMs: number; now?: () => number }) {
    this.exit = options.sessions.onNativeExit(id => this.revoke(id));
  }
  private now(): number { return this.options.now?.() ?? performance.now(); }
  onChange(listener: (sessionId: string, lease: Lease | null) => void): () => void { this.listeners.add(listener); return () => { this.listeners.delete(listener); }; }
  current(sessionId: string): Lease | undefined { return this.leases.get(sessionId); }
  attach(sessionId: string, viewId: string): Attachment {
    const record = this.options.sessions.require(sessionId);
    const existing = record.views.get(viewId); if (existing) return existing;
    const attachment = { generation: ++this.generation, restored: false, live: true, lastHeartbeat: this.now() };
    record.views.set(viewId, attachment); this.options.sessions.changed(record); return attachment;
  }
  detach(sessionId: string, viewId: string): void {
    const record = this.options.sessions.require(sessionId);
    if (this.leases.get(sessionId)?.viewId === viewId) this.revoke(sessionId);
    const attachment = record.views.get(viewId); if (attachment) { attachment.live = false; record.views.delete(viewId); this.options.sessions.changed(record); }
  }
  disconnect(viewId: string): void {
    for (const summary of this.options.sessions.list()) this.detach(summary.id, viewId);
  }
  heartbeat(viewId: string): void {
    const now = this.now();
    for (const summary of this.options.sessions.list()) {
      const attachment = this.options.sessions.require(summary.id).views.get(viewId); if (attachment?.live) attachment.lastHeartbeat = now;
    }
  }
  expire(): void {
    for (const [sessionId, lease] of this.leases) {
      const attachment = this.options.sessions.require(sessionId).views.get(lease.viewId);
      if (!attachment?.live || this.now() - attachment.lastHeartbeat > this.options.timeoutMs) this.revoke(sessionId);
    }
  }
  take(sessionId: string, viewId: string): Lease {
    const record = this.options.sessions.require(sessionId);
    if (record.job) throw new Error('JOB_NOT_INTERACTIVE');
    this.running(record, true);
    const attachment = record.views.get(viewId);
    if (!attachment?.live || !attachment.restored) throw new Error('ATTACHMENT_NOT_READY');
    // A live socket can request control after its heartbeat; expired owners free immediately.
    this.expire();
    const existing = this.leases.get(sessionId);
    if (existing) { if (existing.viewId === viewId) return existing; throw new Error('CONTROL_BUSY'); }
    attachment.lastHeartbeat = this.now();
    const lease = { id: crypto.randomUUID(), viewId, generation: ++this.generation, inputHighWater: 0 };
    this.leases.set(sessionId, lease); record.metadata.controllerViewId = viewId;
    this.options.sessions.changed(record); this.notify(sessionId, lease); return lease;
  }
  release(sessionId: string, viewId: string, leaseId: string): void {
    const lease = this.leases.get(sessionId);
    if (lease?.id !== leaseId || lease.viewId !== viewId) throw new Error('CONTROL_REQUIRED');
    this.revoke(sessionId);
  }
  revoke(sessionId: string): void {
    if (!this.leases.delete(sessionId)) return;
    const record = this.options.sessions.require(sessionId); record.metadata.controllerViewId = null;
    this.options.sessions.changed(record); this.notify(sessionId, null);
  }
  stamp(sessionId: string, viewId: string, leaseId: string, cleanup = false): ExecutionStamp {
    const record = this.options.sessions.require(sessionId); const attachment = record.views.get(viewId); const lease = this.leases.get(sessionId);
    if (!attachment || !lease || lease.id !== leaseId || lease.viewId !== viewId) throw new Error('CONTROL_REQUIRED');
    const stamp = { hostInstanceId: this.options.hostInstanceId, sessionId, viewId, leaseId,
      processGeneration: record.processGeneration, attachmentGeneration: attachment.generation, leaseGeneration: lease.generation };
    this.requireAtExecution(stamp, cleanup); return stamp;
  }
  requireAtExecution(stamp: ExecutionStamp, cleanup = false): { record: SessionRecord; lease: Lease } {
    const record = this.options.sessions.require(stamp.sessionId);
    const attachment = record.views.get(stamp.viewId); const lease = this.leases.get(stamp.sessionId);
    if (stamp.hostInstanceId !== this.options.hostInstanceId || !attachment?.live || !attachment.restored ||
      attachment.generation !== stamp.attachmentGeneration || !lease || lease.id !== stamp.leaseId ||
      lease.viewId !== stamp.viewId || lease.generation !== stamp.leaseGeneration) throw new Error('CONTROL_REQUIRED');
    if (this.now() - attachment.lastHeartbeat > this.options.timeoutMs) { this.revoke(stamp.sessionId); throw new Error('CONTROL_EXPIRED'); }
    this.running(record, cleanup);
    if (record.processGeneration !== stamp.processGeneration) throw new Error('PROCESS_EXITED');
    return { record, lease };
  }
  private running(record: SessionRecord, cleanup = false): void {
    if (record.metadata.stopPending) throw new Error('STOP_PENDING');
    if ((!record.nativeRunning || record.metadata.processState !== 'running') &&
      !(cleanup && record.cleanupRequired)) throw new Error('PROCESS_EXITED');
  }
  private notify(sessionId: string, lease: Lease | null): void {
    for (const listener of this.listeners) { try { listener(sessionId, lease); } catch { /* View isolation; transport owns its error evidence. */ } }
  }
  dispose(): void { this.exit(); for (const id of [...this.leases.keys()]) this.revoke(id); this.listeners.clear(); }
}
