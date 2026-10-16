import { useEffect, useState } from 'react';
import type { RuntimeLogEntry } from '../../../domain/logging/model';
import { LOG_BUFFER_LIMIT, mergeLogEntries } from '../lib/log-viewer';
import { streamRuntimeLogs } from '../lib/runtime-log-stream';
import type { RuntimeStreamSource } from '../lib/runtime-log-stream';

export type RuntimeConnectionState = 'connecting' | 'connected' | 'paused' | 'error' | 'unavailable';
export type LogSource = RuntimeStreamSource | 'console';

interface RuntimeConnection {
  state: RuntimeConnectionState;
  message: string;
  source: LogSource;
}

const SOURCE_NAMES = { container: '容器运行日志', worker: 'Worker 网络日志', console: '检查与部署记录' };

export function useRuntimeLogs(csrfToken: string | undefined, paused: boolean, source: LogSource = 'container') {
  const [buffers, setBuffers] = useState<Record<RuntimeStreamSource, RuntimeLogEntry[]>>({ container: [], worker: [] });
  const [connection, setConnection] = useState<RuntimeConnection>({ state: 'connecting', source: 'container', message: '正在连接容器运行日志' });

  useEffect(() => {
    if (paused || !csrfToken || source === 'console') return;
    const controller = new AbortController();
    const signal = controller.signal;
    const sourceName = SOURCE_NAMES[source];
    let timer: ReturnType<typeof setTimeout> | undefined;
    let flushTimer: ReturnType<typeof setTimeout> | undefined;
    let pending: RuntimeLogEntry[] = [];
    let attempt = 0;
    const append = (entry: RuntimeLogEntry) => {
      if (entry.source !== source) return;
      pending.push(entry);
      if (pending.length > LOG_BUFFER_LIMIT) pending = pending.slice(-LOG_BUFFER_LIMIT);
      if (flushTimer !== undefined) return;
      flushTimer = setTimeout(() => {
        const batch = pending;
        pending = [];
        flushTimer = undefined;
        if (!signal.aborted) setBuffers((current) => ({
          ...current, [source]: mergeLogEntries([...current[source], ...batch])
        }));
      }, 80);
    };
    const waitForRetry = (delay: number) => new Promise<void>((resolve) => {
      const done = () => { signal.removeEventListener('abort', done); clearTimeout(timer); resolve(); };
      signal.addEventListener('abort', done, { once: true });
      timer = setTimeout(done, delay);
    });
    const connect = async () => {
      while (!signal.aborted) {
        setConnection({ state: 'connecting', source, message: `正在${attempt ? '重新' : ''}连接${sourceName}` });
        let streamStartedAt = 0;
        let unavailable = false;
        try {
          await streamRuntimeLogs({ source, csrfToken, origin: window.location.origin, signal, onEvent(event) {
            if (signal.aborted) return;
            if (event.type === 'log') append(event.entry);
            else if (event.state === 'connected') {
              streamStartedAt = Date.now();
              setConnection({ state: 'connected', source, message: event.message || `${sourceName}已连接` });
            } else if (event.state === 'unavailable') {
              unavailable = true;
              setConnection({ state: 'unavailable', source, message: event.message || `${sourceName}不可用` });
            } else {
              throw new Error(event.message || `${sourceName}连接已关闭`);
            }
          } });
          if (signal.aborted || unavailable) break;
          throw new Error(`${sourceName}连接已关闭`);
        } catch (error) {
          if (signal.aborted || unavailable) break;
          if (streamStartedAt && Date.now() - streamStartedAt > 30_000) attempt = 0;
          const delay = Math.min(30_000, 2_000 * 2 ** Math.min(attempt++, 4));
          const message = error instanceof Error ? error.message : `${sourceName}连接失败`;
          setConnection({ state: 'error', source, message: `${message} · ${delay / 1_000} 秒后重试` });
          await waitForRetry(delay);
        }
      }
    };
    void connect();
    return () => {
      controller.abort();
      clearTimeout(timer);
      clearTimeout(flushTimer);
    };
  }, [csrfToken, paused, source]);

  const currentConnection = connection.source === source ? connection : {
    state: 'connecting' as const, source, message: `正在连接${SOURCE_NAMES[source]}`
  };
  return {
    entries: source === 'console' ? [] : buffers[source],
    connection: paused ? { state: 'paused' as const, source, message: '已暂停接收与刷新' }
      : !csrfToken ? { state: 'unavailable' as const, source, message: '当前会话不可用，请重新连接控制台' }
        : source === 'console' ? { state: 'connected' as const, source, message: '检查与部署记录每 4 秒刷新' }
          : currentConnection
  };
}
