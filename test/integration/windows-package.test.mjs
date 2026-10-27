import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import test from 'node:test';
import { windowsZip, stripAuthenticodeSignature, defaultWindowsConfiguration } from '../../bin/package-windows.mjs';
import { readWindowsZip, verifyWindowsFiles } from '../../bin/consumer-windows.mjs';
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
