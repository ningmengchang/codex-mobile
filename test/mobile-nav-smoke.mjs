import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const playwrightPath = process.env.PLAYWRIGHT_PATH
  ?? '/home/ningmengchang/ideaProjects/dpp-cloud-saic/dpp-platform-web/node_modules/playwright';
const { chromium } = require(playwrightPath);

const publicRoot = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'public');
const bootstrap = {
  appServer: { ready: true },
  runtime: { user: 'ningmengchang' },
  models: [],
  collaborationModes: [],
  pendingRequests: [],
  projects: { current: { name: 'home', path: '/home/ningmengchang' }, parent: null, entries: [] },
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
    const pathname = new URL(route.request().url()).pathname;
    const fulfillJson = (body, status = 200) => route.fulfill({
      status, contentType: 'application/json; charset=utf-8', body: JSON.stringify(body),
    });
    if (pathname === '/api/auth/status') return fulfillJson({ authenticated: true });
    if (pathname === '/api/bootstrap') return fulfillJson(bootstrap);
    if (pathname === '/api/requests') return fulfillJson({ data: [] });
    if (pathname === '/api/projects') return fulfillJson(bootstrap.projects);
    if (pathname === '/api/threads' && route.request().method() === 'GET') return fulfillJson({ data: [] });
    if (pathname === '/api/events') return route.fulfill({ status: 200, contentType: 'text/event-stream', body: ': connected\n\n' });
    const file = path.join(publicRoot, pathname === '/' ? 'index.html' : pathname);
    if (!fs.existsSync(file) || !fs.statSync(file).isFile()) return route.fulfill({ status: 404, body: 'not found' });
    const contentType = file.endsWith('.js') ? 'text/javascript; charset=utf-8'
      : file.endsWith('.css') ? 'text/css; charset=utf-8'
        : file.endsWith('.html') ? 'text/html; charset=utf-8'
          : 'application/octet-stream';
    return route.fulfill({ status: 200, contentType, body: fs.readFileSync(file) });
  });

  await page.goto('http://127.0.0.1:39885/', { waitUntil: 'domcontentloaded' });
  await page.locator('#app:not([hidden])').waitFor({ timeout: 15_000 });
  await page.waitForTimeout(300);

  // 1) 按钮顺序：会话 | 产出物 | 控制 | 项目 | 设置
  const labels = await page.locator('.bottom-nav button small').allTextContents();
  const expected = ['会话', '产出物', '控制', '项目', '设置'];
  if (JSON.stringify(labels) !== JSON.stringify(expected)) {
    throw new Error(`底部按钮顺序错误：${labels.join('、')}`);
  }

  // 2) 控制按钮居中、凸起、强调色
  const primary = await page.evaluate(() => {
    const button = document.querySelector('.bottom-nav button.nav-primary');
    const rect = button.getBoundingClientRect();
    const transform = getComputedStyle(button).transform;
    const background = getComputedStyle(button).backgroundColor;
    return {
      height: Math.round(rect.height),
      width: Math.round(rect.width),
      centerX: Math.round(rect.left + rect.width / 2),
      viewportWidth: innerWidth,
      transform,
      background,
    };
  });
  if (!primary.transform.includes('-8') || primary.height < 44) {
    throw new Error(`控制按钮未凸起：${JSON.stringify(primary)}`);
  }
  if (Math.abs(primary.centerX - primary.viewportWidth / 2) > 2) {
    throw new Error(`控制按钮未居中：${JSON.stringify(primary)}`);
  }
  if (primary.background === 'rgba(0, 0, 0, 0)') {
    throw new Error('控制按钮缺少强调背景色');
  }

  // 3) 与输入框不重叠
  const dock = await page.evaluate(() => {
    const primary = document.querySelector('.bottom-nav button.nav-primary').getBoundingClientRect();
    const composer = document.querySelector('.composer').getBoundingClientRect();
    const textarea = document.querySelector('#promptInput').getBoundingClientRect();
    return {
      primaryTop: Math.round(primary.top),
      composerBottom: Math.round(composer.bottom),
      textareaBottom: Math.round(textarea.bottom),
      dock: Math.round(composer.bottom - primary.top),
    };
  });
  if (dock.dock < 4 || dock.dock > 8) throw new Error(`控制按钮未贴边嵌入：${JSON.stringify(dock)}`);
  if (dock.primaryTop < dock.textareaBottom - 1) throw new Error(`控制按钮遮挡输入文字：${JSON.stringify(dock)}`);

  // 4) 切换交互正常
  await page.locator('button[data-tab="artifacts"]').click();
  await page.locator('#artifactsView.active').waitFor({ timeout: 10_000 });
  await page.locator('button[data-tab="chat"]').click();
  await page.locator('#chatView.active').waitFor({ timeout: 10_000 });
  await page.locator('#settingsButton').click();
  await page.locator('#settingsSheet[open]').waitFor({ timeout: 10_000 });

  await page.screenshot({ path: process.env.CODEX_MOBILE_SCREENSHOT ?? '/tmp/codex-mobile-nav.png', fullPage: true });
  process.stdout.write(`${JSON.stringify({ labels, primary, dock })}\n`);
} finally {
  await browser.close();
}
