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
  id: threadId, cwd: '/home/ningmengchang', name: '发送竞态', preview: '', status: 'idle', updatedAt: 1, turns: [],
};
const historyTurn = {
  id: 'turn-0', status: 'completed', durationMs: 100, items: [
    { id: 'hist-user', type: 'userMessage', content: [{ type: 'text', text: '历史问题' }] },
    { id: 'hist-agent', type: 'agentMessage', text: '历史回答' },
  ],
};
const bootstrap = {
  appServer: { ready: true },
  runtime: { user: 'ningmengchang' },
  models: [{ id: 'test-model', displayName: 'Test', isDefault: true }],
  collaborationModes: [{ name: 'Default', mode: 'default' }],
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
      return fulfillJson({ data: [historyTurn], nextCursor: null });
    }
    if (pathname === `/api/threads/${threadId}/turns` && route.request().method() === 'POST') {
      await new Promise((resolve) => setTimeout(resolve, 500));
      return fulfillJson({
        turn: { id: 'turn-9', status: 'inProgress', items: [] },
        thread: { id: threadId, cwd: '/home/ningmengchang' },
        recreated: false,
      }, 201);
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

  await page.goto('http://127.0.0.1:39890/', { waitUntil: 'domcontentloaded' });
  await page.locator('#app:not([hidden])').waitFor({ timeout: 15_000 });
  await page.locator('#mobileThreadList .thread-item').first().click();
  await page.waitForFunction(() => document.querySelector('#timeline')?.textContent?.includes('历史问题'), null, { timeout: 10_000 });

  // 真实规划回复可以只有普通 final_answer，不一定产生 plan / structuredPlan 工具事件。
  await page.locator('#modeSwitch button[data-mode="plan"]').click();
  await page.locator('#promptInput').fill('请给我方案');
  await page.locator('#sendButton').click();
  await page.evaluate(() => {
    window.__sse.emit('codex', {
      method: 'turn/started',
      params: { thread_id: 'thread-1', turn_id: 'turn-9', turn: { id: 'turn-9', status: 'inProgress', items: [] } },
    });
    window.__sse.emit('codex', {
      method: 'item/agentMessage/delta',
      params: { thread_id: 'thread-1', turn_id: 'turn-9', item_id: 'agent-1', delta: '这是结论' },
    });
    window.__sse.emit('codex', {
      method: 'turn/completed',
      params: { thread_id: 'thread-1', turn_id: 'turn-9', turn: { id: 'turn-9', status: 'completed' } },
    });
  });

  await page.locator('#planDecisionBar:not([hidden])').waitFor({ timeout: 10_000 });
  await page.waitForTimeout(900); // 等 POST 返回并完成合并

  const decisionVisible = await page.locator('#planDecisionBar').isVisible();
  const agentText = await page.locator('.message > .agent-card').last().textContent();
  const timelineText = await page.locator('#timeline').textContent();
  if (!decisionVisible) throw new Error('只有普通最终回复时，方案已形成卡片未显示');
  if (!agentText.includes('这是结论')) throw new Error(`结论丢失：${agentText}`);
  if (!timelineText.includes('历史问题')) throw new Error('历史回合被清空');

  await page.screenshot({ path: process.env.CODEX_MOBILE_SCREENSHOT ?? '/tmp/codex-mobile-send-plan-race.png', fullPage: true });
  process.stdout.write(`${JSON.stringify({ decisionVisible, agentText, historyKept: timelineText.includes('历史问题') })}\n`);
} finally {
  await browser.close();
}
