import { describe, expect, it } from 'vitest';
import { createConfigurationService } from '../../src/application/console/configuration-service';
import { defaultConfig } from '../../src/domain/configuration/defaults';
import type { WorkerTarget } from '../../src/domain/deployment/model';
import { createKvConfigurationRepository } from '../../src/infrastructure/persistence/kv-configuration-repository';

function fakeKv(): KVNamespace {
  const values = new Map<string, string>();
  return {
    async get(key: string, type?: string) {
      const value = values.get(key) ?? null;
      return type === 'json' && value ? JSON.parse(value) : value;
    },
    async put(key: string, value: string | ArrayBuffer | ArrayBufferView | ReadableStream) {
      values.set(key, String(value));
    },
    async delete(key: string) {
      values.delete(key);
    }
  } as KVNamespace;
}

function target(workerName = 'uglink-test'): WorkerTarget {
  return {
    accountId: '0123456789abcdef0123456789abcdef',
    accountName: 'Test Account',
    workerName
  };
}

describe('server-side configuration persistence', () => {
  it('persists incomplete drafts independently from the browser and scopes them by Worker', async () => {
    const namespace = fakeKv();
    const service = createConfigurationService(createKvConfigurationRepository(namespace, target()));
    const initial = await service.read();
    expect(initial.deployed).toEqual(defaultConfig());
    expect(initial.draft).toBeUndefined();

    const draft = defaultConfig();
    draft.services = [{ name: '', hostname: '', port: 8080, enabled: true }];
    await service.saveDraft(draft);

    const reloaded = await createConfigurationService(
      createKvConfigurationRepository(namespace, target())
    ).read();
    expect(reloaded.draft).toEqual(draft);

    const otherWorker = await createConfigurationService(
      createKvConfigurationRepository(namespace, target('another-worker'))
    ).read();
    expect(otherWorker.deployed).toEqual(defaultConfig());
    expect(otherWorker.draft).toBeUndefined();
  });

});
