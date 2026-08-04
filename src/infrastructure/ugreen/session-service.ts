import JSEncrypt from 'jsencrypt';
import type { ProxySession } from '../../domain/proxy/model';
import { ProxyAuthenticationError } from '../../domain/proxy/errors';
import type { ProxySessionService } from '../../application/gateway/ports';

const CACHE_TTL_SECONDS = 3600;
const AUTH_FAILURE_TTL_SECONDS = 60;
const MAX_AUTH_PAGE_BYTES = 64 * 1024;
const pendingSessions = new Map<string, Promise<ProxySession>>();

export interface SessionCache {
  get(key: string): Promise<string | null>;
  put(key: string, value: string, options?: { expirationTtl?: number }): Promise<void>;
  delete(key: string): Promise<void>;
}

export interface UgreenSessionRuntime {
  baseUrl: string;
  username: string;
  password: string;
  sessionNamespace: string;
  cache: SessionCache;
}

type LoginData = {
  publicKey: string;
  token: string;
  tokenId: string;
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function getLoginData(value: unknown): LoginData {
  if (!isRecord(value) || value.code !== 200 || !isRecord(value.data)) {
    const code = isRecord(value) && typeof value.code === 'number' ? value.code : 'unknown';
    throw new ProxyAuthenticationError(code);
  }

  const { public_key: publicKey, token, token_id: tokenId } = value.data;
  if (typeof publicKey !== 'string' || typeof token !== 'string' || typeof tokenId !== 'string') {
    throw new Error('Login API returned incomplete credentials');
  }

  return { publicKey, token, tokenId };
}

function getRedirectUrl(value: unknown): string {
  if (!isRecord(value) || value.code !== 200 || !isRecord(value.data)) {
    const code = isRecord(value) && typeof value.code === 'number' ? value.code : 'unknown';
    throw new Error(`Docker token API rejected the request (code ${code})`);
  }

  const redirectUrl = value.data.redirect_url;
  if (typeof redirectUrl !== 'string') {
    throw new Error('Docker token API returned no redirect URL');
  }

  const parsedRedirectUrl = new URL(redirectUrl);
  if (parsedRedirectUrl.protocol !== 'https:') {
    throw new Error('Docker token API returned a non-HTTPS redirect URL');
  }

  return parsedRedirectUrl.toString();
}

function encryptWithPublicKey(value: string, encodedPublicKey: string, label: string): string {
  const encryptor = new JSEncrypt();
  encryptor.setPublicKey(atob(encodedPublicKey));
  const encryptedValue = encryptor.encrypt(value);

  if (!encryptedValue) {
    throw new Error(`Failed to encrypt ${label}`);
  }

  return encryptedValue;
}

async function readTextWithLimit(response: Response, maxBytes: number): Promise<string> {
  if (!response.body) {
    return '';
  }

  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let totalBytes = 0;
  let result = '';

  while (true) {
    const { done, value } = await reader.read();
    if (done) {
      result += decoder.decode();
      return result;
    }

    totalBytes += value.byteLength;
    if (totalBytes > maxBytes) {
      await reader.cancel('auth page exceeded size limit');
      throw new Error('UGREEN auth page exceeded the size limit');
    }
    result += decoder.decode(value, { stream: true });
  }
}

export function cacheKeys(sessionNamespace: string, port: string): {
  cookie: string;
  origin: string;
} {
  return {
    cookie: `proxy_cookie:${sessionNamespace}:${port}`,
    origin: `proxy_origin:${sessionNamespace}:${port}`
  };
}

function authFailureKey(sessionNamespace: string): string {
  return `proxy_auth_failure:${sessionNamespace}`;
}

async function readRecentAuthFailure(runtime: UgreenSessionRuntime): Promise<ProxyAuthenticationError | null> {
  const value = await runtime.cache.get(authFailureKey(runtime.sessionNamespace));
  if (!value) return null;
  const code = Number(value);
  return new ProxyAuthenticationError(Number.isInteger(code) ? code : 'unknown');
}

export async function clearProxySession(runtime: UgreenSessionRuntime, port: string): Promise<void> {
  const keys = cacheKeys(runtime.sessionNamespace, port);
  await Promise.all([
    runtime.cache.delete(keys.cookie),
    runtime.cache.delete(keys.origin)
  ]);
}

async function readProxySession(runtime: UgreenSessionRuntime, port: string): Promise<ProxySession | null> {
  const keys = cacheKeys(runtime.sessionNamespace, port);
  const [cookie, origin] = await Promise.all([
    runtime.cache.get(keys.cookie),
    runtime.cache.get(keys.origin)
  ]);

  if (!cookie || !origin) {
    if (cookie || origin) {
      await clearProxySession(runtime, port);
    }
    return null;
  }

  try {
    const parsedOrigin = new URL(origin);
    if (parsedOrigin.protocol !== 'https:' || parsedOrigin.origin !== origin) {
      throw new Error('invalid proxy origin');
    }
  } catch {
    await clearProxySession(runtime, port);
    return null;
  }

  return { cookie, origin };
}

export async function createProxySession(runtime: UgreenSessionRuntime, port: string): Promise<ProxySession> {
  const baseUrl = new URL(runtime.baseUrl).origin;
  const checkResponse = await fetch(`${baseUrl}/ugreen/v1/verify/check`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ username: runtime.username })
  });

  if (!checkResponse.ok) {
    throw new Error(`Failed to get encryption key (${checkResponse.status})`);
  }

  const rsaToken = checkResponse.headers.get('x-rsa-token');
  if (!rsaToken) {
    throw new Error('No x-rsa-token in check response');
  }

  const encryptedPassword = encryptWithPublicKey(runtime.password, rsaToken, 'password');
  const loginResponse = await fetch(`${baseUrl}/ugreen/v1/verify/login`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'UG-Client-Id': runtime.sessionNamespace
    },
    body: JSON.stringify({
      username: runtime.username,
      password: encryptedPassword,
      keepalive: true,
      otp: true,
      is_simple: true
    })
  });

  if (!loginResponse.ok) {
    throw new Error(`Failed to login (${loginResponse.status})`);
  }

  let loginData: LoginData;
  try {
    loginData = getLoginData(await loginResponse.json());
  } catch (error) {
    if (error instanceof ProxyAuthenticationError) {
      await runtime.cache.put(authFailureKey(runtime.sessionNamespace), String(error.apiCode), {
        expirationTtl: AUTH_FAILURE_TTL_SECONDS
      });
    }
    throw error;
  }
  const encryptedToken = encryptWithPublicKey(loginData.token, loginData.publicKey, 'token');
  const dockerTokenResponse = await fetch(
    `${baseUrl}/ugreen/v1/gateway/proxy/dockerToken?port=${encodeURIComponent(port)}`,
    {
      headers: {
        'X-Ugreen-Token': encryptedToken,
        'X-Ugreen-Security-Key': loginData.tokenId
      }
    }
  );

  if (!dockerTokenResponse.ok) {
    throw new Error(`Failed to fetch docker token (${dockerTokenResponse.status})`);
  }

  const redirectUrl = getRedirectUrl(await dockerTokenResponse.json());
  const redirectResponse = await fetch(redirectUrl, { redirect: 'manual' });
  const setCookie = redirectResponse.headers.get('set-cookie');
  let cookie = setCookie?.split(';', 1)[0] ?? null;

  if (!cookie) {
    const authHtml = await readTextWithLimit(redirectResponse, MAX_AUTH_PAGE_BYTES);
    const cookieMatch = authHtml.match(
      /document\.cookie\s*=\s*['\"](ugreen-proxy-token=[^;'\"]+)/
    );
    cookie = cookieMatch?.[1] ?? null;
  }

  if (!cookie) {
    throw new Error('No proxy cookie in auth response');
  }

  const session = {
    cookie,
    origin: new URL(redirectUrl).origin
  };
  const keys = cacheKeys(runtime.sessionNamespace, port);

  await Promise.all([
    runtime.cache.put(keys.cookie, session.cookie, { expirationTtl: CACHE_TTL_SECONDS }),
    runtime.cache.put(keys.origin, session.origin, { expirationTtl: CACHE_TTL_SECONDS }),
    runtime.cache.delete(authFailureKey(runtime.sessionNamespace))
  ]);

  console.log(JSON.stringify({ event: 'proxy_session_created', port }));
  return session;
}

export async function getProxySession(runtime: UgreenSessionRuntime, port: string): Promise<ProxySession> {
  const cached = await readProxySession(runtime, port);
  if (cached) return cached;

  const recentFailure = await readRecentAuthFailure(runtime);
  if (recentFailure) throw recentFailure;

  const pendingKey = `${runtime.sessionNamespace}:${port}`;
  const existing = pendingSessions.get(pendingKey);
  if (existing) return existing;

  const pending = createProxySession(runtime, port).finally(() => {
    pendingSessions.delete(pendingKey);
  });
  pendingSessions.set(pendingKey, pending);
  return pending;
}

export function createUgreenSessionService(runtime: UgreenSessionRuntime): ProxySessionService {
  return {
    get: (port) => getProxySession(runtime, port),
    create: (port) => createProxySession(runtime, port),
    clear: (port) => clearProxySession(runtime, port)
  };
}
