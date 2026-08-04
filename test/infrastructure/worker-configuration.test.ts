import assert from 'node:assert/strict';
import test from 'node:test';
import { resolveUglinkConfig } from '../../src/domain/configuration/validation';
import { generateWranglerConfig } from '../../src/infrastructure/cloudflare/worker-configuration';

const baseConfig = {
  name: 'test-worker',
  main: 'src/interfaces/http/gateway/worker.ts',
  vars: {},
  kv_namespaces: [{ binding: 'UGLINK_CACHE' }]
};

test('generator creates SERVICE_MAP and custom domains from one service list', async () => {
  const config = resolveUglinkConfig({
    version: 1,
    uglink: {
      baseUrl: 'https://device.example.ug.link/',
      username: 'user'
    },
    services: [
      { name: 'api', hostname: 'API.Example.com.', port: 8317 },
      { name: 'disabled', hostname: 'off.example.com', port: 9999, enabled: false }
    ],
    deployment: { workersDev: false, previewUrls: false }
  });

  const generated = await generateWranglerConfig(baseConfig, config);
  const vars = generated.vars as Record<string, string>;
  assert.equal(vars.BASE_URL, 'https://device.example.ug.link');
  assert.equal(vars.SERVICE_MAP, '{"api.example.com":"8317"}');
  assert.equal(vars.SETUP_MODE, 'false');
  assert.match(vars.SESSION_NAMESPACE ?? '', /^[a-f0-9]{16}$/u);
  assert.deepEqual(generated.routes, [
    { pattern: 'api.example.com', custom_domain: true }
  ]);
});

test('generator supports a safe first-deploy setup mode', async () => {
  const config = resolveUglinkConfig({
    version: 1,
    uglink: { baseUrl: '', username: '' },
    services: []
  });
  const generated = await generateWranglerConfig(baseConfig, config);
  const vars = generated.vars as Record<string, string>;
  assert.equal(generated.workers_dev, true);
  assert.equal(vars.SETUP_MODE, 'true');
  assert.equal(vars.SERVICE_MAP, '{}');
  assert.equal('routes' in generated, false);
});

test('validation rejects duplicate hostnames', () => {
  assert.throws(() => resolveUglinkConfig({
    version: 1,
    uglink: { baseUrl: 'https://device.example.ug.link', username: 'user' },
    services: [
      { name: 'one', hostname: 'api.example.com', port: 8317 },
      { name: 'two', hostname: 'API.EXAMPLE.COM', port: 8318 }
    ]
  }), /服务域名重复/u);
});

test('validation rejects credentials and paths in BASE_URL', () => {
  assert.throws(() => resolveUglinkConfig({
    version: 1,
    uglink: { baseUrl: 'https://user@example.com/path', username: 'user' },
    services: [{ name: 'api', hostname: 'api.example.com', port: 8317 }]
  }), /HTTPS 源地址/u);
});
