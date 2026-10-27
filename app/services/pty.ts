import type { LaunchProfile } from '@grotesqueries/protocol';

export interface StopResult { exitCode: number; verifiedPids: number[]; cleanupScope?: 'tracked-descendants' }
/** Adapter boundary for owned native processes. Cleanup evidence is platform-specific. */
export interface PtyHandle {
  readonly pid: number;
  readonly cleanupScope?: 'tracked-descendants';
  write(data: string): void;
  resize(cols: number, rows: number): void;
  pause(): void;
  resume(): void;
  stop(): Promise<StopResult>;
  onOutput(callback: (data: string) => void): () => void;
  onExit(callback: (exitCode: number, cleanupRequired?: boolean) => void): () => void;
}

export interface PtyLauncher {
  start(profile: LaunchProfile, cols: number, rows: number, sessionId?: string): Promise<PtyHandle>;
}
