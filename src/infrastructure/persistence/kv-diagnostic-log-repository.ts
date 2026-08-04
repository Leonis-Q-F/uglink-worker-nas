import type { DiagnosticLogRepository } from '../../application/console/ports';
import type { DiagnosticEntry } from '../../domain/deployment/model';
import type { WorkerTarget } from '../../domain/deployment/model';

const DIAGNOSTIC_TTL_SECONDS = 60 * 60 * 24 * 30;
const MAX_DIAGNOSTICS = 100;

interface DiagnosticStore {
  version: 1;
  entries: DiagnosticEntry[];
}

function fingerprint(entry: DiagnosticEntry): string {
  return [
    entry.source,
    entry.stage,
    entry.code,
    entry.service?.hostname || '',
    entry.deployment?.jobId || ''
  ].join(':');
}

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

function isCurrentDiagnostic(entry: DiagnosticEntry): boolean {
  return !(entry.source === 'health_check' && entry.stage === 'nas_backend');
}

export function createKvDiagnosticLogRepository(
  namespace: KVNamespace,
  sessionId: string,
  target: Pick<WorkerTarget, 'accountId' | 'workerName'>
): DiagnosticLogRepository {
  const key = `diagnostics:${sessionId}:${target.accountId}:${target.workerName}`;

  async function readEntries(): Promise<DiagnosticEntry[]> {
    const stored = await namespace.get<DiagnosticStore>(key, 'json');
    if (!stored || stored.version !== 1 || !Array.isArray(stored.entries)) return [];
    return stored.entries.filter(isDiagnosticEntry).filter(isCurrentDiagnostic).slice(0, MAX_DIAGNOSTICS);
  }

  return {
    async append(entries: DiagnosticEntry[]): Promise<void> {
      if (entries.length === 0) return;
      const combined = await readEntries();
      for (const entry of entries) {
        const entryFingerprint = fingerprint(entry);
        const existingIndex = combined.findIndex((candidate) => fingerprint(candidate) === entryFingerprint);
        if (existingIndex >= 0) {
          const previous = combined[existingIndex]!;
          combined.splice(existingIndex, 1);
          combined.unshift({
            ...entry,
            firstObservedAt: previous.firstObservedAt,
            occurrences: previous.occurrences + 1
          });
        } else {
          combined.unshift(entry);
        }
      }
      await namespace.put(key, JSON.stringify({
        version: 1,
        entries: combined.slice(0, MAX_DIAGNOSTICS)
      } satisfies DiagnosticStore), {
        expirationTtl: DIAGNOSTIC_TTL_SECONDS
      });
    },
    async list(limit = 50): Promise<DiagnosticEntry[]> {
      const safeLimit = Math.max(1, Math.min(limit, MAX_DIAGNOSTICS));
      return (await readEntries()).slice(0, safeLimit);
    }
  };
}
