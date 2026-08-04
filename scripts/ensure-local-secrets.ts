import { randomBytes } from 'node:crypto';
import { readFile, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const SESSION_KEY_NAME = 'SESSION_ENCRYPTION_KEY';
const SESSION_KEY_PATTERN = /^[A-Za-z0-9_-]{43}$/u;
const ASSIGNMENT_PATTERN = /^(\s*(?:export\s+)?SESSION_ENCRYPTION_KEY\s*=\s*)(.*)$/u;

type KeyFactory = () => string;

export interface LocalSecretPreparationResult {
  generated: boolean;
  filePath: string;
}

function unquote(value: string): string {
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

export function isValidSessionEncryptionKey(value: string): boolean {
  return SESSION_KEY_PATTERN.test(unquote(value));
}

function generateSessionEncryptionKey(): string {
  return randomBytes(32).toString('base64url');
}

async function readExistingFile(filePath: string): Promise<string | undefined> {
  try {
    return await readFile(filePath, 'utf8');
  } catch (error) {
    if (error instanceof Error && 'code' in error && error.code === 'ENOENT') {
      return undefined;
    }
    throw error;
  }
}

function updateContents(existing: string | undefined, createKey: KeyFactory): string | undefined {
  if (existing === undefined) {
    return `${SESSION_KEY_NAME}=${createKey()}\n`;
  }

  const newline = existing.includes('\r\n') ? '\r\n' : '\n';
  const lines = existing.split(/\r?\n/u);
  const assignments: Array<{ index: number; match: RegExpMatchArray }> = [];
  for (const [index, line] of lines.entries()) {
    const match = line.match(ASSIGNMENT_PATTERN);
    if (match) assignments.push({ index, match });
  }

  const effectiveValue = assignments.at(-1)?.match[2];
  if (effectiveValue && isValidSessionEncryptionKey(effectiveValue)) {
    return undefined;
  }

  const generatedKey = createKey();
  if (assignments.length > 0) {
    for (const { index, match } of assignments) {
      lines[index] = `${match[1] ?? `${SESSION_KEY_NAME}=`}${generatedKey}`;
    }
    return lines.join(newline);
  }

  const separator = existing.length === 0 || existing.endsWith('\n') ? '' : newline;
  return `${existing}${separator}${SESSION_KEY_NAME}=${generatedKey}${newline}`;
}

export async function ensureLocalSessionEncryptionKey(
  filePath = resolve(process.cwd(), '.dev.vars'),
  createKey: KeyFactory = generateSessionEncryptionKey
): Promise<LocalSecretPreparationResult> {
  const existing = await readExistingFile(filePath);
  const updated = updateContents(existing, createKey);

  if (updated === undefined) {
    return { generated: false, filePath };
  }

  await writeFile(filePath, updated, { encoding: 'utf8', mode: 0o600 });
  return { generated: true, filePath };
}

async function main(): Promise<void> {
  const result = await ensureLocalSessionEncryptionKey();
  const state = result.generated ? '已自动创建' : '已加载';
  console.log(`[本地配置] ${state}会话加密密钥。`);
}

const invokedPath = process.argv[1] ? resolve(process.argv[1]) : '';
if (invokedPath === fileURLToPath(import.meta.url)) {
  main().catch((error: unknown) => {
    console.error(`[本地配置] 无法准备会话加密密钥：${error instanceof Error ? error.message : String(error)}`);
    process.exitCode = 1;
  });
}
