import { describe, expect, it } from 'vitest';
import {
  createEventStreamParser,
  decodeRuntimeStreamEvent,
  streamRuntimeLogs
} from '../../src/interfaces/web/lib/runtime-log-stream';

describe('runtime log SSE reader', () => {
  it('handles split CRLF frames, comments and multiline data without dropping or duplicating events', () => {
    const events: unknown[] = [];
    const parser = createEventStreamParser((event) => events.push(event));
    parser.push(': heartbeat\r');
    parser.push('\nevent: log\r\ndata: {"id":"1",\r\ndata: "message":"first"}\r');
    parser.push('\n\r\nevent: status\ndata: {"state":"connected"}\n\n');
    parser.finish();
    expect(events).toEqual([
      { event: 'log', data: '{"id":"1",\n"message":"first"}' },
      { event: 'status', data: '{"state":"connected"}' }
    ]);
  });

  it('ignores malformed payloads and unknown events while retaining valid raw output', () => {
    expect(decodeRuntimeStreamEvent({ event: 'log', data: '{oops' })).toBeUndefined();
    expect(decodeRuntimeStreamEvent({ event: 'log', data: JSON.stringify({ id: '1', timestamp: 1, level: 'bogus', source: 'worker', message: 'raw' }) })).toBeUndefined();
    expect(decodeRuntimeStreamEvent({ event: 'heartbeat', data: '{}' })).toBeUndefined();
    expect(decodeRuntimeStreamEvent({ event: 'log', data: JSON.stringify({ id: '1', timestamp: 1e30, level: 'info', source: 'worker', message: 'raw' }) })).toBeUndefined();
    expect(decodeRuntimeStreamEvent({ event: 'log', data: JSON.stringify({ id: '1', timestamp: 1, level: 'error', source: 'worker', message: '<script>raw</script>' }) }))
      .toMatchObject({ type: 'log', entry: { message: '<script>raw</script>', level: 'error' } });
  });

  it('does not publish an incomplete event when the transport closes mid-frame', () => {
    const received: unknown[] = [];
    const parser = createEventStreamParser((event) => received.push(event));
    parser.push('event: log\ndata: {"id":"cut-off"}\n');
    parser.finish();
    expect(received).toEqual([]);
  });

  it('cancels a pending stream read when the view aborts the connection', async () => {
    const controller = new AbortController();
    let streamWasCancelled = false;
    const reading = streamRuntimeLogs({ csrfToken: 'test', origin: 'https://console.example.com', signal: controller.signal,
      onEvent: () => undefined, fetcher: async () => new Response(new ReadableStream({
        start() { queueMicrotask(() => controller.abort()); },
        cancel() { streamWasCancelled = true; }
      }), { headers: { 'Content-Type': 'text/event-stream' } })
    });
    await reading;
    expect(streamWasCancelled).toBe(true);
  });

  it('opens the authenticated POST stream and reads UTF-8 messages across binary chunk boundaries', async () => {
    const bytes = new TextEncoder().encode('event: log\ndata: {"id":"1","timestamp":1,"level":"info","source":"worker","message":"日志"}\n\n');
    const received: unknown[] = [];
    const fetcher: typeof fetch = async (url, init) => {
      expect(url).toBe('/api/diagnostics/stream');
      expect(init).toMatchObject({ method: 'POST', credentials: 'same-origin', mode: 'same-origin',
        headers: { 'X-CSRF-Token': 'test-csrf', 'X-Uglink-Console-Origin': 'https://console.example.com' } });
      return new Response(new ReadableStream({ start(controller) {
        controller.enqueue(bytes.subarray(0, bytes.length - 5));
        controller.enqueue(bytes.subarray(bytes.length - 5));
        controller.close();
      } }), { headers: { 'Content-Type': 'text/event-stream' } });
    };
    await streamRuntimeLogs({ source: 'worker', csrfToken: 'test-csrf', origin: 'https://console.example.com', signal: new AbortController().signal,
      onEvent: (event) => received.push(event), fetcher });
    expect(received).toEqual([{ type: 'log', entry: { id: '1', timestamp: 1, level: 'info', source: 'worker', message: '日志' } }]);
  });

  it('opens the container stream by default and preserves stdout and multiline stderr output', async () => {
    const received: unknown[] = [];
    const payload = { id: 'boot-1', timestamp: 1, level: 'info', source: 'container', stream: 'stderr',
      message: 'ExperimentalWarning: SQLite is an experimental feature\n    at openDatabase (store.ts:12:3)' };
    await streamRuntimeLogs({ csrfToken: 'test', origin: 'https://console.example.com', signal: new AbortController().signal,
      onEvent: (event) => received.push(event), fetcher: async (url) => {
        expect(url).toBe('/api/diagnostics/container-stream');
        return new Response(`event: log\ndata: ${JSON.stringify(payload)}\n\n`, {
          headers: { 'Content-Type': 'text/event-stream' }
        });
      } });
    expect(received).toEqual([{ type: 'log', entry: payload }]);
    expect(decodeRuntimeStreamEvent({ event: 'log', data: JSON.stringify({ ...payload, stream: 'unknown' }) })).toBeUndefined();
  });

  it('retains an explicit unavailable status instead of silently ignoring a missing container source', () => {
    expect(decodeRuntimeStreamEvent({ event: 'status', data: '{"state":"unavailable","message":"Node runtime required"}' }))
      .toEqual({ type: 'status', state: 'unavailable', message: 'Node runtime required' });
  });

  it('reports stream authorization errors locally with the backend message', async () => {
    await expect(streamRuntimeLogs({ csrfToken: 'expired', origin: 'https://console.example.com', signal: new AbortController().signal,
      onEvent: () => undefined, fetcher: async () => new Response(JSON.stringify({ error: { message: 'Session expired' } }), { status: 401 })
    })).rejects.toThrow('Session expired');
  });
});
