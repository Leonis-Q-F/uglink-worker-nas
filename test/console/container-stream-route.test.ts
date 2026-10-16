import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, expect, it, vi } from 'vitest';
import worker from '../../src/interfaces/http/console/worker';
import type { ConsoleWorkerEnv } from '../../src/interfaces/http/console/environment';
import { getOrCreateSession, saveSession } from '../../src/infrastructure/persistence/console-session';

const origin = 'https://console.example.test';
const token = 'exact-container-session-credential';
const directories: string[] = [];
afterEach(() => { vi.restoreAllMocks(); vi.unstubAllGlobals(); for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true }); });

function environment(): ConsoleWorkerEnv {
  const values = new Map<string, string>();
  return { SESSION_ENCRYPTION_KEY: 'a'.repeat(43), CONSOLE_SESSIONS: {
    get: async (key: string, type?: string) => { const value = values.get(key) ?? null; return value && type === 'json' ? JSON.parse(value) as unknown : value; },
    put: async (key: string, value: string) => { values.set(key, value); },
    delete: async (key: string) => { values.delete(key); }
  } as ConsoleWorkerEnv['CONSOLE_SESSIONS'] };
}
async function session(env: ConsoleWorkerEnv, connected = true) {
  const handle = await getOrCreateSession(new Request(origin), env);
  if (connected) {
    handle.data.cloudflare = { apiToken: token, account: { id: 'account', name: 'Test' }, connectedAt: Date.now() };
    handle.data.target = { accountId: 'account', accountName: 'Test', workerName: 'worker' };
    await saveSession(env, handle);
  }
  return { cookie: `uglink_console_session=${handle.id}`, csrfToken: handle.data.csrfToken };
}
function request(cookie: string, csrfToken?: string, requestOrigin = origin) {
  return new Request(`${origin}/api/diagnostics/container-stream`, { method: 'POST', headers: {
    cookie, origin: requestOrigin, ...(csrfToken ? { 'x-csrf-token': csrfToken } : {})
  } });
}

it('requires authentication, same-origin and CSRF for the local process source', async () => {
  const env = environment();
  const credentials = await session(env, false);
  expect((await worker.fetch(request(credentials.cookie, credentials.csrfToken), env)).status).toBe(401);
  expect((await worker.fetch(request(credentials.cookie), env)).status).toBe(403);
  expect((await worker.fetch(request(credentials.cookie, credentials.csrfToken, 'https://other.example.test'), env)).status).toBe(403);
});

it('reports unavailable once on workerd without invoking Cloudflare Tail', async () => {
  const env = environment();
  const credentials = await session(env);
  const upstream = vi.fn(() => { throw new Error('must not contact Cloudflare'); });
  vi.stubGlobal('fetch', upstream);
  const response = await worker.fetch(request(credentials.cookie, credentials.csrfToken), env);
  expect(response.status).toBe(200);
  expect(response.headers.get('content-type')).toContain('text/event-stream');
  expect(await response.text()).toContain('"state":"unavailable"');
  expect(upstream).not.toHaveBeenCalled();
});

it('registers the current session credential before replay and preserves raw local text', async () => {
  const { NodeProcessLogStore } = await import('../../src/infrastructure/logging/node-process-logs');
  const directory = mkdtempSync(join(tmpdir(), 'uglink-container-route-'));
  directories.push(directory);
  const source = new NodeProcessLogStore(directory);
  source.append('stdout', `[startup] ready ${token}`);
  const env = { ...environment(), CONTAINER_LOGS: source };
  const credentials = await session(env);
  const response = await worker.fetch(request(credentials.cookie, credentials.csrfToken), env);
  const reader = response.body!.getReader();
  let text = '';
  while (!text.includes('event: log')) text += new TextDecoder().decode((await reader.read()).value);
  await reader.cancel();
  expect(text).toContain('[startup] ready');
  expect(text).toContain('"source":"container"');
  expect(text).toContain('"stream":"stdout"');
  expect(text).not.toContain(token);
  expect(readFileSync(join(directory, 'console.jsonl'), 'utf8')).not.toContain(token);
});

it('registers new connection credentials before provider operations can write errors', async () => {
  const { NodeProcessLogStore } = await import('../../src/infrastructure/logging/node-process-logs');
  const directory = mkdtempSync(join(tmpdir(), 'uglink-container-auth-'));
  directories.push(directory);
  const source = new NodeProcessLogStore(directory);
  const env = { ...environment(), CONTAINER_LOGS: source };
  const credentials = await session(env, false);
  vi.stubGlobal('fetch', vi.fn(async () => {
    source.append('stderr', `native rejected ${token}`);
    return Response.json({ success: false, errors: [{ code: 10000, message: 'denied' }] }, { status: 403 });
  }));
  const response = await worker.fetch(new Request(`${origin}/api/connections/cloudflare`, { method: 'POST', headers: {
    cookie: credentials.cookie, origin, 'x-csrf-token': credentials.csrfToken, 'content-type': 'application/json'
  }, body: JSON.stringify({ accountId: 'a'.repeat(32), workerName: 'worker', apiToken: token }) }), env);
  expect(response.status).not.toBe(200);
  expect(readFileSync(join(directory, 'console.jsonl'), 'utf8')).toContain('native rejected');
  expect(readFileSync(join(directory, 'console.jsonl'), 'utf8')).not.toContain(token);
});
