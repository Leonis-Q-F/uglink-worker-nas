import assert from 'node:assert/strict';
import test from 'node:test';
import { servicesRequiringSynchronization } from '../../src/domain/configuration/change-set';
import type { UglinkConfig } from '../../src/domain/configuration/model';

function config(): UglinkConfig {
  return {
    version: 2,
    uglink: { id: 'device', username: 'user' },
    services: [
      { name: 'notes', hostname: 'notes.example.com', port: 6806, enabled: true },
      { name: 'photos', hostname: 'photos.example.com', port: 3000, enabled: true }
    ]
  };
}

test('only new or edited active services require synchronization', () => {
  const previous = config();
  const next = config();
  next.services = [
    next.services[1]!,
    { ...next.services[0]!, port: 6807 },
    { name: 'media', hostname: 'media.example.com', port: 8096, enabled: true }
  ];

  assert.deepEqual(
    servicesRequiringSynchronization(previous, next).map((service) => service.hostname),
    ['notes.example.com', 'media.example.com']
  );
});

test('removed or newly disabled services do not recheck unchanged services', () => {
  const previous = config();
  const next = config();
  next.services = [{ ...next.services[1]!, enabled: false }];

  assert.deepEqual(servicesRequiringSynchronization(previous, next), []);
});

test('connection, password, and overwrite changes synchronize every active service', () => {
  const previous = config();
  const connectionChanged = config();
  connectionChanged.uglink.username = 'other-user';

  assert.equal(servicesRequiringSynchronization(previous, connectionChanged).length, 2);
  assert.equal(servicesRequiringSynchronization(previous, config(), { forceAll: true }).length, 2);
});
