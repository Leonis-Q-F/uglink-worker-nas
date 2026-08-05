export interface GatewayWorkerEnv {
  UGLINK_ID: string;
  USERNAME: string;
  PASSWORD: string;
  SERVICE_MAP: string;
  SETUP_MODE: string;
  SESSION_NAMESPACE: string;
  UGLINK_CACHE: KVNamespace;
}
