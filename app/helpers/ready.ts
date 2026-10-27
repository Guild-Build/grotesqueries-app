import fs from 'node:fs';
import path from 'node:path';

/**
 * Grotesqueries 9: what a client reads instead of the host's stdout. `pids` is the server, then its launcher when the
 * launcher passed its own pid in `GROTESQUERIES_LAUNCHER_PID` (never process.ppid: smoke or a shell may be the parent).
 * `hostInstanceId` is what `/health` answers with, so a reader tells this host from a reused pid (ledger 0.6 item 1).
 */
export type ReadyRecord = { url: string; pid: number; pids: number[]; hostInstanceId: string; plugins: string[];
  refusals: Array<{ name: string; reason: string }> };

export function readyFilePath(root: string): string { return path.join(root, '.runtime', 'host-ready.json'); }

/**
 * The pids a ready file names for this process: itself, then the launcher that declared itself.
 * J5-S2-F2, ledger 5: the declared pid counts only when it is this process's own parent, so a value inherited from any
 * other environment (a shell, a test, a session) is ignored. ppid is the cross-check, never the source (ledger 0.6 item 1).
 */
export function hostPids(environment: NodeJS.ProcessEnv = process.env, parent = process.ppid): number[] {
  const launcher = Number(environment.GROTESQUERIES_LAUNCHER_PID);
  return Number.isSafeInteger(launcher) && launcher > 0 && launcher !== process.pid && launcher === parent
    ? [process.pid, launcher] : [process.pid];
}

/** Written once the host listens, under a temporary name first, so a reader never sees half a record. */
export function writeReadyFile(file: string, record: ReadyRecord): void {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const partial = `${file}.${record.pid}.tmp`;
  fs.writeFileSync(partial, JSON.stringify(record) + '\n');
  fs.renameSync(partial, file);
}

/**
 * Removed by the host's own shutdown, and only while it names this process: a second host sharing the tree's
 * `.runtime` keeps its file. A forced kill runs no shutdown, so a reader tells a stale file by `/health`.
 */
export function removeReadyFile(file: string, pid: number): void {
  try { if ((JSON.parse(fs.readFileSync(file, 'utf8')) as ReadyRecord).pid === pid) fs.unlinkSync(file); }
  catch { /* absent or unreadable: nothing of this host's to remove */ }
}

export function pidAlive(pid: number): boolean {
  try { process.kill(pid, 0); return true; } catch (error) { return (error as NodeJS.ErrnoException).code === 'EPERM'; }
}

/**
 * Ledger 0.6 item 1: a ready file is live only when its url's `/health` answers with its `hostInstanceId`. Anything
 * else, including a live pid that is not this host, is stale. `alive` lists the named pids still running.
 */
export async function readyState(file: string): Promise<{ state: 'absent' } |
  { state: 'live' | 'stale'; record: Partial<ReadyRecord>; alive: number[] }> {
  let record: Partial<ReadyRecord>;
  try { record = JSON.parse(fs.readFileSync(file, 'utf8')) as Partial<ReadyRecord>; }
  catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return { state: 'absent' }; record = {}; }
  const pids = Array.isArray(record.pids) ? record.pids : typeof record.pid === 'number' ? [record.pid] : [];
  const alive = pids.filter(pid => Number.isSafeInteger(pid) && pid > 0 && pidAlive(pid));
  let answered: unknown;
  try {
    if (typeof record.url === 'string' && /^http:\/\/127\.0\.0\.1:\d+$/.test(record.url) && typeof record.hostInstanceId === 'string')
      answered = (await fetch(`${record.url}/health`, { signal: AbortSignal.timeout(3000) }).then(response => response.json()) as { hostInstanceId?: unknown }).hostInstanceId;
  } catch { /* refused, timed out or not JSON: not this host */ }
  return { state: answered !== undefined && answered === record.hostInstanceId ? 'live' : 'stale', record, alive };
}
