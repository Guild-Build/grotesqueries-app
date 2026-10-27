import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { folderFile, loadPlugins } from '../../app/services/plugins.js';
import { readyFilePath, writeReadyFile, removeReadyFile } from '../../app/helpers/ready.js';
import { assertManagedPath, createChildEnvironment } from '../../app/helpers/runtime.js';
import { resolveExecutable } from '../../config/application.js';
import { scratchDirectory } from '../support/scratch.js';

test('native plugin paths load valid folders while refusing escapes and hidden content', () => {
  const root = scratchDirectory('portable-files-');
  const plugins = path.join(root, 'plugins');
  const good = path.join(plugins, 'good');
  fs.mkdirSync(path.join(good, 'site', '.hidden'), { recursive: true });
  fs.writeFileSync(path.join(good, 'site', 'index.html'), '<p>portable fixture</p>');
  fs.writeFileSync(path.join(good, 'site', '.hidden', 'private.txt'), 'fixture');
  const manifest = { name: 'good', contract: 3, profiles: [], commands: [],
    folders: [{ id: 'site', path: '{plugin}/site' }], pages: [{ label: 'Home', path: 'site/index.html' }] };
  fs.writeFileSync(path.join(good, 'manifest.json'), JSON.stringify(manifest));
  fs.mkdirSync(path.join(plugins, 'escape'));
  fs.writeFileSync(path.join(plugins, 'escape', 'manifest.json'), JSON.stringify({ ...manifest,
    name: 'escape', folders: [{ id: 'site', path: '{app}/../outside' }] }));
  const loaded = loadPlugins(plugins, { allowedProjectDirectories: [root], launchProfiles: [] });
  assert.deepEqual(loaded.summaries.map(item => item.name), ['good']);
  assert.deepEqual(loaded.refused.map(item => item.name), ['escape']);
  const folder = loaded.folders.get('good/site')!;
  assert.equal(folderFile(folder, [''])?.data.toString(), '<p>portable fixture</p>');
  for (const parts of [['..', 'manifest.json'], ['%2e%2e', 'manifest.json'], ['.hidden', 'private.txt'], ['%2Fetc', 'passwd']]) {
    assert.equal(folderFile(folder, parts), undefined);
  }
});

test('ready files use native paths and cleanup preserves another host record', () => {
  const root = scratchDirectory('portable-ready-');
  const file = readyFilePath(root);
  assert.equal(file, path.join(root, '.runtime', 'host-ready.json'));
  const record = { url: 'http://127.0.0.1:8765', pid: process.pid, pids: [process.pid],
    hostInstanceId: 'synthetic-fixture', plugins: [], refusals: [] };
  writeReadyFile(file, record);
  assert.deepEqual(JSON.parse(fs.readFileSync(file, 'utf8')), record);
  removeReadyFile(file, process.pid + 1); assert.equal(fs.existsSync(file), true);
  removeReadyFile(file, process.pid); assert.equal(fs.existsSync(file), false);
});

test('Windows retains local-drive containment, executable lookup and environment normalization', { skip: process.platform !== 'win32' }, () => {
  const root = scratchDirectory('portable-windows-');
  assert.equal(assertManagedPath(root, path.join(root, 'future', 'file')), path.join(root, 'future', 'file'));
  for (const target of ['\\\\server\\share\\folder', path.parse(root).root, path.join(root, '..', 'outside'), root + '\\ambiguous.']) {
    assert.throws(() => assertManagedPath(root, target));
  }
  assert.equal(resolveExecutable(process.execPath, {}), fs.realpathSync.native(process.execPath));
  assert.equal(resolveExecutable('node', { Path: path.dirname(process.execPath) }), fs.realpathSync.native(process.execPath));
  assert.throws(() => resolveExecutable('run.cmd', { PATH: root }));
  const child = createChildEnvironment(root, 'fixture', { Path: 'inherited', HOME: 'inherited-home' }, { Mixed: 'value' });
  assert.equal(child.PATH, 'inherited'); assert.equal(child.MIXED, 'value'); assert.equal(child.HOME, 'inherited-home');
  assert.match(child.TMPDIR, /^\/[a-z]\//);
  assert.throws(() => createChildEnvironment(root, 'ambiguous', { PATH: 'one', Path: 'two' }), /ambiguous/);
});
