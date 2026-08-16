import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';
import { swipeLeft, swipeRight } from './helpers/mobile-gestures.mjs';

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
      return fulfillJson({ data: cwd === '/proj/b' ? [threadB] : cwd === '/proj/a' ? [threadA] : [threadA, threadB] });
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
  await page.locator('#mobileThreadList .thread-item', { hasText: '目录A会话' }).click();
  await page.locator('.agent-card', { hasText: '目录A回答' }).waitFor({ timeout: 10_000 });

  await page.locator('#chatBackButton').click();
  const directoryResponse = page.waitForResponse((response) => {
    const url = new URL(response.url());
    return url.pathname === '/api/threads' && url.searchParams.get('cwd') === '/proj/a';
  });
  await page.locator('[data-thread-scope="directory"]').click();
  await directoryResponse;
  await swipeRight(page, '#threadsView');
  await page.locator('.project-button', { hasText: 'b' }).click();
  await page.waitForFunction(() => document.querySelector('#projectPath')?.textContent === '/proj/b');
  await swipeLeft(page, '#projectsView');
  await page.locator('#threadsView.active').waitFor({ timeout: 10_000 });

  const listText = await page.locator('#mobileThreadList').textContent();
  if (!listText.includes('目录B会话') || listText.includes('目录A会话')) {
    throw new Error(`切换目录后会话筛选未同步：${listText}`);
  }
  const selectedProject = await page.locator('#currentProjectName').textContent();
  if (selectedProject !== 'b') throw new Error(`当前目录未切换：${selectedProject}`);
  const activeCount = await page.locator('#mobileThreadList .thread-item.active').count();
  if (activeCount !== 0) throw new Error(`切换后仍高亮旧会话：${activeCount}`);
  const savedThread = await page.evaluate(() => localStorage.getItem('codex-mobile-thread'));
  if (savedThread !== null) throw new Error(`旧会话 id 未清除：${savedThread}`);

  await page.locator('[data-thread-scope="all"]').click();
  await page.waitForFunction(() => {
    const text = document.querySelector('#mobileThreadList')?.textContent ?? '';
    return text.includes('目录A会话') && text.includes('目录B会话');
  });
  const globalListText = await page.locator('#mobileThreadList').textContent();
  if (!globalListText.includes('目录A会话') || !globalListText.includes('目录B会话')) {
    throw new Error(`返回全部目录后跨目录会话未恢复：${globalListText}`);
  }

  await page.locator('#threadsView.active').waitFor({ timeout: 10_000 });
  if (await page.locator('#emptyState').getAttribute('hidden') !== null) throw new Error('清空会话后聊天空状态未复位');
  const timelineText = await page.locator('#timeline').textContent();
  if (timelineText.includes('目录A回答')) throw new Error(`旧聊天记录未清空：${timelineText}`);
  if (await page.locator('#artifactBadge').count()) throw new Error('仍存在已移除的产出物全局徽标');
  const artifactCardCount = await page.locator('#artifactList .artifact-card').count();
  if (artifactCardCount !== 0) throw new Error(`切换后产出物列表未清空：${artifactCardCount}`);

  process.stdout.write(`${JSON.stringify({ directoryListUpdated: true, globalListRetained: true, selectedProject, oldCleared: true, activeCount, savedThread: 'removed', emptyState: true })}\n`);
} finally {
  await browser.close();
}
