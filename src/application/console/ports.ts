import type { UglinkConfig } from '../../domain/configuration/model';
import type {
  DeploymentJob,
  DiagnosticEntry,
  ServiceHealth,
  WorkerTarget
} from '../../domain/deployment/model';
import type { CloudflareConnection } from './contracts';

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
}

export interface ServiceHealthChecker {
  check(services: ServiceHealth[], monitoringExisting?: boolean): Promise<void>;
}

export interface TokenGenerator {
  create(size?: number): string;
}
