import fs from 'node:fs';
import path from 'node:path';

export interface Runtime {
  root: string;
  configFile: string;
  temporary: string;
  packaged: boolean;
}

const windows = process.platform === 'win32';

function lexicalProjectPath(value: string): string {
  const rejected = JSON.stringify(value.slice(0, 4096));
  if (!windows) {
    if (!path.isAbsolute(value) || value.startsWith('//') || /[\0\\]/.test(value)) {
      throw new Error('Managed paths must be local absolute project paths; network paths are excluded. Rejected path: ' + rejected);
    }
    const resolved = path.resolve(value);
    if (resolved === path.parse(resolved).root) throw new Error('A project folder beneath the filesystem root is required. Rejected path: ' + rejected);
    return resolved;
  }
  // Windows may return a local drive path with the extended-length prefix.
  if (/^\\\\\?\\[A-Z]:[\\/]/i.test(value)) value = value.slice(4);
  if (!/^[A-Z]:[\\/]/i.test(value) || /[\0<>"|?*]/.test(value) || value.slice(2).includes(':')) {
    throw new Error('Managed paths must be local absolute project paths; network paths are excluded. Rejected path: ' + rejected);
  }
  const resolved = path.resolve(value);
  if (resolved === path.parse(resolved).root) throw new Error('A project folder beneath the drive root is required. Rejected path: ' + rejected);
  if (resolved.slice(3).split('\\').some(part => /[. ]$/.test(part))) {
    throw new Error('Managed path contains an ambiguous Windows filename. Rejected path: ' + rejected);
  }
  return resolved;
}

export function isWithin(parent: string, child: string): boolean {
  const relative = path.relative(parent, child);
  return relative === '' || (relative !== '..' && !relative.startsWith('..' + path.sep) && !path.isAbsolute(relative));
}

function canonicalPath(value: string): string {
  let existing = value;
  const suffix: string[] = [];
  while (!fs.existsSync(existing)) {
    // A dangling link must not be treated as an ordinary missing destination.
    try {
      if (fs.lstatSync(existing).isSymbolicLink()) throw new Error('Managed path has an unresolved symbolic link.');
    } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
    suffix.unshift(path.basename(existing));
    const parent = path.dirname(existing);
    if (parent === existing) throw new Error('Managed path has no existing project parent.');
    existing = parent;
  }
  return path.join(fs.realpathSync.native(existing), ...suffix);
}

/** Validate the lexical destination before probing parents or following junctions. */
export function assertManagedPath(root: string, destination: string): string {
  const project = lexicalProjectPath(root);
  const target = lexicalProjectPath(destination);
  if (!isWithin(project, target)) throw new Error('Managed path escapes the application project.');
  const canonicalRoot = lexicalProjectPath(canonicalPath(project));
  const canonicalTarget = lexicalProjectPath(canonicalPath(target));
  if (windows && path.parse(canonicalRoot).root.toUpperCase() !== path.parse(project).root.toUpperCase()) {
    throw new Error('Project root junction changes its configured drive.');
  }
  if (!isWithin(canonicalRoot, canonicalTarget)) throw new Error('Managed path junction escapes the application project.');
  return target;
}

export function posixWindowsPath(value: string): string {
  return value.replace(/^([a-z]):/i, (_, drive: string) => '/' + drive.toLowerCase()).replaceAll('\\', '/');
}

export function managedDirectory(root: string, directory: string): string {
  const validated = assertManagedPath(root, directory);
  fs.mkdirSync(validated, { recursive: true });
  assertManagedPath(root, validated);
  return validated;
}

export function resolveRuntime(options: { sourceEntry?: string; executable?: string; configFile?: string;
  configName: string; sourceConfigName?: string }): Runtime {
  const packaged = options.executable !== undefined;
  const entry = packaged ? options.executable : options.sourceEntry;
  if (!entry) throw new Error('An explicit host entry path is required.');
  lexicalProjectPath(entry);
  const root = lexicalProjectPath(packaged ? path.dirname(entry) : path.resolve(path.dirname(entry), '../..'));
  assertManagedPath(root, root);
  return { root, packaged,
    configFile: assertManagedPath(root, packaged ? path.join(root, options.configName) :
      options.configFile ?? path.join(root, options.sourceConfigName ?? path.join('config', options.configName))),
    temporary: assertManagedPath(root, path.join(root, '.runtime/tmp')) };
}

export function createChildEnvironment(root: string, jobId: string,
  inherited: Record<string, string | undefined> = process.env,
  overrides: Record<string, string> = {}, defaults: Record<string, string> = {}): Record<string, string> {
  if (!/^[a-zA-Z0-9-]{1,128}$/.test(jobId)) throw new Error('Invalid temporary process identity.');
  const environment: Record<string, string> = {};
  for (const [key, value] of Object.entries(inherited)) {
    if (value === undefined) continue;
    const normalized = windows ? key.toUpperCase() : key;
    if (Object.hasOwn(environment, normalized) && environment[normalized] !== value) {
      throw new Error('Inherited environment contains ambiguous Windows variable names.');
    }
    environment[normalized] = value;
  }
  for (const values of [defaults, overrides]) {
    const seen = new Set<string>();
    for (const [key, value] of Object.entries(values)) {
      const normalized = windows ? key.toUpperCase() : key;
      if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(key) || value.includes('\0') || seen.has(normalized)) {
        throw new Error('Environment overrides must have unique valid variable names and string values.');
      }
      if (['TEMP', 'TMP', 'TMPDIR', 'HOME', 'USERPROFILE', 'CODEX_HOME'].includes(key.toUpperCase())) {
        throw new Error(`${normalized} is reserved; temporary paths are project-owned and home settings are inherited.`);
      }
      seen.add(normalized);
      environment[normalized] = value;
    }
  }
  const temporary = managedDirectory(root, path.join(root, '.runtime/tmp', jobId));
  environment.TEMP = temporary;
  environment.TMP = temporary;
  environment.TMPDIR = windows ? posixWindowsPath(temporary) : temporary;
  return environment;
}
