import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import test from 'node:test';
import { verifyPackageFiles } from '../../bin/check-posix-package.mjs';

function fixture(run) {
  const tmp = path.join(process.cwd(), '.runtime', 'tmp'); fs.mkdirSync(tmp, { recursive: true });
  const folder = fs.mkdtempSync(path.join(tmp, 'package-integrity-'));
  try { run(folder); } finally { fs.rmSync(folder, { recursive: true, force: true }); }
}
const digest = value => crypto.createHash('sha256').update(value).digest('hex');

test('package integrity rejects altered shipped runtime bytes', () => fixture(folder => {
  fs.writeFileSync(path.join(folder, 'runtime.js'), 'original runtime\n');
  fs.writeFileSync(path.join(folder, 'SHA256SUMS'), `${digest('original runtime\n')}  runtime.js\n`);
  assert.deepEqual([...verifyPackageFiles(folder)], ['runtime.js']);
  fs.writeFileSync(path.join(folder, 'runtime.js'), 'altered runtime\n');
  assert.throws(() => verifyPackageFiles(folder), /PACKAGE_CHECKSUM_MISMATCH/);
}));

test('package integrity refuses traversal, duplicate and malformed manifest entries', () => fixture(folder => {
  for (const line of [`${digest('x')}  ../outside\n`, `${digest('x')}  /absolute\n`, 'not-a-checksum  runtime.js\n',
    `${digest('x')}  runtime.js\n${digest('x')}  runtime.js\n`]) {
    fs.writeFileSync(path.join(folder, 'runtime.js'), 'x');
    fs.writeFileSync(path.join(folder, 'SHA256SUMS'), line);
    assert.throws(() => verifyPackageFiles(folder), /PACKAGE_MANIFEST_INVALID/);
  }
}));

test('package integrity refuses a linked runtime even when its bytes match', { skip: process.platform === 'win32' }, () => fixture(folder => {
  fs.writeFileSync(path.join(folder, 'original.js'), 'fixture\n');
  fs.symlinkSync('original.js', path.join(folder, 'runtime.js'));
  fs.writeFileSync(path.join(folder, 'SHA256SUMS'), `${digest('fixture\n')}  runtime.js\n`);
  assert.throws(() => verifyPackageFiles(folder), /PACKAGE_MANIFEST_SYMLINK/);
}));
