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

const metadataBudgetMs = 2000;
function remainingTime(deadline: number): number {
  const time = Math.ceil(deadline - performance.now());
  if (time <= 0) throw new Error('STOP_METADATA_FAILED: The native metadata budget expired.');
  return time;
}

function processRow(value: unknown): MacProcess {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('STOP_METADATA_FAILED');
  const item = value as MacProcess;
  if (!Number.isSafeInteger(item.pid) || item.pid <= 1 || !Number.isSafeInteger(item.parent) || item.parent < 0 ||
    !Number.isSafeInteger(item.session) || item.session <= 0 || typeof item.birth !== 'string' ||
    !/^\d+:\d{1,6}$/.test(item.birth) || typeof item.zombie !== 'boolean' || typeof item.stopped !== 'boolean') {
    throw new Error('STOP_METADATA_FAILED');
  }
  return item;
}

export interface MacBootstrapIdentity { pid: number; birth: string; session: number }

/** Retain known PID + kernel birth identities. This is tracked-descendant cleanup, not a process sandbox. */
export class MacProcessOwnership {
  private readonly helper: string;
  private readonly owned = new Map<number, string>();
  private readonly resolved = new Set<number>();
  private readonly session: number;
  private readonly rootBirth: string;
  private timer?: ReturnType<typeof setInterval>;
  private trackingFailed = false;
  constructor(root: string, private readonly pid: number, expected: MacBootstrapIdentity) {
    this.helper = macProcessHelperPath(root);
    if (expected.pid !== pid || expected.session !== pid || !/^\d+:\d{1,6}$/.test(expected.birth)) throw new Error('STOP_ROOT_IDENTITY_UNAVAILABLE');
    this.rootBirth = expected.birth; this.session = expected.session;
    this.owned.set(pid, expected.birth);
    const deadline = performance.now() + metadataBudgetMs;
    const current = this.list(deadline);
    const target = current.find(item => item.pid === pid);
    if (!target || target.zombie || target.session !== pid || target.birth !== expected.birth) throw new Error('STOP_ROOT_IDENTITY_UNAVAILABLE');
    this.discover(current, deadline);
    this.timer = setInterval(() => {
      try {
        const deadline = performance.now() + metadataBudgetMs;
        const list = this.list(deadline); this.discover(list, deadline);
        if (!this.alive(list).length) this.dispose();
      } catch { this.trackingFailed = true; this.dispose(); }
    }, 100);
    this.timer.unref();
  }
  private status(pid: number, birth: string, deadline: number): MacProcess | undefined {
    const result = JSON.parse(execute(this.helper, ['status', String(pid), birth], remainingTime(deadline))) as
      { state?: unknown; process?: unknown };
    if (result?.state === 'exited' || result?.state === 'replaced') return undefined;
    if (result?.state !== 'alive') throw new Error('STOP_METADATA_FAILED');
    const item = processRow(result.process);
    if (item.pid !== pid || item.birth !== birth) throw new Error('STOP_METADATA_FAILED');
    return item;
  }
  private list(deadline: number): MacProcess[] {
    const value: unknown = JSON.parse(execute(this.helper, ['list'], remainingTime(deadline)));
    if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('STOP_METADATA_FAILED');
    const envelope = value as { complete?: unknown; processes?: unknown };
    if (envelope.complete !== true || !Array.isArray(envelope.processes) || envelope.processes.length > 100000) throw new Error('STOP_METADATA_FAILED');
    const rows = new Map<number, MacProcess>();
    for (const record of envelope.processes) {
      // Unreadable rows can conceal descendants. Treat an incomplete inventory as a failure.
      const item = processRow(record);
      if (rows.has(item.pid)) throw new Error('STOP_METADATA_FAILED');
      rows.set(item.pid, item);
    }
    for (const [pid, expected] of this.owned) {
      // UID-filtered discovery cannot establish death of a retained process that changed credentials.
      const item = rows.get(pid) ?? this.status(pid, expected, deadline);
      if (!item || item.birth !== expected || item.zombie) {
        // Keep the PID in the Stop receipt without polling an exited generation again.
        this.owned.delete(pid);
        this.resolved.add(pid);
      } else {
        rows.set(pid, item);
      }
    }
    return [...rows.values()];
  }
  private alive(list: MacProcess[]): MacProcess[] {
    return list.filter(item => !item.zombie && this.owned.get(item.pid) === item.birth);
  }
  private discover(list: MacProcess[], deadline: number): void {
    const current = new Map(list.map(item => [item.pid, item]));
    const root = current.get(this.pid);
    const checked = new Map<string, boolean>();
    const afterSnapshot = (pid: number, birth: string): boolean => {
      const key = `${pid}:${birth}`;
      const cached = checked.get(key); if (cached !== undefined) return cached;
      if (checked.size >= 256) throw new Error('STOP_METADATA_FAILED');
      const status = this.status(pid, birth, deadline);
      const alive = status !== undefined && !status.zombie;
      checked.set(key, alive);
      return alive;
    };
    const notOlder = (child: string, parent: string): boolean => {
      const ticks = (birth: string) => { const [seconds, micros] = birth.split(':'); return BigInt(seconds) * 1000000n + BigInt(micros); };
      return ticks(child) >= ticks(parent);
    };
    let added = true;
    while (added) {
      added = false;
      for (const item of list) {
        if (item.zombie) continue;
        if (this.owned.get(item.pid) === item.birth) continue;
        const parent = current.get(item.parent);
        // Inventory rows are sampled separately. Recheck each authority AFTER the child row to exclude PID/session reuse joins.
        const sameSession = root?.birth === this.rootBirth && item.session === this.session && notOlder(item.birth, this.rootBirth) &&
          afterSnapshot(this.pid, this.rootBirth);
        const directChild = !sameSession && parent && this.owned.get(parent.pid) === parent.birth && notOlder(item.birth, parent.birth) &&
          afterSnapshot(parent.pid, parent.birth);
        if (sameSession || directChild) {
          this.owned.set(item.pid, item.birth); added = true;
        }
      }
    }
  }
  remaining(): boolean {
    try {
      const deadline = performance.now() + metadataBudgetMs;
      const list = this.list(deadline); this.discover(list, deadline);
      return this.trackingFailed || this.alive(list).length > 0;
    } catch { this.trackingFailed = true; return true; }
  }
  async stop(): Promise<number[]> {
    const deadline = performance.now() + 10000;
    while (performance.now() < deadline) {
      const metadataDeadline = Math.min(deadline, performance.now() + metadataBudgetMs);
      const list = this.list(metadataDeadline); this.discover(list, metadataDeadline);
      const alive = this.alive(list);
      if (!alive.length) {
        this.dispose();
        if (this.trackingFailed) throw new Error('STOP_TRACKING_FAILED: Tracked descendant cleanup could not be verified.');
        return [...this.resolved];
      }
      // Descendants first, root last. The helper signals an audit token, never a numeric PID.
      for (const item of alive.sort((a, b) => Number(a.pid === this.pid) - Number(b.pid === this.pid))) {
        try { execute(this.helper, ['kill', String(item.pid), item.birth, String(item.session)], Math.min(metadataBudgetMs, remainingTime(deadline))); }
        catch { throw new Error('STOP_TREE_FAILED: Owned cleanup was not verified; retry deliberately.'); }
      }
      await new Promise(resolve => setTimeout(resolve, 25));
    }
    throw new Error('STOP_TREE_TIMEOUT');
  }
  dispose(): void { clearInterval(this.timer); this.timer = undefined; }
}
