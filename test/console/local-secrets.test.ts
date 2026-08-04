import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  ensureLocalSessionEncryptionKey,
  isValidSessionEncryptionKey
} from '../../scripts/ensure-local-secrets';

const temporaryDirectories: string[] = [];

async function temporaryDevVars(): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), 'uglink-local-secrets-'));
  temporaryDirectories.push(directory);
  return join(directory, '.dev.vars');
}

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map((directory) => rm(directory, {
    recursive: true,
    force: true
  })));
});

describe('local secret preparation', () => {
  it('creates a valid session key when .dev.vars does not exist', async () => {
    const filePath = await temporaryDevVars();
    const result = await ensureLocalSessionEncryptionKey(filePath);
    const contents = await readFile(filePath, 'utf8');
    const value = contents.trim().split('=')[1] ?? '';

    expect(result.generated).toBe(true);
    expect(isValidSessionEncryptionKey(value)).toBe(true);
  });

  it('keeps an existing valid key unchanged', async () => {
    const filePath = await temporaryDevVars();
    const existingKey = 'A'.repeat(43);
    const original = `OTHER_VALUE=kept\nSESSION_ENCRYPTION_KEY=${existingKey}\n`;
    let generationCount = 0;
    await writeFile(filePath, original, 'utf8');

    const result = await ensureLocalSessionEncryptionKey(filePath, () => {
      generationCount += 1;
      return 'B'.repeat(43);
    });

    expect(result.generated).toBe(false);
    expect(generationCount).toBe(0);
    await expect(readFile(filePath, 'utf8')).resolves.toBe(original);
  });

  it('replaces an empty or placeholder key and preserves other variables', async () => {
    const filePath = await temporaryDevVars();
    const generatedKey = 'C'.repeat(43);
    await writeFile(filePath, 'SESSION_ENCRYPTION_KEY=replace-me\nPASSWORD=unchanged\n', 'utf8');

    const result = await ensureLocalSessionEncryptionKey(filePath, () => generatedKey);
    const contents = await readFile(filePath, 'utf8');

    expect(result.generated).toBe(true);
    expect(contents).toContain(`SESSION_ENCRYPTION_KEY=${generatedKey}`);
    expect(contents).toContain('PASSWORD=unchanged');
  });
});
