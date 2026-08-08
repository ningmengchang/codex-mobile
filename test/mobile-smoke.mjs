import readline from 'node:readline';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const playwrightPath = process.env.PLAYWRIGHT_PATH
  ?? '/home/ningmengchang/ideaProjects/dpp-cloud-saic/dpp-platform-web/node_modules/playwright';
const { chromium } = require(playwrightPath);
const input = readline.createInterface({ input: process.stdin, terminal: false });

const code = await new Promise((resolve) => input.once('line', resolve));
input.close();
if (!/^\d{8}$/.test(code)) throw new Error('需要从标准输入提供 8 位测试配对码。');

const browser = await chromium.launch({ headless: true });
try {
  const page = await browser.newPage({
    viewport: { width: 390, height: 844 },
    deviceScaleFactor: 2,
    isMobile: true,
    hasTouch: true,
  });
  await page.goto(process.env.CODEX_MOBILE_TEST_URL ?? 'http://127.0.0.1:39765', { waitUntil: 'domcontentloaded' });
  await page.locator('#pairCode').fill(code);
  await page.getByRole('button', { name: '连接这台电脑' }).click();
  await page.locator('#app:not([hidden])').waitFor({ timeout: 30_000 });
  await page.locator('#currentProjectName').waitFor();
  await page.waitForTimeout(800);
  const result = await page.evaluate(() => ({
    width: innerWidth,
    scrollWidth: document.documentElement.scrollWidth,
    status: document.querySelector('#connectionStatus span')?.textContent,
    project: document.querySelector('#currentProjectName')?.textContent,
    navigation: [...document.querySelectorAll('.bottom-nav button')].map((element) => element.textContent.trim()),
    modes: [...document.querySelectorAll('#modeSwitch button')].map((element) => element.textContent.trim()),
    reviewer: document.querySelector('#approvalReviewerSelect')?.value,
  }));
  await page.locator('#modeSwitch button[data-mode="plan"]').click();
  result.planNotice = await page.locator('#modeNotice').textContent();
  await page.screenshot({ path: process.env.CODEX_MOBILE_SCREENSHOT ?? '/tmp/codex-mobile-390.png', fullPage: true });
  await page.locator('button[data-tab="projects"]').click();
  await page.locator('#projectList .project-button').first().waitFor();
  result.projects = await page.locator('#projectList .project-button').count();
  if (result.modes.join(',') !== '执行,规划') throw new Error(`模式控件异常：${result.modes.join(',')}`);
  if (result.reviewer !== 'auto_review') throw new Error(`默认审批方式异常：${result.reviewer}`);
  if (!result.planNotice.includes('只读')) throw new Error(`规划模式提示异常：${result.planNotice}`);
  if (result.scrollWidth > result.width) throw new Error(`手机页面横向溢出：${result.scrollWidth} > ${result.width}`);
  process.stdout.write(`${JSON.stringify(result)}\n`);
} finally {
  await browser.close();
}
