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
  id: 'thread-1', cwd: '/home/ningmengchang', name: 'Markdown 预览测试', preview: '', status: 'idle', updatedAt: 1,
};
const historyTurn = {
  id: 'turn-1', status: 'completed', durationMs: 1000, items: [
    { id: 'user-1', type: 'userMessage', content: [{ type: 'text', text: '写一份带表格和流程图的文档' }] },
    { id: 'agent-1', type: 'agentMessage', text: '已生成 guide.md。' },
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
const artifact = {
  id: 'art-md', threadId: 'thread-1', turnId: 'turn-1', projectPath: '/home/ningmengchang',
  path: '/home/ningmengchang/guide.md', status: 'added', token: 'tok-md',
  capturedAt: '2026-08-09T00:00:00.000Z', modifiedAt: '2026-08-09T00:00:00.000Z',
  name: 'guide.md', relativePath: 'guide.md', fileKind: 'markdown', size: 512, available: true,
};
const markdownBody = [
  '# 预览标题',
  '',
  '<script>window.__xss = 1</script>',
  '',
  '| 功能 | 状态 |',
  '| --- | --- |',
  '| 表格 | 可用 |',
  '',
  '![示意图](./assets/mermaid/上汽电池护照状态机-流程图-1.png)',
  '',
  '```mermaid',
  'graph TD',
  'A[开始] --> B[处理]',
  'B --> C[结束]',
  '```',
].join('\n');

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
    if (pathname === '/api/projects') return fulfillJson(bootstrap.projects);
    if (pathname === '/api/threads' && route.request().method() === 'GET') return fulfillJson({ data: [thread] });
    if (pathname === '/api/threads/thread-1') return fulfillJson({ thread: { ...thread, turns: [historyTurn] } });
    if (pathname === '/api/threads/thread-1/resume') return fulfillJson({ thread: { ...thread, turns: [historyTurn] } });
    if (pathname === '/api/threads/thread-1/artifacts') return fulfillJson({ data: [artifact] });
    if (pathname === '/api/events') return route.fulfill({ status: 200, contentType: 'text/event-stream', body: ': connected\n\n' });
    const meta = pathname.match(/^\/api\/artifacts\/([^/]+)\/meta$/);
    if (meta && meta[1] === 'tok-md') {
      return fulfillJson({ name: artifact.name, relativePath: artifact.relativePath, fileKind: 'markdown', size: artifact.size, isDirectory: false });
    }
    const raw = pathname.match(/^\/api\/artifacts\/([^/]+)\/raw$/);
    if (raw && raw[1] === 'tok-md') {
      return route.fulfill({ status: 200, contentType: 'text/markdown; charset=utf-8', body: markdownBody });
    }
    const related = pathname.match(/^\/api\/artifacts\/([^/]+)\/related$/);
    if (related && related[1] === 'tok-md' && url.searchParams.get('path') === 'assets/mermaid/上汽电池护照状态机-流程图-1.png') {
      const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==', 'base64');
      return route.fulfill({ status: 200, contentType: 'image/png', body: png });
    }
    const file = path.join(publicRoot, pathname === '/' ? 'index.html' : pathname);
    if (!fs.existsSync(file) || !fs.statSync(file).isFile()) return route.fulfill({ status: 404, body: 'not found' });
    const contentType = file.endsWith('.js') || file.endsWith('.mjs') ? 'text/javascript; charset=utf-8'
      : file.endsWith('.css') ? 'text/css; charset=utf-8'
        : file.endsWith('.html') ? 'text/html; charset=utf-8'
          : 'application/octet-stream';
    return route.fulfill({ status: 200, contentType, body: fs.readFileSync(file) });
  });

  await page.goto('http://127.0.0.1:39899/', { waitUntil: 'domcontentloaded' });
  await page.locator('#app:not([hidden])').waitFor({ timeout: 15_000 });
  await page.locator('button[data-tab="threads"]').click();
  await page.locator('#mobileThreadList .thread-item').first().click();
  await page.locator('#emptyState').waitFor({ state: 'hidden', timeout: 15_000 });
  await page.locator('button[data-tab="artifacts"]').click();
  await page.locator('.artifact-card').waitFor({ timeout: 10_000 });
  await page.locator('.artifact-card button[data-action="preview"]').click();
  await page.locator('#previewDialog[open]').waitFor({ timeout: 10_000 });
  try {
    await page.locator('#previewBody .markdown-table').waitFor({ timeout: 10_000 });
  } catch (error) {
    const bodyHtml = await page.evaluate(() => document.querySelector('#previewBody')?.innerHTML ?? 'NO BODY');
    throw new Error(`表格未出现。body=${bodyHtml.slice(0, 800)}`);
  }

  const tableText = await page.locator('#previewBody .markdown-table').textContent();
  if (!tableText.includes('功能') || !tableText.includes('表格') || !tableText.includes('可用')) {
    throw new Error(`表格渲染异常：${tableText}`);
  }
  const heading = await page.locator('#previewBody h1').textContent();
  if (heading !== '预览标题') throw new Error(`标题渲染异常：${heading}`);
  const scriptCount = await page.locator('#previewBody script').count();
  if (scriptCount !== 0) throw new Error(`Markdown 中原始 HTML 未被过滤：${scriptCount}`);
  await page.waitForFunction(() => {
    const img = document.querySelector('#previewBody img');
    return img && img.complete && img.naturalWidth > 0;
  }, null, { timeout: 10_000 });
  const imgSrc = await page.locator('#previewBody img').getAttribute('src');
  if (!imgSrc.includes('/api/artifacts/tok-md/related?path=') || !imgSrc.includes('assets%2Fmermaid%2F') || imgSrc.includes('%25')) {
    throw new Error(`相对图片未重写：${imgSrc}`);
  }
  const naturalWidth = await page.evaluate(() => document.querySelector('#previewBody img')?.naturalWidth ?? 0);
  if (naturalWidth <= 0) throw new Error(`图片未成功加载：${imgSrc}`);
  await page.locator('#previewBody .mermaid-block svg').waitFor({ timeout: 20_000 });
  const rendered = await page.evaluate(() => document.querySelector('#previewBody .mermaid-block')?.dataset.mermaidRendered);
  if (rendered !== 'ok') throw new Error(`Mermaid 渲染失败：${rendered}`);
  process.stdout.write(`${JSON.stringify({ tableOk: true, heading, xssBlocked: scriptCount === 0, imgRewritten: true, imgLoaded: naturalWidth > 0, mermaid: rendered })}\n`);
} finally {
  await browser.close();
}
