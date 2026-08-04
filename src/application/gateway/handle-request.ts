import { proxyFailureCode } from '../../domain/proxy/errors';
import { parseServiceMap, requestHostname } from '../../domain/proxy/routing';
import type { GatewayLogger, ProxySessionService, ProxyTransport } from './ports';

const HEALTH_PATH = '/.well-known/uglink-worker-health';
const REPLAY_SAFE_METHODS = new Set(['GET', 'HEAD', 'OPTIONS']);

export interface GatewayRuntime {
  baseUrl: string;
  serviceMap: string;
  setupMode: boolean;
}

export interface GatewayDependencies {
  sessions: ProxySessionService;
  transport: ProxyTransport;
  logger: GatewayLogger;
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
  let services: Map<string, string>;
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
  const port = services.get(hostname);
  const setupMode = runtime.setupMode || services.size === 0;
  const pathname = new URL(request.url).pathname;

  if (pathname === HEALTH_PATH) {
    return jsonResponse(request, {
      status: 'ok',
      mode: setupMode ? 'setup' : 'active',
      hostnameConfigured: Boolean(port),
      serviceCount: services.size
    });
  }
  if (setupMode) return setupResponse(request);
  if (!port) return new Response('Service not configured for this hostname', { status: 404 });

  try {
    let session = await dependencies.sessions.get(port);
    let response = await dependencies.transport.send(request, session);

    if (dependencies.transport.isSessionExpired(response, runtime.baseUrl)) {
      await response.body?.cancel();
      await dependencies.sessions.clear(port);
      dependencies.logger.info({ event: 'proxy_session_expired', hostname, port, method: request.method });

      if (!canReplayAutomatically(request)) return proxySessionResponse(request, true);

      session = await dependencies.sessions.create(port);
      response = await dependencies.transport.send(request, session);
      if (dependencies.transport.isSessionExpired(response, runtime.baseUrl)) {
        await response.body?.cancel();
        await dependencies.sessions.clear(port);
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
