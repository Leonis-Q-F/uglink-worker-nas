import type { UglinkConfig } from '../../domain/configuration/model';
import type {
  DeploymentJob,
  DiagnosticEntry,
  ServiceHealth,
  WorkerTarget
} from '../../domain/deployment/model';
import type { CloudflareConnection } from './contracts';
import type {
  EncryptedControlBackup,
  PersistedConfigurationState
} from './contracts';

export interface KvNamespaceReference {
  id: string;
  title: string;
}

export interface WorkerUploadResult {
  deploymentId?: string;
}

export interface CloudflareDeploymentStatus {
  id: string;
  createdAt: string;
  source: string;
  message?: string;
}

export interface CloudflareConnectionProvider {
  connect(accountId: string, apiToken: string): Promise<CloudflareConnection>;
}

export interface CloudflareDeploymentProvider {
  assertWorkerOwnership(target: WorkerTarget): Promise<void>;
  hasWorkerPassword(target: WorkerTarget): Promise<boolean>;
  ensureKvNamespace(target: WorkerTarget): Promise<KvNamespaceReference>;
  uploadWorker(
    target: WorkerTarget,
    config: UglinkConfig,
    namespace: KvNamespaceReference
  ): Promise<WorkerUploadResult>;
  updatePassword(target: WorkerTarget, password: string): Promise<void>;
  reconcileDomains(target: WorkerTarget, hostnames: string[]): Promise<void>;
  updateSubdomain(target: WorkerTarget, workersDev: boolean, previewUrls: boolean): Promise<void>;
  latestDeployment(target: WorkerTarget): Promise<CloudflareDeploymentStatus | undefined>;
  dashboardUrl(target: WorkerTarget): string;
}

export interface DeploymentJobRepository {
  save(job: DeploymentJob): Promise<void>;
  read(id: string): Promise<DeploymentJob | undefined>;
}

export interface DiagnosticLogRepository {
  append(entries: DiagnosticEntry[]): Promise<void>;
  list(limit?: number): Promise<DiagnosticEntry[]>;
  replace(entries: DiagnosticEntry[]): Promise<void>;
}

export interface ConfigurationRepository {
  read(): Promise<PersistedConfigurationState | undefined>;
  write(state: PersistedConfigurationState): Promise<void>;
}

export interface PortableBackupPayload {
  version: 1;
  createdAt: string;
  connection: CloudflareConnection;
  target: WorkerTarget;
  configuration: PersistedConfigurationState;
  diagnostics: DiagnosticEntry[];
}

export interface BackupCipher {
  seal(payload: PortableBackupPayload, passphrase: string): Promise<EncryptedControlBackup>;
  open(backup: EncryptedControlBackup, passphrase: string): Promise<PortableBackupPayload>;
}

export interface ServiceHealthChecker {
  check(services: ServiceHealth[], monitoringExisting?: boolean): Promise<void>;
}

export interface TokenGenerator {
  create(size?: number): string;
}
