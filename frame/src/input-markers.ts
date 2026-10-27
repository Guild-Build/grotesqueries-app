export interface StorageLike { readonly length: number; key(index: number): string | null;
  getItem(key: string): string | null; setItem(key: string, value: string): void; removeItem(key: string): void }
export interface InputMarker { key: string; version: 1; documentId: string; workerId?: string; hostInstanceId: string; sessionId: string; epoch: string; ids: number[]; count: number }
export type DeliveryEpoch = Omit<InputMarker, 'ids' | 'count'>;
const prefix = 'gq.pending.';
const uuid = /^[0-9a-f]{8}-(?:[0-9a-f]{4}-){3}[0-9a-f]{12}$/i;
const worker = /^[a-zA-Z0-9_-]{1,64}$/;
/** Durable metadata is written before a human input item can become sendable. */
export class InputMarkerStore {
  readonly documentId: string;
  constructor(private readonly local: StorageLike, tab: StorageLike) {
    const existing = tab.getItem('gq.document');
    this.documentId = existing && uuid.test(existing) ? existing : crypto.randomUUID();
    tab.setItem('gq.document', this.documentId);
  }
  begin(hostInstanceId: string, sessionId: string, workerId?: string): DeliveryEpoch {
    if (workerId !== undefined && !worker.test(workerId)) throw new Error('Invalid worker identity.');
    const epoch = crypto.randomUUID(); const key = prefix + [this.documentId, ...(workerId ? [workerId] : []), hostInstanceId, sessionId, epoch].join('.');
    return { key, version: 1, documentId: this.documentId, ...(workerId ? { workerId } : {}), hostInstanceId, sessionId, epoch };
  }
  private read(key: string): InputMarker | undefined {
    const raw = this.local.getItem(key); if (!raw || raw.length > 4096) return;
    try {
      const value = JSON.parse(raw);
      if (value.version !== 1 || !['documentId', 'hostInstanceId', 'sessionId', 'epoch'].every(field => typeof value[field] === 'string' && uuid.test(value[field])) ||
        !Array.isArray(value.ids) || value.ids.length > 64 || value.ids.length < 1 || !value.ids.every((id: unknown) => Number.isSafeInteger(id) && Number(id) > 0) ||
        value.count !== value.ids.length || new Set(value.ids).size !== value.ids.length) return;
      if (value.workerId !== undefined && (typeof value.workerId !== 'string' || !worker.test(value.workerId))) return;
      const expected = prefix + [value.documentId, ...(value.workerId ? [value.workerId] : []), value.hostInstanceId, value.sessionId, value.epoch].join('.');
      if (key !== expected) return;
      return { key, version: 1, documentId: value.documentId, ...(value.workerId ? { workerId: value.workerId } : {}), hostInstanceId: value.hostInstanceId, sessionId: value.sessionId,
        epoch: value.epoch, ids: value.ids, count: value.count };
    } catch { return; }
  }
  loadUnresolved(): InputMarker[] {
    const markers: InputMarker[] = [];
    for (let index = 0; index < this.local.length; index++) {
      const key = this.local.key(index); if (!key?.startsWith(prefix)) continue;
      const marker = this.read(key); if (marker) markers.push(marker);
    }
    return markers;
  }
  add(epoch: DeliveryEpoch, ids: number[]): void {
    const existing = this.read(epoch.key); const combined = [...new Set([...(existing?.ids ?? []), ...ids])];
    if (combined.length > 64 || combined.some(id => !Number.isSafeInteger(id) || id < 1)) throw new Error('Pending input capacity reached.');
    if (!existing && this.loadUnresolved().filter(marker => marker.documentId === this.documentId).length >= 64) throw new Error('Unresolved input epoch capacity reached. Inspect and dismiss an old marker deliberately.');
    const marker = { ...epoch, ids: combined, count: combined.length }; const { key, ...stored } = marker;
    this.local.setItem(key, JSON.stringify(stored));
  }
  acknowledge(epoch: DeliveryEpoch, inputId: number): void {
    const marker = this.read(epoch.key); if (!marker || !marker.ids.includes(inputId)) return;
    marker.ids = marker.ids.filter(id => id !== inputId); marker.count = marker.ids.length;
    if (!marker.ids.length) this.local.removeItem(epoch.key);
    else { const { key, ...stored } = marker; this.local.setItem(key, JSON.stringify(stored)); }
  }
  dismiss(key: string): void { if (this.read(key)) this.local.removeItem(key); }
}
