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
  id: 't-a', cwd: '/proj/a', name: '会话A', preview: '', status: 'active', updatedAt: 3,
  turns: [{ id: 'turn-a', status: 'completed', durationMs: 100, items: [
    { id: 'ua', type: 'userMessage', content: [{ type: 'text', text: '问题A' }] },
    { id: 'aa', type: 'agentMessage', text: '会话A内容' },
  ] }],
};
const threadB = {
  id: 't-b', cwd: '/proj/b', name: '会话B', preview: '', status: 'idle', updatedAt: 2,
  turns: [{ id: 'turn-b', status: 'completed', durationMs: 100, items: [
    { id: 'ub', type: 'userMessage', content: [{ type: 'text', text: '问题B' }] },
    { id: 'ab', type: 'agentMessage', text: '会话B内容' },
  ] }],
};
const bootstrap = {
  appServer: { ready: true },
  runtime: { user: 'ningmengchang' },
  models: [],
  collaborationModes: [],
  pendingRequests: [],
  projects: { current: { name: 'a', path: '/proj/a' }, parent: '/proj', root: '/proj', entries: [{ name: 'b', path: '/proj/b' }] },
};
let favorites = [];
const favoriteFillers = Array.from({ length: 30 }, (_, index) => ({
  id: `favorite-filler-${index}`, name: `历史收藏 ${index + 1}`,
  cwd: '/proj/archive', updatedAt: -index,
}));

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
    if (pathname === '/api/bootstrap') return fulfillJson({ ...bootstrap, favorites });
    if (pathname === '/api/requests') return fulfillJson({ data: [] });
    if (pathname === '/api/favorites/import' && route.request().method() === 'POST') {
      const body = JSON.parse(route.request().postData() || '{}');
      const known = new Set(favorites.map((item) => item.id));
      favorites = [...favorites, ...(body.items ?? []).filter((item) => !known.has(item.id))];
      return fulfillJson({ data: favorites });
    }
    if (pathname === '/api/favorites' && route.request().method() === 'GET') return fulfillJson({ data: favorites });
    if (pathname === '/api/favorites' && route.request().method() === 'POST') {
      const item = JSON.parse(route.request().postData() || '{}');
      favorites = [item, ...favorites.filter((entry) => entry.id !== item.id)];
      return fulfillJson({ data: favorites });
    }
    if (pathname.startsWith('/api/favorites/') && route.request().method() === 'DELETE') {
      const threadId = decodeURIComponent(pathname.slice('/api/favorites/'.length));
      favorites = favorites.filter((item) => item.id !== threadId);
      return fulfillJson({ data: favorites });
    }
    if (pathname === '/api/projects') {
      const requested = url.searchParams.get('path');
      if (requested === '/proj/b') {
        return fulfillJson({ current: { name: 'b', path: '/proj/b' }, parent: '/proj', root: '/proj', entries: [] });
      }
      return fulfillJson(bootstrap.projects);
    }
    if (pathname === '/api/threads' && route.request().method() === 'GET') {
      const cwd = url.searchParams.get('cwd');
      const data = cwd === '/proj/a' ? [threadA] : cwd === '/proj/b' ? [threadB] : [threadA, threadB];
      return fulfillJson({ data });
    }
    if (pathname === '/api/threads/t-a' && route.request().method() === 'GET') return fulfillJson({ thread: threadA });
    if (pathname === '/api/threads/t-b' && route.request().method() === 'GET') return fulfillJson({ thread: threadB });
    if (pathname === '/api/threads/t-a/resume') return fulfillJson({ thread: threadA });
    if (pathname === '/api/threads/t-b/resume') return fulfillJson({ thread: threadB });
    if (pathname === '/api/threads/t-a/artifacts' || pathname === '/api/threads/t-b/artifacts') return fulfillJson({ data: [] });
    if (pathname === '/api/events') return route.fulfill({ status: 200, contentType: 'text/event-stream', body: ': connected\n\n' });
    const file = path.join(publicRoot, pathname === '/' ? 'index.html' : pathname);
    if (!fs.existsSync(file) || !fs.statSync(file).isFile()) return route.fulfill({ status: 404, body: 'not found' });
    const contentType = file.endsWith('.js') ? 'text/javascript; charset=utf-8'
      : file.endsWith('.css') ? 'text/css; charset=utf-8'
        : file.endsWith('.html') ? 'text/html; charset=utf-8'
          : 'application/octet-stream';
    return route.fulfill({ status: 200, contentType, body: fs.readFileSync(file) });
  });

  await page.goto('http://127.0.0.1:39897/', { waitUntil: 'domcontentloaded' });
  await page.locator('#app:not([hidden])').waitFor({ timeout: 15_000 });

  // 1) 打开项目 A 的会话
  await page.locator('#mobileThreadList .thread-item', { hasText: '会话A' }).click();
  await page.locator('.agent-card', { hasText: '会话A内容' }).waitFor({ timeout: 10_000 });

  // 2) 回到会话列表收藏 A
  await page.locator('#chatBackButton').click();
  const threadARow = page.locator('#mobileThreadList .thread-item', { hasText: '会话A' });
  await threadARow.locator('.thread-star').click();
  await threadARow.locator('.thread-star.on').waitFor({ timeout: 5_000 });
  const starOn = await page.locator('#mobileThreadList .thread-star.on').count();
  if (starOn !== 1) throw new Error('收藏后星标未点亮');

  // 3) 会话页收藏筛选显示跨目录条目，并支持搜索
  await page.locator('#threadFavoriteToggle').click();
  const favoriteText = await page.locator('#mobileThreadList').textContent();
  const favoriteProject = await page.locator('#mobileThreadList .thread-meta').textContent();
  if (!favoriteText.includes('会话A') || !favoriteProject.includes('a')) throw new Error(`收藏筛选内容异常：${favoriteText}`);
  await page.locator('[data-thread-filter="active"]').click();
  if (!await page.locator('#threadFavoriteToggle').evaluate((element) => element.classList.contains('active'))
    || !await page.locator('[data-thread-filter="active"]').evaluate((element) => element.classList.contains('active'))) {
    throw new Error('收藏与进行中筛选没有同时保持激活');
  }
  if (!await page.locator('#mobileThreadList').textContent().then((text) => text.includes('会话A'))) {
    throw new Error('收藏与进行中组合筛选未显示会话 A');
  }
  await page.locator('#threadFavoriteToggle').click();
  if (await page.locator('#threadFavoriteToggle').evaluate((element) => element.classList.contains('active'))
    || !await page.locator('[data-thread-filter="active"]').evaluate((element) => element.classList.contains('active'))) {
    throw new Error('关闭收藏时错误重置了进行中筛选');
  }
  await page.locator('#threadFavoriteToggle').click();
  await page.locator('[data-thread-filter="all"]').click();
  await page.locator('#threadSearch').fill('会话A');
  if (!await page.locator('#mobileThreadList').textContent().then((text) => text.includes('会话A'))) throw new Error('收藏搜索没有找到会话 A');
  await page.locator('#threadSearch').fill('不存在的收藏');
  if (!await page.locator('#mobileThreadList').textContent().then((text) => text.includes('没有符合条件的收藏'))) {
    throw new Error('收藏搜索空状态错误');
  }
  await page.locator('#threadSearch').fill('');

  // 长收藏列表仍只滚动会话列表，搜索和筛选栏保持固定。
  favorites = [...favorites, ...favoriteFillers];
  await page.reload({ waitUntil: 'domcontentloaded' });
  await page.locator('#app:not([hidden])').waitFor({ timeout: 15_000 });
  await page.locator('#threadFavoriteToggle').click();
  const favoriteHeadTop = await page.locator('#threadSearch').evaluate((element) => element.getBoundingClientRect().top);
  await page.locator('.thread-list-scroll').evaluate((element) => { element.scrollTop = element.scrollHeight; });
  await page.waitForFunction(() => document.querySelector('.thread-list-scroll').scrollTop > 0);
  const favoriteScrollLayout = await page.evaluate(() => ({
    headTop: document.querySelector('#threadSearch').getBoundingClientRect().top,
    filtersTop: document.querySelector('#threadFilters').getBoundingClientRect().top,
    viewScrollTop: document.querySelector('#threadsView').scrollTop,
    listScrollTop: document.querySelector('.thread-list-scroll').scrollTop,
  }));
  if (Math.abs(favoriteHeadTop - favoriteScrollLayout.headTop) > 1
    || favoriteScrollLayout.viewScrollTop !== 0 || favoriteScrollLayout.listScrollTop <= 0) {
    throw new Error(`收藏页头部随列表滚动：${JSON.stringify({ favoriteHeadTop, favoriteScrollLayout })}`);
  }
  favorites = favorites.filter((item) => !item.id.startsWith('favorite-filler-'));

  // 4) 清空当前 WebView 的本地存储并刷新，收藏仍从服务端恢复
  await page.evaluate(() => { localStorage.clear(); sessionStorage.clear(); });
  await page.reload({ waitUntil: 'domcontentloaded' });
  await page.locator('#app:not([hidden])').waitFor({ timeout: 15_000 });
  await page.locator('#threadFavoriteToggle').click();
  const restoredText = await page.locator('#mobileThreadList').textContent();
  if (!restoredText.includes('会话A')) throw new Error(`清空本地数据后收藏未恢复：${restoredText}`);

  // 5) 切到项目 B，收藏仍可见
  await page.locator('#threadFavoriteToggle').click();
  await swipeRight(page, '#threadsView');
  await page.locator('.project-button', { hasText: 'b' }).click();
  await page.waitForFunction(() => document.querySelector('#projectPath')?.textContent === '/proj/b');
  await swipeLeft(page, '#projectsView');
  await page.locator('#threadsView.active').waitFor({ timeout: 10_000 });
  await page.locator('#mobileThreadList .thread-item', { hasText: '会话B' }).waitFor({ timeout: 10_000 });
  await page.locator('#threadFavoriteToggle').click();
  const crossText = await page.locator('#mobileThreadList').textContent();
  if (!crossText.includes('会话A')) throw new Error('跨目录后收藏丢失');
  await page.locator('[data-thread-scope="directory"]').click();
  await page.waitForFunction(() => document.querySelector('#mobileThreadList')?.textContent.includes('b 目录下没有收藏'));
  if (!await page.locator('#threadFavoriteToggle').evaluate((element) => element.classList.contains('active'))) {
    throw new Error('切换当前目录时收藏筛选被关闭');
  }
  await page.locator('[data-thread-scope="all"]').click();
  await page.locator('#mobileThreadList .thread-item', { hasText: '会话A' }).waitFor({ timeout: 10_000 });

  // 6) 点击收藏 → 直接进入指定会话和目录
  await page.locator('#mobileThreadList .thread-main').click();
  await page.locator('.agent-card', { hasText: '会话A内容' }).waitFor({ timeout: 10_000 });
  const projectName = await page.locator('#currentProjectName').textContent();
  if (projectName !== 'a') throw new Error(`未切到项目 A：${projectName}`);
  await page.locator('#chatBackButton').click();
  await page.locator('#mobileThreadList .thread-item', { hasText: '会话A' }).waitFor({ timeout: 10_000 });

  // 7) 收藏筛选中取消收藏
  await page.locator('#mobileThreadList .thread-star').click();
  await page.locator('#mobileThreadList .empty-list').waitFor({ timeout: 5_000 });
  const emptyText = await page.locator('#mobileThreadList').textContent();
  if (!emptyText.includes('还没有收藏')) throw new Error(`取消收藏后仍存在：${emptyText}`);

  // 8) 旧网页版 localStorage 收藏会自动迁移到服务端
  await page.evaluate((legacy) => {
    localStorage.setItem('codex-mobile-favorite-threads', JSON.stringify([legacy]));
    localStorage.removeItem('codex-mobile-favorites-server-v1');
  }, { id: threadB.id, name: threadB.name, cwd: threadB.cwd, updatedAt: threadB.updatedAt });
  await page.reload({ waitUntil: 'domcontentloaded' });
  await page.locator('#app:not([hidden])').waitFor({ timeout: 15_000 });
  await page.locator('#threadFavoriteToggle').click();
  const migratedText = await page.locator('#mobileThreadList').textContent();
  if (!migratedText.includes('会话B')) throw new Error(`旧收藏未迁移：${migratedText}`);
  const migrationState = await page.evaluate(() => ({
    legacy: localStorage.getItem('codex-mobile-favorite-threads'),
    migrated: localStorage.getItem('codex-mobile-favorites-server-v1'),
  }));
  if (migrationState.legacy !== null || migrationState.migrated !== '1') {
    throw new Error(`旧收藏迁移标记异常：${JSON.stringify(migrationState)}`);
  }

  process.stdout.write(JSON.stringify({ favoriteText, restoredText, crossText, projectName, migratedText, emptyOk: true }));
} finally {
  await browser.close();
}
