import type { ServiceHealthChecker } from '../../application/console/ports';
import type { DiagnosticStage, ServiceHealth } from '../../domain/deployment/model';

const HEALTH_RESPONSE_MAX_BYTES = 4_096;

interface HealthFailure {
  code: string;
  detail: string;
  stage: DiagnosticStage;
  httpStatus?: number;
}

function networkFailure(error: unknown): HealthFailure | undefined {
  // Node fetch may wrap DNS errors in cause; workerd may only expose an opaque
  // internal error. Do not infer DNS failure unless the error identifies it.
  const seen = new Set<unknown>();
  for (let current = error; current && typeof current === 'object' && !seen.has(current);) {
    seen.add(current);
    const { name, code, message, cause } = current as {
      name?: unknown; code?: unknown; message?: unknown; cause?: unknown;
    };
    if (name === 'TimeoutError') {
      return {
        code: 'service_entry_timeout',
        detail: '连接 Worker 服务入口超时，请检查控制台所在网络的 DNS 和 HTTPS 连通性',
        stage: 'service_entry'
      };
    }
    if ((typeof code === 'string' && ['ENOTFOUND', 'EAI_AGAIN', 'EAI_NODATA'].includes(code))
      || (typeof message === 'string'
        && /DNS lookup failed|No address associated with hostname|getaddrinfo ENOTFOUND|getaddrinfo EAI_AGAIN/iu.test(message))) {
      return {
        code: 'service_entry_dns_error',
        detail: '控制台无法通过 DNS 解析服务域名，请检查 Cloudflare 域名解析和控制台所在主机或 Docker 容器的 DNS 设置',
        stage: 'service_entry'
      };
    }
    current = cause;
  }
  return undefined;
}

function markFailure(service: ServiceHealth, failure: HealthFailure): void {
  service.healthy = false;
  service.detail = failure.detail;
  service.code = failure.code;
  service.stage = failure.stage;
  if (failure.httpStatus !== undefined) service.httpStatus = failure.httpStatus;
  else delete service.httpStatus;
}

async function readHealthResponse(response: Response): Promise<{
  status?: string;
  hostnameConfigured?: boolean;
}> {
  if (!response.body) return {};
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let bytesRead = 0;
  let body = '';
  try {
    while (true) {
      const chunk = await reader.read();
      if (chunk.done) break;
      bytesRead += chunk.value.byteLength;
      if (bytesRead > HEALTH_RESPONSE_MAX_BYTES) {
        await reader.cancel('health response exceeds size limit');
        throw new Error('Health response exceeds size limit.');
      }
      body += decoder.decode(chunk.value, { stream: true });
    }
    body += decoder.decode();
  } finally {
    reader.releaseLock();
  }
  return JSON.parse(body) as { status?: string; hostnameConfigured?: boolean };
}

export const httpServiceHealthChecker: ServiceHealthChecker = {
  async check(services, monitoringExisting = false): Promise<void> {
    await Promise.all(services.map(async (service) => {
      try {
        const workerResponse = await fetch(
          `https://${service.hostname}/.well-known/uglink-worker-health`,
          {
            cache: 'no-store',
            headers: { Accept: 'application/json' },
            signal: AbortSignal.timeout(5_000)
          }
        );
        if (!workerResponse.ok) {
          markFailure(service, {
            code: 'service_entry_http_error',
            detail: `服务入口返回 HTTP ${workerResponse.status}`,
            stage: 'service_entry',
            httpStatus: workerResponse.status
          });
          await workerResponse.body?.cancel();
          return;
        }
        let health: Awaited<ReturnType<typeof readHealthResponse>>;
        try {
          health = await readHealthResponse(workerResponse);
        } catch (error) {
          if (networkFailure(error)) throw error;
          markFailure(service, {
            code: 'worker_health_invalid_response',
            detail: '服务入口没有返回有效的 Worker 健康信息',
            stage: 'worker_configuration'
          });
          return;
        }
        if (health.status !== 'ok' || health.hostnameConfigured !== true) {
          markFailure(service, {
            code: 'worker_hostname_unconfigured',
            detail: '服务尚未识别此访问域名',
            stage: 'worker_configuration'
          });
          return;
        }
        service.healthy = true;
        service.detail = 'Worker 已部署且域名配置正常';
        service.code = 'healthy';
        service.stage = 'worker_configuration';
        service.httpStatus = workerResponse.status;
      } catch (error) {
        markFailure(service, networkFailure(error) ?? (monitoringExisting
          ? {
              code: 'service_entry_unreachable',
              detail: '控制台无法连接 Worker 服务入口，请查看运行日志并检查 DNS、网络和 TLS 证书',
              stage: 'service_entry'
            }
          : {
              code: 'domain_propagating',
              detail: '暂时无法连接 Worker 服务入口，域名或证书可能尚未生效；若持续失败，请查看运行日志并检查 DNS 和网络',
              stage: 'service_entry'
            }));
      }
    }));
  }
};
