// Artifact-only consumer check. This file uses Node built-ins and the archive's own ws.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import net from 'node:net';
import crypto from 'node:crypto';
import os from 'node:os';
import { createRequire } from 'node:module';
import { spawn, execFileSync } from 'node:child_process';
import { once } from 'node:events';
import { fileURLToPath } from 'node:url';

const pause = ms => new Promise(resolve => setTimeout(resolve, ms));
const hash = bytes => crypto.createHash('sha256').update(bytes).digest('hex');
async function bounded(operation, milliseconds, code) {
  let timer;
  try { return await Promise.race([operation, new Promise((_, reject) => { timer = setTimeout(() => reject(new Error(code)), milliseconds); })]); }
  finally { clearTimeout(timer); }
}

export function verifyConsumerFiles(folder) {
  const manifest = path.join(folder, 'SHA256SUMS');
  assert.ok(fs.lstatSync(manifest).isFile() && !fs.lstatSync(manifest).isSymbolicLink(), 'Regular checksum manifest');
  const seen = new Set();
  for (const line of fs.readFileSync(manifest, 'utf8').trimEnd().split('\n')) {
    const match = /^([a-f0-9]{64})  ([^\0\r\n]+)$/.exec(line);
    if (!match || path.isAbsolute(match[2]) || match[2].includes('\\') ||
      match[2].split('/').some(part => !part || part === '.' || part === '..') || seen.has(match[2])) throw new Error('CONSUMER_MANIFEST_INVALID');
    let file = folder;
    for (const part of match[2].split('/')) {
      file = path.join(file, part);
      if (fs.lstatSync(file).isSymbolicLink()) throw new Error('CONSUMER_PACKAGE_SYMLINK');
    }
    if (!fs.statSync(file).isFile() || hash(fs.readFileSync(file)) !== match[1]) throw new Error('CONSUMER_CHECKSUM_MISMATCH: ' + match[2]);
    seen.add(match[2]);
  }
  for (const required of ['bin/node', 'grotesqueries', 'BUILD-METADATA.json', 'LICENSE', 'THIRD_PARTY_NOTICES.md',
    'node_modules/ws/package.json', 'node_modules/ws/index.js', 'dist/host/server.js', 'dist/host/setup.js']) {
    assert.ok(seen.has(required), 'Required packaged file: ' + required);
  }
  return seen;
}

export function assertPristineConsumerFolder(folder) {
  if (!path.isAbsolute(folder) || !fs.lstatSync(folder).isDirectory() || fs.lstatSync(folder).isSymbolicLink()) throw new Error('CONSUMER_FOLDER_INVALID');
  for (const file of ['config/grotesqueries.json', '.runtime']) {
    if (fs.existsSync(path.join(folder, file))) throw new Error('CONSUMER_REQUIRES_PRISTINE_DISPOSABLE_COPY');
  }
}

async function unusedPort() {
  const server = net.createServer(); server.listen(0, '127.0.0.1'); await once(server, 'listening');
  const port = server.address().port; await new Promise(resolve => server.close(resolve)); return port;
}

class Peer {
  constructor(socket) {
    this.socket = socket; this.frames = []; this.nextRequest = 0; this.output = ''; this.waiters = new Set();
    socket.on('message', data => {
      try {
        const frame = JSON.parse(data.toString()); this.frames.push(frame);
        if (frame.type === 'snapshot-chunk') {
          this.output += frame.data;
          this.send({ type: 'snapshot-applied', sessionId: frame.sessionId, snapshotId: frame.snapshotId,
            chunkIndex: frame.index, parsedBytes: Buffer.byteLength(frame.data) });
        }
        if (frame.type === 'snapshot-end') this.send({ type: 'applied', sessionId: frame.sessionId,
          snapshotId: frame.snapshotId, sequence: frame.sequence });
        if (frame.type === 'output' || frame.type === 'grid') {
          if (frame.type === 'output') this.output += frame.data;
          this.send({ type: 'applied', sessionId: frame.sessionId, sequence: frame.sequence });
        }
      } catch (error) { this.error = error; }
      for (const wake of this.waiters) wake();
    });
    socket.on('error', error => { this.error = error; for (const wake of this.waiters) wake(); });
    socket.on('close', () => { this.closed = true; for (const wake of this.waiters) wake(); });
  }
  send(frame) { this.socket.send(JSON.stringify(frame)); }
  request(type, fields = {}) { const requestId = ++this.nextRequest; this.send({ type, requestId, ...fields }); return requestId; }
  async until(predicate, description, timeout = 10000) {
    const deadline = Date.now() + timeout;
    while (!predicate()) {
      if (this.error) throw this.error;
      if (this.closed) throw new Error('CONSUMER_SOCKET_CLOSED: ' + description);
      if (Date.now() >= deadline) throw new Error('CONSUMER_TIMEOUT: ' + description + '; ' +
        JSON.stringify(this.frames.filter(frame => frame.type === 'error').map(frame => frame.code)));
      await new Promise(resolve => {
        const timer = setTimeout(() => { this.waiters.delete(wake); resolve(); }, 25);
        const wake = () => { clearTimeout(timer); this.waiters.delete(wake); resolve(); }; this.waiters.add(wake);
      });
    }
  }
  async result(requestId, type = 'operation-result') {
    let result;
    await this.until(() => { result = this.frames.find(frame => frame.requestId === requestId && (frame.type === type || frame.type === 'error')); return result; }, 'request ' + requestId);
    if (result.type === 'error') throw new Error('CONSUMER_OPERATION_FAILED: ' + result.code);
    return result;
  }
  async close() {
    if (this.closed) return;
    const closed = once(this.socket, 'close'); this.socket.close(); await closed;
  }
}

/** Run only on a new extracted test copy, with its bundled Node as this process. */
export async function consumerSmoke(folder, { disposable = false } = {}) {
  if (!disposable) throw new Error('CONSUMER_REQUIRES_EXPLICIT_DISPOSABLE_COPY');
  folder = path.resolve(folder); assertPristineConsumerFolder(folder);
  assert.equal(fs.realpathSync(process.execPath), fs.realpathSync(path.join(folder, 'bin/node')), 'Consumer runs the bundled Node');
  const files = verifyConsumerFiles(folder);
  const metadata = JSON.parse(fs.readFileSync(path.join(folder, 'BUILD-METADATA.json'), 'utf8'));
  assert.equal(metadata.platform, process.platform); assert.equal(metadata.architecture, process.arch);
  assert.equal(metadata.node, process.version); assert.equal(metadata.sourceDirty, false, 'Release source must be committed');
  assert.match(metadata.sourceRevision, /^[a-f0-9]{40}$/);
  const require = createRequire(path.join(folder, 'package.json'));
  const wsEntry = require.resolve('ws');
  assert.ok(wsEntry.startsWith(path.join(folder, 'node_modules/ws') + path.sep), 'WebSocket client comes only from this package');
  const WebSocket = require('ws');
  const env = { PATH: '/usr/bin:/bin', NODE_OPTIONS: '', NODE_PATH: '' };
  for (const key of ['HOME', 'USER', 'LOGNAME', 'SHELL', 'LANG', 'LC_ALL', 'LC_CTYPE', 'TMPDIR', 'TEMP', 'TMP']) {
    if (process.env[key] !== undefined) env[key] = process.env[key];
  }
  const launcher = path.join(folder, 'grotesqueries');
  let child, peer;
  try {
    execFileSync(launcher, ['--setup'], { cwd: folder, env, encoding: 'utf8', timeout: 10000 });
    const configFile = path.join(folder, 'config/grotesqueries.json');
    const original = fs.readFileSync(configFile, 'utf8');
    execFileSync(launcher, ['--setup'], { cwd: folder, env, encoding: 'utf8', timeout: 10000 });
    assert.equal(fs.readFileSync(configFile, 'utf8'), original, 'Setup preserves existing configuration');
    const config = JSON.parse(original); config.port = await unusedPort();
    config.launchProfiles = [{ id: 'consumer-fixture', label: 'Consumer fixture', executable: '/bin/sh',
      args: ['-c', 'printf "CONSUMER_READY\\n"; while IFS= read -r line; do printf "CONSUMER_ECHO:%s\\n" "$line"; done'],
      projectDirectory: '.', environment: {} }];
    if (process.platform === 'linux') config.launchProfiles.push({ id: 'consumer-descendants', label: 'Consumer descendants',
      executable: '/bin/sh', args: ['-c', 'trap "" HUP; sleep 30 & child=$!; printf "CONSUMER_DESCENDANT:%s\\n" "$child"; sleep 1; exit 0'],
      projectDirectory: '.', environment: {} });
    fs.writeFileSync(configFile, JSON.stringify(config));
    child = spawn(launcher, [], { cwd: folder, env, stdio: ['ignore', 'pipe', 'pipe'] });
    let errors = ''; child.stderr.on('data', data => { errors = (errors + data).slice(-16384); }); child.stdout.resume();
    const readyFile = path.join(folder, '.runtime/host-ready.json');
    const deadline = Date.now() + 10000;
    while (!fs.existsSync(readyFile)) {
      if (child.exitCode !== null) throw new Error('CONSUMER_HOST_EXITED: ' + child.exitCode + '; ' + errors);
      if (Date.now() >= deadline) throw new Error('CONSUMER_HOST_TIMEOUT: ' + errors);
      await pause(25);
    }
    assert.equal(JSON.parse(fs.readFileSync(readyFile, 'utf8')).pid, child.pid);
    const origin = `http://127.0.0.1:${config.port}`;
    for (const route of ['/', '/assets/app.js', '/assets/app.css', '/licenses', '/grotesqueries.schema.json']) {
      assert.equal((await fetch(origin + route)).status, 200, route);
    }
    assert.match(await fetch(origin + '/licenses').then(response => response.text()), /Apache License/);
    assert.equal((await fetch(origin + '/api/bootstrap', { headers: { Origin: 'https://example.invalid' } })).status, 403);
    const bootstrap = await fetch(origin + '/api/bootstrap').then(response => response.json()); assert.deepEqual(bootstrap.sessions, []);
    const connect = async () => {
      const connected = new Peer(new WebSocket(`ws://127.0.0.1:${config.port}/api/terminal?token=${bootstrap.token}`, { origin }));
      await connected.until(() => connected.frames.some(frame => frame.type === 'hello'), 'hello');
      await connected.result(connected.request('ready', { protocol: bootstrap.protocol, hostInstanceId: bootstrap.hostInstanceId }));
      return connected;
    };
    const attach = async (connected, sessionId) => {
      await connected.result(connected.request('attach', { sessionId }));
      await connected.until(() => connected.frames.some(frame => frame.type === 'snapshot-end' && frame.sessionId === sessionId), 'complete restore');
    };
    const control = async (connected, sessionId) => {
      await connected.result(connected.request('take-control', { sessionId }));
      await connected.until(() => connected.frames.some(frame => frame.type === 'control' && frame.sessionId === sessionId && frame.leaseId), 'control');
      return connected.frames.findLast(frame => frame.type === 'control' && frame.sessionId === sessionId && frame.leaseId).leaseId;
    };
    peer = await connect();
    const started = await peer.result(peer.request('start', { profileId: 'consumer-fixture', cols: 80, rows: 24 }), 'start-result');
    const sessionId = started.session.id;
    await attach(peer, sessionId); await peer.until(() => peer.output.includes('CONSUMER_READY'), 'initial output');
    const lease = await control(peer, sessionId);
    peer.send({ type: 'input', sessionId, leaseId: lease, inputId: 1, data: 'Unicode-✓-世界\r' });
    await peer.until(() => peer.output.includes('CONSUMER_ECHO:Unicode-✓-世界'), 'Unicode roundtrip');
    await peer.result(peer.request('resize', { sessionId, leaseId: lease, cols: 100, rows: 30 }));
    await peer.close(); peer = undefined;
    const inventory = await fetch(origin + '/api/bootstrap').then(response => response.json());
    assert.equal(inventory.sessions.length, 1); assert.equal(inventory.sessions[0].id, sessionId);
    assert.equal(inventory.sessions[0].processState, 'running');
    peer = await connect(); await attach(peer, sessionId);
    await peer.until(() => peer.output.includes('CONSUMER_ECHO:Unicode-✓-世界'), 'restored native output');
    assert.ok(!peer.frames.some(frame => frame.type === 'control' && frame.leaseId), 'Reconnect only observes');
    const nextLease = await control(peer, sessionId); assert.notEqual(nextLease, lease);
    peer.send({ type: 'input', sessionId, leaseId: nextLease, inputId: 1, data: 'reconnect\r' });
    await peer.until(() => peer.output.includes('CONSUMER_ECHO:reconnect'), 'same native process after reconnect');
    const sibling = await peer.result(peer.request('start', { profileId: 'consumer-fixture', cols: 80, rows: 24 }), 'start-result');
    await peer.result(peer.request('stop', { sessionId, leaseId: nextLease }));
    await peer.until(() => peer.frames.some(frame => frame.type === 'session' && frame.session.id === sessionId &&
      frame.session.processState === 'exited' && !frame.session.stopPending && frame.session.failureCode !== 'STOP_FAILED'), 'verified Stop');
    const afterStop = await fetch(origin + '/api/bootstrap').then(response => response.json());
    assert.equal(afterStop.sessions.find(session => session.id === sibling.session.id).processState, 'running', 'Stop leaves sibling alive');
    await peer.close(); peer = undefined;
    peer = await connect(); await attach(peer, sessionId);
    await peer.until(() => peer.output.includes('CONSUMER_ECHO:reconnect'), 'retained terminal output after Stop');
    if (process.platform === 'linux') {
      const descendant = await peer.result(peer.request('start', { profileId: 'consumer-descendants', cols: 80, rows: 24 }), 'start-result');
      const descendantId = descendant.session.id;
      await attach(peer, descendantId);
      await peer.until(() => /CONSUMER_DESCENDANT:\d+/.test(peer.output), 'descendant fixture identity');
      const pid = Number(/CONSUMER_DESCENDANT:(\d+)/.exec(peer.output)[1]);
      await peer.until(() => peer.frames.some(frame => frame.type === 'session' && frame.session.id === descendantId &&
        frame.session.processState === 'exited' && frame.session.failureCode === 'STOP_FAILED'), 'root-exited ownership retained');
      const cleanupLease = await control(peer, descendantId);
      await peer.result(peer.request('stop', { sessionId: descendantId, leaseId: cleanupLease }));
      await peer.until(() => peer.frames.some(frame => frame.type === 'session' && frame.session.id === descendantId &&
        frame.session.processState === 'exited' && !frame.session.stopPending && frame.session.failureCode !== 'STOP_FAILED'), 'adopted descendant cleanup');
      assert.throws(() => process.kill(pid, 0), error => error.code === 'ESRCH', 'Verified descendant was reaped');
    }
    await peer.close(); peer = undefined;
    const exited = once(child, 'exit'); child.kill('SIGTERM');
    const shutdown = await bounded(exited, 15000, 'CONSUMER_SHUTDOWN_TIMEOUT');
    assert.equal(shutdown[0], 0, 'Host shutdown verifies remaining native session cleanup');
    assert.equal(fs.existsSync(readyFile), false); verifyConsumerFiles(folder);
    const report = process.report.getReport();
    const result = { consumerChecked: true, platform: process.platform, architecture: process.arch, kernel: os.release(),
      uid: process.getuid?.(), node: process.version, nodeExecutable: 'package/bin/node', websocketRuntime: 'package/node_modules/ws',
      glibc: report.header.glibcVersionRuntime ?? null, sourceRevision: metadata.sourceRevision,
      sourceDirty: metadata.sourceDirty, signing: metadata.signing, nativeCleanup: metadata.nativeCleanup,
      files: files.size, checks: ['file-checksums', 'bundled-node', 'package-only-dependencies', 'setup-preservation',
        'assets-and-licenses', 'origin-rejection', 'authenticated-native-pty', 'unicode-input', 'resize',
        'disconnect-survival', 'observing-reconnect', 'native-stop', 'retained-final-output', 'sibling-survival',
        ...(process.platform === 'linux' ? ['root-exited-descendant-cleanup'] : []), 'host-shutdown'] };
    console.log(JSON.stringify(result)); return result;
  } finally {
    peer?.socket.terminate();
    if (child && child.exitCode === null && child.signalCode === null) {
      const exited = once(child, 'exit'); child.kill('SIGTERM');
      await bounded(exited, 15000, 'CONSUMER_CLEANUP_UNVERIFIED');
    }
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  if (process.argv.length !== 4 || process.argv[3] !== '--disposable') throw new Error('Usage: package/bin/node consumer-smoke.mjs <pristine-extracted-package> --disposable');
  await consumerSmoke(process.argv[2], { disposable: true });
}
