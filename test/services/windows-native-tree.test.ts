import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import test from 'node:test';
import { getProcessSnapshot, stopProcessTree, type ProcessSnapshotRow, type ProcessTreeOwnership, type WindowsProcessCommand } from '../../app/services/process-tree.js';

const execute = promisify(execFile);
const root: ProcessSnapshotRow = { ProcessId: 91001, ParentProcessId: 1, CreationDate: '2026-10-27T20:00:00.000Z' };
const child: ProcessSnapshotRow = { ProcessId: 91002, ParentProcessId: root.ProcessId, CreationDate: '2026-10-27T20:00:01.000Z' };
const grandchild: ProcessSnapshotRow = { ProcessId: 91003, ParentProcessId: child.ProcessId, CreationDate: '2026-10-27T20:00:02.000Z' };
const sibling: ProcessSnapshotRow = { ProcessId: 91004, ParentProcessId: 1, CreationDate: '2026-10-27T20:00:03.000Z' };
const ownership = (): ProcessTreeOwnership => ({ processes: new Map(), createdAfter: Date.parse(root.CreationDate) - 1, createdBefore: Date.parse(root.CreationDate) + 1 });
type DiagnosedError = Error & { code: string; diagnostics: Record<string, unknown>; cause: Error & { code: string | number | null } };
const subprocess = (source: string): WindowsProcessCommand => (_phase, _script, options) =>
  execute(process.execPath, ['-e', source], { windowsHide: true, ...options });

test('Windows snapshot query projects only ownership properties and accepts a real subprocess response', async () => {
  const rows = [root, child, sibling];
  const runner: WindowsProcessCommand = async (phase, script, options) => {
    assert.equal(phase, 'snapshot');
    assert.match(script, /Get-CimInstance -ClassName Win32_Process -Property ProcessId,ParentProcessId,CreationDate -ErrorAction Stop/);
    assert.match(script, /\$ErrorActionPreference='Stop'/);
    assert.equal(options.timeout, 5000); assert.equal(options.maxBuffer, 1024 * 1024);
    return subprocess('process.stdout.write(' + JSON.stringify(JSON.stringify(rows)) + ')')(phase, script, options);
  };
  assert.deepEqual(await getProcessSnapshot(5000, runner), rows);
});

test('Windows snapshot nonzero exit reports safe phase/code/output sizes without output contents', async () => {
  const stdout = 'owned-private-stdout', stderr = 'owned-private-stderr';
  const runner = subprocess(`process.stdout.write(${JSON.stringify(stdout)});process.stderr.write(${JSON.stringify(stderr)});process.exit(23)`);
  await assert.rejects(getProcessSnapshot(5000, runner), error => {
    const failure = error as DiagnosedError;
    assert.equal(failure.code, 'STOP_SNAPSHOT_QUERY_FAILED');
    assert.equal(failure.diagnostics.phase, 'snapshot'); assert.equal(failure.diagnostics.kind, 'exit');
    assert.equal(failure.diagnostics.code, 23); assert.equal(failure.diagnostics.killed, false);
    assert.equal(failure.diagnostics.stdoutBytes, Buffer.byteLength(stdout)); assert.equal(failure.diagnostics.stderrBytes, Buffer.byteLength(stderr));
    assert.equal(failure.cause.code, 23);
    assert.equal(JSON.stringify(failure).includes('owned-private-'), false);
    return true;
  });
});

test('Windows snapshot command timeout and output-limit failures remain distinct and bounded', async () => {
  await assert.rejects(getProcessSnapshot(50, subprocess('setInterval(()=>{},1000)')), error => {
    const failure = error as DiagnosedError;
    assert.equal(failure.diagnostics.kind, 'timeout'); assert.equal(failure.diagnostics.timeoutMs, 50);
    assert.equal(failure.diagnostics.killed, true); assert.ok(Number(failure.diagnostics.elapsedMs) >= 40);
    return true;
  });
  await assert.rejects(getProcessSnapshot(5000, subprocess("process.stdout.write('x'.repeat(1024*1024+1))")), error => {
    const failure = error as DiagnosedError;
    assert.equal(failure.diagnostics.kind, 'buffer');
    assert.equal(failure.diagnostics.code, 'ERR_CHILD_PROCESS_STDIO_MAXBUFFER');
    assert.ok(Number(failure.diagnostics.stdoutBytes) >= 1024 * 1024);
    return true;
  });
});

test('incomplete, malformed or ambiguous snapshots never signal a process or clear retained ownership', async () => {
  for (const stdout of ['{', 'null', JSON.stringify([root, { ...child, CreationDate: null }]), JSON.stringify([root, root])]) {
    const retained: ProcessTreeOwnership = { ...ownership(), processes: new Map([[root.ProcessId, root.CreationDate]]) };
    let effects = 0;
    const runner: WindowsProcessCommand = async phase => {
      if (phase === 'stop') effects++;
      return { stdout };
    };
    await assert.rejects(stopProcessTree(root.ProcessId, retained, runner), /STOP_METADATA_FAILED/);
    assert.equal(effects, 0); assert.deepEqual([...retained.processes], [[root.ProcessId, root.CreationDate]]);
  }
});

test('Windows tree cleanup signals only complete validated lineage and verifies a fresh snapshot afterward', async () => {
  const retained = ownership(); let snapshots = 0; const targets: number[] = [];
  const runner: WindowsProcessCommand = async (phase, source, options) => {
    assert.ok(options.timeout >= 1 && options.timeout <= 5000);
    if (phase === 'snapshot') return { stdout: JSON.stringify(snapshots++ ? [sibling] : [grandchild, sibling, root, child]) };
    targets.push(...[...source.matchAll(/GetProcessById\((\d+)\)/g)].map(match => Number(match[1])));
    assert.match(source, /\$ownedHandle = \$ownedProcess.Handle/);
    assert.match(source, /StartTime.ToUniversalTime\(\)/);
    return { stdout: '' };
  };
  assert.deepEqual(await stopProcessTree(root.ProcessId, retained, runner), [root.ProcessId, child.ProcessId, grandchild.ProcessId]);
  assert.deepEqual(targets, [grandchild.ProcessId, child.ProcessId, root.ProcessId]);
  assert.equal(snapshots, 2); assert.equal(targets.includes(sibling.ProcessId), false);
});

test('failed tree signaling retains generations; retry never targets a reused root PID or its new children', async () => {
  const retained = ownership();
  await assert.rejects(stopProcessTree(root.ProcessId, retained, async phase => {
    if (phase === 'snapshot') return { stdout: JSON.stringify([root, child]) };
    throw Object.assign(new Error('owned kill fixture failure'), { code: 23, killed: false, signal: null, stderr: 'owned-private-stderr' });
  }), error => {
    const failure = error as DiagnosedError; assert.equal(failure.code, 'STOP_TREE_FAILED'); assert.equal(failure.diagnostics.phase, 'stop');
    return true;
  });
  assert.deepEqual([...retained.processes], [[root.ProcessId, root.CreationDate], [child.ProcessId, child.CreationDate]]);
  let effects = 0;
  const reused = { ...root, CreationDate: '2026-10-27T20:01:00.000Z' };
  const replacementChild = { ProcessId: 91005, ParentProcessId: root.ProcessId, CreationDate: '2026-10-27T20:01:01.000Z' };
  const verified = await stopProcessTree(root.ProcessId, retained, async phase => {
    if (phase === 'stop') effects++;
    return { stdout: JSON.stringify([reused, replacementChild, sibling]) };
  });
  assert.deepEqual(verified, [root.ProcessId, child.ProcessId]); assert.equal(effects, 0);
});

test('a snapshot consuming the overall cleanup budget never initiates a stop command', async () => {
  const originalNow = Date.now; let now = 1000, effects = 0;
  const retained = ownership();
  try {
    Date.now = () => now;
    await assert.rejects(stopProcessTree(root.ProcessId, retained, async phase => {
      if (phase === 'snapshot') { now += 15000; return { stdout: JSON.stringify([root, child]) }; }
      effects++; return { stdout: '' };
    }), /STOP_TREE_TIMEOUT/);
    assert.equal(effects, 0);
    assert.deepEqual([...retained.processes], [[root.ProcessId, root.CreationDate], [child.ProcessId, child.CreationDate]]);
  } finally { Date.now = originalNow; }
});
