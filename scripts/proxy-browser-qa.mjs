// Prerequisites: build uglink-proxy-qa:local, generate test-results/proxy-certs,
// and start test/fixtures/proxy/compose.yaml with project uglink-proxy-qa.
// Exercises real server responses and real Chromium cookie handling; no API interception.
import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { chromium } from 'playwright-core';
const executablePath = [process.env.CHROME_PATH, 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe', 'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe'].filter(Boolean).find(existsSync);
if (!executablePath) throw new Error('Set CHROME_PATH to an installed Chromium browser');
const compose = ['compose', '-p', 'uglink-proxy-qa', '-f', 'test/fixtures/proxy/compose.yaml'];
const automatic = process.env.QA_AUTO_ORIGIN === 'true';
if (automatic) compose.push('-f', 'test/fixtures/proxy/compose.auto.yaml');
const cookieName = origin => 'uglink_console_session' + (automatic ? '_' + createHash('sha256').update(origin).digest('hex').slice(0, 32) : '');
const browser = await chromium.launch({ executablePath, headless: true, args: ['--no-proxy-server', '--host-resolver-rules=MAP proxy.test 127.0.0.1, MAP relay.test 127.0.0.1'] });
try {
  const context = await browser.newContext({ ignoreHTTPSErrors: true });
  const records = [];
  const origins = ['http://127.0.0.1:15173', 'https://proxy.test:15443', 'https://relay.test:15444'];
  if (automatic) origins.push('http://proxy.test:15173', 'https://proxy.test:15444');
  for (const origin of origins) {
    const page = await context.newPage();
    await page.goto(origin);
    await page.getByRole('heading', { name: /Cloudflare/, level: 1 }).waitFor();
    // Initial cookie must come from the actual application's bootstrap, not the probe.
    assert((await context.cookies(origin)).some(c => c.name === cookieName(origin) && c.secure === origin.startsWith('https:')));
    await page.evaluate(auto => {
      // Test probes use the same non-simple header as the application's API client.
      const originalFetch = window.fetch.bind(window);
      window.fetch = (input, init = {}) => originalFetch(input, { ...init, headers: {
        ...init.headers, ...(auto ? { 'X-Uglink-Console-Origin': location.origin } : {})
      } });
    }, automatic);
    const first = await page.evaluate(async () => (await fetch('/api/bootstrap')).json());
    const cookie = (await context.cookies(origin)).find(c => c.name === cookieName(origin));
    assert(cookie); assert.equal(cookie.secure, origin.startsWith('https:'));
    assert(cookie.httpOnly); assert.equal(cookie.sameSite, 'Lax'); assert.equal(cookie.path, '/');
    assert.equal(cookie.domain, new URL(origin).hostname);
    const write = await page.evaluate(async csrf => (await fetch('/api/configuration/cloud/dismiss', { method: 'POST', headers: { 'x-csrf-token': csrf } })).status, first.csrfToken);
    assert.equal(write, 200);
    const denied = await page.evaluate(async () => (await fetch('/api/configuration/cloud/dismiss', { method: 'POST' })).status);
    assert.equal(denied, 403);
    await page.reload();
    if (automatic) await page.evaluate(() => { const f=window.fetch.bind(window); window.fetch=(input,init={})=>f(input,{...init,headers:{...init.headers,'X-Uglink-Console-Origin':location.origin}}); });
    const again = await page.evaluate(async () => (await fetch('/api/bootstrap')).json());
    assert.equal(again.csrfToken, first.csrfToken);
    records.push({ page, origin, csrf: first.csrfToken, id: cookie.value });
    console.log(`PASS browser bootstrap, cookie attributes, write, CSRF rejection and refresh: ${origin}`);
  }
  assert.equal(new Set(records.map(r => r.id)).size, origins.length);
  if (automatic) {
    // Real browsers cannot attach the custom header cross-origin without a
    // successful preflight, even when an attacker knows a valid CSRF token.
    const attacker = records[0].page;
    for (const target of [records[1].origin, records[2].origin]) {
      const blocked = await attacker.evaluate(async ({ target, csrf }) => {
        try {
          await fetch(target + '/api/bootstrap', { credentials: 'include', headers: {
            'X-Uglink-Console-Origin': target, 'X-CSRF-Token': csrf
          } });
          return false;
        } catch { return true; }
      }, { target, csrf: records[1].csrf });
      assert(blocked);
    }
    const proxyLogs = execFileSync('docker', [...compose, 'logs', 'proxy'], { encoding: 'utf8' });
    assert(proxyLogs.includes('Denied browser preflight: 405'));
    console.log('PASS real Chrome cross-origin requests blocked by denied preflight');
  }
  // Model an existing pre-upgrade browser cookie missing Secure, retaining its session ID.
  const proxy = records[1];
  const existing = (await context.cookies(proxy.origin)).find(c => c.name === cookieName(proxy.origin));
  await context.clearCookies({ name: existing.name, domain: existing.domain });
  await context.addCookies([{ ...existing, secure: false }]);
  await proxy.page.evaluate(async () => (await fetch('/api/bootstrap')).json());
  const upgraded = (await context.cookies(proxy.origin)).find(c => c.name === existing.name);
  assert.equal(upgraded.value, existing.value); assert.equal(upgraded.secure, true);
  console.log('PASS cookie Secure refresh preserves session ID; all entry sessions isolated');
  const lan = records[0];
  const spoof = await fetch(lan.origin + '/api/configuration/cloud/dismiss', { method: 'POST', headers: {
    cookie: `${cookieName(lan.origin)}=${lan.id}`, 'x-csrf-token': lan.csrf, origin: proxy.origin,
    'x-forwarded-host': 'proxy.test:15443', 'x-forwarded-proto': 'https'
  } });
  assert.equal(spoof.status, 403); assert.equal((await spoof.json()).error.code, 'invalid_origin');
  const crossed = await fetch(lan.origin + '/api/configuration/cloud/dismiss', { method: 'POST', headers: {
    host: 'relay.test:15444', cookie: `${cookieName(records[2].origin)}=${records[2].id}`, 'x-csrf-token': records[2].csrf, origin: proxy.origin
  } });
  assert.equal(crossed.status, 403);
  console.log('PASS Docker published-port peer cannot spoof trusted proxy; cross-allowed-origin write rejected');
  if (!automatic) {
  const probe = `const r=await fetch('http://console:8787/api/bootstrap',{headers:{'x-forwarded-host':'proxy.test:15443,evil.test','x-forwarded-proto':'https'}});if(r.status!==400||(await r.json()).error.code!=='invalid_proxy_headers')process.exit(1);`;
  execFileSync('docker', [...compose, 'exec', '-T', 'proxy', 'node', '--input-type=module', '-e', probe], { stdio: 'pipe' });
  }
  // Proxy overwrites hostile client headers, so the browser still reaches its real target.
  await proxy.page.setExtraHTTPHeaders({ 'x-forwarded-host': 'evil.test', 'x-forwarded-proto': 'http', forwarded: 'host=evil.test;proto=http' });
  const clean = await proxy.page.evaluate(async () => (await fetch('/api/bootstrap')).json());
  assert.equal(clean.csrfToken, proxy.csrf);
  await proxy.page.setExtraHTTPHeaders({});
  console.log(automatic ? 'PASS edge strips client forwarding metadata' : 'PASS trusted malformed metadata rejected and edge strips client forwarding metadata');
  execFileSync('docker', [...compose, 'restart', 'console'], { stdio: 'pipe' });
  let ready = false;
  for (let i = 0; i < 50; i++) {
    try { if ((await fetch(lan.origin + '/api/health')).ok) { ready = true; break; } } catch { /* startup */ }
    await new Promise(resolve => setTimeout(resolve, 200));
  }
  assert(ready);
  for (const record of records) {
    await record.page.reload();
    if (automatic) await record.page.evaluate(() => { const f=window.fetch.bind(window); window.fetch=(input,init={})=>f(input,{...init,headers:{...init.headers,'X-Uglink-Console-Origin':location.origin}}); });
    const after = await record.page.evaluate(async () => (await fetch('/api/bootstrap')).json());
    assert.equal(after.csrfToken, record.csrf);
  }
  console.log(`PASS Docker restart preserves all ${records.length} encrypted sessions and pages recover after errors`);
  await context.close();
} finally { await browser.close(); }
