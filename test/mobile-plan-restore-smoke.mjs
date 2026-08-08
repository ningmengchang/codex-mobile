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
  id: 'thread-1', cwd: '/home/ningmengchang', name: '方案恢复测试', preview: '', status: 'idle', updatedAt: 1,
};
const inProgressTurn = {
  id: 'turn-1', status: 'inProgress', items: [
    { id: 'user-1', type: 'userMessage', content: [{ type: 'text', text: '我的问题' }] },
  ],
};
const completedPlanTurn = {
  id: 'turn-1', status: 'completed', items: [
    { id: 'user-1', type: 'userMessage', content: [{ type: 'text', text: '我的问题' }] },
    { id: 'plan-1', type: 'plan', text: '第一步：梳理需求。' },
    {
      id: 'structured-plan-turn-1', type: 'structuredPlan', explanation: '方案说明',
      plan: [{ step: '调研', status: 'completed' }],
    },
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
  let threadReadCount = 0;
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
    if (pathname === '/api/threads/thread-1' && route.request().method() === 'GET') {
      threadReadCount += 1;
      const turns = threadReadCount === 1 ? [inProgressTurn] : [completedPlanTurn];
      return fulfillJson({ thread: { ...thread, turns } });
    }
    if (pathname === '/api/threads/thread-1/resume') {
      return fulfillJson({ thread: { ...thread, turns: [completedPlanTurn] } });
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

  await page.goto('http://127.0.0.1:39881/', { waitUntil: 'domcontentloaded' });
  await page.locator('#app:not([hidden])').waitFor({ timeout: 15_000 });
  await page.locator('button[data-tab="threads"]').click();
  await page.locator('#mobileThreadList .thread-item').first().click();
  await page.waitForFunction(() => Boolean(document.querySelector('#timeline [data-turn="turn-1"]')), null, { timeout: 15_000 });

  await page.evaluate(() => {
    window.__sse.emit('codex', {
      method: 'turn/started',
      params: { thread_id: 'thread-1', turn_id: 'turn-1', turn: { id: 'turn-1', status: 'inProgress', items: [] } },
    });
    window.__sse.emit('codex', {
      method: 'turn/completed',
      params: { thread_id: 'thread-1', turn_id: 'turn-1', turn: { id: 'turn-1', status: 'completed', items: [] } },
    });
  });

  await page.locator('#planDecisionBar:not([hidden])').waitFor({ timeout: 10_000 });
  const planCards = await page.locator('article.plan-card, details.plan-card').count();
  const decisionVisible = await page.locator('#planDecisionBar').isVisible();
  await page.screenshot({ path: process.env.CODEX_MOBILE_SCREENSHOT ?? '/tmp/codex-mobile-plan-restore.png', fullPage: true });
  if (planCards < 1) throw new Error(`方案卡片未恢复：${planCards}`);
  if (!decisionVisible) throw new Error('确认实施卡片未恢复');
  if (threadReadCount < 2) throw new Error(`回合完成后未重新读取会话：${threadReadCount}`);
  process.stdout.write(`${JSON.stringify({ planCards, decisionVisible, threadReadCount })}\n`);
} finally {
  await browser.close();
}
