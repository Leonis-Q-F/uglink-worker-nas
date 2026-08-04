import type { ResolvedUglinkConfig, UglinkConfig, UglinkService } from '../../domain/configuration/model';

export interface WorkerRuntimeBindings {
  BASE_URL: string;
  USERNAME: string;
  SERVICE_MAP: string;
  SETUP_MODE: 'true' | 'false';
  SESSION_NAMESPACE: string;
}

export function activeServices(config: UglinkConfig): UglinkService[] {
  return config.services.filter((service) => service.enabled !== false);
}

export async function createSessionNamespace(config: UglinkConfig): Promise<string> {
  if (!config.uglink.baseUrl || !config.uglink.username) return 'setup';
  const source = `${new URL(config.uglink.baseUrl).origin}\0${config.uglink.username}`;
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(source));
  return Array.from(new Uint8Array(digest))
    .map((byte) => byte.toString(16).padStart(2, '0'))
    .join('')
    .slice(0, 16);
}

export async function createWorkerRuntimeBindings(config: UglinkConfig): Promise<WorkerRuntimeBindings> {
  const services = activeServices(config);
  const serviceMap = Object.fromEntries(
    services.map((service) => [service.hostname.toLowerCase(), String(service.port)])
  );
  return {
    BASE_URL: config.uglink.baseUrl,
    USERNAME: config.uglink.username,
    SERVICE_MAP: JSON.stringify(serviceMap),
    SETUP_MODE: services.length === 0 ? 'true' : 'false',
    SESSION_NAMESPACE: await createSessionNamespace(config)
  };
}

export async function generateWranglerConfig(
  baseConfig: Record<string, unknown>,
  config: ResolvedUglinkConfig
): Promise<Record<string, unknown>> {
  const services = activeServices(config);
  const generated: Record<string, unknown> = {
    ...baseConfig,
    workers_dev: config.deployment.workersDev,
    preview_urls: config.deployment.previewUrls,
    vars: {
      ...(typeof baseConfig.vars === 'object' && baseConfig.vars !== null ? baseConfig.vars : {}),
      ...await createWorkerRuntimeBindings(config)
    }
  };

  if (services.length > 0) {
    generated.routes = services.map((service) => ({
      pattern: service.hostname,
      custom_domain: true
    }));
  } else {
    delete generated.routes;
  }
  return generated;
}
