import { describe, expect, it } from 'vitest';
import {
  constantTimeEqual,
  openJson,
  sealJson,
  toBase64Url
} from '../../src/infrastructure/security/session-crypto';

describe('session cryptography', () => {
  it('round-trips an encrypted session and binds it to the session id', async () => {
    const key = toBase64Url(crypto.getRandomValues(new Uint8Array(32)));
    const original = { apiToken: 'never-plaintext-in-kv', connectedAt: 12345 };
    const sealed = await sealJson(original, key, 'session:one');
    expect(sealed).not.toContain(original.apiToken);
    await expect(openJson(sealed, key, 'session:one')).resolves.toEqual(original);
    await expect(openJson(sealed, key, 'session:two')).rejects.toThrow();
  });

  it('compares CSRF tokens without early character exits', () => {
    expect(constantTimeEqual('same-state', 'same-state')).toBe(true);
    expect(constantTimeEqual('same-state', 'same-statz')).toBe(false);
    expect(constantTimeEqual('short', 'longer')).toBe(false);
  });
});
