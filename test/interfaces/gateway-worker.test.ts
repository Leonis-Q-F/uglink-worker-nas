import assert from 'node:assert/strict';
import { generateKeyPairSync } from 'node:crypto';
import test from 'node:test';
import worker from '../../src/interfaces/http/gateway/worker';
import type { GatewayWorkerEnv } from '../../src/interfaces/http/gateway/environment';
import { cacheKeys, discoveryCacheKey } from '../../src/infrastructure/ugreen/session-service';

function fakeKv(initialValues: Record<string, string>): {
  namespace: KVNamespace;
  values: Map<string, string>;
} {
  const values = new Map(Object.entries(initialValues));
  return {
    values,
    namespace: {
      async get(key: string) {
        return values.get(key) ?? null;
      },
      async put(key: string, value: string | ArrayBuffer | ArrayBufferView | ReadableStream) {
        values.set(key, String(value));
      },
      async delete(key: string) {
        values.delete(key);
      }
    } as KVNamespace
  };
}

function cachedEnvironment(): {
  env: GatewayWorkerEnv;
  values: Map<string, string>;
  keys: { session: string };
} {
  const keys = cacheKeys('stable-client-id', '8317');
  const kv = fakeKv({
    [keys.session]: JSON.stringify({
      cookie: 'ugreen-proxy-token=cached-session',
      origin: 'https://proxy.example.test',
      loginOrigin: 'https://test-device.example.ug.link'
    })
  });
  return {
    keys,
    values: kv.values,
    env: {
      UGLINK_CACHE: kv.namespace,
      UGLINK_ID: 'test-device',
      USERNAME: 'test-user',
      PASSWORD: 'test-password',
      SERVICE_MAP: '{"service.example.com":"8317"}',
      SETUP_MODE: 'false',
      SESSION_NAMESPACE: 'stable-client-id'
    }
  };
}

function installSuccessfulLoginFetch(
  publicKey: string,
  proxyResponse: (call: number) => Response
): { fetch: typeof globalThis.fetch; proxyCalls: () => number; loginCalls: () => number } {
  const encodedPublicKey = Buffer.from(publicKey).toString('base64');
  let proxyCallCount = 0;
  let loginCallCount = 0;

  const fetch: typeof globalThis.fetch = async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    if (url === 'https://proxy.example.test/v1/models') {
      proxyCallCount += 1;
      assert.equal(init?.redirect, 'manual');
      return proxyResponse(proxyCallCount);
    }
    if (url === 'https://api-zh.ugnas.com/api/p2p/v2/ta/nodeInfo/byAlias') {
      return Response.json({ code: 200, data: { alias: 'test-device', relayDomain: 'example.ug.link' } });
    }
    if (url === 'https://test-device.example.ug.link/ugreen/v1/verify/check') {
      return new Response(null, { headers: { 'X-Rsa-Token': encodedPublicKey } });
    }
    if (url === 'https://test-device.example.ug.link/ugreen/v1/verify/login') {
      loginCallCount += 1;
      return new Response(JSON.stringify({
        code: 200,
        data: {
          public_key: encodedPublicKey,
          token: 'temporary-token',
          token_id: 'token-id'
        }
      }));
    }
    if (url === 'https://test-device.example.ug.link/ugreen/v1/gateway/proxy/dockerToken?port=8317') {
      return new Response(JSON.stringify({
        code: 200,
        data: { redirect_url: 'https://proxy.example.test/auth' }
      }));
    }
    if (url === 'https://proxy.example.test/auth') {
      return new Response(null, {
        status: 302,
        headers: { 'Set-Cookie': 'ugreen-proxy-token=fresh-session; Path=/; Secure' }
      });
    }
    throw new Error(`Unexpected request: ${url}`);
  };

  return {
    fetch,
    proxyCalls: () => proxyCallCount,
    loginCalls: () => loginCallCount
  };
}

test('application 401 and 403 responses pass through without refreshing UGREEN', async (context) => {
  const originalFetch = globalThis.fetch;
  context.after(() => {
    globalThis.fetch = originalFetch;
  });

  for (const status of [401, 403]) {
    const { env, values, keys } = cachedEnvironment();
    let calls = 0;
    globalThis.fetch = async (_input: RequestInfo | URL, init?: RequestInit) => {
      calls += 1;
      assert.equal(init?.redirect, 'manual');
      return new Response(JSON.stringify({ error: 'application authentication failed' }), {
        status,
        headers: { 'Content-Type': 'application/json' }
      });
    };

    const response = await worker.fetch(new Request('https://service.example.com/v1/models'), env);

    assert.equal(response.status, status);
    assert.equal(calls, 1);
    assert.equal(JSON.parse(values.get(keys.session) ?? '').cookie, 'ugreen-proxy-token=cached-session');
  }
});

test('a UGREEN login redirect refreshes the session and retries a GET once', async (context) => {
  const originalFetch = globalThis.fetch;
  context.after(() => {
    globalThis.fetch = originalFetch;
  });
  const { publicKey } = generateKeyPairSync('rsa', {
    modulusLength: 1024,
    publicKeyEncoding: { type: 'spki', format: 'pem' },
    privateKeyEncoding: { type: 'pkcs8', format: 'pem' }
  });
  const loginRedirect = () => new Response(null, {
    status: 302,
    headers: { Location: 'http://test-device.example.ug.link/desktop/#/login/account' }
  });
  const mocked = installSuccessfulLoginFetch(
    publicKey,
    (call) => call === 1 ? loginRedirect() : new Response('proxied')
  );
  globalThis.fetch = mocked.fetch;
  const { env, values, keys } = cachedEnvironment();

  const response = await worker.fetch(new Request('https://service.example.com/v1/models'), env);

  assert.equal(response.status, 200);
  assert.equal(await response.text(), 'proxied');
  assert.equal(mocked.proxyCalls(), 2);
  assert.equal(mocked.loginCalls(), 1);
  assert.equal(JSON.parse(values.get(keys.session) ?? '').cookie, 'ugreen-proxy-token=fresh-session');
});

test('an upstream network failure forces rediscovery and retries a GET once', async (context) => {
  const originalFetch = globalThis.fetch;
  context.after(() => {
    globalThis.fetch = originalFetch;
  });
  const { publicKey } = generateKeyPairSync('rsa', {
    modulusLength: 1024,
    publicKeyEncoding: { type: 'spki', format: 'pem' },
    privateKeyEncoding: { type: 'pkcs8', format: 'pem' }
  });
  const mocked = installSuccessfulLoginFetch(publicKey, (call) => {
    if (call === 1) throw new Error('stale proxy origin');
    return new Response('proxied after rediscovery');
  });
  globalThis.fetch = mocked.fetch;
  const { env, values, keys } = cachedEnvironment();

  const response = await worker.fetch(new Request('https://service.example.com/v1/models'), env);

  assert.equal(response.status, 200);
  assert.equal(await response.text(), 'proxied after rediscovery');
  assert.equal(mocked.proxyCalls(), 2);
  assert.equal(mocked.loginCalls(), 1);
  assert.equal(JSON.parse(values.get(keys.session) ?? '').loginOrigin, 'https://test-device.example.ug.link');
});

test('a request with a body is not replayed after a UGREEN login redirect', async (context) => {
  const originalFetch = globalThis.fetch;
  context.after(() => {
    globalThis.fetch = originalFetch;
  });
  const { env, values, keys } = cachedEnvironment();
  let calls = 0;
  globalThis.fetch = async () => {
    calls += 1;
    return new Response(null, {
      status: 302,
      headers: { Location: 'http://test-device.example.ug.link/desktop/#/login/account' }
    });
  };

  const response = await worker.fetch(new Request('https://service.example.com/v1/messages', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ message: 'hello' })
  }), env);

  assert.equal(response.status, 503);
  assert.equal(response.headers.get('x-uglink-error'), 'proxy_session_expired');
  assert.equal(response.headers.get('retry-after'), '0');
  assert.equal(calls, 1);
  assert.equal(values.has(keys.session), false);
  assert.equal(values.has(discoveryCacheKey('stable-client-id')), false);
});

test('an ambiguous network failure never asks clients to replay a request body', async (context) => {
  const originalFetch = globalThis.fetch;
  context.after(() => {
    globalThis.fetch = originalFetch;
  });
  const { env, values, keys } = cachedEnvironment();
  let calls = 0;
  globalThis.fetch = async () => {
    calls += 1;
    throw new Error('connection closed after sending request');
  };

  const response = await worker.fetch(new Request('https://service.example.com/v1/messages', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ message: 'hello' })
  }), env);

  assert.equal(response.status, 502);
  assert.equal(response.headers.get('x-uglink-error'), 'proxy_session_unavailable');
  assert.equal(response.headers.has('retry-after'), false);
  assert.equal(calls, 1);
  assert.equal(values.has(keys.session), false);
});

test('a renewed session is never retried more than once', async (context) => {
  const originalFetch = globalThis.fetch;
  context.after(() => {
    globalThis.fetch = originalFetch;
  });
  const { publicKey } = generateKeyPairSync('rsa', {
    modulusLength: 1024,
    publicKeyEncoding: { type: 'spki', format: 'pem' },
    privateKeyEncoding: { type: 'pkcs8', format: 'pem' }
  });
  const mocked = installSuccessfulLoginFetch(publicKey, () => new Response(null, {
    status: 302,
    headers: { Location: 'http://test-device.example.ug.link/desktop/#/login/account' }
  }));
  globalThis.fetch = mocked.fetch;
  const { env, values, keys } = cachedEnvironment();

  const response = await worker.fetch(new Request('https://service.example.com/v1/models'), env);

  assert.equal(response.status, 502);
  assert.equal(response.headers.get('x-uglink-error'), 'proxy_session_unavailable');
  assert.equal(mocked.proxyCalls(), 2);
  assert.equal(mocked.loginCalls(), 1);
  assert.equal(values.has(keys.session), false);
});

test('a failed send after refresh clears the renewed session', async (context) => {
  const originalFetch = globalThis.fetch;
  context.after(() => {
    globalThis.fetch = originalFetch;
  });
  const { publicKey } = generateKeyPairSync('rsa', {
    modulusLength: 1024,
    publicKeyEncoding: { type: 'spki', format: 'pem' },
    privateKeyEncoding: { type: 'pkcs8', format: 'pem' }
  });
  const mocked = installSuccessfulLoginFetch(publicKey, (call) => {
    if (call === 1) {
      return new Response(null, {
        status: 302,
        headers: { Location: 'http://test-device.example.ug.link/desktop/#/login/account' }
      });
    }
    throw new Error('renewed proxy origin failed');
  });
  globalThis.fetch = mocked.fetch;
  const { env, values, keys } = cachedEnvironment();

  const response = await worker.fetch(new Request('https://service.example.com/v1/models'), env);

  assert.equal(response.status, 502);
  assert.equal(mocked.proxyCalls(), 2);
  assert.equal(mocked.loginCalls(), 1);
  assert.equal(values.has(keys.session), false);
  assert.equal(values.has(discoveryCacheKey('stable-client-id')), false);
});
