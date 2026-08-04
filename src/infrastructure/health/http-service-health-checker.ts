import type { ServiceHealthChecker } from '../../application/console/ports';
import type { DiagnosticStage, ServiceHealth } from '../../domain/deployment/model';

const HEALTH_RESPONSE_MAX_BYTES = 4_096;

interface HealthFailure {
  code: string;
  detail: string;
  stage: DiagnosticStage;
  httpStatus?: number;
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
        } catch {
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
        const timedOut = error instanceof Error && error.name === 'TimeoutError';
        markFailure(service, monitoringExisting
          ? {
              code: timedOut ? 'service_entry_timeout' : 'service_entry_unreachable',
              detail: '无法连接 Worker 服务入口',
              stage: 'service_entry'
            }
          : {
              code: 'domain_propagating',
              detail: '证书或域名入口仍在生效',
              stage: 'service_entry'
            });
      }
    }));
  }
};
