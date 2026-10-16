import assert from 'node:assert/strict';
import test from 'node:test';
import { sanitizeLogValue } from '../../src/infrastructure/security/log-redaction';

test('diagnostic values retain native details while recursively removing credentials and personal request metadata', () => {
  const value = sanitizeLogValue({
    event: 'proxy_request_failed',
    password: 'nas-password', access_token: 'private-token',
    request: { url: 'https://user:pass@example.com/proxy?code=private#credential',
      headers: { Authorization: 'Bearer private-token', Cookie: 'session=private', 'CF-Connecting-IP': '192.0.2.10' },
      cf: { clientTcpRtt: 12, clientIP: '2001:db8::1' } },
    response: { status: 502, body: '{"reason":"expired","password":"private","nested":"{\\"token\\":\\"deep\\"}"}' },
    message: 'GET https://user:pass@example.com/a?token=secret#hash failed from 192.0.2.10; apiToken=plaintext; Bearer bearer-secret',
    native: { code: 'authentication_timeout', durationMs: 15000 }
  });
  const serialized = JSON.stringify(value);
  for (const secret of ['nas-password', 'private-token', 'session=private', '192.0.2.10', '2001:db8::1', 'plaintext', 'bearer-secret', 'code=private', '?token=secret', '#hash', 'user:pass', 'deep']) {
    assert.equal(serialized.includes(secret), false, secret);
  }
  assert.match(serialized, /authentication_timeout/u);
  assert.match(serialized, /https:\/\/example.com\/proxy/u);
  assert.match(serialized, /"status":502/u);
  assert.match(serialized, /expired/u);
});

test('diagnostic values redact actual session secrets inside nested strings and Error causes and bound hostile data', () => {
  const error = new Error('socket failed session-secret', { cause: new Error('password=hidden-value') });
  Object.assign(error, { code: 'ECONNRESET' });
  const cyclic: Record<string, unknown> = { error, message: 'session-secret', lots: 'z'.repeat(100_000) };
  cyclic.cycle = cyclic;
  const value = sanitizeLogValue(cyclic, ['session-secret']) as Record<string, unknown>;
  const serialized = JSON.stringify(value);
  assert.equal(serialized.includes('session-secret'), false);
  assert.equal(serialized.includes('hidden-value'), false);
  assert.match(serialized, /ECONNRESET/u);
  assert.match(serialized, /socket failed/u);
  assert.match(serialized, /cause/u);
  assert.ok(serialized.length < 20_000);
  assert.equal(value.cycle, '[Circular]');
});

test('credential-looking assignments and secrets used as object keys cannot escape redaction', () => {
  const result = JSON.stringify(sanitizeLogValue({
    'session-secret': { text: 'uglink_console_session=cookie-value session_id=private-session; [2001:db8::1] failed' }
  }, ['session-secret']));
  for (const secret of ['session-secret', 'cookie-value', 'private-session', '2001:db8::1']) assert.equal(result.includes(secret), false, secret);
});

test('redacts quoted credential fields in prefixed native JSON and object-style output', () => {
  const input = 'failure {"password":"NAS_PRIVATE_VALUE","client_secret":"escaped\\\"PRIVATE_VALUE","status":502} '
    + "context {'cookie': 'COOKIE_PRIVATE_VALUE', apiToken: 'TOKEN_PRIVATE_VALUE'}";
  const result = sanitizeLogValue(input) as string;
  for (const secret of ['NAS_PRIVATE_VALUE', 'PRIVATE_VALUE', 'COOKIE_PRIVATE_VALUE', 'TOKEN_PRIVATE_VALUE']) {
    assert.equal(result.includes(secret), false, secret);
  }
  assert.match(result, /failure/u);
  assert.match(result, /"status":502/u);
});
