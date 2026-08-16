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
  id: threadId, cwd: '/home/ningmengchang', name: '竞态测试', preview: '', status: 'idle', updatedAt: 1, turns: [],
};
const planTurn = {
  id: 'turn-1', status: 'completed', durationMs: 1000, items: [
    { id: 'user-1', type: 'userMessage', content: [{ type: 'text', text: '请给出规划方案' }] },
    { id: 'plan-1', type: 'plan', text: '第一步：梳理需求。' },
    { id: 'structured-plan-turn-1', type: 'structuredPlan', explanation: '方案说明', plan: [{ step: '调研', status: 'completed' }] },
    { id: 'agent-1', type: 'agentMessage', text: '规划结论' },
  ],
};
const staleTurn = {
  id: 'turn-1', status: 'inProgress', durationMs: null, items: [
    { id: 'user-1', type: 'userMessage', content: [{ type: 'text', text: '请给出规划方案' }] },
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
    let openCallback = null;
    class FakeEventSource {
      constructor() {
        openCallback = () => this.onopen?.();
        setTimeout(() => this.onopen?.(), 800);
      }
      addEventListener(type, callback) {
        if (!listeners.has(type)) listeners.set(type, []);
        listeners.get(type).push(callback);
      }
      close() {}
    }
    window.EventSource = FakeEventSource;
    window.__sse = {
      triggerOpen() { openCallback?.(); },
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
      if (turnsCalls === 1) return fulfillJson({ data: [], nextCursor: null });
      if (turnsCalls === 2) {
        await new Promise((resolve) => setTimeout(resolve, 500));
        return fulfillJson({ data: [staleTurn], nextCursor: null });
      }
      return fulfillJson({ data: [planTurn], nextCursor: null });
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

  await page.goto('http://127.0.0.1:39889/', { waitUntil: 'domcontentloaded' });
  await page.locator('#app:not([hidden])').waitFor({ timeout: 15_000 });
  await page.locator('#mobileThreadList .thread-item').first().click();
  await page.waitForTimeout(1750);

  // 抑制窗口结束后触发 onopen：旧后台刷新（turnsCalls=2，延迟 500ms，快照不含方案）正在途中
  await page.evaluate(() => window.__sse.triggerOpen());
  await page.waitForTimeout(50);
  await page.evaluate(() => {
    window.__sse.emit('codex', {
      method: 'turn/started',
      params: { thread_id: 'thread-1', turn_id: 'turn-1', turn: { id: 'turn-1', status: 'inProgress', items: [] } },
    });
    window.__sse.emit('codex', {
      method: 'item/plan/delta',
      params: { thread_id: 'thread-1', turn_id: 'turn-1', item_id: 'plan-1', delta: '第一步：梳理需求。' },
    });
    window.__sse.emit('codex', {
      method: 'turn/plan/updated',
      params: {
        thread_id: 'thread-1', turn_id: 'turn-1', explanation: '方案说明',
        plan: [{ step: '调研', status: 'completed' }],
      },
    });
    window.__sse.emit('codex', {
      method: 'item/agentMessage/delta',
      params: { thread_id: 'thread-1', turn_id: 'turn-1', item_id: 'agent-1', delta: '规划结论' },
    });
    window.__sse.emit('codex', {
      method: 'turn/completed',
      params: { thread_id: 'thread-1', turn_id: 'turn-1', turn: { id: 'turn-1', status: 'completed' } },
    });
  });

  await page.locator('details.plan-card').waitFor({ timeout: 10_000 });
  await page.locator('#planDecisionBar:not([hidden])').waitFor({ timeout: 10_000 });
  await page.locator('.agent-card', { hasText: '规划结论' }).waitFor({ timeout: 10_000 });

  // 旧快照返回后不应覆盖方案；force 刷新拿到最终快照
  await page.waitForTimeout(700);
  const finalPlanVisible = await page.locator('details.plan-card').isVisible();
  const decisionVisible = await page.locator('#planDecisionBar').isVisible();
  const agentText = await page.locator('.message > .agent-card').first().textContent();
  if (!finalPlanVisible || !decisionVisible || !agentText.includes('规划结论') || turnsCalls < 3) {
    throw new Error(`方案被旧刷新覆盖：${JSON.stringify({ finalPlanVisible, decisionVisible, agentText, turnsCalls })}`);
  }

  await page.screenshot({ path: process.env.CODEX_MOBILE_SCREENSHOT ?? '/tmp/codex-mobile-plan-race.png', fullPage: true });
  process.stdout.write(`${JSON.stringify({ finalPlanVisible, decisionVisible, agentText, turnsCalls })}\n`);
} finally {
  await browser.close();
}
