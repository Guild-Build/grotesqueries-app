import fs from 'node:fs';
import path from 'node:path';
import { spawn, spawnSync } from 'node:child_process';
import { build as compile } from 'esbuild';
import { root } from './build.mjs';
import { runtimeEnvironment } from './runtime.mjs';

// Requirement 4.1.3, 4.1.4, ledger 0.2 and 0.6 item 4: list .runtime and one level inside .runtime/tmp before the suite
// and after it. A new name other than the runner's bundles (test), the host's logs (logs) and TEMP (tmp) fails the run.
const runtimeDirectory = path.join(root, '.runtime');
const allowed = ['logs', 'test', 'tmp'];
// Job file 7.6: names a deferred file may still leave, each with its row in DEMO.md. Empty: every target file is fixed.
const deferred = [];
const listRuntime = () => {
  const list = name => { try { return fs.readdirSync(path.join(runtimeDirectory, name)); } catch { return []; } };
  return new Set([...list(''), ...list('tmp').map(name => `tmp/${name}`)]);
};
const before = listRuntime();

const requested = process.argv.slice(2);
const testRoot = path.join(root, 'test');
// test/fixtures holds inputs, such as the leaking test the check must fail on; they run only when named.
const tests = fs.readdirSync(testRoot, { recursive: true })
  .filter(name => /\.test\.(ts|mjs)$/.test(name) && (requested.length
    ? requested.some(part => name.includes(part)) : !['pty.test.ts', 'concurrent-pty.test.mjs'].includes(path.basename(name))
      && !name.startsWith('fixtures')));
if (!tests.length) throw new Error('No matching behavior tests.');
const output = path.join(root, '.runtime', 'test');
// npm enables Node's compile cache; keep test-runner cache beside its owned bundles.
const testEnvironment = { ...runtimeEnvironment(), NODE_COMPILE_CACHE: path.join(output, 'compile-cache') };
const typed = tests.filter(name => name.endsWith('.ts'));
if (typed.length) await compile({ entryPoints: typed.map(name => path.join(testRoot, name)), outdir: output, outbase: testRoot,
  outExtension: { '.js': '.cjs' }, bundle: true, conditions: ['grotesqueries-source'], platform: 'node', format: 'cjs', target: 'node24',
  external: ['node-pty', 'ws'], logLevel: 'warning' });
const child = spawn(process.execPath, ['--test', '--test-concurrency=1',
  ...tests.map(name => name.endsWith('.ts') ? path.join(output, name.replace(/\.ts$/, '.cjs')) : path.join(root, 'test', name))],
{ cwd: root, env: testEnvironment, stdio: 'inherit', windowsHide: true });
child.on('error', error => { console.error(error.message); process.exitCode = 1; });
child.on('exit', code => {
  process.exitCode = code ?? 1;
  // Job 9, requirement 4.2.2: with no test named, the frame's unit tests follow as a named step; they write frame/.runtime.
  if (!requested.length) {
    console.log('Frame tests: npm test -w frame');
    const frame = spawnSync('npm test -w frame', { cwd: root, env: testEnvironment, stdio: 'inherit', shell: true, windowsHide: true });
    if (frame.status !== 0) process.exitCode = 1;
  }
  const left = [...listRuntime()].filter(name => !before.has(name) && !allowed.includes(name) && !deferred.includes(name));
  console.log(`Runtime check: allowed ${[...allowed, ...deferred].join(', ')}; ` +
    (left.length ? `FAILED, new under .runtime: ${left.join(', ')}` : 'nothing else new under .runtime'));
  if (left.length) process.exitCode = 1;
});
