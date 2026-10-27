import fs from 'node:fs';
import path from 'node:path';
import { root } from './build.mjs';

export function runtimeEnvironment() {
  const temporary = path.join(root, '.runtime', 'tmp');
  fs.mkdirSync(temporary, { recursive: true });
  return { ...process.env, TEMP: temporary, TMP: temporary,
    TMPDIR: process.platform === 'win32'
      ? temporary.replace(/^([a-z]):/i, (_, drive) => '/' + drive.toLowerCase()).replaceAll('\\', '/')
      : temporary };
}
