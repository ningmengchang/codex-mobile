import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const playwrightPath = process.env.PLAYWRIGHT_PATH
  ?? '/home/ningmengchang/ideaProjects/dpp-cloud-saic/dpp-platform-web/node_modules/playwright';
const { chromium } = require(playwrightPath);

const publicRoot = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'public');
const activityA = {
  threadId: 'thread-a', status: 'running', phase: 'default', activeTurnId: 'turn-a',
  attentionCount: 0, unreadCount: 0, updatedAt: 20,
};
let activityB = {
  threadId: 'thread-b', status: 'idle', phase: null, activeTurnId: null,
  attentionCount: 0, unreadCount: 0, updatedAt: 10,
};
const threadA = {
  id: 'thread-a', cwd: '/projects/alpha', name: '并行任务 A', preview: '正在实现首页', status: 'active', updatedAt: 20, activity: activityA,
};
const threadB = {
  id: 'thread-b', cwd: '/projects/beta', name: '并行任务 B', preview: '等待开始', status: 'idle', updatedAt: 10, activity: activityB,
};
const threadAlphaIdle = {
  id: 'thread-alpha-idle', cwd: '/projects/alpha', name: 'Alpha 历史任务', preview: '已经完成', status: 'idle', updatedAt: 9,
};
const fillerThreads = Array.from({ length: 30 }, (_, index) => ({
  id: `thread-filler-${index}`, cwd: '/projects/archive', name: `历史会话 ${index + 1}`,
  preview: '用于验证长会话列表滚动', status: 'idle', updatedAt: 9 - index,
}));
const turns = {
  'thread-a': [{
    id: 'turn-a', status: 'inProgress', items: [
      { id: 'user-a', type: 'userMessage', content: [{ type: 'text', text: '执行 A' }] },
      { id: 'agent-a', type: 'agentMessage', text: 'A 正在执行' },
    ],
  }],
  'thread-b': [{
    id: 'turn-b', status: 'completed', items: [
      { id: 'user-b', type: 'userMessage', content: [{ type: 'text', text: '执行 B' }] },
      { id: 'agent-b', type: 'agentMessage', text: 'B 已完成' },
    ],
  }],
};
const bootstrap = {
  appServer: { ready: true }, runtime: { user: 'ningmengchang' }, models: [], collaborationModes: [],
  pendingRequests: [], threadActivities: [activityA, activityB], favorites: [],
  projects: { current: { name: 'alpha', path: '/projects/alpha' }, parent: '/projects', entries: [] },
};

const browser = await chromium.launch({ headless: true });
try {
  const context = await browser.newContext({
    viewport: { width: 390, height: 844 }, deviceScaleFactor: 2, isMobile: true, hasTouch: true,
  });
  await context.addInitScript(() => {
    const listeners = new Map();
    class FakeEventSource {
      constructor() { setTimeout(() => this.onopen?.(), 20); }
      addEventListener(type, callback) {
        if (!listeners.has(type)) listeners.set(type, []);
        listeners.get(type).push(callback);
      }
      close() {}
    }
    window.EventSource = FakeEventSource;
    window.__emitSessionEvent = (type, value) => {
      for (const callback of listeners.get(type) ?? []) callback({ data: JSON.stringify(value) });
    };
  });
  const page = await context.newPage();
  let listQuery = null;
  let readBCount = 0;
  await page.route('**/*', async (route) => {
    const url = new URL(route.request().url());
    const pathname = url.pathname;
    const method = route.request().method();
    const fulfillJson = (body, status = 200) => route.fulfill({
      status, contentType: 'application/json; charset=utf-8', body: JSON.stringify(body),
    });
    if (pathname === '/api/auth/status') return fulfillJson({ authenticated: true });
    if (pathname === '/api/bootstrap') return fulfillJson(bootstrap);
    if (pathname === '/api/catalogs') return fulfillJson({ models: [], collaborationModes: [] });
    if (pathname === '/api/requests') return fulfillJson({ data: [] });
    if (pathname === '/api/projects') return fulfillJson(bootstrap.projects);
    if (pathname === '/api/threads' && method === 'GET') {
      listQuery = url.searchParams.toString();
      const allThreads = [{ ...threadA, activity: activityA }, threadAlphaIdle, { ...threadB, activity: activityB }, ...fillerThreads];
      const cwd = url.searchParams.get('cwd');
      return fulfillJson({ data: cwd ? allThreads.filter((thread) => thread.cwd === cwd) : allThreads, nextCursor: null });
    }
    const threadMatch = pathname.match(/^\/api\/threads\/(thread-[ab])$/);
    if (threadMatch && method === 'GET') {
      const thread = threadMatch[1] === 'thread-a' ? threadA : threadB;
      const activity = threadMatch[1] === 'thread-a' ? activityA : activityB;
      return fulfillJson({ thread: { ...thread, activity } });
    }
    const turnMatch = pathname.match(/^\/api\/threads\/(thread-[ab])\/turns$/);
    if (turnMatch && method === 'GET') return fulfillJson({ data: turns[turnMatch[1]], nextCursor: null });
    if (/^\/api\/threads\/thread-[ab]\/resume$/.test(pathname)) return fulfillJson({ thread: pathname.includes('thread-a') ? threadA : threadB });
    if (/^\/api\/threads\/thread-[ab]\/artifacts$/.test(pathname)) return fulfillJson({ data: [] });
    if (pathname === '/api/threads/thread-b/read' && method === 'POST') {
      readBCount += 1;
      activityB = { ...activityB, status: 'idle', unreadCount: 0, completedAt: Date.now() };
      return fulfillJson({ activity: activityB });
    }
    if (pathname === '/api/events') return route.fulfill({ status: 200, contentType: 'text/event-stream', body: ': connected\n\n' });
    const file = path.join(publicRoot, pathname === '/' ? 'index.html' : pathname);
    if (!fs.existsSync(file) || !fs.statSync(file).isFile()) return route.fulfill({ status: 404, body: 'not found' });
    const contentType = file.endsWith('.js') ? 'text/javascript; charset=utf-8'
      : file.endsWith('.css') ? 'text/css; charset=utf-8'
        : file.endsWith('.html') ? 'text/html; charset=utf-8'
          : 'application/octet-stream';
    return route.fulfill({ status: 200, contentType, body: fs.readFileSync(file) });
  });

  await page.goto('http://127.0.0.1:39921/', { waitUntil: 'domcontentloaded' });
  await page.locator('#app:not([hidden])').waitFor({ timeout: 15_000 });
  await page.locator('#threadsView.active').waitFor({ timeout: 10_000 });
  if (new URLSearchParams(listQuery).has('cwd')) throw new Error(`手机会话首页仍按目录过滤：${listQuery}`);
  if (!await page.locator('#mobileThreadList', { hasText: '并行任务 A' }).isVisible()) throw new Error('默认会话首页未显示跨目录会话');
  if (!await page.locator('#mobileThreadList .thread-status', { hasText: '执行中' }).isVisible()) throw new Error('执行中状态未显示');

  const directoryResponse = page.waitForResponse((response) => {
    const url = new URL(response.url());
    return url.pathname === '/api/threads' && url.searchParams.get('cwd') === '/projects/alpha';
  });
  await page.locator('[data-thread-scope="directory"]').click();
  await directoryResponse;
  await page.waitForFunction(() => document.querySelector('#threadSummary')?.textContent.includes('alpha'));
  if (new URLSearchParams(listQuery).get('cwd') !== '/projects/alpha') throw new Error(`当前目录请求错误：${listQuery}`);
  if (await page.locator('#mobileThreadList', { hasText: '并行任务 B' }).isVisible()) throw new Error('当前目录筛选混入了其他目录会话');
  const directoryButton = page.locator('[data-thread-scope="directory"]');
  if (!(await directoryButton.textContent()).includes('alpha')) throw new Error('当前目录筛选未显示目录名');
  if (!(await directoryButton.getAttribute('title')).includes('/projects/alpha')) throw new Error('当前目录筛选未保留完整路径');

  await page.locator('[data-thread-filter="active"]').click();
  if (await page.locator('#mobileThreadList', { hasText: 'Alpha 历史任务' }).isVisible()) throw new Error('目录筛选与状态筛选没有组合生效');
  if (!await page.locator('#mobileThreadList', { hasText: '并行任务 A' }).isVisible()) throw new Error('状态筛选误删了目录内进行中会话');

  const globalResponse = page.waitForResponse((response) => {
    const url = new URL(response.url());
    return url.pathname === '/api/threads' && !url.searchParams.has('cwd');
  });
  await page.locator('[data-thread-scope="all"]').click();
  await globalResponse;
  if (!await page.locator('[data-thread-filter="active"]').evaluate((element) => element.classList.contains('active'))) {
    throw new Error('切换目录范围时丢失了状态筛选');
  }
  await page.locator('[data-thread-filter="all"]').click();
  await page.locator('#mobileThreadList', { hasText: '并行任务 B' }).waitFor();
  if (new URLSearchParams(listQuery).has('cwd')) throw new Error(`返回全部目录后仍携带 cwd：${listQuery}`);

  const fixedBefore = await page.evaluate(() => ({
    searchTop: document.querySelector('#threadSearch').getBoundingClientRect().top,
    filtersTop: document.querySelector('#threadFilters').getBoundingClientRect().top,
    viewScrollTop: document.querySelector('#threadsView').scrollTop,
  }));
  await page.locator('.thread-list-scroll').evaluate((element) => { element.scrollTop = element.scrollHeight; });
  await page.waitForFunction(() => document.querySelector('.thread-list-scroll').scrollTop > 0);
  const fixedAfter = await page.evaluate(() => ({
    searchTop: document.querySelector('#threadSearch').getBoundingClientRect().top,
    filtersTop: document.querySelector('#threadFilters').getBoundingClientRect().top,
    viewScrollTop: document.querySelector('#threadsView').scrollTop,
    listScrollTop: document.querySelector('.thread-list-scroll').scrollTop,
  }));
  if (Math.abs(fixedBefore.searchTop - fixedAfter.searchTop) > 1 || Math.abs(fixedBefore.filtersTop - fixedAfter.filtersTop) > 1) {
    throw new Error(`搜索框或状态栏随会话列表滚动：${JSON.stringify({ fixedBefore, fixedAfter })}`);
  }
  if (fixedAfter.viewScrollTop !== 0 || fixedAfter.listScrollTop <= 0) {
    throw new Error(`会话列表滚动层级错误：${JSON.stringify({ fixedBefore, fixedAfter })}`);
  }

  await page.locator('#mobileThreadList .thread-item', { hasText: '并行任务 A' }).click();
  await page.locator('#chatView.active .agent-card', { hasText: 'A 正在执行' }).waitFor({ timeout: 15_000 });
  const detailLayout = await page.evaluate(() => ({
    headerVisible: !document.querySelector('#chatDetailHeader').hidden,
    navigationRemoved: !document.querySelector('.bottom-nav'),
    composerDisplay: getComputedStyle(document.querySelector('#composer')).display,
  }));
  if (!detailLayout.headerVisible || !detailLayout.navigationRemoved || detailLayout.composerDisplay === 'none') {
    throw new Error(`聊天详情布局错误：${JSON.stringify(detailLayout)}`);
  }
  await page.screenshot({ path: '/tmp/codex-mobile-session-chat.png', fullPage: true });
  if (page.url().split('#')[1] !== 'chat/thread-a') throw new Error(`聊天路由错误：${page.url()}`);
  await page.reload({ waitUntil: 'domcontentloaded' });
  await page.locator('#app:not([hidden])').waitFor({ timeout: 15_000 });
  await page.locator('#chatView.active .agent-card', { hasText: 'A 正在执行' }).waitFor({ timeout: 15_000 });

  await page.evaluate(() => window.__emitSessionEvent('codex', {
    method: 'turn/started', params: { threadId: 'thread-b', turn: { id: 'turn-b', status: 'inProgress', items: [] } },
  }));
  await page.waitForFunction(() => [...document.querySelectorAll('#mobileThreadList .thread-item')]
    .some((item) => item.textContent.includes('并行任务 B') && item.textContent.includes('执行中')));
  const aStillVisible = await page.locator('#timeline').textContent();
  if (!aStillVisible.includes('A 正在执行') || aStillVisible.includes('B 已完成')) throw new Error('非当前会话事件污染了当前聊天');

  activityB = {
    ...activityB, status: 'completed', activeTurnId: null, unreadCount: 1,
    lastTerminalStatus: 'completed', completedAt: Date.now(), updatedAt: Date.now(),
  };
  await page.evaluate((activity) => window.__emitSessionEvent('thread-activity', activity), activityB);
  await page.evaluate(() => window.__emitSessionEvent('codex', {
    method: 'turn/completed', params: { threadId: 'thread-b', turn: { id: 'turn-b', status: 'completed' } },
  }));
  await page.locator('#chatBackButton').click();
  await page.locator('#threadsView.active').waitFor({ timeout: 10_000 });
  const rowB = page.locator('#mobileThreadList .thread-item', { hasText: '并行任务 B' });
  if (!(await rowB.textContent()).includes('已完成')) throw new Error('后台会话完成后未显示完成状态');
  if (await rowB.locator('.thread-unread').textContent() !== '1') throw new Error('完成事件被重复计数');

  await rowB.click();
  await page.locator('#chatView.active .agent-card', { hasText: 'B 已完成' }).waitFor({ timeout: 15_000 });
  await page.waitForFunction(() => document.querySelector('#chatDetailMeta')?.textContent.includes('beta'));
  await page.locator('#chatBackButton').click();
  await page.locator('#threadsView.active').waitFor({ timeout: 10_000 });
  await page.waitForFunction(() => ![...document.querySelectorAll('#mobileThreadList .thread-item')]
    .find((item) => item.textContent.includes('并行任务 B'))?.querySelector('.thread-unread'));
  if (readBCount !== 1) throw new Error(`读取确认次数异常：${readBCount}`);

  await page.screenshot({ path: process.env.CODEX_MOBILE_SCREENSHOT ?? '/tmp/codex-mobile-session-home.png', fullPage: true });
  process.stdout.write(`${JSON.stringify({ listQuery, detailLayout, readBCount })}\n`);
} finally {
  await browser.close();
}
