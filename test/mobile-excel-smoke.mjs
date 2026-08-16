import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const playwrightPath = process.env.PLAYWRIGHT_PATH
  ?? '/home/ningmengchang/ideaProjects/dpp-cloud-saic/dpp-platform-web/node_modules/playwright';
const { chromium } = require(playwrightPath);
const session = process.env.CODEX_MOBILE_SESSION;
if (!session) throw new Error('需要通过 CODEX_MOBILE_SESSION 提供测试会话值。');

const base = process.env.CODEX_MOBILE_TEST_URL ?? 'http://127.0.0.1:3765';
const project = process.env.CODEX_MOBILE_EXCEL_PROJECT
  ?? '/home/ningmengchang/Desktop/接口文档设计';
const artifactName = process.env.CODEX_MOBILE_EXCEL_NAME
  ?? '电池护照平台接口清单.xlsx';
const browser = await chromium.launch({ headless: true });
try {
  const context = await browser.newContext({
    viewport: { width: 390, height: 844 }, deviceScaleFactor: 2, isMobile: true, hasTouch: true,
  });
  await context.addCookies([{ name: 'codex_mobile_session', value: session, url: base }]);
  const page = await context.newPage();
  await page.addInitScript((projectPath) => localStorage.setItem('codex-mobile-project', projectPath), project);
  await page.goto(base, { waitUntil: 'domcontentloaded' });
  await page.locator('#app:not([hidden])').waitFor({ timeout: 30_000 });
  await page.locator('#mobileThreadList .thread-item').first().click();
  await page.locator('#chatThreadMoreButton').click();
  await page.locator('#threadArtifactsAction').click();
  await page.locator('#artifactList .artifact-card').first().waitFor({ timeout: 30_000 });
  const cards = page.locator('#artifactList .artifact-card');
  let selected = null;
  for (let index = 0; index < await cards.count(); index += 1) {
    const card = cards.nth(index);
    if (await card.locator('strong').textContent() === artifactName) {
      selected = card;
      break;
    }
  }
  if (!selected) throw new Error(`没有找到 Excel 产出物：${artifactName}`);
  await selected.getByRole('button', { name: '预览' }).click();
  await page.locator('.spreadsheet-table').waitFor({ timeout: 30_000 });
  const firstSheet = await page.locator('.spreadsheet-status').textContent();
  const sheetCount = await page.locator('.sheet-tabs button').count();
  const firstCells = await page.locator('.spreadsheet-table td').evaluateAll((cells) => cells.slice(0, 8).map((cell) => cell.textContent));
  if (sheetCount > 1) {
    await page.locator('.sheet-tabs button').nth(1).click();
    await page.locator('.spreadsheet-status').filter({ hasText: /^认证接口 ·/ }).waitFor();
  }
  const result = {
    width: await page.evaluate(() => innerWidth),
    scrollWidth: await page.evaluate(() => document.documentElement.scrollWidth),
    sheetCount,
    firstSheet,
    activeSheet: await page.locator('.spreadsheet-status').textContent(),
    firstCells,
    modeButtons: await page.locator('.preview-mode-bar button').allTextContents(),
  };
  await page.screenshot({
    path: process.env.CODEX_MOBILE_SCREENSHOT ?? '/tmp/codex-mobile-excel.png', fullPage: true,
  });
  if (result.scrollWidth > result.width) throw new Error(`手机页面横向溢出：${result.scrollWidth} > ${result.width}`);
  if (result.sheetCount !== 12) throw new Error(`工作表数量异常：${result.sheetCount}`);
  if (result.modeButtons.join(',') !== '表格,版式') throw new Error(`预览模式控件异常：${result.modeButtons.join(',')}`);
  process.stdout.write(`${JSON.stringify(result)}\n`);
} finally {
  await browser.close();
}
