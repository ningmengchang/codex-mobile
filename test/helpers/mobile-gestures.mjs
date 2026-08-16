export async function swipeElement(page, selector, direction) {
  const locator = page.locator(selector);
  await locator.waitFor({ state: 'visible' });
  const rect = await locator.boundingBox();
  if (!rect) throw new Error(`找不到手势目标：${selector}`);
  const rightward = direction === 'right';
  const startX = rightward ? rect.x + rect.width * .18 : rect.x + rect.width * .82;
  const endX = rightward ? rect.x + rect.width * .68 : rect.x + rect.width * .32;
  const y = rect.y + rect.height * .48;
  const cdp = await page.context().newCDPSession(page);
  const point = (x) => ({ x, y, radiusX: 3, radiusY: 3, force: 1 });
  let midTransform = '';
  try {
    await cdp.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [point(startX)] });
    await page.waitForTimeout(25);
    await cdp.send('Input.dispatchTouchEvent', { type: 'touchMove', touchPoints: [point(startX + (endX - startX) * .35)] });
    await page.waitForTimeout(25);
    await cdp.send('Input.dispatchTouchEvent', { type: 'touchMove', touchPoints: [point(startX + (endX - startX) * .7)] });
    await page.waitForTimeout(25);
    await cdp.send('Input.dispatchTouchEvent', { type: 'touchMove', touchPoints: [point(endX)] });
    await page.waitForTimeout(25);
    midTransform = await locator.evaluate((element) => element.style.transform);
    await cdp.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
  } finally {
    await cdp.detach();
  }
  await page.waitForTimeout(220);
  return { midTransform };
}

export const swipeRight = (page, selector) => swipeElement(page, selector, 'right');
export const swipeLeft = (page, selector) => swipeElement(page, selector, 'left');
