import { afterEach, describe, expect, it, vi } from 'vitest';
import { createDeploymentService } from '../../src/application/console/deployment-service';
import { defaultConfig } from '../../src/domain/configuration/defaults';
import type { UglinkConfig } from '../../src/domain/configuration/model';
import type { WorkerTarget } from '../../src/domain/deployment/model';
import { createCloudflareDeploymentProvider } from '../../src/infrastructure/cloudflare/api-client';
import { httpServiceHealthChecker } from '../../src/infrastructure/health/http-service-health-checker';
import { createKvDeploymentJobRepository } from '../../src/infrastructure/persistence/kv-deployment-job-repository';
import { createKvDiagnosticLogRepository } from '../../src/infrastructure/persistence/kv-diagnostic-log-repository';
import { createKvConfigurationRepository } from '../../src/infrastructure/persistence/kv-configuration-repository';
import { randomToken } from '../../src/infrastructure/security/session-crypto';

function envelope(result: unknown, status = 200): Response {
  return new Response(JSON.stringify({
    success: status >= 200 && status < 300,
    result,
    errors: status >= 400 ? [{ code: 1000, message: 'mock failure' }] : []
  }), { status, headers: { 'Content-Type': 'application/json' } });
}

function configuredConfig(): UglinkConfig {
  const config = defaultConfig();
  config.uglink = {
    id: 'test-device',
    username: 'test-user'
  };
  config.services = [{
    name: 'app',
    hostname: 'app.example.com',
    port: 8080,
    enabled: true
  }];
  config.deployment = { workersDev: false, previewUrls: false };
  return config;
}

function fakeKv(): KVNamespace {
  const values = new Map<string, string>();
  return {
    async get(key: string, type?: string) {
      const value = values.get(key) ?? null;
      if (type === 'json' && value) return JSON.parse(value) as unknown;
      return value;
    },
    async put(key: string, value: string | ArrayBuffer | ArrayBufferView | ReadableStream, _options?: unknown) {
      values.set(key, String(value));
    },
    async delete(key: string) {
      values.delete(key);
    }
  } as KVNamespace;
}

function service() {
  const target: WorkerTarget = {
    accountId: 'account-id',
    accountName: 'Test Account',
    workerName: 'uglink-test'
  };
  const namespace = fakeKv();
  return createDeploymentService({
    target,
    provider: createCloudflareDeploymentProvider('api-token'),
    jobs: createKvDeploymentJobRepository(
      namespace,
      'test-session-id-that-is-long-enough-for-storage'
    ),
    diagnostics: createKvDiagnosticLogRepository(
      namespace,
      'test-session-id-that-is-long-enough-for-storage',
      target
    ),
    configuration: createKvConfigurationRepository(namespace, target),
    health: httpServiceHealthChecker,
    tokens: { create: randomToken }
  });
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe('production Cloudflare deployment', () => {
  it('checks every locally published service without requiring a deployment job', async () => {
    let healthResult: 'healthy' | 'unconfigured' | 'http-error' = 'healthy';
    const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      expect(url).toBe('https://app.example.com/.well-known/uglink-worker-health');
      if (healthResult === 'http-error') return new Response(null, { status: 404 });
      return new Response(JSON.stringify({
        status: 'ok',
        hostnameConfigured: healthResult === 'healthy'
      }), {
        headers: { 'Content-Type': 'application/json' }
      });
    });
    vi.stubGlobal('fetch', fetchMock);

    const deployment = service();
    const health = await deployment.checkPublishedServices(configuredConfig());

    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(health.services).toEqual([expect.objectContaining({
      serviceName: 'app',
      hostname: 'app.example.com',
      port: 8080,
      healthy: true,
      detail: 'Worker 已部署且域名配置正常',
      code: 'healthy',
      stage: 'worker_configuration',
      httpStatus: 200
    })]);

    healthResult = 'unconfigured';
    const unhealthy = await deployment.checkPublishedServices(configuredConfig());
    expect(unhealthy.services[0]).toMatchObject({
      healthy: false,
      detail: '服务尚未识别此访问域名',
      code: 'worker_hostname_unconfigured',
      stage: 'worker_configuration'
    });
    expect(fetchMock).toHaveBeenCalledTimes(2);

    healthResult = 'http-error';
    const unavailable = await deployment.checkPublishedServices(configuredConfig());
    expect(unavailable.services[0]).toMatchObject({
      healthy: false,
      detail: '服务入口返回 HTTP 404',
      code: 'service_entry_http_error',
      stage: 'service_entry',
      httpStatus: 404
    });
    expect(fetchMock).toHaveBeenCalledTimes(3);

    const diagnostics = await deployment.listDiagnostics();
    expect(diagnostics[0]).toMatchObject({
      source: 'health_check',
      code: 'service_entry_http_error',
      stage: 'service_entry',
      httpStatus: 404,
      service: { name: 'app', hostname: 'app.example.com', port: 8080 }
    });
  });

  it('provisions KV, uploads the Worker, preserves Secret bindings, and reconciles domains', async () => {
    const calls: Array<{ url: string; method: string; body?: BodyInit | null }> = [];
    vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      const method = init?.method || 'GET';
      calls.push({ url, method, body: init?.body });

      if (url.endsWith('/secrets') && method === 'GET') {
        return envelope([{ name: 'PASSWORD', type: 'secret_text' }]);
      }
      if (url.endsWith('/workers/scripts/uglink-test/settings') && method === 'GET') {
        return envelope({
          bindings: [
            { name: 'UGLINK_CONTROL_MANAGED', type: 'plain_text', text: 'v1' },
            { name: 'UGLINK_ID', type: 'plain_text', text: 'test-device' },
            { name: 'USERNAME', type: 'plain_text', text: 'test-user' },
            { name: 'SERVICE_MAP', type: 'plain_text', text: '{}' },
            { name: 'UGLINK_CACHE', type: 'kv_namespace' }
          ]
        });
      }
      if (url.includes('/storage/kv/namespaces') && method === 'GET') {
        return envelope([{ id: 'namespace-id-123456', title: 'uglink-test-uglink-cache' }]);
      }
      if (url.endsWith('/workers/scripts/uglink-test') && method === 'PUT') {
        return envelope({ id: 'uglink-test', deployment_id: 'deployment-id' });
      }
      if (url.endsWith(
        '/storage/kv/namespaces/namespace-id-123456/values/uglink-control%3Aconfiguration%3Av2'
      ) && method === 'PUT') {
        return envelope({});
      }
      if (url.endsWith('/workers/domains') && method === 'GET') {
        return envelope([{
          id: 'old-domain-id',
          hostname: 'old.example.com',
          service: 'uglink-test',
          zone_id: 'zone-id',
          zone_name: 'example.com'
        }]);
      }
      if (url.endsWith('/workers/domains') && method === 'PUT') return envelope({ id: 'new-domain-id' });
      if (url.endsWith('/workers/domains/old-domain-id') && method === 'DELETE') return envelope(null);
      if (url.endsWith('/workers/scripts/uglink-test/subdomain') && method === 'POST') {
        return envelope({ enabled: false, previews_enabled: false });
      }
      if (url.endsWith('/workers/scripts/uglink-test/deployments') && method === 'GET') {
        return envelope({ deployments: [{ id: 'deployment-id', created_on: new Date().toISOString(), source: 'api' }] });
      }
      if (url === 'https://app.example.com/.well-known/uglink-worker-health') {
        return new Response(JSON.stringify({
          status: 'ok',
          hostnameConfigured: true
        }), {
          headers: { 'Content-Type': 'application/json' }
        });
      }
      if (url === 'https://app.example.com/' && method === 'HEAD') {
        return new Response(null, { status: 204 });
      }
      throw new Error(`Unexpected fetch: ${method} ${url}`);
    }));

    const requestedConfig = configuredConfig();
    requestedConfig.deployment = { workersDev: true, previewUrls: true };
    const job = await service().createDeployment({ config: requestedConfig });

    expect(job.phase).toBe('healthy');
    expect(job.mode).toBe('publish');
    expect(job.kvNamespaceTitle).toBe('uglink-test-uglink-cache');
    expect(job.cloudflareDeploymentId).toBe('deployment-id');

    const upload = calls.find((call) => call.url.endsWith('/workers/scripts/uglink-test') && call.method === 'PUT');
    expect(upload?.body).toBeInstanceOf(FormData);
    const metadataPart = (upload!.body as FormData).get('metadata');
    expect(metadataPart).toBeInstanceOf(Blob);
    const metadata = JSON.parse(await (metadataPart as Blob).text()) as {
      keep_bindings: string[];
      bindings: Array<{ name: string; type: string; namespace_id?: string }>;
    };
    expect(metadata.keep_bindings).toEqual(['secret_text', 'secret_key']);
    expect(metadata.bindings).toContainEqual({
      name: 'UGLINK_CACHE',
      type: 'kv_namespace',
      namespace_id: 'namespace-id-123456'
    });
    expect(metadata.bindings).toContainEqual({
      name: 'UGLINK_CONTROL_MANAGED',
      type: 'plain_text',
      text: 'v1'
    });
    expect(metadata.bindings).toContainEqual({
      name: 'UGLINK_ID',
      type: 'plain_text',
      text: 'test-device'
    });
    expect(metadata.bindings).toContainEqual({
      name: 'USERNAME',
      type: 'plain_text',
      text: 'test-user'
    });
    expect(metadata.bindings.some((binding) => binding.name === 'BASE_URL')).toBe(false);
    expect(metadata.bindings.some((binding) => binding.name === 'PASSWORD')).toBe(false);
    const cloudConfiguration = calls.find((call) => (
      call.url.endsWith('/values/uglink-control%3Aconfiguration%3Av2')
      && call.method === 'PUT'
    ));
    expect(cloudConfiguration?.body).toBe(JSON.stringify(configuredConfig()));
    expect(String(cloudConfiguration?.body)).not.toContain('password');
    expect(String(cloudConfiguration?.body)).not.toContain('relayDomain');

    const uploadIndex = calls.findIndex((call) => (
      call.url.endsWith('/workers/scripts/uglink-test') && call.method === 'PUT'
    ));
    const configurationIndex = calls.findIndex((call) => (
      call.url.endsWith('/values/uglink-control%3Aconfiguration%3Av2') && call.method === 'PUT'
    ));
    expect(configurationIndex).toBeGreaterThan(uploadIndex);

    const attachIndex = calls.findIndex((call) => call.url.endsWith('/workers/domains') && call.method === 'PUT');
    const detachIndex = calls.findIndex((call) => call.url.endsWith('/workers/domains/old-domain-id') && call.method === 'DELETE');
    expect(attachIndex).toBeGreaterThan(-1);
    expect(detachIndex).toBeGreaterThan(attachIndex);

    const subdomain = calls.find((call) => (
      call.url.endsWith('/workers/scripts/uglink-test/subdomain') && call.method === 'POST'
    ));
    expect(subdomain?.body).toBe(JSON.stringify({ enabled: false, previews_enabled: false }));

  });

  it('checks only changed services while keeping every active domain configured', async () => {
    const target: WorkerTarget = {
      accountId: 'account-id',
      accountName: 'Test Account',
      workerName: 'uglink-test'
    };
    let persistedConfiguration: Awaited<ReturnType<ReturnType<typeof createKvConfigurationRepository>['read']>>;
    let tokenSequence = 0;
    const jobs = new Map<string, Awaited<ReturnType<ReturnType<typeof service>['createDeployment']>>>();
    const reconcileDomains = vi.fn(async () => undefined);
    const check = vi.fn(async (services: Array<{ healthy: boolean; detail: string }>) => {
      for (const entry of services) {
        entry.healthy = true;
        entry.detail = 'Worker 已部署且域名配置正常';
      }
    });
    const deployment = createDeploymentService({
      target,
      provider: {
        assertWorkerOwnership: vi.fn(async () => undefined),
        hasWorkerPassword: vi.fn(async () => true),
        ensureKvNamespace: vi.fn(async () => ({ id: 'namespace-id', title: 'namespace-title' })),
        uploadWorker: vi.fn(async () => ({ deploymentId: 'deployment-id' })),
        saveConfiguration: vi.fn(async () => undefined),
        updatePassword: vi.fn(async () => undefined),
        reconcileDomains,
        updateSubdomain: vi.fn(async () => undefined),
        latestDeployment: vi.fn(async () => ({
          id: 'deployment-id',
          createdAt: new Date().toISOString(),
          source: 'api'
        })),
        dashboardUrl: vi.fn(() => 'https://dash.cloudflare.com/')
      },
      jobs: {
        async save(job) {
          jobs.set(job.id, structuredClone(job));
        },
        async read(id) {
          return jobs.get(id);
        }
      },
      diagnostics: {
        append: vi.fn(async () => undefined),
        list: vi.fn(async () => []),
        replace: vi.fn(async () => undefined)
      },
      configuration: {
        async read() {
          return persistedConfiguration;
        },
        async write(state) {
          persistedConfiguration = structuredClone(state);
        }
      },
      health: { check },
      tokens: { create: () => `test-token-${++tokenSequence}` }
    });
    const initial = configuredConfig();
    initial.services.push({
      name: 'photos',
      hostname: 'photos.example.com',
      port: 3000,
      enabled: true
    });

    const first = await deployment.createDeployment({ config: initial });
    const edited = structuredClone(initial);
    edited.services[1]!.port = 3001;
    const second = await deployment.createDeployment({ config: edited });

    expect(first.services.map((entry) => entry.hostname)).toEqual([
      'app.example.com',
      'photos.example.com'
    ]);
    expect(second.services).toEqual([
      expect.objectContaining({ hostname: 'photos.example.com', port: 3001, healthy: true })
    ]);
    expect(check).toHaveBeenNthCalledWith(1, expect.arrayContaining([
      expect.objectContaining({ hostname: 'app.example.com' }),
      expect.objectContaining({ hostname: 'photos.example.com' })
    ]));
    expect(check).toHaveBeenNthCalledWith(2, [
      expect.objectContaining({ hostname: 'photos.example.com', port: 3001 })
    ]);
    expect(reconcileDomains).toHaveBeenLastCalledWith(target, [
      'app.example.com',
      'photos.example.com'
    ]);
  });

  it('overwrites the managed Worker when redeployment is requested', async () => {
    let uploadCount = 0;
    vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      const method = init?.method || 'GET';
      if (url.endsWith('/workers/scripts/uglink-test/settings') && method === 'GET') {
        return envelope({ bindings: [{ name: 'UGLINK_CONTROL_MANAGED', type: 'plain_text', text: 'v1' }] });
      }
      if (url.endsWith('/secrets') && method === 'GET') {
        return envelope([{ name: 'PASSWORD', type: 'secret_text' }]);
      }
      if (url.includes('/storage/kv/namespaces') && method === 'GET') {
        return envelope([{ id: 'namespace-id-123456', title: 'uglink-test-uglink-cache' }]);
      }
      if (url.endsWith('/workers/scripts/uglink-test') && method === 'PUT') {
        uploadCount += 1;
        return envelope({ deployment_id: `deployment-${uploadCount}` });
      }
      if (url.endsWith('/values/uglink-control%3Aconfiguration%3Av2') && method === 'PUT') {
        return envelope({});
      }
      if (url.endsWith('/workers/domains') && method === 'GET') return envelope([]);
      if (url.endsWith('/workers/domains') && method === 'PUT') return envelope({ id: 'domain-id' });
      if (url.endsWith('/workers/scripts/uglink-test/subdomain') && method === 'POST') return envelope({});
      if (url.endsWith('/workers/scripts/uglink-test/deployments') && method === 'GET') {
        return envelope({ deployments: [{ id: `deployment-${uploadCount}`, created_on: new Date().toISOString(), source: 'api' }] });
      }
      if (url === 'https://app.example.com/.well-known/uglink-worker-health') {
        return new Response(JSON.stringify({ status: 'ok', hostnameConfigured: true }));
      }
      if (url === 'https://app.example.com/' && method === 'HEAD') return new Response(null, { status: 204 });
      throw new Error(`Unexpected fetch: ${method} ${url}`);
    }));

    const deployment = service();
    const first = await deployment.createDeployment({ config: configuredConfig() });
    const overwritten = await deployment.createDeployment({
      config: configuredConfig(),
      mode: 'overwrite'
    });

    expect(first.phase).toBe('healthy');
    expect(overwritten.phase).toBe('healthy');
    expect(overwritten.mode).toBe('overwrite');
    expect(uploadCount).toBe(2);
  });

  it('fails safely before creating resources when the first deployment has no password', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => envelope(null, 404)));
    const job = await service().createDeployment({ config: configuredConfig() });
    expect(job.phase).toBe('failed');
    expect(job.message).toContain('首次发布需要填写 NAS 密码');
  });

  it('does not overwrite an unrelated Worker with the same name', async () => {
    const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.endsWith('/workers/scripts/uglink-test/settings')) {
        return envelope({ bindings: [{ name: 'UNRELATED_SETTING', type: 'plain_text', text: 'value' }] });
      }
      throw new Error(`Unexpected fetch: ${url}`);
    });
    vi.stubGlobal('fetch', fetchMock);
    const job = await service().createDeployment({
      config: configuredConfig(),
      password: 'test-password'
    });
    expect(job.phase).toBe('failed');
    expect(job.message).toContain('已被其他 Cloudflare 服务使用');
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });
});
