import { readFileSync, mkdirSync } from 'node:fs';
import { expect, test, type Page } from '@playwright/test';

test.use({ channel: process.env.PLAYWRIGHT_CHANNEL ?? undefined });

interface AdminState {
  world: { announcement:string; maintenance:boolean; season:{id:number}; seq:string };
  rules: { version:string };
  audit: {action:string;reason:string}[];
}

function adminPassword():string {
  if (process.env.ADMIN_PASSWORD) return process.env.ADMIN_PASSWORD;
  const contents=readFileSync(new URL('../.env',import.meta.url),'utf8');
  const line=contents.split(/\r?\n/).find(value=>value.startsWith('ADMIN_PASSWORD='));
  const value=line?.slice('ADMIN_PASSWORD='.length).trim() ?? '';
  const password=value.startsWith('"') && value.endsWith('"') ? value.slice(1,-1) : value.startsWith("'") && value.endsWith("'") ? value.slice(1,-1) : value;
  if (!password) throw new Error('缺少本地管理员密码配置');
  return password;
}
async function adminState(page:Page):Promise<AdminState> {
  return page.evaluate(async()=>await (await fetch('/api/admin/state',{cache:'no-store'})).json()) as Promise<AdminState>;
}
async function publish(page:Page,text:string,reason:string) {
  await page.getByRole('textbox',{name:'操作原因'}).fill(reason);
  await page.getByRole('textbox',{name:'公告'}).fill(text);
  await page.getByRole('button',{name:'发布公告'}).click();
  await expect.poll(async()=>(await adminState(page)).world.announcement).toBe(text);
}

test('Compose 管理入口登录、只读规则、公告恢复与审计',async({page})=>{
  const base=process.env.BASE_URL;
  test.skip(!base,'仅在指定 Compose 地址时执行');
  const password=adminPassword();
  await page.goto(`${base}/admin`);
  await expect(page.getByRole('heading',{name:'管理员登录'})).toBeVisible();
  await page.getByLabel('密码').fill(password);
  await page.getByRole('button',{name:'登录'}).click();
  await expect(page.getByRole('heading',{name:'世界状态'})).toBeVisible();
  const before=await adminState(page);
  expect(before.rules.version).toBe('beta-v1');
  expect(before.world.season.id).toBeGreaterThan(0);
  await page.getByText('查看冻结规则（只读）').click();
  await expect(page.locator('.rules-json')).toContainText('"version": "beta-v1"');
  const testText=`【验收测试】管理员界面 ${Date.now()}`;
  try {
    await publish(page,testText,'浏览器验收：测试公告写入');
    await expect(page.locator('.admin-table')).toContainText('浏览器验收：测试公告写入');
  } finally {
    if ((await adminState(page)).world.announcement!==before.world.announcement)
      await publish(page,before.world.announcement,'浏览器验收：恢复原公告');
  }
  const after=await adminState(page);
  expect(after.world.announcement).toBe(before.world.announcement);
  expect(after.world.maintenance).toBe(before.world.maintenance);
  expect(after.audit.some(entry=>entry.action==='announcement' && entry.reason==='浏览器验收：恢复原公告')).toBe(true);
  const output=process.env.QA_SCREENSHOT_DIR;
  if(output){
    mkdirSync(output,{recursive:true});
    await page.getByText('查看冻结规则（只读）').click();
    await page.evaluate(()=>scrollTo(0,0));
    await page.screenshot({path:`${output}/docker-admin.png`});
    await page.locator('.admin-table').scrollIntoViewIfNeeded();
    await page.screenshot({path:`${output}/docker-admin-audit.png`});
  }
});
