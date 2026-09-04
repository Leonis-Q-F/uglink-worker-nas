import type { UglinkConfig, UglinkService } from './model';

export interface ServiceSynchronizationOptions {
  forceAll?: boolean;
}

export function serviceConfigurationsEqual(
  left: UglinkService | undefined,
  right: UglinkService | undefined
): boolean {
  return Boolean(left && right
    && left.name === right.name
    && left.hostname === right.hostname
    && left.port === right.port
    && (left.enabled !== false) === (right.enabled !== false));
}

function connectionConfigurationChanged(previous: UglinkConfig, next: UglinkConfig): boolean {
  return previous.uglink.id !== next.uglink.id
    || previous.uglink.username !== next.uglink.username;
}

export function servicesRequiringSynchronization(
  previous: UglinkConfig,
  next: UglinkConfig,
  options: ServiceSynchronizationOptions = {}
): UglinkService[] {
  const activeServices = next.services.filter((service) => service.enabled !== false);
  if (options.forceAll || connectionConfigurationChanged(previous, next)) return activeServices;

  return activeServices.filter((service) => (
    !previous.services.some((candidate) => serviceConfigurationsEqual(service, candidate))
  ));
}
