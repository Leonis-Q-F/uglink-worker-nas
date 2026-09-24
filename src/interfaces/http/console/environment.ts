import type { ConsoleStore } from '../../../application/console/ports';
export interface ConsoleWorkerEnv {
  CONSOLE_SESSIONS: ConsoleStore;
  SESSION_ENCRYPTION_KEY: string;
  CONSOLE_TITLE?: string;
}
