import type { ConsoleStore } from '../../application/console/ports';
import type { DeploymentJobRepository } from '../../application/console/ports';
import type { DeploymentJob } from '../../domain/deployment/model';
import { redactDeployment } from '../../domain/logging/redact-records';

const JOB_TTL_SECONDS = 60 * 60 * 24 * 30;

export function createKvDeploymentJobRepository(
  namespace: ConsoleStore,
  sessionId: string,
  secrets: readonly string[] = []
): DeploymentJobRepository {
  const key = (id: string) => `deployment:${sessionId}:${id}`;
  return {
    async save(job: DeploymentJob): Promise<void> {
      await namespace.put(key(job.id), JSON.stringify(redactDeployment(job, secrets)), {
        expirationTtl: JOB_TTL_SECONDS
      });
    },
    async read(id: string): Promise<DeploymentJob | undefined> {
      return await namespace.get<DeploymentJob>(key(id), 'json') ?? undefined;
    }
  };
}
