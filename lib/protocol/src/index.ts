/** Versioned browser/host/plugin contract. It deliberately has no Node or DOM imports. */
// Per-session grid/scrollback metadata changes strict wire decoders. Old clients must fail the handshake, not silently misrender.
export const PROTOCOL_VERSION = 4;
// Plugin manifest/import contract is unchanged by the frame/host settings API.
export const PLUGIN_CONTRACT_VERSION = 3;

export interface EffectiveLimits {
  terminal: { scrollbackLines: number; recentOutputBytes: number; maxIncompleteSequenceBytes: number };
  capacity: { maxRunningSessions: number; retainedExitedSessions: number; maxViews: number };
  control: { timeoutMs: number };
  transport: { maxFrameBytes: number; maxInputBytes: number; maxViewQueueBytes: number;
    maxRendererBacklogBytes: number; maxSnapshotBytes: number };
}
export const DEFAULT_LIMITS: EffectiveLimits = {
  terminal: { scrollbackLines: 10000, recentOutputBytes: 8388608, maxIncompleteSequenceBytes: 65536 },
  capacity: { maxRunningSessions: 8, retainedExitedSessions: 8, maxViews: 16 },
  control: { timeoutMs: 10000 },
  transport: { maxFrameBytes: 262144, maxInputBytes: 65536, maxViewQueueBytes: 1048576,
    maxRendererBacklogBytes: 1048576, maxSnapshotBytes: 33554432 },
};

export type ProcessState = 'running' | 'exited' | 'unavailable';
export type ViewMode = 'observing' | 'controlling';

export interface SessionSummary {
  id: string;
  label: string;
  projectDirectory: string;
  profileId: string;
  createdAt: string;
  processState: ProcessState;
  attachedViews: number;
  controllerViewId: string | null;
  cols: number;
  rows: number;
  exitCode: number | null;
  agentState: 'unknown';
  providerConversationId: string | null;
  stopPending?: boolean;
  failureCode?: string | null;
  /** Fixed profile width, absent for controller-pane auto sizing. */
  fixedCols?: number;
  scrollbackLines?: number;
}

export interface LaunchProfile {
  id: string;
  label: string;
  executable: string;
  args: string[];
  projectDirectory: string;
  environment: Record<string, string>;
  columns?: number;
}

/** An interactive profile gets a PTY and a controller; a job runs its fixed arguments to an exit, observed only. */
export type ProfileKind = 'interactive' | 'job';

/** A process a plugin declares: the launch profile shape, environment overrides optional. */
export type PluginProcess = Omit<LaunchProfile, 'environment'> & Partial<Pick<LaunchProfile, 'environment'>>;
/** `path` is `<folder id>/<file>`; the core serves it at `/plugins/<plugin name>/<path>`. */
export interface PluginPage { label: string; path: string }

/** A plugin is a folder with this manifest. Profiles are interactive; commands run as jobs. */
export interface PluginManifest {
  name: string;
  contract: number;
  profiles: PluginProcess[];
  commands: PluginProcess[];
  folders: Array<{ id: string; path: string }>;
  pages: PluginPage[];
  panel?: PluginPage;
}

/** What bootstrap tells a view about one loaded plugin. */
export interface PluginSummary {
  name: string;
  contract: number;
  panel: PluginPage | null;
  pages: PluginPage[];
  profiles: string[];
  commands: string[];
}

export interface Bootstrap {
  protocol: number;
  hostInstanceId: string;
  token: string;
  sessions: SessionSummary[];
  profiles: Array<Pick<LaunchProfile, 'id' | 'label' | 'projectDirectory'> & { kind: ProfileKind }>;
  plugins: PluginSummary[];
  limits: EffectiveLimits;
}

export type GapReason = 'history-evicted' | 'sequence-gap' | 'slow-view' | 'renderer-overflow';
export type CancelReason = 'replaced' | 'detached' | 'timeout' | 'overflow' | 'catch-up-gap' | 'restore-failed';
export type Operation = 'ready' | 'attach' | 'detach' | 'take-control' | 'release-control' | 'resize' | 'stop' | 'resync';
export type ClientMessage =
  | { type: 'ready'; requestId: number; protocol: number; hostInstanceId: string }
  | { type: 'start'; requestId: number; profileId: string; cols: number; rows: number }
  | { type: 'attach'; requestId: number; sessionId: string; resume?: { hostInstanceId: string; sequence: number } }
  | { type: 'detach' | 'take-control'; requestId: number; sessionId: string }
  | { type: 'release-control' | 'stop'; requestId: number; sessionId: string; leaseId: string }
  | { type: 'input'; sessionId: string; leaseId: string; inputId: number; data: string }
  | { type: 'resize'; requestId: number; sessionId: string; leaseId: string; cols: number; rows: number }
  | { type: 'resync'; requestId: number; sessionId: string; sequence: number; reason: GapReason }
  | { type: 'snapshot-applied'; sessionId: string; snapshotId: string; chunkIndex: number; parsedBytes: number }
  | { type: 'applied'; sessionId: string; sequence: number; snapshotId?: string }
  | { type: 'ping'; requestId: number };

export interface ProtocolError {
  type: 'error'; code: string; message: string; requestId?: number; sessionId?: string; leaseId?: string; inputId?: number;
}

export type ServerMessage =
  | { type: 'hello'; protocol: number; hostInstanceId: string; viewId: string; limits: EffectiveLimits }
  | { type: 'inventory'; sessions: SessionSummary[] }
  | { type: 'start-result'; requestId: number; session: SessionSummary }
  | { type: 'operation-result'; requestId: number; operation: Operation; sessionId?: string }
  | { type: 'snapshot-begin'; sessionId: string; snapshotId: string; sequence: number; cols: number; rows: number;
      totalBytes: number; chunkCount: number; historyIncomplete: boolean; historyGapReason: GapReason | null }
  | { type: 'snapshot-chunk'; sessionId: string; snapshotId: string; index: number; data: string }
  | { type: 'snapshot-end'; sessionId: string; snapshotId: string; sequence: number }
  | { type: 'snapshot-cancel'; sessionId: string; snapshotId: string; reason: CancelReason }
  | { type: 'output'; sessionId: string; sequence: number; data: string; historyIncomplete?: boolean }
  | { type: 'grid'; sessionId: string; sequence: number; cols: number; rows: number; historyIncomplete?: boolean }
  | { type: 'control'; sessionId: string; controllerViewId: string | null; leaseId: string | null }
  | { type: 'input-ack'; sessionId: string; leaseId: string; inputId: number; disposition: 'accepted' | 'already-seen' }
  | { type: 'session'; session: SessionSummary }
  | ProtocolError
  | { type: 'pong'; requestId: number };

export { decodeClientMessage, decodeServerMessage, decodeBootstrap, decodePluginManifest, utf8Bytes, utf8Chunks } from './validation.ts';
export { importChecked, importViolations } from './plugin-imports.ts';
export { TERMINAL_QUERY_CATALOG } from './terminal-queries.ts';
export type { EditableSettings, SettingsDocument } from './settings.js';
export { pinnedCore, installSnapshotState, type ParserTerminal } from './terminal-state-adapter.ts';
