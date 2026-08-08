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

  const control = () => page.locator('.bottom-nav button.nav-primary');
  const popoverVisible = () => page.evaluate(() => !document.querySelector('#fullscreenPopover').hidden);
  const activeTab = () => page.evaluate(() => document.querySelector('.bottom-nav button.active')?.dataset.tab);
  const longPress = async () => {
    await control().dispatchEvent('pointerdown', { pointerType: 'touch', button: 0, pointerId: 1 });
    await page.waitForTimeout(550);
    await control().dispatchEvent('pointerup', { pointerType: 'touch', button: 0, pointerId: 1 });
  };

  await page.goto('http://127.0.0.1:39896/', { waitUntil: 'domcontentloaded' });
  await page.locator('#app:not([hidden])').waitFor({ timeout: 15_000 });
  await page.locator('#fullscreenPopover').waitFor({ state: 'attached', timeout: 5_000 });

  // 1) 初始：输入区没有全屏按钮，popover 隐藏
  const initial = await page.evaluate(() => ({
    popoverHidden: document.querySelector('#fullscreenPopover').hidden,
    composerHasButton: Boolean(document.querySelector('.composer-meta #fullscreenButton')),
  }));
  if (!initial.popoverHidden || initial.composerHasButton) throw new Error(`初始状态异常：${JSON.stringify(initial)}`);

  // 2) 长按控制按钮 → popover 出现
  await longPress();
  if (!(await popoverVisible())) throw new Error('长按后 popover 未出现');
  const position = await page.evaluate(() => {
    const popover = document.querySelector('#fullscreenPopover').getBoundingClientRect();
    const jump = document.querySelector('#jumpQuestionButton').getBoundingClientRect();
    return { popoverBottom: Math.round(popover.bottom), jumpTop: Math.round(jump.top), above: popover.bottom < jump.top };
  });
  if (!position.above) throw new Error(`全屏按钮未在上一问题上方：${JSON.stringify(position)}`);
  const pressedAfterOpen = await page.evaluate(() => document.querySelector('#fullscreenButton').getAttribute('aria-pressed'));
  if (pressedAfterOpen !== 'false') throw new Error(`打开时状态异常：${pressedAfterOpen}`);

  // 3) 点击全屏按钮 → 进入全屏且 popover 收起
  await page.locator('#fullscreenButton').click();
  await page.waitForTimeout(300);
  const entered = await page.evaluate(() => ({
    fullscreen: Boolean(document.fullscreenElement || document.webkitFullscreenElement),
    bodyClass: document.body.classList.contains('fullscreen-active'),
    popoverHidden: document.querySelector('#fullscreenPopover').hidden,
  }));
  if ((!entered.fullscreen && !entered.bodyClass) || !entered.popoverHidden) throw new Error(`未进入全屏：${JSON.stringify(entered)}`);

  // 4) 再次长按并点击 → 退出全屏
  await longPress();
  await page.locator('#fullscreenButton').click();
  await page.waitForTimeout(300);
  const exited = await page.evaluate(() => ({
    fullscreen: Boolean(document.fullscreenElement || document.webkitFullscreenElement),
    bodyClass: document.body.classList.contains('fullscreen-active'),
    popoverHidden: document.querySelector('#fullscreenPopover').hidden,
  }));
  if (exited.fullscreen || exited.bodyClass || !exited.popoverHidden) throw new Error(`未退出全屏：${JSON.stringify(exited)}`);

  // 5) 长按不切换 tab；短按正常切换
  await page.locator('button[data-tab="artifacts"]').click();
  await page.waitForTimeout(100);
  await longPress();
  if ((await activeTab()) !== 'artifacts') throw new Error('长按不应切换 tab');
  if (!(await popoverVisible())) throw new Error('产出物页长按后 popover 未出现');
  await page.evaluate(() => document.querySelector('.bottom-nav button.nav-primary').click());
  if ((await activeTab()) !== 'artifacts') throw new Error('长按后的点击应被抑制');
  await page.locator('.bottom-nav button.nav-primary').click();
  if ((await activeTab()) !== 'chat') throw new Error('短按未正常切换');
  if (await popoverVisible()) throw new Error('短按不应显示 popover');

  // 6) 长按后 3 秒自动隐藏
  await longPress();
  if (!(await popoverVisible())) throw new Error('长按后 popover 未出现');
  await page.waitForTimeout(3200);
  if (await popoverVisible()) throw new Error('popover 未自动隐藏');

  process.stdout.write(JSON.stringify({ initial, entered, exited, suppressionOk: true, autoHideOk: true }));
} finally {
  await browser.close();
}
