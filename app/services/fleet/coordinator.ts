import http from 'node:http';
import https from 'node:https';
import crypto from 'node:crypto';
import { WebSocket, WebSocketServer } from 'ws';
import { createLocalServer, jsonResponse as json } from '../../../lib/local-web/server.js';
import type { AssetSource } from '../../helpers/assets.js';
import { folderFile } from '../plugins.js';
import { FleetRegistry } from './registry.js';
import { MAX_FRAME, MAX_QUEUE, decodeEnvelope, send, proofText, httpRoute, actionForFrame, publicBootstrap, uuid,
  type Admission, type PublicBootstrap } from './contracts.js';

interface Worker {
  socket: WebSocket; admission: Admission; instanceId: string; bootstrap?: PublicBootstrap;
  channels: Map<string, WebSocket>;
  requests: Map<string, { finish: (status: number, body: string) => void; fail: () => void; timer: ReturnType<typeof setTimeout> }>;
}
export interface CoordinatorOptions {
  root: string; webPort: number; transportPort: number; transportHost?: string;
  stateFile: string; workers: readonly Admission[]; developmentAccept?: boolean;
  tls?: { certificate: string | Buffer; privateKey: string | Buffer };
  assets?: AssetSource; frame?: string;
}
export function createFleetCoordinator(options: CoordinatorOptions) {
  const bind = options.transportHost ?? '127.0.0.1'; const loopback = ['127.0.0.1', '::1'].includes(bind);
  if (!loopback && (!options.tls || options.developmentAccept)) throw new Error('Remote fleet channels require TLS and public-key admission; development accept is loopback-only.');
  // Validate TLS before opening SQLite; failed construction must not leave its file locked.
  const listener = options.tls ? https.createServer({ cert: options.tls.certificate, key: options.tls.privateKey }, (_req, response) => { response.writeHead(404); response.end(); })
    : http.createServer((_req, response) => { response.writeHead(404); response.end(); });
  const registry = new FleetRegistry(options.root, options.stateFile, options.workers, !!options.developmentAccept);
  const token = crypto.randomBytes(32).toString('base64url'); const instanceId = crypto.randomUUID();
  const origin = `http://127.0.0.1:${options.webPort}`;
  const workers = new Map<string, Worker>(); const last = new Map<string, PublicBootstrap>();
  const browserSockets = new WebSocketServer({ noServer: true, maxPayload: 1048576, perMessageDeflate: false });
  const workerSockets = new WebSocketServer({ noServer: true, maxPayload: MAX_FRAME, perMessageDeflate: false });
  const validToken = (value: unknown) => typeof value === 'string' && value.length === token.length && /^[a-zA-Z0-9_-]+$/.test(value) && crypto.timingSafeEqual(Buffer.from(value), Buffer.from(token));
  function resolve(path: string): { worker: Worker; suffix: string } {
    const match = /^\/fleet\/([a-zA-Z0-9_-]{1,64})\/([a-f0-9-]{36})(\/.*)$/.exec(path);
    if (!match || !uuid(match[2])) throw new Error('FLEET_UNKNOWN_ROUTE');
    const worker = workers.get(match[1]);
    if (!worker?.bootstrap) throw new Error('FLEET_WORKER_UNAVAILABLE');
    if (worker.instanceId !== match[2]) throw new Error('FLEET_STALE_INSTANCE');
    return { worker, suffix: match[3] };
  }
  async function request(worker: Worker, method: 'GET' | 'PUT' | 'DELETE', path: string, body: string): Promise<{ status: number; body: string }> {
    if (worker.requests.size >= 32) throw new Error('FLEET_REQUEST_CAPACITY');
    const requestId = crypto.randomUUID();
    return new Promise((resolve, reject) => {
      const fail = () => { clearTimeout(timer); worker.requests.delete(requestId); reject(new Error('FLEET_RESULT_UNKNOWN: Worker response lost. Inspect current state; do not automatically repeat the action.')); };
      const timer = setTimeout(fail, 10000);
      worker.requests.set(requestId, { timer, fail, finish: (status, body) => { clearTimeout(timer); worker.requests.delete(requestId); resolve({ status, body }); } });
      try { send(worker.socket, { type: 'request', requestId, instanceId: worker.instanceId, method, path, body }); } catch { fail(); }
    });
  }
  const local = createLocalServer({ port: options.webPort, async handler(req, response, url) {
    if (req.method === 'GET' && url.pathname === '/api/fleet') {
      json(response, 200, { mode: 'fleet', instanceId, token, developmentAccept: !!options.developmentAccept,
        hosts: registry.list().map(row => ({ ...row, online: !!workers.get(row.id)?.bootstrap,
          route: row.instanceId ? `/fleet/${row.id}/${row.instanceId}` : null,
          sessions: (workers.get(row.id)?.bootstrap ?? last.get(row.id))?.sessions ?? [],
          actions: registry.admissions.get(row.id)!.actions,
          nativeHarness: { available: false, reason: 'to be implemented — native harness adapter' },
          radio: { available: false, reason: 'to be implemented — external owner Radio' } })) }); return;
    }
    if (url.pathname.startsWith('/fleet/')) {
      try {
        const { worker, suffix } = resolve(url.pathname); const method = req.method ?? '';
        const action = httpRoute(method, suffix); if (!action || !worker.admission.actions!.includes(action)) { json(response, 403, { error: 'FLEET_FORBIDDEN' }); return; }
        if (suffix !== '/api/bootstrap' && (!validToken(req.headers['x-automata-token']) || method !== 'GET' && req.headers.origin !== origin)) { json(response, 403, { error: 'FLEET_UNAUTHORIZED' }); return; }
        if (method === 'PUT' && req.headers['content-type']?.split(';')[0] !== 'application/json') { json(response, 415, { error: 'Expected application/json.' }); return; }
        const parts: Buffer[] = []; let size = 0;
        for await (const chunk of req) { const part = Buffer.from(chunk); size += part.length; if (size > 262144) { json(response, 413, { error: 'FLEET_BODY_LIMIT' }); return; } parts.push(part); }
        const result = await request(worker, method as 'GET' | 'PUT' | 'DELETE', suffix, Buffer.concat(parts).toString('utf8'));
        const body = JSON.parse(result.body);
        if (suffix === '/api/bootstrap' && result.status === 200) body.token = token;
        json(response, result.status, body);
      } catch (error) { const message = (error as Error).message; json(response, message.startsWith('FLEET_STALE_INSTANCE') ? 409 : 503, { error: message }); }
      return;
    }
    if (req.method !== 'GET') { json(response, 405, { error: 'Method not supported.' }); return; }
    if (url.pathname === '/health') { json(response, 200, { ok: true, hostInstanceId: instanceId, workers: workers.size }); return; }
    const asset = options.assets?.get(url.pathname) ?? (options.frame ? folderFile(options.frame, url.pathname.split('/').slice(1)) : undefined);
    if (!asset) { json(response, 404, { error: 'Not found' }); return; }
    response.setHeader('Content-Type', asset.contentType);
    response.setHeader('Content-Security-Policy', "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; connect-src 'self'; img-src 'self' data:; object-src 'none'; frame-ancestors 'none'"); response.end(asset.data);
  } });
  local.server.on('upgrade', (req, socket, head) => {
    try {
      const url = local.requestURL(req);
      if (!url || !local.trustedRequest(req) || req.headers.origin !== origin || !validToken(url.searchParams.get('token'))) throw new Error('FLEET_UNAUTHORIZED');
      const { worker, suffix } = resolve(url.pathname);
      if (suffix !== '/api/terminal' || !worker.admission.actions!.includes('observe') || worker.channels.size >= 64) throw new Error('FLEET_FORBIDDEN');
      browserSockets.handleUpgrade(req, socket, head, browser => {
        const channelId = crypto.randomUUID(); worker.channels.set(channelId, browser);
        // The downstream loopback socket can answer the engine's pings even when a browser dies.
        // Independently fence that browser, otherwise its relayed lease could live indefinitely.
        let alive = true;
        const heartbeat = setInterval(() => {
          if (!alive) browser.terminate();
          else { alive = false; browser.ping(); }
        }, Math.max(500, Math.floor(worker.bootstrap!.limits.control.timeoutMs / 2)));
        browser.on('pong', () => { alive = true; });
        const close = () => {
          clearInterval(heartbeat); if (!worker.channels.delete(channelId)) return;
          try { send(worker.socket, { type: 'close', channelId }); }
          catch { worker.socket.terminate(); } // Failed close cannot leave an orphaned downstream lease alive; fence views, not PTYs.
        };
        browser.on('close', close); browser.on('error', () => browser.close());
        browser.on('message', raw => {
          try {
            const data = raw.toString();
            if (!worker.admission.actions!.includes(actionForFrame(data))) {
              const value = JSON.parse(data) as Record<string, unknown>;
              browser.send(JSON.stringify({ type: 'error', code: 'FLEET_FORBIDDEN', message: 'This host action is not permitted.',
                ...(Number.isSafeInteger(value.requestId) ? { requestId: value.requestId } : {}) })); return;
            }
            send(worker.socket, { type: 'frame', channelId, data });
          } catch { browser.close(1008, 'Fleet route unavailable or capacity exceeded'); }
        });
        try { send(worker.socket, { type: 'open', channelId, instanceId: worker.instanceId }); }
        catch { browser.close(1013, 'Worker unavailable'); }
      });
    } catch { socket.end('HTTP/1.1 403 Forbidden\r\nConnection: close\r\n\r\n'); }
  });
  listener.on('upgrade', (req, socket, head) => {
    if (req.url !== '/worker' || workerSockets.clients.size >= 64) { socket.end('HTTP/1.1 403 Forbidden\r\nConnection: close\r\n\r\n'); return; }
    workerSockets.handleUpgrade(req, socket, head, channel => {
      let worker: Worker | undefined; let candidate: { admission: Admission; instanceId: string; nonce: string } | undefined;
      const timer = setTimeout(() => channel.close(1008, 'Handshake timeout'), 5000); let alive = true;
      channel.on('pong', () => { alive = true; });
      const heartbeat = setInterval(() => { if (!alive) channel.terminate(); else { alive = false; channel.ping(); } }, 5000);
      channel.on('error', () => channel.close());
      channel.on('close', () => {
        clearTimeout(timer); clearInterval(heartbeat);
        if (!worker) return;
        if (workers.get(worker.admission.id) === worker) workers.delete(worker.admission.id);
        for (const browser of worker.channels.values()) browser.close(1012, 'Worker disconnected; reconnect observes, no action replay');
        for (const pending of [...worker.requests.values()]) pending.fail();
      });
      channel.on('message', raw => {
        try {
          const message = decodeEnvelope(raw.toString());
          if (!worker) {
            if (message.type === 'join' && !candidate) {
              const admission = registry.admissions.get(message.workerId);
              if (!admission || workers.has(message.workerId)) throw new Error('FLEET_NOT_ADMITTED');
              candidate = { admission, instanceId: message.instanceId, nonce: crypto.randomBytes(32).toString('hex') };
              send(channel, { type: 'challenge', nonce: candidate.nonce }); return;
            }
            if (message.type !== 'proof' || !candidate || workers.has(candidate.admission.id)) throw new Error('FLEET_INVALID_HANDSHAKE');
            if (!options.developmentAccept && !crypto.verify(null, proofText(candidate.nonce, candidate.admission.id, candidate.instanceId), candidate.admission.publicKey!, Buffer.from(message.signature, 'base64'))) throw new Error('FLEET_BAD_PROOF');
            worker = { socket: channel, admission: candidate.admission, instanceId: candidate.instanceId, channels: new Map(), requests: new Map() };
            workers.set(candidate.admission.id, worker); registry.seen(candidate.admission.id, worker.instanceId);
            clearTimeout(timer); send(channel, { type: 'accepted' }); return;
          }
          switch (message.type) {
            case 'inventory': {
              const boot = publicBootstrap({ ...message.bootstrap, token: 'validation-only-not-a-credential' });
              if (boot.hostInstanceId !== worker.instanceId) throw new Error('FLEET_INSTANCE_CHANGED');
              worker.bootstrap = boot; last.set(worker.admission.id, boot); registry.seen(worker.admission.id, worker.instanceId); break;
            }
            case 'frame': {
              const browser = worker.channels.get(message.channelId); if (!browser) return;
              if (browser.readyState !== WebSocket.OPEN || browser.bufferedAmount + Buffer.byteLength(message.data) > MAX_QUEUE) { browser.close(1013, 'Slow fleet view'); return; }
              browser.send(message.data); break;
            }
            case 'close': worker.channels.get(message.channelId)?.close(1012, 'Worker view closed'); break;
            case 'response': worker.requests.get(message.requestId)?.finish(message.status, message.body); break;
            default: throw new Error('FLEET_UNEXPECTED_MESSAGE');
          }
        } catch { channel.close(1008, 'Fleet protocol or admission failed'); }
      });
    });
  });
  let closing: Promise<void> | undefined;
  return { origin, instanceId, workerURL: `${options.tls ? 'wss' : 'ws'}://${bind === '::1' ? '[::1]' : bind}:${options.transportPort}/worker`,
    async listen(): Promise<void> {
      await local.listen();
      try { await new Promise<void>((resolve, reject) => { listener.once('error', reject); listener.listen(options.transportPort, bind, resolve); }); }
      catch (error) { await local.close(); throw error; }
    },
    close(): Promise<void> { return closing ??= (async () => {
      for (const socket of browserSockets.clients) socket.terminate(); for (const socket of workerSockets.clients) socket.terminate();
      await new Promise<void>(resolve => browserSockets.close(() => resolve())); await new Promise<void>(resolve => workerSockets.close(() => resolve()));
      await local.close(); await new Promise<void>(resolve => listener.close(() => resolve())); registry.close();
    })(); },
  };
}
