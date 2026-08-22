import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const playwrightPath = process.env.PLAYWRIGHT_PATH
  ?? '/home/ningmengchang/ideaProjects/dpp-cloud-saic/dpp-platform-web/node_modules/playwright';
const { chromium } = require(playwrightPath);
const publicRoot = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'public');

const source = {
  id: 'thread-source', cwd: '/projects/source', name: '原会话', preview: '历史问题', status: 'idle', updatedAt: 2,
  turns: [{ id: 'turn-1', status: 'completed', items: [
    { id: 'user-1', type: 'userMessage', content: [{ type: 'text', text: '历史问题' }] },
    { id: 'agent-1', type: 'agentMessage', text: '历史结论' },
  ] }],
};
const copied = { ...source, id: 'thread-copy', cwd: '/projects/target', name: '原会话（副本）' };
const bootstrap = {
  appServer: { ready: true }, runtime: { user: 'ningmengchang' }, models: [], collaborationModes: [], pendingRequests: [],
  projects: { current: { name: 'source', path: '/projects/source' }, parent: { name: 'projects', path: '/projects' }, root: '/projects', entries: [] },
};

const browser = await chromium.launch({ headless: true });
try {
  const context = await browser.newContext({
    viewport: { width: 390, height: 844 }, deviceScaleFactor: 2, isMobile: true, hasTouch: true,
  });
  await context.addInitScript(() => {
    window.EventSource = class {
      constructor() { setTimeout(() => this.onopen?.(), 20); }
      addEventListener() {}
      close() {}
    };
  });
  const page = await context.newPage();
  let copyBody = null;
  let copyCreated = false;
  await page.route('**/*', async (route) => {
    const url = new URL(route.request().url());
    const pathname = url.pathname;
    const fulfillJson = (body, status = 200) => route.fulfill({
      status, contentType: 'application/json; charset=utf-8', body: JSON.stringify(body),
    });
    if (pathname === '/api/auth/status') return fulfillJson({ authenticated: true });
    if (pathname === '/api/bootstrap') return fulfillJson(bootstrap);
    if (pathname === '/api/requests') return fulfillJson({ data: [] });
    if (pathname === '/api/favorites') return fulfillJson({ data: [] });
    if (pathname === '/api/projects') {
      const requested = url.searchParams.get('path') || '/projects/source';
      if (requested === '/projects') return fulfillJson({
        current: { name: 'projects', path: '/projects' }, parent: null, root: '/projects',
        entries: [
          { name: 'source', path: '/projects/source', isDirectory: true },
          { name: 'target', path: '/projects/target', isDirectory: true },
          { name: 'ignore.txt', path: '/projects/ignore.txt', isDirectory: false },
        ],
      });
      return fulfillJson({
        current: { name: path.basename(requested), path: requested },
        parent: { name: 'projects', path: '/projects' }, root: '/projects', entries: [],
      });
    }
    if (pathname === '/api/threads' && route.request().method() === 'GET') {
      return fulfillJson({ data: copyCreated ? [copied, source] : [source] });
    }
    if (pathname === '/api/threads/thread-source/copy' && route.request().method() === 'POST') {
      copyBody = route.request().postDataJSON();
      copyCreated = true;
      return fulfillJson({ copied: true, replayed: false, sourceThreadId: source.id, thread: copied }, 201);
    }
    if (pathname === '/api/threads/thread-copy') return fulfillJson({ thread: copied });
    if (pathname === '/api/threads/thread-copy/turns') return fulfillJson({ data: [...copied.turns].reverse(), nextCursor: null });
    if (pathname === '/api/threads/thread-copy/artifacts') return fulfillJson({ data: [] });
    if (pathname === '/api/events') return route.fulfill({ status: 200, contentType: 'text/event-stream', body: ': connected\n\n' });
    const file = path.join(publicRoot, pathname === '/' ? 'index.html' : pathname);
    if (!fs.existsSync(file) || !fs.statSync(file).isFile()) return route.fulfill({ status: 404, body: 'not found' });
    const contentType = file.endsWith('.js') ? 'text/javascript; charset=utf-8'
      : file.endsWith('.css') ? 'text/css; charset=utf-8'
        : file.endsWith('.html') ? 'text/html; charset=utf-8'
          : 'application/octet-stream';
    return route.fulfill({ status: 200, contentType, body: fs.readFileSync(file) });
  });

  await page.goto('http://127.0.0.1:39901/', { waitUntil: 'domcontentloaded' });
  await page.locator('#app:not([hidden])').waitFor({ timeout: 15_000 });
  await page.locator('#mobileThreadList .thread-more').click();
  await page.locator('#threadActionDialog[open]').waitFor();
  if (await page.locator('#threadCopyAction').isHidden()) throw new Error('会话列表菜单没有复制入口');
  await page.locator('#threadCopyAction').click();
  await page.locator('#threadCopyDialog[open]').waitFor();
  await page.locator('#threadCopyUpButton').click();
  await page.locator('#threadCopyDirectoryList button', { hasText: 'target' }).click();
  await page.waitForFunction(() => document.querySelector('#threadCopyPath').textContent === '/projects/target');
  await page.locator('#confirmThreadCopyButton').click();
  await page.locator('#chatView.active').waitFor({ timeout: 10_000 });
  await page.locator('.agent-card', { hasText: '历史结论' }).waitFor({ timeout: 10_000 });
  if (copyBody.cwd !== '/projects/target' || copyBody.name !== '原会话（副本）' || !copyBody.requestId) {
    throw new Error(`复制请求不完整：${JSON.stringify(copyBody)}`);
  }
  await page.locator('#chatThreadMoreButton').click();
  if (!await page.locator('#threadCopyAction').isHidden()) throw new Error('聊天详情菜单不应显示复制入口');
  process.stdout.write(`${JSON.stringify({ copiedTo: copyBody.cwd, requestId: copyBody.requestId, historyVisible: true })}\n`);
} finally {
  await browser.close();
}
