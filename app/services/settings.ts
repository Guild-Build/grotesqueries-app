import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { parseConfig, type Config } from '../../config/application.js';
import type { SettingsDocument } from '../../lib/protocol/src/settings.js';

function object(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('SETTINGS_INVALID: Expected an object.');
  return value as Record<string, unknown>;
}
function exact(value: Record<string, unknown>, fields: string[]): void {
  if (Object.keys(value).length !== fields.length || fields.some(key => !Object.hasOwn(value, key)))
    throw new Error('SETTINGS_INVALID: Missing or unsupported fields.');
}
const revision = (text: string) => crypto.createHash('sha256').update(text).digest('hex');

/** Operator-owned file only. Save is synchronous and atomic; no active changes precede durable replacement. */
export class HostSettings {
  constructor(readonly file: string, private readonly root: string, private readonly listeningPort: number) {}
  private read(): { raw: Record<string, unknown>; config: Config; revision: string } {
    if (fs.statSync(this.file).size > 1024 * 1024) throw new Error('SETTINGS_INVALID: Configuration exceeds 1 MiB.');
    const text = fs.readFileSync(this.file, 'utf8');
    const raw = object(JSON.parse(text));
    return { raw, config: parseConfig(raw, this.file, this.root), revision: revision(text) };
  }
  private project(config: Config, rev: string): SettingsDocument {
    return { revision: rev, file: this.file, listeningPort: this.listeningPort, restartRequired: config.port !== this.listeningPort,
      allowedProjectDirectories: [...config.allowedProjectDirectories], settings: {
        port: config.port, scrollbackLines: config.terminal.scrollbackLines, recentOutputBytes: config.terminal.recentOutputBytes,
        maxRunningSessions: config.capacity.maxRunningSessions, maxViews: config.capacity.maxViews,
        profiles: config.launchProfiles.map(({ id, label, executable, args, projectDirectory, columns }) =>
          ({ id, label, executable, args: [...args], projectDirectory, columns: columns ?? null })) } };
  }
  get(): SettingsDocument { const value = this.read(); return this.project(value.config, value.revision); }
  save(value: unknown): { document: SettingsDocument; config: Config } {
    const request = object(value); exact(request, ['revision', 'settings']);
    const current = this.read();
    if (request.revision !== current.revision) throw new Error('SETTINGS_CONFLICT: Configuration changed. Reload settings before saving.');
    const edit = object(request.settings);
    exact(edit, ['port', 'scrollbackLines', 'recentOutputBytes', 'maxRunningSessions', 'maxViews', 'profiles']);
    if (!Array.isArray(edit.profiles) || edit.profiles.length !== current.config.launchProfiles.length)
      throw new Error('SETTINGS_INVALID: Edit the existing core profiles; profile IDs cannot be added or removed here.');
    const originals = current.raw.launchProfiles as Array<Record<string, unknown>>;
    const seen = new Set<unknown>();
    const profiles = edit.profiles.map(value => {
      const profile = object(value); exact(profile, ['id', 'label', 'executable', 'args', 'projectDirectory', 'columns']);
      const original = originals.find(item => item.id === profile.id);
      if (!original || seen.has(profile.id)) throw new Error('SETTINGS_INVALID: Unknown or repeated profile ID.');
      seen.add(profile.id);
      const result = { ...original, ...profile };
      if (profile.columns === null) delete result.columns;
      return result;
    });
    const raw = { ...current.raw, port: edit.port, launchProfiles: profiles,
      terminal: { ...object(current.raw.terminal), scrollbackLines: edit.scrollbackLines, recentOutputBytes: edit.recentOutputBytes },
      capacity: { ...(current.raw.capacity ? object(current.raw.capacity) : {}), maxRunningSessions: edit.maxRunningSessions, maxViews: edit.maxViews } };
    const config = parseConfig(raw, this.file, this.root);
    const text = JSON.stringify(raw, null, 2) + '\n';
    if (Buffer.byteLength(text) > 1024 * 1024) throw new Error('SETTINGS_INVALID: Configuration exceeds 1 MiB.');
    const temporary = path.join(path.dirname(this.file), `.settings-${crypto.randomUUID()}.tmp`);
    let created = false;
    try {
      const fd = fs.openSync(temporary, 'wx', 0o600); created = true;
      try { fs.writeFileSync(fd, text, 'utf8'); fs.fsyncSync(fd); } finally { fs.closeSync(fd); }
      if (revision(fs.readFileSync(this.file, 'utf8')) !== current.revision)
        throw new Error('SETTINGS_CONFLICT: Configuration changed during save. Reload settings.');
      fs.renameSync(temporary, this.file); created = false;
    } finally { if (created) fs.unlinkSync(temporary); }
    return { document: this.project(config, revision(text)), config };
  }
}
