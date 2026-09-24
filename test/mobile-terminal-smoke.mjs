import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { EventEmitter } from 'node:events';
import { createRequire } from 'node:module';
import { createCodexMobileServer } from '../server/index.mjs';
import { signClaims } from '../server/security.mjs';

const require = createRequire(import.meta.url);
const { chromium } = require(process.env.PLAYWRIGHT_PATH ?? '/home/ningmengchang/ideaProjects/dpp-cloud-saic/dpp-platform-web/node_modules/playwright');
const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'codex-terminal-browser-'));
class Bridge extends EventEmitter {
  status() { return { ready: true }; }
  getServerRequests() { return []; }
  async request(method, params) {
    if (method === 'thread/read') return { thread: { id: params.threadId, cwd: directory, turns: [] } };
    return { data: [] };
  }
}
const app = createCodexMobileServer({ bridge: new Bridge(), configOverrides: {
  allowedRoots: [directory], dataDir: path.join(directory, 'data'), cacheDir: path.join(directory, 'cache'),
  codexHome: directory, codexBin: '/bin/true', disableAppServer: true, skillsRoots: [],
} });
await new Promise(resolve => app.server.listen(0, '127.0.0.1', resolve));
const base = `http://127.0.0.1:${app.server.address().port}`;
const cookie = signClaims({ kind: 'session', sid: 'browser-owner', exp: Math.floor(Date.now() / 1000) + 600 }, app.config.secret);
const browser = await chromium.launch({ headless: true });
try {
  // Real gateway security checks, never using the user's running service.
  const url = `${base}/api/terminals`;
  const payload = { threadId: 'terminal-thread', backend: 'gpt', acknowledged: true };
  assert.equal((await fetch(url, { method: 'POST', body: JSON.stringify(payload) })).status, 401);
  assert.equal((await fetch(url, { method: 'POST', headers: { Cookie: `codex_mobile_session=${cookie}`, Origin: 'https://evil.test' }, body: JSON.stringify(payload) })).status, 403);
  assert.equal((await fetch(url, { method: 'POST', headers: { Cookie: `codex_mobile_session=${cookie}`, Origin: base }, body: JSON.stringify({ ...payload, acknowledged: false }) })).status, 400);

  const context = await browser.newContext({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true,
    userAgent: 'Mozilla/5.0 (Linux; Android 14) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Mobile Safari/537.36',
  });
  await context.addCookies([{ name: 'codex_mobile_session', value: cookie, url: base }]);
  await context.addInitScript(() => {
    HTMLElement.prototype.requestFullscreen = async () => {};
    window.EventSource = class { constructor() { setTimeout(() => this.onopen?.(), 10); } addEventListener() {} close() {} };
  });
  const page = await context.newPage();
  page.setDefaultTimeout(12_000);
  const errors = [];
  const inputWrites = [];
  let workflowRequests = 0, failNextConnect = true, createRequests = 0, createDelay = 0;
  page.on('pageerror', error => errors.push(error.message));
  const thread = { id: 'terminal-thread', cwd: directory, name: '终端测试', turns: [], status: 'idle', updatedAt: 1 };
  await page.route('**/api/**', async route => {
    const pathname = new URL(route.request().url()).pathname;
    const json = body => route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(body) });
    if (pathname.startsWith('/api/terminal/workflows')) workflowRequests++;
    if (/\/api\/terminals\/[^/]+\/input$/.test(pathname)) inputWrites.push(JSON.parse(route.request().postData()));
    if (pathname === '/api/terminals' && route.request().method() === 'POST') {
      createRequests++;
      if (createDelay) await new Promise(resolve => setTimeout(resolve, createDelay));
      if (failNextConnect) {
        failNextConnect = false;
        return route.fulfill({ status: 503, contentType: 'application/json', body: JSON.stringify({ message: '测试连接失败', error: 'UNAVAILABLE' }) });
      }
    }
    if (pathname.startsWith('/api/terminal')) return route.continue();
    if (pathname === '/api/auth/status') return json({ authenticated: true });
    if (pathname === '/api/bootstrap') return json({ appServer: { ready: true }, runtime: { user: 'test' }, models: [], collaborationModes: [], pendingRequests: [], projects: { current: { name: 'test', path: directory }, parent: null, root: directory, entries: [] } });
    if (pathname === '/api/threads') return json({ data: [thread] });
    if (pathname.endsWith('/turns')) return json({ data: [], nextCursor: null });
    if (pathname === '/api/threads/terminal-thread') return json({ thread });
    if (pathname === '/api/projects') return json({ current: { name: 'test', path: directory }, parent: null, root: directory, entries: [] });
    return json({ data: [], pendingRequests: [] });
  });
  await page.goto(base);
  await page.waitForSelector('#app:not([hidden])');
  await page.evaluate(async thread => {
    const { state } = await import('/js/state.js');
    state.currentThread = thread;
    document.querySelector('#chatDetailHeader').hidden = false;
    document.querySelector('#chatView').classList.add('active');
    for (const view of document.querySelectorAll('.view:not(#chatView)')) view.classList.remove('active');
  }, thread);
  await page.locator('#chatTerminalButton').click();
  // First-use consent is automatic and cancelable; there is no connection landing screen.
  await page.locator('#terminalConfirm button[value="cancel"]').click();
  await page.waitForSelector('#terminalDialog[data-state="idle"]');
  assert.equal(createRequests, 0);
  await page.locator('#terminalConnect').click();
  await page.locator('#terminalConfirmOk').click();
  await page.waitForSelector('#terminalDialog[data-state="error"]');
  assert.match(await page.locator('#terminalNoticeText').innerText(), /测试连接失败/);
  await page.locator('#terminalConnect').click();
  await page.waitForSelector('#terminalScreen .xterm');
  await page.waitForFunction(() => document.querySelector('#terminalStatus').textContent.startsWith('已连接'), null, { timeout: 5000 }).catch(async error => {
    console.error('terminal diagnostics', await page.locator('#terminalStatus').textContent(), errors);
    throw error;
  });
  assert.equal(await page.locator('#terminalConfirm').evaluate(el => el.open), false);
  assert.equal(await page.locator('#terminalCommand, #terminalRun, #terminalTools, #terminalParameters, #terminalSave').count(), 0);
  assert.equal(await page.locator('#terminalKeys').isHidden(), true);
  assert.equal(workflowRequests, 0, '打开终端不应读取旧收藏');
  await page.locator('#terminalKeyboard').click();
  await page.waitForFunction(() => document.activeElement?.classList.contains('xterm-helper-textarea'));
  await page.keyboard.type("printf 'MOBILE_%s\\n' OK");
  await page.keyboard.press('Enter');
  await page.waitForFunction(() => document.querySelector('#terminalScreen').textContent.includes('MOBILE_OK'));

  // Exercise xterm's real input/composition path, not a separate command textbox.
  await page.keyboard.type("printf '");
  const cdp = await context.newCDPSession(page);
  await page.evaluate(() => {
    window.imeEvents = [];
    const textarea = document.querySelector('.xterm-helper-textarea');
    for (const type of ['compositionstart', 'compositionupdate', 'compositionend', 'input']) {
      textarea.addEventListener(type, event => window.imeEvents.push({ type, data: event.data, value: textarea.value }));
    }
  });
  await cdp.send('Input.dispatchKeyEvent', { type: 'keyDown', key: 'Unidentified', windowsVirtualKeyCode: 229, nativeVirtualKeyCode: 229 });
  await cdp.send('Input.imeSetComposition', { text: '中', selectionStart: 1, selectionEnd: 1 });
  await cdp.send('Input.imeSetComposition', { text: '中文', selectionStart: 2, selectionEnd: 2 });
  await cdp.send('Input.insertText', { text: '中文' });
  await cdp.send('Input.dispatchKeyEvent', { type: 'keyUp', key: 'Unidentified', windowsVirtualKeyCode: 229, nativeVirtualKeyCode: 229 });
  await page.waitForFunction(() => document.querySelector('#terminalScreen .xterm-rows').textContent.includes('中文'), null, { timeout: 4000 }).catch(async error => {
    console.error('IME commit diagnostics', inputWrites.map(item => item.data).join(''), await page.evaluate(() => window.imeEvents));
    throw error;
  });
  await page.keyboard.type("%s\\n' ");
  await page.keyboard.insertText('测试');
  await page.keyboard.press('Enter');
  await page.waitForFunction(() => document.querySelector('#terminalScreen').textContent.includes('中文测试')).catch(async error => {
    console.error('IME diagnostics', inputWrites.map(item => item.data).join(''), await page.locator('#terminalScreen').innerText(), await page.evaluate(() => window.imeEvents));
    throw error;
  });
  assert.equal(inputWrites.map(item => item.data).join('').match(/中文/g)?.length, 1, '输入法提交不能重复发送');

  await page.keyboard.type('echo DELETE_X');
  await page.keyboard.press('Backspace');
  await page.keyboard.type('K');
  await page.keyboard.press('Enter');
  await page.waitForFunction(() => document.querySelector('#terminalScreen').textContent.includes('DELETE_K'));
  await page.evaluate(() => {
    const data = new DataTransfer(); data.setData('text/plain', "printf 'PASTE_%s\\n' OK");
    document.querySelector('.xterm-helper-textarea').dispatchEvent(new ClipboardEvent('paste', { clipboardData: data, bubbles: true, cancelable: true }));
  });
  await page.keyboard.press('Enter');
  await page.waitForFunction(() => document.querySelector('#terminalScreen').textContent.includes('PASTE_OK'));

  async function menuAction(id) {
    await page.locator('#terminalMenu > summary').click();
    await page.locator(id).click();
  }
  await menuAction('#terminalToggleKeys');
  assert.equal(await page.locator('#terminalKeys').isVisible(), true);
  await page.locator('[aria-label="上一条命令"]').click();
  await page.locator('#terminalKeys button').filter({ hasText: /^Enter$/ }).click();
  await page.waitForFunction(() => (document.querySelector('#terminalScreen').textContent.match(/PASTE_OK/g) || []).length >= 2);
  await page.keyboard.type('sleep 10'); await page.keyboard.press('Enter');
  await page.locator('#terminalKeys button').filter({ hasText: 'Ctrl+C' }).click();
  await page.keyboard.type("printf 'INTERRUPT_%s\\n' OK"); await page.keyboard.press('Enter');
  await page.waitForFunction(() => document.querySelector('#terminalScreen').textContent.includes('INTERRUPT_OK'));
  await menuAction('#terminalToggleKeys');
  await menuAction('#terminalAi');
  assert.ok((await page.locator('#terminalAiText').inputValue()).includes('MOBILE_OK'));
  await page.locator('#terminalAiDraft').click();
  assert.ok((await page.locator('#promptInput').inputValue()).includes('MOBILE_OK'));
  assert.equal(await page.locator('#terminalDialog').evaluate(el => el.open), false);
  // Reopen without losing the running shell; viewport resize stands in for rotation and IME.
  await page.locator('#chatTerminalButton').click();
  await page.waitForSelector('#terminalDialog[data-state="ready"]');
  await page.waitForFunction(() => document.querySelector('#terminalScreen').textContent.includes('MOBILE_OK'));
  assert.equal(await page.locator('#terminalConfirm').evaluate(el => el.open), false, '恢复终端不再重复确认');
  // Rapidly leaving while reconnect is in flight must not attach an obsolete response.
  await page.locator('#terminalClose').click();
  createDelay = 200;
  const beforeReopen = createRequests;
  await Promise.all([
    page.waitForRequest(request => request.url() === base + '/api/terminals' && request.method() === 'POST'),
    page.locator('#chatTerminalButton').click(),
  ]);
  await page.locator('#terminalClose').click();
  await page.locator('#chatTerminalButton').click();
  await page.waitForSelector('#terminalDialog[data-state="ready"]');
  assert.ok(createRequests >= beforeReopen + 2);
  assert.ok((await page.locator('#terminalScreen').innerText()).includes('MOBILE_OK'));
  createDelay = 0;
  // Touch scrolling must work on the terminal text, not just its narrow scrollbar.
  await page.locator('#terminalKeyboard').click();
  await page.keyboard.type("printf 'SCROLL_%04d\\n' {1..360}; (sleep 3; printf 'ASYNC_%s\\n' SCROLL_DONE) &");
  await page.keyboard.press('Enter');
  await page.waitForFunction(() => document.querySelector('#terminalScreen').textContent.includes('SCROLL_0360'));
  const firstVisibleLine = () => page.locator('#terminalScreen .xterm-rows').evaluate(el =>
    Number(el.textContent.match(/SCROLL_(\d+)/)?.[1] ?? -1));
  async function verticalDrag(direction) {
    const box = await page.locator('#terminalScreen').boundingBox();
    const start = box.y + box.height * (direction === 'down' ? .3 : .75);
    const distance = box.height * (direction === 'down' ? .45 : -.45);
    const point = y => ({ x: box.x + box.width * .55, y, radiusX: 3, radiusY: 3, force: 1 });
    await cdp.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [point(start)] });
    for (let step = 1; step <= 8; step++) {
      await cdp.send('Input.dispatchTouchEvent', { type: 'touchMove', touchPoints: [point(start + distance * step / 8)] });
      await page.waitForTimeout(25);
    }
    await cdp.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
    await page.waitForTimeout(180);
  }
  const bottomLine = await firstVisibleLine();
  const inputsBeforeDrag = inputWrites.length;
  await page.locator('.xterm-helper-textarea').evaluate(el => el.blur());
  await verticalDrag('down');
  const olderLine = await firstVisibleLine();
  assert.ok(olderLine > 0 && olderLine < bottomLine - 8, `向下拖动应查看更早输出：${bottomLine} -> ${olderLine}`);
  await verticalDrag('up');
  const newerLine = await firstVisibleLine();
  assert.ok(newerLine > olderLine + 8, `向上拖动应查看更新输出：${olderLine} -> ${newerLine}`);
  assert.equal(inputWrites.length, inputsBeforeDrag, '滚动不能发送终端按键');
  assert.equal(await page.locator('#terminalDialog').evaluate(el => el.open), true);
  assert.equal(await page.evaluate(() => document.documentElement.scrollTop), 0);
  assert.equal(await page.evaluate(() => document.activeElement?.classList.contains('xterm-helper-textarea')), false, '滑动不能误唤起键盘');
  await verticalDrag('down');
  await verticalDrag('down');
  const heldLine = await firstVisibleLine();
  assert.ok(heldLine < olderLine, '允许连续拖动查看更早记录');
  await page.waitForTimeout(3500);
  const retained = await app.terminals.create({ owner: 'browser-owner', backend: 'gpt', threadId: 'terminal-thread', cwd: directory, acknowledged: true });
  assert.ok(Buffer.from(app.terminals.read(retained.id, 'browser-owner', 'gpt').data, 'base64').toString().includes('ASYNC_SCROLL_DONE'));
  assert.equal(await firstVisibleLine(), heldLine, '查看历史时，新输出不能强行拉回底部');
  console.log('touch scroll', { bottomLine, olderLine, newerLine, heldLine, inputUnchanged: inputWrites.length === inputsBeforeDrag });

  // Exercise boundary/cancellation and alternate-screen behavior without invoking shell input.
  const gestures = await page.evaluate(async () => {
    const { bindTerminalTouchScroll } = await import('/js/terminal.js?v=3');
    const host = document.createElement('div');
    const rows = document.createElement('div'); rows.className = 'xterm-rows';
    rows.getBoundingClientRect = () => ({ height: 240 }); host.append(rows);
    let active = true, wheelCount = 0, clicks = 0;
    const normal = { type: 'normal', viewportY: 50, baseY: 100 };
    const term = { buffer: { active: normal }, rows: 24, options: { fontSize: 10 }, modes: { mouseTrackingMode: 'none' },
      element: host, scrollToLine(line) { this.buffer.active.viewportY = line; } };
    host.addEventListener('wheel', () => wheelCount++);
    const binding = bindTerminalTouchScroll(host, () => term, () => active);
    host.addEventListener('click', () => clicks++);
    const touch = (x, y, id = 1) => new Touch({ identifier: id, target: host, clientX: x, clientY: y });
    const fire = (type, points) => host.dispatchEvent(new TouchEvent(type, { touches: points, changedTouches: points, bubbles: true, cancelable: true }));
    const drag = (dx, dy) => { fire('touchstart', [touch(0, 0)]); fire('touchmove', [touch(dx, dy)]); fire('touchend', []); };
    drag(0, 1000); const top = normal.viewportY;
    drag(0, -2000); const bottom = normal.viewportY;
    drag(80, 5); const horizontal = normal.viewportY;
    fire('touchstart', [touch(0, 0)]); fire('touchmove', [touch(0, 80), touch(10, 80, 2)]); fire('touchend', []);
    const multiple = normal.viewportY;
    fire('touchstart', [touch(0, 0)]); active = false; fire('touchmove', [touch(0, 80)]); active = true;
    const inactive = normal.viewportY;
    fire('touchstart', [touch(0, 0)]); fire('touchcancel', []); fire('touchmove', [touch(0, 80)]);
    const cancelled = normal.viewportY;
    drag(0, 80); host.click(); const clickAfterDrag = clicks;
    fire('touchstart', [touch(0, 0)]); fire('touchend', []); host.click(); const freshTap = clicks;
    term.buffer.active = { type: 'alternate', viewportY: 0, baseY: 0 };
    drag(0, 80); const alternateWithoutMouse = wheelCount;
    term.modes.mouseTrackingMode = 'vt200'; drag(0, 80); const alternateWithMouse = wheelCount;
    binding.dispose(); const before = wheelCount; drag(0, 80);
    return { top, bottom, horizontal, multiple, inactive, cancelled, clickAfterDrag, freshTap, alternateWithoutMouse, alternateWithMouse, disposed: before === wheelCount };
  });
  assert.deepEqual(gestures, { top: 0, bottom: 100, horizontal: 100, multiple: 100, inactive: 100, cancelled: 100,
    clickAfterDrag: 0, freshTap: 1, alternateWithoutMouse: 0, alternateWithMouse: 1, disposed: true });
  for (const viewport of [{ width: 844, height: 390 }, { width: 390, height: 400 }, { width: 390, height: 844 }]) {
    await page.setViewportSize(viewport); await page.waitForTimeout(250);
    const box = await page.locator('#terminalDialog').boundingBox();
    const screen = await page.locator('#terminalScreen').boundingBox();
    assert.ok(Math.abs(box.width - viewport.width) < 2 && Math.abs(box.x) < 1);
    assert.ok(Math.abs(box.height - viewport.height) < 2 && Math.abs(box.y) < 1);
    assert.ok(screen.y + screen.height <= viewport.height, '终端底部不可被视口遮挡');
    assert.ok(screen.height >= viewport.height - 64, '终端应占据除紧凑头部外的空间');
    assert.ok(await page.locator('#terminalKeyboard').isVisible());
    const before = await firstVisibleLine();
    await verticalDrag('down');
    const after = await firstVisibleLine();
    assert.ok(after < before, `横屏和键盘缩小视口时仍可拖动：${JSON.stringify(viewport)} ${before} -> ${after}`);
  }
  await page.screenshot({ path: '/tmp/codex-terminal-simple-dark.png' });
  await page.locator('#terminalClose').click();
  await page.evaluate(() => { document.documentElement.dataset.theme = 'light'; });
  await page.locator('#chatTerminalButton').click();
  await page.waitForSelector('#terminalDialog[data-state="ready"]');
  await page.screenshot({ path: '/tmp/codex-terminal-simple-light.png' });
  await menuAction('#terminalEnd');
  await page.locator('#terminalConfirm button[value="cancel"]').click();
  assert.equal(await page.locator('#terminalDialog').getAttribute('data-state'), 'ready');
  await menuAction('#terminalEnd'); await page.locator('#terminalConfirmOk').click();
  await page.waitForSelector('#terminalDialog[data-state="ended"]');
  // Android back bridge closes the topmost HTML dialog using dialog.close().
  await page.evaluate(() => [...document.querySelectorAll('dialog[open]')].at(-1).close());
  assert.equal(await page.locator('#terminalDialog').evaluate(el => el.open), false);
  // Consent persists across a real page reload, not just within the JS module.
  await page.reload();
  await page.waitForSelector('#app:not([hidden])');
  await page.evaluate(async thread => {
    const { state } = await import('/js/state.js');
    state.currentThread = thread;
    document.querySelector('#chatDetailHeader').hidden = false;
    document.querySelector('#chatView').classList.add('active');
    for (const view of document.querySelectorAll('.view:not(#chatView)')) view.classList.remove('active');
  }, thread);
  await page.locator('#chatTerminalButton').click();
  await page.waitForSelector('#terminalDialog[data-state="ready"]');
  assert.equal(await page.locator('#terminalConfirm').evaluate(el => el.open), false);
  await page.locator('#terminalClose').click();
  assert.deepEqual(errors, []);
  console.log('PASS: real PTY, authentication/CSRF, one-time consent, retry, direct typing/IME/paste/backspace/history/Ctrl+C, touch scroll in both directions, historical viewport retention, gesture boundaries/cancel/alternate screen, rotation/keyboard, no workflow requests, AI draft, automatic reconnect, dark/light, dialog back');
} finally {
  await browser.close(); app.terminals.close(); app.hub.close();
  await new Promise(resolve => app.server.close(resolve));
  fs.rmSync(directory, { recursive: true, force: true });
}
