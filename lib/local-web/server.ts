import http from 'node:http';

export function jsonResponse(response: http.ServerResponse, status: number, value: unknown): void {
  response.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8' });
  response.end(JSON.stringify(value));
}

/** Owns the local listener. Routing, job/session authorization and cleanup belong to the caller. */
export function createLocalServer(options: { port: number;
  handler: (request: http.IncomingMessage, response: http.ServerResponse, url: URL) => void | Promise<void>;
  onError?: (code: string) => void }) {
  if (!Number.isSafeInteger(options.port) || options.port < 0 || options.port > 65535) throw new Error('INVALID_LOCAL_PORT');
  const report = (code: string) => {
    try { options.onError?.(code); }
    catch { console.error('HOST_ERROR_REPORT_FAILED'); }
  };
  const origin = () => {
    const address = server.address();
    return `http://127.0.0.1:${address && typeof address === 'object' ? address.port : options.port}`;
  };
  const trustedRequest = (request: http.IncomingMessage) =>
    request.headers.host === new URL(origin()).host &&
    (!request.headers.origin || request.headers.origin === origin()) &&
    (!request.headers['sec-fetch-site'] || ['same-origin', 'none'].includes(String(request.headers['sec-fetch-site'])));
  const requestURL = (request: http.IncomingMessage): URL | undefined => {
    try {
      const url = new URL(request.url ?? '/', origin());
      if (url.origin !== origin()) throw new Error('FOREIGN_REQUEST_TARGET');
      return url;
    } catch { report('INVALID_REQUEST_TARGET'); return undefined; }
  };
  const failedRequest = (response: http.ServerResponse) => {
    report('REQUEST_HANDLER_FAILED');
    if (response.headersSent) response.destroy();
    else jsonResponse(response, 500, { error: 'Local request failed' });
  };
  const server = http.createServer((request, response) => {
    response.setHeader('Cache-Control', 'no-store'); response.setHeader('X-Content-Type-Options', 'nosniff');
    if (!trustedRequest(request)) { jsonResponse(response, 403, { error: 'Untrusted local connection' }); return; }
    const url = requestURL(request);
    if (!url) { jsonResponse(response, 400, { error: 'Invalid request target' }); return; }
    try { Promise.resolve(options.handler(request, response, url)).catch(() => failedRequest(response)); }
    catch { failedRequest(response); }
  });
  let listening: Promise<void> | undefined;
  let closing: Promise<void> | undefined;
  return {
    server, trustedRequest, requestURL,
    get origin() { return origin(); },
    listen(): Promise<void> {
      if (closing) return Promise.reject(new Error('HOST_SERVER_CLOSED'));
      return listening ??= new Promise<void>((resolve, reject) => {
        const failed = (error: NodeJS.ErrnoException) => reject(Object.assign(new Error(error.code === 'EADDRINUSE'
          ? `Port ${options.port} is occupied. Choose another local port and restart.`
          : 'HOST_LISTEN_FAILED: Check the loopback port and restart.'), { code: error.code }));
        server.once('error', failed);
        server.listen(options.port, '127.0.0.1', () => {
          server.removeListener('error', failed); server.on('error', () => report('HOST_LISTENER_ERROR')); resolve();
        });
      });
    },
    close(): Promise<void> {
      return closing ??= (async () => {
        // A premature server.close cancels Node's listening callback. Settle startup first.
        if (listening) { try { await listening; } catch { /* A failed listener still closes cleanly. */ } }
        await new Promise<void>(resolve => server.close(() => resolve()));
      })();
    },
  };
}
