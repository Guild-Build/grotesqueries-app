import assert from 'node:assert/strict';
import test from 'node:test';
import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { getProcessSnapshot } from '../../app/services/process-tree.js';
import { DiagnosticLogger } from '../../app/services/diagnostics.js';
import { scratchDirectory } from '../support/scratch.js';
import { SessionRegistry } from '../../app/models/sessions.js';
import { FakeLauncher, fixtureConfig } from '../support/helpers.js';

test('only deliberate Start launches; session IDs and immutable metadata survive inspection and sibling Stop', async () => {
  const launcher = new FakeLauncher(); const config = fixtureConfig();
  const registry = new SessionRegistry({ config, launcher });
  assert.deepEqual(registry.list(), []);
  assert.equal(registry.find('unallocated'), undefined);
  assert.equal(launcher.handles.length, 0);
  const first = await registry.start('powershell', 120, 40);
  const second = await registry.start('powershell', 90, 25);
  assert.notEqual(first.id, second.id);
  assert.equal(first.profileId, 'powershell'); assert.equal(first.agentState, 'unknown');
  const inspected = registry.find(first.id)!; inspected.label = 'changed by caller';
  assert.equal(registry.find(first.id)!.label, 'PowerShell');
  await registry.stop(first.id);
  assert.equal(registry.find(first.id)!.processState, 'exited');
  assert.equal(registry.find(second.id)!.processState, 'running');
  assert.equal(launcher.handles[1].stops, 0);
  await registry.shutdown(); await registry.shutdown();
  assert.equal(launcher.handles[1].stops, 1);
});

test('launch reservations enforce capacity, immediate exit stays accurate, and only old exited records are evicted', async () => {
  const config = fixtureConfig(); config.capacity.maxRunningSessions = 1; config.capacity.retainedExitedSessions = 1;
  const launcher = new FakeLauncher(); const registry = new SessionRegistry({ config, launcher });
  const pending = registry.start('powershell', 120, 40);
  await assert.rejects(registry.start('powershell', 120, 40), /SESSION_CAPACITY/);
  const first = await pending;
  await registry.stop(first.id);
  launcher.beforeReturn = pty => pty.exit(7);
  const immediate = await registry.start('powershell', 120, 40);
  assert.equal(immediate.processState, 'exited'); assert.equal(immediate.exitCode, 7);
  assert.equal(registry.find(first.id), undefined);
  assert.equal(registry.list().length, 1);
  await registry.shutdown();
});

test('retention keeps the most recently exited session and failed Stop allows deliberate recovery', async () => {
  const config = fixtureConfig(); config.capacity.retainedExitedSessions = 1;
  const launcher = new FakeLauncher(); const registry = new SessionRegistry({ config, launcher });
  const olderRunning = await registry.start('powershell', 120, 40);
  const newerRunning = await registry.start('powershell', 120, 40);
  await registry.stop(newerRunning.id);
  const nativeStop = launcher.handles[0].stop.bind(launcher.handles[0]);
  let attempts = 0;
  launcher.handles[0].stop = async () => { if (++attempts === 1) throw new Error('fixture transient failure'); return nativeStop(); };
  await assert.rejects(registry.stop(olderRunning.id));
  assert.equal(registry.find(olderRunning.id)!.stopPending, false);
  assert.equal(registry.find(olderRunning.id)!.processState, 'running');
  await registry.stop(olderRunning.id);
  assert.equal(attempts, 2);
  assert.equal(registry.find(newerRunning.id), undefined);
  assert.equal(registry.find(olderRunning.id)!.processState, 'exited');
  await registry.shutdown();
});

test('shutdown reports a finite cleanup failure without claiming a process exited', { timeout: 2000 }, async () => {
  const config = fixtureConfig(); const launcher = new FakeLauncher();
  const registry = new SessionRegistry({ config, launcher, shutdownTimeoutMs: 40 });
  const session = await registry.start('powershell', 120, 40);
  launcher.handles[0].stop = () => new Promise(() => {});
  await assert.rejects(registry.shutdown(), /HOST_SHUTDOWN_TIMEOUT/);
  assert.equal(registry.find(session.id)!.processState, 'running');
  await assert.rejects(registry.start('powershell', 120, 40), /HOST_CLOSING/);
});

test('failed exited-tree cleanup retains ownership and reserves capacity until verified retry', async () => {
  const config = fixtureConfig(); config.capacity.maxRunningSessions = 1; config.capacity.retainedExitedSessions = 1;
  const launcher = new FakeLauncher(); const registry = new SessionRegistry({ config, launcher });
  const failed = await registry.start('powershell', 120, 40); let attempts = 0;
  launcher.handles[0].stop = async () => {
    if (++attempts === 1) { launcher.handles[0].exit(7); throw new Error('STOP_TREE_FAILED'); }
    return { exitCode: 7, verifiedPids: [launcher.handles[0].pid] };
  };
  try {
    await assert.rejects(registry.stop(failed.id), /STOP_TREE_FAILED/);
    await registry.require(failed.id).drain();
    await assert.rejects(registry.start('powershell', 120, 40), /SESSION_CAPACITY/);
    config.capacity.maxRunningSessions = 2;
    const newer = await registry.start('powershell', 120, 40); await registry.stop(newer.id);
    assert.equal(registry.find(failed.id)!.failureCode, 'STOP_FAILED', 'exit retention cannot lose failed cleanup ownership');
    await registry.shutdown(); assert.equal(attempts, 2);
  } finally { await registry.shutdown(); }
});

test('later parser rejection or backlog overflow cannot erase failed cleanup ownership before retry', async () => {
  for (const cause of ['parser-error', 'parser-backlog']) {
  const config = fixtureConfig(); config.capacity.retainedExitedSessions = 1;
  const launcher = new FakeLauncher(); const registry = new SessionRegistry({ config, launcher });
  const summary = await registry.start('powershell', 120, 40); const record = registry.require(summary.id); let rejectParse!: (error: Error) => void; let attempts = 0;
  record.outputHandler = () => new Promise((_resolve, reject) => { rejectParse = reject; });
  launcher.handles[0].output('held harmless final output'); await new Promise(resolve => setImmediate(resolve));
  launcher.handles[0].stop = async () => {
    if (++attempts === 1) { launcher.handles[0].exit(7); throw new Error('STOP_TREE_FAILED'); }
    return { exitCode: 7, verifiedPids: [launcher.handles[0].pid] };
  };
  try {
    await assert.rejects(registry.stop(summary.id), /STOP_TREE_FAILED/);
    if (cause === 'parser-backlog') launcher.handles[0].output('x'.repeat(4 * 1024 * 1024));
    rejectParse(new Error('FIXTURE_PARSER_FAILED'));
    await record.drain(); await new Promise(resolve => setImmediate(resolve));
    assert.equal(record.bridgeFailed, true); assert.equal(record.metadata.failureCode, 'STOP_FAILED');
    const newer = await registry.start('powershell', 120, 40); await registry.stop(newer.id);
    assert.ok(registry.find(summary.id), 'parser error cannot permit eviction of unfinished cleanup');
    await registry.shutdown(); assert.equal(attempts, 2); assert.equal(record.metadata.failureCode, 'TERMINAL_BRIDGE_FAILED');
  } finally { rejectParse?.(new Error('FIXTURE_FINALIZE')); await registry.shutdown(); }
  }
});

test('shutdown drains an already reserved launch and stops its eventual native process once', async () => {
  let release!: () => void;
  const gate = new Promise<void>(resolve => { release = resolve; });
  const launcher = new FakeLauncher();
  const registry = new SessionRegistry({ config: fixtureConfig(), launcher: {
    start: async profile => { await gate; return launcher.start(profile); },
  } });
  const start = registry.start('powershell', 120, 40);
  const shutdown = registry.shutdown();
  release();
  await assert.rejects(start, /HOST_CLOSING/);
  await shutdown;
  assert.equal(launcher.handles.length, 1); assert.equal(launcher.handles[0].stops, 1);
});

test('natural root exit retains descendants, capacity and history until verified Stop', async () => {
  const config = fixtureConfig(); config.capacity.maxRunningSessions = 1; config.capacity.retainedExitedSessions = 1;
  const launcher = new FakeLauncher(); const registry = new SessionRegistry({ config, launcher });
  const root = await registry.start('powershell', 80, 24);
  launcher.handles[0].exit(0, true); await registry.require(root.id).drain();
  assert.equal(registry.find(root.id)!.processState, 'exited');
  assert.equal(registry.find(root.id)!.failureCode, 'STOP_FAILED');
  await assert.rejects(registry.forget(root.id), /SESSION_NOT_FINISHED/);
  await assert.rejects(registry.start('powershell', 80, 24), /SESSION_CAPACITY/);
  config.capacity.maxRunningSessions = 2;
  for (let index = 0; index < 3; index++) { const sibling = await registry.start('powershell', 80, 24); await registry.stop(sibling.id); }
  assert.ok(registry.find(root.id), 'unfinished descendants survive history eviction');
  await registry.stop(root.id);
  assert.equal(registry.find(root.id), undefined, 'completed old session can now be evicted');
  await registry.shutdown();
});

test('Mac scope remains visible after verified tracked cleanup', async () => {
  const launcher = new FakeLauncher();
  launcher.beforeReturn = pty => {
    Object.defineProperty(pty, 'cleanupScope', { value: 'tracked-descendants' });
    const stop = pty.stop.bind(pty);
    pty.stop = async () => ({ ...await stop(), cleanupScope: 'tracked-descendants' });
  };
  const registry = new SessionRegistry({ config: fixtureConfig(), launcher });
  const session = await registry.start('powershell', 80, 24);
  assert.equal(session.failureCode, 'CLEANUP_SCOPE_LIMITED');
  await registry.stop(session.id);
  assert.equal(registry.find(session.id)!.failureCode, 'CLEANUP_SCOPE_LIMITED');
  await registry.shutdown();
});

test('jobs clean descendants after natural root exit and retry a failed cleanup', { timeout: 2000 }, async () => {
  const launcher = new FakeLauncher();
  const registry = new SessionRegistry({ config: fixtureConfig(), launcher, jobs: new Set(['powershell']), jobStopRetryMs: 5 });
  const session = await registry.start('powershell', 80, 24); let attempts = 0;
  launcher.handles[0].stop = async () => {
    if (++attempts === 1) throw new Error('STOP_TREE_FAILED');
    return { exitCode: 0, verifiedPids: [launcher.handles[0].pid] };
  };
  launcher.handles[0].exit(0, true);
  const deadline = Date.now() + 1000;
  while (registry.require(session.id).cleanupRequired) {
    assert.ok(Date.now() < deadline, 'job cleanup did not retry'); await new Promise(resolve => setTimeout(resolve, 5));
  }
  assert.equal(attempts, 2); await registry.shutdown();
});

test('one output observer cannot pause the PTY or suppress healthy observers', async () => {
  const launcher = new FakeLauncher(); const registry = new SessionRegistry({ config: fixtureConfig(), launcher });
  const session = await registry.start('powershell', 120, 40); const received: string[] = [];
  registry.onOutput(() => { throw new Error('broken observer'); });
  registry.onOutput((_id, data) => received.push(data));
  launcher.handles[0].output('first'); launcher.handles[0].output('second');
  await registry.require(session.id).drain();
  assert.deepEqual(received, ['first', 'second']);
  assert.equal(launcher.handles[0].paused, false);
  assert.equal(registry.find(session.id)!.failureCode, null);
  await registry.shutdown();
});

test('contiguous native output uses bounded parser transactions without crossing a queued capture', async () => {
  const launcher = new FakeLauncher(); const registry = new SessionRegistry({ config: fixtureConfig(), launcher });
  const session = await registry.start('powershell', 120, 40); const record = registry.require(session.id);
  let release!: () => void; const gate = new Promise<void>(resolve => { release = resolve; });
  void record.enqueue(() => gate);
  const transactions: string[] = []; const nativeHandler = record.outputHandler!;
  record.outputHandler = data => { transactions.push(data); return nativeHandler(data); };
  const received: string[] = []; registry.onOutput((_id, data) => received.push(data));
  for (let index = 0; index < 100; index++) launcher.handles[0].output('a');
  const boundary = record.enqueue(() => record.terminal.capture());
  launcher.handles[0].output('b'); launcher.handles[0].output('c');
  release(); const snapshot = await boundary; await record.drain();
  assert.deepEqual(transactions, ['a'.repeat(100), 'bc']);
  assert.equal(snapshot.sequence, 1); assert.equal(received.join(''), 'a'.repeat(100) + 'bc'); assert.equal(record.queuedBytes, 0);
  assert.equal(record.terminal.output.sequence, 2);
  await registry.shutdown();
});

test('a job is ended at the bounds its configuration sets', async () => {
  const launcher = new FakeLauncher();
  const registry = new SessionRegistry({ config: { ...fixtureConfig(), jobs: { timeoutMs: 50, outputBytes: 16 } }, launcher,
    jobs: new Set(['powershell']) });
  try {
    const slow = await registry.start('powershell', 120, 40);
    await new Promise(resolve => setTimeout(resolve, 100)); await registry.require(slow.id).stopOperation;
    const flood = await registry.start('powershell', 120, 40);
    launcher.handles[1].output('x'.repeat(17)); await registry.require(flood.id).stopOperation;
    assert.deepEqual([registry.find(slow.id)?.failureCode, registry.find(flood.id)?.failureCode], ['JOB_TIMEOUT', 'JOB_OUTPUT_LIMIT']);
  } finally { await registry.shutdown(); }
});

test('a job whose stop at a bound fails is stopped again until it ends', async () => {
  const launcher = new FakeLauncher();
  const registry = new SessionRegistry({ config: { ...fixtureConfig(), jobs: { timeoutMs: 20, outputBytes: 1024 } }, launcher,
    jobs: new Set(['powershell']), jobStopRetryMs: 20 });
  try {
    const summary = await registry.start('powershell', 120, 40);
    const pty = launcher.handles[0]; const stop = pty.stop.bind(pty); let attempts = 0;
    pty.stop = async () => { if (++attempts === 1) throw new Error('STOP_TREE_FAILED'); return stop(); };
    const done = () => { const item = registry.find(summary.id); return item?.processState === 'exited' && !item.stopPending; };
    for (let tries = 0; tries < 50 && !done(); tries++) await new Promise(resolve => setTimeout(resolve, 10));
    const item = registry.find(summary.id)!;
    assert.deepEqual([item.processState, item.failureCode, attempts], ['exited', 'JOB_TIMEOUT', 2]);
  } finally { await registry.shutdown(); }
});

test('iter2 slice 1 F4: a stop at a bound that keeps failing is retried with a doubling wait, and still ends the job', async () => {
  const launcher = new FakeLauncher();
  const registry = new SessionRegistry({ config: fixtureConfig(), launcher, jobs: new Set(['powershell']),
    jobLimits: { timeoutMs: 10, outputBytes: 1024 }, jobStopRetryMs: 10 });
  try {
    const summary = await registry.start('powershell', 120, 40);
    const pty = launcher.handles[0]; const stop = pty.stop.bind(pty); let attempts = 0, failing = true;
    pty.stop = async () => { attempts++; if (failing) throw new Error('STOP_TREE_FAILED'); return stop(); };
    // A fixed 10 ms wait would make about 40 attempts in 400 ms; doubling from 10 ms makes 6 (at 0, 10, 30, 70, 150 and 310 ms).
    await new Promise(resolve => setTimeout(resolve, 400));
    assert.ok(attempts >= 3 && attempts <= 7, `attempts ${attempts}`);
    failing = false;
    const done = () => { const item = registry.find(summary.id); return item?.processState === 'exited' && !item.stopPending; };
    for (let tries = 0; tries < 100 && !done(); tries++) await new Promise(resolve => setTimeout(resolve, 10));
    assert.deepEqual([registry.find(summary.id)!.processState, registry.find(summary.id)!.failureCode], ['exited', 'JOB_TIMEOUT']);
  } finally { await registry.shutdown(); }
});

test('iter2 slice 1 F4: the stop retry wait stops doubling at one minute', async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const launcher = new FakeLauncher();
  const registry = new SessionRegistry({ config: fixtureConfig(), launcher, jobs: new Set(['powershell']),
    jobLimits: { timeoutMs: 1000, outputBytes: 1024 }, jobStopRetryMs: 16000 });
  const settle = async () => { for (let round = 0; round < 10; round++) await new Promise(resolve => setImmediate(resolve)); };
  let attempts = 0, failing = true;
  try {
    const summary = await registry.start('powershell', 120, 40);
    const pty = launcher.handles[0]; const stop = pty.stop.bind(pty);
    pty.stop = async () => { attempts++; if (failing) throw new Error('STOP_TREE_FAILED'); return stop(); };
    t.mock.timers.tick(1000); await settle();
    // Without the cap the third wait would be 64 s, so the attempt due at 60 s would not come.
    for (const [index, wait] of [16000, 32000, 60000, 60000].entries()) {
      t.mock.timers.tick(wait - 1); await settle(); assert.equal(attempts, index + 1, `before the ${wait} ms wait ends`);
      t.mock.timers.tick(1); await settle(); assert.equal(attempts, index + 2, `when the ${wait} ms wait ends`);
    }
    // Still a minute after that; the previous test shows a stop that then succeeds ends the job.
    t.mock.timers.tick(60000); await settle(); assert.equal(attempts, 6);
    assert.equal(registry.find(summary.id)!.processState, 'running');
  } finally {
    // Let any stop succeed and fire every mocked timer before real ones return, so shutdown cannot wait on one.
    failing = false;
    for (let round = 0; round < 3; round++) { t.mock.timers.tick(120000); await settle(); }
    t.mock.timers.reset(); await registry.shutdown();
  }
});

test('a bridge-failed job that then times out keeps one failure code', async () => {
  const launcher = new FakeLauncher();
  const registry = new SessionRegistry({ config: fixtureConfig(), launcher, jobs: new Set(['powershell']),
    jobLimits: { timeoutMs: 50, outputBytes: 1024 * 1024 } });
  const summary = await registry.start('powershell', 120, 40); const record = registry.require(summary.id);
  record.outputHandler = () => Promise.reject(new Error('FIXTURE_PARSER_FAILED'));
  launcher.handles[0].output('x'); await record.drain(); await new Promise(resolve => setImmediate(resolve));
  assert.equal(record.metadata.failureCode, 'TERMINAL_BRIDGE_FAILED');
  const codes: Array<string | null> = [];
  registry.onChange(session => codes.push(session.failureCode ?? null));
  await new Promise(resolve => setTimeout(resolve, 100)); await record.stopOperation; await record.drain();
  assert.equal(record.jobEnd, 'JOB_TIMEOUT'); assert.equal(registry.find(summary.id)!.processState, 'exited');
  assert.deepEqual([...new Set(codes)], ['TERMINAL_BRIDGE_FAILED']);
  await registry.shutdown();
});

test('failed Stop preserves bounded command diagnostics and host context without changing retry behavior', async () => {
  const launcher = new FakeLauncher(), records: Array<{ event: string; fields: Record<string, unknown> }> = [];
  let throwing = false;
  const registry = new SessionRegistry({ config: fixtureConfig(), launcher, diagnostics: { log(event, fields = {}) {
    records.push({ event, fields }); if (throwing) throw new Error('OWNED_DIAGNOSTIC_FAILURE');
  } } });
  registry.bindDiagnosticHost('current-host'); registry.bindDiagnosticHost('current-host');
  assert.throws(() => registry.bindDiagnosticHost('different-host'), /SESSION_HOST_ALREADY_BOUND/);
  const session = await registry.start('powershell', 80, 24), handle = launcher.handles[0], original = handle.stop.bind(handle);
  const privateMarker = 'owned-private-message-cause-output';
  const diagnostics = { phase: 'snapshot', kind: 'timeout', elapsedMs: 5001, timeoutMs: 5000, code: null, signal: 'SIGTERM', killed: true, stdoutBytes: 0, stderrBytes: 11 };
  handle.stop = async () => { throw Object.assign(new Error('STOP_SNAPSHOT_QUERY_FAILED: ' + privateMarker, { cause: new Error(privateMarker) }),
    { code: 'STOP_SNAPSHOT_QUERY_FAILED', diagnostics, stdout: privateMarker, stderr: privateMarker }); };
  throwing = true;
  await assert.rejects(registry.stop(session.id), /STOP_SNAPSHOT_QUERY_FAILED/);
  assert.equal(registry.find(session.id)!.failureCode, 'STOP_FAILED'); assert.equal(registry.require(session.id).cleanupRequired, true);
  const failure = [...records].reverse().find(record => record.event === 'pty-error')!;
  assert.equal(failure.fields.hostInstanceId, 'current-host');
  assert.deepEqual(failure.fields.nativeFailure, { code: 'STOP_SNAPSHOT_QUERY_FAILED', command: diagnostics });
  assert.equal(JSON.stringify(failure).includes(privateMarker), false);
  throwing = false; handle.stop = original; await registry.stop(session.id); await registry.shutdown();
  assert.equal(registry.require(session.id).cleanupRequired, false);
});


test('diagnostic writer persists only allowlisted native cleanup metadata', () => {
  const root = scratchDirectory('native-diagnostic-writer-');
  const logger = new DiagnosticLogger(root, { directory: path.join(root, 'logs'), maxFiles: 2, maxFileBytes: 4096 });
  const privateMarker = 'owned-private-message-cause-source-output';
  const command = { phase: 'snapshot', kind: 'invalid-json', elapsedMs: 123, timeoutMs: 5000, code: 0, signal: null, killed: false, stdoutBytes: 40, stderrBytes: 0 };
  const valid = { code: 'STOP_METADATA_FAILED', command };
  logger.log('pty-error', { code: 'STOP_FAILED', nativeFailure: valid, message: privateMarker, cause: privateMarker, stdout: privateMarker });
  for (const invalid of [{ ...valid, cause: privateMarker }, { ...valid, command: { ...command, stdout: privateMarker } },
    { ...valid, command: { ...command, elapsedMs: NaN } }, { ...valid, command: { ...command, stderrBytes: Number.MAX_SAFE_INTEGER } },
    { code: privateMarker }]) logger.log('pty-error', { code: 'STOP_FAILED', nativeFailure: invalid });
  const text = fs.readFileSync(path.join(root, 'logs/host-0.log'), 'utf8'), rows = text.trimEnd().split('\n').map(line => JSON.parse(line));
  assert.deepEqual(rows[0].nativeFailure, valid); assert.ok(rows.slice(1).every(row => row.nativeFailure === undefined));
  assert.equal(text.includes(privateMarker), false);
});


test('injected snapshot timeout and invalid JSON reach the current host safe failure report', async () => {
  const moduleURL = pathToFileURL(path.join(process.cwd(), 'bin/consumer-windows.mjs')).href;
  const { windowsHostLifecycle } = await import(moduleURL);
  for (const kind of ['timeout', 'invalid-json']) {
    const root = scratchDirectory('native-failure-report-'), logs = path.join(root, '.runtime/logs');
    const diagnostics = new DiagnosticLogger(root, { directory: logs, maxFiles: 2, maxFileBytes: 4096 });
    const launcher = new FakeLauncher(), registry = new SessionRegistry({ config: fixtureConfig(), launcher, diagnostics });
    registry.bindDiagnosticHost('current-host');
    const session = await registry.start('powershell', 80, 24), handle = launcher.handles[0], original = handle.stop.bind(handle);
    const privateMarker = 'owned-private-command-output-cause';
    handle.stop = async () => {
      await getProcessSnapshot(5000, async () => {
        if (kind === 'timeout') throw Object.assign(new Error(privateMarker), { code: null, signal: 'SIGTERM', killed: true, stdout: privateMarker, stderr: privateMarker });
        return { stdout: '{', stderr: privateMarker };
      });
      return original();
    };
    await assert.rejects(registry.stop(session.id));
    const report = windowsHostLifecycle(root, 'current-host');
    assert.equal(report.nativeFailures.length, 1); assert.equal(report.nativeFailures[0].command.kind, kind);
    assert.equal(report.nativeFailures[0].code, kind === 'timeout' ? 'STOP_SNAPSHOT_QUERY_FAILED' : 'STOP_METADATA_FAILED');
    assert.equal(windowsHostLifecycle(root, 'other-host').nativeFailures, undefined);
    assert.equal(JSON.stringify(report).includes(privateMarker), false);
    handle.stop = original; await registry.stop(session.id); await registry.shutdown();
  }
});
