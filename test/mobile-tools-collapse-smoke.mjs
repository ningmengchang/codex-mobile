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
  id: 'thread-1', cwd: '/home/ningmengchang', name: '工具折叠测试', preview: '', status: 'idle', updatedAt: 1,
  turns: [{
    id: 'turn-1', status: 'completed', durationMs: 1000, items: [
      { id: 'user-1', type: 'userMessage', content: [{ type: 'text', text: '我的问题' }] },
      { id: 'agent-1', type: 'agentMessage', text: '这是最终结论' },
      { id: 'cmd-1', type: 'commandExecution', command: 'ls -la', status: 'completed', aggregatedOutput: '总用量 100' },
      { id: 'cmd-2', type: 'commandExecution', command: 'npm run build', status: 'completed', aggregatedOutput: '构建完成' },
      { id: 'file-1', type: 'fileChange', changes: [{ kind: 'modified', path: 'a.md', diff: '+内容' }] },
      { id: 'think-1', type: 'reasoning', summary: ['推理摘要'], content: ['思考内容'] },
    ],
  }],
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
  await page.route('**/*', async (route) => {
    const pathname = new URL(route.request().url()).pathname;
    const fulfillJson = (body, status = 200) => route.fulfill({
      status, contentType: 'application/json; charset=utf-8', body: JSON.stringify(body),
    });
    if (pathname === '/api/auth/status') return fulfillJson({ authenticated: true });
    if (pathname === '/api/bootstrap') return fulfillJson(bootstrap);
    if (pathname === '/api/requests') return fulfillJson({ data: [] });
    if (pathname === '/api/projects') return fulfillJson(bootstrap.projects);
    if (pathname === '/api/threads' && route.request().method() === 'GET') return fulfillJson({ data: [thread] });
    if (pathname === '/api/threads/thread-1' && route.request().method() === 'GET') {
      return fulfillJson({ thread });
    }
    if (pathname === '/api/threads/thread-1/resume') return fulfillJson({ thread });
    if (pathname === '/api/threads/thread-1/artifacts') return fulfillJson({ data: [] });
    if (pathname === '/api/events') return route.fulfill({ status: 200, contentType: 'text/event-stream', body: ': connected\n\n' });
    const file = path.join(publicRoot, pathname === '/' ? 'index.html' : pathname);
    if (!fs.existsSync(file) || !fs.statSync(file).isFile()) return route.fulfill({ status: 404, body: 'not found' });
    const contentType = file.endsWith('.js') ? 'text/javascript; charset=utf-8'
      : file.endsWith('.css') ? 'text/css; charset=utf-8'
        : file.endsWith('.html') ? 'text/html; charset=utf-8'
          : 'application/octet-stream';
    return route.fulfill({ status: 200, contentType, body: fs.readFileSync(file) });
  });

  await page.goto('http://127.0.0.1:39888/', { waitUntil: 'domcontentloaded' });
  await page.locator('#app:not([hidden])').waitFor({ timeout: 15_000 });
  await page.locator('button[data-tab="threads"]').click();
  await page.locator('#mobileThreadList .thread-item').first().click();
  await page.locator('.agent-card', { hasText: '这是最终结论' }).waitFor({ timeout: 10_000 });

  // 1) 主体只显示问题与结论，工具默认折叠
  const toolsSummary = await page.locator('.turn-tools > summary').textContent();
  if (!toolsSummary.includes('工具与思考 · 4')) throw new Error(`工具计数错误：${toolsSummary}`);
  const toolVisibleWhileClosed = await page.locator('.turn-tools .tool-card').first().isVisible().catch(() => false);
  if (toolVisibleWhileClosed) throw new Error('工具默认应折叠不可见');

  // 2) 展开工具组：每个工具仍是折叠行
  await page.locator('.turn-tools > summary').click();
  await page.locator('.turn-tools[open]').waitFor({ timeout: 5_000 });
  await page.locator('.turn-tools .tool-card').first().waitFor({ state: 'visible', timeout: 5_000 });
  const openInnerCount = await page.locator('.turn-tools .tool-card[open]').count();
  if (openInnerCount !== 0) throw new Error(`工具内部不应默认展开，实际 ${openInnerCount}`);

  // 3) 展开单个命令：内容可见且限高内部滚动，页面不横向撑宽
  await page.locator('.turn-tools .tool-card', { hasText: 'ls -la' }).locator('summary').click();
  await page.waitForFunction(() => document.querySelector('.turn-tools .tool-card[open]') !== null);
  const contentStyle = await page.evaluate(() => {
    const el = document.querySelector('.turn-tools .tool-card[open] .tool-content');
    const style = getComputedStyle(el);
    return { maxHeight: style.maxHeight, overflowY: style.overflowY, scrollWidth: document.documentElement.scrollWidth };
  });
  if (contentStyle.maxHeight === 'none' || contentStyle.overflowY !== 'auto') {
    throw new Error(`工具内容未限高滚动：${JSON.stringify(contentStyle)}`);
  }
  if (contentStyle.scrollWidth > 390) throw new Error(`页面被工具输出撑宽：${contentStyle.scrollWidth}`);

  // 4) 流式新增工具：进入工具组、计数 +1、结论节点不被重建
  const agentHandle = await page.locator('#timeline [data-item-id="agent-1"]').elementHandle();
  await page.evaluate(() => {
    window.__sse.emit('codex', {
      method: 'item/commandExecution/outputDelta',
      params: { thread_id: 'thread-1', turn_id: 'turn-1', item_id: 'cmd-3', delta: '新输出' },
    });
  });
  await page.locator('.turn-tools-content [data-item-id="cmd-3"]').waitFor({ timeout: 5_000 });
  const countAfterStream = await page.locator('.turn-tools > summary').textContent();
  if (!countAfterStream.includes('工具与思考 · 5')) throw new Error(`流式后计数错误：${countAfterStream}`);
  const agentStillSame = await page.evaluate((handle) => {
    const current = document.querySelector('#timeline [data-item-id="agent-1"]');
    return handle === current && document.contains(handle);
  }, agentHandle);
  if (!agentStillSame) throw new Error('结论节点被工具更新重建');

  // 5) 结论增量更新时工具组保持折叠状态
  await page.locator('.turn-tools > summary').click();
  await page.waitForFunction(() => !document.querySelector('.turn-tools').hasAttribute('open'));
  await page.evaluate(() => {
    window.__sse.emit('codex', {
      method: 'item/agentMessage/delta',
      params: { thread_id: 'thread-1', turn_id: 'turn-1', item_id: 'agent-1', delta: '，补充说明' },
    });
  });
  await page.waitForFunction(() => document.querySelector('#timeline [data-item-id="agent-1"]')?.textContent?.includes('补充说明'));
  const toolsClosed = await page.evaluate(() => !document.querySelector('.turn-tools').hasAttribute('open'));
  if (!toolsClosed) throw new Error('结论更新时工具组被展开');

  await page.screenshot({ path: process.env.CODEX_MOBILE_SCREENSHOT ?? '/tmp/codex-mobile-tools-collapse.png', fullPage: true });
  process.stdout.write(`${JSON.stringify({ toolsSummary, openInnerCount, contentStyle, countAfterStream })}\n`);
} finally {
  await browser.close();
}
