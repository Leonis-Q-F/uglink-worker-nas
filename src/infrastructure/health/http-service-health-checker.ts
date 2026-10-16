import type { ServiceHealthChecker } from '../../application/console/ports';
import type { DiagnosticStage, ServiceHealth } from '../../domain/deployment/model';
import { sanitizeLogValue } from '../security/log-redaction';

const HEALTH_RESPONSE_MAX_BYTES = 4_096;

interface HealthFailure {
  code: string;
  detail: string;
  stage: DiagnosticStage;
  httpStatus?: number;
}

function httpFailure(status: number): HealthFailure {
  return {
    code: 'service_entry_http_error',
    detail: `服务入口返回 HTTP ${status}`,
    stage: 'service_entry',
    httpStatus: status
  };
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

async function readHealthBody(response: Response): Promise<{ body: string; truncated: boolean }> {
  if (!response.body) return { body: '', truncated: false };
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let bytesRead = 0;
  let body = '';
  let truncated = false;
  try {
    while (true) {
      const chunk = await reader.read();
      if (chunk.done) break;
      const remaining = HEALTH_RESPONSE_MAX_BYTES - bytesRead;
      body += decoder.decode(chunk.value.subarray(0, remaining), { stream: true });
      bytesRead += chunk.value.byteLength;
      if (bytesRead > HEALTH_RESPONSE_MAX_BYTES) {
        truncated = true;
        await reader.cancel('health response exceeds size limit');
        break;
      }
    }
    body += decoder.decode();
  } finally {
    reader.releaseLock();
  }
  return { body, truncated };
}

export const httpServiceHealthChecker: ServiceHealthChecker = {
  async check(services, monitoringExisting = false): Promise<void> {
    await Promise.all(services.map(async (service) => {
      const startedAt = Date.now();
      const url = `https://${service.hostname}/.well-known/uglink-worker-health`;
      const data: {
        request: { url: string; method: string };
        response?: { status: number; statusText: string; body?: unknown; truncated?: boolean };
        error?: unknown;
      } = { request: { url, method: 'GET' } };
      try {
        const workerResponse = await fetch(
          url,
          {
            cache: 'no-store',
            headers: { Accept: 'application/json' },
            signal: AbortSignal.timeout(5_000)
          }
        );
        data.response = { status: workerResponse.status, statusText: workerResponse.statusText };
        const responseBody = await readHealthBody(workerResponse);
        data.response.body = responseBody.body;
        data.response.truncated = responseBody.truncated;
        // Keep JSON structured so sensitive response fields can be removed by key.
        try { data.response.body = JSON.parse(responseBody.body) as unknown; } catch { /* Preserve bounded text. */ }
        if (!workerResponse.ok) {
          markFailure(service, httpFailure(workerResponse.status));
          return;
        }
        let health: { status?: string; hostnameConfigured?: boolean };
        try {
          if (responseBody.truncated) throw new Error('Health response exceeds size limit.');
          health = JSON.parse(responseBody.body) as typeof health;
          if (!health || typeof health !== 'object') throw new Error('Health response is not an object.');
        } catch (error) {
          data.error = error;
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
        data.error = error;
        if (data.response && (data.response.status < 200 || data.response.status >= 300)) {
          markFailure(service, httpFailure(data.response.status));
          return;
        }
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
      } finally {
        service.data = sanitizeLogValue({ ...data, durationMs: Date.now() - startedAt });
      }
    }));
  }
};
