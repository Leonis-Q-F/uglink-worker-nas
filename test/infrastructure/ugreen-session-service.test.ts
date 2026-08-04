import assert from 'node:assert/strict';
import { generateKeyPairSync } from 'node:crypto';
import test from 'node:test';
import {
  cacheKeys,
  createProxySession
} from '../../src/infrastructure/ugreen/session-service';
import { ProxyAuthenticationError, proxyFailureCode } from '../../src/domain/proxy/errors';

function fakeKv(): KVNamespace {
  const values = new Map<string, string>();
  return {
    async get(key: string) {
      return values.get(key) ?? null;
    },
    async put(key: string, value: string | ArrayBuffer | ArrayBufferView | ReadableStream) {
      values.set(key, String(value));
    },
    async delete(key: string) {
      values.delete(key);
    }
  } as KVNamespace;
}

test('cacheKeys isolate sessions by account namespace and port', () => {
  assert.deepEqual(cacheKeys('account-a', '8317'), {
    cookie: 'proxy_cookie:account-a:8317',
    origin: 'proxy_origin:account-a:8317'
  });
  assert.notDeepEqual(
    cacheKeys('account-a', '8317'),
    cacheKeys('account-b', '8317')
  );
});

test('createProxySession follows the current UGREEN login protocol', async (context) => {
  const { publicKey } = generateKeyPairSync('rsa', {
    modulusLength: 1024,
    publicKeyEncoding: { type: 'spki', format: 'pem' },
    privateKeyEncoding: { type: 'pkcs8', format: 'pem' }
  });
  const encodedPublicKey = Buffer.from(publicKey).toString('base64');
  const originalFetch = globalThis.fetch;
  const requestedUrls: string[] = [];
  context.after(() => {
    globalThis.fetch = originalFetch;
  });

  globalThis.fetch = async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    requestedUrls.push(url);
    if (url === 'https://device.example.test/ugreen/v1/verify/check') {
      return new Response(null, { headers: { 'X-Rsa-Token': encodedPublicKey } });
    }
    if (url === 'https://device.example.test/ugreen/v1/verify/login') {
      const headers = new Headers(init?.headers);
      assert.equal(headers.get('UG-Client-Id'), 'stable-client-id');
      return new Response(JSON.stringify({
        code: 200,
        data: {
          public_key: encodedPublicKey,
          token: 'temporary-token',
          token_id: 'token-id'
        }
      }));
    }
    if (url === 'https://device.example.test/ugreen/v1/gateway/proxy/dockerToken?port=8317') {
      return new Response(JSON.stringify({
        code: 200,
        data: { redirect_url: 'https://proxy.example.test/auth' }
      }));
    }
    if (url === 'https://proxy.example.test/auth') {
      return new Response(null, {
        status: 302,
        headers: { 'Set-Cookie': 'ugreen-proxy-token=session-token; Path=/; Secure' }
      });
    }
    throw new Error(`Unexpected request: ${url}`);
  };

  const session = await createProxySession({
    baseUrl: 'https://device.example.test',
    username: 'test-user',
    password: 'test-password',
    sessionNamespace: 'stable-client-id',
    cache: fakeKv()
  }, '8317');

  assert.deepEqual(session, {
    cookie: 'ugreen-proxy-token=session-token',
    origin: 'https://proxy.example.test'
  });
  assert.equal(requestedUrls[0], 'https://device.example.test/ugreen/v1/verify/check');
});

test('proxyFailureCode exposes only safe authentication categories', () => {
  assert.equal(proxyFailureCode(new ProxyAuthenticationError(1003)), 'invalid_credentials');
  assert.equal(proxyFailureCode(new ProxyAuthenticationError(1120)), 'account_locked');
  assert.equal(proxyFailureCode(new Error('network failure')), undefined);
});
