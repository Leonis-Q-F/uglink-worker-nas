import type { CloudflareConnection } from '../../application/console/contracts';
import { ApplicationError } from '../../application/common/application-error';
import type { WorkerTarget } from '../../domain/deployment/model';
import { constantTimeEqual, openJson, randomToken, sealJson } from '../security/session-crypto';

const COOKIE_NAME = 'uglink_console_session';
const SESSION_TTL_SECONDS = 60 * 60 * 24 * 30;

export interface SessionData {
  version: 2;
  createdAt: number;
  expiresAt: number;
  csrfToken: string;
  cloudflare?: CloudflareConnection;
  target?: WorkerTarget;
}

export interface SessionHandle {
  id: string;
  data: SessionData;
  shouldSetCookie: boolean;
}

export interface ConsoleSessionEnvironment {
  CONSOLE_SESSIONS: KVNamespace;
  SESSION_ENCRYPTION_KEY: string;
}

function parseCookies(request: Request): Map<string, string> {
  const cookies = new Map<string, string>();
  for (const part of (request.headers.get('cookie') || '').split(';')) {
    const separator = part.indexOf('=');
    if (separator < 1) continue;
    const name = part.slice(0, separator).trim();
    const value = part.slice(separator + 1).trim();
    if (name) cookies.set(name, value);
  }
  return cookies;
}

function newSession(): SessionData {
  const now = Date.now();
  return {
    version: 2,
    createdAt: now,
    expiresAt: now + SESSION_TTL_SECONDS * 1000,
    csrfToken: randomToken(24)
  };
}

function sessionKey(id: string): string {
  return `session:${id}`;
}

function associatedData(id: string): string {
  return `uglink-console-session:${id}`;
}

export async function getOrCreateSession(request: Request, env: ConsoleSessionEnvironment): Promise<SessionHandle> {
  const candidate = parseCookies(request).get(COOKIE_NAME);
  if (candidate && /^[A-Za-z0-9_-]{40,80}$/u.test(candidate)) {
    const sealed = await env.CONSOLE_SESSIONS.get(sessionKey(candidate));
    if (sealed) {
      try {
        const data = await openJson<SessionData>(sealed, env.SESSION_ENCRYPTION_KEY, associatedData(candidate));
        if (data.version === 2 && data.expiresAt > Date.now()) {
          return { id: candidate, data, shouldSetCookie: false };
        }
      } catch (error) {
        console.warn(JSON.stringify({
          event: 'invalid_console_session',
          error: error instanceof Error ? error.message : String(error)
        }));
      }
      await env.CONSOLE_SESSIONS.delete(sessionKey(candidate));
    }
  }

  const id = randomToken(32);
  const handle = { id, data: newSession(), shouldSetCookie: true } satisfies SessionHandle;
  await saveSession(env, handle);
  return handle;
}

export async function saveSession(env: ConsoleSessionEnvironment, handle: SessionHandle): Promise<void> {
  const sealed = await sealJson(handle.data, env.SESSION_ENCRYPTION_KEY, associatedData(handle.id));
  await env.CONSOLE_SESSIONS.put(sessionKey(handle.id), sealed, {
    expirationTtl: SESSION_TTL_SECONDS
  });
}

export function applySessionCookie(request: Request, response: Response, handle: SessionHandle): Response {
  if (!handle.shouldSetCookie) return response;
  const headers = new Headers(response.headers);
  const secure = new URL(request.url).protocol === 'https:' ? '; Secure' : '';
  headers.append(
    'Set-Cookie',
    `${COOKIE_NAME}=${handle.id}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${SESSION_TTL_SECONDS}${secure}`
  );
  return new Response(response.body, { status: response.status, statusText: response.statusText, headers });
}

export function assertCsrf(request: Request, session: SessionHandle): void {
  const submitted = request.headers.get('x-csrf-token') || '';
  if (!submitted || !constantTimeEqual(submitted, session.data.csrfToken)) {
    throw new ApplicationError(403, 'invalid_csrf_token', '页面会话已过期，请刷新后重试。');
  }
}

export function requireTarget(session: SessionHandle): WorkerTarget {
  if (!session.data.target) {
    throw new ApplicationError(409, 'target_not_selected', '请先选择 Cloudflare 账户并设置服务名称。');
  }
  return session.data.target;
}
