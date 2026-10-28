import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import path from 'node:path';
import { resolveExecutable } from '../../config/application.js';

const execute = promisify(execFile);
const windowsDirectory = process.env.SystemRoot ?? process.env.SYSTEMROOT;
const powershell = windowsDirectory ? path.win32.join(windowsDirectory, 'System32/WindowsPowerShell/v1.0/powershell.exe') : 'powershell.exe';
// Windows wall-clock samples can differ from kernel process creation time by one 15.625 ms tick.
const clockTickMs = 16;
export interface ProcessSnapshotRow { ProcessId: number; ParentProcessId: number; CreationDate: string }
type CommandOptions = { timeout: number; maxBuffer: number };
export type WindowsProcessCommand = (phase: 'snapshot' | 'stop', source: string, options: CommandOptions) => Promise<{ stdout: string; stderr?: string }>;
type CommandDiagnostics = { phase: 'snapshot' | 'stop'; kind: string; elapsedMs: number; timeoutMs: number;
  code: string | number | null; signal: string | null; killed: boolean; stdoutBytes: number; stderrBytes: number };
class WindowsProcessCommandFailure extends Error {
  constructor(readonly code: string, readonly diagnostics: CommandDiagnostics, cause: Error) {
    super(code + ': Owned process metadata or cleanup was not verified; retry deliberately.', { cause });
  }
}
/** Isolate only our private PS5.1 metadata helper from inherited/pwsh module search paths. */
export function windowsProcessHelperEnvironment(parent: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  const systemRoot = Object.entries(parent).find(([key]) => key.toUpperCase() === 'SYSTEMROOT')?.[1];
  if (!systemRoot || !path.win32.isAbsolute(systemRoot)) throw new Error('STOP_SYSTEMROOT_INVALID');
  return { ...Object.fromEntries(Object.entries(parent).filter(([key]) => key.toUpperCase() !== 'PSMODULEPATH')),
    PSModulePath: path.win32.join(systemRoot, 'System32/WindowsPowerShell/v1.0/Modules') };
}
// Shared with read-only qualification controls; no script/row contents enter diagnostics.
export const executeWindowsCommand: WindowsProcessCommand = (_phase, source, options) => execute(resolveExecutable(powershell),
  ['-NoLogo', '-NoProfile', '-NonInteractive', '-Command', source], { windowsHide: true, ...options, env: windowsProcessHelperEnvironment(process.env) });
const snapshotSource = "$ErrorActionPreference='Stop'; CimCmdlets\\Get-CimInstance -ClassName Win32_Process -Property ProcessId,ParentProcessId,CreationDate -ErrorAction Stop | " +
  "Microsoft.PowerShell.Utility\\Select-Object ProcessId,ParentProcessId,@{n='CreationDate';e={$_.CreationDate.ToUniversalTime().ToString('o')}} | Microsoft.PowerShell.Utility\\ConvertTo-Json -Compress";
function bytes(value: unknown): number { return typeof value === 'string' || Buffer.isBuffer(value) ? Buffer.byteLength(value) : 0; }
async function runCommand(phase: 'snapshot' | 'stop', source: string, options: CommandOptions, executeCommand: WindowsProcessCommand) {
  const started = performance.now();
  try {
    const result = await executeCommand(phase, source, options);
    return { ...result, elapsedMs: Math.round(performance.now() - started) };
  } catch (error) {
    const failure = (error && typeof error === 'object' ? error : {}) as { code?: unknown; signal?: unknown; killed?: unknown; stdout?: unknown; stderr?: unknown };
    const code = typeof failure.code === 'string' || typeof failure.code === 'number' ? failure.code : null;
    const signal = typeof failure.signal === 'string' ? failure.signal : null;
    const killed = failure.killed === true;
    // execFile's only internal kill paths here are the configured timeout and maxBuffer bound.
    const kind = code === 'ERR_CHILD_PROCESS_STDIO_MAXBUFFER' ? 'buffer' : killed ? 'timeout' : typeof code === 'number' ? 'exit' : signal ? 'signal' : 'command';
    const diagnostics = { phase, kind, elapsedMs: Math.round(performance.now() - started), timeoutMs: options.timeout,
      code, signal, killed, stdoutBytes: bytes(failure.stdout), stderrBytes: bytes(failure.stderr) };
    const cause = Object.assign(new Error('Windows process command failed; output contents are omitted.'), diagnostics);
    const label = phase === 'snapshot' ? 'STOP_SNAPSHOT_QUERY_FAILED' : 'STOP_TREE_FAILED';
    throw new WindowsProcessCommandFailure(label, diagnostics, cause);
  }
}
function invalidSnapshot(kind: string, stdout: string, stderr: string | undefined, elapsedMs: number, timeoutMs: number): never {
  throw Object.assign(new Error('STOP_METADATA_FAILED: A complete valid process snapshot was not returned.'),
    { code: 'STOP_METADATA_FAILED', diagnostics: { phase: 'snapshot', kind, elapsedMs, timeoutMs, code: 0, signal: null, killed: false,
      stdoutBytes: bytes(stdout), stderrBytes: bytes(stderr) } });
}

/** Read a complete projected snapshot before deciding which generation-bound processes may be signaled. */
export async function getProcessSnapshot(timeoutMs: number, executeCommand: WindowsProcessCommand = executeWindowsCommand): Promise<ProcessSnapshotRow[]> {
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 5000) throw new Error('STOP_SNAPSHOT_BUDGET_INVALID');
  const { stdout, stderr, elapsedMs } = await runCommand('snapshot', snapshotSource, { timeout: timeoutMs, maxBuffer: 1024 * 1024 }, executeCommand);
  let parsed: unknown;
  try { parsed = JSON.parse(stdout); } catch { invalidSnapshot('invalid-json', stdout, stderr, elapsedMs, timeoutMs); }
  const list = Array.isArray(parsed) ? parsed : [parsed];
  const seen = new Set<number>();
  for (const value of list) {
    if (!value || typeof value !== 'object' || Array.isArray(value)) invalidSnapshot('invalid-row', stdout, stderr, elapsedMs, timeoutMs);
    const item = value as ProcessSnapshotRow;
    if (Object.keys(item).length !== 3 || !['ProcessId', 'ParentProcessId', 'CreationDate'].every(key => Object.hasOwn(item, key)) ||
      !Number.isSafeInteger(item.ProcessId) || item.ProcessId < 0 || item.ProcessId > 0xffffffff || seen.has(item.ProcessId) ||
      !Number.isSafeInteger(item.ParentProcessId) || item.ParentProcessId < 0 || item.ParentProcessId > 0xffffffff ||
      typeof item.CreationDate !== 'string' || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,7})?(?:Z|\+00:00)$/.test(item.CreationDate) ||
      !Number.isFinite(Date.parse(item.CreationDate))) invalidSnapshot('invalid-row', stdout, stderr, elapsedMs, timeoutMs);
    seen.add(item.ProcessId);
  }
  return list as ProcessSnapshotRow[];
}
export interface ProcessTreeOwnership {
  processes: Map<number, string>; createdAfter?: number; createdBefore?: number; exitedAt?: number;
}
export function processAlive(pid: number): boolean {
  try { process.kill(pid, 0); return true; } catch { return false; }
}
export async function stopProcessTree(ownedPid: number, ownership: ProcessTreeOwnership = { processes: new Map() },
  executeCommand: WindowsProcessCommand = executeWindowsCommand): Promise<number[]> {
  if (!Number.isSafeInteger(ownedPid) || ownedPid <= 0) throw new Error('STOP_INVALID_OWNED_PROCESS');
  const deadline = Date.now() + 15000;
  let snapshotRetried = false;
  // Retain identities before effects, including on failure. Root exit never ends tree ownership.
  while (Date.now() < deadline) {
    let list: ProcessSnapshotRow[];
    try { list = await getProcessSnapshot(Math.min(5000, Math.max(1, deadline - Date.now())), executeCommand); }
    catch (error) {
      // A cold CIM query can consume its command budget. Retry that read once,
      // within the original overall deadline; no partial metadata authorizes effects.
      if (!snapshotRetried && error instanceof WindowsProcessCommandFailure && error.diagnostics.phase === 'snapshot' &&
        error.diagnostics.kind === 'timeout' && Date.now() < deadline) { snapshotRetried = true; continue; }
      throw error;
    }
    const current = new Map(list.map(item => [item.ProcessId, item])); const root = current.get(ownedPid);
    if (root && !ownership.processes.has(ownedPid) &&
      Date.parse(root.CreationDate) >= (ownership.createdAfter ?? 0) - clockTickMs &&
      Date.parse(root.CreationDate) <= (ownership.createdBefore ?? Infinity) + clockTickMs) ownership.processes.set(ownedPid, root.CreationDate);
    if (root && !ownership.processes.has(ownedPid) && ownership.exitedAt === undefined) throw new Error('STOP_ROOT_IDENTITY_CHANGED: The owned process identity could not be verified.');
    let added = true;
    while (added) {
      added = false;
      for (const item of list) {
        const parentBirth = ownership.processes.get(item.ParentProcessId);
        if (item.ParentProcessId !== ownedPid && !parentBirth || ownership.processes.has(item.ProcessId)) continue;
        const birth = Date.parse(item.CreationDate); const replacement = current.get(item.ParentProcessId);
        const expectedBirth = parentBirth ?? new Date((ownership.createdAfter ?? 0) - clockTickMs).toISOString();
        if (birth < Date.parse(expectedBirth) || replacement && replacement.CreationDate !== parentBirth &&
          birth >= Date.parse(replacement.CreationDate) || item.ParentProcessId === ownedPid && birth > (ownership.exitedAt ?? Infinity) + clockTickMs) continue;
        ownership.processes.set(item.ProcessId, item.CreationDate); added = true;
      }
    }
    const alive = [...ownership.processes].filter(([pid, birth]) => current.get(pid)?.CreationDate === birth);
    if (!alive.length) return [...new Set([ownedPid, ...ownership.processes.keys()])];
    const targets = alive.sort((a, b) => Date.parse(b[1]) - Date.parse(a[1]));
    // Pin a native Process handle before checking its birth and killing; a reused PID is never targeted.
    const script = "$ErrorActionPreference='Stop';\n" + targets.map(([pid, birth]) => `
$ownedProcess = $null
try {
  try { $ownedProcess = [Diagnostics.Process]::GetProcessById(${pid}); $ownedHandle = $ownedProcess.Handle } catch { }
  if ($null -ne $ownedProcess -and !$ownedProcess.HasExited -and
      [Math]::Abs(($ownedProcess.StartTime.ToUniversalTime() - [DateTime]::Parse('${birth}').ToUniversalTime()).Ticks) -lt 10) {
    $ownedProcess.Kill()
    if (!$ownedProcess.WaitForExit(5000)) { throw 'STOP_TREE_TIMEOUT' }
  }
} finally { if ($null -ne $ownedProcess) { $ownedProcess.Dispose() } }
`).join('\n');
    const remaining = deadline - Date.now();
    if (remaining <= 0) throw new Error('STOP_TREE_TIMEOUT: The cleanup budget expired before signaling; ownership is retained.');
    await runCommand('stop', script, { timeout: Math.min(5000, remaining), maxBuffer: 64 * 1024 }, executeCommand);
    // Requery the retained lineage to find descendants born during cleanup, even after their parent exits.
  }
  throw new Error('STOP_TREE_TIMEOUT: Owned process exit could not be verified.');
}
