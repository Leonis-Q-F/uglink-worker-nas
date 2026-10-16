import type { ContainerLogSource } from '../../application/console/ports';
import type { RuntimeLogEntry } from '../../domain/logging/model';

const encoder = new TextEncoder();
const HEADERS = { 'Content-Type': 'text/event-stream; charset=utf-8', 'Cache-Control': 'no-store',
  'X-Content-Type-Options': 'nosniff', 'X-Accel-Buffering': 'no' };

/** Portable adapter; only the Node bootstrap supplies the actual process source. */
export function createContainerLogStream(options: { source?: ContainerLogSource; signal: AbortSignal; afterId?: string; heartbeatMs?: number }): Response {
  if (!options.source) return new Response(`event: status\ndata: ${JSON.stringify({ state: 'unavailable', message: '当前运行环境不提供本机容器日志；请在 UGLINK Docker 控制台中查看。' })}\n\n`, { headers: HEADERS });
  const source = options.source;
  let controller: ReadableStreamDefaultController<Uint8Array>;
  let unsubscribe: (() => void) | undefined;
  let heartbeat: ReturnType<typeof setInterval> | undefined;
  let finished = false;
  let history: RuntimeLogEntry[] = [];
  let historyIndex = 0;
  const live: { bytes: Uint8Array }[] = [];
  let liveBytes = 0;
  function status(state: string, message: string) { controller.enqueue(encoder.encode(`event: status\ndata: ${JSON.stringify({ state, message })}\n\n`)); }
  function finish(state = 'closed', message = '容器日志连接已关闭。', canceled = false) {
    if (finished) return;
    finished = true;
    if (heartbeat) clearInterval(heartbeat);
    unsubscribe?.();
    history = [];
    live.length = 0;
    liveBytes = 0;
    options.signal.removeEventListener('abort', aborted);
    if (!canceled) { try { status(state, message); controller.close(); } catch { /* Reader already canceled. */ } }
  }
  function aborted() { finish(); }
  function frame(entry: RuntimeLogEntry) { return encoder.encode(`id: ${entry.id}\nevent: log\ndata: ${JSON.stringify(entry)}\n\n`); }
  function drain() {
    if (finished) return;
    while ((controller.desiredSize ?? 0) > 0) {
      if (historyIndex < history.length) { controller.enqueue(frame(history[historyIndex++]!)); continue; }
      if (history.length) { history = []; historyIndex = 0; }
      const next = live.shift();
      if (!next) break;
      liveBytes -= next.bytes.byteLength;
      controller.enqueue(next.bytes);
    }
  }
  function emit(entry: RuntimeLogEntry) {
    if (finished) return;
    const bytes = frame(entry);
    if (live.length >= 256 || liveBytes + bytes.byteLength > 1_048_576) {
      finish('error', '日志接收速度不足，连接已关闭；请重新连接。'); return;
    }
    live.push({ bytes }); liveBytes += bytes.byteLength;
    drain();
  }
  const stream = new ReadableStream<Uint8Array>({
    start(value) {
      controller = value;
      if (options.signal.aborted) { finish(); return; }
      options.signal.addEventListener('abort', aborted, { once: true });
      try {
        const subscription = source.subscribe(emit, () => finish('closed', '控制台正在关闭，容器日志连接已结束。'), options.afterId);
        unsubscribe = subscription.unsubscribe;
        history = subscription.history;
        status('connected', source.persistent ? '已连接 UGLINK 容器日志，正在显示保留记录和实时输出。' : '已连接 UGLINK 容器日志；日志文件不可写，当前仅保留内存记录。');
        drain();
        if (!finished) heartbeat = setInterval(() => {
          if ((controller.desiredSize ?? 0) <= 0) return;
          controller.enqueue(encoder.encode(': heartbeat\n\n'));
        }, options.heartbeatMs ?? 15_000);
      } catch { finish('error', '暂时无法连接容器日志，请稍后重试。'); }
    },
    pull() { drain(); },
    cancel() { finish('closed', '', true); }
  }, { highWaterMark: 65_536, size: (bytes) => bytes.byteLength });
  return new Response(stream, { headers: HEADERS });
}
