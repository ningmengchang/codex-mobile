import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const playwrightPath = process.env.PLAYWRIGHT_PATH
  ?? '/home/ningmengchang/ideaProjects/dpp-cloud-saic/dpp-platform-web/node_modules/playwright';
const { chromium } = require(playwrightPath);

const publicRoot = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'public');
const threadId = 'thread-1';
const threadMeta = {
  id: threadId, cwd: '/home/ningmengchang', name: '聊天流', preview: '', status: 'idle', updatedAt: 1, turns: [],
};
const allTurns = Array.from({ length: 41 }, (_, index) => {
  const number = index + 1;
  return {
    id: `t-${number}`, status: 'completed', durationMs: 100, items: [
      { id: `u-${number}`, type: 'userMessage', content: [{ type: 'text', text: `问题${number}` }] },
      { id: `a-${number}`, type: 'agentMessage', text: `回答${number}` },
    ],
  };
});
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
    window.__sse = {
      emit(type, data) {
        const event = { data: JSON.stringify(data) };
        for (const callback of listeners.get(type) ?? []) callback(event);
      },
    };
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
    if (pathname === '/api/threads' && route.request().method() === 'GET') return fulfillJson({ data: [threadMeta] });
    if (pathname === `/api/threads/${threadId}` && route.request().method() === 'GET') {
      return fulfillJson({ thread: threadMeta });
    }
    if (pathname === `/api/threads/${threadId}/resume`) return fulfillJson({ thread: threadMeta });
    if (pathname === `/api/threads/${threadId}/turns` && route.request().method() === 'GET') {
      const pageSize = Number.parseInt(url.searchParams.get('pageSize') ?? '20', 10);
      const offset = Number.parseInt(url.searchParams.get('cursor') ?? '0', 10);
      const endIndex = allTurns.length - offset;
      const startIndex = Math.max(0, endIndex - pageSize);
      const data = allTurns.slice(startIndex, endIndex).reverse();
      const nextOffset = offset + data.length;
      return fulfillJson({ data, nextCursor: nextOffset < allTurns.length ? String(nextOffset) : null });
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

  await page.goto('http://127.0.0.1:39893/', { waitUntil: 'domcontentloaded' });
  await page.locator('#app:not([hidden])').waitFor({ timeout: 15_000 });
  await page.locator('#mobileThreadList .thread-item').first().click();
  await page.waitForFunction(() => document.querySelectorAll('#timeline [data-turn]').length === 20, null, { timeout: 15_000 });
  await page.waitForTimeout(200);

  // 1) 新回合追加在底部，旧内容上移，滚动保持底部
  await page.evaluate(() => {
    window.__sse.emit('codex', {
      method: 'turn/started',
      params: { thread_id: 'thread-1', turn_id: 't-42', turn: { id: 't-42', status: 'inProgress', items: [] } },
    });
    window.__sse.emit('codex', {
      method: 'item/agentMessage/delta',
      params: { thread_id: 'thread-1', turn_id: 't-42', item_id: 'a-42', delta: '新结论' },
    });
  });
  await page.waitForTimeout(200);
  const afterAppend = await page.evaluate(() => {
    const el = document.querySelector('#chatView');
    return { scrollTop: el.scrollTop, scrollHeight: el.scrollHeight, clientHeight: el.clientHeight };
  });
  if (afterAppend.scrollTop + afterAppend.clientHeight < afterAppend.scrollHeight - 160) {
    throw new Error(`追加后未保持底部：${JSON.stringify(afterAppend)}`);
  }
  if (await page.locator('#scrollLatestButton').isVisible()) throw new Error('底部跟随中不应显示回到最新');

  // 2) 上翻到历史中部：暂停跟随，新内容到达不拉回底部
  await page.evaluate(() => {
    const el = document.querySelector('#chatView');
    el.scrollTop = 400;
    el.dispatchEvent(new Event('scroll'));
  });
  await page.waitForTimeout(100);
  await page.locator('#scrollLatestButton:not([hidden])').waitFor({ timeout: 5_000 });
  await page.evaluate(() => {
    window.__sse.emit('codex', {
      method: 'item/agentMessage/delta',
      params: { thread_id: 'thread-1', turn_id: 't-42', item_id: 'a-42', delta: '，继续补充' },
    });
  });
  await page.waitForTimeout(200);
  const mid = await page.evaluate(() => {
    const el = document.querySelector('#chatView');
    return { scrollTop: el.scrollTop, scrollHeight: el.scrollHeight, clientHeight: el.clientHeight };
  });
  if (mid.scrollTop + mid.clientHeight >= mid.scrollHeight - 200) {
    throw new Error(`阅读历史时被拉回底部：${JSON.stringify(mid)}`);
  }

  // 3) 点击回到最新：滚到底部并恢复跟随
  await page.locator('#scrollLatestButton').click();
  await page.waitForTimeout(200);
  const latest = await page.evaluate(() => {
    const el = document.querySelector('#chatView');
    return { scrollTop: el.scrollTop, scrollHeight: el.scrollHeight, clientHeight: el.clientHeight };
  });
  if (latest.scrollTop + latest.clientHeight < latest.scrollHeight - 60) {
    throw new Error(`回到最新未生效：${JSON.stringify(latest)}`);
  }
  if (await page.locator('#scrollLatestButton').isVisible()) throw new Error('回到底部后按钮未隐藏');

  // 4) 分页加载更早历史保留：顶部上翻自动加载，位置锚定
  await page.evaluate(() => {
    const el = document.querySelector('#chatView');
    el.scrollTop = 0;
    el.dispatchEvent(new Event('scroll'));
  });
  await page.waitForFunction(() => document.querySelectorAll('#timeline [data-turn]').length === 41, null, { timeout: 15_000 });
  const historyText = await page.locator('#timeline').textContent();
  if (!historyText.includes('问题2')) throw new Error('更早历史未加载');
  if (!historyText.includes('问题41')) throw new Error('最新内容丢失');

  await page.screenshot({ path: process.env.CODEX_MOBILE_SCREENSHOT ?? '/tmp/codex-mobile-chat-flow.png', fullPage: true });
  process.stdout.write(`${JSON.stringify({ afterAppend, mid, latest, sections: 41 })}\n`);
} finally {
  await browser.close();
}
