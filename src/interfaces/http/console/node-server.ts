import { createReadStream, realpathSync } from 'node:fs';
import { realpath, stat } from 'node:fs/promises';
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { extname, resolve, sep } from 'node:path';
import { pipeline } from 'node:stream/promises';
import { ApplicationError } from '../../../application/common/application-error';
import { apiError } from '../http';
import type { ConsoleWorkerEnv } from './environment';
import worker from './worker';

const MAX_BODY_BYTES = 1_048_576;
const CONTENT_TYPES: Record<string, string> = {
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8', '.svg': 'image/svg+xml', '.png': 'image/png',
  '.ico': 'image/x-icon', '.woff2': 'font/woff2', '.webp': 'image/webp'
};

async function readBody(request: IncomingMessage): Promise<string | undefined> {
  if (Number(request.headers['content-length'] || 0) > MAX_BODY_BYTES) {
    throw new ApplicationError(413, 'payload_too_large', '请求内容过大。');
  }
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of request.iterator({ destroyOnReturn: false })) {
    const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk as string);
    size += bytes.length;
    if (size > MAX_BODY_BYTES) throw new ApplicationError(413, 'payload_too_large', '请求内容过大。');
    chunks.push(bytes);
  }
  if (request.method === 'GET' || request.method === 'HEAD') return undefined;
  return Buffer.concat(chunks).toString('utf8');
}

async function send(response: Response, outgoing: ServerResponse, head = false): Promise<void> {
  outgoing.statusCode = response.status;
  response.headers.forEach((value, name) => {
    if (name !== 'set-cookie') outgoing.setHeader(name, value);
  });
  const cookies = response.headers.getSetCookie();
  if (cookies.length) outgoing.setHeader('set-cookie', cookies);
  if (!response.body || head) {
    await response.body?.cancel();
    outgoing.end();
    return;
  }
  // API responses are bounded JSON; stream them with backpressure.
  await pipeline(response.body, outgoing);
}

function requestUrl(request: IncomingMessage, publicOrigin?: string): URL {
  const host = request.headers.host;
  if (!host || /[\s/@?#\\]/u.test(host) || !request.url?.startsWith('/') || request.url.startsWith('//')) {
    throw new ApplicationError(400, 'invalid_request', '请求地址无效。');
  }
  return new URL(request.url, publicOrigin || `http://${host}`);
}

async function staticFile(request: IncomingMessage, response: ServerResponse, root: string, url: URL): Promise<void> {
  if (request.method !== 'GET' && request.method !== 'HEAD') {
    response.setHeader('Allow', 'GET, HEAD');
    response.writeHead(405).end();
    return;
  }
  let pathname: string;
  try { pathname = decodeURIComponent(url.pathname); } catch { response.writeHead(400).end(); return; }
  if (pathname.includes('\0') || pathname.includes('\\') || pathname.split('/').some((part) => part.startsWith('.'))) {
    response.writeHead(404).end();
    return;
  }
  let file = resolve(root, `.${pathname}`);
  if (!file.startsWith(root + sep) && file !== root) { response.writeHead(404).end(); return; }
  if (pathname === '/') file = resolve(root, 'index.html');
  try {
    if (!(await stat(file)).isFile()) { response.writeHead(404).end(); return; }
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    if (!extname(pathname) && request.headers.accept?.includes('text/html')) file = resolve(root, 'index.html');
    else { response.writeHead(404).end(); return; }
  }
  file = await realpath(file);
  if (!file.startsWith(root + sep)) { response.writeHead(404).end(); return; }
  const info = await stat(file);
  const etag = `W/"${info.size}-${Math.trunc(info.mtimeMs)}"`;
  response.setHeader('ETag', etag);
  response.setHeader('Cache-Control', pathname.startsWith('/assets/') ? 'public, max-age=31536000, immutable' : 'no-cache');
  response.setHeader('Content-Type', CONTENT_TYPES[extname(file)] || 'application/octet-stream');
  response.setHeader('X-Content-Type-Options', 'nosniff');
  if (request.headers['if-none-match'] === etag) { response.writeHead(304).end(); return; }
  response.setHeader('Content-Length', info.size);
  if (request.method === 'HEAD') { response.end(); return; }
  await pipeline(createReadStream(file), response);
}

export function createConsoleServer(env: ConsoleWorkerEnv, assetDirectory: string, publicOrigin?: string) {
  const root = realpathSync(assetDirectory);
  if (publicOrigin && (!/^https?:\/\//u.test(publicOrigin) || new URL(publicOrigin).origin !== publicOrigin)) {
    throw new Error('UGLINK_PUBLIC_ORIGIN 必须是完整的 http/https 来源，不含路径或末尾斜杠。');
  }
  const server = createServer({ requestTimeout: 30_000, headersTimeout: 15_000 }, (incoming, outgoing) => {
    void (async () => {
      try {
        const url = requestUrl(incoming, publicOrigin);
        if (url.pathname !== '/api' && !url.pathname.startsWith('/api/')) {
          await staticFile(incoming, outgoing, root, url);
          return;
        }
        const headers = new Headers();
        for (const [name, value] of Object.entries(incoming.headers)) {
          if (value !== undefined) headers.set(name, Array.isArray(value) ? value.join(', ') : value);
        }
        const body = await readBody(incoming);
        const request = new Request(url, { method: incoming.method, headers, body });
        await send(await worker.fetch(request, env), outgoing, incoming.method === 'HEAD');
      } catch (error) {
        if (outgoing.destroyed) return;
        if (outgoing.headersSent) { outgoing.destroy(); return; }
        // Close rejected uploads instead of retaining an unconsumed request body.
        outgoing.setHeader('Connection', 'close');
        await send(apiError(error), outgoing).catch(() => outgoing.destroy());
      }
    })();
  });
  server.maxRequestsPerSocket = 1000;
  return server;
}
