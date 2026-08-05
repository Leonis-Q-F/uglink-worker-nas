import type { UglinkConfig } from '../../domain/configuration/model';
import type { DeploymentMode, WorkerTarget } from '../../domain/deployment/model';

export type ProviderState = 'connected' | 'disconnected' | 'expired' | 'error';

export interface ProviderStatus {
  state: ProviderState;
  label?: string;
  detail?: string;
}

export interface PublicWorkerTarget extends WorkerTarget {
  accountIdSuffix: string;
}

export interface BootstrapResponse {
  title: string;
  authenticated: boolean;
  csrfToken: string;
  providers: {
    cloudflare: ProviderStatus;
  };
  target?: PublicWorkerTarget;
  configuration?: PersistedConfigurationState;
  cloudConfiguration?: {
    serviceCount: number;
  };
}

export interface DeployRequest {
  config: UglinkConfig;
  password?: string;
  mode?: DeploymentMode;
}

export interface CloudflareConnectionRequest {
  accountId: string;
  apiToken: string;
  workerName: string;
}

export interface CloudflareConnection {
  apiToken: string;
  account: {
    id: string;
    name: string;
  };
  connectedAt: number;
}

export interface PersistedConfigurationState {
  version: 1;
  deployed: UglinkConfig;
  draft?: UglinkConfig;
  updatedAt: string;
}

export interface ConfigurationImportRequest {
  config: UglinkConfig;
}

export interface BackupKdfParameters {
  name: 'PBKDF2';
  hash: 'SHA-256';
  iterations: number;
  salt: string;
}

export interface BackupCipherParameters {
  name: 'AES-GCM';
  iv: string;
  data: string;
}

export interface EncryptedControlBackup {
  format: 'uglink-control-backup';
  version: 1;
  createdAt: string;
  kdf: BackupKdfParameters;
  cipher: BackupCipherParameters;
}

export interface BackupPassphraseRequest {
  passphrase: string;
}

export interface BackupRestoreRequest extends BackupPassphraseRequest {
  backup: EncryptedControlBackup;
}
