import { describe, expect, it } from 'vitest';
import type { DiagnosticEntry, WorkerTarget } from '../../src/domain/deployment/model';
import { createKvDiagnosticLogRepository } from '../../src/infrastructure/persistence/kv-diagnostic-log-repository';

function fakeKv(): KVNamespace {
  const values = new Map<string, string>();
  return {
    async get(key: string, type?: string) {
      const value = values.get(key) ?? null;
      if (type === 'json' && value) return JSON.parse(value) as unknown;
      return value;
    },
    async put(key: string, value: string | ArrayBuffer | ArrayBufferView | ReadableStream) {
      values.set(key, String(value));
    },
    async delete(key: string) {
      values.delete(key);
    }
  } as KVNamespace;
}

function target(workerName: string): WorkerTarget {
  return {
    accountId: 'account-id',
    accountName: 'Test Account',
    workerName
  };
}

function entry(id: string, observedAt: string): DiagnosticEntry {
  return {
    id,
    source: 'health_check',
    severity: 'error',
    stage: 'service_entry',
    code: 'service_entry_timeout',
    summary: '无法连接 Worker 服务入口',
    firstObservedAt: observedAt,
    lastObservedAt: observedAt,
    occurrences: 1,
    service: {
      name: 'app',
      hostname: 'app.example.com',
      port: 8317
    }
  };
}

describe('diagnostic log repository', () => {
  it('deduplicates repeated failures and isolates records by Worker target', async () => {
    const namespace = fakeKv();
    const sessionId = 'test-session-id-that-is-long-enough-for-storage';
    const repository = createKvDiagnosticLogRepository(namespace, sessionId, target('worker-a'));
    const firstObservedAt = '2026-08-04T00:00:00.000Z';
    const lastObservedAt = '2026-08-04T00:05:00.000Z';

    await repository.append([entry('first-id', firstObservedAt)]);
    await repository.append([entry('latest-id', lastObservedAt)]);

    expect(await repository.list()).toEqual([expect.objectContaining({
      id: 'latest-id',
      firstObservedAt,
      lastObservedAt,
      occurrences: 2,
      code: 'service_entry_timeout'
    })]);

    const otherWorker = createKvDiagnosticLogRepository(namespace, sessionId, target('worker-b'));
    expect(await otherWorker.list()).toEqual([]);
  });
});
