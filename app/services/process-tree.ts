import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import path from 'node:path';
import { resolveExecutable } from '../../config/application.js';

const execute = promisify(execFile);
const windowsDirectory = process.env.SystemRoot ?? process.env.SYSTEMROOT;
const powershell = windowsDirectory ? path.win32.join(windowsDirectory, 'System32/WindowsPowerShell/v1.0/powershell.exe') : 'powershell.exe';
// Windows wall-clock samples can differ from kernel process creation time by one 15.625 ms tick.
const clockTickMs = 16;
export interface ProcessTreeOwnership {
  processes: Map<number, string>; createdAfter?: number; createdBefore?: number; exitedAt?: number;
}
export function processAlive(pid: number): boolean {
  try { process.kill(pid, 0); return true; } catch { return false; }
}
export async function stopProcessTree(ownedPid: number, ownership: ProcessTreeOwnership = { processes: new Map() }): Promise<number[]> {
  if (!Number.isSafeInteger(ownedPid) || ownedPid <= 0) throw new Error('STOP_INVALID_OWNED_PROCESS');
  const deadline = Date.now() + 15000;
  // Retain identities before effects, including on failure. Root exit never ends tree ownership.
  while (Date.now() < deadline) {
    const { stdout } = await execute(resolveExecutable(powershell), ['-NoLogo', '-NoProfile', '-NonInteractive', '-Command',
      "Get-CimInstance Win32_Process | Select-Object ProcessId,ParentProcessId,@{n='CreationDate';e={$_.CreationDate.ToUniversalTime().ToString('o')}} | ConvertTo-Json -Compress"],
    { windowsHide: true, timeout: Math.min(5000, Math.max(1, deadline - Date.now())), maxBuffer: 1024 * 1024 });
    const parsed = JSON.parse(stdout) as unknown;
    const list = (Array.isArray(parsed) ? parsed : [parsed]) as Array<{ ProcessId: number; ParentProcessId: number; CreationDate: string }>;
    if (list.some(item => !Number.isSafeInteger(item.ProcessId) || !Number.isSafeInteger(item.ParentProcessId) ||
      typeof item.CreationDate !== 'string' || !Number.isFinite(Date.parse(item.CreationDate)))) throw new Error('STOP_METADATA_FAILED');
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
    try { await execute(resolveExecutable(powershell), ['-NoLogo', '-NoProfile', '-NonInteractive', '-Command', script],
      { windowsHide: true, timeout: Math.min(5000, Math.max(1, deadline - Date.now())), maxBuffer: 64 * 1024 }); }
    catch { throw new Error('STOP_TREE_FAILED: Owned process cleanup was not verified; retry deliberately.'); }
    // Requery the retained lineage to find descendants born during cleanup, even after their parent exits.
  }
  throw new Error('STOP_TREE_TIMEOUT: Owned process exit could not be verified.');
}
