import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import net from 'node:net';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import test from 'node:test';
import WebSocket from 'ws';
import { PROTOCOL_VERSION } from '@grotesqueries/protocol';

const root = process.cwd();
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
async function port() {
  const server = net.createServer(); server.listen(0, '127.0.0.1'); await once(server, 'listening');
  const value = server.address().port; await new Promise(resolve => server.close(resolve)); return value;
}

test('relocated source host serves the frame and enforces access checks', { timeout: 20000 }, async () => {
  const tmp = path.join(root, '.runtime', 'tmp'); fs.mkdirSync(tmp, { recursive: true });
  const folder = fs.mkdtempSync(path.join(tmp, 'portable-host-'));
  let child, socket;
  try {
    for (const directory of ['dist/host', 'public', 'frame/dist']) fs.cpSync(path.join(root, directory), path.join(folder, directory), { recursive: true });
    fs.writeFileSync(path.join(folder, 'package.json'), '{"type":"module"}\n');
    fs.mkdirSync(path.join(folder, 'config'));
    const config = JSON.parse(fs.readFileSync(path.join(root, 'config/preview.json'), 'utf8'));
    config.port = await port(); config.frame = '../frame/dist';
    fs.writeFileSync(path.join(folder, 'config/grotesqueries.json'), JSON.stringify(config));
    child = spawn(process.execPath, [path.join(folder, 'dist/host/server.js')], {
      cwd: root, env: { ...process.env, GROTESQUERIES_CONFIG: '', GROTESQUERIES_LAUNCHER_PID: '' }, stdio: ['ignore', 'pipe', 'pipe'] });
    const [invalidCode] = await once(child, 'exit');
    assert.notEqual(invalidCode, 0, 'An empty configuration override must fail closed');
    const env = { ...process.env }; delete env.GROTESQUERIES_CONFIG; delete env.GROTESQUERIES_LAUNCHER_PID;
    child = spawn(process.execPath, [path.join(folder, 'dist/host/server.js')], { cwd: root, env, stdio: ['ignore', 'pipe', 'pipe'] });
    let errors = ''; child.stderr.on('data', chunk => { errors += chunk; }); child.stdout.resume();
    const ready = path.join(folder, '.runtime/host-ready.json');
    const deadline = Date.now() + 8000;
    while (!fs.existsSync(ready)) {
      assert.equal(child.exitCode, null, errors); assert.ok(Date.now() < deadline, 'Host did not become ready: ' + errors); await delay(25);
    }
    const record = JSON.parse(fs.readFileSync(ready, 'utf8'));
    assert.equal(record.pid, child.pid); assert.deepEqual(record.pids, [child.pid]);
    const origin = `http://127.0.0.1:${config.port}`;
    const bootstrap = await fetch(origin + '/api/bootstrap').then(response => response.json());
    assert.equal(bootstrap.protocol, PROTOCOL_VERSION); assert.deepEqual(bootstrap.sessions, []);
    for (const route of ['/', '/assets/app.js', '/assets/app.css', '/licenses', '/grotesqueries.schema.json']) {
      assert.equal((await fetch(origin + route)).status, 200, route);
    }
    const version = await fetch(origin + '/version.json').then(response => response.json());
    assert.equal(version.platform, process.platform); assert.equal(version.architecture, process.arch);
    assert.equal((await fetch(origin + '/api/bootstrap', { headers: { Origin: 'https://example.invalid' } })).status, 403);
    assert.equal((await fetch(origin + '/api/settings')).status, 403);
    await new Promise((resolve, reject) => {
      const unauthorized = new WebSocket(`ws://127.0.0.1:${config.port}/api/terminal`, { origin });
      unauthorized.once('unexpected-response', (_request, response) => {
        try { assert.equal(response.statusCode, 403); unauthorized.terminate(); resolve(); } catch (error) { reject(error); }
      });
      unauthorized.on('error', () => {});
      unauthorized.once('open', () => { unauthorized.terminate(); reject(new Error('Unauthenticated socket opened')); });
    });
    socket = new WebSocket(`ws://127.0.0.1:${config.port}/api/terminal?token=${bootstrap.token}`, { origin });
    await new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('WebSocket boundary check timed out')), 5000);
      socket.on('error', error => { clearTimeout(timer); reject(error); });
      socket.on('message', data => {
        try {
          const message = JSON.parse(data.toString());
          if (message.type === 'hello') socket.send(JSON.stringify({ type: 'ready', requestId: 1,
            protocol: bootstrap.protocol, hostInstanceId: bootstrap.hostInstanceId }));
          if (message.type === 'operation-result' && message.operation === 'ready') socket.send(JSON.stringify({ type: 'attach', requestId: 2, sessionId: '00000000-0000-4000-8000-000000000000' }));
          if (message.type === 'error' && message.requestId === 2) {
            assert.equal(message.code, 'SESSION_UNAVAILABLE');
            clearTimeout(timer); resolve();
          }
        } catch (error) { clearTimeout(timer); reject(error); }
      });
    });
    assert.equal((await fetch(origin + '/health').then(response => response.json())).sessions, 0);
    socket.close(); await once(socket, 'close'); socket = undefined;
    const exited = once(child, 'exit'); child.kill('SIGTERM'); const [code] = await exited;
    if (process.platform !== 'win32') { assert.equal(code, 0); assert.equal(fs.existsSync(ready), false); }
  } finally {
    socket?.terminate();
    if (child && child.exitCode === null && child.signalCode === null) { const exited = once(child, 'exit'); child.kill('SIGTERM'); await exited; }
    fs.rmSync(folder, { recursive: true, force: true });
  }
});

test('preview creates its own configuration once and preserves operator and saved settings', { skip: process.platform === 'win32', timeout: 20000 }, async () => {
  const tmp = path.join(root, '.runtime', 'tmp'); fs.mkdirSync(tmp, { recursive: true });
  const folder = fs.mkdtempSync(path.join(tmp, 'portable-preview-'));
  let child;
  try {
    for (const directory of ['dist/host', 'public', 'frame/dist']) fs.cpSync(path.join(root, directory), path.join(folder, directory), { recursive: true });
    for (const name of ['bin/build.mjs', 'bin/native-build.mjs', 'bin/licenses.mjs', 'bin/runtime.mjs', 'bin/start.mjs', 'bin/preview.mjs', 'lib/local-web/runtime.ts']) {
      const target = path.join(folder, name); fs.mkdirSync(path.dirname(target), { recursive: true }); fs.copyFileSync(path.join(root, name), target);
    }
    fs.mkdirSync(path.join(folder, 'config'));
    fs.writeFileSync(path.join(folder, 'package.json'), '{"type":"module"}\n');
    const operator = '{"operatorSentinel":"preserve"}\n';
    fs.writeFileSync(path.join(folder, 'config/grotesqueries.json'), operator);
    const config = JSON.parse(fs.readFileSync(path.join(root, 'config/preview.json'), 'utf8')); config.port = await port();
    fs.writeFileSync(path.join(folder, 'config/preview.json'), JSON.stringify(config));
    const ready = path.join(folder, '.runtime/host-ready.json');
    const savedFile = path.join(folder, '.runtime/preview/grotesqueries.json');
    const env = { ...process.env }; delete env.GROTESQUERIES_CONFIG;
    for (let run = 0; run < 2; run++) {
      child = spawn(process.execPath, [path.join(folder, 'bin/preview.mjs')], { cwd: root, env, stdio: ['ignore', 'pipe', 'pipe'] });
      let errors = ''; child.stderr.on('data', chunk => { errors += chunk; }); child.stdout.resume();
      const deadline = Date.now() + 8000;
      while (!fs.existsSync(ready)) {
        assert.equal(child.exitCode, null, errors); assert.ok(Date.now() < deadline, errors || 'Preview startup timed out'); await delay(25);
      }
      const record = JSON.parse(fs.readFileSync(ready, 'utf8'));
      assert.ok(record.pids.includes(child.pid));
      assert.equal(record.url, `http://127.0.0.1:${config.port}`);
      const saved = JSON.parse(fs.readFileSync(savedFile, 'utf8'));
      assert.deepEqual(saved.launchProfiles, []);
      assert.equal(saved.terminal.scrollbackLines, run ? 1234 : config.terminal.scrollbackLines);
      assert.equal(fs.readFileSync(path.join(folder, 'config/grotesqueries.json'), 'utf8'), operator);
      const exited = once(child, 'exit'); child.kill('SIGTERM'); assert.equal((await exited)[0], 0);
      assert.equal(fs.existsSync(ready), false);
      if (!run) { saved.terminal.scrollbackLines = 1234; fs.writeFileSync(savedFile, JSON.stringify(saved)); }
    }
  } finally {
    if (child && child.exitCode === null && child.signalCode === null) { const exited = once(child, 'exit'); child.kill('SIGTERM'); await exited; }
    fs.rmSync(folder, { recursive: true, force: true });
  }
});
