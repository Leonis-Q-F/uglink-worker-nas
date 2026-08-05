import { ApplicationError } from '../common/application-error';
import type {
  CloudflareConnection,
  EncryptedControlBackup,
  PersistedConfigurationState
} from './contracts';
import type {
  BackupCipher,
  CloudflareCredentialProvider,
  PortableBackupPayload
} from './ports';
import type { DiagnosticEntry, WorkerTarget } from '../../domain/deployment/model';
import { normalizeDraftConfiguration } from './configuration-service';

const WORKER_NAME = /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/u;
const ACCOUNT_ID = /^[a-f0-9]{32}$/u;

export interface BackupExportSource {
  connection: CloudflareConnection;
  target: WorkerTarget;
  configuration: PersistedConfigurationState;
  diagnostics: DiagnosticEntry[];
}

export type BackupRestoreResult = BackupExportSource;

function requirePassphrase(value: unknown): string {
  if (typeof value !== 'string' || value.length < 12 || value.length > 256) {
    throw new ApplicationError(
      400,
      'invalid_backup_passphrase',
      '备份密码必须为 12–256 个字符。'
    );
  }
  return value;
}

function validPayload(value: PortableBackupPayload): boolean {
  return value?.version === 1
    && typeof value.createdAt === 'string'
    && typeof value.connection?.apiToken === 'string'
    && value.connection.apiToken.length >= 20
    && ACCOUNT_ID.test(value.target?.accountId || '')
    && WORKER_NAME.test(value.target?.workerName || '')
    && value.connection.account?.id === value.target.accountId
    && Array.isArray(value.diagnostics)
    && value.configuration?.version === 1;
}

function normalizedConfiguration(value: PersistedConfigurationState): PersistedConfigurationState {
  return {
    version: 1,
    deployed: normalizeDraftConfiguration(value.deployed),
    ...(value.draft === undefined ? {} : { draft: normalizeDraftConfiguration(value.draft) }),
    updatedAt: new Date().toISOString()
  };
}

export function createBackupService(
  cipher: BackupCipher,
  connections: CloudflareCredentialProvider
) {
  async function exportBackup(
    source: BackupExportSource,
    passphraseValue: unknown
  ): Promise<EncryptedControlBackup> {
    const passphrase = requirePassphrase(passphraseValue);
    const payload: PortableBackupPayload = {
      version: 1,
      createdAt: new Date().toISOString(),
      connection: source.connection,
      target: source.target,
      configuration: source.configuration,
      diagnostics: source.diagnostics.slice(0, 100)
    };
    return cipher.seal(payload, passphrase);
  }

  async function restoreBackup(
    backup: EncryptedControlBackup,
    passphraseValue: unknown
  ): Promise<BackupRestoreResult> {
    const passphrase = requirePassphrase(passphraseValue);
    let payload: PortableBackupPayload;
    try {
      payload = await cipher.open(backup, passphrase);
    } catch {
      throw new ApplicationError(
        400,
        'backup_decryption_failed',
        '无法解密备份，请检查备份文件和备份密码。'
      );
    }
    if (!validPayload(payload)) {
      throw new ApplicationError(400, 'invalid_backup', '备份内容无效或版本不受支持。');
    }
    const connection = await connections.connect(payload.target.accountId, payload.connection.apiToken);
    return {
      connection,
      target: {
        accountId: connection.account.id,
        accountName: connection.account.name,
        workerName: payload.target.workerName
      },
      configuration: normalizedConfiguration(payload.configuration),
      diagnostics: payload.diagnostics
    };
  }

  return { exportBackup, restoreBackup };
}
