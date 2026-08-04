import { connectCloudflare } from '../../../application/console/connection-service';
import { createBackupService } from '../../../application/console/backup-service';
import { createConfigurationService } from '../../../application/console/configuration-service';
import type {
  BackupPassphraseRequest,
  BackupRestoreRequest,
  BootstrapResponse,
  CloudflareConnectionRequest,
  ConfigurationImportRequest,
  DeployRequest,
  ProviderStatus
} from '../../../application/console/contracts';
import { createDeploymentService } from '../../../application/console/deployment-service';
import { ApplicationError } from '../../../application/common/application-error';
import type { UglinkConfig } from '../../../domain/configuration/model';
import { validateUglinkConfig } from '../../../domain/configuration/validation';
import {
  cloudflareConnectionProvider,
  createCloudflareDeploymentProvider
} from '../../../infrastructure/cloudflare/api-client';
import { httpServiceHealthChecker } from '../../../infrastructure/health/http-service-health-checker';
import {
  applySessionCookie,
  assertCsrf,
  getOrCreateSession,
  saveSession,
  type SessionHandle
} from '../../../infrastructure/persistence/console-session';
import { createKvDeploymentJobRepository } from '../../../infrastructure/persistence/kv-deployment-job-repository';
import { createKvDiagnosticLogRepository } from '../../../infrastructure/persistence/kv-diagnostic-log-repository';
import { createKvConfigurationRepository } from '../../../infrastructure/persistence/kv-configuration-repository';
import { portableBackupCipher } from '../../../infrastructure/security/portable-backup';
import { randomToken } from '../../../infrastructure/security/session-crypto';
import { apiError, assertSameOrigin, json, readJson } from '../http';
import type { ConsoleWorkerEnv } from './environment';

function providerStatus(connected: boolean, label?: string, detail?: string): ProviderStatus {
  return connected
    ? { state: 'connected', ...(label ? { label } : {}), ...(detail ? { detail } : {}) }
    : { state: 'disconnected' };
}

async function bootstrap(env: ConsoleWorkerEnv, session: SessionHandle): Promise<BootstrapResponse> {
  const connection = session.data.cloudflare;
  const target = session.data.target;
  const cloudflare = providerStatus(
    Boolean(connection),
    connection?.account.name,
    target ? `服务 · ${target.workerName}` : undefined
  );
  const configuration = target
    ? await createConfigurationService(
      createKvConfigurationRepository(env.CONSOLE_SESSIONS, target)
    ).read()
    : undefined;
  return {
    title: env.CONSOLE_TITLE || 'UGLINK Control',
    authenticated: Boolean(connection && target),
    csrfToken: session.data.csrfToken,
    providers: { cloudflare },
    ...(target && configuration ? {
      target: {
        ...target,
        accountIdSuffix: target.accountId.slice(-6)
      },
      configuration
    } : {})
  };
}

function deploymentService(env: ConsoleWorkerEnv, session: SessionHandle) {
  const connection = session.data.cloudflare;
  const target = session.data.target;
  if (!connection || !target) {
    throw new ApplicationError(401, 'cloudflare_not_connected', '请先配置 Cloudflare API Token。');
  }
  return createDeploymentService({
    target,
    provider: createCloudflareDeploymentProvider(connection.apiToken),
    jobs: createKvDeploymentJobRepository(env.CONSOLE_SESSIONS, session.id),
    diagnostics: createKvDiagnosticLogRepository(env.CONSOLE_SESSIONS, session.id, target),
    configuration: createKvConfigurationRepository(env.CONSOLE_SESSIONS, target),
    health: httpServiceHealthChecker,
    tokens: { create: randomToken }
  });
}

async function connect(
  env: ConsoleWorkerEnv,
  session: SessionHandle,
  request: CloudflareConnectionRequest
): Promise<BootstrapResponse> {
  const result = await connectCloudflare(request, cloudflareConnectionProvider);
  session.data.cloudflare = result.connection;
  session.data.target = {
    accountId: result.connection.account.id,
    accountName: result.connection.account.name,
    workerName: result.workerName
  };
  await saveSession(env, session);
  return bootstrap(env, session);
}

async function route(request: Request, env: ConsoleWorkerEnv, session: SessionHandle): Promise<Response> {
  const { pathname } = new URL(request.url);
  if (request.method === 'GET' && pathname === '/api/bootstrap') {
    return json(await bootstrap(env, session));
  }

  if (request.method === 'POST' && pathname === '/api/connections/cloudflare') {
    assertSameOrigin(request);
    assertCsrf(request, session);
    const body = await readJson<CloudflareConnectionRequest>(request, 8_192);
    return json(await connect(env, session, body));
  }

  if (request.method === 'POST' && pathname === '/api/validate') {
    assertSameOrigin(request);
    assertCsrf(request, session);
    deploymentService(env, session);
    const body = await readJson<{ config?: UglinkConfig }>(request);
    return json(validateUglinkConfig(body.config));
  }

  if (request.method === 'POST' && pathname === '/api/configuration/draft') {
    assertSameOrigin(request);
    assertCsrf(request, session);
    const target = session.data.target;
    if (!target) throw new ApplicationError(401, 'cloudflare_not_connected', '请先配置 Cloudflare API Token。');
    const body = await readJson<ConfigurationImportRequest>(request);
    const service = createConfigurationService(createKvConfigurationRepository(env.CONSOLE_SESSIONS, target));
    return json(await service.saveDraft(body.config));
  }

  if (request.method === 'POST' && pathname === '/api/configuration/import') {
    assertSameOrigin(request);
    assertCsrf(request, session);
    const target = session.data.target;
    if (!target) throw new ApplicationError(401, 'cloudflare_not_connected', '请先配置 Cloudflare API Token。');
    const body = await readJson<ConfigurationImportRequest>(request);
    const service = createConfigurationService(createKvConfigurationRepository(env.CONSOLE_SESSIONS, target));
    return json(await service.importAsDraft(body.config));
  }

  if (request.method === 'GET' && pathname === '/api/configuration/export') {
    const target = session.data.target;
    if (!target) throw new ApplicationError(401, 'cloudflare_not_connected', '请先配置 Cloudflare API Token。');
    const service = createConfigurationService(createKvConfigurationRepository(env.CONSOLE_SESSIONS, target));
    return json(await service.exportCurrent());
  }

  if (request.method === 'POST' && pathname === '/api/deploy') {
    assertSameOrigin(request);
    assertCsrf(request, session);
    const body = await readJson<DeployRequest>(request);
    return json(await deploymentService(env, session).createDeployment(body), { status: 202 });
  }

  if (request.method === 'POST' && pathname === '/api/services/health') {
    assertSameOrigin(request);
    assertCsrf(request, session);
    const body = await readJson<{ config?: UglinkConfig }>(request);
    return json(await deploymentService(env, session).checkPublishedServices(body.config));
  }

  if (request.method === 'GET' && pathname === '/api/diagnostics') {
    return json({ entries: await deploymentService(env, session).listDiagnostics() });
  }

  if (request.method === 'POST' && pathname === '/api/backups/export') {
    assertSameOrigin(request);
    assertCsrf(request, session);
    const connection = session.data.cloudflare;
    const target = session.data.target;
    if (!connection || !target) {
      throw new ApplicationError(401, 'cloudflare_not_connected', '请先配置 Cloudflare API Token。');
    }
    const body = await readJson<BackupPassphraseRequest>(request, 4_096);
    const configurationRepository = createKvConfigurationRepository(env.CONSOLE_SESSIONS, target);
    const diagnostics = createKvDiagnosticLogRepository(env.CONSOLE_SESSIONS, session.id, target);
    const configuration = await createConfigurationService(configurationRepository).read();
    const backup = createBackupService(portableBackupCipher, cloudflareConnectionProvider);
    return json(await backup.exportBackup({
      connection,
      target,
      configuration: {
        version: 1,
        deployed: configuration.deployed,
        ...(configuration.draft ? { draft: configuration.draft } : {}),
        updatedAt: configuration.updatedAt
      },
      diagnostics: await diagnostics.list(100)
    }, body.passphrase));
  }

  if (request.method === 'POST' && pathname === '/api/backups/restore') {
    assertSameOrigin(request);
    assertCsrf(request, session);
    const body = await readJson<BackupRestoreRequest>(request, 1_048_576);
    const backup = createBackupService(portableBackupCipher, cloudflareConnectionProvider);
    const restored = await backup.restoreBackup(body.backup, body.passphrase);
    session.data.cloudflare = restored.connection;
    session.data.target = restored.target;
    const configuration = createConfigurationService(
      createKvConfigurationRepository(env.CONSOLE_SESSIONS, restored.target)
    );
    const diagnostics = createKvDiagnosticLogRepository(
      env.CONSOLE_SESSIONS,
      session.id,
      restored.target
    );
    await Promise.all([
      configuration.replace(restored.configuration),
      diagnostics.replace(restored.diagnostics),
      saveSession(env, session)
    ]);
    return json(await bootstrap(env, session));
  }

  const deploymentMatch = pathname.match(/^\/api\/deployments\/([A-Za-z0-9_-]{12,80})$/u);
  if (request.method === 'GET' && deploymentMatch?.[1]) {
    return json(await deploymentService(env, session).refreshDeployment(deploymentMatch[1]));
  }

  if (request.method === 'POST' && pathname === '/api/connections/cloudflare/reset') {
    assertSameOrigin(request);
    assertCsrf(request, session);
    delete session.data.cloudflare;
    delete session.data.target;
    await saveSession(env, session);
    return json({ ok: true });
  }
  throw new ApplicationError(404, 'not_found', '找不到这个 API。');
}

export default {
  async fetch(request: Request, env: ConsoleWorkerEnv): Promise<Response> {
    const { pathname } = new URL(request.url);
    if (request.method === 'GET' && pathname === '/api/health') {
      return json({ status: 'ok' });
    }

    let session: SessionHandle | undefined;
    try {
      session = await getOrCreateSession(request, env);
      return applySessionCookie(request, await route(request, env, session), session);
    } catch (error) {
      const response = apiError(error);
      return session ? applySessionCookie(request, response, session) : response;
    }
  }
} satisfies ExportedHandler<ConsoleWorkerEnv>;
