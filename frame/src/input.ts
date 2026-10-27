import { utf8Bytes, utf8Chunks, type EffectiveLimits, type ClientMessage, type ServerMessage } from '@grotesqueries/protocol';
import { InputMarkerStore, type DeliveryEpoch } from './input-markers.js';

export class InputSender {
  private active?: { hostInstanceId: string; sessionId: string; leaseId: string; epoch: DeliveryEpoch; next: number };
  private readonly pending = new Map<number, { data: string; bytes: number; at: number }>();
  private bytes = 0;
  private blockedLease?: string;
  problem?: string;
  constructor(private readonly options: { markers: InputMarkerStore; limits: EffectiveLimits; send: (message: ClientMessage) => void; changed: () => void; now?: () => number }) {}
  activate(hostInstanceId: string, sessionId: string, leaseId: string, workerId?: string): void {
    if (leaseId === this.blockedLease) return;
    if (this.active?.hostInstanceId === hostInstanceId && this.active.sessionId === sessionId && this.active.leaseId === leaseId && this.active.epoch.workerId === workerId) return;
    this.pending.clear(); this.bytes = 0; this.problem = undefined;
    this.active = { hostInstanceId, sessionId, leaseId, epoch: this.options.markers.begin(hostInstanceId, sessionId, workerId), next: 1 };
    this.options.changed();
  }
  submit(data: string): void {
    const active = this.active; if (!active || this.problem || !data) return;
    const bytes = utf8Bytes(data);
    if (this.bytes + bytes > 262144) { this.problem = 'Pending input exceeds the 256 KiB capacity. Send smaller parts deliberately after inspecting the terminal.'; this.options.changed(); return; }
    const chunkBytes = Math.min(this.options.limits.transport.maxInputBytes, Math.floor((this.options.limits.transport.maxFrameBytes - 512) / 6));
    const parts = utf8Chunks(data, chunkBytes);
    if (this.pending.size + parts.length > 64 || this.bytes + bytes > 262144) {
      this.problem = 'Pending input exceeds the 64 item / 256 KiB capacity. Inspect the terminal and release control before continuing.'; this.options.changed(); return;
    }
    const ids = parts.map((_, index) => active.next + index);
    try { this.options.markers.add(active.epoch, ids); }
    catch { this.problem = 'Input storage failed. No new input was sent. Allow browser storage, then release and take control again.'; this.options.changed(); return; }
    active.next += parts.length;
    parts.forEach((part, index) => { const cost = utf8Bytes(part); this.pending.set(ids[index], { data: part, bytes: cost, at: this.options.now?.() ?? Date.now() }); this.bytes += cost; });
    try {
      parts.forEach((part, index) => this.options.send({ type: 'input', sessionId: active.sessionId, leaseId: active.leaseId, inputId: ids[index], data: part }));
    } catch { this.lose('Input delivery is uncertain. Inspect the terminal, then take control and enter any new input deliberately.'); }
    this.options.changed();
  }
  acknowledge(message: Extract<ServerMessage, { type: 'input-ack' }>): void {
    const active = this.active; const item = this.pending.get(message.inputId);
    if (!active || !item || active.sessionId !== message.sessionId || active.leaseId !== message.leaseId) return;
    try { this.options.markers.acknowledge(active.epoch, message.inputId); }
    catch { this.lose('Acknowledgement storage failed. The conservative delivery marker remains. Inspect the terminal before new input.'); return; }
    this.pending.delete(message.inputId); this.bytes -= item.bytes; this.options.changed();
  }
  reject(message: { sessionId?: string; leaseId?: string; inputId?: number }): boolean {
    if (!this.active || this.active.sessionId !== message.sessionId || this.active.leaseId !== message.leaseId ||
      message.inputId === undefined || !this.pending.has(message.inputId)) return false;
    this.lose('Input was rejected or its delivery is uncertain. Inspect the terminal before entering new input.'); return true;
  }
  lose(reason: string): void {
    if (this.pending.size) { this.problem = reason; this.blockedLease = this.active?.leaseId; }
    this.pending.clear(); this.bytes = 0; this.active = undefined; this.options.changed();
  }
  tick(): void {
    const now = this.options.now?.() ?? Date.now();
    if ([...this.pending.values()].some(item => now - item.at > 5000)) this.lose('Input acknowledgement timed out. Delivery is uncertain; inspect the terminal before new input.');
  }
  get usable(): boolean { return !!this.active && !this.problem; }
  get pendingCount(): number { return this.pending.size; }
  get activeMarkerKey(): string | undefined { return this.active?.epoch.key; }
}
