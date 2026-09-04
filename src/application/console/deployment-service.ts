import { ApplicationError } from '../common/application-error';
import type { DeployRequest } from './contracts';
import type {
  CloudflareDeploymentProvider,
  ConfigurationRepository,
  DeploymentJobRepository,
  DiagnosticLogRepository,
  ServiceHealthChecker,
  TokenGenerator
} from './ports';
import { resolveUglinkConfig, validateUglinkConfig } from '../../domain/configuration/validation';
import { defaultConfig } from '../../domain/configuration/defaults';
import { servicesRequiringSynchronization } from '../../domain/configuration/change-set';
import type { UglinkConfig, UglinkService } from '../../domain/configuration/model';
import type {
  DeploymentJob,
  DeploymentMode,
  DeploymentPhase,
  DiagnosticEntry,
  DiagnosticStage,
  ServiceHealth,
  ServiceHealthResponse,
  WorkerTarget
} from '../../domain/deployment/model';

const HEALTH_TIMEOUT_MS = 15 * 60 * 1000;

export interface DeploymentServiceDependencies {
  target: WorkerTarget;
  provider: CloudflareDeploymentProvider;
  jobs: DeploymentJobRepository;
  diagnostics: DiagnosticLogRepository;
  health: ServiceHealthChecker;
  tokens: TokenGenerator;
  configuration: ConfigurationRepository;
}

function timelineLabel(phase: DeploymentPhase): string {
  const labels: Record<DeploymentPhase, string> = {
    queued: '发布请求已创建',
    validating: '配置检查完成',
    provisioning: '准备会话缓存',
    uploading: '发布服务',
    secret_updated: '更新登录凭据',
    routing: '配置访问域名',
    checking: '检查服务状态',
    healthy: 'Worker 入口正常',
    failed: '发布未完成'
  };
  return labels[phase];
}

function advance(job: DeploymentJob, phase: DeploymentPhase, detail: string): void {
  const now = new Date().toISOString();
  job.phase = phase;
  job.updatedAt = now;
  job.message = detail;
  const last = job.timeline.at(-1);
  if (last?.phase !== phase) {
    job.timeline.push({ phase, label: timelineLabel(phase), detail, at: now });
  } else {
    last.detail = detail;
    last.at = now;
  }
}

function failureStage(phase: DeploymentPhase, code: string): DiagnosticStage {
  if (code.includes('token') || code.includes('permission')) return 'cloudflare_access';
  if (code.includes('password') || code.includes('credential')) return 'credential';
  if (code.includes('domain')) return 'domain_routing';
  if (code.includes('worker')) return 'worker_upload';
  switch (phase) {
    case 'queued':
    case 'validating':
      return 'configuration';
    case 'provisioning':
      return 'session_cache';
    case 'uploading':
      return 'worker_upload';
    case 'secret_updated':
      return 'credential';
    case 'routing':
      return 'domain_routing';
    case 'checking':
    case 'healthy':
    case 'failed':
      return 'service_check';
  }
}

function deploymentFailure(error: unknown, phase: DeploymentPhase): NonNullable<DeploymentJob['failure']> {
  const code = error instanceof ApplicationError ? error.code : 'deployment_failed';
  return {
    phase,
    stage: failureStage(phase, code),
    code,
    summary: error instanceof Error ? error.message : '发布过程中发生未知错误。',
    ...(error instanceof ApplicationError && error.detail ? { detail: error.detail } : {})
  };
}

function failureMessage(failure: NonNullable<DeploymentJob['failure']>): string {
  return failure.detail ? `${failure.summary}（${failure.detail}）` : failure.summary;
}

function validateDeployRequest(request: DeployRequest): { config: UglinkConfig; mode: DeploymentMode } {
  const validation = validateUglinkConfig(request.config);
  if (!validation.valid) {
    throw new ApplicationError(400, 'invalid_config', '配置检查未通过，请先修正相关项目。');
  }
  if (request.password !== undefined && typeof request.password !== 'string') {
    throw new ApplicationError(400, 'invalid_password', '密码字段格式无效。');
  }
  if (request.password !== undefined && (request.password.length < 1 || request.password.length > 4096)) {
    throw new ApplicationError(400, 'invalid_password', 'NAS 密码长度无效。');
  }
  const mode = request.mode ?? 'publish';
  if (mode !== 'publish' && mode !== 'overwrite') {
    throw new ApplicationError(400, 'invalid_deployment_mode', '发布方式无效。');
  }
  return { config: resolveUglinkConfig(request.config), mode };
}

export function createDeploymentService(dependencies: DeploymentServiceDependencies) {
  const { target, provider, jobs, diagnostics, health, tokens, configuration } = dependencies;

  async function appendDiagnostics(entries: DiagnosticEntry[]): Promise<void> {
    if (entries.length === 0) return;
    try {
      await diagnostics.append(entries);
    } catch (error) {
      console.error(JSON.stringify({
        event: 'diagnostic_log_write_failed',
        error: error instanceof Error ? error.message : String(error)
      }));
    }
  }

  function serviceDiagnostics(
    services: ServiceHealth[],
    observedAt: string,
    deployment?: DeploymentJob
  ): DiagnosticEntry[] {
    return services
      .filter((service) => !service.healthy)
      .map((service) => ({
        id: tokens.create(15),
        source: 'health_check',
        severity: service.code === 'domain_propagating' ? 'warning' : 'error',
        stage: service.stage || 'service_entry',
        code: service.code || 'health_check_failed',
        summary: service.detail,
        ...(service.httpStatus !== undefined ? { httpStatus: service.httpStatus } : {}),
        firstObservedAt: observedAt,
        lastObservedAt: observedAt,
        occurrences: 1,
        service: {
          ...(service.serviceName ? { name: service.serviceName } : {}),
          hostname: service.hostname,
          ...(service.port !== undefined ? { port: service.port } : {})
        },
        ...(deployment ? {
          deployment: {
            jobId: deployment.id,
            phase: deployment.phase,
            mode: deployment.mode
          }
        } : {})
      }));
  }

  function deploymentDiagnostic(job: DeploymentJob): DiagnosticEntry | undefined {
    if (!job.failure) return undefined;
    return {
      id: tokens.create(15),
      source: 'deployment',
      severity: 'error',
      stage: job.failure.stage,
      code: job.failure.code,
      summary: job.failure.summary,
      ...(job.failure.detail ? { detail: job.failure.detail } : {}),
      firstObservedAt: job.updatedAt,
      lastObservedAt: job.updatedAt,
      occurrences: 1,
      deployment: {
        jobId: job.id,
        phase: job.failure.phase,
        mode: job.mode
      }
    };
  }

  function newJob(
    mode: DeploymentMode,
    synchronizedServices: UglinkService[]
  ): DeploymentJob {
    const now = new Date().toISOString();
    return {
      id: tokens.create(18),
      mode,
      phase: 'queued',
      createdAt: now,
      updatedAt: now,
      message: mode === 'overwrite' ? '正在准备覆盖部署。' : '正在准备发布。',
      passwordUpdated: false,
      workerName: target.workerName,
      accountId: target.accountId,
      accountName: target.accountName,
      dashboardUrl: provider.dashboardUrl(target),
      services: synchronizedServices.map((service) => ({
        serviceName: service.name,
        hostname: service.hostname.toLowerCase(),
        port: service.port,
        healthy: false,
        detail: '等待发布'
      })),
      timeline: [{
        phase: 'queued',
        label: timelineLabel('queued'),
        detail: mode === 'overwrite' ? '覆盖部署请求已提交。' : '发布请求已提交。',
        at: now
      }]
    };
  }

  async function checkPublishedServices(value: unknown): Promise<ServiceHealthResponse> {
    const validation = validateUglinkConfig(value);
    if (!validation.valid) {
      throw new ApplicationError(400, 'invalid_config', '已发布配置无效，无法检查服务状态。');
    }
    const config = resolveUglinkConfig(value);
    const services = config.services
      .filter((service) => service.enabled)
      .map((service) => ({
        serviceName: service.name,
        hostname: service.hostname,
        port: service.port,
        healthy: false,
        detail: '等待检查'
      }));
    await health.check(services, true);
    const checkedAt = new Date().toISOString();
    await appendDiagnostics(serviceDiagnostics(services, checkedAt));
    return { checkedAt, services };
  }

  async function createDeployment(request: DeployRequest): Promise<DeploymentJob> {
    const validated = validateDeployRequest(request);
    const { config, mode } = validated;
    const previousConfig = (await configuration.read())?.deployed || defaultConfig();
    const synchronizedServices = servicesRequiringSynchronization(previousConfig, config, {
      forceAll: mode === 'overwrite' || request.password !== undefined
    });
    const job = newJob(mode, synchronizedServices);
    await jobs.save(job);

    try {
      advance(job, 'validating', 'UGREENlink ID 和服务配置均有效。');
      await jobs.save(job);
      await provider.assertWorkerOwnership(target);

      const passwordExists = await provider.hasWorkerPassword(target);
      if (!passwordExists && !request.password) {
        throw new ApplicationError(400, 'password_required', '首次发布需要填写 NAS 密码。');
      }

      advance(job, 'provisioning', '正在准备会话缓存。');
      await jobs.save(job);
      const namespace = await provider.ensureKvNamespace(target);
      job.kvNamespaceTitle = namespace.title;
      job.kvNamespaceIdSuffix = namespace.id.slice(-6);
      advance(job, 'provisioning', '会话缓存已就绪。');
      await jobs.save(job);

      advance(job, 'uploading', '正在发布服务配置。');
      await jobs.save(job);
      const upload = await provider.uploadWorker(target, config, namespace);
      await provider.saveConfiguration(target, config, namespace);
      if (upload.deploymentId) job.cloudflareDeploymentId = upload.deploymentId;
      advance(job, 'uploading', '服务已发布。');
      await jobs.save(job);

      if (request.password) {
        await provider.updatePassword(target, request.password);
        job.passwordUpdated = true;
        advance(job, 'secret_updated', '登录密码已安全更新。');
        await jobs.save(job);
      }

      const desiredHostnames = config.services
        .filter((service) => service.enabled !== false)
        .map((service) => service.hostname);
      advance(job, 'routing', '正在配置自定义访问域名。');
      await jobs.save(job);
      await provider.reconcileDomains(target, desiredHostnames);
      await provider.updateSubdomain(target, false, false);
      advance(job, 'routing', `${desiredHostnames.length} 个访问域名已配置。`);
      await jobs.save(job);

      const latest = await provider.latestDeployment(target);
      if (latest) job.cloudflareDeploymentId = latest.id;
      if (job.services.length === 0) {
        advance(job, 'healthy', '配置已发布，没有需要重新检查的服务入口。');
      } else {
        await health.check(job.services);
        await appendDiagnostics(serviceDiagnostics(job.services, new Date().toISOString(), job));
        advance(
          job,
          job.services.every((service) => service.healthy) ? 'healthy' : 'checking',
          job.services.every((service) => service.healthy)
            ? '服务已发布，本次修改涉及的入口均已生效。'
            : '服务已发布，正在等待本次修改涉及的入口生效。'
        );
      }
      await configuration.write({
        version: 1,
        deployed: config,
        updatedAt: new Date().toISOString()
      });
    } catch (error) {
      job.failure = deploymentFailure(error, job.phase);
      advance(job, 'failed', failureMessage(job.failure));
    }

    await jobs.save(job);
    const diagnostic = deploymentDiagnostic(job);
    if (diagnostic) await appendDiagnostics([diagnostic]);
    return job;
  }

  async function refreshDeployment(id: string): Promise<DeploymentJob> {
    const job = await jobs.read(id);
    if (!job) throw new ApplicationError(404, 'deployment_not_found', '找不到这次部署记录。');
    if (job.phase === 'healthy' || job.phase === 'failed') return job;

    const jobTarget: WorkerTarget = {
      accountId: job.accountId,
      accountName: job.accountName,
      workerName: job.workerName
    };
    try {
      const latest = await provider.latestDeployment(jobTarget);
      if (latest) job.cloudflareDeploymentId = latest.id;
      await health.check(job.services);
      await appendDiagnostics(serviceDiagnostics(job.services, new Date().toISOString(), job));
      const healthy = job.services.length === 0 || job.services.every((service) => service.healthy);
      const age = Date.now() - new Date(job.createdAt).getTime();
      if (healthy) {
        advance(job, 'healthy', '服务已发布，本次修改涉及的入口均已生效。');
      } else if (age > HEALTH_TIMEOUT_MS) {
        job.failure = {
          phase: 'checking',
          stage: 'service_check',
          code: 'service_health_timeout',
          summary: '部分访问域名在 15 分钟内仍无法正常使用。'
        };
        advance(job, 'failed', '服务已发布，但部分访问域名在 15 分钟内仍无法正常使用。');
      } else {
        advance(job, 'checking', '服务已发布，正在等待本次修改涉及的入口生效。');
      }
    } catch (error) {
      job.failure = deploymentFailure(error, job.phase);
      advance(job, 'failed', failureMessage(job.failure));
    }
    await jobs.save(job);
    const diagnostic = deploymentDiagnostic(job);
    if (diagnostic) await appendDiagnostics([diagnostic]);
    return job;
  }

  async function listDiagnostics(): Promise<DiagnosticEntry[]> {
    return diagnostics.list(100);
  }

  return { checkPublishedServices, createDeployment, listDiagnostics, refreshDeployment };
}
