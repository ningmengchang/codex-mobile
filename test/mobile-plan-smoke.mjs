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
  const planSnapshot1 = {
    id: 'turn-1', status: 'completed', items: [
      { id: 'plan-1', type: 'plan', text: '第一步：梳理需求。' },
      {
        id: 'structured-plan-turn-1', type: 'structuredPlan', explanation: '方案说明',
        plan: [{ step: '调研', status: 'completed' }, { step: '实施', status: 'in_progress' }],
      },
    ],
  };
  const planSnapshot2 = {
    id: 'turn-2', status: 'completed', items: [
      { id: 'plan-2', type: 'plan', text: '第二步：落地实现。' },
      {
        id: 'structured-plan-turn-2', type: 'structuredPlan', explanation: '第二版方案',
        plan: [{ step: 'A', status: 'pending' }],
      },
    ],
  };
  const planSnapshot3 = {
    id: 'turn-3', status: 'completed', items: [
      { id: 'msg-3', type: 'agentMessage', text: '实施完成' },
    ],
  };
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
      const turns = threadReadCount === 1 ? []
        : threadReadCount === 2 ? [planSnapshot1]
          : threadReadCount === 3 ? [planSnapshot1, planSnapshot2]
            : [planSnapshot1, planSnapshot2, planSnapshot3];
      return fulfillJson({ thread: { ...thread, turns } });
    }
    if (pathname === '/api/threads/thread-1/resume') {
      return fulfillJson({ thread: { ...thread, turns: [] } });
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
  await page.goto('http://127.0.0.1:39877/', { waitUntil: 'domcontentloaded' });
  await page.locator('#app:not([hidden])').waitFor({ timeout: 15_000 });
  await page.locator('button[data-tab="threads"]').click();
  await page.locator('#mobileThreadList .thread-item').first().click();
  await page.locator('#emptyState').waitFor({ state: 'hidden', timeout: 15_000 });
  await page.waitForTimeout(300);

  await page.evaluate(() => {
    window.__sse.emit('codex', {
      method: 'turn/started',
      params: {
        thread_id: 'thread-1', turn_id: 'turn-1',
        turn: { id: 'turn-1', status: 'inProgress', items: [] },
      },
    });
    window.__sse.emit('codex', {
      method: 'item/plan/delta',
      params: {
        thread_id: 'thread-1', turn_id: 'turn-1', item_id: 'plan-1', delta: '第一步：梳理需求。',
      },
    });
    window.__sse.emit('codex', {
      method: 'turn/plan/updated',
      params: {
        thread_id: 'thread-1', turn_id: 'turn-1', explanation: '方案说明',
        plan: [{ step: '调研', status: 'completed' }, { text: '实施', state: 'in_progress' }],
      },
    });
    window.__sse.emit('codex', {
      method: 'turn/completed',
      params: {
        thread_id: 'thread-1', turn_id: 'turn-1', turn: { id: 'turn-1', status: 'completed', items: [] },
      },
    });
  });

  await page.locator('article.plan-card').first().waitFor({ timeout: 10_000 });
  await page.locator('#planDecisionBar:not([hidden])').waitFor({ timeout: 5_000 });
  const first = {
    planCards: await page.locator('article.plan-card').count(),
    draftCards: await page.locator('details.plan-card').count(),
    explanation: await page.locator('.plan-explanation').first().textContent(),
    steps: await page.locator('.plan-step').evaluateAll((items) => items.map((item) => ({
      text: item.querySelector('span')?.textContent ?? '',
      status: item.getAttribute('data-status'),
      icon: item.querySelector('i')?.textContent,
    }))),
    draftText: await page.locator('details.plan-card').first().textContent(),
    draftFontSize: await page.evaluate(() => {
      const el = document.querySelector('details.plan-card .tool-content.agent-card');
      return el ? getComputedStyle(el).fontSize : null;
    }),
    stepFontSize: await page.evaluate(() => {
      const el = document.querySelector('.plan-step');
      return el ? getComputedStyle(el).fontSize : null;
    }),
    decisionVisible: await page.locator('#planDecisionBar').isVisible(),
  };
  if (first.draftFontSize !== '14px') throw new Error(`方案草案字号异常：${first.draftFontSize}`);
  if (first.stepFontSize !== '12px') throw new Error(`方案步骤字号异常：${first.stepFontSize}`);

  await page.evaluate(() => {
    window.__sse.emit('codex', {
      method: 'turn/started',
      params: {
        threadId: 'thread-1', turnId: 'turn-2',
        turn: { id: 'turn-2', status: 'inProgress', items: [] },
      },
    });
    window.__sse.emit('codex', {
      method: 'item/plan/delta',
      params: {
        threadId: 'thread-1', turnId: 'turn-2', itemId: 'plan-2', delta: '第二步：落地实现。',
      },
    });
    window.__sse.emit('codex', {
      method: 'turn/plan/updated',
      params: {
        threadId: 'thread-1', turnId: 'turn-2', explanation: '第二版方案',
        plan: [{ step: 'A', status: 'pending' }],
      },
    });
    window.__sse.emit('codex', {
      method: 'turn/completed',
      params: {
        threadId: 'thread-1', turnId: 'turn-2', turn: { id: 'turn-2', status: 'completed' },
      },
    });
  });
  await page.locator('article.plan-card').nth(1).waitFor({ timeout: 10_000 });
  const second = {
    planCards: await page.locator('article.plan-card').count(),
    draftCards: await page.locator('details.plan-card').count(),
    steps: await page.locator('article.plan-card').nth(1).locator('.plan-step span').allTextContents(),
    decisionVisible: await page.locator('#planDecisionBar').isVisible(),
    scrollWidth: await page.evaluate(() => document.documentElement.scrollWidth),
    width: await page.evaluate(() => innerWidth),
  };

  await page.evaluate(() => {
    window.__sse.emit('codex', {
      method: 'turn/started',
      params: {
        threadId: 'thread-1', turnId: 'turn-3',
        turn: { id: 'turn-3', status: 'inProgress', items: [] },
      },
    });
    window.__sse.emit('codex', {
      method: 'item/agentMessage/delta',
      params: {
        threadId: 'thread-1', turnId: 'turn-3', itemId: 'msg-3', delta: '开始按方案实施…',
      },
    });
    window.__sse.emit('codex', {
      method: 'turn/completed',
      params: {
        threadId: 'thread-1', turnId: 'turn-3', turn: { id: 'turn-3', status: 'completed' },
      },
    });
  });
  await page.waitForTimeout(300);
  const third = {
    decisionVisible: await page.locator('#planDecisionBar').isVisible(),
    turnDividers: await page.locator('.turn-divider').allTextContents(),
  };
  await page.screenshot({ path: process.env.CODEX_MOBILE_SCREENSHOT ?? '/tmp/codex-mobile-plan.png', fullPage: true });

  if (first.planCards !== 1 || first.draftCards !== 1) throw new Error(`第一回合卡片数量异常：${JSON.stringify(first)}`);
  if (!first.explanation.includes('方案说明')) throw new Error(`方案说明异常：${first.explanation}`);
  if (first.steps[0].text !== '调研' || first.steps[0].status !== 'completed' || first.steps[0].icon !== '✓') throw new Error(`步骤一异常：${JSON.stringify(first.steps[0])}`);
  if (first.steps[1].text !== '实施' || first.steps[1].status !== 'in_progress') throw new Error(`步骤二异常：${JSON.stringify(first.steps[1])}`);
  if (!first.draftText.includes('第一步：梳理需求')) throw new Error(`方案增量未显示：${first.draftText}`);
  if (!first.decisionVisible) throw new Error('方案确认条未显示');
  if (second.planCards !== 2 || second.draftCards !== 2) throw new Error(`第二回合卡片数量异常：${JSON.stringify(second)}`);
  if (!second.steps.join('').includes('A')) throw new Error(`第二回合步骤异常：${JSON.stringify(second.steps)}`);
  if (!second.decisionVisible) throw new Error('第二回合确认条未显示');
  if (second.scrollWidth > second.width) throw new Error(`手机页面横向溢出：${second.scrollWidth} > ${second.width}`);
  if (third.decisionVisible) throw new Error(`实施回合完成后方案确认条仍显示：${JSON.stringify(third)}`);
  if (third.turnDividers.length !== 3) throw new Error(`回合数异常：${JSON.stringify(third)}`);
  process.stdout.write(`${JSON.stringify({ first, second, third })}\n`);
} finally {
  await browser.close();
}
