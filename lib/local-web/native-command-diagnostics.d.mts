export interface NativeCommandDiagnostic {
  phase: 'snapshot' | 'stop'; kind: string; elapsedMs: number; timeoutMs: number;
  code: string | number | null; signal: string | null; killed: boolean; stdoutBytes: number; stderrBytes: number;
}
export interface NativeStopFailure { code: string; command?: NativeCommandDiagnostic }
export function sanitizeNativeCommand(value: unknown): NativeCommandDiagnostic | undefined;
export function sanitizeNativeStopFailure(value: unknown): NativeStopFailure | undefined;
export function nativeStopFailure(error: unknown): NativeStopFailure;
