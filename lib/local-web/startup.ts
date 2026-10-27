import { createInterface } from 'node:readline';
import type { Readable, Writable } from 'node:stream';
import fs from 'node:fs';
import path from 'node:path';
import { assertManagedPath } from './runtime.js';

/** Keep an interactive failure visible; scripts and helper pipes never wait. */
export async function reportStartupFailure(error: unknown, root: string,
  input: Readable & { isTTY?: boolean } = process.stdin, output: Writable = process.stderr,
  logName = 'startup.log'): Promise<void> {
  const message = error instanceof Error ? error.message : 'HOST_STARTUP_FAILED';
  output.write(message + '\n');
  output.write('Application folder: ' + JSON.stringify(root.slice(0, 4096)) + '\n');
  try {
    const log = assertManagedPath(root, path.join(root, logName));
    const line = new Date().toISOString() + ' ' + message.slice(0, 8192).replace(/[\r\n]/g, ' ') + '\n';
    if (fs.existsSync(log) && fs.statSync(log).size + Buffer.byteLength(line) > 65536) {
      fs.renameSync(log, assertManagedPath(root, log + '.1'));
    }
    fs.appendFileSync(log, line, 'utf8');
    output.write('Startup error saved to ' + log + '\n');
  } catch (cause) {
    const reason = cause instanceof Error ? cause.message : 'Unknown logging failure.';
    output.write('Startup error could not be saved: ' + reason.slice(0, 8192).replace(/[\r\n]/g, ' ') + '\n');
  }
  if (!input.isTTY) return;
  output.write('Startup failed. Press Enter to close this window.\n');
  await new Promise<void>(resolve => {
    const reader = createInterface({ input });
    reader.once('line', () => reader.close()); reader.once('close', resolve);
  });
}
