import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import test from 'node:test';
import { windowsProcessHelperEnvironment, getProcessSnapshot, stopProcessTree, type ProcessSnapshotRow, type ProcessTreeOwnership, type WindowsProcessCommand } from '../../app/services/process-tree.js';

const execute = promisify(execFile);
const root: ProcessSnapshotRow = { ProcessId: 91001, ParentProcessId: 1, CreationDate: '2026-10-27T20:00:00.0000000Z' };
const child: ProcessSnapshotRow = { ProcessId: 91002, ParentProcessId: root.ProcessId, CreationDate: '2026-10-27T20:00:01.0000000Z' };
const grandchild: ProcessSnapshotRow = { ProcessId: 91003, ParentProcessId: child.ProcessId, CreationDate: '2026-10-27T20:00:02.0000000Z' };
const sibling: ProcessSnapshotRow = { ProcessId: 91004, ParentProcessId: 1, CreationDate: '2026-10-27T20:00:03.0000000Z' };
const ownership = (): ProcessTreeOwnership => ({ processes: new Map(), createdAfter: Date.parse(root.CreationDate) - 1, createdBefore: Date.parse(root.CreationDate) + 1 });
// Lineage fixtures use normalized UTC; the provider wire format remains raw DMTF only.
function snapshotJson(rows: unknown[]): string {
  return JSON.stringify(rows.map(value => {
    if (!value || typeof value !== 'object' || Array.isArray(value)) return value;
    const row = value as Record<string, unknown>;
    if (typeof row.CreationDate !== 'string') return row;
    const match = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})\.(\d{7})Z$/.exec(row.CreationDate);
    return match ? { ...row, CreationDate: match.slice(1, 7).join('') + '.' + match[7].slice(0, 6) + '+000' } : row;
  }));
}
type DiagnosedError = Error & { code: string; diagnostics: Record<string, unknown>; cause: Error & { code: string | number | null } };
const subprocess = (source: string): WindowsProcessCommand => (_phase, _script, options) =>
  execute(process.execPath, ['-e', source], { windowsHide: true, ...options });

test('Windows snapshot query projects only ownership properties and accepts a real subprocess response', async () => {
  const rows = [root, child, sibling];
  const runner: WindowsProcessCommand = async (phase, script, options) => {
    assert.equal(phase, 'snapshot');
    assert.match(script, /Add-Type -AssemblyName System.Management/);
    assert.match(script, /SELECT ProcessId,ParentProcessId,CreationDate FROM Win32_Process/);
    assert.doesNotMatch(script, /CimCmdlets|Get-CimInstance|ManagementDateTimeConverter|ToUniversalTime|Set-ExecutionPolicy/);
    assert.match(script, /\$item\.Dispose\(\)/); assert.match(script, /\$collection\.Dispose\(\)/); assert.match(script, /\$searcher\.Dispose\(\)/);
    assert.match(script, /\$ErrorActionPreference='Stop'/);
    assert.equal(options.timeout, 5000); assert.equal(options.maxBuffer, 1024 * 1024);
    return subprocess('process.stdout.write(' + JSON.stringify(snapshotJson(rows)) + ')')(phase, script, options);
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
  for (const stdout of ['{', 'null', snapshotJson([root, { ...child, CreationDate: null }]), snapshotJson([root, root])]) {
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
    if (phase === 'snapshot') return { stdout: snapshotJson(snapshots++ ? [sibling] : [grandchild, sibling, root, child]) };
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
    if (phase === 'snapshot') return { stdout: snapshotJson([root, child]) };
    throw Object.assign(new Error('owned kill fixture failure'), { code: 23, killed: false, signal: null, stderr: 'owned-private-stderr' });
  }), error => {
    const failure = error as DiagnosedError; assert.equal(failure.code, 'STOP_TREE_FAILED'); assert.equal(failure.diagnostics.phase, 'stop');
    return true;
  });
  assert.deepEqual([...retained.processes], [[root.ProcessId, root.CreationDate], [child.ProcessId, child.CreationDate]]);
  let effects = 0;
  const reused = { ...root, CreationDate: '2026-10-27T20:01:00.0000000Z' };
  const replacementChild = { ProcessId: 91005, ParentProcessId: root.ProcessId, CreationDate: '2026-10-27T20:01:01.0000000Z' };
  const verified = await stopProcessTree(root.ProcessId, retained, async phase => {
    if (phase === 'stop') effects++;
    return { stdout: snapshotJson([reused, replacementChild, sibling]) };
  });
  assert.deepEqual(verified, [root.ProcessId, child.ProcessId]); assert.equal(effects, 0);
});

test('a snapshot consuming the overall cleanup budget never initiates a stop command', async () => {
  const originalNow = Date.now; let now = 1000, effects = 0;
  const retained = ownership();
  try {
    Date.now = () => now;
    await assert.rejects(stopProcessTree(root.ProcessId, retained, async phase => {
      if (phase === 'snapshot') { now += 15000; return { stdout: snapshotJson([root, child]) }; }
      effects++; return { stdout: '' };
    }), /STOP_TREE_TIMEOUT/);
    assert.equal(effects, 0);
    assert.deepEqual([...retained.processes], [[root.ProcessId, root.CreationDate], [child.ProcessId, child.CreationDate]]);
  } finally { Date.now = originalNow; }
});

const timedOut = () => Object.assign(new Error('owned snapshot command timeout'), { code: null, signal: 'SIGTERM', killed: true, stdout: '', stderr: '' });
test('one typed snapshot timeout retries only the read, then signals after complete validation', async () => {
  const originalNow = Date.now; let now = 1000, snapshots = 0, effects = 0;
  const retained = ownership();
  try {
    Date.now = () => now;
    const verified = await stopProcessTree(root.ProcessId, retained, async (phase, _source, options) => {
      assert.ok(options.timeout >= 1 && options.timeout <= 5000);
      if (phase === 'snapshot') {
        snapshots++;
        if (snapshots === 1) { now += 5000; assert.equal(effects, 0); throw timedOut(); }
        if (snapshots === 2) { assert.equal(effects, 0); return { stdout: snapshotJson([root, child]) }; }
        return { stdout: snapshotJson([sibling]) };
      }
      assert.equal(snapshots, 2); effects++; return { stdout: '' };
    });
    assert.deepEqual(verified, [root.ProcessId, child.ProcessId]); assert.equal(snapshots, 3); assert.equal(effects, 1);
  } finally { Date.now = originalNow; }
});

test('two typed snapshot timeouts fail without signals and retain known generations', async () => {
  const originalNow = Date.now; let now = 1000, snapshots = 0, effects = 0;
  const retained: ProcessTreeOwnership = { ...ownership(), processes: new Map([[root.ProcessId, root.CreationDate]]) };
  try {
    Date.now = () => now;
    await assert.rejects(stopProcessTree(root.ProcessId, retained, async (phase, _source, options) => {
      if (phase === 'stop') { effects++; return { stdout: '' }; }
      snapshots++; now += options.timeout; throw timedOut();
    }), /STOP_SNAPSHOT_QUERY_FAILED/);
    assert.equal(snapshots, 2); assert.equal(effects, 0);
    assert.deepEqual([...retained.processes], [[root.ProcessId, root.CreationDate]]);
  } finally { Date.now = originalNow; }
});

test('snapshot timeout cannot retry after the overall deadline is exhausted', async () => {
  const originalNow = Date.now; let now = 1000, snapshots = 0;
  const retained = ownership();
  try {
    Date.now = () => now;
    await assert.rejects(stopProcessTree(root.ProcessId, retained, async phase => {
      assert.equal(phase, 'snapshot'); snapshots++; now += 15000; throw timedOut();
    }), /STOP_SNAPSHOT_QUERY_FAILED/);
    assert.equal(snapshots, 1); assert.equal(retained.processes.size, 0);
  } finally { Date.now = originalNow; }
});

test('invalid snapshots, command exits and output limits remain terminal without a snapshot retry', async () => {
  for (const failure of [null, Object.assign(new Error('owned command exit'), { code: 23, killed: false }),
    Object.assign(new Error('owned output limit'), { code: 'ERR_CHILD_PROCESS_STDIO_MAXBUFFER', killed: true })]) {
    let snapshots = 0;
    await assert.rejects(stopProcessTree(root.ProcessId, ownership(), async phase => {
      assert.equal(phase, 'snapshot'); snapshots++;
      if (failure) throw failure;
      return { stdout: snapshotJson([root, { ...child, CreationDate: null }]) };
    }), /STOP_METADATA_FAILED|STOP_SNAPSHOT_QUERY_FAILED/);
    assert.equal(snapshots, 1);
  }
});

test('the read retry allowance is shared across the whole Stop and never retries a stop command', async () => {
  let snapshots = 0, effects = 0;
  await assert.rejects(stopProcessTree(root.ProcessId, ownership(), async phase => {
    if (phase === 'snapshot') {
      snapshots++; if (snapshots === 1 || snapshots === 3) throw timedOut();
      return { stdout: snapshotJson([root]) };
    }
    effects++; return { stdout: '' };
  }), /STOP_SNAPSHOT_QUERY_FAILED/);
  assert.equal(snapshots, 3); assert.equal(effects, 1);
  snapshots = 0; effects = 0;
  await assert.rejects(stopProcessTree(root.ProcessId, ownership(), async phase => {
    if (phase === 'snapshot') { snapshots++; return { stdout: snapshotJson([root]) }; }
    effects++; throw timedOut();
  }), /STOP_TREE_FAILED/);
  assert.equal(snapshots, 1); assert.equal(effects, 1);
});


test('private Windows process helper pins OS modules without mutating inherited or CLI environment', () => {
  for (const aliases of [{}, { PSModulePath: 'C:\\pwsh7-modules' }, { PsModulePath: 'missing-one', psmodulepath: 'missing-two' }]) {
    const parent = { SystemRoot: 'C:\\Windows', PATH: 'owned-cli-path', OWNED_CLI_SETTING: 'preserved', ...aliases };
    const before = { ...parent }, helper = windowsProcessHelperEnvironment(parent);
    assert.deepEqual(parent, before); assert.notEqual(helper, parent);
    assert.deepEqual(Object.keys(helper).filter(key => key.toUpperCase() === 'PSMODULEPATH'), ['PSModulePath']);
    assert.equal(helper.PSModulePath, 'C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\Modules');
    assert.equal(helper.PATH, parent.PATH); assert.equal(helper.OWNED_CLI_SETTING, parent.OWNED_CLI_SETTING);
  }
  assert.throws(() => windowsProcessHelperEnvironment({ SystemRoot: 'relative' }), /STOP_SYSTEMROOT_INVALID/);
});


test('raw Windows birth metadata normalizes offsets and microseconds independently of local DST', async () => {
  const cases = [
    ['20261101013000.123456-240', '2026-11-01T05:30:00.1234560Z'],
    ['20261101013000.123456-300', '2026-11-01T06:30:00.1234560Z'],
    ['20260101010000.000001+330', '2025-12-31T19:30:00.0000010Z'],
    ['20261028120000.654321+999', '2026-10-27T19:21:00.6543210Z'],
    ['20261028120000.654321-999', '2026-10-29T04:39:00.6543210Z'],
    ['00010101000000.000001+000', '0001-01-01T00:00:00.0000010Z'],
    ['00991231235959.999999-000', '0099-12-31T23:59:59.9999990Z'],
    ['20240229000000.999999+000', '2024-02-29T00:00:00.9999990Z'],
  ];
  const originalTZ = process.env.TZ;
  try {
    for (const timezone of ['UTC', 'America/New_York', 'Asia/Kolkata']) {
      process.env.TZ = timezone;
      for (const [wire, expected] of cases) {
        const rows = await getProcessSnapshot(5000, async () => ({ stdout: JSON.stringify({ ...root, CreationDate: wire }) }));
        assert.equal(rows[0].CreationDate, expected, timezone + ' ' + wire);
      }
    }
  } finally { if (originalTZ === undefined) delete process.env.TZ; else process.env.TZ = originalTZ; }
});

test('unknown or invalid DMTF births reject the complete snapshot before any signal or identity retention', async () => {
  const invalid = [null, '', '20261028120000.000000+***', '2026**********.000000+000', '20261028120000.000000+1000',
    '20261028120000.000000000', '20261028120000.00000+000', '20261028120000.000000+000\n', '２０２６1028120000.000000+000',
    '00000101000000.000000+000', '20260229000000.000000+000', '20260431000000.000000+000', '20261301000000.000000+000',
    '20260001000000.000000+000', '20260100235959.000000+000', '20260101240000.000000+000', '20260101006000.000000+000',
    '20260101000060.000000+000', '00010101000000.000000+001', '99991231235959.999999-001', root.CreationDate];
  for (const birth of invalid) {
    const retained = ownership(); let signals = 0;
    await assert.rejects(stopProcessTree(root.ProcessId, retained, async phase => {
      if (phase === 'stop') signals++;
      return { stdout: JSON.stringify([{ ...root, CreationDate: '20261027200000.000000+000' }, { ...child, CreationDate: birth }]) };
    }), /STOP_METADATA_FAILED/);
    assert.equal(signals, 0); assert.equal(retained.processes.size, 0, 'No row authorizes effects after a rejected snapshot');
  }
});
