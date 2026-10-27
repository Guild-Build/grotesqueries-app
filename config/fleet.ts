import fs from 'node:fs';
import path from 'node:path';
import { assertManagedPath } from '../app/helpers/runtime.js';
import { ACTIONS, identity, type Action } from '../app/services/fleet/contracts.js';

export interface FleetConfig {
  coordinator?: { port: number; workerPort: number; workerBind: string; stateFile: string; developmentAccept: boolean;
    certificateFile?: string; privateKeyFile?: string;
    workers: Array<{ id: string; label: string; publicKeyFile?: string; actions: Action[] }> };
  worker?: { id: string; coordinatorURL: string; developmentAccept: boolean; privateKeyFile?: string; caFile?: string };
}
/** Presence enables a role. Omission of fleet means standalone. */
export function parseFleet(raw: unknown, root: string, enginePort: number): FleetConfig {
  const object = (v: unknown, allowed: string[]): Record<string, unknown> => {
    if (!v || typeof v !== 'object' || Array.isArray(v) || Object.keys(v).some(k => !allowed.includes(k))) throw new Error('Invalid fleet configuration fields.');
    return v as Record<string, unknown>;
  };
  const text = (v: unknown): string => { if (typeof v !== 'string' || !v || v.includes('\0') || v.length > 4096) throw new Error('Invalid fleet text.'); return v; };
  const port = (v: unknown): number => { if (!Number.isSafeInteger(v) || Number(v) < 1 || Number(v) > 65535) throw new Error('Invalid fleet port.'); return v as number; };
  const dev = (v: unknown): boolean => { if (v !== undefined && typeof v !== 'boolean') throw new Error('developmentAccept must be boolean.'); return v === true; };
  const localPath = (v: unknown): string => {
    const value = text(v);
    if (process.platform !== 'win32' && (/^[A-Z]:/i.test(value) || value.includes('\\') || value.startsWith('//'))) throw new Error('Fleet paths must use local POSIX paths.');
    return assertManagedPath(root, path.resolve(root, value));
  };
  const file = (v: unknown): string => {
    const value = localPath(v);
    if (!fs.statSync(value).isFile() || fs.statSync(value).size > 65536) throw new Error('Fleet key/certificate file must be a bounded local file.'); return value;
  };
  const config = object(raw, ['coordinator', 'worker']); const result: FleetConfig = {};
  if (config.coordinator !== undefined) {
    const c = object(config.coordinator, ['port', 'workerPort', 'workerBind', 'stateFile', 'developmentAccept', 'certificateFile', 'privateKeyFile', 'workers']);
    if (!Array.isArray(c.workers) || c.workers.length > 32) throw new Error('At most32 admitted fleet workers.');
    const developmentAccept = dev(c.developmentAccept); const ids = new Set<string>();
    const workers = c.workers.map(item => {
      const w = object(item, ['id', 'label', 'publicKeyFile', 'actions']);
      if (!identity(w.id) || ids.has(w.id)) throw new Error('Unique fleet worker IDs required.'); ids.add(w.id);
      const label = text(w.label); if (Buffer.byteLength(label) > 256) throw new Error('Worker label too long.');
      if (w.actions !== undefined && (!Array.isArray(w.actions) || !w.actions.every(a => ACTIONS.includes(a)))) throw new Error('Unknown fleet action.');
      return { id: w.id, label, actions: [...new Set((w.actions ?? ACTIONS) as Action[])],
        ...(!developmentAccept || w.publicKeyFile !== undefined ? { publicKeyFile: file(w.publicKeyFile) } : {}) };
    });
    const workerBind = text(c.workerBind ?? '127.0.0.1');
    if (!/^[a-zA-Z0-9.:_-]+$/.test(workerBind)) throw new Error('Invalid worker listener address.');
    const certificateFile = c.certificateFile === undefined ? undefined : file(c.certificateFile);
    const privateKeyFile = c.privateKeyFile === undefined ? undefined : file(c.privateKeyFile);
    if (!!certificateFile !== !!privateKeyFile) throw new Error('TLS requires both certificate and private key.');
    if (!['127.0.0.1', '::1'].includes(workerBind) && (developmentAccept || !certificateFile)) throw new Error('Remote worker listener requires TLS and public-key admission.');
    result.coordinator = { port: port(c.port), workerPort: port(c.workerPort), workerBind, developmentAccept, workers,
      stateFile: localPath(c.stateFile ?? '.runtime/fleet.sqlite'),
      ...(certificateFile ? { certificateFile, privateKeyFile } : {}) };
    if (result.coordinator.port === result.coordinator.workerPort) throw new Error('Fleet listener ports must differ.');
  }
  if (config.worker !== undefined) {
    const w = object(config.worker, ['id', 'coordinatorURL', 'developmentAccept', 'privateKeyFile', 'caFile']);
    if (!identity(w.id)) throw new Error('Worker ID required.');
    const developmentAccept = dev(w.developmentAccept), coordinatorURL = text(w.coordinatorURL), url = new URL(coordinatorURL);
    if (!['ws:', 'wss:'].includes(url.protocol) || url.pathname !== '/worker' || url.username || url.password || url.search || url.hash ||
      (url.protocol === 'ws:' || developmentAccept) && !['127.0.0.1', '[::1]'].includes(url.hostname)) throw new Error('Remote coordinator requires wss; development accept is loopback-only.');
    result.worker = { id: w.id, coordinatorURL, developmentAccept,
      ...(!developmentAccept || w.privateKeyFile !== undefined ? { privateKeyFile: file(w.privateKeyFile) } : {}),
      ...(w.caFile === undefined ? {} : { caFile: file(w.caFile) }) };
  }
  if (!result.worker && !result.coordinator) throw new Error('Fleet must enable coordinator or worker.');
  if (result.worker && result.coordinator && [result.coordinator.port, result.coordinator.workerPort].includes(enginePort)) throw new Error('Local engine and fleet listener ports must differ.');
  return result;
}
