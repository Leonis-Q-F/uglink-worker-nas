import { defaultConfig } from '../../domain/configuration/defaults';
import type { UglinkConfig } from '../../domain/configuration/model';
import { validateUglinkConfig } from '../../domain/configuration/validation';
import type { WorkerTarget } from '../../domain/deployment/model';

const STORAGE_PREFIX = 'uglink-control:v1';

function key(target: WorkerTarget, kind: 'deployed' | 'draft'): string {
  return `${STORAGE_PREFIX}:${target.accountId}:${target.workerName}:${kind}`;
}

function readConfig(storageKey: string): UglinkConfig | undefined {
  try {
    const raw = window.localStorage.getItem(storageKey);
    if (!raw) return undefined;
    const value = JSON.parse(raw) as UglinkConfig;
    if (!validateUglinkConfig(value).valid) throw new Error('invalid stored configuration');
    return value;
  } catch {
    window.localStorage.removeItem(storageKey);
    return undefined;
  }
}

export function loadLocalConfig(target: WorkerTarget): {
  config: UglinkConfig;
  deployed: UglinkConfig;
} {
  const deployed = readConfig(key(target, 'deployed')) || defaultConfig();
  return {
    deployed,
    config: readConfig(key(target, 'draft')) || deployed
  };
}

export function saveDraftConfig(target: WorkerTarget, config: UglinkConfig): void {
  window.localStorage.setItem(key(target, 'draft'), JSON.stringify(config));
}

export function saveDeployedConfig(target: WorkerTarget, config: UglinkConfig): void {
  window.localStorage.setItem(key(target, 'deployed'), JSON.stringify(config));
  window.localStorage.removeItem(key(target, 'draft'));
}

export function clearDraftConfig(target: WorkerTarget): void {
  window.localStorage.removeItem(key(target, 'draft'));
}
