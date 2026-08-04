import type { UglinkConfig } from './model';

export function defaultConfig(): UglinkConfig {
  return {
    $schema: './uglink.config.schema.json',
    version: 1,
    uglink: {
      baseUrl: '',
      username: ''
    },
    services: [],
    deployment: {
      workersDev: true,
      previewUrls: false
    }
  };
}
