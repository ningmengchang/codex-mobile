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
  id: 'thread-1', cwd: '/home/ningmengchang', name: '流式测试', preview: '', status: 'inProgress', updatedAt: 1,
};
const streamingTurn = {
  id: 'turn-1', status: 'inProgress', items: [
    { id: 'user-1', type: 'userMessage', content: [{ type: 'text', text: '我的问题' }] },
  ],
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
    if (pathname === '/api/threads' && route.request().method() === 'GET') return fulfillJson({ data: [thread] });
    if (pathname === '/api/threads/thread-1') {
      return fulfillJson({ thread: { ...thread, turns: [streamingTurn] } });
    }
    if (pathname === '/api/threads/thread-1/resume') {
      return fulfillJson({ thread: { ...thread, turns: [streamingTurn] } });
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

  await page.goto('http://127.0.0.1:39880/', { waitUntil: 'domcontentloaded' });
  await page.locator('#app:not([hidden])').waitFor({ timeout: 15_000 });
  await page.locator('button[data-tab="threads"]').click();
  await page.locator('#mobileThreadList .thread-item').first().click();
  await page.locator('#emptyState').waitFor({ state: 'hidden', timeout: 15_000 });
  await page.locator('.message.user .bubble').waitFor({ timeout: 10_000 });

  await page.evaluate(() => {
    window.__sse.emit('codex', {
      method: 'item/started',
      params: {
        thread_id: 'thread-1', turn_id: 'turn-1',
        item: { id: 'server-user-1', type: 'userMessage', content: [{ type: 'text', text: '我的问题' }] },
      },
    });
  });
  await page.waitForTimeout(100);
  const userCardCount = await page.locator('.message.user').count();
  const serverCardCount = await page.locator('#timeline [data-item-id="server-user-1"]').count();
  if (userCardCount !== 1) throw new Error(`问题卡片重复：${userCardCount}`);
  if (serverCardCount !== 1) throw new Error(`重复问题未合并到服务端 id：${serverCardCount}`);

  await page.evaluate(() => {
    window.__bubbleRef = document.querySelector('.message.user .bubble');
    window.__userCardRef = document.querySelector('.message.user');
  });

  let stable = true;
  let textLength = 0;
  for (let index = 0; index < 10; index += 1) {
    await page.evaluate((delta) => {
      window.__sse.emit('codex', {
        method: 'item/agentMessage/delta',
        params: { thread_id: 'thread-1', turn_id: 'turn-1', item_id: 'agent-1', delta },
      });
    }, `第${index + 1}段`);
    await page.waitForTimeout(30);
    const state = await page.evaluate(() => ({
      bubbleSame: document.querySelector('.message.user .bubble') === window.__bubbleRef,
      cardSame: document.querySelector('.message.user') === window.__userCardRef,
      agentText: document.querySelector('.agent-card')?.textContent ?? '',
      itemCount: document.querySelectorAll('#timeline [data-item-id]').length,
    }));
    stable = stable && state.bubbleSame && state.cardSame;
    textLength = state.agentText.length;
    if (state.itemCount !== 2) throw new Error(`消息节点数量异常：${state.itemCount}`);
  }

  await page.screenshot({ path: process.env.CODEX_MOBILE_SCREENSHOT ?? '/tmp/codex-mobile-stream.png', fullPage: true });
  if (!stable) throw new Error('流式更新过程中问题气泡 DOM 被重建');
  if (textLength < 20) throw new Error(`助手文本未增量累积：${textLength}`);
  process.stdout.write(`${JSON.stringify({ stable, textLength, deltas: 10 })}\n`);
} finally {
  await browser.close();
}
