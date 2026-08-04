import assert from 'node:assert/strict';
import test from 'node:test';
import { parseServiceMap } from '../../src/domain/proxy/routing';

test('parseServiceMap normalizes hostnames and ports', () => {
  const services = parseServiceMap('{"API.Example.COM.":8317}');
  assert.equal(services.get('api.example.com'), '8317');
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
