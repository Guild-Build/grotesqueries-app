import fs from 'node:fs';
import path from 'node:path';
import { assertManagedPath, managedDirectory } from '../helpers/runtime.js';
import { loadConfig, parseConfig, resolveExecutable } from '../../config/application.js';

/** Discover tools without executing them; existing configuration always wins. */
export function setupPosix(root: string, packaged = false, inherited: NodeJS.ProcessEnv = process.env): string {
  if (!['darwin', 'linux'].includes(process.platform)) throw new Error('POSIX_SETUP_UNSUPPORTED: Use Windows setup on this platform.');
  const directory = managedDirectory(root, path.join(root, packaged ? 'config' : '.runtime/posix'));
  const file = assertManagedPath(root, path.join(directory, 'grotesqueries.json'));
  if (fs.existsSync(file)) { loadConfig(file, root); return file; }
  const shells = process.platform === 'darwin' ? [['zsh', '/bin/zsh', ['-f', '-i']], ['bash', '/bin/bash', ['--noprofile', '--norc', '-i']]]
    : [['bash', '/bin/bash', ['--noprofile', '--norc', '-i']], ['sh', '/bin/sh', ['-i']]];
  const launchProfiles: Array<{ id: string; label: string; executable: string; args: string[]; projectDirectory: string; environment: Record<string, string> }> = [];
  for (const [id, executable, args] of shells as Array<[string, string, string[]]>) {
    try { launchProfiles.push({ id, label: id === 'zsh' ? 'Zsh' : id === 'bash' ? 'Bash' : 'Shell',
      executable: resolveExecutable(executable, inherited), args, projectDirectory: '.', environment: {} }); }
    catch { /* Missing optional shells are not installed by setup. */ }
  }
  if (!launchProfiles.length) throw new Error('POSIX_SHELL_NOT_FOUND: Install a supported shell before setup.');
  for (const [id, label] of [['claude', 'Claude Code'], ['codex', 'Codex']]) {
    try { launchProfiles.push({ id, label, executable: resolveExecutable(id, inherited), args: [], projectDirectory: '.', environment: {} }); }
    catch { /* Provider CLIs are optional and retain their own authentication. */ }
  }
  const config = { version: 1, port: 8765, allowedProjectDirectories: ['.'], launchProfiles,
    frame: path.relative(directory, path.join(root, 'frame/dist')),
    terminal: { scrollbackLines: 10000, recentOutputBytes: 8388608, maxIncompleteSequenceBytes: 65536 },
    diagnostics: { directory: '.runtime/logs', maxFiles: 4, maxFileBytes: 1048576 } };
  // Validate before writing. A failed discovery never replaces operator data.
  parseConfig(config, file, root);
  fs.writeFileSync(file, JSON.stringify(config, null, 2) + '\n', { flag: 'wx', mode: 0o600 });
  return file;
}
