import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import test from 'node:test';
import { activateTab, boundLine, closeTab, openTab, readSelection, refusedAtBound, writeSelection, type TabOrder } from '../src/tabs.js';

// Requirement 4.2.7: the tab model's pure part. Each test names the input on which it fails.
const [a, b, c] = [crypto.randomUUID(), crypto.randomUUID(), crypto.randomUUID()];
test('requirement 4.2.1: open adds a tab and activates it; opening an open session activates it, never a second tab (input: a duplicate tab)', () => {
  let order: TabOrder = { sessions: [] };
  order = openTab(order, a); order = openTab(order, b);
  assert.deepEqual(order, { sessions: [a, b], active: b });
  order = openTab(order, a);
  assert.deepEqual(order, { sessions: [a, b], active: a });
  assert.deepEqual(activateTab(order, c), order, 'activating a tab that is not open changes nothing');
  assert.equal(activateTab(order, b).active, b);
});
test('closing the active tab activates the right neighbour, else the left, else none; closing a hidden tab keeps the active one (input: active left on a closed tab)', () => {
  const order: TabOrder = { sessions: [a, b, c], active: b };
  assert.deepEqual(closeTab(order, b), { sessions: [a, c], active: c });
  assert.deepEqual(closeTab({ sessions: [a, b, c], active: c }, c), { sessions: [a, b], active: b });
  assert.deepEqual(closeTab(order, a), { sessions: [b, c], active: b });
  assert.deepEqual(closeTab({ sessions: [a], active: a }, a), { sessions: [], active: undefined });
});
test('ledger 0.5(1): a socket closed before it ever connected, after bootstrap answered, is the bound; a lost connection is not (input: a reconnecting tab read as refused)', () => {
  assert.equal(refusedAtBound({ bootstrapAnswered: true, everConnected: false }, 'reconnecting'), true);
  assert.equal(refusedAtBound({ bootstrapAnswered: true, everConnected: true }, 'reconnecting'), false);
  assert.equal(refusedAtBound({ bootstrapAnswered: false, everConnected: false }, 'reconnecting'), false, 'no bootstrap: the host is down, not full');
  assert.equal(refusedAtBound({ bootstrapAnswered: true, everConnected: false }, 'connecting'), false);
  assert.equal(boundLine(2), "The host refused this tab's connection: its view bound is 2 (this page's panel counts), or the host closed it; close a tab, or Retry");
});
test('requirement 4.2.6 and job file 7.8(e): gq.selection round-trips the tabs; a job 7 value reads as one active tab (input: the old shape dropped)', () => {
  const host = crypto.randomUUID();
  const order: TabOrder = { hostInstanceId: host, sessions: [a, b], active: b };
  assert.deepEqual(readSelection(writeSelection(order)), order);
  assert.deepEqual(readSelection(JSON.stringify({ hostInstanceId: host, sessionId: a })), { hostInstanceId: host, sessions: [a], active: a });
  assert.deepEqual(readSelection(JSON.stringify({ hostInstanceId: host, sessions: [a, 'x', a], active: 'x' })), { hostInstanceId: host, sessions: [a], active: a });
  assert.deepEqual(readSelection('{'), { sessions: [] });
  assert.ok(!/token|leaseId|data/.test(writeSelection(order)), 'no capability or payload in the stored value');
});
