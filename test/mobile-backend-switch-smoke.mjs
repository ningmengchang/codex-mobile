import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';
import { swipeRight } from './helpers/mobile-gestures.mjs';

const require = createRequire(import.meta.url);
const playwrightPath = process.env.PLAYWRIGHT_PATH
  ?? '/home/ningmengchang/ideaProjects/dpp-cloud-saic/dpp-platform-web/node_modules/playwright';
const { chromium } = require(playwrightPath);
const publicRoot = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'public');

let activeBackend = 'gpt';
const switchBodies = [];
const backendData = () => ({
  active: activeBackend,
  data: [
    { id: 'gpt', label: 'GPT', description: '设备码登录 · OpenAI', available: true, active: activeBackend === 'gpt' },
    { id: 'deepseek', label: 'DeepSeek', description: '独立本地配置', available: true, active: activeBackend === 'deepseek' },
  ],
});
const bootstrap = () => ({
  appServer: { ready: true }, runtime: { user: 'ningmengchang', codexHome: activeBackend === 'gpt' ? '/home/user/.codex' : '/home/user/.codex-ds' },
  backends: backendData(),
  defaultModel: activeBackend === 'gpt' ? 'gpt-model' : 'deepseek-v4-flash',
  defaultEffort: activeBackend === 'gpt' ? 'max' : 'high',
  models: [{ id: activeBackend === 'gpt' ? 'gpt-model' : 'deepseek-v4-flash', isDefault: true }],
  collaborationModes: [], pendingRequests: [], threadActivities: [], favorites: [],
  projects: { current: { name: 'demo', path: '/projects/demo' }, parent: '/projects', entries: [] },
});

const browser = await chromium.launch({ headless: true });
try {
  const context = await browser.newContext({
    viewport: { width: 390, height: 844 }, deviceScaleFactor: 2, isMobile: true, hasTouch: true,
  });
  await context.addInitScript(() => {
    window.EventSource = class {
      constructor() { setTimeout(() => this.onopen?.(), 10); }
      addEventListener() {}
      close() {}
    };
  });
  const page = await context.newPage();
  page.on('dialog', (dialog) => dialog.accept());
  await page.route('**/*', async (route) => {
    const url = new URL(route.request().url());
    const pathname = url.pathname;
    const method = route.request().method();
    const fulfillJson = (body, status = 200) => route.fulfill({
      status, contentType: 'application/json; charset=utf-8', body: JSON.stringify(body),
    });
    if (pathname === '/api/auth/status') return fulfillJson({ authenticated: true });
    if (pathname === '/api/bootstrap') return fulfillJson(bootstrap());
    if (pathname === '/api/catalogs') return fulfillJson(bootstrap());
    if (pathname === '/api/threads' && method === 'GET') return fulfillJson({ data: [], nextCursor: null });
    if (pathname === '/api/requests') return fulfillJson({ data: [] });
    if (pathname === '/api/runtime/backend' && method === 'POST') {
      const body = JSON.parse(route.request().postData() || '{}');
      switchBodies.push(body);
      if (body.force !== true) {
        return fulfillJson({
          error: 'BACKEND_BUSY', message: '仍有会话正在执行或等待确认，切换会中断这些任务。',
          data: { activeThreads: ['thread-running'] },
        }, 409);
      }
      activeBackend = body.id;
      return fulfillJson({ active: activeBackend, backends: backendData(), defaultModel: 'deepseek-v4-flash' });
    }
    const file = path.join(publicRoot, pathname === '/' ? 'index.html' : pathname);
    if (!fs.existsSync(file) || !fs.statSync(file).isFile()) return route.fulfill({ status: 404, body: 'not found' });
    const contentType = file.endsWith('.js') ? 'text/javascript; charset=utf-8'
      : file.endsWith('.css') ? 'text/css; charset=utf-8'
        : file.endsWith('.html') ? 'text/html; charset=utf-8'
          : 'application/octet-stream';
    return route.fulfill({ status: 200, contentType, body: fs.readFileSync(file) });
  });

  await page.goto('http://127.0.0.1:39925/', { waitUntil: 'domcontentloaded' });
  await page.locator('#app:not([hidden])').waitFor({ timeout: 15_000 });
  await swipeRight(page, '#threadsView');
  await page.locator('#projectsView.active').waitFor();
  await page.locator('#settingsButton').click();
  await page.locator('#backendSelect').selectOption('deepseek');
  await page.waitForFunction(() => document.querySelector('#app') && !document.querySelector('#app').hidden
    && document.querySelector('#backendSelect')?.value === 'deepseek', null, { timeout: 15_000 });
  if (switchBodies.length !== 2 || switchBodies[0].id !== 'deepseek' || switchBodies[0].force === true
      || switchBodies[1].id !== 'deepseek' || switchBodies[1].force !== true) {
    throw new Error(`Agent 切换请求异常：${JSON.stringify(switchBodies)}`);
  }
  await swipeRight(page, '#threadsView');
  await page.locator('#projectsView.active').waitFor();
  await page.locator('#settingsButton').click();
  const result = await page.evaluate(() => ({
    backend: document.querySelector('#backendSelect').value,
    model: document.querySelector('#modelSelect').value,
    runtime: document.querySelector('#settingsRuntime').textContent,
  }));
  if (result.backend !== 'deepseek' || result.model !== 'deepseek-v4-flash' || !result.runtime.includes('DeepSeek')) {
    throw new Error(`切换后设置状态异常：${JSON.stringify(result)}`);
  }
  process.stdout.write(`${JSON.stringify({ switchBodies, result })}\n`);
} finally {
  await browser.close();
}
