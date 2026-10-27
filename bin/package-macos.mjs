import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { execFileSync, spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { packagePosix, inspectMacPayload } from './package-posix.mjs';
import { checkSignedPayloadRuntime, checkMacosRelease, digest, verifyCodeSignature } from './check-macos-release.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const run = (file, args, options = {}) => execFileSync(file, args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], ...options });

export function validateSigningOptions({ identity, keychainProfile }) {
  if (typeof identity !== 'string' || !/^[a-f0-9]{40}$/i.test(identity)) throw new Error('MACOS_SIGNING_IDENTITY_REQUIRED: Supply the SHA-1 of an existing Developer ID Application identity.');
  if (typeof keychainProfile !== 'string' || !keychainProfile.trim() || keychainProfile.length > 128 || /[\0\r\n]/.test(keychainProfile)) throw new Error('MACOS_NOTARY_PROFILE_REQUIRED: Supply an existing notarytool Keychain profile name.');
}

function existingIdentity(identity) {
  const identities = run('/usr/bin/security', ['find-identity', '-v', '-p', 'codesigning']);
  if (!identities.split('\n').some(line => line.toUpperCase().includes(identity.toUpperCase()) && line.includes('Developer ID Application:'))) {
    throw new Error('MACOS_DEVELOPER_ID_NOT_AVAILABLE: No matching valid Developer ID Application identity is available in the current Keychain.');
  }
}

function writeJson(file, value) {
  const directory = fs.mkdtempSync(path.join(path.dirname(file), '.receipt-'));
  const temporary = path.join(directory, 'receipt.json');
  try {
    fs.writeFileSync(temporary, JSON.stringify(value, null, 2) + '\n', { mode: 0o600, flag: 'wx' });
    syncFile(temporary); fs.renameSync(temporary, file); syncDirectory(path.dirname(file));
  }
  finally { fs.rmSync(directory, { recursive: true, force: true }); }
}

function syncFile(file) {
  const descriptor = fs.openSync(file, fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW ?? 0));
  try { if (!fs.fstatSync(descriptor).isFile()) throw new Error('MACOS_PROMOTION_NOT_REGULAR'); fs.fsyncSync(descriptor); }
  finally { fs.closeSync(descriptor); }
}

function syncDirectory(directory) {
  const descriptor = fs.openSync(directory, fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW ?? 0));
  try { fs.fsyncSync(descriptor); } finally { fs.closeSync(descriptor); }
}

function promotionPath(output, relative) {
  if (typeof relative !== 'string' || !relative || path.isAbsolute(relative) || relative.includes('\\') ||
    relative.split('/').some(part => !part || part === '.' || part === '..')) throw new Error('MACOS_PROMOTION_PATH_INVALID');
  let file = output;
  for (const [index, part] of relative.split('/').entries()) {
    file = path.join(file, part);
    try {
      const stat = fs.lstatSync(file);
      if (stat.isSymbolicLink()) throw new Error('MACOS_PROMOTION_SYMLINK');
      if (index < relative.split('/').length - 1 && !stat.isDirectory()) throw new Error('MACOS_PROMOTION_PATH_INVALID');
    } catch (error) { if (error.code !== 'ENOENT') throw error; }
  }
  return file;
}

function matchesPromotionFile(file, sha256) {
  let stat;
  try { stat = fs.lstatSync(file); } catch (error) { if (error.code === 'ENOENT') return false; throw error; }
  if (!stat.isFile() || stat.isSymbolicLink()) throw new Error('MACOS_PROMOTION_NOT_REGULAR');
  const descriptor = fs.openSync(file, fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW ?? 0));
  try {
    const opened = fs.fstatSync(descriptor);
    if (opened.dev !== stat.dev || opened.ino !== stat.ino || !opened.isFile()) throw new Error('MACOS_PROMOTION_FILE_CHANGED');
    if (cryptoHash(fs.readFileSync(descriptor)) !== sha256) throw new Error('MACOS_PROMOTION_BYTES_MISMATCH');
  } finally { fs.closeSync(descriptor); }
  return true;
}

const cryptoHash = bytes => crypto.createHash('sha256').update(bytes).digest('hex');

function validatePromotion(receipt, output, promotion) {
  const candidate = validateNotaryReceipt(receipt, output);
  const suffixes = ['', '.sha256', '.notarization.json'];
  if (receipt.status !== 'Accepted' || promotion?.schema !== 1 || !['verified', 'complete'].includes(promotion.state) ||
    !Array.isArray(promotion.files) || promotion.files.length !== suffixes.length ||
    promotion.files[0]?.sha256 !== receipt.finalSha256) throw new Error('MACOS_PROMOTION_CHECKPOINT_INVALID');
  const stagedBase = promotion.files[0].staged;
  const entries = promotion.files.map((entry, index) => {
    if (entry.final !== receipt.releaseName + '.dmg' + suffixes[index] || entry.staged !== stagedBase + suffixes[index] ||
      !/^[0-9a-f]{64}$/.test(entry.sha256 ?? '')) throw new Error('MACOS_PROMOTION_CHECKPOINT_INVALID');
    const staged = promotionPath(output, entry.staged); const final = promotionPath(output, entry.final);
    const ownedStage = path.dirname(candidate);
    if (ownedStage === output || !staged.startsWith(ownedStage + path.sep) || path.dirname(staged) === output ||
      path.basename(staged) !== entry.final || !matchesPromotionFile(staged, entry.sha256)) throw new Error('MACOS_PROMOTION_STAGING_INVALID');
    return { ...entry, stagedPath: staged, finalPath: final };
  });
  return entries;
}

/** Capture before verification, then save only if those exact checked bytes still exist. */
export function captureMacosPromotion(receipt, output, stagedArtifact) {
  const base = path.relative(output, stagedArtifact).split(path.sep).join('/');
  const promotion = { schema: 1, state: 'verified', files: ['', '.sha256', '.notarization.json'].map(suffix => ({
    staged: base + suffix, final: receipt.releaseName + '.dmg' + suffix, sha256: digest(stagedArtifact + suffix),
  })) };
  validatePromotion(receipt, output, promotion); return promotion;
}

export function checkpointMacosPromotion(receiptFile, receipt, output, promotion) {
  const entries = validatePromotion(receipt, output, promotion);
  for (const entry of entries) syncFile(entry.stagedPath);
  syncDirectory(path.dirname(entries[0].stagedPath));
  validatePromotion(receipt, output, promotion);
  const checkpointed = { ...receipt, promotion };
  writeJson(receiptFile, checkpointed); return checkpointed;
}

/** Complete a saved promotion using atomic no-overwrite placement; keep all verified staging files. */
export function promoteMacosFiles(receiptFile, output) {
  if (path.dirname(path.resolve(receiptFile)) !== path.resolve(output) || !fs.lstatSync(receiptFile).isFile() ||
    fs.lstatSync(receiptFile).isSymbolicLink()) throw new Error('MACOS_PROMOTION_RECEIPT_INVALID');
  const receipt = JSON.parse(fs.readFileSync(receiptFile, 'utf8'));
  const entries = validatePromotion(receipt, output, receipt.promotion);
  // Find any conflicting existing final file before placing another member of the set.
  for (const entry of entries) matchesPromotionFile(entry.finalPath, entry.sha256);
  for (const entry of entries) {
    if (!matchesPromotionFile(entry.finalPath, entry.sha256)) {
      const directory = fs.mkdtempSync(path.join(output, '.promotion-'));
      const temporary = path.join(directory, 'verified-copy');
      try {
        fs.copyFileSync(entry.stagedPath, temporary, fs.constants.COPYFILE_EXCL);
        if (!matchesPromotionFile(temporary, entry.sha256)) throw new Error('MACOS_PROMOTION_COPY_MISSING');
        syncFile(temporary);
        try { fs.linkSync(temporary, entry.finalPath); }
        catch (error) { if (error.code !== 'EEXIST') throw error; }
        if (!matchesPromotionFile(entry.finalPath, entry.sha256)) throw new Error('MACOS_PROMOTION_COPY_MISSING');
        syncDirectory(output);
      } finally { fs.rmSync(directory, { recursive: true, force: true }); }
    }
  }
  for (const entry of entries) {
    if (!matchesPromotionFile(entry.finalPath, entry.sha256)) throw new Error('MACOS_PROMOTION_COPY_MISSING');
    syncFile(entry.finalPath);
  }
  syncDirectory(output);
  const complete = { ...receipt, finalArtifact: entries[0].final, promotion: { ...receipt.promotion, state: 'complete' } };
  writeJson(receiptFile, complete);
  return entries[0].finalPath;
}

function manifest(folder) {
  const files = [];
  function walk(relative = '') {
    for (const entry of fs.readdirSync(path.join(folder, relative), { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name, 'en'))) {
      const file = relative ? relative + '/' + entry.name : entry.name;
      if (entry.isSymbolicLink()) throw new Error('MACOS_PAYLOAD_SYMLINK');
      if (entry.isDirectory()) walk(file);
      else if (entry.isFile() && file !== 'SHA256SUMS') files.push(file);
      else if (!entry.isFile()) throw new Error('MACOS_PAYLOAD_NOT_REGULAR');
    }
  }
  walk(); fs.writeFileSync(path.join(folder, 'SHA256SUMS'), files.map(file => `${digest(path.join(folder, file))}  ${file}\n`).join(''));
}

export function validateNotaryReceipt(receipt, output) {
  if (receipt?.schema !== 1 || !/^[a-f0-9]{40}$/i.test(receipt.sourceRevision ?? '') ||
    !/^[a-f0-9]{64}$/.test(receipt.submittedSha256 ?? '') || !['arm64', 'x64'].includes(receipt.architecture) ||
    !/^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i.test(receipt.submissionId ?? '') || typeof receipt.candidate !== 'string' || typeof receipt.releaseName !== 'string' ||
    !/^grotesqueries-\d+\.\d+\.\d+(?:-[a-zA-Z0-9.-]+)?-darwin-(arm64|x64)$/.test(receipt.releaseName)) throw new Error('MACOS_NOTARY_RECEIPT_INVALID');
  const candidate = path.resolve(output, receipt.candidate);
  const relative = path.relative(output, candidate);
  if (!relative || relative.startsWith('..' + path.sep) || path.isAbsolute(relative)) throw new Error('MACOS_NOTARY_RECEIPT_ESCAPES_OUTPUT');
  let current = output;
  for (const part of relative.split(path.sep)) { current = path.join(current, part); if (fs.lstatSync(current).isSymbolicLink()) throw new Error('MACOS_NOTARY_RECEIPT_SYMLINK'); }
  if (!fs.statSync(candidate).isFile() || digest(candidate) !== receipt.submittedSha256) throw new Error('MACOS_SUBMISSION_BYTES_CHANGED: Preserve the existing submission; do not resubmit changed bytes.');
  return candidate;
}

async function signedNativeTests(sourceRoot, payload) {
  const { build } = await import('esbuild');
  const runtime = path.join(payload, '.runtime');
  if (fs.existsSync(runtime)) throw new Error('MACOS_SIGNED_TEST_RUNTIME_EXISTS');
  const bundle = path.join(runtime, 'release-test/mac-native.cjs');
  await build({ entryPoints: [path.join(sourceRoot, 'test/services/mac-native.test.ts')], outfile: bundle,
    bundle: true, conditions: ['grotesqueries-source'], platform: 'node', format: 'cjs', target: 'node24', external: ['node-pty', 'ws'], logLevel: 'silent' });
  const tested = spawnSync(path.join(payload, 'bin/node'), ['--test', '--test-concurrency=1', '--test-reporter=tap', bundle], {
    cwd: payload, env: { ...process.env, PATH: '/usr/bin:/bin', NODE_OPTIONS: '', NODE_PATH: '' }, encoding: 'utf8', timeout: 180000, maxBuffer: 4 * 1024 * 1024,
  });
  if (tested.status !== 0) throw new Error('MACOS_SIGNED_NATIVE_TESTS_FAILED: Retained the owned staging folder for cleanup inspection.');
  const total = Number(/^# tests (\d+)$/m.exec(tested.stdout)?.[1]);
  const passed = Number(/^# pass (\d+)$/m.exec(tested.stdout)?.[1]);
  if (!total || total !== passed || !/^# skipped 0$/m.test(tested.stdout)) throw new Error('MACOS_SIGNED_NATIVE_TEST_PROOF_MISSING');
  fs.rmSync(runtime, { recursive: true }); return { tests: total, passed };
}

async function prepareSubmission(sourceRoot, identity, output) {
  const revision = run('git', ['rev-parse', 'HEAD'], { cwd: sourceRoot }).trim();
  if (run('git', ['status', '--porcelain', '--untracked-files=normal'], { cwd: sourceRoot }).trim()) throw new Error('MACOS_RELEASE_SOURCE_DIRTY');
  // Build all payload inputs from this reviewed tree, never from stale dist files.
  for (const entry of ['lib/protocol/build.mjs', 'frame/build.mjs', 'bin/build.mjs']) run(process.execPath, [path.join(sourceRoot, entry)], { cwd: sourceRoot, timeout: 120000 });
  const unsigned = packagePosix(sourceRoot);
  if (unsigned.metadata.sourceRevision !== revision || unsigned.metadata.sourceDirty) throw new Error('MACOS_RELEASE_SOURCE_MISMATCH');
  const name = path.basename(unsigned.archive, '.tar.gz');
  const receiptFile = path.join(output, name + '.submission.json');
  if (fs.existsSync(receiptFile)) throw new Error('MACOS_SUBMISSION_EXISTS: Resume the recorded submission instead of uploading again.');
  const stage = fs.mkdtempSync(path.join(output, '.submission-'));
  const volume = path.join(stage, 'volume'); fs.mkdirSync(volume);
  run('/usr/bin/tar', ['-xzf', unsigned.archive, '-C', volume], { env: { ...process.env, TAR_OPTIONS: '', COPYFILE_DISABLE: '1' } });
  const payload = path.join(volume, name);
  const entitlements = path.join(sourceRoot, 'config/macos-node-entitlements.plist');
  const approved = JSON.parse(run('/usr/bin/plutil', ['-convert', 'json', '-o', '-', entitlements]));
  if (JSON.stringify(approved) !== JSON.stringify({ 'com.apple.security.cs.allow-jit': true })) throw new Error('MACOS_ENTITLEMENTS_NOT_APPROVED');
  let teamIdentifier;
  for (const binary of inspectMacPayload(payload)) {
    run('/usr/bin/codesign', ['--force', '--sign', identity, '--options', 'runtime', '--timestamp',
      ...(binary.file === 'bin/node' ? ['--entitlements', entitlements] : []), path.join(payload, binary.file)], { timeout: 120000 });
    const signature = verifyCodeSignature(path.join(payload, binary.file), { node: binary.file === 'bin/node', teamIdentifier });
    teamIdentifier ??= signature.teamIdentifier;
  }
  const metadataFile = path.join(payload, 'BUILD-METADATA.json');
  const metadata = JSON.parse(fs.readFileSync(metadataFile, 'utf8'));
  Object.assign(metadata, { signing: 'developer-id', signingTeamIdentifier: teamIdentifier,
    signedNodeSha256: digest(path.join(payload, 'bin/node')), notarization: 'ticket-on-distribution-dmg' });
  fs.writeFileSync(metadataFile, JSON.stringify(metadata, null, 2) + '\n');
  const readme = path.join(payload, 'README.txt');
  fs.writeFileSync(readme, fs.readFileSync(readme, 'utf8').replace('This Mac alpha is unsigned and unnotarized. Do not bypass operating-system security warnings.',
    'Copy this entire folder from the disk image into a writable local folder before running it. This payload is distributed in a signed, notarized, stapled DMG.'));
  manifest(payload);
  const native = await signedNativeTests(sourceRoot, payload);
  const packageChecked = await checkSignedPayloadRuntime(payload, stage);
  metadata.signedNativeTests = native; metadata.signedPackageChecks = packageChecked.checks.length;
  fs.writeFileSync(metadataFile, JSON.stringify(metadata, null, 2) + '\n'); manifest(payload);
  fs.writeFileSync(path.join(volume, 'READ-ME-FIRST.txt'), 'Copy the entire Grotesqueries folder to a writable local folder, then open Terminal there and run ./grotesqueries --setup followed by ./grotesqueries.\nThe mounted disk image is read-only. Do not launch from it.\nMac Stop verifies tracked processes only; rapidly detached unobserved daemons may remain running.\n');
  const candidate = path.join(stage, name + '-' + revision.slice(0, 12) + '.dmg');
  run('/usr/bin/hdiutil', ['create', '-volname', 'Grotesqueries', '-srcfolder', volume, '-format', 'UDZO', '-ov', candidate], { timeout: 120000 });
  run('/usr/bin/codesign', ['--sign', identity, '--timestamp', candidate], { timeout: 120000 });
  verifyCodeSignature(candidate, { diskImage: true, teamIdentifier });
  const receipt = { schema: 1, releaseName: name, candidate: path.relative(output, candidate), sourceRevision: revision,
    architecture: process.arch, minimumMacOS: '15.0', signingTeamIdentifier: teamIdentifier,
    submittedSha256: digest(candidate), status: 'SubmissionStarted', signedNativeTests: native, signedPackageChecks: packageChecked.checks.length };
  writeJson(receiptFile, receipt);
  return { receipt, receiptFile, candidate };
}

/** Sign, prove the signed runtime, notarize once, staple, and qualify the resulting DMG. */
export async function packageMacos({ sourceRoot = root, identity, keychainProfile, resume } = {}) {
  if (process.platform !== 'darwin') throw new Error('MACOS_PACKAGING_UNSUPPORTED');
  if (process.version !== 'v24.14.1') throw new Error('MACOS_PACKAGE_NODE_VERSION: Build with Node 24.14.1.');
  validateSigningOptions({ identity, keychainProfile }); existingIdentity(identity);
  sourceRoot = fs.realpathSync(sourceRoot);
  const output = path.join(sourceRoot, 'dist/macos');
  for (const file of [path.join(sourceRoot, 'dist'), output]) {
    try { if (fs.lstatSync(file).isSymbolicLink()) throw new Error('MACOS_RELEASE_OUTPUT_ESCAPES_SOURCE'); }
    catch (error) { if (error.code !== 'ENOENT') throw error; }
  }
  fs.mkdirSync(output, { recursive: true });
  if (fs.lstatSync(output).isSymbolicLink() || !fs.realpathSync(output).startsWith(sourceRoot + path.sep)) throw new Error('MACOS_RELEASE_OUTPUT_ESCAPES_SOURCE');
  let receipt, receiptFile, candidate;
  if (resume) {
    receiptFile = path.resolve(resume);
    if (path.dirname(receiptFile) !== output || fs.lstatSync(receiptFile).isSymbolicLink()) throw new Error('MACOS_NOTARY_RECEIPT_ESCAPES_OUTPUT');
    receipt = JSON.parse(fs.readFileSync(receiptFile, 'utf8')); candidate = validateNotaryReceipt(receipt, output);
    if (receipt.architecture !== process.arch) throw new Error('MACOS_SUBMISSION_ARCHITECTURE_MISMATCH');
    if (receipt.promotion) return checkMacosRelease(promoteMacosFiles(receiptFile, output));
    if (receipt.finalArtifact) {
      const artifact = path.join(output, receipt.releaseName + '.dmg');
      if (receipt.finalArtifact !== path.basename(artifact) || fs.lstatSync(artifact).isSymbolicLink() || digest(artifact) !== receipt.finalSha256) throw new Error('MACOS_RELEASE_BYTES_CHANGED');
      return checkMacosRelease(artifact);
    }
  } else ({ receipt, receiptFile, candidate } = await prepareSubmission(sourceRoot, identity, output));
  if (!receipt.submissionId) {
    let submitted;
    const result = spawnSync('/usr/bin/xcrun', ['notarytool', 'submit', candidate, '--keychain-profile', keychainProfile, '--output-format', 'json'],
      { encoding: 'utf8', timeout: 180000, maxBuffer: 4 * 1024 * 1024 });
    try { submitted = JSON.parse(result.stdout); } catch { /* A lost response is an unknown upload outcome, never permission to resubmit. */ }
    if (!/^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i.test(submitted?.id ?? '')) {
      receipt.status = 'SubmissionOutcomeUnknown'; writeJson(receiptFile, receipt);
      throw new Error('MACOS_SUBMISSION_OUTCOME_UNKNOWN: Inspect notarytool history; do not upload a second copy.');
    }
    receipt.submissionId = submitted.id; receipt.status = 'Submitted'; writeJson(receiptFile, receipt);
  }
  let waited;
  const waitedResult = spawnSync('/usr/bin/xcrun', ['notarytool', 'wait', receipt.submissionId, '--keychain-profile', keychainProfile, '--timeout', '10m', '--output-format', 'json'],
    { encoding: 'utf8', timeout: 650000, maxBuffer: 4 * 1024 * 1024 });
  try { waited = JSON.parse(waitedResult.stdout); } catch { /* Missing status remains unknown; preserve the submission for recovery. */ }
  if (!['Accepted', 'Invalid', 'Rejected'].includes(waited?.status)) throw new Error('MACOS_NOTARIZATION_STATUS_UNAVAILABLE: Check the approved profile and resume the recorded submission.');
  receipt.status = waited.status; writeJson(receiptFile, receipt);
  const logFile = path.join(path.dirname(candidate), 'notarization-log.json');
  run('/usr/bin/xcrun', ['notarytool', 'log', receipt.submissionId, '--keychain-profile', keychainProfile, logFile], { timeout: 30000 });
  const log = JSON.parse(fs.readFileSync(logFile, 'utf8'));
  if (waited.status !== 'Accepted' || log.status !== 'Accepted' || log.issues?.length ||
    log.jobId && log.jobId.toLowerCase() !== receipt.submissionId.toLowerCase() ||
    log.sha256 && log.sha256 !== receipt.submittedSha256) throw new Error('MACOS_NOTARIZATION_NOT_CLEAN: Inspect the retained Apple log before distribution.');
  if (digest(candidate) !== receipt.submittedSha256) throw new Error('MACOS_SUBMISSION_BYTES_CHANGED');
  // Preserve the originally uploaded bytes for recovery. Stapling mutates only a fresh owned copy.
  const stapled = fs.mkdtempSync(path.join(path.dirname(candidate), 'stapled-'));
  const checkedArtifact = path.join(stapled, receipt.releaseName + '.dmg'); fs.copyFileSync(candidate, checkedArtifact);
  run('/usr/bin/xcrun', ['stapler', 'staple', checkedArtifact], { timeout: 120000 });
  run('/usr/bin/xcrun', ['stapler', 'validate', checkedArtifact], { timeout: 30000 });
  run('/usr/sbin/spctl', ['--assess', '--type', 'open', '--context', 'context:primary-signature', checkedArtifact], { timeout: 30000 });
  const artifact = path.join(output, receipt.releaseName + '.dmg');
  receipt.finalSha256 = digest(checkedArtifact); receipt.notarizationLogSha256 = digest(logFile); receipt.status = 'Accepted';
  fs.writeFileSync(checkedArtifact + '.sha256', `${receipt.finalSha256}  ${path.basename(artifact)}\n`);
  const publicReceipt = { ...receipt }; delete publicReceipt.candidate;
  writeJson(checkedArtifact + '.notarization.json', publicReceipt);
  const promotion = captureMacosPromotion(receipt, output, checkedArtifact);
  const checked = await checkMacosRelease(checkedArtifact);
  if (checked.sha256 !== promotion.files[0].sha256) throw new Error('MACOS_PROMOTION_BYTES_MISMATCH');
  checkpointMacosPromotion(receiptFile, receipt, output, promotion);
  promoteMacosFiles(receiptFile, output);
  const finalChecked = await checkMacosRelease(artifact);
  const result = { ...finalChecked, artifact, checksum: artifact + '.sha256', receipt: artifact + '.notarization.json' };
  console.log(JSON.stringify({ macosPackaged: true, ...result })); return result;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const args = process.argv.slice(2); const options = {};
  for (let index = 0; index < args.length; index += 2) {
    const key = { '--identity': 'identity', '--keychain-profile': 'keychainProfile', '--resume': 'resume' }[args[index]];
    if (!key || !args[index + 1] || Object.hasOwn(options, key)) throw new Error('Usage: package-macos.mjs --identity <identity SHA-1> --keychain-profile <existing profile> [--resume <receipt.json>]');
    options[key] = args[index + 1];
  }
  await packageMacos(options);
}
