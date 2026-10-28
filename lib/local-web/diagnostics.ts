import fs from 'node:fs';
import path from 'node:path';
import { sanitizeNativeStopFailure } from './native-command-diagnostics.mjs';
import { assertManagedPath, managedDirectory } from './runtime.js';

/** Lifecycle metadata only. Native error text, request and terminal payloads never enter logs. */
export class DiagnosticLogger {
  private readonly directory: string;
  constructor(private readonly root: string,
    private readonly settings: { directory: string; maxFiles: number; maxFileBytes: number },
    private readonly identifierFields: readonly string[] = ['hostInstanceId', 'jobId']) {
    if (!Number.isSafeInteger(settings.maxFiles) || settings.maxFiles < 1 || settings.maxFiles > 100 ||
      !Number.isSafeInteger(settings.maxFileBytes) || settings.maxFileBytes < 128) throw new Error('INVALID_DIAGNOSTIC_LIMITS');
    this.directory = assertManagedPath(root, settings.directory);
    try { managedDirectory(root, this.directory); }
    catch { throw this.failure(); }
  }

  log(event: string, fields: Record<string, unknown> = {}): void {
    if (!/^[a-z][a-z0-9-]{0,63}$/.test(event)) throw new Error('INVALID_DIAGNOSTIC_EVENT');
    const entry: Record<string, unknown> = { timestamp: new Date().toISOString(), event };
    for (const key of this.identifierFields) {
      const value = fields[key];
      if (typeof value === 'string' && /^[a-zA-Z0-9-]{1,128}$/.test(value)) entry[key] = value;
    }
    if (typeof fields.code === 'string' && /^[A-Z0-9_]{1,64}$/.test(fields.code)) entry.code = fields.code;
    if (Number.isSafeInteger(fields.exitCode)) entry.exitCode = fields.exitCode;
    const nativeFailure = sanitizeNativeStopFailure(fields.nativeFailure);
    if (nativeFailure) entry.nativeFailure = nativeFailure;
    const line = JSON.stringify(entry) + '\n';
    if (Buffer.byteLength(line) > this.settings.maxFileBytes) throw this.failure();
    try {
      const current = this.file(0);
      if (fs.existsSync(current) && fs.statSync(current).size + Buffer.byteLength(line) > this.settings.maxFileBytes) {
        const oldest = this.file(this.settings.maxFiles - 1);
        if (fs.existsSync(oldest)) fs.unlinkSync(oldest);
        for (let index = this.settings.maxFiles - 2; index >= 0; index--) {
          const previous = this.file(index);
          if (fs.existsSync(previous)) fs.renameSync(previous, this.file(index + 1));
        }
      }
      fs.appendFileSync(current, line, 'utf8');
    } catch { throw this.failure(); }
  }

  private file(index: number): string {
    return assertManagedPath(this.root, path.join(this.directory, `host-${index}.log`));
  }
  private failure(): Error {
    return new Error('DIAGNOSTICS_WRITE_FAILED: Check the project diagnostic directory and available disk space.');
  }
}
