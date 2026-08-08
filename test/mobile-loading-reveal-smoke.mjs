import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const playwrightPath = process.env.PLAYWRIGHT_PATH
  ?? '/home/ningmengchang/ideaProjects/dpp-cloud-saic/dpp-platform-web/node_modules/playwright';
const { chromium } = require(playwrightPath);

const publicRoot = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'public');
const allTurns = Array.from({ length: 21 }, (_, index) => {
  const number = index + 1;
  return {
    id: `t-${number}`, status: 'completed', durationMs: 100, items: [
      { id: `u-${number}`, type: 'userMessage', content: [{ type: 'text', text: `问题${number}` }] },
      { id: `a-${number}`, type: 'agentMessage', text: `回答${number}` },
    ],
  };
});
const threadMeta = {
  id: 'thread-1', cwd: '/home/ningmengchang', name: '加载展示', preview: '', status: 'idle', updatedAt: 1, turns: allTurns,
};
const bootstrap = {
  appServer: { ready: true },
  runtime: { user: 'ningmengchang' },
  models: [],
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
    const listeners = new Map();
    class FakeEventSource {
      constructor() { setTimeout(() => this.onopen?.(), 30); }
      addEventListener(type, callback) {
        if (!listeners.has(type)) listeners.set(type, []);
        listeners.get(type).push(callback);
      }
      close() {}
    }
    window.EventSource = FakeEventSource;
    window.__boot = boot;
  }, bootstrap);
  const page = await context.newPage();
  await page.route('**/*', async (route) => {
    const pathname = new URL(route.request().url()).pathname;
    const fulfillJson = (body, status = 200) => route.fulfill({
      status, contentType: 'application/json; charset=utf-8', body: JSON.stringify(body),
    });
    if (pathname === '/api/auth/status') return fulfillJson({ authenticated: true });
    if (pathname === '/api/bootstrap') return fulfillJson(bootstrap);
    if (pathname === '/api/requests') return fulfillJson({ data: [] });
    if (pathname === '/api/projects') return fulfillJson(bootstrap.projects);
    if (pathname === '/api/threads' && route.request().method() === 'GET') return fulfillJson({ data: [threadMeta] });
    if (pathname === '/api/threads/thread-1' && route.request().method() === 'GET') {
      await new Promise((resolve) => setTimeout(resolve, 300));
      return fulfillJson({ thread: threadMeta });
    }
    if (pathname === '/api/threads/thread-1/resume') return fulfillJson({ thread: threadMeta });
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

  async function openAndAssertLoading() {
    await page.locator('#threadLoading:not([hidden])').waitFor({ timeout: 2_000 });
    // 分块渲染开始后：时间线必须带隐藏类（不允许露出部分历史）
    await page.waitForFunction(() => document.querySelectorAll('#timeline [data-turn]').length > 0, null, { timeout: 10_000 });
    const hidingDuringRender = await page.evaluate(() => document.querySelector('#timeline').classList.contains('timeline-rendering'));
    if (!hidingDuringRender) throw new Error('渲染过程中时间线未隐藏');
    // 渲染完成：遮罩关闭、隐藏类移除、停在最新
    await page.waitForFunction(() => document.querySelector('#threadLoading')?.hidden === true, null, { timeout: 10_000 });
    const revealed = await page.evaluate(() => ({
      hiding: document.querySelector('#timeline').classList.contains('timeline-rendering'),
      scrollTop: document.querySelector('#chatView').scrollTop,
      scrollHeight: document.querySelector('#chatView').scrollHeight,
      clientHeight: document.querySelector('#chatView').clientHeight,
    }));
    if (revealed.hiding) throw new Error(`渲染完成后时间线仍隐藏：${JSON.stringify(revealed)}`);
    if (revealed.scrollTop + revealed.clientHeight < revealed.scrollHeight - 60) {
      throw new Error(`渲染完成后未停在最新：${JSON.stringify(revealed)}`);
    }
    const text = await page.locator('#timeline').textContent();
    if (!text.includes('问题21')) throw new Error('最新问题不可见');
  }

  await page.goto('http://127.0.0.1:39895/', { waitUntil: 'domcontentloaded' });
  await page.locator('#app:not([hidden])').waitFor({ timeout: 15_000 });
  await page.locator('button[data-tab="threads"]').click();
  await page.locator('#mobileThreadList .thread-item').first().click();
  await openAndAssertLoading();

  // 刷新后同样先加载后展示，且最终停在最新
  await page.reload({ waitUntil: 'domcontentloaded' });
  await page.locator('#app:not([hidden])').waitFor({ timeout: 15_000 });
  await openAndAssertLoading();

  await page.screenshot({ path: process.env.CODEX_MOBILE_SCREENSHOT ?? '/tmp/codex-mobile-loading-reveal.png', fullPage: true });
  process.stdout.write(JSON.stringify({ firstLoadOk: true, reloadOk: true }));
} finally {
  await browser.close();
}
