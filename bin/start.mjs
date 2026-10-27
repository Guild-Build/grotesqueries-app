import path from 'node:path';
import { spawn } from 'node:child_process';
import { root } from './build.mjs';
import { runtimeEnvironment } from './runtime.mjs';

const child = spawn(process.execPath, [path.join(root, 'dist', 'host', 'server.js')], {
  // Requirement 4.2.1: the server lists this launcher's pid in the ready file, so bin/stop.mjs ends both.
  cwd: root, env: { ...runtimeEnvironment(), GROTESQUERIES_LAUNCHER_PID: String(process.pid) }, stdio: 'inherit', windowsHide: true,
});
child.on('error', (error) => { console.error(error.message); process.exitCode = 1; });
child.on('exit', (code) => { process.exitCode = code ?? 1; });
process.once('SIGINT', () => child.kill('SIGINT'));
process.once('SIGTERM', () => child.kill('SIGTERM'));
