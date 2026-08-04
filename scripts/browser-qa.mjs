import { existsSync } from 'node:fs';
import { mkdir, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import process from 'node:process';
import { chromium } from 'playwright-core';

const baseUrl = process.env.QA_BASE_URL || 'http://127.0.0.1:5173';
const outputDirectory = join(tmpdir(), 'uglink-control-qa');
const screenshotPath = (name) => join(outputDirectory, name);
const chromeCandidates = [
  process.env.CHROME_PATH,
  'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
  'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe'
].filter(Boolean);
const executablePath = chromeCandidates.find((candidate) => existsSync(candidate));
if (!executablePath) throw new Error('Chrome or Edge was not found. Set CHROME_PATH.');

await mkdir(outputDirectory, { recursive: true });
const browser = await chromium.launch({ executablePath, headless: true });
const page = await browser.newPage({ viewport: { width: 1440, height: 1000 }, deviceScaleFactor: 1 });
const browserErrors = [];
page.on('pageerror', (error) => browserErrors.push(`pageerror: ${error.message}`));
page.on('console', (message) => {
  if (message.type() === 'error' || message.type() === 'warning') {
    browserErrors.push(`console ${message.type()}: ${message.text()}`);
  }
});

const account = { id: '0123456789abcdef0123456789abcdef', name: 'QA Cloudflare Account' };
let cloudflareConnected = true;
let target = {
  accountId: account.id,
  accountName: account.name,
  accountIdSuffix: account.id.slice(-6),
  workerName: 'uglink-qa'
};
let deploymentJob;
let deploymentRequests = 0;
let lastDeploymentMode;
let publishedHealthRequests = 0;
let publishedServicesHealthy = true;
let diagnosticEntries = [];

function bootstrap() {
  return {
    title: 'UGLINK Control',
    authenticated: cloudflareConnected && Boolean(target),
    csrfToken: 'qa-csrf-token',
    providers: {
      cloudflare: cloudflareConnected
        ? { state: 'connected', label: account.name, detail: target ? `服务 · ${target.workerName}` : '请选择账户和服务' }
        : { state: 'disconnected' }
    },
    ...(target ? { target } : {})
  };
}

function validation() {
  return {
    valid: true,
    checks: [
      { id: 'schema', label: '配置结构', detail: '字段、类型和取值范围符合配置规范。', level: 'pass' },
      { id: 'upstream', label: 'UGLINK 上游地址', detail: '使用 HTTPS。', level: 'pass' },
      { id: 'unique-services', label: '服务映射唯一性', detail: '没有重复映射。', level: 'pass' },
      { id: 'enabled-services', label: '已启用服务', detail: '服务会被发布。', level: 'pass' },
      { id: 'username', label: '登录用户名', detail: '用户名已设置。', level: 'pass' }
    ]
  };
}

function jsonResponse(route, body, status = 200) {
  return route.fulfill({
    status,
    contentType: 'application/json; charset=utf-8',
    body: JSON.stringify(body)
  });
}

await page.route('**/api/**', async (route) => {
  const request = route.request();
  const url = new URL(request.url());
  if (request.method() === 'GET' && url.pathname === '/api/bootstrap') {
    return jsonResponse(route, bootstrap());
  }
  if (request.method() === 'POST' && url.pathname === '/api/connections/cloudflare') {
    const body = request.postDataJSON();
    cloudflareConnected = true;
    target = {
      accountId: String(body.accountId),
      accountName: account.name,
      accountIdSuffix: String(body.accountId).slice(-6),
      workerName: String(body.workerName).trim().toLowerCase()
    };
    return jsonResponse(route, bootstrap());
  }
  if (request.method() === 'POST' && url.pathname === '/api/validate') {
    return jsonResponse(route, validation());
  }
  if (request.method() === 'POST' && url.pathname === '/api/services/health') {
    publishedHealthRequests += 1;
    const body = request.postDataJSON();
    const services = body.config.services
      .filter((service) => service.enabled !== false)
      .map((service) => ({
        serviceName: service.name,
        hostname: service.hostname,
        port: service.port,
        healthy: publishedServicesHealthy,
        detail: publishedServicesHealthy ? 'Worker 已部署且域名配置正常' : '服务入口返回 HTTP 404',
        code: publishedServicesHealthy ? 'healthy' : 'service_entry_http_error',
        stage: publishedServicesHealthy ? 'worker_configuration' : 'service_entry',
        httpStatus: publishedServicesHealthy ? 200 : 404
      }));
    if (!publishedServicesHealthy) {
      const previousOccurrences = diagnosticEntries[0]?.occurrences || 0;
      diagnosticEntries = [{
        id: 'qa-diagnostic-service-entry',
        source: 'health_check',
        severity: 'error',
        stage: 'service_entry',
        code: 'service_entry_http_error',
        summary: '服务入口返回 HTTP 404',
        httpStatus: 404,
        firstObservedAt: diagnosticEntries[0]?.firstObservedAt || new Date().toISOString(),
        lastObservedAt: new Date().toISOString(),
        occurrences: previousOccurrences + 1,
        service: {
          name: services[0]?.serviceName,
          hostname: services[0]?.hostname,
          port: services[0]?.port
        }
      }];
    }
    return jsonResponse(route, {
      checkedAt: new Date().toISOString(),
      services
    });
  }
  if (request.method() === 'GET' && url.pathname === '/api/diagnostics') {
    return jsonResponse(route, { entries: diagnosticEntries });
  }
  if (request.method() === 'POST' && url.pathname === '/api/deploy') {
    const body = request.postDataJSON();
    deploymentRequests += 1;
    lastDeploymentMode = body.mode;
    const now = new Date().toISOString();
    deploymentJob = {
      id: 'qa-deployment-0001',
      mode: body.mode || 'publish',
      phase: 'checking',
      createdAt: now,
      updatedAt: now,
      message: '服务已发布，正在等待访问域名生效。',
      passwordUpdated: Boolean(body.password),
      workerName: target.workerName,
      accountId: account.id,
      accountName: account.name,
      kvNamespaceTitle: `${target.workerName}-uglink-cache`,
      kvNamespaceIdSuffix: 'c0ffee',
      cloudflareDeploymentId: 'deployment-version-0001',
      dashboardUrl: `https://dash.cloudflare.com/${account.id}/workers/services/view/${target.workerName}/production`,
      services: body.config.services.filter((service) => service.enabled !== false).map((service) => ({
        serviceName: service.name,
        hostname: service.hostname,
        port: service.port,
        healthy: false,
        detail: '证书或域名入口仍在生效',
        code: 'domain_propagating',
        stage: 'service_entry'
      })),
      timeline: [
        { phase: 'queued', label: '发布请求已创建', detail: '发布请求已提交。', at: now },
        { phase: 'provisioning', label: '准备会话缓存', detail: '会话缓存已就绪。', at: now },
        { phase: 'uploading', label: '发布服务', detail: '服务已发布。', at: now },
        { phase: 'routing', label: '配置访问域名', detail: '访问域名已配置。', at: now },
        { phase: 'checking', label: '检查服务状态', detail: '正在等待访问域名生效。', at: now }
      ]
    };
    return jsonResponse(route, deploymentJob, 202);
  }
  if (request.method() === 'GET' && url.pathname.startsWith('/api/deployments/')) {
    deploymentJob = {
      ...deploymentJob,
      phase: 'healthy',
      message: '服务已发布，所有 Worker 入口均已生效。',
      services: deploymentJob.services.map((service) => ({
        ...service,
        healthy: true,
        detail: 'Worker 已部署且域名配置正常',
        code: 'healthy',
        stage: 'worker_configuration',
        httpStatus: 200
      })),
      timeline: [
        ...deploymentJob.timeline,
        { phase: 'healthy', label: 'Worker 入口正常', detail: '所有 Worker 入口均已生效。', at: new Date().toISOString() }
      ]
    };
    return jsonResponse(route, deploymentJob);
  }
  if (request.method() === 'POST' && url.pathname === '/api/connections/cloudflare/reset') {
    cloudflareConnected = false;
    target = undefined;
    return jsonResponse(route, { ok: true });
  }
  return jsonResponse(route, { error: { code: 'not_mocked', message: `Unmocked ${request.method()} ${url.pathname}` } }, 500);
});

const assertions = [];
function assert(condition, message) {
  assertions.push({ passed: Boolean(condition), message });
  if (!condition) throw new Error(message);
}

async function layoutMetrics() {
  return page.evaluate(() => ({
    bodyWidth: document.body.scrollWidth,
    viewportWidth: window.innerWidth,
    bodyHeight: document.body.scrollHeight,
    viewportHeight: window.innerHeight
  }));
}

try {
  await page.goto(`${baseUrl}/`, { waitUntil: 'networkidle' });
  await page.getByRole('heading', { name: '服务配置', exact: true }).waitFor();
  assert(await page.locator('.app-sidebar nav button').count() === 3, 'Desktop navigation contains service configuration, diagnostics, and security.');
  assert(await page.getByRole('button', { name: '发布状态', exact: true }).count() === 0, 'The standalone deployment page is not present.');
  const dashboardMetrics = await layoutMetrics();
  assert(dashboardMetrics.bodyWidth <= dashboardMetrics.viewportWidth + 1, 'Desktop dashboard has no horizontal overflow.');
  await page.screenshot({ path: screenshotPath('dashboard.png'), fullPage: false });

  await page.getByRole('button', { name: /添加服务/ }).click();
  await page.getByLabel('第 1 个服务名').fill('qa-api');
  await page.getByLabel('第 1 个服务域名').fill('qa-api.example.com');
  await page.getByLabel('第 1 个 NAS 端口').fill('9000');
  await page.getByLabel('绿联云地址').fill('https://device.example.test');
  await page.getByLabel('登录用户名').fill('test-user');
  const passwordInput = page.getByLabel('登录密码');
  await passwordInput.fill('qa-visible-secret');
  assert(await passwordInput.getAttribute('type') === 'password', 'The NAS password is hidden by default.');
  await page.getByRole('button', { name: '显示密码', exact: true }).click();
  assert(await passwordInput.getAttribute('type') === 'text', 'The password visibility control reveals the entered password.');
  assert(await passwordInput.inputValue() === 'qa-visible-secret', 'Toggling visibility preserves the password value.');
  await page.screenshot({ path: screenshotPath('password-visible.png'), fullPage: false });
  await page.getByRole('button', { name: '隐藏密码', exact: true }).click();
  assert(await passwordInput.getAttribute('type') === 'password', 'The password visibility control hides the password again.');
  await page.screenshot({ path: screenshotPath('password-hidden.png'), fullPage: false });
  await page.reload({ waitUntil: 'networkidle' });
  assert(await page.getByLabel('第 1 个服务域名').inputValue() === 'qa-api.example.com', 'The browser-local draft survives reload.');
  await page.getByRole('button', { name: /检查配置/ }).click();
  await page.getByText('配置已通过服务器校验。').waitFor();
  assert(await page.getByRole('button', { name: /发布更改/ }).isEnabled(), 'A valid edit enables deployment.');
  await page.getByRole('button', { name: /发布更改/ }).click();
  await page.getByRole('heading', { name: '服务配置', exact: true }).waitFor();
  await page.locator('.service-status--success').waitFor({ timeout: 10_000 });
  assert(await page.getByLabel('第 1 个服务域名').inputValue() === 'qa-api.example.com', 'The deployed service remains visible in the service list.');
  assert(await page.getByText('运行正常', { exact: true }).isVisible(), 'The service list shows the successful runtime status.');
  const healthRequestsBeforeReload = publishedHealthRequests;
  await page.reload({ waitUntil: 'networkidle' });
  await page.locator('.service-status--success').waitFor({ timeout: 10_000 });
  assert(publishedHealthRequests > healthRequestsBeforeReload, 'Reload checks every locally published service without a deployment task ID.');
  assert(await page.getByText('运行正常', { exact: true }).isVisible(), 'The refreshed service health check restores the successful status.');
  assert(await page.getByText('未检查', { exact: true }).count() === 0, 'Published services never fall back to the unchecked state.');
  await page.screenshot({ path: screenshotPath('services-healthy.png'), fullPage: false });

  publishedServicesHealthy = false;
  await page.reload({ waitUntil: 'networkidle' });
  await page.locator('.service-status--error').waitFor({ timeout: 10_000 });
  assert(await page.getByText('HTTP 404', { exact: true }).isVisible(), 'An invalid Worker service entry shows a specific status in the service list.');
  const errorStatus = page.getByRole('button', { name: /HTTP 404：服务入口返回 HTTP 404/ });
  assert((await errorStatus.count()) === 1, 'The abnormal service provides a diagnostics entry point.');
  await errorStatus.click();
  await page.getByRole('heading', { name: '故障诊断', exact: true }).waitFor();
  assert(await page.getByText('服务入口', { exact: true }).first().isVisible(), 'The diagnostics page identifies the failed stage.');
  assert(await page.locator('code').filter({ hasText: 'service_entry_http_error' }).first().isVisible(), 'The diagnostics page shows the machine-readable error code.');
  assert(await page.getByText('HTTP 404', { exact: true }).first().isVisible(), 'The diagnostics page shows the Worker entry HTTP status.');
  assert(await page.getByText('服务入口返回 HTTP 404', { exact: true }).first().isVisible(), 'The diagnostics page shows the specific failure cause.');
  const healthRequestsBeforeManualCheck = publishedHealthRequests;
  const recheckResponse = page.waitForResponse((response) => response.url().endsWith('/api/services/health') && response.request().method() === 'POST');
  await page.getByRole('button', { name: '重新检查', exact: true }).click();
  await recheckResponse;
  assert(publishedHealthRequests > healthRequestsBeforeManualCheck, 'The diagnostics page can run the health check again.');
  await page.screenshot({ path: screenshotPath('diagnostics.png'), fullPage: false });

  const deploymentsBeforeOverwrite = deploymentRequests;
  page.once('dialog', (dialog) => dialog.accept());
  const overwriteResponse = page.waitForResponse((response) => response.url().endsWith('/api/deploy') && response.request().method() === 'POST');
  await page.getByRole('button', { name: '覆盖部署', exact: true }).click();
  await overwriteResponse;
  assert(deploymentRequests === deploymentsBeforeOverwrite + 1, 'Overwrite deployment creates a new deployment request.');
  assert(lastDeploymentMode === 'overwrite', 'Redeployment explicitly uses overwrite mode.');
  await page.getByText('覆盖部署进行中', { exact: true }).waitFor();
  publishedServicesHealthy = true;

  await page.locator('.app-sidebar button').filter({ hasText: '权限与安全' }).click();
  await page.getByRole('heading', { name: '权限与安全', exact: true }).waitFor();
  assert(await page.getByText('本地配置', { exact: true }).isVisible(), 'Local-only configuration boundary is visible.');
  assert(await page.locator('.security-card').filter({ hasText: 'Cloudflare 连接' }).count() === 1, 'Only the Cloudflare API Token connection is present.');
  await page.screenshot({ path: screenshotPath('security.png'), fullPage: false });
  await page.locator('.security-card').filter({ hasText: 'Cloudflare 连接' }).getByRole('button', { name: /重新配置 API Token/ }).click();
  await page.getByRole('heading', { level: 2, name: '配置 API Token', exact: true }).waitFor();
  assert(await page.getByLabel('API Token').isVisible(), 'The API Token connection form is shown after reset.');

  const connectMetrics = await layoutMetrics();
  assert(connectMetrics.bodyWidth <= connectMetrics.viewportWidth + 1, 'Desktop connection screen has no horizontal overflow.');
  await page.screenshot({ path: screenshotPath('connect.png'), fullPage: false });

  await page.setViewportSize({ width: 390, height: 844 });
  await page.reload({ waitUntil: 'networkidle' });
  const mobileConnectMetrics = await layoutMetrics();
  assert(mobileConnectMetrics.bodyWidth <= mobileConnectMetrics.viewportWidth + 1, 'Mobile connection screen has no horizontal overflow.');
  await page.screenshot({ path: screenshotPath('connect-mobile.png'), fullPage: true });

  await page.setViewportSize({ width: 1440, height: 1000 });
  cloudflareConnected = false;
  target = undefined;
  await page.reload({ waitUntil: 'networkidle' });
  await page.getByRole('heading', { level: 2, name: '配置 API Token', exact: true }).waitFor();
  await page.getByLabel('Account ID').fill(account.id);
  await page.getByLabel('API Token').fill('qa-cloudflare-api-token-value');
  await page.getByLabel('服务名称').fill('uglink-reconnected');
  await page.getByRole('button', { name: /验证并继续/ }).click();
  await page.getByRole('heading', { name: '服务配置', exact: true }).waitFor();
  assert((await page.getByText('uglink-reconnected').count()) > 0, 'A selected Worker target enters the production console.');

  await page.setViewportSize({ width: 390, height: 844 });
  await page.reload({ waitUntil: 'networkidle' });
  await page.getByRole('heading', { name: '服务配置', exact: true }).waitFor();
  const mobileDashboardMetrics = await layoutMetrics();
  assert(mobileDashboardMetrics.bodyWidth <= mobileDashboardMetrics.viewportWidth + 1, 'Mobile dashboard has no horizontal overflow.');
  await page.screenshot({ path: screenshotPath('dashboard-mobile.png'), fullPage: true });

  assert(browserErrors.length === 0, `Browser emitted no errors or warnings. ${browserErrors.join(' | ')}`);
  await writeFile(join(outputDirectory, 'report.json'), JSON.stringify({
    baseUrl,
    assertions,
    browserErrors,
    completedAt: new Date().toISOString()
  }, null, 2));
  console.log(`Browser QA passed (${assertions.length} assertions). Output: ${outputDirectory}`);
} finally {
  await browser.close();
}
