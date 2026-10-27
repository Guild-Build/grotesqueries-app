import crypto from 'node:crypto';
import net from 'node:net';
import path from 'node:path';
import { WebSocket } from 'ws';
import { Terminal } from '@xterm/headless';
import { Unicode11Addon } from '@xterm/addon-unicode11';
import { DEFAULT_LIMITS, PROTOCOL_VERSION, decodeServerMessage, utf8Bytes, type ServerMessage } from '@grotesqueries/protocol';
import { createHost } from '../../app/controllers/server.js';
import { resolveRuntime } from '../../app/helpers/runtime.js';
import { embeddedAssets } from '../../app/helpers/assets.js';
import { DiagnosticLogger } from '../../app/services/diagnostics.js';
import { SessionRegistry } from '../../app/models/sessions.js';
import { FakeLauncher, fixtureConfig } from './helpers.js';
import type { Config } from '../../config/application.js';
import { installSnapshotState } from '../../lib/protocol/src/terminal-state-adapter.js';
import { installRendererReplySuppression } from './renderer-replies.js';
import { scratchDirectory } from './scratch.js';
import type { HostSettings } from '../../app/services/settings.js';

export async function bridgeFixture(modify?: (config: Config) => void, settings?: (config: Config) => HostSettings) {
  const reservation = net.createServer(); await new Promise<void>(resolve => reservation.listen(0, '127.0.0.1', resolve));
  const port = (reservation.address() as net.AddressInfo).port; await new Promise<void>(resolve => reservation.close(() => resolve()));
  const config = fixtureConfig(); config.port = port;
  modify?.(config);
  const launcher = new FakeLauncher(); const sessions = new SessionRegistry({ config, launcher });
  const runtime = resolveRuntime({ sourceEntry: path.join(process.cwd(), 'dist/host/server.js') });
  const hostInstanceId = crypto.randomUUID(); const token = crypto.randomBytes(32).toString('base64url');
  const host = createHost({ config, runtime, sessions, hostInstanceId, token,
    settings: settings?.(config),
    assets: embeddedAssets({ 'index.html': Buffer.from('fixture'), 'assets/app.js': Buffer.from(''), 'assets/app.css': Buffer.from('') }),
    diagnostics: new DiagnosticLogger(runtime.root, { ...config.diagnostics, directory: path.join(scratchDirectory('bridge-test-logs-', runtime.root), 'logs') }) });
  await host.listen(); return { host, config, launcher, sessions, hostInstanceId, token,
    peer: async (render = true) => Peer.open(host.origin, token, hostInstanceId, render) };
}
export class Peer {
  readonly messages: ServerMessage[] = [];
  private readonly waiters = new Set<() => void>();
  private requestId = 0; private queue = Promise.resolve();
  private terminal?: Terminal;
  private adapter?: ReturnType<typeof installSnapshotState>;
  private suppressed?: () => void;
  private snapshotId?: string; private sequence = 0; private parsed = 0;
  constructor(readonly socket: WebSocket, private readonly render: boolean) {
    socket.on('message', raw => {
      const message = decodeServerMessage(JSON.parse(raw.toString()), DEFAULT_LIMITS); this.messages.push(message);
      for (const notify of this.waiters) notify();
      if (this.render) this.queue = this.queue.then(() => this.apply(message));
    });
  }
  static async open(origin: string, token: string, hostInstanceId: string, render = true): Promise<Peer> {
    const socket = new WebSocket(origin.replace('http:', 'ws:') + '/api/terminal?token=' + token, { origin: new URL(origin).origin });
    const peer = new Peer(socket, render);
    await new Promise<void>((resolve, reject) => { socket.once('open', resolve); socket.once('error', reject); });
    peer.request('ready', { protocol: PROTOCOL_VERSION, hostInstanceId }); await peer.wait(message => message.type === 'operation-result' && message.operation === 'ready');
    return peer;
  }
  send(message: unknown): void { this.socket.send(JSON.stringify(message)); }
  request(type: string, fields: Record<string, unknown> = {}): number { const requestId = ++this.requestId; this.send({ type, requestId, ...fields }); return requestId; }
  wait(predicate: (message: ServerMessage) => boolean, after = 0, timeoutMs = 5000): Promise<ServerMessage> {
    return new Promise((resolve, reject) => {
      const check = () => { const found = this.messages.slice(after).find(predicate); if (found) { clearTimeout(timer); this.waiters.delete(check); resolve(found); } };
      const timer = setTimeout(() => { this.waiters.delete(check); reject(new Error('Bridge response timed out')); }, timeoutMs);
      this.waiters.add(check); check();
    });
  }
  private async apply(message: ServerMessage): Promise<void> {
    if (message.type === 'snapshot-begin') {
      this.terminal?.dispose(); this.snapshotId = message.snapshotId; this.parsed = 0; this.sequence = message.sequence;
      this.terminal = new Terminal({ cols: message.cols, rows: message.rows, scrollback: 10000, allowProposedApi: true });
      this.terminal.loadAddon(new Unicode11Addon() as unknown as Parameters<Terminal['loadAddon']>[0]); this.terminal.unicode.activeVersion = '11';
      this.adapter = installSnapshotState(this.terminal, () => this.snapshotId !== undefined);
      this.suppressed = installRendererReplySuppression(this.terminal);
    } else if (message.type === 'snapshot-chunk' && message.snapshotId === this.snapshotId) {
      await new Promise<void>(resolve => this.terminal!.write(message.data, resolve)); this.parsed += utf8Bytes(message.data);
      this.send({ type: 'snapshot-applied', sessionId: message.sessionId, snapshotId: message.snapshotId, chunkIndex: message.index, parsedBytes: this.parsed });
    } else if (message.type === 'snapshot-end' && message.snapshotId === this.snapshotId) {
      this.adapter!.complete(); this.snapshotId = undefined;
      this.send({ type: 'applied', sessionId: message.sessionId, snapshotId: message.snapshotId, sequence: message.sequence });
    } else if (message.type === 'output') {
      await new Promise<void>(resolve => this.terminal!.write(message.data, resolve)); this.sequence = message.sequence;
      this.send({ type: 'applied', sessionId: message.sessionId, sequence: this.sequence });
    } else if (message.type === 'grid') {
      this.terminal!.resize(message.cols, message.rows); this.sequence = message.sequence;
      this.send({ type: 'applied', sessionId: message.sessionId, sequence: this.sequence });
    }
  }
  async close(): Promise<void> {
    await this.queue; this.adapter?.(); this.suppressed?.(); this.terminal?.dispose();
    if (this.socket.readyState === WebSocket.CLOSED) return;
    await new Promise<void>(resolve => { this.socket.once('close', resolve); this.socket.close(); });
  }
  async screen(): Promise<string> {
    await this.queue; const buffer = this.terminal?.buffer.active; if (!buffer) return '';
    const rows: string[] = []; for (let index = 0; index < buffer.length; index++) rows.push(buffer.getLine(index)!.translateToString(true));
    return rows.join('\n');
  }
  async screenDigest(): Promise<string> {
    await this.queue; const terminal = this.terminal; if (!terminal) return '';
    const buffer = terminal.buffer.active; const cells: unknown[] = [terminal.cols, terminal.rows, buffer.cursorX, buffer.cursorY];
    for (let y = 0; y < buffer.length; y++) for (let x = 0; x < terminal.cols; x++) {
      const cell = buffer.getLine(y)!.getCell(x)!;
      cells.push([cell.getChars(), cell.getFgColorMode(), cell.getFgColor(), cell.getBgColorMode(), cell.getBgColor(), cell.isBold(), cell.isInverse(), cell.isUnderline()]);
    }
    return crypto.createHash('sha256').update(JSON.stringify(cells)).digest('hex');
  }
  get restored(): boolean { return !!this.terminal && this.snapshotId === undefined; }
}
