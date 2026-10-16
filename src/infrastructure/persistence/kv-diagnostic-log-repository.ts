import type { ConsoleStore } from '../../application/console/ports';
import type { DiagnosticLogRepository } from '../../application/console/ports';
import type { DiagnosticEntry } from '../../domain/deployment/model';
import type { WorkerTarget } from '../../domain/deployment/model';
import { redactDiagnostic } from '../../domain/logging/redact-records';

const DIAGNOSTIC_TTL_SECONDS = 60 * 60 * 24 * 30;
const MAX_DIAGNOSTICS = 100;

interface DiagnosticStore {
  version: 1;
  entries: DiagnosticEntry[];
}

// Keep read/modify/write operations from overlapping within one console process.
// Remote Workers KV still cannot provide cross-isolate transactional appends.
const writes = new WeakMap<ConsoleStore, Map<string, Promise<void>>>();

function isDiagnosticEntry(value: unknown): value is DiagnosticEntry {
  if (!value || typeof value !== 'object') return false;
  const entry = value as Partial<DiagnosticEntry>;
  return typeof entry.id === 'string'
    && typeof entry.code === 'string'
    && typeof entry.summary === 'string'
    && typeof entry.firstObservedAt === 'string'
    && typeof entry.lastObservedAt === 'string'
    && typeof entry.occurrences === 'number';
}

export function createKvDiagnosticLogRepository(
  namespace: ConsoleStore,
  sessionId: string,
  target: Pick<WorkerTarget, 'accountId' | 'workerName'>,
  secrets: readonly string[] = []
): DiagnosticLogRepository {
  const key = `diagnostics:${sessionId}:${target.accountId}:${target.workerName}`;

  async function write(operation: () => Promise<void>): Promise<void> {
    let pending = writes.get(namespace);
    if (!pending) {
      pending = new Map();
      writes.set(namespace, pending);
    }
    const next = (pending.get(key) || Promise.resolve()).catch(() => undefined).then(operation);
    pending.set(key, next);
    try {
      await next;
    } finally {
      if (pending.get(key) === next) pending.delete(key);
    }
  }

  async function readEntries(): Promise<DiagnosticEntry[]> {
    const stored = await namespace.get<DiagnosticStore>(key, 'json');
    if (!stored || stored.version !== 1 || !Array.isArray(stored.entries)) return [];
    return stored.entries.filter(isDiagnosticEntry).slice(0, MAX_DIAGNOSTICS);
  }

  return {
    async append(entries: DiagnosticEntry[]): Promise<void> {
      if (entries.length === 0) return;
      await write(async () => {
        const combined = await readEntries();
        const ids = new Set(combined.map((entry) => entry.id));
        for (const entry of entries) {
          if (ids.has(entry.id)) continue;
          ids.add(entry.id);
          combined.unshift(entry);
        }
        combined.sort((left, right) => Date.parse(right.lastObservedAt) - Date.parse(left.lastObservedAt));
        await namespace.put(key, JSON.stringify({
          version: 1,
          entries: combined.slice(0, MAX_DIAGNOSTICS).map((entry) => redactDiagnostic(entry, secrets))
        } satisfies DiagnosticStore), {
          expirationTtl: DIAGNOSTIC_TTL_SECONDS
        });
      });
    },
    async list(limit = 50): Promise<DiagnosticEntry[]> {
      const safeLimit = Math.max(1, Math.min(limit, MAX_DIAGNOSTICS));
      return (await readEntries()).slice(0, safeLimit);
    },
    async replace(entries: DiagnosticEntry[]): Promise<void> {
      const normalized = entries
        .filter(isDiagnosticEntry)
        .slice(0, MAX_DIAGNOSTICS)
        .map((entry) => redactDiagnostic(entry, secrets));
      await write(async () => {
        await namespace.put(key, JSON.stringify({
          version: 1,
          entries: normalized
        } satisfies DiagnosticStore), {
          expirationTtl: DIAGNOSTIC_TTL_SECONDS
        });
      });
    }
  };
}
