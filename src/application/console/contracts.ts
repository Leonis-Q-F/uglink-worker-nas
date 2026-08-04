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
