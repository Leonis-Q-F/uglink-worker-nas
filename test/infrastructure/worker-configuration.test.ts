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
    version: 2,
    uglink: {
      id: 'My-NAS',
      username: 'user'
    },
    services: [
      { name: 'api', hostname: 'API.Example.com.', port: 8317 },
      { name: 'disabled', hostname: 'off.example.com', port: 9999, enabled: false }
    ],
    deployment: { workersDev: true, previewUrls: true }
  });

  const generated = await generateWranglerConfig(baseConfig, config);
  const vars = generated.vars as Record<string, string>;
  assert.equal(vars.UGLINK_ID, 'my-nas');
  assert.equal('BASE_URL' in vars, false);
  assert.equal(vars.SERVICE_MAP, '{"api.example.com":"8317"}');
  assert.equal(vars.SETUP_MODE, 'false');
  assert.match(vars.SESSION_NAMESPACE ?? '', /^[a-f0-9]{16}$/u);
  assert.equal(vars.UGLINK_CONTROL_MANAGED, 'v1');
  assert.deepEqual(generated.routes, [
    { pattern: 'api.example.com', custom_domain: true }
  ]);
  assert.equal(generated.workers_dev, false);
  assert.equal(generated.preview_urls, false);
});

test('generator supports a safe first-deploy setup mode', async () => {
  const config = resolveUglinkConfig({
    version: 2,
    uglink: { id: '', username: '' },
    services: []
  });
  const generated = await generateWranglerConfig(baseConfig, config);
  const vars = generated.vars as Record<string, string>;
  assert.equal(generated.workers_dev, false);
  assert.equal(generated.preview_urls, false);
  assert.equal(vars.SETUP_MODE, 'true');
  assert.equal(vars.SERVICE_MAP, '{}');
  assert.equal(vars.UGLINK_CONTROL_MANAGED, 'v1');
  assert.equal('routes' in generated, false);
});

test('validation disables default and preview addresses from persisted v2 configuration', () => {
  const config = resolveUglinkConfig({
    version: 2,
    uglink: { id: 'device', username: 'user' },
    services: [{ name: 'api', hostname: 'api.example.com', port: 8317 }],
    deployment: { workersDev: true, previewUrls: true }
  });

  assert.deepEqual(config.deployment, { workersDev: false, previewUrls: false });
});

test('validation rejects duplicate hostnames', () => {
  assert.throws(() => resolveUglinkConfig({
    version: 2,
    uglink: { id: 'device', username: 'user' },
    services: [
      { name: 'one', hostname: 'api.example.com', port: 8317 },
      { name: 'two', hostname: 'API.EXAMPLE.COM', port: 8318 }
    ]
  }), /服务域名重复/u);
});

test('validation rejects URLs and invalid UGREENlink IDs', () => {
  assert.throws(() => resolveUglinkConfig({
    version: 2,
    uglink: { id: 'https://device.example.test', username: 'user' },
    services: [{ name: 'api', hostname: 'api.example.com', port: 8317 }]
  }), /UGREENlink ID/u);
});
