/** Browser-visible destination, resolved once by the ingress, never from Origin. */
export interface ExternalRequestContext {
  readonly externalOrigin: string;
  readonly externalUrl: string;
  readonly secureCookies: boolean;
  readonly source: 'direct' | 'trusted-proxy' | 'configured-host' | 'legacy';
}

export function normalizeAuthority(value: string): string {
  if (!value || /[\s\x00-\x1f\x7f/@?#\\%,*]/u.test(value)) throw new Error('Invalid authority');
  const match = /^(\[[0-9a-fA-F:.]+\]|[^:\[\]]+)(?::([0-9]+))?$/u.exec(value);
  if (!match) throw new Error('Invalid authority');
  const port = match[2] === undefined ? undefined : Number(match[2]);
  if (port !== undefined && (!Number.isInteger(port) || port < 1 || port > 65535)) throw new Error('Invalid port');
  const url = new URL(`http://${value}`);
  return url.hostname + (port === undefined ? '' : `:${port}`);
}

export function normalizeOrigin(value: string): string {
  const match = /^(https?):\/\/([^/]+)$/iu.exec(value);
  if (!match) throw new Error('Expected a complete http/https origin without a path');
  const authority = normalizeAuthority(match[2]!);
  return new URL(`${match[1]!.toLowerCase()}://${authority}`).origin;
}

export function requestContext(origin: string, target: string, source: ExternalRequestContext['source']): ExternalRequestContext {
  return Object.freeze({ externalOrigin: origin, externalUrl: origin + target, secureCookies: new URL(origin).protocol === 'https:', source });
}

export function platformContext(request: Request): ExternalRequestContext {
  const url = new URL(request.url);
  return requestContext(url.origin, url.pathname + url.search, 'direct');
}
