import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const playwrightPath = process.env.PLAYWRIGHT_PATH
  ?? '/home/ningmengchang/ideaProjects/dpp-cloud-saic/dpp-platform-web/node_modules/playwright';
const { chromium } = require(playwrightPath);

const publicRoot = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'public');
let threadReadCount = 0;
const allTurns = Array.from({ length: 21 }, (_, index) => {
  const number = index + 1;
  return {
    id: `t-${number}`, status: 'completed', durationMs: 100, items: [
      { id: `u-${number}`, type: 'userMessage', content: [{ type: 'text', text: `问题${number}` }] },
      { id: `a-${number}`, type: 'agentMessage', text: `回答${number}` },
    ],
  };
});
const threadMeta = {
  id: 'thread-1', cwd: '/home/ningmengchang', name: '加载展示', preview: '', status: 'idle', updatedAt: 1, turns: allTurns,
};
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
    let openCallback = null;
    class FakeEventSource {
      constructor() {
        openCallback = () => this.onopen?.();
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
      triggerOpen() { openCallback?.(); },
      emit(type, data) {
        const event = { data: JSON.stringify(data) };
        for (const callback of listeners.get(type) ?? []) callback(event);
      },
    };
    window.__boot = boot;
    window.__appRevealSnapshots = [];
    window.addEventListener('DOMContentLoaded', () => {
      const app = document.querySelector('#app');
      const capture = () => {
        if (app.hidden) return;
        window.__appRevealSnapshots.push({
          latestVisible: document.querySelector('#timeline')?.textContent?.includes('问题21') ?? false,
          threadLoadingHidden: document.querySelector('#threadLoading')?.hidden ?? false,
          inputEnabled: !document.querySelector('#promptInput')?.readOnly && !document.querySelector('#sendButton')?.disabled,
        });
      };
      new MutationObserver(capture).observe(app, { attributes: true, attributeFilter: ['hidden'] });
      capture();
    });
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
    if (pathname === '/api/threads' && route.request().method() === 'GET') return fulfillJson({ data: [threadMeta] });
    if (pathname === '/api/threads/thread-1' && route.request().method() === 'GET') {
      threadReadCount += 1;
      await new Promise((resolve) => setTimeout(resolve, 300));
      return fulfillJson({ thread: threadMeta });
    }
    if (pathname === '/api/threads/thread-1/resume') return fulfillJson({ thread: threadMeta });
    if (pathname === '/api/threads/thread-1/artifacts') {
      await new Promise((resolve) => setTimeout(resolve, 300));
      return fulfillJson({ data: [] });
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

  async function openAndAssertLoading() {
    await page.locator('#threadLoading:not([hidden])').waitFor({ timeout: 2_000 });
    // 分块渲染开始后：时间线必须带隐藏类（不允许露出部分历史）
    await page.waitForFunction(() => document.querySelectorAll('#timeline [data-turn]').length > 0, null, { timeout: 10_000 });
    const hidingDuringRender = await page.evaluate(() => document.querySelector('#timeline').classList.contains('timeline-rendering'));
    if (hidingDuringRender) throw new Error('加载期间时间线不应单独隐藏');
    const disabledDuringArtifacts = await page.evaluate(() => (
      document.querySelector('#promptInput').readOnly && document.querySelector('#sendButton').disabled
    ));
    if (!disabledDuringArtifacts) throw new Error('产出物加载期间输入框不应可用');
    const overlayBlocksInput = await page.evaluate(() => {
      const input = document.querySelector('#promptInput');
      const rect = input.getBoundingClientRect();
      const element = document.elementFromPoint(rect.left + rect.width / 2, rect.top + rect.height / 2);
      return element === document.querySelector('#threadLoading') || element?.closest?.('#threadLoading');
    });
    if (!overlayBlocksInput) throw new Error('产出物加载期间输入框未被遮罩挡住');
    const hiddenDuringLoad = await page.evaluate(() => {
      const composer = getComputedStyle(document.querySelector('#composer')).display;
      return composer === 'none' && !document.querySelector('.bottom-nav');
    });
    if (!hiddenDuringLoad) throw new Error('产出物加载期间输入框未被隐藏或底部导航仍存在');
    // 渲染完成：遮罩关闭、隐藏类移除、停在最新
    await page.waitForFunction(() => document.querySelector('#threadLoading')?.hidden === true, null, { timeout: 10_000 });
    const revealed = await page.evaluate(() => ({
      hiding: document.querySelector('#timeline').classList.contains('timeline-rendering'),
      scrollTop: document.querySelector('#chatView').scrollTop,
      scrollHeight: document.querySelector('#chatView').scrollHeight,
      clientHeight: document.querySelector('#chatView').clientHeight,
      inputEnabled: !document.querySelector('#promptInput').readOnly && !document.querySelector('#sendButton').disabled,
      composerDisplay: getComputedStyle(document.querySelector('#composer')).display,
      navigationRemoved: !document.querySelector('.bottom-nav'),
    }));
    if (revealed.hiding) throw new Error(`渲染完成后时间线仍隐藏：${JSON.stringify(revealed)}`);
    if (!revealed.inputEnabled) throw new Error(`加载完成后输入框仍不可用：${JSON.stringify(revealed)}`);
    if (revealed.composerDisplay === 'none' || !revealed.navigationRemoved) {
      throw new Error(`加载完成后输入框未恢复或底部导航重新出现：${JSON.stringify(revealed)}`);
    }
    const inputClickable = await page.evaluate(() => {
      const input = document.querySelector('#promptInput');
      const rect = input.getBoundingClientRect();
      const element = document.elementFromPoint(rect.left + rect.width / 2, rect.top + rect.height / 2);
      return element === input || element?.closest?.('#promptInput') === input;
    });
    if (!inputClickable) throw new Error('加载完成后输入框仍被遮挡');
    const beforeWait = threadReadCount;
    await page.waitForTimeout(1700);
    if (threadReadCount !== beforeWait) throw new Error('打开会话后 1.5 秒内不应自动刷新');
    await page.evaluate(() => window.__sse.triggerOpen());
    await page.waitForTimeout(300);
    if (threadReadCount !== beforeWait + 1) throw new Error('超过 1.5 秒后自动刷新未恢复');
    await page.waitForTimeout(600);
    const stable = await page.evaluate(() => ({
      hiding: document.querySelector('#timeline').classList.contains('timeline-rendering'),
      inputEnabled: !document.querySelector('#promptInput').readOnly && !document.querySelector('#sendButton').disabled,
      composerDisplay: getComputedStyle(document.querySelector('#composer')).display,
    }));
    if (stable.hiding || !stable.inputEnabled || stable.composerDisplay === 'none') {
      throw new Error(`加载完成后仍出现闪烁或输入框不可用：${JSON.stringify(stable)}`);
    }
    const beforeOld = threadReadCount;
    await page.evaluate(() => window.__sse.emit('codex', {
      method: 'turn/completed',
      at: new Date(Date.now() - 60_000).toISOString(),
      params: { thread_id: 'thread-1', turn_id: 'turn-1', turn: { id: 'turn-1', status: 'completed' } },
    }));
    await page.waitForTimeout(200);
    if (threadReadCount !== beforeOld) throw new Error('旧 SSE 事件不应触发自动刷新');
    const stillStable = await page.evaluate(() => !document.querySelector('#timeline').classList.contains('timeline-rendering'));
    if (!stillStable) throw new Error('旧 SSE 事件触发了时间线闪烁');
    await page.evaluate(() => window.__sse.emit('codex', {
      method: 'turn/completed',
      at: new Date().toISOString(),
      params: { thread_id: 'thread-1', turn_id: 'turn-1', turn: { id: 'turn-1', status: 'completed' } },
    }));
    await page.waitForTimeout(400);
    if (threadReadCount <= beforeOld) throw new Error('新 SSE 事件未正常处理');
    if (revealed.scrollTop + revealed.clientHeight < revealed.scrollHeight - 60) {
      throw new Error(`渲染完成后未停在最新：${JSON.stringify(revealed)}`);
    }
    const text = await page.locator('#timeline').textContent();
    if (!text.includes('问题21')) throw new Error('最新问题不可见');
  }

  await page.goto('http://127.0.0.1:39895/', { waitUntil: 'domcontentloaded' });
  await page.locator('#app:not([hidden])').waitFor({ timeout: 15_000 });
  await page.locator('#mobileThreadList .thread-item').first().click();
  await openAndAssertLoading();

  // 刷新后同样先加载后展示，且最终停在最新
  const beforeReloadReads = threadReadCount;
  await page.reload({ waitUntil: 'domcontentloaded' });
  await page.locator('#startupScreen').waitFor({ state: 'visible', timeout: 2_000 });
  await page.waitForTimeout(120);
  const gated = await page.evaluate(() => ({
    appHidden: document.querySelector('#app').hidden,
    startupVisible: !document.querySelector('#startupScreen').hidden,
    composerVisible: getComputedStyle(document.querySelector('#composer')).display !== 'none'
      && !document.querySelector('#app').hidden,
  }));
  if (!gated.appHidden || !gated.startupVisible || gated.composerVisible) {
    throw new Error(`刷新恢复期间泄露了未完成页面：${JSON.stringify(gated)}`);
  }
  await page.locator('#app:not([hidden])').waitFor({ timeout: 15_000 });
  if (threadReadCount <= beforeReloadReads) throw new Error('刷新后未恢复保存的会话');
  const reloadResult = await page.evaluate(() => {
    const chat = document.querySelector('#chatView');
    return {
      startupHidden: document.querySelector('#startupScreen').hidden,
      threadLoadingHidden: document.querySelector('#threadLoading').hidden,
      inputEnabled: !document.querySelector('#promptInput').readOnly && !document.querySelector('#sendButton').disabled,
      composerDisplay: getComputedStyle(document.querySelector('#composer')).display,
      latestVisible: document.querySelector('#timeline').textContent.includes('问题21'),
      atBottom: chat.scrollTop + chat.clientHeight >= chat.scrollHeight - 60,
      revealSnapshots: window.__appRevealSnapshots,
    };
  });
  if (!reloadResult.startupHidden || !reloadResult.threadLoadingHidden || !reloadResult.inputEnabled
    || reloadResult.composerDisplay === 'none' || !reloadResult.latestVisible || !reloadResult.atBottom) {
    throw new Error(`刷新完成后的会话状态错误：${JSON.stringify(reloadResult)}`);
  }
  if (reloadResult.revealSnapshots.length !== 1
    || !reloadResult.revealSnapshots[0].latestVisible
    || !reloadResult.revealSnapshots[0].threadLoadingHidden
    || !reloadResult.revealSnapshots[0].inputEnabled) {
    throw new Error(`应用在会话就绪前被提前展示：${JSON.stringify(reloadResult.revealSnapshots)}`);
  }

  await page.screenshot({ path: process.env.CODEX_MOBILE_SCREENSHOT ?? '/tmp/codex-mobile-loading-reveal.png', fullPage: true });
  process.stdout.write(JSON.stringify({ firstLoadOk: true, reloadOk: true }));
} finally {
  await browser.close();
}
