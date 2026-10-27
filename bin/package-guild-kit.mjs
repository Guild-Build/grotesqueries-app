import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { ARCHIVE_LIMITS, portableName, readZip, readTarGzip, writeZip, writeTarGzip } from './guild-kit-archive.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const IDS = ['lean-start', 'measured-delivery', 'measured-writing-desk', 'evidence-first-review', 'trial-runner'];
const HEX = /^[a-f0-9]{64}$/, REVISION = /^[a-f0-9]{40}$/, VERSION = /^\d+\.\d+\.\d+(?:-[A-Za-z0-9.-]+)?$/;
export const digest = bytes => crypto.createHash('sha256').update(bytes).digest('hex');
const fail = message => { throw new Error('GUILD_KIT_INVALID: ' + message); };
const json = value => Buffer.from(JSON.stringify(value, null, 2) + '\n');
function object(value, keys, label) {
  if (!value || typeof value !== 'object' || Array.isArray(value) || Object.keys(value).length !== keys.length || keys.some(key => !Object.hasOwn(value, key))) fail(label);
}
function same(left, right) { return JSON.stringify(left) === JSON.stringify(right); }
function parseJson(bytes, label) {
  if (bytes.length > 1024 * 1024) fail(label + ' size');
  try { return JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes)); } catch { fail(label + ' JSON'); }
}
function regularInput(file, maximum = ARCHIVE_LIMITS.archive) {
  const stat = fs.lstatSync(file);
  if (!stat.isFile() || stat.isSymbolicLink() || stat.size > maximum) fail('regular bounded input required');
  return fs.readFileSync(file);
}
export function validateCatalog(value) {
  object(value, ['schemaVersion', 'catalogRevision', 'builds'], 'catalog fields');
  if (value.schemaVersion !== 1 || !REVISION.test(value.catalogRevision) || !Array.isArray(value.builds) || value.builds.length !== IDS.length) fail('catalog identity');
  const found = new Set();
  for (const build of value.builds) {
    object(build, ['slug', 'name', 'version', 'target', 'modules', 'requiresBash', 'archive', 'files'], 'build fields');
    if (!IDS.includes(build.slug) || found.has(build.slug) || typeof build.name !== 'string' || !build.name.trim() || build.name.length > 128 ||
      !VERSION.test(build.version) || build.target !== 'claude-code' || typeof build.requiresBash !== 'boolean') fail('build identity');
    found.add(build.slug);
    if (!Array.isArray(build.modules) || !build.modules.length || build.modules.length > 64 || new Set(build.modules).size !== build.modules.length ||
      build.modules.some(module => typeof module !== 'string' || !/^(?:skill|agent|hook|mcp|playbook|tool)\/[a-z0-9]+(?:-[a-z0-9]+)*$/.test(module))) fail('build modules');
    if (build.requiresBash !== build.modules.some(module => module.startsWith('hook/'))) fail('build prerequisites');
    object(build.archive, ['url', 'sha256', 'bytes'], 'bundle archive fields');
    if (build.archive.url !== `https://buildguild.gg/dl/${build.slug}-${build.version}.zip` || !HEX.test(build.archive.sha256) ||
      !Number.isSafeInteger(build.archive.bytes) || build.archive.bytes < 22 || build.archive.bytes > 4 * 1024 * 1024) fail('bundle archive identity');
    if (!Array.isArray(build.files) || build.files.length < 4 || build.files.length > 256) fail('bundle file inventory');
    const files = new Set();
    for (const file of build.files) {
      object(file, ['path', 'sha256', 'mode'], 'bundle file fields');
      portableName(file.path);
      if (file.path.endsWith('/') || files.has(file.path.toLowerCase()) || !HEX.test(file.sha256) || ![0o644, 0o755].includes(file.mode)) fail('bundle file identity');
      files.add(file.path.toLowerCase());
    }
  }
  return value;
}
export function loadCatalog(file = path.join(root, 'config/guild-builds.json')) {
  return validateCatalog(parseJson(regularInput(file, 65536), 'catalog'));
}
function rooted(entries, folder) {
  for (const entry of entries) {
    const name = entry.name.replace(/\/$/, '');
    if (name !== folder && !name.startsWith(folder + '/')) fail('single contained archive root required');
  }
  return entries.filter(entry => !entry.directory).map(entry => ({ ...entry, name: entry.name.slice(folder.length + 1) }));
}
function verifyChecksums(entries) {
  const files = new Map(entries.map(entry => [entry.name, entry]));
  const sums = files.get('SHA256SUMS');
  if (!sums) fail('runtime SHA256SUMS missing');
  const source = sums.data.toString('utf8');
  if (!source.endsWith('\n') || source.includes('\r')) fail('runtime checksum format');
  const seen = new Set();
  for (const line of source.trimEnd().split('\n')) {
    const match = /^([a-f0-9]{64})  ([A-Za-z0-9._/-]+)$/.exec(line);
    if (!match || match[2] === 'SHA256SUMS') fail('runtime checksum format');
    portableName(match[2]);
    if (seen.has(match[2]) || !files.has(match[2]) || digest(files.get(match[2]).data) !== match[1]) fail('runtime checksum mismatch');
    seen.add(match[2]);
  }
  if (seen.size !== files.size - 1 || [...files.keys()].some(name => name !== 'SHA256SUMS' && !seen.has(name))) fail('runtime checksum inventory');
}
export function inspectRuntimeArchive(file) {
  const bytes = regularInput(file); const sha256 = digest(bytes);
  const sidecar = regularInput(file + '.sha256', 1024).toString('utf8');
  if (sidecar !== `${sha256}  ${path.basename(file)}\n`) fail('runtime archive checksum');
  const entries = file.endsWith('.tar.gz') ? readTarGzip(bytes) : file.endsWith('.zip') ? readZip(bytes) : fail('runtime archive extension');
  const folder = entries[0].name.split('/')[0];
  const files = rooted(entries, folder); verifyChecksums(files);
  const metadataFile = files.find(entry => entry.name === 'BUILD-METADATA.json');
  if (!metadataFile) fail('runtime build metadata missing');
  const metadata = parseJson(metadataFile.data, 'runtime metadata');
  if (metadata.guildBuildPresetVersion !== 1 || metadata.sourceDirty !== false || !VERSION.test(metadata.version) || !REVISION.test(metadata.sourceRevision) ||
    !['linux', 'win32'].includes(metadata.platform) || !['arm64', 'x64'].includes(metadata.architecture) ||
    (metadata.platform === 'win32' && metadata.architecture !== 'x64') ||
    folder !== `grotesqueries-${metadata.version}-${metadata.platform}-${metadata.architecture}` ||
    (metadata.platform === 'linux') !== file.endsWith('.tar.gz')) fail('runtime provenance or target');
  if (!files.some(entry => entry.name === (metadata.platform === 'win32' ? 'grotesqueries.exe' : 'grotesqueries'))) fail('runtime launcher missing');
  if (!files.some(entry => entry.name === 'LICENSE') || !files.some(entry => entry.name === 'THIRD_PARTY_NOTICES.md')) fail('runtime notices missing');
  if (metadata.platform === 'linux' && !(files.find(entry => entry.name === 'grotesqueries').mode & 0o111)) fail('runtime launcher mode');
  if (files.some(entry => /^(?:GUILD-BUILD\.json|KIT-SHA256SUMS|README-GUILD-BUILD\.txt|guild-builds(?:\/|$)|workspace(?:\/|$)|\.runtime(?:\/|$))/.test(entry.name))) fail('runtime is already configured');
  return { bytes, sha256, entries, files, folder, metadata };
}
export function inspectBundleArchive(bytes, build) {
  if (bytes.length !== build.archive.bytes || digest(bytes) !== build.archive.sha256) fail('bundle archive checksum');
  const files = rooted(readZip(bytes), build.slug);
  if (files.length > 256 || files.reduce((sum, file) => sum + file.data.length, 0) > 4 * 1024 * 1024) fail('bundle content bound');
  const byName = new Map(files.map(file => [file.name, file]));
  if (files.length !== build.files.length || build.files.some(expected => !byName.has(expected.path) ||
    digest(byName.get(expected.path).data) !== expected.sha256 || byName.get(expected.path).mode !== expected.mode)) fail('bundle file pins differ');
  for (const name of ['buildguild.json', '.claude-plugin/plugin.json', 'LICENSE', 'README.md']) if (!byName.has(name)) fail('bundle identity file missing');
  const manifest = parseJson(byName.get('buildguild.json').data, 'build manifest');
  const plugin = parseJson(byName.get('.claude-plugin/plugin.json').data, 'Claude plugin manifest');
  if (manifest.schema !== 'buildguild.build.v1' || manifest.slug !== build.slug || manifest.name !== build.name || manifest.version !== build.version || manifest.license !== 'Apache-2.0' ||
    !same(manifest.branches, ['claude-code']) || !same(manifest.modules, build.modules) || plugin.name !== build.slug || plugin.version !== build.version || plugin.license !== 'Apache-2.0') fail('bundle manifest identity');
  if (build.requiresBash !== files.some(file => file.name === 'hooks/hooks.json')) fail('bundle hook declaration');
  return files;
}
const transientDownloadCodes = new Set(['ECONNRESET', 'ECONNREFUSED', 'ECONNABORTED', 'ETIMEDOUT', 'EAI_AGAIN', 'ENOTFOUND',
  'ENETUNREACH', 'EHOSTUNREACH', 'ENETDOWN', 'EPIPE', 'UND_ERR_CONNECT_TIMEOUT', 'UND_ERR_HEADERS_TIMEOUT', 'UND_ERR_BODY_TIMEOUT', 'UND_ERR_SOCKET']);
class BundleDownloadRejection extends Error {}
const rejectDownload = message => { throw new BundleDownloadRejection('GUILD_KIT_INVALID: bundle download ' + message); };
function transientDownloadFailure(error, signal) {
  if (signal.aborted && signal.reason?.name === 'TimeoutError') return 'TIMEOUT';
  for (const candidate of [error, error?.cause, error?.cause?.cause]) {
    if (candidate?.name === 'TimeoutError') return 'TIMEOUT';
    if (transientDownloadCodes.has(candidate?.code)) return candidate.code;
  }
}
/** Retry transport failures only; pinned response identity and contents never receive a retry. */
export async function fetchBundle(build, { request = globalThis.fetch,
  pause = milliseconds => new Promise(resolve => setTimeout(resolve, milliseconds)) } = {}) {
  for (let attempt = 1; attempt <= 3; attempt++) {
    const signal = AbortSignal.timeout(30000); let stage = 'request';
    try {
      const response = await request(build.archive.url, { redirect: 'error', headers: { 'User-Agent': 'Grotesqueries-release-verification/0.1' }, signal });
      if (!response.ok || response.url !== build.archive.url) {
        try { await response.body?.cancel?.(); } catch { /* The response rejection remains authoritative. */ }
        if (response.url !== build.archive.url) rejectDownload('response URL differs from the pinned URL');
        rejectDownload('HTTP response ' + (Number.isInteger(response.status) && response.status >= 0 && response.status <= 599 ? response.status : 'invalid'));
      }
      stage = 'body';
      const chunks = []; let size = 0;
      for await (const chunk of response.body) {
        if ((size += chunk.length) > build.archive.bytes) rejectDownload('size exceeds pinned byte count');
        chunks.push(chunk);
      }
      if (size !== build.archive.bytes) rejectDownload('size differs from pinned byte count');
      const bytes = Buffer.concat(chunks);
      if (digest(bytes) !== build.archive.sha256) rejectDownload('checksum differs from the pinned SHA-256');
      return bytes;
    } catch (error) {
      if (error instanceof BundleDownloadRejection) throw error;
      const transient = transientDownloadFailure(error, signal);
      if (!transient || attempt === 3) rejectDownload(`${stage} failed (${transient ?? 'non-retryable transport'}; attempts ${attempt}/3)`);
      await pause(attempt * 500);
    }
  }
}
function safeOutputDirectory(directory) {
  const parsed = path.parse(directory); let current = parsed.root;
  for (const segment of directory.slice(parsed.root.length).split(path.sep).filter(Boolean)) {
    current = path.join(current, segment);
    if (fs.existsSync(current)) {
      const stat = fs.lstatSync(current);
      if (!stat.isDirectory() || stat.isSymbolicLink()) fail('output directory contains a link or non-directory');
    } else fs.mkdirSync(current);
  }
}
function publish(outputs) {
  for (const [file, bytes] of outputs) {
    if (!fs.existsSync(file)) continue;
    if (!regularInput(file).equals(bytes)) fail('existing output differs: ' + path.basename(file));
  }
  for (const [file, bytes] of outputs) {
    if (fs.existsSync(file)) continue;
    const temporary = path.join(path.dirname(file), '.guild-kit-' + crypto.randomUUID() + '.tmp');
    try { fs.writeFileSync(temporary, bytes, { flag: 'wx', mode: 0o644 }); fs.linkSync(temporary, file); }
    finally { if (fs.existsSync(temporary)) fs.unlinkSync(temporary); }
  }
}

/** Assemble one immutable platform runtime with one pinned first-party Claude Code build. */
export async function packageGuildKit({ runtimeArchive, buildSlug, bundleArchive,
  outputDirectory = path.join(root, 'dist/guild-kits') }, catalog = loadCatalog()) {
  if (process.version !== 'v24.14.1') fail('assemble with Node 24.14.1');
  validateCatalog(catalog);
  const build = catalog.builds.find(build => build.slug === buildSlug);
  if (!build) fail('choose a published Guild build');
  const runtime = inspectRuntimeArchive(path.resolve(runtimeArchive));
  const bundleBytes = bundleArchive ? regularInput(path.resolve(bundleArchive), 4 * 1024 * 1024) : await fetchBundle(build);
  const bundleFiles = inspectBundleArchive(bundleBytes, build);
  const preset = { schemaVersion: 1,
    runtime: { version: runtime.metadata.version, platform: runtime.metadata.platform, architecture: runtime.metadata.architecture,
      sourceRevision: runtime.metadata.sourceRevision, archiveSha256: runtime.sha256 },
    build: { slug: build.slug, name: build.name, version: build.version, target: build.target, catalogRevision: catalog.catalogRevision,
      archiveSha256: build.archive.sha256, modules: build.modules,
      files: bundleFiles.map(file => ({ path: file.name, sha256: digest(file.data) })).sort((a, b) => a.path < b.path ? -1 : 1) } };
  const added = bundleFiles.map(file => ({ ...file, name: `${runtime.folder}/guild-builds/${build.slug}/${file.name}` }));
  added.push({ name: `${runtime.folder}/GUILD-BUILD.json`, data: json(preset), mode: 0o644, directory: false });
  added.push({ name: `${runtime.folder}/README-GUILD-BUILD.txt`, mode: 0o644, directory: false, data: Buffer.from([
    `Grotesqueries with ${build.name} v${build.version}`, '',
    'This archive includes the unchanged Grotesqueries runtime and the complete selected Guild build.',
    'The Guild build targets Claude Code. Install and authenticate your own Claude Code CLI separately.',
    ...(build.requiresBash ? ['This build includes hooks. Install Bash and Git (Git for Windows on Windows) before using this build.'] : []),
    ...(build.slug === 'evidence-first-review' ? ['The merge guard also needs jq, Python 3 or Node on its PATH. Linux can use the verified bundled Node.'] : []),
    runtime.metadata.platform === 'win32' ? 'In PowerShell, run .\\grotesqueries.exe --setup, then .\\grotesqueries.exe.' : 'Run ./grotesqueries --setup, then ./grotesqueries.',
    'Open the printed loopback URL. Review the selected build and prerequisites in the Guild Build panel.',
    'Choose its profile, select Start session, then Take control. Setup never starts a CLI or signs in for you.',
    'The selected profile uses an app-local evaluation workspace. Existing project and operator files are preserved.',
    'Qualified runtime file checksums remain in SHA256SUMS. KIT-SHA256SUMS covers the complete combined payload.',
    'Runtime qualification alone does not establish provider workflow, plugin or platform qualification for this kit.',
    `Build source: https://github.com/Guild-Build/Build/tree/${catalog.catalogRevision}/bundles/${build.slug}`,
    `Catalog and external tools: https://buildguild.gg/builds/${build.slug}/`,
    'Bundled first-party source uses Apache-2.0; all runtime and bundle third-party notices remain included.', '',
  ].join('\n')) });
  const all = [...runtime.entries, ...added];
  const checksumLines = all.filter(file => !file.directory).map(file => ({ name: file.name.slice(runtime.folder.length + 1), hash: digest(file.data) }))
    .sort((a, b) => a.name < b.name ? -1 : 1).map(file => `${file.hash}  ${file.name}\n`).join('');
  all.push({ name: `${runtime.folder}/KIT-SHA256SUMS`, data: Buffer.from(checksumLines), mode: 0o644, directory: false });
  const extension = runtime.metadata.platform === 'win32' ? '.zip' : '.tar.gz';
  const filename = `${runtime.folder}-${build.slug}-${build.version}${extension}`;
  const bytes = extension === '.zip' ? writeZip(all) : writeTarGzip(all); const sha256 = digest(bytes);
  const report = { kitAssembled: true, assemblerNode: process.version, archive: filename, sha256, bytes: bytes.length, folder: runtime.folder,
    runtime: { ...preset.runtime, archive: path.basename(runtimeArchive), filesPreserved: runtime.files.length },
    build: { slug: build.slug, name: build.name, version: build.version, target: build.target, catalogRevision: catalog.catalogRevision,
      archiveSha256: build.archive.sha256, modules: build.modules, requiresBash: build.requiresBash },
    files: all.filter(file => !file.directory).length, qualification: 'not-run-by-assembler' };
  const directory = path.resolve(outputDirectory); safeOutputDirectory(directory);
  const archive = path.join(directory, filename), checksum = archive + '.sha256', reportFile = archive + '.assembly.json';
  publish([[archive, bytes], [checksum, Buffer.from(`${sha256}  ${filename}\n`)], [reportFile, json(report)]]);
  return { ...report, archive, checksum, reportFile };
}
if (process.argv[1] && path.basename(process.argv[1]) === 'package-guild-kit.mjs' && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const args = process.argv.slice(2); const options = {};
  if (args.length < 2) throw new Error('Usage: node bin/package-guild-kit.mjs <runtime-archive> <build-slug> [--bundle <local-zip>] [--output <directory>]');
  options.runtimeArchive = args.shift(); options.buildSlug = args.shift();
  while (args.length) {
    const flag = args.shift(), value = args.shift();
    if (!value || !['--bundle', '--output'].includes(flag)) fail('command arguments');
    const key = flag === '--bundle' ? 'bundleArchive' : 'outputDirectory';
    if (Object.hasOwn(options, key)) fail('duplicate command option');
    options[key] = value;
  }
  console.log(JSON.stringify(await packageGuildKit(options)));
}
