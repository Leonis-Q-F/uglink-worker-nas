import { describe, expect, it } from 'vitest';
import { defaultConfig } from '../../src/domain/configuration/defaults';
import type { UglinkConfig } from '../../src/domain/configuration/model';
import { serializeConfig, validateUglinkConfig } from '../../src/domain/configuration/validation';

function configuredConfig(): UglinkConfig {
  const config = defaultConfig();
  config.uglink = {
    baseUrl: 'https://device.example.test',
    username: 'test-user'
  };
  config.services = [{
    name: 'app',
    hostname: 'app.example.com',
    port: 8080,
    enabled: true
  }];
  return config;
}

describe('validateUglinkConfig', () => {
  it('accepts a complete service configuration', () => {
    const result = validateUglinkConfig(configuredConfig());
    expect(result.valid).toBe(true);
    expect(result.checks.every((check) => check.level !== 'error')).toBe(true);
  });

  it('rejects duplicate hostnames case-insensitively', () => {
    const config = configuredConfig();
    config.services.push({
      name: 'second',
      hostname: config.services[0]!.hostname.toUpperCase(),
      port: 9000,
      enabled: true
    });
    const result = validateUglinkConfig(config);
    expect(result.valid).toBe(false);
    expect(result.checks.find((check) => check.id === 'unique-services')?.level).toBe('error');
  });

  it('rejects non-HTTPS upstream URLs and credentials in URLs', () => {
    const config = configuredConfig();
    config.uglink.baseUrl = 'http://user:password@example.test/?token=unsafe';
    const result = validateUglinkConfig(config);
    expect(result.valid).toBe(false);
    expect(result.checks.find((check) => check.id === 'upstream')?.level).toBe('error');
  });

  it('serializes with stable indentation and a trailing newline', () => {
    const serialized = serializeConfig(defaultConfig());
    expect(serialized.endsWith('\n')).toBe(true);
    expect(JSON.parse(serialized)).toEqual(defaultConfig());
  });
});
