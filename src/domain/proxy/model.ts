export interface ProxySession {
  cookie: string;
  origin: string;
}

export type ProxyFailureCode =
  | 'invalid_credentials'
  | 'account_locked'
  | 'login_source_blocked'
  | 'account_blocked'
  | 'password_expired'
  | 'authentication_failed';
