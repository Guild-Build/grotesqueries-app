import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import test from 'node:test';
import { InputMarkerStore, type StorageLike } from '../src/input-markers.js';
import { InputSender } from '../src/input.js';
import { DEFAULT_LIMITS, type ClientMessage } from '@grotesqueries/protocol';

class MemoryStorage implements StorageLike {
  readonly data = new Map<string, string>(); fail = false;
  get length() { return this.data.size; } key(index: number) { return [...this.data.keys()][index] ?? null; }
  getItem(key: string) { return this.data.get(key) ?? null; }
  setItem(key: string, value: string) { if (this.fail) throw new Error('storage full'); this.data.set(key, value); }
  removeItem(key: string) { if (this.fail) throw new Error('storage full'); this.data.delete(key); }
}
test('input markers survive hard refresh and reopening, contain only identities/IDs, and isolate documents/epochs', () => {
  const local = new MemoryStorage(); const tab = new MemoryStorage(); const instance = crypto.randomUUID(); const session = crypto.randomUUID();
  const first = new InputMarkerStore(local, tab); const second = new InputMarkerStore(local, new MemoryStorage());
  const a = first.begin(instance, session); const b = second.begin(instance, session);
  first.add(a, [1, 2]); second.add(b, [1]);
  const refreshed = new InputMarkerStore(local, tab); assert.equal(refreshed.documentId, first.documentId);
  assert.equal(refreshed.loadUnresolved().length, 2);
  const reopened = new InputMarkerStore(local, new MemoryStorage()); assert.equal(reopened.loadUnresolved().length, 2);
  first.acknowledge(a, 1); assert.deepEqual(first.loadUnresolved().find(marker => marker.epoch === a.epoch)!.ids, [2]);
  assert.deepEqual(second.loadUnresolved().find(marker => marker.epoch === b.epoch)!.ids, [1]);
  first.dismiss(a.key); assert.equal(local.length, 1);
  assert.ok(!JSON.stringify([...local.data]).includes('lease')); assert.ok(!JSON.stringify([...local.data]).includes('token'));
});
test('fleet pending receipts retain the worker identity even when engine and session IDs collide', () => {
  const storage = new MemoryStorage(), tab = new MemoryStorage(), store = new InputMarkerStore(storage, tab);
  const instance = crypto.randomUUID(), session = crypto.randomUUID();
  const a = store.begin(instance, session, 'worker-a'), b = store.begin(instance, session, 'worker-b');
  store.add(a, [1]); store.add(b, [1]);
  const restored = new InputMarkerStore(storage, tab).loadUnresolved();
  assert.deepEqual(restored.map(marker => marker.workerId).sort(), ['worker-a', 'worker-b']);
  store.acknowledge(a, 1); assert.equal(store.loadUnresolved()[0].workerId, 'worker-b');
});
test('input is marked before send; storage failure prevents send; loss and late acknowledgements never replay or clear other epochs', () => {
  const local = new MemoryStorage(); const store = new InputMarkerStore(local, new MemoryStorage()); const sent: ClientMessage[] = [];
  const sessionId = crypto.randomUUID(); const hostInstanceId = crypto.randomUUID(); const leaseId = crypto.randomUUID();
  const sender = new InputSender({ markers: store, limits: DEFAULT_LIMITS, send: message => {
    assert.ok(message.type === 'input' && store.loadUnresolved().some(marker => marker.ids.includes(message.inputId))); sent.push(message);
  }, changed: () => {} });
  sender.activate(hostInstanceId, sessionId, leaseId); sender.submit('secret human input'); assert.equal(sent.length, 1);
  assert.ok(!JSON.stringify([...local.data]).includes('secret human input'));
  sender.lose('Disconnected'); sender.activate(hostInstanceId, sessionId, crypto.randomUUID()); sender.submit('new input');
  assert.equal(sent.length, 2); sender.acknowledge({ type: 'input-ack', sessionId, leaseId, inputId: 1, disposition: 'accepted' });
  assert.equal(store.loadUnresolved().length, 2);
  local.fail = true; sender.submit('must not send'); assert.equal(sent.length, 2);
  assert.match(sender.problem ?? '', /storage/i);
});
test('paste preflight preserves order, bounds RAM, and exact live acknowledgement removes only its pending ID', () => {
  const local = new MemoryStorage(); const store = new InputMarkerStore(local, new MemoryStorage()); const sent: ClientMessage[] = [];
  const hostInstanceId = crypto.randomUUID(); const sessionId = crypto.randomUUID(); const leaseId = crypto.randomUUID();
  const sender = new InputSender({ markers: store, limits: DEFAULT_LIMITS, send: message => { sent.push(message); }, changed: () => {} });
  sender.activate(hostInstanceId, sessionId, leaseId); const paste = '🙂'.repeat(20000); sender.submit(paste);
  assert.equal(sent.filter(message => message.type === 'input').map(message => message.type === 'input' ? message.data : '').join(''), paste);
  sender.acknowledge({ type: 'input-ack', sessionId, leaseId, inputId: 1, disposition: 'already-seen' });
  assert.ok(store.loadUnresolved()[0].ids.every(id => id !== 1));
  const count = sent.length; sender.submit('x'.repeat(300000)); assert.equal(sent.length, count);
  assert.match(sender.problem ?? '', /limit|KiB|capacity/i);
});

test('ack timeout cannot be cleared by a repeated old lease or an old input error', () => {
  const store = new InputMarkerStore(new MemoryStorage(), new MemoryStorage()); let now = 0; const sent: ClientMessage[] = [];
  const host = crypto.randomUUID(); const session = crypto.randomUUID(); const lease = crypto.randomUUID();
  const sender = new InputSender({ markers: store, limits: DEFAULT_LIMITS, now: () => now, send: message => { sent.push(message); }, changed: () => {} });
  sender.activate(host, session, lease); sender.submit('first'); now = 6000; sender.tick();
  sender.activate(host, session, lease); sender.submit('blocked'); assert.equal(sent.length, 1);
  const next = crypto.randomUUID(); sender.activate(host, session, next); sender.submit('new');
  assert.equal(sender.reject({ sessionId: session, leaseId: lease, inputId: 1 }), false);
  assert.equal(sender.usable, true); assert.equal(store.loadUnresolved().length, 2);
});

test('failed receipt cleanup retains the marker, and unresolved epoch capacity pauses without eviction', () => {
  const local = new MemoryStorage(); const store = new InputMarkerStore(local, new MemoryStorage()); const host = crypto.randomUUID(); const session = crypto.randomUUID();
  const sent: ClientMessage[] = []; const sender = new InputSender({ markers: store, limits: DEFAULT_LIMITS, send: message => { sent.push(message); }, changed: () => {} });
  const lease = crypto.randomUUID(); sender.activate(host, session, lease); sender.submit('one'); local.fail = true;
  sender.acknowledge({ type: 'input-ack', sessionId: session, leaseId: lease, inputId: 1, disposition: 'accepted' });
  assert.equal(store.loadUnresolved().length, 1); assert.equal(sender.usable, false); local.fail = false;
  for (let i = 1; i < 64; i++) { sender.activate(host, session, crypto.randomUUID()); sender.submit('x'); sender.lose('fixture loss'); }
  sender.activate(host, session, crypto.randomUUID()); sender.submit('must not send');
  assert.equal(sent.length, 64); assert.equal(store.loadUnresolved().length, 64); assert.equal(sender.usable, false);
});
