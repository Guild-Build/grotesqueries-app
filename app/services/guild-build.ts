import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { GUILD_BUILD_SLUGS, type GuildBuildSummary, type LaunchProfile } from '@grotesqueries/protocol';
import { assertManagedPath, isWithin, managedDirectory } from '../helpers/runtime.js';
import { revalidateProfile, resolveExecutable, type Config } from '../../config/application.js';

const hash = /^[a-f0-9]{64}$/;
const revision = /^[a-f0-9]{40}$/;
const version = /^\d+\.\d+\.\d+(?:-[a-zA-Z0-9.-]+)?$/;
const moduleId = /^(skill|agent|hook|mcp|playbook|tool)\/[a-z0-9]+(?:-[a-z0-9]+)*$/;
const maximumBytes = 16 * 1024 * 1024;
type Preset = {
  schemaVersion: 1;
  runtime: { version: string; platform: string; architecture: string; sourceRevision: string; archiveSha256: string };
  build: { slug: string; name: string; version: string; target: 'claude-code'; catalogRevision: string;
    archiveSha256: string; modules: string[]; files: Array<{ path: string; sha256: string }> };
};
function refuse(message: string): never { throw new Error('GUILD_BUILD_INVALID: ' + message); }
function object(value: unknown, fields: string[]): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) refuse('Expected an object.');
  const item = value as Record<string, unknown>;
  if (Object.keys(item).length !== fields.length || fields.some(field => !Object.hasOwn(item, field))) refuse('Unsupported or missing fields.');
  return item;
}
function text(value: unknown, pattern?: RegExp, bound = 256): string {
  if (typeof value !== 'string' || !value.trim() || Buffer.byteLength(value) > bound || /[\0-\x1f\x7f]/.test(value) || pattern && !pattern.test(value)) refuse('Invalid text.');
  return value;
}
function relativeFile(value: unknown): string {
  const file = text(value, undefined, 512);
  const parts = file.split('/');
  if (parts.length > 16 || parts.some(part => !/^[a-zA-Z0-9_.-]+$/.test(part) || part === '.' || part === '..' || /[. ]$/.test(part) ||
    /^(con|prn|aux|nul|com[0-9]|lpt[0-9])(?:\.|$)/i.test(part))) refuse('Unsafe file path.');
  return file;
}
function present(file: string): boolean {
  try { fs.lstatSync(file); return true; } catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return false; throw error; }
}
function regular(root: string, relative: string, limit = 1024 * 1024): Buffer {
  let file = root;
  for (const part of relative.split('/')) {
    file = assertManagedPath(root, path.join(file, part));
    if (fs.lstatSync(file).isSymbolicLink()) refuse('Links are not allowed in a kit.');
  }
  const info = fs.lstatSync(file);
  if (!info.isFile() || info.nlink !== 1 || info.size > limit) refuse('Kit file is not a bounded regular file.');
  return fs.readFileSync(file);
}
function json(root: string, relative: string): unknown {
  try { return JSON.parse(regular(root, relative).toString('utf8')); }
  catch (error) { if (error instanceof Error && error.message.startsWith('GUILD_BUILD_INVALID:')) throw error; refuse('Cannot read kit JSON.'); }
}
function filesIn(root: string, relative: string): string[] {
  const folder = assertManagedPath(root, path.join(root, relative));
  const info = fs.lstatSync(folder);
  if (!info.isDirectory() || info.isSymbolicLink()) refuse('Bundle folders cannot be links.');
  const output: string[] = [];
  const seen = new Set<string>();
  let bytes = 0;
  const walk = (directory: string, prefix = '') => {
    for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
      const name = relativeFile(prefix + entry.name);
      if (seen.has(name.toLowerCase())) refuse('Case-colliding bundle paths.');
      seen.add(name.toLowerCase());
      const file = assertManagedPath(root, path.join(directory, entry.name));
      const stat = fs.lstatSync(file);
      if (stat.isSymbolicLink()) refuse('Links are not allowed in a kit.');
      if (stat.isDirectory()) walk(file, name + '/');
      else if (stat.isFile() && stat.nlink === 1) {
        bytes += stat.size; output.push(name);
        if (bytes > maximumBytes || output.length > 256 || stat.size > 1024 * 1024) refuse('Bundle is too large.');
      } else refuse('Bundle contains a non-regular file.');
    }
  };
  walk(folder);
  return output.sort();
}

/** Read a release preset without running code or replacing any customer files. */
export function verifyGuildBuild(root: string): Preset | undefined {
  const file = assertManagedPath(root, path.join(root, 'GUILD-BUILD.json'));
  if (!present(file)) return;
  const raw = object(json(root, 'GUILD-BUILD.json'), ['schemaVersion', 'runtime', 'build']);
  if (raw.schemaVersion !== 1) refuse('Unsupported schema version.');
  const runtime = object(raw.runtime, ['version', 'platform', 'architecture', 'sourceRevision', 'archiveSha256']);
  text(runtime.version, version, 128); text(runtime.sourceRevision, revision); text(runtime.archiveSha256, hash);
  if (!['linux', 'win32', 'darwin'].includes(String(runtime.platform)) || !['x64', 'arm64'].includes(String(runtime.architecture)) ||
    runtime.platform === 'win32' && runtime.architecture !== 'x64') refuse('Unsupported runtime target.');
  if (runtime.platform !== process.platform || runtime.architecture !== process.arch) refuse('This kit is for a different operating system or processor.');
  const metadata = json(root, 'BUILD-METADATA.json') as Record<string, unknown>;
  if (!metadata || typeof metadata !== 'object' || Array.isArray(metadata) || metadata.sourceDirty !== false || metadata.guildBuildPresetVersion !== 1 ||
    ['version', 'platform', 'architecture', 'sourceRevision'].some(field => metadata[field] !== runtime[field])) refuse('Runtime metadata does not match the preset.');
  const build = object(raw.build, ['slug', 'name', 'version', 'target', 'catalogRevision', 'archiveSha256', 'modules', 'files']);
  if (!GUILD_BUILD_SLUGS.includes(build.slug as typeof GUILD_BUILD_SLUGS[number]) || build.target !== 'claude-code') refuse('Unsupported build or agent target.');
  text(build.name); text(build.version, version, 128); text(build.catalogRevision, revision); text(build.archiveSha256, hash);
  if (!Array.isArray(build.modules) || build.modules.length > 64 || build.modules.some(item => typeof item !== 'string' || item.length > 128 || !moduleId.test(item)) ||
    new Set(build.modules).size !== build.modules.length) refuse('Invalid component list.');
  if (!Array.isArray(build.files) || !build.files.length || build.files.length > 256) refuse('Invalid file inventory.');
  const files = build.files.map(item => {
    const entry = object(item, ['path', 'sha256']);
    return { path: relativeFile(entry.path), sha256: text(entry.sha256, hash) };
  });
  if (new Set(files.map(item => item.path.toLowerCase())).size !== files.length) refuse('Duplicate file inventory.');
  const folder = `guild-builds/${build.slug}`;
  // Check every parent, including guild-builds, before walking or reading it.
  for (const name of ['guild-builds', folder]) {
    const info = fs.lstatSync(assertManagedPath(root, path.join(root, name)));
    if (!info.isDirectory() || info.isSymbolicLink()) refuse('Bundle folders cannot be links.');
  }
  if (JSON.stringify(files.map(item => item.path).sort()) !== JSON.stringify(filesIn(root, folder))) refuse('Bundle inventory differs from the preset.');
  for (const item of files) {
    if (crypto.createHash('sha256').update(regular(root, folder + '/' + item.path)).digest('hex') !== item.sha256) refuse('Bundle file checksum differs.');
  }
  if (!files.some(item => item.path === 'LICENSE')) refuse('Bundle license is missing.');
  const authored = json(root, folder + '/buildguild.json') as Record<string, unknown>;
  const plugin = json(root, folder + '/.claude-plugin/plugin.json') as Record<string, unknown>;
  if (!authored || typeof authored !== 'object' || Array.isArray(authored) || !plugin || typeof plugin !== 'object' || Array.isArray(plugin) ||
    authored.schema !== 'buildguild.build.v1' || authored.slug !== build.slug || authored.version !== build.version || authored.name !== build.name ||
    authored.license !== 'Apache-2.0' || !Array.isArray(authored.branches) || !authored.branches.includes('claude-code') ||
    JSON.stringify(authored.modules) !== JSON.stringify(build.modules) || plugin.name !== build.slug || plugin.version !== build.version ||
    plugin.license !== 'Apache-2.0') refuse('Bundle identities do not match the preset.');
  return raw as unknown as Preset;
}

/** Add one in-memory profile. Missing prerequisites leave ordinary profiles usable. */
export function loadGuildBuild(root: string, config: Config, inherited: NodeJS.ProcessEnv = process.env): { config: Config; state?: GuildBuildSummary } {
  const preset = verifyGuildBuild(root);
  if (!preset) return { config };
  const { build } = preset;
  const prerequisites: string[] = [];
  let executable: string | undefined;
  const configuredClaude = config.launchProfiles.find(profile => profile.id === 'claude' && profile.args.length === 0 &&
    (process.platform !== 'win32' || /\.exe$/i.test(profile.executable)));
  try { executable = resolveExecutable(configuredClaude?.executable ?? (process.platform === 'win32' ? 'claude.exe' : 'claude'), inherited, root); }
  catch { prerequisites.push(process.platform === 'win32' ? 'Install the native Claude Code executable, sign in, and run setup again.' : 'Install Claude Code, sign in, and run setup again.'); }
  let bash: string | undefined;
  const environment: Record<string, string> = {};
  if (build.modules.some(module => module.startsWith('hook/'))) {
    const configured = config.launchProfiles.find(profile => profile.id === 'git-bash');
    try { bash = resolveExecutable(configured?.executable ?? (process.platform === 'win32' ? 'bash.exe' : 'bash'), inherited, root); }
    catch { prerequisites.push('This build has Bash hooks. Install Bash (Git for Windows on Windows) before using it.'); }
    try { resolveExecutable('git', inherited); }
    catch { prerequisites.push('This build has Git hooks. Install Git and make it available on PATH before using it.'); }
    if (process.platform === 'win32' && bash) {
      environment.CLAUDE_CODE_GIT_BASH_PATH = bash;
      const pathKey = Object.keys(inherited).find(key => key.toUpperCase() === 'PATH');
      environment.PATH = path.dirname(bash) + path.delimiter + (pathKey ? inherited[pathKey] ?? '' : '');
    }
  }
  if (build.slug === 'evidence-first-review') {
    let parser = ['jq', 'python3', 'node'].some(name => {
      try { resolveExecutable(name, inherited); return true; } catch { return false; }
    });
    if (!parser && process.platform === 'linux') {
      try {
        const metadata = json(root, 'BUILD-METADATA.json') as Record<string, unknown>;
        const node = resolveExecutable(path.join(root, 'bin/node'), inherited, root);
        const digest = crypto.createHash('sha256').update(regular(root, 'bin/node', 128 * 1024 * 1024)).digest('hex');
        if (typeof metadata.nodeBinarySha256 === 'string' && hash.test(metadata.nodeBinarySha256) && digest === metadata.nodeBinarySha256) {
          environment.PATH = path.dirname(node) + path.delimiter + (inherited.PATH ?? ''); parser = true;
        }
      } catch { /* A missing or changed bundled parser never enables the merge guard. */ }
    }
    if (!parser) prerequisites.push('The merge guard needs jq, python3 or Node on PATH to parse its JSON input.');
  }
  const profileId = `guild-${build.slug}`;
  const workspace = assertManagedPath(root, path.join(root, 'workspaces', profileId));
  if (!config.allowedProjectDirectories.some(directory => isWithin(directory, workspace))) prerequisites.push('Authorize the app-local workspace in allowedProjectDirectories before using this build.');
  if (config.launchProfiles.some(profile => profile.id === profileId) || config.launchProfiles.length >= 64) prerequisites.push('The selected build profile conflicts with an existing profile or the profile limit.');
  const state: GuildBuildSummary = { slug: build.slug, name: build.name, version: build.version, target: build.target,
    modules: [...build.modules], catalogRevision: build.catalogRevision, profileId: null, prerequisites };
  if (!prerequisites.length && executable) {
    for (const directory of [path.join(root, 'workspaces'), workspace]) {
      if (present(directory) && fs.lstatSync(directory).isSymbolicLink()) refuse('The app-local workspace cannot be a link.');
    }
    managedDirectory(root, workspace);
    const profile: LaunchProfile = revalidateProfile({ id: profileId, label: `${build.name} · Claude Code`, executable,
      args: ['--plugin-dir', path.join(root, 'guild-builds', build.slug)], projectDirectory: workspace,
      environment }, config, root);
    state.profileId = profileId;
    return { config: { ...config, launchProfiles: [...config.launchProfiles, profile] }, state };
  }
  return { config, state };
}
