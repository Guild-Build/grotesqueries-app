import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import type { LaunchProfile } from '@grotesqueries/protocol';
import { assertManagedPath, isWithin } from '../helpers/runtime.js';
import { parseConfig } from '../../config/application.js';
import { verifyGuildBuild } from './guild-build.js';

type Program = { path: string; executable: string };

/** Explicit installation setup: inspect files and update JSON, never launch a CLI. */
export function configureInstallation(directory: string,
  inherited: Record<string, string | undefined> = process.env): void {
  const root = assertManagedPath(directory, directory);
  verifyGuildBuild(root);
  if (!fs.existsSync(path.win32.join(root, 'grotesqueries.exe'))) throw new Error('grotesqueries.exe was not found in the application folder.');
  const variables: Record<string, string> = Object.fromEntries(
    Object.entries(inherited).map(([key, value]) => [key.toUpperCase(), value ?? '']));
  const under = (name: string, relative: string): string | undefined => {
    const folder = variables[name];
    return folder && /^[A-Z]:[\\/]/i.test(folder) ? path.win32.join(folder, relative) : undefined;
  };
  const localFile = (candidate: string | undefined): string | undefined => {
    if (!candidate || !/^[A-Z]:[\\/]/i.test(candidate)) return undefined;
    try {
      const canonical = fs.realpathSync.native(candidate);
      return /^[A-Z]:[\\/]/i.test(canonical) && fs.statSync(canonical).isFile() ? canonical : undefined;
    } catch { return undefined; }
  };
  const program = (file: string): Program => ({ path: file, executable: isWithin(root, file) ?
    './' + path.win32.relative(root, file).replaceAll('\\', '/') : file });
  const find = (names: string[], candidates: (string | undefined)[] = []): Program | undefined => {
    for (const name of names) for (const entry of (variables.PATH ?? '').split(';')) {
      const folder = entry.replace(/^"|"$/g, '');
      if (!/^[A-Z]:[\\/]/i.test(folder)) continue;
      const found = localFile(path.win32.join(folder, name));
      if (found) return program(found);
    }
    for (const candidate of candidates) {
      const found = localFile(candidate);
      if (found) return program(found);
    }
    return undefined;
  };
  const profiles: LaunchProfile[] = [];
  const add = (id: string, label: string, program: Program | undefined, args: string[] = [],
    environment: Record<string, string> = {}): void => {
    if (!program) { console.log('Skipped ' + label + ': no installed executable found.'); return; }
    profiles.push({ id, label, executable: program.executable, args, projectDirectory: '.', environment });
    console.log('Found ' + label + ': ' + program.path);
  };
  const commandPrompt = find(['cmd.exe'], [under('SYSTEMROOT', 'System32/cmd.exe')]);
  const powershell = find(['powershell.exe'], [under('SYSTEMROOT', 'System32/WindowsPowerShell/v1.0/powershell.exe')]);
  add('command-prompt', 'Command Prompt', commandPrompt, ['/d']);
  add('powershell', 'PowerShell', powershell, ['-NoLogo', '-NoProfile']);
  add('pwsh', 'PowerShell 7', find(['pwsh.exe']), ['-NoLogo', '-NoProfile']);
  const git = find(['git.exe']);
  const gitDirectory = git ? path.win32.dirname(git.path) : undefined;
  add('git-bash', 'Git Bash', find([], [
    under('PROGRAMFILES', 'Git/bin/bash.exe'), under('PROGRAMFILES(X86)', 'Git/bin/bash.exe'),
    under('LOCALAPPDATA', 'Programs/Git/bin/bash.exe'),
    ...(gitDirectory ? [path.win32.join(gitDirectory, 'bash.exe'), path.win32.join(gitDirectory, '../bin/bash.exe'),
      path.win32.join(gitDirectory, '../../bin/bash.exe')] : []),
  ]), ['--noprofile', '--norc', '-i'], { LANG: 'en_US.UTF-8' });
  const addCLI = (id: string, label: string, candidates: (string | undefined)[]): void => {
    const program = find([id + '.exe'], candidates);
    if (program) { add(id, label, program); return; }
    const wrapper = find([id + '.cmd']);
    if (wrapper && commandPrompt && !/[&<>|%^!"]/.test(wrapper.path)) {
      add(id, label, { path: wrapper.path, executable: commandPrompt.executable },
        ['/d', '/c', 'call', wrapper.path]);
      return;
    }
    const script = find([id + '.ps1']);
    if (script && powershell) {
      add(id, label, { path: script.path, executable: powershell.executable },
        ['-NoLogo', '-NoProfile', '-File', script.path]);
      return;
    }
    add(id, label, undefined);
  };
  addCLI('claude', 'Claude Code', [under('USERPROFILE', '.local/bin/claude.exe'),
    under('LOCALAPPDATA', 'Microsoft/WinGet/Links/claude.exe')]);
  addCLI('codex', 'Codex', [under('LOCALAPPDATA', 'Programs/OpenAI/Codex/bin/codex.exe')]);
  const file = assertManagedPath(root, path.win32.join(root, 'grotesqueries.json'));
  if (!profiles.length && !fs.existsSync(file)) throw new Error('No supported executable was found. Install a shell or CLI, then run setup again.');
  let configuration: Record<string, unknown>;
  if (fs.existsSync(file)) {
    let raw: unknown;
    try { raw = JSON.parse(fs.readFileSync(file, 'utf8').replace(/^\uFEFF/, '')); }
    catch { throw new Error('Cannot read valid JSON configuration. Check grotesqueries.json in the application folder.'); }
    if (!raw || typeof raw !== 'object' || Array.isArray(raw) || (raw as Record<string, unknown>).version !== 1) {
      throw new Error('Existing JSON has an unsupported version. Preserve it and restore version-1 JSON first.');
    }
    configuration = raw as Record<string, unknown>;
    const parsed = parseConfig(configuration, file, root);
    const existing = configuration.launchProfiles as LaunchProfile[];
    const additions = parsed.allowedProjectDirectories.some(allowed => isWithin(allowed, root))
      ? profiles.filter(profile => !existing.some(item => item.id === profile.id)).slice(0, 64 - existing.length) : [];
    if (!additions.length) {
      console.log('Existing configuration preserved. No CLI was launched.');
      return;
    }
    configuration = { ...configuration, launchProfiles: [...existing, ...additions] };
  } else {
    configuration = { version: 1, port: 8765, allowedProjectDirectories: ['.'], launchProfiles: profiles,
      terminal: { scrollbackLines: 10000, recentOutputBytes: 8388608, maxIncompleteSequenceBytes: 65536 },
      diagnostics: { directory: '.runtime/logs', maxFiles: 4, maxFileBytes: 1048576 } };
  }
  parseConfig(configuration, file, root);
  if (fs.existsSync(file)) {
    const first = assertManagedPath(root, file + '.bak');
    const backup = fs.existsSync(first) ? assertManagedPath(root, file + '.' + crypto.randomUUID() + '.bak') : first;
    fs.copyFileSync(file, backup, fs.constants.COPYFILE_EXCL);
    console.log('Previous configuration backed up to ' + backup);
  }
  const temporary = assertManagedPath(root, path.win32.join(root, '.grotesqueries-' + crypto.randomUUID() + '.tmp'));
  try {
    fs.writeFileSync(temporary, JSON.stringify(configuration, null, 2) + '\n', { encoding: 'utf8', flag: 'wx', mode: 0o600 });
    fs.renameSync(temporary, file);
  } finally {
    if (fs.existsSync(temporary)) fs.unlinkSync(temporary);
  }
  console.log('Wrote ' + file + ' with ' + (configuration.launchProfiles as unknown[]).length + ' profiles. Existing profiles and allowed directories were preserved.');
  console.log('No CLI was launched. Restart the host to apply this configuration.');
}
