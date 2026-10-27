import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { assertManagedPath, createChildEnvironment, isWithin, resolveRuntime } from '../../app/helpers/runtime.js';
import { scratchDirectory } from '../support/scratch.js';

const skip = process.platform === 'win32';

test('POSIX runtime resolves source, package and caller-relative configuration paths', { skip }, () => {
  const root = scratchDirectory('posix-runtime-');
  const sourceEntry = path.join(root, 'dist/host/server.js');
  const runtime = resolveRuntime({ sourceEntry });
  assert.equal(runtime.root, root);
  assert.equal(runtime.configFile, path.join(root, 'config/grotesqueries.json'));
  assert.equal(runtime.temporary, path.join(root, '.runtime/tmp'));
  assert.equal(runtime.packaged, false);
  const relative = path.relative(process.cwd(), path.join(root, 'source.json'));
  assert.equal(resolveRuntime({ sourceEntry, configFile: relative }).configFile, path.join(root, 'source.json'));
  const packaged = resolveRuntime({ executable: path.join(root, 'grotesqueries') });
  assert.equal(packaged.root, root);
  assert.equal(packaged.configFile, path.join(root, 'grotesqueries.json'));
  assert.equal(packaged.packaged, true);
  for (const configFile of ['', '../outside.json', '//server/share/config.json', 'C:/project/config.json', 'C:\\project\\config.json']) {
    assert.throws(() => resolveRuntime({ sourceEntry, configFile }), /Managed path/);
  }
});

test('POSIX containment is case-sensitive and rejects root, foreign, network and traversal paths', { skip }, () => {
  const root = scratchDirectory('posix-paths-');
  assert.equal(isWithin('/work/Project', '/work/Project/child'), true);
  assert.equal(isWithin('/work/Project', '/work/project/child'), false);
  assert.equal(isWithin('/work/Project', '/work/Project-extra'), false);
  assert.equal(assertManagedPath(root, path.join(root, 'new/deep/file')), path.join(root, 'new/deep/file'));
  for (const destination of ['/', 'relative', '//server/share/project', 'C:/project', 'C:\\project', path.join(root, '../outside'), root + '\0bad']) {
    assert.throws(() => assertManagedPath(root, destination));
  }
  assert.throws(() => assertManagedPath('/', '/project'), /beneath the filesystem root/);
});

test('POSIX managed paths reject escaping and dangling symlinks before creating directories', { skip }, () => {
  const scratch = scratchDirectory('posix-links-');
  const root = path.join(scratch, 'project');
  const outside = path.join(scratch, 'outside');
  fs.mkdirSync(root); fs.mkdirSync(outside);
  fs.symlinkSync(outside, path.join(root, 'escape'));
  assert.throws(() => assertManagedPath(root, path.join(root, 'escape/not-created/deep')), /escapes/);
  fs.symlinkSync(path.join(outside, 'missing'), path.join(root, 'dangling'));
  assert.throws(() => assertManagedPath(root, path.join(root, 'dangling/new')), /symbolic link/);
  const inner = path.join(root, 'inner'); fs.mkdirSync(inner);
  fs.symlinkSync(inner, path.join(root, 'within'));
  assert.equal(assertManagedPath(root, path.join(root, 'within/new')), path.join(root, 'within/new'));
  assert.deepEqual(fs.readdirSync(outside), []);
});

test('POSIX child environments preserve case and inherited authentication homes with native scoped temp', { skip }, () => {
  const root = scratchDirectory('posix-environment-');
  const inherited = { PATH: '/usr/bin:/bin', Path: 'case-sensitive-value', HOME: '/home/inherited',
    CODEX_HOME: '/home/inherited/.codex', USERPROFILE: 'inherited-profile', MixedName: 'original', TERM: 'dumb' };
  const result = createChildEnvironment(root, 'case-fixture', inherited, { MixedName: 'changed', mixedname: 'distinct' });
  assert.equal(result.PATH, inherited.PATH); assert.equal(result.Path, inherited.Path);
  assert.equal(result.HOME, inherited.HOME); assert.equal(result.CODEX_HOME, inherited.CODEX_HOME);
  assert.equal(result.USERPROFILE, inherited.USERPROFILE);
  assert.equal(result.MixedName, 'changed'); assert.equal(result.mixedname, 'distinct');
  assert.equal(result.TERM, 'xterm-256color');
  assert.equal(result.TMPDIR, path.join(root, '.runtime/tmp/case-fixture'));
  assert.equal(result.TMP, result.TMPDIR); assert.equal(result.TEMP, result.TMPDIR);
  assert.equal(fs.statSync(result.TMPDIR).isDirectory(), true);
  assert.equal(inherited.MixedName, 'original');
  for (const name of ['TEMP', 'tmp', 'TmpDir', 'HOME', 'home', 'USERPROFILE', 'CODEX_HOME']) {
    assert.throws(() => createChildEnvironment(root, 'reserved', inherited, { [name]: '/outside' }), /reserved/);
  }
  assert.throws(() => createChildEnvironment(root, '../escape', inherited), /identity/);
});
