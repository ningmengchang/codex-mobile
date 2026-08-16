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
  id: threadId, cwd: '/home/ningmengchang', name: '分块滚动', preview: '', status: 'idle', updatedAt: 1, turns: [],
};
const allTurns = Array.from({ length: 21 }, (_, index) => {
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
    const pathname = new URL(route.request().url()).pathname;
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
      return fulfillJson({ data: [...allTurns].reverse(), nextCursor: null });
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

  await page.goto('http://127.0.0.1:39892/', { waitUntil: 'domcontentloaded' });
  await page.locator('#app:not([hidden])').waitFor({ timeout: 15_000 });
  await page.locator('#mobileThreadList .thread-item').first().click();
  await page.waitForFunction(() => document.querySelectorAll('#timeline [data-turn]').length === 21, null, { timeout: 15_000 });
  await page.waitForTimeout(200);

  const bottom = await page.evaluate(() => {
    const el = document.querySelector('#chatView');
    return { scrollTop: el.scrollTop, scrollHeight: el.scrollHeight, clientHeight: el.clientHeight };
  });
  if (bottom.scrollTop + bottom.clientHeight < bottom.scrollHeight - 60) {
    throw new Error(`打开后未停在底部：${JSON.stringify(bottom)}`);
  }

  // 新回合到达：增量追加，滚动保持底部，不跳顶部
  await page.evaluate(() => {
    window.__sse.emit('codex', {
      method: 'turn/started',
      params: { thread_id: 'thread-1', turn_id: 't-22', turn: { id: 't-22', status: 'inProgress', items: [] } },
    });
  });
  await page.waitForTimeout(30);
  const sample1 = await page.evaluate(() => {
    const el = document.querySelector('#chatView');
    return { scrollTop: el.scrollTop, scrollHeight: el.scrollHeight, clientHeight: el.clientHeight };
  });
  await page.waitForTimeout(100);
  const sample2 = await page.evaluate(() => {
    const el = document.querySelector('#chatView');
    return { scrollTop: el.scrollTop, scrollHeight: el.scrollHeight, clientHeight: el.clientHeight };
  });
  for (const sample of [sample1, sample2]) {
    if (sample.scrollTop < 100) throw new Error(`新回合到达后跳到了顶部：${JSON.stringify(sample)}`);
    if (sample.scrollTop + sample.clientHeight < sample.scrollHeight - 160) {
      throw new Error(`新回合到达后未保持在底部：${JSON.stringify(sample)}`);
    }
  }
  const sections = await page.locator('#timeline [data-turn]').count();
  if (sections !== 22) throw new Error(`新回合未追加：${sections}`);
  const firstStillThere = await page.locator('#timeline').textContent().then((text) => text.includes('问题1'));
  if (!firstStillThere) throw new Error('旧内容未保留');

  await page.screenshot({ path: process.env.CODEX_MOBILE_SCREENSHOT ?? '/tmp/codex-mobile-chunk-scroll.png', fullPage: true });
  process.stdout.write(`${JSON.stringify({ bottom, sample1, sample2, sections })}\n`);
} finally {
  await browser.close();
}
