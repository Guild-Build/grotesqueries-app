// Qualify a disposable copy of the final combined artifact; no provider/model call is made.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import net from 'node:net';
import { once } from 'node:events';
import { spawn, spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import WebSocket from 'ws';
import catalogData from '../config/guild-builds.json' with { type: 'json' };
import { portableName, readZip, readTarGzip } from './guild-kit-archive.mjs';
import { digest, inspectRuntimeArchive, validateCatalog } from './package-guild-kit.mjs';
import { startOwnedWindowsHost } from './consumer-windows.mjs';

const catalog = validateCatalog(catalogData);
const pause = ms => new Promise(resolve => setTimeout(resolve, ms));
const fail = message => { throw new Error('GUILD_KIT_CHECK_FAILED: ' + message); };
async function bounded(operation, milliseconds, label) {
  let timer;
  try { return await Promise.race([operation, new Promise((_, reject) => { timer = setTimeout(() => reject(new Error(label)), milliseconds); })]); }
  finally { clearTimeout(timer); }
}
function exactKeys(value, fields, label) {
  if (!value || typeof value !== 'object' || Array.isArray(value) || Object.keys(value).length !== fields.length || fields.some(key => !Object.hasOwn(value, key))) fail(label);
}
function record(bytes, label) {
  if (bytes.length > 1024 * 1024) fail(label + ' too large');
  try { return JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes)); } catch { fail(label + ' JSON'); }
}
const samePath = (left, right) => {
  const normalize = value => process.platform === 'win32' ? path.resolve(value).toLowerCase() : path.resolve(value);
  return typeof left === 'string' && typeof right === 'string' && normalize(left) === normalize(right);
};
function regular(file, limit = 256 * 1024 * 1024) {
  const stat = fs.lstatSync(file);
  if (!stat.isFile() || stat.isSymbolicLink() || stat.size > limit) fail('input is not a bounded regular file');
  return fs.readFileSync(file);
}

/** Verify the combined payload against both the exact baseline and the embedded official catalog. */
export function inspectGuildKit(archive, runtimeArchive, trustedCatalog = catalog) {
  validateCatalog(trustedCatalog);
  const baseline = inspectRuntimeArchive(runtimeArchive), bytes = regular(archive), sha256 = digest(bytes);
  if (regular(archive + '.sha256', 1024).toString() !== `${sha256}  ${path.basename(archive)}\n`) fail('kit archive checksum');
  const entries = archive.endsWith('.zip') ? readZip(bytes) : archive.endsWith('.tar.gz') ? readTarGzip(bytes) : fail('kit archive extension');
  const byName = new Map(entries.map(entry => [entry.name, entry]));
  if (entries.some(entry => entry.name.replace(/\/$/, '') !== baseline.folder && !entry.name.startsWith(baseline.folder + '/'))) fail('kit root differs');
  for (const original of baseline.entries) {
    const candidate = byName.get(original.name);
    if (!candidate || candidate.directory !== original.directory || candidate.mode !== original.mode || !candidate.data.equals(original.data)) fail('runtime files changed');
  }
  const rootEntry = name => byName.get(baseline.folder + '/' + name)?.data ?? fail('missing ' + name);
  const preset = record(rootEntry('GUILD-BUILD.json'), 'preset');
  exactKeys(preset, ['schemaVersion', 'runtime', 'build'], 'preset fields');
  exactKeys(preset.runtime, ['version', 'platform', 'architecture', 'sourceRevision', 'archiveSha256'], 'runtime receipt fields');
  exactKeys(preset.build, ['slug', 'name', 'version', 'target', 'catalogRevision', 'archiveSha256', 'modules', 'files'], 'build receipt fields');
  const build = trustedCatalog.builds.find(build => build.slug === preset.build.slug);
  if (!build || preset.schemaVersion !== 1 || preset.runtime.version !== baseline.metadata.version || preset.runtime.platform !== baseline.metadata.platform ||
    preset.runtime.architecture !== baseline.metadata.architecture || preset.runtime.sourceRevision !== baseline.metadata.sourceRevision || preset.runtime.archiveSha256 !== baseline.sha256 ||
    preset.build.name !== build.name || preset.build.version !== build.version || preset.build.target !== build.target || preset.build.catalogRevision !== trustedCatalog.catalogRevision ||
    preset.build.archiveSha256 !== build.archive.sha256 || JSON.stringify(preset.build.modules) !== JSON.stringify(build.modules)) fail('preset input binding');
  if (!Array.isArray(preset.build.files) || preset.build.files.length !== build.files.length) fail('preset file count');
  const expected = new Set([...baseline.entries.map(file => file.name), ...['GUILD-BUILD.json', 'README-GUILD-BUILD.txt', 'KIT-SHA256SUMS'].map(name => baseline.folder + '/' + name)]);
  const seen = new Set();
  for (const item of preset.build.files) {
    exactKeys(item, ['path', 'sha256'], 'preset file fields'); portableName(item.path);
    if (seen.has(item.path)) fail('duplicate preset file'); seen.add(item.path);
    const pin = build.files.find(file => file.path === item.path), name = baseline.folder + '/guild-builds/' + build.slug + '/' + item.path;
    const entry = byName.get(name);
    if (!pin || item.sha256 !== pin.sha256 || !entry || entry.directory || entry.mode !== pin.mode || digest(entry.data) !== pin.sha256) fail('bundle differs from catalog');
    expected.add(name);
  }
  if (entries.some(entry => !expected.has(entry.name))) fail('unexpected kit member');
  const sums = rootEntry('KIT-SHA256SUMS').toString();
  if (!sums.endsWith('\n')) fail('kit checksum format');
  const checked = new Set();
  for (const line of sums.trimEnd().split('\n')) {
    const match = /^([a-f0-9]{64})  ([A-Za-z0-9._/-]+)$/.exec(line);
    if (!match || match[2] === 'KIT-SHA256SUMS' || checked.has(match[2])) fail('kit checksum format');
    portableName(match[2]); checked.add(match[2]);
    const entry = byName.get(baseline.folder + '/' + match[2]);
    if (!entry || entry.directory || digest(entry.data) !== match[1]) fail('kit checksum mismatch');
  }
  if (checked.size !== entries.filter(entry => !entry.directory).length - 1) fail('kit checksum inventory');
  const extension = baseline.metadata.platform === 'win32' ? '.zip' : '.tar.gz';
  if (!archive.endsWith(extension) || path.basename(archive) !== `${baseline.folder}-${build.slug}-${build.version}${extension}`) fail('kit filename');
  return { entries, baseline, preset, build, sha256, bytes: bytes.length };
}

function run(executable, args, options, label, expected = 0) {
  const result = spawnSync(executable, args, { ...options, encoding: 'utf8', windowsHide: true, timeout: 30000, maxBuffer: 4 * 1024 * 1024 });
  if (result.error || result.status !== expected) fail(label + ' failed');
  return result.stdout;
}
function extract(entries, destination) {
  fs.mkdirSync(destination, { recursive: true });
  for (const entry of entries) {
    const file = path.join(destination, ...entry.name.split('/'));
    if (entry.directory) fs.mkdirSync(file, { recursive: true, mode: entry.mode });
    else { fs.mkdirSync(path.dirname(file), { recursive: true }); fs.writeFileSync(file, entry.data, { flag: 'wx', mode: entry.mode }); fs.chmodSync(file, entry.mode); }
  }
}
async function until(predicate, description, milliseconds = 15000) {
  const deadline = Date.now() + milliseconds;
  while (!await predicate()) { if (Date.now() >= deadline) fail('timeout: ' + description); await pause(25); }
}
class Peer {
  constructor(socket) {
    this.socket = socket; this.frames = []; this.output = ''; this.id = 0;
    socket.on('message', data => {
      try {
        const frame = JSON.parse(data.toString()); this.frames.push(frame);
        if (this.frames.length > 10000) fail('fixture frame bound');
        if (frame.type === 'snapshot-chunk') {
          this.output += frame.data; this.send({ type: 'snapshot-applied', sessionId: frame.sessionId, snapshotId: frame.snapshotId, chunkIndex: frame.index, parsedBytes: Buffer.byteLength(frame.data) });
        }
        if (frame.type === 'snapshot-end') this.send({ type: 'applied', sessionId: frame.sessionId, snapshotId: frame.snapshotId, sequence: frame.sequence });
        if (frame.type === 'output' || frame.type === 'grid') {
          if (frame.type === 'output') this.output += frame.data;
          this.send({ type: 'applied', sessionId: frame.sessionId, sequence: frame.sequence });
        }
        if (this.output.length > 1024 * 1024) fail('fixture output bound');
      } catch (error) { this.error = error; }
    });
    socket.on('error', error => { this.error = error; }); socket.on('close', () => { this.closed = true; });
  }
  send(frame) { this.socket.send(JSON.stringify(frame)); }
  async wait(predicate, label) { await until(() => { if (this.error) throw this.error; if (this.closed) fail('socket closed'); return predicate(); }, label); }
  async request(type, fields = {}, resultType = 'operation-result') {
    const requestId = ++this.id; this.send({ type, requestId, ...fields }); let result;
    await this.wait(() => (result = this.frames.find(frame => frame.requestId === requestId && [resultType, 'error'].includes(frame.type))), type);
    if (result.type === 'error') fail('fixture operation ' + type + ': ' + result.code);
    return result;
  }
  async close() { if (this.closed) return; const done = once(this.socket, 'close'); this.socket.close(); await done; }
}
const psQuote = value => "'" + value.replaceAll("'", "''") + "'";
const shQuote = value => "'" + value.replaceAll("'", "'\\''") + "'";
export function fixtureCLI(folder, tools, recordFile, environment, powershell) {
  if (process.platform === 'win32') {
    const source = `using System; using System.IO; public class GuildKitFixture { public static void Main(string[] args) {
      var lines=new string[args.Length+1]; lines[0]=Directory.GetCurrentDirectory(); Array.Copy(args,0,lines,1,args.Length);
      File.WriteAllLines(Environment.GetEnvironmentVariable("GUILD_KIT_PROBE_FILE"),lines);
      Console.WriteLine("GUILD_KIT_FIXTURE_READY"); string line; while((line=Console.ReadLine())!=null) { Console.WriteLine("GUILD_KIT_FIXTURE_ACK:"+line); }
    } }`;
    const executable = path.join(tools, 'claude.exe');
    const script = `$ErrorActionPreference='Stop'; Add-Type -TypeDefinition ${psQuote(source)} -OutputAssembly ${psQuote(executable)} -OutputType ConsoleApplication`;
    run(powershell, ['-NoLogo', '-NoProfile', '-NonInteractive', '-EncodedCommand', Buffer.from(script, 'utf16le').toString('base64')], { cwd: tools, env: environment }, 'compile owned fixture');
  } else {
    const probe = path.join(tools, 'fixture.cjs');
    fs.writeFileSync(probe, `const fs=require('node:fs');fs.writeFileSync(process.env.GUILD_KIT_PROBE_FILE,[process.cwd(),...process.argv.slice(2)].join('\\n')+'\\n');process.stdout.write('GUILD_KIT_FIXTURE_READY\\n');require('node:readline').createInterface({input:process.stdin}).on('line',line=>process.stdout.write('GUILD_KIT_FIXTURE_ACK:'+line+'\\n'));\n`);
    fs.writeFileSync(path.join(tools, 'claude'), `#!/bin/sh\nexec ${shQuote(path.join(folder, 'bin/node'))} ${shQuote(probe)} "$@"\n`, { mode: 0o755 });
  }
  environment.GUILD_KIT_PROBE_FILE = recordFile;
}
function environmentFor(scratch, tools) {
  const temporary = path.join(scratch, 'temp'); fs.mkdirSync(temporary);
  const environment = { PATH: [tools, path.dirname(process.execPath), process.env.PATH ?? ''].join(path.delimiter),
    NODE_OPTIONS: '', NODE_PATH: '', WS_NO_BUFFER_UTIL: '1', WS_NO_UTF_8_VALIDATE: '1', TEMP: temporary, TMP: temporary, TMPDIR: temporary,
    CLAUDE_CONFIG_DIR: path.join(scratch, 'claude-config'), DISABLE_AUTOUPDATER: '1', CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: '1' };
  const inherited = new Set(['HOME', 'USER', 'LOGNAME', 'SHELL', 'LANG', 'LC_ALL', 'LC_CTYPE', 'SYSTEMROOT', 'WINDIR', 'SYSTEMDRIVE',
    'COMSPEC', 'PATHEXT', 'USERPROFILE', 'APPDATA', 'LOCALAPPDATA', 'PROGRAMFILES', 'PROGRAMFILES(X86)', 'PROGRAMDATA',
    'NUMBER_OF_PROCESSORS', 'PROCESSOR_ARCHITECTURE', 'OS', 'CLAUDE_CODE_GIT_BASH_PATH']);
  for (const [key, value] of Object.entries(process.env)) if (inherited.has(key.toUpperCase()) && value !== undefined) environment[key] = value;
  fs.mkdirSync(environment.CLAUDE_CONFIG_DIR);
  environment.GIT_CONFIG_NOSYSTEM = '1'; environment.GIT_CONFIG_GLOBAL = path.join(scratch, 'empty-git-config');
  fs.writeFileSync(environment.GIT_CONFIG_GLOBAL, '', { flag: 'wx' });
  environment.GIT_TEMPLATE_DIR = path.join(scratch, 'empty-git-template'); fs.mkdirSync(environment.GIT_TEMPLATE_DIR);
  return environment;
}

/** Validate actual session-only plugin loading without creating a model session. */
export function checkClaudePlugin(claude, bundle, workspace, environment, build) {
  const options = { cwd: workspace, env: environment };
  const version = run(claude, ['--version'], options, 'Claude version').trim().match(/^\d+\.\d+\.\d+/)?.[0];
  if (!version) fail('unknown Claude version');
  run(claude, ['plugin', 'validate', '--strict', bundle], options, 'Claude plugin validation');
  const output = run(claude, ['--plugin-dir', bundle, 'plugin', 'list', '--json'], options, 'Claude plugin loading');
  let plugins; try { plugins = JSON.parse(output); } catch { fail('Claude plugin list JSON'); }
  if (!Array.isArray(plugins) || !plugins.some(plugin => plugin.id === `${build.slug}@inline` && plugin.version === build.version && plugin.enabled === true &&
    samePath(plugin.installPath, bundle))) fail('selected Claude plugin did not load');
  return { version, validation: 'strict', pluginId: `${build.slug}@inline`, pluginVersion: build.version, sessionPluginLoaded: true };
}
export function checkBuildHooks(build, bundle, workspace, environment) {
  if (!build.requiresBash) return { required: false, checks: ['no-hooks-declared'] };
  const bash = process.platform === 'win32' ? environment.CLAUDE_CODE_GIT_BASH_PATH || 'bash.exe' : 'bash';
  const options = { cwd: workspace, env: environment };
  const bashVersion = run(bash, ['--version'], options, 'Bash prerequisite').trim().split('\n')[0];
  const gitVersion = run('git', ['--version'], options, 'Git prerequisite').trim();
  run('git', ['-c', 'init.defaultBranch=main', 'init', '.'], options, 'initialize owned hook fixture');
  if (build.slug === 'measured-delivery') {
    const script = path.join(bundle, 'scripts/uncommitted-work-check.sh');
    assert.equal(run(bash, [script], { ...options, input: '{}' }, 'clean worktree hook').trim(), '');
    const dirty = path.join(workspace, 'owned-hook-fixture.txt'); fs.writeFileSync(dirty, 'owned harmless fixture\n', { flag: 'wx' });
    const advisory = run(bash, [script], { ...options, input: '{}' }, 'dirty worktree hook');
    if (!JSON.parse(advisory).systemMessage?.includes('Uncommitted changes')) fail('dirty worktree hook advisory missing');
    fs.unlinkSync(dirty);
    return { required: true, bashVersion, gitVersion, checks: ['clean-worktree-allowed', 'dirty-worktree-advisory'] };
  }
  if (build.slug === 'evidence-first-review') {
    const script = path.join(bundle, 'scripts/merge-guard.sh');
    const parser = run(bash, ['--noprofile', '--norc', '-c', 'for tool in jq python3 node; do if command -v "$tool" >/dev/null 2>&1; then printf "%s" "$tool"; break; fi; done'], options, 'JSON parser prerequisite').trim();
    if (!['jq', 'python3', 'node'].includes(parser)) fail('JSON parser prerequisite missing');
    run(bash, [script], { ...options, input: JSON.stringify({ tool_input: { command: 'git status' } }) }, 'ordinary command hook');
    run(bash, [script], { ...options, input: JSON.stringify({ tool_input: { command: 'git push --force' } }) }, 'force push hook', 2);
    run(bash, [script], { ...options, input: JSON.stringify({ tool_input: { command: 'gh pr merge 1' } }) }, 'author merge hook', 2);
    return { required: true, bashVersion, gitVersion, jsonParser: parser, checks: ['ordinary-command-allowed', 'force-push-blocked', 'author-merge-blocked'] };
  }
  fail('unknown hook-bearing build');
}

export async function checkGuildKit(archive, { runtimeArchive, claude, outputDirectory } = {}) {
  if (process.version !== 'v24.14.1' || !['linux', 'win32'].includes(process.platform)) fail('native Linux/Windows Node 24.14.1 required');
  archive = path.resolve(archive); runtimeArchive = path.resolve(runtimeArchive);
  const inspected = inspectGuildKit(archive, runtimeArchive);
  if (inspected.baseline.metadata.platform !== process.platform || inspected.baseline.metadata.architecture !== process.arch || inspected.baseline.metadata.node !== process.version) fail('native target mismatch');
  const temporary = path.join(process.cwd(), '.runtime/tmp'); fs.mkdirSync(temporary, { recursive: true });
  if (fs.lstatSync(temporary).isSymbolicLink()) fail('temporary directory is a link');
  const scratch = fs.mkdtempSync(path.join(temporary, 'guild-kit-consumer-'));
  const destination = path.join(scratch, 'relocated app 世界'), tools = path.join(scratch, 'tools'); fs.mkdirSync(tools);
  extract(inspected.entries, destination);
  const folder = path.join(destination, inspected.baseline.folder), bundle = path.join(folder, 'guild-builds', inspected.build.slug);
  const recordFile = path.join(scratch, 'fixture-record.txt'), environment = environmentFor(scratch, tools);
  const windows = process.env.SystemRoot ?? process.env.SYSTEMROOT;
  const powershell = process.platform === 'win32' ? path.join(windows, 'System32/WindowsPowerShell/v1.0/powershell.exe') : undefined;
  const launcher = path.join(folder, process.platform === 'win32' ? 'grotesqueries.exe' : 'grotesqueries');
  let host, child, peer, cleaned = false; const checks = ['runtime-files-unchanged', 'preset-integrity'];
  try {
    fixtureCLI(folder, tools, recordFile, environment, powershell);
    const options = { cwd: scratch, env: environment };
    run(launcher, ['--setup'], options, 'kit setup');
    if (fs.existsSync(recordFile) || fs.existsSync(path.join(folder, '.runtime/host-ready.json'))) fail('setup started a process');
    const configurationFile = path.join(folder, process.platform === 'win32' ? 'grotesqueries.json' : 'config/grotesqueries.json');
    const before = fs.readFileSync(configurationFile); run(launcher, ['--setup'], options, 'repeated kit setup');
    assert.deepEqual(fs.readFileSync(configurationFile), before, 'Setup preserves operator bytes'); checks.push('setup-preservation');
    const configuration = JSON.parse(before);
    if (process.platform === 'win32' && !environment.CLAUDE_CODE_GIT_BASH_PATH) {
      const bash = configuration.launchProfiles.find(profile => profile.id === 'git-bash');
      if (bash) environment.CLAUDE_CODE_GIT_BASH_PATH = path.resolve(folder, bash.executable);
    }
    const server = net.createServer(); server.listen(0, '127.0.0.1'); await once(server, 'listening'); configuration.port = server.address().port;
    await new Promise(resolve => server.close(resolve)); fs.writeFileSync(configurationFile, JSON.stringify(configuration, null, 2) + '\n');
    if (process.platform === 'win32') host = await startOwnedWindowsHost(launcher, scratch, environment);
    else {
      child = spawn(launcher, [], { ...options, stdio: ['ignore', 'pipe', 'pipe'] }); child.stdout.resume(); child.stderr.resume();
      host = { pid: child.pid, stop: async () => { if (child.exitCode !== null || child.signalCode !== null) return; const exited = once(child, 'exit'); child.kill('SIGINT'); await bounded(exited, 15000, 'host shutdown timeout'); } };
    }
    const readyFile = path.join(folder, '.runtime/host-ready.json');
    await until(() => { if (child && child.exitCode !== null) fail('host exited before readiness'); return fs.existsSync(readyFile); }, 'host readiness');
    const ready = JSON.parse(fs.readFileSync(readyFile)); if (ready.pid !== host.pid) fail('host identity mismatch');
    const origin = `http://127.0.0.1:${configuration.port}`, bootstrap = await fetch(origin + '/api/bootstrap').then(response => response.json());
    assert.deepEqual(bootstrap.sessions, []); if (fs.existsSync(recordFile)) fail('host startup started a CLI'); checks.push('zero-automatic-sessions');
    assert.equal((await fetch(origin + '/api/guild-build')).status, 403);
    const response = await fetch(origin + '/api/guild-build', { headers: { 'x-automata-token': bootstrap.token } }); assert.equal(response.status, 200);
    const summary = (await response.json()).guildBuild;
    if (summary?.slug !== inspected.build.slug || summary.version !== inspected.build.version || summary.name !== inspected.build.name ||
      summary.target !== 'claude-code' || JSON.stringify(summary.modules) !== JSON.stringify(inspected.build.modules) ||
      summary.profileId !== 'guild-' + inspected.build.slug || summary.prerequisites.length) fail('selected build not ready in host');
    peer = new Peer(new WebSocket(`ws://127.0.0.1:${configuration.port}/api/terminal?token=${bootstrap.token}`, { origin }));
    await peer.wait(() => peer.frames.some(frame => frame.type === 'hello'), 'hello');
    await peer.request('ready', { protocol: bootstrap.protocol, hostInstanceId: bootstrap.hostInstanceId });
    const started = await peer.request('start', { profileId: summary.profileId, cols: 80, rows: 24 }, 'start-result');
    const sessionId = started.session.id; await peer.request('attach', { sessionId });
    await peer.wait(() => peer.frames.some(frame => frame.type === 'snapshot-end' && frame.sessionId === sessionId), 'fixture restore');
    await peer.wait(() => peer.output.includes('GUILD_KIT_FIXTURE_READY') && fs.existsSync(recordFile), 'fixture launch');
    const actual = fs.readFileSync(recordFile, 'utf8').replace(/^\uFEFF/, '').trimEnd().split(/\r?\n/);
    if (actual.length !== 3 || actual[1] !== '--plugin-dir' || !samePath(actual[0], path.join(folder, 'workspaces', summary.profileId)) || !samePath(actual[2], bundle)) fail('generated CLI arguments or workspace differ');
    if (peer.frames.some(frame => frame.type === 'control' && frame.leaseId)) fail('attachment granted control');
    await peer.request('take-control', { sessionId });
    await peer.wait(() => peer.frames.some(frame => frame.type === 'control' && frame.leaseId), 'explicit control');
    const lease = peer.frames.findLast(frame => frame.type === 'control' && frame.leaseId).leaseId;
    peer.send({ type: 'input', sessionId, leaseId: lease, inputId: 1, data: 'owned-preset-probe\r' });
    await peer.wait(() => peer.output.includes('GUILD_KIT_FIXTURE_ACK:owned-preset-probe'), 'native fixture roundtrip');
    await peer.request('stop', { sessionId, leaseId: lease });
    await peer.wait(() => peer.frames.some(frame => frame.type === 'session' && frame.session.id === sessionId && frame.session.processState === 'exited'), 'fixture cleanup');
    checks.push('launch-profile', 'explicit-start-and-control', 'native-profile-stop');
    await peer.close(); peer = undefined; await host.stop(); host = undefined;
    assert.equal(fs.existsSync(readyFile), false); checks.push('host-shutdown');
    const workspace = path.join(scratch, 'hook-workspace'); fs.mkdirSync(workspace);
    const realClaude = claude ?? (process.platform === 'win32' ? 'claude.exe' : 'claude');
    // Remove the harmless fixture from lookup before invoking the real provider CLI or hooks.
    const actualEnvironment = { ...environment, PATH: [path.dirname(process.execPath), process.env.PATH ?? ''].join(path.delimiter) };
    const provider = checkClaudePlugin(realClaude, bundle, workspace, actualEnvironment, inspected.build); checks.push('claude-plugin-validation');
    const hooks = checkBuildHooks(inspected.build, bundle, workspace, actualEnvironment); checks.push('hook-compatibility');
    fs.rmSync(scratch, { recursive: true, force: true }); cleaned = true; checks.push('owned-fixture-cleanup');
    const report = { guildKitChecked: true, archive: path.basename(archive), sha256: inspected.sha256, bytes: inspected.bytes,
      operatingSystem: { type: os.type(), release: os.release(), version: os.version(), machine: os.machine() },
      runtime: { archiveSha256: inspected.baseline.sha256, version: inspected.preset.runtime.version, sourceRevision: inspected.preset.runtime.sourceRevision,
        platform: process.platform, architecture: process.arch, node: process.version, kernel: os.release(), signing: inspected.baseline.metadata.signing },
      build: { slug: inspected.build.slug, version: inspected.build.version, target: inspected.build.target, catalogRevision: inspected.preset.build.catalogRevision,
        archiveSha256: inspected.build.archive.sha256 }, provider, hooks, checks, modelCalls: 0 };
    const output = path.resolve(outputDirectory ?? path.dirname(archive)); fs.mkdirSync(output, { recursive: true });
    const reportFile = path.join(output, path.basename(archive) + '.qualification.json'), proof = Buffer.from(JSON.stringify(report, null, 2) + '\n');
    if (fs.existsSync(reportFile)) { if (!regular(reportFile).equals(proof)) fail('existing qualification differs'); }
    else fs.writeFileSync(reportFile, proof, { flag: 'wx' });
    return { ...report, reportFile };
  } finally {
    if (peer) peer.socket.terminate();
    await host?.stop();
    if (!cleaned && !host) fs.rmSync(scratch, { recursive: true, force: true });
  }
}

if (process.argv[1] && /^check-guild-kit\.(mjs|cjs)$/.test(path.basename(process.argv[1])) && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const args = process.argv.slice(2), archive = args.shift(), options = {};
  while (args.length) {
    const flag = args.shift(), value = args.shift(); if (!value || !['--runtime', '--claude', '--output'].includes(flag)) fail('command arguments');
    const key = ({ '--runtime': 'runtimeArchive', '--claude': 'claude', '--output': 'outputDirectory' })[flag];
    if (Object.hasOwn(options, key)) fail('duplicate command option'); options[key] = value;
  }
  if (!archive || !options.runtimeArchive) fail('Usage: node bin/check-guild-kit.mjs KIT_ARCHIVE --runtime BASE_ARCHIVE [--claude EXECUTABLE] [--output DIRECTORY]');
  console.log(JSON.stringify(await checkGuildKit(archive, options)));
}
