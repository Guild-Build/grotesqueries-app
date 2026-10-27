import assert from 'node:assert/strict';
import test from 'node:test';
import crypto from 'node:crypto';
import { ControlLeases } from '../../app/controllers/control.js';
import { InputDelivery } from '../../app/controllers/input.js';
import { SessionRegistry } from '../../app/models/sessions.js';
import { FakeLauncher, fixtureConfig } from '../support/helpers.js';

async function fixture() {
  const launcher = new FakeLauncher(); const config = fixtureConfig(); let now = 100;
  const sessions = new SessionRegistry({ config, launcher }); const summary = await sessions.start('powershell', 120, 40);
  const control = new ControlLeases({ sessions, hostInstanceId: crypto.randomUUID(), timeoutMs: 2000, now: () => now });
  const input = new InputDelivery(sessions, control, config); const view = crypto.randomUUID();
  const attachment = control.attach(summary.id, view); attachment.restored = true;
  const lease = control.take(summary.id, view); const record = sessions.require(summary.id);
  return { launcher, sessions, control, input, view, lease, record, id: summary.id, setTime: (value: number) => { now = value; },
    close: async () => { control.dispose(); await sessions.shutdown(); } };
}
test('control is exclusive and attachment, expiry and process generation are checked at execution', async () => {
  const f = await fixture(); const other = crypto.randomUUID();
  f.control.attach(f.id, other).restored = true;
  assert.throws(() => f.control.take(f.id, other), /CONTROL_BUSY/);
  const stamp = f.control.stamp(f.id, f.view, f.lease.id);
  f.setTime(2101); assert.throws(() => f.control.requireAtExecution(stamp), /CONTROL_EXPIRED/);
  const next = f.control.take(f.id, other);
  assert.notEqual(next.id, f.lease.id);
  assert.throws(() => f.control.stamp(f.id, f.view, next.id), /CONTROL_REQUIRED/);
  f.launcher.handles[0].exit(7);
  assert.throws(() => f.control.requireAtExecution(f.control.stamp(f.id, other, next.id)), /CONTROL_REQUIRED|PROCESS_EXITED/);
  await f.close();
});
test('release bypasses a blocked queue; stale input, resize and Stop have no native effect', async () => {
  const f = await fixture(); let release!: () => void;
  const gate = new Promise<void>(resolve => { release = resolve; });
  void f.record.enqueue(() => gate);
  const mutations = [f.input.write(f.id, f.view, f.lease.id, 1, 'human'),
    f.input.resize(f.id, f.view, f.lease.id, 90, 25), f.input.stop(f.id, f.view, f.lease.id)];
  f.control.release(f.id, f.view, f.lease.id); release();
  const results = await Promise.allSettled(mutations);
  assert.ok(results.every(result => result.status === 'rejected'));
  assert.deepEqual(f.launcher.handles[0].writes, []); assert.deepEqual(f.launcher.handles[0].grids, []);
  assert.equal(f.launcher.handles[0].stops, 0); await f.close();
});
test('input high-water survives thousands of writes; gaps and partial delivery never replay', async () => {
  const f = await fixture();
  for (let id = 1; id <= 1000; id++) assert.equal(await f.input.write(f.id, f.view, f.lease.id, id, 'x'), 'accepted');
  assert.equal(await f.input.write(f.id, f.view, f.lease.id, 1, 'duplicate'), 'already-seen');
  assert.equal(f.launcher.handles[0].writes.length, 1000);
  await assert.rejects(f.input.write(f.id, f.view, f.lease.id, 1002, 'gap'), /INPUT_ID_GAP/);
  f.launcher.handles[0].write = () => { throw new Error('possible partial write'); };
  await assert.rejects(f.input.write(f.id, f.view, f.lease.id, 1001, 'uncertain'), /INPUT_DELIVERY_UNCERTAIN/);
  await assert.rejects(f.input.write(f.id, f.view, f.lease.id, 1001, 'retry'), /CONTROL_REQUIRED/);
  await f.close();
});
test('Stop initiation survives disconnect and prevents takeover until verified completion', async () => {
  const f = await fixture(); let finish!: () => void;
  const gate = new Promise<void>(resolve => { finish = resolve; });
  const stop = f.launcher.handles[0].stop.bind(f.launcher.handles[0]);
  f.launcher.handles[0].stop = async () => { await gate; return stop(); };
  const pending = f.input.stop(f.id, f.view, f.lease.id);
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(f.record.metadata.stopPending, true); f.control.detach(f.id, f.view);
  const other = crypto.randomUUID(); f.control.attach(f.id, other).restored = true;
  assert.throws(() => f.control.take(f.id, other), /STOP_PENDING/);
  finish(); await pending; assert.equal(f.record.metadata.processState, 'exited'); await f.close();
});

test('failed tree cleanup after root exit permits controlled Stop retry but no input or resize', async () => {
  const f = await fixture(); let attempts = 0;
  f.launcher.handles[0].stop = async () => {
    if (++attempts === 1) { f.launcher.handles[0].exit(7); throw new Error('STOP_TREE_FAILED'); }
    return { exitCode: 7, verifiedPids: [f.launcher.handles[0].pid] };
  };
  try {
    await assert.rejects(f.input.stop(f.id, f.view, f.lease.id), /STOP_TREE_FAILED/);
    await f.record.drain(); assert.equal(f.record.metadata.processState, 'exited'); assert.equal(f.record.metadata.failureCode, 'STOP_FAILED');
    const retry = f.control.take(f.id, f.view);
    await assert.rejects(f.input.write(f.id, f.view, retry.id, 1, 'never-sent'), /PROCESS_EXITED/);
    await assert.rejects(f.input.resize(f.id, f.view, retry.id, 90, 25), /PROCESS_EXITED/);
    assert.deepEqual(f.launcher.handles[0].writes, []); assert.deepEqual(f.launcher.handles[0].grids, []);
    await f.input.stop(f.id, f.view, retry.id); assert.equal(attempts, 2); assert.equal(f.record.metadata.failureCode, null);
    assert.throws(() => f.control.take(f.id, f.view), /PROCESS_EXITED/);
  } finally { await f.close(); }
});

test('natural root exit with descendants grants cleanup control without input permission', async () => {
  const f = await fixture();
  try {
    f.launcher.handles[0].exit(0, true); await f.record.drain();
    assert.equal(f.control.current(f.id), undefined);
    const cleanup = f.control.take(f.id, f.view);
    await assert.rejects(f.input.write(f.id, f.view, cleanup.id, 1, 'never-sent'), /PROCESS_EXITED/);
    await assert.rejects(f.input.resize(f.id, f.view, cleanup.id, 100, 30), /PROCESS_EXITED/);
    await f.input.stop(f.id, f.view, cleanup.id);
    assert.equal(f.record.cleanupRequired, false);
  } finally { await f.close(); }
});

test('disconnect, heartbeat expiry, resync and native exit each cancel queued mutations', async () => {
  for (const cause of ['disconnect', 'expiry', 'resync', 'exit']) {
    const f = await fixture(); let release!: () => void;
    void f.record.enqueue(() => new Promise<void>(resolve => { release = resolve; }));
    await new Promise(resolve => setImmediate(resolve));
    const writes = [f.input.write(f.id, f.view, f.lease.id, 1, 'stale'), f.input.resize(f.id, f.view, f.lease.id, 80, 24)];
    if (cause === 'disconnect') f.control.disconnect(f.view);
    if (cause === 'expiry') { f.setTime(2101); f.control.expire(); }
    if (cause === 'resync') f.record.views.get(f.view)!.restored = false;
    if (cause === 'exit') f.launcher.handles[0].exit(7);
    release(); assert.ok((await Promise.allSettled(writes)).every(result => result.status === 'rejected'), cause);
    assert.deepEqual(f.launcher.handles[0].writes, [], cause); assert.deepEqual(f.launcher.handles[0].grids, [], cause);
    await f.close();
  }
});
