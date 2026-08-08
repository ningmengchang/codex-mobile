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
  id: 'thread-1', cwd: '/home/ningmengchang', name: '超长会话标题'.repeat(40), preview: '', status: 'idle', updatedAt: 1,
};
const agentMessages = Array.from({ length: 25 }, (_, index) => ({
  id: `message-${index + 1}`, type: 'agentMessage', text: `第 ${index + 1} 行内容，用于让页面可以滚动。`,
}));
const messages = [
  { id: 'user-1', type: 'userMessage', content: [{ type: 'text', text: '问题1' }] },
  ...agentMessages.slice(0, 8),
  { id: 'user-2', type: 'userMessage', content: [{ type: 'text', text: '问题2' }] },
  ...agentMessages.slice(8, 16),
  { id: 'user-3', type: 'userMessage', content: [{ type: 'text', text: '问题3' }] },
  ...agentMessages.slice(16),
];
const historyTurn = { id: 'turn-1', status: 'completed', durationMs: 1000, items: messages };
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
  await context.grantPermissions(['clipboard-read', 'clipboard-write']);
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

  await page.goto('http://127.0.0.1:39879/', { waitUntil: 'domcontentloaded' });
  await page.locator('#app:not([hidden])').waitFor({ timeout: 15_000 });
  await page.waitForTimeout(300);

  const layout = await page.evaluate(() => {
    const composer = document.querySelector('.composer');
    const input = document.querySelector('#promptInput');
    const dialog = document.querySelector('#previewDialog');
    dialog.showModal();
    const composerRect = composer.getBoundingClientRect();
    const dialogRect = dialog.getBoundingClientRect();
    const result = {
      composerHeight: Math.round(composerRect.height),
      composerWidth: Math.round(composerRect.width),
      composerLeft: Math.round(composerRect.left),
      composerRight: Math.round(composerRect.right),
      inputFontSize: getComputedStyle(input).fontSize,
      previewTitleFontSize: getComputedStyle(document.querySelector('#previewTitle')).fontSize,
      previewKindFontSize: getComputedStyle(document.querySelector('#previewKind')).fontSize,
      previewModifyPadding: getComputedStyle(document.querySelector('#modifyArtifactButton')).padding,
      previewModifyFontSize: getComputedStyle(document.querySelector('#modifyArtifactButton')).fontSize,
      previewCloseWidth: Math.round(document.querySelector('#closePreviewButton').getBoundingClientRect().width),
      approvalReviewerValue: document.querySelector('#approvalReviewerSelect').value,
      projectPickerPresent: Boolean(document.querySelector('#projectPickerButton')),
      connectionInComposer: Boolean(document.querySelector('#connectionStatus')?.closest('.composer')),
      projectInComposer: Boolean(document.querySelector('#currentProjectName')?.closest('.composer')),
      contextStripPresent: Boolean(document.querySelector('.context-strip')),
      modeSwitchInComposer: Boolean(document.querySelector('#modeSwitch')?.closest('.composer-actions')),
      settingsInNav: Boolean(document.querySelector('#settingsButton')?.closest('.bottom-nav')),
      modeBeforeSend: (() => {
        const actions = document.querySelector('.composer-actions');
        const mode = document.querySelector('#modeSwitch');
        const send = document.querySelector('#sendButton');
        if (!actions || !mode || !send) return false;
        return Array.from(actions.children).indexOf(mode) < Array.from(actions.children).indexOf(send);
      })(),
      previewWidth: Math.round(dialogRect.width),
      previewHeight: Math.round(dialogRect.height),
      previewLeft: Math.round(dialogRect.left),
      previewBodyHeight: Math.round(document.querySelector('#previewBody').getBoundingClientRect().height),
      viewportWidth: innerWidth,
      scrollWidth: document.documentElement.scrollWidth,
    };
    dialog.close();
    return result;
  });

  if (layout.composerHeight > 70) throw new Error(`输入框过高：${JSON.stringify(layout)}`);
  if (layout.inputFontSize !== '12px') throw new Error(`输入字号异常：${layout.inputFontSize}`);
  if (layout.previewTitleFontSize !== '10px') throw new Error(`产出物弹窗标题字号异常：${layout.previewTitleFontSize}`);
  if (layout.previewKindFontSize !== '8px') throw new Error(`产出物弹窗小标题字号异常：${layout.previewKindFontSize}`);
  if (layout.approvalReviewerValue !== 'auto_review') throw new Error(`审批方式默认值异常：${layout.approvalReviewerValue}`);
  if (layout.projectPickerPresent) throw new Error('顶部项目入口未移除');
  if (!layout.connectionInComposer) throw new Error('连接状态未移入输入区');
  if (!layout.projectInComposer) throw new Error('当前项目名未移入输入区');
  if (layout.contextStripPresent) throw new Error('顶部操作条未移除');
  if (!layout.modeSwitchInComposer) throw new Error('模式切换不在输入区');
  if (!layout.settingsInNav) throw new Error('设置按钮不在底部导航');
  if (!layout.modeBeforeSend) throw new Error('模式切换未在发送按钮左侧');
  if (layout.previewModifyPadding !== '6px 10px') throw new Error(`产出物弹窗按钮内边距异常：${layout.previewModifyPadding}`);
  if (layout.previewModifyFontSize !== '10px') throw new Error(`产出物弹窗按钮字号异常：${layout.previewModifyFontSize}`);
  if (layout.previewCloseWidth < 27 || layout.previewCloseWidth > 30) throw new Error(`产出物弹窗关闭按钮尺寸异常：${layout.previewCloseWidth}`);
  if (layout.previewWidth !== layout.viewportWidth || layout.previewLeft !== 0) throw new Error(`产出物弹窗未占满宽度：${JSON.stringify(layout)}`);
  if (layout.previewHeight < 700) throw new Error(`产出物弹窗高度不足：${layout.previewHeight}`);
  if (layout.previewBodyHeight < 700) throw new Error(`产出物预览区高度不足：${layout.previewBodyHeight}`);
  if (layout.composerWidth !== layout.viewportWidth || layout.composerLeft !== 0 || layout.composerRight !== layout.viewportWidth) {
    throw new Error(`输入框宽度被误改：${JSON.stringify(layout)}`);
  }
  if (layout.scrollWidth > layout.viewportWidth) throw new Error(`页面横向溢出：${layout.scrollWidth} > ${layout.viewportWidth}`);

  await page.locator('button[data-tab="threads"]').click();
  await page.locator('#mobileThreadList .thread-item').first().waitFor({ timeout: 10_000 });
  const threadsOverflow = await page.evaluate(() => {
    const view = document.querySelector('#threadsView');
    return {
      viewScrollWidth: view.scrollWidth,
      viewClientWidth: view.clientWidth,
      docScrollWidth: document.documentElement.scrollWidth,
      innerWidth,
    };
  });
  if (threadsOverflow.viewScrollWidth > threadsOverflow.viewClientWidth) {
    throw new Error(`会话列表横向溢出：${JSON.stringify(threadsOverflow)}`);
  }
  if (threadsOverflow.docScrollWidth > threadsOverflow.innerWidth) {
    throw new Error(`页面横向溢出（会话列表）：${JSON.stringify(threadsOverflow)}`);
  }
  const threadsHead = await page.evaluate(() => {
    const h2 = document.querySelector('#threadsView .section-head h2');
    const button = document.querySelector('#mobileNewThreadButton');
    return {
      titlePresent: Boolean(h2),
      buttonText: button ? button.textContent.trim() : null,
      buttonLabel: button ? button.getAttribute('aria-label') : null,
      buttonWidth: button ? Math.round(button.getBoundingClientRect().width) : null,
      buttonHeight: button ? Math.round(button.getBoundingClientRect().height) : null,
      buttonRadius: button ? getComputedStyle(button).borderRadius : null,
    };
  });
  if (threadsHead.titlePresent) throw new Error(`会话页仍存在标题：${JSON.stringify(threadsHead)}`);
  if (threadsHead.buttonText !== '+') throw new Error(`新建按钮不是加号：${JSON.stringify(threadsHead)}`);
  if (threadsHead.buttonLabel !== '新建会话') throw new Error(`新建按钮缺少无障碍标签：${JSON.stringify(threadsHead)}`);
  if (threadsHead.buttonWidth !== 30 || threadsHead.buttonHeight !== 30) throw new Error(`新建按钮尺寸异常：${JSON.stringify(threadsHead)}`);
  if (threadsHead.buttonRadius !== '50%') throw new Error(`新建按钮不是圆形：${JSON.stringify(threadsHead)}`);
  await page.locator('#mobileThreadList .thread-item').first().click();
  await page.locator('#emptyState').waitFor({ state: 'hidden', timeout: 15_000 });
  await page.locator('.message').first().waitFor({ timeout: 10_000 });
  const bubble = await page.evaluate(() => {
    const el = document.querySelector('.message.user .bubble');
    const agent = document.querySelector('.message > .agent-card');
    const p = el?.querySelector('p');
    return {
      padding: el ? getComputedStyle(el).padding : null,
      fontSize: el ? getComputedStyle(el).fontSize : null,
      pMargin: p ? getComputedStyle(p).margin : null,
      radius: el ? getComputedStyle(el).borderRadius : null,
      maxWidth: el ? getComputedStyle(el).maxWidth : null,
      agentFontSize: agent ? getComputedStyle(agent).fontSize : null,
      agentMaxWidth: agent ? getComputedStyle(agent).maxWidth : null,
      agentBackground: agent ? getComputedStyle(agent).backgroundColor : null,
      agentRadius: agent ? getComputedStyle(agent).borderRadius : null,
    };
  });
  if (bubble.padding !== '8px 30px 8px 10px') throw new Error(`问题气泡内边距异常：${JSON.stringify(bubble)}`);
  if (bubble.fontSize !== '13px') throw new Error(`问题气泡字号异常：${JSON.stringify(bubble)}`);
  if (bubble.pMargin !== '0px') throw new Error(`问题气泡段落边距异常：${JSON.stringify(bubble)}`);
  if (bubble.radius !== '16px 5px 16px 16px') throw new Error(`问题气泡尾巴圆角异常：${JSON.stringify(bubble)}`);
  if (bubble.maxWidth !== '96%') throw new Error(`问题气泡最大宽度异常：${JSON.stringify(bubble)}`);
  if (bubble.agentFontSize !== '14px') throw new Error(`回答气泡字号异常：${JSON.stringify(bubble)}`);
  if (bubble.agentMaxWidth !== '96%') throw new Error(`回答气泡最大宽度异常：${JSON.stringify(bubble)}`);
  if (bubble.agentBackground === 'rgba(0, 0, 0, 0)') throw new Error(`回答气泡缺少背景：${JSON.stringify(bubble)}`);
  if (!['5px 16px 16px', '5px 16px 16px 16px'].includes(bubble.agentRadius)) throw new Error(`回答气泡尾巴圆角异常：${JSON.stringify(bubble)}`);
  await page.waitForTimeout(300);
  const jumpBefore = await page.evaluate(() => {
    const button = document.querySelector('#jumpQuestionButton');
    return {
      visible: button ? !button.hidden : false,
      scrollTop: document.querySelector('#chatView').scrollTop,
    };
  });
  if (!jumpBefore.visible) throw new Error('上一问题按钮未显示');
  const flashSequence = [];
  const scrollTops = [jumpBefore.scrollTop];
  for (let index = 0; index < 4; index += 1) {
    await page.locator('#jumpQuestionButton').click();
    await page.waitForTimeout(450);
    const step = await page.evaluate(() => ({
      id: document.querySelector('.message.user.flash')?.getAttribute('data-item-id') ?? null,
      scrollTop: document.querySelector('#chatView').scrollTop,
      flashCount: document.querySelectorAll('.message.user.flash').length,
    }));
    flashSequence.push(step.id);
    scrollTops.push(step.scrollTop);
    if (step.flashCount !== 1) throw new Error(`高亮数量异常：${step.flashCount}`);
  }
  const expectedSequence = ['user-3', 'user-2', 'user-1', 'user-3'];
  if (JSON.stringify(flashSequence) !== JSON.stringify(expectedSequence)) {
    throw new Error(`回退顺序异常：${JSON.stringify(flashSequence)}`);
  }
  if (!(scrollTops[1] < scrollTops[0] && scrollTops[2] < scrollTops[1] && scrollTops[3] < scrollTops[2])) {
    throw new Error(`回退滚动方向异常：${JSON.stringify(scrollTops)}`);
  }
  if (!(scrollTops[4] > scrollTops[3])) throw new Error(`循环回最新未生效：${JSON.stringify(scrollTops)}`);
  await page.locator('.copy-question').first().click();
  await page.waitForTimeout(100);
  const copied = await page.evaluate(() => navigator.clipboard.readText());
  if (copied !== '问题1') throw new Error(`复制内容异常：${copied}`);
  await page.screenshot({ path: process.env.CODEX_MOBILE_SCREENSHOT ?? '/tmp/codex-mobile-layout.png', fullPage: true });
  process.stdout.write(`${JSON.stringify({ layout, bubble, jumpBefore, flashSequence, scrollTops })}\n`);
} finally {
  await browser.close();
}
