import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import type { TransactionalSqlExecutor } from '../../apps/db/src/sql.js';
import { LOCAL_PIPELINE_PREVIEW_PATH } from '../../apps/worker/src/contracts/local-pipeline-preview.js';
import { readLocalPipelinePreview, type LocalPreviewSchedulerState } from './preview.js';

const LOOPBACK_HOST = '127.0.0.1';
const DEFAULT_PORT = 8788;
const APPROVED_ORIGINS = new Set(['http://127.0.0.1:5173', 'http://localhost:5173']);
const ALLOWED_FETCH_SITES = new Set(['same-origin', 'same-site', 'none']);

export interface StartLocalPipelinePreviewServerInput {
  readonly executor: TransactionalSqlExecutor;
  readonly models: 'mock' | 'opt_in_gateway';
  readonly scheduler?: () => LocalPreviewSchedulerState;
  /** Port 0 is reserved for isolated local tests. Runtime callers use the fixed default. */
  readonly port?: number;
}

export interface LocalPipelinePreviewServerHandle {
  readonly server: Server;
  readonly host: typeof LOOPBACK_HOST;
  readonly port: number;
  close(): Promise<void>;
}

/** Start the read-only development endpoint on IPv4 loopback. */
export async function startLocalPipelinePreviewServer(
  input: StartLocalPipelinePreviewServerInput,
): Promise<LocalPipelinePreviewServerHandle> {
  validateInput(input);
  const server = createServer((request, response) => {
    void handleRequest(request, response, server, input);
  });
  server.maxHeadersCount = 20;
  server.headersTimeout = 5_000;
  server.requestTimeout = 5_000;
  server.keepAliveTimeout = 1_000;
  server.on('clientError', (_error, socket) => {
    if (socket.destroyed) return;
    socket.end('HTTP/1.1 400 Bad Request\r\nConnection: close\r\n\r\n');
  });

  try {
    await new Promise<void>((resolve, reject) => {
      const onError = (error: Error) => {
        server.removeListener('listening', onListening);
        reject(error);
      };
      const onListening = () => {
        server.removeListener('error', onError);
        resolve();
      };
      server.once('error', onError);
      server.once('listening', onListening);
      server.listen(input.port ?? DEFAULT_PORT, LOOPBACK_HOST);
    });
    const address = server.address();
    if (!address || typeof address === 'string' || address.address !== LOOPBACK_HOST) {
      await closeServer(server);
      throw new Error('local_preview_bind_failed');
    }
    let closePromise: Promise<void> | undefined;
    return {
      server,
      host: LOOPBACK_HOST,
      port: address.port,
      close() {
        closePromise ??= closeServer(server);
        return closePromise;
      },
    };
  } catch {
    if (server.listening) await closeServer(server);
    throw new Error('local_preview_server_start_failed');
  }
}

function validateInput(input: StartLocalPipelinePreviewServerInput): void {
  if (!input || typeof input !== 'object' || !input.executor
    || typeof input.executor.query !== 'function' || typeof input.executor.transaction !== 'function'
    || (input.models !== 'mock' && input.models !== 'opt_in_gateway')
    || (input.scheduler !== undefined && typeof input.scheduler !== 'function')) {
    throw new Error('invalid_local_preview_server_options');
  }
  const port = input.port ?? DEFAULT_PORT;
  if (!Number.isSafeInteger(port) || port < 0 || port > 65_535) {
    throw new Error('invalid_local_preview_server_options');
  }
}

async function handleRequest(
  request: IncomingMessage,
  response: ServerResponse,
  server: Server,
  input: StartLocalPipelinePreviewServerInput,
): Promise<void> {
  setBaseHeaders(response);
  const address = server.address();
  const expectedHost = address && typeof address !== 'string' ? `${LOOPBACK_HOST}:${address.port}` : '';
  if (!address || typeof address === 'string' || !isLoopbackAddress(request.socket.remoteAddress)
    || headerCount(request, 'host') !== 1 || request.headers.host !== expectedHost
    || !validOriginAndFetchSite(request)) {
    sendError(response, 403, 'forbidden');
    return;
  }
  if (request.url !== LOCAL_PIPELINE_PREVIEW_PATH) {
    sendError(response, 404, 'not_found');
    return;
  }
  if (request.method !== 'GET') {
    response.setHeader('Allow', 'GET');
    sendError(response, 405, 'method_not_allowed');
    return;
  }

  try {
    const scheduler = input.scheduler?.() ?? { status: 'idle', polls: 0, collectionFailures: 0 };
    const projection = await readLocalPipelinePreview({
      executor: input.executor,
      models: input.models,
      scheduler,
    });
    sendJson(response, 200, projection);
  } catch {
    sendError(response, 503, 'preview_unavailable');
  }
}

function validOriginAndFetchSite(request: IncomingMessage): boolean {
  const originCount = headerCount(request, 'origin');
  const fetchSiteCount = headerCount(request, 'sec-fetch-site');
  if (originCount > 1 || fetchSiteCount > 1) return false;
  const origin = request.headers.origin;
  const fetchSite = request.headers['sec-fetch-site'];
  if (origin !== undefined && (typeof origin !== 'string' || !APPROVED_ORIGINS.has(origin))) return false;
  if (fetchSite !== undefined && (typeof fetchSite !== 'string' || !ALLOWED_FETCH_SITES.has(fetchSite))) return false;
  if (origin !== undefined && fetchSite === undefined) return false;
  return true;
}

function isLoopbackAddress(address: string | undefined): boolean {
  return address === '127.0.0.1' || address === '::ffff:127.0.0.1';
}

function headerCount(request: IncomingMessage, name: string): number {
  const target = name.toLowerCase();
  let count = 0;
  for (let index = 0; index < request.rawHeaders.length; index += 2) {
    if (request.rawHeaders[index]?.toLowerCase() === target) count++;
  }
  return count;
}

function setBaseHeaders(response: ServerResponse): void {
  response.setHeader('Cache-Control', 'no-store');
  response.setHeader('X-Content-Type-Options', 'nosniff');
  response.setHeader('Referrer-Policy', 'no-referrer');
  response.setHeader('Content-Type', 'application/json; charset=utf-8');
}

function sendError(response: ServerResponse, status: number, code: string): void {
  sendJson(response, status, { error: code });
}

function sendJson(response: ServerResponse, status: number, value: unknown): void {
  if (response.destroyed || response.writableEnded) return;
  response.statusCode = status;
  response.end(JSON.stringify(value));
}

async function closeServer(server: Server): Promise<void> {
  if (!server.listening) return;
  await new Promise<void>((resolve, reject) => {
    server.close((error) => error ? reject(error) : resolve());
  });
}
