import assert from 'node:assert/strict';
import test from 'node:test';
import { connectRuntimeTailSocket, createRuntimeLogStream, type TailSocket } from '../../src/infrastructure/cloudflare/runtime-log-stream';

class Socket extends EventTarget implements TailSocket {
  sent: string[] = [];
  closed = 0;
  send(value: string) { this.sent.push(value); }
  close() { this.closed++; }
  message(value: unknown) { this.dispatchEvent(new MessageEvent('message', { data: typeof value === 'string' ? value : JSON.stringify(value) })); }
}
function setup(overrides: { expiresAt?: number; response?: Response; socket?: Socket } = {}) {
  const socket = overrides.socket ?? new Socket();
  const calls: { url: string; init: RequestInit | undefined }[] = [];
  const fetcher = async (input: RequestInfo | URL, init?: RequestInit) => {
    calls.push({ url: String(input), init });
    if (init?.method === 'DELETE') return Response.json({ success: true });
    return overrides.response ?? Response.json({ success: true, result: {
      id: 'tail-id', expires_at: new Date(overrides.expiresAt ?? Date.now() + 60_000).toISOString(),
      url: 'wss://tail.example.test/capability-url?token=tail-secret'
    } });
  };
  const signal = new AbortController();
  const options = {
    apiToken: 'api-session-secret', target: { accountId: 'account-id', workerName: 'worker-name' },
    signal: signal.signal, fetcher, connectSocket: async () => socket, heartbeatMs: 60_000
  };
  return { socket, calls, signal, options };
}
async function frame(reader: ReadableStreamDefaultReader<Uint8Array>) {
  const { value, done } = await reader.read();
  assert.equal(done, false);
  const valueString = new TextDecoder().decode(value);
  const [event, data] = valueString.trim().split('\n');
  return { event: event?.replace('event: ', ''), data: data?.startsWith('data: ') ? JSON.parse(data.slice(6)) as Record<string, unknown> : undefined, raw: valueString };
}
const tick = () => new Promise<void>((resolve) => setTimeout(resolve, 0));

test('live tail relays native console levels, exceptions and safe event context as SSE and deletes the tail on cancel', async () => {
  const { socket, calls, options } = setup();
  const response = createRuntimeLogStream(options);
  assert.match(response.headers.get('content-type') ?? '', /text\/event-stream/u);
  assert.equal(response.headers.get('cache-control'), 'no-store');
  const reader = response.body!.getReader();
  assert.equal((await frame(reader)).data?.state, 'connected');
  assert.deepEqual(socket.sent, ['{"debug":false}']);
  assert.match(calls[0]!.url, /accounts\/account-id\/workers\/scripts\/worker-name\/tails$/u);
  assert.equal(new Headers(calls[0]!.init?.headers).get('authorization'), 'Bearer api-session-secret');
  socket.message({ outcome: 'exception', eventTimestamp: 1000,
    event: { request: { url: 'https://api.example.com/path?private=x#secret', method: 'GET', body: 'request-body-secret', headers: { cookie: 'private-cookie', 'cf-connecting-ip': '192.0.2.11' } } },
    logs: [{ level: 'warn', message: ['native warning', { password: 'hidden-password', durationMs: 8 }], timestamp: 1001 }],
    exceptions: [{ name: 'TypeError', message: 'native failure api-session-secret', stack: 'native stack', timestamp: 1002 }]
  });
  const summary = await frame(reader);
  const log = await frame(reader);
  const exception = await frame(reader);
  assert.equal(summary.event, 'log');
  assert.equal(log.data?.level, 'warning');
  assert.equal(log.data?.source, 'worker');
  assert.equal(log.data?.hostname, 'api.example.com');
  assert.match(String(log.data?.message), /native warning/u);
  assert.equal(exception.data?.level, 'error');
  assert.match(String(exception.data?.message), /TypeError.*native failure/u);
  assert.match(JSON.stringify(exception.data?.data), /native stack/u);
  const all = summary.raw + log.raw + exception.raw;
  for (const secret of ['request-body-secret', 'private-cookie', '192.0.2.11', 'hidden-password', 'api-session-secret', 'tail-secret', 'capability-url', '?private=x', '#secret']) assert.equal(all.includes(secret), false, secret);
  await reader.cancel();
  assert.equal(socket.closed, 1);
  assert.equal(calls.filter((call) => call.init?.method === 'DELETE').length, 1);
});

test('tail permission errors stay local to the SSE stream and include sanitized provider details', async () => {
  const { options, calls } = setup({ response: Response.json({ success: false, errors: [{ code: 10000, message: 'missing Workers Tail Read api-session-secret' }] }, { status: 403 }) });
  const response = createRuntimeLogStream(options);
  const reader = response.body!.getReader();
  const status = await frame(reader);
  assert.equal(response.status, 200);
  assert.equal(status.data?.state, 'error');
  assert.match(String(status.data?.message), /403.*Workers Tail Read/u);
  assert.equal(status.raw.includes('api-session-secret'), false);
  assert.equal((await reader.read()).done, true);
  assert.equal(calls.length, 1);
});

test('client abort, malformed provider data and provider close release the socket and delete tail exactly once', async () => {
  for (const mode of ['abort', 'malformed', 'close'] as const) {
    const { options, signal, calls, socket } = setup();
    const reader = createRuntimeLogStream(options).body!.getReader();
    await frame(reader);
    if (mode === 'abort') signal.abort();
    else if (mode === 'malformed') socket.message('{bad JSON');
    else socket.dispatchEvent(new Event('close'));
    const status = await frame(reader);
    assert.equal(status.data?.state, mode === 'malformed' ? 'error' : 'closed');
    assert.equal((await reader.read()).done, true);
    await tick();
    assert.equal(socket.closed, 1, mode);
    assert.equal(calls.filter((call) => call.init?.method === 'DELETE').length, 1, mode);
  }
});

test('tail expiration is explicit and heartbeats do not retain an expired tail', async () => {
  const { options, socket, calls } = setup({ expiresAt: Date.now() + 60 });
  const reader = createRuntimeLogStream({ ...options, heartbeatMs: 10 }).body!.getReader();
  await frame(reader);
  let heartbeat = false;
  for (;;) {
    const next = await frame(reader);
    if (next.raw.startsWith(': heartbeat')) heartbeat = true;
    if (next.data?.state === 'closed') { assert.match(String(next.data?.message), /过期/u); break; }
  }
  assert.equal(heartbeat, true);
  assert.equal((await reader.read()).done, true);
  await tick();
  assert.equal(socket.closed, 1);
  assert.equal(calls.filter((call) => call.init?.method === 'DELETE').length, 1);
});

test('bounded stream rejects oversized messages and disconnects a slow consumer', async () => {
  for (const mode of ['message', 'backpressure'] as const) {
    const { options, socket, calls } = setup();
    const reader = createRuntimeLogStream({ ...options, maxMessageBytes: 1024 }).body!.getReader();
    await frame(reader);
    if (mode === 'message') socket.message('x'.repeat(1025));
    else for (let i = 0; i < 200; i++) socket.message({ outcome: 'ok', eventTimestamp: 1000, event: { message: 'x'.repeat(900) }, logs: [], exceptions: [] });
    let final: Record<string, unknown> | undefined;
    for (;;) { const next = await reader.read(); if (next.done) break; const line = new TextDecoder().decode(next.value); if (line.startsWith('event: status')) final = JSON.parse(line.split('\n')[1]!.slice(6)) as Record<string, unknown>; }
    assert.equal(final?.state, 'error');
    await tick();
    assert.equal(socket.closed, 1);
    assert.equal(calls.filter((call) => call.init?.method === 'DELETE').length, 1);
  }
});

test('cancel during socket establishment deletes tail and closes a connection that arrives late', async () => {
  const { options, socket, calls, signal } = setup();
  let resolveSocket: ((socket: TailSocket) => void) | undefined;
  const pending = new Promise<TailSocket>((resolve) => { resolveSocket = resolve; });
  const reader = createRuntimeLogStream({ ...options, connectSocket: () => pending }).body!.getReader();
  await tick();
  signal.abort();
  assert.equal((await frame(reader)).data?.state, 'closed');
  resolveSocket!(socket);
  await tick();
  assert.equal(socket.closed, 1);
  assert.equal(calls.filter((call) => call.init?.method === 'DELETE').length, 1);
});

test('an active reader receives every console line from one invocation with large native request context', async () => {
  const { options, socket } = setup();
  const reader = createRuntimeLogStream(options).body!.getReader();
  await frame(reader);
  const received = (async () => {
    const rows: Record<string, unknown>[] = [];
    for (let index = 0; index < 21; index++) rows.push((await frame(reader)).data!);
    return rows;
  })();
  socket.message({ outcome: 'ok', eventTimestamp: 1000,
    event: { request: { method: 'GET', url: 'https://api.example.com/', headers: { 'user-agent': 'a'.repeat(7000) } } },
    logs: Array.from({ length: 20 }, (_, index) => ({ level: 'log', message: [`native line ${index}`], timestamp: 1001 + index })), exceptions: []
  });
  const rows = await received;
  assert.equal(rows.length, 21);
  assert.deepEqual(rows.slice(1).map((row) => row.message), Array.from({ length: 20 }, (_, index) => `native line ${index}`));
  await reader.cancel();
});

test('an accepted native invocation can fan out long console lines without a false slow-consumer disconnect', async () => {
  const { options, socket } = setup();
  const reader = createRuntimeLogStream(options).body!.getReader();
  await frame(reader);
  const received = (async () => {
    const rows: Record<string, unknown>[] = [];
    for (let index = 0; index < 21; index++) rows.push((await frame(reader)).data!);
    return rows;
  })();
  const messages = Array.from({ length: 20 }, (_, index) => `native line ${index} ${'x'.repeat(4000)}`);
  socket.message({ outcome: 'ok', eventTimestamp: 1000, event: null,
    logs: messages.map((message) => ({ level: 'log', message: [message], timestamp: 1001 })), exceptions: [] });
  const rows = await received;
  assert.deepEqual(rows.slice(1).map((row) => row.message), messages);
  await reader.cancel();
});

test('runtime socket adapter negotiates trace-v1 in Node and validates the workerd WebSocket upgrade', async () => {
  const globals = globalThis as unknown as { WebSocket: typeof WebSocket; WebSocketPair?: unknown };
  const originalSocket = globals.WebSocket;
  const originalPair = globals.WebSocketPair;
  const calls: { url: string; protocol: string }[] = [];
  class NativeSocket extends Socket {
    binaryType = '';
    constructor(url: string, protocol: string) {
      super(); calls.push({ url, protocol }); queueMicrotask(() => this.dispatchEvent(new Event('open')));
    }
  }
  try {
    globals.WebSocket = NativeSocket as unknown as typeof WebSocket;
    delete globals.WebSocketPair;
    const socket = await connectRuntimeTailSocket('wss://tail.example.test/private', new AbortController().signal);
    assert.deepEqual(calls, [{ url: 'wss://tail.example.test/private', protocol: 'trace-v1' }]);
    socket.close();
    globals.WebSocketPair = function() {};
    const upgraded = Object.assign(new Socket(), { accepted: 0, accept() { this.accepted++; } });
    const requestCalls: { url: string; protocol: string | null }[] = [];
    const fetcher = async (input: RequestInfo | URL, init?: RequestInit) => {
      requestCalls.push({ url: String(input), protocol: new Headers(init?.headers).get('sec-websocket-protocol') });
      return { status: 101, webSocket: upgraded, headers: new Headers({ 'sec-websocket-protocol': 'trace-v1' }) } as unknown as Response;
    };
    assert.equal(await connectRuntimeTailSocket('wss://tail.example.test/private', new AbortController().signal, fetcher), upgraded);
    assert.deepEqual(requestCalls, [{ url: 'https://tail.example.test/private', protocol: 'trace-v1' }]);
    assert.equal(upgraded.accepted, 1);
    const invalid = Object.assign(new Socket(), { accept() {} });
    await assert.rejects(connectRuntimeTailSocket('wss://tail.example.test/private', new AbortController().signal,
      async () => ({ status: 101, webSocket: invalid, headers: new Headers({ 'sec-websocket-protocol': 'wrong-protocol' }) }) as unknown as Response), /协议/u);
    assert.equal(invalid.closed, 1);
  } finally {
    globals.WebSocket = originalSocket;
    if (originalPair === undefined) delete globals.WebSocketPair;
    else globals.WebSocketPair = originalPair;
  }
});

test('native socket errors remain visible in status with credentials and Tail capabilities removed', async () => {
  const { options, socket } = setup();
  const reader = createRuntimeLogStream(options).body!.getReader();
  await frame(reader);
  const error = Object.assign(new Error('native ECONNRESET api-session-secret password=hidden'), { code: 'ECONNRESET',
    cause: 'wss://tail.example.test/capability-url?token=tail-secret' });
  socket.dispatchEvent(Object.assign(new Event('error'), { error }));
  const status = await frame(reader);
  assert.equal(status.data?.state, 'error');
  assert.match(String(status.data?.message), /ECONNRESET/u);
  for (const secret of ['api-session-secret', 'hidden', 'capability-url', 'tail-secret']) assert.equal(status.raw.includes(secret), false, secret);
  assert.equal((await reader.read()).done, true);
});
