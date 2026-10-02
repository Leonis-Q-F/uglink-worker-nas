// Prerequisites: build uglink-proxy-qa:local, generate test-results/proxy-certs,
// and start test/fixtures/proxy/compose.yaml with project uglink-proxy-qa.
// Exercises real server responses and real Chromium cookie handling; no API interception.
import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { chromium } from 'playwright-core';
const executablePath = [process.env.CHROME_PATH, 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe', 'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe'].filter(Boolean).find(existsSync);
if (!executablePath) throw new Error('Set CHROME_PATH to an installed Chromium browser');
const compose = ['compose', '-p', 'uglink-proxy-qa', '-f', 'test/fixtures/proxy/compose.yaml'];
const browser = await chromium.launch({ executablePath, headless: true, args: ['--no-proxy-server', '--host-resolver-rules=MAP proxy.test 127.0.0.1, MAP relay.test 127.0.0.1'] });
try {
  const context = await browser.newContext({ ignoreHTTPSErrors: true });
  const records = [];
  for (const origin of ['http://127.0.0.1:15173', 'https://proxy.test:15443', 'https://relay.test:15444']) {
    const page = await context.newPage();
    await page.goto(origin);
    const first = await page.evaluate(async () => (await fetch('/api/bootstrap')).json());
    const cookie = (await context.cookies(origin)).find(c => c.name === 'uglink_console_session');
    assert(cookie); assert.equal(cookie.secure, origin.startsWith('https:'));
    assert(cookie.httpOnly); assert.equal(cookie.sameSite, 'Lax'); assert.equal(cookie.path, '/');
    assert.equal(cookie.domain, new URL(origin).hostname);
    const write = await page.evaluate(async csrf => (await fetch('/api/configuration/cloud/dismiss', { method: 'POST', headers: { 'x-csrf-token': csrf } })).status, first.csrfToken);
    assert.equal(write, 200);
    const denied = await page.evaluate(async () => (await fetch('/api/configuration/cloud/dismiss', { method: 'POST' })).status);
    assert.equal(denied, 403);
    await page.reload();
    const again = await page.evaluate(async () => (await fetch('/api/bootstrap')).json());
    assert.equal(again.csrfToken, first.csrfToken);
    records.push({ page, origin, csrf: first.csrfToken, id: cookie.value });
    console.log(`PASS browser bootstrap, cookie attributes, write, CSRF rejection and refresh: ${origin}`);
  }
  assert.equal(new Set(records.map(r => r.id)).size, 3);
  // Model an existing pre-upgrade browser cookie missing Secure, retaining its session ID.
  const proxy = records[1];
  const existing = (await context.cookies(proxy.origin)).find(c => c.name === 'uglink_console_session');
  await context.clearCookies({ name: existing.name, domain: existing.domain });
  await context.addCookies([{ ...existing, secure: false }]);
  await proxy.page.evaluate(async () => (await fetch('/api/bootstrap')).json());
  const upgraded = (await context.cookies(proxy.origin)).find(c => c.name === existing.name);
  assert.equal(upgraded.value, existing.value); assert.equal(upgraded.secure, true);
  console.log('PASS legacy browser cookie upgraded without changing session ID; three hosts isolated');
  const lan = records[0];
  const spoof = await fetch(lan.origin + '/api/configuration/cloud/dismiss', { method: 'POST', headers: {
    cookie: `uglink_console_session=${lan.id}`, 'x-csrf-token': lan.csrf, origin: proxy.origin,
    'x-forwarded-host': 'proxy.test:15443', 'x-forwarded-proto': 'https'
  } });
  assert.equal(spoof.status, 403); assert.equal((await spoof.json()).error.code, 'invalid_origin');
  const crossed = await fetch(lan.origin + '/api/configuration/cloud/dismiss', { method: 'POST', headers: {
    host: 'relay.test:15444', cookie: `uglink_console_session=${records[2].id}`, 'x-csrf-token': records[2].csrf, origin: proxy.origin
  } });
  assert.equal(crossed.status, 403);
  console.log('PASS Docker published-port peer cannot spoof trusted proxy; cross-allowed-origin write rejected');
  const probe = `const r=await fetch('http://console:8787/api/bootstrap',{headers:{'x-forwarded-host':'proxy.test:15443,evil.test','x-forwarded-proto':'https'}});if(r.status!==400||(await r.json()).error.code!=='invalid_proxy_headers')process.exit(1);`;
  execFileSync('docker', [...compose, 'exec', '-T', 'proxy', 'node', '--input-type=module', '-e', probe], { stdio: 'pipe' });
  // Proxy overwrites hostile client headers, so the browser still reaches its real target.
  await proxy.page.setExtraHTTPHeaders({ 'x-forwarded-host': 'evil.test', 'x-forwarded-proto': 'http', forwarded: 'host=evil.test;proto=http' });
  const clean = await proxy.page.evaluate(async () => (await fetch('/api/bootstrap')).json());
  assert.equal(clean.csrfToken, proxy.csrf);
  await proxy.page.setExtraHTTPHeaders({});
  console.log('PASS trusted malformed metadata rejected and edge strips client forwarding metadata');
  execFileSync('docker', [...compose, 'restart', 'console'], { stdio: 'pipe' });
  let ready = false;
  for (let i = 0; i < 50; i++) {
    try { if ((await fetch(lan.origin + '/api/health')).ok) { ready = true; break; } } catch { /* startup */ }
    await new Promise(resolve => setTimeout(resolve, 200));
  }
  assert(ready);
  for (const record of records) {
    await record.page.reload();
    const after = await record.page.evaluate(async () => (await fetch('/api/bootstrap')).json());
    assert.equal(after.csrfToken, record.csrf);
  }
  console.log('PASS Docker restart preserves all three encrypted sessions and pages recover after errors');
  await context.close();
} finally { await browser.close(); }
