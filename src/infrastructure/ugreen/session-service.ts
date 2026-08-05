import JSEncrypt from 'jsencrypt';
import type { ProxySession } from '../../domain/proxy/model';
import { ProxyAuthenticationError } from '../../domain/proxy/errors';
import type { ProxySessionService } from '../../application/gateway/ports';

const CACHE_TTL_SECONDS = 3600;
const DISCOVERY_TTL_SECONDS = 300;
const AUTH_FAILURE_TTL_SECONDS = 60;
const MAX_AUTH_PAGE_BYTES = 64 * 1024;
const MAX_DISCOVERY_BYTES = 16 * 1024;
const DISCOVERY_TIMEOUT_MS = 5000;
const DISCOVERY_ENDPOINTS = ['api-zh', 'api-us', 'api-eur', 'api-aar']
  .map((region) => `https://${region}.ugnas.com/api/p2p/v2/ta/nodeInfo/byAlias`);
const RELAY_DOMAIN = /^(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+ug\.link$/u;
const UGLINK_ID = /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/u;

export interface SessionCache {
  get(key: string): Promise<string | null>;
  put(key: string, value: string, options?: { expirationTtl?: number }): Promise<void>;
  delete(key: string): Promise<void>;
}

export interface UgreenSessionRuntime {
  uglinkId: string;
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

class UgreenOriginUnavailableError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'UgreenOriginUnavailableError';
  }
}

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

export function cacheKeys(sessionNamespace: string, port: string): { session: string } {
  return {
    session: `uglink:session:v2:${sessionNamespace}:${port}`
  };
}

export function discoveryCacheKey(sessionNamespace: string): string {
  return `uglink:discovery:v1:${sessionNamespace}`;
}

function authFailureKey(sessionNamespace: string): string {
  return `uglink:auth-failure:v1:${sessionNamespace}`;
}

async function readRecentAuthFailure(runtime: UgreenSessionRuntime): Promise<ProxyAuthenticationError | null> {
  const value = await runtime.cache.get(authFailureKey(runtime.sessionNamespace));
  if (!value) return null;
  const code = Number(value);
  return new ProxyAuthenticationError(Number.isInteger(code) ? code : 'unknown');
}

async function cacheAuthenticationFailure(
  runtime: UgreenSessionRuntime,
  error: ProxyAuthenticationError
): Promise<void> {
  await runtime.cache.put(authFailureKey(runtime.sessionNamespace), String(error.apiCode), {
    expirationTtl: AUTH_FAILURE_TTL_SECONDS
  });
}

export async function clearProxySession(runtime: UgreenSessionRuntime, port: string): Promise<void> {
  await runtime.cache.delete(cacheKeys(runtime.sessionNamespace, port).session);
}

async function readProxySession(runtime: UgreenSessionRuntime, port: string): Promise<ProxySession | null> {
  const stored = await runtime.cache.get(cacheKeys(runtime.sessionNamespace, port).session);
  if (!stored) return null;

  try {
    const parsed = JSON.parse(stored) as unknown;
    if (
      !isRecord(parsed)
      || typeof parsed.cookie !== 'string'
      || typeof parsed.origin !== 'string'
      || typeof parsed.loginOrigin !== 'string'
    ) {
      throw new Error('invalid proxy session');
    }
    const parsedOrigin = new URL(parsed.origin);
    const parsedLoginOrigin = new URL(parsed.loginOrigin);
    if (
      parsedOrigin.protocol !== 'https:'
      || parsedOrigin.origin !== parsed.origin
      || parsedLoginOrigin.protocol !== 'https:'
      || parsedLoginOrigin.origin !== parsed.loginOrigin
      || !validDiscoveredOrigin(parsed.loginOrigin, runtime.uglinkId)
    ) {
      throw new Error('invalid proxy origin');
    }
    return {
      cookie: parsed.cookie,
      origin: parsed.origin,
      loginOrigin: parsed.loginOrigin
    };
  } catch {
    await clearProxySession(runtime, port);
    return null;
  }
}

function validDiscoveredOrigin(origin: string, uglinkId: string): boolean {
  try {
    const parsed = new URL(origin);
    return parsed.protocol === 'https:'
      && parsed.origin === origin
      && parsed.port === ''
      && parsed.hostname.startsWith(`${uglinkId}.`)
      && RELAY_DOMAIN.test(parsed.hostname.slice(uglinkId.length + 1));
  } catch {
    return false;
  }
}

function parseDiscoveredOrigin(value: unknown, uglinkId: string): string {
  if (!isRecord(value) || value.code !== 200 || !isRecord(value.data)) {
    const code = isRecord(value) && typeof value.code === 'number' ? value.code : 'unknown';
    throw new Error(`UGREENlink discovery failed (code ${code})`);
  }
  const alias = value.data.alias;
  const relayDomain = value.data.relayDomain;
  if (
    typeof alias !== 'string'
    || alias.toLowerCase() !== uglinkId
    || typeof relayDomain !== 'string'
  ) {
    throw new Error('UGREENlink discovery returned an invalid device');
  }
  const normalizedDomain = relayDomain.trim().toLowerCase().replace(/\.$/u, '');
  if (!RELAY_DOMAIN.test(normalizedDomain)) {
    throw new Error('UGREENlink discovery returned an invalid relay domain');
  }
  const origin = `https://${uglinkId}.${normalizedDomain}`;
  if (!validDiscoveredOrigin(origin, uglinkId)) {
    throw new Error('UGREENlink discovery returned an invalid origin');
  }
  return origin;
}

async function fetchDiscoveredOrigin(runtime: UgreenSessionRuntime): Promise<string> {
  if (!UGLINK_ID.test(runtime.uglinkId)) {
    throw new Error('UGREENlink ID binding is invalid');
  }
  let lastFailure = 'unavailable';
  for (const endpoint of DISCOVERY_ENDPOINTS) {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), DISCOVERY_TIMEOUT_MS);
    let response: Response;
    try {
      response = await fetch(endpoint, {
        method: 'POST',
        headers: {
          Accept: 'application/json, text/plain, */*',
          'Content-Type': 'application/json',
          Origin: 'https://www.ug.link',
          Referer: 'https://www.ug.link/',
          lang: 'zh-CN'
        },
        body: JSON.stringify({ alias: runtime.uglinkId }),
        signal: controller.signal
      });
    } catch {
      lastFailure = 'network';
      continue;
    } finally {
      clearTimeout(timeout);
    }
    if (!response.ok) {
      lastFailure = `HTTP ${response.status}`;
      await response.body?.cancel();
      continue;
    }
    const text = await readTextWithLimit(response, MAX_DISCOVERY_BYTES);
    let payload: unknown;
    try {
      payload = JSON.parse(text) as unknown;
    } catch {
      lastFailure = 'invalid JSON';
      continue;
    }
    if (isRecord(payload) && payload.code === 200) {
      return parseDiscoveredOrigin(payload, runtime.uglinkId);
    }
    lastFailure = isRecord(payload) && typeof payload.code === 'number'
      ? `code ${payload.code}`
      : 'invalid response';
  }
  throw new Error(`UGREENlink discovery failed (${lastFailure})`);
}

async function getDiscoveredOrigin(
  runtime: UgreenSessionRuntime,
  force = false
): Promise<{ origin: string; cached: boolean }> {
  const key = discoveryCacheKey(runtime.sessionNamespace);
  if (!force) {
    const stored = await runtime.cache.get(key);
    if (stored) {
      try {
        const parsed = JSON.parse(stored) as unknown;
        if (isRecord(parsed) && typeof parsed.origin === 'string'
          && validDiscoveredOrigin(parsed.origin, runtime.uglinkId)) {
          return { origin: parsed.origin, cached: true };
        }
      } catch {
        // Invalid discovery cache entries are replaced below.
      }
      await runtime.cache.delete(key);
    }
  }
  const origin = await fetchDiscoveredOrigin(runtime);
  await runtime.cache.put(key, JSON.stringify({ origin }), { expirationTtl: DISCOVERY_TTL_SECONDS });
  return { origin, cached: false };
}

async function createProxySessionAtOrigin(
  runtime: UgreenSessionRuntime,
  port: string,
  loginOrigin: string
): Promise<ProxySession> {
  let checkResponse: Response;
  try {
    checkResponse = await fetch(`${loginOrigin}/ugreen/v1/verify/check`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ username: runtime.username })
    });
  } catch {
    throw new UgreenOriginUnavailableError('Failed to reach the discovered UGREEN origin');
  }

  if (!checkResponse.ok) {
    await checkResponse.body?.cancel();
    throw new UgreenOriginUnavailableError(`Failed to get encryption key (${checkResponse.status})`);
  }

  const rsaToken = checkResponse.headers.get('x-rsa-token');
  if (!rsaToken) {
    await checkResponse.body?.cancel();
    throw new UgreenOriginUnavailableError('No x-rsa-token in check response');
  }

  const encryptedPassword = encryptWithPublicKey(runtime.password, rsaToken, 'password');
  const loginResponse = await fetch(`${loginOrigin}/ugreen/v1/verify/login`, {
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
    await loginResponse.body?.cancel();
    const error = new ProxyAuthenticationError('unknown');
    await cacheAuthenticationFailure(runtime, error);
    throw error;
  }

  let loginData: LoginData;
  try {
    loginData = getLoginData(await loginResponse.json());
  } catch (error) {
    if (error instanceof ProxyAuthenticationError) {
      await cacheAuthenticationFailure(runtime, error);
    }
    throw error;
  }
  const encryptedToken = encryptWithPublicKey(loginData.token, loginData.publicKey, 'token');
  const dockerTokenResponse = await fetch(
    `${loginOrigin}/ugreen/v1/gateway/proxy/dockerToken?port=${encodeURIComponent(port)}`,
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
    origin: new URL(redirectUrl).origin,
    loginOrigin
  };

  await Promise.all([
    runtime.cache.put(
      cacheKeys(runtime.sessionNamespace, port).session,
      JSON.stringify(session),
      { expirationTtl: CACHE_TTL_SECONDS }
    ),
    runtime.cache.delete(authFailureKey(runtime.sessionNamespace))
  ]);

  console.log(JSON.stringify({ event: 'proxy_session_created', port }));
  return session;
}

export async function createProxySession(
  runtime: UgreenSessionRuntime,
  port: string,
  forceDiscovery = false
): Promise<ProxySession> {
  const discovered = await getDiscoveredOrigin(runtime, forceDiscovery);
  try {
    return await createProxySessionAtOrigin(runtime, port, discovered.origin);
  } catch (error) {
    if (!(error instanceof UgreenOriginUnavailableError) || !discovered.cached || forceDiscovery) throw error;
    await runtime.cache.delete(discoveryCacheKey(runtime.sessionNamespace));
    const refreshed = await getDiscoveredOrigin(runtime, true);
    return createProxySessionAtOrigin(runtime, port, refreshed.origin);
  }
}

export async function getProxySession(runtime: UgreenSessionRuntime, port: string): Promise<ProxySession> {
  const cached = await readProxySession(runtime, port);
  if (cached) return cached;

  const recentFailure = await readRecentAuthFailure(runtime);
  if (recentFailure) throw recentFailure;

  return createProxySession(runtime, port);
}

export async function invalidateProxySession(runtime: UgreenSessionRuntime, port: string): Promise<void> {
  await Promise.all([
    clearProxySession(runtime, port),
    runtime.cache.delete(discoveryCacheKey(runtime.sessionNamespace))
  ]);
}

export async function refreshProxySession(runtime: UgreenSessionRuntime, port: string): Promise<ProxySession> {
  await invalidateProxySession(runtime, port);
  const recentFailure = await readRecentAuthFailure(runtime);
  if (recentFailure) throw recentFailure;
  return createProxySession(runtime, port, true);
}

export function createUgreenSessionService(runtime: UgreenSessionRuntime): ProxySessionService {
  return {
    get: (port) => getProxySession(runtime, port),
    refresh: (port) => refreshProxySession(runtime, port),
    invalidate: (port) => invalidateProxySession(runtime, port)
  };
}
