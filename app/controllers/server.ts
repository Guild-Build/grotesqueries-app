import crypto from 'node:crypto';
import { WebSocketServer } from 'ws';
import { createLocalServer, jsonResponse as json } from '../../lib/local-web/server.js';
import { PROTOCOL_VERSION, type Bootstrap, type EffectiveLimits } from '@grotesqueries/protocol';
import type { Config } from '../../config/application.js';
import type { Runtime } from '../helpers/runtime.js';
import type { AssetSource } from '../helpers/assets.js';
import type { DiagnosticLogger } from '../services/diagnostics.js';
import { folderFile, pluginFile, type LoadedPlugins } from '../services/plugins.js';
import { hostPids, readyState, removeReadyFile, writeReadyFile, type ReadyRecord } from '../helpers/ready.js';
import { SessionRegistry } from '../models/sessions.js';
import { ControlLeases } from './control.js';
import { InputDelivery } from './input.js';
import { ViewConnection } from './transport.js';
import type { HostSettings } from '../services/settings.js';

export function createHost(options: { config: Config; runtime: Runtime; assets: AssetSource;
  sessions: SessionRegistry; diagnostics: DiagnosticLogger; hostInstanceId: string; token: string;
  plugins?: Pick<LoadedPlugins, 'summaries' | 'jobs' | 'folders'>;
  settings?: HostSettings;
  ready?: { file: string; refusals: ReadyRecord['refusals'] } }) {
  const { assets, sessions, diagnostics, hostInstanceId, token } = options;
  let config = options.config;
  const pluginProfiles = config.launchProfiles.filter(profile => options.plugins?.summaries.some(plugin =>
    plugin.profiles.includes(profile.id) || plugin.commands.includes(profile.id)));
  const plugins = options.plugins ?? { summaries: [], jobs: new Set<string>(), folders: new Map<string, string>() };
  const origin = `http://127.0.0.1:${config.port}`;
  let limits: EffectiveLimits = { terminal: config.terminal, capacity: config.capacity,
    control: config.control, transport: config.transport };
  const sockets = new WebSocketServer({ noServer: true, maxPayload: limits.transport.maxFrameBytes, perMessageDeflate: false });
  const views = new Map<string, ViewConnection>();
  const control = new ControlLeases({ sessions, hostInstanceId, timeoutMs: config.control.timeoutMs });
  const input = new InputDelivery(sessions, control, limits);
  let heartbeat: ReturnType<typeof setInterval> | undefined;
  function log(event: Parameters<DiagnosticLogger['log']>[0], fields: Record<string, unknown> = {}): void {
    try { diagnostics.log(event, { ...fields, hostInstanceId }); }
    catch { console.error('DIAGNOSTICS_WRITE_FAILED: Check the project log directory and available disk space.'); }
  }
  function validToken(value: string | null): boolean {
    return !!value && value.length === token.length && /^[A-Za-z0-9_-]+$/.test(value) &&
      crypto.timingSafeEqual(Buffer.from(value), Buffer.from(token));
  }
  const local = createLocalServer({ port: config.port, onError: code => log('bridge-error', { code }),
    async handler(request, response, url) {
      if (url.pathname.startsWith('/api/sessions/')) {
        if (request.headers.origin !== origin || !validToken(typeof request.headers['x-automata-token'] === 'string' ? request.headers['x-automata-token'] : null)) {
          json(response, 403, { error: 'An authenticated same-origin request is required.' }); return;
        }
        if (request.method !== 'DELETE') { json(response, 405, { error: 'Method not supported' }); return; }
        try { await sessions.forget(url.pathname.slice('/api/sessions/'.length)); json(response, 200, { forgotten: true }); }
        catch (error) { json(response, 409, { error: error instanceof Error ? error.message : 'Session cannot be forgotten.' }); }
        return;
      }
      if (url.pathname === '/api/settings') {
        if ((request.method !== 'GET' && request.headers.origin !== origin) || !validToken(typeof request.headers['x-automata-token'] === 'string' ? request.headers['x-automata-token'] : null)) {
          json(response, 403, { error: 'Settings require an authenticated same-origin request.' }); return;
        }
        if (!options.settings) { json(response, 503, { error: 'This host has no writable configuration store.' }); return; }
        try {
          if (request.method === 'GET') { json(response, 200, options.settings.get()); return; }
          if (request.method !== 'PUT') { json(response, 405, { error: 'Method not supported' }); return; }
          if (request.headers['content-type']?.split(';')[0] !== 'application/json') { json(response, 415, { error: 'Expected application/json.' }); return; }
          const chunks: Buffer[] = []; let bytes = 0;
          for await (const chunk of request) {
            const data = Buffer.from(chunk); bytes += data.length;
            if (bytes > 262144) { json(response, 413, { error: 'Settings exceed 256 KiB.' }); return; }
            chunks.push(data);
          }
          const saved = options.settings.save(JSON.parse(Buffer.concat(chunks).toString('utf8')));
          // Only the editor's advertised live fields apply. Unrelated operator edits wait for restart.
          config = { ...config, port: saved.config.port, allowedProjectDirectories: saved.config.allowedProjectDirectories,
            launchProfiles: [...saved.config.launchProfiles, ...pluginProfiles],
            terminal: { ...config.terminal, scrollbackLines: saved.config.terminal.scrollbackLines, recentOutputBytes: saved.config.terminal.recentOutputBytes },
            capacity: { ...config.capacity, maxRunningSessions: saved.config.capacity.maxRunningSessions, maxViews: saved.config.capacity.maxViews } };
          sessions.updateConfiguration(config);
          limits = { terminal: config.terminal, capacity: config.capacity, control: config.control, transport: config.transport };
          json(response, 200, saved.document); return;
        } catch (error) {
          const message = error instanceof Error ? error.message : 'Settings could not be saved.';
          json(response, message.startsWith('SETTINGS_CONFLICT:') ? 409 : 400, { error: message }); return;
        }
      }
      if (request.method !== 'GET') { json(response, 405, { error: 'Method not supported' }); return; }
      if (url.pathname === '/health') {
        const replies = sessions.queryAccounting();
        json(response, 200, { ok: true, hostInstanceId, sessions: sessions.list().length, ...(replies.length ? { automaticReplies: replies } : {}) }); return;
      }
      if (url.pathname === '/api/bootstrap') {
        const bootstrap: Bootstrap = { protocol: PROTOCOL_VERSION, hostInstanceId, limits, token, sessions: sessions.list(),
          profiles: config.launchProfiles.map(({ id, label, projectDirectory }) => ({ id, label, projectDirectory,
            kind: plugins.jobs.has(id) ? 'job' : 'interactive' })),
          plugins: plugins.summaries };
        json(response, 200, bootstrap); return;
      }
      try {
        // Requirement 4.2.2: the host's own files first, then the frame folder's under `/`, through K-05's containment.
        const asset = url.pathname.startsWith('/plugins/') ? pluginFile(plugins.folders, url.pathname)
          : assets.get(url.pathname) ?? (config.frame ? folderFile(config.frame, url.pathname.split('/').slice(1)) : undefined);
        if (!asset && url.pathname === '/' && !config.frame) {
          response.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' }); response.end('No frame is configured.\n'); return;
        }
        if (!asset) { json(response, 404, { error: 'Not found' }); return; }
        response.setHeader('Content-Type', asset.contentType);
        response.setHeader('Content-Security-Policy', "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; connect-src 'self'; img-src 'self' data:; object-src 'none'; frame-ancestors 'none'");
        response.end(asset.data);
      } catch { log('bridge-error', { code: 'ASSET_UNAVAILABLE' }); json(response, 500, { error: 'Application assets unavailable. Rebuild and restart.' }); }
  } });
  const { server, trustedRequest, requestURL } = local;
  server.on('upgrade', (request, socket, head) => {
    const url = requestURL(request);
    if (!url) { socket.end('HTTP/1.1 400 Bad Request\r\nConnection: close\r\n\r\n'); return; }
    if (!trustedRequest(request) || request.headers.origin !== origin || url.pathname !== '/api/terminal' || !validToken(url.searchParams.get('token'))) {
      socket.end('HTTP/1.1 403 Forbidden\r\nConnection: close\r\n\r\n'); return;
    }
    if (sockets.clients.size >= limits.capacity.maxViews) { socket.end('HTTP/1.1 503 Service Unavailable\r\nConnection: close\r\n\r\n'); return; }
    sockets.handleUpgrade(request, socket, head, client => {
      let view: ViewConnection | undefined;
      view = new ViewConnection({ socket: client, hostInstanceId, limits, sessions, control, input,
        log: (code, viewId) => log('bridge-error', { code, viewId }),
        closed: () => { if (view) { views.delete(view.id); log('view-detach', { viewId: view.id }); } } });
      if (view.connected) views.set(view.id, view);
      log('view-attach', { viewId: view.id });
    });
  });
  let closing: Promise<void> | undefined;
  let starting: Promise<void> | undefined;
  return {
    origin,
    accounting: () => [...views.values()].map(view => ({ viewId: view.id, ...view.accounting })),
    listen: () => starting ??= (async () => {
        // Requirement 4.2.2: one host per tree. A live host behind the ready file refuses this start; a stale file
        // (no host answering with its instance, a reused pid included) is replaced once this host listens.
        if (options.ready) {
          const found = await readyState(options.ready.file);
          if (found.state === 'live') throw new Error(`HOST_ALREADY_RUNNING: A host is running in this folder (pid ${found.record.pid}, ${found.record.url}). Stop it with node bin/stop.mjs.`);
        }
        try { await local.listen(); }
        catch (error) {
          if ((error as NodeJS.ErrnoException).code === 'EADDRINUSE') throw new Error(`Port ${config.port} is occupied. Choose another port in grotesqueries.json and restart.`);
          throw error;
        }
        heartbeat = setInterval(() => { control.expire(); for (const view of views.values()) view.tick(); }, Math.max(250, Math.floor(config.control.timeoutMs / 4)));
        heartbeat.unref(); log('host-start');
        if (options.ready) writeReadyFile(options.ready.file, { url: origin, pid: process.pid, pids: hostPids(), hostInstanceId,
          plugins: plugins.summaries.map(plugin => plugin.name), refusals: options.ready.refusals });
    })(),
    close: (): Promise<void> => closing ??= (async () => {
      clearInterval(heartbeat); for (const view of [...views.values()]) view.close(1001, 'Host stopping');
      for (const socket of sockets.clients) socket.terminate(); control.dispose();
      let cleanupFailed = false;
      try { await sessions.shutdown(); }
      catch (error) { cleanupFailed = true; throw error; }
      finally {
        if (options.ready) removeReadyFile(options.ready.file, process.pid);
        await new Promise<void>(resolve => sockets.close(() => resolve()));
        await local.close();
        log('host-stop', cleanupFailed ? { code: 'HOST_SHUTDOWN_FAILED' } : {});
      }
    })(),
  };
}
