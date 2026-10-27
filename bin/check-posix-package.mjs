import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import net from 'node:net';
import crypto from 'node:crypto';
import { spawn, execFileSync } from 'node:child_process';
import { once } from 'node:events';
import { fileURLToPath } from 'node:url';
import WebSocket from 'ws';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const pause = ms => new Promise(resolve => setTimeout(resolve, ms));
const hash = bytes => crypto.createHash('sha256').update(bytes).digest('hex');

export function verifyPackageFiles(folder) {
  const manifestFile = path.join(folder, 'SHA256SUMS');
  if (!fs.lstatSync(manifestFile).isFile() || fs.lstatSync(manifestFile).isSymbolicLink()) throw new Error('PACKAGE_MANIFEST_SYMLINK');
  const manifest = fs.readFileSync(manifestFile, 'utf8');
  const seen = new Set();
  for (const line of manifest.trimEnd().split('\n')) {
    const match = /^([a-f0-9]{64})  ([^\0\r\n]+)$/.exec(line);
    if (!match || path.isAbsolute(match[2]) || match[2].includes('\\') || match[2].split('/').some(part => !part || part === '.' || part === '..') || seen.has(match[2])) throw new Error('PACKAGE_MANIFEST_INVALID');
    seen.add(match[2]);
    let file = folder;
    for (const part of match[2].split('/')) { file = path.join(file, part); if (fs.lstatSync(file).isSymbolicLink()) throw new Error('PACKAGE_MANIFEST_SYMLINK'); }
    if (!fs.statSync(file).isFile() || hash(fs.readFileSync(file)) !== match[1]) throw new Error(`PACKAGE_CHECKSUM_MISMATCH: ${match[2]}`);
  }
  if (!seen.size) throw new Error('PACKAGE_MANIFEST_EMPTY');
  return seen;
}

async function unusedPort() {
  const server = net.createServer(); server.listen(0, '127.0.0.1'); await once(server, 'listening');
  const port = server.address().port; await new Promise(resolve => server.close(resolve)); return port;
}

class Peer {
  constructor(socket) {
    this.socket = socket; this.frames = []; this.nextRequest = 0; this.output = ''; this.waiters = new Set();
    socket.on('message', data => {
      const frame = JSON.parse(data.toString()); this.frames.push(frame);
      if (frame.type === 'snapshot-chunk') { this.output += frame.data; this.send({ type: 'snapshot-applied', sessionId: frame.sessionId,
        snapshotId: frame.snapshotId, chunkIndex: frame.index, parsedBytes: Buffer.byteLength(frame.data) }); }
      if (frame.type === 'snapshot-end') this.send({ type: 'applied', sessionId: frame.sessionId, snapshotId: frame.snapshotId, sequence: frame.sequence });
      if (frame.type === 'output' || frame.type === 'grid') {
        if (frame.type === 'output') this.output += frame.data;
        this.send({ type: 'applied', sessionId: frame.sessionId, sequence: frame.sequence });
      }
      for (const wake of this.waiters) wake();
    });
    socket.on('error', error => { this.error = error; for (const wake of this.waiters) wake(); });
  }
  send(frame) { this.socket.send(JSON.stringify(frame)); }
  request(type, fields = {}) { const requestId = ++this.nextRequest; this.send({ type, requestId, ...fields }); return requestId; }
  async until(predicate, description, timeout = 8000) {
    const deadline = Date.now() + timeout;
    while (!predicate()) {
      if (this.error) throw this.error;
      if (Date.now() >= deadline) throw new Error(`PACKAGE_WS_TIMEOUT: ${description}; ${JSON.stringify(this.frames.filter(frame => frame.type === 'error'))}`);
      await new Promise(resolve => {
        const timer = setTimeout(() => { this.waiters.delete(wake); resolve(); }, 25);
        const wake = () => { clearTimeout(timer); this.waiters.delete(wake); resolve(); }; this.waiters.add(wake);
      });
    }
  }
  async result(requestId, type = 'operation-result') {
    let result;
    await this.until(() => { result = this.frames.find(frame => frame.requestId === requestId && (frame.type === type || frame.type === 'error')); return result; }, `request ${requestId}`);
    if (result.type === 'error') throw new Error(`PACKAGE_OPERATION_FAILED: ${result.code}: ${result.message}`);
    return result;
  }
}

/** Verify the actual archive and run its relocated bundled runtime and native terminal. */
export async function checkPosixPackage(archive) {
  if (!['darwin', 'linux'].includes(process.platform)) throw new Error('POSIX_PACKAGE_CHECK_UNSUPPORTED');
  archive = path.resolve(archive);
  const expected = fs.readFileSync(archive + '.sha256', 'utf8').trim();
  assert.equal(expected, `${hash(fs.readFileSync(archive))}  ${path.basename(archive)}`, 'Archive checksum');
  const tarEnvironment = { ...process.env, TAR_OPTIONS: '', COPYFILE_DISABLE: '1' };
  const entries = execFileSync('/usr/bin/tar', ['-tzf', archive], { encoding: 'utf8', env: tarEnvironment, maxBuffer: 4 * 1024 * 1024 }).trim().split('\n');
  const top = entries[0].replace(/\/$/, '');
  assert.match(top, /^grotesqueries-\d+\.\d+\.\d+(?:-[a-zA-Z0-9.-]+)?-(?:darwin|linux)-(?:arm64|x64)$/);
  assert.ok(entries.every(entry => /^[A-Za-z0-9._/-]+$/.test(entry) && !entry.startsWith('/') && entry.split('/').every(part => part !== '..') && entry.startsWith(top + '/')), 'Archive has one contained root');
  const detail = execFileSync('/usr/bin/tar', ['-tvzf', archive], { encoding: 'utf8', env: tarEnvironment, maxBuffer: 4 * 1024 * 1024 }).trim().split('\n');
  assert.ok(detail.length === entries.length && detail.every(line => /^[-d]/.test(line)), 'Archive contains only regular files and directories');
  const temporary = path.join(root, '.runtime', 'tmp'); fs.mkdirSync(temporary, { recursive: true });
  const scratch = fs.mkdtempSync(path.join(temporary, 'posix-package-'));
  let child, peer;
  let preserveScratch = false;
  try {
    execFileSync('/usr/bin/tar', ['-xzf', archive, '-C', scratch], { env: tarEnvironment });
    const folder = path.join(scratch, top), launcher = path.join(folder, 'grotesqueries');
    const files = verifyPackageFiles(folder);
    const build = JSON.parse(fs.readFileSync(path.join(folder, 'BUILD-METADATA.json'), 'utf8'));
    assert.equal(build.platform, process.platform); assert.equal(build.architecture, process.arch);
    assert.equal(build.node, 'v24.14.1');
    assert.ok(files.has('bin/node')); assert.ok(files.has('LICENSE')); assert.ok(files.has('THIRD_PARTY_NOTICES.md'));
    assert.ok(![...files].some(file => file.includes('/.cache/') || file.includes('/.git/') || file.includes('prebuilds/') && !file.includes(`prebuilds/${process.platform}-${process.arch}/`)));
    const env = { ...process.env, PATH: '/usr/bin:/bin', NODE_PATH: '', NODE_OPTIONS: '' };
    for (const key of ['GROTESQUERIES_CONFIG', 'GROTESQUERIES_LAUNCHER_PID', 'ENV', 'BASH_ENV', 'ZDOTDIR']) delete env[key];
    execFileSync(launcher, ['--setup'], { cwd: scratch, env, encoding: 'utf8', timeout: 10000 });
    const configFile = path.join(folder, 'config', 'grotesqueries.json');
    const original = fs.readFileSync(configFile, 'utf8');
    execFileSync(launcher, ['--setup'], { cwd: scratch, env, encoding: 'utf8', timeout: 10000 });
    assert.equal(fs.readFileSync(configFile, 'utf8'), original, 'Setup preserves the operator file');
    const config = JSON.parse(original); config.port = await unusedPort();
    config.launchProfiles = [{ id: 'package-fixture', label: 'Package fixture', executable: '/bin/sh',
      args: ['-c', 'printf "PACKAGE_READY\\n"; while IFS= read -r line; do printf "PACKAGE_ECHO:%s\\n" "$line"; done'], projectDirectory: '.', environment: {} }];
    fs.writeFileSync(configFile, JSON.stringify(config));
    child = spawn(launcher, [], { cwd: scratch, env, stdio: ['ignore', 'pipe', 'pipe'] });
    let errors = ''; child.stderr.on('data', data => { errors = (errors + data).slice(-32768); }); child.stdout.resume();
    const readyFile = path.join(folder, '.runtime', 'host-ready.json');
    const deadline = Date.now() + 10000;
    while (!fs.existsSync(readyFile)) {
      if (child.exitCode !== null) throw new Error(`PACKAGE_HOST_EXITED: ${child.exitCode}; ${errors}`);
      if (Date.now() >= deadline) throw new Error(`PACKAGE_HOST_TIMEOUT: ${errors}`);
      await pause(25);
    }
    const origin = `http://127.0.0.1:${config.port}`;
    const ready = JSON.parse(fs.readFileSync(readyFile, 'utf8')); assert.equal(ready.pid, child.pid);
    for (const route of ['/', '/assets/app.js', '/assets/app.css', '/licenses', '/grotesqueries.schema.json']) assert.equal((await fetch(origin + route)).status, 200, route);
    const licenses = await fetch(origin + '/licenses').then(response => response.text()); assert.match(licenses, /Apache License/);
    const bootstrap = await fetch(origin + '/api/bootstrap').then(response => response.json()); assert.deepEqual(bootstrap.sessions, []);
    assert.equal((await fetch(origin + '/api/bootstrap', { headers: { Origin: 'https://example.invalid' } })).status, 403);
    let socket = new WebSocket(`ws://127.0.0.1:${config.port}/api/terminal?token=${bootstrap.token}`, { origin });
    peer = new Peer(socket);
    await peer.until(() => peer.frames.some(frame => frame.type === 'hello'), 'hello');
    await peer.result(peer.request('ready', { protocol: bootstrap.protocol, hostInstanceId: bootstrap.hostInstanceId }));
    const started = await peer.result(peer.request('start', { profileId: 'package-fixture', cols: 80, rows: 24 }), 'start-result');
    const sessionId = started.session.id;
    await peer.result(peer.request('attach', { sessionId }));
    await peer.until(() => peer.output.includes('PACKAGE_READY'), 'native initial output');
    await peer.until(() => peer.frames.some(frame => frame.type === 'snapshot-end' && frame.sessionId === sessionId), 'initial restore completion');
    await peer.result(peer.request('take-control', { sessionId }));
    await peer.until(() => peer.frames.some(frame => frame.type === 'control' && frame.sessionId === sessionId && frame.leaseId), 'control lease');
    let lease = peer.frames.findLast(frame => frame.type === 'control' && frame.sessionId === sessionId && frame.leaseId).leaseId;
    peer.send({ type: 'input', sessionId, leaseId: lease, inputId: 1, data: 'packaged-roundtrip\r' });
    await peer.until(() => peer.output.includes('PACKAGE_ECHO:packaged-roundtrip'), 'bundled native PTY input/output');
    await peer.result(peer.request('resize', { sessionId, leaseId: lease, cols: 100, rows: 30 }));
    socket.close(); await once(socket, 'close'); peer = undefined;
    const afterDisconnect = await fetch(origin + '/api/bootstrap').then(response => response.json());
    assert.equal(afterDisconnect.sessions.length, 1);
    assert.equal(afterDisconnect.sessions[0].id, sessionId);
    assert.equal(afterDisconnect.sessions[0].processState, 'running');
    socket = new WebSocket(`ws://127.0.0.1:${config.port}/api/terminal?token=${bootstrap.token}`, { origin });
    peer = new Peer(socket);
    await peer.until(() => peer.frames.some(frame => frame.type === 'hello'), 'reconnect hello');
    await peer.result(peer.request('ready', { protocol: bootstrap.protocol, hostInstanceId: bootstrap.hostInstanceId }));
    await peer.result(peer.request('attach', { sessionId }));
    await peer.until(() => peer.output.includes('PACKAGE_ECHO:packaged-roundtrip'), 'restored existing native session');
    await peer.until(() => peer.frames.some(frame => frame.type === 'snapshot-end' && frame.sessionId === sessionId), 'reconnect restore completion');
    assert.ok(!peer.frames.some(frame => frame.type === 'control' && frame.leaseId), 'Reconnection only observes');
    await peer.result(peer.request('take-control', { sessionId }));
    await peer.until(() => peer.frames.some(frame => frame.type === 'control' && frame.sessionId === sessionId && frame.leaseId), 'new control lease');
    const previousLease = lease;
    lease = peer.frames.findLast(frame => frame.type === 'control' && frame.sessionId === sessionId && frame.leaseId).leaseId;
    assert.notEqual(lease, previousLease);
    peer.send({ type: 'input', sessionId, leaseId: lease, inputId: 1, data: 'reconnected-roundtrip\r' });
    await peer.until(() => peer.output.includes('PACKAGE_ECHO:reconnected-roundtrip'), 'same native session after reconnect');
    await peer.result(peer.request('stop', { sessionId, leaseId: lease }));
    await peer.until(() => peer.frames.some(frame => frame.type === 'session' && frame.session.id === sessionId && frame.session.processState === 'exited' && !frame.session.stopPending && frame.session.failureCode !== 'STOP_FAILED'), 'verified native Stop');
    socket.close(); await once(socket, 'close'); peer = undefined;
    const exited = once(child, 'exit'); child.kill('SIGTERM'); assert.equal((await exited)[0], 0);
    assert.equal(fs.existsSync(readyFile), false, 'Shutdown removes its ready file');
    verifyPackageFiles(folder);
    const result = { archive, platform: process.platform, architecture: process.arch, files: files.size,
      checks: ['archive-checksum', 'file-checksums', 'relocation', 'bundled-node', 'setup-preservation', 'assets-and-licenses', 'origin-check', 'authenticated-native-pty', 'controlled-input', 'resize', 'disconnect-survival', 'observing-reconnect', 'native-stop', 'host-shutdown'] };
    console.log(JSON.stringify({ packageChecked: true, ...result }));
    return result;
  } finally {
    peer?.socket.terminate();
    if (child && child.exitCode === null && child.signalCode === null) {
      const exited = once(child, 'exit'); child.kill('SIGTERM');
      let timer;
      try {
        await Promise.race([exited, new Promise((_, reject) => { timer = setTimeout(() => reject(new Error('PACKAGE_CLEANUP_UNVERIFIED')), 15000); })]);
      } catch (error) {
        preserveScratch = true;
        console.error(`Package cleanup needs recovery; preserved owned fixture at ${scratch}`);
        throw error;
      } finally { clearTimeout(timer); }
    }
    if (!preserveScratch) fs.rmSync(scratch, { recursive: true, force: true });
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const version = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8')).version;
  await checkPosixPackage(process.argv[2] ?? path.join(root, 'dist', 'posix', `grotesqueries-${version}-${process.platform}-${process.arch}.tar.gz`));
}
