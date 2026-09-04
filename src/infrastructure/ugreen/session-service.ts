import JSEncrypt from 'jsencrypt';
import { createHash } from 'node:crypto';
import type { ProxySession } from '../../domain/proxy/model';
import {
  ProxyAuthenticationError,
  type ProxyAuthenticationIssue
} from '../../domain/proxy/errors';
import type { ProxySessionService } from '../../application/gateway/ports';

const CACHE_TTL_SECONDS = 3600;
const DISCOVERY_TTL_SECONDS = 300;
const AUTH_ATTEMPT_TTL_SECONDS = 300;
const DEFAULT_AUTH_FAILURE_TTL_SECONDS = 600;
const LOCKED_AUTH_FAILURE_TTL_SECONDS = 1800;
const BLOCKED_AUTH_FAILURE_TTL_SECONDS = 3600;
const MAX_AUTH_PAGE_BYTES = 64 * 1024;
const MAX_CLIENT_PAGE_BYTES = 32 * 1024;
const MAX_AUTH_RESPONSE_BYTES = 64 * 1024;
const MAX_DISCOVERY_BYTES = 16 * 1024;
const DISCOVERY_TIMEOUT_MS = 5000;
const CLIENT_PROFILE_TIMEOUT_MS = 5000;
const AUTH_REQUEST_TIMEOUT_MS = 15000;
const REDIRECT_TIMEOUT_MS = 30000;
const MAX_HANDOFF_REDIRECTS = 4;
const DEFAULT_CLIENT_PROFILE = {
  numberVersion: '78471',
  shortVersion: '1.19.0'
};
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

type LoginData =
  | { publicKey?: string; token: string; authType: 'url' }
  | { publicKey: string; token: string; authType: 'header' };

type LoginExchange = {
  data: LoginData;
  cookies: ResponseCookie[];
};

type ResponseCookie = {
  name: string;
  pair: string;
  domain: string;
  hostOnly: boolean;
  path: string;
  secure: boolean;
};

type ClientProfile = {
  numberVersion: string;
  shortVersion: string;
};

type ClientIdentity = {
  clientId: string;
  ugClientId: string;
};

class UgreenOriginUnavailableError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'UgreenOriginUnavailableError';
  }
}

class UgreenRequestTimeoutError extends Error {
  constructor(readonly phase: string) {
    super(`UGREEN request timed out during ${phase}`);
    this.name = 'UgreenRequestTimeoutError';
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

  const { public_key: publicKey, token, auth_type: authType, enable_otp: enableOtp } = value.data;
  if (Boolean(enableOtp) && (typeof token !== 'string' || token.length === 0)) {
    throw new ProxyAuthenticationError('otp_required');
  }
  if (typeof token !== 'string' || token.length === 0) {
    throw new Error('Login API returned incomplete credentials');
  }

  const normalizedAuthType = authType === undefined || authType === null || authType === 'url'
    ? 'url'
    : 'header';
  if (normalizedAuthType === 'header') {
    if (typeof publicKey !== 'string' || publicKey.length === 0) {
      throw new Error('Login API returned no public key for header authentication');
    }
    return { publicKey, token, authType: 'header' };
  }
  return {
    publicKey: typeof publicKey === 'string' && publicKey.length > 0 ? publicKey : undefined,
    token,
    authType: 'url'
  };
}

function getRedirectUrl(value: unknown): string {
  if (!isRecord(value) || value.code !== 200 || !isRecord(value.data)) {
    const code = isRecord(value) && typeof value.code === 'number' ? value.code : 'unknown';
    throw new ProxyAuthenticationError(code);
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

function md5Hex(value: string): string {
  return createHash('md5').update(value, 'utf8').digest('hex');
}

function domainMatches(hostname: string, domain: string): boolean {
  return hostname === domain || hostname.endsWith(`.${domain}`);
}

function defaultCookiePath(pathname: string): string {
  const lastSlash = pathname.lastIndexOf('/');
  return lastSlash <= 0 ? '/' : pathname.slice(0, lastSlash);
}

function responseCookies(headers: Headers, responseUrl: string): ResponseCookie[] {
  const source = new URL(responseUrl);
  const sourceHostname = source.hostname.toLowerCase();
  const cookies: ResponseCookie[] = [];
  for (const setCookie of headers.getSetCookie()) {
    const segments = setCookie.split(';');
    const pair = segments.shift()?.trim();
    const separator = pair?.indexOf('=') ?? -1;
    if (!pair || separator <= 0) continue;
    const name = pair.slice(0, separator);
    let domain = sourceHostname;
    let hostOnly = true;
    let path = defaultCookiePath(source.pathname);
    let secure = false;
    let valid = true;
    let expired = false;

    for (const segment of segments) {
      const attribute = segment.trim();
      const attributeSeparator = attribute.indexOf('=');
      const attributeName = (attributeSeparator < 0
        ? attribute
        : attribute.slice(0, attributeSeparator)).trim().toLowerCase();
      const attributeValue = attributeSeparator < 0
        ? ''
        : attribute.slice(attributeSeparator + 1).trim();
      switch (attributeName) {
        case 'domain': {
          const candidate = attributeValue.toLowerCase().replace(/^\./u, '');
          if (!candidate || !domainMatches(sourceHostname, candidate)) {
            valid = false;
            break;
          }
          domain = candidate;
          hostOnly = false;
          break;
        }
        case 'path':
          if (attributeValue.startsWith('/')) path = attributeValue;
          break;
        case 'secure':
          secure = true;
          break;
        case 'max-age':
          if (/^-?\d+$/u.test(attributeValue) && Number(attributeValue) <= 0) expired = true;
          break;
        case 'expires': {
          const expiresAt = Date.parse(attributeValue);
          if (Number.isFinite(expiresAt) && expiresAt <= Date.now()) expired = true;
          break;
        }
      }
      if (!valid) break;
    }
    if (valid && !expired) cookies.push({ name, pair, domain, hostOnly, path, secure });
  }
  return cookies;
}

function cookieHeaderForUrl(cookies: ResponseCookie[], targetUrl: string): string | undefined {
  const target = new URL(targetUrl);
  const hostname = target.hostname.toLowerCase();
  const selected = new Map<string, string>();
  for (const cookie of [...cookies].sort((left, right) => right.path.length - left.path.length)) {
    const domainAllowed = cookie.hostOnly
      ? hostname === cookie.domain
      : domainMatches(hostname, cookie.domain);
    const pathAllowed = target.pathname.startsWith(cookie.path)
      && (cookie.path.endsWith('/')
        || target.pathname.length === cookie.path.length
        || target.pathname[cookie.path.length] === '/');
    if (
      domainAllowed
      && pathAllowed
      && (!cookie.secure || target.protocol === 'https:')
      && !selected.has(cookie.name)
    ) {
      selected.set(cookie.name, cookie.pair);
    }
  }
  return selected.size > 0 ? [...selected.values()].join('; ') : undefined;
}

function mergeResponseCookies(
  current: ResponseCookie[],
  incoming: ResponseCookie[]
): ResponseCookie[] {
  const merged = [...current];
  for (const cookie of incoming) {
    const existingIndex = merged.findIndex((candidate) => (
      candidate.name === cookie.name
      && candidate.domain === cookie.domain
      && candidate.path === cookie.path
    ));
    if (existingIndex >= 0) merged.splice(existingIndex, 1);
    merged.push(cookie);
  }
  return merged;
}

function decodeJavascriptString(value: string): string {
  return value
    .replace(/\\x([0-9a-f]{2})/giu, (_, hex: string) => String.fromCharCode(Number.parseInt(hex, 16)))
    .replace(/\\u([0-9a-f]{4})/giu, (_, hex: string) => String.fromCharCode(Number.parseInt(hex, 16)))
    .replace(/\\([\\/'"bfnrt])/gu, (_, escaped: string) => {
      const controls: Record<string, string> = {
        b: '\b',
        f: '\f',
        n: '\n',
        r: '\r',
        t: '\t'
      };
      return controls[escaped] ?? escaped;
    });
}

function documentCookies(html: string, responseUrl: string): ResponseCookie[] {
  const assignments = [
    ...html.matchAll(/document\.cookie\s*=\s*"((?:\\.|[^"\\])*)"/gu),
    ...html.matchAll(/document\.cookie\s*=\s*'((?:\\.|[^'\\])*)'/gu)
  ];
  const headers = new Headers();
  for (const assignment of assignments) {
    const value = assignment[1];
    if (value) headers.append('Set-Cookie', decodeJavascriptString(value));
  }
  return responseCookies(headers, responseUrl);
}

type HandoffNavigation = {
  kind: 'assign' | 'replace' | 'reload' | 'meta';
  url: string;
};

function literalNavigationTarget(html: string): HandoffNavigation | null {
  const literalPatterns: Array<{
    kind: HandoffNavigation['kind'];
    pattern: RegExp;
  }> = [
    {
      kind: 'replace',
      pattern: /(?:window\.)?location\.(?:replace|assign)\s*\(\s*"((?:\\.|[^"\\])*)"\s*\)/iu
    },
    {
      kind: 'replace',
      pattern: /(?:window\.)?location\.(?:replace|assign)\s*\(\s*'((?:\\.|[^'\\])*)'\s*\)/iu
    },
    {
      kind: 'assign',
      pattern: /(?:window\.)?location(?:\.href)?\s*=\s*"((?:\\.|[^"\\])*)"/iu
    },
    {
      kind: 'assign',
      pattern: /(?:window\.)?location(?:\.href)?\s*=\s*'((?:\\.|[^'\\])*)'/iu
    }
  ];
  for (const { kind, pattern } of literalPatterns) {
    const value = html.match(pattern)?.[1];
    if (value) return { kind, url: decodeJavascriptString(value) };
  }

  const meta = html.match(
    /<meta\b[^>]*http-equiv\s*=\s*["']?refresh["']?[^>]*content\s*=\s*["'][^"']*?url\s*=\s*([^"';>\s]+)[^"']*["'][^>]*>/iu
  )?.[1];
  if (meta) return { kind: 'meta', url: meta };

  if (/(?:window\.)?location\.reload\s*\(/iu.test(html)) {
    return { kind: 'reload', url: '' };
  }
  return null;
}

function createClientIdentity(sessionNamespace: string): ClientIdentity {
  return {
    clientId: `${crypto.randomUUID().slice(0, -12)}WEB`,
    ugClientId: md5Hex(`uglink-worker:${sessionNamespace}:Chrome`)
  };
}

function browserContextHeaders(loginOrigin: string): Record<string, string> {
  return {
    Origin: loginOrigin,
    Referer: `${loginOrigin}/desktop/`
  };
}

function clientHeaders(
  identity: ClientIdentity,
  profile: ClientProfile,
  loginOrigin: string
): Record<string, string> {
  return {
    Accept: 'application/json, text/plain, */*',
    'Cache-Control': 'no-cache',
    'Client-Id': identity.clientId,
    'Client-Version': profile.numberVersion,
    'Client-Version-Str': profile.shortVersion,
    'UG-Agent': 'PC/WEB',
    'X-Specify-Language': 'zh-CN',
    ...browserContextHeaders(loginOrigin)
  };
}

async function withRequestTimeout<T>(
  timeoutMs: number,
  phase: string,
  operation: (signal: AbortSignal) => Promise<T>
): Promise<T> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await operation(controller.signal);
  } catch (error) {
    if (controller.signal.aborted) throw new UgreenRequestTimeoutError(phase);
    throw error;
  } finally {
    clearTimeout(timeout);
  }
}

function logAuthPhase(phase: string, status: 'ok' | 'failed', startedAt: number): void {
  console.log(JSON.stringify({
    event: 'ugreen_auth_phase',
    phase,
    status,
    durationMs: Date.now() - startedAt
  }));
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

export function authAttemptKey(sessionNamespace: string): string {
  return `uglink:auth-attempt:v1:${sessionNamespace}`;
}

function parseStoredAuthIssue(value: string): ProxyAuthenticationIssue {
  const numericCode = Number(value);
  if (Number.isInteger(numericCode)) return numericCode;
  switch (value) {
    case 'otp_required':
    case 'timeout':
    case 'unavailable':
      return value;
    default:
      return 'unknown';
  }
}

async function readRecentAuthFailure(runtime: UgreenSessionRuntime): Promise<ProxyAuthenticationError | null> {
  const value = await runtime.cache.get(authFailureKey(runtime.sessionNamespace));
  if (!value) return null;
  return new ProxyAuthenticationError(parseStoredAuthIssue(value));
}

function authenticationFailureTtl(issue: ProxyAuthenticationIssue): number {
  switch (issue) {
    case 1120:
    case 1113:
      return LOCKED_AUTH_FAILURE_TTL_SECONDS;
    case 1000:
    case 1001:
    case 1206:
    case 'otp_required':
      return BLOCKED_AUTH_FAILURE_TTL_SECONDS;
    default:
      return DEFAULT_AUTH_FAILURE_TTL_SECONDS;
  }
}

async function cacheAuthenticationFailure(
  runtime: UgreenSessionRuntime,
  error: ProxyAuthenticationError
): Promise<void> {
  await runtime.cache.put(authFailureKey(runtime.sessionNamespace), String(error.apiCode), {
    expirationTtl: authenticationFailureTtl(error.apiCode)
  });
}

async function reserveAuthenticationAttempt(runtime: UgreenSessionRuntime): Promise<string> {
  const recentFailure = await readRecentAuthFailure(runtime);
  if (recentFailure) throw recentFailure;

  const key = authAttemptKey(runtime.sessionNamespace);
  if (await runtime.cache.get(key)) throw new ProxyAuthenticationError('backoff');

  const attemptId = crypto.randomUUID();
  await runtime.cache.put(key, attemptId, { expirationTtl: AUTH_ATTEMPT_TTL_SECONDS });
  if (await runtime.cache.get(key) !== attemptId) {
    throw new ProxyAuthenticationError('backoff');
  }
  return attemptId;
}

async function releaseAuthenticationAttempt(
  runtime: UgreenSessionRuntime,
  attemptId: string
): Promise<void> {
  const key = authAttemptKey(runtime.sessionNamespace);
  if (await runtime.cache.get(key) === attemptId) await runtime.cache.delete(key);
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

async function readJsonWithLimit(response: Response, maxBytes: number, label: string): Promise<unknown> {
  const text = await readTextWithLimit(response, maxBytes);
  try {
    return JSON.parse(text) as unknown;
  } catch {
    throw new Error(`${label} returned invalid JSON`);
  }
}

async function loadClientProfile(loginOrigin: string): Promise<ClientProfile> {
  try {
    return await withRequestTimeout(
      CLIENT_PROFILE_TIMEOUT_MS,
      'client_profile',
      async (signal) => {
        const response = await fetch(`${loginOrigin}/desktop/`, {
          headers: { Accept: 'text/html' },
          signal
        });
        if (!response.ok) {
          await response.body?.cancel();
          return DEFAULT_CLIENT_PROFILE;
        }
        const html = await readTextWithLimit(response, MAX_CLIENT_PAGE_BYTES);
        const numberVersion = html.match(
          /clientNumberVersion\s*=\s*(?:window\.clientNumberVersion\s*=\s*)?(\d{1,10})/u
        )?.[1];
        const showVersion = html.match(
          /clientShowVersion\s*=\s*(?:window\.clientShowVersion\s*=\s*)?["'](\d+\.\d+\.\d+(?:\.\d+)?)["']/u
        )?.[1];
        if (!numberVersion || !showVersion) return DEFAULT_CLIENT_PROFILE;
        return {
          numberVersion,
          shortVersion: showVersion.split('.').slice(0, 3).join('.')
        };
      }
    );
  } catch {
    return DEFAULT_CLIENT_PROFILE;
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
  // The official web client loads its version metadata before the user submits
  // the login form, then performs verify/check with a native browser fetch.
  const clientProfile = await loadClientProfile(loginOrigin);
  const identity = createClientIdentity(runtime.sessionNamespace);
  const checkStartedAt = Date.now();
  let checkResponse: Response;
  try {
    checkResponse = await withRequestTimeout(
      AUTH_REQUEST_TIMEOUT_MS,
      'verify_check',
      (signal) => fetch(`${loginOrigin}/ugreen/v1/verify/check`, {
        method: 'POST',
        headers: {
          Accept: '*/*',
          'Content-Type': 'text/plain;charset=UTF-8',
          ...browserContextHeaders(loginOrigin)
        },
        body: JSON.stringify({ username: runtime.username }),
        signal
      })
    );
  } catch {
    logAuthPhase('verify_check', 'failed', checkStartedAt);
    throw new UgreenOriginUnavailableError('Failed to reach the discovered UGREEN origin');
  }

  if (!checkResponse.ok) {
    await checkResponse.body?.cancel();
    logAuthPhase('verify_check', 'failed', checkStartedAt);
    throw new UgreenOriginUnavailableError(`Failed to get encryption key (${checkResponse.status})`);
  }

  const rsaToken = checkResponse.headers.get('x-rsa-token');
  if (!rsaToken) {
    await checkResponse.body?.cancel();
    logAuthPhase('verify_check', 'failed', checkStartedAt);
    throw new UgreenOriginUnavailableError('No x-rsa-token in check response');
  }
  await checkResponse.body?.cancel();
  logAuthPhase('verify_check', 'ok', checkStartedAt);

  const encryptedPassword = encryptWithPublicKey(runtime.password, rsaToken, 'password');
  const commonHeaders = clientHeaders(identity, clientProfile, loginOrigin);
  const loginStartedAt = Date.now();
  let loginExchange: LoginExchange;
  try {
    loginExchange = await withRequestTimeout(
      AUTH_REQUEST_TIMEOUT_MS,
      'verify_login',
      async (signal) => {
        const loginUrl = `${loginOrigin}/ugreen/v1/verify/login`;
        const loginResponse = await fetch(loginUrl, {
          method: 'POST',
          headers: {
            ...commonHeaders,
            'Content-Type': 'application/json',
            'UG-Client-Id': identity.ugClientId
          },
          body: JSON.stringify({
            username: runtime.username,
            password: encryptedPassword,
            keepalive: false,
            otp: true,
            is_simple: true
          }),
          signal
        });
        if (!loginResponse.ok) {
          await loginResponse.body?.cancel();
          throw new ProxyAuthenticationError('unknown');
        }
        const cookies = responseCookies(loginResponse.headers, loginUrl);
        const data = getLoginData(
          await readJsonWithLimit(loginResponse, MAX_AUTH_RESPONSE_BYTES, 'Login API')
        );
        return { data, cookies };
      }
    );
  } catch (error) {
    logAuthPhase('verify_login', 'failed', loginStartedAt);
    if (error instanceof ProxyAuthenticationError) throw error;
    if (error instanceof UgreenRequestTimeoutError) {
      throw new ProxyAuthenticationError('timeout');
    }
    throw new ProxyAuthenticationError('unavailable');
  }
  logAuthPhase('verify_login', 'ok', loginStartedAt);
  const loginData = loginExchange.data;
  console.log(JSON.stringify({
    event: 'ugreen_login_context',
    responseCookieCount: loginExchange.cookies.length
  }));

  const dockerTokenUrl = new URL(`${loginOrigin}/ugreen/v1/gateway/proxy/dockerToken`);
  dockerTokenUrl.searchParams.set('port', port);
  const dockerTokenHeaders = new Headers(commonHeaders);
  const dockerTokenCookie = cookieHeaderForUrl(loginExchange.cookies, dockerTokenUrl.toString());
  if (dockerTokenCookie) {
    dockerTokenHeaders.set('Cookie', dockerTokenCookie);
  }
  dockerTokenHeaders.set('X-Ugreen-Security-Key', md5Hex(loginData.token));
  if (loginData.authType === 'url') {
    dockerTokenUrl.searchParams.set('token', loginData.token);
  } else {
    dockerTokenHeaders.set(
      'X-Ugreen-Token',
      encryptWithPublicKey(loginData.token, loginData.publicKey, 'token')
    );
  }

  const dockerTokenStartedAt = Date.now();
  let redirectUrl: string;
  try {
    redirectUrl = await withRequestTimeout(
      AUTH_REQUEST_TIMEOUT_MS,
      'docker_token',
      async (signal) => {
        const dockerTokenResponse = await fetch(dockerTokenUrl.toString(), {
          headers: dockerTokenHeaders,
          signal
        });
        if (!dockerTokenResponse.ok) {
          await dockerTokenResponse.body?.cancel();
          throw new ProxyAuthenticationError('unknown');
        }
        return getRedirectUrl(
          await readJsonWithLimit(dockerTokenResponse, MAX_AUTH_RESPONSE_BYTES, 'Docker token API')
        );
      }
    );
  } catch (error) {
    logAuthPhase('docker_token', 'failed', dockerTokenStartedAt);
    if (error instanceof ProxyAuthenticationError) throw error;
    if (error instanceof UgreenRequestTimeoutError) {
      throw new ProxyAuthenticationError('timeout');
    }
    throw new ProxyAuthenticationError('unavailable');
  }
  logAuthPhase('docker_token', 'ok', dockerTokenStartedAt);

  const redirectStartedAt = Date.now();
  let cookie: string | null;
  let proxyOrigin: string;
  try {
    const handoff = await withRequestTimeout(
      REDIRECT_TIMEOUT_MS,
      'proxy_redirect',
      async (signal) => {
        const redirectTarget = new URL(redirectUrl);
        const redirectHeaders = new Headers({
          Accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
          Referer: `${loginOrigin}/desktop/`
        });
        const redirectCookie = cookieHeaderForUrl(loginExchange.cookies, redirectUrl);
        if (redirectCookie) {
          redirectHeaders.set('Cookie', redirectCookie);
        }
        console.log(JSON.stringify({
          event: 'ugreen_proxy_handoff',
          sameHostname: redirectTarget.hostname === new URL(loginOrigin).hostname,
          ugLinkHostname: RELAY_DOMAIN.test(redirectTarget.hostname),
          explicitPort: redirectTarget.port !== '',
          cookieAttached: Boolean(redirectCookie)
        }));
        const responseStartedAt = Date.now();
        const redirectResponse = await fetch(redirectUrl, {
          headers: redirectHeaders,
          redirect: 'manual',
          signal
        });
        console.log(JSON.stringify({
          event: 'ugreen_proxy_handoff_response',
          status: redirectResponse.status,
          hasSetCookie: redirectResponse.headers.getSetCookie().length > 0,
          durationMs: Date.now() - responseStartedAt
        }));
        let proxyCookies = responseCookies(redirectResponse.headers, redirectUrl);
        let navigation: HandoffNavigation | null = null;
        let documentCookieCount = 0;
        let responseLocation = redirectResponse.headers.get('location');
        if (!responseLocation && redirectResponse.status >= 200 && redirectResponse.status < 300) {
          const authHtml = await readTextWithLimit(redirectResponse, MAX_AUTH_PAGE_BYTES);
          const pageCookies = documentCookies(authHtml, redirectUrl);
          documentCookieCount = pageCookies.length;
          proxyCookies = mergeResponseCookies(proxyCookies, pageCookies);
          navigation = literalNavigationTarget(authHtml);
          console.log(JSON.stringify({
            event: 'ugreen_proxy_handoff_page',
            documentCookieCount: pageCookies.length,
            navigation: navigation?.kind ?? 'fallback',
            pathDepth: redirectTarget.pathname.split('/').filter(Boolean).length,
            queryParameterCount: [...redirectTarget.searchParams.keys()].length
          }));
        } else {
          await redirectResponse.body?.cancel();
        }

        if (!proxyCookies.some((candidate) => candidate.name === 'ugreen-proxy-token')) {
          return { cookie: null, origin: redirectTarget.origin };
        }
        if (!responseLocation && documentCookieCount === 0) {
          return {
            cookie: cookieHeaderForUrl(proxyCookies, `${redirectTarget.origin}/`) ?? null,
            origin: redirectTarget.origin
          };
        }

        let activationUrl: URL;
        if (responseLocation) {
          activationUrl = new URL(responseLocation, redirectUrl);
        } else if (navigation) {
          activationUrl = navigation.kind === 'reload'
            ? new URL(redirectUrl)
            : new URL(navigation.url, redirectUrl);
        } else {
          activationUrl = new URL('/', redirectUrl);
        }
        if (activationUrl.protocol !== 'https:' || activationUrl.origin !== redirectTarget.origin) {
          throw new Error('UGREEN proxy handoff attempted to leave its HTTPS origin');
        }

        let redirects = 0;
        let activationStatus = 0;
        while (true) {
          const activationHeaders = new Headers({
            Accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
            Referer: redirectUrl
          });
          const activationCookie = cookieHeaderForUrl(proxyCookies, activationUrl.toString());
          if (activationCookie) activationHeaders.set('Cookie', activationCookie);
          const activationResponse = await fetch(activationUrl.toString(), {
            headers: activationHeaders,
            redirect: 'manual',
            signal
          });
          activationStatus = activationResponse.status;
          proxyCookies = mergeResponseCookies(
            proxyCookies,
            responseCookies(activationResponse.headers, activationUrl.toString())
          );
          responseLocation = activationResponse.headers.get('location');
          await activationResponse.body?.cancel();
          if (
            !responseLocation
            || ![301, 302, 303, 307, 308].includes(activationStatus)
            || redirects >= MAX_HANDOFF_REDIRECTS
          ) {
            break;
          }
          const nextUrl = new URL(responseLocation, activationUrl);
          if (nextUrl.protocol !== 'https:' || nextUrl.origin !== redirectTarget.origin) {
            throw new Error('UGREEN proxy activation attempted to leave its HTTPS origin');
          }
          activationUrl = nextUrl;
          redirects += 1;
        }
        console.log(JSON.stringify({
          event: 'ugreen_proxy_activation',
          status: activationStatus,
          redirects,
          destinationRoot: activationUrl.pathname === '/',
          cookieCount: proxyCookies.length
        }));
        return {
          cookie: cookieHeaderForUrl(proxyCookies, `${redirectTarget.origin}/`) ?? null,
          origin: redirectTarget.origin
        };
      }
    );
    cookie = handoff.cookie;
    proxyOrigin = handoff.origin;
  } catch (error) {
    logAuthPhase('proxy_redirect', 'failed', redirectStartedAt);
    if (error instanceof UgreenRequestTimeoutError) {
      throw new ProxyAuthenticationError('timeout');
    }
    throw new ProxyAuthenticationError('unavailable');
  }

  if (!cookie) {
    logAuthPhase('proxy_redirect', 'failed', redirectStartedAt);
    throw new Error('No proxy cookie in auth response');
  }
  logAuthPhase('proxy_redirect', 'ok', redirectStartedAt);

  const session = {
    cookie,
    origin: proxyOrigin,
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
  const attemptId = await reserveAuthenticationAttempt(runtime);
  try {
    const discovered = await getDiscoveredOrigin(runtime, forceDiscovery);
    let session: ProxySession;
    try {
      session = await createProxySessionAtOrigin(runtime, port, discovered.origin);
    } catch (error) {
      if (!(error instanceof UgreenOriginUnavailableError) || !discovered.cached || forceDiscovery) {
        throw error;
      }
      await runtime.cache.delete(discoveryCacheKey(runtime.sessionNamespace));
      const refreshed = await getDiscoveredOrigin(runtime, true);
      session = await createProxySessionAtOrigin(runtime, port, refreshed.origin);
    }
    await releaseAuthenticationAttempt(runtime, attemptId);
    return session;
  } catch (error) {
    if (error instanceof ProxyAuthenticationError && error.apiCode !== 'backoff') {
      await cacheAuthenticationFailure(runtime, error);
    }
    throw error;
  }
}

export async function getProxySession(runtime: UgreenSessionRuntime, port: string): Promise<ProxySession> {
  const cached = await readProxySession(runtime, port);
  if (cached) return cached;
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
  return createProxySession(runtime, port, true);
}

export function createUgreenSessionService(runtime: UgreenSessionRuntime): ProxySessionService {
  return {
    get: (port) => getProxySession(runtime, port),
    refresh: (port) => refreshProxySession(runtime, port),
    invalidate: (port) => invalidateProxySession(runtime, port)
  };
}
