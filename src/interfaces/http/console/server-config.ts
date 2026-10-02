import { BlockList, isIP } from 'node:net';
import { normalizeAuthority, normalizeOrigin } from './request-context';

export type ProxyHeaderMode = 'off' | 'forwarded-single' | 'x-forwarded-single';
export interface ServerConfig {
  readonly mode: ProxyHeaderMode;
  readonly publicOrigin?: string;
  readonly allows: (origin: string) => boolean;
  readonly mappedOrigin: (host: string) => string | undefined;
  readonly trusts: (peer: string | undefined) => boolean;
}

export function parseServerConfig(env: Record<string, string | undefined> = {}): ServerConfig {
  const list = (key: string) => {
    const value = env[key];
    if (!value?.trim()) return [];
    const items = value.split(',').map(v => v.trim());
    if (items.some(v => !v)) throw new Error(`${key}: empty list entry`);
    return items;
  };
  try {
    const mode = env.UGLINK_PROXY_HEADER_MODE || 'off';
    if (!['off', 'forwarded-single', 'x-forwarded-single'].includes(mode)) throw new Error('invalid proxy header mode');
    const allowed = new Set(list('UGLINK_ALLOWED_ORIGINS').map(normalizeOrigin));
    const cidrs = list('UGLINK_TRUSTED_PROXY_CIDRS');
    const mapText = (env.UGLINK_HOST_ORIGIN_MAP || '{}').trim();
    const parsed: unknown = JSON.parse(mapText);
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error('Host map must be an object');
    if (Object.values(parsed).some(value => typeof value !== 'string')) throw new Error('Host map values must be origins');
    const mappings = new Map<string, string>();
    // Scan the validated flat JSON's original members: JSON.parse alone discards
    // duplicate keys (including escaped spellings) before conflicts can be found.
    const member = /\s*("(?:[^"\\]|\\.)*")\s*:\s*("(?:[^"\\]|\\.)*")\s*/uy;
    let position = 1;
    while (mapText.slice(position).trim() !== '}') {
      member.lastIndex = position;
      const match = member.exec(mapText);
      if (!match) throw new Error('Host map values must be origins');
      position = member.lastIndex;
      if (mapText[position] === ',') position++;
      const key = JSON.parse(match[1]!) as string;
      const value = JSON.parse(match[2]!) as string;
      const host = normalizeAuthority(key);
      const origin = normalizeOrigin(value);
      if (!allowed.has(origin)) throw new Error('Host map origin must be allowed');
      if (normalizeOrigin(`${new URL(origin).protocol}//${host}`) !== origin) throw new Error('Host map must preserve authority');
      if (mappings.has(host) && mappings.get(host) !== origin) throw new Error('Conflicting Host mappings');
      mappings.set(host, origin);
    }
    if (mode === 'off' && cidrs.length) throw new Error('Trusted proxies require a header mode');
    if (mode !== 'off' && (!cidrs.length || !allowed.size)) throw new Error('Proxy mode requires trusted peers and allowed origins');
    const peers = new BlockList();
    for (const cidr of cidrs) {
      const parts = cidr.split('/');
      const ip = parts[0]!;
      const family = isIP(ip);
      if (!family || parts.length > 2 || (parts.length === 2 && !/^\d+$/u.test(parts[1]!))) throw new Error('Invalid proxy CIDR');
      const prefix = parts[1] === undefined ? (family === 4 ? 32 : 128) : Number(parts[1]);
      if (prefix > (family === 4 ? 32 : 128)) throw new Error('Invalid proxy CIDR prefix');
      // BlockList also matches IPv4-mapped IPv6 socket addresses against IPv4 rules.
      peers.addSubnet(ip, prefix, family === 4 ? 'ipv4' : 'ipv6');
    }
    const publicOrigin = env.UGLINK_PUBLIC_ORIGIN ? normalizeOrigin(env.UGLINK_PUBLIC_ORIGIN) : undefined;
    if (publicOrigin && (allowed.size || cidrs.length || mappings.size || mode !== 'off')) throw new Error('UGLINK_PUBLIC_ORIGIN cannot be combined with multi-entry settings');
    return Object.freeze({
      mode: mode as ProxyHeaderMode, publicOrigin,
      allows: (origin: string) => !allowed.size || allowed.has(origin),
      mappedOrigin: (host: string) => mappings.get(host),
      trusts: (peer: string | undefined) => Boolean(peer && isIP(peer) && peers.check(peer, isIP(peer) === 4 ? 'ipv4' : 'ipv6'))
    });
  } catch (error) {
    throw new Error(`Invalid console ingress configuration: ${error instanceof Error ? error.message : 'invalid value'}`);
  }
}
