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
const markdown = {
  id: 'project-file-readme', name: 'README.md', path: '/proj/session/README.md', relativePath: 'README.md', fileKind: 'markdown',
  isDirectory: false, size: 128, modifiedAt: '2026-08-11T10:00:00.000Z', available: true, token: 'project-file-token',
};
const fillerEntries = Array.from({ length: 30 }, (_, index) => ({
  name: `archive-${index + 1}`, path: `/proj/session/archive-${index + 1}`,
  relativePath: `archive-${index + 1}`, isDirectory: true, fileKind: 'directory',
}));
const thread = {
  id: 'thread-session', cwd: '/proj/session', name: '当前工作会话', preview: '', status: 'idle', updatedAt: 2, turns: [],
};
const bootstrap = {
  appServer: { ready: true }, runtime: { user: 'ningmengchang' }, models: [], collaborationModes: [], pendingRequests: [],
  projects: {
    current: { name: 'demo', path: '/proj/demo' }, parent: null, root: '/proj',
    entries: [
      { name: 'docs', path: '/proj/demo/docs', isDirectory: true, fileKind: 'directory' },
      markdown,
    ],
  },
};

const browser = await chromium.launch({ headless: true });
try {
  const context = await browser.newContext({
    viewport: { width: 390, height: 844 }, deviceScaleFactor: 2, isMobile: true, hasTouch: true,
  });
  await context.addInitScript(() => {
    window.EventSource = class {
      constructor() { setTimeout(() => this.onopen?.(), 20); }
      addEventListener() {}
      close() {}
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
  });
  const page = await context.newPage();
  const cdp = await context.newCDPSession(page);
  let browsedDocs = false;
  let includeFillerEntries = true;
  let uploadedFile = null;
  let managedEntries = [];
  const projectRequests = [];
  const uploadRequests = [];
  const createRequests = [];
  const deleteRequests = [];
  let newThreadRequest = null;
  await page.route('**/*', async (route) => {
    const url = new URL(route.request().url());
    const pathname = url.pathname;
    const method = route.request().method();
    const fulfillJson = (body, status = 200) => route.fulfill({
      status, contentType: 'application/json; charset=utf-8', body: JSON.stringify(body),
    });
    if (pathname === '/api/auth/status') return fulfillJson({ authenticated: true });
    if (pathname === '/api/bootstrap') return fulfillJson(bootstrap);
    if (pathname === '/api/requests') return fulfillJson({ data: [] });
    if (pathname === '/api/projects') {
      projectRequests.push(url.searchParams.get('path'));
      if (url.searchParams.get('path') === '/proj/session/docs') {
        browsedDocs = true;
        return fulfillJson({ current: { name: 'docs', path: '/proj/session/docs' }, parent: '/proj/session', root: '/proj', entries: [] });
      }
      if (url.searchParams.get('path')?.startsWith('/proj/session/')) {
        const currentPath = url.searchParams.get('path');
        return fulfillJson({
          current: { name: path.basename(currentPath), path: currentPath }, parent: path.dirname(currentPath), root: '/proj',
          entries: managedEntries.filter((entry) => entry.parent === currentPath),
        });
      }
      if (url.searchParams.get('path') === '/proj/session') {
        return fulfillJson({
          current: { name: 'session', path: '/proj/session' }, parent: '/proj', root: '/proj',
          entries: [
            { name: 'docs', path: '/proj/session/docs', isDirectory: true, fileKind: 'directory' },
            markdown,
            ...(includeFillerEntries ? fillerEntries : []),
            ...(uploadedFile ? [uploadedFile] : []),
            ...managedEntries.filter((entry) => entry.parent === '/proj/session'),
          ],
        });
      }
      return fulfillJson(bootstrap.projects);
    }
    if (pathname === '/api/projects/upload' && route.request().method() === 'POST') {
      const body = route.request().postDataBuffer();
      uploadRequests.push({
        path: url.searchParams.get('path'),
        name: url.searchParams.get('name'),
        body: body?.toString('utf8'),
      });
      uploadedFile = {
        id: 'project-uploaded-file', name: url.searchParams.get('name'), relativePath: url.searchParams.get('name'),
        fileKind: 'text', isDirectory: false, size: body?.length ?? 0,
        modifiedAt: '2026-08-11T11:00:00.000Z', available: true, token: 'uploaded-file-token',
      };
      return fulfillJson({ uploaded: true, overwritten: false, artifact: uploadedFile }, 201);
    }
    if (pathname === '/api/projects/entries' && route.request().method() === 'POST') {
      const body = JSON.parse(route.request().postData() || '{}');
      createRequests.push(body);
      const isDirectory = body.type === 'directory';
      const entry = {
        id: `managed-${createRequests.length}`, name: body.name, path: path.join(body.directory, body.name),
        parent: body.directory, relativePath: body.name, isDirectory,
        fileKind: isDirectory ? 'directory' : 'text', size: isDirectory ? 0 : Buffer.byteLength(body.content || ''),
        modifiedAt: '2026-08-11T12:00:00.000Z', available: true,
        ...(isDirectory ? {} : { token: `managed-token-${createRequests.length}` }),
      };
      managedEntries.push(entry);
      return fulfillJson({ created: true, artifact: entry }, 201);
    }
    if (pathname === '/api/projects/entry' && route.request().method() === 'DELETE') {
      const body = JSON.parse(route.request().postData() || '{}');
      deleteRequests.push(body);
      const deleted = managedEntries.find((entry) => entry.path === body.path);
      managedEntries = managedEntries.filter((entry) => entry.path !== body.path && !entry.path.startsWith(`${body.path}/`));
      return fulfillJson({
        deleted: true, name: deleted?.name ?? body.confirmName, path: body.path, parent: path.dirname(body.path),
        isDirectory: deleted?.isDirectory ?? body.recursive,
      });
    }
    if (pathname === '/api/threads' && method === 'POST') {
      newThreadRequest = route.request().postDataJSON();
      return fulfillJson({ thread: { id: 'thread-docs', cwd: newThreadRequest.cwd, name: '文档会话', turns: [] } });
    }
    if (pathname === '/api/threads') return fulfillJson({ data: [thread] });
    if (pathname === '/api/threads/thread-session' && route.request().method() === 'GET') return fulfillJson({ thread });
    if (pathname === '/api/threads/thread-session/resume') return fulfillJson({ thread });
    if (pathname === '/api/threads/thread-session/turns') return fulfillJson({ data: [], nextCursor: null });
    if (pathname === '/api/threads/thread-session/artifacts') return fulfillJson({ data: [] });
    if (pathname === '/api/events') return route.fulfill({ status: 200, contentType: 'text/event-stream', body: ': connected\n\n' });
    if (pathname === '/api/artifacts/project-file-token/meta') return fulfillJson(markdown);
    if (pathname === '/api/artifacts/project-file-token/raw') {
      return route.fulfill({ status: 200, contentType: 'text/markdown; charset=utf-8', body: '# 项目说明\n\n项目文件可直接预览。' });
    }
    const file = path.join(publicRoot, pathname === '/' ? 'index.html' : pathname);
    if (!fs.existsSync(file) || !fs.statSync(file).isFile()) return route.fulfill({ status: 404, body: 'not found' });
    const contentType = file.endsWith('.js') ? 'text/javascript; charset=utf-8'
      : file.endsWith('.css') ? 'text/css; charset=utf-8'
        : file.endsWith('.html') ? 'text/html; charset=utf-8'
          : 'application/octet-stream';
    return route.fulfill({ status: 200, contentType, body: fs.readFileSync(file) });
  });

  const longPress = async (locator) => {
    const box = await locator.boundingBox();
    if (!box) throw new Error('长按目标不可见');
    const point = { x: box.x + box.width / 2, y: box.y + box.height / 2, radiusX: 3, radiusY: 3, force: 1 };
    await cdp.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [point] });
    await page.waitForTimeout(650);
    await cdp.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
    await page.locator('#fileUploadPopover:not([hidden])').waitFor();
  };

  const touchTap = async (locator) => {
    const box = await locator.boundingBox();
    if (!box) throw new Error('点击目标不可见');
    const point = { x: box.x + box.width / 2, y: box.y + box.height / 2, radiusX: 3, radiusY: 3, force: 1 };
    await cdp.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [point] });
    await page.waitForTimeout(80);
    await cdp.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
  };

  await page.goto('http://127.0.0.1:39911/', { waitUntil: 'domcontentloaded' });
  await page.locator('#app:not([hidden])').waitFor({ timeout: 15_000 });
  await page.locator('#mobileThreadList .thread-item', { hasText: '当前工作会话' }).click();
  await page.locator('#chatView.active').waitFor();
  await page.locator('#chatBackButton').click();
  await page.locator('#threadsView.active').waitFor();
  await swipeRight(page, '#threadsView');
  await page.locator('#projectsView.active').waitFor();
  await page.waitForFunction(() => document.querySelector('#projectPath')?.textContent === '/proj/session');

  const projectHeadTop = await page.locator('.project-fixed-head').evaluate((element) => element.getBoundingClientRect().top);
  await page.locator('.project-list-scroll').evaluate((element) => { element.scrollTop = element.scrollHeight; });
  await page.waitForFunction(() => document.querySelector('.project-list-scroll').scrollTop > 0);
  const projectScrollLayout = await page.evaluate(() => ({
    headTop: document.querySelector('.project-fixed-head').getBoundingClientRect().top,
    viewScrollTop: document.querySelector('#projectsView').scrollTop,
    listScrollTop: document.querySelector('.project-list-scroll').scrollTop,
  }));
  if (Math.abs(projectHeadTop - projectScrollLayout.headTop) > 1
    || projectScrollLayout.viewScrollTop !== 0 || projectScrollLayout.listScrollTop <= 0) {
    throw new Error(`文件管理页头部随列表滚动：${JSON.stringify({ projectHeadTop, projectScrollLayout })}`);
  }
  includeFillerEntries = false;

  const fileButton = page.locator('.project-button.project-file', { hasText: 'README.md' });
  await fileButton.waitFor();
  const directoryShareButton = page.locator('.project-file-row', { hasText: 'README.md' }).locator('.project-file-share');
  await directoryShareButton.waitFor();
  const shareButtonWidth = await directoryShareButton.evaluate((element) => Math.round(element.getBoundingClientRect().width));
  if (shareButtonWidth > 42) throw new Error(`文件分享按钮过宽：${shareButtonWidth}`);
  await directoryShareButton.click();
  await page.locator('#fileShareDialog[open]').waitFor();
  await page.locator('#systemShareButton:not(:disabled)').waitFor();
  if (process.env.CODEX_MOBILE_SHARE_SCREENSHOT) {
    await page.screenshot({ path: process.env.CODEX_MOBILE_SHARE_SCREENSHOT, fullPage: true });
  }
  await page.locator('#systemShareButton').click();
  await page.locator('#fileShareDialog').waitFor({ state: 'hidden' });
  const firstSharedFile = await page.evaluate(() => window.__sharedFiles[0]);
  if (firstSharedFile?.name !== 'README.md' || !firstSharedFile.text.includes('项目文件可直接预览')) {
    throw new Error(`文件目录分享内容错误：${JSON.stringify(firstSharedFile)}`);
  }
  const directoryTypography = await page.evaluate(() => {
    const sizeOf = (selector) => {
      const element = document.querySelector(selector);
      return element ? Number.parseFloat(getComputedStyle(element).fontSize) : null;
    };
    return {
      heading: sizeOf('#projectsView .section-head h2'),
      name: sizeOf('.project-button.project-file strong'),
      detail: sizeOf('.project-button.project-file small'),
      path: sizeOf('#projectPath'),
      back: sizeOf('#projectUpButton'),
      upload: sizeOf('#uploadProjectFilesButton'),
    };
  });
  if (directoryTypography.heading > 14 || directoryTypography.name > 11
    || directoryTypography.detail > 9 || directoryTypography.path > 9
    || directoryTypography.back > 10 || directoryTypography.upload > 10) {
    throw new Error(`文件目录页字号过大：${JSON.stringify(directoryTypography)}`);
  }
  if (await page.locator('#desktopUploadProjectFilesButton').isVisible()) {
    throw new Error('手机端仍显示顶部上传按钮');
  }
  if (await page.locator('#fileUploadPopover').isVisible()) {
    throw new Error('上传按钮不应默认显示');
  }
  if (await page.locator('.project-button', { hasText: '使用当前目录' }).count()) {
    throw new Error('文件目录仍显示“使用当前目录”入口');
  }
  const currentDirectoryEntry = page.locator('#projectPath');
  await longPress(currentDirectoryEntry);
  if (!await page.locator('#uploadProjectFilesButton').isVisible()
    || !await page.locator('#createProjectFileButton').isVisible()
    || !await page.locator('#createProjectDirectoryButton').isVisible()
    || await page.locator('#deleteProjectEntryButton').isVisible()) {
    throw new Error('当前目录长按操作项错误');
  }
  const uploadPopoverPosition = await page.evaluate(() => {
    const popover = document.querySelector('#fileUploadPopover').getBoundingClientRect();
    return {
      left: Math.round(popover.left),
      right: Math.round(popover.right),
      top: Math.round(popover.top),
      popoverBottom: Math.round(popover.bottom),
      viewportWidth: innerWidth,
      viewportHeight: innerHeight,
    };
  });
  if (uploadPopoverPosition.left < 0 || uploadPopoverPosition.top < 0
    || uploadPopoverPosition.right > uploadPopoverPosition.viewportWidth
    || uploadPopoverPosition.popoverBottom > uploadPopoverPosition.viewportHeight) {
    throw new Error(`长按上传按钮位置错误：${JSON.stringify(uploadPopoverPosition)}`);
  }
  const chooserPromise = page.waitForEvent('filechooser');
  await page.locator('#uploadProjectFilesButton').click();
  const chooser = await chooserPromise;
  await chooser.setFiles({ name: '手机上传.txt', mimeType: 'text/plain', buffer: Buffer.from('来自手机') });
  await page.locator('.project-button.project-file', { hasText: '手机上传.txt' }).waitFor();
  if (uploadRequests.length !== 1 || uploadRequests[0].path !== '/proj/session'
    || uploadRequests[0].name !== '手机上传.txt' || uploadRequests[0].body !== '来自手机') {
    throw new Error(`文件上传请求错误：${JSON.stringify(uploadRequests)}`);
  }

  await longPress(currentDirectoryEntry);
  await page.locator('#createProjectDirectoryButton').click();
  await page.locator('#projectCreateDialog[open]').waitFor();
  await page.locator('#projectCreateName').fill('手机资料');
  if (await page.locator('#projectCreateContentField').isVisible()) throw new Error('新建文件夹不应显示内容输入框');
  await page.locator('#confirmProjectCreateButton').click();
  const managedFolder = page.locator('.project-button', { hasText: '手机资料' });
  await managedFolder.waitFor();
  if (createRequests[0]?.directory !== '/proj/session' || createRequests[0]?.name !== '手机资料'
    || createRequests[0]?.type !== 'directory') {
    throw new Error(`新建文件夹请求错误：${JSON.stringify(createRequests)}`);
  }

  await longPress(managedFolder);
  if (!await page.locator('#deleteProjectEntryButton').isVisible()
    || !await page.locator('#createProjectFileButton').isVisible()
    || !await page.locator('#uploadProjectFilesButton').isVisible()) {
    throw new Error('文件夹长按操作项不完整');
  }
  if (!String(await page.locator('#fileActionTargetName').textContent()).includes('手机资料')) {
    throw new Error('文件夹长按目标错误');
  }
  await page.locator('#createProjectFileButton').click();
  await page.locator('#projectCreateDialog[open]').waitFor();
  await page.locator('#projectCreateName').fill('说明.txt');
  await page.locator('#projectCreateContent').click();
  await page.locator('#projectCreateContent').fill('目录中创建的文件');
  await page.locator('#confirmProjectCreateButton').click();
  if (createRequests[1]?.directory !== '/proj/session/手机资料' || createRequests[1]?.name !== '说明.txt'
    || createRequests[1]?.type !== 'file' || createRequests[1]?.content !== '目录中创建的文件') {
    throw new Error(`新建文件请求错误：${JSON.stringify(createRequests)}`);
  }

  await page.waitForTimeout(150);
  await managedFolder.click();
  await page.waitForFunction(() => document.querySelector('#projectPath')?.textContent === '/proj/session/手机资料');
  const managedFile = page.locator('.project-button.project-file', { hasText: '说明.txt' });
  await managedFile.waitFor();
  await longPress(managedFile);
  if (!await page.locator('#deleteProjectEntryButton').isVisible()
    || await page.locator('#createProjectFileButton').isVisible()
    || await page.locator('#uploadProjectFilesButton').isVisible()) {
    throw new Error('文件长按应只显示删除操作');
  }
  await touchTap(page.locator('#deleteProjectEntryButton'));
  await page.locator('#projectDeleteDialog[open]').waitFor();
  if (!String(await page.locator('#projectDeleteMessage').textContent()).includes('说明.txt')) throw new Error('删除文件确认目标错误');
  await page.locator('#confirmProjectDeleteButton').click();
  await managedFile.waitFor({ state: 'detached' });

  await page.locator('#projectUpButton').click();
  await page.waitForFunction(() => document.querySelector('#projectPath')?.textContent === '/proj/session');
  const managedFolderAgain = page.locator('.project-button', { hasText: '手机资料' });
  await managedFolderAgain.waitFor();
  await longPress(managedFolderAgain);
  await touchTap(page.locator('#deleteProjectEntryButton'));
  await page.locator('#projectDeleteDialog[open]').waitFor();
  if (!String(await page.locator('#projectDeleteMessage').textContent()).includes('全部内容')) throw new Error('删除文件夹未提示递归删除');
  await page.locator('#confirmProjectDeleteButton').click();
  await managedFolderAgain.waitFor({ state: 'detached' });
  if (deleteRequests.length !== 2 || deleteRequests[0]?.path !== '/proj/session/手机资料/说明.txt'
    || deleteRequests[0]?.recursive !== false || deleteRequests[1]?.path !== '/proj/session/手机资料'
    || deleteRequests[1]?.recursive !== true) {
    throw new Error(`删除请求错误：${JSON.stringify(deleteRequests)}`);
  }

  await fileButton.click();
  await page.locator('#previewDialog[open]').waitFor();
  if (await page.locator('#previewTitle').textContent() !== 'README.md') throw new Error('项目文件预览标题错误');
  const previewText = await page.locator('#previewBody').textContent();
  if (!previewText.includes('项目文件可直接预览')) throw new Error(`项目文件预览内容错误：${previewText}`);
  const previewTypography = await page.evaluate(() => {
    const body = document.querySelector('#previewBody > .agent-card');
    const heading = body?.querySelector('h1');
    return {
      body: body ? Number.parseFloat(getComputedStyle(body).fontSize) : null,
      heading: heading ? Number.parseFloat(getComputedStyle(heading).fontSize) : null,
    };
  });
  if (previewTypography.body > 11 || previewTypography.heading > 14) {
    throw new Error(`文件预览字号过大：${JSON.stringify(previewTypography)}`);
  }

  if (!await page.locator('#sharePreviewButton').isVisible()) throw new Error('文件预览缺少分享按钮');
  await page.locator('#sharePreviewButton').click();
  await page.locator('#fileShareDialog[open]').waitFor();
  await page.locator('#systemShareButton:not(:disabled)').waitFor();
  await page.locator('#systemShareButton').click();
  await page.locator('#fileShareDialog').waitFor({ state: 'hidden' });
  if (!await page.locator('#previewDialog').evaluate((dialog) => dialog.open)) {
    throw new Error('分享完成后文件预览被意外关闭');
  }
  const previewSharedFile = await page.evaluate(() => window.__sharedFiles[1]);
  if (previewSharedFile?.name !== 'README.md') {
    throw new Error(`预览页分享文件错误：${JSON.stringify(previewSharedFile)}`);
  }

  await page.evaluate(() => {
    Object.defineProperty(navigator, 'canShare', { configurable: true, value: () => false });
  });
  await page.locator('#sharePreviewButton').click();
  await page.locator('#fileShareDialog[open]').waitFor();
  await page.waitForFunction(() => document.querySelector('#fileShareStatus')?.textContent?.includes('不支持直接分享'));
  if (!await page.locator('#systemShareButton').isDisabled()) throw new Error('不支持文件分享时系统分享按钮仍可点击');
  const fallbackDownload = await page.locator('#shareDownloadButton').getAttribute('href');
  if (!fallbackDownload?.includes('/api/artifacts/project-file-token/raw?download=1')) {
    throw new Error(`分享降级下载地址错误：${fallbackDownload}`);
  }
  await page.locator('#closeFileShareButton').click();

  await page.locator('#closePreviewButton').click();
  await page.locator('.project-button', { hasText: 'docs' }).click();
  await page.waitForFunction(() => document.querySelector('#projectPath')?.textContent === '/proj/session/docs');
  if (!browsedDocs) throw new Error('文件夹导航未保留');

  await swipeLeft(page, '#projectsView');
  await page.locator('#threadsView.active').waitFor();
  await swipeRight(page, '#threadsView');
  await page.locator('#projectsView.active').waitFor();
  await page.waitForFunction(() => document.querySelector('#projectPath')?.textContent === '/proj/session/docs');
  if (projectRequests.at(-1) !== '/proj/session/docs') {
    throw new Error(`重新进入文件页未保留已选目录：${JSON.stringify(projectRequests)}`);
  }

  await page.locator('#mobileNewThreadButton').click();
  await page.locator('#chatView.active').waitFor();
  if (newThreadRequest?.cwd !== '/proj/session/docs') {
    throw new Error(`加号没有使用正在浏览的目录创建会话：${JSON.stringify(newThreadRequest)}`);
  }
  if (await page.locator('#currentProjectName').textContent() !== 'docs') {
    throw new Error('新会话创建后当前目录名称未同步');
  }

  process.stdout.write(`${JSON.stringify({ currentDirectoryEntryRemoved: true, browsingDirectoryCreatesThread: true, selectedDirectoryPersisted: true, directoryActions: true, createDirectory: true, createFile: true, deleteFile: true, deleteDirectory: true, longPressUpload: true, fileUpload: true, filePreview: true, fileShare: true, previewShare: true, shareFallback: true, shareButtonWidth, directoryNavigation: true, uploadPopoverPosition, directoryTypography, previewTypography })}\n`);
} finally {
  await browser.close();
}
