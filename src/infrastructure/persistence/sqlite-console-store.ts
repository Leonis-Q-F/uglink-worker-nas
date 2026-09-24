import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import type { ConsoleStore } from '../../application/console/ports';

interface StoredEntry { value: string; expiration: number | null }
interface LegacyEntry { key: string; blob_id: string; expiration: number | null }

export class SqliteConsoleStore implements ConsoleStore {
  private readonly db: DatabaseSync;
  private closed = false;

  constructor(path: string, private readonly now: () => number = Date.now) {
    this.db = new DatabaseSync(path);
    this.db.exec(`
      PRAGMA journal_mode = WAL;
      PRAGMA synchronous = FULL;
      PRAGMA busy_timeout = 5000;
      PRAGMA cache_size = -2048;
      CREATE TABLE IF NOT EXISTS entries (
        key TEXT PRIMARY KEY, value TEXT NOT NULL, expiration INTEGER
      );
      CREATE INDEX IF NOT EXISTS entries_expiration ON entries(expiration);
      CREATE TABLE IF NOT EXISTS migrations (name TEXT PRIMARY KEY);
    `);
  }

  async get(key: string): Promise<string | null>;
  async get<T>(key: string, type: 'json'): Promise<T | null>;
  async get<T>(key: string, type?: 'json'): Promise<T | string | null> {
    const row = this.db.prepare('SELECT value, expiration FROM entries WHERE key = ?').get(key) as unknown as StoredEntry | undefined;
    if (!row || (row.expiration !== null && row.expiration <= this.now())) return null;
    return type === 'json' ? JSON.parse(row.value) as T : row.value;
  }

  async put(key: string, value: string, options?: { expirationTtl?: number }): Promise<void> {
    const ttl = options?.expirationTtl;
    if (ttl !== undefined && (!Number.isFinite(ttl) || ttl <= 0)) throw new Error('Invalid storage TTL');
    this.db.prepare('INSERT OR REPLACE INTO entries (key, value, expiration) VALUES (?, ?, ?)')
      .run(key, value, ttl === undefined ? null : this.now() + ttl * 1000);
  }

  async delete(key: string): Promise<void> {
    this.db.prepare('DELETE FROM entries WHERE key = ?').run(key);
  }

  pruneExpired(): number {
    return Number(this.db.prepare('DELETE FROM entries WHERE expiration <= ?').run(this.now()).changes);
  }

  // Only the fixed namespace shipped in the former Docker Wrangler config is supported.
  // Run before serving requests, with the old console stopped. Never modify its files.
  migrateLegacy(persistencePath: string): number {
    const migration = 'wrangler-v3-console';
    if (this.db.prepare('SELECT name FROM migrations WHERE name = ?').get(migration)) return 0;
    const root = join(persistencePath, 'v3', 'kv');
    if (existsSync(persistencePath) && !existsSync(root)) {
      throw new Error('旧控制台数据布局无法识别，请保留数据卷并检查旧版备份。');
    }
    const sqlDirectory = join(root, 'miniflare-KVNamespaceObject');
    const blobs = join(root, '00000000000000000000000000000000', 'blobs');
    let imported = 0;
    let tables = 0;
    this.db.exec('BEGIN IMMEDIATE');
    try {
      if (existsSync(root)) {
        const files = readdirSync(sqlDirectory).filter((name) => name.endsWith('.sqlite'));
        for (const file of files) {
          const source = new DatabaseSync(join(sqlDirectory, file), { readOnly: true });
          try {
            if (!source.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = '_mf_entries'").get()) continue;
            tables += 1;
            for (const record of source.prepare('SELECT key, blob_id, expiration FROM _mf_entries').iterate()) {
              const row = record as unknown as LegacyEntry;
              if (typeof row.key !== 'string' || !/^(session:|configuration:v2:|deployment:|diagnostics:)/u.test(row.key)
                || typeof row.blob_id !== 'string' || !/^[a-f0-9]+$/u.test(row.blob_id)
                || (row.expiration !== null && !Number.isSafeInteger(row.expiration))) {
                throw new Error('旧控制台数据格式无法识别，迁移已停止。');
              }
              // Miniflare stores expiration as milliseconds, not the KV API's seconds.
              if (row.expiration !== null && row.expiration <= this.now()) continue;
              const value = readFileSync(join(blobs, row.blob_id), 'utf8');
              this.db.prepare('INSERT INTO entries (key, value, expiration) VALUES (?, ?, ?)')
                .run(row.key, value, row.expiration);
              imported += 1;
            }
          } finally {
            source.close();
          }
        }
        if (tables !== 1) throw new Error('旧控制台 KV 数据库数量异常，迁移已停止。');
      }
      this.db.prepare('INSERT INTO migrations (name) VALUES (?)').run(migration);
      this.db.exec('COMMIT');
      return imported;
    } catch (error) {
      this.db.exec('ROLLBACK');
      throw error;
    }
  }

  close(): void {
    if (this.closed) return;
    this.db.close();
    this.closed = true;
  }
}
