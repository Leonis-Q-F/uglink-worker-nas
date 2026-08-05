import { afterEach, describe, expect, it, vi } from 'vitest';
import type { BootstrapResponse } from '../../src/application/console/contracts';
import { defaultConfig } from '../../src/domain/configuration/defaults';
import type { UglinkConfig } from '../../src/domain/configuration/model';
import worker from '../../src/interfaces/http/console/worker';
import type { ConsoleWorkerEnv } from '../../src/interfaces/http/console/environment';
import { toBase64Url } from '../../src/infrastructure/security/session-crypto';

const ORIGIN = 'http://console.test';
const ACCOUNT_ID = '0123456789abcdef0123456789abcdef';
const API_TOKEN = 'cloudflare-api-token-used-only-for-testing';

function deployedConfig(): UglinkConfig {
  const config = defaultConfig();
  config.uglink = {
    baseUrl: 'https://device.example.test',
    username: 'test-user'
  };
  config.services = [{
    name: 'nas',
    hostname: 'nas.example.com',
    port: 9443,
    enabled: true
  }];
  config.deployment = { workersDev: false, previewUrls: false };
  return config;
}

function envelope(result: unknown, status = 200): Response {
  return new Response(JSON.stringify({
    success: status >= 200 && status < 300,
    result,
    errors: status >= 400 ? [{ code: 10000, message: 'mock authorization failure' }] : []
  }), { status, headers: { 'Content-Type': 'application/json' } });
}

function fakeKv(): { namespace: KVNamespace; values: Map<string, string> } {
  const values = new Map<string, string>();
  const namespace = {
    async get(key: string, type?: string) {
      const value = values.get(key) ?? null;
      if (type === 'json' && value) return JSON.parse(value) as unknown;
      return value;
    },
    async put(key: string, value: string | ArrayBuffer | ArrayBufferView | ReadableStream) {
      values.set(key, String(value));
    },
    async delete(key: string) {
      values.delete(key);
    }
  } as KVNamespace;
  return { namespace, values };
}

function environment(): { env: ConsoleWorkerEnv; values: Map<string, string> } {
  const { namespace, values } = fakeKv();
  return {
    env: {
      CONSOLE_SESSIONS: namespace,
      CONSOLE_TITLE: 'UGLINK Control',
      SESSION_ENCRYPTION_KEY: toBase64Url(new Uint8Array(32).fill(7))
    },
    values
  };
}

async function openSession(env: ConsoleWorkerEnv): Promise<{ cookie: string; bootstrap: BootstrapResponse }> {
  const response = await worker.fetch(new Request(`${ORIGIN}/api/bootstrap`), env);
  const cookie = response.headers.get('set-cookie')?.split(';')[0];
  if (!cookie) throw new Error('Session cookie was not created.');
  return { cookie, bootstrap: await response.json() as BootstrapResponse };
}

function connectionRequest(cookie: string, csrfToken: string): Request {
  return new Request(`${ORIGIN}/api/connections/cloudflare`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Cookie: cookie,
      Origin: ORIGIN,
      'X-CSRF-Token': csrfToken
    },
    body: JSON.stringify({
      accountId: ACCOUNT_ID,
      apiToken: API_TOKEN,
      workerName: 'uglink-test'
    })
  });
}

function cloudConfigurationRequest(path: 'import' | 'dismiss', cookie: string, csrfToken: string): Request {
  return new Request(`${ORIGIN}/api/configuration/cloud/${path}`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Cookie: cookie,
      Origin: ORIGIN,
      'X-CSRF-Token': csrfToken
    },
    body: '{}'
  });
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe('Cloudflare API Token connection', () => {
  it('reports container liveness without creating a console session', async () => {
    const { env, values } = environment();
    const response = await worker.fetch(new Request(`${ORIGIN}/api/health`), env);

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({ status: 'ok' });
    expect(response.headers.has('set-cookie')).toBe(false);
    expect(values.size).toBe(0);
  });

  it('verifies required resources and stores the token only inside the encrypted server session', async () => {
    const calls: Array<{ url: string; authorization: string | null }> = [];
    vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      calls.push({
        url,
        authorization: new Headers(init?.headers).get('Authorization')
      });
      if (url.endsWith(`/accounts/${ACCOUNT_ID}`)) {
        return envelope({ id: ACCOUNT_ID, name: 'Test Account' });
      }
      if (url.endsWith(`/accounts/${ACCOUNT_ID}/workers/domains`)) return envelope([]);
      if (url.includes(`/accounts/${ACCOUNT_ID}/storage/kv/namespaces`)) return envelope([]);
      if (url.endsWith(`/accounts/${ACCOUNT_ID}/workers/scripts/uglink-test/settings`)) {
        return envelope(null, 404);
      }
      throw new Error(`Unexpected fetch: ${url}`);
    }));

    const { env, values } = environment();
    const initial = await openSession(env);
    expect(initial.bootstrap.authenticated).toBe(false);

    const response = await worker.fetch(connectionRequest(initial.cookie, initial.bootstrap.csrfToken), env);
    const body = await response.json() as BootstrapResponse;

    expect(response.status).toBe(200);
    expect(body.authenticated).toBe(true);
    expect(body.target).toMatchObject({
      accountId: ACCOUNT_ID,
      accountName: 'Test Account',
      workerName: 'uglink-test'
    });
    expect(JSON.stringify(body)).not.toContain(API_TOKEN);
    expect([...values.values()].every((value) => !value.includes(API_TOKEN))).toBe(true);
    expect(calls).toHaveLength(4);
    expect(calls.every((call) => call.authorization === `Bearer ${API_TOKEN}`)).toBe(true);
  });

  it('offers a managed Worker configuration and imports it only after confirmation', async () => {
    const cloudConfig = deployedConfig();
    vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.endsWith(`/accounts/${ACCOUNT_ID}`)) {
        return envelope({ id: ACCOUNT_ID, name: 'Test Account' });
      }
      if (url.endsWith(`/accounts/${ACCOUNT_ID}/workers/domains`)) return envelope([]);
      if (url.includes(`/accounts/${ACCOUNT_ID}/storage/kv/namespaces?`)) return envelope([]);
      if (url.endsWith(`/accounts/${ACCOUNT_ID}/workers/scripts/uglink-test/settings`)) {
        return envelope({
          bindings: [
            { name: 'UGLINK_CONTROL_MANAGED', type: 'plain_text', text: 'v1' },
            { name: 'UGLINK_CACHE', type: 'kv_namespace', namespace_id: 'namespace-id' }
          ]
        });
      }
      if (url.endsWith(
        `/accounts/${ACCOUNT_ID}/storage/kv/namespaces/namespace-id/values/uglink-control%3Aconfiguration%3Av1`
      )) {
        return new Response(JSON.stringify(cloudConfig), {
          headers: { 'Content-Type': 'application/json' }
        });
      }
      throw new Error(`Unexpected fetch: ${url}`);
    }));

    const { env } = environment();
    const initial = await openSession(env);
    const response = await worker.fetch(connectionRequest(initial.cookie, initial.bootstrap.csrfToken), env);
    const body = await response.json() as BootstrapResponse;

    expect(response.status).toBe(200);
    expect(body.cloudConfiguration).toEqual({ serviceCount: 1 });
    expect(body.configuration?.deployed).toEqual(defaultConfig());

    const dismissedResponse = await worker.fetch(
      cloudConfigurationRequest('dismiss', initial.cookie, initial.bootstrap.csrfToken),
      env
    );
    expect(dismissedResponse.status).toBe(200);
    const afterDismiss = await worker.fetch(new Request(`${ORIGIN}/api/bootstrap`, {
      headers: { Cookie: initial.cookie }
    }), env);
    const dismissed = await afterDismiss.json() as BootstrapResponse;
    expect(dismissed.cloudConfiguration).toBeUndefined();
    expect(dismissed.configuration?.deployed).toEqual(defaultConfig());

    const reconnectedResponse = await worker.fetch(
      connectionRequest(initial.cookie, initial.bootstrap.csrfToken),
      env
    );
    const reconnected = await reconnectedResponse.json() as BootstrapResponse;
    expect(reconnected.cloudConfiguration).toEqual({ serviceCount: 1 });

    const importedResponse = await worker.fetch(
      cloudConfigurationRequest('import', initial.cookie, initial.bootstrap.csrfToken),
      env
    );
    const imported = await importedResponse.json() as BootstrapResponse;
    expect(importedResponse.status).toBe(200);
    expect(imported.cloudConfiguration).toBeUndefined();
    expect(imported.configuration?.deployed).toEqual(cloudConfig);
    expect(imported.configuration?.draft).toBeUndefined();
  });

  it('refuses to connect to an unrelated Worker with the same name', async () => {
    vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.endsWith(`/accounts/${ACCOUNT_ID}`)) {
        return envelope({ id: ACCOUNT_ID, name: 'Test Account' });
      }
      if (url.endsWith(`/accounts/${ACCOUNT_ID}/workers/domains`)) return envelope([]);
      if (url.includes(`/accounts/${ACCOUNT_ID}/storage/kv/namespaces`)) return envelope([]);
      if (url.endsWith(`/accounts/${ACCOUNT_ID}/workers/scripts/uglink-test/settings`)) {
        return envelope({ bindings: [{ name: 'OTHER_APP', type: 'plain_text', text: 'true' }] });
      }
      throw new Error(`Unexpected fetch: ${url}`);
    }));

    const { env } = environment();
    const initial = await openSession(env);
    const response = await worker.fetch(connectionRequest(initial.cookie, initial.bootstrap.csrfToken), env);
    const body = await response.json() as { error: { code: string } };

    expect(response.status).toBe(409);
    expect(body.error.code).toBe('cloudflare_worker_name_conflict');
  });

  it('does not infer configuration when the cloud configuration record is missing', async () => {
    vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.endsWith(`/accounts/${ACCOUNT_ID}`)) {
        return envelope({ id: ACCOUNT_ID, name: 'Test Account' });
      }
      if (url.endsWith(`/accounts/${ACCOUNT_ID}/workers/domains`)) return envelope([]);
      if (url.includes(`/accounts/${ACCOUNT_ID}/storage/kv/namespaces?`)) return envelope([]);
      if (url.endsWith(`/accounts/${ACCOUNT_ID}/workers/scripts/uglink-test/settings`)) {
        return envelope({
          bindings: [
            { name: 'UGLINK_CONTROL_MANAGED', type: 'plain_text', text: 'v1' },
            { name: 'UGLINK_CACHE', type: 'kv_namespace', namespace_id: 'namespace-id' }
          ]
        });
      }
      if (url.endsWith('/values/uglink-control%3Aconfiguration%3Av1')) return envelope(null, 404);
      throw new Error(`Unexpected fetch: ${url}`);
    }));

    const { env } = environment();
    const initial = await openSession(env);
    const response = await worker.fetch(connectionRequest(initial.cookie, initial.bootstrap.csrfToken), env);
    const body = await response.json() as { error: { code: string } };

    expect(response.status).toBe(502);
    expect(body.error.code).toBe('cloudflare_configuration_invalid');
  });

  it('rejects a token that cannot access both Workers and Workers KV', async () => {
    vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.endsWith(`/accounts/${ACCOUNT_ID}`)) {
        return envelope({ id: ACCOUNT_ID, name: 'Test Account' });
      }
      if (url.endsWith(`/accounts/${ACCOUNT_ID}/workers/domains`)) return envelope(null, 403);
      if (url.includes(`/accounts/${ACCOUNT_ID}/storage/kv/namespaces`)) return envelope([]);
      throw new Error(`Unexpected fetch: ${url}`);
    }));

    const { env, values } = environment();
    const initial = await openSession(env);
    const response = await worker.fetch(connectionRequest(initial.cookie, initial.bootstrap.csrfToken), env);
    const body = await response.json() as { error: { code: string; message: string } };

    expect(response.status).toBe(403);
    expect(body.error.code).toBe('cloudflare_permissions_missing');
    expect(body.error.message).toContain('API Token');
    expect([...values.values()].every((value) => !value.includes(API_TOKEN))).toBe(true);
  });
});
