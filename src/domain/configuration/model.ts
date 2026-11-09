export type ServiceAccessMode = 'proxy' | 'ticket';

export interface UglinkService {
  name: string;
  hostname: string;
  port: number;
  enabled?: boolean;
  accessMode?: ServiceAccessMode;
}

export interface UglinkConfig {
  $schema?: string;
  version: 2;
  uglink: {
    id: string;
    username: string;
  };
  services: UglinkService[];
  deployment?: {
    workersDev?: boolean;
    previewUrls?: boolean;
  };
}

export interface ResolvedUglinkService extends UglinkService {
  enabled: boolean;
  accessMode: ServiceAccessMode;
}

export interface ResolvedUglinkConfig extends Omit<UglinkConfig, 'services' | 'deployment'> {
  services: ResolvedUglinkService[];
  deployment: {
    workersDev: boolean;
    previewUrls: boolean;
  };
}
