import type { ConsoleStore, ContainerLogSource } from '../../../application/console/ports';
export interface ConsoleWorkerEnv {
  CONSOLE_SESSIONS: ConsoleStore;
  SESSION_ENCRYPTION_KEY: string;
  CONSOLE_TITLE?: string;
  /** Provided by the Node bootstrap only; unavailable in workerd. */
  CONTAINER_LOGS?: ContainerLogSource;
}
