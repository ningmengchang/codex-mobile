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
  id: threadId, cwd: '/home/ningmengchang', name: '去重测试', preview: '', status: 'idle', updatedAt: 1, turns: [],
};
const serverTurn = {
  id: 'turn-1', status: 'completed', durationMs: 100, items: [
    { id: 'user-1', type: 'userMessage', content: [{ type: 'text', text: '问题' }] },
    { id: 'srv-agent', type: 'agentMessage', text: '这是结论' },
    { id: 'srv-plan', type: 'plan', text: '方案文本' },
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
      constructor() { setTimeout(() => this.onopen?.(), 800); }
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
  let turnsCalls = 0;
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
      turnsCalls += 1;
      return fulfillJson({ data: turnsCalls === 1 ? [] : [serverTurn], nextCursor: null });
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

  await page.goto('http://127.0.0.1:39891/', { waitUntil: 'domcontentloaded' });
  await page.locator('#app:not([hidden])').waitFor({ timeout: 15_000 });
  await page.locator('#mobileThreadList .thread-item').first().click();
  await page.waitForTimeout(300);

  // SSE 先推同一结论（流式 id），随后 onopen（800ms）触发刷新合并（服务端规范 id）
  await page.evaluate(() => {
    window.__sse.emit('codex', {
      method: 'turn/started',
      params: { thread_id: 'thread-1', turn_id: 'turn-1', turn: { id: 'turn-1', status: 'inProgress', items: [] } },
    });
    window.__sse.emit('codex', {
      method: 'item/agentMessage/delta',
      params: { thread_id: 'thread-1', turn_id: 'turn-1', item_id: 'sse-agent', delta: '这是结论' },
    });
    window.__sse.emit('codex', {
      method: 'turn/completed',
      params: { thread_id: 'thread-1', turn_id: 'turn-1', turn: { id: 'turn-1', status: 'completed' } },
    });
  });
  await page.waitForTimeout(200);
  const beforeRefresh = await page.locator('.message > .agent-card').count();
  if (beforeRefresh !== 1) throw new Error(`SSE 后结论卡片数量异常：${beforeRefresh}`);

  await page.waitForTimeout(800); // 等回合完成后的强制刷新合并完成
  const agentCount = await page.locator('.message > .agent-card').count();
  const agentText = await page.locator('.message > .agent-card').first().textContent();
  const planCount = await page.locator('details.plan-card').count();
  if (agentCount !== 1) throw new Error(`刷新合并后结论卡片重复：${agentCount}`);
  if (!agentText.includes('这是结论')) throw new Error(`结论文本异常：${agentText}`);
  if (planCount !== 1) throw new Error(`方案卡片重复或缺失：${planCount}`);
  if (turnsCalls < 2) throw new Error(`强制刷新未发生：${turnsCalls}`);

  await page.screenshot({ path: process.env.CODEX_MOBILE_SCREENSHOT ?? '/tmp/codex-mobile-duplicate-card.png', fullPage: true });
  process.stdout.write(`${JSON.stringify({ beforeRefresh, agentCount, planCount, turnsCalls })}\n`);
} finally {
  await browser.close();
}
