import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import net from 'node:net';
import path from 'node:path';
import test from 'node:test';
import { decodeBootstrap, decodeGuildBuild } from '@grotesqueries/protocol';
import { loadGuildBuild, verifyGuildBuild } from '../../app/services/guild-build.js';
import { configureInstallation } from '../../app/services/setup.js';
import { loadConfig, parseConfig } from '../../config/application.js';
import { createHost } from '../../app/controllers/server.js';
import { embeddedAssets } from '../../app/helpers/assets.js';
import { resolveRuntime } from '../../app/helpers/runtime.js';
import { DiagnosticLogger } from '../../app/services/diagnostics.js';
import { HostSettings } from '../../app/services/settings.js';
import { SessionRegistry } from '../../app/models/sessions.js';
import { FakeLauncher } from '../support/helpers.js';
import { Peer } from '../support/bridge-fixture.js';
import { scratchDirectory } from '../support/scratch.js';

const sha = (value: Buffer | string) => crypto.createHash('sha256').update(value).digest('hex');
function fixture(slug = 'lean-start', modules = ['skill/context-budget']) {
  const root = scratchDirectory('guild-kit-');
  const metadata = { version: '0.1.0-alpha.2', platform: process.platform, architecture: process.arch,
    sourceRevision: 'a'.repeat(40), sourceDirty: false, guildBuildPresetVersion: 1 };
  const folder = path.join(root, 'guild-builds', slug);
  const bundle: Record<string, string> = {
    'LICENSE': 'Apache-2.0 fixture license\n',
    'buildguild.json': JSON.stringify({ schema: 'buildguild.build.v1', slug, name: 'Fixture Guild Build', version: '1.0.0',
      branches: ['claude-code'], license: 'Apache-2.0', modules }),
    '.claude-plugin/plugin.json': JSON.stringify({ name: slug, version: '1.0.0', license: 'Apache-2.0' }),
    'skills/context-budget/SKILL.md': '---\nname: context-budget\ndescription: Fixture only\n---\nCount the fixture.\n',
  };
  for (const [file, content] of Object.entries(bundle)) {
    fs.mkdirSync(path.dirname(path.join(folder, file)), { recursive: true });
    fs.writeFileSync(path.join(folder, file), content);
  }
  const preset = { schemaVersion: 1, runtime: { version: metadata.version, platform: metadata.platform,
    architecture: metadata.architecture, sourceRevision: metadata.sourceRevision, archiveSha256: 'b'.repeat(64) },
    build: { slug, name: 'Fixture Guild Build', version: '1.0.0', target: 'claude-code', catalogRevision: 'c'.repeat(40),
      archiveSha256: 'd'.repeat(64), modules, files: Object.entries(bundle).map(([file, content]) => ({ path: file, sha256: sha(content) })) } };
  const save = () => fs.writeFileSync(path.join(root, 'GUILD-BUILD.json'), JSON.stringify(preset));
  save(); fs.writeFileSync(path.join(root, 'BUILD-METADATA.json'), JSON.stringify(metadata));
  const raw = { version: 1, port: 8765, allowedProjectDirectories: ['.'], launchProfiles: [] as Array<Record<string, unknown>>,
    terminal: { scrollbackLines: 1000, recentOutputBytes: 1048576, maxIncompleteSequenceBytes: 65536 },
    diagnostics: { directory: '.runtime/logs', maxFiles: 4, maxFileBytes: 1048576 } };
  const file = path.join(root, 'grotesqueries.json');
  fs.writeFileSync(file, JSON.stringify(raw));
  const config = () => parseConfig(raw, file, root);
  const tools = path.join(root, 'tools'); fs.mkdirSync(tools);
  const tool = (name: string) => {
    const file = path.join(tools, name + (process.platform === 'win32' ? '.exe' : ''));
    fs.writeFileSync(file, '#!/bin/sh\nexit 99\n', { mode: 0o755 }); return file;
  };
  return { root, folder, preset, metadata, save, raw, file, config, tools, tool };
}

test('a kit adds a fixed Claude profile and preserves configuration, build and workspace data', () => {
  const f = fixture(); const executable = f.tool('claude');
  const before = fs.readFileSync(f.file);
  const loaded = loadGuildBuild(f.root, f.config(), { PATH: f.tools });
  assert.equal(loaded.state?.profileId, 'guild-lean-start');
  assert.deepEqual(loaded.state?.prerequisites, []);
  const profile = loaded.config.launchProfiles[0];
  assert.equal(profile.executable, executable);
  assert.deepEqual(profile.args, ['--plugin-dir', f.folder]);
  assert.equal(profile.projectDirectory, path.join(f.root, 'workspaces/guild-lean-start'));
  const personal = path.join(profile.projectDirectory, 'personal.txt'); fs.writeFileSync(personal, 'keep');
  const again = loadGuildBuild(f.root, f.config(), { PATH: f.tools });
  assert.equal(again.config.launchProfiles.length, 1);
  assert.deepEqual(fs.readFileSync(f.file), before);
  assert.equal(fs.readFileSync(personal, 'utf8'), 'keep');
  assert.equal(verifyGuildBuild(f.root)?.build.slug, 'lean-start');
});

test('missing CLI or Bash leaves ordinary profiles intact and exposes requirements', () => {
  const f = fixture('measured-delivery', ['hook/uncommitted-work-check']);
  const original = f.config();
  assert.equal(loadGuildBuild(f.root, original, { PATH: '' }).config, original);
  f.tool('claude');
  const missingBash = loadGuildBuild(f.root, original, { PATH: f.tools });
  assert.equal(missingBash.state?.profileId, null);
  assert.ok(missingBash.state?.prerequisites.some(item => item.includes('Bash hooks')));
  const bash = f.tool('bash');
  assert.equal(loadGuildBuild(f.root, original, { PATH: f.tools }).state?.profileId, null);
  f.tool('git');
  const configured = loadGuildBuild(f.root, original, { PATH: f.tools });
  assert.ok(configured.state?.profileId);
  assert.deepEqual(configured.config.launchProfiles[0].environment,
    process.platform === 'win32' ? { CLAUDE_CODE_GIT_BASH_PATH: bash, PATH: path.dirname(bash) + path.delimiter + f.tools } : {});
});

test('the review guard requires an available JSON parser as well as Bash and Git', () => {
  const f = fixture('evidence-first-review', ['hook/merge-guard']);
  for (const tool of ['claude', 'bash', 'git']) f.tool(tool);
  const missing = loadGuildBuild(f.root, f.config(), { PATH: f.tools });
  assert.equal(missing.state?.profileId, null);
  assert.ok(missing.state?.prerequisites.some(item => item.includes('JSON input')));
  f.tool('node');
  assert.ok(loadGuildBuild(f.root, f.config(), { PATH: f.tools }).state?.profileId);
});

test('a Linux review kit can use its checksum-verified bundled Node without an external parser', { skip: process.platform !== 'linux' }, () => {
  const f = fixture('evidence-first-review', ['hook/merge-guard']);
  for (const tool of ['claude', 'bash', 'git']) f.tool(tool);
  fs.mkdirSync(path.join(f.root, 'bin'));
  const node = path.join(f.root, 'bin/node'); fs.writeFileSync(node, '#!/bin/sh\nexit 99\n', { mode: 0o755 });
  fs.writeFileSync(path.join(f.root, 'BUILD-METADATA.json'), JSON.stringify({ ...f.metadata, nodeBinarySha256: sha(fs.readFileSync(node)) }));
  const loaded = loadGuildBuild(f.root, f.config(), { PATH: f.tools });
  assert.ok(loaded.state?.profileId);
  assert.equal(loaded.config.launchProfiles[0].environment.PATH, path.join(f.root, 'bin') + path.delimiter + f.tools);
  fs.appendFileSync(node, 'changed');
  assert.equal(loadGuildBuild(f.root, f.config(), { PATH: f.tools }).state?.profileId, null);
});

test('kit profiles honor existing directory authorization and cannot replace an operator profile', () => {
  const f = fixture(); f.tool('claude');
  const allowed = path.join(f.root, 'existing-project'); fs.mkdirSync(allowed);
  const denied = loadGuildBuild(f.root, { ...f.config(), allowedProjectDirectories: [allowed] }, { PATH: f.tools });
  assert.equal(denied.state?.profileId, null);
  assert.equal(fs.existsSync(path.join(f.root, 'workspaces')), false);
  const own = { id: 'guild-lean-start', label: 'Mine', executable: process.execPath, args: [], projectDirectory: allowed, environment: {} };
  const occupied = loadGuildBuild(f.root, { ...f.config(), launchProfiles: [own] }, { PATH: f.tools });
  assert.deepEqual(occupied.config.launchProfiles, [own]);
  assert.equal(occupied.state?.profileId, null);
});

test('corruption, unexpected files and changed bundle identities fail without rewriting data', () => {
  const f = fixture(); const skill = path.join(f.folder, 'skills/context-budget/SKILL.md');
  fs.appendFileSync(skill, 'modified by user');
  assert.throws(() => verifyGuildBuild(f.root), /checksum/);
  assert.ok(fs.readFileSync(skill, 'utf8').endsWith('modified by user'));
  const extra = fixture(); fs.writeFileSync(path.join(extra.folder, 'unexpected.txt'), 'extra');
  assert.throws(() => verifyGuildBuild(extra.root), /inventory/);
  const identity = fixture(); identity.preset.build.name = 'Changed'; identity.save();
  assert.throws(() => verifyGuildBuild(identity.root), /identities/);
});

test('preset records reject executable settings, traversal, duplicate paths and incompatible runtimes', () => {
  const f = fixture();
  Object.assign(f.preset.build, { executable: '/untrusted/command' }); f.save();
  assert.throws(() => verifyGuildBuild(f.root), /fields/);
  const traversal = fixture(); traversal.preset.build.files[0].path = '../outside'; traversal.save();
  assert.throws(() => verifyGuildBuild(traversal.root), /Unsafe file path/);
  const collision = fixture(); collision.preset.build.files.push({ ...collision.preset.build.files[0], path: 'license' }); collision.save();
  assert.throws(() => verifyGuildBuild(collision.root), /Duplicate/);
  const runtime = fixture(); runtime.preset.runtime.platform = process.platform === 'win32' ? 'linux' : 'win32'; runtime.save();
  assert.throws(() => verifyGuildBuild(runtime.root), /different operating system|Unsupported runtime/);
  const dirty = fixture(); fs.writeFileSync(path.join(dirty.root, 'BUILD-METADATA.json'), JSON.stringify({ ...dirty.metadata, sourceDirty: true }));
  assert.throws(() => verifyGuildBuild(dirty.root), /metadata/);
});

test('bundle and workspace junctions or links cannot redirect the kit', () => {
  const f = fixture(); const outside = scratchDirectory('guild-outside-');
  fs.renameSync(path.join(f.root, 'guild-builds'), path.join(outside, 'guild-builds'));
  fs.symlinkSync(path.join(outside, 'guild-builds'), path.join(f.root, 'guild-builds'), process.platform === 'win32' ? 'junction' : 'dir');
  assert.throws(() => verifyGuildBuild(f.root), /link|junction|escapes/);
  const workspace = fixture(); workspace.tool('claude');
  fs.symlinkSync(outside, path.join(workspace.root, 'workspaces'), process.platform === 'win32' ? 'junction' : 'dir');
  assert.throws(() => loadGuildBuild(workspace.root, workspace.config(), { PATH: workspace.tools }), /link|junction|escapes/);
});

test('build summary decoder accepts absent information and refuses URL/command injection', () => {
  assert.deepEqual(decodeGuildBuild({ guildBuild: null }), { guildBuild: null });
  const f = fixture(); const state = loadGuildBuild(f.root, f.config(), { PATH: '' }).state!;
  assert.deepEqual(decodeGuildBuild({ guildBuild: state }).guildBuild, state);
  assert.throws(() => decodeGuildBuild({ guildBuild: { ...state, url: 'https://untrusted.invalid/' } }));
  assert.throws(() => decodeGuildBuild({ guildBuild: { ...state, modules: ['../escape'] } }));
  assert.throws(() => decodeGuildBuild({ guildBuild: { ...state, profileId: 'operator-command' } }));
});

test('the authenticated build endpoint reads without starting; only explicit Start uses the selected preset', async () => {
  const f = fixture(); f.tool('claude');
  const reservation = net.createServer();
  await new Promise<void>(resolve => reservation.listen(0, '127.0.0.1', resolve));
  f.raw.port = (reservation.address() as net.AddressInfo).port;
  await new Promise<void>(resolve => reservation.close(() => resolve()));
  const loaded = loadGuildBuild(f.root, f.config(), { PATH: f.tools });
  const launcher = new FakeLauncher(); const sessions = new SessionRegistry({ config: loaded.config, launcher });
  const hostInstanceId = crypto.randomUUID(); const token = crypto.randomBytes(32).toString('base64url');
  const host = createHost({ config: loaded.config, runtime: resolveRuntime({ executable: path.join(f.root, 'grotesqueries.exe') }),
    sessions, hostInstanceId, token, guildBuild: loaded.state,
    assets: embeddedAssets({ 'index.html': Buffer.from('fixture'), 'assets/app.js': Buffer.from(''), 'assets/app.css': Buffer.from('') }),
    diagnostics: new DiagnosticLogger(f.root, loaded.config.diagnostics) });
  await host.listen(); let peer: Peer | undefined;
  try {
    const url = host.origin + '/api/guild-build';
    assert.equal((await fetch(url)).status, 403);
    const headers = { 'x-automata-token': token };
    assert.equal((await fetch(url, { method: 'POST', headers })).status, 405);
    assert.deepEqual(decodeGuildBuild(await fetch(url, { headers }).then(response => response.json())).guildBuild, loaded.state);
    const bootstrap = decodeBootstrap(await fetch(host.origin + '/api/bootstrap').then(response => response.json()));
    assert.equal(Object.hasOwn(bootstrap, 'guildBuild'), false);
    assert.equal(bootstrap.sessions.length, 0); assert.equal(launcher.handles.length, 0);
    peer = await Peer.open(host.origin, token, hostInstanceId, false);
    assert.equal(launcher.handles.length, 0);
    peer.request('start', { profileId: loaded.state!.profileId, cols: 80, rows: 24 });
    await peer.wait(message => message.type === 'start-result');
    assert.equal(launcher.handles.length, 1);
    assert.deepEqual(launcher.profiles[0].args, ['--plugin-dir', f.folder]);
  } finally { await peer?.close(); await host.close(); }
});

test('BOM configuration loads and its Settings revision remains bound to the original bytes', () => {
  const f = fixture(); const text = '\uFEFF' + JSON.stringify(f.raw);
  fs.writeFileSync(f.file, text);
  assert.equal(loadConfig(f.file, f.root).port, f.raw.port);
  const settings = new HostSettings(f.file, f.root, f.raw.port);
  assert.equal(settings.get().revision, sha(text));
  assert.equal(fs.readFileSync(f.file, 'utf8'), text);
});

test('failed Guild preparation preserves saved bytes and active settings; the same edit succeeds after repair', async () => {
  const f = fixture(); const executable = f.tool('claude');
  f.raw.launchProfiles.push({ id: 'claude', label: 'Existing CLI', executable, args: ['--fixture-ineligible'], projectDirectory: '.', environment: {} });
  const reservation = net.createServer();
  await new Promise<void>(resolve => reservation.listen(0, '127.0.0.1', resolve));
  f.raw.port = (reservation.address() as net.AddressInfo).port;
  await new Promise<void>(resolve => reservation.close(() => resolve()));
  const original = '\uFEFF' + JSON.stringify(f.raw, null, 3) + '\n'; fs.writeFileSync(f.file, original);
  const loaded = loadGuildBuild(f.root, f.config(), { PATH: '' });
  assert.equal(loaded.state?.profileId, null);
  const workspace = path.join(f.root, 'workspaces/guild-lean-start');
  fs.mkdirSync(path.dirname(workspace)); fs.writeFileSync(workspace, 'operator fixture file');
  const settings = new HostSettings(f.file, f.root, f.raw.port);
  const launcher = new FakeLauncher(); const sessions = new SessionRegistry({ config: loaded.config, launcher });
  const hostInstanceId = crypto.randomUUID(); const token = crypto.randomBytes(32).toString('base64url');
  const host = createHost({ config: loaded.config, runtime: resolveRuntime({ executable: path.join(f.root, 'grotesqueries.exe') }),
    sessions, hostInstanceId, token, guildBuild: loaded.state, settings,
    assets: embeddedAssets({ 'index.html': Buffer.from('fixture'), 'assets/app.js': Buffer.from(''), 'assets/app.css': Buffer.from('') }),
    diagnostics: new DiagnosticLogger(f.root, loaded.config.diagnostics) });
  await host.listen();
  try {
    const document = settings.get(); const edit = structuredClone(document.settings);
    edit.scrollbackLines = 4321; edit.profiles[0].args = []; edit.profiles[0].label = 'Updated CLI';
    const headers = { 'x-automata-token': token, origin: host.origin, 'content-type': 'application/json' };
    const body = JSON.stringify({ revision: document.revision, settings: edit });
    const failed = await fetch(host.origin + '/api/settings', { method: 'PUT', headers, body });
    assert.equal(failed.status, 400);
    assert.match((await failed.json() as { error: string }).error, /EEXIST|ENOTDIR|already exists|not a directory/);
    assert.equal(fs.readFileSync(f.file, 'utf8'), original);
    assert.equal(settings.get().revision, document.revision);
    assert.equal(fs.readFileSync(workspace, 'utf8'), 'operator fixture file');
    const unchanged = decodeBootstrap(await fetch(host.origin + '/api/bootstrap').then(response => response.json()));
    assert.equal(unchanged.limits.terminal.scrollbackLines, f.raw.terminal.scrollbackLines);
    assert.equal(unchanged.profiles[0].label, 'Existing CLI');
    assert.equal(unchanged.profiles.some(profile => profile.id === 'guild-lean-start'), false);
    assert.deepEqual(decodeGuildBuild(await fetch(host.origin + '/api/guild-build', { headers }).then(response => response.json())).guildBuild, loaded.state);
    assert.equal(launcher.handles.length, 0);
    fs.unlinkSync(workspace); // Exact collision file created by this test; customer files are never removed.
    const saved = await fetch(host.origin + '/api/settings', { method: 'PUT', headers, body });
    assert.equal(saved.status, 200);
    assert.equal(settings.get().settings.scrollbackLines, 4321);
    const changed = decodeBootstrap(await fetch(host.origin + '/api/bootstrap').then(response => response.json()));
    assert.equal(changed.limits.terminal.scrollbackLines, 4321);
    assert.equal(changed.profiles.some(profile => profile.id === 'guild-lean-start'), true);
    assert.equal(launcher.handles.length, 0);
  } finally { await host.close(); }
});

test('settings preparation retains the final revision conflict check and preserves concurrent editor bytes', () => {
  const f = fixture(); const settings = new HostSettings(f.file, f.root, f.raw.port);
  const document = settings.get(); const edit = structuredClone(document.settings); edit.scrollbackLines = 4321;
  const external = JSON.stringify({ ...f.raw, port: 9002 }) + '\n';
  assert.throws(() => settings.save({ revision: document.revision, settings: edit }, candidate => {
    fs.writeFileSync(f.file, external); // Simulate an independent editor during synchronous preparation.
    return candidate;
  }), /SETTINGS_CONFLICT/);
  assert.equal(fs.readFileSync(f.file, 'utf8'), external);
  assert.equal(fs.readdirSync(f.root).some(name => name.startsWith('.settings-')), false);
});

for (const nativeCount of [1, 63]) {
  test(`settings save retains native plugin ownership and the complete profile limit (${nativeCount} native profiles)`, async () => {
    const f = fixture(); const executable = f.tool('claude');
    f.raw.launchProfiles.push({ id: 'claude', label: 'Claude Code', executable, args: [], projectDirectory: '.', environment: {} });
    const reservation = net.createServer();
    await new Promise<void>(resolve => reservation.listen(0, '127.0.0.1', resolve));
    f.raw.port = (reservation.address() as net.AddressInfo).port;
    await new Promise<void>(resolve => reservation.close(() => resolve()));
    fs.writeFileSync(f.file, JSON.stringify(f.raw));
    const operator = f.config();
    const native = Array.from({ length: nativeCount }, (_, index) => ({
      id: nativeCount === 1 ? 'guild-lean-start' : 'native-' + index, label: 'Native plugin ' + index,
      executable, args: ['--native-fixture', String(index)], projectDirectory: f.root, environment: {},
    }));
    const loaded = loadGuildBuild(f.root, { ...operator, launchProfiles: [...operator.launchProfiles, ...native] }, { PATH: f.tools });
    assert.equal(loaded.state?.profileId, null);
    const launcher = new FakeLauncher(); const sessions = new SessionRegistry({ config: loaded.config, launcher });
    const hostInstanceId = crypto.randomUUID(); const token = crypto.randomBytes(32).toString('base64url');
    const settings = new HostSettings(f.file, f.root, f.raw.port);
    const host = createHost({ config: loaded.config, runtime: resolveRuntime({ executable: path.join(f.root, 'grotesqueries.exe') }),
      sessions, hostInstanceId, token, guildBuild: loaded.state, settings,
      plugins: { summaries: [{ name: 'native-fixture', contract: 1, panel: null, pages: [], profiles: native.map(profile => profile.id), commands: [] }],
        jobs: new Set(), folders: new Map() },
      assets: embeddedAssets({ 'index.html': Buffer.from('fixture'), 'assets/app.js': Buffer.from(''), 'assets/app.css': Buffer.from('') }),
      diagnostics: new DiagnosticLogger(f.root, loaded.config.diagnostics) });
    await host.listen(); let peer: Peer | undefined;
    try {
      const document = settings.get();
      const headers = { 'x-automata-token': token, origin: host.origin, 'content-type': 'application/json' };
      const saved = await fetch(host.origin + '/api/settings', { method: 'PUT', headers,
        body: JSON.stringify({ revision: document.revision, settings: document.settings }) });
      assert.equal(saved.status, 200);
      const bootstrap = decodeBootstrap(await fetch(host.origin + '/api/bootstrap').then(response => response.json()));
      assert.equal(bootstrap.profiles.length, 1 + nativeCount);
      assert.equal(new Set(bootstrap.profiles.map(profile => profile.id)).size, bootstrap.profiles.length);
      assert.equal(bootstrap.profiles.filter(profile => profile.id === 'guild-lean-start').length, nativeCount === 1 ? 1 : 0);
      assert.deepEqual(decodeGuildBuild(await fetch(host.origin + '/api/guild-build', { headers }).then(response => response.json())).guildBuild, loaded.state);
      assert.equal(JSON.parse(fs.readFileSync(f.file, 'utf8')).launchProfiles.length, 1);
      assert.equal(launcher.handles.length, 0);
      // An independent operator edit must not introduce duplicate IDs or overflow
      // when the running host retains native profiles from its startup snapshot.
      const external = JSON.parse(fs.readFileSync(f.file, 'utf8'));
      external.launchProfiles.push({ ...native[0], id: nativeCount === 1 ? native[0].id : 'extra-core' });
      const externalBytes = JSON.stringify(external) + '\n'; fs.writeFileSync(f.file, externalBytes);
      const externalDocument = settings.get();
      const refused = await fetch(host.origin + '/api/settings', { method: 'PUT', headers,
        body: JSON.stringify({ revision: externalDocument.revision, settings: externalDocument.settings }) });
      assert.equal(refused.status, 400);
      assert.match((await refused.json() as { error: string }).error, /profiles conflict|64 profiles/);
      assert.equal(fs.readFileSync(f.file, 'utf8'), externalBytes);
      const active = decodeBootstrap(await fetch(host.origin + '/api/bootstrap').then(response => response.json()));
      assert.equal(active.profiles.length, 1 + nativeCount);
      assert.equal(new Set(active.profiles.map(profile => profile.id)).size, active.profiles.length);
      if (nativeCount === 1) {
        peer = await Peer.open(host.origin, token, hostInstanceId, false);
        peer.request('start', { profileId: 'guild-lean-start', cols: 80, rows: 24 });
        await peer.wait(message => message.type === 'start-result');
        assert.deepEqual(launcher.profiles[0].args, native[0].args);
      }
    } finally { await peer?.close(); await host.close(); }
  });
}

test('Windows setup preserves operator profiles and allowlists while discovering missing defaults', { skip: process.platform !== 'win32' }, () => {
  const root = scratchDirectory('windows-setup-preserve-'); fs.writeFileSync(path.join(root, 'grotesqueries.exe'), 'fixture');
  const project = path.join(root, 'project'); fs.mkdirSync(project);
  const executable = path.join(process.env.SystemRoot ?? 'C:/Windows', 'System32/WindowsPowerShell/v1.0/powershell.exe');
  const file = path.join(root, 'grotesqueries.json');
  const raw = { version: 1, port: 9001, allowedProjectDirectories: ['.'],
    launchProfiles: [{ id: 'powershell', label: 'My shell', executable, args: ['-NoLogo'], projectDirectory: './project', environment: { KEEP: 'value' } }],
    terminal: { scrollbackLines: 2345, recentOutputBytes: 1048576 }, diagnostics: { directory: '.runtime/logs', maxFiles: 2, maxFileBytes: 1048576 } };
  fs.writeFileSync(file, JSON.stringify(raw));
  configureInstallation(root, { SystemRoot: process.env.SystemRoot });
  const result = JSON.parse(fs.readFileSync(file, 'utf8'));
  assert.deepEqual(result.launchProfiles.find((profile: { id: string }) => profile.id === 'powershell'), raw.launchProfiles[0]);
  assert.deepEqual(result.allowedProjectDirectories, raw.allowedProjectDirectories);
  assert.equal(result.port, 9001); assert.equal(result.terminal.scrollbackLines, 2345);
  const after = fs.readFileSync(file);
  configureInstallation(root, { SystemRoot: process.env.SystemRoot });
  assert.deepEqual(fs.readFileSync(file), after);
});
