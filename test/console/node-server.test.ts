import { mkdtempSync, mkdirSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { request as httpRequest, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { SqliteConsoleStore } from '../../src/infrastructure/persistence/sqlite-console-store';
import { createConsoleServer } from '../../src/interfaces/http/console/node-server';

let directory: string;
let store: SqliteConsoleStore;
let server: Server;
let base: string;
beforeEach(async () => {
  directory = mkdtempSync(join(tmpdir(), 'uglink-node-test-'));
  const assets = join(directory, 'client');
  mkdirSync(join(assets, 'assets'), { recursive: true });
  writeFileSync(join(assets, 'index.html'), '<h1>UGLINK</h1>');
  writeFileSync(join(assets, 'assets', 'app.js'), 'console.log("example")');
  writeFileSync(join(directory, 'private.txt'), 'secret');
  symlinkSync(join(directory, 'private.txt'), join(assets, 'leak.txt'));
  store = new SqliteConsoleStore(join(directory, 'console.sqlite'));
  server = createConsoleServer({
    CONSOLE_SESSIONS: store, SESSION_ENCRYPTION_KEY: 'a'.repeat(43)
  }, assets);
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});
afterEach(async () => {
  server.closeAllConnections();
  await new Promise<void>((resolve) => server.close(() => resolve()));
  store.close();
  rmSync(directory, { recursive: true, force: true });
});

describe('Node console HTTP adapter', () => {
  it('serves health and keeps encrypted sessions and CSRF enforcement', async () => {
    expect(await (await fetch(`${base}/api/health`)).json()).toEqual({ status: 'ok' });
    const response = await fetch(`${base}/api/bootstrap`);
    const cookie = response.headers.get('set-cookie')!.split(';')[0]!;
    const first = await response.json() as { csrfToken: string };
    expect(cookie).toContain('uglink_console_session=');
    const next = await (await fetch(`${base}/api/bootstrap`, { headers: { cookie } })).json();
    expect(next).toEqual(first);
    const csrf = await fetch(`${base}/api/connections/cloudflare/reset`, {
      method: 'POST', headers: { cookie, 'content-type': 'application/json' }, body: '{}'
    });
    expect(csrf.status).toBe(403);
    const crossOrigin = await fetch(`${base}/api/connections/cloudflare/reset`, {
      method: 'POST', headers: { cookie, origin: 'https://other.example.com', 'x-csrf-token': first.csrfToken }, body: '{}'
    });
    expect(crossOrigin.status).toBe(403);
    const spoofedProxy = await fetch(`${base}/api/connections/cloudflare/reset`, {
      method: 'POST', headers: {
        cookie, origin: 'https://other.example.com', 'x-csrf-token': first.csrfToken,
        'x-forwarded-host': 'other.example.com', 'x-forwarded-proto': 'https'
      }, body: '{}'
    });
    expect(spoofedProxy.status).toBe(403);
    const reset = await fetch(`${base}/api/connections/cloudflare/reset`, {
      method: 'POST', headers: { cookie, 'x-csrf-token': first.csrfToken }, body: '{}'
    });
    expect(reset.status).toBe(200);
  });

  it('supports an explicit HTTPS public origin with Secure cookies and same-origin writes', async () => {
    const proxy = createConsoleServer({
      CONSOLE_SESSIONS: store, SESSION_ENCRYPTION_KEY: 'a'.repeat(43)
    }, join(directory, 'client'), 'https://console.example.com');
    await new Promise<void>((resolve) => proxy.listen(0, '127.0.0.1', resolve));
    try {
      const address = `http://127.0.0.1:${(proxy.address() as AddressInfo).port}`;
      const bootstrap = await fetch(`${address}/api/bootstrap`);
      const cookie = bootstrap.headers.get('set-cookie')!;
      expect(cookie).toContain('; Secure');
      const { csrfToken } = await bootstrap.json() as { csrfToken: string };
      const result = await fetch(`${address}/api/connections/cloudflare/reset`, {
        method: 'POST', headers: {
          origin: 'https://console.example.com', cookie: cookie.split(';')[0]!, 'x-csrf-token': csrfToken
        }, body: '{}'
      });
      expect(result.status).toBe(200);
    } finally {
      proxy.closeAllConnections();
      await new Promise<void>((resolve) => proxy.close(() => resolve()));
    }
  });

  it('serves SPA routes, HEAD and cache validation without exposing private files', async () => {
    const page = await fetch(`${base}/nested`, { headers: { accept: 'text/html' } });
    expect(await page.text()).toContain('UGLINK');
    expect((await fetch(`${base}/assets/missing.js`)).status).toBe(404);
    expect((await fetch(`${base}/.dev.vars`)).status).toBe(404);
    expect((await fetch(`${base}/leak.txt`)).status).toBe(404);
    const head = await fetch(`${base}/assets/app.js`, { method: 'HEAD' });
    expect(await head.text()).toBe('');
    expect(head.headers.get('cache-control')).toContain('immutable');
    const cached = await fetch(`${base}/assets/app.js`, { headers: { 'if-none-match': head.headers.get('etag')! } });
    expect(cached.status).toBe(304);
    expect((await fetch(`${base}/`, { method: 'POST' })).status).toBe(405);
  });

  it('rejects oversized declared and chunked bodies before loading them into memory', async () => {
    expect((await fetch(`${base}/api/validate`, { method: 'POST', body: 'x'.repeat(1_048_577) })).status).toBe(413);
    const status = await new Promise<number | undefined>((resolve, reject) => {
      const request = httpRequest(`${base}/api/validate`, { method: 'POST' }, (response) => {
        response.resume();
        resolve(response.statusCode);
      });
      request.on('error', reject);
      for (let i = 0; i < 17; i++) request.write(Buffer.alloc(65_536, 'a'));
      request.end();
    });
    expect(status).toBe(413);
    expect((await fetch(`${base}/api/health`)).status).toBe(200);
  });
});
