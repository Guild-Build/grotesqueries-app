import crypto from 'node:crypto';
import fs from 'node:fs';
import net from 'node:net';
import path from 'node:path';
import { createRequire } from 'node:module';
import type { LaunchProfile } from '@grotesqueries/protocol';
import type { PtyHandle, StopResult } from './pty.js';
import { assertManagedPath, createChildEnvironment } from '../helpers/runtime.js';

/** A per-session child subreaper owns Linux descendants independently of PTY root exit. */
export async function startLinuxPty(root: string, profile: LaunchProfile, cols: number, rows: number,
  sessionId: string): Promise<PtyHandle> {
  if (process.platform !== 'linux') throw new Error('PTY_PLATFORM_UNSUPPORTED');
  if (!Number.isSafeInteger(cols) || !Number.isSafeInteger(rows) || cols < 2 || cols > 300 || rows < 1 || rows > 200) throw new Error('INVALID_GRID');
  const helper = assertManagedPath(root, path.join(root, 'dist/native/linux-supervisor'));
  fs.accessSync(helper, fs.constants.X_OK);
  const cwd = assertManagedPath(profile.projectDirectory, profile.projectDirectory);
  const env = createChildEnvironment(cwd, sessionId, process.env, profile.environment);
  const directory = fs.mkdtempSync(path.join(env.TMPDIR, 'linux-control-'));
  const directoryFd = fs.openSync(directory, fs.constants.O_RDONLY | fs.constants.O_DIRECTORY);
  const socketFile = path.join(directory, 'control.sock');
  // Linux resolves this short procfs path to the private directory. Long workspace
  // paths must not exceed sockaddr_un's limit or force a system-temp fallback.
  const address = `/proc/${process.pid}/fd/${directoryFd}/control.sock`;
  const token = crypto.randomBytes(32).toString('hex');
  const server = net.createServer();
  let control: net.Socket | undefined;
  let terminal: import('node-pty').IPty | undefined;
  let started = false, authenticated = false, nativeExited = false, cancelled = false, running = false, stopRequested = false;
  let controlEnded = false, exitAnnounced = false;
  let finalControlTimer: ReturnType<typeof setTimeout> | undefined;
  let exitCode: number | undefined, cleanupRequired = true;
  let done: StopResult | undefined;
  let stopping: Promise<StopResult> | undefined;
  let finishStop: ((result: StopResult) => void) | undefined, failStop: ((error: Error) => void) | undefined;
  let rejectStart: (error: Error) => void = () => {};
  let resolveStart: () => void = () => {};
  const output = new Set<(data: string) => void>();
  const exits = new Set<(code: number, cleanupRequired?: boolean) => void>();
  let pendingOutput = '', outputScheduled = false;
  let cleanupDone = false;
  const clean = () => {
    if (cleanupDone) return; cleanupDone = true;
    clearTimeout(finalControlTimer);
    control?.destroy(); if (server.listening) server.close();
    let failed = false;
    try { fs.unlinkSync(socketFile); } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') failed = true; }
    try { fs.closeSync(directoryFd); } catch { failed = true; }
    // Preserve unexpected files; cleanup housekeeping must not crash another session.
    try { fs.rmdirSync(directory); } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') failed = true; }
    if (failed) console.error('LINUX_CONTROL_CLEANUP_FAILED');
  };
  const notifyExit = () => {
    if (exitCode === undefined) return;
    exitAnnounced = true;
    for (const callback of exits) callback(exitCode, cleanupRequired);
  };
  const fail = (code: string) => {
    const error = new Error(code);
    if (!started) rejectStart(error);
    failStop?.(error);
  };
  const completeStop = () => {
    if (!nativeExited || !done) return;
    // The control stream and PTY are independent channels. Completion needs both
    // the supervisor's ECHILD receipt and the native PTY's final-output drain.
    if (!exitAnnounced) { cleanupRequired = false; notifyExit(); }
    finishStop?.(done); clean();
  };
  const lostSupervisor = () => {
    cleanupRequired = true;
    if (!exitAnnounced) notifyExit();
    if (!started) rejectStart(new Error('PTY_LAUNCH_FAILED: Linux supervision did not become ready.'));
    failStop?.(new Error('LINUX_SUPERVISOR_LOST: Owned descendant cleanup could not be verified.'));
    if (nativeExited) clean();
  };
  server.on('connection', socket => {
    if (control || cancelled) { socket.destroy(); return; }
    control = socket; socket.setEncoding('utf8');
    let pending = '';
    socket.on('data', (data: string) => {
      if (cleanupDone) return;
      pending += data;
      if (Buffer.byteLength(pending) > 65536) { fail('LINUX_CONTROL_INVALID'); socket.destroy(); return; }
      for (;;) {
        const newline = pending.indexOf('\n'); if (newline < 0) break;
        const line = pending.slice(0, newline); pending = pending.slice(newline + 1);
        try {
          const message = JSON.parse(line) as Record<string, unknown>;
          if (!authenticated) {
            if (message.type === 'error') { fail('LINUX_SUPERVISION_UNAVAILABLE'); continue; }
            if (message.type !== 'hello' || message.token !== token || message.pid !== terminal?.pid) throw new Error('LINUX_CONTROL_INVALID');
            authenticated = true; socket.write('start\n'); continue;
          }
          if (message.type === 'started') {
            if (started || !Number.isSafeInteger(message.primaryPid) || Number(message.primaryPid) <= 1) throw new Error('LINUX_CONTROL_INVALID');
            started = true; resolveStart();
          } else if (message.type === 'exit') {
            if (!Number.isSafeInteger(message.exitCode) || typeof message.cleanupRequired !== 'boolean') throw new Error('LINUX_CONTROL_INVALID');
            exitCode = Number(message.exitCode); cleanupRequired = message.cleanupRequired;
            if (cleanupRequired) notifyExit();
          } else if (message.type === 'done') {
            if (!Number.isSafeInteger(message.exitCode) || !Array.isArray(message.verifiedPids) || message.verifiedPids.length > 4096 ||
              message.verifiedPids.some(pid => !Number.isSafeInteger(pid) || Number(pid) <= 1) || !message.verifiedPids.includes(terminal!.pid)) throw new Error('LINUX_CONTROL_INVALID');
            done = { exitCode: Number(message.exitCode), verifiedPids: message.verifiedPids as number[] }; completeStop();
          } else if (message.type === 'error') {
            fail(typeof message.code === 'string' && /^[A-Z_]{1,64}$/.test(message.code) ? message.code : 'LINUX_CONTROL_INVALID');
          } else throw new Error('LINUX_CONTROL_INVALID');
        } catch { fail('LINUX_CONTROL_INVALID'); socket.destroy(); return; }
      }
    });
    socket.on('error', () => fail('LINUX_CONTROL_FAILED'));
    socket.on('close', () => {
      controlEnded = true;
      if (!done) {
        fail('LINUX_SUPERVISOR_LOST');
        if (nativeExited) lostSupervisor();
      }
    });
  });
  try {
    await new Promise<void>((resolve, reject) => { server.once('error', reject); server.listen(address, resolve); });
    fs.chmodSync(socketFile, 0o600);
    const native = createRequire(path.join(root, 'package.json'))('node-pty') as typeof import('node-pty');
    const ready = new Promise<void>((resolve, reject) => { resolveStart = resolve; rejectStart = reject; });
    terminal = native.spawn(helper, [address, token, profile.executable, ...profile.args], { cwd, env, cols, rows, name: 'xterm-256color' });
    terminal.onData(data => {
      if (output.size) { for (const callback of output) callback(data); }
      else {
        pendingOutput += data;
        if (Buffer.byteLength(pendingOutput) > 65536) { terminal!.pause(); fail('PTY_START_OUTPUT_LIMIT'); }
      }
    });
    terminal.onExit(event => {
      nativeExited = true;
      if (exitCode === undefined) exitCode = event.signal ? 128 + event.signal : event.exitCode;
      if (done) completeStop();
      else if (controlEnded || cancelled) lostSupervisor();
      else finalControlTimer = setTimeout(lostSupervisor, 2000);
    });
    let timer: ReturnType<typeof setTimeout>;
    try { await Promise.race([ready, new Promise<never>((_resolve, reject) => { timer = setTimeout(() => reject(new Error('PTY_START_TIMEOUT')), 7000); })]); }
    finally { clearTimeout(timer!); }
  } catch (error) {
    cancelled = true;
    control?.destroy();
    if (server.listening) server.close();
    if (!terminal || nativeExited) clean();
    throw error;
  }
  const handle = terminal;
  return {
    pid: handle.pid,
    write(data) { if (exitCode !== undefined) throw new Error('SESSION_EXITED'); handle.write(data); },
    resize(columns, lines) { if (exitCode !== undefined) throw new Error('SESSION_EXITED'); handle.resize(columns, lines); },
    pause() { if (!stopping) handle.pause(); }, resume() { handle.resume(); },
    onOutput(callback) {
      output.add(callback);
      if (!running && !stopRequested && exitCode === undefined) { running = true; control!.write('run\n'); }
      if (pendingOutput && !outputScheduled) {
        outputScheduled = true; queueMicrotask(() => {
          outputScheduled = false; const data = pendingOutput; pendingOutput = '';
          if (data) for (const listener of output) listener(data);
          handle.resume();
        });
      }
      return () => { output.delete(callback); };
    },
    onExit(callback) {
      exits.add(callback);
      if (exitCode !== undefined && (cleanupRequired || nativeExited)) queueMicrotask(() => { if (exits.has(callback)) callback(exitCode!, cleanupRequired); });
      return () => { exits.delete(callback); };
    },
    stop() {
      if (stopping) return stopping;
      stopRequested = true;
      if (nativeExited && cleanupDone) return done ? Promise.resolve(done) : Promise.reject(new Error('LINUX_SUPERVISOR_LOST'));
      let timer: ReturnType<typeof setTimeout>;
      const attempt = new Promise<StopResult>((resolve, reject) => {
        finishStop = resolve; failStop = reject;
        timer = setTimeout(() => reject(new Error('STOP_TREE_TIMEOUT')), 14000);
        if (nativeExited) { completeStop(); return; }
        if (!authenticated || !control || control.destroyed) { reject(new Error('LINUX_SUPERVISOR_LOST')); return; }
        control.write('stop\n'); handle.resume(); completeStop();
      }).finally(() => { clearTimeout(timer); finishStop = undefined; failStop = undefined; });
      stopping = attempt;
      void attempt.catch(() => { if (stopping === attempt) stopping = undefined; });
      return attempt;
    },
  };
}
