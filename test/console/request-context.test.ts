import { describe, expect, it } from 'vitest';
import { parseServerConfig } from '../../src/interfaces/http/console/server-config';
import { resolveNodeContext } from '../../src/interfaces/http/console/node-request-context';
import { normalizeOrigin } from '../../src/interfaces/http/console/request-context';

const config = { UGLINK_ALLOWED_ORIGINS: 'http://lan.test:5173,https://proxy.test,https://relay.test', UGLINK_TRUSTED_PROXY_CIDRS: '192.0.2.2/32,2001:db8::/32', UGLINK_PROXY_HEADER_MODE: 'x-forwarded-single', UGLINK_HOST_ORIGIN_MAP: '{"relay.test":"https://relay.test"}' };
const resolve = (headers: string[] = [], peer = '192.0.2.2', host = 'lan.test:5173', path = '/api/bootstrap', env = config) => resolveNodeContext({ rawHeaders: ['Host', host, ...headers], remoteAddress: peer, target: path, method: 'GET' }, parseServerConfig(env));
const forwarded = ['X-Forwarded-Host', 'proxy.test', 'X-Forwarded-Proto', 'https'];
describe('external origin policy', () => {
  it('keeps direct, trusted and mapped entries independent including mapped IPv4 and IPv6 peers', () => {
    expect(resolve(forwarded).externalOrigin).toBe('https://proxy.test');
    expect(resolve(forwarded, '::ffff:192.0.2.2').secureCookies).toBe(true);
    expect(resolve(forwarded, '2001:db8::1').secureCookies).toBe(true);
    expect(resolve(forwarded, '192.0.2.3').externalOrigin).toBe('http://lan.test:5173');
    expect(resolve([], '192.0.2.3', 'relay.test').secureCookies).toBe(true);
    expect(resolve([], '192.0.2.2', 'relay.test').externalOrigin).toBe('https://relay.test');
    expect(resolve(forwarded, '192.0.2.2', 'lan.test:5173', '/api/bootstrap?a=1').externalUrl).toBe('https://proxy.test/api/bootstrap?a=1');
  });
  it.each([
    [[], 'proxy_context_missing'],
    [['X-Forwarded-Host', 'proxy.test'], 'invalid_proxy_headers'],
    [[...forwarded, 'X-Forwarded-Host', 'proxy.test'], 'invalid_proxy_headers'],
    [['X-Forwarded-Host', 'proxy.test,relay.test', 'X-Forwarded-Proto', 'https'], 'invalid_proxy_headers'],
    [['X-Forwarded-Host', 'evil.test', 'X-Forwarded-Proto', 'https'], 'unconfigured_origin']
  ])('rejects ambiguous or unauthorized proxy metadata %j', (headers, code) => {
    expect(() => resolve(headers)).toThrow(expect.objectContaining({ code }));
  });
  it('rejects conflicts and never fills selected headers from another family', () => {
    expect(() => resolve(forwarded, '192.0.2.2', 'relay.test')).toThrow(expect.objectContaining({ code: 'invalid_proxy_headers' }));
    expect(() => resolve(['Forwarded', 'host=proxy.test;proto=https'])).toThrow(expect.objectContaining({ code: 'proxy_context_missing' }));
  });
  it.each(['//evil.test/x', 'http://evil.test/api/bootstrap', '/\\evil.test', '/a\n'])('rejects request target %j', path => {
    expect(() => resolve(forwarded, '192.0.2.2', 'lan.test:5173', path)).toThrow(expect.objectContaining({ code: 'invalid_request' }));
  });
  it('rejects duplicate Host before header merging', () => {
    expect(() => resolve(['Host', 'lan.test:5173'])).toThrow(expect.objectContaining({ code: 'invalid_request' }));
  });
  it('parses one RFC Forwarded element including quoted IPv6, case and escapes', () => {
    const env = { ...config, UGLINK_PROXY_HEADER_MODE: 'forwarded-single', UGLINK_ALLOWED_ORIGINS: 'https://[2001:db8::2]:8443' };
    env.UGLINK_HOST_ORIGIN_MAP = '{}';
    expect(resolve(['Forwarded', 'for=unknown;host="[2001:db8::2]:8443";proto=https'], '192.0.2.2', 'internal', '/', env).externalOrigin).toBe('https://[2001:db8::2]:8443');
  });
  it.each(['host=proxy.test;proto=https,host=relay.test;proto=https', 'host=proxy.test;host=proxy.test;proto=https', 'host="proxy.test;proto=https', 'host=proxy.test;proto=https;', 'host=proxy.test'])('rejects malformed Forwarded %j', value => {
    expect(() => resolve(['Forwarded', value], '192.0.2.2', 'internal', '/', { ...config, UGLINK_PROXY_HEADER_MODE: 'forwarded-single' })).toThrow(expect.objectContaining({ code: 'invalid_proxy_headers' }));
  });
  it.each(['null', 'https://x/', 'https://x/a', 'https://u:p@x', 'https://*.test', 'https://x?y', 'https://x#x', 'https://x:99999', 'https://x\\y', 'https://x\n'])('rejects non-origin %j', value => expect(() => normalizeOrigin(value)).toThrow());
  it('normalizes casing, default ports and IPv6', () => {
    expect(normalizeOrigin('HTTPS://EXAMPLE.COM:443')).toBe('https://example.com');
    expect(normalizeOrigin('http://[0:0:0:0:0:0:0:1]:80')).toBe('http://[::1]');
  });
  it.each([
    { UGLINK_ALLOWED_ORIGINS: '*' },
    { UGLINK_PROXY_HEADER_MODE: 'auto' },
    { UGLINK_TRUSTED_PROXY_CIDRS: '192.0.2.1' },
    { ...config, UGLINK_TRUSTED_PROXY_CIDRS: '192.0.2.1/99' },
    { ...config, UGLINK_TRUSTED_PROXY_CIDRS: '192.0.2.1/' },
    { ...config, UGLINK_PUBLIC_ORIGIN: 'https://proxy.test' },
    { ...config, UGLINK_ALLOWED_ORIGINS: '' },
    { ...config, UGLINK_HOST_ORIGIN_MAP: '{"internal":"https://relay.test"}' },
    { ...config, UGLINK_HOST_ORIGIN_MAP: '{"relay.test":"https://evil.test"}' },
    { ...config, UGLINK_HOST_ORIGIN_MAP: '[]' },
    { UGLINK_ALLOWED_ORIGINS: 'http://relay.test,https://relay.test', UGLINK_HOST_ORIGIN_MAP: '{"relay.test":"https://relay.test","relay.test":"http://relay.test"}' },
    { ...config, UGLINK_HOST_ORIGIN_MAP: '{"relay.test":null,"relay.test":"https://relay.test"}' }
  ])('fails startup for invalid configuration %j', env => expect(() => parseServerConfig(env)).toThrow());
});
