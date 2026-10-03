import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { request, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { SqliteConsoleStore } from '../../src/infrastructure/persistence/sqlite-console-store';
import { createConsoleServer } from '../../src/interfaces/http/console/node-server';
import { parseServerConfig } from '../../src/interfaces/http/console/server-config';
import { resolveNodeContext } from '../../src/interfaces/http/console/node-request-context';
import { openJson, sealJson } from '../../src/infrastructure/security/session-crypto';
import { createHash } from 'node:crypto';
import type { SessionData } from '../../src/infrastructure/persistence/console-session';
let directory: string, store: SqliteConsoleStore, server: Server, base: string;
const key = 'a'.repeat(43);
const browserHeaders = { host: 'internal:8787', 'x-uglink-console-origin': 'https://relay.test', 'sec-fetch-site': 'same-origin' };
beforeEach(async () => {
  directory = mkdtempSync(join(tmpdir(), 'uglink-auto-'));
  mkdirSync(join(directory, 'client')); writeFileSync(join(directory, 'client', 'index.html'), 'test');
  store = new SqliteConsoleStore(join(directory, 'console.sqlite'));
  server = createConsoleServer({ CONSOLE_SESSIONS: store, SESSION_ENCRYPTION_KEY: key }, join(directory, 'client'));
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});
afterEach(async () => {
  vi.restoreAllMocks(); server.closeAllConnections();
  await new Promise<void>(resolve => server.close(() => resolve())); store.close(); rmSync(directory, { recursive: true, force: true });
});
async function call(headers: Record<string,string> | string[], method = 'GET', path = '/api/bootstrap') {
  return new Promise<{status:number; headers: import('node:http').IncomingHttpHeaders; body:any}>((resolve,reject) => {
    const req = request(base + path, { headers, method }, res => {
      let body = ''; res.on('data', chunk => body += chunk); res.on('end', () => resolve({status:res.statusCode!,headers:res.headers,body:JSON.parse(body)}));
    }); req.on('error',reject); req.end();
  });
}
it('works without environment configuration when a proxy rewrites Host and drops all forwarding metadata', async () => {
  const first = await call(browserHeaders);
  expect(first.status).toBe(200); expect(first.headers['set-cookie']![0]).toContain('; Secure');
  const cookie = first.headers['set-cookie']![0]!.split(';')[0]!;
  const headers = { ...browserHeaders, cookie, origin:'https://relay.test', 'x-csrf-token':first.body.csrfToken };
  expect((await call(headers,'POST','/api/configuration/cloud/dismiss')).status).toBe(200);
  expect((await call({...headers, 'x-csrf-token':''},'POST','/api/configuration/cloud/dismiss')).status).toBe(403);
  expect((await call({...headers, origin:'https://evil.test'},'POST','/api/configuration/cloud/dismiss')).body.error.code).toBe('invalid_origin');
});
it.each(['cross-site','same-site','none'])('rejects %s browser claims before creating a session', async site => {
  const put = vi.spyOn(store,'put');
  const result = await call({...browserHeaders,'sec-fetch-site':site});
  expect(result.status).toBe(403); expect(result.headers['set-cookie']).toBeUndefined(); expect(put).not.toHaveBeenCalled();
});
it('rejects preflights without granting CORS or creating sessions', async () => {
  const put=vi.spyOn(store,'put');
  const r = await call({host:'internal',origin:'https://evil.test','access-control-request-method':'GET','access-control-request-headers':'x-uglink-console-origin'},'OPTIONS');
  expect(r.status).toBe(405); expect(r.headers['access-control-allow-origin']).toBeUndefined(); expect(put).not.toHaveBeenCalled();
});
it('rejects duplicate or malformed custom origins and mismatching bootstrap Origin', async () => {
  for (const headers of [
    ['Host','internal','X-Uglink-Console-Origin','https://relay.test','X-Uglink-Console-Origin','https://evil.test'],
    {...browserHeaders,'x-uglink-console-origin':'null'},
    {...browserHeaders,origin:'https://evil.test'}
  ]) expect((await call(headers)).status).toBe(403);
});
it('supports browsers without Fetch Metadata using the non-simple header boundary', async () => {
  expect((await call({host:'internal','x-uglink-console-origin':'https://relay.test'})).headers['set-cookie']![0]).toContain('; Secure');
});
it('does not let automatic hints override explicitly configured origins', () => {
  const facts = { rawHeaders: ['Host','internal','X-Uglink-Console-Origin','https://evil.test'],target:'/api/bootstrap',method:'GET' };
  expect(resolveNodeContext(facts,parseServerConfig({UGLINK_PUBLIC_ORIGIN:'https://configured.test'})).externalOrigin).toBe('https://configured.test');
  expect(() => resolveNodeContext(facts,parseServerConfig({UGLINK_ALLOWED_ORIGINS:'https://evil.test'}))).toThrow(expect.objectContaining({code:'unconfigured_origin'}));
});
it('binds upgraded sessions without changing IDs, data or expiry, and never downgrades cookies on headerless navigation', async () => {
  const old = await call({host:'internal'});
  const cookie=old.headers['set-cookie']![0]!.split(';')[0]!; const id=cookie.split('=')[1]!;
  const before = await openJson<SessionData>((await store.get(`session:${id}`))!,key,`uglink-console-session:${id}`);
  before.cloudflare = { apiToken: 'fixture-only-token', account: { id: 'a'.repeat(32), name: 'Fixture' }, connectedAt: Date.now() };
  await store.put(`session:${id}`, await sealJson(before, key, `uglink-console-session:${id}`));
  const upgraded=await call({...browserHeaders,cookie});
  expect(upgraded.headers['set-cookie']![0]).toContain(`=${id};`); expect(upgraded.headers['set-cookie']![0]).toContain('; Secure');
  expect(upgraded.body.csrfToken).toBe(old.body.csrfToken);
  const boundCookie = upgraded.headers['set-cookie']![0]!.split(';')[0]!;
  const rejected = await call({host:'internal',cookie:boundCookie});
  expect(rejected.status).toBe(403); expect(rejected.headers['set-cookie']).toBeUndefined();
  const other = await call({...browserHeaders,cookie:boundCookie,'x-uglink-console-origin':'https://another.test'});
  expect(other.status).toBe(200); expect(other.body.csrfToken).not.toBe(before.csrfToken);
  const after=await openJson<SessionData>((await store.get(`session:${id}`))!,key,`uglink-console-session:${id}`);
  expect(after.expiresAt).toBe(before.expiresAt); expect(after.csrfToken).toBe(before.csrfToken);
  expect(after.cloudflare).toEqual(before.cloudflare);
  expect((await call({...browserHeaders,cookie})).body.csrfToken).toBe(before.csrfToken);
});
it('rejects a bound session transplanted under another origin cookie name without deleting it', async () => {
  const old = await call(browserHeaders);
  const id = old.headers['set-cookie']![0]!.split(';')[0]!.split('=')[1]!;
  const origin = 'https://another.test';
  const cookie = `uglink_console_session_${createHash('sha256').update(origin).digest('hex').slice(0,32)}=${id}`;
  const rejected = await call({...browserHeaders, 'x-uglink-console-origin':origin, cookie});
  expect(rejected.status).toBe(403); expect(rejected.body.error.code).toBe('session_origin_mismatch');
  expect(rejected.headers['set-cookie']).toBeUndefined(); expect(await store.get(`session:${id}`)).not.toBeNull();
});
it('isolates same-host ports and HTTP/HTTPS cookies while keeping both sessions usable', async () => {
  const cookies: string[] = [];
  const tokens: string[] = [];
  for (const origin of ['http://relay.test:5173','https://relay.test:5173','https://relay.test:8443']) {
    const r = await call({...browserHeaders,'x-uglink-console-origin':origin,cookie:cookies.join('; ')});
    expect(r.status).toBe(200);
    cookies.push(r.headers['set-cookie']![0]!.split(';')[0]!);
    tokens.push(r.body.csrfToken);
  }
  expect(new Set(cookies.map(c=>c.split('=')[0])).size).toBe(3);
  for (const [index, origin] of ['http://relay.test:5173','https://relay.test:5173','https://relay.test:8443'].entries()) {
    const r = await call({...browserHeaders,'x-uglink-console-origin':origin,cookie:cookies.join('; ')});
    expect(r.body.csrfToken).toBe(tokens[index]);
  }
});
it('preserves the old encrypted session if saving its origin binding fails', async () => {
  const old = await call({ host: 'internal' });
  const cookie = old.headers['set-cookie']![0]!.split(';')[0]!;
  const sessionKey = `session:${cookie.split('=')[1]!}`;
  const sealed = await store.get(sessionKey);
  vi.spyOn(store, 'put').mockRejectedValueOnce(new Error('disk unavailable'));
  expect((await call({ ...browserHeaders, cookie })).status).toBe(500);
  expect(await store.get(sessionKey)).toBe(sealed);
  expect((await call({ ...browserHeaders, cookie })).body.csrfToken).toBe(old.body.csrfToken);
});
