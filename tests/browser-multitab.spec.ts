import { expect, test } from '@playwright/test';
import type { Snapshot } from '../shared/types';

test.use({ channel: process.env.PLAYWRIGHT_CHANNEL ?? undefined });

test('同一浏览器两个标签共享阵营背包与移动状态',async({page,context})=>{
  const base=process.env.BASE_URL;
  test.skip(!base,'仅在指定 Compose 地址时执行');
  await page.goto(base!);
  await page.getByRole('button',{name:'创建匿名身份'}).click();
  await page.getByRole('button',{name:'我已保存'}).click();
  const second=await context.newPage();
  await second.goto(base!);
  await expect(second.getByRole('heading',{name:'选择阵营'})).toBeVisible();
  const firstAccount=(await page.evaluate(async()=>await (await fetch('/api/world/snapshot')).json()) as Snapshot).player.id;
  const secondAccount=(await second.evaluate(async()=>await (await fetch('/api/world/snapshot')).json()) as Snapshot).player.id;
  expect(secondAccount).toBe(firstAccount);
  await page.getByRole('button',{name:'▲ 蓝方'}).click();
  await expect(second.getByRole('heading',{name:'选择阵营'})).toHaveCount(0,{timeout:10_000});
  await second.getByRole('button',{name:/背包/}).first().click();
  await expect(second.locator('.page-heading strong')).toContainText('48 / 500');
  await second.getByRole('button',{name:/城市/}).first().click();
  await page.getByRole('button',{name:'前往据点'}).click();
  await expect(second.getByRole('button',{name:'停止移动'})).toBeEnabled({timeout:10_000});
  const moved=(await second.evaluate(async()=>await (await fetch('/api/world/snapshot')).json()) as Snapshot).player;
  expect(moved.id).toBe(firstAccount);
  expect(moved.movement).not.toBeNull();
  await second.close();
});
