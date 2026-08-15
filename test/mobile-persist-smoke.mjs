import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const playwrightPath = process.env.PLAYWRIGHT_PATH
  ?? '/home/ningmengchang/ideaProjects/dpp-cloud-saic/dpp-platform-web/node_modules/playwright';
const { chromium } = require(playwrightPath);

const publicRoot = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'public');
const thread = {
  id: 'thread-1', cwd: '/home/ningmengchang', name: '测试会话', preview: '', status: 'idle', updatedAt: 1,
};
const messages = Array.from({ length: 25 }, (_, index) => ({
  id: `message-${index + 1}`, type: 'agentMessage', text: `第 ${index + 1} 行内容，用于让页面可以滚动。`,
}));
const historyTurn = { id: 'turn-1', status: 'completed', durationMs: 1000, items: messages };
const bootstrap = {
  appServer: { ready: true },
  runtime: { user: 'ningmengchang' },
  models: [
    { id: 'gpt-5.6-sol', displayName: 'GPT-5.6-Sol' },
    { id: 'gpt-5.6-terra', displayName: 'GPT-5.6-Terra' },
  ],
  defaultModel: 'gpt-5.6-sol',
  defaultEffort: 'max',
  collaborationModes: [],
  pendingRequests: [],
  projects: { current: { name: 'home', path: '/home/ningmengchang' }, parent: null, entries: [] },
};

const browser = await chromium.launch({ headless: true });
try {
  const context = await browser.newContext({
    viewport: { width: 390, height: 844 }, deviceScaleFactor: 2, isMobile: true, hasTouch: true,
  });
  await context.addInitScript((boot) => {
    try {
      const marker = 'codex-mobile-test-stale-model-seeded';
      if (!sessionStorage.getItem(marker)) {
        localStorage.setItem('codex-mobile-model', 'deepseek-v4-flash');
        sessionStorage.setItem(marker, '1');
      }
    } catch {}
    const listeners = new Map();
    class FakeEventSource {
      constructor() {
        setTimeout(() => this.onopen?.(), 30);
      }
      addEventListener(type, callback) {
        if (!listeners.has(type)) listeners.set(type, []);
        listeners.get(type).push(callback);
      }
      close() {}
    }
    window.EventSource = FakeEventSource;
  }, bootstrap);
  const page = await context.newPage();
  await page.route('**/*', async (route) => {
    const url = new URL(route.request().url());
    const pathname = url.pathname;
    const fulfillJson = (body, status = 200) => route.fulfill({
      status, contentType: 'application/json; charset=utf-8', body: JSON.stringify(body),
    });
    if (pathname === '/api/auth/status') return fulfillJson({ authenticated: true });
    if (pathname === '/api/bootstrap') return fulfillJson(bootstrap);
    if (pathname === '/api/requests') return fulfillJson({ data: [] });
    if (pathname === '/api/projects') return fulfillJson(bootstrap.projects);
    if (pathname === '/api/threads' && route.request().method() === 'GET') return fulfillJson({ data: [thread] });
    if (pathname === '/api/threads/thread-1') return fulfillJson({ thread: { ...thread, turns: [historyTurn] } });
    if (pathname === '/api/threads/thread-1/resume') {
      return fulfillJson({ thread: { ...thread, turns: [historyTurn] } });
    }
    if (pathname === '/api/threads/thread-1/artifacts') return fulfillJson({ data: [] });
    if (pathname === '/api/events') return route.fulfill({ status: 200, contentType: 'text/event-stream', body: ': connected\n\n' });
    const file = path.join(publicRoot, pathname === '/' ? 'index.html' : pathname);
    if (!fs.existsSync(file) || !fs.statSync(file).isFile()) return route.fulfill({ status: 404, body: 'not found' });
    const contentType = file.endsWith('.js') ? 'text/javascript; charset=utf-8'
      : file.endsWith('.css') ? 'text/css; charset=utf-8'
        : file.endsWith('.html') ? 'text/html; charset=utf-8'
          : 'application/octet-stream';
    return route.fulfill({ status: 200, contentType, body: fs.readFileSync(file) });
  });

  await page.goto('http://127.0.0.1:39878/', { waitUntil: 'domcontentloaded' });
  await page.locator('#app:not([hidden])').waitFor({ timeout: 15_000 });
  if (await page.locator('#modelSelect').inputValue() !== 'gpt-5.6-sol') {
    throw new Error('首次加载未默认选中 gpt-5.6-sol');
  }
  if (await page.evaluate(() => localStorage.getItem('codex-mobile-model')) !== null) {
    throw new Error('无效的历史 DeepSeek 模型选择未被清理');
  }
  if (await page.locator('#effortSelect').inputValue() !== 'max') {
    throw new Error('首次加载未默认选中 Max');
  }
  await page.locator('#settingsButton').click();
  await page.locator('#settingsSheet[open]').waitFor({ timeout: 5_000 });
  await page.locator('#modelSelect').selectOption('gpt-5.6-terra');
  await page.locator('#effortSelect').selectOption('high');
  await page.locator('#closeSettingsButton').click();
  await page.waitForFunction(() => !document.querySelector('#settingsSheet')?.hasAttribute('open'));
  await page.locator('button[data-tab="threads"]').click();
  await page.locator('#mobileThreadList .thread-item').first().click();
  await page.locator('#emptyState').waitFor({ state: 'hidden', timeout: 15_000 });
  await page.locator('.message').first().waitFor({ timeout: 10_000 });

  await page.locator('#promptInput').fill('草稿内容');
  await page.evaluate(() => document.activeElement?.blur());
  await page.waitForFunction(() => !document.body.classList.contains('keyboard-open'));
  await page.locator('button[data-tab="artifacts"]').click();
  await page.waitForTimeout(200);
  await page.reload({ waitUntil: 'domcontentloaded' });
  await page.locator('#app:not([hidden])').waitFor({ timeout: 15_000 });
  await page.locator('#emptyState').waitFor({ state: 'hidden', timeout: 15_000 });
  if (await page.locator('#modelSelect').inputValue() !== 'gpt-5.6-terra') {
    throw new Error('刷新后模型选择未保持 gpt-5.6-terra');
  }
  if (await page.locator('#effortSelect').inputValue() !== 'high') {
    throw new Error('刷新后推理强度未保持 high');
  }
  const afterReload = {
    tab: await page.locator('.bottom-nav button.active').getAttribute('data-tab'),
    draft: await page.locator('#promptInput').inputValue(),
    threadOpened: await page.locator('#emptyState').isHidden(),
  };

  await page.locator('button[data-tab="chat"]').click();
  await page.locator('.message').first().waitFor({ timeout: 10_000 });
  await page.locator('#chatView').evaluate((element) => { element.scrollTop = 400; });
  await page.waitForTimeout(300);
  await page.reload({ waitUntil: 'domcontentloaded' });
  await page.locator('#app:not([hidden])').waitFor({ timeout: 15_000 });
  await page.locator('#emptyState').waitFor({ state: 'hidden', timeout: 15_000 });
  await page.locator('.message').first().waitFor({ timeout: 10_000 });
  await page.waitForTimeout(1200);
  if (await page.locator('#modelSelect').inputValue() !== 'gpt-5.6-terra') {
    throw new Error('第二次刷新后模型选择未保持 gpt-5.6-terra');
  }
  if (await page.locator('#effortSelect').inputValue() !== 'high') {
    throw new Error('第二次刷新后推理强度未保持 high');
  }
  const afterScrollReload = {
    tab: await page.locator('.bottom-nav button.active').getAttribute('data-tab'),
    draft: await page.locator('#promptInput').inputValue(),
    scrollTop: await page.locator('#chatView').evaluate((element) => element.scrollTop),
    scrollHeight: await page.locator('#chatView').evaluate((element) => element.scrollHeight),
    clientHeight: await page.locator('#chatView').evaluate((element) => element.clientHeight),
  };
  await page.screenshot({ path: process.env.CODEX_MOBILE_SCREENSHOT ?? '/tmp/codex-mobile-persist.png', fullPage: true });

  if (afterReload.tab !== 'artifacts') throw new Error(`页签未恢复：${afterReload.tab}`);
  if (afterReload.draft !== '草稿内容') throw new Error(`草稿未恢复：${afterReload.draft}`);
  if (!afterReload.threadOpened) throw new Error('会话未自动打开');
  if (afterScrollReload.tab !== 'chat') throw new Error(`第二页签未恢复：${afterScrollReload.tab}`);
  if (afterScrollReload.draft !== '草稿内容') throw new Error(`第二次草稿未恢复：${afterScrollReload.draft}`);
  if (afterScrollReload.scrollTop + afterScrollReload.clientHeight < afterScrollReload.scrollHeight - 60) {
    throw new Error(`刷新后未定位到最新：${JSON.stringify(afterScrollReload)}`);
  }
  await page.evaluate(() => localStorage.clear());
  await page.reload({ waitUntil: 'domcontentloaded' });
  await page.locator('#app:not([hidden])').waitFor({ timeout: 15_000 });
  if (await page.locator('#modelSelect').inputValue() !== 'gpt-5.6-sol') {
    throw new Error('清空本地存储后未回到默认 gpt-5.6-sol');
  }
  if (await page.locator('#effortSelect').inputValue() !== 'max') {
    throw new Error('清空本地存储后未回到默认 Max');
  }
  process.stdout.write(`${JSON.stringify({ afterReload, afterScrollReload, modelReset: true })}\n`);
} finally {
  await browser.close();
}
