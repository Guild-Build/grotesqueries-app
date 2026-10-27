// Requirement 4.2.4, J4-O2: the package's build. dist is cleared here, in code, before tsc writes it, so no stale file
// from an earlier build survives; the test proves the clear by planting one, not by reading this script's text.
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const packageRoot = path.dirname(fileURLToPath(import.meta.url));

export function buildProtocol() {
  fs.rmSync(path.join(packageRoot, 'dist'), { recursive: true, force: true });
  execFileSync(process.execPath, [createRequire(import.meta.url).resolve('typescript/bin/tsc'), '-p', 'tsconfig.build.json'],
    { cwd: packageRoot, windowsHide: true, timeout: 120000, stdio: 'inherit' });
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) buildProtocol();
