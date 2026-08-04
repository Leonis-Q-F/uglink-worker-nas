import { describe, expect, it, vi } from 'vitest';
import { createBackupService } from '../../src/application/console/backup-service';
import { defaultConfig } from '../../src/domain/configuration/defaults';
import type { PortableBackupPayload } from '../../src/application/console/ports';
import { portableBackupCipher } from '../../src/infrastructure/security/portable-backup';

const ACCOUNT_ID = '0123456789abcdef0123456789abcdef';
const API_TOKEN = 'cloudflare-api-token-used-only-for-testing';
const PASSPHRASE = 'a-strong-backup-passphrase';

function payload(): PortableBackupPayload {
  return {
    version: 1,
    createdAt: '2026-08-04T00:00:00.000Z',
    connection: {
      apiToken: API_TOKEN,
      account: { id: ACCOUNT_ID, name: 'Test Account' },
      connectedAt: 123
    },
    target: {
      accountId: ACCOUNT_ID,
      accountName: 'Test Account',
      workerName: 'uglink-test'
    },
    configuration: {
      version: 1,
      deployed: defaultConfig(),
      updatedAt: '2026-08-04T00:00:00.000Z'
    },
    diagnostics: []
  };
}

describe('portable encrypted backups', () => {
  it('encrypts sensitive connection data and rejects the wrong passphrase', async () => {
    const original = payload();
    const backup = await portableBackupCipher.seal(original, PASSPHRASE);
    expect(JSON.stringify(backup)).not.toContain(API_TOKEN);
    await expect(portableBackupCipher.open(backup, PASSPHRASE)).resolves.toEqual(original);
    await expect(portableBackupCipher.open(backup, 'the-wrong-passphrase')).rejects.toThrow();
  });

  it('verifies the restored Cloudflare token before accepting a backup', async () => {
    const connect = vi.fn(async (accountId: string, apiToken: string) => ({
      apiToken,
      account: { id: accountId, name: 'Restored Account' },
      connectedAt: 456
    }));
    const service = createBackupService(portableBackupCipher, { connect });
    const source = payload();
    const backup = await portableBackupCipher.seal(source, PASSPHRASE);
    const restored = await service.restoreBackup(backup, PASSPHRASE);

    expect(connect).toHaveBeenCalledWith(ACCOUNT_ID, API_TOKEN);
    expect(restored.target).toEqual({
      accountId: ACCOUNT_ID,
      accountName: 'Restored Account',
      workerName: 'uglink-test'
    });
    expect(restored.configuration.deployed).toEqual(source.configuration.deployed);
  });
});
