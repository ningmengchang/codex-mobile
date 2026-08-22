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
  id: 'thread-stable', cwd: '/projects/demo', name: '稳定会话', preview: '测试', status: 'idle', updatedAt: 1,
  turns: [{ id: 'turn-1', status: 'completed', items: [{ id: 'agent-1', type: 'agentMessage', text: '会话已加载' }] }],
};
const bootstrap = {
  appServer: { ready: true }, runtime: { user: 'ningmengchang' },
  backends: { active: 'gpt', data: [{ id: 'gpt', label: 'GPT', available: true, active: true }, { id: 'deepseek', label: 'DeepSeek', available: true }] },
  models: [], collaborationModes: [], pendingRequests: [], threadActivities: [], favorites: [],
  projects: { current: { name: 'demo', path: '/projects/demo' }, parent: null, entries: [] },
};

const browser = await chromium.launch({ headless: true });
try {
  const context = await browser.newContext({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true });
  await context.addInitScript(() => {
    window.EventSource = class {
      constructor() {
        this.listeners = new Map();
        setTimeout(() => {
          this.onopen?.();
          this.listeners.get('backend-changed')?.({ data: JSON.stringify({
            active: 'deepseek',
            at: new Date(Date.now() - 5 * 60 * 1000).toISOString(),
          }) });
        }, 20);
      }
      addEventListener(type, callback) { this.listeners.set(type, callback); }
      close() {}
    };
  });
  const page = await context.newPage();
  let bootstrapReads = 0;
  await page.route('**/*', async (route) => {
    const url = new URL(route.request().url());
    const pathname = url.pathname;
    const fulfillJson = (body, status = 200) => route.fulfill({ status, contentType: 'application/json', body: JSON.stringify(body) });
    if (pathname === '/api/auth/status') return fulfillJson({ authenticated: true });
    if (pathname === '/api/bootstrap') { bootstrapReads += 1; return fulfillJson(bootstrap); }
    if (pathname === '/api/catalogs') return fulfillJson(bootstrap);
    if (pathname === '/api/requests') return fulfillJson({ data: [] });
    if (pathname === '/api/threads') return fulfillJson({ data: [thread], nextCursor: null });
    if (pathname === '/api/threads/thread-stable') return fulfillJson({ thread });
    if (pathname === '/api/threads/thread-stable/turns') return fulfillJson({ data: [...thread.turns].reverse(), nextCursor: null });
    if (pathname === '/api/threads/thread-stable/artifacts') return fulfillJson({ data: [] });
    const file = path.join(publicRoot, pathname === '/' ? 'index.html' : pathname);
    if (!fs.existsSync(file) || !fs.statSync(file).isFile()) return route.fulfill({ status: 404, body: 'not found' });
    const contentType = file.endsWith('.js') ? 'text/javascript' : file.endsWith('.css') ? 'text/css' : file.endsWith('.html') ? 'text/html' : 'application/octet-stream';
    return route.fulfill({ status: 200, contentType, body: fs.readFileSync(file) });
  });

  await page.goto('http://127.0.0.1:39931/#chat/thread-stable', { waitUntil: 'domcontentloaded' });
  await page.locator('#app:not([hidden])').waitFor({ timeout: 15_000 });
  await page.locator('.agent-card', { hasText: '会话已加载' }).waitFor({ timeout: 15_000 });
  await page.waitForTimeout(500);
  const result = await page.evaluate(() => ({ hash: location.hash, chatActive: document.querySelector('#chatView')?.classList.contains('active') }));
  if (bootstrapReads !== 1 || result.hash !== '#chat/thread-stable' || !result.chatActive) {
    throw new Error(`过期 Agent 事件导致页面重载：${JSON.stringify({ bootstrapReads, result })}`);
  }
  process.stdout.write(`${JSON.stringify({ bootstrapReads, ...result, staleEventIgnored: true })}\n`);
} finally {
  await browser.close();
}
