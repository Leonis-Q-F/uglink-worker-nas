import assert from 'node:assert/strict';
import test from 'node:test';
import {
  buildProxyHeaders,
  isUgreenLoginRedirect,
  proxyRequest
} from '../../src/infrastructure/ugreen/proxy-transport';

test('buildProxyHeaders preserves application cookies and replaces spoofed proxy cookies', () => {
  const request = new Request('https://api.example.com/v1', {
    headers: {
      Cookie: 'app_session=abc; ugreen-proxy-token=spoofed',
      'CF-Ray': 'test-ray',
      'X-Forwarded-For': '127.0.0.1',
      'X-App-Header': 'kept'
    }
  });

  const headers = buildProxyHeaders(request, {
    cookie: 'ugreen-proxy-token=trusted',
    origin: 'https://proxy.example.net',
    loginOrigin: 'https://device.example.test'
  });

  assert.equal(headers.get('cookie'), 'app_session=abc; ugreen-proxy-token=trusted');
  assert.equal(headers.get('host'), 'proxy.example.net');
  assert.equal(headers.get('x-app-header'), 'kept');
  assert.equal(headers.has('cf-ray'), false);
  assert.equal(headers.has('x-forwarded-for'), false);
});

test('isUgreenLoginRedirect recognizes only the UGREEN account login redirect', () => {
  const expired = new Response(null, {
    status: 302,
    headers: {
      Location: 'http://device.example.test/desktop/#/login/account'
    }
  });
  const session = {
    cookie: 'ugreen-proxy-token=trusted',
    origin: 'https://proxy.example.test',
    loginOrigin: 'https://device.example.test'
  };
  assert.equal(isUgreenLoginRedirect(expired, session), true);

  for (const status of [401, 403]) {
    assert.equal(
      isUgreenLoginRedirect(new Response(null, { status }), session),
      false
    );
  }

  const applicationRedirect = new Response(null, {
    status: 302,
    headers: { Location: '/sign-in' }
  });
  assert.equal(
    isUgreenLoginRedirect(applicationRedirect, session),
    false
  );

  const foreignRedirect = new Response(null, {
    status: 302,
    headers: { Location: 'https://accounts.example.net/desktop/#/login/account' }
  });
  assert.equal(
    isUgreenLoginRedirect(foreignRedirect, session),
    false
  );
});

test('proxyRequest preserves the incoming path and exposes redirects to the Worker', async (context) => {
  const originalFetch = globalThis.fetch;
  context.after(() => {
    globalThis.fetch = originalFetch;
  });

  let requestedUrl = '';
  let requestedRedirect: RequestRedirect | undefined;
  globalThis.fetch = async (input: RequestInfo | URL, init?: RequestInit) => {
    requestedUrl = String(input);
    requestedRedirect = init?.redirect;
    return new Response(null, {
      status: 302,
      headers: { Location: 'https://device.example.test/desktop/#/login/account' }
    });
  };

  await proxyRequest(
    new Request('https://service.example.com/v1/models?limit=10'),
    {
      cookie: 'ugreen-proxy-token=trusted',
      origin: 'https://proxy.example.test',
      loginOrigin: 'https://device.example.test'
    }
  );

  assert.equal(requestedUrl, 'https://proxy.example.test/v1/models?limit=10');
  assert.equal(requestedRedirect, 'manual');
});
