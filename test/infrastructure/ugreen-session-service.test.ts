import assert from 'node:assert/strict';
import {
  constants,
  createHash,
  generateKeyPairSync,
  privateDecrypt
} from 'node:crypto';
import test from 'node:test';
import {
  authAttemptKey,
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

function rsaKeyPair(): { encodedPublicKey: string; privateKey: string } {
  const { publicKey, privateKey } = generateKeyPairSync('rsa', {
    modulusLength: 1024,
    publicKeyEncoding: { type: 'spki', format: 'pem' },
    privateKeyEncoding: { type: 'pkcs8', format: 'pem' }
  });
  return {
    encodedPublicKey: Buffer.from(publicKey).toString('base64'),
    privateKey
  };
}

function rsaPublicKey(): string {
  return rsaKeyPair().encodedPublicKey;
}

function successfulLoginResponse(encodedPublicKey: string, init?: ResponseInit): Response {
  return Response.json({
    code: 200,
    data: {
      public_key: encodedPublicKey,
      token: 'temporary-token',
      token_id: 'token-id',
      auth_type: 'url'
    }
  }, init);
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
  assert.equal(authAttemptKey('account-a'), 'uglink:auth-attempt:v1:account-a');
  assert.deepEqual(cacheKeys('account-a', '8317'), {
    session: 'uglink:session:v2:account-a:8317'
  });
  assert.notDeepEqual(cacheKeys('account-a', '8317'), cacheKeys('account-b', '8317'));
});

test('runtime discovery is cached for five minutes and creates an atomic proxy session', async (context) => {
  const { encodedPublicKey, privateKey } = rsaKeyPair();
  const originalFetch = globalThis.fetch;
  const requestedUrls: string[] = [];
  let clientId = '';
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
      const headers = new Headers(init?.headers);
      assert.equal(headers.get('Accept'), '*/*');
      assert.equal(headers.get('Content-Type'), 'text/plain;charset=UTF-8');
      assert.equal(headers.get('Origin'), 'https://my-nas.example.ug.link');
      assert.equal(headers.get('Referer'), 'https://my-nas.example.ug.link/desktop/');
      return new Response(null, { headers: { 'X-Rsa-Token': encodedPublicKey } });
    }
    if (url === 'https://my-nas.example.ug.link/desktop/') {
      return new Response(`
        <script>
          const clientNumberVersion = window.clientNumberVersion = 78471;
          const clientShowVersion = window.clientShowVersion = "1.19.0.78471";
        </script>
      `);
    }
    if (url === 'https://my-nas.example.ug.link/ugreen/v1/verify/login') {
      const headers = new Headers(init?.headers);
      const body = JSON.parse(String(init?.body)) as Record<string, unknown>;
      clientId = headers.get('Client-Id') ?? '';
      assert.match(clientId, /^[0-9a-f-]{24}WEB$/u);
      assert.equal(
        headers.get('UG-Client-Id'),
        createHash('md5').update('uglink-worker:stable-client-id:Chrome').digest('hex')
      );
      assert.equal(headers.get('UG-Agent'), 'PC/WEB');
      assert.equal(headers.get('Client-Version'), '78471');
      assert.equal(headers.get('Client-Version-Str'), '1.19.0');
      assert.equal(headers.get('X-Specify-Language'), 'zh-CN');
      assert.equal(headers.get('Origin'), 'https://my-nas.example.ug.link');
      assert.equal(headers.get('Referer'), 'https://my-nas.example.ug.link/desktop/');
      assert.deepEqual({ ...body, password: '<encrypted>' }, {
        username: 'nas-user',
        password: '<encrypted>',
        keepalive: false,
        otp: true,
        is_simple: true
      });
      assert.equal(typeof body.password, 'string');
      assert.notEqual(body.password, 'test-password');
      assert.equal(
        privateDecrypt({ key: privateKey, padding: constants.RSA_PKCS1_PADDING },
          Buffer.from(String(body.password), 'base64')).toString('utf8'),
        'test-password'
      );
      const responseHeaders = new Headers();
      responseHeaders.append('Set-Cookie', 'token=login-token; Path=/; Secure; SameSite=Strict');
      responseHeaders.append('Set-Cookie', 'session=login-session; Path=/; Secure; HttpOnly');
      return successfulLoginResponse(encodedPublicKey, { headers: responseHeaders });
    }
    if (url.startsWith('https://my-nas.example.ug.link/ugreen/v1/gateway/proxy/dockerToken?')) {
      const parsed = new URL(url);
      const headers = new Headers(init?.headers);
      assert.equal(parsed.searchParams.get('port'), '8317');
      assert.equal(parsed.searchParams.get('token'), 'temporary-token');
      assert.equal(headers.get('Client-Id'), clientId);
      assert.equal(headers.get('Cookie'), 'token=login-token; session=login-session');
      assert.equal(
        headers.get('X-Ugreen-Security-Key'),
        createHash('md5').update('temporary-token').digest('hex')
      );
      assert.equal(headers.has('X-Ugreen-Token'), false);
      return Response.json({
        code: 200,
        data: { redirect_url: 'https://my-nas.example.ug.link/proxy/auth' }
      });
    }
    if (url === 'https://my-nas.example.ug.link/proxy/auth') {
      const headers = new Headers(init?.headers);
      assert.equal(headers.get('Cookie'), 'token=login-token; session=login-session');
      assert.equal(headers.get('Referer'), 'https://my-nas.example.ug.link/desktop/');
      const responseHeaders = new Headers();
      responseHeaders.append('Set-Cookie', 'unrelated=value; Path=/; Secure');
      responseHeaders.append('Set-Cookie', 'ugreen-proxy-token=session-token; Path=/; Secure');
      return new Response(null, {
        status: 302,
        headers: responseHeaders
      });
    }
    throw new Error(`Unexpected request: ${url}`);
  };
  const kv = fakeKv();

  const session = await createProxySession(runtime(kv.cache), '8317');

  assert.deepEqual(session, {
    cookie: 'unrelated=value; ugreen-proxy-token=session-token',
    origin: 'https://my-nas.example.ug.link',
    loginOrigin: 'https://my-nas.example.ug.link'
  });
  assert.equal(requestedUrls[0], 'https://api-zh.ugnas.com/api/p2p/v2/ta/nodeInfo/byAlias');
  assert.equal(kv.ttls.get(discoveryCacheKey('stable-client-id')), 300);
  assert.equal(kv.ttls.get(cacheKeys('stable-client-id', '8317').session), 3600);
  assert.equal(kv.values.has(authAttemptKey('stable-client-id')), false);
  assert.deepEqual(JSON.parse(kv.values.get(cacheKeys('stable-client-id', '8317').session) ?? ''), session);
});

test('a script-issued proxy cookie reaches the app through the browser navigation target', async (context) => {
  const encodedPublicKey = rsaPublicKey();
  const originalFetch = globalThis.fetch;
  let activationCalls = 0;
  context.after(() => {
    globalThis.fetch = originalFetch;
  });
  globalThis.fetch = async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    if (url.endsWith('/desktop/')) return new Response(null, { status: 404 });
    if (url.endsWith('/verify/check')) {
      return new Response(null, { headers: { 'X-Rsa-Token': encodedPublicKey } });
    }
    if (url.endsWith('/verify/login')) return successfulLoginResponse(encodedPublicKey);
    if (url.includes('/dockerToken?port=')) {
      return Response.json({
        code: 200,
        data: { redirect_url: 'https://proxy.example.test/auth?ticket=one-time' }
      });
    }
    if (url === 'https://proxy.example.test/auth?ticket=one-time') {
      return new Response(`
        <script>
          document.cookie = "ugreen-proxy-token=session-token; Path=/; Secure";
          window.location.href = "/";
        </script>
      `, { headers: { 'Content-Type': 'text/html' } });
    }
    if (url === 'https://proxy.example.test/') {
      activationCalls += 1;
      const headers = new Headers(init?.headers);
      assert.equal(headers.get('Cookie'), 'ugreen-proxy-token=session-token');
      assert.equal(headers.get('Referer'), 'https://proxy.example.test/auth?ticket=one-time');
      return new Response('<!doctype html>', {
        status: 401,
        headers: { 'Set-Cookie': 'relay_session=activated; Path=/; Secure' }
      });
    }
    throw new Error(`Unexpected request: ${url}`);
  };
  const discoveryKey = discoveryCacheKey('stable-client-id');
  const kv = fakeKv({
    [discoveryKey]: JSON.stringify({ origin: 'https://my-nas.example.ug.link' })
  });

  const session = await createProxySession(runtime(kv.cache), '8317');

  assert.equal(activationCalls, 1);
  assert.deepEqual(session, {
    cookie: 'ugreen-proxy-token=session-token; relay_session=activated',
    origin: 'https://proxy.example.test',
    loginOrigin: 'https://my-nas.example.ug.link'
  });
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
  assert.deepEqual(requestedUrls.filter((url) => (
    url.includes('/nodeInfo/byAlias') || url.endsWith('/verify/check')
  )), [
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
  assert.equal(kv.ttls.get('uglink:auth-failure:v1:stable-client-id'), 600);
});

test('an account lock response applies a thirty-minute login backoff', async (context) => {
  const encodedPublicKey = rsaPublicKey();
  const originalFetch = globalThis.fetch;
  context.after(() => {
    globalThis.fetch = originalFetch;
  });
  globalThis.fetch = async (input: RequestInfo | URL) => {
    const url = String(input);
    if (url.endsWith('/verify/check')) {
      return new Response(null, { headers: { 'X-Rsa-Token': encodedPublicKey } });
    }
    if (url.endsWith('/desktop/')) return new Response(null, { status: 404 });
    if (url.endsWith('/verify/login')) return Response.json({ code: 1120 });
    throw new Error(`Unexpected request: ${url}`);
  };
  const key = discoveryCacheKey('stable-client-id');
  const kv = fakeKv({ [key]: JSON.stringify({ origin: 'https://my-nas.example.ug.link' }) });

  await assert.rejects(
    createProxySession(runtime(kv.cache), '8317'),
    (error: unknown) => error instanceof ProxyAuthenticationError && error.apiCode === 1120
  );

  assert.equal(kv.ttls.get('uglink:auth-failure:v1:stable-client-id'), 1800);
});

test('header authentication encrypts the token and signs it with its MD5 digest', async (context) => {
  const encodedPublicKey = rsaPublicKey();
  const originalFetch = globalThis.fetch;
  context.after(() => {
    globalThis.fetch = originalFetch;
  });
  globalThis.fetch = async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    if (url.endsWith('/verify/check')) {
      return new Response(null, { headers: { 'X-Rsa-Token': encodedPublicKey } });
    }
    if (url.endsWith('/desktop/')) return new Response(null, { status: 404 });
    if (url.endsWith('/verify/login')) {
      return Response.json({
        code: 200,
        data: {
          public_key: encodedPublicKey,
          token: 'temporary-token',
          token_id: 'otp-token-id',
          auth_type: 'header'
        }
      }, {
        headers: { 'Set-Cookie': 'token=header-login; Path=/; Secure' }
      });
    }
    if (url.includes('/dockerToken?')) {
      const parsed = new URL(url);
      const headers = new Headers(init?.headers);
      assert.equal(parsed.searchParams.get('port'), '8317');
      assert.equal(parsed.searchParams.has('token'), false);
      assert.equal(headers.get('Cookie'), 'token=header-login');
      assert.match(headers.get('X-Ugreen-Token') ?? '', /^[A-Za-z0-9+/]+=*$/u);
      assert.notEqual(headers.get('X-Ugreen-Token'), 'temporary-token');
      assert.equal(
        headers.get('X-Ugreen-Security-Key'),
        createHash('md5').update('temporary-token').digest('hex')
      );
      assert.notEqual(headers.get('X-Ugreen-Security-Key'), 'otp-token-id');
      return Response.json({ code: 200, data: { redirect_url: 'https://proxy.example.test/auth' } });
    }
    if (url === 'https://proxy.example.test/auth') {
      assert.equal(new Headers(init?.headers).has('Cookie'), false);
      return new Response(null, {
        headers: { 'Set-Cookie': 'ugreen-proxy-token=session-token; Path=/' }
      });
    }
    throw new Error(`Unexpected request: ${url}`);
  };
  const key = discoveryCacheKey('stable-client-id');
  const kv = fakeKv({ [key]: JSON.stringify({ origin: 'https://my-nas.example.ug.link' }) });

  const session = await createProxySession(runtime(kv.cache), '8317');

  assert.equal(session.cookie, 'ugreen-proxy-token=session-token');
});

test('OTP-required responses stop before docker token exchange and apply a long backoff', async (context) => {
  const encodedPublicKey = rsaPublicKey();
  const originalFetch = globalThis.fetch;
  let loginCalls = 0;
  context.after(() => {
    globalThis.fetch = originalFetch;
  });
  globalThis.fetch = async (input: RequestInfo | URL) => {
    const url = String(input);
    if (url.endsWith('/verify/check')) {
      return new Response(null, { headers: { 'X-Rsa-Token': encodedPublicKey } });
    }
    if (url.endsWith('/desktop/')) return new Response(null, { status: 404 });
    if (url.endsWith('/verify/login')) {
      loginCalls += 1;
      return Response.json({
        code: 200,
        data: { enable_otp: true, token_id: 'otp-token-id' }
      });
    }
    throw new Error(`Unexpected request after OTP challenge: ${url}`);
  };
  const key = discoveryCacheKey('stable-client-id');
  const kv = fakeKv({ [key]: JSON.stringify({ origin: 'https://my-nas.example.ug.link' }) });

  await assert.rejects(
    createProxySession(runtime(kv.cache), '8317'),
    (error: unknown) => error instanceof ProxyAuthenticationError && error.apiCode === 'otp_required'
  );
  await assert.rejects(
    createProxySession(runtime(kv.cache), '8317'),
    (error: unknown) => error instanceof ProxyAuthenticationError && error.apiCode === 'otp_required'
  );

  assert.equal(loginCalls, 1);
  assert.equal(kv.values.get('uglink:auth-failure:v1:stable-client-id'), 'otp_required');
  assert.equal(kv.ttls.get('uglink:auth-failure:v1:stable-client-id'), 3600);
  assert.equal(kv.ttls.get(authAttemptKey('stable-client-id')), 300);
});

test('an active authentication attempt suppresses concurrent login requests', async (context) => {
  const originalFetch = globalThis.fetch;
  context.after(() => {
    globalThis.fetch = originalFetch;
  });
  globalThis.fetch = async () => {
    throw new Error('Authentication backoff must stop all upstream requests');
  };
  const kv = fakeKv({ [authAttemptKey('stable-client-id')]: 'another-attempt' });

  await assert.rejects(
    createProxySession(runtime(kv.cache), '8317'),
    (error: unknown) => error instanceof ProxyAuthenticationError && error.apiCode === 'backoff'
  );
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
  assert.equal(proxyFailureCode(new ProxyAuthenticationError('otp_required')), 'otp_required');
  assert.equal(proxyFailureCode(new ProxyAuthenticationError('backoff')), 'authentication_backoff');
  assert.equal(proxyFailureCode(new ProxyAuthenticationError('timeout')), 'authentication_timeout');
  assert.equal(proxyFailureCode(new Error('network failure')), undefined);
});
