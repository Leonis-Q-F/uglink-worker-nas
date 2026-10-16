import type { DeploymentJob, DiagnosticEntry } from '../../../domain/deployment/model';
import type { RuntimeLogEntry } from '../../../domain/logging/model';

export const LOG_BUFFER_LIMIT = 1_000;

export interface ViewerLogEntry extends RuntimeLogEntry {
  occurrences?: number;
}

export interface LogFilters {
  search?: string;
  level?: RuntimeLogEntry['level'] | '';
  source?: RuntimeLogEntry['source'] | '';
  hostname?: string;
}

function object(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === 'object' ? value as Record<string, unknown> : undefined;
}

function nativeError(value: unknown): string | undefined {
  const error = object(value);
  if (!error || typeof error.message !== 'string') return;
  const name = typeof error.name === 'string' ? `${error.name}: ` : '';
  const code = typeof error.code === 'string' ? ` (${error.code})` : '';
  return `${name}${error.message}${code}`;
}

function diagnosticMessage(entry: DiagnosticEntry): string {
  const data = object(entry.data);
  const error = nativeError(data?.error);
  if (error) {
    const cause = nativeError(object(data?.error)?.cause);
    return cause ? `${error} · ${cause}` : error;
  }
  const request = object(data?.request);
  const response = object(data?.response);
  if (typeof request?.url === 'string') {
    const method = typeof request.method === 'string' ? request.method : 'GET';
    const status = typeof response?.status === 'number'
      ? ` → HTTP ${response.status}${typeof response.statusText === 'string' && response.statusText ? ` ${response.statusText}` : ''}` : '';
    const duration = typeof data?.durationMs === 'number' ? ` (${data.durationMs} ms)` : '';
    return `${method} ${request.url}${status}${duration}`;
  }
  return entry.detail ? `${entry.summary} — ${entry.detail}` : entry.summary;
}

export function consoleLogEntries(entries: DiagnosticEntry[], job?: DeploymentJob): ViewerLogEntry[] {
  const result: ViewerLogEntry[] = entries.map((entry) => ({
    id: `console:${entry.id}`,
    timestamp: Date.parse(entry.lastObservedAt) || 0,
    level: entry.severity,
    source: 'console',
    message: diagnosticMessage(entry),
    ...(entry.service?.hostname ? { hostname: entry.service.hostname } : {}),
    ...(entry.occurrences > 1 ? { occurrences: entry.occurrences } : {}),
    data: entry
  }));
  job?.timeline.forEach((event, index) => {
    const id = `${job.id}:timeline:${index}`;
    const persisted = entries.some((entry) => entry.id === id || (
      entry.deployment?.jobId === job.id && entry.deployment.phase === event.phase
      && (entry.firstObservedAt === event.at || entry.detail === event.detail || entry.summary === event.detail)
    ));
    if (persisted) return;
    result.push({
      id: `console:${id}`,
      timestamp: Date.parse(event.at) || 0,
      level: event.phase === 'failed' ? 'error' : 'info',
      source: 'console',
      message: event.detail || event.label,
      data: { jobId: job.id, workerName: job.workerName, mode: job.mode, ...event }
    });
  });
  return mergeLogEntries(result);
}

export function mergeLogEntries(entries: ViewerLogEntry[], limit = LOG_BUFFER_LIMIT): ViewerLogEntry[] {
  if (limit <= 0) return [];
  const unique = new Map<string, ViewerLogEntry>();
  for (const entry of entries) unique.set(`${entry.source}:${entry.id}`, entry);
  return [...unique.values()].sort((left, right) => left.timestamp - right.timestamp).slice(-Math.max(0, limit));
}

export function filterLogEntries(entries: ViewerLogEntry[], filters: LogFilters): ViewerLogEntry[] {
  const query = filters.search?.trim().toLowerCase();
  const hostname = filters.hostname?.toLowerCase();
  return entries.filter((entry) => {
    if (filters.level && entry.level !== filters.level) return false;
    if (filters.source && entry.source !== filters.source) return false;
    if (hostname && entry.hostname?.toLowerCase() !== hostname) return false;
    if (!query) return true;
    return `${entry.message}\n${entry.hostname || ''}\n${entry.source}\n${JSON.stringify(entry.data) || ''}`
      .toLowerCase().includes(query);
  });
}

export function formatLogExport(entries: ViewerLogEntry[]): string {
  return entries.length ? `${entries.map((entry) => JSON.stringify(entry)).join('\n')}\n` : '';
}

export function formatLogTextExport(entries: ViewerLogEntry[]): string {
  if (!entries.length) return '';
  return `${entries.map((entry) => {
    const date = new Date(entry.timestamp);
    const timestamp = Number.isFinite(date.getTime()) ? `${date.toISOString()} ` : '';
    return `${timestamp}[${entry.stream || entry.source}] ${entry.message}`;
  }).join('\n')}\n`;
}
