import path from 'node:path';
import { resolveRuntime as resolveLocalRuntime, createChildEnvironment as childEnvironment } from '../../lib/local-web/runtime.js';
export { assertManagedPath, isWithin, posixWindowsPath, managedDirectory, type Runtime } from '../../lib/local-web/runtime.js';

/**
 * Requirement 1.3, G2: a relative configuration path (GROTESQUERIES_CONFIG) resolves against the caller's working
 * directory, then meets the same containment check as an absolute one. An empty value stays refused.
 */
export function resolveRuntime(options: { sourceEntry?: string; executable?: string; configFile?: string }) {
  const configFile = options.configFile && !(process.platform !== 'win32' && (/^[A-Z]:/i.test(options.configFile) || options.configFile.startsWith('//')))
    ? path.resolve(options.configFile) : options.configFile;
  return resolveLocalRuntime({ ...options, configFile, configName: 'grotesqueries.json' });
}

export function createChildEnvironment(root: string, sessionId: string,
  inherited: Record<string, string | undefined> = process.env, overrides: Record<string, string> = {}) {
  return childEnvironment(root, sessionId, inherited, overrides, { TERM: 'xterm-256color', COLORTERM: 'truecolor' });
}
