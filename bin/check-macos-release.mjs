import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { execFileSync, spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { inspectMacPayload } from './package-posix.mjs';
import { verifyConsumerFiles } from './consumer-smoke.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
export const digest = file => crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');

/** Read signature metadata without logging a certificate subject or credential. */
export function inspectCodeSignature(file) {
  const displayed = spawnSync('/usr/bin/codesign', ['--display', '--verbose=4', '--entitlements', ':-', file], { encoding: 'utf8' });
  if (displayed.status !== 0) throw new Error('MACOS_SIGNATURE_MISSING');
  const details = displayed.stderr;
  const teamIdentifier = /^TeamIdentifier=([A-Z0-9]{10})$/m.exec(details)?.[1];
  const developerId = /^Authority=Developer ID Application:/m.test(details);
  const runtime = /\bflags=0x[0-9a-f]+\([^\n)]*\bruntime\b/i.test(details);
  let entitlements = {};
  if (displayed.stdout.trim()) {
    const converted = spawnSync('/usr/bin/plutil', ['-convert', 'json', '-o', '-', '-'], { input: displayed.stdout, encoding: 'utf8' });
    if (converted.status !== 0) throw new Error('MACOS_ENTITLEMENTS_INVALID');
    entitlements = JSON.parse(converted.stdout);
  }
  return { teamIdentifier, developerId, runtime, entitlements };
}

export function verifyCodeSignature(file, { node = false, teamIdentifier, diskImage = false } = {}) {
  execFileSync('/usr/bin/codesign', ['--verify', '--strict', file], { stdio: 'pipe' });
  const signature = inspectCodeSignature(file);
  if (!signature.developerId || !signature.teamIdentifier || teamIdentifier && signature.teamIdentifier !== teamIdentifier) throw new Error('MACOS_DEVELOPER_ID_MISMATCH');
  execFileSync('/usr/bin/codesign', ['--verify', '--strict', '-R', '=anchor apple generic and certificate leaf[field.1.2.840.113635.100.6.1.13] exists', file], { stdio: 'pipe' });
  if (!diskImage && !signature.runtime) throw new Error('MACOS_HARDENED_RUNTIME_REQUIRED');
  const expected = node ? { 'com.apple.security.cs.allow-jit': true } : {};
  if (JSON.stringify(signature.entitlements) !== JSON.stringify(expected)) throw new Error('MACOS_ENTITLEMENTS_NOT_APPROVED');
  return signature;
}

export function verifySignedPayload(folder) {
  verifyConsumerFiles(folder);
  const binaries = inspectMacPayload(folder);
  let teamIdentifier;
  for (const binary of binaries) {
    const verified = verifyCodeSignature(path.join(folder, binary.file), { node: binary.file === 'bin/node', teamIdentifier });
    teamIdentifier ??= verified.teamIdentifier;
  }
  const metadata = JSON.parse(fs.readFileSync(path.join(folder, 'BUILD-METADATA.json'), 'utf8'));
  if (metadata.sourceDirty !== false || metadata.signing !== 'developer-id' || metadata.signingTeamIdentifier !== teamIdentifier ||
    metadata.minimumMacOS !== '15.0' || JSON.stringify(metadata.machOBinaries) !== JSON.stringify(binaries)) throw new Error('MACOS_RELEASE_METADATA_MISMATCH');
  return { teamIdentifier, binaries, metadata };
}

/** Run the existing real terminal roundtrip against a temporary archive of these exact signed files. */
export async function checkSignedPayloadRuntime(folder, scratch) {
  const { checkPosixPackage } = await import('./check-posix-package.mjs');
  verifySignedPayload(folder);
  const archive = path.join(scratch, 'signed-runtime.tar.gz');
  execFileSync('/usr/bin/tar', ['-czf', archive, '-C', path.dirname(folder), path.basename(folder)],
    { env: { ...process.env, COPYFILE_DISABLE: '1', TAR_OPTIONS: '' }, stdio: 'pipe' });
  fs.writeFileSync(archive + '.sha256', `${digest(archive)}  ${path.basename(archive)}\n`);
  return checkPosixPackage(archive);
}

/** Assess an exact downloaded DMG. Never removes quarantine or disables Gatekeeper. */
export async function checkMacosRelease(artifact, { requireQuarantine = false } = {}) {
  if (process.platform !== 'darwin') throw new Error('MACOS_RELEASE_CHECK_UNSUPPORTED');
  artifact = path.resolve(artifact);
  const stat = fs.lstatSync(artifact);
  if (!stat.isFile() || stat.isSymbolicLink()) throw new Error('MACOS_DMG_NOT_REGULAR');
  const sha256 = digest(artifact);
  if (fs.readFileSync(artifact + '.sha256', 'utf8').trim() !== `${sha256}  ${path.basename(artifact)}`) throw new Error('MACOS_DMG_CHECKSUM_MISMATCH');
  if (requireQuarantine) execFileSync('/usr/bin/xattr', ['-p', 'com.apple.quarantine', artifact], { stdio: 'pipe' });
  const imageSignature = verifyCodeSignature(artifact, { diskImage: true });
  execFileSync('/usr/bin/xcrun', ['stapler', 'validate', artifact], { stdio: 'pipe' });
  execFileSync('/usr/sbin/spctl', ['--assess', '--type', 'open', '--context', 'context:primary-signature', artifact], { stdio: 'pipe' });
  const receipt = JSON.parse(fs.readFileSync(artifact + '.notarization.json', 'utf8'));
  if (receipt.status !== 'Accepted' || receipt.finalSha256 !== sha256 || !/^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i.test(receipt.submissionId ?? '')) throw new Error('MACOS_NOTARIZATION_RECEIPT_MISMATCH');
  const temporary = path.join(root, '.runtime/tmp'); fs.mkdirSync(temporary, { recursive: true });
  const scratch = fs.mkdtempSync(path.join(temporary, 'macos-release-check-'));
  const mount = path.join(scratch, 'mounted'); fs.mkdirSync(mount);
  let mounted = false, preserveScratch = false;
  try {
    execFileSync('/usr/bin/hdiutil', ['attach', '-readonly', '-nobrowse', '-mountpoint', mount, artifact], { stdio: 'pipe' }); mounted = true;
    const names = fs.readdirSync(mount).filter(name => /^grotesqueries-\d+\.\d+\.\d+(?:-[a-zA-Z0-9.-]+)?-darwin-(arm64|x64)$/.test(name));
    if (names.length !== 1) throw new Error('MACOS_DMG_PAYLOAD_MISMATCH');
    const payload = path.join(mount, names[0]);
    const signed = verifySignedPayload(payload);
    if (signed.teamIdentifier !== imageSignature.teamIdentifier) throw new Error('MACOS_DEVELOPER_ID_MISMATCH');
    const native = signed.metadata.signedNativeTests;
    if (receipt.sourceRevision !== signed.metadata.sourceRevision || receipt.architecture !== process.arch ||
      receipt.signingTeamIdentifier !== signed.teamIdentifier || receipt.minimumMacOS !== signed.metadata.minimumMacOS ||
      !Number.isSafeInteger(native?.tests) || native.tests <= 0 || native.passed !== native.tests ||
      JSON.stringify(receipt.signedNativeTests) !== JSON.stringify(native)) throw new Error('MACOS_NOTARIZATION_RECEIPT_MISMATCH');
    const copied = path.join(scratch, names[0]);
    execFileSync('/usr/bin/ditto', ['--rsrc', '--extattr', payload, copied], { stdio: 'pipe' });
    execFileSync('/usr/sbin/spctl', ['--assess', '--type', 'execute', path.join(copied, 'bin/node')], { stdio: 'pipe' });
    if (!Number.isSafeInteger(receipt.signedPackageChecks) || receipt.signedPackageChecks <= 0 ||
      signed.metadata.signedPackageChecks !== receipt.signedPackageChecks) throw new Error('MACOS_SIGNED_RUNTIME_PROOF_MISMATCH');
    let consumer;
    try {
      // Execute the copied payload directly. Re-archiving here would discard the download's quarantine metadata.
      consumer = JSON.parse(execFileSync(path.join(copied, 'bin/node'), [path.join(root, 'bin/consumer-smoke.mjs'), copied, '--disposable'], {
        cwd: scratch, env: { ...process.env, PATH: '/usr/bin:/bin', NODE_OPTIONS: '', NODE_PATH: '' },
        encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], timeout: 180000, maxBuffer: 4 * 1024 * 1024,
      }));
    } catch {
      preserveScratch = true;
      throw new Error('MACOS_CONSUMER_CHECK_FAILED: Retained owned fixture for cleanup inspection at ' + scratch);
    }
    if (consumer.consumerChecked !== true || consumer.sourceRevision !== receipt.sourceRevision || consumer.signing !== 'developer-id') throw new Error('MACOS_SIGNED_RUNTIME_PROOF_MISMATCH');
    const result = { artifact, sha256, architecture: process.arch, minimumMacOS: signed.metadata.minimumMacOS,
      signingTeamIdentifier: signed.teamIdentifier, notarization: 'Accepted', stapled: true,
      quarantineVerified: requireQuarantine, runtimeVerified: true, consumerChecks: consumer.checks };
    console.log(JSON.stringify({ macosReleaseChecked: true, ...result })); return result;
  } finally {
    if (mounted) execFileSync('/usr/bin/hdiutil', ['detach', mount], { stdio: 'pipe' });
    if (!preserveScratch) fs.rmSync(scratch, { recursive: true, force: true });
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const args = process.argv.slice(2); const quarantine = args.includes('--require-quarantine');
  const files = args.filter(argument => argument !== '--require-quarantine');
  if (files.length !== 1) throw new Error('Usage: check-macos-release.mjs <artifact.dmg> [--require-quarantine]');
  await checkMacosRelease(files[0], { requireQuarantine: quarantine });
}
