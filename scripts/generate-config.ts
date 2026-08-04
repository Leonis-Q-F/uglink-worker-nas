import { readFile, rename, writeFile } from 'node:fs/promises';
import path from 'node:path';
import process from 'node:process';
import { resolveUglinkConfig } from '../src/domain/configuration/validation';
import { generateWranglerConfig } from '../src/infrastructure/cloudflare/worker-configuration';

const root = process.cwd();
const userConfigPath = path.join(root, 'uglink.config.json');
const baseConfigPath = path.join(root, 'wrangler.gateway.jsonc');
const outputPath = path.join(root, 'wrangler.gateway.generated.json');

async function readJson(filePath: string): Promise<unknown> {
  return JSON.parse(await readFile(filePath, 'utf8')) as unknown;
}

async function main(): Promise<void> {
  const [rawConfig, baseConfig] = await Promise.all([
    readJson(userConfigPath),
    readJson(baseConfigPath)
  ]);
  const config = resolveUglinkConfig(rawConfig);
  const generated = await generateWranglerConfig(baseConfig as Record<string, unknown>, config);
  const activeServices = config.services.filter((service) => service.enabled);

  if (!process.argv.includes('--check')) {
    const temporaryPath = `${outputPath}.tmp`;
    await writeFile(temporaryPath, `${JSON.stringify(generated, null, 2)}\n`, 'utf8');
    await rename(temporaryPath, outputPath);
  }

  process.stdout.write(
    `Configuration valid: ${activeServices.length} active service(s)`
    + `${activeServices.length ? ` (${activeServices.map((service) => service.hostname).join(', ')})` : ''}\n`
  );
}

main().catch((error) => {
  process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
  process.exitCode = 1;
});
