import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import childProcess, { execFileSync, spawn, spawnSync } from 'node:child_process';
import test from 'node:test';
import { createRequire } from 'node:module';
import crypto from 'node:crypto';
import type { LaunchProfile } from '@grotesqueries/protocol';
import { startMacPty } from '../../app/services/mac-pty.js';
import { verifyMacProcessSupport, type MacProcess } from '../../app/services/mac-processes.js';
import { scratchDirectory } from '../support/scratch.js';

const root = process.cwd();
const skip = process.platform !== 'darwin';
const helper = path.join(root, 'dist/native/macos-processes');
const list = (): MacProcess[] => JSON.parse(execFileSync(helper, ['list'], { encoding: 'utf8', timeout: 2000, maxBuffer: 4 * 1024 * 1024 })).processes;
function profile(script: string): LaunchProfile {
  return { id: 'mac-fixture', label: 'Native Mac fixture', executable: process.execPath, args: ['-e', script], projectDirectory: scratchDirectory('mac-native-'), environment: {} };
}
async function until(predicate: () => boolean, message: string): Promise<void> {
  const deadline = Date.now() + 10000;
  while (!predicate()) { if (Date.now() > deadline) throw new Error('Timed out: ' + message); await new Promise(resolve => setTimeout(resolve, 20)); }
}
const delay = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));
function cleanupIdentity(item: MacProcess): void {
  const current = list().find(value => value.pid === item.pid && value.birth === item.birth);
  if (current && !current.zombie) execFileSync(helper, ['kill', String(current.pid), current.birth, String(current.session)], { timeout: 2000 });
}

test('Mac helper capability checks audit-token generation and refuses incorrect retained identities', { skip, timeout: 15000 }, async () => {
  assert.equal(execFileSync(helper, ['probe'], { encoding: 'utf8' }).trim(), 'audit-token-v1');
  verifyMacProcessSupport(root);
  const sibling = spawn(process.execPath, ['-e', 'setInterval(()=>{},1000)'], { stdio: 'ignore' });
  const exited = new Promise(resolve => sibling.once('exit', resolve));
  let identity: MacProcess | undefined;
  try {
    await until(() => { identity = list().find(item => item.pid === sibling.pid); return !!identity; }, 'sibling identity');
    assert.equal(spawnSync(helper, ['kill', String(sibling.pid), '0:0', String(identity!.session)]).status, 4);
    assert.equal(spawnSync(helper, ['kill', String(sibling.pid), identity!.birth, String(identity!.session + 1)]).status, 4);
    assert.ok(list().some(item => item.pid === sibling.pid && item.birth === identity!.birth && !item.zombie));
  } finally { if (identity) cleanupIdentity(identity); await exited; }
});

test('Mac unsupported capability fails before any requested program can run', { skip }, async () => {
  const scratch = scratchDirectory('mac-no-helper-');
  const marker = path.join(scratch, 'should-not-exist');
  await assert.rejects(startMacPty(scratch, { ...profile(`require('node:fs').writeFileSync(${JSON.stringify(marker)},'bad')`),
    projectDirectory: scratch }, 80, 24, 'unsupported'), /PTY_PLATFORM_UNSUPPORTED/);
  assert.equal(fs.existsSync(marker), false);
});

test('Mac PTY supports Unicode, input, resize and final output', { skip, timeout: 20000 }, async () => {
  const script = `const readline=require('node:readline'); console.log('READY λ中🙂');
    readline.createInterface({input:process.stdin}).on('line',line=>{
      if(line==='grid') console.log('GRID:'+require('node:child_process').execFileSync('/bin/stty',['size'],{encoding:'utf8',stdio:['inherit','pipe','pipe']}).trim());
      else if(line==='quit'){console.log('FINAL-MAC-MARKER');process.exit(7)}else console.log('ECHO:'+line)
    });`;
  const pty = await startMacPty(root, profile(script), 120, 40, 'unicode');
  let output = ''; let exitCode: number | undefined;
  pty.onOutput(data => { output += data; }); pty.onExit(code => { exitCode = code; });
  try {
    await until(() => output.includes('READY λ中🙂'), 'Unicode readiness');
    pty.write('hello λ🙂\r'); await until(() => output.includes('ECHO:hello λ🙂'), 'Unicode echo');
    pty.resize(90, 25); pty.write('grid\r'); await until(() => output.includes('GRID:25 90'), 'resized kernel PTY');
    pty.write('quit\r'); await until(() => exitCode !== undefined, 'natural exit');
    assert.equal(exitCode, 7); assert.ok(output.includes('FINAL-MAC-MARKER'));
    assert.equal(pty.cleanupScope, 'tracked-descendants');
    assert.equal((await pty.stop()).cleanupScope, 'tracked-descendants');
  } finally { await pty.stop(); }
});

test('Mac immediate exits preserve their first and final output before exit delivery', { skip, timeout: 25000 }, async () => {
  for (let attempt = 0; attempt < 5; attempt++) {
    const pty = await startMacPty(root, profile("process.stdout.write('FIRST λ🙂 FINAL');process.exit(9)"), 80, 24, 'immediate-' + attempt);
    let output = ''; let code: number | undefined;
    pty.onOutput(data => { output += data; }); pty.onExit(value => { code = value; assert.ok(output.includes('FIRST λ🙂 FINAL')); });
    try { await until(() => code !== undefined, 'immediate output and exit'); assert.equal(code, 9); }
    finally { await pty.stop(); }
  }
});

test('Mac silent PTY starts and Stop remains bounded with explicit tracked cleanup scope', { skip, timeout: 15000 }, async () => {
  const pty = await startMacPty(root, profile("process.stdin.setRawMode(true);process.stdin.on('data',()=>console.log('SILENT-ACK'));setInterval(()=>{},1000)"), 80, 24, 'silent');
  let output = ''; pty.onOutput(data => { output += data; });
  try { pty.write('x'); await until(() => output.includes('SILENT-ACK'), 'silent input'); }
  finally {
    const stopped = await pty.stop(); assert.equal(stopped.cleanupScope, 'tracked-descendants');
    assert.ok(stopped.verifiedPids.includes(pty.pid)); assert.ok(!list().some(item => item.pid === pty.pid && !item.zombie));
  }
});

for (const detached of [false, true]) {
  test(`Mac Stop retains known child/grandchild after root exit, detached=${detached}, and isolates sibling`, { skip, timeout: 25000 }, async () => {
    const grandchild = "process.on('SIGHUP',()=>{});setInterval(()=>{},1000)";
    const child = `process.on('SIGHUP',()=>{});const p=require('node:child_process').spawn(process.execPath,['-e',${JSON.stringify(grandchild)}],{stdio:'ignore'});process.send({child:process.pid,grandchild:p.pid});setInterval(()=>{},1000)`;
    const script = `const p=require('node:child_process').spawn(process.execPath,['-e',${JSON.stringify(child)}],{detached:${detached},stdio:['ignore','ignore','ignore','ipc']});p.on('message',m=>console.log('TREE:'+JSON.stringify(m)));process.stdin.setRawMode(true);process.stdin.on('data',()=>{console.log('ROOT-FINAL');process.exit(0)});setInterval(()=>{},1000)`;
    const sibling = spawn(process.execPath, ['-e', 'setInterval(()=>{},1000)'], { stdio: 'ignore' });
    const siblingExit = new Promise(resolve => sibling.once('exit', resolve));
    const siblingIdentity = list().find(item => item.pid === sibling.pid)!;
    const pty = await startMacPty(root, profile(script), 80, 24, 'tree-' + detached);
    let output = ''; let cleanup: boolean | undefined; let code: number | undefined; let identities: MacProcess[] = [];
    pty.onOutput(data => { output += data; }); pty.onExit((value, remaining) => { code = value; cleanup = remaining; });
    try {
      await until(() => /TREE:\{[^\r\n]+\}/.test(output), 'descendant identities');
      const pids = JSON.parse(output.match(/TREE:(\{[^\r\n]+\})/)![1]) as { child: number; grandchild: number };
      identities = list().filter(item => [pids.child, pids.grandchild].includes(item.pid)); assert.equal(identities.length, 2);
      await delay(250); // Retain both births before deliberately exiting the PTY root.
      pty.write('x'); await until(() => code !== undefined, 'root exit with known descendants');
      assert.equal(cleanup, true); assert.ok(output.includes('ROOT-FINAL'));
      const stopped = await pty.stop(); assert.equal(stopped.cleanupScope, 'tracked-descendants');
      for (const identity of identities) {
        assert.ok(stopped.verifiedPids.includes(identity.pid));
        assert.ok(!list().some(item => item.pid === identity.pid && item.birth === identity.birth && !item.zombie));
      }
      assert.ok(list().some(item => item.pid === siblingIdentity.pid && item.birth === siblingIdentity.birth && !item.zombie));
    } finally {
      await pty.stop(); for (const identity of identities) cleanupIdentity(identity);
      cleanupIdentity(siblingIdentity); await siblingExit;
    }
  });
}

test('Mac metadata truncation and malformed records fail closed, and a failed Stop can be retried', { skip, timeout: 20000 }, async context => {
  const original = childProcess.execFileSync;
  let corrupt: string | undefined;
  context.mock.method(childProcess, 'execFileSync', (...args: Parameters<typeof execFileSync>) => {
    if (corrupt && Array.isArray(args[1]) && args[1][0] === 'list') return corrupt;
    return original(...args);
  });
  const pty = await startMacPty(root, profile('setInterval(()=>{},1000)'), 80, 24, 'retry');
  try {
    await delay(50);
    for (const invalid of ['{"complete":false,"processes":[]}', '{"complete":true,"processes":[null]}',
      '{"complete":true,"processes":[{"pid":42,"unavailable":true}]}']) {
      corrupt = invalid; await assert.rejects(pty.stop(), /STOP_METADATA_FAILED/);
    }
    corrupt = undefined;
    assert.equal((await pty.stop()).cleanupScope, 'tracked-descendants');
  } finally { corrupt = undefined; await pty.stop(); }
});


test('Mac rapid double-fork/setsid escape reports tracked-only scope and fixture cleanup uses retained identity', { skip, timeout: 20000 }, async () => {
  // Polling cannot guarantee observing this lineage. The result must never advertise full descendant containment.
  const leaf = "process.on('SIGHUP',()=>{});setTimeout(()=>process.exit(0),8000)";
  const intermediate = `const p=require('node:child_process').spawn(process.execPath,['-e',${JSON.stringify(leaf)}],{detached:true,stdio:'ignore'});p.unref();process.send({leaf:p.pid},()=>process.exit(0))`;
  const script = `const p=require('node:child_process').spawn(process.execPath,['-e',${JSON.stringify(intermediate)}],{detached:true,stdio:['ignore','ignore','ignore','ipc']});p.on('message',m=>{console.log('ESCAPE:'+JSON.stringify(m));process.exit(0)})`;
  const pty = await startMacPty(root, profile(script), 80, 24, 'rapid-escape');
  let output = ''; let code: number | undefined; let retained: MacProcess | undefined;
  pty.onOutput(data => { output += data; }); pty.onExit(value => { code = value; });
  try {
    await until(() => code !== undefined, 'rapid root exit');
    const match = output.match(/ESCAPE:(\{[^\r\n]+\})/); assert.ok(match);
    const pid = (JSON.parse(match[1]) as { leaf: number }).leaf;
    retained = list().find(item => item.pid === pid);
    const result = await pty.stop();
    assert.equal(pty.cleanupScope, 'tracked-descendants'); assert.equal(result.cleanupScope, 'tracked-descendants');
    // The leaf may be observed or may escape between samples; neither permits a full-tree claim.
    if (retained) cleanupIdentity(retained);
    if (retained) await until(() => !list().some(item => item.pid === retained!.pid && item.birth === retained!.birth && !item.zombie), 'verified escaped fixture cleanup');
  } finally { await pty.stop(); if (retained) cleanupIdentity(retained); }
});


test('Mac unacknowledged bootstrap expires without stopping forever or executing requested program', { skip, timeout: 10000 }, async () => {
  const native = createRequire(path.join(root, 'package.json'))('node-pty') as typeof import('node-pty');
  const scratch = scratchDirectory('mac-unacknowledged-'); const marker = path.join(scratch, 'never-exec');
  const terminal = native.spawn(helper, ['bootstrap', crypto.randomUUID(), process.execPath, '-e',
    `require('node:fs').writeFileSync(${JSON.stringify(marker)},'unexpected')`], { cwd: scratch, cols: 80, rows: 24 });
  let output = ''; let code: number | undefined; let captured: MacProcess | undefined;
  terminal.onData(data => { output += data; }); terminal.onExit(event => { code = event.exitCode; });
  try {
    await until(() => output.includes('\x1f'), 'bootstrap self-identity');
    captured = list().find(item => item.pid === terminal.pid); assert.ok(captured);
    await until(() => code !== undefined, 'unacknowledged bootstrap expiry');
    assert.notEqual(code, 0); assert.equal(fs.existsSync(marker), false);
    assert.ok(!list().some(item => item.pid === captured!.pid && item.birth === captured!.birth && !item.zombie));
  } finally { if (captured) cleanupIdentity(captured); }
});

test('Mac startup error cleanup binds handshake birth and cannot abort another stopped sibling', { skip, timeout: 15000 }, async context => {
  const sibling = spawn(process.execPath, ['-e', "process.kill(process.pid,'SIGSTOP');setInterval(()=>{},1000)"], { detached: true, stdio: 'ignore' });
  const siblingExit = new Promise(resolve => sibling.once('exit', resolve));
  let identity: MacProcess | undefined;
  await until(() => { identity = list().find(item => item.pid === sibling.pid); return identity?.stopped === true; }, 'unrelated stopped session leader');
  assert.equal(spawnSync(helper, ['abort', String(sibling.pid), String(process.pid)]).status, 2);
  const original = childProcess.execFileSync; let capturedBootstrap: number | undefined;
  context.mock.method(childProcess, 'execFileSync', (...args: Parameters<typeof execFileSync>) => {
    if (Array.isArray(args[1]) && args[1][0] === 'list') return '{"complete":false,"processes":[]}';
    if (Array.isArray(args[1]) && args[1][0] === 'status') capturedBootstrap = Number(args[1][1]);
    return original(...args);
  });
  const scratch = scratchDirectory('mac-startup-error-'); const marker = path.join(scratch, 'never-exec');
  try {
    await assert.rejects(startMacPty(root, { ...profile(`require('node:fs').writeFileSync(${JSON.stringify(marker)},'bad')`), projectDirectory: scratch }, 80, 24, 'startup-error'), /PTY_OWNERSHIP_FAILED/);
    assert.equal(fs.existsSync(marker), false); assert.notEqual(capturedBootstrap, sibling.pid);
    context.mock.restoreAll();
    assert.ok(list().some(item => item.pid === identity!.pid && item.birth === identity!.birth && item.stopped));
    await until(() => !list().some(item => item.pid === capturedBootstrap && !item.zombie), 'captured bootstrap cleanup');
  } finally { context.mock.restoreAll(); cleanupIdentity(identity!); await siblingExit; }
});

test('Mac omitted retained identities are queried directly and unknown status cannot release cleanup', { skip, timeout: 15000 }, async context => {
  const original = childProcess.execFileSync;
  let omitted = false; let unavailable = false; let queried = false; let pid = 0;
  context.mock.method(childProcess, 'execFileSync', (...args: Parameters<typeof execFileSync>) => {
    if (omitted && Array.isArray(args[1]) && args[1][0] === 'list') {
      const envelope = JSON.parse(String(original(...args)));
      envelope.processes = envelope.processes.filter((item: MacProcess) => item.pid !== pid);
      return JSON.stringify(envelope);
    }
    if (omitted && Array.isArray(args[1]) && args[1][0] === 'status' && Number(args[1][1]) === pid) {
      queried = true; if (unavailable) return '{"state":"unavailable"}';
    }
    return original(...args);
  });
  const pty = await startMacPty(root, profile('setInterval(()=>{},1000)'), 80, 24, 'omitted-identity'); pid = pty.pid;
  try {
    await delay(50); omitted = true; unavailable = true;
    await assert.rejects(pty.stop(), /STOP_METADATA_FAILED/); assert.equal(queried, true);
    unavailable = false;
    const stopped = await pty.stop(); assert.ok(stopped.verifiedPids.includes(pid));
  } finally { omitted = false; unavailable = false; await pty.stop(); }
});


test('Mac Stop before deferred resume never starts the requested program', { skip, timeout: 10000 }, async () => {
  const scratch = scratchDirectory('mac-cancel-before-exec-'); const marker = path.join(scratch, 'never-exec');
  const pty = await startMacPty(root, { ...profile(`require('node:fs').writeFileSync(${JSON.stringify(marker)},'bad')`),
    projectDirectory: scratch }, 80, 24, 'cancel-before-exec');
  const result = await pty.stop();
  assert.equal(result.cleanupScope, 'tracked-descendants'); assert.equal(fs.existsSync(marker), false);
});


for (const stale of ['parent', 'session'] as const) {
  test(`Mac stale ${stale} authority cannot claim or signal an unrelated sibling`, { skip, timeout: 15000 }, async context => {
    const pty = await startMacPty(root, profile('setInterval(()=>{},1000)'), 80, 24, 'stale-' + stale);
    await delay(50);
    const sibling = spawn(process.execPath, ['-e', 'setInterval(()=>{},1000)'], { stdio: 'ignore' });
    const siblingExit = new Promise(resolve => sibling.once('exit', resolve));
    let siblingIdentity: MacProcess | undefined;
    await until(() => { siblingIdentity = list().find(item => item.pid === sibling.pid); return !!siblingIdentity; }, 'sibling sampled after authority');
    const rootIdentity = list().find(item => item.pid === pty.pid)!;
    const original = childProcess.execFileSync; let rechecked = 0; let siblingSignal = false;
    context.mock.method(childProcess, 'execFileSync', (...args: Parameters<typeof execFileSync>) => {
      if (Array.isArray(args[1]) && args[1][0] === 'list') {
        const envelope = JSON.parse(String(original(...args)));
        if (envelope.processes.some((item: MacProcess) => item.pid === pty.pid && item.birth === rootIdentity.birth)) {
          envelope.processes = envelope.processes.map((item: MacProcess) => item.pid !== sibling.pid ? item : {
            ...item, ...(stale === 'parent' ? { parent: pty.pid } : { session: pty.pid }),
          });
        }
        return JSON.stringify(envelope);
      }
      if (Array.isArray(args[1]) && args[1][0] === 'status' && Number(args[1][1]) === pty.pid) {
        rechecked++; return '{"state":"replaced"}';
      }
      if (Array.isArray(args[1]) && args[1][0] === 'kill' && Number(args[1][1]) === sibling.pid) siblingSignal = true;
      return original(...args);
    });
    try {
      const result = await pty.stop();
      assert.ok(rechecked > 0); assert.equal(siblingSignal, false); assert.equal(result.verifiedPids.includes(sibling.pid!), false);
      context.mock.restoreAll();
      assert.ok(list().some(item => item.pid === sibling.pid && item.birth === siblingIdentity!.birth && !item.zombie));
    } finally { context.mock.restoreAll(); await pty.stop(); cleanupIdentity(siblingIdentity!); await siblingExit; }
  });
}

test('Mac unknown post-snapshot authority refuses a new ownership claim and Stop can retry', { skip, timeout: 15000 }, async context => {
  const pty = await startMacPty(root, profile('setInterval(()=>{},1000)'), 80, 24, 'unknown-authority'); await delay(50);
  const sibling = spawn(process.execPath, ['-e', 'setInterval(()=>{},1000)'], { stdio: 'ignore' });
  const siblingExit = new Promise(resolve => sibling.once('exit', resolve)); let identity: MacProcess | undefined;
  await until(() => { identity = list().find(item => item.pid === sibling.pid); return !!identity; }, 'unrelated sibling');
  const original = childProcess.execFileSync; let fault = true; let rechecked = false;
  context.mock.method(childProcess, 'execFileSync', (...args: Parameters<typeof execFileSync>) => {
    if (fault && Array.isArray(args[1]) && args[1][0] === 'list') {
      const envelope = JSON.parse(String(original(...args)));
      envelope.processes = envelope.processes.map((item: MacProcess) => item.pid === sibling.pid ? { ...item, session: pty.pid } : item);
      return JSON.stringify(envelope);
    }
    if (fault && Array.isArray(args[1]) && args[1][0] === 'status' && Number(args[1][1]) === pty.pid) {
      rechecked = true; return '{"state":"unavailable"}';
    }
    return original(...args);
  });
  try {
    await assert.rejects(pty.stop(), /STOP_METADATA_FAILED/); assert.equal(rechecked, true);
    fault = false; await pty.stop();
    assert.ok(list().some(item => item.pid === sibling.pid && item.birth === identity!.birth && !item.zombie));
  } finally { fault = false; context.mock.restoreAll(); await pty.stop(); cleanupIdentity(identity!); await siblingExit; }
});
