import type { CloudflareConnection } from '../../application/console/contracts';
import { ApplicationError } from '../../application/common/application-error';
import type {
  CloudflareConnectionProvider,
  CloudflareDeploymentProvider,
  CloudflareDeploymentStatus,
  KvNamespaceReference
} from '../../application/console/ports';
import type { UglinkConfig } from '../../domain/configuration/model';
import type { WorkerTarget } from '../../domain/deployment/model';
import { createWorkerRuntimeBindings } from './worker-configuration';
import {
  TARGET_COMPATIBILITY_DATE,
  TARGET_WORKER_MODULE,
  TARGET_WORKER_SOURCE
} from './target-worker';

const API_ROOT = 'https://api.cloudflare.com/client/v4';

interface CloudflareMessage {
  code?: number;
  message?: string;
}

interface CloudflareEnvelope<T> {
  success: boolean;
  result: T;
  errors?: CloudflareMessage[];
  messages?: CloudflareMessage[];
  result_info?: {
    page?: number;
    total_pages?: number;
    count?: number;
    total_count?: number;
  };
}

interface CloudflareAccount {
  id: string;
  name: string;
}

type CloudflareKvNamespace = KvNamespaceReference;

interface CloudflareSecret {
  name: string;
  type: string;
}

interface CloudflareWorkerSettings {
  bindings?: Array<{
    name?: string;
    type?: string;
    text?: string;
  }>;
}

interface CloudflareDomain {
  id: string;
  hostname: string;
  service: string;
  zone_id: string;
  zone_name: string;
}

interface CloudflareDeployments {
  deployments: Array<{
    id: string;
    created_on: string;
    source: string;
    annotations?: {
      'workers/message'?: string;
    };
  }>;
}

interface CloudflareUploadResult {
  id?: string;
  deployment_id?: string;
  etag?: string;
  startup_time_ms?: number;
}

function apiStatus(status: number): number {
  if (status === 401) return 401;
  if (status === 403) return 403;
  if (status === 409) return 409;
  return 502;
}

async function cloudflareEnvelope<T>(
  path: string,
  token: string,
  init: RequestInit = {},
  allowNotFound = false
): Promise<CloudflareEnvelope<T> | undefined> {
  const headers = new Headers(init.headers);
  headers.set('Accept', 'application/json');
  headers.set('Authorization', `Bearer ${token}`);
  if (typeof init.body === 'string' && !headers.has('Content-Type')) {
    headers.set('Content-Type', 'application/json');
  }

  const response = await fetch(`${API_ROOT}${path}`, { ...init, headers });
  if (allowNotFound && response.status === 404) {
    await response.body?.cancel();
    return undefined;
  }

  const text = await response.text();
  let body: CloudflareEnvelope<T> | undefined;
  if (text) {
    try {
      body = JSON.parse(text) as CloudflareEnvelope<T>;
    } catch {
      body = undefined;
    }
  }
  if (!response.ok || (body && !body.success)) {
    const detail = body?.errors
      ?.map((error) => [error.code, error.message].filter(Boolean).join(': '))
      .filter(Boolean)
      .join('；');
    const code = response.status === 401
      ? 'cloudflare_token_invalid'
      : response.status === 403
        ? 'cloudflare_permission_denied'
        : 'cloudflare_api_failed';
    const message = response.status === 401
      ? 'Cloudflare API Token 无效、已过期或已被撤销。'
      : response.status === 403
        ? 'Cloudflare API Token 无权完成该操作。'
        : 'Cloudflare 暂时无法完成请求。';
    throw new ApplicationError(apiStatus(response.status), code, message, detail || `HTTP ${response.status}`);
  }
  if (!body) {
    return { success: true, result: undefined as T };
  }
  return body;
}

async function cloudflareRequest<T>(
  path: string,
  token: string,
  init: RequestInit = {}
): Promise<T> {
  const body = await cloudflareEnvelope<T>(path, token, init);
  return body!.result;
}

export async function createCloudflareConnection(
  accountId: string,
  apiToken: string
): Promise<CloudflareConnection> {
  const encodedAccountId = encodeURIComponent(accountId);
  const account = await cloudflareRequest<CloudflareAccount>(
    `/accounts/${encodedAccountId}`,
    apiToken
  );
  if (
    typeof account.id !== 'string'
    || account.id.toLowerCase() !== accountId
    || typeof account.name !== 'string'
    || account.name.trim().length === 0
  ) {
    throw new ApplicationError(502, 'cloudflare_account_invalid', 'Cloudflare 返回的账户信息无效。');
  }

  try {
    await Promise.all([
      cloudflareRequest<CloudflareDomain[]>(
        `/accounts/${encodedAccountId}/workers/domains`,
        apiToken
      ),
      cloudflareRequest<CloudflareKvNamespace[]>(
        `/accounts/${encodedAccountId}/storage/kv/namespaces?order=title&direction=asc&per_page=5`,
        apiToken
      )
    ]);
  } catch (error) {
    if (error instanceof ApplicationError && error.status === 403) {
      throw new ApplicationError(
        403,
        'cloudflare_permissions_missing',
        'API Token 缺少管理 Worker 或 Workers KV 的权限。',
        '请授予 Workers Scripts Write 和 Workers KV Storage Write，并把资源范围限定到该账户。'
      );
    }
    throw error;
  }

  return {
    apiToken,
    account: { id: account.id.toLowerCase(), name: account.name.trim() },
    connectedAt: Date.now()
  };
}

export async function hasWorkerPassword(
  apiToken: string,
  target: WorkerTarget
): Promise<boolean> {
  const envelope = await cloudflareEnvelope<CloudflareSecret[]>(
    `/accounts/${encodeURIComponent(target.accountId)}/workers/scripts/${encodeURIComponent(target.workerName)}/secrets`,
    apiToken,
    {},
    true
  );
  return envelope?.result.some((secret) => secret.name === 'PASSWORD') === true;
}

export async function assertWorkerOwnership(
  apiToken: string,
  target: WorkerTarget
): Promise<void> {
  const envelope = await cloudflareEnvelope<CloudflareWorkerSettings>(
    `/accounts/${encodeURIComponent(target.accountId)}/workers/scripts/${encodeURIComponent(target.workerName)}/settings`,
    apiToken,
    {},
    true
  );
  if (!envelope) return;

  const bindings = envelope.result.bindings || [];
  const managed = bindings.some((binding) => (
    binding.name === 'UGLINK_CONTROL_MANAGED'
    && binding.type === 'plain_text'
    && binding.text === 'v1'
  ));
  if (managed) return;

  throw new ApplicationError(
    409,
    'cloudflare_worker_name_conflict',
    `服务名称“${target.workerName}”已被其他 Cloudflare 服务使用。`,
    '请选择新的服务名称；系统不会覆盖现有服务。'
  );
}

export async function ensureKvNamespace(
  apiToken: string,
  target: WorkerTarget
): Promise<CloudflareKvNamespace> {
  const title = `${target.workerName}-uglink-cache`;
  const namespaces = await cloudflareRequest<CloudflareKvNamespace[]>(
    `/accounts/${encodeURIComponent(target.accountId)}/storage/kv/namespaces?order=title&direction=asc&per_page=1000`,
    apiToken
  );
  const existing = namespaces.find((namespace) => namespace.title === title);
  if (existing) return existing;
  return cloudflareRequest<CloudflareKvNamespace>(
    `/accounts/${encodeURIComponent(target.accountId)}/storage/kv/namespaces`,
    apiToken,
    { method: 'POST', body: JSON.stringify({ title }) }
  );
}

export async function uploadProxyWorker(
  apiToken: string,
  target: WorkerTarget,
  config: UglinkConfig,
  namespace: CloudflareKvNamespace
): Promise<CloudflareUploadResult> {
  const runtimeBindings = await createWorkerRuntimeBindings(config);
  const metadata = {
    main_module: TARGET_WORKER_MODULE,
    bindings: [
      { name: 'UGLINK_CACHE', type: 'kv_namespace', namespace_id: namespace.id },
      ...Object.entries(runtimeBindings).map(([name, text]) => ({ name, type: 'plain_text', text })),
      { name: 'UGLINK_CONTROL_MANAGED', type: 'plain_text', text: 'v1' }
    ],
    compatibility_date: TARGET_COMPATIBILITY_DATE,
    compatibility_flags: ['nodejs_compat'],
    keep_bindings: ['secret_text', 'secret_key'],
    observability: { enabled: true, head_sampling_rate: 1 }
  };
  const form = new FormData();
  form.set('metadata', new Blob([JSON.stringify(metadata)], { type: 'application/json' }));
  form.set(
    TARGET_WORKER_MODULE,
    new Blob([TARGET_WORKER_SOURCE], { type: 'application/javascript+module' }),
    TARGET_WORKER_MODULE
  );
  return cloudflareRequest<CloudflareUploadResult>(
    `/accounts/${encodeURIComponent(target.accountId)}/workers/scripts/${encodeURIComponent(target.workerName)}`,
    apiToken,
    { method: 'PUT', body: form }
  );
}

export async function updateWorkerPassword(
  apiToken: string,
  target: WorkerTarget,
  password: string
): Promise<void> {
  if (password.length < 1 || password.length > 4096) {
    throw new ApplicationError(400, 'invalid_password', 'NAS 密码长度无效。');
  }
  await cloudflareRequest(
    `/accounts/${encodeURIComponent(target.accountId)}/workers/scripts/${encodeURIComponent(target.workerName)}/secrets`,
    apiToken,
    {
      method: 'PUT',
      body: JSON.stringify({ name: 'PASSWORD', text: password, type: 'secret_text' })
    }
  );
}

export async function reconcileWorkerDomains(
  apiToken: string,
  target: WorkerTarget,
  desiredHostnames: string[]
): Promise<void> {
  const domains = await cloudflareRequest<CloudflareDomain[]>(
    `/accounts/${encodeURIComponent(target.accountId)}/workers/domains`,
    apiToken
  );
  const desired = new Set(desiredHostnames.map((hostname) => hostname.toLowerCase()));
  const conflict = domains.find((domain) => (
    desired.has(domain.hostname.toLowerCase()) && domain.service !== target.workerName
  ));
  if (conflict) {
    throw new ApplicationError(
      409,
      'cloudflare_domain_conflict',
      `${conflict.hostname} 已绑定到另一个服务。`,
      `当前目标：${conflict.service}`
    );
  }

  const current = domains.filter((domain) => domain.service === target.workerName);
  const currentHosts = new Set(current.map((domain) => domain.hostname.toLowerCase()));
  for (const hostname of desired) {
    if (currentHosts.has(hostname)) continue;
    await cloudflareRequest(
      `/accounts/${encodeURIComponent(target.accountId)}/workers/domains`,
      apiToken,
      { method: 'PUT', body: JSON.stringify({ hostname, service: target.workerName }) }
    );
  }

  for (const domain of current) {
    if (desired.has(domain.hostname.toLowerCase())) continue;
    await cloudflareRequest(
      `/accounts/${encodeURIComponent(target.accountId)}/workers/domains/${encodeURIComponent(domain.id)}`,
      apiToken,
      { method: 'DELETE' }
    );
  }
}

export async function updateWorkerSubdomain(
  apiToken: string,
  target: WorkerTarget,
  workersDev: boolean,
  previewUrls: boolean
): Promise<void> {
  await cloudflareRequest(
    `/accounts/${encodeURIComponent(target.accountId)}/workers/scripts/${encodeURIComponent(target.workerName)}/subdomain`,
    apiToken,
    {
      method: 'POST',
      headers: { 'Cloudflare-Workers-Script-Api-Date': '2025-08-01' },
      body: JSON.stringify({ enabled: workersDev, previews_enabled: previewUrls })
    }
  );
}

export async function getLatestCloudflareDeployment(
  apiToken: string,
  target: WorkerTarget
): Promise<CloudflareDeploymentStatus | undefined> {
  const result = await cloudflareRequest<CloudflareDeployments>(
    `/accounts/${encodeURIComponent(target.accountId)}/workers/scripts/${encodeURIComponent(target.workerName)}/deployments`,
    apiToken
  );
  const deployment = result.deployments[0];
  if (!deployment) return undefined;
  return {
    id: deployment.id,
    createdAt: deployment.created_on,
    source: deployment.source,
    ...(deployment.annotations?.['workers/message']
      ? { message: deployment.annotations['workers/message'] }
      : {})
  };
}

export function cloudflareDashboardUrl(target: WorkerTarget): string {
  return `https://dash.cloudflare.com/${target.accountId}/workers/services/view/${encodeURIComponent(target.workerName)}/production`;
}

export const cloudflareConnectionProvider: CloudflareConnectionProvider = {
  connect: createCloudflareConnection
};

export function createCloudflareDeploymentProvider(apiToken: string): CloudflareDeploymentProvider {
  return {
    assertWorkerOwnership: (target) => assertWorkerOwnership(apiToken, target),
    hasWorkerPassword: (target) => hasWorkerPassword(apiToken, target),
    ensureKvNamespace: (target) => ensureKvNamespace(apiToken, target),
    async uploadWorker(target, config, namespace) {
      const result = await uploadProxyWorker(apiToken, target, config, namespace);
      return { ...(result.deployment_id ? { deploymentId: result.deployment_id } : {}) };
    },
    updatePassword: (target, password) => updateWorkerPassword(apiToken, target, password),
    reconcileDomains: (target, hostnames) => reconcileWorkerDomains(apiToken, target, hostnames),
    updateSubdomain: (target, workersDev, previewUrls) => (
      updateWorkerSubdomain(apiToken, target, workersDev, previewUrls)
    ),
    latestDeployment: (target) => getLatestCloudflareDeployment(apiToken, target),
    dashboardUrl: cloudflareDashboardUrl
  };
}
