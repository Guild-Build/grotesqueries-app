import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { spawnSync } from 'node:child_process';
import { gzipSync, gunzipSync } from 'node:zlib';
import { ARCHIVE_LIMITS, readZip, writeZip, readTarGzip, writeTarGzip } from '../../bin/guild-kit-archive.mjs';
import { digest, loadCatalog, packageGuildKit, inspectRuntimeArchive, inspectBundleArchive, validateCatalog, fetchBundle } from '../../bin/package-guild-kit.mjs';
import { inspectGuildKit, fixtureCLI } from '../../bin/check-guild-kit.mjs';

const bytes = value => Buffer.from(value);
const file = (name, data, mode = 0o644) => ({ name, data: Buffer.isBuffer(data) ? data : bytes(data), mode, directory: false });
async function fixture(run) {
  const temporary = path.join(process.cwd(), '.runtime/tmp'); fs.mkdirSync(temporary, { recursive: true });
  const directory = fs.mkdtempSync(path.join(temporary, 'guild-kit-package-'));
  try { await run(directory); } finally { fs.rmSync(directory, { recursive: true, force: true }); }
}
function runtime(directory, platform = 'linux', override = {}, extra = []) {
  const metadata = { version: '0.1.0-alpha.2', sourceRevision: 'a'.repeat(40), sourceDirty: false, guildBuildPresetVersion: 1,
    platform, architecture: 'x64', signing: 'unsigned', ...override };
  const folder = `grotesqueries-${metadata.version}-${metadata.platform}-${metadata.architecture}`;
  const entries = [file('BUILD-METADATA.json', JSON.stringify(metadata)), file('LICENSE', 'Apache-2.0\n'), file('THIRD_PARTY_NOTICES.md', 'Notices\n'),
    file(platform === 'win32' ? 'grotesqueries.exe' : 'grotesqueries', 'original runtime bytes\n', platform === 'linux' ? 0o755 : 0o644), ...extra];
  if (platform === 'win32') entries.push(file('grotesqueries.json', '{"version":1,"operator":"preserve me"}\n'));
  entries.push(file('SHA256SUMS', entries.map(entry => `${digest(entry.data)}  ${entry.name}\n`).join('')));
  const archiveEntries = entries.map(entry => ({ ...entry, name: folder + '/' + entry.name }));
  const archive = path.join(directory, folder + (platform === 'win32' ? '.zip' : '.tar.gz'));
  fs.writeFileSync(archive, platform === 'win32' ? writeZip(archiveEntries) : writeTarGzip(archiveEntries));
  fs.writeFileSync(archive + '.sha256', digest(fs.readFileSync(archive)) + '  ' + path.basename(archive) + '\n');
  return { archive, entries, folder };
}
function bundle(directory, slug = 'lean-start') {
  const catalog = structuredClone(loadCatalog()), build = catalog.builds.find(build => build.slug === slug);
  const manifest = { schema: 'buildguild.build.v1', slug: build.slug, name: build.name, version: build.version, license: 'Apache-2.0', branches: ['claude-code'], modules: build.modules };
  const files = [file('buildguild.json', JSON.stringify(manifest)), file('.claude-plugin/plugin.json', JSON.stringify({ name: slug, version: build.version, license: 'Apache-2.0' })),
    file('LICENSE', 'Apache-2.0\n'), file('README.md', 'Complete fixture bundle\n'), file('skills/example/SKILL.md', 'Actual fixture skill\n')];
  if (build.requiresBash) files.push(file('hooks/hooks.json', '{"hooks":{}}\n'), file('scripts/hook.sh', '#!/bin/sh\nexit 0\n', 0o755));
  const archive = path.join(directory, 'bundle.zip'), archiveBytes = writeZip(files.map(entry => ({ ...entry, name: slug + '/' + entry.name })));
  fs.writeFileSync(archive, archiveBytes); build.archive.sha256 = digest(archiveBytes); build.archive.bytes = archiveBytes.length;
  build.files = files.map(file => ({ path: file.name, sha256: digest(file.data), mode: file.mode }));
  return { archive, catalog, build, files };
}

function downloadResponse(build, data, overrides = {}) {
  return { ok: true, status: 200, url: build.archive.url,
    body: (async function* () { yield data; })(), ...overrides };
}
const networkFailure = code => new TypeError('private transport details must not be logged', {
  cause: Object.assign(new Error('private endpoint information'), { code }),
});

test('pinned bundle download retries transient network and timeout failures with fresh bounded attempts', context => fixture(async directory => {
  const selected = bundle(directory), data = fs.readFileSync(selected.archive), requests = [], waits = [], timeouts = [];
  context.mock.method(AbortSignal, 'timeout', milliseconds => { timeouts.push(milliseconds); return new AbortController().signal; });
  const result = await fetchBundle(selected.build, {
    request: async (url, options) => {
      requests.push({ url, options });
      if (requests.length === 1) throw networkFailure('ECONNRESET');
      if (requests.length === 2) throw new DOMException('private timeout diagnostics', 'TimeoutError');
      return downloadResponse(selected.build, data);
    }, pause: async milliseconds => { waits.push(milliseconds); },
  });
  assert.deepEqual(result, data); assert.equal(requests.length, 3); assert.deepEqual(waits, [500, 1000]);
  assert.deepEqual(timeouts, [30000, 30000, 30000]);
  assert.equal(new Set(requests.map(request => request.options.signal)).size, 3);
  for (const { url, options } of requests) {
    assert.equal(url, selected.build.archive.url); assert.equal(options.redirect, 'error');
    assert.equal(options.headers['User-Agent'], 'Grotesqueries-release-verification/0.1');
    assert.ok(options.signal instanceof AbortSignal);
  }
}));

test('an interrupted body retries from empty buffers and transport exhaustion reports its stage without private details', () => fixture(async directory => {
  const selected = bundle(directory), data = fs.readFileSync(selected.archive); let requests = 0; const waits = [];
  const result = await fetchBundle(selected.build, {
    request: async () => {
      requests++;
      if (requests === 1) return downloadResponse(selected.build, data, { body: (async function* () { yield data.subarray(0, 20); throw networkFailure('UND_ERR_SOCKET'); })() });
      return downloadResponse(selected.build, data);
    }, pause: async milliseconds => { waits.push(milliseconds); },
  });
  assert.deepEqual(result, data); assert.equal(requests, 2); assert.deepEqual(waits, [500]);
  for (const stage of ['request', 'body']) {
    requests = 0; waits.length = 0;
    await assert.rejects(fetchBundle(selected.build, {
      request: async () => {
        requests++;
        if (stage === 'request') throw networkFailure('ETIMEDOUT');
        return downloadResponse(selected.build, data, { body: (async function* () { throw networkFailure('UND_ERR_SOCKET'); })() });
      }, pause: async milliseconds => { waits.push(milliseconds); },
    }), error => {
      assert.match(error.message, new RegExp(`bundle download ${stage} failed.*attempts 3/3`));
      assert.ok(!error.message.includes('private')); assert.equal(error.cause, undefined); return true;
    });
    assert.equal(requests, 3); assert.deepEqual(waits, [500, 1000]);
  }
}));

test('a timed-out body retries using a new deadline even when the stream reports AbortError', context => fixture(async directory => {
  const selected = bundle(directory), data = fs.readFileSync(selected.archive), controllers = [], waits = []; let requests = 0;
  context.mock.method(AbortSignal, 'timeout', milliseconds => { assert.equal(milliseconds, 30000); const controller = new AbortController(); controllers.push(controller); return controller.signal; });
  const result = await fetchBundle(selected.build, {
    request: async () => {
      requests++;
      if (requests === 1) return downloadResponse(selected.build, data, { body: (async function* () {
        yield data.subarray(0, 20); controllers[0].abort(new DOMException('private timeout reason', 'TimeoutError'));
        throw new DOMException('private abort details', 'AbortError');
      })() });
      return downloadResponse(selected.build, data);
    }, pause: async milliseconds => { waits.push(milliseconds); },
  });
  assert.deepEqual(result, data); assert.equal(requests, 2); assert.deepEqual(waits, [500]);
  assert.equal(controllers[0].signal.aborted, true); assert.equal(controllers[1].signal.aborted, false);
}));

test('bundle download never retries HTTP rejection, redirects, invalid URLs, certificate failures or corrupt contents', () => fixture(async directory => {
  const selected = bundle(directory), data = fs.readFileSync(selected.archive), corrupt = Buffer.from(data); corrupt[corrupt.length - 1] ^= 1;
  const cases = [
    ...[401, 403, 404, 429, 503].map(status => ({ label: 'HTTP ' + status, request: async () => downloadResponse(selected.build, data, { ok: false, status }), expected: /bundle download HTTP response/ })),
    { label: 'HTTP refusal with socket failure during cancellation', request: async () => downloadResponse(selected.build, data, { ok: false, status: 403,
      body: { cancel: async () => { throw networkFailure('UND_ERR_SOCKET'); } } }), expected: /bundle download HTTP response 403/ },
    { label: 'redirect response', request: async () => downloadResponse(selected.build, data, { url: 'https://example.invalid/private-location' }), expected: /bundle download response URL differs/ },
    { label: 'redirect rejection', request: async () => { throw new TypeError('fetch failed', { cause: new Error('unexpected redirect with private location') }); }, expected: /non-retryable transport.*attempts 1\/3/ },
    { label: 'invalid URL', request: async () => { throw networkFailure('ERR_INVALID_URL'); }, expected: /non-retryable transport.*attempts 1\/3/ },
    { label: 'certificate error', request: async () => { throw networkFailure('CERT_HAS_EXPIRED'); }, expected: /non-retryable transport.*attempts 1\/3/ },
    { label: 'oversize', request: async () => downloadResponse(selected.build, Buffer.concat([data, bytes('x')])), expected: /bundle download size exceeds/ },
    { label: 'short content', request: async () => downloadResponse(selected.build, data.subarray(0, -1)), expected: /bundle download size differs/ },
    { label: 'checksum mismatch', request: async () => downloadResponse(selected.build, corrupt), expected: /bundle download checksum differs/ },
  ];
  for (const item of cases) {
    let requests = 0, waits = 0;
    await assert.rejects(fetchBundle(selected.build, { request: async (...args) => { requests++; return item.request(...args); },
      pause: async () => { waits++; } }), item.expected, item.label);
    assert.equal(requests, 1, item.label); assert.equal(waits, 0, item.label);
  }
}));

test('assembly does not retry invalid archive contents that match their declared download checksum', context => fixture(async directory => {
  const source = runtime(directory), selected = bundle(directory), data = Buffer.alloc(32, 65); let requests = 0;
  selected.build.archive.bytes = data.length; selected.build.archive.sha256 = digest(data);
  context.mock.method(globalThis, 'fetch', async () => { requests++; return downloadResponse(selected.build, data); });
  await assert.rejects(packageGuildKit({ runtimeArchive: source.archive, buildSlug: 'lean-start', outputDirectory: path.join(directory, 'output') }, selected.catalog), /KIT_ARCHIVE_INVALID/);
  assert.equal(requests, 1); assert.equal(fs.existsSync(path.join(directory, 'output')), false);
}));

test('generated POSIX CLI fixture records real lines and acknowledges input with spaced Unicode paths', { skip: process.platform === 'win32' }, () => fixture(directory => {
  assert.equal(process.version, 'v24.14.1');
  const folder = path.join(directory, 'package with spaces 世界'), tools = path.join(directory, 'tools with spaces 世界');
  const workspace = path.join(directory, 'workspace with spaces 世界'), bundle = path.join(folder, 'guild build 世界');
  const recordFile = path.join(directory, 'fixture-record.txt');
  for (const target of [path.join(folder, 'bin'), tools, workspace, bundle]) fs.mkdirSync(target, { recursive: true });
  fs.symlinkSync(process.execPath, path.join(folder, 'bin/node'));
  const environment = { PATH: '/usr/bin:/bin', NODE_OPTIONS: '', NODE_PATH: '' };
  fixtureCLI(folder, tools, recordFile, environment);
  const result = spawnSync(path.join(tools, 'claude'), ['--plugin-dir', bundle], { cwd: workspace, env: environment,
    input: 'owned fixture input ✓\n', encoding: 'utf8', timeout: 10000 });
  assert.ifError(result.error); assert.equal(result.status, 0); assert.equal(result.stderr, '');
  assert.deepEqual(fs.readFileSync(recordFile, 'utf8').trimEnd().split('\n'), [workspace, '--plugin-dir', bundle]);
  assert.equal(result.stdout, 'GUILD_KIT_FIXTURE_READY\nGUILD_KIT_FIXTURE_ACK:owned fixture input ✓\n');
}));

for (const platform of ['linux', 'win32']) test(`${platform} kit preserves runtime bytes, modes and checksums and contains exactly the selected bundle`, () => fixture(async directory => {
  const source = runtime(directory, platform), selected = bundle(directory, 'measured-delivery');
  const options = { runtimeArchive: source.archive, buildSlug: selected.build.slug, bundleArchive: selected.archive, outputDirectory: path.join(directory, 'output') };
  const result = await packageGuildKit(options, selected.catalog);
  const read = platform === 'win32' ? readZip : readTarGzip;
  const archiveBytes = fs.readFileSync(result.archive), entries = read(archiveBytes);
  const byName = new Map(entries.map(entry => [entry.name.slice(source.folder.length + 1), entry]));
  for (const original of source.entries) {
    assert.deepEqual(byName.get(original.name).data, original.data, original.name);
    assert.equal(byName.get(original.name).mode, original.mode, original.name + ' permissions');
  }
  for (const original of selected.files) assert.deepEqual(byName.get(`guild-builds/${selected.build.slug}/${original.name}`).data, original.data);
  const preset = JSON.parse(byName.get('GUILD-BUILD.json').data);
  assert.deepEqual(Object.keys(preset), ['schemaVersion', 'runtime', 'build']);
  assert.equal(preset.runtime.archiveSha256, digest(fs.readFileSync(source.archive)));
  assert.equal(preset.build.archiveSha256, selected.build.archive.sha256);
  assert.equal(preset.build.catalogRevision, selected.catalog.catalogRevision);
  assert.equal(preset.build.target, 'claude-code');
  assert.deepEqual(preset.build.modules, selected.build.modules);
  assert.equal(preset.build.files.length, selected.files.length);
  assert.equal([...byName.keys()].filter(name => name.startsWith('guild-builds/')).length, selected.files.length);
  assert.equal([...byName.keys()].filter(name => name.startsWith('workspace/') || name.startsWith('.runtime/')).length, 0);
  assert.equal(fs.readFileSync(result.checksum, 'utf8'), digest(archiveBytes) + '  ' + path.basename(result.archive) + '\n');
  const kitSums = byName.get('KIT-SHA256SUMS').data.toString().trim().split('\n');
  assert.equal(kitSums.length, byName.size - 1);
  for (const line of kitSums) { const [sha, name] = line.split('  '); assert.equal(digest(byName.get(name).data), sha); }
  const report = JSON.parse(fs.readFileSync(result.reportFile));
  assert.equal(report.qualification, 'not-run-by-assembler'); assert.equal(report.runtime.filesPreserved, source.entries.length);
  assert.ok(!JSON.stringify(report).includes(directory));
  assert.deepEqual(await packageGuildKit(options, selected.catalog), result, 'repeated assembly is identical');
  assert.deepEqual(fs.readFileSync(result.archive), archiveBytes);
  const inspected = inspectGuildKit(result.archive, source.archive, selected.catalog);
  assert.equal(inspected.sha256, result.sha256); assert.equal(inspected.build.slug, selected.build.slug);
}));

test('final kit inspection refuses modified runtime bytes, changed permissions and unselected files despite a valid outer checksum', () => fixture(async directory => {
  const source = runtime(directory), selected = bundle(directory), options = { runtimeArchive: source.archive, buildSlug: 'lean-start', bundleArchive: selected.archive };
  for (const [index, mutate, error] of [
    [0, entries => entries.find(entry => entry.name.endsWith('/grotesqueries')).data = bytes('changed runtime'), /runtime files changed/],
    [1, entries => entries.find(entry => entry.name.endsWith('/grotesqueries')).mode = 0o644, /runtime files changed/],
    [2, entries => entries.push(file(source.folder + '/guild-builds/other-build/README.md', 'not selected')), /unexpected kit member/],
  ]) {
    const result = await packageGuildKit({ ...options, outputDirectory: path.join(directory, 'output-' + index) }, selected.catalog);
    const entries = readTarGzip(fs.readFileSync(result.archive)); mutate(entries); const changed = writeTarGzip(entries);
    fs.writeFileSync(result.archive, changed); fs.writeFileSync(result.checksum, `${digest(changed)}  ${path.basename(result.archive)}\n`);
    assert.throws(() => inspectGuildKit(result.archive, source.archive, selected.catalog), error);
  }
}));

test('final inspection binds receipt and files to the trusted bundle catalog, independently of self-authored receipt hashes', () => fixture(async directory => {
  const source = runtime(directory), selected = bundle(directory);
  const result = await packageGuildKit({ runtimeArchive: source.archive, buildSlug: 'lean-start', bundleArchive: selected.archive, outputDirectory: path.join(directory, 'output') }, selected.catalog);
  const entries = readTarGzip(fs.readFileSync(result.archive)), skill = entries.find(entry => entry.name.endsWith('/skills/example/SKILL.md'));
  skill.data = bytes('untrusted replacement skill');
  const receipt = entries.find(entry => entry.name.endsWith('/GUILD-BUILD.json')), value = JSON.parse(receipt.data);
  value.build.files.find(item => item.path === 'skills/example/SKILL.md').sha256 = digest(skill.data); receipt.data = bytes(JSON.stringify(value));
  const changed = writeTarGzip(entries); fs.writeFileSync(result.archive, changed); fs.writeFileSync(result.checksum, `${digest(changed)}  ${path.basename(result.archive)}\n`);
  assert.throws(() => inspectGuildKit(result.archive, source.archive, selected.catalog), /bundle differs from catalog/);
}));

test('different existing output is preserved and the assembler refuses to overwrite it', () => fixture(async directory => {
  const source = runtime(directory), selected = bundle(directory), outputDirectory = path.join(directory, 'output');
  const result = await packageGuildKit({ runtimeArchive: source.archive, buildSlug: 'lean-start', bundleArchive: selected.archive, outputDirectory }, selected.catalog);
  fs.writeFileSync(result.archive, 'operator-owned bytes');
  await assert.rejects(packageGuildKit({ runtimeArchive: source.archive, buildSlug: 'lean-start', bundleArchive: selected.archive, outputDirectory }, selected.catalog), /existing output differs/);
  assert.equal(fs.readFileSync(result.archive, 'utf8'), 'operator-owned bytes');
}));

test('runtime ingestion rejects corrupt sidecars, uncovered files, dirty source and unsupported platforms', () => fixture(directory => {
  let source = runtime(directory);
  fs.appendFileSync(source.archive, 'corruption'); assert.throws(() => inspectRuntimeArchive(source.archive), /runtime archive checksum/);
  for (const override of [{ sourceDirty: true }, { guildBuildPresetVersion: undefined }, { sourceRevision: 'not-a-revision' }, { platform: 'darwin' }]) {
    source = runtime(directory, 'linux', override); assert.throws(() => inspectRuntimeArchive(source.archive), /runtime provenance or target/);
  }
  source = runtime(directory);
  let entries = readTarGzip(fs.readFileSync(source.archive)); entries.find(entry => entry.name.endsWith('/grotesqueries')).data = bytes('tampered launcher');
  fs.writeFileSync(source.archive, writeTarGzip(entries)); fs.writeFileSync(source.archive + '.sha256', `${digest(fs.readFileSync(source.archive))}  ${path.basename(source.archive)}\n`);
  assert.throws(() => inspectRuntimeArchive(source.archive), /runtime checksum mismatch/);
  source = runtime(directory); entries = readTarGzip(fs.readFileSync(source.archive)); entries.push(file(source.folder + '/unexpected.js', 'uncovered'));
  fs.writeFileSync(source.archive, writeTarGzip(entries)); fs.writeFileSync(source.archive + '.sha256', `${digest(fs.readFileSync(source.archive))}  ${path.basename(source.archive)}\n`);
  assert.throws(() => inspectRuntimeArchive(source.archive), /runtime checksum inventory/);
}));

test('configured runtime inputs and selected bundle corruption are refused', () => fixture(async directory => {
  const source = runtime(directory, 'linux', {}, [file('GUILD-BUILD.json', '{}')]), selected = bundle(directory);
  await assert.rejects(packageGuildKit({ runtimeArchive: source.archive, buildSlug: 'lean-start', bundleArchive: selected.archive, outputDirectory: path.join(directory, 'output') }, selected.catalog), /runtime is already configured/);
  const clean = runtime(directory); fs.appendFileSync(selected.archive, 'corruption');
  await assert.rejects(packageGuildKit({ runtimeArchive: clean.archive, buildSlug: 'lean-start', bundleArchive: selected.archive }, selected.catalog), /bundle archive checksum/);
  await assert.rejects(packageGuildKit({ runtimeArchive: clean.archive, buildSlug: 'bare-runtime' }, selected.catalog), /choose a published Guild build/);
}));

test('bundle identity and module list must agree with the pinned record', () => fixture(directory => {
  const selected = bundle(directory); const entries = readZip(fs.readFileSync(selected.archive));
  const manifest = entries.find(entry => entry.name.endsWith('/buildguild.json'));
  const data = JSON.parse(manifest.data); data.modules = ['skill/not-selected']; manifest.data = bytes(JSON.stringify(data));
  const changed = writeZip(entries); selected.build.archive.sha256 = digest(changed); selected.build.archive.bytes = changed.length;
  selected.build.files = entries.map(file => ({ path: file.name.slice(selected.build.slug.length + 1), sha256: digest(file.data), mode: file.mode }));
  assert.throws(() => inspectBundleArchive(changed, selected.build), /bundle manifest identity/);
}));

test('pinned catalog excludes unknown IDs, external download URLs, duplicate records and unbounded module data', () => {
  const catalog = loadCatalog(); assert.equal(catalog.builds.length, 5);
  for (const mutate of [value => value.builds[0].slug = 'third-party', value => value.builds[0].archive.url = 'https://example.com/payload.zip',
    value => value.builds[1] = value.builds[0], value => value.builds[0].modules.push('skill/../../outside'), value => value.builds[0].environment = { TOKEN: 'x' }]) {
    const changed = structuredClone(catalog); mutate(changed); assert.throws(() => validateCatalog(changed), /GUILD_KIT_INVALID/);
  }
});

test('archive writers and readers reject unsafe, duplicate and case-colliding paths', () => {
  for (const name of ['../outside', '/absolute', 'C:/drive', 'folder\\file', 'safe/../outside', 'name.', 'NUL.txt', 'safe//file']) {
    for (const write of [writeZip, writeTarGzip]) assert.throws(() => write([file(name, 'x')]), /unsafe member name/);
  }
  for (const write of [writeZip, writeTarGzip]) {
    assert.throws(() => write([file('Root/a', 'x'), file('root/A', 'y')]), /case-colliding/);
    assert.throws(() => write([file('root', 'x'), file('root/file', 'y')]), /below a file/);
  }
});

test('ZIP ingress checks local headers, CRCs, central directory extents and nonregular file modes', () => {
  const original = writeZip([file('root/file', 'fixed payload')]);
  const central = original.indexOf(Buffer.from([0x50, 0x4b, 0x01, 0x02]));
  for (const mutate of [value => value.writeUInt32LE(1, 14), value => value.writeUInt32LE(1, central + 42),
    value => value.writeUInt32LE(0o120777 << 16 >>> 0, central + 38), value => value[value.length - 6] ^= 1,
    value => value.writeUInt32LE(ARCHIVE_LIMITS.file + 1, central + 24)]) {
    const changed = Buffer.from(original); mutate(changed); assert.throws(() => readZip(changed), /KIT_ARCHIVE_INVALID/);
  }
  const corrupt = Buffer.from(original); corrupt[30 + Buffer.byteLength('root/file')] ^= 1;
  assert.throws(() => readZip(corrupt), /ZIP content checksum|ZIP decompression/);
});

test('archive ingress independently rejects unsafe names and case collisions in otherwise valid records', () => {
  const rename = (input, index, name) => {
    const value = Buffer.from(input); let central = value.readUInt32LE(value.length - 6);
    for (let item = 0; item < index; item++) central += 46 + value.readUInt16LE(central + 28);
    const length = value.readUInt16LE(central + 28), local = value.readUInt32LE(central + 42);
    assert.equal(Buffer.byteLength(name), length); value.write(name, central + 46, length, 'ascii'); value.write(name, local + 30, length, 'ascii');
    return value;
  };
  assert.throws(() => readZip(rename(writeZip([file('root/file', 'x')]), 0, '../escape')), /unsafe member name/);
  assert.throws(() => readZip(rename(writeZip([file('root/a', 'x'), file('root/b', 'y')]), 1, 'root/A')), /case-colliding/);
  const tar = gunzipSync(writeTarGzip([file('root/file', 'x')])); tar.fill(0, 0, 100); tar.write('../escape', 0, 'ascii'); tar.fill(32, 148, 156);
  tar.write(tar.subarray(0, 512).reduce((sum, byte) => sum + byte, 0).toString(8).padStart(6, '0') + '\0 ', 148, 8, 'ascii');
  assert.throws(() => readTarGzip(gzipSync(tar)), /unsafe member name/);
});

test('TAR ingress rejects link types, damaged headers and data following its trailer', () => {
  const original = gunzipSync(writeTarGzip([file('root/file', 'x')]));
  const linked = Buffer.from(original); linked[156] = 50; linked.fill(32, 148, 156);
  linked.write(linked.subarray(0, 512).reduce((sum, byte) => sum + byte, 0).toString(8).padStart(6, '0') + '\0 ', 148, 8, 'ascii');
  assert.throws(() => readTarGzip(gzipSync(linked)), /nonregular TAR/);
  const corrupt = Buffer.from(original); corrupt[1] ^= 1; assert.throws(() => readTarGzip(gzipSync(corrupt)), /header checksum/);
  const trailing = Buffer.from(original); trailing[trailing.length - 1] = 1; assert.throws(() => readTarGzip(gzipSync(trailing)), /TAR trailer/);
});

test('output junctions or symlinks are refused without writing into the target', () => fixture(async directory => {
  const source = runtime(directory), selected = bundle(directory); const target = path.join(directory, 'target'); fs.mkdirSync(target);
  const link = path.join(directory, 'link'); fs.symlinkSync(target, link, process.platform === 'win32' ? 'junction' : 'dir');
  await assert.rejects(packageGuildKit({ runtimeArchive: source.archive, buildSlug: 'lean-start', bundleArchive: selected.archive, outputDirectory: link }, selected.catalog), /output directory contains a link/);
  assert.deepEqual(fs.readdirSync(target), []);
}));
