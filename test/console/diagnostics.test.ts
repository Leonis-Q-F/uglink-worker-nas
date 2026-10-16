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
  it('keeps repeated failures as separate events and isolates records by Worker target', async () => {
    const namespace = fakeKv();
    const sessionId = 'test-session-id-that-is-long-enough-for-storage';
    const repository = createKvDiagnosticLogRepository(namespace, sessionId, target('worker-a'));
    const firstObservedAt = '2026-08-04T00:00:00.000Z';
    const lastObservedAt = '2026-08-04T00:05:00.000Z';

    await repository.append([entry('first-id', firstObservedAt)]);
    await repository.append([entry('latest-id', lastObservedAt)]);

    expect(await repository.list()).toEqual([expect.objectContaining({
      id: 'latest-id',
      firstObservedAt: lastObservedAt,
      lastObservedAt,
      occurrences: 1,
      code: 'service_entry_timeout'
    }), expect.objectContaining({ id: 'first-id', firstObservedAt, occurrences: 1 })]);

    const otherWorker = createKvDiagnosticLogRepository(namespace, sessionId, target('worker-b'));
    expect(await otherWorker.list()).toEqual([]);
  });

  it('ignores a retry of the same event id without changing historical aggregation counts', async () => {
    const repository = createKvDiagnosticLogRepository(fakeKv(), 'session', target('worker-a'));
    const historical = { ...entry('historical', '2026-08-04T00:00:00.000Z'), occurrences: 7 };
    await repository.replace([historical]);
    const fresh = entry('fresh', '2026-08-04T00:05:00.000Z');
    await repository.append([fresh]);
    await repository.append([fresh]);
    expect(await repository.list()).toEqual([fresh, historical]);
  });

  it('retains the newest 100 events in a batch in time order', async () => {
    const repository = createKvDiagnosticLogRepository(fakeKv(), 'session', target('worker-a'));
    await repository.append(Array.from({ length: 105 }, (_, index) => entry(
      `event-${index}`, new Date(Date.UTC(2026, 7, 4, 0, index)).toISOString()
    )));
    const entries = await repository.list(100);
    expect(entries).toHaveLength(100);
    expect(entries[0]?.id).toBe('event-104');
    expect(entries.at(-1)?.id).toBe('event-5');
  });

  it('preserves concurrent appends within the console process', async () => {
    const namespace = fakeKv();
    const first = createKvDiagnosticLogRepository(namespace, 'session', target('worker-a'));
    const second = createKvDiagnosticLogRepository(namespace, 'session', target('worker-a'));
    await Promise.all([
      first.append([entry('first', '2026-08-04T00:00:00.000Z')]),
      second.append([entry('second', '2026-08-04T00:05:00.000Z')])
    ]);
    expect((await first.list()).map((item) => item.id)).toEqual(['second', 'first']);
  });
});
