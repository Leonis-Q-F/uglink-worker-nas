import { ApplicationError } from '../../../application/common/application-error';
import { normalizeAuthority, normalizeOrigin, requestContext, type ExternalRequestContext } from './request-context';
import { proxyOrigin, rawHeaderValues } from './proxy-headers';
import type { ServerConfig } from './server-config';

interface NodeRequestFacts {
  rawHeaders: readonly string[];
  remoteAddress?: string;
  target?: string;
  method?: string;
}

export function resolveNodeContext(facts: NodeRequestFacts, config: ServerConfig): ExternalRequestContext {
  let host: string;
  const target = facts.target;
  try {
    const hosts = rawHeaderValues(facts.rawHeaders, 'host');
    if (hosts.length !== 1 || !target?.startsWith('/') || target.startsWith('//') || /[\\\s\x00-\x1f\x7f]/u.test(target) || target.includes('#')) throw new Error();
    host = normalizeAuthority(hosts[0]!);
  } catch {
    throw new ApplicationError(400, 'invalid_request', '请求地址无效。');
  }
  const direct = normalizeOrigin(`http://${host}`);
  // Exact liveness route only: no session, credentials, proxy parsing or business action.
  if (facts.method === 'GET' && target === '/api/health') return requestContext(direct, target, 'direct');
  let origin = config.publicOrigin;
  let source: ExternalRequestContext['source'] = origin ? 'legacy' : 'direct';
  const mapped = config.mappedOrigin(host);
  if (!origin && config.mode !== 'off' && config.trusts(facts.remoteAddress)) {
    origin = proxyOrigin(facts.rawHeaders, config.mode);
    if (origin && mapped && origin !== mapped) throw new ApplicationError(400, 'invalid_proxy_headers', '代理来源与 Host 映射冲突。');
    if (!origin && !mapped) throw new ApplicationError(400, 'proxy_context_missing', '可信代理缺少来源信息，请检查代理配置。');
    if (origin) source = 'trusted-proxy';
  }
  if (!origin && mapped) { origin = mapped; source = 'configured-host'; }
  origin ??= direct;
  if (!config.allows(origin)) throw new ApplicationError(421, 'unconfigured_origin', '访问来源未配置，请检查反向代理来源配置。');
  return requestContext(origin, target!, source);
}
