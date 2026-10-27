import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import test from 'node:test';
import { extractNativePayload } from '../../app/services/native-payload.js';
import { scratchDirectory } from '../support/scratch.js';

test('native extraction verifies hashes, repairs partial files and rejects unsafe manifest names', () => {
  const root = scratchDirectory('native-payload-');
  const bytes = Buffer.from('fixture-only');
  const sha256 = crypto.createHash('sha256').update(bytes).digest('hex');
  const manifest = { buildId: sha256.slice(0, 24), files: [{ path: 'fixture/data.js', bytes: bytes.length, sha256 }] };
  const directory = extractNativePayload(root, manifest, () => bytes);
  const file = path.join(directory, 'fixture/data.js');
  fs.writeFileSync(file, 'partial');
  extractNativePayload(root, manifest, () => bytes);
  assert.equal(fs.readFileSync(file, 'utf8'), 'fixture-only');
  for (const name of ['../escape', '/absolute', 'C:/outside', 'E:/outside', 'fixture/../escape', 'fixture/data:stream']) {
    assert.throws(() => extractNativePayload(root, { ...manifest, files: [{ ...manifest.files[0], path: name }] }, () => bytes));
  }
  assert.throws(() => extractNativePayload(root, { ...manifest, buildId: 'a'.repeat(24) }, () => Buffer.from('wrong-hash')), /INTEGRITY/);
});
