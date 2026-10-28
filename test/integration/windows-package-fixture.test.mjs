import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import { execFileSync } from 'node:child_process';
import { finalizeGuildKitFixture } from '../../bin/check-guild-kit.mjs';
import { windowsEnvironmentBlock, controllerChannel, startOwnedWindowsHost } from '../../bin/windows-host-fixture.mjs';

const nonce = 'a'.repeat(32), receipt = (phase, payload = '-', token = nonce) => `GQ|${token}|${phase}|${payload}\n`;
function fake() {
  const child = new EventEmitter(); child.stdin = new PassThrough(); child.stdout = new PassThrough(); child.stderr = new PassThrough();
  child.kill = () => { child.emit('close', null, 'SIGTERM'); return true; };
  return { child, channel: controllerChannel(child, nonce) };
}

test('Windows child environment is a sorted, double-NUL Unicode block and refuses aliases/embedded NULs', () => {
  assert.equal(windowsEnvironmentBlock({ z: 'λ界', PATH: 'C:\\Windows', A: '' }).toString('utf16le'), 'A=\0PATH=C:\\Windows\0z=λ界\0\0');
  for (const environment of [{ PATH: 'one', Path: 'two' }, { PATH: 'bad\0value' }, { 'bad=name': 'value' }, { PATH: undefined }]) {
    assert.throws(() => windowsEnvironmentBlock(environment), /ENVIRONMENT_INVALID/);
  }
  assert.throws(() => windowsEnvironmentBlock({ LONG: 'a'.repeat(65536) }), /ENVIRONMENT_LIMIT/);
});

test('controller receipts require exact nonce, grammar and requested phase; bounded diagnostics omit raw output', async () => {
  for (const value of [receipt('started', '-', 'b'.repeat(32)), receipt('created', '0,1'), receipt('resumed', '1'), 'untrusted raw output\n']) {
    const { child, channel } = fake(); child.stdout.write(value);
    await assert.rejects(channel.receive('started', 20), /RECEIPT_INVALID/);
    assert.equal(JSON.stringify(channel.diagnostics()).includes('untrusted'), false);
  }
  const { child, channel } = fake(); child.stdout.write(receipt('resumed'));
  await assert.rejects(channel.receive('created', 20), /PHASE_created/);
});

test('controller command ack is nonce-bound and final receipt requires successful close and drained output', async () => {
  const { child, channel } = fake(); let command = ''; child.stdin.on('data', data => { command += data; });
  child.stdout.write(receipt('created', '123,134000000000000000'));
  assert.equal(await channel.receive('created'), '123,134000000000000000');
  channel.send('resume'); assert.equal(command, nonce + ' resume\n');
  child.stdout.write(receipt('resumed')); await channel.receive('resumed');
  child.stdout.write(receipt('disposed')); await channel.receive('disposed');
  await assert.rejects(channel.finish(15), /DRAIN_TIMEOUT/);
  child.emit('close', 0, null); await channel.finish();
  assert.throws(() => channel.healthy(), /UNEXPECTED_EXIT/);
});

test('controller environment frame is nonce-bound, bounded and memory-only', async () => {
  const { child, channel } = fake(); const chunks = [];
  child.stdin.on('data', bytes => chunks.push(bytes));
  const block = windowsEnvironmentBlock({ OWNED_SECRET_MARKER: 'never-a-real-secret' });
  channel.sendEnvironment(block);
  assert.equal(Buffer.concat(chunks).toString(), nonce + ' env ' + block.toString('base64') + '\n');
  assert.equal(JSON.stringify(channel.diagnostics()).includes('never-a-real-secret'), false);
  assert.throws(() => channel.sendEnvironment(Buffer.alloc(131074)), /ENVIRONMENT_FRAME/);
  await channel.abort();
});

test('controller death, nonzero exit, truncated/extra receipts and missing phases cannot qualify', async () => {
  for (const exit of [[71, null], [null, 'SIGTERM']]) {
    const { child, channel } = fake(); child.stdout.write(receipt('disposed')); await channel.receive('disposed'); child.emit('close', ...exit);
    await assert.rejects(channel.finish(), /EXIT_FAILED/);
  }
  const truncated = fake(); truncated.child.stdout.write('GQ|'); truncated.child.emit('close', 0, null);
  await assert.rejects(truncated.channel.finish(), /TRUNCATED_RECEIPT/);
  const extra = fake(); extra.child.stdout.write(receipt('disposed') + receipt('disposed')); await extra.channel.receive('disposed'); extra.child.emit('close', 0, null);
  await assert.rejects(extra.channel.finish(), /EXIT_FAILED/);
  const missing = fake(); await assert.rejects(missing.channel.receive('created', 15), /TIMEOUT_created/); await missing.channel.abort();
  const exited = fake(); exited.child.emit('close', 0, null); await assert.rejects(exited.channel.receive('created'), /UNEXPECTED_EXIT/);
});

test('controller output bounds fail closed and abort targets only the owned helper', async () => {
  const { child, channel } = fake(); child.stdout.write('x'.repeat(65537)); await assert.rejects(channel.receive('started'), /OUTPUT_LIMIT/);
  let kills = 0; child.kill = () => { kills++; child.emit('close', null, 'SIGTERM'); };
  await channel.abort(); await channel.abort(); assert.equal(kills, 1);
  const stderr = fake(); stderr.child.stderr.write('private detail'.repeat(6000));
  await assert.rejects(stderr.channel.receive('started'), /STDERR_LIMIT/); assert.equal(JSON.stringify(stderr.channel.diagnostics()).includes('private'), false);
});

const native = process.platform === 'win32' && process.arch === 'x64';
const pause = ms => new Promise(resolve => setTimeout(resolve, ms));
const alive = pid => { try { process.kill(pid, 0); return true; } catch (error) { if (error.code === 'ESRCH') return false; throw error; } };
async function until(predicate, ms = 5000) {
  const end = Date.now() + ms; while (!predicate()) { if (Date.now() >= end) throw new Error('FIXTURE_ASSERTION_TIMEOUT'); await pause(20); }
}
async function fixture(run) {
  const root = path.join(process.cwd(), '.runtime/tmp'); fs.mkdirSync(root, { recursive: true });
  const scratch = fs.mkdtempSync(path.join(root, 'windows-package-fixture-')), cwd = path.join(scratch, 'relocated 世界 app');
  fs.mkdirSync(cwd); const marker = path.join(cwd, 'app-started.txt');
  const windows = process.env.SystemRoot ?? process.env.SYSTEMROOT;
  const powershell = path.join(windows, 'System32/WindowsPowerShell/v1.0/powershell.exe'), exe = path.join(cwd, 'grotesqueries.exe');
  const allowed = new Set(['SYSTEMROOT', 'WINDIR', 'SYSTEMDRIVE', 'COMSPEC', 'PATHEXT', 'USERPROFILE', 'APPDATA', 'LOCALAPPDATA',
    'PROGRAMFILES', 'PROGRAMFILES(X86)', 'PROGRAMDATA', 'NUMBER_OF_PROCESSORS', 'PROCESSOR_ARCHITECTURE', 'OS', 'TEMP', 'TMP']);
  const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => allowed.has(key.toUpperCase())));
  env.GUILD_FIXTURE_SECRET_MARKER = 'owned-test-marker-never-a-real-secret';
  env.GUILD_FIXTURE_STARTED = marker; env.PATH = path.join(windows, 'System32');
  const source = 'using System; using System.IO; public class OwnedFixture { public static void Main() { File.WriteAllText(Environment.GetEnvironmentVariable("GUILD_FIXTURE_STARTED"),(Environment.GetEnvironmentVariable("PSModulePath")??"absent")+"|"+(Environment.GetEnvironmentVariable("GUILD_FIXTURE_SECRET_MARKER")!=null?"present":"missing")); while(true) System.Threading.Thread.Sleep(100); } }';
  const quote = value => "'" + value.replaceAll("'", "''") + "'";
  const script = `$ErrorActionPreference='Stop'; Microsoft.PowerShell.Utility\\Add-Type -TypeDefinition ${quote(source)} -OutputAssembly ${quote(exe)} -OutputType ConsoleApplication`;
  let host, passed = false;
  try {
    try { execFileSync(powershell, ['-NoLogo', '-NoProfile', '-NonInteractive', '-EncodedCommand', Buffer.from(script, 'utf16le').toString('base64')],
      { cwd, env: { ...env, PSModulePath: path.join(path.dirname(powershell), 'Modules') }, windowsHide: true, stdio: 'pipe', timeout: 30000 }); }
    catch (error) { throw new Error('WINDOWS_FIXTURE_COMPILE_FAILED: ' + JSON.stringify({ code: error.code, signal: error.signal, status: error.status })); }
    await run({ cwd, marker, exe, env, own: value => { host = value; } }); passed = true;
  } finally {
    if (host) { try { await host.stop(); await host.dispose(); } catch (error) { await host.abort(); throw error; } }
    if (passed) fs.rmSync(scratch, { recursive: true, force: true, maxRetries: 8, retryDelay: 100 });
    else console.error('Windows fixture evidence retained at ' + cwd);
  }
}

test('native controller preserves app environment, delivers real console Ctrl+C and disposes only after graceful exit', { skip: !native }, async () => fixture(async ({ cwd, marker, exe, env, own }) => {
  const host = await startOwnedWindowsHost(exe, cwd, env, { reportDirectory: cwd }); own(host);
  await until(() => fs.existsSync(marker)); assert.equal(fs.readFileSync(marker, 'utf8'), 'absent|present');
  assert.ok(fs.readdirSync(cwd).every(file => !file.endsWith('.env')));
  for (const file of fs.readdirSync(cwd)) if (fs.lstatSync(path.join(cwd, file)).isFile()) {
    const bytes = fs.readFileSync(path.join(cwd, file));
    assert.equal(bytes.includes(Buffer.from(env.GUILD_FIXTURE_SECRET_MARKER)), false);
    assert.equal(bytes.includes(Buffer.from(env.GUILD_FIXTURE_SECRET_MARKER, 'utf16le')), false);
  }
  await host.stop(); assert.equal(alive(host.pid), false); await host.dispose(); await host.dispose();
}));

test('native controller death immediately after suspended creation contains the unacknowledged host', { skip: !native }, async () => fixture(async ({ cwd, marker, exe, env }) => {
  let created;
  await assert.rejects(startOwnedWindowsHost(exe, cwd, env, { fault: 'after-create', reportDirectory: cwd, onCreated: value => { created = value; } }), /START_FAILED/);
  assert.ok(created?.pid, 'Validated suspended identity was received before controller exited');
  await until(() => !alive(created.pid)); assert.equal(fs.existsSync(marker), false, 'No app code ran before acknowledgment');
}));


test('kit finalization preserves failed launcher evidence when ownership was never returned', async () => {
  const root = path.join(process.cwd(), '.runtime/tmp'); fs.mkdirSync(root, { recursive: true });
  const scratch = fs.mkdtempSync(path.join(root, 'guild-kit-startup-failure-'));
  try {
    const record = path.join(scratch, 'controller-report.json'); fs.writeFileSync(record, '{"ownedFixture":"unverified-close"}\n');
    const primaryFailure = new Error('WINDOWS_CONTROLLER_START_CLEANUP_FAILED');
    await assert.rejects((async () => {
      try { throw primaryFailure; }
      finally { await finalizeGuildKitFixture(scratch, { host: undefined, primaryFailure }); }
    })(), error => error === primaryFailure);
    assert.equal(fs.readFileSync(record, 'utf8'), '{"ownedFixture":"unverified-close"}\n');
    await finalizeGuildKitFixture(scratch, { host: undefined });
    assert.equal(fs.existsSync(scratch), false, 'Existing successful no-host cleanup remains unchanged');
  } finally { fs.rmSync(scratch, { recursive: true, force: true }); }
});
