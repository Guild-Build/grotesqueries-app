import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import test from 'node:test';
import { windowsZip, stripAuthenticodeSignature, defaultWindowsConfiguration } from '../../bin/package-windows.mjs';
import { cleanupWindowsConsumer, readWindowsZip, verifyUnsignedWindowsArchive, verifyWindowsFiles } from '../../bin/consumer-windows.mjs';
import { assertNoEmbeddedAuthenticode, inspectWindowsPE } from '../../bin/windows-pe.mjs';
import { seaConfig } from '../../bin/sea-config.mjs';
import { frameAssets, FRAME_FILES } from '../../bin/frame-assets.mjs';

const epoch = 1793130000, digest = value => crypto.createHash('sha256').update(value).digest('hex');
function fixture(run) {
  const directory = path.join(process.cwd(), '.runtime/tmp'); fs.mkdirSync(directory, { recursive: true });
  const folder = fs.mkdtempSync(path.join(directory, 'windows-package-test-'));
  try { run(folder); } finally { fs.rmSync(folder, { recursive: true, force: true }); }
}

test('Windows ZIP is stable across input order and retains exact binary and Unicode bytes', () => {
  const entries = [{ name: 'grotesqueries-test/grotesqueries.exe', bytes: Buffer.from([0, 255, 13, 10, 0, 4]) },
    { name: 'grotesqueries-test/README.txt', bytes: Buffer.from('Unicode λ界🙂\n') }];
  const first = windowsZip(entries, epoch), second = windowsZip([...entries].reverse(), epoch);
  assert.deepEqual(first, second);
  const decoded = readWindowsZip(first);
  assert.deepEqual(decoded.map(entry => entry.name), [...entries.map(entry => entry.name)].sort());
  for (const entry of decoded) assert.deepEqual(entry.bytes, entries.find(value => value.name === entry.name).bytes);
  assert.notDeepEqual(first, windowsZip(entries, epoch + 2));
});

test('Windows ZIP producer and consumer refuse path aliases, corruption, links and mismatched headers', () => {
  for (const name of ['../outside', '/outside', 'C:/outside', 'root/file:stream', 'root/../outside', 'root/a\\b', 'root/trailing.']) {
    assert.throws(() => windowsZip([{ name, bytes: Buffer.from('fixture') }], epoch), /WINDOWS_ZIP_PATH_INVALID/);
  }
  assert.throws(() => windowsZip([{ name: 'root/one', bytes: Buffer.from('1') }, { name: 'root/ONE', bytes: Buffer.from('2') }], epoch), /WINDOWS_ZIP_PATH_INVALID/);
  const original = windowsZip([{ name: 'root/test', bytes: Buffer.from('fixture bytes') }], epoch);
  const central = original.readUInt32LE(original.length - 6);
  for (const mutate of [
    bytes => bytes.writeUInt32LE(0, 14),
    bytes => bytes.writeUInt32LE(1, central + 42),
    bytes => bytes.writeUInt32LE((0o120777 << 16) >>> 0, central + 38),
    bytes => bytes.writeUInt16LE(0x801, central + 8),
    bytes => { bytes[central + 46] = 'x'.charCodeAt(0); },
    bytes => bytes.writeUInt32LE(0, central + 16),
  ]) { const bytes = Buffer.from(original); mutate(bytes); assert.throws(() => readWindowsZip(bytes)); }
  assert.throws(() => readWindowsZip(original.subarray(0, -1)));
});

function executableFixture() {
  const bytes = Buffer.alloc(544), pe = 128, optional = pe + 24;
  bytes.writeUInt16LE(0x5a4d); bytes.writeUInt32LE(pe, 0x3c); bytes.writeUInt32LE(0x4550, pe);
  bytes.writeUInt16LE(1, pe + 6);
  bytes.writeUInt16LE(0x8664, pe + 4); bytes.writeUInt16LE(240, pe + 20); bytes.writeUInt16LE(0x20b, optional);
  bytes.writeUInt32LE(16, optional + 108); bytes.writeUInt32LE(512, optional + 144); bytes.writeUInt32LE(32, optional + 148);
  bytes.fill(0xcd, 512); return bytes;
}

test('SEA packaging removes only a trailing Authenticode certificate from the copied x64 PE', () => {
  const original = executableFixture(), before = Buffer.from(original), stripped = stripAuthenticodeSignature(original);
  assert.deepEqual(original, before, 'Installed runtime bytes are not mutated');
  assert.equal(stripped.length, 512); assert.equal(stripped.readBigUInt64LE(128 + 24 + 144), 0n);
  assert.deepEqual(stripAuthenticodeSignature(stripped), stripped);
  const nonTrailing = executableFixture(); nonTrailing.writeUInt32LE(16, 128 + 24 + 148);
  assert.throws(() => stripAuthenticodeSignature(nonTrailing), /WINDOWS_CERTIFICATE_LAYOUT_UNSUPPORTED/);
  const wrongArchitecture = executableFixture(); wrongArchitecture.writeUInt16LE(0xaa64, 132);
  assert.throws(() => stripAuthenticodeSignature(wrongArchitecture), /WINDOWS_PE_INVALID/);
  assert.throws(() => stripAuthenticodeSignature(Buffer.alloc(60)), /WINDOWS_PE_INVALID/);
});

test('unsigned PE inspection is read-only and rejects signatures, missing directories and malformed header bounds', () => {
  const signed = executableFixture(), originalSigned = Buffer.from(signed);
  assert.throws(() => assertNoEmbeddedAuthenticode(signed), /WINDOWS_EMBEDDED_AUTHENTICODE_PRESENT/);
  assert.deepEqual(signed, originalSigned);
  const unsigned = stripAuthenticodeSignature(signed), before = Buffer.from(unsigned);
  assertNoEmbeddedAuthenticode(unsigned); assert.deepEqual(unsigned, before);
  assert.equal(inspectWindowsPE(unsigned).certificateOffset, 0);
  for (const mutate of [
    bytes => bytes.writeUInt32LE(0xffffffff, 0x3c),
    bytes => bytes.writeUInt16LE(0x10b, 128 + 24),
    bytes => bytes.writeUInt16LE(0xaa64, 128 + 4),
    bytes => bytes.writeUInt32LE(4, 128 + 24 + 108),
    bytes => bytes.writeUInt16LE(152, 128 + 20),
    bytes => bytes.writeUInt16LE(97, 128 + 6),
    bytes => bytes.writeUInt32LE(1024, 128 + 24 + 240 + 16),
  ]) { const bytes = Buffer.from(unsigned); mutate(bytes); assert.throws(() => assertNoEmbeddedAuthenticode(bytes), /WINDOWS_PE_INVALID/); }
  for (const [offset, size] of [[512, 0], [0, 32], [512, 32]]) {
    const bytes = Buffer.from(unsigned); bytes.writeUInt32LE(offset, 128 + 24 + 144); bytes.writeUInt32LE(size, 128 + 24 + 148);
    assert.throws(() => assertNoEmbeddedAuthenticode(bytes), /WINDOWS_EMBEDDED_AUTHENTICODE_PRESENT/);
  }
});

test('unsigned archive evidence covers final PE bytes and excludes shipped catalogs without OS trust claims', () => {
  const top = 'grotesqueries-0.1.0-alpha.2-win32-x64';
  const entries = ['BUILD-METADATA.json', 'LICENSE', 'README.txt', 'SHA256SUMS', 'THIRD_PARTY_NOTICES.md', 'grotesqueries.exe', 'grotesqueries.json', 'licenses.txt']
    .map(file => ({ name: top + '/' + file, bytes: file === 'grotesqueries.exe' ? stripAuthenticodeSignature(executableFixture()) : Buffer.from('fixture') }));
  assert.deepEqual(verifyUnsignedWindowsArchive(entries).signingEvidence,
    { embeddedAuthenticode: 'absent', shippedCatalog: 'absent', operatingSystemTrust: 'not-evaluated' });
  assert.throws(() => verifyUnsignedWindowsArchive([...entries, { name: top + '/signing.cat', bytes: Buffer.from('catalog fixture') }]));
  assert.throws(() => verifyUnsignedWindowsArchive(entries.map(entry => entry.name.endsWith('/grotesqueries.exe') ? { ...entry, bytes: executableFixture() } : entry)),
    /WINDOWS_EMBEDDED_AUTHENTICODE_PRESENT/);
});

test('Windows file manifest covers all runtime files, detects alteration and permits only configured JSON to change', () => fixture(folder => {
  const files = ['BUILD-METADATA.json', 'LICENSE', 'README.txt', 'THIRD_PARTY_NOTICES.md', 'grotesqueries.exe', 'grotesqueries.json', 'licenses.txt'];
  for (const file of files) fs.writeFileSync(path.join(folder, file), 'fixture:' + file);
  fs.writeFileSync(path.join(folder, 'SHA256SUMS'), files.map(file => `${digest('fixture:' + file)}  ${file}\n`).join(''));
  assert.equal(verifyWindowsFiles(folder).size, files.length);
  fs.writeFileSync(path.join(folder, 'grotesqueries.json'), 'operator edit');
  assert.throws(() => verifyWindowsFiles(folder), /WINDOWS_PACKAGE_CHECKSUM_MISMATCH/);
  assert.equal(verifyWindowsFiles(folder, { configured: true }).size, files.length);
  fs.writeFileSync(path.join(folder, 'grotesqueries.exe'), 'altered executable');
  assert.throws(() => verifyWindowsFiles(folder, { configured: true }), /WINDOWS_PACKAGE_CHECKSUM_MISMATCH/);
}));

test('Windows package manifest refuses omitted files, duplicate entries and traversal', () => fixture(folder => {
  fs.writeFileSync(path.join(folder, 'LICENSE'), 'fixture');
  for (const content of [`${digest('fixture')}  LICENSE\n`, `${digest('fixture')}  ../LICENSE\n`,
    `${digest('fixture')}  LICENSE\n${digest('fixture')}  LICENSE\n`]) {
    fs.writeFileSync(path.join(folder, 'SHA256SUMS'), content); assert.throws(() => verifyWindowsFiles(folder), /WINDOWS_PACKAGE_MANIFEST_/);
  }
}));

test('Windows defaults contain no machine paths, credentials or source-only frame override', () => {
  const value = defaultWindowsConfiguration();
  assert.deepEqual(value.allowedProjectDirectories, ['.']); assert.equal(value.launchProfiles[0].executable, 'powershell.exe');
  assert.deepEqual(value.launchProfiles[0].environment, {}); assert.equal(value.frame, undefined);
  assert.equal(value.launchProfiles[0].projectDirectory, '.');
  assert.equal(seaConfig('entry.cjs', 'sea.blob', {}).execArgvExtension, 'none');
});

test('Windows packaging requires every frame asset and refuses linked inputs', () => fixture(folder => {
  for (const file of FRAME_FILES) { fs.mkdirSync(path.dirname(path.join(folder, file)), { recursive: true }); fs.writeFileSync(path.join(folder, file), file); }
  assert.equal(Object.keys(frameAssets(folder)).length, 4);
  fs.unlinkSync(path.join(folder, 'assets/app.js')); assert.throws(() => frameAssets(folder));
  if (process.platform !== 'win32') { fs.symlinkSync('app.css', path.join(folder, 'assets/app.js')); assert.throws(() => frameAssets(folder), /WINDOWS_FRAME_SYMLINK/); }
}));

test('Windows consumer cleanup retains primary/recovery errors and never qualifies live fixture processes', async () => {
  const temporary = path.join(process.cwd(), '.runtime/tmp'); fs.mkdirSync(temporary, { recursive: true });
  const folder = fs.mkdtempSync(path.join(temporary, 'windows-cleanup-test-'));
  try {
    fs.writeFileSync(path.join(folder, 'fixture.txt'), 'owned cleanup fixture');
    const primary = new Error('OWNED_PRIMARY_FAILURE'), recovery = new Error('OWNED_RECOVERY_FAILURE');
    await assert.rejects(cleanupWindowsConsumer(folder, { pid: process.pid, stop: async () => { throw recovery; } }, [], primary), error => {
      assert.ok(error instanceof AggregateError); assert.deepEqual(error.errors, [primary, recovery]); return true;
    });
    assert.equal(fs.readFileSync(path.join(folder, 'fixture.txt'), 'utf8'), 'owned cleanup fixture');
    await assert.rejects(cleanupWindowsConsumer(folder, undefined, [process.pid]), /WINDOWS_CONSUMER_CLEANUP_FAILED/);
    await assert.rejects(cleanupWindowsConsumer(folder, undefined, [], primary), error => error === primary);
    await cleanupWindowsConsumer(folder, undefined, []); assert.equal(fs.existsSync(folder), false);
  } finally { fs.rmSync(folder, { recursive: true, force: true }); }
});

test('Windows consumer cleanup treats a permission-denied PID probe as unknown and preserves evidence', async () => {
  const temporary = path.join(process.cwd(), '.runtime/tmp'); fs.mkdirSync(temporary, { recursive: true });
  const folder = fs.mkdtempSync(path.join(temporary, 'windows-probe-test-'));
  const originalKill = process.kill;
  const denied = Object.assign(new Error('OWNED_PID_PROBE_DENIED'), { code: 'EPERM' });
  try {
    fs.writeFileSync(path.join(folder, 'fixture.txt'), 'owned probe fixture');
    process.kill = function (pid, signal) {
      if (pid === process.pid && signal === 0) throw denied;
      return originalKill.call(process, pid, signal);
    };
    await assert.rejects(cleanupWindowsConsumer(folder, undefined, [process.pid]), error => {
      assert.ok(error instanceof AggregateError); assert.deepEqual(error.errors, [denied]); return true;
    });
    assert.equal(fs.readFileSync(path.join(folder, 'fixture.txt'), 'utf8'), 'owned probe fixture');
  } finally {
    process.kill = originalKill;
    fs.rmSync(folder, { recursive: true, force: true });
  }
});

test('Windows consumer requires controller disposal and reports containment as failed cleanup', async () => {
  const temporary = path.join(process.cwd(), '.runtime/tmp'); fs.mkdirSync(temporary, { recursive: true });
  const folder = fs.mkdtempSync(path.join(temporary, 'windows-controller-cleanup-'));
  const calls = [];
  try {
    const failedDispose = new Error('OWNED_CONTROLLER_UNEXPECTED_EXIT');
    await assert.rejects(cleanupWindowsConsumer(folder, { pid: process.pid,
      stop: async () => { calls.push('stop'); },
      dispose: async () => { calls.push('dispose'); throw failedDispose; },
      abort: async () => { calls.push('abort'); } }, []), error => {
      assert.ok(error instanceof AggregateError); assert.deepEqual(error.errors, [failedDispose]); return true;
    });
    assert.deepEqual(calls, ['stop', 'dispose', 'abort']); assert.equal(fs.existsSync(folder), true);
    calls.length = 0;
    const primary = new Error('OWNED_PRIMARY_FAILURE');
    await assert.rejects(cleanupWindowsConsumer(folder, { pid: process.pid,
      stop: async () => { calls.push('stop'); }, dispose: async () => { calls.push('dispose'); },
      abort: async () => { calls.push('abort'); } }, [process.pid], primary), error => {
      assert.ok(error instanceof AggregateError); assert.equal(error.errors[0], primary); return true;
    });
    assert.deepEqual(calls, ['stop', 'abort'], 'Known live fixture prevents normal disposal; containment cannot qualify');
    calls.length = 0;
    await cleanupWindowsConsumer(folder, { pid: process.pid, stop: async () => { calls.push('stop'); },
      dispose: async () => { calls.push('dispose'); }, abort: async () => { calls.push('abort'); } }, []);
    assert.deepEqual(calls, ['stop', 'dispose']); assert.equal(fs.existsSync(folder), false);
  } finally { fs.rmSync(folder, { recursive: true, force: true }); }
});

test('Windows semantic screen preserves exact Unicode across split VT redraws and snapshot replacement', async () => {
  const { WindowsFixtureScreens } = await import('../../bin/consumer-windows.mjs');
  const screens = new WindowsFixtureScreens(), id = 'owned-terminal';
  const begin = (sessionId, snapshotId, cols, rows) => screens.accept({ type: 'snapshot-begin', sessionId, snapshotId, cols, rows });
  const chunk = (sessionId, snapshotId, data) => screens.accept({ type: 'snapshot-chunk', sessionId, snapshotId, data });
  try {
    begin(id, 'first', 100, 30);
    const chunks = ['WINDOWS_ECHO:Unico', 'de-λXé', '\x1b[1;23H', '界é'];
    for (const data of chunks) chunk(id, 'first', data);
    screens.accept({ type: 'snapshot-end', sessionId: id, snapshotId: 'first' });
    assert.equal(chunks.join('').includes('WINDOWS_ECHO:Unicode-λ界é'), false);
    assert.ok((await screens.text(id)).includes('WINDOWS_ECHO:Unicode-λ界é'));
    screens.accept({ type: 'grid', sessionId: id, cols: 90, rows: 25 });
    screens.accept({ type: 'output', sessionId: id, data: '\r\nWINDOWS_GRID:90x25' });
    assert.ok((await screens.text(id)).includes('WINDOWS_GRID:90x25'));
    assert.equal((await screens.diagnostics(id)).cols, 90); assert.equal((await screens.diagnostics(id)).rows, 25);
    begin('sibling', 'other', 80, 24); chunk('sibling', 'other', 'unrelated fixture');
    begin(id, 'restored', 70, 12); chunk(id, 'restored', 'WINDOWS_ECHO:Unicode-λ界é');
    assert.equal((await screens.diagnostics(id)).cols, 70); assert.equal((await screens.diagnostics(id)).rows, 12);
    assert.equal((await screens.text(id)).includes('WINDOWS_GRID'), false, 'A new snapshot replaces prior screen state');
    assert.ok((await screens.text(id)).includes('WINDOWS_ECHO:Unicode-λ界é'));
    assert.equal((await screens.text(id)).includes('unrelated'), false);
    assert.throws(() => chunk(id, 'stale', 'bad'), /SNAPSHOT_ID/);
  } finally { await screens.dispose(); }
});

test('Windows input checks require exact accepted ACK and surface errors without waiting for output', async () => {
  const { EventEmitter } = await import('node:events');
  const { WindowsConsumerPeer } = await import('../../bin/consumer-windows.mjs');
  for (const mode of ['accepted', 'denied', 'duplicate']) {
    const socket = new EventEmitter();
    socket.send = bytes => {
      const message = JSON.parse(bytes);
      assert.equal(message.type, 'input');
      socket.emit('message', Buffer.from(JSON.stringify({ type: 'input-ack', sessionId: 'wrong', leaseId: message.leaseId, inputId: message.inputId, disposition: 'accepted' })));
      const frame = mode === 'denied' ? { type: 'error', code: 'CONTROL_REQUIRED', sessionId: message.sessionId, inputId: message.inputId }
        : { type: 'input-ack', sessionId: message.sessionId, leaseId: message.leaseId, inputId: message.inputId, disposition: mode === 'accepted' ? 'accepted' : 'already-seen' };
      socket.emit('message', Buffer.from(JSON.stringify(frame)));
    };
    const peer = new WindowsConsumerPeer(socket);
    if (mode === 'accepted') await peer.input('owned', 'owned-lease', 1, 'ASCII-probe\r');
    else await assert.rejects(peer.input('owned', 'owned-lease', 1, 'ASCII-probe\r'), mode === 'denied' ? /INPUT_FAILED: CONTROL_REQUIRED/ : /INPUT_NOT_ACCEPTED/);
    const proof = await peer.fixtureDiagnostics('owned'); assert.equal(JSON.stringify(proof).includes('owned-lease'), false);
    await peer.screens.dispose();
  }
});

test('accepted input cannot conceal a prior or concurrent terminal protocol failure', async () => {
  const { EventEmitter } = await import('node:events');
  const { WindowsConsumerPeer } = await import('../../bin/consumer-windows.mjs');
  const socket = new EventEmitter();
  socket.send = bytes => {
    const message = JSON.parse(bytes);
    socket.emit('message', Buffer.from(JSON.stringify({ type: 'output', sessionId: message.sessionId, data: 'invalid before snapshot' })));
    socket.emit('message', Buffer.from(JSON.stringify({ type: 'input-ack', sessionId: message.sessionId, leaseId: message.leaseId, inputId: message.inputId, disposition: 'accepted' })));
  };
  const peer = new WindowsConsumerPeer(socket);
  await assert.rejects(peer.input('owned', 'lease', 1, 'ASCII-probe\r'), /SCREEN_WITHOUT_SNAPSHOT/);
  await peer.screens.dispose();
  const later = new WindowsConsumerPeer(new EventEmitter());
  await assert.rejects(later.until(async () => {
    await Promise.resolve(); later.error = new Error('OWNED_ASYNC_PARSER_FAILURE'); return true;
  }, 'ready'), /OWNED_ASYNC_PARSER_FAILURE/);
  await later.screens.dispose();
});
