import { readFile } from 'node:fs/promises';

const configUrl = new URL('../wrangler.jsonc', import.meta.url);
const config = JSON.parse(await readFile(configUrl, 'utf8'));
const sessionBinding = config.kv_namespaces?.find(
  (binding) => binding.binding === 'CONSOLE_SESSIONS'
);
const namespaceId = sessionBinding?.id;

if (!/^[a-f0-9]{32}$/u.test(namespaceId || '') || /^0+$/u.test(namespaceId)) {
  throw new Error(
    '请先在 wrangler.jsonc 中填写 CONSOLE_SESSIONS 的 Workers KV 命名空间 ID。'
  );
}

console.log('控制台生产配置检查通过。');
