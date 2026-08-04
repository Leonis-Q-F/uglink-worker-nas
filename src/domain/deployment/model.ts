export interface WorkerTarget {
  accountId: string;
  accountName: string;
  workerName: string;
}

export type DeploymentPhase =
  | 'queued'
  | 'validating'
  | 'provisioning'
  | 'uploading'
  | 'secret_updated'
  | 'routing'
  | 'checking'
  | 'healthy'
  | 'failed';

export type DeploymentMode = 'publish' | 'overwrite';

export type DiagnosticSource = 'health_check' | 'deployment';

export type DiagnosticSeverity = 'error' | 'warning';

export type DiagnosticStage =
  | 'service_entry'
  | 'worker_configuration'
  | 'configuration'
  | 'cloudflare_access'
  | 'session_cache'
  | 'worker_upload'
  | 'credential'
  | 'domain_routing'
  | 'service_check';

export interface ServiceHealth {
  serviceName?: string;
  hostname: string;
  port?: number;
  healthy: boolean;
  detail: string;
  code?: string;
  stage?: DiagnosticStage;
  httpStatus?: number;
}

export interface ServiceHealthResponse {
  checkedAt: string;
  services: ServiceHealth[];
}

export interface DeploymentJob {
  id: string;
  mode: DeploymentMode;
  phase: DeploymentPhase;
  createdAt: string;
  updatedAt: string;
  message: string;
  passwordUpdated: boolean;
  workerName: string;
  accountId: string;
  accountName: string;
  kvNamespaceTitle?: string;
  kvNamespaceIdSuffix?: string;
  cloudflareDeploymentId?: string;
  dashboardUrl?: string;
  services: ServiceHealth[];
  failure?: {
    phase: DeploymentPhase;
    stage: DiagnosticStage;
    code: string;
    summary: string;
    detail?: string;
  };
  timeline: Array<{
    phase: DeploymentPhase;
    label: string;
    detail: string;
    at: string;
  }>;
}

export interface DiagnosticEntry {
  id: string;
  source: DiagnosticSource;
  severity: DiagnosticSeverity;
  stage: DiagnosticStage;
  code: string;
  summary: string;
  detail?: string;
  httpStatus?: number;
  firstObservedAt: string;
  lastObservedAt: string;
  occurrences: number;
  service?: {
    name?: string;
    hostname: string;
    port?: number;
  };
  deployment?: {
    jobId: string;
    phase: DeploymentPhase;
    mode: DeploymentMode;
  };
}

export interface DiagnosticLogResponse {
  entries: DiagnosticEntry[];
}
