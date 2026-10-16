import type { RuntimeLogEntry, RuntimeLogLevel } from '../../domain/logging/model';
import { sanitizeLogValue } from '../security/log-redaction';

const API_ROOT = 'https://api.cloudflare.com/client/v4';
const TRACE_PROTOCOL = 'trace-v1';
const MAX_FRAME_BYTES = 32_768;
const encoder = new TextEncoder();

export interface TailSocket {
  addEventListener(type: string, listener: EventListener): void;
  removeEventListener(type: string, listener: EventListener): void;
  send(value: string): void;
  close(code?: number, reason?: string): void;
}

export interface RuntimeLogStreamOptions {
  apiToken: string;
  target: { accountId: string; workerName: string };
  signal: AbortSignal;
  fetcher?: typeof fetch;
  connectSocket?: (url: string, signal: AbortSignal) => Promise<TailSocket>;
  connectTimeoutMs?: number;
  maxDurationMs?: number;
  heartbeatMs?: number;
  maxMessageBytes?: number;
}

async function boundedText(response: Response, limit: number): Promise<string> {
  if (!response.body) return '';
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    for (;;) {
      const { value, done } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > limit) { await reader.cancel(); throw new Error('Cloudflare Tail 响应超过大小限制。'); }
      chunks.push(value);
    }
  } finally { reader.releaseLock(); }
  const bytes = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.byteLength; }
  return new TextDecoder().decode(bytes);
}

/** workerd uses fetch upgrades; Node 22 uses its standard global WebSocket client. */
export async function connectRuntimeTailSocket(url: string, signal: AbortSignal, fetcher: typeof fetch = fetch): Promise<TailSocket> {
  if (signal.aborted) throw new Error('实时日志连接已取消。');
  if (typeof WebSocketPair !== 'undefined') {
    const response = await fetcher(url.replace(/^wss:/u, 'https:'), {
      headers: { Upgrade: 'websocket', 'Sec-WebSocket-Protocol': TRACE_PROTOCOL },
      signal, redirect: 'error'
    });
    const socket = (response as Response & { webSocket?: WebSocket }).webSocket;
    if (response.status !== 101 || !socket) {
      await response.body?.cancel();
      throw new Error(`Cloudflare Tail WebSocket 升级失败 (HTTP ${response.status})。`);
    }
    if (response.headers.get('Sec-WebSocket-Protocol') !== TRACE_PROTOCOL) {
      socket.accept();
      socket.close(1002, 'Invalid tail protocol');
      throw new Error('Cloudflare Tail WebSocket 协议无效。');
    }
    if (signal.aborted) { socket.close(1000, 'Client disconnected'); throw new Error('实时日志连接已取消。'); }
    socket.accept();
    return socket;
  }
  return new Promise<TailSocket>((resolve, reject) => {
    const socket = new WebSocket(url, TRACE_PROTOCOL);
    socket.binaryType = 'arraybuffer';
    function clean() {
      socket.removeEventListener('open', opened);
      socket.removeEventListener('error', failed);
      socket.removeEventListener('close', failed);
      signal.removeEventListener('abort', aborted);
    }
    function opened() { clean(); resolve(socket); }
    function failed(event?: Event) { clean(); try { socket.close(); } catch { /* Already closed. */ } reject(new Error(`Cloudflare Tail WebSocket 连接失败。${socketEventDetail(event)}`)); }
    function aborted() { failed(); }
    socket.addEventListener('open', opened);
    socket.addEventListener('error', failed);
    socket.addEventListener('close', failed);
    signal.addEventListener('abort', aborted, { once: true });
    if (signal.aborted) aborted();
  });
}

function record(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function timestamp(value: unknown, fallback: number): number {
  return typeof value === 'number' && Number.isFinite(value) && Math.abs(value) <= 8.64e15 ? value : fallback;
}

function stringify(value: unknown): string {
  return typeof value === 'string' ? value : JSON.stringify(value) ?? '';
}

function socketEventDetail(event?: Event): string {
  const detail = event as (Event & { error?: unknown; message?: string; reason?: string; code?: number }) | undefined;
  const value = detail?.error ?? detail?.message ?? detail?.reason;
  return value ? ` ${stringify(sanitizeLogValue(value))}` : '';
}

function nativeLevel(level: unknown): RuntimeLogLevel {
  return level === 'warn' ? 'warning' : level === 'error' ? 'error' : level === 'debug' ? 'debug' : 'info';
}

function safePayload(payload: Record<string, unknown>, secrets: readonly string[]): Record<string, unknown> {
  let native = payload;
  if (record(payload.event) && record(payload.event.request)) {
    const { body: omittedBody, ...request } = payload.event.request;
    native = { ...payload, event: { ...payload.event, request: { ...request, ...(omittedBody === undefined ? {} : { body: '[REDACTED]' }) } } };
  }
  return sanitizeLogValue(native, secrets) as Record<string, unknown>;
}

/** Never sends the API token or the Tail's bearer-capability WebSocket URL to the browser. */
export function createRuntimeLogStream(options: RuntimeLogStreamOptions): Response {
  const fetcher = options.fetcher ?? fetch;
  const connect = options.connectSocket ?? ((url, signal) => connectRuntimeTailSocket(url, signal, fetcher));
  const maxMessageBytes = Math.min(options.maxMessageBytes ?? 262_144, 262_144);
  // One accepted invocation synchronously emits a summary and console rows.
  // Account for duplicated message/data text and metadata before judging the reader.
  const bufferBytes = Math.max(65_536, maxMessageBytes * 4 + 65_536);
  const path = `/accounts/${encodeURIComponent(options.target.accountId)}/workers/scripts/${encodeURIComponent(options.target.workerName)}/tails`;
  const connectionAbort = new AbortController();
  const secrets = [options.apiToken];
  let controller: ReadableStreamDefaultController<Uint8Array>;
  let socket: TailSocket | undefined;
  let tailId: string | undefined;
  let finished = false;
  let sequence = 0;
  let pendingBinary = 0;
  const deleted = new Set<string>();
  const timers: ReturnType<typeof setTimeout>[] = [];
  let heartbeat: ReturnType<typeof setInterval> | undefined;
  const cleanups: (() => void)[] = [];

  async function deleteTail(): Promise<void> {
    if (!tailId || deleted.has(tailId)) return;
    deleted.add(tailId);
    const abort = new AbortController();
    const timeout = setTimeout(() => abort.abort(), 5_000);
    try {
      const response = await fetcher(`${API_ROOT}${path}/${encodeURIComponent(tailId)}`, {
        method: 'DELETE', headers: { Authorization: `Bearer ${options.apiToken}` }, signal: abort.signal, redirect: 'error'
      });
      await response.body?.cancel();
    } catch { /* A disconnected Tail also expires server-side; cleanup cannot keep the SSE open. */ }
    finally { clearTimeout(timeout); }
  }
  async function cleanup(): Promise<void> {
    for (const timer of timers) clearTimeout(timer);
    if (heartbeat) clearInterval(heartbeat);
    for (const remove of cleanups) remove();
    options.signal.removeEventListener('abort', aborted);
    connectionAbort.abort();
    if (socket) { try { socket.close(1000, 'Log viewer disconnected'); } catch { /* Already closed. */ } socket = undefined; }
    await deleteTail();
  }
  function status(state: 'connected' | 'closed' | 'error', message: string): void {
    controller.enqueue(encoder.encode(`event: status\ndata: ${JSON.stringify({ state, message: sanitizeLogValue(message, secrets) })}\n\n`));
  }
  async function finish(state: 'closed' | 'error', message: string, canceled = false): Promise<void> {
    if (finished) return;
    finished = true;
    if (!canceled) {
      try { status(state, message); controller.close(); } catch { /* Reader already canceled. */ }
    }
    await cleanup();
  }
  function aborted() { void finish('closed', '实时日志连接已关闭。'); }
  function emit(entry: RuntimeLogEntry): void {
    if (finished) return;
    if ((controller.desiredSize ?? 0) <= 0) { void finish('error', '日志接收速度不足，实时连接已关闭；请重新连接。'); return; }
    let bytes = encoder.encode(`event: log\ndata: ${JSON.stringify(entry)}\n\n`);
    if (bytes.byteLength > MAX_FRAME_BYTES) {
      const bounded: RuntimeLogEntry = { ...entry, message: entry.message.slice(0, 2_048), data: { truncated: true, preview: stringify(entry.data).slice(0, 4_096) } };
      bytes = encoder.encode(`event: log\ndata: ${JSON.stringify(bounded)}\n\n`);
    }
    controller.enqueue(bytes);
  }
  function receiveText(text: string): void {
    if (finished) return;
    if (text.length > maxMessageBytes || encoder.encode(text).byteLength > maxMessageBytes) { void finish('error', 'Cloudflare Tail 日志消息超过大小限制。'); return; }
    let payload: unknown;
    try { payload = JSON.parse(text) as unknown; } catch { void finish('error', 'Cloudflare Tail 返回了无效的日志 JSON。'); return; }
    if (!record(payload) || (payload.logs !== undefined && !Array.isArray(payload.logs)) || (payload.exceptions !== undefined && !Array.isArray(payload.exceptions))) {
      void finish('error', 'Cloudflare Tail 返回了无效的日志结构。'); return;
    }
    const data = safePayload(payload, secrets);
    const event = record(data.event) ? data.event : {};
    const request = record(event.request) ? event.request : undefined;
    const now = Date.now();
    const observed = timestamp(data.eventTimestamp, now);
    let hostname: string | undefined;
    if (typeof request?.url === 'string') {
      try { const candidate = new URL(request.url).hostname; if (!candidate.includes(':') && !/^\d+(?:\.\d+){3}$/u.test(candidate)) hostname = candidate; } catch { /* The safe payload still contains the supplied URL. */ }
    }
    const context = { source: 'worker' as const, ...(hostname ? { hostname } : {}) };
    const add = (message: string, level: RuntimeLogLevel, time: unknown, details: unknown) => {
      const id = `worker-${now}-${++sequence}`;
      emit({ ...context, id, timestamp: timestamp(time, observed), level, message: message.slice(0, 8_192), data: details });
      return id;
    };
    const outcome = typeof data.outcome === 'string' ? data.outcome : '';
    const summary = request
      ? `${typeof request.method === 'string' ? request.method : 'HTTP'} ${typeof request.url === 'string' ? request.url : ''}${outcome ? ` — ${outcome}` : ''}`
      : typeof event.message === 'string' ? event.message : `Worker event${outcome ? ` — ${outcome}` : ''}`;
    const invocationId = add(summary, 'info', observed, data);
    for (const log of Array.isArray(data.logs) ? data.logs.slice(0, 100) : []) {
      if (finished) break;
      if (record(log)) add((Array.isArray(log.message) ? log.message : [log.message]).map(stringify).join(' '), nativeLevel(log.level), log.timestamp, { invocationId, log });
    }
    for (const exception of Array.isArray(data.exceptions) ? data.exceptions.slice(0, 100) : []) {
      if (finished) break;
      if (record(exception)) add(`${typeof exception.name === 'string' ? exception.name : 'Error'}: ${stringify(exception.message)}`, 'error', exception.timestamp, { invocationId, exception });
    }
  }
  function received(event: Event): void {
    if (finished) return;
    const data: unknown = (event as MessageEvent<unknown>).data;
    try {
      if (typeof data === 'string') receiveText(data);
      else if (data instanceof ArrayBuffer || ArrayBuffer.isView(data)) {
        const bytes = data instanceof ArrayBuffer ? new Uint8Array(data) : new Uint8Array(data.buffer, data.byteOffset, data.byteLength);
        if (bytes.byteLength > maxMessageBytes) { void finish('error', 'Cloudflare Tail 日志消息超过大小限制。'); return; }
        receiveText(new TextDecoder('utf-8', { fatal: true }).decode(bytes));
      } else if (data instanceof Blob && data.size <= maxMessageBytes && pendingBinary < 4) {
        pendingBinary++;
        void data.text().then(receiveText, () => finish('error', 'Cloudflare Tail 日志消息无法读取。')).finally(() => { pendingBinary--; });
      } else void finish('error', 'Cloudflare Tail 日志消息无效或超过大小限制。');
    } catch { void finish('error', 'Cloudflare Tail 日志消息无法读取。'); }
  }

  async function start(): Promise<void> {
    options.signal.addEventListener('abort', aborted, { once: true });
    if (options.signal.aborted) { await finish('closed', '实时日志连接已关闭。'); return; }
    const timeout = setTimeout(() => { void finish('error', '连接 Cloudflare Tail 超时。'); }, options.connectTimeoutMs ?? 10_000);
    timers.push(timeout);
    try {
      const response = await fetcher(`${API_ROOT}${path}`, {
        method: 'POST', headers: { Authorization: `Bearer ${options.apiToken}`, Accept: 'application/json', 'Content-Type': 'application/json' },
        body: '{}', signal: connectionAbort.signal, redirect: 'error'
      });
      const text = await boundedText(response, 65_536);
      let envelope: unknown;
      try { envelope = JSON.parse(text) as unknown; } catch { throw new Error(`Cloudflare Tail 返回了无效的 JSON (HTTP ${response.status})。`); }
      if (!response.ok || !record(envelope) || envelope.success !== true) {
        throw new Error(`Cloudflare Tail HTTP ${response.status}: ${stringify(sanitizeLogValue(envelope, secrets))}`);
      }
      const result = envelope.result;
      if (!record(result) || typeof result.id !== 'string' || !result.id || result.id.length > 128) throw new Error('Cloudflare Tail 返回了无效的会话。');
      tailId = result.id;
      if (finished) { await deleteTail(); return; }
      if (typeof result.url !== 'string' || typeof result.expires_at !== 'string') throw new Error('Cloudflare Tail 返回了无效的连接信息。');
      const url = new URL(result.url);
      if (url.protocol !== 'wss:' || url.username || url.password) throw new Error('Cloudflare Tail 返回了无效的 WebSocket 地址。');
      secrets.push(result.url, `${url.origin}${url.pathname}`);
      const expiresAt = Date.parse(result.expires_at);
      if (!Number.isFinite(expiresAt) || expiresAt <= Date.now()) throw new Error('Cloudflare Tail 会话已过期。');
      const connected = await connect(result.url, connectionAbort.signal);
      if (finished) { connected.close(1000, 'Log viewer disconnected'); await deleteTail(); return; }
      socket = connected;
      clearTimeout(timeout);
      const closed: EventListener = (event) => { void finish('closed', `Cloudflare Tail 连接已关闭。${socketEventDetail(event)}`); };
      const failed: EventListener = (event) => { void finish('error', `Cloudflare Tail WebSocket 连接中断。${socketEventDetail(event)}`); };
      for (const [type, listener] of [['message', received], ['close', closed], ['error', failed]] as const) {
        socket.addEventListener(type, listener);
        cleanups.push(() => connected.removeEventListener(type, listener));
      }
      // Wrangler's trace-v1 protocol sends this control message after opening.
      socket.send(JSON.stringify({ debug: false }));
      status('connected', `已连接 ${options.target.workerName} 的实时日志。`);
      const maxDuration = options.maxDurationMs ?? 15 * 60_000;
      const remaining = expiresAt - Date.now();
      timers.push(setTimeout(() => { void finish('closed', remaining <= maxDuration ? 'Cloudflare Tail 会话已过期，请重新连接。' : '实时日志连接已达到时长限制，请重新连接。'); }, Math.max(1, Math.min(remaining, maxDuration))));
      heartbeat = setInterval(() => {
        if (finished) return;
        if ((controller.desiredSize ?? 0) <= 0) { void finish('error', '日志接收速度不足，实时连接已关闭；请重新连接。'); return; }
        controller.enqueue(encoder.encode(': heartbeat\n\n'));
      }, options.heartbeatMs ?? 15_000);
    } catch (error) {
      if (!finished) await finish('error', error instanceof Error ? error.message : stringify(error));
    }
  }
  const stream = new ReadableStream<Uint8Array>({
    start(streamController) { controller = streamController; void start(); },
    cancel() { return finish('closed', '实时日志连接已关闭。', true); }
  }, { highWaterMark: bufferBytes, size: (bytes) => bytes.byteLength });
  return new Response(stream, { headers: {
    'Content-Type': 'text/event-stream; charset=utf-8', 'Cache-Control': 'no-store',
    'X-Content-Type-Options': 'nosniff', 'X-Accel-Buffering': 'no'
  } });
}
