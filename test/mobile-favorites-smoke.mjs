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
  id: 't-a', cwd: '/proj/a', name: '会话A', preview: '', status: 'idle', updatedAt: 3,
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
      const data = cwd === '/proj/a' ? [threadA] : cwd === '/proj/b' ? [threadB] : [];
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
  await page.locator('button[data-tab="threads"]').click();
  await page.locator('#mobileThreadList .thread-item', { hasText: '会话A' }).click();
  await page.locator('.agent-card', { hasText: '会话A内容' }).waitFor({ timeout: 10_000 });

  // 2) 回到会话列表收藏 A
  await page.locator('button[data-tab="threads"]').click();
  await page.locator('#mobileThreadList .thread-star').click();
  await page.locator('#mobileThreadList .thread-star.on').waitFor({ timeout: 5_000 });
  const starOn = await page.locator('#mobileThreadList .thread-star.on').count();
  if (starOn !== 1) throw new Error('收藏后星标未点亮');

  // 3) 收藏页出现跨目录条目
  await page.locator('button[data-tab="favorites"]').click();
  await page.locator('#favoritesView.active').waitFor({ timeout: 5_000 });
  const favoriteText = await page.locator('#favoriteList').textContent();
  if (!favoriteText.includes('会话A') || !favoriteText.includes('/proj/a')) throw new Error(`收藏页内容异常：${favoriteText}`);

  // 4) 清空当前 WebView 的本地存储并刷新，收藏仍从服务端恢复
  await page.evaluate(() => { localStorage.clear(); sessionStorage.clear(); });
  await page.reload({ waitUntil: 'domcontentloaded' });
  await page.locator('#app:not([hidden])').waitFor({ timeout: 15_000 });
  await page.locator('button[data-tab="favorites"]').click();
  const restoredText = await page.locator('#favoriteList').textContent();
  if (!restoredText.includes('会话A')) throw new Error(`清空本地数据后收藏未恢复：${restoredText}`);

  // 5) 切到项目 B，收藏仍可见
  await page.locator('button[data-tab="projects"]').click();
  await page.locator('.project-button', { hasText: 'b' }).click();
  await page.locator('.project-button', { hasText: '使用当前目录' }).click();
  await page.locator('button[data-tab="threads"]').click();
  await page.locator('#mobileThreadList .thread-item', { hasText: '会话B' }).waitFor({ timeout: 10_000 });
  await page.locator('button[data-tab="favorites"]').click();
  const crossText = await page.locator('#favoriteList').textContent();
  if (!crossText.includes('会话A')) throw new Error('跨目录后收藏丢失');

  // 6) 点击收藏 → 直接进入指定会话和目录
  await page.locator('#favoriteList .thread-main').click();
  await page.locator('.agent-card', { hasText: '会话A内容' }).waitFor({ timeout: 10_000 });
  const projectName = await page.locator('#currentProjectName').textContent();
  if (projectName !== 'a') throw new Error(`未切到项目 A：${projectName}`);
  await page.locator('button[data-tab="threads"]').click();
  await page.locator('#mobileThreadList .thread-item', { hasText: '会话A' }).waitFor({ timeout: 10_000 });

  // 7) 收藏页取消收藏
  await page.locator('button[data-tab="favorites"]').click();
  await page.locator('#favoriteList .thread-star').click();
  await page.locator('#favoriteList .empty-list').waitFor({ timeout: 5_000 });
  const emptyText = await page.locator('#favoriteList').textContent();
  if (!emptyText.includes('还没有收藏')) throw new Error(`取消收藏后仍存在：${emptyText}`);

  // 8) 旧网页版 localStorage 收藏会自动迁移到服务端
  await page.evaluate((legacy) => {
    localStorage.setItem('codex-mobile-favorite-threads', JSON.stringify([legacy]));
    localStorage.removeItem('codex-mobile-favorites-server-v1');
  }, { id: threadB.id, name: threadB.name, cwd: threadB.cwd, updatedAt: threadB.updatedAt });
  await page.reload({ waitUntil: 'domcontentloaded' });
  await page.locator('#app:not([hidden])').waitFor({ timeout: 15_000 });
  await page.locator('button[data-tab="favorites"]').click();
  const migratedText = await page.locator('#favoriteList').textContent();
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
