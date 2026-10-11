import { mkdir } from 'node:fs/promises';
import { expect, test, type Page } from '@playwright/test';
import type { Snapshot } from '../shared/types';

test.use({ channel: process.env.PLAYWRIGHT_CHANNEL ?? undefined });

async function select(page:Page,id:string) {
  const index=Number(id.split('-').at(-1))-1;
  const guided=page.locator('.tutorial-core button').nth(index);
  if (index>=0 && index<3 && await guided.count()) {await guided.click();return;}
  const marker=page.locator(`[data-portal-id="${id}"]`);
  for(let i=0;i<6;i++) {
    const box=await marker.boundingBox();
    if(box && box.y>90 && box.x>310 && box.x<page.viewportSize()!.width-330) break;
    await page.getByRole('button',{name:'缩小地图'}).click();
  }
  await marker.click();
}
async function moveTo(page:Page,id:string) {
  await select(page,id);
  await page.getByRole('button',{name:'据点',exact:true}).click();
  const go=page.getByRole('button',{name:'前往据点'});
  if (await go.count()) await go.click();
  await expect(page.locator('.distance-line')).toContainText('可交互',{timeout:60_000});
}
async function capture(page:Page,id:string) {
  await moveTo(page,id);
  await page.getByRole('button',{name:/^Hack/}).click();
  await expect(page.getByRole('dialog',{name:'入侵收获'})).toBeVisible();
  await page.getByRole('button',{name:'继续探索'}).click();
  await expect(page.locator('.actions-section')).toContainText(/本点 Key [1-9]\d* 把/);
  await page.getByRole('button',{name:/批量部署/}).click();
  await expect(page.locator('.resonator-section')).toContainText('8 / 8');
}
async function connect(page:Page,originId:string,targetId:string) {
  await select(page,originId);
  await page.getByRole('button',{name:'连线',exact:true}).click();
  const targetName=await page.evaluate(async id=>(await (await fetch('/api/world/snapshot')).json()).world.portals[id].name,targetId);
  const candidate=page.getByRole('region',{name:'可连线据点'}).getByRole('button',{name:`连线至 ${targetName}`,exact:true});
  await expect(candidate).toBeEnabled();
  await candidate.click();
  await expect(candidate).toHaveCount(0);
  await expect(page.getByRole('button',{name:'取消连线',exact:true})).toHaveCount(0);
}

test('真实 Compose 浏览器完成 A→B→C→A 首场并在刷新后保留',async({page})=>{
  test.setTimeout(180_000);
  const base=process.env.BASE_URL;
  test.skip(!base,'仅在指定 Compose 地址时执行');
  await page.goto(base!);
  await page.getByRole('button',{name:'创建匿名身份'}).click();
  await page.getByRole('button',{name:'确认名称并进入'}).click();
  await page.getByRole('button',{name:'我已保存'}).click();
  await page.getByRole('button',{name:'▲ 蓝方'}).click();
  const initial=await page.evaluate(async()=>await (await fetch('/api/world/snapshot')).json()) as Snapshot;
  const spawn=initial.map.spawns.find(item=>item.x===initial.player.x && item.y===initial.player.y);
  expect(spawn).toBeTruthy();
  const core=initial.map.portals.filter(portal=>portal.districtId===spawn!.districtId && portal.role==='core').sort((a,b)=>a.id.localeCompare(b.id));
  expect(core).toHaveLength(3);
  for (const portal of core) {
    expect(initial.world.portals[portal.id].faction, '首场测试需使用独立空白世界，核心点必须中立').toBeNull();
  }
  const [a,b,c]=core;
  await capture(page,a.id);
  await capture(page,b.id);
  await connect(page,b.id,a.id);
  await capture(page,c.id);
  await connect(page,c.id,b.id);
  await moveTo(page,a.id);
  await connect(page,a.id,c.id);
  const before=await page.evaluate(async()=>await (await fetch('/api/world/snapshot')).json()) as Snapshot;
  expect(before.world.fields.some(field=>field.owner===before.player.id)).toBe(true);
  expect(before.world.links.filter(link=>link.owner===before.player.id)).toHaveLength(3);
  await page.reload();
  const after=await page.evaluate(async()=>await (await fetch('/api/world/snapshot')).json()) as Snapshot;
  expect(after.world.fields).toEqual(before.world.fields);
  expect(after.world.links).toEqual(before.world.links);
  expect(after.player.inventory).toEqual(before.player.inventory);
  const output=process.env.QA_SCREENSHOT_DIR;
  if(output){await mkdir(output,{recursive:true});await page.screenshot({path:`${output}/browser-first-field.png`});}
});
