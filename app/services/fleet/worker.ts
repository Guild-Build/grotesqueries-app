import crypto from 'node:crypto';
import { WebSocket } from 'ws';
import { decodeBootstrap, type Bootstrap } from '@grotesqueries/protocol';
import { FLEET_VERSION, MAX_FRAME, MAX_QUEUE, send, decodeEnvelope, proofText, publicBootstrap, httpRoute, identity } from './contracts.js';

export interface WorkerOptions {
  workerId: string; engineOrigin: string; coordinatorURL: string; privateKey?: string | Buffer;
  caCertificate?: string | Buffer; developmentAccept?: boolean; reconnectMs?: number;
  problem?: (code: string) => void;
}
/** Outbound connector. Every browser channel gets its own native-engine view/socket and lease. */
export function createFleetWorker(options: WorkerOptions) {
  const local = new URL(options.engineOrigin), target = new URL(options.coordinatorURL);
  if (!identity(options.workerId) || local.protocol !== 'http:' || local.hostname !== '127.0.0.1' || local.pathname !== '/') throw new Error('Fleet connector must target its own loopback engine.');
  if (target.pathname !== '/worker' || target.username || target.password || target.search || target.hash || !['ws:', 'wss:'].includes(target.protocol) ||
    target.protocol === 'ws:' && !['127.0.0.1', '[::1]'].includes(target.hostname)) throw new Error('Remote coordinator requires wss and its trusted CA.');
  if (options.developmentAccept && !['127.0.0.1', '[::1]'].includes(target.hostname)) throw new Error('Development accept is loopback-only.');
  if (!options.developmentAccept && (!options.privateKey || crypto.createPrivateKey(options.privateKey).asymmetricKeyType !== 'ed25519')) throw new Error('Worker Ed25519 private key required.');
  let closed = false, outer: WebSocket | undefined, retry: ReturnType<typeof setTimeout> | undefined;
  let reportTimer: ReturnType<typeof setInterval> | undefined, failures = 0, generation = 0;
  const inner = new Map<string, { socket: WebSocket; opening: string[]; bytes: number }>();
  const requests = new Map<string, AbortController>();
  function teardown(): void {
    clearInterval(reportTimer); reportTimer = undefined;
    for (const view of inner.values()) view.socket.terminate(); inner.clear();
    for (const pending of requests.values()) pending.abort(); requests.clear();
  }
  function reconnect(): void {
    if (closed || retry) return;
    retry = setTimeout(() => { retry = undefined; void connect(); }, Math.min(30000, (options.reconnectMs ?? 1000) * 2 ** Math.min(failures++, 5)));
  }
  async function connect(): Promise<void> {
    if (closed) return; const round = ++generation; let bootstrap: Bootstrap;
    try {
      const response = await fetch(local.origin + '/api/bootstrap', { signal: AbortSignal.timeout(5000) });
      if (!response.ok) throw new Error('LOCAL_ENGINE_UNAVAILABLE'); bootstrap = decodeBootstrap(await response.json());
    } catch { options.problem?.('LOCAL_ENGINE_UNAVAILABLE'); reconnect(); return; }
    if (closed || round !== generation) return;
    const socket = outer = new WebSocket(target, { maxPayload: MAX_FRAME, perMessageDeflate: false, followRedirects: false,
      handshakeTimeout: 5000, ...(options.caCertificate ? { ca: options.caCertificate } : {}) });
    let admitted = false; const handshake = setTimeout(() => socket.close(1008, 'Handshake timeout'), 7000);
    // TCP can remain open through a partition while our loopback views auto-pong forever.
    // Coordinator pings every 5s; missing three intervals fences all downstream leases.
    let watchdog: ReturnType<typeof setTimeout> | undefined;
    const heartbeat = () => { clearTimeout(watchdog); watchdog = setTimeout(() => socket.terminate(), 15000); };
    socket.on('ping', heartbeat);
    socket.on('open', () => { heartbeat(); try { send(socket, { type: 'join', version: FLEET_VERSION, workerId: options.workerId, instanceId: bootstrap.hostInstanceId }); } catch { socket.close(); } });
    socket.on('error', () => options.problem?.('FLEET_CONNECTION_FAILED'));
    socket.on('close', () => { clearTimeout(handshake); clearTimeout(watchdog); if (round !== generation) return; teardown(); options.problem?.('FLEET_DISCONNECTED'); reconnect(); });
    async function report(): Promise<void> {
      try {
        const response = await fetch(local.origin + '/api/bootstrap', { signal: AbortSignal.timeout(5000) });
        if (!response.ok) throw new Error('LOCAL_ENGINE_UNAVAILABLE'); const next = decodeBootstrap(await response.json());
        if (closed || round !== generation || socket.readyState !== WebSocket.OPEN) return;
        if (next.hostInstanceId !== bootstrap.hostInstanceId) throw new Error('LOCAL_ENGINE_CHANGED');
        bootstrap = next; send(socket, { type: 'inventory', bootstrap: publicBootstrap(next) });
      } catch { socket.close(1012, 'Local engine unavailable'); }
    }
    socket.on('message', raw => {
      try {
        const message = decodeEnvelope(raw.toString());
        if (!admitted) {
          if (message.type === 'challenge') {
            const signature = options.developmentAccept ? '' : crypto.sign(null, proofText(message.nonce, options.workerId, bootstrap.hostInstanceId), options.privateKey!).toString('base64');
            send(socket, { type: 'proof', signature }); return;
          }
          if (message.type !== 'accepted') throw new Error('FLEET_NOT_ADMITTED');
          admitted = true; failures = 0; clearTimeout(handshake); void report();
          reportTimer = setInterval(() => { void report(); }, 2000); return;
        }
        if (message.type === 'open') {
          if (message.instanceId !== bootstrap.hostInstanceId || inner.has(message.channelId) || inner.size >= 64) throw new Error('FLEET_STALE_CHANNEL');
          const view = new WebSocket(local.origin.replace('http:', 'ws:') + '/api/terminal?token=' + encodeURIComponent(bootstrap.token), {
            origin: local.origin, maxPayload: 1048576, perMessageDeflate: false, handshakeTimeout: 5000 });
          const channel = { socket: view, opening: [] as string[], bytes: 0 }; inner.set(message.channelId, channel);
          view.on('open', () => {
            for (const frame of channel.opening) view.send(frame);
            channel.opening = []; channel.bytes = 0;
          });
          view.on('message', data => { try { send(socket, { type: 'frame', channelId: message.channelId, data: data.toString() }); } catch { view.close(); } });
          view.on('error', () => view.close());
          view.on('close', () => { if (inner.get(message.channelId) !== channel) return; inner.delete(message.channelId); try { send(socket, { type: 'close', channelId: message.channelId }); } catch { /* Outer loss already tears down views. */ } });
        } else if (message.type === 'frame') {
          const channel = inner.get(message.channelId); if (!channel) return;
          const view = channel.socket;
          if (view.readyState === WebSocket.CONNECTING) {
            channel.bytes += Buffer.byteLength(message.data);
            if (channel.bytes > 1048576 || channel.opening.length >= 128) { view.close(); return; }
            channel.opening.push(message.data); return;
          }
          if (view.readyState !== WebSocket.OPEN || view.bufferedAmount + Buffer.byteLength(message.data) > MAX_QUEUE) { view.close(1013, 'Worker view unavailable'); return; }
          view.send(message.data);
        } else if (message.type === 'close') { inner.get(message.channelId)?.socket.close(); }
        else if (message.type === 'request') {
          if (message.instanceId !== bootstrap.hostInstanceId || !httpRoute(message.method, message.path) || requests.size >= 32 || requests.has(message.requestId)) throw new Error('FLEET_INVALID_REQUEST');
          const controller = new AbortController(); requests.set(message.requestId, controller);
          const timeout = setTimeout(() => controller.abort(), 8000);
          void (async () => {
            try {
              const response = await fetch(local.origin + message.path, { method: message.method, signal: controller.signal, redirect: 'error',
                headers: { origin: local.origin, 'x-automata-token': bootstrap.token, ...(message.method === 'PUT' ? { 'content-type': 'application/json' } : {}) },
                ...(message.method === 'PUT' ? { body: message.body } : {}) });
              let body = await response.text();
              if (Buffer.byteLength(body) > 1048576) throw new Error('FLEET_RESPONSE_LIMIT');
              if (message.path === '/api/bootstrap' && response.ok) body = JSON.stringify(publicBootstrap(JSON.parse(body)));
              if (!closed && round === generation) send(socket, { type: 'response', requestId: message.requestId, status: response.status, body });
            } catch {
              try { send(socket, { type: 'response', requestId: message.requestId, status: 503, body: JSON.stringify({ error: 'Worker request outcome unknown. Inspect current state before retrying.' }) }); } catch { /* Coordinator records uncertainty when the channel drops. */ }
            } finally { clearTimeout(timeout); requests.delete(message.requestId); }
          })();
        } else throw new Error('FLEET_UNEXPECTED_MESSAGE');
      } catch { socket.close(1008, 'Fleet protocol failure'); }
    });
  }
  void connect();
  return { async close(): Promise<void> {
    closed = true; generation++; clearTimeout(retry); teardown();
    if (!outer || outer.readyState === WebSocket.CLOSED) return;
    const socket = outer; await new Promise<void>(resolve => { socket.once('close', resolve); socket.terminate(); });
  } };
}
