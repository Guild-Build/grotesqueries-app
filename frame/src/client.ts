import { PROTOCOL_VERSION, decodeBootstrap, decodeServerMessage, utf8Bytes,
  type Bootstrap, type ClientMessage, type ServerMessage } from '@grotesqueries/protocol';
type Request = ClientMessage extends infer M ? M extends { requestId: number } ? Omit<M, 'requestId'> : never : never;
export type ConnectionState = 'connecting' | 'connected' | 'reconnecting' | 'unavailable';
export class HostClient {
  bootstrap?: Bootstrap; viewId?: string;
  private socket?: WebSocket; private generation = 0; private requestId = 0; private failures = 0;
  private retry?: ReturnType<typeof setTimeout>;
  private heartbeat?: ReturnType<typeof setInterval>;
  private readonly requests = new Map<number, { resolve: (message: ServerMessage) => void; reject: (error: Error) => void; timer: ReturnType<typeof setTimeout> }>();
  private state: ConnectionState = 'unavailable'; private closed = false;
  constructor(private readonly callbacks: { bootstrap: (value: Bootstrap) => void; message: (value: ServerMessage) => void;
    status: (state: ConnectionState, detail: string) => void }, readonly route = '') {
    if (route && !/^\/fleet\/[a-zA-Z0-9_-]{1,64}\/[a-f0-9-]{36}$/i.test(route)) throw new Error('Invalid host route.');
  }
  async connect(manual = false): Promise<void> {
    if (this.closed) return;
    if (manual) this.failures = 0;
    clearTimeout(this.retry); clearInterval(this.heartbeat); const generation = ++this.generation;
    for (const request of this.requests.values()) { clearTimeout(request.timer); request.reject(new Error('Connection replaced; inspect the inventory for operation outcomes.')); }
    this.requests.clear();
    this.socket?.close(); this.socket = undefined; this.viewId = undefined; this.requestId = 0;
    this.status(this.failures ? 'reconnecting' : 'connecting', this.failures ? 'Reconnecting to host…' : 'Connecting to host…');
    try {
      const response = await fetch(this.route + '/api/bootstrap', { cache: 'no-store' });
      if (!response.ok) throw new Error('Host bootstrap unavailable.');
      const bootstrap = decodeBootstrap(await response.json()); if (generation !== this.generation) return;
      this.bootstrap = bootstrap; this.callbacks.bootstrap(bootstrap);
      const socket = new WebSocket(`${location.protocol === 'https:' ? 'wss:' : 'ws:'}//${location.host}${this.route}/api/terminal?token=${encodeURIComponent(bootstrap.token)}`);
      this.socket = socket;
      const handshake = setTimeout(() => { if (generation === this.generation && this.state !== 'connected') socket.close(); }, 10000);
      socket.onmessage = event => {
        if (generation !== this.generation) return;
        try {
          const message = decodeServerMessage(JSON.parse(String(event.data)), bootstrap.limits);
          if (message.type === 'hello') {
            if (message.protocol !== PROTOCOL_VERSION || message.hostInstanceId !== bootstrap.hostInstanceId) throw new Error('Protocol mismatch.');
            this.viewId = message.viewId;
            void this.request({ type: 'ready', protocol: PROTOCOL_VERSION, hostInstanceId: bootstrap.hostInstanceId }).then(() => {
              if (generation !== this.generation) return; clearTimeout(handshake); this.failures = 0; this.status('connected', 'Host connected');
              this.heartbeat = setInterval(() => {
                if (generation === this.generation && this.connected) void this.request({ type: 'ping' }).catch(() => socket.close());
              }, Math.min(5000, Math.max(500, Math.floor(bootstrap.limits.control.timeoutMs / 3))));
            }).catch(() => socket.close());
          }
          if ('requestId' in message && message.requestId !== undefined) {
            const pending = this.requests.get(message.requestId);
            if (pending) { clearTimeout(pending.timer); this.requests.delete(message.requestId);
              if (message.type === 'error') pending.reject(new Error(message.message)); else pending.resolve(message); }
          }
          this.callbacks.message(message);
        } catch { this.status('unavailable', 'Invalid host stream. Reconnect for a complete restoration.'); socket.close(); }
      };
      socket.onclose = () => { clearTimeout(handshake); if (generation === this.generation) this.lost(); };
      socket.onerror = () => socket.close();
    } catch { if (generation === this.generation) this.lost(); }
  }
  request(message: Request): Promise<ServerMessage> {
    if (this.requests.size >= 32) return Promise.reject(new Error('Too many pending operations. Wait for their results.'));
    const requestId = ++this.requestId;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => { this.requests.delete(requestId); reject(new Error('Operation result is unknown. Inspect the inventory before trying a new action.')); }, 10000);
      this.requests.set(requestId, { resolve, reject, timer });
      try { this.send({ ...message, requestId } as ClientMessage); }
      catch (error) { clearTimeout(timer); this.requests.delete(requestId); reject(error); }
    });
  }
  send(message: ClientMessage): void {
    const socket = this.socket; const limits = this.bootstrap?.limits.transport;
    if (!socket || socket.readyState !== WebSocket.OPEN || !limits) throw new Error('Host connection is unavailable.');
    const data = JSON.stringify(message); const bytes = utf8Bytes(data);
    if (bytes > limits.maxFrameBytes || socket.bufferedAmount + bytes > limits.maxViewQueueBytes) throw new Error('View transport queue capacity reached.');
    socket.send(data);
  }
  private lost(): void {
    clearInterval(this.heartbeat);
    this.socket = undefined; this.viewId = undefined;
    for (const request of this.requests.values()) { clearTimeout(request.timer); request.reject(new Error('Connection lost; operation outcome may be unknown. Inspect the inventory.')); }
    this.requests.clear();
    this.failures++;
    if (this.failures >= 10) { this.status('unavailable', 'Host unavailable. Use Retry when it is ready.'); return; }
    this.status('reconnecting', 'Connection lost. Reconnecting; control must be acquired again.');
    const delay = Math.min(5000, 500 * 2 ** Math.min(this.failures - 1, 4)) * (0.8 + Math.random() * 0.4);
    this.retry = setTimeout(() => { void this.connect(); }, delay);
  }
  /** Ledger 0.5(2): ends this view for good, for a closed or refused tab: no timer, no pending request, no socket, no further status. */
  close(): void {
    this.closed = true; this.generation++; this.state = 'unavailable'; clearTimeout(this.retry); clearInterval(this.heartbeat);
    for (const request of this.requests.values()) { clearTimeout(request.timer); request.reject(new Error('View closed.')); }
    this.requests.clear(); this.socket?.close(); this.socket = undefined; this.viewId = undefined;
  }
  private status(state: ConnectionState, detail: string): void { if (this.closed) return; this.state = state; this.callbacks.status(state, detail); }
  get connected(): boolean { return this.state === 'connected'; }
}
