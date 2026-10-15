import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';

export type LocalAccountHandler = (request: Request) => Promise<Response | undefined>;
export interface LocalAccountServer {
  readonly port: number;
  close(): Promise<void>;
}

/** Adapter only; real authorization remains in the shared account handler. */
export async function startLocalAccountServer(
  handler: LocalAccountHandler,
  options: { readonly appOrigin: string; readonly port?: number },
): Promise<LocalAccountServer> {
  if (!['http://127.0.0.1:5173', 'http://localhost:5173'].includes(options.appOrigin)
    || (options.port !== undefined && (!Number.isInteger(options.port) || options.port < 0 || options.port > 65535))) {
    throw new Error('invalid_local_account_server');
  }
  const server = createServer((request, response) => { void dispatch(request, response, server, handler, options.appOrigin); });
  server.maxHeadersCount = 40;
  server.headersTimeout = 5_000;
  server.requestTimeout = 15_000;
  server.keepAliveTimeout = 1_000;
  server.on('clientError', (_error, socket) => socket.end('HTTP/1.1 400 Bad Request\r\nConnection: close\r\n\r\n'));
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(options.port ?? 8789, '127.0.0.1', resolve);
  });
  const address = server.address();
  if (address === null || typeof address === 'string') throw new Error('local_account_bind_failed');
  let closing: Promise<void> | undefined;
  return {
    port: address.port,
    close() {
      closing ??= new Promise<void>((resolve, reject) => {
        server.close(error => error ? reject(new Error('local_account_close_failed')) : resolve());
        server.closeIdleConnections();
      });
      return closing;
    },
  };
}

async function dispatch(
  request: IncomingMessage, response: ServerResponse, server: Server,
  handler: LocalAccountHandler, appOrigin: string,
): Promise<void> {
  const headers = {
    'Cache-Control': 'no-store', 'Referrer-Policy': 'no-referrer',
    'X-Content-Type-Options': 'nosniff', 'X-Waspada-Auth-Demo': 'synthetic-only',
  };
  for (const [key, value] of Object.entries(headers)) response.setHeader(key, value);
  const failure = (status: number, code: string) => {
    if (response.destroyed || response.writableEnded) return;
    response.statusCode = status;
    response.setHeader('Content-Type', 'application/json');
    response.end(JSON.stringify({ code, message: 'Permintaan akun lokal tidak dapat diproses.', request_id: crypto.randomUUID() }));
  };
  const address = server.address();
  const allowedPeer = request.socket.remoteAddress === '127.0.0.1' || request.socket.remoteAddress === '::ffff:127.0.0.1';
  if (!allowedPeer || address === null || typeof address === 'string'
    || request.headers.host !== `127.0.0.1:${address.port}`
    || request.rawHeaders.filter((_, index) => index % 2 === 0).filter(name => name.toLowerCase() === 'host').length !== 1) {
    failure(403, 'FORBIDDEN'); return;
  }
  const path = request.url ?? '/';
  if (!/^\/api\/v1\/(?:auth(?:\/|$)|account(?:\/|\?|$))/.test(path)) {
    failure(404, 'NOT_FOUND'); return;
  }
  try {
    const chunks: Uint8Array[] = [];
    let size = 0;
    for await (const chunk of request) {
      const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
      size += bytes.byteLength;
      if (size > 16 * 1024) { failure(413, 'PAYLOAD_TOO_LARGE'); return; }
      chunks.push(bytes);
    }
    const requestHeaders = new Headers();
    for (const [name, value] of Object.entries(request.headers)) {
      if (typeof value === 'string') requestHeaders.set(name, value);
      else if (Array.isArray(value)) for (const part of value) requestHeaders.append(name, part);
    }
    const method = request.method ?? 'GET';
    const converted = new Request(new URL(path, appOrigin), {
      method, headers: requestHeaders,
      ...(!['GET', 'HEAD'].includes(method) ? { body: Buffer.concat(chunks) } : {}),
    });
    const result = await handler(converted);
    if (!result) { failure(404, 'NOT_FOUND'); return; }
    response.statusCode = result.status;
    for (const [name, value] of result.headers) if (name !== 'set-cookie') response.setHeader(name, value);
    const cookies = result.headers.getSetCookie();
    if (cookies.length > 0) response.setHeader('Set-Cookie', cookies);
    // The Node tool never caches even when an injected handler forgets headers.
    response.setHeader('Cache-Control', 'no-store');
    response.end(Buffer.from(await result.arrayBuffer()));
  } catch { failure(503, 'TEMPORARILY_UNAVAILABLE'); }
}
