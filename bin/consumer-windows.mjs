// Artifact-only Windows checker. CI bundles ws into this test tool; the app uses its own embedded runtime.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import crypto from 'node:crypto';
import net from 'node:net';
import { execFileSync } from 'node:child_process';
import { once } from 'node:events';
import { fileURLToPath } from 'node:url';
import { inflateRawSync, crc32 } from 'node:zlib';
import WebSocket from 'ws';
import Headless from '@xterm/headless';
import Unicode11 from '@xterm/addon-unicode11';
import { assertNoEmbeddedAuthenticode } from './windows-pe.mjs';
import { startOwnedWindowsHost, probeWindowsPowerShell } from './windows-host-fixture.mjs';
export { startOwnedWindowsHost } from './windows-host-fixture.mjs';

const hash = bytes => crypto.createHash('sha256').update(bytes).digest('hex');
const pause = ms => new Promise(resolve => setTimeout(resolve, ms));
const required = ['BUILD-METADATA.json', 'LICENSE', 'README.txt', 'SHA256SUMS', 'THIRD_PARTY_NOTICES.md', 'grotesqueries.exe', 'grotesqueries.json', 'licenses.txt'];

/** Inspect the complete artifact without a network-capable OS trust lookup. */
export function verifyUnsignedWindowsArchive(entries) {
  const top = entries[0]?.name.split('/')[0];
  assert.match(top ?? '', /^grotesqueries-\d+\.\d+\.\d+(?:-[A-Za-z0-9.-]+)?-win32-x64$/);
  assert.deepEqual(entries.map(entry => entry.name.slice(top.length + 1)).sort(), [...required].sort());
  assert.ok(entries.every(entry => entry.name.startsWith(top + '/')));
  assertNoEmbeddedAuthenticode(entries.find(entry => entry.name === top + '/grotesqueries.exe').bytes);
  return { top, signingEvidence: { embeddedAuthenticode: 'absent', shippedCatalog: 'absent', operatingSystemTrust: 'not-evaluated' } };
}

/** Validate both ZIP headers before creating files. This accepts only our bounded, regular-file archive format. */
export function readWindowsZip(input) {
  const bytes = Buffer.from(input), fail = () => { throw new Error('WINDOWS_ZIP_INVALID'); };
  if (bytes.length < 22 || bytes.length > 256 * 1024 * 1024) fail();
  const end = bytes.length - 22;
  if (bytes.readUInt32LE(end) !== 0x06054b50 || bytes.readUInt16LE(end + 4) || bytes.readUInt16LE(end + 6) || bytes.readUInt16LE(end + 20)) fail();
  const count = bytes.readUInt16LE(end + 10), size = bytes.readUInt32LE(end + 12), start = bytes.readUInt32LE(end + 16);
  if (count < 1 || count > 64 || count !== bytes.readUInt16LE(end + 8) || start + size !== end) fail();
  const entries = [], seen = new Set(); let cursor = start, nextLocal = 0, total = 0;
  for (let index = 0; index < count; index++) {
    if (cursor + 46 > end || bytes.readUInt32LE(cursor) !== 0x02014b50) fail();
    const flags = bytes.readUInt16LE(cursor + 8), method = bytes.readUInt16LE(cursor + 10), checksum = bytes.readUInt32LE(cursor + 16);
    const packedSize = bytes.readUInt32LE(cursor + 20), originalSize = bytes.readUInt32LE(cursor + 24), length = bytes.readUInt16LE(cursor + 28);
    const extra = bytes.readUInt16LE(cursor + 30), comment = bytes.readUInt16LE(cursor + 32), offset = bytes.readUInt32LE(cursor + 42);
    if (flags !== 0x800 || method !== 8 || extra || comment || !length || cursor + 46 + length > end ||
      bytes.readUInt16LE(cursor + 34) || (bytes.readUInt32LE(cursor + 38) >>> 16 & 0o170000) !== 0o100000 ||
      originalSize > 192 * 1024 * 1024 || (total += originalSize) > 256 * 1024 * 1024 || offset !== nextLocal) fail();
    const name = bytes.subarray(cursor + 46, cursor + 46 + length).toString('utf8');
    if (!/^[A-Za-z0-9._/-]+$/.test(name) || name.startsWith('/') || name.split('/').some(part => !part || part === '.' || part === '..' || /[. ]$/.test(part)) ||
      seen.has(name.toLowerCase())) fail();
    seen.add(name.toLowerCase());
    if (offset + 30 + length + packedSize > start || bytes.readUInt32LE(offset) !== 0x04034b50 ||
      bytes.readUInt16LE(offset + 6) !== flags || bytes.readUInt16LE(offset + 8) !== method ||
      bytes.readUInt32LE(offset + 14) !== checksum || bytes.readUInt32LE(offset + 18) !== packedSize ||
      bytes.readUInt32LE(offset + 22) !== originalSize || bytes.readUInt16LE(offset + 26) !== length || bytes.readUInt16LE(offset + 28) ||
      !bytes.subarray(offset + 30, offset + 30 + length).equals(bytes.subarray(cursor + 46, cursor + 46 + length))) fail();
    const dataStart = offset + 30 + length;
    const data = inflateRawSync(bytes.subarray(dataStart, dataStart + packedSize), { maxOutputLength: Math.max(1, originalSize) });
    if (data.length !== originalSize || crc32(data) !== checksum) fail();
    entries.push({ name, bytes: data }); nextLocal = dataStart + packedSize; cursor += 46 + length;
  }
  if (cursor !== end || nextLocal !== start) fail();
  return entries;
}

export function verifyWindowsFiles(folder, { configured = false } = {}) {
  const regular = file => {
    const full = path.join(folder, file), stat = fs.lstatSync(full);
    if (!stat.isFile() || stat.isSymbolicLink()) throw new Error('WINDOWS_PACKAGE_NOT_REGULAR');
    return fs.readFileSync(full);
  };
  const lines = regular('SHA256SUMS').toString('utf8').trimEnd().split('\n'), seen = new Set();
  for (const line of lines) {
    const match = /^([a-f0-9]{64})  ([A-Za-z0-9._-]+)$/.exec(line);
    if (!match || !required.includes(match[2]) || match[2] === 'SHA256SUMS' || seen.has(match[2].toLowerCase())) throw new Error('WINDOWS_PACKAGE_MANIFEST_INVALID');
    seen.add(match[2].toLowerCase());
    if (!(configured && match[2] === 'grotesqueries.json') && hash(regular(match[2])) !== match[1]) throw new Error('WINDOWS_PACKAGE_CHECKSUM_MISMATCH');
  }
  if (lines.length !== required.length - 1 || required.some(file => file !== 'SHA256SUMS' && !seen.has(file.toLowerCase()))) throw new Error('WINDOWS_PACKAGE_MANIFEST_INCOMPLETE');
  return seen;
}

/** Render exactly what a terminal user sees, independently for each session/snapshot. */
export class WindowsFixtureScreens {
  constructor() { this.sessions = new Map(); }
  accept(frame) {
    if (frame.type === 'snapshot-begin') {
      let entry = this.sessions.get(frame.sessionId);
      if (!entry) {
        const terminal = new Headless.Terminal({ cols: frame.cols, rows: frame.rows, scrollback: 1000, allowProposedApi: true, logLevel: 'off' });
        terminal.loadAddon(new Unicode11.Unicode11Addon()); terminal.unicode.activeVersion = '11';
        entry = { terminal, queue: Promise.resolve(), raw: '' }; this.sessions.set(frame.sessionId, entry);
      }
      entry.snapshotId = frame.snapshotId; entry.raw = '';
      entry.queue = entry.queue.then(() => { entry.terminal.reset(); entry.terminal.resize(frame.cols, frame.rows); });
      return;
    }
    if (!['snapshot-chunk', 'snapshot-end', 'output', 'grid'].includes(frame.type)) return;
    const entry = this.sessions.get(frame.sessionId); if (!entry) throw new Error('WINDOWS_FIXTURE_SCREEN_WITHOUT_SNAPSHOT');
    if (frame.type.startsWith('snapshot-') && entry.snapshotId !== frame.snapshotId) throw new Error('WINDOWS_FIXTURE_SNAPSHOT_ID');
    if (frame.type === 'snapshot-end') { entry.snapshotId = undefined; return; }
    if (frame.type === 'grid') entry.queue = entry.queue.then(() => { entry.terminal.resize(frame.cols, frame.rows); });
    else {
      entry.raw = (entry.raw + frame.data).slice(-8192);
      entry.queue = entry.queue.then(() => new Promise(resolve => { entry.terminal.write(frame.data, resolve); }));
    }
  }
  async text(sessionId) {
    const entry = this.sessions.get(sessionId); if (!entry) return '';
    await entry.queue; const buffer = entry.terminal.buffer.active, lines = [];
    for (let index = 0; index < buffer.length; index++) lines.push(buffer.getLine(index)?.translateToString(true) ?? '');
    return lines.join('\n');
  }
  async diagnostics(sessionId) {
    const entry = this.sessions.get(sessionId); if (!entry) return { rawVt: '', screen: '' };
    const screen = (await this.text(sessionId)).slice(-8192), rawVt = entry.raw;
    return { cols: entry.terminal.cols, rows: entry.terminal.rows, rawVt, rawCodePoints: Array.from(rawVt, char => char.codePointAt(0)), screen };
  }
  async dispose() { for (const entry of this.sessions.values()) { await entry.queue; entry.terminal.dispose(); } this.sessions.clear(); }
}

export class WindowsConsumerPeer {
  constructor(socket) {
    this.socket = socket; this.frames = []; this.nextRequest = 0; this.output = ''; this.screens = new WindowsFixtureScreens();
    socket.on('message', data => {
      try {
        const frame = JSON.parse(data.toString()); this.frames.push(frame); this.screens.accept(frame);
        if (this.frames.length > 20000) throw new Error('WINDOWS_CONSUMER_FRAME_LIMIT');
        if (frame.type === 'snapshot-chunk') {
          this.output += frame.data; this.send({ type: 'snapshot-applied', sessionId: frame.sessionId,
            snapshotId: frame.snapshotId, chunkIndex: frame.index, parsedBytes: Buffer.byteLength(frame.data) });
        }
        if (frame.type === 'snapshot-end') this.send({ type: 'applied', sessionId: frame.sessionId, snapshotId: frame.snapshotId, sequence: frame.sequence });
        if (frame.type === 'output' || frame.type === 'grid') {
          if (frame.type === 'output') this.output += frame.data;
          this.send({ type: 'applied', sessionId: frame.sessionId, sequence: frame.sequence });
        }
        if (this.output.length > 4 * 1024 * 1024) throw new Error('WINDOWS_CONSUMER_OUTPUT_LIMIT');
      } catch (error) { this.error = error; }
    });
    socket.on('error', error => { this.error = error; }); socket.on('close', () => { this.closed = true; });
  }
  send(frame) { this.socket.send(JSON.stringify(frame)); }
  request(type, fields = {}) { const requestId = ++this.nextRequest; this.send({ type, requestId, ...fields }); return requestId; }
  async until(predicate, description, milliseconds = 15000) {
    const deadline = Date.now() + milliseconds;
    while (true) {
      if (this.error) throw this.error;
      if (this.closed) throw new Error('WINDOWS_CONSUMER_SOCKET_CLOSED: ' + description);
      const ready = await predicate();
      if (this.error) throw this.error;
      if (this.closed) throw new Error('WINDOWS_CONSUMER_SOCKET_CLOSED: ' + description);
      if (ready) return;
      if (Date.now() >= deadline) throw new Error('WINDOWS_CONSUMER_TIMEOUT: ' + description);
      await pause(20);
    }
  }
  async result(requestId, type = 'operation-result', milliseconds = 15000) {
    let frame;
    await this.until(() => (frame = this.frames.find(value => value.requestId === requestId && [type, 'error'].includes(value.type))), 'request ' + requestId, milliseconds);
    if (frame.type === 'error') throw new Error('WINDOWS_CONSUMER_OPERATION_FAILED: ' + frame.code);
    return frame;
  }
  async input(sessionId, leaseId, inputId, data) {
    const begin = this.frames.length; this.send({ type: 'input', sessionId, leaseId, inputId, data }); let acknowledgment;
    await this.until(() => (acknowledgment = this.frames.slice(begin).find(frame =>
      frame.type === 'input-ack' && frame.sessionId === sessionId && frame.leaseId === leaseId && frame.inputId === inputId ||
      frame.type === 'error' && (frame.sessionId === undefined || frame.sessionId === sessionId) && (frame.inputId === undefined || frame.inputId === inputId))), 'input acknowledgment');
    if (acknowledgment.type === 'error') throw new Error('WINDOWS_CONSUMER_INPUT_FAILED: ' + acknowledgment.code);
    if (acknowledgment.disposition !== 'accepted') throw new Error('WINDOWS_CONSUMER_INPUT_NOT_ACCEPTED');
  }
  async fixtureDiagnostics(sessionId) {
    return { ...(await this.screens.diagnostics(sessionId)), inputResults: this.frames.filter(frame => frame.sessionId === sessionId && ['input-ack', 'error'].includes(frame.type))
      .slice(-16).map(frame => ({ type: frame.type, inputId: Number.isSafeInteger(frame.inputId) ? frame.inputId : null,
        code: typeof frame.code === 'string' && /^[A-Z0-9_]{1,64}$/.test(frame.code) ? frame.code : null,
        disposition: ['accepted', 'already-seen'].includes(frame.disposition) ? frame.disposition : null })) };
  }
  async close() {
    if (this.closed) { await this.screens.dispose(); return; }
    const closed = once(this.socket, 'close'); this.socket.close(); await closed; await this.screens.dispose();
  }
}

const quote = value => "'" + value.replaceAll("'", "''") + "'";
const encoded = source => Buffer.from(source, 'utf16le').toString('base64');
const alive = pid => { try { process.kill(pid, 0); return true; } catch (error) { if (error.code === 'ESRCH') return false; throw error; } };

/** Finalize only the owned fixture, retaining every primary and recovery failure. */
export async function cleanupWindowsConsumer(scratch, ownedHost, fixturePids, primaryFailure) {
  const cleanupErrors = [];
  try { if (ownedHost && alive(ownedHost.pid)) await ownedHost.stop(); }
  catch (error) { cleanupErrors.push(error); }
  try { if (fixturePids.some(alive)) cleanupErrors.push(new Error('WINDOWS_CONSUMER_PROCESSES_REMAIN: Recorded fixture processes are still live.')); }
  catch (error) { cleanupErrors.push(error); }
  try {
    if (cleanupErrors.length) await ownedHost?.abort?.();
    else await ownedHost?.dispose?.();
  } catch (error) {
    cleanupErrors.push(error);
    try { await ownedHost?.abort?.(); } catch (recovery) { cleanupErrors.push(recovery); }
  }
  if (primaryFailure !== undefined || cleanupErrors.length) {
    console.error('Windows consumer failure needs recovery; owned fixture preserved at ' + scratch);
    if (cleanupErrors.length) {
      throw new AggregateError([...(primaryFailure === undefined ? [] : [primaryFailure]), ...cleanupErrors],
        'WINDOWS_CONSUMER_CLEANUP_FAILED: Evidence preserved at ' + scratch, { cause: primaryFailure ?? cleanupErrors[0] });
    }
    throw primaryFailure;
  }
  try { fs.rmSync(scratch, { recursive: true, force: true, maxRetries: 8, retryDelay: 100 }); }
  catch (error) { throw new Error('WINDOWS_CONSUMER_REMOVE_FAILED: Passed process checks; fixture preserved at ' + scratch, { cause: error }); }
}

/** Downloaded archive plus this bundled checker are the only inputs; test installations are always newly extracted. */
export async function checkWindowsArchive(archive) {
  if (process.platform !== 'win32' || process.arch !== 'x64' || process.version !== 'v24.14.1') throw new Error('WINDOWS_X64_NODE_24_14_1_REQUIRED');
  archive = path.resolve(archive);
  const bytes = fs.readFileSync(archive), archiveSha256 = hash(bytes);
  assert.equal(fs.readFileSync(archive + '.sha256', 'utf8').trim(), `${archiveSha256}  ${path.basename(archive)}`, 'Archive checksum');
  const entries = readWindowsZip(bytes), { top, signingEvidence } = verifyUnsignedWindowsArchive(entries);
  const temporary = path.join(process.cwd(), '.runtime/tmp'); fs.mkdirSync(temporary, { recursive: true });
  if (fs.lstatSync(temporary).isSymbolicLink()) throw new Error('WINDOWS_CONSUMER_TEMP_SYMLINK');
  const scratch = fs.mkdtempSync(path.join(temporary, 'windows-consumer-'));
  const folder = path.join(scratch, top), caller = path.join(scratch, 'different-cwd'), temp = path.join(scratch, 'temp');
  fs.mkdirSync(folder); fs.mkdirSync(caller); fs.mkdirSync(temp);
  const receivedFile = path.join(folder, 'consumer-received-code-units.txt');
  let pid, ownedHost, peer, fixtureSessionId, fixturePhase = 'startup', primaryFailure; const fixturePids = [];
  const windows = process.env.SystemRoot ?? process.env.SYSTEMROOT;
  assert.match(windows ?? '', /^[A-Za-z]:[\\/]/);
  const powershell = path.join(windows, 'System32/WindowsPowerShell/v1.0/powershell.exe');
  const environment = { PATH: [path.join(windows, 'System32'), path.dirname(powershell)].join(';'), NODE_PATH: '', NODE_OPTIONS: '',
    WS_NO_BUFFER_UTIL: '1', WS_NO_UTF_8_VALIDATE: '1', TEMP: temp, TMP: temp };
  for (const name of ['SYSTEMROOT', 'WINDIR', 'SYSTEMDRIVE', 'COMSPEC', 'PATHEXT', 'USERPROFILE', 'APPDATA', 'LOCALAPPDATA',
    'PROGRAMFILES', 'PROGRAMFILES(X86)', 'PROGRAMDATA', 'NUMBER_OF_PROCESSORS', 'PROCESSOR_ARCHITECTURE', 'OS']) {
    const value = Object.entries(process.env).find(([key]) => key.toUpperCase() === name)?.[1]; if (value !== undefined) environment[name] = value;
  }
  const options = { cwd: caller, env: environment }, executable = path.join(folder, 'grotesqueries.exe');
  const until = async (predicate, description, milliseconds = 20000) => {
    const deadline = Date.now() + milliseconds;
    while (!await predicate()) { ownedHost?.assertHealthy?.(); if (Date.now() >= deadline) throw new Error('WINDOWS_CONSUMER_TIMEOUT: ' + description); await pause(25); }
  };
  try {
    for (const entry of entries) fs.writeFileSync(path.join(folder, entry.name.slice(top.length + 1)), entry.bytes, { flag: 'wx' });
    verifyWindowsFiles(folder);
    const metadata = JSON.parse(fs.readFileSync(path.join(folder, 'BUILD-METADATA.json'), 'utf8'));
    assert.equal(metadata.platform, 'win32'); assert.equal(metadata.architecture, 'x64'); assert.equal(metadata.node, 'v24.14.1');
    assert.match(metadata.sourceRevision, /^[a-f0-9]{40}$/); assert.equal(metadata.sourceDirty, false); assert.equal(metadata.signing, 'unsigned');
    assert.equal(metadata.executableSha256, hash(fs.readFileSync(executable)));
    assert.equal(path.basename(archive), `grotesqueries-${metadata.version}-win32-x64.zip`);
    execFileSync(executable, ['--setup'], { ...options, windowsHide: true, timeout: 15000, stdio: 'pipe' });
    const configFile = path.join(folder, 'grotesqueries.json'), config = JSON.parse(fs.readFileSync(configFile, 'utf8'));
    assert.equal(fs.existsSync(path.join(folder, '.runtime/host-ready.json')), false, 'Setup does not start the host');
    assert.ok(config.launchProfiles.length > 0 && config.launchProfiles.every(profile => profile.projectDirectory === '.'));
    const server = net.createServer(); server.listen(0, '127.0.0.1'); await once(server, 'listening');
    config.port = server.address().port; await new Promise(resolve => server.close(resolve));
    const script = `[Console]::OutputEncoding=[Text.UTF8Encoding]::new($false); [Console]::InputEncoding=[Text.UTF8Encoding]::new($false); ` +
      `[Console]::WriteLine('WINDOWS_READY:'+$PID); while ($null -ne ($line=[Console]::ReadLine())) { ` +
      `$units=[Text.StringBuilder]::new(); for($i=0;$i -lt $line.Length;$i++){ if($i){[void]$units.Append(',')}; [void]$units.Append([int][char]$line[$i]) }; ` +
      `[IO.File]::AppendAllText(${quote(receivedFile)},$units.ToString()+[Environment]::NewLine); ` +
      `if ($line -eq 'grid') { [Console]::WriteLine('WINDOWS_GRID:'+ [Console]::WindowWidth +'x'+ [Console]::WindowHeight) } ` +
      `else { [Console]::WriteLine('WINDOWS_ECHO:'+$line) } }`;
    const profile = (id, source) => ({ id, label: id, executable: powershell,
      args: ['-NoLogo', '-NoProfile', '-EncodedCommand', encoded(source)], projectDirectory: '.', environment: { PSModulePath: path.join(path.dirname(powershell), 'Modules') } });
    const pidFile = path.join(folder, 'consumer-tree-pids.txt'), exitFile = path.join(folder, 'consumer-root-exit.txt');
    const tree = role => {
      const child = role === 'root' ? 'child' : 'grandchild';
      return `[IO.File]::AppendAllText(${quote(pidFile)}, '${role}:'+$PID+[Environment]::NewLine); ` +
        (role !== 'grandchild' ? `Microsoft.PowerShell.Management\\Start-Process -FilePath ${quote(powershell)} -ArgumentList '-NoLogo','-NoProfile','-EncodedCommand',${quote(encoded(tree(child)))} -WindowStyle Hidden; ` : '') +
        (role === 'root' ? `[Console]::WriteLine('WINDOWS_TREE_READY'); while (![IO.File]::Exists(${quote(exitFile)})) { [Threading.Thread]::Sleep(10) }; [Console]::WriteLine('WINDOWS_ROOT_FINAL'); exit 7` : 'while ($true) { [Threading.Thread]::Sleep(100) }');
    };
    config.launchProfiles.push(profile('consumer-terminal', script), profile('consumer-tree', tree('root')));
    fs.writeFileSync(configFile, JSON.stringify(config, null, 2) + '\n');
    const configuredBytes = fs.readFileSync(configFile);
    execFileSync(executable, ['--setup'], { ...options, windowsHide: true, timeout: 15000, stdio: 'pipe' });
    assert.deepEqual(fs.readFileSync(configFile), configuredBytes, 'Setup preserves configured profile bytes');
    await probeWindowsPowerShell(caller, environment);
    ownedHost = await startOwnedWindowsHost(executable, caller, environment); pid = ownedHost.pid;
    const readyFile = path.join(folder, '.runtime/host-ready.json');
    await until(() => { if (!alive(pid)) throw new Error('WINDOWS_CONSUMER_HOST_EXITED'); return fs.existsSync(readyFile); }, 'host ready');
    assert.equal(JSON.parse(fs.readFileSync(readyFile, 'utf8')).pid, pid);
    const origin = `http://127.0.0.1:${config.port}`, bootstrap = () => fetch(origin + '/api/bootstrap').then(response => response.json());
    for (const route of ['/', '/assets/app.js', '/assets/app.css', '/licenses', '/grotesqueries.schema.json', '/version.json']) {
      assert.equal((await fetch(origin + route)).status, 200, route);
    }
    assert.match(await fetch(origin + '/licenses').then(response => response.text()), /Copyright Node\.js contributors/);
    assert.equal((await fetch(origin + '/api/bootstrap', { headers: { Origin: 'https://example.invalid' } })).status, 403);
    const initial = await bootstrap(); assert.deepEqual(initial.sessions, []);
    const connect = async () => {
      const connected = new WindowsConsumerPeer(new WebSocket(`ws://127.0.0.1:${config.port}/api/terminal?token=${initial.token}`, { origin }));
      await connected.until(() => connected.frames.some(frame => frame.type === 'hello'), 'hello');
      await connected.result(connected.request('ready', { protocol: initial.protocol, hostInstanceId: initial.hostInstanceId })); return connected;
    };
    const attach = async (connected, id) => {
      await connected.result(connected.request('attach', { sessionId: id }));
      await connected.until(() => connected.frames.some(frame => frame.type === 'snapshot-end' && frame.sessionId === id), 'restore');
    };
    const control = async (connected, id) => {
      await connected.result(connected.request('take-control', { sessionId: id }));
      await connected.until(() => connected.frames.some(frame => frame.type === 'control' && frame.sessionId === id && frame.leaseId), 'control');
      return connected.frames.findLast(frame => frame.type === 'control' && frame.sessionId === id && frame.leaseId).leaseId;
    };
    peer = await connect();
    const started = await peer.result(peer.request('start', { profileId: 'consumer-terminal', cols: 100, rows: 30 }), 'start-result');
    const id = started.session.id; fixtureSessionId = id; await attach(peer, id);
    await peer.until(async () => /WINDOWS_READY:\d+/.test(await peer.screens.text(id)), 'native readiness');
    const rootPid = Number(/WINDOWS_READY:(\d+)/.exec(await peer.screens.text(id))[1]); fixturePids.push(rootPid);
    await assert.rejects(peer.result(peer.request('resize', { sessionId: id, leaseId: crypto.randomUUID(), cols: 90, rows: 25 })), /CONTROL_REQUIRED/);
    let lease = await control(peer, id);
    fixturePhase = 'ascii';
    await peer.input(id, lease, 1, 'ASCII-probe\r');
    await peer.until(async () => (await peer.screens.text(id)).includes('WINDOWS_ECHO:ASCII-probe'), 'ASCII input');
    fixturePhase = 'unicode';
    await peer.input(id, lease, 2, 'Unicode-λ界é\r');
    await peer.until(async () => (await peer.screens.text(id)).includes('WINDOWS_ECHO:Unicode-λ界é'), 'Unicode input');
    assert.deepEqual(fs.readFileSync(receivedFile, 'utf8').trimEnd().split(/\r?\n/).slice(0, 2),
      ['ASCII-probe', 'Unicode-λ界é'].map(value => value.split('').map(char => char.charCodeAt(0)).join(',')), 'Actual fixture receives exact UTF16 code units');
    fixturePhase = 'resize';
    await peer.result(peer.request('resize', { sessionId: id, leaseId: lease, cols: 90, rows: 25 }));
    await peer.input(id, lease, 3, 'grid\r');
    await peer.until(async () => (await peer.screens.text(id)).includes('WINDOWS_GRID:90x25'), 'native resize');
    await peer.close(); peer = undefined;
    assert.equal((await bootstrap()).sessions.filter(session => session.processState === 'running').length, 1);
    fixturePhase = 'reconnect';
    peer = await connect(); await attach(peer, id);
    await peer.until(async () => (await peer.screens.text(id)).includes('WINDOWS_ECHO:Unicode-λ界é'), 'retained screen');
    assert.ok(!peer.frames.some(frame => frame.type === 'control' && frame.leaseId), 'Reconnection only observes');
    lease = await control(peer, id);
    const sibling = await peer.result(peer.request('start', { profileId: 'consumer-terminal', cols: 100, rows: 30 }), 'start-result');
    await peer.result(peer.request('release-control', { sessionId: id, leaseId: lease }));
    const siblingOutput = peer.output.length; await attach(peer, sibling.session.id);
    await peer.until(() => /WINDOWS_READY:\d+/.test(peer.output.slice(siblingOutput)), 'sibling readiness');
    const siblingPid = Number(/WINDOWS_READY:(\d+)/.exec(peer.output.slice(siblingOutput))[1]); fixturePids.push(siblingPid);
    const naturalTree = await peer.result(peer.request('start', { profileId: 'consumer-tree', cols: 100, rows: 30 }), 'start-result');
    await attach(peer, naturalTree.session.id);
    await until(() => fs.existsSync(pidFile) && fs.readFileSync(pidFile, 'utf8').trim().split(/\r?\n/).length === 3, 'natural-exit descendants');
    const naturalPids = fs.readFileSync(pidFile, 'utf8').trim().split(/\r?\n/).map(line => {
      assert.match(line, /^(?:root|child|grandchild):\d+$/); return Number(line.split(':')[1]);
    }); fixturePids.push(...naturalPids); assert.ok(naturalPids.every(alive));
    fs.writeFileSync(exitFile, 'owned natural root exit\n', { flag: 'wx' });
    await until(async () => (await bootstrap()).sessions.some(session => session.id === naturalTree.session.id &&
      session.processState === 'exited' && session.exitCode === 7 && session.failureCode === 'STOP_FAILED'), 'natural exit retains cleanup ownership');
    assert.ok(naturalPids.slice(1).some(alive), 'Natural primary exit does not prove detached children exited');
    const naturalLease = await control(peer, naturalTree.session.id);
    await peer.result(peer.request('stop', { sessionId: naturalTree.session.id, leaseId: naturalLease }), 'operation-result', 30000);
    await until(() => naturalPids.every(value => !alive(value)), 'natural root-exit descendants stopped');
    assert.ok(alive(siblingPid) && alive(rootPid));
    fs.unlinkSync(pidFile); fs.unlinkSync(exitFile);
    const treeStart = await peer.result(peer.request('start', { profileId: 'consumer-tree', cols: 100, rows: 30 }), 'start-result');
    await attach(peer, treeStart.session.id);
    await peer.until(() => peer.output.includes('WINDOWS_TREE_READY'), 'tree root ready');
    await until(() => {
      if (!fs.existsSync(pidFile)) return false;
      const lines = fs.readFileSync(pidFile, 'utf8').trim().split(/\r?\n/); if (lines.length !== 3) return false;
      for (const line of lines) { assert.match(line, /^(?:root|child|grandchild):\d+$/); const value = Number(line.split(':')[1]); if (!fixturePids.includes(value)) fixturePids.push(value); }
      return true;
    }, 'detached descendants');
    const treePids = fs.readFileSync(pidFile, 'utf8').trim().split(/\r?\n/).map(line => Number(line.split(':')[1]));
    assert.ok(treePids.every(alive));
    const treeLease = await control(peer, treeStart.session.id);
    const stopping = peer.request('stop', { sessionId: treeStart.session.id, leaseId: treeLease });
    await until(async () => (await bootstrap()).sessions.some(session => session.id === treeStart.session.id && session.stopPending), 'Stop initiated');
    fs.writeFileSync(exitFile, 'owned root exit\n', { flag: 'wx' });
    await peer.result(stopping, 'operation-result', 30000);
    await until(() => treePids.every(value => !alive(value)), 'root-exit descendants stopped');
    const afterTree = await bootstrap();
    assert.equal(afterTree.sessions.find(session => session.id === treeStart.session.id).exitCode, 7);
    assert.equal(afterTree.sessions.find(session => session.id === sibling.session.id).processState, 'running');
    assert.ok(alive(rootPid));
    await attach(peer, id); lease = await control(peer, id);
    await peer.result(peer.request('stop', { sessionId: id, leaseId: lease }), 'operation-result', 30000);
    await until(() => !alive(rootPid), 'native Stop');
    await peer.close(); peer = undefined;
    await ownedHost.stop();
    assert.equal(fs.existsSync(readyFile), false, 'Graceful shutdown removes the owned ready file');
    assert.ok(fixturePids.every(value => !alive(value)), 'All recorded fixture processes exited');
    verifyWindowsFiles(folder, { configured: true });
    const diagnostics = fs.readdirSync(path.join(folder, '.runtime/logs')).map(file => fs.readFileSync(path.join(folder, '.runtime/logs', file), 'utf8')).join('\n');
    assert.match(diagnostics, /host-stop/); assert.doesNotMatch(diagnostics, /HOST_SHUTDOWN_FAILED/);
    await ownedHost.dispose();
    const result = { consumerChecked: true, archive: path.basename(archive), archiveSha256, platform: process.platform, architecture: process.arch,
      kernel: os.release(), version: metadata.version, sourceRevision: metadata.sourceRevision, sourceDirty: metadata.sourceDirty,
      signing: metadata.signing, signingEvidence, nativeCleanup: metadata.nativeCleanup, runtime: 'embedded-node-' + metadata.node,
      checkerRuntime: process.version, freshArtifactOnly: true, files: required.length,
      checks: ['archive-checksum', 'contained-zip', 'file-checksums', 'no-embedded-authenticode', 'no-shipped-catalog', 'relocated-exe', 'system-only-path',
        'setup-no-spawn', 'setup-preservation', 'embedded-assets-and-licenses', 'origin-rejection', 'empty-startup', 'authenticated-native-pty',
        'observer-input-refusal', 'unicode-roundtrip', 'native-resize', 'disconnect-survival', 'observing-reconnect', 'retained-screen',
        'natural-root-exit-retains-cleanup', 'root-exit-during-stop', 'detached-descendant-cleanup', 'sibling-survival', 'native-stop', 'real-console-ctrl-c', 'graceful-host-cleanup',
        'controller-job-before-create', 'suspended-host-ack', 'controller-graceful-disposal'] };
    return result;
  } catch (error) {
    primaryFailure = error;
    if (peer && fixtureSessionId) {
      try {
        const report = path.join(process.cwd(), '.runtime/verification/windows-terminal-fixture.json');
        const received = fs.existsSync(receivedFile) && fs.lstatSync(receivedFile).isFile() && !fs.lstatSync(receivedFile).isSymbolicLink() && fs.statSync(receivedFile).size <= 8192
          ? fs.readFileSync(receivedFile, 'utf8').trimEnd().split(/\r?\n/).map(line => line === '' ? [] : line.split(',').map(Number)) : null;
        if (received && (received.length > 16 || received.some(line => line.length > 256 || line.some(unit => !Number.isInteger(unit) || unit < 0 || unit > 65535)))) throw new Error('WINDOWS_FIXTURE_UNITS_INVALID');
        fs.mkdirSync(path.dirname(report), { recursive: true });
        fs.writeFileSync(report, JSON.stringify({ fixture: 'consumer-terminal', phase: fixturePhase, ...(await peer.fixtureDiagnostics(fixtureSessionId)), receivedUtf16Units: received }, null, 2) + '\n');
      } catch { primaryFailure = new AggregateError([error, new Error('WINDOWS_FIXTURE_DIAGNOSTIC_FAILED')], 'WINDOWS_CONSUMER_FAILED'); }
    }
    throw primaryFailure;
  } finally {
    peer?.socket.terminate();
    try { await peer?.screens.dispose(); }
    catch (error) { primaryFailure = new AggregateError([...(primaryFailure === undefined ? [] : [primaryFailure]), error], 'WINDOWS_FIXTURE_SCREEN_CLEANUP_FAILED'); }
    await cleanupWindowsConsumer(scratch, ownedHost, fixturePids, primaryFailure);
  }
}

if (process.argv[1] && path.basename(process.argv[1]) === 'consumer-windows.mjs' && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  if (process.argv.length !== 3) throw new Error('Usage: node consumer-windows.mjs <archive.zip>');
  const result = await checkWindowsArchive(process.argv[2]);
  const report = path.join(process.cwd(), '.runtime/verification/windows-consumer.json');
  fs.mkdirSync(path.dirname(report), { recursive: true }); fs.writeFileSync(report, JSON.stringify(result, null, 2) + '\n');
  console.log(JSON.stringify(result));
}
