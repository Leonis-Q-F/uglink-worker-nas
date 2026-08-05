import type { ProxySession } from '../../domain/proxy/model';

export interface ProxySessionService {
  get(port: string): Promise<ProxySession>;
  refresh(port: string): Promise<ProxySession>;
  invalidate(port: string): Promise<void>;
}

export interface ProxyTransport {
  send(request: Request, session: ProxySession): Promise<Response>;
  isSessionExpired(response: Response, session: ProxySession): boolean;
}

export interface GatewayLogger {
  info(event: Record<string, unknown>): void;
  error(event: Record<string, unknown>): void;
}
