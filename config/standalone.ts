import path from 'node:path';
import crypto from 'node:crypto';
import { getAsset, getAssetKeys } from 'node:sea';
import { resolveRuntime, managedDirectory, posixWindowsPath, type Runtime } from '../app/helpers/runtime.js';
import { loadConfig, type Config } from './application.js';
import { embeddedAssets, frameRoutes } from '../app/helpers/assets.js';
import { dispatchConsoleHelper, extractNativePayload, type NativeManifest } from '../app/services/native-payload.js';
import { createHost } from '../app/controllers/server.js';
import { SessionRegistry } from '../app/models/sessions.js';
import { DiagnosticLogger } from '../app/services/diagnostics.js';
import { NodePtyLauncher } from '../app/services/node-pty.js';
import { reportStartupFailure } from '../app/helpers/startup.js';
import { readyFilePath } from '../app/helpers/ready.js';
import { configureInstallation } from '../app/services/setup.js';
import { HostSettings } from '../app/services/settings.js';
import { composeHost } from './composition.js';
import { loadGuildBuild } from '../app/services/guild-build.js';

export async function runSea(probe?: (context: { runtime: Runtime; config: Config; payload: string;
  origin: string }) => Promise<void>): Promise<void> {
  // Helpers never load operator config or construct another host.
  const root = path.dirname(process.execPath);
  const manifest = JSON.parse(getAsset('native-manifest.json', 'utf8')) as NativeManifest;
  if (dispatchConsoleHelper(root, manifest)) return;
  if (process.argv.length === 3 && process.argv[2] === '--setup') {
    configureInstallation(resolveRuntime({ executable: process.execPath }).root);
    return;
  }
  if (process.argv.length !== 2) throw new Error('UNSUPPORTED_ARGUMENTS: Configure this host using adjacent grotesqueries.json.');
  const runtime = resolveRuntime({ executable: process.execPath });
  const temporary = managedDirectory(runtime.root, runtime.temporary);
  process.env.TEMP = process.env.TMP = temporary;
  process.env.TMPDIR = posixWindowsPath(temporary);
  const guild = loadGuildBuild(runtime.root, loadConfig(runtime.configFile, runtime.root));
  const config = guild.config;
  const payload = extractNativePayload(root, manifest, name => new Uint8Array(getAsset(`native/${name}`)));
  // Requirement 4.2.2: the frame's files when the EXE was packaged with them; a `frame` beside the EXE wins over them.
  const frameFiles = Object.values(frameRoutes).map(({ file }) => file).filter(file => getAssetKeys().includes(`web/${file}`));
  const assets = embeddedAssets(Object.fromEntries(['licenses.txt', 'grotesqueries.schema.json', 'version.json', ...frameFiles]
    .map(name => [name, new Uint8Array(getAsset(`web/${name}`))])), config.frame);
  const diagnostics = new DiagnosticLogger(root, config.diagnostics);
  const host = composeHost({ config, runtime, assets, engine: () => createHost({ config, runtime, assets,
    sessions: new SessionRegistry({ config, launcher: new NodePtyLauncher(root, payload), diagnostics }),
    settings: new HostSettings(runtime.configFile, runtime.root, config.port), guildBuild: guild.state,
    diagnostics, hostInstanceId: crypto.randomUUID(),
    token: crypto.randomBytes(32).toString('base64url'),
    ...(config.fleet?.coordinator ? {} : { ready: { file: readyFilePath(runtime.root), refusals: [] } }) }) });
  await host.listen();
  console.log(JSON.stringify({ ready: true, url: host.origin, sessions: 0 }));
  if (probe) { try { await probe({ runtime, config, payload, origin: host.origin }); } finally { await host.close(); } }
  else {
    const stop = () => { void host.close().catch(() => { console.error('HOST_SHUTDOWN_FAILED'); process.exitCode = 1; }); };
    process.once('SIGINT', stop); process.once('SIGTERM', stop);
  }
}

// A separate probe entry invokes runSea with its own explicit fixture runner.
declare const GROTESQUERIES_PROBE: boolean;
if (!GROTESQUERIES_PROBE) void runSea().catch(async error => { process.exitCode = 1;
  await reportStartupFailure(error, path.dirname(process.execPath)); });
