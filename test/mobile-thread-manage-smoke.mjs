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
const bootstrap = {
  appServer: { ready: true },
  runtime: { user: 'ningmengchang' },
  models: [],
  collaborationModes: [],
  pendingRequests: [],
  projects: { current: { name: 'a', path: '/proj/a' }, parent: '/proj', root: '/proj', entries: [] },
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
  let deleted = false;
  await page.route('**/*', async (route) => {
    const pathname = new URL(route.request().url()).pathname;
    const fulfillJson = (body, status = 200) => route.fulfill({
      status, contentType: 'application/json; charset=utf-8', body: JSON.stringify(body),
    });
    if (pathname === '/api/auth/status') return fulfillJson({ authenticated: true });
    if (pathname === '/api/bootstrap') return fulfillJson(bootstrap);
    if (pathname === '/api/requests') return fulfillJson({ data: [] });
    if (pathname === '/api/projects') return fulfillJson(bootstrap.projects);
    if (pathname === '/api/threads' && route.request().method() === 'GET') {
      return fulfillJson({ data: deleted ? [] : [threadA] });
    }
    if (pathname === '/api/threads/t-a' && route.request().method() === 'GET') return fulfillJson({ thread: threadA });
    if (pathname === '/api/threads/t-a/resume') return fulfillJson({ thread: threadA });
    if (pathname === '/api/threads/t-a/name' && route.request().method() === 'POST') {
      const body = route.request().postDataJSON();
      threadA.name = body.name;
      return fulfillJson({ thread: threadA });
    }
    if (pathname === '/api/threads/t-a/delete' && route.request().method() === 'POST') {
      deleted = true;
      return fulfillJson({ deleted: true, result: { deleted: true } });
    }
    if (pathname === '/api/threads/t-a/artifacts') return fulfillJson({ data: [] });
    if (pathname === '/api/events') return route.fulfill({ status: 200, contentType: 'text/event-stream', body: ': connected\n\n' });
    const file = path.join(publicRoot, pathname === '/' ? 'index.html' : pathname);
    if (!fs.existsSync(file) || !fs.statSync(file).isFile()) return route.fulfill({ status: 404, body: 'not found' });
    const contentType = file.endsWith('.js') ? 'text/javascript; charset=utf-8'
      : file.endsWith('.css') ? 'text/css; charset=utf-8'
        : file.endsWith('.html') ? 'text/html; charset=utf-8'
          : 'application/octet-stream';
    return route.fulfill({ status: 200, contentType, body: fs.readFileSync(file) });
  });

  await page.goto('http://127.0.0.1:39898/', { waitUntil: 'domcontentloaded' });
  await page.locator('#app:not([hidden])').waitFor({ timeout: 15_000 });

  // 打开会话后收藏
  await page.locator('button[data-tab="threads"]').click();
  await page.locator('#mobileThreadList .thread-item', { hasText: '会话A' }).click();
  await page.locator('.agent-card', { hasText: '会话A内容' }).waitFor({ timeout: 10_000 });
  await page.locator('button[data-tab="threads"]').click();
  await page.locator('#mobileThreadList .thread-star').click();

  // 重命名（先非法名称，再合法）
  await page.locator('#mobileThreadList .thread-more').click();
  await page.locator('#threadActionDialog[open]').waitFor({ timeout: 5_000 });
  await page.locator('#threadRenameAction').click();
  await page.locator('#threadRenameDialog[open]').waitFor({ timeout: 5_000 });
  await page.locator('#threadRenameInput').fill('   ');
  await page.locator('#threadRenameConfirm').click();
  const renameStillOpen = await page.evaluate(() => document.querySelector('#threadRenameDialog').hasAttribute('open'));
  if (!renameStillOpen) throw new Error('非法名称不应关闭弹窗');
  await page.locator('#threadRenameInput').fill('会话A新名');
  await page.locator('#threadRenameConfirm').click();
  await page.waitForFunction(() => !document.querySelector('#threadRenameDialog').hasAttribute('open'), null, { timeout: 5_000 });
  const rowText = await page.locator('#mobileThreadList').textContent();
  if (!rowText.includes('会话A新名')) throw new Error(`改名未生效：${rowText}`);

  // 收藏同步新名称
  await page.locator('button[data-tab="favorites"]').click();
  const favoriteText = await page.locator('#favoriteList').textContent();
  if (!favoriteText.includes('会话A新名')) throw new Error(`收藏未同步新名称：${favoriteText}`);

  // 删除：当前会话被删除后聊天区回到空状态、收藏移除
  await page.locator('button[data-tab="threads"]').click();
  await page.locator('#mobileThreadList .thread-more').click();
  await page.locator('#threadActionDialog[open]').waitFor({ timeout: 5_000 });
  await page.locator('#threadDeleteAction').click();
  await page.locator('#threadDeleteConfirm:not([hidden])').waitFor({ timeout: 5_000 });
  await page.locator('#threadDeleteOk').click();
  await page.waitForFunction(() => !document.querySelector('#threadActionDialog').hasAttribute('open'), null, { timeout: 5_000 });
  const listAfterDelete = await page.locator('#mobileThreadList').textContent();
  if (listAfterDelete.includes('会话A')) throw new Error(`删除后仍存在：${listAfterDelete}`);
  await page.locator('button[data-tab="favorites"]').click();
  const favoriteAfterDelete = await page.locator('#favoriteList').textContent();
  if (!favoriteAfterDelete.includes('还没有收藏')) throw new Error(`收藏未同步删除：${favoriteAfterDelete}`);
  await page.locator('button[data-tab="chat"]').click();
  const chatEmpty = await page.evaluate(() => !document.querySelector('#emptyState').hidden);
  if (!chatEmpty) throw new Error('删除当前会话后聊天区未清空');

  process.stdout.write(JSON.stringify({ rowText, favoriteText, listAfterDelete, favoriteAfterDelete, chatEmpty }));
} finally {
  await browser.close();
}
