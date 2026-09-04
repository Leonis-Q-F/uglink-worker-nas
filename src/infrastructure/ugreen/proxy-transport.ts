import type { ProxyTransport } from '../../application/gateway/ports';
import type { ProxySession } from '../../domain/proxy/model';

const PROXY_COOKIE_NAME = 'ugreen-proxy-token';
const REDIRECT_STATUSES = new Set([301, 302, 303, 307, 308]);

export function isUgreenLoginRedirect(response: Response, session: ProxySession): boolean {
  if (!REDIRECT_STATUSES.has(response.status)) {
    return false;
  }

  const location = response.headers.get('location');
  if (!location) {
    return false;
  }

  try {
    const loginUrl = new URL(location, session.loginOrigin);
    const deviceUrl = new URL(session.loginOrigin);
    return (
      loginUrl.hostname === deviceUrl.hostname
      && loginUrl.pathname.startsWith('/desktop/')
      && loginUrl.hash.startsWith('#/login/')
    );
  } catch {
    return false;
  }
}

export function buildProxyHeaders(request: Request, session: ProxySession): Headers {
  const proxyHeaders = new Headers();
  const requestOrigin = new URL(request.url).origin;

  for (const [key, value] of request.headers) {
    const lowerKey = key.toLowerCase();
    if (lowerKey === 'host' || lowerKey.startsWith('cf-') || lowerKey.startsWith('x-forwarded-')) {
      continue;
    }
    proxyHeaders.set(key, value);
  }

  const trustedCookies = session.cookie
    .split(';')
    .map((cookie) => cookie.trim())
    .filter(Boolean);
  const trustedCookieNames = new Set(trustedCookies.map((cookie) => (
    cookie.slice(0, Math.max(0, cookie.indexOf('='))).toLowerCase()
  )));
  trustedCookieNames.add(PROXY_COOKIE_NAME);

  const applicationCookies = (request.headers.get('cookie') ?? '')
    .split(';')
    .map((cookie) => cookie.trim())
    .filter((cookie) => {
      if (!cookie) return false;
      const separator = cookie.indexOf('=');
      const name = (separator < 0 ? cookie : cookie.slice(0, separator)).toLowerCase();
      return !trustedCookieNames.has(name);
    });
  applicationCookies.push(...trustedCookies);

  proxyHeaders.set('Host', new URL(session.origin).host);
  proxyHeaders.set('Cookie', applicationCookies.join('; '));

  if (proxyHeaders.get('Origin') === requestOrigin) {
    proxyHeaders.set('Origin', session.origin);
  }
  const referer = proxyHeaders.get('Referer');
  if (referer) {
    try {
      const refererUrl = new URL(referer);
      if (refererUrl.origin === requestOrigin) {
        proxyHeaders.set(
          'Referer',
          `${session.origin}${refererUrl.pathname}${refererUrl.search}${refererUrl.hash}`
        );
      }
    } catch {
      // Preserve malformed or non-URL referrers instead of broadening the rewrite.
    }
  }
  return proxyHeaders;
}

export async function proxyRequest(request: Request, session: ProxySession): Promise<Response> {
  const incomingUrl = new URL(request.url);
  const proxyUrl = `${session.origin}${incomingUrl.pathname}${incomingUrl.search}`;

  return fetch(proxyUrl, {
    method: request.method,
    headers: buildProxyHeaders(request, session),
    body: request.method === 'GET' || request.method === 'HEAD' ? undefined : request.body,
    redirect: 'manual'
  });
}

export const ugreenProxyTransport: ProxyTransport = {
  send: proxyRequest,
  isSessionExpired: isUgreenLoginRedirect
};
