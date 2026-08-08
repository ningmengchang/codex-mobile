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

  const activeState = () => page.evaluate(() => ({
    fullscreen: Boolean(document.fullscreenElement || document.webkitFullscreenElement),
    bodyClass: document.body.classList.contains('fullscreen-active'),
    pressed: document.querySelector('#fullscreenButton').getAttribute('aria-pressed'),
  }));

  await page.goto('http://127.0.0.1:39896/', { waitUntil: 'domcontentloaded' });
  await page.locator('#app:not([hidden])').waitFor({ timeout: 15_000 });
  await page.locator('#fullscreenButton').waitFor({ state: 'attached', timeout: 5_000 });

  // 0) manifest 声明安装态全屏
  const manifest = await page.evaluate(async () => {
    const response = await fetch('/manifest.webmanifest');
    return await response.json();
  });
  if (!Array.isArray(manifest.display_override) || !manifest.display_override.includes('fullscreen')) {
    throw new Error(`manifest 缺少 display_override fullscreen：${JSON.stringify(manifest)}`);
  }

  // 1) 按钮常驻右侧、“上一问题”上方；无长按弹层
  const position = await page.evaluate(() => {
    const button = document.querySelector('#fullscreenButton').getBoundingClientRect();
    const jumpButton = document.querySelector('#jumpQuestionButton');
    const hiddenBefore = jumpButton.hidden;
    jumpButton.hidden = false;
    const jump = jumpButton.getBoundingClientRect();
    jumpButton.hidden = hiddenBefore;
    return {
      buttonRight: Math.round(button.right),
      viewportWidth: innerWidth,
      buttonTop: Math.round(button.top),
      jumpTop: Math.round(jump.top),
      popoverGone: !document.querySelector('#fullscreenPopover'),
    };
  });
  if (position.popoverGone !== true) throw new Error(`弹层未移除：${JSON.stringify(position)}`);
  if (position.buttonRight > position.viewportWidth) throw new Error(`按钮超出右边界：${JSON.stringify(position)}`);
  if (position.buttonTop >= position.jumpTop) throw new Error(`按钮未在“上一问题”上方：${JSON.stringify(position)}`);

  // 2) 首次任意点按（浏览器限制下）自动进入全屏
  await page.evaluate(() => document.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true, pointerType: 'touch', pointerId: 1 })));
  await page.waitForTimeout(400);
  const enteredByFallback = await activeState();
  if ((!enteredByFallback.fullscreen && !enteredByFallback.bodyClass) || enteredByFallback.pressed !== 'true') {
    throw new Error(`首次点按未进入全屏：${JSON.stringify(enteredByFallback)}`);
  }

  // 3) 点按钮退出全屏
  await page.locator('#fullscreenButton').click();
  await page.waitForTimeout(300);
  const exited = await activeState();
  if (exited.fullscreen || exited.bodyClass || exited.pressed !== 'false') throw new Error(`未退出全屏：${JSON.stringify(exited)}`);

  // 4) 再点按钮重新进入，且不会“刚进就退”
  await page.locator('#fullscreenButton').click();
  await page.waitForTimeout(400);
  const reentered = await activeState();
  if ((!reentered.fullscreen && !reentered.bodyClass) || reentered.pressed !== 'true') {
    throw new Error(`按钮未能重新进入全屏：${JSON.stringify(reentered)}`);
  }

  process.stdout.write(JSON.stringify({ position, enteredByFallback, exited, reentered }));
} finally {
  await browser.close();
}
