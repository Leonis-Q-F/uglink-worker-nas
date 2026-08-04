import type { ConfigurationRepository } from '../../application/console/ports';
import type { PersistedConfigurationState } from '../../application/console/contracts';
import type { WorkerTarget } from '../../domain/deployment/model';

function storageKey(target: WorkerTarget): string {
  return `configuration:v1:${target.accountId}:${target.workerName}`;
}

export function createKvConfigurationRepository(
  namespace: KVNamespace,
  target: WorkerTarget
): ConfigurationRepository {
  const key = storageKey(target);
  return {
    async read() {
      return (await namespace.get<PersistedConfigurationState>(key, 'json')) || undefined;
    },
    async write(state) {
      await namespace.put(key, JSON.stringify(state));
    }
  };
}
