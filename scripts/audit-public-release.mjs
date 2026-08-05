import { execFileSync } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import { extname, normalize, sep } from 'node:path';

const HISTORY_MODE = process.argv.includes('--history');
const MAX_TEXT_BYTES = 5 * 1024 * 1024;
const BINARY_EXTENSIONS = new Set([
  '.avif', '.gif', '.ico', '.jpeg', '.jpg', '.pdf', '.png', '.webp', '.woff', '.woff2'
]);
const FORBIDDEN_PATHS = [
  /(^|\/)\.dev\.vars(?:\.|$)(?!example$)/iu,
  /(^|\/)\.env(?:\.|$)(?!example$)/iu,
  /(^|\/)(?:\.generated|\.wrangler|dist|node_modules)(?:\/|$)/iu,
  /(^|\/)wrangler\.gateway\.generated\.json$/iu
];
const PRIVATE_NETWORK = /\b(?:10(?:\.\d{1,3}){3}|192\.168(?:\.\d{1,3}){2}|172\.(?:1[6-9]|2\d|3[01])(?:\.\d{1,3}){2})\b/gu;
const EMAIL = /(?<![A-Za-z0-9._%+-])[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/gu;
const USER_HOME = /(?:[A-Za-z]:\\Users\\[^\\\s]+|\/(?:Users|home)\/[^/\s]+)/gu;
const UGREEN_REMOTE = /https:\/\/([A-Za-z0-9.-]+\.ug\.link)(?=[:/\s"'`]|$)/giu;
const WORKERS_DEV = /https:\/\/([A-Za-z0-9.-]+\.workers\.dev)(?=[:/\s"'`]|$)/giu;
const ACCOUNT_ID_ASSIGNMENT = /(?:account(?:_|\s*)id|accountId)\s*[=:]\s*["']?([a-f0-9]{32})/giu;
const SAFE_ACCOUNT_IDS = new Set([
  '00000000000000000000000000000000',
  '0123456789abcdef0123456789abcdef'
]);

function repositoryFiles() {
  const output = execFileSync('git', [
    'ls-files', '--cached', '--others', '--exclude-standard', '-z'
  ], { encoding: 'utf8' });
  return output.split('\0').filter(Boolean).map((path) => normalize(path));
}

function lineNumber(contents, index) {
  let line = 1;
  for (let offset = 0; offset < index; offset += 1) {
    if (contents.charCodeAt(offset) === 10) line += 1;
  }
  return line;
}

function addMatches(findings, path, contents, expression, category, predicate = () => true) {
  expression.lastIndex = 0;
  for (const match of contents.matchAll(expression)) {
    if (!predicate(match)) continue;
    findings.push({ path, line: lineNumber(contents, match.index ?? 0), category });
  }
}

function customForbiddenTerms() {
  return (process.env.UGLINK_AUDIT_FORBIDDEN_TERMS || '')
    .split(',')
    .map((term) => term.trim())
    .filter(Boolean);
}

function scanText(findings, path, contents) {
  addMatches(
    findings,
    path,
    contents,
    EMAIL,
    '电子邮箱',
    (match) => !/@(?:(?:[^@.]+\.)*(?:example\.(?:com|net|org)|example|test)|users\.noreply\.github\.com)$/iu.test(String(match[0]))
  );
  addMatches(findings, path, contents, PRIVATE_NETWORK, '私有网络地址');
  addMatches(findings, path, contents, USER_HOME, '用户主目录绝对路径');
  addMatches(
    findings,
    path,
    contents,
    UGREEN_REMOTE,
    '真实绿联远程地址',
    (match) => {
      const hostname = String(match[1]).toLowerCase();
      return hostname !== 'www.ug.link'
        && !hostname.startsWith('example.')
        && !hostname.includes('.example.ug.link');
    }
  );
  addMatches(
    findings,
    path,
    contents,
    WORKERS_DEV,
    '具体 workers.dev 地址',
    (match) => !String(match[1]).toLowerCase().startsWith('example.')
  );
  addMatches(
    findings,
    path,
    contents,
    ACCOUNT_ID_ASSIGNMENT,
    '疑似 Cloudflare Account ID',
    (match) => !SAFE_ACCOUNT_IDS.has(String(match[1]).toLowerCase())
  );

  const lower = contents.toLowerCase();
  for (const term of customForbiddenTerms()) {
    const index = lower.indexOf(term.toLowerCase());
    if (index >= 0) {
      findings.push({ path, line: lineNumber(contents, index), category: '自定义禁止词' });
    }
  }
}

async function scanWorkingTree() {
  const findings = [];
  for (const path of repositoryFiles()) {
    const portablePath = path.split(sep).join('/');
    if (FORBIDDEN_PATHS.some((pattern) => pattern.test(portablePath))) {
      findings.push({ path: portablePath, line: 1, category: '不应发布的运行时文件' });
      continue;
    }
    if (/^docs\/design\/.*\.(?:avif|gif|jpe?g|png|webp)$/iu.test(portablePath)) {
      findings.push({ path: portablePath, line: 1, category: '未经审阅的设计截图' });
      continue;
    }
    if (BINARY_EXTENSIONS.has(extname(path).toLowerCase())) continue;

    let contents;
    try {
      contents = await readFile(path);
    } catch (error) {
      if (error && typeof error === 'object' && error.code === 'ENOENT') continue;
      throw error;
    }
    if (contents.byteLength > MAX_TEXT_BYTES || contents.includes(0)) continue;
    scanText(findings, portablePath, contents.toString('utf8'));
  }
  return findings;
}

function scanHistory() {
  if (!HISTORY_MODE) return [];
  const history = execFileSync('git', [
    'log', '--all', '--patch', '--no-ext-diff', '--text', '--format=fuller'
  ], { encoding: 'utf8', maxBuffer: 100 * 1024 * 1024 });
  const findings = [];
  scanText(findings, 'Git history', history);
  return findings;
}

const findings = [...await scanWorkingTree(), ...scanHistory()];
if (findings.length > 0) {
  console.error('公开发布审计未通过：');
  for (const finding of findings.slice(0, 50)) {
    console.error(`- ${finding.path}:${finding.line} · ${finding.category}`);
  }
  if (findings.length > 50) console.error(`- 另有 ${findings.length - 50} 项未显示。`);
  process.exitCode = 1;
} else {
  console.log(HISTORY_MODE
    ? '公开发布审计通过：当前文件和可达 Git 历史均未发现个人化数据。'
    : '公开发布审计通过：当前发布文件未发现个人化数据。');
}
