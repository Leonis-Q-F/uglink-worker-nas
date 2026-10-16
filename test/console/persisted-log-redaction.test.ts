import { afterEach, expect, it, vi } from 'vitest';
import type { ConsoleStore } from '../../src/application/console/ports';
import type { DeploymentJob, DiagnosticEntry } from '../../src/domain/deployment/model';
import { createKvDeploymentJobRepository } from '../../src/infrastructure/persistence/kv-deployment-job-repository';
import { createKvDiagnosticLogRepository } from '../../src/infrastructure/persistence/kv-diagnostic-log-repository';
import worker from '../../src/interfaces/http/console/worker';
import { getOrCreateSession, saveSession } from '../../src/infrastructure/persistence/console-session';
import { defaultConfig } from '../../src/domain/configuration/defaults';

const secret = 'opaque-current-cloud-credential';
afterEach(() => { vi.unstubAllGlobals(); });
function storage() {
  const values = new Map<string, string>();
  const store = {
    async get(key: string, type?: string) {
      const value = values.get(key) ?? null;
      return value && type === 'json' ? JSON.parse(value) as unknown : value;
    },
    async put(key: string, value: string) { values.set(key, value); },
    async delete(key: string) { values.delete(key); }
  } as ConsoleStore;
  return { store, values };
}
function diagnostic(index: number): DiagnosticEntry {
  return { id: `row-${index}`, source: 'health_check', severity: 'error', code: 'native', stage: 'service_entry',
    summary: `native ${secret}`, detail: `response ${secret}`, data: { response: { body: `failed ${secret}` } },
    firstObservedAt: new Date().toISOString(), lastObservedAt: new Date().toISOString(), occurrences: 1 };
}

it('redacts session secrets before diagnostic append and backup replacement enter storage, retaining all typed rows', async () => {
  const { store, values } = storage();
  const repository = createKvDiagnosticLogRepository(store, 'session', { accountId: 'account', workerName: 'worker' }, [secret]);
  await repository.append(Array.from({ length: 100 }, (_, index) => diagnostic(index)));
  expect(JSON.stringify([...values.values()])).not.toContain(secret);
  expect(await repository.list(100)).toHaveLength(100);
  expect((await repository.list(100)).every((entry) => entry.occurrences === 1 && entry.id.startsWith('row-'))).toBe(true);
  await repository.replace([diagnostic(101)]);
  expect(JSON.stringify([...values.values()])).not.toContain(secret);
  expect((await repository.list())[0]?.data).toMatchObject({ response: { body: 'failed [REDACTED]' } });
});

it('redacts native deployment messages, health payloads and failure stacks before storing jobs without altering state fields', async () => {
  const { store, values } = storage();
  const repository = createKvDeploymentJobRepository(store, 'session', [secret]);
  const job: DeploymentJob = { id: 'job', phase: 'failed', mode: 'publish', passwordUpdated: true,
    accountId: 'account', accountName: 'Test', workerName: 'worker', createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(),
    message: `failed ${secret}`, timeline: [{ phase: 'failed', label: 'failed', detail: `error ${secret}`, at: new Date().toISOString() }],
    services: [{ hostname: 'app.example.test', healthy: false, detail: `native ${secret}`, data: { response: { body: secret } } }],
    failure: { phase: 'uploading', stage: 'worker_upload', code: 'native', summary: `failure ${secret}`, detail: `cause ${secret}`,
      data: { error: { stack: `Error: ${secret}\n at native` } } } };
  await repository.save(job);
  expect(JSON.stringify([...values.values()])).not.toContain(secret);
  expect(await repository.read('job')).toMatchObject({ passwordUpdated: true, phase: 'failed', services: [{ healthy: false }] });
  expect((await repository.read('job'))?.failure?.data).toMatchObject({ error: { stack: 'Error: [REDACTED]\n at native' } });
});

it('wires authenticated session secrets into HTTP health-check persistence', async () => {
  const { store, values } = storage();
  const env = { CONSOLE_SESSIONS: store, SESSION_ENCRYPTION_KEY: 'a'.repeat(43) };
  const origin = 'https://console.example.test';
  const handle = await getOrCreateSession(new Request(origin), env);
  handle.data.cloudflare = { apiToken: secret, account: { id: 'account', name: 'Test' }, connectedAt: Date.now() };
  handle.data.target = { accountId: 'account', accountName: 'Test', workerName: 'worker' };
  await saveSession(env, handle);
  const config = defaultConfig();
  config.uglink = { id: 'test-device', username: 'test-user' };
  config.services = [{ name: 'app', hostname: 'app.example.test', port: 8080, enabled: true }];
  vi.stubGlobal('fetch', vi.fn(async () => Response.json({ status: 'ok', hostnameConfigured: true, debug: `native ${secret}` })));
  const response = await worker.fetch(new Request(`${origin}/api/services/health`, { method: 'POST', headers: {
    cookie: `uglink_console_session=${handle.id}`, origin, 'x-csrf-token': handle.data.csrfToken, 'content-type': 'application/json'
  }, body: JSON.stringify({ config }) }), env);
  expect(response.status).toBe(200);
  const saved = [...values].filter(([key]) => key.startsWith('diagnostics:')).map(([, value]) => value).join('');
  expect(saved).toContain('native');
  expect(saved.includes(secret)).toBe(false);
});
