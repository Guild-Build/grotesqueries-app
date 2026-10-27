import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fork, spawn, type ChildProcess } from 'node:child_process';
import { once } from 'node:events';
import test from 'node:test';
import { NodePtyLauncher } from '../../app/services/node-pty.js';
import type { PtyHandle } from '../../app/services/pty.js';

const skip = process.platform !== 'win32';
const alive = (pid: number): boolean => {
  try { process.kill(pid, 0); return true; }
  catch (error) { if ((error as NodeJS.ErrnoException).code === 'ESRCH') return false; throw error; }
};
type DiagnosticValue = string | number | boolean | null;
type ErrorRecord = { message: string; stack?: string; code?: string | number | null; signal?: string | null; killed?: boolean;
  stdoutBytes?: number; stderrBytes?: number; diagnostics?: Record<string, DiagnosticValue>; cause?: ErrorRecord };
type CaseReport = { name: string; passed: boolean; cleanupVerified: boolean; knownPids: number[];
  primary?: ErrorRecord; cleanupErrors: ErrorRecord[] };
function recordError(error: unknown, depth = 0): ErrorRecord {
  const record: ErrorRecord = error instanceof Error
    ? { message: error.message.slice(0, 4096), stack: error.stack?.slice(0, 8192) } : { message: String(error).slice(0, 4096) };
  if (!error || typeof error !== 'object') return record;
  const fields = error as Record<string, unknown>;
  if (fields.code === null || typeof fields.code === 'number' || typeof fields.code === 'string') record.code = typeof fields.code === 'string' ? fields.code.slice(0, 128) : fields.code;
  if (fields.signal === null || typeof fields.signal === 'string') record.signal = fields.signal;
  if (typeof fields.killed === 'boolean') record.killed = fields.killed;
  for (const name of ['stdout', 'stderr'] as const) {
    const value = fields[name], size = fields[name + 'Bytes'];
    if (typeof value === 'string' || Buffer.isBuffer(value)) record[name + 'Bytes' as 'stdoutBytes' | 'stderrBytes'] = Buffer.byteLength(value);
    else if (typeof size === 'number' && Number.isSafeInteger(size) && size >= 0) record[name + 'Bytes' as 'stdoutBytes' | 'stderrBytes'] = size;
  }
  if (fields.diagnostics && typeof fields.diagnostics === 'object') {
    const diagnostics: Record<string, DiagnosticValue> = {};
    for (const key of ['phase', 'kind', 'elapsedMs', 'timeoutMs', 'code', 'signal', 'killed', 'stdoutBytes', 'stderrBytes']) {
      const value = (fields.diagnostics as Record<string, unknown>)[key];
      if (value === null || typeof value === 'boolean' || typeof value === 'number' && Number.isFinite(value) || typeof value === 'string' && value.length <= 128) diagnostics[key] = value as DiagnosticValue;
    }
    record.diagnostics = diagnostics;
  }
  if (fields.cause !== undefined && depth < 3) record.cause = recordError(fields.cause, depth + 1);
  return record;
}
const restoredError = ({ message, stack, cause, ...metadata }: ErrorRecord): Error => Object.assign(
  new Error(message, cause ? { cause: restoredError(cause) } : undefined), { stack, ...metadata });
async function until(predicate: () => boolean, description: string): Promise<void> {
  const deadline = Date.now() + 15000;
  while (!predicate()) { if (Date.now() >= deadline) throw new Error('WINDOWS_NATIVE_TIMEOUT: ' + description); await new Promise(resolve => setTimeout(resolve, 20)); }
}
async function launch(source: string, directory: string, stopTree?: ConstructorParameters<typeof NodePtyLauncher>[2]): Promise<PtyHandle> {
  const native = path.join(directory, 'node_modules/node-pty'), installed = path.join(process.cwd(), 'node_modules/node-pty');
  fs.mkdirSync(path.join(native, 'prebuilds/win32-x64'), { recursive: true });
  fs.cpSync(path.join(installed, 'lib'), path.join(native, 'lib'), { recursive: true });
  for (const file of ['package.json', 'LICENSE', 'prebuilds/win32-x64/conpty.node', 'prebuilds/win32-x64/conpty_console_list.node']) {
    fs.copyFileSync(path.join(installed, file), path.join(native, file));
  }
  return new NodePtyLauncher(directory, undefined, stopTree).start({ id: 'fixture', label: 'Windows fixture', executable: process.execPath,
    args: ['-e', source], projectDirectory: directory, environment: {} }, 100, 30, path.basename(directory).replaceAll(' ', '-'));
}

async function exercise(name: string, directory: string): Promise<CaseReport> {
  let pty: PtyHandle | undefined, sibling: ChildProcess | undefined, siblingExited: Promise<unknown> | undefined;
  let primary: ErrorRecord | undefined, cleanupVerified = false, injectedFailure = false;
  const cleanupErrors: ErrorRecord[] = [], knownPids: number[] = [];
  try {
    if (name === 'natural-exit') {
      const grandchild = 'setInterval(()=>{},1000)';
      const child = `const child=require('node:child_process').spawn(process.execPath,['-e',${JSON.stringify(grandchild)}],{detached:true,windowsHide:true,stdio:'ignore'});process.send({child:process.pid,grandchild:child.pid});setInterval(()=>{},1000)`;
      const source = `const child=require('node:child_process').spawn(process.execPath,['-e',${JSON.stringify(child)}],{detached:true,windowsHide:true,stdio:['ignore','ignore','ignore','ipc']});child.on('message',value=>console.log('TREE:'+JSON.stringify(value)));process.stdin.setRawMode(true);process.stdin.on('data',()=>{console.log('WINDOWS_ROOT_FINAL');process.exit(7)});setInterval(()=>{},1000)`;
      pty = await launch(source, directory); knownPids.push(pty.pid);
      sibling = spawn(process.execPath, ['-e', 'setInterval(()=>{},1000)'], { windowsHide: true, stdio: 'ignore' });
      siblingExited = once(sibling, 'exit'); void siblingExited.catch(() => {});
      if (sibling.pid) knownPids.push(sibling.pid);
      let output = '', code: number | undefined, cleanup: boolean | undefined;
      pty.onOutput(data => { output += data; }); pty.onExit((value, remaining) => { code = value; cleanup = remaining; });
      await until(() => /TREE:\{[^\r\n]+\}/.test(output), 'native descendants');
      const descendants = JSON.parse(/TREE:(\{[^\r\n]+\})/.exec(output)![1]) as { child: number; grandchild: number };
      knownPids.push(descendants.child, descendants.grandchild);
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
    } else if (name === 'failed-stop') {
      const { stopProcessTree } = await import('../../app/services/process-tree.js');
      injectedFailure = true;
      pty = await launch("console.log('WINDOWS_READY');process.stdin.setRawMode(true);process.stdin.on('data',()=>process.exit(5));setInterval(()=>{},1000)", directory,
        async (pid, ownership) => { if (injectedFailure) throw new Error('OWNED_TEST_METADATA_FAILED'); return stopProcessTree(pid, ownership); });
      knownPids.push(pty.pid);
      let output = '', exited = false; pty.onOutput(data => { output += data; }); pty.onExit(() => { exited = true; });
      await until(() => output.includes('WINDOWS_READY'), 'ready'); pty.write('x'); await until(() => exited, 'primary exit');
      await assert.rejects(pty.stop(), /OWNED_TEST_METADATA_FAILED/);
      let cleanup: boolean | undefined; pty.onExit((_code, remaining) => { cleanup = remaining; });
      await until(() => cleanup !== undefined, 'failed cleanup evidence'); assert.equal(cleanup, true);
      injectedFailure = false; assert.equal((await pty.stop()).exitCode, 5);
    } else throw new Error('WINDOWS_NATIVE_CASE_INVALID');
  } catch (error) { primary = recordError(error); }
  finally {
    injectedFailure = false;
    if (pty) {
      try { await pty.stop(); cleanupVerified = true; }
      catch (error) { cleanupErrors.push(recordError(error)); }
    }
    if (sibling) {
      try { if (sibling.exitCode === null && sibling.signalCode === null) sibling.kill(); await siblingExited; }
      catch (error) { cleanupErrors.push(recordError(error)); cleanupVerified = false; }
    }
  }
  return { name, passed: !primary && !cleanupErrors.length && cleanupVerified, cleanupVerified, knownPids, primary, cleanupErrors };
}

/** Native addons remain mapped until their loading process exits. Only the parent removes that process's fixture. */
async function isolated(name: string, directory: string): Promise<void> {
  const environment = { ...process.env }; delete environment.NODE_TEST_CONTEXT;
  const child = fork(__filename, ['--windows-native-worker', name, directory], {
    execArgv: [], env: environment, stdio: ['ignore', 'pipe', 'pipe', 'ipc'], windowsHide: true,
  });
  let report: CaseReport | undefined, output = '', errors = '', timedOut = false;
  child.stdout?.on('data', data => { output = (output + data).slice(-65536); });
  child.stderr?.on('data', data => { errors = (errors + data).slice(-65536); });
  child.on('message', value => { if (value && typeof value === 'object' && (value as CaseReport).name === name) report = value as CaseReport; });
  const timer = setTimeout(() => { timedOut = true; child.kill(); }, 40000);
  let code: number | null;
  try { [code] = await once(child, 'exit') as [number | null]; }
  finally { clearTimeout(timer); }
  if (timedOut || code !== 0 || !report?.passed || !report.cleanupVerified) {
    const failures: Error[] = [];
    if (report?.primary) failures.push(restoredError(report.primary));
    failures.push(...(report?.cleanupErrors ?? []).map(restoredError));
    if (!failures.length) failures.push(new Error((timedOut ? 'WINDOWS_NATIVE_WORKER_TIMEOUT' : 'WINDOWS_NATIVE_WORKER_FAILED') + `: exit ${code}; ${output}${errors}`));
    throw new AggregateError(failures, 'Windows native fixture failed; evidence preserved at ' + directory, { cause: failures[0] });
  }
  try { fs.rmSync(directory, { recursive: true, force: true, maxRetries: 8, retryDelay: 100 }); }
  catch (error) { throw new Error('WINDOWS_NATIVE_FIXTURE_REMOVE_FAILED: Passed native checks; fixture preserved at ' + directory, { cause: error }); }
}
function fixtureDirectory(): string {
  const temporary = path.join(process.cwd(), '.runtime/tmp'); fs.mkdirSync(temporary, { recursive: true });
  return fs.mkdtempSync(path.join(temporary, 'windows-native-'));
}

const worker = process.argv[2] === '--windows-native-worker';
if (worker) {
  const name = process.argv[3], directory = process.argv[4];
  if (!directory || !path.isAbsolute(directory) || path.dirname(directory) !== path.join(process.cwd(), '.runtime/tmp') || !path.basename(directory).startsWith('windows-native-')) {
    throw new Error('WINDOWS_NATIVE_WORKER_DIRECTORY');
  }
  void (async () => {
    const report: CaseReport = name === 'harness-pass'
      ? { name, passed: true, cleanupVerified: true, knownPids: [], cleanupErrors: [] }
      : name === 'harness-errors'
        ? { name, passed: false, cleanupVerified: false, knownPids: [], primary: recordError(Object.assign(
          new Error('OWNED_PRIMARY_FIXTURE_FAILURE', { cause: Object.assign(new Error('OWNED_COMMAND_FAILURE'),
            { code: 23, signal: null, killed: false, stdout: 'owned-private-stdout', stderr: 'owned-private-stderr' }) }),
          { code: 'STOP_SNAPSHOT_QUERY_FAILED', diagnostics: { phase: 'snapshot', kind: 'exit', elapsedMs: 12, timeoutMs: 5000,
            code: 23, signal: null, killed: false, stdoutBytes: 20, stderrBytes: 20 } })), cleanupErrors: [{ message: 'OWNED_CLEANUP_FIXTURE_FAILURE' }] }
        : await exercise(name, directory);
    fs.writeFileSync(path.join(directory, 'case-report.json'), JSON.stringify(report, null, 2) + '\n');
    if (typeof process.send !== 'function') throw new Error('WINDOWS_NATIVE_WORKER_IPC');
    process.send(report, () => process.exit(report.passed ? 0 : 1));
  })().catch(error => { console.error(error); process.exit(1); });
} else {
  test('Windows native fixture isolation removes files after worker exit and preserves both failure causes', async () => {
    const passed = fixtureDirectory(); await isolated('harness-pass', passed); assert.equal(fs.existsSync(passed), false);
    const failed = fixtureDirectory();
    try {
      await assert.rejects(isolated('harness-errors', failed), error => {
        assert.ok(error instanceof AggregateError);
        assert.deepEqual(error.errors.map(value => (value as Error).message), ['OWNED_PRIMARY_FIXTURE_FAILURE', 'OWNED_CLEANUP_FIXTURE_FAILURE']);
        const primary = error.errors[0] as Error & ErrorRecord;
        assert.equal(primary.code, 'STOP_SNAPSHOT_QUERY_FAILED'); assert.equal(primary.diagnostics?.phase, 'snapshot');
        assert.equal(primary.diagnostics?.timeoutMs, 5000); assert.equal(primary.cause?.code, 23);
        assert.equal(primary.cause?.signal, null); assert.equal(primary.cause?.killed, false);
        assert.equal(primary.cause?.stdoutBytes, Buffer.byteLength('owned-private-stdout'));
        assert.equal(primary.cause?.stderrBytes, Buffer.byteLength('owned-private-stderr'));
        assert.equal(JSON.stringify(primary).includes('owned-private-'), false);
        return true;
      });
      assert.equal(JSON.parse(fs.readFileSync(path.join(failed, 'case-report.json'), 'utf8')).cleanupVerified, false);
    } finally { fs.rmSync(failed, { recursive: true, force: true }); }
  });
  test('Windows natural root exit retains child/grandchild ownership and late exit subscribers until verified Stop', { skip, timeout: 45000 },
    () => isolated('natural-exit', fixtureDirectory()));
  test('Windows failed Stop remains retryable after primary exit and does not clear cleanup evidence', { skip, timeout: 45000 },
    () => isolated('failed-stop', fixtureDirectory()));
}
