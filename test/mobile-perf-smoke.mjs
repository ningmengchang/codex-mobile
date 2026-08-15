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
  id: 'thread-1', cwd: '/home/ningmengchang', name: '性能测试', preview: '', status: 'idle', updatedAt: 1,
};
const turns = ['turn-1', 'turn-2', 'turn-3'].map((turnId, index) => ({
  id: turnId, status: 'completed', durationMs: 1000, items: [
    { id: `user-${index + 1}`, type: 'userMessage', content: [{ type: 'text', text: `第 ${index + 1} 个问题` }] },
    { id: `agent-${index + 1}`, type: 'agentMessage', text: `第 ${index + 1} 个回答。`.repeat(12) },
  ],
}));
const bootstrap = {
  appServer: { ready: true },
  runtime: { user: 'ningmengchang' },
  models: [],
  collaborationModes: [],
  pendingRequests: [],
  projects: { current: { name: 'home', path: '/home/ningmengchang' }, parent: null, entries: [] },
};
const artifactRequests = [];

const artifacts = [];
for (let index = 0; index < 10; index += 1) {
  artifacts.push({
    id: `doc-${index}`, threadId: 'thread-1', turnId: 'turn-1', projectPath: '/home/ningmengchang',
    path: `/home/ningmengchang/docs/prd-${index}.md`, status: 'added',
    capturedAt: '2026-08-07T01:45:10.991Z', modifiedAt: `2026-08-07T09:3${index}:00.000Z`,
    name: `prd-${index}.md`, relativePath: `docs/prd-${index}.md`, fileKind: 'markdown',
    size: 1000, available: true, token: `tok-doc-${index}`,
  });
}
for (let index = 0; index < 990; index += 1) {
  artifacts.push({
    id: `other-${index}`, threadId: 'thread-1', turnId: index % 3 === 0 ? 'turn-2' : 'turn-1',
    projectPath: '/home/ningmengchang', path: `/home/ningmengchang/assets/file-${index}.png`, status: 'added',
    capturedAt: '2026-08-07T01:45:10.991Z', modifiedAt: '2026-08-07T09:50:00.000Z',
    name: `file-${index}.png`, relativePath: `assets/file-${index}.png`, fileKind: 'image',
    size: 100, available: true, token: `tok-other-${index}`,
  });
}

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
  await page.route('**/*', async (route) => {
    const pathname = new URL(route.request().url()).pathname;
    const fulfillJson = (body, status = 200) => route.fulfill({
      status, contentType: 'application/json; charset=utf-8', body: JSON.stringify(body),
    });
    if (pathname === '/api/auth/status') return fulfillJson({ authenticated: true });
    if (pathname === '/api/bootstrap') return fulfillJson(bootstrap);
    if (pathname === '/api/requests') return fulfillJson({ data: [] });
    if (pathname === '/api/projects') return fulfillJson(bootstrap.projects);
    if (pathname === '/api/threads' && route.request().method() === 'GET') return fulfillJson({ data: [thread] });
    if (pathname === '/api/threads/thread-1') {
      return fulfillJson({ thread: { ...thread, turns } });
    }
    if (pathname === '/api/threads/thread-1/resume') {
      return fulfillJson({ thread: { ...thread, turns } });
    }
    if (pathname === '/api/threads/thread-1/artifacts') {
      const url = new URL(route.request().url());
      const search = (url.searchParams.get('search') ?? '').trim().toLowerCase();
      const offset = Number.parseInt(url.searchParams.get('offset') ?? '0', 10) || 0;
      const limit = Number.parseInt(url.searchParams.get('limit') ?? '100', 10) || 100;
      const filtered = search
        ? artifacts.filter((item) => `${item.name} ${item.relativePath}`.toLowerCase().includes(search))
        : artifacts;
      const nextOffset = offset + limit < filtered.length ? offset + limit : null;
      artifactRequests.push({ search, offset, limit });
      return fulfillJson({ data: filtered.slice(offset, offset + limit), total: filtered.length, nextOffset });
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

  await page.goto('http://127.0.0.1:39883/', { waitUntil: 'domcontentloaded' });
  await page.locator('#app:not([hidden])').waitFor({ timeout: 15_000 });
  await page.locator('button[data-tab="threads"]').click();
  await page.locator('#mobileThreadList .thread-item').first().click();
  await page.locator('#emptyState').waitFor({ state: 'hidden', timeout: 15_000 });
  await page.locator('.message.user .bubble').first().waitFor({ timeout: 10_000 });
  await page.locator('.turn-artifacts').waitFor({ timeout: 10_000 });

  const messageHandle = await page.locator('#timeline [data-item-id="user-1"]').elementHandle();

  // 1) 产出物首屏只渲染 置顶(0) + 文档(10) + 其他(50)
  await page.locator('button[data-tab="artifacts"]').click();
  await page.locator('#artifactsView.active').waitFor({ timeout: 10_000 });
  await page.waitForTimeout(150);
  const initialCards = await page.locator('.artifact-card').count();
  if (initialCards !== 60) throw new Error(`首屏应渲染 60 张卡片，实际 ${initialCards}`);
  const moreText = await page.locator('[data-action="more"]').textContent();
  if (!moreText.includes('40')) throw new Error(`显示更多文案错误：${moreText}`);
  const remoteMoreText = await page.locator('[data-action="load-more"]').textContent();
  if (!remoteMoreText.includes('100/1000')) throw new Error(`分页加载文案错误：${remoteMoreText}`);
  if (artifactRequests[0]?.limit !== 100 || artifactRequests[0]?.offset !== 0) {
    throw new Error(`首屏产出物请求未分页：${JSON.stringify(artifactRequests)}`);
  }

  // 2) 显示更多每次追加 100 条
  const renderMoreStart = Date.now();
  await page.locator('[data-action="more"]').click();
  await page.waitForTimeout(150);
  const afterMoreCards = await page.locator('.artifact-card').count();
  const moreRenderMs = Date.now() - renderMoreStart;
  if (afterMoreCards !== 100) throw new Error(`显示更多后应 100 张卡片，实际 ${afterMoreCards}`);

  // 3) 继续读取下一页后仍只增量展示，不一次构建全部 1000 张卡片
  await page.locator('[data-action="load-more"]').click();
  await page.waitForFunction(() => document.querySelectorAll('.artifact-card').length === 160);
  const afterRemoteMoreCards = await page.locator('.artifact-card').count();
  if (artifactRequests.at(-1)?.offset !== 100) {
    throw new Error(`第二页 offset 错误：${JSON.stringify(artifactRequests)}`);
  }

  // 4) 切回控制不重建时间线
  const switchToChatMs = await page.evaluate(() => {
    const started = performance.now();
    document.querySelector('button[data-tab="chat"]').click();
    return performance.now() - started;
  });
  await page.waitForTimeout(50);
  const messageStillSame = await page.evaluate((handle) => {
    const current = document.querySelector('#timeline [data-item-id="user-1"]');
    return handle === current && document.contains(handle);
  }, messageHandle);
  if (!messageStillSame) throw new Error('切回聊天时时间线被全量重建');
  if (switchToChatMs > 200) throw new Error(`切回聊天耗时过长：${switchToChatMs.toFixed(1)}ms`);

  // 5) SSE 新产出物只更新“本次产出”条，不重建消息节点
  const newDoc = {
    id: 'doc-new', threadId: 'thread-1', turnId: 'turn-1', projectPath: '/home/ningmengchang',
    path: '/home/ningmengchang/docs/login-log-prd.md', status: 'added',
    capturedAt: '2026-08-07T01:45:10.991Z', modifiedAt: '2026-08-07T10:00:00.000Z',
    name: '登录日志 PRD.md', relativePath: 'docs/login-log-prd.md', fileKind: 'markdown',
    size: 1600, available: true, token: 'tok-new',
  };
  await page.evaluate((item) => {
    window.__sse.emit('artifacts', { threadId: 'thread-1', turnId: 'turn-1', items: [item] });
  }, newDoc);
  await page.locator('.turn-artifact-chip', { hasText: '登录日志 PRD.md' }).waitFor({ timeout: 10_000 });
  const messageStillSameAfterSse = await page.evaluate((handle) => {
    const current = document.querySelector('#timeline [data-item-id="user-1"]');
    return handle === current && document.contains(handle);
  }, messageHandle);
  if (!messageStillSameAfterSse) throw new Error('SSE 推送后消息节点被重建');

  // 6) 再来回切一次仍是 O(1) 显示切换
  const roundTripMs = await page.evaluate(async () => {
    const started = performance.now();
    document.querySelector('button[data-tab="artifacts"]').click();
    await new Promise((resolve) => setTimeout(resolve, 30));
    document.querySelector('button[data-tab="chat"]').click();
    return performance.now() - started;
  });
  if (roundTripMs > 300) throw new Error(`来回切换耗时过长：${roundTripMs.toFixed(1)}ms`);

  await page.screenshot({ path: process.env.CODEX_MOBILE_SCREENSHOT ?? '/tmp/codex-mobile-perf.png', fullPage: true });
  process.stdout.write(`${JSON.stringify({ initialCards, moreText, afterMoreCards, afterRemoteMoreCards, artifactRequests, switchToChatMs: +switchToChatMs.toFixed(1), moreRenderMs, roundTripMs: +roundTripMs.toFixed(1) })}\n`);
} finally {
  await browser.close();
}
