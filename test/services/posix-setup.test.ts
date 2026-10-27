import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { setupPosix } from '../../app/services/setup-posix.js';
import { loadConfig } from '../../config/application.js';
import { scratchDirectory } from '../support/scratch.js';

const skip = process.platform === 'win32';
test('native setup discovers without executing tools and preserves existing configuration', { skip }, () => {
  const root = scratchDirectory('posix-setup-');
  fs.mkdirSync(path.join(root, 'frame/dist'), { recursive: true });
  fs.mkdirSync(path.join(root, 'tools'));
  const sentinel = path.join(root, 'executed');
  fs.writeFileSync(path.join(root, 'tools/codex'), '#!/bin/sh\ntouch "' + sentinel + '"\n', { mode: 0o755 });
  fs.mkdirSync(path.join(root, 'config'));
  const original = '{"operator":"must remain unchanged"}\n';
  fs.writeFileSync(path.join(root, 'config/grotesqueries.json'), original);
  const file = setupPosix(root, false, { PATH: path.join(root, 'tools') });
  const config = loadConfig(file, root);
  assert.ok(config.launchProfiles.some(profile => profile.id === 'codex'));
  assert.ok(config.launchProfiles.some(profile => ['bash', 'sh', 'zsh'].includes(profile.id)));
  assert.equal(fs.existsSync(sentinel), false);
  assert.equal(fs.readFileSync(path.join(root, 'config/grotesqueries.json'), 'utf8'), original);
  const raw = JSON.parse(fs.readFileSync(file, 'utf8')); raw.terminal.scrollbackLines = 2345;
  const saved = JSON.stringify(raw); fs.writeFileSync(file, saved);
  assert.equal(setupPosix(root, false, { PATH: '' }), file);
  assert.equal(fs.readFileSync(file, 'utf8'), saved);
  assert.throws(() => setupPosix(root, true, { PATH: '' }));
  assert.equal(fs.readFileSync(path.join(root, 'config/grotesqueries.json'), 'utf8'), original);
});

test('package setup works with no tools on PATH and refuses linked config paths', { skip }, () => {
  const root = scratchDirectory('posix-package-setup-');
  fs.mkdirSync(path.join(root, 'frame/dist'), { recursive: true });
  const file = setupPosix(root, true, { PATH: '' });
  assert.equal(file, path.join(root, 'config/grotesqueries.json'));
  assert.ok(loadConfig(file, root).launchProfiles.length > 0);
  const linked = scratchDirectory('posix-setup-link-');
  fs.symlinkSync(path.join(root, 'config'), path.join(linked, 'config'));
  assert.throws(() => setupPosix(linked, true, { PATH: '' }), /escapes|link/);
});
