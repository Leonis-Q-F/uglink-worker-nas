import { handleGatewayRequest } from '../../../application/gateway/handle-request';
import { ugreenProxyTransport } from '../../../infrastructure/ugreen/proxy-transport';
import {
  createUgreenSessionService,
  createUgreenTicketService,
  type UgreenSessionRuntime
} from '../../../infrastructure/ugreen/session-service';
import type { GatewayWorkerEnv } from './environment';

const logger = {
  info(event: Record<string, unknown>): void {
    console.log(JSON.stringify(event));
  },
  error(event: Record<string, unknown>): void {
    console.error(JSON.stringify(event));
  }
};

export default {
  fetch(request: Request, env: GatewayWorkerEnv): Promise<Response> {
    const runtime: UgreenSessionRuntime = {
      uglinkId: env.UGLINK_ID,
      username: env.USERNAME,
      password: env.PASSWORD,
      sessionNamespace: env.SESSION_NAMESPACE,
      cache: {
        get: (key) => env.UGLINK_CACHE.get(key),
        put: (key, value, options) => env.UGLINK_CACHE.put(key, value, options),
        delete: (key) => env.UGLINK_CACHE.delete(key)
      }
    };
    const sessions = createUgreenSessionService(runtime);
    const tickets = createUgreenTicketService(runtime);
    return handleGatewayRequest(request, {
      serviceMap: env.SERVICE_MAP,
      setupMode: env.SETUP_MODE === 'true'
    }, {
      sessions,
      tickets,
      transport: ugreenProxyTransport,
      logger
    });
  }
} satisfies ExportedHandler<GatewayWorkerEnv>;
