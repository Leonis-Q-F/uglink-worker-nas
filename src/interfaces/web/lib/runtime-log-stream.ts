import type { RuntimeLogEntry } from '../../../domain/logging/model';

export interface ServerSentEvent {
  event: string;
  data: string;
}

export type RuntimeStreamEvent =
  | { type: 'log'; entry: RuntimeLogEntry }
  | { type: 'status'; state: 'connected' | 'closed' | 'error' | 'unavailable'; message: string };

export type RuntimeStreamSource = 'container' | 'worker';

export function createEventStreamParser(onEvent: (event: ServerSentEvent) => void) {
  let pending = '';
  let event = '';
  let data: string[] = [];
  function line(value: string) {
    if (!value) {
      if (data.length) onEvent({ event: event || 'message', data: data.join('\n') });
      event = '';
      data = [];
      return;
    }
    if (value.startsWith(':')) return;
    const separator = value.indexOf(':');
    const field = separator === -1 ? value : value.slice(0, separator);
    let content = separator === -1 ? '' : value.slice(separator + 1);
    if (content.startsWith(' ')) content = content.slice(1);
    if (field === 'event') event = content;
    if (field === 'data') data.push(content);
  }
  return {
    push(chunk: string) {
      pending += chunk;
      if (pending.length + data.reduce((size, part) => size + part.length, 0) > 1_048_576) {
        throw new Error('实时日志事件超过大小限制。');
      }
      let start = 0;
      for (let index = 0; index < pending.length; index++) {
        const character = pending[index];
        if (character !== '\r' && character !== '\n') continue;
        if (character === '\r' && index === pending.length - 1) break;
        line(pending.slice(start, index));
        if (character === '\r' && pending[index + 1] === '\n') index++;
        start = index + 1;
      }
      pending = pending.slice(start);
    },
    finish() {
      // An SSE event is complete only after its empty separator line.
      if (pending === '\r') line('');
      pending = '';
      data = [];
      event = '';
    }
  };
}

export function decodeRuntimeStreamEvent(event: ServerSentEvent): RuntimeStreamEvent | undefined {
  let body: unknown;
  try { body = JSON.parse(event.data); } catch { return; }
  if (!body || typeof body !== 'object') return;
  const value = body as Record<string, unknown>;
  if (event.event === 'log') {
    if (typeof value.id !== 'string' || typeof value.timestamp !== 'number' || !Number.isFinite(value.timestamp)
      || !Number.isFinite(new Date(value.timestamp).getTime())
      || !['debug', 'info', 'warning', 'error'].includes(String(value.level))
      || !['container', 'worker', 'console'].includes(String(value.source)) || typeof value.message !== 'string'
      || (value.stream !== undefined && value.stream !== 'stdout' && value.stream !== 'stderr')
      || (value.hostname !== undefined && typeof value.hostname !== 'string')) return;
    return { type: 'log', entry: value as unknown as RuntimeLogEntry };
  }
  if (event.event === 'status' && ['connected', 'closed', 'error', 'unavailable'].includes(String(value.state))) {
    return { type: 'status', state: value.state as 'connected' | 'closed' | 'error' | 'unavailable',
      message: typeof value.message === 'string' ? value.message : '' };
  }
}

interface RuntimeStreamOptions {
  source?: RuntimeStreamSource;
  csrfToken: string;
  origin: string;
  signal: AbortSignal;
  onEvent: (event: RuntimeStreamEvent) => void;
  fetcher?: typeof fetch;
}

export async function streamRuntimeLogs({ source = 'container', csrfToken, origin, signal, onEvent, fetcher = fetch }: RuntimeStreamOptions): Promise<void> {
  const endpoint = source === 'container' ? '/api/diagnostics/container-stream' : '/api/diagnostics/stream';
  const response = await fetcher(endpoint, {
    method: 'POST', credentials: 'same-origin', mode: 'same-origin', signal,
    headers: {
      Accept: 'text/event-stream', 'Content-Type': 'application/json',
      'X-CSRF-Token': csrfToken, 'X-Uglink-Console-Origin': origin
    },
    body: '{}'
  });
  if (!response.ok) {
    let message = `实时日志连接失败（HTTP ${response.status}）。`;
    try {
      const body = await response.json() as { error?: { message?: string } };
      if (body.error?.message) message = body.error.message;
    } catch { /* HTTP status remains useful when a proxy returns a non-JSON error. */ }
    throw new Error(message);
  }
  if (!response.body || !response.headers.get('Content-Type')?.includes('text/event-stream')) {
    throw new Error('服务器未返回有效的实时日志流。');
  }
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  const parser = createEventStreamParser((event) => {
    const decoded = decodeRuntimeStreamEvent(event);
    if (decoded) onEvent(decoded);
  });
  const cancel = () => { void reader.cancel().catch(() => undefined); };
  signal.addEventListener('abort', cancel, { once: true });
  try {
    while (!signal.aborted) {
      const { value, done } = await reader.read();
      if (done) break;
      parser.push(decoder.decode(value, { stream: true }));
    }
    parser.push(decoder.decode());
    parser.finish();
  } finally {
    signal.removeEventListener('abort', cancel);
    await reader.cancel().catch(() => undefined);
    reader.releaseLock();
  }
}
