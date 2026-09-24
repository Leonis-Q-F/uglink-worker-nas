import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { afterEach, describe, expect, it } from 'vitest';
import { SqliteConsoleStore } from '../../src/infrastructure/persistence/sqlite-console-store';

const directories: string[] = [];
const stores: SqliteConsoleStore[] = [];
function fixture() {
  const dir = mkdtempSync(join(tmpdir(), 'uglink-sqlite-test-'));
  directories.push(dir);
  return dir;
}
function open(dir: string, now = () => Date.now()) {
  const store = new SqliteConsoleStore(join(dir, 'console.sqlite'), now);
  stores.push(store);
  return store;
}
function legacy(dir: string) {
  const root = join(dir, 'wrangler', 'v3', 'kv');
  const sql = join(root, 'miniflare-KVNamespaceObject');
  const blobs = join(root, '00000000000000000000000000000000', 'blobs');
  mkdirSync(sql, { recursive: true });
  mkdirSync(blobs, { recursive: true });
  const path = join(sql, 'test.sqlite');
  const db = new DatabaseSync(path);
  db.exec('CREATE TABLE _mf_entries (key TEXT PRIMARY KEY, blob_id TEXT NOT NULL, expiration INTEGER, metadata TEXT)');
  db.prepare('INSERT INTO _mf_entries VALUES (?, ?, ?, NULL)').run('session:example', 'aabb', null);
  db.prepare('INSERT INTO _mf_entries VALUES (?, ?, ?, NULL)').run('deployment:expired', 'ccdd', 1);
  db.close();
  writeFileSync(join(blobs, 'aabb'), 'encrypted-value');
  return { path, blobs };
}
afterEach(() => {
  for (const store of stores.splice(0)) store.close();
  for (const dir of directories.splice(0)) rmSync(dir, { recursive: true, force: true });
});

describe('SQLite console storage', () => {
  it('persists text, JSON, replacements and deletion across restarts', async () => {
    const dir = fixture();
    const first = open(dir);
    await first.put('config', '{"version":1}');
    first.close();
    const next = open(dir);
    expect(await next.get('config', 'json')).toEqual({ version: 1 });
    await next.put('config', 'updated');
    expect(await next.get('config')).toBe('updated');
    await next.delete('config');
    expect(await next.get('config')).toBeNull();
  });

  it('expires sessions and jobs without expiring permanent configuration', async () => {
    let now = 100_000;
    const store = open(fixture(), () => now);
    await store.put('session', 'value', { expirationTtl: 60 });
    await store.put('configuration', '{}');
    now += 60_000;
    expect(await store.get('session')).toBeNull();
    expect(await store.get('configuration')).toBe('{}');
    expect(store.pruneExpired()).toBe(1);
  });

  it('imports the legacy layout once, skips expired blobs, and preserves the source', async () => {
    const dir = fixture();
    const source = legacy(dir);
    const before = readFileSync(source.path);
    const store = open(dir);
    expect(store.migrateLegacy(join(dir, 'wrangler'))).toBe(1);
    expect(await store.get('session:example')).toBe('encrypted-value');
    expect(await store.get('deployment:expired')).toBeNull();
    await store.put('session:example', 'new-value');
    expect(store.migrateLegacy(join(dir, 'wrangler'))).toBe(0);
    expect(await store.get('session:example')).toBe('new-value');
    expect(readFileSync(source.path)).toEqual(before);
  });

  it('rolls back incomplete migration and retries after a missing blob is restored', async () => {
    const dir = fixture();
    const source = legacy(dir);
    const db = new DatabaseSync(source.path);
    db.prepare('INSERT INTO _mf_entries VALUES (?, ?, ?, NULL)').run('configuration:v2:test', 'eeff', null);
    db.close();
    const store = open(dir);
    expect(() => store.migrateLegacy(join(dir, 'wrangler'))).toThrow();
    expect(await store.get('session:example')).toBeNull();
    writeFileSync(join(source.blobs, 'eeff'), '{}');
    expect(store.migrateLegacy(join(dir, 'wrangler'))).toBe(2);
  });

  it('rejects unknown legacy data instead of silently starting an empty store', () => {
    const dir = fixture();
    mkdirSync(join(dir, 'wrangler', 'v2'), { recursive: true });
    expect(() => open(dir).migrateLegacy(join(dir, 'wrangler'))).toThrow('布局无法识别');
  });
});
