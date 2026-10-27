import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { frameFolder, parseConfig, projectPath, resolveExecutable } from '../../config/application.js';
import { parseFleet } from '../../config/fleet.js';
import { scratchDirectory } from '../support/scratch.js';

const skip = process.platform === 'win32';
function executable(directory: string, name = 'fixture-cli', mode = 0o755): string {
  fs.mkdirSync(directory, { recursive: true });
  const file = path.join(directory, name);
  fs.writeFileSync(file, '#!/bin/sh\nexit 0\n', { mode });
  return file;
}
function configuration() {
  return { version: 1, allowedProjectDirectories: ['.'], launchProfiles: [],
    terminal: { scrollbackLines: 10000, recentOutputBytes: 8388608 },
    diagnostics: { directory: '.runtime/logs', maxFiles: 4, maxFileBytes: 1048576 } };
}

test('POSIX executable lookup uses exact PATH case and skips empty, relative and non-executable entries', { skip }, () => {
  const root = scratchDirectory('posix-executables-');
  const tools = path.join(root, 'tools');
  const file = executable(tools);
  const readonly = executable(path.join(root, 'readonly'), 'fixture-cli', 0o644);
  assert.equal(resolveExecutable('fixture-cli', { PATH: `:relative:${path.dirname(readonly)}:${tools}`, Path: '/ignored' }), file);
  assert.equal(resolveExecutable(file, {}), file);
  assert.equal(resolveExecutable('./tools/fixture-cli', {}, root), file);
  assert.throws(() => resolveExecutable('fixture-cli', { PATH: ':relative', Path: tools }), /EXECUTABLE_NOT_FOUND/);
  assert.throws(() => resolveExecutable('fixture-cli', { Path: tools }), /EXECUTABLE_NOT_FOUND/);
  assert.throws(() => resolveExecutable(readonly, {}), /EXECUTABLE_NOT_FOUND/);
  assert.throws(() => resolveExecutable(tools, {}), /EXECUTABLE_NOT_FOUND/);
  assert.throws(() => resolveExecutable('./tools/fixture-cli', {}), /application root/);
  assert.throws(() => resolveExecutable('fixture-cli; echo unsafe', { PATH: tools }), /EXECUTABLE_NOT_FOUND/);
  for (const foreign of ['C:/Windows/shell.exe', 'C:\\Windows\\shell.exe', '//server/share/shell', 'bad\0name']) {
    assert.throws(() => resolveExecutable(foreign, { PATH: tools }));
  }
});

test('POSIX local executable profiles cannot escape through relative traversal or symlinks', { skip }, () => {
  const scratch = scratchDirectory('posix-profile-links-');
  const root = path.join(scratch, 'project'); fs.mkdirSync(root);
  const outside = executable(path.join(scratch, 'outside'));
  fs.symlinkSync(path.dirname(outside), path.join(root, 'linked'));
  assert.throws(() => resolveExecutable('../outside/fixture-cli', {}, root), /escapes/);
  assert.throws(() => resolveExecutable('./linked/fixture-cli', {}, root), /escapes/);
  const profile = { id: 'shell', label: 'Shell', executable: outside, args: [], projectDirectory: './linked', environment: {} };
  assert.throws(() => parseConfig({ ...configuration(), launchProfiles: [profile] }, path.join(root, 'grotesqueries.json'), root), /outside allowed directories/);
  // Absolute installed tools can be outside the application folder.
  assert.equal(resolveExecutable(outside, {}, root), outside);
});

test('POSIX configuration accepts local shell profiles and case-sensitive environment overrides', { skip }, () => {
  const root = scratchDirectory('posix-config-');
  const file = executable(path.join(root, 'tools'));
  const frame = path.join(root, 'frame'); fs.mkdirSync(frame);
  const profile = { id: 'shell', label: 'Shell', executable: './tools/fixture-cli', args: ['-i'],
    projectDirectory: '.', environment: { Mixed: 'first', MIXED: 'second' } };
  const config = parseConfig({ ...configuration(), launchProfiles: [profile], frame: './frame' }, path.join(root, 'grotesqueries.json'), root);
  assert.equal(config.launchProfiles[0].executable, file);
  assert.equal(config.launchProfiles[0].projectDirectory, fs.realpathSync.native(root));
  assert.deepEqual(config.launchProfiles[0].environment, profile.environment);
  assert.equal(config.diagnostics.directory, path.join(root, '.runtime/logs'));
  assert.equal(config.frame, frame); assert.equal(config.port, 8765);
  for (const key of ['HOME', 'home', 'tmpdir', 'CODEX_HOME']) {
    assert.throws(() => parseConfig({ ...configuration(), launchProfiles: [{ ...profile, environment: { [key]: '/outside' } }] },
      path.join(root, 'grotesqueries.json'), root), /reserved/);
  }
  for (const directory of ['/outside', '../outside', 'C:/outside', 'C:\\outside']) {
    assert.throws(() => parseConfig({ ...configuration(), diagnostics: { ...configuration().diagnostics, directory } },
      path.join(root, 'grotesqueries.json'), root));
  }
  for (const foreign of ['C:/project', 'C:\\project', '//server/share/project']) {
    assert.throws(() => projectPath(foreign, 'Project', root));
    assert.throws(() => parseConfig(configuration(), foreign + '/grotesqueries.json', root));
  }
});

test('POSIX frame and fleet paths retain containment, link and hidden-folder restrictions', { skip }, () => {
  const scratch = scratchDirectory('posix-fleet-');
  const root = path.join(scratch, 'project'); fs.mkdirSync(root);
  const outside = path.join(scratch, 'outside'); fs.mkdirSync(outside);
  fs.mkdirSync(path.join(root, 'frame')); fs.mkdirSync(path.join(root, '.hidden'));
  fs.symlinkSync(outside, path.join(root, 'linked'));
  assert.equal(frameFolder('./frame', root), path.join(root, 'frame'));
  assert.throws(() => frameFolder('./.hidden', root), /starts with a dot/);
  assert.throws(() => frameFolder('./linked', root), /junction or link/);
  const coordinator = { port: 8766, workerPort: 8767, developmentAccept: true, workers: [] };
  const fleet = parseFleet({ coordinator }, root, 8765);
  assert.equal(fleet.coordinator?.stateFile, path.join(root, '.runtime/fleet.sqlite'));
  for (const stateFile of ['../outside/fleet.sqlite', './linked/fleet.sqlite', 'C:/outside/fleet.sqlite', '//server/share/fleet.sqlite']) {
    assert.throws(() => parseFleet({ coordinator: { ...coordinator, stateFile } }, root, 8765));
  }
});
