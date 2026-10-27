import { createRequire } from 'node:module';
import path from 'node:path';
import crypto from 'node:crypto';
import type { LaunchProfile } from '@grotesqueries/protocol';
import type { PtyHandle, StopResult } from './pty.js';
import { assertManagedPath, createChildEnvironment } from '../helpers/runtime.js';
import { MacProcessOwnership, verifyMacProcessSupport, abortMacBootstrap, macProcessHelperPath, type MacBootstrapIdentity } from './mac-processes.js';

export async function startMacPty(root: string, profile: LaunchProfile, cols: number, rows: number, sessionId: string): Promise<PtyHandle> {
  if (!Number.isSafeInteger(cols) || !Number.isSafeInteger(rows) || cols < 2 || cols > 300 || rows < 1 || rows > 200) throw new Error('INVALID_GRID');
  verifyMacProcessSupport(root);
  const cwd = assertManagedPath(profile.projectDirectory, profile.projectDirectory);
  const env = createChildEnvironment(cwd, sessionId, process.env, profile.environment);
  const native = createRequire(path.join(root, 'package.json'))('node-pty') as typeof import('node-pty');
  const nonce = crypto.randomUUID();
  let terminal: import('node-pty').IPty;
  try { terminal = native.spawn(macProcessHelperPath(root), ['bootstrap', nonce, profile.executable, ...profile.args], { cwd, env, cols, rows, name: 'xterm-256color' }); }
  catch { throw new Error('PTY_LAUNCH_FAILED: Check the executable and project directory.'); }
  let exitCode: number | undefined;
  let cleanupRequired = false;
  let ownership: MacProcessOwnership | undefined;
  const output = new Set<(data: string) => void>(); const exits = new Set<(code: number, cleanupRequired?: boolean) => void>();
  let identity: MacBootstrapIdentity | undefined;
  let header = '';
  let bootstrapResolve!: (value: MacBootstrapIdentity) => void;
  let bootstrapReject!: (error: Error) => void;
  const bootstrap = new Promise<MacBootstrapIdentity>((resolve, reject) => { bootstrapResolve = resolve; bootstrapReject = reject; });
  const startupTimer = setTimeout(() => bootstrapReject(new Error('PTY_BOOTSTRAP_TIMEOUT')), 2000);
  // The native child reports its own identity before stopping. Never infer ownership from a later PID lookup.
  terminal.onData(data => {
    if (!identity) {
      header += data;
      if (Buffer.byteLength(header) > 2048) { bootstrapReject(new Error('PTY_BOOTSTRAP_INVALID')); return; }
      const end = header.indexOf('\x1f');
      if (end === -1) return;
      const prefix = '\x1e' + nonce + ':';
      try {
        if (!header.startsWith(prefix) || end !== header.length - 1) throw new Error('invalid handshake');
        const value = JSON.parse(header.slice(prefix.length, end)) as MacBootstrapIdentity;
        if (value.pid !== terminal.pid || value.session !== terminal.pid || typeof value.birth !== 'string' || !/^\d+:\d{1,6}$/.test(value.birth)) throw new Error('invalid identity');
        identity = value; header = ''; bootstrapResolve(value);
      } catch { bootstrapReject(new Error('PTY_BOOTSTRAP_INVALID')); }
      return;
    }
    for (const callback of output) callback(data);
  });
  terminal.onExit(event => { exitCode = event.signal ? 128 + event.signal : event.exitCode;
    bootstrapReject(new Error('PTY_BOOTSTRAP_EXITED'));
    cleanupRequired = ownership?.remaining() ?? true; for (const callback of exits) callback(exitCode, cleanupRequired); });
  try {
    const expected = await bootstrap;
    terminal.write(nonce);
    ownership = new MacProcessOwnership(root, terminal.pid, expected);
  } catch {
    // A missing handshake is not authority to signal whichever process now occupies the numeric PID.
    if (exitCode === undefined) {
      if (!identity) throw new Error('PTY_BOOTSTRAP_FAILED: Initial identity was not received. The unacknowledged bootstrap exits without running the requested program.');
      try { abortMacBootstrap(root, terminal.pid, identity); }
      catch { throw new Error('PTY_BOOTSTRAP_CLEANUP_UNVERIFIED: The captured bootstrap identity could not be cleaned up.'); }
    }
    throw new Error('PTY_OWNERSHIP_FAILED: Native process ownership could not be established.');
  } finally { clearTimeout(startupTimer); }
  let stopping: Promise<StopResult> | undefined;
  let resumed = false;
  let cancelledBeforeResume = false;
  const handle: PtyHandle = {
    pid: terminal.pid, cleanupScope: 'tracked-descendants',
    write: data => { if (exitCode !== undefined) throw new Error('SESSION_EXITED'); terminal.write(data); },
    resize: (columns, lines) => { if (exitCode !== undefined) throw new Error('SESSION_EXITED'); terminal.resize(columns, lines); },
    pause: () => { if (!stopping) terminal.pause(); }, resume: () => terminal.resume(),
    onOutput: callback => { output.add(callback); return () => { output.delete(callback); }; },
    onExit: callback => { exits.add(callback); if (exitCode !== undefined) queueMicrotask(() => { if (exits.has(callback)) callback(exitCode!, cleanupRequired); }); return () => { exits.delete(callback); }; },
    stop: () => {
      if (!resumed) cancelledBeforeResume = true;
      if (stopping) return stopping;
      terminal.resume();
      const attempt = (async () => {
        const verifiedPids = await ownership!.stop(); const deadline = Date.now() + 5000;
        while (exitCode === undefined) {
          if (Date.now() >= deadline) throw new Error('PTY_DRAIN_TIMEOUT');
          await new Promise(resolve => setTimeout(resolve, 25));
        }
        return { exitCode, verifiedPids, cleanupScope: 'tracked-descendants' as const };
      })();
      stopping = attempt; void attempt.catch(() => { if (stopping === attempt) stopping = undefined; }); return attempt;
    },
  };
  setImmediate(() => {
    if (cancelledBeforeResume) return;
    try { ownership!.resume(); resumed = true; }
    catch { cleanupRequired = true; void handle.stop().catch(() => { /* Retained ownership permits deliberate cleanup retry. */ }); }
  });
  return handle;
}
