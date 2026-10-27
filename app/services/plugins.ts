import fs from 'node:fs';
import path from 'node:path';
import { decodePluginManifest, importChecked, importViolations, type LaunchProfile, type PluginSummary } from '@grotesqueries/protocol';
import { projectPath, revalidateProfile, type Config } from '../../config/application.js';
import { assertManagedPath, isWithin, managedDirectory } from '../helpers/runtime.js';
import type { DiagnosticLogger } from './diagnostics.js';

/** Startup result: what loaded, what each contributed, and every refusal by plugin folder name. */
export interface LoadedPlugins {
  summaries: PluginSummary[];
  profiles: LaunchProfile[];
  jobs: Set<string>;
  /** `<plugin name>/<folder id>` to its canonical directory. */
  folders: Map<string, string>;
  refused: Array<{ name: string; reason: string }>;
}

/**
 * A-05: every script and page in the plugin folder imports only the contract or files inside the folder. A link or
 * junction inside it is refused, since a path through it reads as inside while reaching elsewhere.
 */
function checkImports(root: string, relative = ''): void {
  for (const entry of fs.readdirSync(path.join(root, relative), { withFileTypes: true })) {
    const file = relative ? `${relative}/${entry.name}` : entry.name;
    if (entry.isSymbolicLink()) throw new Error(`Plugin file ${file} is a junction or link.`);
    if (entry.isDirectory()) checkImports(root, file);
    else if (importChecked(file)) {
      const [refused] = importViolations(file, fs.readFileSync(path.join(root, file), 'utf8'));
      if (refused !== undefined) throw new Error(`File ${file} imports ${refused}.`);
    }
  }
}

/**
 * A value that begins with `{plugin}` or `{app}` names a path under the plugin folder or the application root. It
 * resolves against that folder and must stay inside it (setup's assertManagedPath, junctions included). A placeholder
 * anywhere else in a value is refused rather than passed on as text.
 */
function placeholder(value: string, bases: { plugin: string; app: string }): string {
  const match = /^\{(plugin|app)\}(?=$|[\\/])/.exec(value);
  const rest = match ? value.slice(match[0].length) : value;
  if (/\{(?:plugin|app)\}/.test(rest)) throw new Error(`A placeholder must begin the value: ${value}.`);
  if (!match) return value;
  const base = bases[match[1] as 'plugin' | 'app'];
  try { return assertManagedPath(base, path.join(base, rest)); }
  catch { throw new Error(`${value} leaves ${match[0]}.`); }
}

/**
 * K-02: read `<directory>/<name>/manifest.json` once at startup. Setup's own checks contain every project directory,
 * executable and environment (revalidateProfile) and every served folder (projectPath plus allowedProjectDirectories);
 * folders and project directories are placed by the decoder (requirement 1.4), a relative executable resolves against
 * the plugin folder, and placeholders resolve before any check. A refused plugin never stops the others; each refusal is also
 * logged by name, without its reason text, since native error text never enters the diagnostic log.
 */
export function loadPlugins(directory: string, config: Pick<Config, 'allowedProjectDirectories' | 'launchProfiles'>,
  diagnostics?: Pick<DiagnosticLogger, 'log'>): LoadedPlugins {
  const loaded: LoadedPlugins = { summaries: [], profiles: [], jobs: new Set(), folders: new Map(), refused: [] };
  if (!fs.existsSync(directory)) return loaded;
  const allowed = config.allowedProjectDirectories.map(item => projectPath(item, 'Allowed project'));
  // The plugins folder sits in the application root, so its parent is what {app} names.
  const app = projectPath(path.dirname(directory), 'Application root');
  const entries = fs.readdirSync(directory, { withFileTypes: true }).filter(entry => entry.isDirectory() || entry.isSymbolicLink());
  const links = new Set(entries.filter(entry => entry.isSymbolicLink()).map(entry => entry.name));
  const names = entries.map(entry => entry.name).sort();
  for (const name of names) {
    try {
      // A junction or link is reported by name, never followed (K-02).
      if (links.has(name)) throw new Error('Plugin folder is a junction or link.');
      // Bootstrap's decoder holds at most 64 plugins; one more would stop every view.
      if (loaded.summaries.length === 64) throw new Error('More than 64 plugins.');
      const root = projectPath(path.join(directory, name), 'Plugin folder');
      const manifest = decodePluginManifest(JSON.parse(fs.readFileSync(path.join(root, 'manifest.json'), 'utf8')));
      if (manifest.name !== name) throw new Error(`Manifest name ${manifest.name} does not match its folder.`);
      checkImports(root);
      const place = (value: string) => placeholder(value, { plugin: root, app });
      // Row 10 and demo 3.2: a placed project directory or served folder missing at startup is created when it lies
      // inside the plugin folder or an allowed directory, through setup's own containment check (managedDirectory,
      // assertManagedPath), junctions included. Returns false when no such directory holds it; nothing is created then.
      const create = (declared: string) => {
        const lexical = path.resolve(root, declared);
        if (fs.existsSync(lexical)) return true;
        const base = [root, ...allowed].find(project => isWithin(project, lexical));
        if (base) managedDirectory(base, lexical);
        return !!base;
      };
      const taken = new Set([...config.launchProfiles, ...loaded.profiles].map(profile => profile.id));
      const profiles = [...manifest.profiles, ...manifest.commands].map(item => {
        if (taken.has(item.id)) throw new Error(`Profile ${item.id} is already loaded.`);
        // Outside containment a missing project is left for revalidateProfile to refuse, as before (slice 1 F1).
        const projectDirectory = place(item.projectDirectory);
        create(projectDirectory);
        return revalidateProfile({ ...item, args: item.args.map(place), projectDirectory,
          environment: item.environment ?? {} }, { allowedProjectDirectories: allowed }, root);
      });
      if (config.launchProfiles.length + loaded.profiles.length + profiles.length > 64) throw new Error('More than 64 startable profiles.');
      const folders = manifest.folders.map(folder => {
        const declared = place(folder.path);
        if (!create(declared)) throw new Error(`Folder ${folder.id} does not exist and is outside allowed directories.`);
        const resolved = projectPath(declared, `Plugin folder ${folder.id}`, root);
        if (!isWithin(root, resolved) && !allowed.some(project => isWithin(project, resolved))) throw new Error(`Folder ${folder.id} is outside allowed directories.`);
        return [`${name}/${folder.id}`, resolved] as const;
      });
      loaded.profiles.push(...profiles);
      for (const command of manifest.commands) loaded.jobs.add(command.id);
      for (const [key, value] of folders) loaded.folders.set(key, value);
      loaded.summaries.push({ name, contract: manifest.contract, panel: manifest.panel ?? null, pages: manifest.pages,
        profiles: manifest.profiles.map(profile => profile.id), commands: manifest.commands.map(command => command.id) });
    } catch (error) {
      loaded.refused.push({ name, reason: error instanceof Error ? error.message : 'Unreadable manifest.' });
      // A failed log write must not stop the plugins after this one, as for sessions.
      try { diagnostics?.log('plugin-refused', { plugin: name, code: 'PLUGIN_REFUSED' }); } catch { console.error('DIAGNOSTICS_WRITE_FAILED'); }
    }
  }
  return loaded;
}

const contentTypes: Record<string, string> = { '.html': 'text/html; charset=utf-8', '.htm': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.mjs': 'text/javascript; charset=utf-8',
  '.json': 'application/json', '.txt': 'text/plain; charset=utf-8', '.md': 'text/plain; charset=utf-8',
  '.svg': 'image/svg+xml', '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.gif': 'image/gif' };

/** K-05: read one file under `/plugins/<name>/<folder id>/...`; anything else, including a junction escape, is absent. */
export function pluginFile(folders: ReadonlyMap<string, string>, pathname: string): { data: Buffer; contentType: string } | undefined {
  const [, prefix, name, folder, ...rest] = pathname.split('/');
  const root = prefix === 'plugins' ? folders.get(`${name}/${folder}`) : undefined;
  if (!root || !rest.length) return;
  return folderFile(root, rest);
}

/** K-05's containment for one folder: `rest` is the request's path segments under it, still URL-encoded. */
export function folderFile(root: string, rest: string[]): { data: Buffer; contentType: string } | undefined {
  let parts: string[];
  try { parts = rest.map(part => decodeURIComponent(part)); } catch { return; }
  // A folder URL, with its trailing slash, serves that folder's index.html through the same containment.
  if (rest[rest.length - 1] === '') parts[parts.length - 1] = 'index.html';
  // A segment that starts with a dot is absent: `.` and `..`, and a plugin's own build state such as `.build/` (job 3 L2-4).
  if (parts.some(part => !part || part.startsWith('.') || /[\\/:*?"<>|\0]/.test(part))) return;
  try {
    // `.native` turns an 8.3 short name into its long name, so the check below sees `.build`; plain realpathSync keeps the short name (R2-F1).
    const file = fs.realpathSync.native(path.join(root, ...parts));
    // The resolved path is checked for dot-led segments too, so a name that reaches `.build` (an 8.3 alias such as
    // BUILD~1, or a link) is absent as well (slice 1 F2).
    if (!isWithin(root, file) || path.relative(root, file).split(path.sep).some(part => part.startsWith('.'))) return;
    if (!fs.statSync(file).isFile()) return;
    return { data: fs.readFileSync(file), contentType: contentTypes[path.extname(file).toLowerCase()] ?? 'application/octet-stream' };
  } catch { return; }
}
