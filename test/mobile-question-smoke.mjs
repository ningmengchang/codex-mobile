import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const playwrightPath = process.env.PLAYWRIGHT_PATH
  ?? '/home/ningmengchang/ideaProjects/dpp-cloud-saic/dpp-platform-web/node_modules/playwright';
const { chromium } = require(playwrightPath);

const publicRoot = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'public');
const questionRequest = {
  id: 'req-question-1',
  method: 'item/tool/requestUserInput',
  params: {
    threadId: 'thread-1', turnId: 'turn-1', itemId: 'item-1', autoResolutionMs: 120_000,
    questions: [
      {
        id: 'mode', header: '方案选择', question: '请选择实施方式？', isOther: true,
        options: [
          { label: '直接实施', description: '改动最小' },
          { label: '分阶段实施', description: '每阶段验证' },
        ],
      },
      { id: 'note', header: '补充', question: '还有需要补充的要求吗？' },
    ],
  },
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
let respondBody = null;
try {
  const context = await browser.newContext({
    viewport: { width: 390, height: 844 }, deviceScaleFactor: 2, isMobile: true, hasTouch: true,
  });
  await context.addInitScript(({ question, boot }) => {
    window.__question = question;
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
    window.__emitApproval = () => {
      const event = { data: JSON.stringify(question) };
      for (const callback of listeners.get('approval') ?? []) callback(event);
    };
    window.EventSource = FakeEventSource;
    window.__boot = boot;
  }, { question: questionRequest, boot: bootstrap });
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
    if (pathname === '/api/threads' || /^\/api\/threads\/[^/]+$/.test(pathname)) {
      return fulfillJson({ data: [], thread: { id: 'thread-1', cwd: '/home/ningmengchang', turns: [] } });
    }
    if (/^\/api\/requests\/[^/]+\/respond$/.test(pathname)) {
      respondBody = route.request().postDataJSON();
      return fulfillJson({ resolved: true });
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
  await page.goto('http://127.0.0.1:39876/', { waitUntil: 'domcontentloaded' });
  await page.locator('#app:not([hidden])').waitFor({ timeout: 15_000 });
  await page.locator('#skillButton').click();
  await page.locator('#skillSheet[open]').waitFor({ timeout: 5_000 });
  await page.evaluate(() => window.__emitApproval());
  await page.locator('.approval-card').waitFor({ timeout: 15_000 });
  const skillSheetClosed = await page.evaluate(() => !document.querySelector('#skillSheet').hasAttribute('open'));
  if (!skillSheetClosed) throw new Error('审批到达后技能弹窗未关闭');
  await page.waitForTimeout(300);
  await page.locator('.question-block').first().waitFor();
  const layout = await page.evaluate(() => {
    const stack = document.querySelector('#approvalStack').getBoundingClientRect();
    const composer = document.querySelector('#composer').getBoundingClientRect();
    const nav = document.querySelector('.bottom-nav');
    const settingsElement = document.querySelector('.context-settings');
    return {
      stackTop: Math.round(stack.top),
      stackBottom: Math.round(stack.bottom),
      stackHeight: Math.round(stack.height),
      composerTop: Math.round(composer.top),
      navHidden: getComputedStyle(nav).display === 'none',
      viewport: window.innerHeight,
      approvalOpen: document.body.classList.contains('approval-open'),
      settingsVisible: settingsElement ? getComputedStyle(settingsElement).display !== 'none' : false,
      settingsGear: Boolean(document.querySelector('#settingsButton')),
    };
  });
  const result = {
    title: await page.locator('.approval-card h3').textContent(),
    optionLabels: await page.locator('.question-option strong').allTextContents(),
    questionCount: await page.locator('.question-block').count(),
    otherPresent: await page.locator('.question-option.other input').count() === 1,
    autoResolution: await page.locator('.approval-card p').first().textContent(),
    layout,
  };
  await page.locator('.approval-actions button.allow').click();
  await page.locator('.question-block.invalid').first().waitFor();
  const validationShown = await page.locator('.question-error:not([hidden])').count();
  await page.locator('.question-option input').nth(1).check();
  await page.locator('.question-freeform').fill('补充内容');
  await page.locator('.approval-actions button.allow').click();
  await page.locator('.approval-card').waitFor({ state: 'detached' });
  const screenshot = process.env.CODEX_MOBILE_SCREENSHOT ?? '/tmp/codex-mobile-question.png';
  await page.screenshot({ path: screenshot, fullPage: true });
  if (result.questionCount !== 2) throw new Error(`问题数量异常：${result.questionCount}`);
  if (!result.otherPresent) throw new Error('缺少“其他”输入选项');
  if (validationShown !== 2) throw new Error(`提交校验提示异常：${validationShown}`);
  if (result.layout.stackTop > result.layout.viewport * 0.3) {
    throw new Error(`抽屉起点过高，答题区太小：${JSON.stringify(result.layout)}`);
  }
  if (result.layout.stackHeight < result.layout.viewport * 0.7) {
    throw new Error(`抽屉高度不足视口 70%：${JSON.stringify(result.layout)}`);
  }
  if (result.layout.stackBottom < result.layout.viewport - 2) {
    throw new Error(`抽屉未延伸到屏幕底部：${JSON.stringify(result.layout)}`);
  }
  if (!result.layout.approvalOpen) throw new Error('approval-open 状态未设置');
  if (result.layout.settingsVisible) throw new Error('顶部设置项仍然常驻');
  if (!result.layout.settingsGear) throw new Error('缺少设置按钮');
  await page.locator('#settingsButton').click();
  await page.locator('#settingsSheet[open]').waitFor({ timeout: 5_000 });
  if (await page.locator('#modelSelect').isHidden()) throw new Error('设置抽屉里没有模型选择');
  await page.locator('#closeSettingsButton').click();
  await page.waitForFunction(() => !document.querySelector('#settingsSheet')?.hasAttribute('open'));
  if (!result.layout.navHidden) throw new Error('抽屉打开时底部导航未隐藏');
  const answers = respondBody?.answers ?? {};
  if (answers.mode?.[0] !== '分阶段实施' || answers.note?.[0] !== '补充内容') {
    throw new Error(`回答映射异常：${JSON.stringify(respondBody)}`);
  }
  result.submittedAnswers = answers;
  result.validationShown = validationShown;
  process.stdout.write(`${JSON.stringify(result)}\n`);
} finally {
  await browser.close();
}
