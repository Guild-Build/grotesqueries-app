import fs from 'node:fs';
import type { Config } from './application.js';
import type { Runtime } from '../app/helpers/runtime.js';
import type { AssetSource } from '../app/helpers/assets.js';
import { readyFilePath, readyState, writeReadyFile, removeReadyFile, hostPids } from '../app/helpers/ready.js';
import { createFleetCoordinator } from '../app/services/fleet/coordinator.js';
import { createFleetWorker } from '../app/services/fleet/worker.js';

/** Same executable, configured roles. Network loss never invokes engine shutdown. */
export function composeHost(options: { config: Config; runtime: Runtime; assets: AssetSource;
  engine: () => { origin: string; listen(): Promise<void>; close(): Promise<void> } }) {
  const { config, runtime } = options, fleet = config.fleet;
  const read = (file?: string) => file ? fs.readFileSync(file) : undefined;
  const c = fleet?.coordinator;
  const makeCoordinator = () => c ? createFleetCoordinator({ root: runtime.root, webPort: c.port, transportPort: c.workerPort,
    transportHost: c.workerBind, stateFile: c.stateFile, developmentAccept: c.developmentAccept,
    workers: c.workers.map(w => ({ id: w.id, label: w.label, actions: w.actions, publicKey: read(w.publicKeyFile)?.toString('utf8') })),
    ...(c.certificateFile ? { tls: { certificate: read(c.certificateFile)!, privateKey: read(c.privateKeyFile)! } } : {}),
    assets: options.assets, frame: config.frame }) : undefined;
  let engine: ReturnType<typeof options.engine> | undefined;
  let coordinator: ReturnType<typeof createFleetCoordinator> | undefined;
  let listening: Promise<void> | undefined;
  let worker: ReturnType<typeof createFleetWorker> | undefined; let closing: Promise<void> | undefined;
  const ready = readyFilePath(runtime.root);
  return { origin: `http://127.0.0.1:${c?.port ?? config.port}`,
    listen(): Promise<void> {
      if (closing) return Promise.reject(new Error('HOST_SERVER_CLOSED'));
      return listening ??= (async () => {
      try {
        if (c && (await readyState(ready)).state === 'live') throw new Error('HOST_ALREADY_RUNNING: Stop the existing application before starting another role composition in this folder.');
        coordinator = makeCoordinator();
        if (!fleet || fleet.worker) engine = options.engine();
        await coordinator?.listen(); await engine?.listen();
        if (fleet?.worker) {
          const w = fleet.worker;
          worker = createFleetWorker({ workerId: w.id, engineOrigin: engine!.origin, coordinatorURL: w.coordinatorURL,
            developmentAccept: w.developmentAccept, privateKey: read(w.privateKeyFile), caCertificate: read(w.caFile),
            problem: code => console.error(code) });
        }
        if (coordinator) writeReadyFile(ready, { url: coordinator.origin, hostInstanceId: coordinator.instanceId,
          pid: process.pid, pids: hostPids(), plugins: [], refusals: [] });
      } catch (error) { await worker?.close(); await engine?.close(); await coordinator?.close(); throw error; }
      })();
    },
    close(): Promise<void> { return closing ??= (async () => {
      if (listening) { try { await listening; } catch { /* Failed startup already closed its owned components. */ } }
      await worker?.close(); await coordinator?.close(); await engine?.close();
      if (coordinator) removeReadyFile(ready, process.pid);
    })(); },
  };
}
