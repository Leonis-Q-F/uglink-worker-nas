import type { ServiceAccessMode } from '../configuration/model';

export interface ServiceRoute {
  port: string;
  accessMode: ServiceAccessMode;
}

function normalizeHostname(hostname: string): string {
  return hostname.trim().toLowerCase().replace(/\.$/u, '');
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function validatePort(value: unknown, hostname: string): string {
  const port = typeof value === 'number' ? String(value) : value;
  if (typeof port !== 'string' || !/^\d+$/u.test(port)) {
    throw new Error(`SERVICE_MAP has an invalid port for ${hostname}`);
  }

  const portNumber = Number(port);
  if (portNumber < 1 || portNumber > 65535) {
    throw new Error(`SERVICE_MAP port for ${hostname} must be between 1 and 65535`);
  }
  return String(portNumber);
}

function validateServiceRoute(value: unknown, hostname: string): ServiceRoute {
  if (!isRecord(value)) {
    return { port: validatePort(value, hostname), accessMode: 'proxy' };
  }

  const accessMode = value.accessMode ?? 'proxy';
  if (accessMode !== 'proxy' && accessMode !== 'ticket') {
    throw new Error(`SERVICE_MAP has an invalid accessMode for ${hostname}`);
  }
  return {
    port: validatePort(value.port, hostname),
    accessMode
  };
}

export function parseServiceMap(rawServiceMap: string): Map<string, ServiceRoute> {
  let parsed: unknown;
  try {
    parsed = JSON.parse(rawServiceMap);
  } catch {
    throw new Error('SERVICE_MAP must be valid JSON');
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    throw new Error('SERVICE_MAP must be a JSON object');
  }

  const services = new Map<string, ServiceRoute>();
  for (const [hostname, value] of Object.entries(parsed)) {
    const normalizedHostname = normalizeHostname(hostname);
    if (!normalizedHostname) throw new Error('SERVICE_MAP contains an empty hostname');
    services.set(normalizedHostname, validateServiceRoute(value, normalizedHostname));
  }
  return services;
}

export function requestHostname(request: Request): string {
  return normalizeHostname(new URL(request.url).hostname);
}
