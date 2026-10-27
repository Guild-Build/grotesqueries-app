import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import net from 'node:net';
import { createRequire } from 'node:module';
import { execFileSync, spawn, spawnSync } from 'node:child_process';
import test from 'node:test';
import { startLinuxPty } from '../../app/services/linux-pty.js';
import type { PtyHandle } from '../../app/services/pty.js';
import type { LaunchProfile } from '@grotesqueries/protocol';
import { scratchDirectory } from '../support/scratch.js';

const root = process.cwd();
const skip = process.platform !== 'linux';
const delay = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));
async function until(predicate: () => boolean, description: string): Promise<void> {
  const deadline = Date.now() + 8000;
  while (!predicate()) { if (Date.now() >= deadline) throw new Error(`Timed out: ${description}`); await delay(15); }
}
function profile(directory: string, executable: string, args: string[]): LaunchProfile {
  return { id: 'linux-fixture', label: 'Linux fixture', executable, args, projectDirectory: directory, environment: {} };
}
async function launch(directory: string, executable: string, args: string[], identity: string) {
  const pty = await startLinuxPty(root, profile(directory, executable, args), 100, 30, identity);
  let output = '';
  let exit: { code: number; cleanupRequired?: boolean } | undefined;
  pty.onOutput(data => { output += data; });
  pty.onExit((code, cleanupRequired) => { exit = { code, cleanupRequired }; });
  return { pty, output: () => output, exit: () => exit };
}
async function stop(pty: PtyHandle): Promise<void> { await pty.stop(); }
function alive(pid: number): boolean {
  try { return fs.readFileSync(`/proc/${pid}/stat`, 'utf8').split(') ')[1].split(' ')[0] !== 'Z'; }
  catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return false; throw error; }
}

test('Linux PTY carries Unicode, input, resize and final output before its exit callback', { skip, timeout: 15000 }, async () => {
  const directory = scratchDirectory('linux-echo-');
  const shell = "printf 'READY λ中🙂\\n'; while IFS= read -r value; do case \"$value\" in grid) stty size;; quit) printf 'FINAL-MARKER\\n'; exit 7;; *) printf 'ECHO:%s\\n' \"$value\";; esac; done";
  const fixture = await launch(directory, '/bin/sh', ['-c', shell], 'unicode');
  try {
    await until(() => fixture.output().includes('READY λ中🙂'), 'Unicode readiness');
    fixture.pty.write('hello\r'); await until(() => fixture.output().includes('ECHO:hello'), 'input echo');
    fixture.pty.resize(82, 23); fixture.pty.write('grid\r');
    await until(() => fixture.output().includes('23 82'), 'native resize');
    fixture.pty.write('quit\r'); await until(() => fixture.exit() !== undefined, 'natural exit');
    assert.equal(fixture.exit()!.code, 7); assert.equal(fixture.exit()!.cleanupRequired, false);
    assert.ok(fixture.output().includes('FINAL-MARKER'));
    const result = await fixture.pty.stop(); assert.equal(result.exitCode, 7);
    assert.ok(result.verifiedPids.includes(fixture.pty.pid)); assert.equal(result.cleanupScope, undefined);
  } finally { await stop(fixture.pty); }
});

test('Linux silent startup accepts input and immediate exit retains its final marker', { skip, timeout: 15000 }, async () => {
  const directory = scratchDirectory('linux-silent-');
  const fixture = await launch(directory, process.execPath,
    ['-e', "process.stdin.setRawMode(true);process.stdin.on('data',()=>process.stdout.write('SILENT-ACK\\n'));setInterval(()=>{},1000)"], 'silent');
  try {
    assert.ok(fixture.pty.pid > 1); fixture.pty.write('x');
    await until(() => fixture.output().includes('SILENT-ACK'), 'silent input acknowledgement');
    assert.equal((await fixture.pty.stop()).exitCode, 137);
  } finally { await stop(fixture.pty); }
  const immediate = await launch(directory, '/bin/sh', ['-c', "printf 'IMMEDIATE-FINAL\\n'; exit 11"], 'immediate');
  try {
    await until(() => immediate.exit() !== undefined, 'immediate exit');
    assert.equal(immediate.exit()!.code, 11); assert.ok(immediate.output().includes('IMMEDIATE-FINAL'));
  } finally { await stop(immediate.pty); }
});

test('Linux subreaper cleans children and grandchildren while preserving an unrelated sibling', { skip, timeout: 15000 }, async () => {
  const directory = scratchDirectory('linux-tree-');
  const childSource = "const {spawn}=require('node:child_process');const c=spawn(process.execPath,['-e','setInterval(()=>{},1000)'],{stdio:'ignore'});console.log('GRANDCHILD:'+c.pid);setInterval(()=>{},1000)";
  const source = `const {spawn}=require('node:child_process');const c=spawn(process.execPath,['-e',${JSON.stringify(childSource)}],{stdio:['ignore',1,2]});console.log('CHILD:'+c.pid);setInterval(()=>{},1000)`;
  const fixture = await launch(directory, process.execPath, ['-e', source], 'tree');
  const sibling = spawn(process.execPath, ['-e', 'setInterval(()=>{},1000)'], { stdio: 'ignore' });
  try {
    await until(() => /GRANDCHILD:\d+/.test(fixture.output()), 'grandchild creation');
    const child = Number(/CHILD:(\d+)/.exec(fixture.output())![1]);
    const grandchild = Number(/GRANDCHILD:(\d+)/.exec(fixture.output())![1]);
    const result = await fixture.pty.stop();
    for (const pid of [child, grandchild]) { assert.ok(result.verifiedPids.includes(pid)); assert.equal(alive(pid), false); }
    assert.equal(alive(fixture.pty.pid), false); assert.equal(alive(sibling.pid!), true);
  } finally {
    await stop(fixture.pty); const exited = new Promise(resolve => sibling.once('exit', resolve)); sibling.kill('SIGTERM'); await exited;
  }
});

test('Linux retains root-exited ownership and adopts rapid double-forked setsid descendants', { skip, timeout: 15000 }, async () => {
  const directory = scratchDirectory('linux-detached-'); const marker = path.join(directory, 'daemon.pid');
  const daemon = `require('node:fs').writeFileSync(${JSON.stringify(marker)},String(process.pid));setInterval(()=>{},1000)`;
  const middle = `const c=require('node:child_process').spawn(process.execPath,['-e',${JSON.stringify(daemon)}],{detached:true,stdio:'ignore'});c.unref()`;
  const source = `const c=require('node:child_process').spawn(process.execPath,['-e',${JSON.stringify(middle)}],{detached:true,stdio:'ignore'});c.unref();console.log('ROOT-FINAL');process.exit(9)`;
  const fixture = await launch(directory, process.execPath, ['-e', source], 'detached');
  try {
    await until(() => fixture.exit() !== undefined && fs.existsSync(marker), 'root exit and detached daemon');
    const daemonPid = Number(fs.readFileSync(marker, 'utf8'));
    assert.equal(fixture.exit()!.code, 9); assert.equal(fixture.exit()!.cleanupRequired, true);
    assert.equal(alive(daemonPid), true); assert.equal(alive(fixture.pty.pid), true);
    assert.throws(() => fixture.pty.write('ignored'), /SESSION_EXITED/);
    const result = await fixture.pty.stop();
    assert.equal(result.exitCode, 9); assert.ok(result.verifiedPids.includes(daemonPid));
    assert.equal(alive(daemonPid), false); assert.equal(alive(fixture.pty.pid), false);
    assert.ok(fixture.output().includes('ROOT-FINAL'));
  } finally { await stop(fixture.pty); }
});

test('Linux Stop failure retains its supervisor and permits deliberate retry', {
  skip: skip || spawnSync('prlimit', ['--version'], { stdio: 'ignore' }).status !== 0, timeout: 15000,
}, async () => {
  const directory = scratchDirectory('linux-retry-');
  const fixture = await launch(directory, process.execPath, ['-e', "console.log('READY');setInterval(()=>{},1000)"], 'retry');
  let soft = '', hard = '';
  try {
    await until(() => fixture.output().includes('READY'), 'retry fixture readiness');
    const limits = fs.readFileSync(`/proc/${fixture.pty.pid}/limits`, 'utf8');
    [, soft, hard] = /Max open files\s+(\S+)\s+(\S+)/.exec(limits)!;
    execFileSync('prlimit', ['--pid', String(fixture.pty.pid), `--nofile=4:${hard}`]);
    await assert.rejects(fixture.pty.stop(), /STOP_METADATA_OR_SIGNAL_FAILED/);
    assert.equal(alive(fixture.pty.pid), true);
    execFileSync('prlimit', ['--pid', String(fixture.pty.pid), `--nofile=${soft}:${hard}`]); soft = '';
    assert.equal((await fixture.pty.stop()).exitCode, 137);
  } finally {
    if (soft && alive(fixture.pty.pid)) execFileSync('prlimit', ['--pid', String(fixture.pty.pid), `--nofile=${soft}:${hard}`]);
    await stop(fixture.pty);
  }
});

test('Linux missing native helper fails before starting the configured CLI', { skip }, async () => {
  const directory = scratchDirectory('linux-missing-'); const marker = path.join(directory, 'unexpected');
  await assert.rejects(startLinuxPty(directory, profile(directory, process.execPath,
    ['-e', `require('node:fs').writeFileSync(${JSON.stringify(marker)},'wrong')`]), 80, 24, 'missing'));
  assert.equal(fs.existsSync(marker), false);
});

test('Linux owner subscribes before exec and can Stop the paused bootstrap without CLI effects', { skip, timeout: 15000 }, async () => {
  const directory = scratchDirectory('linux-start-barrier-'); const marker = path.join(directory, 'unexpected');
  const pty = await startLinuxPty(root, profile(directory, process.execPath,
    ['-e', `require('node:fs').writeFileSync(${JSON.stringify(marker)},'wrong')`]), 80, 24, 'barrier');
  try {
    assert.equal(fs.existsSync(marker), false);
    assert.equal((await pty.stop()).exitCode, 137);
    pty.onOutput(() => {});
    assert.equal(fs.existsSync(marker), false);
  } finally { await stop(pty); }
});

test('Linux interactive job-control groups are cleaned without affecting another session', { skip, timeout: 15000 }, async () => {
  const directory = scratchDirectory('linux-job-control-');
  const fixture = await launch(directory, '/bin/bash', ['--noprofile', '--norc', '-i'], 'job-control');
  try {
    fixture.pty.write("sleep 600 & printf 'BACKGROUND:%s\\n' \"$!\"\r");
    await until(() => /BACKGROUND:\d+/.test(fixture.output()), 'interactive background job');
    assert.doesNotMatch(fixture.output(), /no job control|cannot set terminal process group/);
    const pid = Number(/BACKGROUND:(\d+)/.exec(fixture.output())![1]);
    const result = await fixture.pty.stop();
    assert.ok(result.verifiedPids.includes(pid)); assert.equal(alive(pid), false);
  } finally { await stop(fixture.pty); }
});

test('Linux unexpected supervisor loss reports unresolved cleanup rather than a verified Stop', { skip, timeout: 15000 }, async () => {
  const directory = scratchDirectory('linux-helper-loss-');
  const source = "const parent=process.ppid;console.log('READY:'+process.pid);setInterval(()=>{if(process.ppid!==parent)process.exit(0)},10)";
  const fixture = await launch(directory, process.execPath, ['-e', source], 'helper-loss');
  await until(() => /READY:\d+/.test(fixture.output()), 'helper-loss fixture readiness');
  const primary = Number(/READY:(\d+)/.exec(fixture.output())![1]);
  // This is the still-live supervisor created by this test. Its child exits itself
  // after reparenting so this injected crash cannot leave a fixture daemon behind.
  process.kill(fixture.pty.pid, 'SIGKILL');
  await until(() => fixture.exit() !== undefined, 'unexpected supervisor exit');
  assert.equal(fixture.exit()!.cleanupRequired, true);
  await assert.rejects(fixture.pty.stop(), /LINUX_SUPERVISOR_LOST/);
  await until(() => !alive(primary), 'owned fixture self-cleanup');
});

for (const delayMs of [50, 2200]) test(delayMs === 50
  ? 'Linux waits for final control proof delivered after the independent PTY exit'
  : 'Linux bounds the final control drain and never promotes a late receipt after failure', { skip, timeout: 15000 }, async t => {
  let nativeExited = false, delayed = false, releasedAfterExit = false;
  const native = createRequire(path.join(root, 'package.json'))('node-pty') as typeof import('node-pty');
  const spawnNative = native.spawn;
  t.mock.method(native, 'spawn', (...args: Parameters<typeof native.spawn>) => {
    const pty = spawnNative(...args); pty.onExit(() => { nativeExited = true; }); return pty;
  });
  const createServer = net.createServer;
  t.mock.method(net, 'createServer', () => {
    const server = createServer(); const serverOn = server.on.bind(server);
    t.mock.method(server, 'on', ((event: string, listener: (...args: unknown[]) => void) => {
      if (event !== 'connection') return serverOn(event, listener);
      return serverOn('connection', socket => {
        const socketOn = socket.on.bind(socket);
        let finalHeld = false; const afterRelease: Array<() => void> = [];
        t.mock.method(socket, 'on', ((name: string, callback: (...args: unknown[]) => void) => {
          if (name === 'close') return socketOn('close', () => { if (finalHeld) afterRelease.push(() => callback()); else callback(); });
          if (name !== 'data') return socketOn(name, callback);
          return socketOn('data', (data: string) => {
            const start = data.indexOf('{"type":"done"');
            if (start < 0) { callback(data); return; }
            if (start) callback(data.slice(0, start));
            delayed = true; finalHeld = true; socket.pause();
            const release = () => {
              if (!nativeExited) { setTimeout(release, 5); return; }
              setTimeout(() => {
                releasedAfterExit = true; finalHeld = false; callback(data.slice(start));
                for (const close of afterRelease) close(); socket.resume();
              }, delayMs);
            };
            release();
          });
        }) as typeof socket.on);
        listener(socket);
      });
    }) as typeof server.on);
    return server;
  });
  const directory = scratchDirectory('linux-channel-order-');
  const fixture = await launch(directory, process.execPath, ['-e', "console.log('READY');setInterval(()=>{},1000)"], 'ordering');
  try {
    await until(() => fixture.output().includes('READY'), 'ordering fixture readiness');
    if (delayMs < 2000) {
      const result = await fixture.pty.stop();
      assert.equal(result.exitCode, 137); assert.ok(result.verifiedPids.includes(fixture.pty.pid));
      assert.equal(fixture.exit()!.cleanupRequired, false);
    } else {
      await assert.rejects(fixture.pty.stop(), /LINUX_SUPERVISOR_LOST/);
      assert.equal(fixture.exit()!.cleanupRequired, true);
      await until(() => releasedAfterExit, 'late proof delivery');
      await assert.rejects(fixture.pty.stop(), /LINUX_SUPERVISOR_LOST/);
    }
    assert.equal(delayed, true); assert.equal(releasedAfterExit, true);
  } finally {
    if (delayMs < 2000) await stop(fixture.pty);
    else await assert.rejects(fixture.pty.stop(), /LINUX_SUPERVISOR_LOST/);
  }
});
