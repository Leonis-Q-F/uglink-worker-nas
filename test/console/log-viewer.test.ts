import { describe, expect, it } from 'vitest';
import type { DeploymentJob, DiagnosticEntry } from '../../src/domain/deployment/model';
import type { RuntimeLogEntry } from '../../src/domain/logging/model';
import {
  consoleLogEntries,
  filterLogEntries,
  formatLogExport,
  formatLogTextExport,
  mergeLogEntries
} from '../../src/interfaces/web/lib/log-viewer';

const first = '2026-10-16T06:25:30.000Z';
const last = '2026-10-16T06:25:35.000Z';
const diagnostic: DiagnosticEntry = {
  id: 'check-1', source: 'health_check', severity: 'error', stage: 'service_entry',
  code: 'entry_timeout', summary: '服务检查失败', detail: 'upstream timeout',
  firstObservedAt: first, lastObservedAt: last, occurrences: 7,
  service: { hostname: 'app.example.com', port: 8317 }
};

function runtime(id: string, timestamp: number): RuntimeLogEntry {
  return { id, timestamp, level: 'info', source: 'worker', message: 'GET /api/files', hostname: 'app.example.com' };
}

describe('log viewer records', () => {
  it('keeps repeated messages as individual events while replacing only matching event IDs', () => {
    const logs = mergeLogEntries([
      runtime('first', 10), runtime('second', 20), { ...runtime('first', 10), message: 'updated' }
    ]);
    expect(logs.map((entry) => [entry.id, entry.message])).toEqual([
      ['first', 'updated'], ['second', 'GET /api/files']
    ]);
  });

  it('retains the newest records in chronological order within the buffer bound', () => {
    expect(mergeLogEntries([runtime('late', 30), runtime('early', 10), runtime('middle', 20)], 2)
      .map((entry) => entry.id)).toEqual(['middle', 'late']);
  });

  it('preserves historical occurrence metadata and original diagnostic fields in expandable data', () => {
    const [entry] = consoleLogEntries([diagnostic]);
    expect(entry).toMatchObject({
      id: 'console:check-1', timestamp: Date.parse(last), source: 'console', level: 'error',
      hostname: 'app.example.com', message: '服务检查失败 — upstream timeout', occurrences: 7,
      data: { code: 'entry_timeout', firstObservedAt: first, lastObservedAt: last, occurrences: 7 }
    });
  });

  it('uses the native error and cause as the primary message ahead of classified summaries', () => {
    const entry = { ...diagnostic, data: { error: { name: 'TypeError', message: 'fetch failed',
      cause: { name: 'ConnectTimeoutError', message: 'Connect Timeout Error', code: 'UND_ERR_CONNECT_TIMEOUT' } } } } as DiagnosticEntry;
    expect(consoleLogEntries([entry])[0]?.message).toBe('TypeError: fetch failed · ConnectTimeoutError: Connect Timeout Error (UND_ERR_CONNECT_TIMEOUT)');
  });

  it('uses actual request and response output when no native error exists', () => {
    const entry = { ...diagnostic, data: { request: { method: 'GET', url: 'https://app.example.com/' },
      response: { status: 502, statusText: 'Bad Gateway', body: 'upstream unavailable' }, durationMs: 1003 } } as DiagnosticEntry;
    expect(consoleLogEntries([entry])[0]?.message).toBe('GET https://app.example.com/ → HTTP 502 Bad Gateway (1003 ms)');
  });

  it('does not repeat a deployment timeline event already persisted in the console log', () => {
    const job = { id: 'job-1', timeline: [
      { at: first, phase: 'uploading', label: '上传', detail: 'Uploading Worker' },
      { at: last, phase: 'routing', label: '路由', detail: 'Binding route' }
    ] } as DeploymentJob;
    const persisted = { ...diagnostic, source: 'deployment', firstObservedAt: first, lastObservedAt: first,
      summary: 'Uploading Worker', detail: undefined, deployment: { jobId: 'job-1', phase: 'uploading', mode: 'overwrite' }
    } as DiagnosticEntry;
    const logs = consoleLogEntries([persisted], job);
    expect(logs.map((entry) => entry.message)).toEqual(['Uploading Worker', 'Binding route']);
  });

  it('combines case-insensitive search, exact hostname, severity and source filters', () => {
    const logs = [
      { ...runtime('match', 10), level: 'error', data: { trace: 'Timeout' } },
      { ...runtime('other-host', 20), level: 'error', hostname: 'other.example.com', data: { trace: 'Timeout' } },
      { ...runtime('other-level', 30), data: { trace: 'Timeout' } }
    ] as RuntimeLogEntry[];
    expect(filterLogEntries(logs, { search: 'TIMEOUT', level: 'error', source: 'worker', hostname: 'APP.EXAMPLE.COM' })
      .map((entry) => entry.id)).toEqual(['match']);
  });

  it('exports full records as JSON lines with raw text and structured data intact', () => {
    const logs = [{ ...runtime('raw', 10), message: '<script>\nline 2', data: { status: 502 } }];
    const output = formatLogExport(logs);
    expect(output.split('\n')).toHaveLength(2);
    expect(JSON.parse(output.trim())).toEqual(logs[0]);
  });

  it('deduplicates replayed container records by ID while retaining repeated text from different events', () => {
    const stdout = { id: 'run-1', timestamp: 20, source: 'container', stream: 'stdout', level: 'info', message: 'Server listening' } as RuntimeLogEntry;
    const replay = mergeLogEntries([stdout, { ...stdout, id: 'run-2', timestamp: 30 }, stdout]);
    expect(replay.map((entry) => entry.id)).toEqual(['run-1', 'run-2']);
  });

  it('copies visible container output as plain text without hiding multiline messages in JSON', () => {
    const logs = [{ id: 'run-1', timestamp: 0, source: 'container', stream: 'stderr', level: 'info',
      message: 'ExperimentalWarning: SQLite is an experimental feature\n    at openDatabase (store.ts:12:3)' }] as RuntimeLogEntry[];
    expect(formatLogTextExport(logs)).toBe('1970-01-01T00:00:00.000Z [stderr] ExperimentalWarning: SQLite is an experimental feature\n    at openDatabase (store.ts:12:3)\n');
    expect(formatLogTextExport([])).toBe('');
  });

  it('keeps text exports usable if a malformed historical timestamp is encountered', () => {
    expect(formatLogTextExport([{ ...runtime('invalid-time', Number.NaN), message: 'raw line' }]))
      .toBe('[worker] raw line\n');
  });
});
