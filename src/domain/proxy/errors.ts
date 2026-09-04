import type { ProxyFailureCode } from './model';

export type ProxyAuthenticationIssue =
  | number
  | 'unknown'
  | 'otp_required'
  | 'backoff'
  | 'timeout'
  | 'unavailable';

export class ProxyAuthenticationError extends Error {
  constructor(readonly apiCode: ProxyAuthenticationIssue) {
    const message = typeof apiCode === 'number' || apiCode === 'unknown'
      ? `Login API rejected the request (code ${apiCode})`
      : {
          otp_required: 'Login requires one-time verification',
          backoff: 'Login attempt deferred by authentication backoff',
          timeout: 'UGREEN authentication request timed out',
          unavailable: 'UGREEN authentication service is unavailable'
        }[apiCode];
    super(message);
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
    case 'otp_required':
      return 'otp_required';
    case 'backoff':
      return 'authentication_backoff';
    case 'timeout':
      return 'authentication_timeout';
    case 'unavailable':
      return 'authentication_unavailable';
    default:
      return 'authentication_failed';
  }
}
