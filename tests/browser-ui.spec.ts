import { expect, test } from '@playwright/test';
import map from '../maps/beta-v1.json' with { type: 'json' };

test.use({ channel: process.env.PLAYWRIGHT_CHANNEL ?? undefined });

const now = Date.now();
const player = {
  id:'browser-demo', name:'探索者', faction:'blue', ap:0, xm:3000, energyAt:now, energyRemainder:0,
  inventory:[], movement:null, cooldowns:{}, hacks:{}, version:1, createdAt:now,
  tutorial:{}, rechargeRemainder:0, restrictedUntil:0,
  x:map.spawns[0].x, y:map.spawns[0].y,
};
const world = {
  seq:'1', logicalAt:now, season:{id:1,startAt:now,endAt:now+604800000}, nextCheckpoint:now+300000,
  portals:Object.fromEntries(map.portals.map(portal=>[portal.id,portal])), links:[], fields:[],
  scores:{red:0,green:0,blue:0}, maintenance:false, announcement:'',
};
const state={world,player,serverTime:now,rulesetVersion:'beta-v1',mapVersion:'beta-v1',map,csrfToken:'test',commandEpoch:'test'};
const nearest=map.portals.reduce((best,portal)=>Math.hypot(portal.x-player.x,portal.y-player.y)<Math.hypot(best.x-player.x,best.y-player.y)?portal:best);

test.beforeEach(async({page})=>{
  await page.route('**/api/session',route=>route.fulfill({json:{player,csrfToken:'test',commandEpoch:'test'}}));
  await page.route('**/api/world/snapshot',route=>route.fulfill({json:state}));
  await page.route('**/api/po-applications/mine',route=>route.fulfill({json:{applications:[]}}));
  await page.route('**/api/social',route=>route.fulfill({json:{markers:[],alerts:[]}}));
});

test('据点、背包和战况可从地图访问',async({page})=>{
  await page.goto(process.env.BASE_URL ?? 'http://127.0.0.1:5173/');
  await expect(page.getByRole('heading',{name:'七日赛季'})).toBeVisible();
  await expect(page.getByRole('heading',{name:nearest.name})).toBeVisible();
  await page.getByRole('button',{name:/背包/}).first().click();
  await expect(page.getByRole('heading',{name:'背包'})).toBeVisible();
  await page.getByRole('button',{name:/战况/}).first().click();
  await expect(page.getByRole('heading',{name:'战况'})).toBeVisible();
  await page.getByRole('button',{name:/城市/}).first().click();
  await expect(page.locator('svg.world-map')).toBeVisible();
  if (process.env.QA_SCREENSHOT_DIR) await page.screenshot({path:`${process.env.QA_SCREENSHOT_DIR}/desktop.png`});
});

test('窄屏显示地图与可操作的据点抽屉',async({page})=>{
  await page.setViewportSize({width:390,height:844});
  await page.goto(process.env.BASE_URL ?? 'http://127.0.0.1:5173/');
  await expect(page.locator('svg.world-map')).toBeVisible();
  await expect(page.locator('.detail-panel')).toBeVisible();
  await expect(page.getByRole('button',{name:/Hack/})).toBeVisible();
  const overflow=await page.evaluate(()=>document.documentElement.scrollWidth>window.innerWidth);
  expect(overflow).toBe(false);
  if (process.env.QA_SCREENSHOT_DIR) await page.screenshot({path:`${process.env.QA_SCREENSHOT_DIR}/mobile.png`});
  await page.getByRole('button',{name:'账号设置'}).click();
  await expect(page.getByRole('button',{name:'重新生成恢复码'})).toBeVisible();
  await expect(page.getByRole('button',{name:'退出账号'})).toBeVisible();
});

test('命令已提交但回包丢失后刷新，仍用原请求确认收据',async({page})=>{
  let requestId='',posts=0,receiptVisible=false;
  await page.route('**/api/moves',async route=>{
    const body=route.request().postDataJSON() as {requestId:string};
    if (requestId) expect(body.requestId).toBe(requestId);
    requestId=body.requestId;posts++;
    if (posts===1) await route.abort('failed');
    else await route.fulfill({status:503,json:{error:{code:'RESULT_UNKNOWN',message:'提交结果暂不可确认'}}});
  });
  await page.route('**/api/commands/*',route=>receiptVisible
    ? route.fulfill({json:{requestId,committedSeq:'2',serverTime:Date.now(),result:{type:'move'}}})
    : route.fulfill({status:404,json:{error:{code:'NOT_FOUND',message:'尚未找到'}}}));
  await page.goto(process.env.BASE_URL ?? 'http://127.0.0.1:5173/');
  await page.getByRole('button',{name:'前往据点'}).click();
  await expect(page.getByRole('button',{name:'确认上次操作结果'})).toBeVisible();
  expect(posts).toBe(2);
  await page.reload();
  await expect(page.getByRole('button',{name:'确认上次操作结果'})).toBeVisible();
  await page.getByRole('button',{name:'前往据点'}).click();
  expect(posts).toBe(2);
  receiptVisible=true;
  await page.getByRole('button',{name:'确认上次操作结果'}).click();
  await expect(page.getByRole('button',{name:'确认上次操作结果'})).toHaveCount(0);
  expect(posts).toBe(2);
  expect(requestId).toMatch(/^[0-9a-f-]{36}$/);
});

test('匿名建号响应缺失后，刷新以原请求找回只显示一次的恢复码',async({page})=>{
  let requestId='',posts=0;
  await page.route('**/api/session',route=>route.fulfill({json:{player:null,csrfToken:'',commandEpoch:''}}));
  await page.route('**/api/anonymous-sessions',route=>{
    const body=route.request().postDataJSON() as {requestId:string;name:string};
    expect(body.name).toBe('重试玩家Wind');
    if(requestId) expect(body.requestId).toBe(requestId);
    requestId=body.requestId;posts++;
    return posts===1 ? route.fulfill({status:200,body:''}) : route.fulfill({json:{player,recoveryCode:'cc-new-code',csrfToken:'test',commandEpoch:'test'}});
  });
  await page.goto(process.env.BASE_URL ?? 'http://127.0.0.1:5173/');
  await page.getByRole('button',{name:'创建匿名身份'}).click();
  await page.getByRole('textbox',{name:'玩家名称'}).fill('重试玩家Wind');
  await page.getByRole('button',{name:'确认名称并进入'}).click();
  await expect(page.getByRole('alert')).toHaveText('响应正文缺失，请使用原请求确认结果');
  await expect(page.getByRole('alert')).not.toContainText('RESULT_UNKNOWN');
  await page.reload();
  await expect(page.getByRole('heading',{name:'保存恢复码'})).toBeVisible();
  expect(posts).toBe(2);
  expect(await page.evaluate(()=>sessionStorage.getItem('junction-beta:pending-create'))).toBeNull();
});

test('恢复身份未知结果后，同一恢复码跨刷新沿用原请求 ID',async({page})=>{
  const oldCode=`cc-${'A'.repeat(43)}`;
  let requestId='',posts=0;
  await page.route('**/api/session',route=>route.fulfill({json:{player:null,csrfToken:'',commandEpoch:''}}));
  await page.route('**/api/account/recover',route=>{
    const body=route.request().postDataJSON() as {requestId:string;recoveryCode:string};
    expect(body.recoveryCode).toBe(oldCode);
    if(requestId) expect(body.requestId).toBe(requestId);
    requestId=body.requestId;posts++;
    return posts===1
      ? route.fulfill({status:503,json:{error:{code:'RESULT_UNKNOWN',message:'结果未确认'}}})
      : route.fulfill({json:{player,recoveryCode:'cc-rotated-code',csrfToken:'test',commandEpoch:'test'}});
  });
  await page.goto(process.env.BASE_URL ?? 'http://127.0.0.1:5173/');
  await page.getByRole('button',{name:'已有恢复码？恢复身份'}).click();
  await page.getByRole('textbox',{name:'恢复码'}).fill(oldCode);
  await page.getByRole('button',{name:'恢复账号'}).click();
  await expect(page.getByRole('alert')).toHaveText('结果未确认');
  await expect(page.getByRole('alert')).not.toContainText('RESULT_UNKNOWN');
  const stored=await page.evaluate(()=>sessionStorage.getItem('junction-beta:pending-recover'));
  expect(stored).not.toContain(oldCode);
  await page.reload();
  await page.getByRole('button',{name:'已有恢复码？恢复身份'}).click();
  await page.getByRole('textbox',{name:'恢复码'}).fill(oldCode);
  await page.getByRole('button',{name:'恢复账号'}).click();
  await expect(page.getByRole('heading',{name:'保存恢复码'})).toBeVisible();
  expect(posts).toBe(2);
  expect(await page.evaluate(()=>sessionStorage.getItem('junction-beta:pending-recover'))).toBeNull();
});

for (const mobile of [false,true]) test(`建号先输入预填名称，校验后提交${mobile?'（手机）':'（桌面）'}`,async({page})=>{
  await page.setViewportSize(mobile?{width:390,height:844}:{width:1440,height:960});
  const errors:string[]=[];
  page.on('pageerror',e=>errors.push(e.message));
  page.on('console',e=>{if(['error','warning'].includes(e.type()))errors.push(e.text())});
  await page.routeWebSocket('**/api/events',()=>{});
  await page.route('**/api/session',r=>r.fulfill({json:{player:null,csrfToken:'',commandEpoch:''}}));
  let submittedName='';
  await page.route('**/api/anonymous-sessions',r=>{
    submittedName=r.request().postDataJSON().name;
    return r.fulfill({json:{player:{...player,name:submittedName},recoveryCode:'local-code',csrfToken:'test',commandEpoch:'test'}});
  });
  await page.route('**/api/world/snapshot',r=>r.fulfill({json:{...state,player:{...player,name:submittedName}}}));
  const url=process.env.BASE_URL ?? 'http://127.0.0.1:5173/';
  await page.goto(url);await expect(page).toHaveURL(url);await expect(page).toHaveTitle(/场域战争/);
  await page.getByRole('button',{name:'创建匿名身份'}).click();
  await expect(page.getByRole('heading',{name:'输入玩家名称'})).toBeVisible();
  const name=page.getByRole('textbox',{name:'玩家名称'}),submit=page.getByRole('button',{name:'确认名称并进入'});
  await expect(name).toBeFocused();await expect(name).toHaveValue(/^玩家[0-9a-f]{6}$/);
  const defaultName=await name.inputValue();
  expect(submittedName).toBe('');await expect(submit).toBeEnabled();
  await name.fill(' ');await expect(submit).toBeDisabled();
  await name.fill('星'.repeat(21));await expect(submit).toBeDisabled();
  await expect(page.getByText('玩家名称最多 20 个字符')).toBeVisible();
  await name.fill(mobile?' 新玩家Wind ':defaultName);await expect(submit).toBeEnabled();
  await expect(page.locator('vite-error-overlay')).toHaveCount(0);
  expect(await page.evaluate(()=>document.documentElement.scrollWidth>innerWidth)).toBe(false);
  if(process.env.QA_SCREENSHOT_DIR)await page.screenshot({path:`${process.env.QA_SCREENSHOT_DIR}/join-name-${mobile?'mobile':'desktop'}.png`});
  await submit.click();
  await expect(page.getByRole('heading',{name:'保存恢复码'})).toBeVisible();
  expect(submittedName).toBe(mobile?'新玩家Wind':defaultName);
  await expect(page.getByRole('button',{name:'修改玩家名称'})).toHaveText(submittedName);
  expect(errors).toEqual([]);
});
