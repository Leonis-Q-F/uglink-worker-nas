import type { ProxySession } from '../../domain/proxy/model';

export interface ProxySessionService {
  get(port: string): Promise<ProxySession>;
  create(port: string): Promise<ProxySession>;
  clear(port: string): Promise<void>;
}

export interface ProxyTransport {
  send(request: Request, session: ProxySession): Promise<Response>;
  isSessionExpired(response: Response, baseUrl: string): boolean;
}

export interface GatewayLogger {
  info(event: Record<string, unknown>): void;
  error(event: Record<string, unknown>): void;
}
