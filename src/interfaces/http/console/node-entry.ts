import { chmod, mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { randomBytes } from 'node:crypto';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { existsSync } from 'node:fs';
import { SqliteConsoleStore } from '../../../infrastructure/persistence/sqlite-console-store';
import { createConsoleServer } from './node-server';
import { parseServerConfig } from './server-config';
import { NodeProcessLogStore, captureProcessOutput } from '../../../infrastructure/logging/node-process-logs';

// Install synchronously before startup and next-tick native runtime warnings.
const dataDirectory = resolve(process.env.UGLINK_DATA_DIR || '/data');
const processLogs = new NodeProcessLogStore(join(dataDirectory, 'logs'));
const outputCapture = captureProcessOutput(processLogs);
process.on('exit', () => outputCapture.dispose());
// Node's default fatal-error writer can bypass stream.write. Observe it without
// installing an uncaughtException handler or changing crash/exit behavior.
process.on('uncaughtExceptionMonitor', (error: Error) => {
  try {
    outputCapture.flush();
    processLogs.append('stderr', error.stack || String(error));
  } catch { /* An observer must never change Node's fatal-error handling. */ }
});

async function sessionKey(directory: string): Promise<string> {
  const injected = process.env.SESSION_ENCRYPTION_KEY;
  const file = join(directory, '.dev.vars');
  let value = injected;
  if (!value) {
    try {
      const text = await readFile(file, 'utf8');
      value = text.match(/^\s*SESSION_ENCRYPTION_KEY\s*=\s*([^\r\n]*)\s*$/mu)?.[1];
      if (!value) throw new Error('持久化会话加密密钥缺失。');
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
      if (existsSync(join(directory, 'console.sqlite')) || existsSync(join(directory, 'wrangler'))) {
        throw new Error('已有控制台数据但缺少会话加密密钥，请恢复原密钥或提供 SESSION_ENCRYPTION_KEY。');
      }
      value = randomBytes(32).toString('base64url');
      const temporary = `${file}.${process.pid}.tmp`;
      await writeFile(temporary, `SESSION_ENCRYPTION_KEY=${value}\n`, { mode: 0o600 });
      await rename(temporary, file);
    }
    await chmod(file, 0o600);
  }
  value = value.trim().replace(/^(["'])(.*)\1$/u, '$2');
  if (!/^[A-Za-z0-9_-]{43}$/u.test(value)) throw new Error('会话加密密钥无效。');
  return value;
}

async function main(): Promise<void> {
  process.umask(0o077);
  const ingress = parseServerConfig(process.env);
  if (ingress.publicOrigin) console.warn('[启动] UGLINK_PUBLIC_ORIGIN 已弃用；多入口请配置 UGLINK_ALLOWED_ORIGINS 和代理策略。');
  const port = Number(process.env.PORT || 8787);
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error('PORT 必须是 1–65535 之间的整数。');
  const directory = dataDirectory;
  await mkdir(directory, { recursive: true, mode: 0o700 });
  const key = await sessionKey(directory);
  const store = new SqliteConsoleStore(join(directory, 'console.sqlite'));
  try {
    const count = store.migrateLegacy(join(directory, 'wrangler'));
    if (count) console.log(`[启动] 已迁移 ${count} 条本地记录，旧数据保留不变。`);
    store.pruneExpired();
    const server = createConsoleServer({
      CONSOLE_SESSIONS: store,
      SESSION_ENCRYPTION_KEY: key,
      CONSOLE_TITLE: process.env.CONSOLE_TITLE || 'UGLINK Control',
      CONTAINER_LOGS: processLogs
    }, fileURLToPath(new URL('../client', import.meta.url)), ingress);
    const cleanup = setInterval(() => {
      try { store.pruneExpired(); } catch { console.error('[存储] 清理过期记录失败。'); }
    }, 60 * 60 * 1000);
    cleanup.unref();
    let stopping = false;
    const stop = (signal: NodeJS.Signals) => {
      if (stopping) return;
      stopping = true;
      console.log(`[关闭] 收到 ${signal}，正在关闭控制台。`);
      processLogs.closeStreams();
      clearInterval(cleanup);
      const deadline = setTimeout(() => {
        console.warn('[关闭] 等待连接结束超时，正在关闭剩余连接。');
        server.closeAllConnections();
      }, 15_000);
      deadline.unref();
      server.close(() => {
        clearTimeout(deadline);
        store.close();
        console.log('[关闭] HTTP 服务和 SQLite 存储已关闭。');
        outputCapture.flush();
      });
    };
    process.once('SIGTERM', () => stop('SIGTERM'));
    process.once('SIGINT', () => stop('SIGINT'));
    server.once('error', (error) => {
      clearInterval(cleanup);
      store.close();
      console.error('[启动]', error);
      process.exitCode = 1;
    });
    server.listen(port, '0.0.0.0', () => console.log(`[启动] 控制台已就绪，端口 ${port}，存储 SQLite。`));
  } catch (error) {
    store.close();
    throw error;
  }
}

main().catch((error: unknown) => {
  console.error('[启动]', error);
  process.exitCode = 1;
});
