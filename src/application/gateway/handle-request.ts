import { proxyFailureCode } from '../../domain/proxy/errors';
import {
  parseServiceMap,
  requestHostname,
  type ServiceRoute
} from '../../domain/proxy/routing';
import type {
  GatewayLogger,
  ProxySessionService,
  ProxyTicketService,
  ProxyTransport
} from './ports';

const HEALTH_PATH = '/.well-known/uglink-worker-health';
const TICKET_PATH = '/__uglink/ticket';
const REPLAY_SAFE_METHODS = new Set(['GET', 'HEAD', 'OPTIONS']);
const HTML_HEADERS = {
  'Cache-Control': 'no-store',
  'Content-Type': 'text/html; charset=utf-8',
  'Content-Security-Policy': "default-src 'none'; style-src 'unsafe-inline'; form-action 'self'; base-uri 'none'; frame-ancestors 'none'",
  'Referrer-Policy': 'no-referrer',
  'X-Content-Type-Options': 'nosniff'
};
const TICKET_ERROR_MESSAGES: Record<string, string> = {
  invalid_credentials: 'NAS 登录凭据无效。',
  account_locked: 'NAS 账号已被锁定。',
  login_source_blocked: '当前登录来源被 NAS 限制。',
  account_blocked: 'NAS 账号暂时无法登录。',
  password_expired: 'NAS 登录密码已经过期。',
  otp_required: '当前账号启用了二次验证，暂不支持票据模式。',
  authentication_backoff: '最近已有登录尝试，请稍后再试。',
  authentication_timeout: '登录 NAS 超时，请稍后再试。',
  authentication_unavailable: '暂时无法连接 NAS，请稍后再试。',
  authentication_failed: '登录 NAS 失败，请稍后再试。'
};

export interface GatewayRuntime {
  serviceMap: string;
  setupMode: boolean;
}

export interface GatewayDependencies {
  sessions: ProxySessionService;
  tickets: ProxyTicketService;
  transport: ProxyTransport;
  logger: GatewayLogger;
}

function escapeHtml(value: string): string {
  return value
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#39;');
}

function htmlResponse(request: Request, html: string, status = 200): Response {
  return new Response(request.method === 'HEAD' ? null : html, {
    status,
    headers: HTML_HEADERS
  });
}

function ticketPage(request: Request, hostname: string, error?: string, status = 200): Response {
  const message = error
    ? `<p class="error" role="alert">${escapeHtml(error)}</p>`
    : '';
  return htmlResponse(request, `<!doctype html>
<html lang="zh-CN">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <meta name="referrer" content="no-referrer">
  <title>打开 NAS 服务</title>
  <style>
    :root { color-scheme: light; font-family: ui-sans-serif, system-ui, sans-serif; }
    * { box-sizing: border-box; }
    body { margin: 0; min-height: 100vh; display: grid; place-items: center; padding: 24px; color: #10233f; background: #f4f8fd; }
    main { width: min(100%, 520px); padding: 40px; border: 1px solid #dbe5f0; border-radius: 28px; background: #fff; box-shadow: 0 24px 70px rgba(24, 52, 88, 0.1); }
    .eyebrow { margin: 0 0 12px; color: #5b7190; font-size: 12px; font-weight: 700; letter-spacing: .14em; text-transform: uppercase; }
    h1 { margin: 0; font-size: clamp(28px, 6vw, 40px); line-height: 1.12; }
    p { color: #5b7190; line-height: 1.7; }
    strong { color: #10233f; overflow-wrap: anywhere; }
    form { margin: 28px 0 18px; }
    button { width: 100%; min-height: 52px; border: 0; border-radius: 16px; color: #fff; background: #2563eb; font: inherit; font-weight: 700; cursor: pointer; }
    button:hover { background: #1d4ed8; }
    .hint { margin-bottom: 0; font-size: 13px; }
    .error { padding: 12px 14px; border-radius: 12px; color: #9f2d20; background: #fff1ee; font-size: 14px; }
  </style>
</head>
<body>
  <main>
    <p class="eyebrow">UGLINK WORKER</p>
    <h1>打开 NAS 服务</h1>
    <p><strong>${escapeHtml(hostname)}</strong> 是票据入口。点击后会签发一次性登录链接，并跳转到绿联中继域名。</p>
    ${message}
    <form method="post" action="${TICKET_PATH}">
      <button type="submit">打开服务</button>
    </form>
    <p class="hint">链接只对一次打开有效。刷新或重新访问服务时，请回到此页重新签发。</p>
  </main>
</body>
</html>`, status);
}

function ticketFailureResponse(request: Request, hostname: string, error: unknown): Response {
  const code = proxyFailureCode(error) ?? 'ticket_unavailable';
  const message = TICKET_ERROR_MESSAGES[code] ?? '暂时无法签发登录链接，请稍后再试。';
  const response = ticketPage(request, hostname, message, 502);
  response.headers.set('X-UGLINK-Error', code);
  return response;
}

function isCrossOrigin(request: Request): boolean {
  const fetchSite = request.headers.get('Sec-Fetch-Site');
  if (fetchSite && fetchSite !== 'same-origin' && fetchSite !== 'none') return true;

  const origin = request.headers.get('Origin');
  if (!origin) return false;
  try {
    return new URL(origin).origin !== new URL(request.url).origin;
  } catch {
    return true;
  }
}

async function ticketIssuanceResponse(
  request: Request,
  hostname: string,
  route: ServiceRoute,
  dependencies: GatewayDependencies
): Promise<Response> {
  if (request.method !== 'POST') {
    const response = ticketPage(request, hostname, '请从入口页点击“打开服务”重新签发。', 405);
    response.headers.set('Allow', 'POST');
    return response;
  }
  if (isCrossOrigin(request)) {
    return new Response('Cross-origin ticket issuance is not allowed', {
      status: 403,
      headers: { 'Cache-Control': 'no-store' }
    });
  }

  try {
    const ticket = await dependencies.tickets.issue(route.port);
    return new Response(null, {
      status: 303,
      headers: {
        'Cache-Control': 'no-store',
        Location: ticket.url,
        'Referrer-Policy': 'no-referrer',
        'X-Content-Type-Options': 'nosniff'
      }
    });
  } catch (error) {
    dependencies.logger.error({
      event: 'ticket_issue_failed',
      hostname,
      port: route.port,
      error: error instanceof Error ? error.message : String(error)
    });
    return ticketFailureResponse(request, hostname, error);
  }
}

function canReplayAutomatically(request: Request): boolean {
  return REPLAY_SAFE_METHODS.has(request.method) && request.body === null;
}

function jsonResponse(request: Request, value: unknown, status = 200): Response {
  const headers = new Headers({
    'Cache-Control': 'no-store',
    'Content-Type': 'application/json; charset=utf-8'
  });
  return new Response(request.method === 'HEAD' ? null : JSON.stringify(value), { status, headers });
}

function setupResponse(request: Request): Response {
  return jsonResponse(request, {
    status: 'setup_required',
    message: 'Configure uglink.config.json and deploy again.'
  });
}

function proxySessionResponse(request: Request, retryable: boolean): Response {
  const status = retryable ? 503 : 502;
  const code = retryable ? 'proxy_session_expired' : 'proxy_session_unavailable';
  const headers = new Headers({
    'Cache-Control': 'no-store',
    'Content-Type': 'application/json; charset=utf-8',
    'X-UGLINK-Error': code
  });
  if (retryable) headers.set('Retry-After', '0');
  const body = request.method === 'HEAD' ? null : JSON.stringify({
    error: code,
    message: retryable
      ? 'UGREEN proxy session expired. Retry the request.'
      : 'UGREEN proxy session could not be established.'
  });
  return new Response(body, { status, headers });
}

export async function handleGatewayRequest(
  request: Request,
  runtime: GatewayRuntime,
  dependencies: GatewayDependencies
): Promise<Response> {
  let services: Map<string, ServiceRoute>;
  try {
    services = parseServiceMap(runtime.serviceMap);
  } catch (error) {
    dependencies.logger.error({
      event: 'invalid_service_map',
      error: error instanceof Error ? error.message : String(error)
    });
    return new Response('Worker service configuration is invalid', { status: 500 });
  }

  const hostname = requestHostname(request);
  const route = services.get(hostname);
  const setupMode = runtime.setupMode || services.size === 0;
  const pathname = new URL(request.url).pathname;

  if (pathname === HEALTH_PATH) {
    return jsonResponse(request, {
      status: 'ok',
      mode: setupMode ? 'setup' : 'active',
      hostnameConfigured: Boolean(route),
      serviceCount: services.size
    });
  }
  if (setupMode) return setupResponse(request);
  if (!route) return new Response('Service not configured for this hostname', { status: 404 });

  if (route.accessMode === 'ticket') {
    if (pathname === TICKET_PATH) {
      return ticketIssuanceResponse(request, hostname, route, dependencies);
    }
    if (request.method === 'GET' || request.method === 'HEAD') {
      return ticketPage(request, hostname);
    }
    return new Response('Method not allowed', {
      status: 405,
      headers: { Allow: 'GET, HEAD', 'Cache-Control': 'no-store' }
    });
  }

  const port = route.port;
  try {
    let session = await dependencies.sessions.get(port);
    let response: Response;
    try {
      response = await dependencies.transport.send(request, session);
    } catch {
      await dependencies.sessions.invalidate(port);
      dependencies.logger.info({ event: 'proxy_upstream_unavailable', hostname, port, method: request.method });
      if (!canReplayAutomatically(request)) return proxySessionResponse(request, false);
      session = await dependencies.sessions.refresh(port);
      try {
        response = await dependencies.transport.send(request, session);
      } catch (error) {
        await dependencies.sessions.invalidate(port);
        throw error;
      }
    }

    if (dependencies.transport.isSessionExpired(response, session)) {
      await response.body?.cancel();
      dependencies.logger.info({ event: 'proxy_session_expired', hostname, port, method: request.method });

      if (!canReplayAutomatically(request)) {
        await dependencies.sessions.invalidate(port);
        return proxySessionResponse(request, true);
      }

      session = await dependencies.sessions.refresh(port);
      try {
        response = await dependencies.transport.send(request, session);
      } catch (error) {
        await dependencies.sessions.invalidate(port);
        throw error;
      }
      if (dependencies.transport.isSessionExpired(response, session)) {
        await response.body?.cancel();
        await dependencies.sessions.invalidate(port);
        return proxySessionResponse(request, false);
      }
    }
    return response;
  } catch (error) {
    const failureCode = proxyFailureCode(error);
    dependencies.logger.error({
      event: 'proxy_request_failed',
      hostname,
      port,
      error: error instanceof Error ? error.message : String(error)
    });
    return new Response('Upstream proxy request failed', {
      status: 502,
      headers: failureCode ? { 'X-UGLINK-Error': failureCode } : undefined
    });
  }
}
