export interface UglinkService {
  name: string;
  hostname: string;
  port: number;
  enabled?: boolean;
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
}

export interface ResolvedUglinkConfig extends Omit<UglinkConfig, 'services' | 'deployment'> {
  services: ResolvedUglinkService[];
  deployment: {
    workersDev: boolean;
    previewUrls: boolean;
  };
}
