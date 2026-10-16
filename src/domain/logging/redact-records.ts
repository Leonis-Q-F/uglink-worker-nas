import type { DeploymentJob, DiagnosticEntry, ServiceHealth } from '../deployment/model';
import { sanitizeLogValue } from './sanitize';

function text(value: string, secrets: readonly string[]): string {
  return sanitizeLogValue(value, secrets) as string;
}

function payload<T extends { data?: unknown }>(value: T, secrets: readonly string[]): T {
  return value.data === undefined ? value : { ...value, data: sanitizeLogValue(value.data, secrets) };
}

/** Sanitize each freeform payload independently while preserving the typed record envelope. */
export function redactDiagnostic(entry: DiagnosticEntry, secrets: readonly string[] = []): DiagnosticEntry {
  return payload({ ...entry, summary: text(entry.summary, secrets),
    ...(entry.detail === undefined ? {} : { detail: text(entry.detail, secrets) }) }, secrets);
}

export function redactHealth(service: ServiceHealth, secrets: readonly string[] = []): ServiceHealth {
  return payload({ ...service, detail: text(service.detail, secrets) }, secrets);
}

export function redactDeployment(job: DeploymentJob, secrets: readonly string[] = []): DeploymentJob {
  return { ...job, message: text(job.message, secrets), services: job.services.map((service) => redactHealth(service, secrets)),
    timeline: job.timeline.map((step) => ({ ...step, detail: text(step.detail, secrets) })),
    ...(job.failure ? { failure: payload({ ...job.failure, summary: text(job.failure.summary, secrets),
      ...(job.failure.detail === undefined ? {} : { detail: text(job.failure.detail, secrets) }) }, secrets) } : {}) };
}
