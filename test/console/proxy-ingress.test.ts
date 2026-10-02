import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { request as httpRequest, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { SqliteConsoleStore } from '../../src/infrastructure/persistence/sqlite-console-store';
import { createConsoleServer } from '../../src/interfaces/http/console/node-server';
import { parseServerConfig } from '../../src/interfaces/http/console/server-config';
import worker from '../../src/interfaces/http/console/worker';
import { openJson } from '../../src/infrastructure/security/session-crypto';
import type { SessionData } from '../../src/infrastructure/persistence/console-session';

let directory: string, store: SqliteConsoleStore, server: Server, base: string;
const key = 'a'.repeat(43);
const proxyHeaders = { host: 'internal', 'x-forwarded-host': 'proxy.test', 'x-forwarded-proto': 'https' };
beforeEach(async () => {
  directory = mkdtempSync(join(tmpdir(), 'uglink-proxy-test-'));
  mkdirSync(join(directory, 'client'));
  writeFileSync(join(directory, 'client', 'index.html'), 'test');
  store = new SqliteConsoleStore(join(directory, 'console.sqlite'));
  server = createConsoleServer({ CONSOLE_SESSIONS: store, SESSION_ENCRYPTION_KEY: key }, join(directory, 'client'), parseServerConfig({
    UGLINK_ALLOWED_ORIGINS: 'https://proxy.test,https://relay.test,http://lan.test:5173',
    UGLINK_TRUSTED_PROXY_CIDRS: '127.0.0.1', UGLINK_PROXY_HEADER_MODE: 'x-forwarded-single',
    UGLINK_HOST_ORIGIN_MAP: '{"relay.test":"https://relay.test","lan.test:5173":"http://lan.test:5173"}'
  }));
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});
afterEach(async () => {
  vi.restoreAllMocks();
  server?.closeAllConnections();
  if (server) await new Promise<void>(resolve => server.close(() => resolve()));
  store?.close();
  rmSync(directory, { recursive: true, force: true });
});
// node:http lets these tests control the actual wire Host, including duplicate raw headers.
async function call(path: string, headers: Record<string, string> | string[], method = 'GET') {
  return new Promise<{ status: number; cookie?: string; body: any }>((resolve, reject) => {
    const req = httpRequest(base + path, { headers, method }, res => {
      let text = '';
      res.on('data', chunk => text += chunk);
      res.on('end', () => resolve({ status: res.statusCode!, cookie: res.headers['set-cookie']?.[0], body: JSON.parse(text) }));
    });
    req.on('error', reject); req.end();
  });
}
it('bootstraps three interleaved entries without Origin and refreshes existing cookies without extending authorization', async () => {
  for (const headers of [proxyHeaders, { host: 'lan.test:5173' }, { host: 'relay.test' }, proxyHeaders, { host: 'lan.test:5173' }]) {
    const first = await call('/api/bootstrap', headers);
    expect(first.status).toBe(200);
    expect(first.cookie).toContain('HttpOnly; SameSite=Lax;');
    expect(first.cookie).not.toContain('Domain=');
    expect(first.cookie!.includes('; Secure')).toBe(headers.host !== 'lan.test:5173');
    const cookie = first.cookie!.split(';')[0]!;
    const id = cookie.split('=')[1]!;
    const prior = await openJson<SessionData>((await store.get(`session:${id}`))!, key, `uglink-console-session:${id}`);
    const next = await call('/api/bootstrap', { ...headers, cookie });
    expect(next.cookie).toContain(cookie);
    expect(next.body.csrfToken).toBe(first.body.csrfToken);
    const after = await openJson<SessionData>((await store.get(`session:${id}`))!, key, `uglink-console-session:${id}`);
    expect(after.expiresAt).toBe(prior.expiresAt);
    const origin = headers.host === 'lan.test:5173' ? 'http://lan.test:5173' : headers.host === 'relay.test' ? 'https://relay.test' : 'https://proxy.test';
    expect((await call('/api/connections/cloudflare/reset', { ...headers, cookie, origin, 'x-csrf-token': first.body.csrfToken }, 'POST')).status).toBe(200);
  }
});
it('keeps Origin and CSRF checks ahead of external side effects', async () => {
  const first = await call('/api/bootstrap', proxyHeaders);
  const headers = { ...proxyHeaders, cookie: first.cookie!.split(';')[0]!, 'x-csrf-token': first.body.csrfToken };
  const outbound = vi.spyOn(globalThis, 'fetch').mockRejectedValue(new Error('Unexpected outbound request'));
  for (const origin of ['https://relay.test', 'null', '', 'https://proxy.test, https://relay.test', 'https://proxy.test/']) {
    const result = await call('/api/connections/cloudflare', { ...headers, origin }, 'POST');
    expect(result.status).toBe(403); expect(result.body.error.code).toBe('invalid_origin');
  }
  for (const extra of [{ cookie: '' }, { 'x-csrf-token': '' }]) {
    const result = await call('/api/connections/cloudflare', { ...headers, origin: 'https://proxy.test', ...extra }, 'POST');
    expect(result.status).toBe(403); expect(result.body.error.code).toBe('invalid_csrf_token');
  }
  expect((await call('/api/connections/cloudflare/reset', headers, 'POST')).status).toBe(200);
  expect((await call('/api/connections/cloudflare/reset', { ...headers, origin: 'HTTPS://PROXY.TEST:443' }, 'POST')).status).toBe(200);
  expect(outbound).not.toHaveBeenCalled();
});
it('rejects unknown destinations before creating sessions and confines the health bypass', async () => {
  const put = vi.spyOn(store, 'put');
  const denied = await call('/api/bootstrap', { ...proxyHeaders, 'x-forwarded-host': 'evil.test' });
  expect(denied.status).toBe(421); expect(denied.cookie).toBeUndefined(); expect(put).not.toHaveBeenCalled();
  const health = await call('/api/health', { host: '127.0.0.1:8787' });
  expect(health.status).toBe(200); expect(health.cookie).toBeUndefined();
  expect((await call('/api/bootstrap', { host: '127.0.0.1:8787' })).status).toBe(400);
  expect((await call('/api/health?x=1', { host: '127.0.0.1:8787' })).status).toBe(400);
  expect((await call('/api/health', { host: '127.0.0.1:8787' }, 'POST')).status).toBe(400);
  expect((await call('/api/bootstrap', ['Host', 'proxy.test', 'Host', 'relay.test'])).status).toBe(400);
});
it('Worker trusts its platform URL and upgrades an old session using the same ID', async () => {
  const env = { CONSOLE_SESSIONS: store, SESSION_ENCRYPTION_KEY: key };
  const old = await worker.fetch(new Request('http://proxy.test/api/bootstrap'), env);
  const cookie = old.headers.get('set-cookie')!.split(';')[0]!;
  const first = await old.json() as { csrfToken: string };
  const upgraded = await worker.fetch(new Request('https://proxy.test/api/bootstrap', { headers: { cookie, 'x-forwarded-host': 'evil.test', 'x-forwarded-proto': 'http' } }), env);
  expect(upgraded.headers.get('set-cookie')).toContain(cookie);
  expect(upgraded.headers.get('set-cookie')).toContain('; Secure');
  expect((await upgraded.json() as { csrfToken: string }).csrfToken).toBe(first.csrfToken);
});
