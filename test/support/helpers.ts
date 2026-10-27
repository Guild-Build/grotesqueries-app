import fs from 'node:fs';
import path from 'node:path';
import type { LaunchProfile } from '@grotesqueries/protocol';
import type { PtyHandle, PtyLauncher, StopResult } from '../../app/services/pty.js';
import { loadConfig, type Config } from '../../config/application.js';
import { scratchDirectory } from './scratch.js';

export class FakePty implements PtyHandle {
  readonly pid: number;
  readonly writes: string[] = [];
  readonly grids: Array<[number, number]> = [];
  stops = 0; paused = false; exitCode: number | undefined;
  private outputCallbacks = new Set<(data: string) => void>();
  private exitCallbacks = new Set<(code: number, cleanupRequired?: boolean) => void>();
  cleanupRequired = false;
  constructor(pid: number) { this.pid = pid; }
  write(data: string): void { if (this.exitCode !== undefined) throw new Error('exited'); this.writes.push(data); }
  resize(cols: number, rows: number): void { this.grids.push([cols, rows]); }
  pause(): void { this.paused = true; } resume(): void { this.paused = false; }
  onOutput(callback: (data: string) => void) { this.outputCallbacks.add(callback); return () => { this.outputCallbacks.delete(callback); }; }
  onExit(callback: (code: number, cleanupRequired?: boolean) => void) { this.exitCallbacks.add(callback); if (this.exitCode !== undefined) callback(this.exitCode, this.cleanupRequired); return () => { this.exitCallbacks.delete(callback); }; }
  output(data: string): void { for (const callback of this.outputCallbacks) callback(data); }
  exit(code = 0, cleanupRequired = false): void { this.exitCode = code; this.cleanupRequired = cleanupRequired; for (const callback of this.exitCallbacks) callback(code, cleanupRequired); }
  async stop(): Promise<StopResult> {
    if (this.exitCode !== undefined) return { exitCode: this.exitCode, verifiedPids: [] };
    this.stops++; this.output('final fixture output'); this.exit(0); return { exitCode: 0, verifiedPids: [this.pid] };
  }
}
export class FakeLauncher implements PtyLauncher {
  readonly handles: FakePty[] = [];
  readonly profiles: LaunchProfile[] = [];
  beforeReturn?: (pty: FakePty) => void;
  async start(profile: LaunchProfile): Promise<FakePty> {
    const pty = new FakePty(1000 + this.handles.length); this.handles.push(pty); this.profiles.push(profile);
    this.beforeReturn?.(pty); return pty;
  }
}
export function fixtureConfig(): Config {
  // A fixture must not depend on the operator's installed agents or original X: checkout.
  // Keep real configuration validation, but bind its one harmless profile to this test tree.
  const root = process.cwd();
  const source = JSON.parse(fs.readFileSync(path.join(root, 'config/grotesqueries.json'), 'utf8'));
  source.allowedProjectDirectories = [root];
  source.launchProfiles = [{ id: 'powershell', label: 'PowerShell',
    executable: process.platform === 'win32' ? path.join(process.env.SystemRoot ?? 'C:/Windows', 'System32/WindowsPowerShell/v1.0/powershell.exe') : process.execPath,
    args: process.platform === 'win32' ? ['-NoLogo', '-NoProfile'] : [], projectDirectory: root, environment: {} }];
  delete source.frame;
  const file = path.join(scratchDirectory('config-fixture-', root), 'grotesqueries.json');
  fs.writeFileSync(file, JSON.stringify(source));
  return loadConfig(file, root);
}
