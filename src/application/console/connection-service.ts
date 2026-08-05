import { ApplicationError } from '../common/application-error';
import type { CloudflareConnectionRequest } from './contracts';
import type { CloudflareConnectionProvider } from './ports';

const ACCOUNT_ID = /^[a-f0-9]{32}$/u;
const WORKER_NAME = /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/u;

export function normalizeConnectionRequest(
  request: CloudflareConnectionRequest
): CloudflareConnectionRequest {
  const accountId = typeof request.accountId === 'string'
    ? request.accountId.trim().toLowerCase()
    : '';
  if (!ACCOUNT_ID.test(accountId)) {
    throw new ApplicationError(
      400,
      'invalid_cloudflare_account_id',
      'Cloudflare Account ID 必须是 32 位十六进制字符。'
    );
  }

  const apiToken = typeof request.apiToken === 'string' ? request.apiToken.trim() : '';
  if (apiToken.length < 20 || apiToken.length > 4096) {
    throw new ApplicationError(400, 'invalid_cloudflare_api_token', 'Cloudflare API Token 格式无效。');
  }

  const workerName = typeof request.workerName === 'string'
    ? request.workerName.trim().toLowerCase()
    : '';
  if (!WORKER_NAME.test(workerName)) {
    throw new ApplicationError(
      400,
      'invalid_worker_name',
      '服务名称必须为 1–63 位小写字母、数字或连字符，且首尾不能是连字符。'
    );
  }
  return { accountId, apiToken, workerName };
}

export async function connectCloudflare(
  request: CloudflareConnectionRequest,
  provider: CloudflareConnectionProvider
) {
  const normalized = normalizeConnectionRequest(request);
  const connection = await provider.connect(normalized.accountId, normalized.apiToken);
  const target = {
    accountId: connection.account.id,
    accountName: connection.account.name,
    workerName: normalized.workerName
  };
  const deployedConfiguration = await provider.loadDeployedConfiguration(
    target.accountId,
    normalized.apiToken,
    target.workerName
  );
  return { connection, target, deployedConfiguration };
}
