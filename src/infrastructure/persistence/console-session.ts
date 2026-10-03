import type { ConsoleStore } from '../../application/console/ports';
import type { CloudflareConnection } from '../../application/console/contracts';
import { ApplicationError } from '../../application/common/application-error';
import type { WorkerTarget } from '../../domain/deployment/model';
import type { UglinkConfig } from '../../domain/configuration/model';
import { constantTimeEqual, openJson, randomToken, sealJson } from '../security/session-crypto';

const COOKIE_NAME = 'uglink_console_session';
const SESSION_TTL_SECONDS = 60 * 60 * 24 * 30;

export interface SessionData {
  version: 2;
  createdAt: number;
  expiresAt: number;
  csrfToken: string;
  externalOrigin?: string;
  cloudflare?: CloudflareConnection;
  target?: WorkerTarget;
  pendingCloudConfiguration?: UglinkConfig;
}

export interface SessionHandle {
  id: string;
  data: SessionData;
  shouldSetCookie: boolean;
  cookieName?: string;
}

export interface ConsoleSessionEnvironment {
  CONSOLE_SESSIONS: ConsoleStore;
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

export async function getOrCreateSession(request: Request, env: ConsoleSessionEnvironment, options?: { origin: string; bindOrigin: boolean }): Promise<SessionHandle> {
  const cookies = parseCookies(request);
  const cookieName = options?.bindOrigin
    ? `${COOKIE_NAME}_${Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(options.origin)))).map(byte => byte.toString(16).padStart(2, '0')).join('').slice(0, 32)}`
    : COOKIE_NAME;
  const legacy = cookieName !== COOKIE_NAME && !cookies.has(cookieName);
  const candidate = cookies.get(cookieName) ?? (legacy ? cookies.get(COOKIE_NAME) : undefined);
  if (candidate && /^[A-Za-z0-9_-]{40,80}$/u.test(candidate)) {
    const sealed = await env.CONSOLE_SESSIONS.get(sessionKey(candidate));
    if (sealed) {
      let data: SessionData | undefined;
      try {
        data = await openJson<SessionData>(sealed, env.SESSION_ENCRYPTION_KEY, associatedData(candidate));
      } catch (error) {
        console.warn(JSON.stringify({
          event: 'invalid_console_session',
          error: error instanceof Error ? error.message : String(error)
        }));
      }
      if (data?.version === 2 && data.expiresAt > Date.now()) {
        if (data.externalOrigin && data.externalOrigin !== options?.origin) {
          // A legacy host-wide cookie can belong to a different port/scheme.
          // Leave it intact and create an independent origin-scoped session.
          if (legacy) return createSession(env, cookieName, options);
          throw new ApplicationError(403, 'session_origin_mismatch', '当前会话属于其他访问入口，请使用原入口打开控制台。');
        }
        const handle = { id: candidate, data, cookieName, shouldSetCookie: legacy };
        if (!data.externalOrigin && options?.bindOrigin) {
          data.externalOrigin = options.origin;
          await saveSession(env, handle);
        }
        return handle;
      }
      await env.CONSOLE_SESSIONS.delete(sessionKey(candidate));
    }
  }
  return createSession(env, cookieName, options);
}

async function createSession(env: ConsoleSessionEnvironment, cookieName: string, options?: { origin: string; bindOrigin: boolean }): Promise<SessionHandle> {
  const id = randomToken(32);
  const handle = { id, data: newSession(), cookieName, shouldSetCookie: true } satisfies SessionHandle;
  if (options?.bindOrigin) handle.data.externalOrigin = options.origin;
  await saveSession(env, handle);
  return handle;
}

export async function saveSession(env: ConsoleSessionEnvironment, handle: SessionHandle): Promise<void> {
  const sealed = await sealJson(handle.data, env.SESSION_ENCRYPTION_KEY, associatedData(handle.id));
  await env.CONSOLE_SESSIONS.put(sessionKey(handle.id), sealed, {
    expirationTtl: SESSION_TTL_SECONDS
  });
}

export function applySessionCookie(request: Request, response: Response, handle: SessionHandle, options: { secure: boolean; refresh?: boolean } = { secure: new URL(request.url).protocol === 'https:' }): Response {
  if (!handle.shouldSetCookie && !options.refresh) return response;
  const headers = new Headers(response.headers);
  const secure = options.secure ? '; Secure' : '';
  const maxAge = Math.max(0, Math.floor((handle.data.expiresAt - Date.now()) / 1000));
  headers.append(
    'Set-Cookie',
    `${handle.cookieName ?? COOKIE_NAME}=${handle.id}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${maxAge}${secure}`
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
