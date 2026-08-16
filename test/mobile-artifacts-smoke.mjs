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
  id: 'thread-1', cwd: '/home/ningmengchang', name: '产出物测试', preview: '', status: 'idle', updatedAt: 1,
};
const historyTurn = {
  id: 'turn-1', status: 'completed', durationMs: 1000, items: [
    { id: 'user-1', type: 'userMessage', content: [{ type: 'text', text: '生成菜单管理 PRD' }] },
    { id: 'agent-1', type: 'agentMessage', text: '已完成 PRD 生成。[打开最终目录](/home/ningmengchang/最终材料)' },
  ],
};
const bootstrap = {
  appServer: { ready: true },
  runtime: { user: 'ningmengchang' },
  models: [],
  collaborationModes: [],
  pendingRequests: [],
  projects: { current: { name: 'home', path: '/home/ningmengchang' }, parent: null, entries: [] },
};

const artifact = (overrides) => ({
  id: 'art-unknown', threadId: 'thread-1', turnId: 'turn-1', projectPath: '/home/ningmengchang',
  path: '/home/ningmengchang/placeholder', status: 'added',
  capturedAt: '2026-08-07T01:45:10.991Z', modifiedAt: '2026-08-07T09:35:00.000Z',
  name: 'unknown.bin', relativePath: 'unknown.bin', fileKind: 'binary',
  size: 1, available: true, token: null,
  ...overrides,
});

const artifacts = [
  artifact({
    id: 'art-prd', token: 'tok-prd', name: 'menu-manage-prd.md', relativePath: 'docs/menu-manage-prd.md',
    fileKind: 'markdown', size: 2232, modifiedAt: '2026-08-07T09:37:00.000Z',
    path: '/home/ningmengchang/docs/menu-manage-prd.md',
  }),
  artifact({
    id: 'art-docx', token: 'tok-docx', name: '菜单管理 PRD.docx', relativePath: 'docs/菜单管理 PRD.docx',
    fileKind: 'office', size: 30420, modifiedAt: '2026-08-07T09:40:00.000Z',
    path: '/home/ningmengchang/docs/菜单管理 PRD.docx',
  }),
  artifact({
    id: 'art-png', token: 'tok-png', name: 'menu-manage-list.png',
    relativePath: 'docs/assets/system-management-prd/menu-manage-list.png',
    fileKind: 'image', modifiedAt: '2026-08-07T09:45:00.000Z',
    path: '/home/ningmengchang/docs/assets/system-management-prd/menu-manage-list.png',
  }),
  artifact({
    id: 'art-meta', token: 'tok-meta', name: 'capture-meta.json',
    relativePath: 'docs/assets/system-management-prd/capture-meta.json',
    fileKind: 'text', modifiedAt: '2026-08-07T09:45:00.000Z',
    path: '/home/ningmengchang/docs/assets/system-management-prd/capture-meta.json',
  }),
  artifact({
    id: 'art-dist', token: 'tok-dist', name: 'chunk-123.js', relativePath: 'dist/chunk-123.js',
    fileKind: 'text', modifiedAt: '2026-08-07T09:50:00.000Z',
    path: '/home/ningmengchang/dist/chunk-123.js',
  }),
  artifact({
    id: 'art-deleted', token: null, name: 'old-report.md', relativePath: 'docs/old-report.md',
    fileKind: 'markdown', status: 'deleted', available: false, modifiedAt: '2026-08-07T08:00:00.000Z',
    path: '/home/ningmengchang/docs/old-report.md',
  }),
];
const historicalArtifact = artifact({
  id: 'art-history', token: 'tok-history', threadId: 'thread-1', turnId: null,
  source: 'conversation', status: 'linked', name: '历史验收报告.pdf',
  relativePath: '历史材料/历史验收报告.pdf', fileKind: 'pdf', size: 18240,
  modifiedAt: '2026-08-06T08:00:00.000Z', path: '/home/ningmengchang/历史材料/历史验收报告.pdf',
});
const linkedDirectory = artifact({
  id: 'linked-dir', token: 'tok-dir', name: '最终材料', relativePath: '最终材料',
  fileKind: 'directory', isDirectory: true, size: 4096,
  path: '/home/ningmengchang/最终材料',
});
const linkedReport = artifact({
  id: 'linked-report', token: 'tok-linked-report', name: '最终报告.md', relativePath: '最终材料/最终报告.md',
  fileKind: 'markdown', isDirectory: false, size: 120,
  path: '/home/ningmengchang/最终材料/最终报告.md',
});
const previewArtifacts = [...artifacts, historicalArtifact, linkedDirectory, linkedReport];
let historyReady = false;

const browser = await chromium.launch({ headless: true });
try {
  const context = await browser.newContext({
    viewport: { width: 390, height: 844 }, deviceScaleFactor: 2, isMobile: true, hasTouch: true,
  });
  await context.addInitScript((boot) => {
    const listeners = new Map();
    class FakeEventSource {
      constructor() {
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
      emit(type, data) {
        const event = { data: JSON.stringify(data) };
        for (const callback of listeners.get(type) ?? []) callback(event);
      },
    };
    window.__sharedFiles = [];
    Object.defineProperty(navigator, 'canShare', {
      configurable: true,
      value: (data) => Array.isArray(data?.files) && data.files.length === 1,
    });
    Object.defineProperty(navigator, 'share', {
      configurable: true,
      value: async (data) => {
        const file = data.files[0];
        window.__sharedFiles.push({ name: file.name, type: file.type, size: file.size, text: await file.text() });
      },
    });
    window.__boot = boot;
  }, bootstrap);
  const page = await context.newPage();
  await page.route('**/*', async (route) => {
    const url = new URL(route.request().url());
    const pathname = url.pathname;
    const fulfillJson = (body, status = 200) => route.fulfill({
      status, contentType: 'application/json; charset=utf-8', body: JSON.stringify(body),
    });
    if (pathname === '/api/auth/status') return fulfillJson({ authenticated: true });
    if (pathname === '/api/bootstrap') return fulfillJson(bootstrap);
    if (pathname === '/api/requests') return fulfillJson({ data: [] });
    if (pathname === '/api/projects') return fulfillJson(bootstrap.projects);
    if (pathname === '/api/threads' && route.request().method() === 'GET') return fulfillJson({ data: [thread] });
    if (pathname === '/api/threads/thread-1') {
      return fulfillJson({ thread: { ...thread, turns: [historyTurn] } });
    }
    if (pathname === '/api/threads/thread-1/resume') {
      return fulfillJson({ thread: { ...thread, turns: [historyTurn] } });
    }
    if (pathname === '/api/threads/thread-1/artifacts') {
      const search = (url.searchParams.get('search') ?? '').trim().toLowerCase();
      const offset = Number.parseInt(url.searchParams.get('offset') ?? '0', 10) || 0;
      const limit = Number.parseInt(url.searchParams.get('limit') ?? '100', 10) || 100;
      const availableArtifacts = historyReady ? [...artifacts, historicalArtifact] : artifacts;
      const filtered = search
        ? availableArtifacts.filter((item) => `${item.name} ${item.relativePath}`.toLowerCase().includes(search))
        : availableArtifacts;
      return fulfillJson({
        data: filtered.slice(offset, offset + limit),
        total: filtered.length,
        nextOffset: offset + limit < filtered.length ? offset + limit : null,
        scope: { kind: 'documents', history: true, historyPending: !historyReady },
      });
    }
    if (pathname === '/api/files/resolve' && route.request().method() === 'POST') {
      const body = JSON.parse(route.request().postData() || '{}');
      return decodeURIComponent(body.path) === '/home/ningmengchang/最终材料'
        ? fulfillJson({ artifact: linkedDirectory })
        : fulfillJson({ error: 'NOT_FOUND', message: '文件不存在' }, 404);
    }
    if (pathname === '/api/events') return route.fulfill({ status: 200, contentType: 'text/event-stream', body: ': connected\n\n' });
    const meta = pathname.match(/^\/api\/artifacts\/([^/]+)\/meta$/);
    if (meta) {
      const item = previewArtifacts.find((entry) => entry.token === meta[1]);
      return fulfillJson(item ? {
        name: item.name, relativePath: item.relativePath, fileKind: item.fileKind, size: item.size, isDirectory: Boolean(item.isDirectory),
      } : { error: 'NOT_FOUND', message: '文件不存在' }, item ? 200 : 404);
    }
    const directory = pathname.match(/^\/api\/artifacts\/([^/]+)\/directory$/);
    if (directory) {
      return directory[1] === linkedDirectory.token
        ? fulfillJson({ data: [linkedReport], parent: null, truncated: false })
        : fulfillJson({ error: 'NOT_A_DIRECTORY', message: '该路径不是目录' }, 400);
    }
    const raw = pathname.match(/^\/api\/artifacts\/([^/]+)\/raw$/);
    if (raw) {
      const item = previewArtifacts.find((entry) => entry.token === raw[1]);
      if (!item) return fulfillJson({ error: 'NOT_FOUND', message: '文件不存在' }, 404);
      return route.fulfill({
        status: 200,
        contentType: item.fileKind === 'markdown' ? 'text/markdown; charset=utf-8' : 'application/octet-stream',
        body: `# ${item.name}\n内容预览`,
      });
    }
    const sendMatch = pathname.match(/^\/api\/artifacts\/([^/]+)\/send-dingtalk$/);
    if (sendMatch && route.request().method() === 'POST') {
      return fulfillJson({ sent: true });
    }
    const file = path.join(publicRoot, pathname === '/' ? 'index.html' : pathname);
    if (!fs.existsSync(file) || !fs.statSync(file).isFile()) return route.fulfill({ status: 404, body: 'not found' });
    const contentType = file.endsWith('.js') ? 'text/javascript; charset=utf-8'
      : file.endsWith('.css') ? 'text/css; charset=utf-8'
        : file.endsWith('.html') ? 'text/html; charset=utf-8'
          : 'application/octet-stream';
    return route.fulfill({ status: 200, contentType, body: fs.readFileSync(file) });
  });

  await page.goto('http://127.0.0.1:39881/', { waitUntil: 'domcontentloaded' });
  await page.locator('#app:not([hidden])').waitFor({ timeout: 15_000 });
  await page.locator('#mobileThreadList .thread-item').first().click();
  await page.locator('#emptyState').waitFor({ state: 'hidden', timeout: 15_000 });
  await page.locator('.message.user .bubble').waitFor({ timeout: 10_000 });

  // 0) 聊天回复中的本机目录链接应在应用内打开，并可继续预览目录内文件
  const linkedPath = page.locator('.message .agent-card a', { hasText: '打开最终目录' });
  await linkedPath.click();
  await page.locator('#previewDialog[open]').waitFor({ timeout: 10_000 });
  await page.waitForFunction(() => document.querySelector('#previewTitle')?.textContent === '最终材料');
  await page.locator('.directory-entry', { hasText: '最终报告.md' }).waitFor({ timeout: 10_000 });
  if (!(await page.locator('#downloadArtifactButton').isHidden())) throw new Error('目录预览不应显示下载按钮');
  await page.locator('.directory-entry', { hasText: '最终报告.md' }).click();
  await page.waitForFunction(() => document.querySelector('#previewTitle')?.textContent === '最终报告.md');
  await page.waitForFunction(() => document.querySelector('#previewBody')?.textContent?.includes('内容预览'));
  if (await page.locator('#downloadArtifactButton').isHidden()) throw new Error('文件预览应恢复下载按钮');
  await page.locator('#closePreviewButton').click();

  // 1) 聊天窗口出现“本次产出”条，且只展示文档类产出
  await page.locator('.turn-artifacts').waitFor({ timeout: 10_000 });
  const chipNames = await page.locator('.turn-artifact-chip span').allTextContents();
  if (!chipNames.some((name) => name.includes('PRD'))) throw new Error(`聊天产出条缺少 PRD：${chipNames.join(',')}`);
  const chipCount = await page.locator('.turn-artifact-chip').count();
  if (chipCount !== 2) throw new Error(`产出条应只显示 2 个文档芯片，实际 ${chipCount}`);

  // 2) 点击芯片直接打开预览弹窗
  await page.locator('.turn-artifact-chip', { hasText: 'menu-manage-prd.md' }).click();
  await page.locator('#previewDialog[open]').waitFor({ timeout: 10_000 });
  const previewTitle = await page.locator('#previewTitle').textContent();
  if (previewTitle !== 'menu-manage-prd.md') throw new Error(`预览标题错误：${previewTitle}`);
  await page.waitForFunction(() => document.querySelector('#previewBody')?.textContent?.includes('内容预览'));
  await page.locator('#closePreviewButton').click();

  // 3) “全部”进入当前会话的产出物二级页，文档优先排最前
  await page.locator('.turn-artifacts-more').click();
  await page.locator('#artifactsView.active').waitFor({ timeout: 10_000 });
  const artifactsHead = await page.evaluate(() => {
    const search = document.querySelector('#artifactSearch');
    return {
      title: document.querySelector('#artifactDetailName')?.textContent,
      scope: document.querySelector('#artifactScope')?.textContent,
      route: location.hash,
      detail: document.body.classList.contains('mobile-artifacts-detail'),
      navigationRemoved: !document.querySelector('.bottom-nav'),
      searchTop: search ? Math.round(search.getBoundingClientRect().top) : null,
    };
  });
  if (artifactsHead.title !== '产出物测试' || !artifactsHead.scope.includes('历史文档同步中')) throw new Error(`产出物页会话范围错误：${JSON.stringify(artifactsHead)}`);
  if (artifactsHead.route !== '#artifacts/thread-1' || !artifactsHead.detail) throw new Error(`产出物二级路由错误：${JSON.stringify(artifactsHead)}`);
  if (!artifactsHead.navigationRemoved) throw new Error(`产出物二级页仍存在主导航：${JSON.stringify(artifactsHead)}`);
  if (artifactsHead.searchTop >= 110) throw new Error(`搜索框未上移：${JSON.stringify(artifactsHead)}`);
  await page.screenshot({ path: process.env.CODEX_MOBILE_DETAIL_SCREENSHOT ?? '/tmp/codex-mobile-artifacts-detail.png', fullPage: true });
  const sections = await page.locator('.artifact-section').allTextContents();
  if (JSON.stringify(sections) !== JSON.stringify(['历史文档'])) throw new Error(`历史文档分组错误：${sections.join(',')}`);
  const initialArtifactNames = await page.locator('.artifact-card-main strong').allTextContents();
  if (JSON.stringify([...initialArtifactNames].sort()) !== JSON.stringify(['menu-manage-prd.md', '菜单管理 PRD.docx'].sort())) {
    throw new Error(`代码、图片或已删除文件未被过滤：${initialArtifactNames.join(',')}`);
  }
  const firstCardText = await page.locator('.artifact-card').first().textContent();
  if (!firstCardText.includes('PRD')) throw new Error(`文档未排到最前：${firstCardText}`);
  const timeTexts = await page.locator('.artifact-card .artifact-time').allTextContents();
  if (!timeTexts.length || timeTexts.every((text) => !text.trim())) {
    throw new Error(`产出物卡片缺少修改时间：${timeTexts.join(',')}`);
  }

  // 后台历史索引完成后自动补入文档，不阻塞首次打开。
  historyReady = true;
  await page.evaluate(() => {
    window.__sse.emit('artifact-history-ready', { threadId: 'thread-1' });
  });
  await page.locator('.artifact-card', { hasText: '历史验收报告.pdf' }).waitFor({ timeout: 10_000 });
  await page.waitForFunction(() => document.querySelector('#artifactScope')?.textContent?.includes('全部历史文档'));

  const firstShareButton = page.locator('.artifact-card button[data-action="share"]').first();
  await firstShareButton.click();
  await page.locator('#fileShareDialog[open]').waitFor();
  await page.locator('#systemShareButton:not(:disabled)').waitFor();
  await page.locator('#systemShareButton').click();
  await page.locator('#fileShareDialog').waitFor({ state: 'hidden' });
  const sharedArtifact = await page.evaluate(() => window.__sharedFiles[0]);
  if (!sharedArtifact?.name || !sharedArtifact.text.includes('内容预览')) {
    throw new Error(`产出物系统分享内容错误：${JSON.stringify(sharedArtifact)}`);
  }

  await firstShareButton.click();
  await page.locator('#fileShareDialog[open]').waitFor();
  page.once('dialog', (dialog) => dialog.accept());
  await page.locator('#shareDingtalkButton').click();
  await page.waitForFunction(() => document.querySelector('#toastRegion')?.textContent?.includes('已发送'), null, { timeout: 10_000 });

  // 4) 搜索过滤与空态
  await page.locator('#artifactSearch').fill('prd');
  await page.waitForTimeout(250);
  const searchCards = await page.locator('.artifact-card').count();
  if (searchCards !== 2) throw new Error(`搜索 prd 应剩 2 张文档卡片，实际 ${searchCards}`);
  await page.locator('#artifactSearch').fill('不存在xyz');
  await page.locator('.empty-list', { hasText: '没有匹配' }).waitFor({ timeout: 10_000 });
  await page.locator('#artifactSearch').fill('');
  await page.waitForTimeout(250);
  const restoredCards = await page.locator('.artifact-card').count();
  if (restoredCards !== 3) throw new Error(`清空搜索应恢复 3 张文档卡片，实际 ${restoredCards}`);

  // 5) 新卡片布局：类型徽标存在，置顶按钮已移除
  const kindTexts = await page.locator('.artifact-card .artifact-kind').allTextContents();
  if (!kindTexts.length || !kindTexts.some((text) => text.trim())) {
    throw new Error(`产出物卡片缺少类型徽标：${kindTexts.join(',')}`);
  }
  const pinCount = await page.locator('.artifact-card .pin-button').count();
  if (pinCount !== 0) throw new Error(`置顶按钮未移除：${pinCount}`);

  // 6) SSE 推送新产出物后列表与聊天条同步
  const newDoc = artifact({
    id: 'art-new', token: 'tok-new', name: '登录日志 PRD.md', relativePath: 'docs/login-log-prd.md',
    fileKind: 'markdown', size: 1682, modifiedAt: '2026-08-07T10:00:00.000Z',
    path: '/home/ningmengchang/docs/login-log-prd.md',
  });
  await page.evaluate((item) => {
    window.__sse.emit('artifacts', { threadId: 'thread-1', turnId: 'turn-1', items: [item] });
  }, newDoc);
  await page.waitForTimeout(150);
  await page.evaluate(() => document.activeElement?.blur());
  await page.waitForFunction(() => !document.body.classList.contains('keyboard-open'));
  await page.locator('#artifactBackButton').click();
  await page.locator('#chatView.active').waitFor({ timeout: 10_000 });
  await page.locator('.turn-artifact-chip', { hasText: '登录日志 PRD.md' }).waitFor({ timeout: 10_000 });
  const chipsAfterSse = await page.locator('.turn-artifact-chip').count();
  if (chipsAfterSse !== 3) throw new Error(`SSE 后应显示 3 个文档芯片，实际 ${chipsAfterSse}`);

  await page.screenshot({ path: process.env.CODEX_MOBILE_SCREENSHOT ?? '/tmp/codex-mobile-artifacts.png', fullPage: true });
  process.stdout.write(`${JSON.stringify({ chipNames, chipCount, sections, searchCards, restoredCards, kindOk: true, pinRemoved: pinCount === 0, chipsAfterSse })}\n`);
} finally {
  await browser.close();
}
