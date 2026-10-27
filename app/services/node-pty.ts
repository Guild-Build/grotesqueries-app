import os from 'node:os';
import crypto from 'node:crypto';
import type { LaunchProfile } from '@grotesqueries/protocol';
import type { PtyHandle, PtyLauncher, StopResult } from './pty.js';
import { assertManagedPath, createChildEnvironment } from '../helpers/runtime.js';
import { loadNativePty, sourceNativePayload } from './native-payload.js';
import { stopProcessTree, type ProcessTreeOwnership } from './process-tree.js';
import { startMacPty } from './mac-pty.js';
import { startLinuxPty } from './linux-pty.js';

export class NodePtyLauncher implements PtyLauncher {
  constructor(private readonly root: string, private readonly payload?: string,
    private readonly stopTree: (pid: number, ownership: ProcessTreeOwnership) => Promise<number[]> = stopProcessTree) {}
  async start(profile: LaunchProfile, cols: number, rows: number, sessionId: string = crypto.randomUUID()): Promise<PtyHandle> {
    if (process.platform === 'darwin') return startMacPty(this.root, profile, cols, rows, sessionId);
    if (process.platform === 'linux') return startLinuxPty(this.root, profile, cols, rows, sessionId);
    if (process.platform !== 'win32') throw new Error('PTY_PLATFORM_UNSUPPORTED: This operating system is not supported.');
    if (Number(os.release().split('.')[2]) < 18309) throw new Error('CONPTY_UNAVAILABLE: Windows 10 build 18309 or later is required.');
    if (!Number.isSafeInteger(cols) || !Number.isSafeInteger(rows) || cols < 2 || cols > 300 || rows < 1 || rows > 200) throw new Error('INVALID_GRID');
    const cwd = assertManagedPath(profile.projectDirectory, profile.projectDirectory);
    const env = createChildEnvironment(cwd, sessionId, process.env, profile.environment);
    const native = loadNativePty(this.payload ?? sourceNativePayload(this.root));
    let terminal: import('node-pty').IPty;
    const createdAfter = Date.now();
    try { terminal = native.spawn(profile.executable, [...profile.args], { cwd, env, cols, rows,
      name: 'xterm-256color', useConpty: true, useConptyDll: false }); }
    catch { throw new Error('PTY_LAUNCH_FAILED: Check the configured executable and project directory.'); }
    // Pinned beta14 connects asynchronously. Its ready event precedes the first output.
    // Await that event, never first output: silent CLIs must also become usable.
    const readyTerminal = terminal as typeof terminal & {
      on(event: string, callback: () => void): void; removeListener(event: string, callback: () => void): void;
      _agent: { _cancelStartup(): Promise<void> };
    };
    if (!terminal.pid) {
      let timer: ReturnType<typeof setTimeout>; let ready: () => void; let earlyExit: { dispose(): void };
      try {
        await new Promise<void>((resolve, reject) => {
          ready = () => terminal.pid > 0 ? resolve() : reject(new Error('PTY_LAUNCH_FAILED'));
          earlyExit = terminal.onExit(() => reject(new Error('PTY_LAUNCH_FAILED')));
          readyTerminal.on('ready_datapipe', ready);
          timer = setTimeout(() => reject(new Error('PTY_LAUNCH_FAILED')), 7000);
        });
      } catch {
        await readyTerminal._agent._cancelStartup();
        throw new Error('PTY_LAUNCH_FAILED: Check the configured executable and project directory.');
      } finally { clearTimeout(timer!); earlyExit!.dispose(); readyTerminal.removeListener('ready_datapipe', ready!); }
    }
    if (!Number.isSafeInteger(terminal.pid) || terminal.pid <= 0) throw new Error('PTY_LAUNCH_FAILED: Check the configured executable and project directory.');
    const ownership: ProcessTreeOwnership = { processes: new Map(), createdAfter, createdBefore: Date.now() };
    let exitCode: number | undefined;
    let stopping: Promise<StopResult> | undefined;
    terminal.onExit(event => { exitCode = event.exitCode; ownership.exitedAt = Date.now(); });
    const output = new Set<(data: string) => void>();
    const exits = new Set<(code: number) => void>();
    terminal.onData(data => { for (const callback of output) callback(data); });
    terminal.onExit(event => { for (const callback of exits) callback(event.exitCode); });
    return {
      pid: terminal.pid,
      write: data => { if (exitCode !== undefined) throw new Error('SESSION_EXITED'); terminal.write(data); },
      resize: (columns, lines) => { if (exitCode !== undefined) throw new Error('SESSION_EXITED'); terminal.resize(columns, lines); },
      pause: () => { if (!stopping) terminal.pause(); }, resume: () => terminal.resume(),
      onOutput: callback => { output.add(callback); return () => { output.delete(callback); }; },
      onExit: callback => { exits.add(callback); if (exitCode !== undefined) queueMicrotask(() => { if (exits.has(callback)) callback(exitCode!); }); return () => { exits.delete(callback); }; },
      stop: () => {
        if (stopping) return stopping;
        const attempt = (async () => {
        const verifiedPids = await this.stopTree(terminal.pid, ownership);
        const deadline = Date.now() + 5000;
        while (exitCode === undefined) {
          if (Date.now() >= deadline) throw new Error('PTY_DRAIN_TIMEOUT: Final output/exit was not confirmed.');
          await new Promise(resolve => setTimeout(resolve, 25));
        }
        return { exitCode, verifiedPids };
        })();
        stopping = attempt;
        // Stop drains final output/exit even if parser or consumer backpressure previously paused the pipe.
        terminal.resume();
        void attempt.catch(() => { if (stopping === attempt) stopping = undefined; });
        return attempt;
      },
    };
  }
}
