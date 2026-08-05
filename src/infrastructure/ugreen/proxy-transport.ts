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

  for (const [key, value] of request.headers) {
    const lowerKey = key.toLowerCase();
    if (lowerKey === 'host' || lowerKey.startsWith('cf-') || lowerKey.startsWith('x-forwarded-')) {
      continue;
    }
    proxyHeaders.set(key, value);
  }

  const applicationCookies = (request.headers.get('cookie') ?? '')
    .split(';')
    .map((cookie) => cookie.trim())
    .filter((cookie) => cookie && !cookie.toLowerCase().startsWith(`${PROXY_COOKIE_NAME}=`));
  applicationCookies.push(session.cookie);

  proxyHeaders.set('Host', new URL(session.origin).host);
  proxyHeaders.set('Cookie', applicationCookies.join('; '));
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
