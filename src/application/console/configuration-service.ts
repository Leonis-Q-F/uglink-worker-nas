import { ApplicationError } from '../common/application-error';
import { defaultConfig } from '../../domain/configuration/defaults';
import type { UglinkConfig, UglinkService } from '../../domain/configuration/model';
import {
  configsEqual,
  resolveUglinkConfig,
  validateUglinkConfig
} from '../../domain/configuration/validation';
import type { PersistedConfigurationState } from './contracts';
import type { ConfigurationRepository } from './ports';

const MAX_UGLINK_ID_LENGTH = 63;
const MAX_USERNAME_LENGTH = 128;
const MAX_SERVICE_NAME_LENGTH = 64;
const MAX_HOSTNAME_LENGTH = 253;
const MAX_SERVICES = 64;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function optionalBoolean(value: unknown, field: string): boolean | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== 'boolean') {
    throw new ApplicationError(400, 'invalid_config', `${field} 必须是布尔值。`);
  }
  return value;
}

function boundedString(value: unknown, field: string, maximum: number): string {
  if (typeof value !== 'string' || value.length > maximum) {
    throw new ApplicationError(400, 'invalid_config', `${field} 格式无效。`);
  }
  return value;
}

function draftService(value: unknown, index: number): UglinkService {
  if (!isRecord(value)) {
    throw new ApplicationError(400, 'invalid_config', `services[${index}] 必须是对象。`);
  }
  const port = Number(value.port);
  if (!Number.isInteger(port) || port < 1 || port > 65_535) {
    throw new ApplicationError(400, 'invalid_config', `services[${index}].port 必须是有效端口。`);
  }
  const enabled = optionalBoolean(value.enabled, `services[${index}].enabled`);
  return {
    name: boundedString(value.name, `services[${index}].name`, MAX_SERVICE_NAME_LENGTH),
    hostname: boundedString(value.hostname, `services[${index}].hostname`, MAX_HOSTNAME_LENGTH),
    port,
    ...(enabled === undefined ? {} : { enabled })
  };
}

export function normalizeDraftConfiguration(value: unknown): UglinkConfig {
  if (!isRecord(value) || value.version !== 2 || !isRecord(value.uglink)) {
    throw new ApplicationError(400, 'invalid_config', '配置结构无效。');
  }
  if (!Array.isArray(value.services) || value.services.length > MAX_SERVICES) {
    throw new ApplicationError(400, 'invalid_config', `services 最多允许 ${MAX_SERVICES} 项。`);
  }
  if (value.deployment !== undefined && !isRecord(value.deployment)) {
    throw new ApplicationError(400, 'invalid_config', 'deployment 必须是对象。');
  }
  const deployment = value.deployment as Record<string, unknown> | undefined;
  optionalBoolean(deployment?.workersDev, 'deployment.workersDev');
  optionalBoolean(deployment?.previewUrls, 'deployment.previewUrls');
  return {
    ...(typeof value.$schema === 'string' && value.$schema.length <= 256
      ? { $schema: value.$schema }
      : {}),
    version: 2,
    uglink: {
      id: boundedString(value.uglink.id, 'uglink.id', MAX_UGLINK_ID_LENGTH),
      username: boundedString(value.uglink.username, 'uglink.username', MAX_USERNAME_LENGTH)
    },
    services: value.services.map(draftService)
  };
}

function importConfiguration(value: unknown): UglinkConfig {
  const validation = validateUglinkConfig(value);
  if (!validation.valid) {
    throw new ApplicationError(
      400,
      'invalid_config_import',
      '导入的配置没有通过检查。',
      validation.checks.filter((check) => check.level === 'error').map((check) => check.detail).join('；')
    );
  }
  return resolveUglinkConfig(value);
}

function state(deployed: UglinkConfig, draft?: UglinkConfig): PersistedConfigurationState {
  return {
    version: 1,
    deployed,
    ...(draft ? { draft } : {}),
    updatedAt: new Date().toISOString()
  };
}

export function createConfigurationService(repository: ConfigurationRepository) {
  async function read(): Promise<PersistedConfigurationState> {
    return (await repository.read()) || state(defaultConfig());
  }

  async function saveDraft(value: unknown): Promise<PersistedConfigurationState> {
    const draft = normalizeDraftConfiguration(value);
    const current = await repository.read();
    const deployed = current?.deployed || defaultConfig();
    const next = state(deployed, configsEqual(deployed, draft) ? undefined : draft);
    await repository.write(next);
    return next;
  }

  async function saveDeployed(value: unknown): Promise<PersistedConfigurationState> {
    const deployed = importConfiguration(value);
    const next = state(deployed);
    await repository.write(next);
    return next;
  }

  async function replace(value: PersistedConfigurationState): Promise<PersistedConfigurationState> {
    const deployed = normalizeDraftConfiguration(value.deployed);
    const draft = value.draft === undefined ? undefined : normalizeDraftConfiguration(value.draft);
    const next = state(deployed, draft);
    await repository.write(next);
    return next;
  }

  return {
    read,
    replace,
    saveDeployed,
    saveDraft
  };
}
