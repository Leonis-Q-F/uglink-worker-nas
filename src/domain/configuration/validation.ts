import type { ResolvedUglinkConfig, UglinkConfig } from './model';

const SERVICE_NAME = /^[a-zA-Z0-9][a-zA-Z0-9_-]*$/u;
const HOSTNAME = /^(?=.{1,253}$)(?!-)(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/iu;
const UGLINK_ID = /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/u;

export type CheckLevel = 'pass' | 'warning' | 'error' | 'pending';

export interface ValidationCheck {
  id: string;
  label: string;
  detail: string;
  level: CheckLevel;
}

export interface ValidationResponse {
  valid: boolean;
  checks: ValidationCheck[];
}

export class ConfigurationError extends Error {
  constructor(readonly issues: string[]) {
    super(issues.join('; '));
    this.name = 'ConfigurationError';
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function unexpectedKeys(value: Record<string, unknown>, allowed: readonly string[]): string[] {
  const allowedSet = new Set(allowed);
  return Object.keys(value).filter((key) => !allowedSet.has(key));
}

export function normalizeHostname(value: string): string {
  const trimmed = value.trim().toLowerCase().replace(/\.$/u, '');
  if (!trimmed || trimmed.includes('*') || trimmed === 'localhost') {
    throw new Error(`无效的服务域名：${value}`);
  }

  let hostname: string;
  try {
    const parsed = new URL(`https://${trimmed}`);
    if (parsed.username || parsed.password || parsed.port || parsed.pathname !== '/' || parsed.search || parsed.hash) {
      throw new Error('hostname contains unsupported URL components');
    }
    hostname = parsed.hostname.toLowerCase().replace(/\.$/u, '');
  } catch {
    throw new Error(`无效的服务域名：${value}`);
  }

  if (!HOSTNAME.test(hostname)) {
    throw new Error(`无效的服务域名：${value}`);
  }
  return hostname;
}

export function normalizeUglinkId(value: string): string {
  const normalized = value.trim().toLowerCase();
  if (!normalized) return '';
  if (!UGLINK_ID.test(normalized)) {
    throw new Error('uglink.id 必须是有效的 UGREENlink ID');
  }
  return normalized;
}

function shapeErrors(value: unknown): string[] {
  if (!isRecord(value)) return ['配置根节点必须是对象'];

  const errors: string[] = [];
  const rootExtra = unexpectedKeys(value, ['$schema', 'version', 'uglink', 'services', 'deployment']);
  if (rootExtra.length) errors.push(`配置根节点包含不支持的字段：${rootExtra.join(', ')}`);
  if (value.$schema !== undefined && typeof value.$schema !== 'string') errors.push('$schema 必须是字符串');
  if (value.version !== 2) errors.push('version 必须为 2');

  if (!isRecord(value.uglink)) {
    errors.push('uglink 必须是对象');
  } else {
    const extra = unexpectedKeys(value.uglink, ['id', 'username']);
    if (extra.length) errors.push(`uglink 包含不支持的字段：${extra.join(', ')}`);
    if (typeof value.uglink.id !== 'string' || value.uglink.id.length > 63) {
      errors.push('uglink.id 必须是不超过 63 个字符的字符串');
    }
    if (typeof value.uglink.username !== 'string' || value.uglink.username.length > 128) {
      errors.push('uglink.username 必须是不超过 128 个字符的字符串');
    }
  }

  if (!Array.isArray(value.services)) {
    errors.push('services 必须是数组');
  } else if (value.services.length > 64) {
    errors.push('services 最多允许 64 项');
  } else {
    value.services.forEach((service, index) => {
      if (!isRecord(service)) {
        errors.push(`services[${index}] 必须是对象`);
        return;
      }
      const extra = unexpectedKeys(service, ['name', 'hostname', 'port', 'enabled']);
      if (extra.length) errors.push(`services[${index}] 包含不支持的字段：${extra.join(', ')}`);
      if (typeof service.name !== 'string' || service.name.length > 64 || !SERVICE_NAME.test(service.name)) {
        errors.push(`services[${index}].name 格式无效`);
      }
      if (typeof service.hostname !== 'string') {
        errors.push(`services[${index}].hostname 必须是字符串`);
      } else {
        try {
          normalizeHostname(service.hostname);
        } catch {
          errors.push(`services[${index}].hostname 不是有效的完整域名`);
        }
      }
      if (!Number.isInteger(service.port) || Number(service.port) < 1 || Number(service.port) > 65535) {
        errors.push(`services[${index}].port 必须是 1–65535 的整数`);
      }
      if (service.enabled !== undefined && typeof service.enabled !== 'boolean') {
        errors.push(`services[${index}].enabled 必须是布尔值`);
      }
    });
  }

  if (value.deployment !== undefined) {
    if (!isRecord(value.deployment)) {
      errors.push('deployment 必须是对象');
    } else {
      const extra = unexpectedKeys(value.deployment, ['workersDev', 'previewUrls']);
      if (extra.length) errors.push(`deployment 包含不支持的字段：${extra.join(', ')}`);
      if (value.deployment.workersDev !== undefined && typeof value.deployment.workersDev !== 'boolean') {
        errors.push('deployment.workersDev 必须是布尔值');
      }
      if (value.deployment.previewUrls !== undefined && typeof value.deployment.previewUrls !== 'boolean') {
        errors.push('deployment.previewUrls 必须是布尔值');
      }
    }
  }
  return errors;
}

function duplicateErrors(config: UglinkConfig): string[] {
  const issues: string[] = [];
  const names = new Set<string>();
  const hostnames = new Set<string>();
  for (const service of config.services) {
    const name = service.name.toLowerCase();
    if (names.has(name)) issues.push(`服务名称重复：${service.name}`);
    names.add(name);

    const hostname = normalizeHostname(service.hostname);
    if (hostnames.has(hostname)) issues.push(`服务域名重复：${hostname}`);
    hostnames.add(hostname);
  }
  return issues;
}

export function resolveUglinkConfig(value: unknown): ResolvedUglinkConfig {
  const issues = shapeErrors(value);
  if (issues.length) throw new ConfigurationError(issues);

  const config = value as UglinkConfig;
  issues.push(...duplicateErrors(config));

  let id = '';
  try {
    id = normalizeUglinkId(config.uglink.id);
  } catch (error) {
    issues.push(error instanceof Error ? error.message : String(error));
  }
  const username = config.uglink.username.trim();
  const services = config.services.map((service) => ({
    name: service.name,
    hostname: normalizeHostname(service.hostname),
    port: service.port,
    enabled: service.enabled !== false
  }));
  const activeServices = services.filter((service) => service.enabled);
  if (activeServices.length > 0 && (!id || !username)) {
    issues.push('启用服务时必须填写 uglink.id 和 uglink.username');
  }
  if (issues.length) throw new ConfigurationError(issues);

  return {
    ...('$schema' in config && config.$schema ? { $schema: config.$schema } : {}),
    version: 2,
    uglink: { id, username },
    services,
    deployment: {
      workersDev: false,
      previewUrls: false
    }
  };
}

export function validateUglinkConfig(value: unknown): ValidationResponse {
  const checks: ValidationCheck[] = [];
  const errors = shapeErrors(value);
  const schemaValid = errors.length === 0;
  checks.push({
    id: 'schema',
    label: '配置结构',
    detail: schemaValid ? '字段、类型和取值范围符合配置规范。' : errors.slice(0, 3).join('；'),
    level: schemaValid ? 'pass' : 'error'
  });
  if (!schemaValid) return { valid: false, checks };

  const config = value as UglinkConfig;
  let uglinkIdValid = config.uglink.id === config.uglink.id.trim();
  try {
    uglinkIdValid = uglinkIdValid && normalizeUglinkId(config.uglink.id).length > 0;
  } catch {
    uglinkIdValid = false;
  }
  checks.push({
    id: 'uglink-id',
    label: 'UGREENlink ID',
    detail: uglinkIdValid
      ? 'ID 格式有效，运行时将自动发现当前中继地址。'
      : '请输入分享地址末尾的 UGREENlink ID，只能包含字母、数字和连字符。',
    level: uglinkIdValid ? 'pass' : 'error'
  });

  const duplicates = duplicateErrors(config);
  checks.push({
    id: 'unique-services',
    label: '服务映射唯一性',
    detail: duplicates.length === 0
      ? `${config.services.length} 个服务的名称和域名没有重复。`
      : duplicates.join('；'),
    level: duplicates.length === 0 ? 'pass' : 'error'
  });

  const usernameValid = config.uglink.username.length > 0
    && config.uglink.username === config.uglink.username.trim();
  checks.push({
    id: 'username',
    label: '登录用户名',
    detail: usernameValid ? '用户名已设置。' : '用户名不能为空，也不能包含首尾空格。',
    level: usernameValid ? 'pass' : 'error'
  });

  const enabledCount = config.services.filter((service) => service.enabled !== false).length;
  checks.push({
    id: 'enabled-services',
    label: '已启用服务',
    detail: enabledCount > 0
      ? `${enabledCount} 个服务会被发布。`
      : '当前没有启用服务；发布后不会创建公开访问入口。',
    level: enabledCount > 0 ? 'pass' : 'warning'
  });

  return { valid: checks.every((check) => check.level !== 'error'), checks };
}

export function configsEqual(left: UglinkConfig, right: UglinkConfig): boolean {
  return JSON.stringify(left) === JSON.stringify(right);
}

export function serializeConfig(config: UglinkConfig): string {
  return `${JSON.stringify(config, null, 2)}\n`;
}

export function prettyConfig(config: UglinkConfig): string {
  return JSON.stringify(config, null, 2);
}
