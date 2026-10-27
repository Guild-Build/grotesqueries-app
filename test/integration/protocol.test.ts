import assert from 'node:assert/strict';
import test from 'node:test';
import { decodeClientMessage, decodePluginManifest, decodeServerMessage, PROTOCOL_VERSION, utf8Chunks, utf8Bytes } from '@grotesqueries/protocol';

const sessionId = '11111111-1111-4111-8111-111111111111';
const leaseId = '22222222-2222-4222-8222-222222222222';
test('v4 decoders retain literal human payloads and reject foreign identity, launch fields and malformed bounds', () => {
  assert.equal(PROTOCOL_VERSION, 4);
  const message = { type: 'input', sessionId, leaseId, inputId: 1,
    data: '{"type":"start","profileId":"shell"}\u001b[1;1R' };
  assert.deepEqual(decodeClientMessage(message), message);
  for (const invalid of [null, [], {}, { type: 'unknown' }, { type: 'attach', requestId: 1, sessionId: 'missing-session' },
    { type: 'start', requestId: 1, profileId: 'shell', cols: 120, rows: 40, executable: 'evil.exe' },
    { type: 'attach', requestId: 1, sessionId, viewId: leaseId },
    { ...message, inputId: 0 }, { ...message, inputId: Number.MAX_SAFE_INTEGER + 1 },
    { ...message, data: '' }, { ...message, data: 'x'.repeat(65537) },
    { type: 'resize', requestId: 1, sessionId, leaseId, cols: 1, rows: 40 },
    { type: 'ping', requestId: 1.5 }]) assert.throws(() => decodeClientMessage(invalid));
});

test('server restoration progress has finite frame and identity bounds', () => {
  const chunk = { type: 'snapshot-chunk', sessionId, snapshotId: leaseId, index: 0, data: 'screen' };
  assert.deepEqual(decodeServerMessage(chunk), chunk);
  assert.throws(() => decodeServerMessage({ ...chunk, index: -1 }));
  assert.throws(() => decodeServerMessage({ ...chunk, data: 'x'.repeat(300000) }));
  assert.throws(() => decodeServerMessage({ type: 'input-ack', sessionId, leaseId, inputId: 1, disposition: 'executed' }));
});

test('only observer control messages may carry a null lease identity', () => {
  assert.doesNotThrow(() => decodeServerMessage({ type: 'control', sessionId, controllerViewId: null, leaseId: null }));
  assert.doesNotThrow(() => decodeServerMessage({ type: 'control', sessionId, controllerViewId: leaseId, leaseId: null }));
  assert.doesNotThrow(() => decodeServerMessage({ type: 'input-ack', sessionId, leaseId, inputId: 1, disposition: 'accepted' }));
  assert.throws(() => decodeServerMessage({ type: 'input-ack', sessionId, leaseId: null, inputId: 1, disposition: 'accepted' }));
  assert.throws(() => decodeServerMessage({ type: 'error', sessionId, leaseId: null, code: 'STALE_LEASE', message: 'Take control again.' }));
});

test('UTF-8 framing preserves mixed code points, lone surrogates and exact byte boundaries', () => {
  const text = 'ASCII界🙂é\ud800X\udc00'.repeat(200);
  for (const limit of [4, 5, 7, 16, 16384]) {
    const chunks = utf8Chunks(text, limit); assert.equal(chunks.join(''), text);
    assert.ok(chunks.every(chunk => utf8Bytes(chunk) <= limit));
    for (let index = 1; index < chunks.length; index++) assert.ok(!(/[\ud800-\udbff]$/.test(chunks[index - 1]) && /^[\udc00-\udfff]/.test(chunks[index])));
  }
  assert.deepEqual(utf8Chunks(''), []); assert.deepEqual(utf8Chunks('界🙂a', 4), ['界', '🙂', 'a']);
});

test('live output and grid accept only boolean optional history notices', () => {
  for (const event of [{ type: 'output', sessionId, sequence: 1, data: 'live' }, { type: 'grid', sessionId, sequence: 2, cols: 120, rows: 40 }]) {
    assert.deepEqual(decodeServerMessage(event), event);
    for (const historyIncomplete of [true, false]) assert.deepEqual(decodeServerMessage({ ...event, historyIncomplete }), { ...event, historyIncomplete });
    for (const historyIncomplete of [null, 'true', 1]) assert.throws(() => decodeServerMessage({ ...event, historyIncomplete }));
  }
});
test('Grotesqueries 4: a page or panel label of only whitespace is refused, as a profile label is', () => {
  const manifest = { name: 'labels', contract: 3, profiles: [], commands: [], folders: [{ id: 'site', path: '{plugin}/site' }],
    pages: [{ label: 'Home', path: 'site/index.html' }], panel: { label: 'Panel', path: 'site/panel.html' } };
  assert.deepEqual(decodePluginManifest(manifest), manifest);
  for (const label of ['   ', ' \t ', '\u3000']) {
    assert.throws(() => decodePluginManifest({ ...manifest, pages: [{ ...manifest.pages[0], label }] }), /INVALID_MESSAGE: Invalid label/);
    assert.throws(() => decodePluginManifest({ ...manifest, panel: { ...manifest.panel, label } }), /INVALID_MESSAGE: Invalid label/);
  }
});
