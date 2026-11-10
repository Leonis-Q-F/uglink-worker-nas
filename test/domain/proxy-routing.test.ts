import assert from 'node:assert/strict';
import test from 'node:test';
import { parseServiceMap } from '../../src/domain/proxy/routing';

test('parseServiceMap normalizes hostnames and defaults legacy ports to proxy mode', () => {
  const services = parseServiceMap('{"API.Example.COM.":8317}');
  assert.deepEqual(services.get('api.example.com'), {
    port: '8317',
    accessMode: 'proxy'
  });
});

test('parseServiceMap reads ticket routes from object values', () => {
  const services = parseServiceMap(
    '{"ticket.example.com":{"port":"9000","accessMode":"ticket"}}'
  );
  assert.deepEqual(services.get('ticket.example.com'), {
    port: '9000',
    accessMode: 'ticket'
  });
});

test('parseServiceMap allows setup mode with no services', () => {
  assert.equal(parseServiceMap('{}').size, 0);
});

test('parseServiceMap rejects invalid ports', () => {
  assert.throws(
    () => parseServiceMap('{"api.example.com":"70000"}'),
    /between 1 and 65535/
  );
});

test('parseServiceMap rejects non-object JSON', () => {
  assert.throws(() => parseServiceMap('[]'), /must be a JSON object/);
});

test('parseServiceMap rejects unknown access modes', () => {
  assert.throws(
    () => parseServiceMap('{"api.example.com":{"port":8317,"accessMode":"direct"}}'),
    /accessMode/u
  );
});
