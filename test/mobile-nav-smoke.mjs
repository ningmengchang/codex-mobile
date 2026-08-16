import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';
import { swipeLeft, swipeRight } from './helpers/mobile-gestures.mjs';

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
  let createdThreads = 0;
  let createdThreadCwd = null;
  await page.route('**/*', async (route) => {
    const pathname = new URL(route.request().url()).pathname;
    const method = route.request().method();
    const fulfillJson = (body, status = 200) => route.fulfill({
      status, contentType: 'application/json; charset=utf-8', body: JSON.stringify(body),
    });
    if (pathname === '/api/auth/status') return fulfillJson({ authenticated: true });
    if (pathname === '/api/bootstrap') return fulfillJson(bootstrap);
    if (pathname === '/api/requests') return fulfillJson({ data: [] });
    if (pathname === '/api/projects') return fulfillJson(bootstrap.projects);
    if (pathname === '/api/threads' && method === 'GET') return fulfillJson({ data: [] });
    if (pathname === '/api/threads' && method === 'POST') {
      createdThreads += 1;
      createdThreadCwd = route.request().postDataJSON()?.cwd ?? null;
      return fulfillJson({ thread: { id: 'thread-new', cwd: createdThreadCwd, name: '新会话', turns: [] } });
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

  await page.goto('http://127.0.0.1:39885/', { waitUntil: 'domcontentloaded' });
  await page.locator('#app:not([hidden])').waitFor({ timeout: 15_000 });
  await page.waitForTimeout(300);

  // 1) 会话页不再放新增会话和设置，底部导航也不再占用高度
  if (await page.locator('.bottom-nav').count()) throw new Error('底部导航仍占用会话页空间');
  if (await page.locator('#threadsView #mobileNewThreadButton').count()) throw new Error('新增会话仍在会话页');
  if (await page.locator('#threadsView #settingsButton').count()) throw new Error('设置仍在会话页');
  if (await page.locator('#fileDirectoryButton').count()) {
    throw new Error('会话页仍保留文件目录点击按钮');
  }
  if (!await page.locator('#threadsView .thread-home-head h2', { hasText: '会话' }).isVisible()) {
    throw new Error('会话页顶部标题没有恢复');
  }

  const homeLayout = await page.evaluate(() => {
    const workspace = document.querySelector('.workspace').getBoundingClientRect();
    return {
      workspaceTop: Math.round(workspace.top),
      workspaceBottom: Math.round(workspace.bottom),
      viewportHeight: innerHeight,
    };
  });
  if (homeLayout.workspaceTop !== 0 || homeLayout.workspaceBottom !== homeLayout.viewportHeight) {
    throw new Error(`会话列表未使用完整视口高度：${JSON.stringify(homeLayout)}`);
  }

  // 2) 会话页左滑依次切换全部目录、当前目录和收藏，状态筛选保持独立
  await page.locator('[data-thread-filter="active"]').click();
  const directoryFilterSwipe = await swipeLeft(page, '#threadsView');
  if (!directoryFilterSwipe.midTransform.includes('translate3d(-72')) {
    throw new Error(`真实触摸时会话页没有跟随手指左移：${directoryFilterSwipe.midTransform || 'none'}`);
  }
  await page.waitForFunction(() => document.querySelector('[data-thread-scope="directory"]')?.classList.contains('active'));
  if (await page.locator('#threadFavoriteToggle').evaluate((element) => element.classList.contains('active'))) {
    throw new Error('第一次左滑不应提前开启收藏筛选');
  }
  if (!await page.locator('[data-thread-filter="active"]').evaluate((element) => element.classList.contains('active'))) {
    throw new Error('第一次左滑改变了独立的状态筛选');
  }

  await swipeLeft(page, '#threadsView');
  await page.waitForFunction(() => document.querySelector('[data-thread-scope="all"]')?.classList.contains('active')
    && document.querySelector('#threadFavoriteToggle')?.classList.contains('active'));
  if (!await page.locator('[data-thread-filter="active"]').evaluate((element) => element.classList.contains('active'))) {
    throw new Error('第二次左滑改变了独立的状态筛选');
  }

  await swipeLeft(page, '#threadsView');
  await page.waitForFunction(() => document.querySelector('[data-thread-scope="all"]')?.classList.contains('active')
    && !document.querySelector('#threadFavoriteToggle')?.classList.contains('active'));
  if (!await page.locator('[data-thread-filter="active"]').evaluate((element) => element.classList.contains('active'))) {
    throw new Error('第三次左滑改变了独立的状态筛选');
  }
  await page.locator('[data-thread-filter="all"]').click();

  // 3) 文件目录作为负一屏打开，操作按钮只出现在负一屏
  if (await page.locator('button[data-tab="artifacts"]').count()) throw new Error('仍存在独立产出物导航按钮');
  if (await page.locator('button[data-tab="favorites"]').count()) throw new Error('仍存在独立收藏导航按钮');
  if (await page.locator('button[data-tab="projects"]').count()) throw new Error('底部仍存在文件目录导航按钮');
  if (await page.locator('#favoritesView').count()) throw new Error('仍存在独立收藏页面');
  await page.locator('#threadsView.active').waitFor({ timeout: 10_000 });
  await page.locator('#threadSearch').fill('保留的筛选');
  const threadSwipe = await swipeRight(page, '#threadsView');
  if (!threadSwipe.midTransform.includes('translate3d(72')) {
    throw new Error(`真实触摸时会话页没有跟随手指右移：${threadSwipe.midTransform || 'none'}`);
  }
  await page.locator('#projectsView.active').waitFor({ timeout: 10_000 });
  if (await page.locator('.project-button', { hasText: '使用当前目录' }).count()) {
    throw new Error('负一屏仍显示“使用当前目录”入口');
  }
  const fileScreenLayout = await page.evaluate(() => {
    const settings = document.querySelector('#settingsButton');
    const create = document.querySelector('#mobileNewThreadButton');
    const settingsRect = settings.getBoundingClientRect();
    const createRect = create.getBoundingClientRect();
    return {
      hash: location.hash,
      backRemoved: !document.querySelector('#projectThreadsBackButton'),
      navigationRemoved: !document.querySelector('.bottom-nav'),
      projectClass: document.body.classList.contains('mobile-project-detail'),
      settingsInProjects: Boolean(settings.closest('#projectsView')),
      settingsVisible: getComputedStyle(settings).display !== 'none',
      settingsWidth: Math.round(settingsRect.width),
      settingsTop: Math.round(settingsRect.top),
      settingsRight: Math.round(innerWidth - settingsRect.right),
      createInProjects: Boolean(create.closest('#projectsView')),
      createVisible: getComputedStyle(create).display !== 'none',
      createWidth: Math.round(createRect.width),
      createHeight: Math.round(createRect.height),
      createRight: Math.round(innerWidth - createRect.right),
      createBottom: Math.round(innerHeight - createRect.bottom),
    };
  });
  if (fileScreenLayout.hash !== '#projects' || !fileScreenLayout.backRemoved
    || !fileScreenLayout.navigationRemoved || !fileScreenLayout.projectClass
    || !fileScreenLayout.settingsInProjects || !fileScreenLayout.settingsVisible
    || !fileScreenLayout.createInProjects || !fileScreenLayout.createVisible) {
    throw new Error(`文件目录负一屏布局错误：${JSON.stringify(fileScreenLayout)}`);
  }
  if (fileScreenLayout.settingsWidth > 32 || fileScreenLayout.settingsTop > 54 || fileScreenLayout.settingsRight > 14) {
    throw new Error(`设置按钮没有小尺寸固定在右上角：${JSON.stringify(fileScreenLayout)}`);
  }
  if (fileScreenLayout.createWidth < 52 || fileScreenLayout.createHeight < 52
    || fileScreenLayout.createRight > 22 || fileScreenLayout.createBottom > 22) {
    throw new Error(`新增会话按钮没有大尺寸固定在右下角：${JSON.stringify(fileScreenLayout)}`);
  }
  await page.screenshot({ path: '/tmp/codex-mobile-negative-screen.png', fullPage: true });
  await swipeRight(page, '#projectsView');
  if (!await page.locator('#projectsView').evaluate((element) => element.classList.contains('active'))) {
    throw new Error('文件页错误响应了反方向右滑');
  }
  const projectSwipe = await swipeLeft(page, '#projectsView');
  if (!projectSwipe.midTransform.includes('translate3d(-72')) {
    throw new Error(`真实触摸时文件页没有跟随手指左移：${projectSwipe.midTransform || 'none'}`);
  }
  await page.locator('#threadsView.active').waitFor({ timeout: 10_000 });
  if (await page.locator('#threadSearch').inputValue() !== '保留的筛选') {
    throw new Error('从文件目录返回后会话筛选状态丢失');
  }
  await swipeRight(page, '#threadsView');
  await page.locator('#projectsView.active').waitFor({ timeout: 10_000 });
  await page.evaluate(() => history.back());
  await page.locator('#threadsView.active').waitFor({ timeout: 10_000 });
  const returnedHash = await page.evaluate(() => location.hash);
  if (returnedHash !== '#threads') throw new Error(`系统返回键没有返回会话页：${returnedHash}`);
  await page.locator('#threadSearch').fill('');
  await page.locator('#threadFavoriteToggle').click();
  if (!await page.locator('#threadFavoriteToggle').evaluate((element) => element.classList.contains('active'))) {
    throw new Error('会话页收藏筛选未激活');
  }
  if (!await page.locator('[data-thread-filter="all"]').evaluate((element) => element.classList.contains('active'))) {
    throw new Error('开启收藏时不应取消全部状态');
  }
  await page.locator('#threadFavoriteToggle').click();
  if (await page.locator('#threadFavoriteToggle').evaluate((element) => element.classList.contains('active'))) {
    throw new Error('再次点击收藏未关闭筛选');
  }
  await page.evaluate(() => {
    history.pushState({ codexMobile: true, view: 'favorites' }, '', '#favorites');
    dispatchEvent(new PopStateEvent('popstate'));
  });
  await page.waitForFunction(() => location.hash === '#threads'
    && document.querySelector('#threadsView')?.classList.contains('active')
    && document.querySelector('#threadFavoriteToggle')?.classList.contains('active')
    && document.querySelector('[data-thread-filter="all"]')?.classList.contains('active'));
  await swipeRight(page, '#threadsView');
  await page.locator('#projectsView.active').waitFor({ timeout: 10_000 });
  await page.locator('#settingsButton').click();
  await page.locator('#settingsSheet[open]').waitFor({ timeout: 10_000 });

  // 5) 深浅主题可以切换，并在刷新后保留。
  const initialTheme = await page.evaluate(() => ({
    dataset: document.documentElement.dataset.theme,
    selected: document.querySelector('#themeSelect').value,
  }));
  if (initialTheme.dataset !== 'dark' || initialTheme.selected !== 'dark') {
    throw new Error(`默认主题异常：${JSON.stringify(initialTheme)}`);
  }
  await page.locator('#themeSelect').selectOption('light');
  const lightTheme = await page.evaluate(() => ({
    dataset: document.documentElement.dataset.theme,
    selected: document.querySelector('#themeSelect').value,
    stored: localStorage.getItem('codex-mobile-theme'),
    bodyBackground: getComputedStyle(document.body).backgroundColor,
    dialogBackground: getComputedStyle(document.querySelector('#settingsSheet')).backgroundColor,
    themeColor: document.querySelector('#themeColorMeta').content,
  }));
  if (lightTheme.dataset !== 'light' || lightTheme.selected !== 'light' || lightTheme.stored !== 'light'
    || lightTheme.bodyBackground !== 'rgb(243, 245, 247)' || lightTheme.dialogBackground !== 'rgb(255, 255, 255)'
    || lightTheme.themeColor !== '#f3f5f7') {
    throw new Error(`浅色主题未完整应用：${JSON.stringify(lightTheme)}`);
  }

  await page.screenshot({ path: process.env.CODEX_MOBILE_SCREENSHOT ?? '/tmp/codex-mobile-nav.png', fullPage: true });
  await page.locator('#closeSettingsButton').click();
  await page.reload({ waitUntil: 'domcontentloaded' });
  await page.locator('#app:not([hidden])').waitFor({ timeout: 15_000 });
  const persistedTheme = await page.evaluate(() => ({
    dataset: document.documentElement.dataset.theme,
    stored: localStorage.getItem('codex-mobile-theme'),
    bodyBackground: getComputedStyle(document.body).backgroundColor,
  }));
  if (persistedTheme.dataset !== 'light' || persistedTheme.stored !== 'light'
    || persistedTheme.bodyBackground !== 'rgb(243, 245, 247)') {
    throw new Error(`刷新后主题未保留：${JSON.stringify(persistedTheme)}`);
  }
  await swipeRight(page, '#threadsView');
  await page.locator('#projectsView.active').waitFor({ timeout: 10_000 });
  await page.locator('#mobileNewThreadButton').click();
  await page.locator('#chatView.active').waitFor({ timeout: 10_000 });
  if (createdThreads !== 1 || createdThreadCwd !== '/home/ningmengchang'
    || await page.evaluate(() => location.hash) !== '#chat/thread-new') {
    throw new Error(`负一屏新增会话未使用当前目录进入聊天：${createdThreads} / ${createdThreadCwd} / ${await page.evaluate(() => location.hash)}`);
  }
  process.stdout.write(`${JSON.stringify({ homeLayout, fileScreenLayout, initialTheme, lightTheme, persistedTheme, createdThreads, createdThreadCwd })}\n`);
} finally {
  await browser.close();
}
