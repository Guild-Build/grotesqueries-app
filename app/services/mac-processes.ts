import { execFileSync } from 'node:child_process';
import path from 'node:path';
import { assertManagedPath } from '../helpers/runtime.js';

export interface MacProcess { pid: number; parent: number; session: number; birth: string; zombie: boolean; stopped: boolean }
export function macProcessHelperPath(root: string): string { return assertManagedPath(root, path.join(root, 'dist/native/macos-processes')); }
const execute = (helper: string, args: string[], timeout = 2000): string => execFileSync(helper, args,
  { encoding: 'utf8', timeout, maxBuffer: 4 * 1024 * 1024, stdio: ['ignore', 'pipe', 'pipe'] });

/** Refuse the platform before spawning a requested CLI when generation-bound signals are unavailable. */
export function verifyMacProcessSupport(root: string): void {
  try { if (execute(macProcessHelperPath(root), ['probe']).trim() !== 'audit-token-v1') throw new Error('invalid capability'); }
  catch { throw new Error('PTY_PLATFORM_UNSUPPORTED: macOS audit-token process signaling is required. Rebuild the native helper on a supported macOS host.'); }
}

/** Abort only our still-stopped bootstrap; the requested program has not executed. */
export function abortMacBootstrap(root: string, pid: number, expected: MacBootstrapIdentity): void {
  const status = JSON.parse(execute(macProcessHelperPath(root), ['status', String(pid), expected.birth])) as { state?: string };
  if (status.state === 'exited' || status.state === 'replaced') return;
  if (status.state !== 'alive') throw new Error('STOP_METADATA_FAILED');
  execute(macProcessHelperPath(root), ['kill', String(pid), expected.birth, String(expected.session)]);
}

export interface MacBootstrapIdentity { pid: number; birth: string; session: number }

/** Retain known PID + kernel birth identities. This is tracked-descendant cleanup, not a process sandbox. */
export class MacProcessOwnership {
  private readonly helper: string;
  private readonly owned = new Map<number, { birth: string; session: number }>();
  private readonly session: number;
  private readonly rootBirth: string;
  private timer?: ReturnType<typeof setInterval>;
  private trackingFailed = false;
  constructor(root: string, private readonly pid: number, expected: MacBootstrapIdentity) {
    this.helper = macProcessHelperPath(root);
    if (expected.pid !== pid || expected.session !== pid || !/^\d+:\d{1,6}$/.test(expected.birth)) throw new Error('STOP_ROOT_IDENTITY_UNAVAILABLE');
    this.rootBirth = expected.birth; this.session = expected.session;
    this.owned.set(pid, { birth: expected.birth, session: expected.session });
    let current = this.list(); let target = current.find(item => item.pid === pid);
    const deadline = Date.now() + 2000;
    while (target && !target.stopped && Date.now() < deadline) {
      current = this.list(); target = current.find(item => item.pid === pid);
    }
    if (!target || !target.stopped || target.session !== pid || target.birth !== expected.birth) throw new Error('STOP_ROOT_IDENTITY_UNAVAILABLE');
    this.discover(current);
    this.timer = setInterval(() => {
      try {
        const list = this.list(); this.discover(list);
        if (!this.alive(list).length) this.dispose();
      } catch { this.trackingFailed = true; this.dispose(); }
    }, 100);
    this.timer.unref();
  }
  private list(): MacProcess[] {
    const value: unknown = JSON.parse(execute(this.helper, ['list']));
    if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('STOP_METADATA_FAILED');
    const envelope = value as { complete?: unknown; processes?: unknown };
    if (envelope.complete !== true || !Array.isArray(envelope.processes) || envelope.processes.length > 100000) throw new Error('STOP_METADATA_FAILED');
    const ids = new Set<number>();
    const known: MacProcess[] = [];
    for (const record of envelope.processes) {
      if (!record || typeof record !== 'object' || Array.isArray(record)) throw new Error('STOP_METADATA_FAILED');
      const item = record as Record<string, unknown>;
      if (!Number.isSafeInteger(item.pid) || Number(item.pid) <= 1 || ids.has(Number(item.pid))) throw new Error('STOP_METADATA_FAILED');
      ids.add(Number(item.pid));
      // An unreadable record can conceal a descendant; do not infer complete inventory from the rest.
      if (item.unavailable) throw new Error('STOP_METADATA_FAILED');
      if (!Number.isSafeInteger(item.parent) || Number(item.parent) < 0 || !Number.isSafeInteger(item.session) || Number(item.session) <= 0 ||
        typeof item.birth !== 'string' || !/^\d+:\d{1,6}$/.test(item.birth) || typeof item.zombie !== 'boolean' || typeof item.stopped !== 'boolean') throw new Error('STOP_METADATA_FAILED');
      known.push(record as MacProcess);
    }
    // UID-filtered discovery cannot establish death of a retained process that changed credentials.
    for (const [pid, expected] of this.owned) {
      if (ids.has(pid)) continue;
      const status = JSON.parse(execute(this.helper, ['status', String(pid), expected.birth])) as { state?: unknown; process?: unknown };
      if (status.state === 'exited' || status.state === 'replaced') continue;
      if (status.state !== 'alive' || !status.process || typeof status.process !== 'object') throw new Error('STOP_METADATA_FAILED');
      const item = status.process as MacProcess;
      if (item.pid !== pid || item.birth !== expected.birth || !Number.isSafeInteger(item.parent) || item.parent < 0 ||
        !Number.isSafeInteger(item.session) || item.session <= 0 || typeof item.zombie !== 'boolean' || typeof item.stopped !== 'boolean') throw new Error('STOP_METADATA_FAILED');
      known.push(item);
    }
    return known;
  }
  private alive(list: MacProcess[]): MacProcess[] {
    return list.filter(item => !item.zombie && this.owned.get(item.pid)?.birth === item.birth);
  }
  private discover(list: MacProcess[]): void {
    const current = new Map(list.map(item => [item.pid, item]));
    const root = current.get(this.pid);
    const deadline = Date.now() + 2000;
    const checked = new Map<string, boolean>();
    const afterSnapshot = (pid: number, birth: string): boolean => {
      const key = `${pid}:${birth}`;
      const cached = checked.get(key); if (cached !== undefined) return cached;
      if (checked.size >= 256 || Date.now() >= deadline) throw new Error('STOP_METADATA_FAILED');
      const status = JSON.parse(execute(this.helper, ['status', String(pid), birth], Math.max(1, deadline - Date.now()))) as { state?: unknown; process?: unknown };
      if (status.state === 'exited' || status.state === 'replaced') { checked.set(key, false); return false; }
      if (status.state !== 'alive' || !status.process || typeof status.process !== 'object') throw new Error('STOP_METADATA_FAILED');
      const item = status.process as MacProcess;
      if (item.pid !== pid || item.birth !== birth || !Number.isSafeInteger(item.parent) || item.parent < 0 ||
        !Number.isSafeInteger(item.session) || item.session <= 0 || typeof item.zombie !== 'boolean' || typeof item.stopped !== 'boolean') throw new Error('STOP_METADATA_FAILED');
      checked.set(key, true); return true;
    };
    const notOlder = (child: string, parent: string): boolean => {
      const ticks = (birth: string) => { const [seconds, micros] = birth.split(':'); return BigInt(seconds) * 1000000n + BigInt(micros); };
      return ticks(child) >= ticks(parent);
    };
    let added = true;
    while (added) {
      added = false;
      for (const item of list) {
        if (this.owned.get(item.pid)?.birth === item.birth) {
          this.owned.set(item.pid, { birth: item.birth, session: item.session }); continue;
        }
        const parent = current.get(item.parent);
        // Inventory rows are sampled separately. Recheck each authority AFTER the child row to exclude PID/session reuse joins.
        const sameSession = root?.birth === this.rootBirth && item.session === this.session && notOlder(item.birth, this.rootBirth) &&
          afterSnapshot(this.pid, this.rootBirth);
        const directChild = !sameSession && parent && this.owned.get(parent.pid)?.birth === parent.birth && notOlder(item.birth, parent.birth) &&
          afterSnapshot(parent.pid, parent.birth);
        if (sameSession || directChild) {
          this.owned.set(item.pid, { birth: item.birth, session: item.session }); added = true;
        }
      }
    }
  }
  remaining(): boolean {
    try { const list = this.list(); this.discover(list); return this.trackingFailed || this.alive(list).length > 0; }
    catch { this.trackingFailed = true; return true; }
  }
  resume(): void {
    execute(this.helper, ['resume', String(this.pid), this.rootBirth, String(this.session)]);
  }
  async stop(): Promise<number[]> {
    const deadline = Date.now() + 10000;
    while (Date.now() < deadline) {
      const list = this.list(); this.discover(list);
      const alive = this.alive(list);
      if (!alive.length) {
        this.dispose();
        if (this.trackingFailed) throw new Error('STOP_TRACKING_FAILED: Tracked descendant cleanup could not be verified.');
        return [...this.owned.keys()];
      }
      // Descendants first, root last. The helper signals an audit token, never a numeric PID.
      for (const item of alive.sort((a, b) => Number(a.pid === this.pid) - Number(b.pid === this.pid))) {
        try { execute(this.helper, ['kill', String(item.pid), item.birth, String(item.session)]); }
        catch { throw new Error('STOP_TREE_FAILED: Owned cleanup was not verified; retry deliberately.'); }
      }
      await new Promise(resolve => setTimeout(resolve, 25));
    }
    throw new Error('STOP_TREE_TIMEOUT');
  }
  dispose(): void { clearInterval(this.timer); this.timer = undefined; }
}
