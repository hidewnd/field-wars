import { mkdir } from 'node:fs/promises';
import { expect, test } from '@playwright/test';

test.use({ channel: process.env.PLAYWRIGHT_CHANNEL ?? undefined });

test('Docker 部署的匿名入口与响应式城市地图', async ({page}) => {
  const base=process.env.BASE_URL;
  test.skip(!base, '只在显式指定 Docker 部署地址时运行');
  const errors:string[]=[];
  page.on('pageerror',error=>errors.push(error.message));
  await page.goto(base!);
  await page.getByRole('button',{name:'创建匿名身份'}).click();
  await expect(page.getByRole('heading',{name:'保存恢复码'})).toBeVisible();
  await page.getByRole('button',{name:'我已保存'}).click();
  await page.getByRole('button',{name:'◆ 绿方'}).click();
  await expect(page.locator('svg.world-map')).toBeVisible();
  await expect(page.getByRole('heading',{name:'七日赛季'})).toBeVisible();
  const output=process.env.QA_SCREENSHOT_DIR;
  if (output) {
    await mkdir(output,{recursive:true});
    await page.screenshot({path:`${output}/docker-desktop.png`});
  }
  const mobile=await page.context().newPage();
  mobile.on('pageerror',error=>errors.push(error.message));
  await mobile.setViewportSize({width:390,height:844});
  await mobile.goto(base!);
  await expect(mobile.locator('.detail-panel')).toBeVisible();
  expect(await mobile.evaluate(()=>document.documentElement.scrollWidth>innerWidth)).toBe(false);
  if (output) await mobile.screenshot({path:`${output}/docker-mobile.png`});
  await mobile.close();
  expect(errors).toEqual([]);
});
