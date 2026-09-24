import { chmod, mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { randomBytes } from 'node:crypto';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { existsSync } from 'node:fs';
import { SqliteConsoleStore } from '../../../infrastructure/persistence/sqlite-console-store';
import { createConsoleServer } from './node-server';

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
  const port = Number(process.env.PORT || 8787);
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error('PORT 必须是 1–65535 之间的整数。');
  const directory = resolve(process.env.UGLINK_DATA_DIR || '/data');
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
      CONSOLE_TITLE: process.env.CONSOLE_TITLE || 'UGLINK Control'
    }, fileURLToPath(new URL('../client', import.meta.url)), process.env.UGLINK_PUBLIC_ORIGIN);
    const cleanup = setInterval(() => {
      try { store.pruneExpired(); } catch { console.error('[存储] 清理过期记录失败。'); }
    }, 60 * 60 * 1000);
    cleanup.unref();
    let stopping = false;
    const stop = () => {
      if (stopping) return;
      stopping = true;
      clearInterval(cleanup);
      const deadline = setTimeout(() => server.closeAllConnections(), 15_000);
      deadline.unref();
      server.close(() => {
        clearTimeout(deadline);
        store.close();
      });
    };
    process.once('SIGTERM', stop);
    process.once('SIGINT', stop);
    server.once('error', (error) => {
      clearInterval(cleanup);
      store.close();
      console.error(`[启动] ${error.message}`);
      process.exitCode = 1;
    });
    server.listen(port, '0.0.0.0', () => console.log(`[启动] 控制台已就绪，端口 ${port}，存储 SQLite。`));
  } catch (error) {
    store.close();
    throw error;
  }
}

main().catch((error: unknown) => {
  console.error(`[启动] ${error instanceof Error ? error.message : String(error)}`);
  process.exitCode = 1;
});
