import { ApplicationError } from '../../../application/common/application-error';
import { normalizeAuthority, normalizeOrigin } from './request-context';
import type { ProxyHeaderMode } from './server-config';

export function rawHeaderValues(raw: readonly string[], name: string): string[] {
  const values: string[] = [];
  for (let i = 0; i < raw.length; i += 2) if (raw[i]!.toLowerCase() === name) values.push(raw[i + 1]!);
  return values;
}

/** Only the configured family is authoritative; no list/hop guessing. */
export function proxyOrigin(raw: readonly string[], mode: ProxyHeaderMode): string | undefined {
  try {
    if (mode === 'off') return undefined;
    let host: string | undefined;
    let proto: string | undefined;
    if (mode === 'x-forwarded-single') {
      const hosts = rawHeaderValues(raw, 'x-forwarded-host');
      const protocols = rawHeaderValues(raw, 'x-forwarded-proto');
      if (!hosts.length && !protocols.length) return undefined;
      if (hosts.length !== 1 || protocols.length !== 1) throw new Error();
      host = hosts[0];
      proto = protocols[0];
    } else {
      const values = rawHeaderValues(raw, 'forwarded');
      if (!values.length) return undefined;
      if (values.length !== 1) throw new Error();
      const value = values[0]!;
      const parameters = new Map<string, string>();
      // RFC token / quoted-string. Commas outside a quoted value cannot match.
      const pair = /\s*([!#$%&'*+.^_`|~0-9A-Za-z-]+)=(?:([!#$%&'*+.^_`|~0-9A-Za-z-]+)|"((?:[\x20\x21\x23-\x5b\x5d-\x7e]|\\[\x20-\x7e])*)")\s*/y;
      let position = 0;
      while (position < value.length) {
        pair.lastIndex = position;
        const match = pair.exec(value);
        if (!match) throw new Error();
        const name = match[1]!.toLowerCase();
        if (parameters.has(name)) throw new Error();
        parameters.set(name, match[2] ?? match[3]!.replace(/\\(.)/gu, '$1'));
        position = pair.lastIndex;
        if (position === value.length) break;
        if (value[position] !== ';' || position + 1 === value.length) throw new Error();
        position++;
      }
      host = parameters.get('host');
      proto = parameters.get('proto');
    }
    if (!host || (proto !== 'http' && proto !== 'https')) throw new Error();
    return normalizeOrigin(`${proto}://${normalizeAuthority(host)}`);
  } catch {
    throw new ApplicationError(400, 'invalid_proxy_headers', '反向代理来源信息无效，请检查代理配置。');
  }
}
