import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync, spawn } from 'node:child_process';
import { once } from 'node:events';
import test from 'node:test';
import { buildNative } from '../../bin/native-build.mjs';
import { inspectMacPayload } from '../../bin/package-posix.mjs';
import { inspectCodeSignature, verifyCodeSignature } from '../../bin/check-macos-release.mjs';
import { digest } from '../../bin/check-macos-release.mjs';
import { packageMacos, validateSigningOptions, validateNotaryReceipt, captureMacosPromotion,
  checkpointMacosPromotion, promoteMacosFiles } from '../../bin/package-macos.mjs';

const root = process.cwd(); const skip = process.platform !== 'darwin';
function scratch() {
  const parent = path.join(root, '.runtime/tmp'); fs.mkdirSync(parent, { recursive: true });
  return fs.mkdtempSync(path.join(parent, 'macos-release-'));
}
function compile(folder, name, source = 'int main(void){return 0;}\n', target = '15.0') {
  const file = path.join(folder, name); fs.writeFileSync(file + '.c', source);
  execFileSync('/usr/bin/cc', [`-mmacosx-version-min=${target}`, file + '.c', '-o', file], { stdio: 'pipe' }); return file;
}

// These opaque files exercise filesystem recovery only. They are not notarization or signature fixtures.
function promotionFixture(checkpoint = true) {
  const output = scratch(); const stage = path.join(output, '.submission-fixture');
  const stapled = path.join(stage, 'stapled-fixture'); fs.mkdirSync(stapled, { recursive: true });
  const releaseName = 'grotesqueries-0.1.0-alpha.1-darwin-arm64';
  const original = path.join(stage, 'uploaded.dmg'); fs.writeFileSync(original, 'original upload fixture');
  const artifact = path.join(stapled, releaseName + '.dmg'); fs.writeFileSync(artifact, 'verified output fixture');
  fs.writeFileSync(artifact + '.sha256', digest(artifact) + '  ' + releaseName + '.dmg\n');
  fs.writeFileSync(artifact + '.notarization.json', '{"filesystemFixture":true}\n');
  const receipt = { schema: 1, sourceRevision: 'a'.repeat(40), submittedSha256: digest(original), architecture: 'arm64',
    submissionId: '11111111-2222-3333-4444-555555555555', releaseName, candidate: '.submission-fixture/uploaded.dmg',
    finalSha256: digest(artifact), status: 'Accepted' };
  const receiptFile = path.join(output, releaseName + '.submission.json'); fs.writeFileSync(receiptFile, JSON.stringify(receipt));
  const promotion = captureMacosPromotion(receipt, output, artifact);
  if (checkpoint) checkpointMacosPromotion(receiptFile, receipt, output, promotion);
  return { output, receiptFile, receipt, promotion, artifact };
}
function assertPreserved(fixture, finals = true) {
  for (const entry of fixture.promotion.files) {
    assert.equal(digest(path.join(fixture.output, entry.staged)), entry.sha256, 'verified staging remains intact');
    if (finals) assert.equal(digest(path.join(fixture.output, entry.final)), entry.sha256);
  }
  assert.equal(digest(path.join(fixture.output, fixture.receipt.candidate)), fixture.receipt.submittedSha256);
}
function eio() { const error = new Error('owned filesystem interruption'); error.code = 'EIO'; return error; }
const promotionSkip = process.platform === 'win32';

for (const interrupted of ['', '.sha256', '.notarization.json']) {
  test(`Mac filesystem promotion resumes after placement of ${interrupted || 'DMG'}`, { skip: promotionSkip }, context => {
    const fixture = promotionFixture(); const link = fs.linkSync;
    try {
      context.mock.method(fs, 'linkSync', (source, destination) => {
        link(source, destination);
        if (destination === fixture.artifact.replace(path.dirname(fixture.artifact), fixture.output) + interrupted) throw eio();
      });
      assert.throws(() => promoteMacosFiles(fixture.receiptFile, fixture.output), /filesystem interruption/);
      assertPreserved(fixture, false);
      assert.equal(JSON.parse(fs.readFileSync(fixture.receiptFile)).promotion.state, 'verified');
      context.mock.restoreAll();
      assert.equal(promoteMacosFiles(fixture.receiptFile, fixture.output), path.join(fixture.output, fixture.receipt.releaseName + '.dmg'));
      assertPreserved(fixture);
      assert.equal(JSON.parse(fs.readFileSync(fixture.receiptFile)).promotion.state, 'complete');
    } finally { context.mock.restoreAll(); fs.rmSync(fixture.output, { recursive: true, force: true }); }
  });
}

for (const phase of ['checkpoint', 'completion']) for (const boundary of ['before', 'after']) {
  test(`Mac filesystem promotion survives ${boundary} ${phase} receipt rename`, { skip: promotionSkip }, context => {
    const fixture = promotionFixture(phase !== 'checkpoint'); const rename = fs.renameSync;
    try {
      context.mock.method(fs, 'renameSync', (source, destination) => {
        if (destination === fixture.receiptFile && boundary === 'before') throw eio();
        rename(source, destination);
        if (destination === fixture.receiptFile && boundary === 'after') throw eio();
      });
      assert.throws(() => phase === 'checkpoint'
        ? checkpointMacosPromotion(fixture.receiptFile, fixture.receipt, fixture.output, fixture.promotion)
        : promoteMacosFiles(fixture.receiptFile, fixture.output), /filesystem interruption/);
      assertPreserved(fixture, phase === 'completion');
      if (phase === 'checkpoint') for (const entry of fixture.promotion.files) assert.equal(fs.existsSync(path.join(fixture.output, entry.final)), false);
      context.mock.restoreAll();
      if (!JSON.parse(fs.readFileSync(fixture.receiptFile)).promotion) checkpointMacosPromotion(fixture.receiptFile, fixture.receipt, fixture.output, fixture.promotion);
      promoteMacosFiles(fixture.receiptFile, fixture.output); assertPreserved(fixture);
      assert.equal(JSON.parse(fs.readFileSync(fixture.receiptFile)).promotion.state, 'complete');
    } finally { context.mock.restoreAll(); fs.rmSync(fixture.output, { recursive: true, force: true }); }
  });
}

test('Mac filesystem promotion retries a partial temporary copy without occupying a final name', { skip: promotionSkip }, context => {
  const fixture = promotionFixture(); const copy = fs.copyFileSync;
  try {
    context.mock.method(fs, 'copyFileSync', (source, destination, flags) => {
      copy(source, destination, flags); fs.writeFileSync(destination, 'partial copy'); throw eio();
    });
    assert.throws(() => promoteMacosFiles(fixture.receiptFile, fixture.output), /filesystem interruption/);
    assertPreserved(fixture, false);
    for (const entry of fixture.promotion.files) assert.equal(fs.existsSync(path.join(fixture.output, entry.final)), false);
    context.mock.restoreAll(); promoteMacosFiles(fixture.receiptFile, fixture.output); assertPreserved(fixture);
  } finally { context.mock.restoreAll(); fs.rmSync(fixture.output, { recursive: true, force: true }); }
});

for (const suffix of ['', '.sha256', '.notarization.json']) {
  test(`Mac filesystem promotion preserves a conflicting existing ${suffix || 'DMG'}`, { skip: promotionSkip }, () => {
    const fixture = promotionFixture();
    try {
      const conflict = path.join(fixture.output, fixture.receipt.releaseName + '.dmg' + suffix);
      fs.writeFileSync(conflict, 'unrelated existing bytes');
      assert.throws(() => promoteMacosFiles(fixture.receiptFile, fixture.output), /PROMOTION_BYTES_MISMATCH/);
      assert.equal(fs.readFileSync(conflict, 'utf8'), 'unrelated existing bytes'); assertPreserved(fixture, false);
      for (const entry of fixture.promotion.files) if (entry.final !== path.basename(conflict)) assert.equal(fs.existsSync(path.join(fixture.output, entry.final)), false);
    } finally { fs.rmSync(fixture.output, { recursive: true, force: true }); }
  });
}

test('Mac filesystem promotion preserves a symlink destination and its target', { skip: promotionSkip }, () => {
  const fixture = promotionFixture();
  try {
    const target = path.join(fixture.output, 'owned-unrelated-fixture'); fs.writeFileSync(target, 'unrelated target');
    const destination = path.join(fixture.output, fixture.receipt.releaseName + '.dmg.sha256'); fs.symlinkSync(target, destination);
    assert.throws(() => promoteMacosFiles(fixture.receiptFile, fixture.output), /PROMOTION_SYMLINK/);
    assert.equal(fs.lstatSync(destination).isSymbolicLink(), true); assert.equal(fs.readFileSync(target, 'utf8'), 'unrelated target'); assertPreserved(fixture, false);
  } finally { fs.rmSync(fixture.output, { recursive: true, force: true }); }
});

test('Mac filesystem promotion never overwrites a conflicting file created during placement', { skip: promotionSkip }, context => {
  const fixture = promotionFixture(); const link = fs.linkSync; let raced;
  try {
    context.mock.method(fs, 'linkSync', (source, destination) => {
      raced = destination; fs.writeFileSync(destination, 'concurrent existing bytes'); return link(source, destination);
    });
    assert.throws(() => promoteMacosFiles(fixture.receiptFile, fixture.output), /PROMOTION_BYTES_MISMATCH/);
    assert.equal(fs.readFileSync(raced, 'utf8'), 'concurrent existing bytes'); assertPreserved(fixture, false);
  } finally { context.mock.restoreAll(); fs.rmSync(fixture.output, { recursive: true, force: true }); }
});

test('Mac filesystem checkpoint rejects staging that changed after verification capture', { skip: promotionSkip }, () => {
  const fixture = promotionFixture(false);
  try {
    fs.writeFileSync(fixture.artifact, 'changed after capture');
    assert.throws(() => checkpointMacosPromotion(fixture.receiptFile, fixture.receipt, fixture.output, fixture.promotion), /PROMOTION_BYTES_MISMATCH/);
    assert.equal(JSON.parse(fs.readFileSync(fixture.receiptFile)).promotion, undefined);
    for (const entry of fixture.promotion.files) assert.equal(fs.existsSync(path.join(fixture.output, entry.final)), false);
  } finally { fs.rmSync(fixture.output, { recursive: true, force: true }); }
});

test('Mac filesystem checkpoint does not advance when verified staging cannot be flushed', { skip: promotionSkip }, context => {
  const fixture = promotionFixture(false);
  try {
    context.mock.method(fs, 'fsyncSync', () => { throw eio(); });
    assert.throws(() => checkpointMacosPromotion(fixture.receiptFile, fixture.receipt, fixture.output, fixture.promotion), /filesystem interruption/);
    assert.equal(JSON.parse(fs.readFileSync(fixture.receiptFile)).promotion, undefined); assertPreserved(fixture, false);
    for (const entry of fixture.promotion.files) assert.equal(fs.existsSync(path.join(fixture.output, entry.final)), false);
    context.mock.restoreAll(); checkpointMacosPromotion(fixture.receiptFile, fixture.receipt, fixture.output, fixture.promotion);
    promoteMacosFiles(fixture.receiptFile, fixture.output); assertPreserved(fixture);
  } finally { context.mock.restoreAll(); fs.rmSync(fixture.output, { recursive: true, force: true }); }
});

test('Mac signing refuses absent identities and plaintext credential arguments before writing a release', async () => {
  assert.throws(() => validateSigningOptions({}), /MACOS_SIGNING_IDENTITY_REQUIRED/);
  assert.throws(() => validateSigningOptions({ identity: 'Developer ID Application: ambiguous name', keychainProfile: 'existing' }), /MACOS_SIGNING_IDENTITY_REQUIRED/);
  assert.throws(() => validateSigningOptions({ identity: 'a'.repeat(40), keychainProfile: 'bad\nprofile' }), /MACOS_NOTARY_PROFILE_REQUIRED/);
  if (!skip) await assert.rejects(packageMacos({ identity: '0'.repeat(40), keychainProfile: 'missing-test-profile' }), /MACOS_DEVELOPER_ID_NOT_AVAILABLE/);
});

test('Mac notarization resume requires the original submission bytes and a contained regular file', () => {
  const folder = scratch();
  try {
    const candidate = path.join(folder, 'candidate.dmg'); fs.writeFileSync(candidate, 'original fixture bytes');
    const receipt = { schema: 1, sourceRevision: 'a'.repeat(40), submittedSha256: digest(candidate), architecture: 'arm64',
      submissionId: '11111111-2222-3333-4444-555555555555', releaseName: 'grotesqueries-0.1.0-alpha.1-darwin-arm64', candidate: 'candidate.dmg' };
    assert.equal(validateNotaryReceipt(receipt, folder), candidate);
    assert.throws(() => validateNotaryReceipt({ ...receipt, candidate: '../outside.dmg' }, folder), /ESCAPES_OUTPUT/);
    assert.throws(() => validateNotaryReceipt({ ...receipt, submissionId: undefined }, folder), /RECEIPT_INVALID/);
    fs.writeFileSync(candidate, 'mutated bytes');
    assert.throws(() => validateNotaryReceipt(receipt, folder), /SUBMISSION_BYTES_CHANGED/);
    if (process.platform !== 'win32') {
      fs.symlinkSync(candidate, path.join(folder, 'linked.dmg'));
      assert.throws(() => validateNotaryReceipt({ ...receipt, candidate: 'linked.dmg' }, folder), /RECEIPT_SYMLINK/);
    }
  } finally { fs.rmSync(folder, { recursive: true, force: true }); }
});

test('Mac native build records 15.0 and package inspection rejects newer or unexpected Mach-O files', { skip }, () => {
  buildNative(root);
  assert.match(execFileSync('/usr/bin/xcrun', ['vtool', '-show-build', path.join(root, 'dist/native/macos-processes')], { encoding: 'utf8' }), /minos 15\.0/);
  const folder = scratch();
  try {
    const binary = compile(folder, 'fixture');
    const names = ['bin/node', 'dist/native/macos-processes', `node_modules/node-pty/prebuilds/darwin-${process.arch}/pty.node`,
      `node_modules/node-pty/prebuilds/darwin-${process.arch}/spawn-helper`];
    for (const name of names) { fs.mkdirSync(path.dirname(path.join(folder, name)), { recursive: true }); fs.copyFileSync(binary, path.join(folder, name)); }
    fs.unlinkSync(binary); fs.unlinkSync(binary + '.c');
    assert.equal(inspectMacPayload(folder).length, 4);
    fs.copyFileSync(path.join(folder, names[0]), path.join(folder, 'unexpected-native'));
    assert.throws(() => inspectMacPayload(folder), /MACHO_INVENTORY_MISMATCH/);
    fs.unlinkSync(path.join(folder, 'unexpected-native'));
    const newer = compile(folder, 'newer', undefined, '26.0');
    fs.copyFileSync(newer, path.join(folder, names[1])); fs.unlinkSync(newer); fs.unlinkSync(newer + '.c');
    assert.throws(() => inspectMacPayload(folder), /MINIMUM_OS_MISMATCH/);
  } finally { fs.rmSync(folder, { recursive: true, force: true }); }
});

test('Mac hardened helper signals an owned hardened child without debugging entitlements', { skip, timeout: 12000 }, async () => {
  const folder = scratch(); let child; let exited;
  try {
    const binary = compile(folder, 'owned-child', '#include <unistd.h>\n#include <signal.h>\nint main(void){alarm(6);write(1,"ready\\n",6);for(;;)pause();}\n');
    const helper = path.join(folder, 'process-helper'); fs.copyFileSync(path.join(root, 'dist/native/macos-processes'), helper);
    for (const file of [binary, helper]) execFileSync('/usr/bin/codesign', ['--force', '--sign', '-', '--options', 'runtime', file], { stdio: 'pipe' });
    const signature = inspectCodeSignature(binary); assert.equal(signature.runtime, true); assert.deepEqual(signature.entitlements, {});
    assert.throws(() => verifyCodeSignature(binary), /DEVELOPER_ID_MISMATCH/);
    child = spawn(binary, [], { detached: true, stdio: ['ignore', 'pipe', 'pipe'] }); exited = once(child, 'exit');
    await once(child.stdout, 'data');
    const identity = JSON.parse(execFileSync(helper, ['list'], { encoding: 'utf8', maxBuffer: 4 * 1024 * 1024 })).processes.find(value => value.pid === child.pid);
    assert.ok(identity); execFileSync(helper, ['kill', String(identity.pid), identity.birth, String(identity.session)], { stdio: 'pipe', timeout: 2000 });
    assert.deepEqual(await exited, [null, 'SIGKILL']);
  } finally {
    // The harmless owned child self-expires in six seconds even if metadata or signaling failed.
    if (child && child.exitCode === null && child.signalCode === null) await exited;
    fs.rmSync(folder, { recursive: true, force: true });
  }
});
