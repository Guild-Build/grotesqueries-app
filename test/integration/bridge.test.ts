import assert from 'node:assert/strict';
import test from 'node:test';
import { WebSocket } from 'ws';
import { DiagnosticLogger } from '../../app/services/diagnostics.js';
import { bridgeFixture } from '../support/bridge-fixture.js';

test('actual async WS Start deduplicates pending/completed/evicted requests without implicit starts', async () => {
  const f = await bridgeFixture(); const peer = await f.peer(false);
  let release!: () => void; const gate = new Promise<void>(resolve => { release = resolve; });
  const launch = f.launcher.start.bind(f.launcher); f.launcher.start = async profile => { await gate; return launch(profile); };
  try {
    const requestId = peer.request('start', { profileId: 'powershell', cols: 120, rows: 40 });
    peer.send({ type: 'start', requestId, profileId: 'powershell', cols: 120, rows: 40 });
    await peer.wait(message => message.type === 'error' && message.code === 'REQUEST_PENDING'); assert.equal(f.launcher.handles.length, 0);
    release(); const result = await peer.wait(message => message.type === 'start-result'); assert.equal(f.launcher.handles.length, 1);
    const cursor = peer.messages.length; peer.send({ type: 'start', requestId, profileId: 'powershell', cols: 120, rows: 40 });
    assert.deepEqual(await peer.wait(message => message.type === 'start-result', cursor), result); assert.equal(f.launcher.handles.length, 1);
    for (let i = 0; i < 65; i++) { const id = peer.request('ping'); await peer.wait(message => message.type === 'pong' && message.requestId === id); }
    peer.send({ type: 'start', requestId, profileId: 'powershell', cols: 120, rows: 40 });
    await peer.wait(message => message.type === 'error' && message.code === 'REQUEST_RESULT_UNAVAILABLE'); assert.equal(f.launcher.handles.length, 1);
    await peer.close(); const reopened = await f.peer(false); assert.equal(f.sessions.list().length, 1); assert.equal(f.launcher.handles.length, 1); await reopened.close();
  } finally { release(); await peer.close(); await f.host.close(); }
});

test('stalled renderer credit and invalid acknowledgements remain local while a healthy view advances', async () => {
  const f = await bridgeFixture(config => { config.transport.maxRendererBacklogBytes = 262144; });
  const slow = await f.peer(false); const healthy = await f.peer();
  try {
    const summary = await f.sessions.start('powershell', 120, 40); const record = f.sessions.require(summary.id);
    f.launcher.handles[0].output(('x'.repeat(110) + '\r\n').repeat(1200)); await record.drain();
    slow.request('attach', { sessionId: summary.id });
    const begin = await slow.wait(message => message.type === 'snapshot-begin'); assert.ok(begin.type === 'snapshot-begin');
    await slow.wait(message => message.type === 'snapshot-chunk');
    const before = f.host.accounting().find(item => item.rendererBytes > 0)!.rendererBytes;
    slow.send({ type: 'snapshot-applied', sessionId: summary.id, snapshotId: begin.snapshotId, chunkIndex: 10000, parsedBytes: 1 });
    await slow.wait(message => message.type === 'error' && message.code === 'INVALID_SNAPSHOT_CREDIT');
    assert.equal(f.host.accounting().find(item => item.rendererBytes > 0)!.rendererBytes, before);
    healthy.request('attach', { sessionId: summary.id }); await healthy.wait(message => message.type === 'snapshot-end');
    f.launcher.handles[0].output('healthy continues'); await record.drain();
    await healthy.wait(message => message.type === 'output' && message.data.includes('healthy continues'));
    assert.equal(f.launcher.handles[0].paused, false);
    assert.ok(f.host.accounting().every(item => item.rendererBytes <= 262144));
    const cursor = slow.messages.length; slow.request('resync', { sessionId: summary.id, sequence: 0, reason: 'slow-view' });
    await slow.wait(message => message.type === 'snapshot-begin', cursor);
    slow.send({ type: 'snapshot-applied', sessionId: summary.id, snapshotId: begin.snapshotId, chunkIndex: 0, parsedBytes: 16384 });
    await slow.wait(message => message.type === 'error' && message.code === 'INVALID_SNAPSHOT_CREDIT', cursor);
    const replacement = slow.messages.slice(cursor); assert.equal(replacement[0].type, 'snapshot-cancel');
  } finally { await slow.close(); await healthy.close(); await f.host.close(); }
});

test('native heartbeat expires an unreachable idle controller without stopping its process', { timeout: 6000 }, async () => {
  const f = await bridgeFixture(config => { config.control.timeoutMs = 2000; });
  const summary = await f.sessions.start('powershell', 120, 40);
  const socket = new WebSocket(f.host.origin.replace('http:', 'ws:') + '/api/terminal?token=' + f.token,
    { origin: f.host.origin, autoPong: false });
  try {
    let requestId = 0;
    socket.on('message', raw => {
      const message = JSON.parse(raw.toString());
      if (message.type === 'hello') socket.send(JSON.stringify({ type: 'ready', requestId: ++requestId, protocol: message.protocol, hostInstanceId: f.hostInstanceId }));
      if (message.type === 'operation-result' && message.operation === 'ready') socket.send(JSON.stringify({ type: 'attach', requestId: ++requestId,
        sessionId: summary.id, resume: { hostInstanceId: f.hostInstanceId, sequence: 0 } }));
      if (message.type === 'operation-result' && message.operation === 'attach') socket.send(JSON.stringify({ type: 'take-control', requestId: ++requestId, sessionId: summary.id }));
    });
    await new Promise<void>(resolve => socket.once('close', resolve));
    assert.equal(f.sessions.find(summary.id)!.controllerViewId, null); assert.equal(f.launcher.handles[0].stops, 0);
    assert.equal(f.sessions.find(summary.id)!.processState, 'running');
  } finally { socket.terminate(); await f.host.close(); }
});

test('WS observers restore, controller lease is private, and release revokes a queued input immediately', async () => {
  const f = await bridgeFixture(); const first = await f.peer(); const second = await f.peer();
  try {
    const summary = await f.sessions.start('powershell', 120, 40);
    f.launcher.handles[0].output('before attach 🙂\r\n'); await f.sessions.require(summary.id).drain();
    for (const peer of [first, second]) {
      peer.request('attach', { sessionId: summary.id }); await peer.wait(message => message.type === 'snapshot-end');
    }
    await new Promise(resolve => setTimeout(resolve, 30));
    first.request('take-control', { sessionId: summary.id });
    const leaseMessage = await first.wait(message => message.type === 'control' && message.leaseId !== null);
    assert.ok(leaseMessage.type === 'control'); const leaseId = leaseMessage.leaseId!;
    const observer = await second.wait(message => message.type === 'control' && message.controllerViewId !== null);
    assert.ok(observer.type === 'control'); assert.equal(observer.leaseId, null);
    second.request('take-control', { sessionId: summary.id }); await second.wait(message => message.type === 'error' && message.code === 'CONTROL_BUSY');
    let release!: () => void; void f.sessions.require(summary.id).enqueue(() => new Promise<void>(resolve => { release = resolve; }));
    await new Promise(resolve => setImmediate(resolve));
    first.send({ type: 'input', sessionId: summary.id, leaseId, inputId: 1, data: 'stale input' });
    first.request('release-control', { sessionId: summary.id, leaseId });
    await first.wait(message => message.type === 'operation-result' && message.operation === 'release-control'); release();
    await first.wait(message => message.type === 'error' && message.inputId === 1 && message.code === 'CONTROL_REQUIRED');
    assert.deepEqual(f.launcher.handles[0].writes, []);
    await first.close(); assert.equal(f.sessions.find(summary.id)!.processState, 'running');
    second.request('take-control', { sessionId: summary.id }); await second.wait(message => message.type === 'control' && message.leaseId !== null);
    assert.equal(f.launcher.handles[0].stops, 0); assert.ok(f.host.accounting().every(item => item.rendererBytes <= f.config.transport.maxRendererBacklogBytes));
  } finally { await first.close(); await second.close(); await f.host.close(); }
});

test('an obsolete failed capture cannot detach replacement resync or detach/reattach restoration', async () => {
  for (const action of ['resync', 'reattach']) {
    const f = await bridgeFixture(); const peer = await f.peer(false);
    try {
      const summary = await f.sessions.start('powershell', 120, 40); const record = f.sessions.require(summary.id);
      const capture = record.terminal.capture.bind(record.terminal); let reject!: (error: Error) => void; let calls = 0;
      record.terminal.capture = () => ++calls === 1 ? new Promise((_resolve, fail) => { reject = fail; }) : capture();
      const firstId = peer.request('attach', { sessionId: summary.id });
      while (!reject) await new Promise(resolve => setImmediate(resolve));
      if (action === 'reattach') { const detachId = peer.request('detach', { sessionId: summary.id });
        await peer.wait(message => message.type === 'operation-result' && message.requestId === detachId); }
      const nextId = peer.request(action === 'resync' ? 'resync' : 'attach', { sessionId: summary.id,
        ...(action === 'resync' ? { sequence: 0, reason: 'sequence-gap' } : {}) });
      // A ping after the replacement confirms its synchronous admission reached the host.
      const barrier = peer.request('ping'); await peer.wait(message => message.type === 'pong' && message.requestId === barrier);
      reject(new Error('fixture old capture failed'));
      await peer.wait(message => message.type === 'error' && message.requestId === firstId);
      await peer.wait(message => message.type === 'operation-result' && message.requestId === nextId);
      await peer.wait(message => message.type === 'snapshot-begin');
      assert.equal(record.views.size, 1, action); assert.equal(calls, 2);
    } finally { await peer.close(); await f.host.close(); }
  }
});

test('automatic restore errors belong only to the active capture generation', async () => {
  for (const replace of [false, true]) {
    const f = await bridgeFixture(config => { config.terminal.recentOutputBytes = 1024; }); const peer = await f.peer(false);
    try {
      const summary = await f.sessions.start('powershell', 120, 40); const record = f.sessions.require(summary.id);
      const initial = peer.request('attach', { sessionId: summary.id });
      await peer.wait(message => message.type === 'operation-result' && message.requestId === initial);
      const capture = record.terminal.capture.bind(record.terminal); let reject!: (error: Error) => void; let calls = 0;
      record.terminal.capture = () => ++calls === 1 ? new Promise((_resolve, fail) => { reject = fail; }) : capture();
      f.launcher.handles[0].output('x'.repeat(2048));
      while (!reject) await new Promise(resolve => setImmediate(resolve));
      let replacement: number | undefined;
      if (replace) { replacement = peer.request('resync', { sessionId: summary.id, sequence: 0, reason: 'sequence-gap' });
        const barrier = peer.request('ping'); await peer.wait(message => message.type === 'pong' && message.requestId === barrier); }
      reject(new Error('automatic fixture capture failed'));
      if (replace) {
        await peer.wait(message => message.type === 'operation-result' && message.requestId === replacement);
        const barrier = peer.request('ping'); await peer.wait(message => message.type === 'pong' && message.requestId === barrier);
        assert.equal(peer.messages.filter(message => message.type === 'error' && message.code === 'RESTORE_FAILED').length, 0);
        assert.equal(record.views.size, 1);
      } else { await peer.wait(message => message.type === 'error' && message.code === 'RESTORE_FAILED'); assert.equal(record.views.size, 0); }
      assert.equal(record.metadata.processState, 'running'); assert.equal(f.launcher.handles[0].stops, 0);
    } finally { await peer.close(); await f.host.close(); }
  }
});


test('shutdown lifecycle observation failures never prevent session or server cleanup', async () => {
  const original = DiagnosticLogger.prototype.log, phases: string[] = [];
  const f = await bridgeFixture();
  await f.sessions.start('powershell', 80, 24);
  DiagnosticLogger.prototype.log = function (event, fields) {
    if (event.startsWith('host-stop')) { phases.push(event); throw new Error('OWNED_DIAGNOSTIC_DISK_FAILURE'); }
    return original.call(this, event, fields);
  };
  try {
    await f.host.close(); assert.equal(f.launcher.handles[0].stops, 1);
    assert.deepEqual(phases, ['host-stop-start', 'host-stop-sessions', 'host-stop-websockets', 'host-stop-http', 'host-stop']);
    await assert.rejects(fetch(f.host.origin + '/api/bootstrap'));
  } finally { DiagnosticLogger.prototype.log = original; await f.host.close(); }
});
