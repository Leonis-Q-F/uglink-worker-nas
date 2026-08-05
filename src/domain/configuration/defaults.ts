import type { UglinkConfig } from './model';

export function defaultConfig(): UglinkConfig {
  return {
    $schema: './uglink.config.schema.json',
    version: 2,
    uglink: {
      id: '',
      username: ''
    },
    services: [],
    deployment: {
      workersDev: true,
      previewUrls: false
    }
  };
}
