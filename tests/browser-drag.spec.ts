import { expect, test, type Page } from '@playwright/test';
import map from '../maps/beta-v1.json' with { type: 'json' };
import { createPlayer, createWorld } from '../shared/engine';
import type { MapData } from '../shared/types';

test.use({ channel: process.env.PLAYWRIGHT_CHANNEL ?? undefined, viewport: { width: 1440, height: 960 } });

async function mount(page: Page, moving = false) {
  const now = Date.now(), city = map as MapData;
  const player = createPlayer('drag-test', '拖拽测试', now, city.portals[0]);
  player.tutorial={quick_start_seen_at:now};player.faction = 'blue'; player.ap = 240000;
  if (moving) player.movement = { from: { x: player.x, y: player.y }, to: { x: player.x + 30000, y: player.y }, startAt: now, arriveAt: now + 60000 };
  const state = { map: city, world: createWorld(city, now), player, serverTime: now, rulesetVersion: 'beta-v1', mapVersion: 'beta-v1', csrfToken: 'test', commandEpoch: 'test' };
  const requests: string[] = [], errors: string[] = [];
  page.on('pageerror', error => errors.push(error.message));
  page.on('console', message => { if (message.type() === 'error') errors.push(message.text()); });
  await page.routeWebSocket('**/api/events', () => {});
  await page.route('**/api/session', route => route.fulfill({ json: { player, csrfToken: 'test', commandEpoch: 'test' } }));
  await page.route('**/api/world/snapshot', route => route.fulfill({ json: state }));
  await page.route('**/api/po-applications/mine', route => route.fulfill({ json: { applications: [] } }));
  await page.route('**/api/social', route => route.fulfill({ json: { markers: [], alerts: [] } }));
  await page.route('**/api/moves{,/cancel}', route => { requests.push(route.request().url()); return route.abort(); });
  await page.goto(process.env.BASE_URL ?? 'http://127.0.0.1:5178/');
  await expect(page.locator('svg.world-map')).toBeVisible();
  await page.getByRole('button', { name: '关闭详情' }).click();
  await page.getByRole('button', { name: '定位', exact: true }).click();
  return { requests, errors };
}
async function blank(page: Page) {
  const box = (await page.locator('svg.world-map').boundingBox())!;
  return { x: box.x + box.width * .55, y: box.y + box.height * .65 };
}
async function drag(page: Page, point: { x: number; y: number }, dx: number, dy: number, button: 'left' | 'right' = 'left') {
  await page.mouse.move(point.x, point.y); await page.mouse.down({ button });
  await page.mouse.move(point.x + dx, point.y + dy, { steps: 10 }); await page.mouse.up({ button });
}

for (const button of ['left', 'right'] as const) test(`${button}拖拽实际平移，松开不移动角色或弹菜单`, async ({ page }) => {
  const { requests, errors } = await mount(page), svg = page.locator('svg.world-map');
  const before = (await svg.getAttribute('viewBox'))!.split(' ').map(Number), box = (await svg.boundingBox())!;
  await drag(page, await blank(page), 90, 60, button);
  await expect.poll(async () => (await svg.getAttribute('viewBox'))!.split(' ').map(Number)[0]).toBeCloseTo(before[0] - 90 * before[2] / box.width);
  const after = (await svg.getAttribute('viewBox'))!.split(' ').map(Number);
  expect(after[1]).toBeCloseTo(before[1] - 60 * before[2] / box.width);
  expect(after.slice(2)).toEqual(before.slice(2));
  await expect(page.getByRole('menu')).toHaveCount(0);
  expect(requests).toEqual([]); expect(errors).toEqual([]);
  expect(await page.title()).toBe('场域战争'); await expect(page.locator('vite-error-overlay')).toHaveCount(0);
  if (process.env.QA_SCREENSHOT_DIR) await page.screenshot({ path: `${process.env.QA_SCREENSHOT_DIR}/drag-${button}.png` });
});

test('标签上拖动不选择文字，已有选区也不能启动浏览器原生拖放', async ({ page, context }) => {
  const { requests, errors } = await mount(page), svg = page.locator('svg.world-map');
  const label = page.locator(`[data-portal-id="${map.portals[0].id}"] text`), box = (await label.boundingBox())!;
  const before = await svg.getAttribute('viewBox');
  await drag(page, { x: box.x + box.width / 2, y: box.y + box.height / 2 }, 100, 50);
  await expect(svg).not.toHaveAttribute('viewBox', before!);
  expect(await page.evaluate(() => window.getSelection()?.toString())).toBe('');
  // 模拟用户进入地图前已有的选区，验证默认拖放被取消，不交给浏览器查询/开页。
  const blocked = await label.evaluate(node => {
    const range = document.createRange(); range.selectNodeContents(node);
    const selection = window.getSelection()!; selection.removeAllRanges(); selection.addRange(range);
    const event = new DragEvent('dragstart', { bubbles: true, cancelable: true, dataTransfer: new DataTransfer() });
    node.dispatchEvent(event); return event.defaultPrevented;
  });
  expect(blocked).toBe(true);
  const second = (await label.boundingBox())!, selectedBefore = await svg.getAttribute('viewBox');
  await drag(page, { x: second.x + second.width / 2, y: second.y + second.height / 2 }, -60, 40);
  await expect(svg).not.toHaveAttribute('viewBox', selectedBefore!);
  expect(context.pages()).toHaveLength(1); expect(requests).toEqual([]); expect(errors).toEqual([]);
});

for (const cancel of ['Escape', 'blur', 'pointercancel', 'lostpointercapture']) test(`${cancel}结束拖拽，随后可重新拖动`, async ({ page }) => {
  const { requests } = await mount(page), svg = page.locator('svg.world-map'), p = await blank(page);
  await page.mouse.move(p.x, p.y); await page.mouse.down(); await page.mouse.move(p.x + 40, p.y + 20);
  if (cancel === 'Escape') await page.keyboard.press('Escape');
  else if (cancel === 'blur') await page.evaluate(() => window.dispatchEvent(new Event('blur')));
  else await svg.dispatchEvent(cancel, { pointerId: 1 });
  const stopped = await svg.getAttribute('viewBox');
  await page.mouse.move(p.x + 100, p.y + 70); await page.mouse.up();
  await expect(svg).toHaveAttribute('viewBox', stopped!);
  await drag(page, p, -50, -30);
  await expect(svg).not.toHaveAttribute('viewBox', stopped!); expect(requests).toEqual([]);
});

test('城区标记可拖拽，单击仍放大；贴边后的反向拖拽立即响应', async ({ page }) => {
  const { requests } = await mount(page), svg = page.locator('svg.world-map');
  for (let i = 0; i < 7; i++) await page.getByRole('button', { name: '缩小地图' }).click();
  const cluster = page.locator('.cluster').first();
  const p = await cluster.evaluate(node => { const p = new DOMPoint(0, 0).matrixTransform((node as SVGGraphicsElement).getScreenCTM()!); return { x: p.x, y: p.y }; });
  const before = (await svg.getAttribute('viewBox'))!.split(' ').map(Number);
  await drag(page, p, -80, -50);
  const after = (await svg.getAttribute('viewBox'))!.split(' ').map(Number);
  expect(after[2]).toBe(before[2]); expect(after[0]).toBeGreaterThan(before[0]);
  const point = await blank(page);
  await drag(page, point, 700, 0);
  await expect.poll(async () => Number((await svg.getAttribute('viewBox'))!.split(' ')[0])).toBe(0);
  await drag(page, point, -60, 0);
  await expect.poll(async () => Number((await svg.getAttribute('viewBox'))!.split(' ')[0])).toBeGreaterThan(0);
  await cluster.click();
  await expect.poll(async () => Number((await svg.getAttribute('viewBox'))!.split(' ')[2])).toBeLessThan(before[2]);
  expect(requests).toEqual([]);
});

test('手机触摸拖动平移且不产生点击移动', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  const { requests, errors } = await mount(page), svg = page.locator('svg.world-map');
  const p = await blank(page), before = await svg.getAttribute('viewBox'), cdp = await page.context().newCDPSession(page);
  await cdp.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [{ ...p, id: 1 }] });
  await cdp.send('Input.dispatchTouchEvent', { type: 'touchMove', touchPoints: [{ x: p.x - 70, y: p.y - 50, id: 1 }] });
  await cdp.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
  await expect(svg).not.toHaveAttribute('viewBox', before!);
  await expect(page.getByRole('menu')).toHaveCount(0); expect(requests).toEqual([]); expect(errors).toEqual([]);
  expect(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth)).toBe(false);
  if (process.env.QA_SCREENSHOT_DIR) await page.screenshot({ path: `${process.env.QA_SCREENSHOT_DIR}/drag-mobile.png` });
  await cdp.detach();
});

test('移动途中右键拖动不会停止，按下时的菜单事件不抢占手势', async ({ page }) => {
  const { requests, errors } = await mount(page, true), svg = page.locator('svg.world-map'), p = await blank(page);
  const before = await svg.getAttribute('viewBox');
  await page.mouse.move(p.x, p.y); await page.mouse.down({ button: 'right' });
  await svg.dispatchEvent('contextmenu', { button: 2, clientX: p.x, clientY: p.y });
  await expect(page.getByRole('menu')).toHaveCount(0); expect(requests).toEqual([]);
  await page.mouse.move(p.x + 60, p.y + 30, { steps: 5 }); await page.mouse.up({ button: 'right' });
  await expect(svg).not.toHaveAttribute('viewBox', before!);
  const playerBefore = await page.locator('.player-marker').getAttribute('transform');
  await expect.poll(() => page.locator('.player-marker').getAttribute('transform')).not.toBe(playerBefore);
  expect(requests).toEqual([]); expect(errors).toEqual([]);
});
