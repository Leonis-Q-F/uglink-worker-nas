import { afterEach, describe, expect, it, vi } from 'vitest';
import type { BootstrapResponse } from '../../src/application/console/contracts';
import worker from '../../src/interfaces/http/console/worker';
import type { ConsoleWorkerEnv } from '../../src/interfaces/http/console/environment';
import { toBase64Url } from '../../src/infrastructure/security/session-crypto';

const ORIGIN = 'http://console.test';
const ACCOUNT_ID = '0123456789abcdef0123456789abcdef';
const API_TOKEN = 'cloudflare-api-token-used-only-for-testing';

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
    expect(calls).toHaveLength(3);
    expect(calls.every((call) => call.authorization === `Bearer ${API_TOKEN}`)).toBe(true);
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
