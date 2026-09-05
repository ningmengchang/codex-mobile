import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const playwrightPath = process.env.PLAYWRIGHT_PATH
  ?? '/home/ningmengchang/ideaProjects/dpp-cloud-saic/dpp-platform-web/node_modules/playwright';
const { chromium } = require(playwrightPath);

const publicRoot = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'public');
const threadId = 'thread-image';
const thread = {
  id: threadId,
  cwd: '/home/ningmengchang',
  name: '图片输入测试',
  preview: '',
  status: 'idle',
  updatedAt: 1,
  turns: [],
};
const bootstrap = {
  appServer: { ready: true },
  runtime: { user: 'ningmengchang' },
  models: [
    { id: 'gpt-image', displayName: 'GPT Image', inputModalities: ['text', 'image'] },
    { id: 'text-only', displayName: 'Text only', inputModalities: ['text'] },
  ],
  defaultModel: 'gpt-image',
  collaborationModes: [],
  pendingRequests: [],
  projects: { current: { name: 'home', path: '/home/ningmengchang' }, parent: null, entries: [] },
};
const png = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=',
  'base64',
);

const browser = await chromium.launch({ headless: true });
try {
  const context = await browser.newContext({
    viewport: { width: 390, height: 844 }, deviceScaleFactor: 2, isMobile: true, hasTouch: true,
  });
  await context.addInitScript(() => {
    const listeners = new Map();
    class FakeEventSource {
      constructor() { setTimeout(() => this.onopen?.(), 20); }
      addEventListener(type, callback) {
        if (!listeners.has(type)) listeners.set(type, []);
        listeners.get(type).push(callback);
      }
      close() {}
    }
    window.EventSource = FakeEventSource;
    window.__sse = {
      emit(type, data) {
        for (const callback of listeners.get(type) ?? []) callback({ data: JSON.stringify(data) });
      },
    };
    window.__cameraRequests = 0;
    window.__galleryRequests = 0;
    window.CodexNativeUi = {
      requestCameraCapture() { window.__cameraRequests += 1; },
      requestGalleryPicker() { window.__galleryRequests += 1; },
    };
  });
  const page = await context.newPage();
  const turnBodies = [];
  let uploadCount = 0;
  await page.route('**/*', async (route) => {
    const url = new URL(route.request().url());
    const pathname = url.pathname;
    const fulfillJson = (body, status = 200) => route.fulfill({
      status, contentType: 'application/json; charset=utf-8', body: JSON.stringify(body),
    });
    if (pathname === '/api/auth/status') return fulfillJson({ authenticated: true });
    if (pathname === '/api/bootstrap' || pathname === '/api/catalogs') return fulfillJson(bootstrap);
    if (pathname === '/api/requests') return fulfillJson({ data: [] });
    if (pathname === '/api/favorites') return fulfillJson({ data: [] });
    if (pathname === '/api/projects') return fulfillJson(bootstrap.projects);
    if (pathname === '/api/threads' && route.request().method() === 'GET') return fulfillJson({ data: [thread] });
    if (pathname === `/api/threads/${threadId}`) return fulfillJson({ thread });
    if (pathname === `/api/threads/${threadId}/turns` && route.request().method() === 'GET') {
      return fulfillJson({ data: [], nextCursor: null });
    }
    if (pathname === `/api/threads/${threadId}/artifacts`) return fulfillJson({ data: [] });
    if (pathname === '/api/chat-images' && route.request().method() === 'POST') {
      uploadCount += 1;
      if (!(await route.request().postDataBuffer())?.length) throw new Error('图片上传内容为空');
      return fulfillJson({
        image: {
          id: `image-${uploadCount}`,
          name: url.searchParams.get('name') || '图片.png',
          mimeType: route.request().headers()['content-type'],
          size: png.length,
          token: `image-token-${uploadCount}`,
          previewUrl: `/api/chat-images/preview-${uploadCount}`,
        },
      }, 201);
    }
    if (pathname.startsWith('/api/chat-images/preview-')) {
      return route.fulfill({ status: 200, contentType: 'image/png', body: png });
    }
    if (pathname === `/api/threads/${threadId}/turns` && route.request().method() === 'POST') {
      const body = route.request().postDataJSON();
      turnBodies.push(body);
      return fulfillJson({
        thread,
        turn: { id: `turn-${turnBodies.length}`, status: 'completed', items: [] },
      }, 201);
    }
    if (pathname === '/api/events') {
      return route.fulfill({ status: 200, contentType: 'text/event-stream', body: ': connected\n\n' });
    }
    const file = path.join(publicRoot, pathname === '/' ? 'index.html' : pathname);
    if (!fs.existsSync(file) || !fs.statSync(file).isFile()) return route.fulfill({ status: 404, body: 'not found' });
    const contentType = file.endsWith('.js') ? 'text/javascript; charset=utf-8'
      : file.endsWith('.css') ? 'text/css; charset=utf-8'
        : file.endsWith('.html') ? 'text/html; charset=utf-8'
          : file.endsWith('.svg') ? 'image/svg+xml'
            : 'application/octet-stream';
    return route.fulfill({ status: 200, contentType, body: fs.readFileSync(file) });
  });

  await page.goto('http://127.0.0.1:39896/', { waitUntil: 'domcontentloaded' });
  await page.locator('#app:not([hidden])').waitFor({ timeout: 15_000 });
  await page.locator('#mobileThreadList .thread-item').first().click();
  await page.locator('#imageButton').click();
  await page.locator('#imageSourcePopover:not([hidden])').waitFor();

  const cameraChooser = page.waitForEvent('filechooser');
  await page.locator('#takePhotoButton').click();
  await (await cameraChooser).setFiles({ name: '截图.png', mimeType: 'image/png', buffer: png });
  if (await page.evaluate(() => window.__cameraRequests) !== 1) throw new Error('拍照入口未通知 Android 原生层');
  await page.waitForFunction(() => {
    const draft = document.querySelector('.image-draft');
    return draft && !draft.querySelector('.image-draft-progress');
  });
  await page.screenshot({
    path: process.env.CODEX_MOBILE_SCREENSHOT ?? '/tmp/codex-mobile-image-input.png',
    fullPage: true,
  });
  await page.locator('#promptInput').fill('请分析这张截图');
  await page.locator('#sendButton').click();
  await page.waitForFunction(() => document.querySelectorAll('.user-image-button').length === 1);

  if (turnBodies[0]?.text !== '请分析这张截图') throw new Error('图片与文字未一起发送');
  if (turnBodies[0]?.images?.[0]?.token !== 'image-token-1') throw new Error('图片凭据未进入回合请求');
  if (await page.locator('#imageTray').isVisible()) throw new Error('发送成功后图片草稿未清空');

  await page.evaluate(() => window.__sse.emit('codex', {
    method: 'item/completed',
    params: {
      thread_id: 'thread-image',
      turn_id: 'turn-1',
      item: {
        id: 'server-user-1',
        type: 'userMessage',
        content: [
          { type: 'local_image', imageId: 'image-1', previewUrl: '/api/chat-images/preview-1' },
          { type: 'text', text: '请分析这张截图' },
        ],
      },
    },
  }));
  await page.waitForTimeout(50);
  if (await page.locator('.user-image-button').count() !== 1) throw new Error('服务端回显后图片问题卡片重复');

  await page.locator('.user-image-button').click();
  await page.locator('#chatImagePreviewDialog[open]').waitFor();
  await page.locator('#closeChatImagePreview').click();

  await page.locator('#imageButton').click();
  const galleryChooser = page.waitForEvent('filechooser');
  await page.locator('#chooseGalleryImageButton').click();
  await (await galleryChooser).setFiles({ name: '纯图片.png', mimeType: 'image/png', buffer: png });
  if (await page.evaluate(() => window.__galleryRequests) !== 1) throw new Error('相册入口未通知 Android 原生层');
  await page.waitForFunction(() => {
    const draft = document.querySelector('.image-draft');
    return draft && !draft.querySelector('.image-draft-progress');
  });
  await page.locator('#sendButton').click();
  await page.waitForFunction(() => document.querySelectorAll('.user-image-button').length === 2);
  if (turnBodies[1]?.text !== '') throw new Error('纯图片回合不应注入占位文字');
  if (turnBodies[1]?.images?.[0]?.token !== 'image-token-2') throw new Error('纯图片回合未发送图片凭据');

  await page.locator('#modelSelect').evaluate((select) => {
    select.value = 'text-only';
    select.dispatchEvent(new Event('change', { bubbles: true }));
  });
  if (!await page.locator('#imageButton').evaluate((button) => button.classList.contains('unsupported'))) {
    throw new Error('纯文本模型未禁用图片入口');
  }
  await page.locator('#modelSelect').evaluate((select) => {
    select.value = 'gpt-image';
    select.dispatchEvent(new Event('change', { bubbles: true }));
  });
  await page.locator('#imageGalleryInput').setInputFiles(Array.from({ length: 5 }, (_, index) => ({
    name: `批量-${index + 1}.png`, mimeType: 'image/png', buffer: png,
  })));
  if (await page.locator('.image-draft').count() !== 4) throw new Error('前端未限制一次最多四张图片');

  process.stdout.write(`${JSON.stringify({ uploads: uploadCount, turns: turnBodies.length, preview: true, capability: true, maxImages: 4 })}\n`);
} finally {
  await browser.close();
}
