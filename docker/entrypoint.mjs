import { randomBytes } from 'node:crypto';
import { spawn } from 'node:child_process';
import { chmod, mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const SESSION_KEY_PATTERN = /^[A-Za-z0-9_-]{43}$/u;
const SESSION_ASSIGNMENT = /^\s*SESSION_ENCRYPTION_KEY\s*=\s*([^\r\n]*)\s*$/mu;

function cleanValue(value) {
  const trimmed = value.trim();
  if (trimmed.length >= 2) {
    const first = trimmed[0];
    const last = trimmed.at(-1);
    if ((first === '"' && last === '"') || (first === "'" && last === "'")) {
      return trimmed.slice(1, -1);
    }
  }
  return trimmed;
}

function requireSessionKey(value, source) {
  const key = cleanValue(value || '');
  if (!SESSION_KEY_PATTERN.test(key)) {
    throw new Error(`${source} 中的会话加密密钥无效。`);
  }
  return key;
}

async function existingPersistentKey(filePath) {
  try {
    const contents = await readFile(filePath, 'utf8');
    const assignment = contents.match(SESSION_ASSIGNMENT)?.[1];
    return requireSessionKey(assignment || '', '持久化配置');
  } catch (error) {
    if (error && typeof error === 'object' && error.code === 'ENOENT') return undefined;
    throw error;
  }
}

async function writeSecretFile(filePath, key) {
  await mkdir(dirname(filePath), { recursive: true, mode: 0o700 });
  const temporaryPath = `${filePath}.${process.pid}.tmp`;
  await writeFile(temporaryPath, `SESSION_ENCRYPTION_KEY=${key}\n`, {
    encoding: 'utf8',
    mode: 0o600
  });
  await rename(temporaryPath, filePath);
  await chmod(filePath, 0o600);
}

async function prepareSecretFile(dataDirectory) {
  const injected = process.env.SESSION_ENCRYPTION_KEY;
  if (injected) {
    const key = requireSessionKey(injected, 'SESSION_ENCRYPTION_KEY');
    const runtimeFile = join('/tmp', `uglink-runtime-${process.pid}.env`);
    await writeSecretFile(runtimeFile, key);
    console.log('[启动] 已加载外部会话加密密钥。');
    return runtimeFile;
  }

  const persistentFile = join(dataDirectory, '.dev.vars');
  const current = await existingPersistentKey(persistentFile);
  if (current) {
    console.log('[启动] 已加载持久化会话加密密钥。');
    return persistentFile;
  }

  await writeSecretFile(persistentFile, randomBytes(32).toString('base64url'));
  console.log('[启动] 已创建持久化会话加密密钥。');
  return persistentFile;
}

async function prepareRuntimeConfig(runtimeDirectory) {
  const sourcePath = fileURLToPath(new URL('./wrangler.json', import.meta.url));
  const projectDirectory = resolve(fileURLToPath(new URL('..', import.meta.url)));
  const source = JSON.parse(await readFile(sourcePath, 'utf8'));
  const config = {
    ...source,
    $schema: join(projectDirectory, 'node_modules', 'wrangler', 'config-schema.json'),
    main: join(projectDirectory, 'dist', 'uglink_console', 'index.mjs'),
    assets: {
      ...source.assets,
      directory: join(projectDirectory, 'dist', 'client')
    }
  };
  const configPath = join(runtimeDirectory, 'wrangler.json');
  await writeFile(configPath, `${JSON.stringify(config, null, 2)}\n`, {
    encoding: 'utf8',
    mode: 0o600
  });
  return configPath;
}

function listenPort() {
  const value = Number(process.env.PORT || 8787);
  if (!Number.isInteger(value) || value < 1 || value > 65535) {
    throw new Error('PORT 必须是 1–65535 之间的整数。');
  }
  return String(value);
}

async function main() {
  process.umask(0o077);
  const dataDirectory = resolve(process.env.UGLINK_DATA_DIR || '/data');
  await mkdir(dataDirectory, { recursive: true, mode: 0o700 });
  const secretFile = await prepareSecretFile(dataDirectory);
  const runtimeDirectory = join('/tmp', `uglink-runtime-${process.pid}`);
  await mkdir(runtimeDirectory, { recursive: true, mode: 0o700 });
  const configPath = await prepareRuntimeConfig(runtimeDirectory);
  const wranglerCli = fileURLToPath(new URL('../node_modules/wrangler/bin/wrangler.js', import.meta.url));
  const persistencePath = join(dataDirectory, 'wrangler');
  const childEnvironment = {
    ...process.env,
    HOME: join(runtimeDirectory, 'home'),
    XDG_CONFIG_HOME: join(runtimeDirectory, 'config'),
    CLOUDFLARE_CF_FETCH_ENABLED: 'false',
    NO_COLOR: process.env.NO_COLOR || '1'
  };
  delete childEnvironment.SESSION_ENCRYPTION_KEY;

  const child = spawn(process.execPath, [
    wranglerCli,
    'dev',
    '--local',
    '--config',
    configPath,
    '--ip',
    '0.0.0.0',
    '--port',
    listenPort(),
    '--persist-to',
    persistencePath,
    '--env-file',
    secretFile,
    '--log-level',
    process.env.UGLINK_LOG_LEVEL || 'info'
  ], {
    cwd: runtimeDirectory,
    env: childEnvironment,
    stdio: 'inherit'
  });

  for (const signal of ['SIGINT', 'SIGTERM']) {
    process.on(signal, () => child.kill(signal));
  }

  child.once('error', (error) => {
    console.error(`[启动] 无法启动本地 Worker 运行时：${error.message}`);
    process.exitCode = 1;
  });
  child.once('exit', async (code, signal) => {
    await rm(runtimeDirectory, { recursive: true, force: true }).catch(() => undefined);
    process.exitCode = typeof code === 'number' ? code : signal ? 1 : 0;
  });
}

main().catch((error) => {
  console.error(`[启动] ${error instanceof Error ? error.message : String(error)}`);
  process.exitCode = 1;
});
