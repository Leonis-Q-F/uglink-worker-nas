import { afterEach, expect, it, vi } from 'vitest';
import worker from '../../src/interfaces/http/console/worker';
import type { ConsoleWorkerEnv } from '../../src/interfaces/http/console/environment';
import { getOrCreateSession, saveSession } from '../../src/infrastructure/persistence/console-session';

const origin = 'https://console.example.test';
const token = 'session-api-secret-for-tail-testing';
function environment(): ConsoleWorkerEnv {
  const values = new Map<string, string>();
  return {
    SESSION_ENCRYPTION_KEY: 'a'.repeat(43),
    CONSOLE_SESSIONS: {
      get: async (key: string, type?: string) => { const value = values.get(key) ?? null; return value && type === 'json' ? JSON.parse(value) as unknown : value; },
      put: async (key: string, value: string) => { values.set(key, value); },
      delete: async (key: string) => { values.delete(key); }
    } as ConsoleWorkerEnv['CONSOLE_SESSIONS']
  };
}
async function session(env: ConsoleWorkerEnv, connected: boolean) {
  const handle = await getOrCreateSession(new Request(origin), env);
  if (connected) {
    handle.data.cloudflare = { apiToken: token, account: { id: 'account', name: 'Test' }, connectedAt: Date.now() };
    handle.data.target = { accountId: 'account', accountName: 'Test', workerName: 'worker' };
    await saveSession(env, handle);
  }
  return { cookie: `uglink_console_session=${handle.id}`, csrfToken: handle.data.csrfToken };
}
function request(cookie: string, csrfToken?: string, requestOrigin = origin) {
  return new Request(`${origin}/api/diagnostics/stream`, { method: 'POST', headers: {
    cookie, origin: requestOrigin, ...(csrfToken ? { 'x-csrf-token': csrfToken } : {})
  } });
}
afterEach(() => { vi.restoreAllMocks(); vi.unstubAllGlobals(); });

it('requires a connected session, same-origin and valid CSRF before starting a Tail', async () => {
  const env = environment();
  const { cookie, csrfToken } = await session(env, false);
  expect((await worker.fetch(request(cookie, csrfToken), env)).status).toBe(401);
  expect((await worker.fetch(request(cookie), env)).status).toBe(403);
  expect((await worker.fetch(request(cookie, csrfToken, 'https://other.example.test'), env)).status).toBe(403);
});

it('returns Tail permission errors inside SSE and retains the existing authenticated session', async () => {
  const env = environment();
  const { cookie, csrfToken } = await session(env, true);
  vi.stubGlobal('fetch', vi.fn(async () => Response.json({ success: false, errors: [{ code: 10000, message: `Workers Tail Read denied ${token}` }] }, { status: 403 })));
  const response = await worker.fetch(request(cookie, csrfToken), env);
  expect(response.status).toBe(200);
  expect(response.headers.get('content-type')).toContain('text/event-stream');
  const text = await response.text();
  expect(text).toContain('event: status');
  expect(text).toContain('"state":"error"');
  expect(text).toContain('Workers Tail Read');
  expect(text).not.toContain(token);
  const bootstrap = await worker.fetch(new Request(`${origin}/api/bootstrap`, { headers: { cookie } }), env);
  expect(await bootstrap.json()).toMatchObject({ authenticated: true });
});

it('redacts exact session-token literals in stored diagnostic messages before returning them', async () => {
  const env = environment();
  const { cookie } = await session(env, true);
  const { createKvDiagnosticLogRepository } = await import('../../src/infrastructure/persistence/kv-diagnostic-log-repository');
  await createKvDiagnosticLogRepository(env.CONSOLE_SESSIONS, cookie.split('=')[1]!, { accountId: 'account', workerName: 'worker' }).append([{
    id: 'fixture', source: 'health_check', severity: 'error', stage: 'service_entry', code: 'native',
    summary: `native failure ${token}`, firstObservedAt: new Date().toISOString(), lastObservedAt: new Date().toISOString(), occurrences: 1
  }]);
  const response = await worker.fetch(new Request(`${origin}/api/diagnostics`, { headers: { cookie } }), env);
  const text = await response.text();
  expect(response.status).toBe(200);
  expect(text).toContain('native failure');
  expect(text).not.toContain(token);
});

it('preserves all 100 typed diagnostic records while independently bounding their freeform payloads', async () => {
  const env = environment();
  const { cookie } = await session(env, true);
  const { createKvDiagnosticLogRepository } = await import('../../src/infrastructure/persistence/kv-diagnostic-log-repository');
  const entries = Array.from({ length: 100 }, (_, index) => ({
    id: `fixture-${index}`, source: 'health_check' as const, severity: 'info' as const, stage: 'service_entry' as const, code: 'native',
    summary: `record ${index} ${token}`, data: { nested: Array.from({ length: 50 }, () => ({ useful: true })) },
    firstObservedAt: new Date().toISOString(), lastObservedAt: new Date().toISOString(), occurrences: 1
  }));
  await createKvDiagnosticLogRepository(env.CONSOLE_SESSIONS, cookie.split('=')[1]!, { accountId: 'account', workerName: 'worker' }).replace(entries);
  const response = await worker.fetch(new Request(`${origin}/api/diagnostics`, { headers: { cookie } }), env);
  const result = await response.json() as { entries: { id: string; summary: string }[] };
  expect(result.entries).toHaveLength(100);
  expect(result.entries.every((entry) => typeof entry.id === 'string' && typeof entry.summary === 'string')).toBe(true);
  expect(JSON.stringify(result)).not.toContain(token);
});

it('preserves deployment passwordUpdated booleans and sanitizes native job failure messages', async () => {
  const env = environment();
  const { cookie } = await session(env, true);
  const { createKvDeploymentJobRepository } = await import('../../src/infrastructure/persistence/kv-deployment-job-repository');
  await createKvDeploymentJobRepository(env.CONSOLE_SESSIONS, cookie.split('=')[1]!).save({
    id: 'test-deployment-id', mode: 'publish', phase: 'failed', createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(),
    passwordUpdated: true, message: `native ${token}`, workerName: 'worker', accountId: 'account', accountName: 'Test', services: [],
    failure: { phase: 'uploading', stage: 'worker_upload', code: 'native', summary: `failure ${token}`, data: { token } }, timeline: []
  });
  const response = await worker.fetch(new Request(`${origin}/api/deployments/test-deployment-id`, { headers: { cookie } }), env);
  const result = await response.json() as { passwordUpdated: boolean; failure: unknown };
  expect(result.passwordUpdated).toBe(true);
  expect(JSON.stringify(result.failure)).toContain('failure');
  expect(JSON.stringify(result)).not.toContain(token);
});
