import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import test from 'node:test';
import { assertSourceNode } from '../../bin/licenses.mjs';

const root = process.cwd();
const manifest = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'));

test('source runtime selection agrees with install metadata and rejects other Node versions', () => {
  const pin = fs.readFileSync(path.join(root, '.nvmrc'), 'utf8').trim();
  assert.equal(pin, manifest.engines.node);
  assert.equal(JSON.parse(fs.readFileSync(path.join(root, 'package-lock.json'), 'utf8')).packages[''].engines.node, pin);
  assert.doesNotThrow(() => assertSourceNode(root, 'v' + pin));
  for (const version of ['v26.4.0', 'v24.14.0', 'v24.14.2']) {
    assert.throws(() => assertSourceNode(root, version), error => {
      assert.match(error.message, /NODE_VERSION_UNSUPPORTED/);
      assert.ok(error.message.includes('v' + pin) && error.message.includes(version));
      return true;
    });
  }
});

test('the real build command checks Node before workspace effects even with ignore-scripts', { timeout: 20000 }, () => {
  const temporary = path.join(root, '.runtime', 'tmp'); fs.mkdirSync(temporary, { recursive: true });
  const folder = fs.mkdtempSync(path.join(temporary, 'source-node-'));
  try {
    fs.mkdirSync(path.join(folder, 'bin'));
    for (const name of ['check-node.mjs', 'licenses.mjs']) fs.copyFileSync(path.join(root, 'bin', name), path.join(folder, 'bin', name));
    fs.writeFileSync(path.join(folder, 'package.json'), JSON.stringify({ name: 'source-node-fixture', private: true, type: 'module',
      engines: manifest.engines, workspaces: ['lib/protocol', 'frame'], scripts: { build: manifest.scripts.build } }));
    const trace = path.join(folder, 'effects');
    const effect = `import fs from 'node:fs'; fs.appendFileSync(${JSON.stringify(trace)}, 'built\\n');`;
    for (const name of ['lib/protocol', 'frame']) {
      const directory = path.join(folder, name); fs.mkdirSync(directory, { recursive: true });
      fs.writeFileSync(path.join(directory, 'package.json'), JSON.stringify({ name: 'fixture-' + name.replace('/', '-'), type: 'module', scripts: { build: 'node build.mjs' } }));
      fs.writeFileSync(path.join(directory, 'build.mjs'), effect);
    }
    fs.writeFileSync(path.join(folder, 'bin/build.mjs'), effect);
    const preload = 'data:text/javascript,' + encodeURIComponent('Object.defineProperty(process,"version",{value:"v26.4.0"})');
    const bad = spawnSync('npm run build --ignore-scripts', { cwd: folder, shell: true, encoding: 'utf8', timeout: 10000,
      env: { ...process.env, NODE_OPTIONS: '--import=' + preload } });
    assert.equal(bad.error, undefined); assert.notEqual(bad.status, 0);
    assert.match(bad.stderr, /NODE_VERSION_UNSUPPORTED.*v24\.14\.1.*v26\.4\.0/);
    assert.equal(fs.existsSync(trace), false, 'No protocol, frame or host build may run after the rejected version');
    const env = { ...process.env }; delete env.NODE_OPTIONS;
    const good = spawnSync('npm run build --ignore-scripts', { cwd: folder, shell: true, encoding: 'utf8', timeout: 10000, env });
    assert.equal(good.error, undefined); assert.equal(good.status, 0, good.stderr);
    assert.equal(fs.readFileSync(trace, 'utf8'), 'built\nbuilt\nbuilt\n');
  } finally { fs.rmSync(folder, { recursive: true, force: true }); }
});
