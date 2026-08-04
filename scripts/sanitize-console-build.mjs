import { readdir, readFile, rm } from 'node:fs/promises';
import { basename, join, resolve } from 'node:path';

const OUTPUT_DIRECTORY = resolve('dist');
const LOCAL_SECRET_FILE = resolve('.dev.vars');
const SECRET_FILE_NAME = /^(?:\.dev\.vars|\.env)(?:\.|$)/u;

async function filesBelow(directory) {
  const files = [];
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) files.push(...await filesBelow(path));
    else if (entry.isFile()) files.push(path);
  }
  return files;
}

function dotenvValues(contents) {
  const values = [];
  for (const line of contents.split(/\r?\n/u)) {
    const match = line.match(/^\s*(?:export\s+)?[A-Za-z_][A-Za-z0-9_]*\s*=\s*(.*)\s*$/u);
    if (!match) continue;
    let value = (match[1] || '').trim();
    if (value.length >= 2 && ((value.startsWith('"') && value.endsWith('"'))
      || (value.startsWith("'") && value.endsWith("'")))) {
      value = value.slice(1, -1);
    }
    if (value.length >= 8) values.push(value);
  }
  return values;
}

async function readableText(path) {
  const contents = await readFile(path);
  return contents.includes(0) ? undefined : contents.toString('utf8');
}

async function main() {
  const outputFiles = await filesBelow(OUTPUT_DIRECTORY);
  const secretFiles = outputFiles.filter((path) => SECRET_FILE_NAME.test(basename(path)));
  const secretValues = [];

  try {
    secretValues.push(...dotenvValues(await readFile(LOCAL_SECRET_FILE, 'utf8')));
  } catch (error) {
    if (!error || typeof error !== 'object' || error.code !== 'ENOENT') throw error;
  }
  for (const path of secretFiles) {
    secretValues.push(...dotenvValues(await readFile(path, 'utf8')));
    await rm(path, { force: true });
  }

  const remainingFiles = outputFiles.filter((path) => !secretFiles.includes(path));
  for (const path of remainingFiles) {
    const contents = await readableText(path);
    if (!contents) continue;
    if (secretValues.some((value) => contents.includes(value))) {
      throw new Error(`构建产物包含本地密钥值：${path}`);
    }
  }

  console.log(`控制台构建已清理：移除 ${secretFiles.length} 个本地密钥文件。`);
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});
