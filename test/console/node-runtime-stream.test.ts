import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { AddressInfo } from 'node:net';
import { afterEach, expect, it, vi } from 'vitest';
import { createConsoleServer } from '../../src/interfaces/http/console/node-server';
import { getOrCreateSession, saveSession } from '../../src/infrastructure/persistence/console-session';
import type { ConsoleWorkerEnv } from '../../src/interfaces/http/console/environment';

afterEach(() => { vi.restoreAllMocks(); vi.unstubAllGlobals(); });

it('aborts pending Tail establishment when an HTTP streaming client disconnects', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'uglink-stream-test-'));
  mkdirSync(join(directory, 'client'));
  writeFileSync(join(directory, 'client', 'index.html'), 'test');
  const values = new Map<string, string>();
  const env: ConsoleWorkerEnv = { SESSION_ENCRYPTION_KEY: 'a'.repeat(43), CONSOLE_SESSIONS: {
    get: async (key: string) => values.get(key) ?? null,
    put: async (key: string, value: string) => { values.set(key, value); },
    delete: async (key: string) => { values.delete(key); }
  } as ConsoleWorkerEnv['CONSOLE_SESSIONS'] };
  const handle = await getOrCreateSession(new Request('http://localhost'), env);
  handle.data.cloudflare = { apiToken: 'secret', account: { id: 'account', name: 'Test' }, connectedAt: Date.now() };
  handle.data.target = { accountId: 'account', accountName: 'Test', workerName: 'worker' };
  await saveSession(env, handle);
  const server = createConsoleServer(env, join(directory, 'client'));
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const originalFetch = fetch;
  const abort = new AbortController();
  let established: (() => void) | undefined;
  let upstreamCanceled: (() => void) | undefined;
  const started = new Promise<void>((resolve) => { established = resolve; });
  const canceled = new Promise<void>((resolve) => { upstreamCanceled = resolve; });
  vi.stubGlobal('fetch', vi.fn((_input: RequestInfo | URL, init?: RequestInit) => new Promise<Response>((_resolve, reject) => {
    established!();
    init?.signal?.addEventListener('abort', () => { upstreamCanceled!(); reject(new Error('upstream aborted')); }, { once: true });
  })));
  try {
    const request = originalFetch(`http://127.0.0.1:${(server.address() as AddressInfo).port}/api/diagnostics/stream`, {
      method: 'POST', signal: abort.signal, headers: { cookie: `uglink_console_session=${handle.id}`, 'x-csrf-token': handle.data.csrfToken }
    }).catch(() => undefined);
    await started;
    abort.abort();
    await expect(Promise.race([canceled.then(() => true), new Promise<boolean>((resolve) => setTimeout(() => resolve(false), 1_000))])).resolves.toBe(true);
    await request;
  } finally {
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
    rmSync(directory, { recursive: true, force: true });
  }
});
