import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';
import { swipeRight } from './helpers/mobile-gestures.mjs';
import assert from 'node:assert/strict';

const require = createRequire(import.meta.url);
const playwrightPath = process.env.PLAYWRIGHT_PATH
  ?? '/home/ningmengchang/ideaProjects/dpp-cloud-saic/dpp-platform-web/node_modules/playwright';
const { chromium } = require(playwrightPath);
const publicRoot = process.env.CODEX_MOBILE_PUBLIC_ROOT
  ?? path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'public');

let activeBackend = 'gpt';
const switchBodies = [];
const accountRequests = [];
const dialogDecisions = [];
const settingsReturnKey = 'codex-mobile-settings-after-agent-switch';
let switchFailure = false;
let backendBusy = true;
const BACKENDS = {
  gpt: { home: '/home/user/.codex', model: 'gpt-model', effort: 'max' },
  deepseek: { home: '/home/user/.codex-ds', model: 'deepseek-v4-flash', effort: 'high' },
  glm: { home: '/home/user/.codex-glm', model: 'glm-5.3', effort: 'max' },
};
const backendData = () => ({
  active: activeBackend,
  data: [
    { id: 'gpt', label: 'GPT', description: '设备码登录 · OpenAI', available: true, active: activeBackend === 'gpt' },
    { id: 'deepseek', label: 'DeepSeek', description: '独立本地配置', available: true, active: activeBackend === 'deepseek' },
    { id: 'glm', label: 'GLM', description: '智谱 Coding Plan · 独立本地配置', available: true, active: activeBackend === 'glm' },
    { id: 'codex1', label: 'Codex1', description: '设备码登录 · 备用账号 1', available: false, state: 'login_required', account: null, active: false },
    { id: 'codex2', label: 'Codex2', description: '设备码登录 · 备用账号 2', available: false, state: 'login_required', account: null, active: false },
    { id: 'codex3', label: 'Codex3', description: '设备码登录 · 备用账号 3', available: false, state: 'login_required', account: null, active: false },
  ],
});
const bootstrap = () => ({
  appServer: { ready: true }, runtime: { user: 'ningmengchang', codexHome: BACKENDS[activeBackend].home },
  backends: backendData(),
  defaultModel: BACKENDS[activeBackend].model,
  defaultEffort: BACKENDS[activeBackend].effort,
  models: [{ id: BACKENDS[activeBackend].model, isDefault: true }],
  collaborationModes: [], pendingRequests: [], threadActivities: [], favorites: [],
  projects: { current: { name: 'demo', path: '/projects/demo' }, parent: '/projects', entries: [] },
});

const browser = await chromium.launch({ headless: true });
try {
  const context = await browser.newContext({
    viewport: { width: 390, height: 844 }, deviceScaleFactor: 2, isMobile: true, hasTouch: true,
  });
  await context.addInitScript(() => {
    // Observe the first app reveal after a switch, not just the final modal state.
    if (sessionStorage.getItem('codex-mobile-settings-after-agent-switch')) {
      const observer = new MutationObserver(() => {
        const app = document.querySelector('#app');
        if (!app || app.hidden) return;
        window.firstRevealHadSettings = document.querySelector('#settingsSheet')?.open === true;
        observer.disconnect();
      });
      observer.observe(document, { subtree: true, attributes: true, childList: true });
    }
    window.EventSource = class {
      constructor() { setTimeout(() => this.onopen?.(), 10); }
      addEventListener(name, callback) {
        if (name === 'backend-changed') window.dispatchBackendChange = (data) => callback({ data: JSON.stringify(data) });
      }
      close() {}
    };
  });
  const page = await context.newPage();
  page.on('dialog', (dialog) => (dialogDecisions.shift() ?? true) ? dialog.accept() : dialog.dismiss());
  await page.route('**/*', async (route) => {
    const url = new URL(route.request().url());
    const pathname = url.pathname;
    const method = route.request().method();
    const fulfillJson = (body, status = 200) => route.fulfill({
      status, contentType: 'application/json; charset=utf-8', body: JSON.stringify(body),
    });
    if (pathname === '/api/auth/status') return fulfillJson({ authenticated: true });
    if (pathname === '/api/bootstrap') return fulfillJson(bootstrap());
    if (pathname === '/api/catalogs') return fulfillJson(bootstrap());
    if (pathname === '/api/threads' && method === 'GET') return fulfillJson({ data: [], nextCursor: null });
    if (pathname === '/api/requests') return fulfillJson({ data: [] });
    if (pathname === '/api/account/status') {
      const backend = activeBackend;
      accountRequests.push(backend);
      await new Promise((resolve) => setTimeout(resolve, 180));
      return fulfillJson({ backend, available: false, message: `${backend} 账号额度` });
    }
    if (pathname === '/api/runtime/backend' && method === 'POST') {
      const body = JSON.parse(route.request().postData() || '{}');
      switchBodies.push(body);
      await new Promise((resolve) => setTimeout(resolve, 120));
      if (switchFailure) return fulfillJson({ error: 'BACKEND_FAILED', message: '测试切换失败' }, 503);
      if (backendBusy && body.force !== true) {
        return fulfillJson({
          error: 'BACKEND_BUSY', message: '仍有会话正在执行或等待确认，切换会中断这些任务。',
          data: { activeThreads: ['thread-running'] },
        }, 409);
      }
      activeBackend = body.id;
      return fulfillJson({ active: activeBackend, backends: backendData(), defaultModel: BACKENDS[activeBackend].model });
    }
    const file = path.join(publicRoot, pathname === '/' ? 'index.html' : pathname);
    if (!fs.existsSync(file) || !fs.statSync(file).isFile()) return route.fulfill({ status: 404, body: 'not found' });
    const contentType = file.endsWith('.js') ? 'text/javascript; charset=utf-8'
      : file.endsWith('.css') ? 'text/css; charset=utf-8'
        : file.endsWith('.html') ? 'text/html; charset=utf-8'
          : 'application/octet-stream';
    return route.fulfill({ status: 200, contentType, body: fs.readFileSync(file) });
  });

  await page.goto('http://127.0.0.1:39925/', { waitUntil: 'domcontentloaded' });
  await page.locator('#app:not([hidden])').waitFor({ timeout: 15_000 });
  const backendOptions = await page.evaluate(() => [...document.querySelectorAll('#backendSelect option')]
    .map((option) => ({ value: option.value, text: option.textContent, disabled: option.disabled })));
  for (const id of ['codex1', 'codex2', 'codex3']) {
    const option = backendOptions.find((item) => item.value === id);
    if (!option || option.disabled !== true || !option.text.includes('（未登录）')) {
      throw new Error(`未登录的设备码实例未正确置灰：${JSON.stringify(backendOptions)}`);
    }
  }
  await swipeRight(page, '#threadsView');
  await page.locator('#projectsView.active').waitFor();
  await page.locator('#settingsButton').click();
  await page.locator('#backendSelect').selectOption('deepseek');
  await page.locator('#settingsBackendStatus:not([hidden])').waitFor();
  assert.equal(await page.locator('#settingsSheet').getAttribute('aria-busy'), 'true');
  assert.equal(await page.locator('#backendSelect').isDisabled(), true);
  assert.equal(await page.locator('#modelSelect').isDisabled(), true);
  assert.match(await page.locator('#accountQuotaList').innerText(), /切换中/);
  await page.waitForFunction(() => document.querySelector('#app') && !document.querySelector('#app').hidden
    && document.querySelector('#backendSelect')?.value === 'deepseek', null, { timeout: 15_000 });
  if (switchBodies.length !== 2 || switchBodies[0].id !== 'deepseek' || switchBodies[0].force === true
      || switchBodies[1].id !== 'deepseek' || switchBodies[1].force !== true) {
    throw new Error(`Agent 切换请求异常：${JSON.stringify(switchBodies)}`);
  }
  async function assertSettingsRestored(backend) {
    assert.equal(await page.locator('#settingsSheet').evaluate((dialog) => dialog.open), true);
    assert.equal(await page.evaluate(() => window.firstRevealHadSettings), true, '首页不能先于设置页露出');
    assert.equal(await page.evaluate((key) => sessionStorage.getItem(key), settingsReturnKey), null);
    await page.waitForFunction((id) => document.querySelector('#accountQuotaList').textContent.includes(`${id} 账号额度`), backend);
    assert.equal(await page.locator('#backendSelect').isDisabled(), false);
    assert.equal(await page.locator('#modelSelect').isDisabled(), false);
    assert.equal(accountRequests.at(-1), backend);
  }
  await assertSettingsRestored('deepseek');
  const result = await page.evaluate(() => ({
    backend: document.querySelector('#backendSelect').value,
    model: document.querySelector('#modelSelect').value,
    runtime: document.querySelector('#settingsRuntime').textContent,
  }));
  if (result.backend !== 'deepseek' || result.model !== 'deepseek-v4-flash' || !result.runtime.includes('DeepSeek')) {
    throw new Error(`切换后设置状态异常：${JSON.stringify(result)}`);
  }
  await page.locator('#backendSelect').selectOption('glm');
  await page.waitForFunction(() => document.querySelector('#app') && !document.querySelector('#app').hidden
    && document.querySelector('#backendSelect')?.value === 'glm', null, { timeout: 15_000 });
  await assertSettingsRestored('glm');
  const glmResult = await page.evaluate(() => ({
    backend: document.querySelector('#backendSelect').value,
    model: document.querySelector('#modelSelect').value,
    runtime: document.querySelector('#settingsRuntime').textContent,
  }));
  if (glmResult.backend !== 'glm' || glmResult.model !== 'glm-5.3' || !glmResult.runtime.includes('GLM')) {
    throw new Error(`切换到 GLM 后设置状态异常：${JSON.stringify(glmResult)}`);
  }
  const glmSwitches = switchBodies.filter((body) => body.id === 'glm');
  if (glmSwitches.length !== 2 || glmSwitches[0].force === true || glmSwitches[1].force !== true) {
    throw new Error(`GLM 切换请求异常：${JSON.stringify(switchBodies)}`);
  }

  // Initial confirmation cancellation must make no request and leave settings unchanged.
  const beforeCancel = switchBodies.length;
  dialogDecisions.push(false);
  await page.locator('#backendSelect').selectOption('gpt');
  await page.waitForFunction(() => document.querySelector('#backendSelect').value === 'glm');
  assert.equal(switchBodies.length, beforeCancel);
  assert.equal(await page.locator('#settingsSheet').evaluate((dialog) => dialog.open), true);

  // Declining to interrupt running tasks stays in settings without a forced request/reload.
  dialogDecisions.push(true, false);
  await page.locator('#backendSelect').selectOption('gpt');
  await page.waitForFunction(() => document.querySelector('#backendSelect').value === 'glm'
    && !document.querySelector('#backendSelect').disabled);
  assert.deepEqual(switchBodies.slice(beforeCancel), [{ id: 'gpt' }]);
  assert.equal(await page.locator('#settingsSheet').evaluate((dialog) => dialog.open), true);

  // Server failure preserves the old Agent and usable settings.
  switchFailure = true;
  await page.locator('#backendSelect').selectOption('gpt');
  await page.waitForFunction(() => document.querySelector('#backendSelect').value === 'glm'
    && !document.querySelector('#backendSelect').disabled);
  assert.equal(await page.locator('#settingsSheet').evaluate((dialog) => dialog.open), true);
  assert.equal(await page.locator('#settingsBackendStatus').isHidden(), true);
  assert.equal(await page.locator('#modelSelect').inputValue(), BACKENDS.glm.model);
  assert.equal(await page.evaluate((key) => sessionStorage.getItem(key), settingsReturnKey), null);
  switchFailure = false;

  // Normal successful switch with no running tasks uses a single request.
  backendBusy = false;
  const beforeNormal = switchBodies.length;
  await page.locator('#backendSelect').selectOption('gpt');
  await page.waitForFunction(() => !document.querySelector('#app').hidden
    && document.querySelector('#backendSelect').value === 'gpt');
  await assertSettingsRestored('gpt');
  assert.deepEqual(switchBodies.slice(beforeNormal), [{ id: 'gpt' }]);

  // Manual close and ordinary refresh must not unexpectedly reopen the dialog.
  await page.locator('#closeSettingsButton').click();
  assert.equal(await page.locator('#settingsSheet').evaluate((dialog) => dialog.open), false);
  await page.reload();
  await page.locator('#app:not([hidden])').waitFor();
  assert.equal(await page.locator('#settingsSheet').evaluate((dialog) => dialog.open), false);

  // Reloading while settings is open is also an ordinary refresh, not a switch.
  await swipeRight(page, '#threadsView');
  await page.locator('#settingsButton').click();
  await page.reload();
  await page.locator('#app:not([hidden])').waitFor();
  assert.equal(await page.locator('#settingsSheet').evaluate((dialog) => dialog.open), false);

  // Corrupt, expired, future, or wrong-Agent markers are discarded safely and only once.
  for (const saved of ['{invalid', 'null', JSON.stringify({ backendId: 'deepseek', createdAt: Date.now() }),
    JSON.stringify({ backendId: 'gpt', createdAt: Date.now() - 600_000 }),
    JSON.stringify({ backendId: 'gpt', createdAt: Date.now() + 600_000 })]) {
    await page.evaluate(({ key, value }) => sessionStorage.setItem(key, value), { key: settingsReturnKey, value: saved });
    await page.reload();
    await page.locator('#app:not([hidden])').waitFor();
    assert.equal(await page.locator('#settingsSheet').evaluate((dialog) => dialog.open), false);
    assert.equal(await page.evaluate((key) => sessionStorage.getItem(key), settingsReturnKey), null);
  }

  // Backend changes from another client keep settings open only when already open here.
  await swipeRight(page, '#threadsView');
  await page.locator('#settingsButton').click();
  activeBackend = 'deepseek';
  await page.evaluate(() => window.dispatchBackendChange({ active: 'deepseek', at: new Date().toISOString() }));
  await page.waitForFunction(() => !document.querySelector('#app').hidden
    && document.querySelector('#backendSelect').value === 'deepseek');
  await assertSettingsRestored('deepseek');
  // Android's existing back bridge closes the topmost dialog using close().
  await page.evaluate(() => [...document.querySelectorAll('dialog[open]')].at(-1).close());
  assert.equal(await page.locator('#settingsSheet').evaluate((dialog) => dialog.open), false);
  activeBackend = 'glm';
  await page.evaluate(() => window.dispatchBackendChange({ active: 'glm', at: new Date().toISOString() }));
  await page.waitForFunction(() => !document.querySelector('#app').hidden
    && document.querySelector('#backendSelect').value === 'glm');
  assert.equal(await page.locator('#settingsSheet').evaluate((dialog) => dialog.open), false);

  process.stdout.write(`${JSON.stringify({ switchBodies, result, glmResult, accountRequests, settingsReturn: 'passed' })}\n`);
} finally {
  await browser.close();
}
