/** Browser-only preferences, deliberately separate from host configuration and input records. */
export interface Preferences {
  version: 2; sessions: boolean; panel: boolean; leftWidth: number; rightWidth: number; screenReader: boolean;
  clickToControl: boolean; releaseShortcut: 'escape' | 'ctrl-alt-g' | 'none';
}
export const PREFERENCES_KEY = 'gq.layout.v2';
export const DEFAULT_PREFERENCES: Readonly<Preferences> = Object.freeze({
  version: 2, sessions: true, panel: true, leftWidth: 17, rightWidth: 18, screenReader: false,
  clickToControl: true, releaseShortcut: 'escape',
});
export function panelWidth(value: unknown, fallback: number): number {
  return typeof value === 'number' && Number.isFinite(value) ? Math.max(3, Math.min(40, Math.round(value * 10) / 10)) : fallback;
}
export function readPreferences(raw: string | null): Preferences {
  const defaults = { ...DEFAULT_PREFERENCES };
  try {
    const value: unknown = JSON.parse(raw ?? 'null');
    if (!value || typeof value !== 'object' || Array.isArray(value) || !('version' in value) || value.version !== 2) return defaults;
    const saved = value as Record<string, unknown>;
    return { version: 2,
      sessions: typeof saved.sessions === 'boolean' ? saved.sessions : defaults.sessions,
      panel: typeof saved.panel === 'boolean' ? saved.panel : defaults.panel,
      screenReader: typeof saved.screenReader === 'boolean' ? saved.screenReader : defaults.screenReader,
      clickToControl: typeof saved.clickToControl === 'boolean' ? saved.clickToControl : defaults.clickToControl,
      releaseShortcut: saved.releaseShortcut === 'escape' || saved.releaseShortcut === 'ctrl-alt-g' || saved.releaseShortcut === 'none'
        ? saved.releaseShortcut : defaults.releaseShortcut,
      leftWidth: panelWidth(saved.leftWidth, defaults.leftWidth), rightWidth: panelWidth(saved.rightWidth, defaults.rightWidth) };
  } catch { return defaults; }
}
export function writePreferences(value: Preferences): string {
  // Read through the same allowlist: neither future fields nor other browser/host state are persisted.
  return JSON.stringify(readPreferences(JSON.stringify(value)));
}
