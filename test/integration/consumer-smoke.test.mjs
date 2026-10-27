import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { assertPristineConsumerFolder, consumerSmoke } from '../../bin/consumer-smoke.mjs';

function fixture(run) {
  const directory = path.join(process.cwd(), '.runtime/tmp'); fs.mkdirSync(directory, { recursive: true });
  const folder = fs.mkdtempSync(path.join(directory, 'consumer-safety-'));
  try { return run(folder); } finally { fs.rmSync(folder, { recursive: true, force: true }); }
}

test('consumer testing refuses an existing operator configuration before changing any bytes', () => fixture(folder => {
  fs.mkdirSync(path.join(folder, 'config'));
  const file = path.join(folder, 'config/grotesqueries.json'); const original = '{"operator":"preserve"}\n';
  fs.writeFileSync(file, original);
  assert.throws(() => assertPristineConsumerFolder(folder), /PRISTINE_DISPOSABLE_COPY/);
  assert.equal(fs.readFileSync(file, 'utf8'), original);
  assert.deepEqual(fs.readdirSync(folder), ['config']);
}));

test('consumer testing requires a disposable-copy instruction and refuses prior runtime data', async () => {
  await assert.rejects(consumerSmoke(process.cwd()), /EXPLICIT_DISPOSABLE_COPY/);
  fixture(folder => {
    fs.mkdirSync(path.join(folder, '.runtime'));
    fs.writeFileSync(path.join(folder, '.runtime/evidence'), 'preserve this evidence');
    assert.throws(() => assertPristineConsumerFolder(folder), /PRISTINE_DISPOSABLE_COPY/);
    assert.equal(fs.readFileSync(path.join(folder, '.runtime/evidence'), 'utf8'), 'preserve this evidence');
  });
});
