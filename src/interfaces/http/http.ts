import { ApplicationError } from '../../application/common/application-error';
import type { ApiErrorPayload } from './contracts';

const JSON_HEADERS = {
  'Cache-Control': 'no-store',
  'Content-Type': 'application/json; charset=utf-8',
  'X-Content-Type-Options': 'nosniff'
};

export function json(value: unknown, init: ResponseInit = {}): Response {
  const headers = new Headers(init.headers);
  for (const [name, headerValue] of Object.entries(JSON_HEADERS)) {
    if (!headers.has(name)) headers.set(name, headerValue);
  }
  return new Response(JSON.stringify(value), { ...init, headers });
}

export function apiError(error: unknown): Response {
  if (error instanceof ApplicationError) {
    const body: ApiErrorPayload = {
      error: {
        code: error.code,
        message: error.message,
        ...(error.detail ? { detail: error.detail } : {})
      }
    };
    return json(body, { status: error.status });
  }

  console.error(JSON.stringify({
    event: 'console_api_error',
    error: error instanceof Error ? error.message : String(error)
  }));

  return json({
    error: {
      code: 'internal_error',
      message: '控制台暂时无法完成该请求。'
    }
  } satisfies ApiErrorPayload, { status: 500 });
}

export async function readJson<T>(request: Request, maxBytes = 65_536): Promise<T> {
  const contentType = request.headers.get('content-type') || '';
  if (!contentType.toLowerCase().includes('application/json')) {
    throw new ApplicationError(415, 'unsupported_media_type', '请求必须使用 application/json。');
  }

  const contentLength = Number(request.headers.get('content-length') || 0);
  if (contentLength > maxBytes) {
    throw new ApplicationError(413, 'payload_too_large', '请求内容过大。');
  }

  const text = await request.text();
  if (new TextEncoder().encode(text).byteLength > maxBytes) {
    throw new ApplicationError(413, 'payload_too_large', '请求内容过大。');
  }

  try {
    return JSON.parse(text) as T;
  } catch {
    throw new ApplicationError(400, 'invalid_json', '请求内容不是有效的 JSON。');
  }
}

export function assertSameOrigin(request: Request): void {
  const origin = request.headers.get('origin');
  if (!origin) return;
  if (origin !== new URL(request.url).origin) {
    throw new ApplicationError(403, 'invalid_origin', '请求来源无效。');
  }
}
