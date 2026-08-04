import type { ProxyFailureCode } from './model';

export class ProxyAuthenticationError extends Error {
  constructor(readonly apiCode: number | 'unknown') {
    super(`Login API rejected the request (code ${apiCode})`);
    this.name = 'ProxyAuthenticationError';
  }
}

export function proxyFailureCode(error: unknown): ProxyFailureCode | undefined {
  if (!(error instanceof ProxyAuthenticationError)) return undefined;
  switch (error.apiCode) {
    case 1003:
    case 1205:
      return 'invalid_credentials';
    case 1120:
      return 'account_locked';
    case 1113:
      return 'login_source_blocked';
    case 1000:
    case 1001:
      return 'account_blocked';
    case 1206:
      return 'password_expired';
    default:
      return 'authentication_failed';
  }
}
