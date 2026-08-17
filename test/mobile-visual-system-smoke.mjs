import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';

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
  projects: { current: { name: 'codex-mobile', path: '/home/ningmengchang/ideaProjects/codex-mobile' }, parent: null, entries: [] },
};

const browser = await chromium.launch({ headless: true });
try {
  const context = await browser.newContext({
    viewport: { width: 390, height: 844 },
    deviceScaleFactor: 2,
    isMobile: true,
    hasTouch: true,
  });
  await context.addInitScript(() => {
    localStorage.removeItem('codex-mobile-theme');
    window.EventSource = class {
      constructor() { setTimeout(() => this.onopen?.(), 20); }
      addEventListener() {}
      close() {}
    };
  });
  const page = await context.newPage();
  await page.route('**/*', async (route) => {
    const pathname = new URL(route.request().url()).pathname;
    const fulfillJson = (body, status = 200) => route.fulfill({
      status,
      contentType: 'application/json; charset=utf-8',
      body: JSON.stringify(body),
    });
    if (pathname === '/api/auth/status') return fulfillJson({ authenticated: true });
    if (pathname === '/api/bootstrap') return fulfillJson(bootstrap);
    if (pathname === '/api/requests') return fulfillJson({ data: [] });
    if (pathname === '/api/projects') return fulfillJson(bootstrap.projects);
    if (pathname === '/api/threads') return fulfillJson({ data: [] });
    if (pathname === '/api/favorites') return fulfillJson({ data: [] });
    if (pathname === '/api/skills') return fulfillJson({ data: [] });
    if (pathname.startsWith('/api/skills/market')) return fulfillJson({ data: [] });
    if (pathname === '/api/events') {
      return route.fulfill({ status: 200, contentType: 'text/event-stream', body: ': connected\n\n' });
    }
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
  await page.evaluate(() => {
    const fixture = document.createElement('section');
    fixture.id = 'visualCoverageFixture';
    fixture.hidden = true;
    fixture.innerHTML = `
      <button class="button">次要按钮</button>
      <button class="button primary">主要按钮</button>
      <button class="button danger">危险按钮</button>
      <button class="icon-button">×</button>
      <button class="thread-action-row">会话操作</button>
      <button class="file-action-button">文件操作</button>
      <button class="file-upload-button">上传</button>
      <button class="project-settings-button">设置</button>
      <button class="skill-button">⌘</button>
      <button class="send-button">↑</button>
      <button class="stop-button"><i></i>停止</button>
      <button class="scroll-latest">回到最新</button>
      <article class="message user"><div class="bubble">用户问题</div></article>
      <article class="message"><div class="agent-card">模型结论</div></article>
      <details class="tool-card"><summary><span class="tool-badge">工具</span>执行详情</summary></details>
      <details class="turn-tools"><summary><span class="tool-badge">工具</span>本回合工具</summary></details>
      <article class="plan-card"><header><strong>实施方案</strong><span>PLAN</span></header><div class="plan-step">步骤</div></article>
      <article class="approval-card"><div class="approval-head"><i class="approval-symbol">!</i><h3>需要确认</h3></div></article>
      <fieldset class="question-block"><legend><span>问题</span>请选择</legend><label class="question-option"><input type="radio"><span><strong>选项</strong></span></label></fieldset>
      <article class="artifact-card"><strong>需求文档.md</strong><button>预览</button></article>
      <button class="project-button"><i>↯</i><span><strong>目录</strong><small>文件夹</small></span></button>
      <button class="directory-entry"><i>↯</i><span><strong>目录</strong><small>文件夹</small></span></button>
      <article class="dingtalk-message"><div class="dingtalk-message-body">钉钉消息</div></article>
      <button class="skill-item"><strong>已安装技能</strong><small>技能简介</small></button>
      <article class="skill-market-item"><div class="skill-market-main"><strong>热门技能</strong><small>技能简介</small></div><button>安装</button></article>
      <section class="turn-artifacts"><strong>本次产出</strong></section>
      <p class="file-share-status">文件准备状态</p>
      <div class="toast">操作已完成</div>
      <input class="artifact-search" value="搜索内容">
      <input class="question-freeform" value="补充说明">
    `;
    document.body.append(fixture);
  });

  const dialogIds = [
    'settingsSheet',
    'skillSheet',
    'skillInstallDialog',
    'threadActionDialog',
    'threadRenameDialog',
    'dingtalkTodoDialog',
    'projectCreateDialog',
    'projectDeleteDialog',
    'previewDialog',
    'fileShareDialog',
  ];

  const inspectTheme = async (theme) => {
    await page.evaluate((nextTheme) => {
      document.documentElement.dataset.theme = nextTheme;
    }, theme);
    await page.waitForTimeout(180);
    return page.evaluate(({ ids, theme: currentTheme }) => {
      const root = getComputedStyle(document.documentElement);
      const tokens = Object.fromEntries([
        '--bg', '--panel', '--panel-2', '--surface-inset', '--line', '--text', '--accent', '--danger-soft',
      ].map((name) => [name, root.getPropertyValue(name).trim()]));
      const style = (selector) => {
        const computed = getComputedStyle(document.querySelector(selector));
        return {
          background: computed.backgroundColor,
          border: computed.borderColor,
          color: computed.color,
          radius: computed.borderRadius,
          fontSize: computed.fontSize,
        };
      };
      const dialogs = ids.map((id) => {
        const dialog = document.querySelector(`#${id}`);
        dialog.showModal();
        const computed = getComputedStyle(dialog);
        const header = dialog.querySelector('header');
        const close = dialog.querySelector('.icon-button');
        const result = {
          id,
          background: computed.backgroundColor,
          border: computed.borderColor,
          color: computed.color,
          radius: computed.borderRadius,
          backdrop: getComputedStyle(dialog, '::backdrop').backgroundColor,
          headerHeight: header ? Math.round(header.getBoundingClientRect().height) : 0,
          closeWidth: close ? Math.round(close.getBoundingClientRect().width) : 0,
          closeBackground: close ? getComputedStyle(close).backgroundColor : '',
        };
        dialog.close();
        return result;
      });
      return {
        theme: currentTheme,
        tokens,
        body: style('body'),
        controls: {
          secondary: style('#visualCoverageFixture .button'),
          primary: style('#visualCoverageFixture .button.primary'),
          danger: style('#visualCoverageFixture .button.danger'),
          icon: style('#visualCoverageFixture .icon-button'),
          send: style('#visualCoverageFixture .send-button'),
          stop: style('#visualCoverageFixture .stop-button'),
          search: style('#visualCoverageFixture .artifact-search'),
          input: style('#visualCoverageFixture .question-freeform'),
        },
        cards: Object.fromEntries([
          '.bubble', '.message > .agent-card', '.tool-card', '.turn-tools', '.plan-card', '.approval-card',
          '.question-block', '.artifact-card', '.project-button', '.directory-entry', '.dingtalk-message',
          '.skill-item', '.skill-market-item', '.turn-artifacts', '.file-share-status', '.toast',
        ].map((selector) => [selector, style(`#visualCoverageFixture ${selector}`)])),
        dialogs,
        overflow: document.documentElement.scrollWidth - innerWidth,
      };
    }, { ids: dialogIds, theme });
  };

  const dark = await inspectTheme('dark');
  const light = await inspectTheme('light');

  const expected = {
    dark: {
      background: 'rgb(11, 13, 16)', panel: 'rgb(18, 23, 28)', panel2: 'rgb(25, 32, 40)',
      inset: 'rgb(9, 12, 15)', line: 'rgb(44, 52, 61)', text: 'rgb(237, 242, 246)', accent: 'rgb(184, 239, 85)',
    },
    light: {
      background: 'rgb(243, 245, 247)', panel: 'rgb(255, 255, 255)', panel2: 'rgb(237, 241, 244)',
      inset: 'rgb(247, 249, 250)', line: 'rgb(215, 221, 227)', text: 'rgb(24, 35, 46)', accent: 'rgb(79, 115, 25)',
    },
  };
  for (const result of [dark, light]) {
    const palette = expected[result.theme];
    if (result.body.background !== palette.background || result.body.color !== palette.text) {
      throw new Error(`${result.theme} 页面令牌未生效：${JSON.stringify(result.body)}`);
    }
    if (result.controls.secondary.background !== palette.panel2
      || result.controls.primary.background !== palette.accent
      || result.controls.icon.background !== palette.panel
      || result.controls.search.background !== palette.inset
      || result.controls.input.background !== palette.inset) {
      throw new Error(`${result.theme} 控件视觉不一致：${JSON.stringify(result.controls)}`);
    }
    if (result.controls.danger.background === 'rgba(0, 0, 0, 0)' || result.controls.stop.background === 'rgba(0, 0, 0, 0)') {
      throw new Error(`${result.theme} 危险操作缺少语义底色：${JSON.stringify(result.controls)}`);
    }
    for (const [selector, card] of Object.entries(result.cards)) {
      if (card.background === 'rgba(0, 0, 0, 0)' && !['.skill-item', '.skill-market-item'].includes(selector)) {
        throw new Error(`${result.theme} 卡片 ${selector} 缺少表面色：${JSON.stringify(card)}`);
      }
      if ((!card.radius || card.radius === '0px') && !['.skill-item', '.skill-market-item'].includes(selector)) {
        throw new Error(`${result.theme} 卡片 ${selector} 缺少统一圆角：${JSON.stringify(card)}`);
      }
    }
    for (const dialog of result.dialogs) {
      if (dialog.background !== palette.panel || dialog.border !== palette.line || dialog.backdrop === 'rgba(0, 0, 0, 0)') {
        throw new Error(`${result.theme} 弹窗 ${dialog.id} 未使用统一表面：${JSON.stringify(dialog)}`);
      }
      if (!dialog.radius || dialog.radius === '0px' || dialog.headerHeight > 50 || dialog.closeWidth > 36) {
        throw new Error(`${result.theme} 弹窗 ${dialog.id} 尺寸不统一：${JSON.stringify(dialog)}`);
      }
    }
    if (result.overflow > 0) throw new Error(`${result.theme} 页面出现横向溢出：${result.overflow}px`);
  }

  process.stdout.write(`${JSON.stringify({
    themes: [dark.theme, light.theme],
    dialogCount: dark.dialogs.length,
    cardCount: Object.keys(dark.cards).length,
    controlCount: Object.keys(dark.controls).length,
    darkOverflow: dark.overflow,
    lightOverflow: light.overflow,
  })}\n`);
} finally {
  await browser.close();
}
