import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import test from 'node:test';
import { NodePtyLauncher } from '../../app/services/node-pty.js';
import type { PtyHandle } from '../../app/services/pty.js';

const skip = process.platform !== 'win32';
const alive = (pid: number): boolean => { try { process.kill(pid, 0); return true; } catch { return false; } };
async function until(predicate: () => boolean, description: string): Promise<void> {
  const deadline = Date.now() + 15000;
  while (!predicate()) { if (Date.now() >= deadline) throw new Error('WINDOWS_NATIVE_TIMEOUT: ' + description); await new Promise(resolve => setTimeout(resolve, 20)); }
}
async function launch(source: string, stopTree?: ConstructorParameters<typeof NodePtyLauncher>[2]): Promise<{ pty: PtyHandle; directory: string }> {
  const temporary = path.join(process.cwd(), '.runtime/tmp'); fs.mkdirSync(temporary, { recursive: true });
  const directory = fs.mkdtempSync(path.join(temporary, 'windows-native-'));
  // Extraction stays in the owned fixture, so source testing does not leave a native cache in the checkout.
  const native = path.join(directory, 'node_modules/node-pty'), installed = path.join(process.cwd(), 'node_modules/node-pty');
  fs.mkdirSync(path.join(native, 'prebuilds/win32-x64'), { recursive: true });
  fs.cpSync(path.join(installed, 'lib'), path.join(native, 'lib'), { recursive: true });
  for (const file of ['package.json', 'LICENSE', 'prebuilds/win32-x64/conpty.node', 'prebuilds/win32-x64/conpty_console_list.node']) {
    fs.copyFileSync(path.join(installed, file), path.join(native, file));
  }
  const pty = await new NodePtyLauncher(directory, undefined, stopTree).start({ id: 'fixture', label: 'Windows fixture', executable: process.execPath,
    args: ['-e', source], projectDirectory: directory, environment: {} }, 100, 30, path.basename(directory).replaceAll(' ', '-'));
  return { pty, directory };
}
async function cleanupFixture(pty: PtyHandle, directory: string): Promise<void> {
  try { await pty.stop(); }
  catch (error) { console.error('Windows native cleanup needs recovery; owned fixture preserved at ' + directory); throw error; }
  fs.rmSync(directory, { recursive: true, force: true });
}

test('Windows natural root exit retains child/grandchild ownership and late exit subscribers until verified Stop', { skip, timeout: 45000 }, async () => {
  const grandchild = 'setInterval(()=>{},1000)';
  const child = `const child=require('node:child_process').spawn(process.execPath,['-e',${JSON.stringify(grandchild)}],{detached:true,windowsHide:true,stdio:'ignore'});process.send({child:process.pid,grandchild:child.pid});setInterval(()=>{},1000)`;
  const source = `const child=require('node:child_process').spawn(process.execPath,['-e',${JSON.stringify(child)}],{detached:true,windowsHide:true,stdio:['ignore','ignore','ignore','ipc']});child.on('message',value=>console.log('TREE:'+JSON.stringify(value)));process.stdin.setRawMode(true);process.stdin.on('data',()=>{console.log('WINDOWS_ROOT_FINAL');process.exit(7)});setInterval(()=>{},1000)`;
  const { pty, directory } = await launch(source), sibling = spawn(process.execPath, ['-e', 'setInterval(()=>{},1000)'], { windowsHide: true, stdio: 'ignore' });
  const siblingExited = once(sibling, 'exit'); let output = '', code: number | undefined, cleanup: boolean | undefined;
  pty.onOutput(data => { output += data; }); pty.onExit((value, remaining) => { code = value; cleanup = remaining; });
  try {
    await until(() => /TREE:\{[^\r\n]+\}/.test(output), 'native descendants');
    const descendants = JSON.parse(/TREE:(\{[^\r\n]+\})/.exec(output)![1]) as { child: number; grandchild: number };
    assert.ok(alive(descendants.child) && alive(descendants.grandchild));
    pty.write('x'); await until(() => code !== undefined, 'natural primary exit');
    assert.equal(code, 7); assert.equal(cleanup, true); assert.ok(output.includes('WINDOWS_ROOT_FINAL'));
    assert.equal(pty.cleanupScope, 'tracked-descendants');
    let lateCleanup: boolean | undefined; pty.onExit((_value, remaining) => { lateCleanup = remaining; });
    await until(() => lateCleanup !== undefined, 'late exit subscriber'); assert.equal(lateCleanup, true);
    const stopped = await pty.stop(); assert.equal(stopped.exitCode, 7); assert.equal(stopped.cleanupScope, 'tracked-descendants');
    for (const pid of [descendants.child, descendants.grandchild]) { assert.ok(stopped.verifiedPids.includes(pid)); assert.equal(alive(pid), false); }
    assert.ok(alive(sibling.pid!));
    let verified: boolean | undefined; pty.onExit((_value, remaining) => { verified = remaining; });
    await until(() => verified !== undefined, 'verified late exit subscriber'); assert.equal(verified, false);
  } finally { try { await cleanupFixture(pty, directory); } finally { sibling.kill(); await siblingExited; } }
});

test('Windows failed Stop remains retryable after primary exit and does not clear cleanup evidence', { skip, timeout: 45000 }, async () => {
  const { stopProcessTree } = await import('../../app/services/process-tree.js');
  let fail = true;
  const { pty, directory } = await launch("console.log('WINDOWS_READY');process.stdin.setRawMode(true);process.stdin.on('data',()=>process.exit(5));setInterval(()=>{},1000)",
    async (pid, ownership) => { if (fail) throw new Error('OWNED_TEST_METADATA_FAILED'); return stopProcessTree(pid, ownership); });
  let output = '', exited = false; pty.onOutput(data => { output += data; }); pty.onExit(() => { exited = true; });
  try {
    await until(() => output.includes('WINDOWS_READY'), 'ready'); pty.write('x'); await until(() => exited, 'primary exit');
    await assert.rejects(pty.stop(), /OWNED_TEST_METADATA_FAILED/);
    let cleanup: boolean | undefined; pty.onExit((_code, remaining) => { cleanup = remaining; });
    await until(() => cleanup !== undefined, 'failed cleanup evidence'); assert.equal(cleanup, true);
    fail = false; assert.equal((await pty.stop()).exitCode, 5);
  } finally { fail = false; await cleanupFixture(pty, directory); }
});
