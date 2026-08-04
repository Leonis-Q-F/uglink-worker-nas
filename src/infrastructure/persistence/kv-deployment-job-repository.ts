import type { DeploymentJobRepository } from '../../application/console/ports';
import type { DeploymentJob } from '../../domain/deployment/model';

const JOB_TTL_SECONDS = 60 * 60 * 24 * 30;

export function createKvDeploymentJobRepository(
  namespace: KVNamespace,
  sessionId: string
): DeploymentJobRepository {
  const key = (id: string) => `deployment:${sessionId}:${id}`;
  return {
    async save(job: DeploymentJob): Promise<void> {
      await namespace.put(key(job.id), JSON.stringify(job), {
        expirationTtl: JOB_TTL_SECONDS
      });
    },
    async read(id: string): Promise<DeploymentJob | undefined> {
      return await namespace.get<DeploymentJob>(key(id), 'json') ?? undefined;
    }
  };
}
