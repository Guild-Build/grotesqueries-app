import type { TabOrder } from './tabs.js';
export interface FleetHost { id: string; label: string; instanceId: string | null; online: boolean; route: string | null; actions: string[] }
export interface FleetCatalog { mode: 'fleet'; developmentAccept: boolean; hosts: FleetHost[] }
const uuid = /^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/i;
const identity = /^[a-zA-Z0-9_-]{1,64}$/;
export function decodeFleet(raw: unknown): FleetCatalog {
  const value = raw as FleetCatalog;
  if (value?.mode !== 'fleet' || typeof value.developmentAccept !== 'boolean' || !Array.isArray(value.hosts) || value.hosts.length > 32) throw new Error('Invalid fleet catalog.');
  const ids = new Set<string>();
  for (const host of value.hosts) {
    if (!host || !identity.test(host.id) || ids.has(host.id) || typeof host.label !== 'string' || host.label.length > 256 || typeof host.online !== 'boolean' ||
      host.instanceId !== null && !uuid.test(host.instanceId) || host.route !== (host.instanceId ? `/fleet/${host.id}/${host.instanceId}` : null) ||
      !Array.isArray(host.actions) || !host.actions.every(a => ['observe', 'start', 'control', 'stop', 'settings'].includes(a))) throw new Error('Invalid fleet host.');
    ids.add(host.id);
  }
  return value;
}
export function splitTarget(key: string): { worker: string; instance: string; session: string } | undefined {
  const parts = key.split('/');
  if (parts.length !== 3 || !identity.test(parts[0]) || !uuid.test(parts[1]) || !uuid.test(parts[2])) return;
  return { worker: parts[0], instance: parts[1], session: parts[2] };
}
export function readFleetSelection(raw: string | null): TabOrder {
  try {
    const value = JSON.parse(raw ?? 'null');
    const sessions = Array.isArray(value?.sessions) ? [...new Set<string>(value.sessions.filter((s: unknown) => typeof s === 'string' && !!splitTarget(s)))].slice(0, 64) : [];
    return { sessions, active: sessions.includes(value?.active) ? value.active : sessions[0] };
  } catch { return { sessions: [] }; }
}
