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
  projects: { current: { name: 'home', path: '/home/ningmengchang' }, parent: null, entries: [] },
};
let installed = false;
const discover = [
  { name: 'ppt-master', installed: true, description: '生成 PPT', repo: 'demo/ppt-master', path: 'skills/ppt-master', stars: 1200, score: 90 },
  { name: 'new-skill', installed: false, description: '新技能描述', repo: 'demo/new-skill', path: 'skills/new-skill', stars: 88, score: 76 },
];
const official = [
  { name: 'official-skill', installed: false, description: '官方技能', repo: 'openai/skills', path: 'skills/.curated/official-skill' },
];

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
  let installRequested = null;
  await page.route('**/*', async (route) => {
    const pathname = new URL(route.request().url()).pathname;
    const fulfillJson = (body, status = 200) => route.fulfill({
      status, contentType: 'application/json; charset=utf-8', body: JSON.stringify(body),
    });
    if (pathname === '/api/auth/status') return fulfillJson({ authenticated: true });
    if (pathname === '/api/bootstrap') return fulfillJson(bootstrap);
    if (pathname === '/api/requests') return fulfillJson({ data: [] });
    if (pathname === '/api/projects') return fulfillJson(bootstrap.projects);
    if (pathname === '/api/threads' && route.request().method() === 'GET') return fulfillJson({ data: [] });
    if (pathname === '/api/skills') return fulfillJson({ data: [{ name: 'ppt-master', description: '生成 PPT' }] });
    if (pathname === '/api/skills/market') {
      const query = new URL(route.request().url()).searchParams.get('search') ?? '';
      let data = discover.map((item) => item.name === 'new-skill' ? { ...item, installed } : item);
      if (query) {
        data = data.filter((item) => item.name.includes(query) || item.repo.includes(query));
      }
      return fulfillJson({ data });
    }
    if (pathname === '/api/skills/market/official') return fulfillJson({ data: official });
    if (pathname === '/api/skills/market/install' && route.request().method() === 'POST') {
      installRequested = JSON.parse(route.request().postData());
      installed = true;
      return fulfillJson({ installed: true });
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

  await page.goto('http://127.0.0.1:39906/', { waitUntil: 'domcontentloaded' });
  await page.locator('#app:not([hidden])').waitFor({ timeout: 15_000 });
  await page.locator('#skillButton').click();
  await page.locator('#skillSheet[open]').waitFor({ timeout: 5_000 });
  await page.locator('#skillTabs button[data-skill-tab="installed"]').waitFor({ timeout: 5_000 });
  await page.locator('#skillList .skill-item', { hasText: 'ppt-master' }).waitFor({ timeout: 5_000 });

  await page.locator('#skillTabs button[data-skill-tab="discover"]').click();
  await page.locator('#skillDiscoverList .skill-market-item', { hasText: 'new-skill' }).waitFor({ timeout: 10_000 });
  await page.locator('#skillDiscoverList .skill-market-item', { hasText: 'ppt-master' }).waitFor({ timeout: 5_000 });
  const installedMark = await page.locator('#skillDiscoverList .skill-installed').textContent();
  if (!installedMark.includes('已安装')) throw new Error(`已安装标记异常：${installedMark}`);

  const discoverText = await page.locator('#skillDiscoverList').textContent();
  if (!discoverText.includes('⭐ 88') || !discoverText.includes('demo/new-skill')) {
    throw new Error(`热门信息展示异常：${discoverText}`);
  }

  await page.locator('#skillMarketSearchInput').fill('new');
  await page.waitForFunction(() => {
    const text = document.querySelector('#skillDiscoverList')?.textContent ?? '';
    return text.includes('new-skill') && !text.includes('ppt-master');
  }, null, { timeout: 5_000 });

  const newSkillCard = page.locator('#skillDiscoverList .skill-market-item', { hasText: 'new-skill' });
  await newSkillCard.locator('button[data-install]').click();
  await page.locator('#skillInstallDialog[open]').waitFor({ timeout: 5_000 });
  const installName = await page.locator('#skillInstallName').textContent();
  if (!installName.includes('new-skill')) throw new Error(`安装弹窗名称异常：${installName}`);
  const installRepo = await page.locator('#skillInstallRepo').textContent();
  if (!installRepo.includes('demo/new-skill') || !installRepo.includes('skills/new-skill')) {
    throw new Error(`安装弹窗仓库/路径异常：${installRepo}`);
  }
  await page.locator('#confirmSkillInstallButton').click();
  await page.waitForFunction(() => !document.querySelector('#skillInstallDialog')?.hasAttribute('open'), null, { timeout: 5_000 });
  if (!installRequested) throw new Error('安装请求未发出');
  if (installRequested.repo !== 'demo/new-skill' || installRequested.path !== 'skills/new-skill' || installRequested.name !== 'new-skill') {
    throw new Error(`安装请求参数异常：${JSON.stringify(installRequested)}`);
  }
  await page.waitForFunction(() => document.querySelector('#skillDiscoverList')?.textContent?.includes('已安装'), null, { timeout: 5_000 });
  const afterInstall = await page.locator('#skillDiscoverList').textContent();
  if (!afterInstall.includes('new-skill') || !afterInstall.includes('已安装')) {
    throw new Error(`安装后市场状态未刷新：${afterInstall}`);
  }

  await page.locator('#skillTabs button[data-skill-tab="official"]').click();
  await page.locator('#skillOfficialList .skill-market-item', { hasText: 'official-skill' }).waitFor({ timeout: 5_000 });
  const officialText = await page.locator('#skillOfficialList').textContent();
  if (!officialText.includes('official-skill') || !officialText.includes('openai/skills')) {
    throw new Error(`官方页签展示异常：${officialText}`);
  }

  process.stdout.write(`${JSON.stringify({ tabs: true, discover: true, search: true, install: true, official: true })}\n`);
} finally {
  await browser.close();
}
