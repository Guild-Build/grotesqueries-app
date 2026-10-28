import { DEFAULT_LIMITS, GUILD_BUILD_SLUGS, PLUGIN_CONTRACT_VERSION, type Bootstrap, type ClientMessage, type EffectiveLimits, type GuildBuildSummary, type PluginManifest,
  type ServerMessage } from './index.ts';

type ObjectValue = Record<string, unknown>;
const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const gaps = ['history-evicted', 'sequence-gap', 'slow-view', 'renderer-overflow'];
const cancels = ['replaced', 'detached', 'timeout', 'overflow', 'catch-up-gap', 'restore-failed'];
const operations = ['ready', 'attach', 'detach', 'take-control', 'release-control', 'resize', 'stop', 'resync'];
function invalid(field = 'message'): never { throw new Error(`INVALID_MESSAGE: Invalid ${field}.`); }
function object(value: unknown, allowed: string[], required: string[] = allowed): ObjectValue {
  if (!value || typeof value !== 'object' || Array.isArray(value)) invalid();
  const result = value as ObjectValue;
  if (Object.keys(result).some(key => !allowed.includes(key)) || required.some(key => !Object.hasOwn(result, key))) invalid('fields');
  return result;
}
function number(value: unknown, min = 0, max = Number.MAX_SAFE_INTEGER): void {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < min || value > max) invalid('integer');
}
function text(value: unknown, max: number, min = 0): void {
  if (typeof value !== 'string' || value.length < min || utf8Bytes(value) > max) invalid('text size');
}
function id(value: unknown): void { if (typeof value !== 'string' || !uuid.test(value)) invalid('identity'); }
function profileId(value: unknown): void { if (typeof value !== 'string' || !/^[a-z0-9-]{1,64}$/i.test(value)) invalid('profile identity'); }
function choice(value: unknown, values: readonly unknown[]): void { if (!values.includes(value)) invalid('variant'); }
function grid(message: ObjectValue): void { number(message.cols, 2, 300); number(message.rows, 1, 200); }
function boolean(value: unknown): void { if (typeof value !== 'boolean') invalid('boolean'); }
function frame(value: unknown, limits: EffectiveLimits): void {
  const serialized = JSON.stringify(value);
  if (!serialized || utf8Bytes(serialized) > limits.transport.maxFrameBytes) invalid('frame size');
}

export function utf8Bytes(value: string): number {
  let bytes = 0;
  for (const character of value) {
    const point = character.codePointAt(0)!;
    bytes += point <= 0x7f ? 1 : point <= 0x7ff ? 2 : point <= 0xffff ? 3 : 4;
  }
  return bytes;
}
export function utf8Chunks(value: string, limit = 16384): string[] {
  if (!Number.isSafeInteger(limit) || limit < 4) invalid('chunk limit');
  const chunks: string[] = [];
  let start = 0, bytes = 0;
  for (let index = 0; index < value.length;) {
    const point = value.codePointAt(index)!;
    const size = point <= 0x7f ? 1 : point <= 0x7ff ? 2 : point <= 0xffff ? 3 : 4;
    if (bytes + size > limit) { chunks.push(value.slice(start, index)); start = index; bytes = 0; }
    bytes += size; index += point > 0xffff ? 2 : 1;
  }
  if (start < value.length) chunks.push(value.slice(start));
  return chunks;
}

export function decodeClientMessage(value: unknown, limits = DEFAULT_LIMITS): ClientMessage {
  frame(value, limits);
  if (!value || typeof value !== 'object' || Array.isArray(value)) invalid();
  const raw = value as ObjectValue;
  const type = raw.type;
  let message: ObjectValue;
  switch (type) {
    case 'ready': message = object(value, ['type', 'requestId', 'protocol', 'hostInstanceId']); number(message.protocol, 1, 100); id(message.hostInstanceId); break;
    case 'start': message = object(value, ['type', 'requestId', 'profileId', 'cols', 'rows']); profileId(message.profileId); grid(message); break;
    case 'attach':
      message = object(value, ['type', 'requestId', 'sessionId', 'resume'], ['type', 'requestId', 'sessionId']);
      if (Object.hasOwn(message, 'resume')) { const resume = object(message.resume, ['hostInstanceId', 'sequence']); id(resume.hostInstanceId); number(resume.sequence); }
      break;
    case 'detach': case 'take-control': message = object(value, ['type', 'requestId', 'sessionId']); break;
    case 'release-control': case 'stop': message = object(value, ['type', 'requestId', 'sessionId', 'leaseId']); break;
    case 'resize': message = object(value, ['type', 'requestId', 'sessionId', 'leaseId', 'cols', 'rows']); grid(message); break;
    case 'input': message = object(value, ['type', 'sessionId', 'leaseId', 'inputId', 'data']); number(message.inputId, 1); text(message.data, limits.transport.maxInputBytes, 1); break;
    case 'resync': message = object(value, ['type', 'requestId', 'sessionId', 'sequence', 'reason']); number(message.sequence); choice(message.reason, gaps); break;
    case 'snapshot-applied': message = object(value, ['type', 'sessionId', 'snapshotId', 'chunkIndex', 'parsedBytes']); number(message.chunkIndex); number(message.parsedBytes, 0, limits.transport.maxSnapshotBytes); break;
    case 'applied': message = object(value, ['type', 'sessionId', 'sequence', 'snapshotId'], ['type', 'sessionId', 'sequence']); number(message.sequence); break;
    case 'ping': message = object(value, ['type', 'requestId']); break;
    default: invalid('message type');
  }
  if ('requestId' in message) number(message.requestId, 1);
  if ('sessionId' in message) id(message.sessionId);
  if ('leaseId' in message) id(message.leaseId);
  if ('snapshotId' in message) id(message.snapshotId);
  return message as unknown as ClientMessage;
}

function summary(value: unknown): void {
  const fields = ['id', 'label', 'projectDirectory', 'profileId', 'createdAt', 'processState', 'attachedViews',
    'controllerViewId', 'cols', 'rows', 'exitCode', 'agentState', 'providerConversationId'];
  const message = object(value, [...fields, 'stopPending', 'failureCode', 'fixedCols', 'scrollbackLines'], fields);
  id(message.id); profileId(message.profileId); text(message.label, 256, 1); text(message.projectDirectory, 4096, 1);
  text(message.createdAt, 64, 1); if (!Number.isFinite(Date.parse(message.createdAt as string))) invalid('creation time');
  choice(message.processState, ['running', 'exited', 'unavailable']); choice(message.agentState, ['unknown']);
  number(message.attachedViews, 0, 64); grid(message);
  if (message.controllerViewId !== null) id(message.controllerViewId);
  if (message.providerConversationId !== null) text(message.providerConversationId, 128, 1);
  if (message.exitCode !== null) number(message.exitCode, -2147483648, 4294967295);
  if ('stopPending' in message) boolean(message.stopPending);
  if ('fixedCols' in message) number(message.fixedCols, 20, 300);
  if ('scrollbackLines' in message) number(message.scrollbackLines, 0, 100000);
  if ('failureCode' in message && message.failureCode !== null) text(message.failureCode, 64, 1);
}
function inventory(value: unknown): void {
  if (!Array.isArray(value) || value.length > 64) invalid('inventory');
  for (const item of value) summary(item);
}
function effectiveLimits(value: unknown): void {
  const limits = object(value, ['terminal', 'capacity', 'control', 'transport']);
  const terminal = object(limits.terminal, ['scrollbackLines', 'recentOutputBytes', 'maxIncompleteSequenceBytes']);
  number(terminal.scrollbackLines, 0, 100000); number(terminal.recentOutputBytes, 1024, 67108864); number(terminal.maxIncompleteSequenceBytes, 1024, 1048576);
  const capacity = object(limits.capacity, ['maxRunningSessions', 'retainedExitedSessions', 'maxViews']);
  number(capacity.maxRunningSessions, 1, 32); number(capacity.retainedExitedSessions, 1, 32); number(capacity.maxViews, 2, 64);
  number(object(limits.control, ['timeoutMs']).timeoutMs, 2000, 60000);
  const transport = object(limits.transport, ['maxFrameBytes', 'maxInputBytes', 'maxViewQueueBytes', 'maxRendererBacklogBytes', 'maxSnapshotBytes']);
  number(transport.maxFrameBytes, 131072, 1048576); number(transport.maxInputBytes, 1024, 65536);
  number(transport.maxViewQueueBytes, 262144, 8388608); number(transport.maxRendererBacklogBytes, 262144, 8388608);
  number(transport.maxSnapshotBytes, 1048576, 67108864);
}

export function decodeServerMessage(value: unknown, limits = DEFAULT_LIMITS): ServerMessage {
  frame(value, limits);
  if (!value || typeof value !== 'object' || Array.isArray(value)) invalid();
  const raw = value as ObjectValue;
  let message: ObjectValue;
  switch (raw.type) {
    case 'hello': message = object(value, ['type', 'protocol', 'hostInstanceId', 'viewId', 'limits']); number(message.protocol, 1, 100); id(message.hostInstanceId); id(message.viewId); effectiveLimits(message.limits); break;
    case 'inventory': message = object(value, ['type', 'sessions']); inventory(message.sessions); break;
    case 'session': message = object(value, ['type', 'session']); summary(message.session); break;
    case 'start-result': message = object(value, ['type', 'requestId', 'session']); summary(message.session); break;
    case 'operation-result': message = object(value, ['type', 'requestId', 'operation', 'sessionId'], ['type', 'requestId', 'operation']); choice(message.operation, operations); if (message.operation !== 'ready' && !('sessionId' in message)) invalid('operation session'); if (message.operation === 'ready' && 'sessionId' in message) invalid('ready session'); break;
    case 'control': message = object(value, ['type', 'sessionId', 'controllerViewId', 'leaseId']); if (message.controllerViewId !== null) id(message.controllerViewId); if (message.leaseId !== null) id(message.leaseId); break;
    case 'output': message = object(value, ['type', 'sessionId', 'sequence', 'data', 'historyIncomplete'], ['type', 'sessionId', 'sequence', 'data']); text(message.data, limits.transport.maxFrameBytes, 1); if ('historyIncomplete' in message) boolean(message.historyIncomplete); break;
    case 'grid': message = object(value, ['type', 'sessionId', 'sequence', 'cols', 'rows', 'historyIncomplete'], ['type', 'sessionId', 'sequence', 'cols', 'rows']); grid(message); if ('historyIncomplete' in message) boolean(message.historyIncomplete); break;
    case 'snapshot-begin': message = object(value, ['type', 'sessionId', 'snapshotId', 'sequence', 'cols', 'rows', 'totalBytes', 'chunkCount', 'historyIncomplete', 'historyGapReason']); grid(message); number(message.totalBytes, 0, limits.transport.maxSnapshotBytes); number(message.chunkCount, 0, limits.transport.maxSnapshotBytes); boolean(message.historyIncomplete); if (message.historyGapReason !== null) choice(message.historyGapReason, gaps); break;
    case 'snapshot-chunk': message = object(value, ['type', 'sessionId', 'snapshotId', 'index', 'data']); number(message.index); text(message.data, limits.transport.maxFrameBytes, 1); break;
    case 'snapshot-end': message = object(value, ['type', 'sessionId', 'snapshotId', 'sequence']); break;
    case 'snapshot-cancel': message = object(value, ['type', 'sessionId', 'snapshotId', 'reason']); choice(message.reason, cancels); break;
    case 'input-ack': message = object(value, ['type', 'sessionId', 'leaseId', 'inputId', 'disposition']); number(message.inputId, 1); choice(message.disposition, ['accepted', 'already-seen']); break;
    case 'error': message = object(value, ['type', 'code', 'message', 'requestId', 'sessionId', 'leaseId', 'inputId'], ['type', 'code', 'message']); text(message.code, 64, 1); if (!/^[A-Z0-9_]+$/.test(message.code as string)) invalid('error code'); text(message.message, 1024, 1); if ('inputId' in message) number(message.inputId, 1); break;
    case 'pong': message = object(value, ['type', 'requestId']); break;
    default: invalid('message type');
  }
  if ('requestId' in message) number(message.requestId, 1);
  if ('sessionId' in message) id(message.sessionId);
  if ('snapshotId' in message) id(message.snapshotId);
  if ('leaseId' in message && (message.type !== 'control' || message.leaseId !== null)) id(message.leaseId);
  if ('sequence' in message) number(message.sequence);
  return message as unknown as ServerMessage;
}

function list(value: unknown, max: number, item: (value: unknown) => void): void {
  if (!Array.isArray(value) || value.length > max) invalid('list');
  for (const entry of value) item(entry);
}
function name(value: unknown): void { if (typeof value !== 'string' || !/^[a-z0-9-]{1,64}$/.test(value)) invalid('name'); }
/** A profile, page or panel label as configuration accepts a profile's: at most 256 UTF-8 bytes and not only whitespace. */
function label(value: unknown): void { text(value, 256, 1); if (!(value as string).trim()) invalid('label'); }
function path(value: unknown): void { text(value, 4096, 1); if ((value as string).includes('\0')) invalid('path'); }
/**
 * Requirement 1.4: a manifest's folder and project directory begin with `{app}` or `{plugin}`, and so does any
 * argument shaped like a path: one that starts with a drive, a root or a `.` or `..` segment (also as the value of
 * `--name=value`), or holds a `..` segment. A bare relative argument resolves inside the placed project directory.
 * Executables and environment values are exempt. Where a placed path leads is still the core's containment check.
 */
const placed = /^\{(?:app|plugin)\}(?=$|[\\/])/;
const pathShaped = /^(?:-{1,2}[^=\s]+=)?(?:[A-Za-z]:|[\\/]|\.\.?(?:$|[\\/]))|(?:^|[\\/=])\.\.(?:$|[\\/])/;
function placedPath(value: unknown, field: string): void { path(value); if (!placed.test(value as string)) invalid(field); }
function page(value: unknown, folders?: string[]): void {
  const page = object(value, ['label', 'path']); label(page.label); text(page.path, 1024, 1);
  const segments = (page.path as string).split('/'); name(segments[0]);
  if (segments.length < 2 || segments.some(part => !/^[A-Za-z0-9._~-]+$/.test(part) || part === '.' || part === '..')) invalid('page path');
  if (folders && !folders.includes(segments[0])) invalid('page folder');
}
function launch(value: unknown): string {
  const fields = ['id', 'label', 'executable', 'args', 'projectDirectory'];
  const item = object(value, [...fields, 'environment', 'columns'], fields);
  if ('columns' in item) number(item.columns, 20, 300);
  profileId(item.id); label(item.label); path(item.executable); placedPath(item.projectDirectory, 'project directory');
  list(item.args, 64, arg => {
    if (typeof arg !== 'string' || arg.includes('\0')) invalid('argument');
    if (pathShaped.test(arg) && !placed.test(arg)) invalid('argument path');
  });
  if ((item.args as string[]).join('').length > 30000) invalid('arguments');
  if ('environment' in item) {
    const environment = item.environment;
    if (!environment || typeof environment !== 'object' || Array.isArray(environment) || Object.keys(environment).length > 64) invalid('environment');
    for (const [key, value] of Object.entries(environment)) {
      if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(key)) invalid('environment name');
      text(value, 8192); if ((value as string).includes('\0')) invalid('environment value');
    }
  }
  return item.id as string;
}
function plugin(value: unknown): void {
  const item = object(value, ['name', 'contract', 'panel', 'pages', 'profiles', 'commands']);
  name(item.name); number(item.contract, 1, 100); if (item.panel !== null) page(item.panel);
  list(item.pages, 64, page); list(item.profiles, 64, profileId); list(item.commands, 64, profileId);
}

export function decodeBootstrap(value: unknown): Bootstrap {
  const message = object(value, ['protocol', 'hostInstanceId', 'token', 'sessions', 'profiles', 'plugins', 'limits']);
  number(message.protocol, 1, 100); id(message.hostInstanceId); text(message.token, 128, 20);
  inventory(message.sessions); effectiveLimits(message.limits);
  list(message.profiles, 64, value => {
    const profile = object(value, ['id', 'label', 'projectDirectory', 'kind']); profileId(profile.id);
    text(profile.label, 256, 1); text(profile.projectDirectory, 4096, 1); choice(profile.kind, ['interactive', 'job']);
  });
  list(message.plugins, 64, plugin);
  return message as unknown as Bootstrap;
}

export function decodeGuildBuild(value: unknown): { guildBuild: GuildBuildSummary | null } {
  const document = object(value, ['guildBuild']);
  if (document.guildBuild === null) return { guildBuild: null };
  const item = object(document.guildBuild, ['slug', 'name', 'version', 'target', 'modules', 'catalogRevision', 'profileId', 'prerequisites']);
  choice(item.slug, GUILD_BUILD_SLUGS); choice(item.target, ['claude-code']);
  text(item.name, 256, 1); text(item.version, 128, 1);
  if (typeof item.version !== 'string' || !/^\d+\.\d+\.\d+(?:-[a-zA-Z0-9.-]+)?$/.test(item.version) ||
    typeof item.catalogRevision !== 'string' || !/^[a-f0-9]{40}$/.test(item.catalogRevision)) invalid('build identity');
  list(item.modules, 64, value => { if (typeof value !== 'string' || value.length > 128 || !/^(skill|agent|hook|mcp|playbook|tool)\/[a-z0-9]+(?:-[a-z0-9]+)*$/.test(value)) invalid('build component'); });
  list(item.prerequisites, 8, value => text(value, 512, 1));
  if (item.profileId !== null && item.profileId !== `guild-${item.slug}`) invalid('build profile');
  if (item.profileId !== null && (item.prerequisites as unknown[]).length !== 0) invalid('build readiness');
  return document as unknown as { guildBuild: GuildBuildSummary };
}

/** Shape only. The core still resolves and contains every executable, directory and folder before loading. */
export function decodePluginManifest(value: unknown): PluginManifest {
  const fields = ['name', 'contract', 'profiles', 'commands', 'folders', 'pages'];
  const manifest = object(value, [...fields, 'panel'], fields);
  name(manifest.name); if (manifest.contract !== PLUGIN_CONTRACT_VERSION) invalid('contract version');
  const ids: string[] = [];
  list(manifest.profiles, 64, item => ids.push(launch(item))); list(manifest.commands, 64, item => ids.push(launch(item)));
  const folders: string[] = [];
  list(manifest.folders, 64, value => { const folder = object(value, ['id', 'path']); name(folder.id); placedPath(folder.path, 'folder path'); folders.push(folder.id as string); });
  if (new Set(ids).size !== ids.length || new Set(folders).size !== folders.length) invalid('duplicate identity');
  list(manifest.pages, 64, item => page(item, folders));
  if ('panel' in manifest) page(manifest.panel, folders);
  return manifest as unknown as PluginManifest;
}
