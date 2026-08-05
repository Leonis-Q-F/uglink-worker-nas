import assert from 'node:assert/strict';
import { generateKeyPairSync } from 'node:crypto';
import test from 'node:test';
import {
  cacheKeys,
  createProxySession,
  discoveryCacheKey
} from '../../src/infrastructure/ugreen/session-service';
import { ProxyAuthenticationError, proxyFailureCode } from '../../src/domain/proxy/errors';

function fakeKv(initialValues: Record<string, string> = {}): {
  cache: KVNamespace;
  values: Map<string, string>;
  ttls: Map<string, number | undefined>;
} {
  const values = new Map(Object.entries(initialValues));
  const ttls = new Map<string, number | undefined>();
  return {
    values,
    ttls,
    cache: {
      async get(key: string) {
        return values.get(key) ?? null;
      },
      async put(key: string, value: string | ArrayBuffer | ArrayBufferView | ReadableStream, options?: KVNamespacePutOptions) {
        values.set(key, String(value));
        ttls.set(key, options?.expirationTtl);
      },
      async delete(key: string) {
        values.delete(key);
      }
    } as KVNamespace
  };
}

function rsaPublicKey(): string {
  const { publicKey } = generateKeyPairSync('rsa', {
    modulusLength: 1024,
    publicKeyEncoding: { type: 'spki', format: 'pem' },
    privateKeyEncoding: { type: 'pkcs8', format: 'pem' }
  });
  return Buffer.from(publicKey).toString('base64');
}

function successfulLoginResponse(encodedPublicKey: string): Response {
  return Response.json({
    code: 200,
    data: {
      public_key: encodedPublicKey,
      token: 'temporary-token',
      token_id: 'token-id'
    }
  });
}

function runtime(cache: KVNamespace) {
  return {
    uglinkId: 'my-nas',
    username: 'nas-user',
    password: 'test-password',
    sessionNamespace: 'stable-client-id',
    cache
  };
}

test('cache keys isolate discovery and sessions by namespace and port', () => {
  assert.equal(discoveryCacheKey('account-a'), 'uglink:discovery:v1:account-a');
  assert.deepEqual(cacheKeys('account-a', '8317'), {
    session: 'uglink:session:v2:account-a:8317'
  });
  assert.notDeepEqual(cacheKeys('account-a', '8317'), cacheKeys('account-b', '8317'));
});

test('runtime discovery is cached for five minutes and creates an atomic proxy session', async (context) => {
  const encodedPublicKey = rsaPublicKey();
  const originalFetch = globalThis.fetch;
  const requestedUrls: string[] = [];
  context.after(() => {
    globalThis.fetch = originalFetch;
  });
  globalThis.fetch = async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    requestedUrls.push(url);
    if (url === 'https://api-zh.ugnas.com/api/p2p/v2/ta/nodeInfo/byAlias') {
      assert.equal(init?.body, JSON.stringify({ alias: 'my-nas' }));
      const headers = new Headers(init?.headers);
      assert.equal(headers.get('Origin'), 'https://www.ug.link');
      assert.equal(headers.get('Referer'), 'https://www.ug.link/');
      assert.equal(headers.get('lang'), 'zh-CN');
      return Response.json({ code: 200, data: { alias: 'my-nas', relayDomain: 'example.ug.link' } });
    }
    if (url === 'https://my-nas.example.ug.link/ugreen/v1/verify/check') {
      return new Response(null, { headers: { 'X-Rsa-Token': encodedPublicKey } });
    }
    if (url === 'https://my-nas.example.ug.link/ugreen/v1/verify/login') {
      const headers = new Headers(init?.headers);
      assert.equal(headers.get('UG-Client-Id'), 'stable-client-id');
      return successfulLoginResponse(encodedPublicKey);
    }
    if (url === 'https://my-nas.example.ug.link/ugreen/v1/gateway/proxy/dockerToken?port=8317') {
      return Response.json({ code: 200, data: { redirect_url: 'https://proxy.example.test/auth' } });
    }
    if (url === 'https://proxy.example.test/auth') {
      return new Response(null, {
        status: 302,
        headers: { 'Set-Cookie': 'ugreen-proxy-token=session-token; Path=/; Secure' }
      });
    }
    throw new Error(`Unexpected request: ${url}`);
  };
  const kv = fakeKv();

  const session = await createProxySession(runtime(kv.cache), '8317');

  assert.deepEqual(session, {
    cookie: 'ugreen-proxy-token=session-token',
    origin: 'https://proxy.example.test',
    loginOrigin: 'https://my-nas.example.ug.link'
  });
  assert.equal(requestedUrls[0], 'https://api-zh.ugnas.com/api/p2p/v2/ta/nodeInfo/byAlias');
  assert.equal(kv.ttls.get(discoveryCacheKey('stable-client-id')), 300);
  assert.equal(kv.ttls.get(cacheKeys('stable-client-id', '8317').session), 3600);
  assert.deepEqual(JSON.parse(kv.values.get(cacheKeys('stable-client-id', '8317').session) ?? ''), session);
});

test('a cached discovery origin is reused across service ports', async (context) => {
  const encodedPublicKey = rsaPublicKey();
  const originalFetch = globalThis.fetch;
  let discoveryCalls = 0;
  context.after(() => {
    globalThis.fetch = originalFetch;
  });
  globalThis.fetch = async (input: RequestInfo | URL) => {
    const url = String(input);
    if (url.includes('/nodeInfo/byAlias')) {
      discoveryCalls += 1;
      return Response.json({ code: 200, data: { alias: 'my-nas', relayDomain: 'example.ug.link' } });
    }
    if (url.endsWith('/verify/check')) return new Response(null, { headers: { 'X-Rsa-Token': encodedPublicKey } });
    if (url.endsWith('/verify/login')) return successfulLoginResponse(encodedPublicKey);
    if (url.includes('/dockerToken?port=')) {
      return Response.json({ code: 200, data: { redirect_url: `https://proxy.example.test/${discoveryCalls}` } });
    }
    if (url.startsWith('https://proxy.example.test/')) {
      return new Response(null, { headers: { 'Set-Cookie': 'ugreen-proxy-token=session-token; Path=/' } });
    }
    throw new Error(`Unexpected request: ${url}`);
  };
  const kv = fakeKv();

  await createProxySession(runtime(kv.cache), '8317');
  await createProxySession(runtime(kv.cache), '9090');

  assert.equal(discoveryCalls, 1);
});

test('failure at a cached origin forces discovery once before retrying login', async (context) => {
  const encodedPublicKey = rsaPublicKey();
  const originalFetch = globalThis.fetch;
  const requestedUrls: string[] = [];
  context.after(() => {
    globalThis.fetch = originalFetch;
  });
  globalThis.fetch = async (input: RequestInfo | URL) => {
    const url = String(input);
    requestedUrls.push(url);
    if (url === 'https://my-nas.old.example.ug.link/ugreen/v1/verify/check') return new Response(null, { status: 502 });
    if (url.includes('/nodeInfo/byAlias')) {
      return Response.json({ code: 200, data: { alias: 'my-nas', relayDomain: 'new.example.ug.link' } });
    }
    if (url === 'https://my-nas.new.example.ug.link/ugreen/v1/verify/check') {
      return new Response(null, { headers: { 'X-Rsa-Token': encodedPublicKey } });
    }
    if (url.endsWith('/verify/login')) return successfulLoginResponse(encodedPublicKey);
    if (url.includes('/dockerToken?port=')) {
      return Response.json({ code: 200, data: { redirect_url: 'https://proxy.example.test/auth' } });
    }
    if (url === 'https://proxy.example.test/auth') {
      return new Response(null, { headers: { 'Set-Cookie': 'ugreen-proxy-token=session-token; Path=/' } });
    }
    throw new Error(`Unexpected request: ${url}`);
  };
  const key = discoveryCacheKey('stable-client-id');
  const kv = fakeKv({ [key]: JSON.stringify({ origin: 'https://my-nas.old.example.ug.link' }) });

  const session = await createProxySession(runtime(kv.cache), '8317');

  assert.equal(session.loginOrigin, 'https://my-nas.new.example.ug.link');
  assert.deepEqual(requestedUrls.slice(0, 3), [
    'https://my-nas.old.example.ug.link/ugreen/v1/verify/check',
    'https://api-zh.ugnas.com/api/p2p/v2/ta/nodeInfo/byAlias',
    'https://my-nas.new.example.ug.link/ugreen/v1/verify/check'
  ]);
});

test('authentication rejection never triggers rediscovery or a second login', async (context) => {
  const encodedPublicKey = rsaPublicKey();
  const originalFetch = globalThis.fetch;
  let discoveryCalls = 0;
  let loginCalls = 0;
  context.after(() => {
    globalThis.fetch = originalFetch;
  });
  globalThis.fetch = async (input: RequestInfo | URL) => {
    const url = String(input);
    if (url.includes('/nodeInfo/byAlias')) {
      discoveryCalls += 1;
      throw new Error('Discovery must not be called');
    }
    if (url.endsWith('/verify/check')) return new Response(null, { headers: { 'X-Rsa-Token': encodedPublicKey } });
    if (url.endsWith('/verify/login')) {
      loginCalls += 1;
      return Response.json({ code: 1003 });
    }
    throw new Error(`Unexpected request: ${url}`);
  };
  const key = discoveryCacheKey('stable-client-id');
  const kv = fakeKv({ [key]: JSON.stringify({ origin: 'https://my-nas.example.ug.link' }) });

  await assert.rejects(createProxySession(runtime(kv.cache), '8317'), ProxyAuthenticationError);

  assert.equal(discoveryCalls, 0);
  assert.equal(loginCalls, 1);
});

test('an HTTP login rejection is cached and never triggers rediscovery', async (context) => {
  const encodedPublicKey = rsaPublicKey();
  const originalFetch = globalThis.fetch;
  let discoveryCalls = 0;
  let loginCalls = 0;
  context.after(() => {
    globalThis.fetch = originalFetch;
  });
  globalThis.fetch = async (input: RequestInfo | URL) => {
    const url = String(input);
    if (url.includes('/nodeInfo/byAlias')) {
      discoveryCalls += 1;
      throw new Error('Discovery must not be called');
    }
    if (url.endsWith('/verify/check')) return new Response(null, { headers: { 'X-Rsa-Token': encodedPublicKey } });
    if (url.endsWith('/verify/login')) {
      loginCalls += 1;
      return new Response(null, { status: 401 });
    }
    throw new Error(`Unexpected request: ${url}`);
  };
  const key = discoveryCacheKey('stable-client-id');
  const kv = fakeKv({ [key]: JSON.stringify({ origin: 'https://my-nas.example.ug.link' }) });

  await assert.rejects(createProxySession(runtime(kv.cache), '8317'), ProxyAuthenticationError);

  assert.equal(discoveryCalls, 0);
  assert.equal(loginCalls, 1);
  assert.equal(kv.ttls.get('uglink:auth-failure:v1:stable-client-id'), 60);
});

test('discovery rejects relay domains outside the UGREEN trust boundary', async (context) => {
  const originalFetch = globalThis.fetch;
  let calls = 0;
  context.after(() => {
    globalThis.fetch = originalFetch;
  });
  globalThis.fetch = async () => {
    calls += 1;
    return Response.json({ code: 200, data: { alias: 'my-nas', relayDomain: 'attacker.example' } });
  };

  await assert.rejects(
    createProxySession(runtime(fakeKv().cache), '8317'),
    /invalid relay domain/u
  );

  assert.equal(calls, 1);
});

test('proxyFailureCode exposes only safe authentication categories', () => {
  assert.equal(proxyFailureCode(new ProxyAuthenticationError(1003)), 'invalid_credentials');
  assert.equal(proxyFailureCode(new ProxyAuthenticationError(1120)), 'account_locked');
  assert.equal(proxyFailureCode(new Error('network failure')), undefined);
});
