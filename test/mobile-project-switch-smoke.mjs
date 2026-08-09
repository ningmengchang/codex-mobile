import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const playwrightPath = process.env.PLAYWRIGHT_PATH
  ?? '/home/ningmengchang/ideaProjects/dpp-cloud-saic/dpp-platform-web/node_modules/playwright';
const { chromium } = require(playwrightPath);

const publicRoot = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'public');
const threadA = {
  id: 'thread-a', cwd: '/proj/a', name: '目录A会话', preview: '', status: 'idle', updatedAt: 2,
  turns: [
    {
      id: 'turn-a', status: 'completed', durationMs: 100, items: [
        { id: 'ua', type: 'userMessage', content: [{ type: 'text', text: '目录A问题' }] },
        { id: 'aa', type: 'agentMessage', text: '目录A回答' },
      ],
    },
  ],
};
const threadB = { id: 'thread-b', cwd: '/proj/b', name: '目录B会话', preview: '', status: 'idle', updatedAt: 1, turns: [] };
const bootstrap = {
  appServer: { ready: true },
  runtime: { user: 'ningmengchang' },
  models: [],
  collaborationModes: [],
  pendingRequests: [],
  projects: {
    current: { name: 'a', path: '/proj/a' },
    parent: null,
    entries: [{ name: 'b', path: '/proj/b' }],
  },
};

const browser = await chromium.launch({ headless: true });
try {
  const context = await browser.newContext({
    viewport: { width: 390, height: 844 }, deviceScaleFactor: 2, isMobile: true, hasTouch: true,
  });
  await context.addInitScript((boot) => {
    window.EventSource = class {
      constructor() { setTimeout(() => this.onopen?.(), 30); }
      addEventListener() {}
      close() {}
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
    if (pathname === '/api/projects' && route.request().method() === 'GET') {
      if (url.searchParams.get('path') === '/proj/b') {
        return fulfillJson({ current: { name: 'b', path: '/proj/b' }, parent: '/proj', entries: [] });
      }
      return fulfillJson(bootstrap.projects);
    }
    if (pathname === '/api/threads' && route.request().method() === 'GET') {
      const cwd = url.searchParams.get('cwd');
      return fulfillJson({ data: cwd === '/proj/b' ? [threadB] : [threadA] });
    }
    if (pathname === '/api/threads/thread-a' && route.request().method() === 'GET') {
      return fulfillJson({ thread: threadA });
    }
    if (pathname === '/api/threads/thread-a/resume') return fulfillJson({ thread: threadA });
    if (pathname === '/api/threads/thread-a/turns') {
      return fulfillJson({ data: [threadA.turns[0]], nextCursor: null });
    }
    if (pathname === '/api/threads/thread-a/artifacts') return fulfillJson({ data: [] });
    if (pathname === '/api/events') return route.fulfill({ status: 200, contentType: 'text/event-stream', body: ': connected\n\n' });
    const file = path.join(publicRoot, pathname === '/' ? 'index.html' : pathname);
    if (!fs.existsSync(file) || !fs.statSync(file).isFile()) return route.fulfill({ status: 404, body: 'not found' });
    const contentType = file.endsWith('.js') ? 'text/javascript; charset=utf-8'
      : file.endsWith('.css') ? 'text/css; charset=utf-8'
        : file.endsWith('.html') ? 'text/html; charset=utf-8'
          : 'application/octet-stream';
    return route.fulfill({ status: 200, contentType, body: fs.readFileSync(file) });
  });

  await page.goto('http://127.0.0.1:39903/', { waitUntil: 'domcontentloaded' });
  await page.locator('#app:not([hidden])').waitFor({ timeout: 15_000 });
  await page.locator('button[data-tab="threads"]').click();
  await page.locator('#mobileThreadList .thread-item', { hasText: '目录A会话' }).click();
  await page.locator('.agent-card', { hasText: '目录A回答' }).waitFor({ timeout: 10_000 });

  await page.locator('button[data-tab="projects"]').click();
  await page.locator('.project-button', { hasText: 'b' }).click();
  await page.locator('.project-button', { hasText: '使用当前目录' }).click();
  await page.locator('#threadsView.active').waitFor({ timeout: 10_000 });

  const listText = await page.locator('#mobileThreadList').textContent();
  if (!listText.includes('目录B会话')) throw new Error(`新目录会话未加载：${listText}`);
  if (listText.includes('目录A会话')) throw new Error(`旧目录会话仍显示：${listText}`);
  const activeCount = await page.locator('#mobileThreadList .thread-item.active').count();
  if (activeCount !== 0) throw new Error(`切换后仍高亮旧会话：${activeCount}`);
  const savedThread = await page.evaluate(() => localStorage.getItem('codex-mobile-thread'));
  if (savedThread !== null) throw new Error(`旧会话 id 未清除：${savedThread}`);

  await page.locator('button[data-tab="chat"]').click();
  try {
    await page.locator('#emptyState:not([hidden])').waitFor({ timeout: 10_000 });
  } catch (error) {
    const dump = await page.evaluate(() => ({
      chatActive: document.querySelector('#chatView')?.classList.contains('active'),
      emptyHidden: document.querySelector('#emptyState')?.hidden,
      emptyDisplay: getComputedStyle(document.querySelector('#emptyState')).display,
      timelineText: document.querySelector('#timeline')?.textContent?.slice(0, 200),
      threadList: document.querySelector('#mobileThreadList')?.textContent?.slice(0, 200),
      savedThread: localStorage.getItem('codex-mobile-thread'),
      beforeChatTimeline: document.querySelector('#timeline')?.textContent?.slice(0, 200),
    }));
    throw new Error(`空状态未出现：${JSON.stringify(dump)}`);
  }
  const timelineText = await page.locator('#timeline').textContent();
  if (timelineText.includes('目录A回答')) throw new Error(`旧聊天记录未清空：${timelineText}`);
  const artifactBadgeHidden = await page.evaluate(() => document.querySelector('#artifactBadge')?.hidden);
  if (artifactBadgeHidden !== true) throw new Error(`切换后产出物徽标未清空：${artifactBadgeHidden}`);

  process.stdout.write(`${JSON.stringify({ listHasB: true, oldCleared: true, activeCount, savedThread: 'removed', emptyState: true })}\n`);
} finally {
  await browser.close();
}
