import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const playwrightPath = process.env.PLAYWRIGHT_PATH
  ?? '/home/ningmengchang/ideaProjects/dpp-cloud-saic/dpp-platform-web/node_modules/playwright';
const { chromium } = require(playwrightPath);

const publicRoot = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'public');
const threadId = 'thread-paged';
const allTurns = Array.from({ length: 55 }, (_, index) => {
  const number = index + 1;
  return {
    id: `p-turn-${number}`,
    status: 'completed',
    durationMs: 1000,
    startedAt: 1_700_000_000 + number * 60,
    completedAt: 1_700_000_000 + number * 60 + 45,
    items: [
      { id: `p-user-${number}`, type: 'userMessage', content: [{ type: 'text', text: `问题${number}` }] },
      { id: `p-agent-${number}`, type: 'agentMessage', text: `回答${number}` },
    ],
  };
});
const thread = {
  id: threadId, cwd: '/proj/paged', name: '分页会话', preview: '', status: 'idle', updatedAt: 1, turns: [],
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
    if (pathname === `/api/threads/${threadId}` && route.request().method() === 'GET') {
      return fulfillJson({ thread });
    }
    if (pathname === `/api/threads/${threadId}/resume`) return fulfillJson({ thread });
    if (pathname === `/api/threads/${threadId}/turns` && route.request().method() === 'GET') {
      const pageSize = Number.parseInt(url.searchParams.get('pageSize') ?? '20', 10);
      const offset = Number.parseInt(url.searchParams.get('cursor') ?? '0', 10);
      const endIndex = allTurns.length - offset;
      const startIndex = Math.max(0, endIndex - pageSize);
      const data = allTurns.slice(startIndex, endIndex).reverse();
      const nextOffset = offset + data.length;
      return fulfillJson({
        data,
        nextCursor: nextOffset < allTurns.length ? String(nextOffset) : null,
      });
    }
    if (pathname === `/api/threads/${threadId}/artifacts`) return fulfillJson({ data: [] });
    if (pathname === '/api/events') return route.fulfill({ status: 200, contentType: 'text/event-stream', body: ': connected\n\n' });
    const file = path.join(publicRoot, pathname === '/' ? 'index.html' : pathname);
    if (!fs.existsSync(file) || !fs.statSync(file).isFile()) return route.fulfill({ status: 404, body: 'not found' });
    const contentType = file.endsWith('.js') ? 'text/javascript; charset=utf-8'
      : file.endsWith('.css') ? 'text/css; charset=utf-8'
        : file.endsWith('.html') ? 'text/html; charset=utf-8'
          : 'application/octet-stream';
    return route.fulfill({ status: 200, contentType, body: fs.readFileSync(file) });
  });

  await page.goto('http://127.0.0.1:39887/', { waitUntil: 'domcontentloaded' });
  await page.locator('#app:not([hidden])').waitFor({ timeout: 15_000 });
  await page.locator('#mobileThreadList .thread-item').first().click();

  // 1) 首屏只渲染最新一页（20 回合），且是最新内容
  await page.waitForFunction(() => document.querySelectorAll('#timeline [data-turn]').length === 20, null, { timeout: 15_000 });
  const firstPageText = await page.locator('#timeline').textContent();
  if (!firstPageText.includes('问题55') || !firstPageText.includes('问题36')) {
    throw new Error('首屏应包含最新 20 个回合');
  }
  if (firstPageText.includes('问题35')) throw new Error('首屏不应包含更早的回合');
  await page.locator('#loadOlderButton:not([hidden])').waitFor({ timeout: 5_000 });
  await page.waitForTimeout(150);

  // 2) 滚动到顶部自动加载更早一页
  await page.evaluate(() => {
    const el = document.querySelector('#chatView');
    el.scrollTop = 0;
    el.dispatchEvent(new Event('scroll'));
  });
  await page.waitForFunction(() => document.querySelectorAll('#timeline [data-turn]').length === 40, null, { timeout: 15_000 });
  const secondPageText = await page.locator('#timeline').textContent();
  if (!secondPageText.includes('问题35') || !secondPageText.includes('问题55')) {
    throw new Error('第二页应包含问题35 且保留最新回合');
  }
  const scrollTopAfterPrepend = await page.evaluate(() => document.querySelector('#chatView').scrollTop);
  if (scrollTopAfterPrepend < 100) throw new Error(`prepend 后滚动位置被重置：${scrollTopAfterPrepend}`);
  await page.locator('#loadOlderButton:not([hidden])').waitFor({ timeout: 5_000 });

  // 3) 点击按钮加载剩余全部，加载完成后显示全局回合编号
  await page.locator('#loadOlderButton').click();
  await page.waitForFunction(() => document.querySelectorAll('#timeline [data-turn]').length === 55, null, { timeout: 15_000 });
  await page.waitForFunction(() => document.querySelector('#loadOlderButton')?.hidden === true, null, { timeout: 5_000 });
  const finalText = await page.locator('#timeline').textContent();
  if (!finalText.includes('问题1') || !finalText.includes('回合 1')) {
    throw new Error('加载全部后应显示最早回合与全局编号');
  }

  // 4) 刷新后固定回到最新问题（不再恢复旧滚动位置）
  await page.evaluate(() => {
    const el = document.querySelector('#chatView');
    el.scrollTop = 0;
    el.dispatchEvent(new Event('scroll'));
  });
  await page.waitForTimeout(300);
  await page.reload({ waitUntil: 'domcontentloaded' });
  await page.locator('#app:not([hidden])').waitFor({ timeout: 15_000 });
  await page.waitForFunction(() => document.querySelectorAll('#timeline [data-turn]').length === 20, null, { timeout: 15_000 });
  await page.waitForTimeout(1200);
  const refreshText = await page.locator('#timeline').textContent();
  if (!refreshText.includes('问题55')) throw new Error('刷新后未显示最新问题');
  const refreshScroll = await page.evaluate(() => {
    const el = document.querySelector('#chatView');
    return { scrollTop: el.scrollTop, scrollHeight: el.scrollHeight, clientHeight: el.clientHeight };
  });
  if (refreshScroll.scrollTop + refreshScroll.clientHeight < refreshScroll.scrollHeight - 60) {
    throw new Error(`刷新后未定位到底部最新：${JSON.stringify(refreshScroll)}`);
  }

  await page.screenshot({ path: process.env.CODEX_MOBILE_SCREENSHOT ?? '/tmp/codex-mobile-turn-pagination.png', fullPage: true });
  process.stdout.write(`${JSON.stringify({ firstTurns: 20, secondTurns: 40, finalTurns: 55, scrollTopAfterPrepend, refreshScroll })}\n`);
} finally {
  await browser.close();
}
