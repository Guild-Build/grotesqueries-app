import fs from 'node:fs';
import path from 'node:path';
import { DEFAULT_LIMITS, utf8Bytes, type EffectiveLimits, type LaunchProfile } from '@grotesqueries/protocol';
import { assertManagedPath, isWithin } from '../app/helpers/runtime.js';
import { parseFleet, type FleetConfig } from './fleet.js';

/** A plugin command runs as a job: observed only, ended by the core at either bound. Defaults for `jobs`. */
export const JOB_LIMITS = { timeoutMs: 10 * 60 * 1000, outputBytes: 8 * 1024 * 1024 };

export interface Config extends EffectiveLimits {
  version: 1; port: number; allowedProjectDirectories: string[]; launchProfiles: LaunchProfile[];
  diagnostics: { directory: string; maxFiles: number; maxFileBytes: number };
  jobs: typeof JOB_LIMITS;
  /** The frame's built files, served at `/` (requirement 4.2.1). Absent: `/` answers 404. */
  frame?: string;
  fleet?: FleetConfig;
}
function object(value: unknown, name: string): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error(`${name} must be an object.`);
  return value as Record<string, unknown>;
}
function keys(value: Record<string, unknown>, allowed: string[], name: string): void {
  if (Object.keys(value).some(key => !allowed.includes(key))) throw new Error(`${name} contains unsupported fields.`);
}
function integer(value: unknown, name: string, min: number, max: number): number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < min || value > max) throw new Error(`${name} must be an integer from ${min} through ${max}.`);
  return value;
}
function optional(group: Record<string, unknown>, key: string, fallback: number, min: number, max: number): number {
  return integer(Object.hasOwn(group, key) ? group[key] : fallback, key, min, max);
}
export function projectPath(value: unknown, name: string, root?: string): string {
  if (typeof value !== 'string' || !value) throw new Error(`${name} must be a project directory.`);
  if (utf8Bytes(value) > 4096) throw new Error(`${name} must fit the 4096 UTF-8 byte public path bound.`);
  if (/^[A-Z]:[^\\/]/i.test(value) || /^[A-Z]:$/i.test(value)) throw new Error(`${name} cannot use a drive-relative path.`);
  if (process.platform !== 'win32' && (/^[A-Z]:/i.test(value) || value.includes('\\') || value.startsWith('//'))) throw new Error(`${name} must use a local POSIX path.`);
  const resolved = root && !path.isAbsolute(value) ? path.resolve(root, value) : value;
  const lexical = assertManagedPath(resolved, resolved);
  if (!fs.existsSync(lexical) || !fs.statSync(lexical).isDirectory()) throw new Error(`${name} directory does not exist.`);
  const canonical = fs.realpathSync.native(lexical);
  if (utf8Bytes(canonical) > 4096) throw new Error(`${name} must fit the 4096 UTF-8 byte public path bound.`);
  return canonical;
}

/** Resolve an installed native executable without constructing a shell command. Source provenance: docs/reuse.md. */
export function resolveExecutable(value: string, inherited: Record<string, string | undefined> = process.env, root?: string): string {
  if (process.platform !== 'win32') return resolvePosixExecutable(value, inherited, root);
  if (!value || value.includes('\0') || /\.(cmd|bat|ps1|js)$/i.test(value)) throw new Error('Executable must be a direct .exe/.com or explicitly configured interpreter.');
  const explicit = /[\\/]|:/.test(value);
  if (explicit && !path.isAbsolute(value)) {
    if (!root || /^[A-Z]:/i.test(value)) throw new Error('A relative executable needs an application root and cannot be drive-relative.');
    value = assertManagedPath(root, path.resolve(root, value));
  }
  const names = /\.(exe|com)$/i.test(value) ? [value] : explicit ? [] : [value + '.exe', value + '.com'];
  const pathKey = Object.keys(inherited).find(key => key.toUpperCase() === 'PATH');
  const directories = explicit ? [''] : (pathKey ? inherited[pathKey] ?? '' : '').split(';');
  for (const entry of directories) for (const name of names) {
    const directory = entry.replace(/^"|"$/g, '');
    const candidate = explicit ? name : path.join(directory, name);
    if (!/^[A-Z]:[\\/]/i.test(candidate)) continue;
    try {
      const canonical = fs.realpathSync.native(candidate);
      if (!/^[A-Z]:[\\/]/i.test(canonical) || !/\.(exe|com)$/i.test(canonical)) continue;
      if (fs.statSync(canonical).isFile()) return canonical;
    } catch { /* A missing PATH candidate never changes the selected executable. */ }
  }
  throw new Error('EXECUTABLE_NOT_FOUND: Configure an installed direct executable, an application-relative file, or a program on PATH.');
}
function resolvePosixExecutable(value: string, inherited: Record<string, string | undefined>, root?: string): string {
  if (!value || value.includes('\0') || value.includes('\\') || /^[A-Z]:/i.test(value) || value.startsWith('//')) {
    throw new Error('Executable must be a local executable file or a program on PATH.');
  }
  const explicit = value.includes('/');
  if (explicit && !path.isAbsolute(value)) {
    if (!root) throw new Error('A relative executable needs an application root.');
    value = assertManagedPath(root, path.resolve(root, value));
  }
  const directories = explicit ? [''] : (inherited.PATH ?? '').split(path.delimiter);
  for (const directory of directories) {
    // Empty and relative PATH components depend on the caller cwd and are not trusted lookup locations.
    if (!explicit && (!path.isAbsolute(directory) || directory.startsWith('//') || directory.includes('\\'))) continue;
    const candidate = explicit ? value : path.join(directory, value);
    try {
      const canonical = fs.realpathSync.native(candidate);
      if (!fs.statSync(canonical).isFile()) continue;
      fs.accessSync(canonical, fs.constants.X_OK);
      return canonical;
    } catch { /* Keep looking after a missing, inaccessible or non-executable candidate. */ }
  }
  throw new Error('EXECUTABLE_NOT_FOUND: Configure an installed direct executable, an application-relative file, or a program on PATH.');
}
function environment(value: unknown): Record<string, string> {
  const raw = object(value === undefined ? {} : value, 'Launch profile environment');
  const normalized: Record<string, string> = {};
  if (Object.keys(raw).length > 64) throw new Error('Too many environment overrides.');
  for (const [key, value] of Object.entries(raw)) {
    const upper = process.platform === 'win32' ? key.toUpperCase() : key;
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(key) || typeof value !== 'string' || value.includes('\0') ||
      utf8Bytes(value) > 8192 || Object.hasOwn(normalized, upper)) throw new Error('Environment overrides must have unique valid names and bounded string values.');
    if (['TEMP', 'TMP', 'TMPDIR', 'HOME', 'USERPROFILE', 'CODEX_HOME'].includes(key.toUpperCase())) throw new Error(`${upper} is reserved for scoped temp or inherited home settings.`);
    normalized[upper] = value;
  }
  return normalized;
}
/**
 * Requirement 4.2.1, ledger 4: the frame folder resolves as a plugin's declared folder does (projectPath: absolute or
 * relative to the configuration file's folder, `..` resolved lexically, a missing folder refused). The folder itself may
 * not be a junction or link (K-02's rule), and a dot-led name in the path it resolves to is refused (K-05's rule).
 */
export function frameFolder(value: unknown, configDirectory: string): string {
  if (typeof value !== 'string' || !value) throw new Error('Frame folder must be a project directory.');
  if (process.platform !== 'win32' && (/^[A-Z]:/i.test(value) || value.includes('\\') || value.startsWith('//'))) throw new Error('Frame folder must use a local POSIX path.');
  const lexical = path.resolve(configDirectory, value);
  if (fs.existsSync(lexical) && fs.lstatSync(lexical).isSymbolicLink()) throw new Error('Frame folder is a junction or link.');
  const folder = projectPath(value, 'Frame folder', configDirectory);
  if (path.relative(configDirectory, lexical).split(path.sep).some(part => part.startsWith('.') && part !== '..') ||
    path.basename(folder).startsWith('.')) throw new Error('Frame folder resolves to a name that starts with a dot.');
  return folder;
}
export function revalidateProfile(profile: LaunchProfile, config: Pick<Config, 'allowedProjectDirectories'>, root?: string): LaunchProfile {
  const projectDirectory = projectPath(profile.projectDirectory, 'Launch profile project', root);
  if (!config.allowedProjectDirectories.some(allowed => isWithin(projectPath(allowed, 'Allowed project'), projectDirectory))) throw new Error('Launch profile project is outside allowed directories.');
  return { ...profile, args: [...profile.args], projectDirectory,
    executable: resolveExecutable(profile.executable, process.env, root), environment: environment(profile.environment) };
}

/** The configuration's top-level fields; config/grotesqueries.schema.json's properties are tested equal to them. */
export const CONFIG_KEYS = ['version', 'port', 'allowedProjectDirectories', 'launchProfiles', 'terminal', 'diagnostics', 'capacity', 'control', 'transport', 'jobs', 'frame', 'fleet'];

export function loadConfig(file: string, root: string): Config {
  if (process.platform !== 'win32' && (/^[A-Z]:/i.test(file) || file.includes('\\') || file.startsWith('//'))) throw new Error('Configuration must use a local POSIX path.');
  const configPath = assertManagedPath(root, path.resolve(file));
  let raw: unknown;
  try { raw = JSON.parse(fs.readFileSync(configPath, 'utf8')); }
  catch { throw new Error('Cannot read valid JSON configuration. Check grotesqueries.json in the application project.'); }
  return parseConfig(raw, configPath, root);
}

/** Validate a candidate without writing it or changing the running host. */
export function parseConfig(raw: unknown, file: string, root: string): Config {
  if (process.platform !== 'win32' && (/^[A-Z]:/i.test(file) || file.includes('\\') || file.startsWith('//'))) throw new Error('Configuration must use a local POSIX path.');
  const configPath = assertManagedPath(root, path.resolve(file));
  const config = object(raw, 'Configuration');
  keys(config, CONFIG_KEYS, 'Configuration');
  if (config.version !== 1) throw new Error('Configuration version must be 1.');
  if (!Array.isArray(config.allowedProjectDirectories) || !config.allowedProjectDirectories.length || config.allowedProjectDirectories.length > 64) throw new Error('allowedProjectDirectories must contain 1-64 project directories.');
  const allowedProjectDirectories = config.allowedProjectDirectories.map(item => projectPath(item, 'Allowed project', root));
  if (!Array.isArray(config.launchProfiles) || config.launchProfiles.length > 64) throw new Error('launchProfiles must be an array of at most 64 profiles.');
  const ids = new Set<string>();
  const launchProfiles = config.launchProfiles.map((value): LaunchProfile => {
    const profile = object(value, 'Launch profile');
    keys(profile, ['id', 'label', 'executable', 'args', 'projectDirectory', 'environment', 'columns'], 'Launch profile');
    if (typeof profile.id !== 'string' || !/^[a-z0-9-]{1,64}$/i.test(profile.id) || ids.has(profile.id)) throw new Error('Profile IDs must be unique letters, numbers or hyphens.');
    ids.add(profile.id);
    if (typeof profile.label !== 'string' || !profile.label.trim() || utf8Bytes(profile.label) > 256) throw new Error('Launch profile requires a label of at most 256 UTF-8 bytes.');
    if (typeof profile.executable !== 'string') throw new Error('Launch profile requires an executable.');
    if (!Array.isArray(profile.args) || profile.args.length > 64 || !profile.args.every(item => typeof item === 'string' && !item.includes('\0')) ||
      profile.args.reduce((sum, item) => sum + (typeof item === 'string' ? item.length : 0), 0) > 30000) throw new Error('Launch profile args must be a bounded string array.');
    return revalidateProfile({ id: profile.id, label: profile.label, executable: profile.executable,
      args: profile.args as string[], projectDirectory: profile.projectDirectory as string,
      environment: environment(profile.environment),
      ...(Object.hasOwn(profile, 'columns') ? { columns: integer(profile.columns, 'columns', 20, 300) } : {}) }, { allowedProjectDirectories }, root);
  });
  const terminal = object(config.terminal, 'terminal');
  keys(terminal, ['scrollbackLines', 'recentOutputBytes', 'maxIncompleteSequenceBytes'], 'terminal');
  const diagnostics = object(config.diagnostics, 'diagnostics');
  keys(diagnostics, ['directory', 'maxFiles', 'maxFileBytes'], 'diagnostics');
  if (typeof diagnostics.directory !== 'string' || !diagnostics.directory || path.isAbsolute(diagnostics.directory) ||
    process.platform !== 'win32' && (/^[A-Z]:/i.test(diagnostics.directory) || diagnostics.directory.includes('\\'))) throw new Error('diagnostics.directory must be relative to the application project.');
  const capacity = object(config.capacity === undefined ? {} : config.capacity, 'capacity');
  keys(capacity, ['maxRunningSessions', 'retainedExitedSessions', 'maxViews'], 'capacity');
  const control = object(config.control === undefined ? {} : config.control, 'control'); keys(control, ['timeoutMs'], 'control');
  const transport = object(config.transport === undefined ? {} : config.transport, 'transport');
  keys(transport, Object.keys(DEFAULT_LIMITS.transport), 'transport');
  const jobs = object(config.jobs === undefined ? {} : config.jobs, 'jobs'); keys(jobs, Object.keys(JOB_LIMITS), 'jobs');
  const result: Config = {
    version: 1, port: integer(Object.hasOwn(config, 'port') ? config.port : 8765, 'port', 1, 65535),
    allowedProjectDirectories, launchProfiles,
    terminal: { scrollbackLines: integer(terminal.scrollbackLines, 'scrollbackLines', 0, 100000),
      recentOutputBytes: integer(terminal.recentOutputBytes, 'recentOutputBytes', 1024, 67108864),
      maxIncompleteSequenceBytes: optional(terminal, 'maxIncompleteSequenceBytes', 65536, 1024, 1048576) },
    capacity: { maxRunningSessions: optional(capacity, 'maxRunningSessions', 8, 1, 32),
      retainedExitedSessions: optional(capacity, 'retainedExitedSessions', 8, 1, 32), maxViews: optional(capacity, 'maxViews', 16, 2, 64) },
    control: { timeoutMs: optional(control, 'timeoutMs', 10000, 2000, 60000) },
    transport: { maxFrameBytes: optional(transport, 'maxFrameBytes', 262144, 131072, 1048576),
      maxInputBytes: optional(transport, 'maxInputBytes', 65536, 1024, 65536),
      maxViewQueueBytes: optional(transport, 'maxViewQueueBytes', 1048576, 262144, 8388608),
      maxRendererBacklogBytes: optional(transport, 'maxRendererBacklogBytes', 1048576, 262144, 8388608),
      maxSnapshotBytes: optional(transport, 'maxSnapshotBytes', 33554432, 1048576, 67108864) },
    diagnostics: { directory: assertManagedPath(root, path.resolve(root, diagnostics.directory)),
      maxFiles: integer(diagnostics.maxFiles, 'diagnostics.maxFiles', 1, 100),
      maxFileBytes: integer(diagnostics.maxFileBytes, 'diagnostics.maxFileBytes', 1024, 16777216) },
    jobs: { timeoutMs: optional(jobs, 'timeoutMs', JOB_LIMITS.timeoutMs, 1000, 86400000),
      outputBytes: optional(jobs, 'outputBytes', JOB_LIMITS.outputBytes, 1024, 268435456) },
    ...(Object.hasOwn(config, 'frame') ? { frame: frameFolder(config.frame, path.dirname(configPath)) } : {}),
  };
  if (result.transport.maxViewQueueBytes < result.transport.maxFrameBytes ||
    result.transport.maxRendererBacklogBytes < result.transport.maxFrameBytes ||
    result.transport.maxFrameBytes < result.transport.maxInputBytes + 1024 || result.transport.maxSnapshotBytes < 120 * 40 * 16) {
    throw new Error('Transport limits must fit the frame, input envelope and active terminal screen.');
  }
  if (config.fleet !== undefined) result.fleet = parseFleet(config.fleet, root, result.port);
  return result;
}
