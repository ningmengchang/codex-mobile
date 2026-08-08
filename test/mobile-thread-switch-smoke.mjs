import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const playwrightPath = process.env.PLAYWRIGHT_PATH
  ?? '/home/ningmengchang/ideaProjects/dpp-cloud-saic/dpp-platform-web/node_modules/playwright';
const { chromium } = require(playwrightPath);

const publicRoot = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'public');
const shortThread = {
  id: 'thread-short', cwd: '/proj/short', name: '短会话', preview: '', status: 'idle', updatedAt: 1,
  turns: [
    { id: 'short-turn-1', status: 'completed', durationMs: 100, items: [
      { id: 'short-user-1', type: 'userMessage', content: [{ type: 'text', text: '短会话问题' }] },
      { id: 'short-agent-1', type: 'agentMessage', text: '短会话回答' },
    ] },
    { id: 'short-turn-2', status: 'completed', durationMs: 100, items: [
      { id: 'short-user-2', type: 'userMessage', content: [{ type: 'text', text: '短会话问题2' }] },
      { id: 'short-agent-2', type: 'agentMessage', text: '短会话回答2' },
    ] },
  ],
};

const makeLongTurns = (extraTurn = false) => {
  const turns = [];
  for (let index = 0; index < 40; index += 1) {
    turns.push({
      id: `long-turn-${index + 1}`, status: 'completed', durationMs: 100, items: [
        { id: `long-user-${index + 1}`, type: 'userMessage', content: [{ type: 'text', text: `长-回合${index + 1}问题` }] },
        { id: `long-agent-${index + 1}`, type: 'agentMessage', text: `长-回合${index + 1}回答`.repeat(3) },
        { id: `long-cmd-${index + 1}`, type: 'commandExecution', command: `命令 ${index + 1}`, status: 'completed', aggregatedOutput: `输出 ${index + 1}` },
        { id: `long-file-${index + 1}`, type: 'fileChange', changes: [{ kind: 'modified', path: `file-${index + 1}.md`, diff: '+内容' }] },
      ],
    });
  }
  if (extraTurn) {
    turns.push({
      id: 'long-turn-41', status: 'completed', durationMs: 100, items: [
        { id: 'long-user-41', type: 'userMessage', content: [{ type: 'text', text: '后台刷新新回合' }] },
      ],
    });
  }
  return turns;
};

const bootstrap = {
  appServer: { ready: true },
  runtime: { user: 'ningmengchang' },
  models: [],
  collaborationModes: [],
  pendingRequests: [],
  projects: { current: { name: 'home', path: '/home/ningmengchang' }, parent: null, entries: [] },
};

const longArtifacts = [
  {
    id: 'long-doc-1', threadId: 'thread-long', turnId: 'long-turn-1', projectPath: '/proj/long',
    path: '/proj/long/docs/prd.md', status: 'added', capturedAt: '2026-08-07T01:45:10.991Z',
    modifiedAt: '2026-08-07T09:40:00.000Z', name: 'prd.md', relativePath: 'docs/prd.md',
    fileKind: 'markdown', size: 100, available: true, token: 'tok-long-doc',
  },
];

const browser = await chromium.launch({ headless: true });
try {
  const context = await browser.newContext({
    viewport: { width: 390, height: 844 }, deviceScaleFactor: 2, isMobile: true, hasTouch: true,
  });
  await context.addInitScript((boot) => {
    const listeners = new Map();
    class FakeEventSource {
      constructor() { setTimeout(() => this.onopen?.(), 30); }
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
  let longGetCount = 0;
  await page.route('**/*', async (route) => {
    const pathname = new URL(route.request().url()).pathname;
    const fulfillJson = (body, status = 200) => route.fulfill({
      status, contentType: 'application/json; charset=utf-8', body: JSON.stringify(body),
    });
    if (pathname === '/api/auth/status') return fulfillJson({ authenticated: true });
    if (pathname === '/api/bootstrap') return fulfillJson(bootstrap);
    if (pathname === '/api/requests') return fulfillJson({ data: [] });
    if (pathname === '/api/projects') return fulfillJson(bootstrap.projects);
    if (pathname === '/api/threads' && route.request().method() === 'GET') {
      return fulfillJson({ data: [shortThread, { id: 'thread-long', cwd: '/proj/long', name: '长会话', preview: '', status: 'idle', updatedAt: 1 }] });
    }
    if (pathname === '/api/threads/thread-short' && route.request().method() === 'GET') {
      return fulfillJson({ thread: shortThread });
    }
    if (pathname === '/api/threads/thread-short/resume') return fulfillJson({ thread: shortThread });
    if (pathname === '/api/threads/thread-long' && route.request().method() === 'GET') {
      longGetCount += 1;
      if (longGetCount === 1) {
        await new Promise((resolve) => setTimeout(resolve, 400));
        return fulfillJson({ thread: { ...shortThread, id: 'thread-long', cwd: '/proj/long', name: '长会话', updatedAt: 1, turns: makeLongTurns(false) } });
      }
      await new Promise((resolve) => setTimeout(resolve, 600));
      return fulfillJson({ thread: { ...shortThread, id: 'thread-long', cwd: '/proj/long', name: '长会话', updatedAt: 2, turns: makeLongTurns(true) } });
    }
    if (pathname === '/api/threads/thread-long/resume') {
      return fulfillJson({ thread: { ...shortThread, id: 'thread-long', cwd: '/proj/long', name: '长会话', updatedAt: 2, turns: makeLongTurns(true) } });
    }
    if (pathname === '/api/threads/thread-short/artifacts') return fulfillJson({ data: [] });
    if (pathname === '/api/threads/thread-long/artifacts') return fulfillJson({ data: longArtifacts });
    if (pathname === '/api/events') return route.fulfill({ status: 200, contentType: 'text/event-stream', body: ': connected\n\n' });
    const file = path.join(publicRoot, pathname === '/' ? 'index.html' : pathname);
    if (!fs.existsSync(file) || !fs.statSync(file).isFile()) return route.fulfill({ status: 404, body: 'not found' });
    const contentType = file.endsWith('.js') ? 'text/javascript; charset=utf-8'
      : file.endsWith('.css') ? 'text/css; charset=utf-8'
        : file.endsWith('.html') ? 'text/html; charset=utf-8'
          : 'application/octet-stream';
    return route.fulfill({ status: 200, contentType, body: fs.readFileSync(file) });
  });

  await page.goto('http://127.0.0.1:39886/', { waitUntil: 'domcontentloaded' });
  await page.locator('#app:not([hidden])').waitFor({ timeout: 15_000 });
  await page.locator('button[data-tab="threads"]').click();

  // 1) 首次打开长会话：显示居中加载层，完成后全部回合渲染
  await page.locator('#mobileThreadList .thread-item', { hasText: '长会话' }).click();
  await page.locator('#threadLoading:not([hidden])').waitFor({ timeout: 2000 });
  await page.waitForFunction(() => document.querySelector('#threadLoading')?.hidden === true, null, { timeout: 15_000 });
  await page.waitForFunction(() => document.querySelectorAll('#timeline [data-turn]').length === 40, null, { timeout: 15_000 });
  const projectName = await page.locator('#currentProjectName').textContent();
  if (projectName !== 'long') throw new Error(`首次打开后项目名错误：${projectName}`);
  const sendDisabled = await page.locator('#sendButton').isDisabled();
  if (sendDisabled) throw new Error('加载完成后发送按钮仍被禁用');

  // 2) 切到短会话
  await page.locator('button[data-tab="threads"]').click();
  await page.locator('#mobileThreadList .thread-item', { hasText: '短会话' }).click();
  await page.waitForFunction(() => document.querySelector('#timeline')?.textContent?.includes('短会话回答2'), null, { timeout: 10_000 });

  // 3) 切回长会话：缓存秒开（不等待后台刷新），加载层不出现
  await page.locator('button[data-tab="threads"]').click();
  await page.locator('#mobileThreadList .thread-item', { hasText: '长会话' }).click();
  const loadingHiddenDuringCacheHit = await page.evaluate(() => document.querySelector('#threadLoading').hidden);
  if (!loadingHiddenDuringCacheHit) throw new Error('缓存命中时不应显示加载层');
  await page.waitForFunction(() => document.querySelector('#timeline')?.textContent?.includes('长-回合40问题'), null, { timeout: 2000 });
  if (longGetCount !== 2) throw new Error(`切回后应只有一次后台刷新 GET，实际 ${longGetCount}`);
  await page.waitForFunction(() => document.querySelector('#timeline')?.textContent?.includes('后台刷新新回合'), null, { timeout: 10_000 });
  if (longGetCount !== 2) throw new Error(`后台刷新后 GET 次数异常：${longGetCount}`);

  // 4) 快速连续切换，最终停留在最后点击的会话
  await page.locator('button[data-tab="threads"]').click();
  await page.locator('#mobileThreadList .thread-item', { hasText: '短会话' }).click();
  await page.waitForFunction(() => document.querySelector('#currentProjectName')?.textContent === 'short', null, { timeout: 5000 });
  await page.locator('button[data-tab="threads"]').click();
  await page.locator('#mobileThreadList .thread-item', { hasText: '长会话' }).click();
  await page.waitForFunction(() => document.querySelector('#currentProjectName')?.textContent === 'long', null, { timeout: 5000 });
  const finalProject = await page.locator('#currentProjectName').textContent();
  if (finalProject !== 'long') throw new Error(`快速切换后最终会话错误：${finalProject}`);

  // 5) SSE 产出物仍能局部更新“本次产出”条
  await page.evaluate(() => {
    window.__sse.emit('artifacts', {
      threadId: 'thread-long', turnId: 'long-turn-1',
      items: [{ ...JSON.parse(JSON.stringify({
        id: 'long-doc-2', threadId: 'thread-long', turnId: 'long-turn-1', projectPath: '/proj/long',
        path: '/proj/long/docs/new.md', status: 'added', capturedAt: '2026-08-07T01:45:10.991Z',
        modifiedAt: '2026-08-07T10:00:00.000Z', name: 'new.md', relativePath: 'docs/new.md',
        fileKind: 'markdown', size: 10, available: true, token: 'tok-new',
      })) }],
    });
  });
  await page.locator('.turn-artifact-chip', { hasText: 'new.md' }).waitFor({ timeout: 10_000 });

  await page.screenshot({ path: process.env.CODEX_MOBILE_SCREENSHOT ?? '/tmp/codex-mobile-thread-switch.png', fullPage: true });
  process.stdout.write(`${JSON.stringify({ projectName, sendDisabled, longGetCount, finalProject })}\n`);
} finally {
  await browser.close();
}
