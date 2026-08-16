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
    const listeners = new Map();
    const fakeViewport = {
      width: 390,
      height: 844,
      offsetTop: 0,
      offsetLeft: 0,
      addEventListener(type, callback) {
        if (!listeners.has(type)) listeners.set(type, []);
        listeners.get(type).push(callback);
      },
      removeEventListener(type, callback) {
        const list = listeners.get(type) ?? [];
        const index = list.indexOf(callback);
        if (index >= 0) list.splice(index, 1);
      },
    };
    Object.defineProperty(window, 'visualViewport', { value: fakeViewport, configurable: true });
    window.__keyboard = {
      setHeight(height) {
        fakeViewport.height = height;
        for (const callback of listeners.get('resize') ?? []) callback();
      },
    };
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
    if (pathname === '/api/threads' && route.request().method() === 'POST') {
      return fulfillJson({ thread: { id: 'thread-new', cwd: '/home/ningmengchang', name: '键盘测试', turns: [] } });
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

  await page.goto('http://127.0.0.1:39902/', { waitUntil: 'domcontentloaded' });
  await page.locator('#app:not([hidden])').waitFor({ timeout: 15_000 });
  await swipeRight(page, '#threadsView');
  await page.locator('#projectsView.active').waitFor({ timeout: 5_000 });
  await page.locator('#mobileNewThreadButton').click();
  await page.locator('#chatView.active').waitFor({ timeout: 5_000 });
  await page.locator('#promptInput').focus();
  await page.waitForFunction(() => document.body.classList.contains('keyboard-open'), null, { timeout: 5_000 });
  await page.evaluate(() => window.__keyboard.setHeight(544));
  await page.waitForFunction(() => document.documentElement.style.getPropertyValue('--kb-inset') === '300px', null, { timeout: 5_000 });

  const opened = await page.evaluate(() => {
    const composer = document.querySelector('#composer').getBoundingClientRect();
    const fullscreen = document.querySelector('#fullscreenButton');
    const scrollQuestion = document.querySelector('#jumpQuestionButton');
    const scrollLatest = document.querySelector('#scrollLatestButton');
    return {
      keyboardOpen: document.body.classList.contains('keyboard-open'),
      kbInset: document.documentElement.style.getPropertyValue('--kb-inset'),
      composerBottom: Math.round(composer.bottom),
      navigationRemoved: !document.querySelector('.bottom-nav'),
      fullscreenDisplay: getComputedStyle(fullscreen).display,
      fullscreenBottom: Math.round(parseFloat(getComputedStyle(fullscreen).bottom)),
      scrollQuestionBottom: Math.round(parseFloat(getComputedStyle(scrollQuestion).bottom)),
      scrollLatestBottom: Math.round(parseFloat(getComputedStyle(scrollLatest).bottom)),
    };
  });
  if (!opened.keyboardOpen || opened.kbInset !== '300px') throw new Error(`键盘态未生效：${JSON.stringify(opened)}`);
  if (opened.composerBottom > 548 || opened.composerBottom < 540) throw new Error(`输入框未抬到键盘上方：${JSON.stringify(opened)}`);
  if (!opened.navigationRemoved) throw new Error(`键盘打开时仍存在底部导航：${JSON.stringify(opened)}`);
  if (opened.fullscreenDisplay === 'none') throw new Error(`键盘打开时全屏按钮不应隐藏：${JSON.stringify(opened)}`);
  if (opened.fullscreenBottom <= opened.scrollQuestionBottom) throw new Error(`全屏按钮未保持在上一个问题上方：${JSON.stringify(opened)}`);
  if (Math.abs(opened.fullscreenBottom - 462) > 2 || Math.abs(opened.scrollQuestionBottom - 422) > 2) {
    throw new Error(`键盘打开时悬浮按钮未随键盘上移：${JSON.stringify(opened)}`);
  }

  await page.evaluate(() => document.activeElement?.blur());
  await page.evaluate(() => window.__keyboard.setHeight(844));
  await page.waitForFunction(() => !document.body.classList.contains('keyboard-open'), null, { timeout: 5_000 });
  await page.waitForFunction(() => document.documentElement.style.getPropertyValue('--kb-inset') === '0px', null, { timeout: 5_000 });
  const closed = await page.evaluate(() => {
    const composer = document.querySelector('#composer').getBoundingClientRect();
    return {
      keyboardOpen: document.body.classList.contains('keyboard-open'),
      kbInset: document.documentElement.style.getPropertyValue('--kb-inset'),
      composerBottom: Math.round(composer.bottom),
      navigationRemoved: !document.querySelector('.bottom-nav'),
      fullscreenDisplay: getComputedStyle(document.querySelector('#fullscreenButton')).display,
      fullscreenBottom: Math.round(parseFloat(getComputedStyle(document.querySelector('#fullscreenButton')).bottom)),
    };
  });
  if (closed.keyboardOpen || closed.kbInset !== '0px' || !closed.navigationRemoved) {
    throw new Error(`键盘关闭后未恢复：${JSON.stringify(closed)}`);
  }
  if (closed.fullscreenDisplay === 'none' || Math.abs(closed.fullscreenBottom - 162) > 2) {
    throw new Error(`键盘关闭后全屏按钮位置未恢复：${JSON.stringify(closed)}`);
  }
  process.stdout.write(`${JSON.stringify({ opened, closed })}\n`);
} finally {
  await browser.close();
}
