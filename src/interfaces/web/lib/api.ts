import type { ApiErrorPayload } from '../../http/contracts';

export class ConsoleApiError extends Error {
  readonly status: number;
  readonly code: string;
  readonly detail?: string;

  constructor(status: number, payload: ApiErrorPayload) {
    super(payload.error.message);
    this.name = 'ConsoleApiError';
    this.status = status;
    this.code = payload.error.code;
    this.detail = payload.error.detail;
  }
}

async function request<T>(path: string, init?: RequestInit): Promise<T> {
  const response = await fetch(path, {
    ...init,
    credentials: 'same-origin',
    headers: {
      Accept: 'application/json',
      ...init?.headers
    }
  });
  const body = await response.json() as T | ApiErrorPayload;
  if (!response.ok) {
    throw new ConsoleApiError(response.status, body as ApiErrorPayload);
  }
  return body as T;
}

export function apiGet<T>(path: string): Promise<T> {
  return request<T>(path);
}

export function apiPost<T>(path: string, csrfToken: string, body?: unknown): Promise<T> {
  return request<T>(path, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'X-CSRF-Token': csrfToken
    },
    body: JSON.stringify(body ?? {})
  });
}
