import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';

export const MACOS_DEPLOYMENT_TARGET = '14.0';

export function buildNative(root) {
  if (!['darwin', 'linux'].includes(process.platform)) return;
  const name = process.platform === 'darwin' ? 'macos-processes' : 'linux-supervisor';
  const directory = path.join(root, 'dist/native');
  for (const file of [path.join(root, 'dist'), directory, path.join(directory, name)]) {
    try { if (fs.lstatSync(file).isSymbolicLink()) throw new Error('NATIVE_BUILD_SYMLINK'); }
    catch (error) { if (error.code !== 'ENOENT') throw error; }
  }
  fs.mkdirSync(directory, { recursive: true });
  execFileSync('/usr/bin/cc', ['-std=c11', '-Wall', '-Wextra', '-Werror', '-O2',
    ...(process.platform === 'darwin' ? [`-mmacosx-version-min=${MACOS_DEPLOYMENT_TARGET}`] : []),
    path.join(root, 'app/native', name + '.c'), '-o', path.join(directory, name)], { stdio: 'inherit' });
}
