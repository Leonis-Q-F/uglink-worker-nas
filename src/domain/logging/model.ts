export type RuntimeLogLevel = 'debug' | 'info' | 'warning' | 'error';

export interface RuntimeLogEntry {
  id: string;
  timestamp: number;
  level: RuntimeLogLevel;
  source: 'worker' | 'console' | 'container';
  stream?: 'stdout' | 'stderr';
  message: string;
  data?: unknown;
  hostname?: string;
}
