import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { createHost } from '../app/controllers/server.js';
import { resolveRuntime, managedDirectory, posixWindowsPath } from '../app/helpers/runtime.js';
import { loadConfig } from './application.js';
import { diskAssets } from '../app/helpers/assets.js';
import { DiagnosticLogger } from '../app/services/diagnostics.js';
import { SessionRegistry } from '../app/models/sessions.js';
import { NodePtyLauncher } from '../app/services/node-pty.js';
import { loadPlugins } from '../app/services/plugins.js';
import { reportStartupFailure } from '../app/helpers/startup.js';
import { readyFilePath } from '../app/helpers/ready.js';
import { HostSettings } from '../app/services/settings.js';
import { composeHost } from './composition.js';
import { loadGuildBuild } from '../app/services/guild-build.js';

async function main(): Promise<void> {
  const runtime = resolveRuntime({ sourceEntry: fileURLToPath(import.meta.url), configFile: process.env.GROTESQUERIES_CONFIG });
  const temporary = managedDirectory(runtime.root, runtime.temporary);
  process.env.TEMP = process.env.TMP = temporary;
  process.env.TMPDIR = process.platform === 'win32' ? posixWindowsPath(temporary) : temporary;
  const operatorConfig = loadConfig(runtime.configFile, runtime.root);
  const diagnostics = new DiagnosticLogger(runtime.root, operatorConfig.diagnostics);
  // Plugins live in <application root>/plugins; their profiles join the configured ones for this process only.
  const plugins = loadPlugins(path.join(runtime.root, 'plugins'), operatorConfig, diagnostics);
  const guild = loadGuildBuild(runtime.root, { ...operatorConfig, launchProfiles: [...operatorConfig.launchProfiles, ...plugins.profiles] });
  const config = guild.config;
  const assets = diskAssets(runtime.root);
  const host = composeHost({ config, runtime, assets, engine: () => createHost({ config, runtime, assets,
    sessions: new SessionRegistry({ config, launcher: new NodePtyLauncher(runtime.root), diagnostics, jobs: plugins.jobs }), diagnostics, plugins,
    settings: new HostSettings(runtime.configFile, runtime.root, config.port), guildBuild: guild.state,
    hostInstanceId: crypto.randomUUID(), token: crypto.randomBytes(32).toString('base64url'),
    ...(config.fleet?.coordinator ? {} : { ready: { file: readyFilePath(runtime.root), refusals: plugins.refused } }) }) });
  // The ready file can become visible during listen; graceful shutdown must already be installed.
  const stop = () => { void host.close().catch(() => { console.error('HOST_SHUTDOWN_FAILED'); process.exitCode = 1; }); };
  process.once('SIGINT', stop);
  process.once('SIGTERM', stop);
  await host.listen();
  console.log(JSON.stringify({ ready: true, url: host.origin, sessions: 0,
    plugins: plugins.summaries.map(plugin => plugin.name), refusedPlugins: plugins.refused }));
}
void main().catch(async error => { process.exitCode = 1;
  await reportStartupFailure(error, path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..')); });
