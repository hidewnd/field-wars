import { expect, test, type Page } from '@playwright/test';
import map from '../maps/beta-v1.json' with { type: 'json' };
import type { Portal, Snapshot } from '../shared/types';
import {applyCommand, GameError} from '../shared/engine';
import {refreshGroundXm} from '../shared/ground-xm';
import {randomUUID} from 'node:crypto';

test.use({ channel: process.env.PLAYWRIGHT_CHANNEL ?? undefined, viewport: { width: 1440, height: 960 } });
const source = map.portals.filter(p => p.role === 'core').slice(0, 2);
const [origin, target] = source;

function fixture(): Snapshot {
  const now = Date.now();
  const portals = structuredClone(map.portals) as Portal[];
  for (const portal of portals.filter(p => source.some(s => s.id === p.id))) {
    portal.faction = 'blue';
    portal.resonators = Array.from({ length: 8 }, (_, slot) => ({
      level: 1, energy: slot === 2 ? 500 : 1000, owner: 'demo', ownerName:'探索者', generation: `g-${slot}`,
      x: portal.x + Math.round(Math.cos(slot * Math.PI / 4) * 1600),
      y: portal.y + Math.round(Math.sin(slot * Math.PI / 4) * 1600), nextDecayAt: now + 86400000,
    }));
  }
  return {
    map: map as Snapshot['map'], rulesetVersion: 'beta-v1', mapVersion: 'beta-v1', serverTime: now, csrfToken: 'test', commandEpoch: 'test',
    world: { seq: '1', logicalAt: now, season: { id: 1, startAt: now, endAt: now + 604800000 }, nextCheckpoint: now + 300000,
      portals: Object.fromEntries(portals.map(p => [p.id, p])), links: [], fields: [], scores: { red: 0, green: 0, blue: 0 }, maintenance: false, announcement: '' },
    player: { id: 'demo', name: '探索者', faction: 'blue', ap: 240000, xm: 10000, x: origin.x, y: origin.y,
      inventory: [{ type: 'resonator', level: 1, quantity: 24 }, { type: 'pulse', level: 1, quantity: 8 }, { type: 'pulse', level: 8, quantity: 3 }, { type: 'key', level: 1, portalId: target.id, quantity: 1 }],
      movement: null, cooldowns: {}, hacks: {}, version: 1, energyAt: now, energyRemainder: 0, createdAt: now,
      tutorial: { first_field_at: now }, rechargeRemainder: 0, restrictedUntil: 0 },
  };
}
async function mount(page: Page, state = fixture()) {
  await page.routeWebSocket('**/api/events', () => {});
  await page.route('**/api/session', route => route.fulfill({ json: { player: state.player, csrfToken: 'test', commandEpoch: 'test' } }));
  await page.route('**/api/world/snapshot', route => route.fulfill({ json: state }));
  await page.route('**/api/po-applications/mine', route => route.fulfill({ json: { applications: [] } }));
  await page.route('**/api/social', route => route.fulfill({ json: { markers: [], alerts: [] } }));
  await page.goto(process.env.BASE_URL ?? 'http://127.0.0.1:5174/');
  await expect(page.getByRole('heading', { name: origin.name })).toBeVisible();
}
async function center(page: Page, id = origin.id) {
  return page.locator(`[data-portal-id="${id}"]`).evaluate(node => {
    const point = new DOMPoint(0, 0).matrixTransform((node as SVGGraphicsElement).getScreenCTM()!);
    return { x: point.x, y: point.y };
  });
}

// 浏览器通过真实规则引擎更新内存快照，用于核对界面提交参数与操作后的显示。
async function gameActions(page: Page, state: Snapshot) {
  const submitted:{type:string;payload:Record<string,unknown>}[]=[];
  await page.route(url=>/\/api\/(faction|account\/(rename|guide-read)|inventory\/(drop|pickup|recycle)|portals\/[^/]+\/(deploy|deploy-all|upgrade|recharge))$/.test(url.pathname),async route=>{
    const path=new URL(route.request().url()).pathname.split('/');
    const type=path.at(-1)!,payload=route.request().postDataJSON().payload;
    submitted.push({type,payload});
    try {
      const out=applyCommand(state.world,state.player,{type,payload,portalId:path.includes('portals')?path.at(-2):undefined},{now:Date.now(),id:randomUUID,random:()=>.5,map:state.map});
      out.world.seq=String(BigInt(state.world.seq)+1n);
      state.world=out.world;state.player=out.player;state.serverTime=Date.now();
      await route.fulfill({json:{result:out.result,player:out.player,committedSeq:out.world.seq}});
    }catch(error){if(!(error instanceof GameError))throw error;await route.fulfill({status:400,json:{error:{code:error.code,message:error.message}}});}
  });
  return submitted;
}

test('侵入攻击位于第一项，二级菜单明确选择等级并禁用超等级攻击器',async({page})=>{
  const state=fixture();state.player.ap=0;state.player.xm=3000;
  const errors:string[]=[];page.on('pageerror',error=>errors.push(error.message));page.on('console',message=>{if(['error','warning'].includes(message.type()))errors.push(message.text())});
  let attack:unknown;
  await mount(page,state);
  await page.route('**/api/attacks',route=>{attack=route.request().postDataJSON().payload;return route.fulfill({json:{result:{type:'attack'},committedSeq:'2'}})});
  await page.getByRole('button',{name:'收起侧栏'}).click();
  for(const [size,width,height] of [['desktop',1440,960],['mobile',390,844]] as const){
    await page.setViewportSize({width,height});
    await page.locator(`[data-portal-id="${origin.id}"]`).click({button:'right'});
    const menu=page.getByRole('menu',{name:'地图快捷操作'});
    await expect(menu.getByRole('menuitem').first()).toHaveText(/侵入攻击/);
    await menu.getByRole('menuitem',{name:/侵入攻击/}).click();
    expect(attack).toBeUndefined();
    const submenu=page.getByRole('menu',{name:'选择攻击道具'});
    await expect(submenu.getByRole('menuitem',{name:/L8/})).toBeDisabled();
    await expect(submenu.getByRole('menuitem',{name:/L1/})).toBeEnabled();
    if(process.env.QA_SCREENSHOT_DIR)await page.screenshot({path:`${process.env.QA_SCREENSHOT_DIR}/attack-${size}.png`});
    if(size==='desktop')await page.keyboard.press('Escape');
    else await submenu.getByRole('menuitem',{name:/L1/}).click();
  }
  await expect.poll(()=>attack).toEqual({level:1});
  await expect(page.getByRole('menu',{name:'地图快捷操作'})).toBeVisible();
  await expect(page.getByRole('menu',{name:'选择攻击道具'})).toBeVisible();
  await expect(page.locator('vite-error-overlay')).toHaveCount(0);
  expect(errors).toEqual([]);
});

test('菜单外点击只收起菜单，连续攻击保留菜单并更新库存；桌面和手机显示XM点',async({page})=>{
  const state=fixture(),errors:string[]=[];
  state.world.portals[origin.id].faction='red';
  state.world.groundXm=[[-6500,-5500],[-7200,3000],[6000,-5000],[1000,8500],[-5000,8500],[7500,7000]].map(([x,y],i)=>({id:`xm-${i}`,x:origin.x+x,y:origin.y+y,amount:50,spawnedAt:state.serverTime,expiresAt:state.serverTime+300000}));
  page.on('pageerror',error=>errors.push(error.message));
  page.on('console',message=>{if(['error','warning'].includes(message.type()))errors.push(message.text())});
  let attacks=0,moves=0;
  await mount(page,state);
  await page.route('**/api/moves',route=>{moves++;return route.abort()});
  await page.route('**/api/attacks',async route=>{
    const payload=route.request().postDataJSON().payload;
    const out=applyCommand(state.world,state.player,{type:'attack',payload},{now:Date.now(),map:state.map,id:randomUUID,random:()=>.5});
    state.world=out.world;state.player=out.player;state.serverTime=Date.now();attacks++;
    await route.fulfill({json:{result:out.result,player:out.player,committedSeq:String(attacks+1)}});
  });
  await page.getByRole('button',{name:'收起侧栏'}).click();
  await page.getByRole('button',{name:'关闭详情'}).click();
  for(const [size,width,height] of [['desktop',1440,960],['mobile',390,844]] as const){
    await page.setViewportSize({width,height});
    await expect(page).toHaveTitle(/场域战争/);
    for(let i=0;i<5;i++)await page.getByRole('button',{name:'放大地图',exact:true}).click();
    await expect(page.locator('[data-xm-id]')).toHaveCount(6);
    const point=await center(page);
    await page.mouse.click(point.x,point.y,{button:'right'});
    const menu=page.getByRole('menu',{name:'地图快捷操作'});
    await expect(menu).toBeVisible();
    const box=await page.locator('svg.world-map').boundingBox();
    await page.mouse.click(box!.x+20,box!.y+60);
    await expect(menu).toHaveCount(0);expect(moves).toBe(0);
    await page.mouse.click(point.x,point.y,{button:'right'});
    await page.getByRole('menuitem',{name:/侵入攻击/}).click();
    const weapon=page.getByRole('menuitem',{name:/L1 脉冲器/}),before=attacks;
    await weapon.click();await expect.poll(()=>attacks).toBe(before+1);
    await expect(menu).toBeVisible();
    await expect(weapon).toHaveText(new RegExp(`×${8-attacks}`));
    await expect(weapon).toBeEnabled({timeout:4000});
    await weapon.click();await expect.poll(()=>attacks).toBe(before+2);
    await expect(menu).toBeVisible();
    await expect(weapon).toHaveText(new RegExp(`×${8-attacks}`));
    await expect(page.locator('vite-error-overlay')).toHaveCount(0);
    expect(await page.evaluate(()=>document.documentElement.scrollWidth>innerWidth)).toBe(false);
    if(process.env.QA_SCREENSHOT_DIR)await page.screenshot({path:`${process.env.QA_SCREENSHOT_DIR}/xm-menu-${size}.png`});
    await page.getByRole('button',{name:'账号设置'}).click();await expect(menu).toHaveCount(0);
    await page.getByRole('dialog',{name:'账号信息'}).getByRole('button',{name:'关闭',exact:true}).click();
    await expect(page.locator('[data-xm-id="xm-0"] circle').first()).toBeVisible();
    if(process.env.QA_SCREENSHOT_DIR)await page.screenshot({path:`${process.env.QA_SCREENSHOT_DIR}/xm-map-${size}.png`});
  }
  expect(errors).toEqual([]);expect(moves).toBe(0);
});

test('自动批量部署高等级优先且可切换固定等级，槽位显示真实部署人',async({page})=>{
  const state=fixture();
  state.world.portals[origin.id].faction=null;state.world.portals[origin.id].resonators=Array(8).fill(null);
  state.player.inventory=[{type:'resonator',level:8,quantity:3},{type:'resonator',level:6,quantity:3},{type:'resonator',level:1,quantity:8}];
  await mount(page,state);const submitted=await gameActions(page,state);
  await page.getByRole('button',{name:/批量部署/}).click();
  await expect.poll(()=>state.world.portals[origin.id].resonators.map(r=>r?.level)).toEqual([8,6,6,1,1,1,1,1]);
  expect(submitted[0]).toEqual({type:'deploy-all',payload:{}});
  await expect(page.getByText('部署人：探索者')).toBeVisible();
  state.world.portals[origin.id].resonators=Array(8).fill(null);state.world.portals[origin.id].version++;
  state.player.inventory=[{type:'resonator',level:2,quantity:8},{type:'resonator',level:8,quantity:1}];
  await page.reload();
  await page.getByLabel('批量部署等级').selectOption('2');
  await page.getByRole('button',{name:/批量部署/}).click();
  await expect.poll(()=>state.world.portals[origin.id].resonators.filter(Boolean).map(r=>r?.level)).toEqual([2,2,2,2]);
  expect(submitted.at(-1)).toEqual({type:'deploy-all',payload:{level:2}});
});

test('选择单槽列出背包可升级脚，升级后刷新等级与部署人，桌面手机均可操作',async({page})=>{
  const state=fixture();state.player.ap=4000;state.player.inventory=[{type:'resonator',level:3,quantity:2},{type:'resonator',level:2,quantity:2},{type:'resonator',level:8,quantity:1}];
  state.world.portals[origin.id].resonators.forEach(r=>{if(r){r.owner='other';r.ownerName='青岚'}});
  await mount(page,state);await gameActions(page,state);
  await expect(page.getByText('部署人：青岚')).toBeVisible();
  await expect(page.getByRole('button',{name:/升级至 L8/})).toHaveCount(0);
  await page.getByRole('button',{name:/第2槽 L1/}).click();
  await page.getByRole('button',{name:/升级至 L3/}).click();
  await expect(page.getByRole('button',{name:/第2槽 L3/})).toHaveAttribute('aria-pressed','true');
  await expect(page.getByText('部署人：探索者')).toBeVisible();
  await page.getByRole('button',{name:/第1槽 L1/}).click();
  await expect(page.getByText('部署人：青岚')).toBeVisible();
  if(process.env.QA_SCREENSHOT_DIR)await page.screenshot({path:`${process.env.QA_SCREENSHOT_DIR}/slot-desktop.png`});
  await page.getByRole('button',{name:'收起侧栏'}).click();
  await page.setViewportSize({width:390,height:844});
  await page.getByRole('button',{name:/升级至 L2/}).click();
  await expect(page.getByRole('button',{name:/第1槽 L2/})).toBeVisible();
  expect(await page.evaluate(()=>document.documentElement.scrollWidth>innerWidth)).toBe(false);
  if(process.env.QA_SCREENSHOT_DIR)await page.screenshot({path:`${process.env.QA_SCREENSHOT_DIR}/slot-mobile.png`});
});

test('背包丢弃落地，其他玩家通过地图拾取，回收返回能量',async({page})=>{
  const state=fixture();state.player.inventory=[{type:'pulse',level:1,quantity:2},{type:'cube',level:1,quantity:2}];
  await mount(page,state);await gameActions(page,state);
  page.on('dialog',dialog=>dialog.accept());
  await page.getByRole('navigation',{name:'主导航'}).getByRole('button',{name:/背包/}).click();
  await page.locator('.item-row').filter({hasText:'脉冲器'}).getByRole('button',{name:'丢弃'}).click();
  await expect.poll(()=>state.world.droppedItems?.length).toBe(1);
  await expect(page.locator('.toast')).toContainText('已丢弃');
  const droppedBy=state.player.id;
  state.player={...state.player,id:'picker',name:'拾取者',faction:'green',inventory:[],xm:9000,version:0};
  await page.reload();
  await page.locator('[data-drop-position] rect').click();
  const pickup=page.getByRole('region',{name:'拾取地面道具'});
  await expect(pickup).toContainText('脉冲器 L1 ×1');
  if(process.env.QA_SCREENSHOT_DIR)await page.screenshot({path:`${process.env.QA_SCREENSHOT_DIR}/drop-desktop.png`});
  await page.getByRole('button',{name:'收起侧栏'}).click();
  await page.setViewportSize({width:390,height:844});
  await expect(pickup).toBeVisible();
  await expect(page.locator('.topbar')).toHaveCount(1);
  await page.evaluate(()=>new Promise<void>(resolve=>requestAnimationFrame(()=>requestAnimationFrame(()=>resolve()))));
  if(process.env.QA_SCREENSHOT_DIR)await page.screenshot({path:`${process.env.QA_SCREENSHOT_DIR}/drop-mobile.png`});
  await pickup.getByRole('button',{name:'拾取',exact:true}).click();
  await expect(page.locator('[data-drop-position]')).toHaveCount(0);
  expect(state.player.id).not.toBe(droppedBy);
  expect(state.player.inventory).toEqual([{type:'pulse',level:1,quantity:1}]);
  await page.getByRole('navigation',{name:'主导航'}).getByRole('button',{name:/背包/}).click();
  expect(await page.evaluate(()=>document.documentElement.scrollWidth>innerWidth)).toBe(false);
  if(process.env.QA_SCREENSHOT_DIR)await page.screenshot({path:`${process.env.QA_SCREENSHOT_DIR}/inventory-mobile.png`});
  await page.getByRole('button',{name:'回收',exact:true}).click();
  await expect(page.locator('.toast')).toContainText('已恢复 20 XM');
  await expect(page.getByText('该分类暂无物品。前往据点 Hack 获取资源。')).toBeVisible();
});

test('PO边缘、脚节点和轻抖点击仅选择；拖动和取消不移动', async ({ page }) => {
  const dialogs: string[] = [], moves: string[] = [];
  page.on('dialog', async dialog => { dialogs.push(dialog.message()); await dialog.dismiss(); });
  await page.route('**/api/moves', route => { moves.push(route.request().url()); return route.abort(); });
  await mount(page);
  await page.getByRole('button', { name: '关闭详情' }).click();
  const p = await center(page);
  await page.mouse.click(p.x + 20, p.y - 3);
  await expect(page.getByRole('heading', { name: origin.name })).toBeVisible();
  await page.mouse.move(p.x, p.y); await page.mouse.down(); await page.mouse.move(p.x + 5, p.y + 2); await page.mouse.up();
  await expect(page.getByRole('heading', { name: origin.name })).toBeVisible();
  await page.getByRole('button', { name: '关闭详情' }).click();
  const foot = page.locator(`[data-portal-id="${origin.id}"] [data-resonator-slot="0"] circle`).first();
  await foot.click();
  await expect(page.getByRole('heading', { name: origin.name })).toBeVisible();
  await page.mouse.move(p.x, p.y); await page.mouse.down(); await page.mouse.move(p.x + 70, p.y + 40, { steps: 5 }); await page.mouse.up();
  await page.locator('svg.world-map').dispatchEvent('pointercancel', { pointerId: 1 });
  expect(dialogs).toEqual([]); expect(moves).toEqual([]);
});

test('右键菜单区分空白和PO，基础操作保留且点击外部或Escape关闭', async ({ page }) => {
  await mount(page);
  const p = await center(page);
  await page.mouse.click(p.x, p.y, { button: 'right' });
  const menu = page.getByRole('menu', { name: '地图快捷操作' });
  await expect(menu.getByRole('menuitem', { name: '入侵 Hack' })).toBeVisible();
  await expect(menu.getByRole('menuitem', { name: '侵入攻击' })).toBeVisible();
  await expect(menu.getByRole('menuitem', { name: '申请新 PO' })).toBeVisible();
  await page.keyboard.press('Escape'); await expect(menu).toHaveCount(0);
  const box = await page.locator('svg.world-map').boundingBox();
  await page.mouse.click(box!.x + box!.width - 8, box!.y + 65, { button: 'right' });
  await expect(menu).toBeVisible();
  await expect(menu.getByRole('menuitem', { name: '入侵 Hack' })).toHaveCount(0);
  const menuBox = await menu.boundingBox();
  expect(menuBox!.x + menuBox!.width).toBeLessThanOrEqual(1440);
  await menu.getByRole('menuitem', { name: '申请新 PO' }).click();
  await expect(page.getByRole('heading', { name: '申请新 PO' })).toBeVisible();
  await page.getByRole('button', { name: '取消', exact: true }).click();
  await page.mouse.click(p.x, p.y, { button: 'right' });
  await page.getByRole('heading', { name: origin.name }).click();
  await expect(menu).toHaveCount(0);
});

test('右键攻击从玩家当前位置提交且PO入侵使用菜单目标', async ({ page }) => {
  let attack: Record<string, unknown> | undefined, hackPath = '';
  await mount(page);
  await page.route('**/api/attacks', route => { attack = route.request().postDataJSON().payload; return route.fulfill({ json: { result: { type: 'attack', hits: 1 }, committedSeq: '2' } }); });
  const p = await center(page, target.id);
  await page.mouse.click(p.x, p.y, { button: 'right' });
  await page.getByRole('menuitem', { name: '侵入攻击' }).click();
  await page.getByRole('menu', {name:'选择攻击道具'}).getByRole('menuitem', {name:/L8 脉冲器/}).click();
  await expect.poll(() => attack).toEqual({ level: 8 });
  await expect(page.locator('.toast')).toHaveText('操作成功');
  await page.route('**/api/portals/*/hack', route => { hackPath = route.request().url(); return route.fulfill({ json: { result: { type: 'hack', portalId: target.id, items: [], key: false, cost: 50, ap: 0, counterDamage: 0 }, committedSeq: '3' } }); });
  await page.mouse.click(p.x, p.y, { button: 'right' });
  await page.getByRole('menuitem', { name: '入侵 Hack' }).click();
  await expect.poll(() => hackPath).toContain(`/portals/${target.id}/hack`);
  await expect(page.locator('.toast')).toHaveText('无任何收获');
});

test('Hack收据展示合并物品与Key，Escape关闭；零掉落只显示底部文字', async ({ page }) => {
  await mount(page);
  let empty = false;
  await page.route('**/api/portals/*/hack', route => route.fulfill({ json: { result: { type: 'hack', portalId: origin.id,
    items: empty ? [] : [{ type: 'resonator', level: 1, quantity: 1 }, { type: 'resonator', level: 1, quantity: 1 }, { type: 'cube', level: 2, quantity: 1 }],
    key: !empty, cost: 50, ap: 0, counterDamage: 0 }, committedSeq: '2' } }));
  await page.getByRole('button', { name: /^Hack/ }).click();
  const reward = page.getByRole('dialog', { name: '入侵收获' });
  await expect(reward).toBeVisible();
  await expect(reward.locator('.reward-item')).toHaveCount(3);
  await expect(reward.locator('.reward-resonator')).toContainText('×2');
  await expect(reward.locator('.reward-key')).toContainText('×1');
  if (process.env.QA_SCREENSHOT_DIR) await page.screenshot({ path: `${process.env.QA_SCREENSHOT_DIR}/hack-rewards.png` });
  await page.keyboard.press('Escape'); await expect(reward).toHaveCount(0);
  empty = true; await page.getByRole('button', { name: /^Hack/ }).click();
  await expect(page.locator('.toast')).toHaveText('无任何收获'); await expect(reward).toHaveCount(0);
});

test('Hack失败保留错误，未知提交用原收据恢复后展示收获', async ({ page }) => {
  await mount(page);
  let unknown = false, requestId = '';
  await page.route('**/api/portals/*/hack', route => {
    requestId = route.request().postDataJSON().requestId;
    return route.fulfill({ status: unknown ? 503 : 409, json: { error: { code: unknown ? 'RESULT_UNKNOWN' : 'OUT_OF_RANGE', message: unknown ? '结果未确认' : '距离过远' } } });
  });
  await page.getByRole('button', { name: /^Hack/ }).click();
  await expect(page.locator('.toast')).toHaveText('距离过远');
  await expect(page.locator('.toast')).not.toContainText('OUT_OF_RANGE');
  await expect(page.getByRole('dialog', { name: '入侵收获' })).toHaveCount(0);
  unknown = true; await page.getByRole('button', { name: /^Hack/ }).click();
  await expect(page.getByRole('button', { name: '确认上次操作结果' })).toBeVisible();
  await page.route('**/api/commands/*', route => route.fulfill({ json: { requestId, committedSeq: '2', result: { type: 'hack', portalId: origin.id, items: [], key: true, cost: 50, ap: 0, counterDamage: 0 } } }));
  await page.getByRole('button', { name: '确认上次操作结果' }).click();
  await expect(page.getByRole('dialog', { name: '入侵收获' })).toBeVisible();
  await expect(page.getByRole('button', { name: '确认上次操作结果' })).toHaveCount(0);
});

test('连线页直接提交，失败仅显示原因且可以重试', async ({ page }) => {
  const requests: string[] = []; let failure = 'key';
  await mount(page);
  await page.route('**/api/links**', route => { requests.push(route.request().url()); return failure==='none'
    ? route.fulfill({ json: { result: { type: 'link' }, committedSeq: '2' } })
    : route.fulfill({ status: 409, json: { error: failure==='key' ? { code: 'KEY_REQUIRED', message: '需要目标 Key' } : {code:'LINK_CROSSING',message:'LINK_CROSSING'} } }); });
  await page.getByRole('button', { name: '连线', exact:true }).click();
  await expect(page.getByRole('button',{name:/起点|取消连线|检查连线/})).toHaveCount(0);
  const button=page.getByRole('button',{name:`连线至 ${target.name}`,exact:true});
  await button.click();await expect(page.locator('.toast')).toHaveText('需要目标 Key');
  await expect(page.locator('.toast')).not.toContainText('KEY_REQUIRED');
  failure='crossing';await button.click();
  await expect(page.locator('.toast')).toHaveText('连线路径被其他连线阻挡');
  await expect(page.locator('.toast')).not.toContainText('LINK_CROSSING');
  failure='none';await button.click();await expect(page.locator('.toast')).toHaveText('操作成功');
  expect(requests).toHaveLength(3); expect(requests.every(url => url.endsWith('/api/links'))).toBe(true);
});

test('快捷连线打开当前PO的列表，切换PO不会保留隐藏起点',async({page})=>{
  const state=fixture();state.player.inventory.push({type:'key',level:1,portalId:origin.id,quantity:1});
  await mount(page,state);
  await page.getByRole('button',{name:'连线 查看可连据点',exact:true}).click();
  await expect(page.getByRole('button',{name:`连线至 ${target.name}`,exact:true})).toBeVisible();
  const p=await center(page,target.id);await page.mouse.click(p.x,p.y,{button:'right'});
  await page.getByRole('menuitem',{name:'连线',exact:true}).click();
  await expect(page.getByRole('heading',{name:target.name})).toBeVisible();
  await expect(page.getByRole('button',{name:`连线至 ${origin.name}`,exact:true})).toBeVisible();
  await expect(page.getByRole('button',{name:`连线至 ${target.name}`,exact:true})).toHaveCount(0);
  await expect(page.getByRole('button',{name:/起点|取消连线/})).toHaveCount(0);
});

test('连线列表按资格展示，一次点击提交并在Key耗尽后移除目标', async ({ page }) => {
  const state=fixture(), requests:Record<string,unknown>[]=[];
  const errors:string[]=[];page.on('pageerror',error=>errors.push(error.message));
  await mount(page,state);
  await page.getByRole('button',{name:'连线',exact:true}).click();
  const list=page.getByRole('region',{name:'可连线据点'});
  const button=list.getByRole('button',{name:`连线至 ${target.name}`,exact:true});
  await expect(button).toBeEnabled();
  await expect(list.locator('.link-target')).toHaveCount(1);
  if(process.env.QA_SCREENSHOT_DIR)await page.screenshot({path:`${process.env.QA_SCREENSHOT_DIR}/link-targets-desktop.png`});
  await page.route('**/api/links',route=>{
    requests.push(route.request().postDataJSON());
    state.player.inventory=state.player.inventory.filter(item=>item.type!=='key');state.world.seq='2';
    return route.fulfill({json:{result:{type:'link'},committedSeq:'2'}});
  });
  await button.click();
  await expect(button).toHaveCount(0);
  await expect(list).toContainText('暂无可连线据点');
  expect(requests).toHaveLength(1);
  expect(requests[0]).toMatchObject({payload:{originId:origin.id,destinationId:target.id}});
  expect(errors).toEqual([]);
});

test('缺脚目标不列出，手机列表可用且移动时禁止提交',async({page})=>{
  const state=fixture();state.world.portals[target.id].resonators[0]=null;
  await page.setViewportSize({width:390,height:844});await mount(page,state);
  await page.getByRole('button',{name:'连线',exact:true}).click();
  const list=page.getByRole('region',{name:'可连线据点'});
  await expect(list.locator('.link-target')).toHaveCount(0);
  state.world.portals[target.id].resonators[0]={...state.world.portals[origin.id].resonators[0]!};state.world.seq='2';
  await page.reload();await page.getByRole('button',{name:'连线',exact:true}).click();
  const button=list.getByRole('button',{name:`连线至 ${target.name}`,exact:true});
  await expect(button).toBeEnabled();await button.scrollIntoViewIfNeeded();
  expect(await page.evaluate(()=>document.documentElement.scrollWidth>innerWidth)).toBe(false);
  if(process.env.QA_SCREENSHOT_DIR)await page.screenshot({path:`${process.env.QA_SCREENSHOT_DIR}/link-targets-mobile.png`});
  state.player.movement={from:{x:origin.x,y:origin.y},to:{x:target.x,y:target.y},startAt:Date.now(),arriveAt:Date.now()+60_000};state.world.seq='3';
  await page.reload();await page.getByRole('button',{name:'连线',exact:true}).click();
  await expect(button).toBeDisabled();await expect(list).toContainText('移动中');
});

test('真实脚数量随快照更新，零距离八脚可辨；手机菜单与详情没有横向溢出', async ({ page }) => {
  const state = fixture(); const po = state.world.portals[origin.id];
  po.resonators = po.resonators.map((r, i) => i < 3 ? { ...r!, x: po.x, y: po.y } : null);
  const errors: string[] = []; page.on('pageerror', error => errors.push(error.message));
  page.on('console', message => { if (message.type()==='error') errors.push(message.text()); });
  await mount(page, state);
  expect(await page.title()).toContain('场域战争');
  await expect(page.locator('vite-error-overlay')).toHaveCount(0);
  await expect(page.locator(`[data-portal-id="${origin.id}"] [data-resonator-slot]`)).toHaveCount(3);
  po.resonators=Array.from({length:8},(_,slot)=>({...po.resonators[0]!,generation:`updated-${slot}`,x:po.x,y:po.y}));
  state.world.seq='2'; await page.reload();
  const feet=page.locator(`[data-portal-id="${origin.id}"] [data-resonator-slot]`);
  await expect(feet).toHaveCount(8);
  const positions=await feet.locator('circle:first-of-type').evaluateAll(nodes=>nodes.map(node=>`${node.getAttribute('cx')}:${node.getAttribute('cy')}`));
  expect(new Set(positions).size).toBe(8);
  if (process.env.QA_SCREENSHOT_DIR) await page.screenshot({ path: `${process.env.QA_SCREENSHOT_DIR}/map-detail-desktop.png` });
  await page.setViewportSize({ width: 390, height: 844 });
  await page.reload();
  await expect(page.locator('.detail-panel')).toBeVisible();
  expect(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth)).toBe(false);
  if (process.env.QA_SCREENSHOT_DIR) await page.screenshot({ path: `${process.env.QA_SCREENSHOT_DIR}/map-detail-mobile.png` });
  await page.getByRole('button', { name: '关闭详情' }).click();
  const p = await center(page); await page.mouse.click(p.x, p.y, { button: 'right' });
  const menu = page.getByRole('menu', { name: '地图快捷操作' }); await expect(menu).toBeVisible();
  const box = await menu.boundingBox(); expect(box!.x).toBeGreaterThanOrEqual(0); expect(box!.x + box!.width).toBeLessThanOrEqual(390); expect(box!.y + box!.height).toBeLessThanOrEqual(844);
  if (process.env.QA_SCREENSHOT_DIR) await page.screenshot({ path: `${process.env.QA_SCREENSHOT_DIR}/map-menu-mobile.png` });
  expect(errors).toEqual([]);
});

test('手机长按打开菜单而不发移动命令', async ({ page }) => {
  await page.setViewportSize({width:390,height:844});
  let moves=0; const dialogs:string[]=[];
  page.on('dialog',async dialog=>{dialogs.push(dialog.message());await dialog.dismiss();});
  await page.route('**/api/moves',route=>{moves++;return route.abort();});
  await mount(page);await page.getByRole('button',{name:'关闭详情'}).click();
  const p=await center(page),cdp=await page.context().newCDPSession(page);
  await cdp.send('Input.dispatchTouchEvent',{type:'touchStart',touchPoints:[{x:p.x,y:p.y,id:1}]});
  await expect(page.getByRole('menu',{name:'地图快捷操作'})).toBeVisible();
  await cdp.send('Input.dispatchTouchEvent',{type:'touchEnd',touchPoints:[]});
  await expect(page.getByRole('menuitem',{name:'入侵 Hack'})).toBeVisible();
  expect(moves).toBe(0);expect(dialogs).toEqual([]);await cdp.detach();
});

test('领域场摧毁战报显示攻击者、三个顶点与MU，刷新和手机端均保留',async({page})=>{
  const state=fixture(),third=map.portals.filter(p=>p.role==='core')[2];
  const errors:string[]=[];
  page.on('pageerror',error=>errors.push(error.message));
  page.on('console',message=>{if(['error','warning'].includes(message.type()))errors.push(message.text())});
  await mount(page,state);
  const feed=page.getByRole('region',{name:'实时战报'});
  await expect(feed).toContainText('战场暂时平静');
  state.world.battleEvents=[
    {id:'attack',at:Date.now(),faction:'red',kind:'attack',actor:'赤羽',portals:[origin.id]},
    {id:'destroyed',at:Date.now(),faction:'red',kind:'field-destroyed',actor:'赤羽',portals:[origin.id,target.id,third.id],amount:129},
  ];
  await page.reload();
  await expect(page).toHaveTitle(/场域战争/);
  const report=feed.getByRole('listitem').first();
  await expect(report).toHaveText(new RegExp(`红方 · 赤羽 摧毁了领域场：${origin.name} / ${target.name} / ${third.name} · 129 MU`));
  await expect(report.locator('span')).toHaveClass('red');
  await expect(feed.getByText(/摧毁了领域场/)).toHaveCount(1);
  await expect(page.locator('vite-error-overlay')).toHaveCount(0);
  if(process.env.QA_SCREENSHOT_DIR)await page.screenshot({path:`${process.env.QA_SCREENSHOT_DIR}/field-destroyed-desktop.png`});
  await page.setViewportSize({width:390,height:844});await page.reload();
  await expect(report).toBeVisible();
  await expect(report).toContainText('129 MU');
  expect(await page.evaluate(()=>document.documentElement.scrollWidth>innerWidth)).toBe(false);
  expect(await report.evaluate(el=>el.scrollWidth>el.clientWidth)).toBe(false);
  if(process.env.QA_SCREENSHOT_DIR)await page.screenshot({path:`${process.env.QA_SCREENSHOT_DIR}/field-destroyed-mobile.png`});
  expect(errors).toEqual([]);
});

test('侧栏可收起并记忆，首场引导移除，半透明战报显示真实事件',async({page})=>{
  const state=fixture();state.player.tutorial={};
  state.world.battleEvents=[
    {id:'capture',at:Date.now(),faction:'red',kind:'capture',actor:'赤羽',portals:[origin.id]},
    {id:'link',at:Date.now(),faction:'green',kind:'link',portals:[origin.id,target.id]},
    {id:'score',at:Date.now(),faction:'blue',kind:'score',portals:[],amount:120},
    {id:'attack',at:Date.now(),faction:'red',kind:'attack',actor:'赤羽',portals:[target.id]},
  ];
  const errors:string[]=[];page.on('pageerror',e=>errors.push(e.message));page.on('console',e=>{if(['error','warning'].includes(e.type()))errors.push(e.text())});
  await mount(page,state);expect(await page.title()).toContain('场域战争');
  await expect(page.locator('vite-error-overlay')).toHaveCount(0);
  await expect(page.getByText('首场：本区核心三角')).toHaveCount(0);
  const feed=page.getByRole('region',{name:'实时战报'});
  await expect(feed).toContainText('本阵营获得 120 积分');
  await expect(feed).toContainText('赤羽 攻击了');
  expect(await feed.evaluate(el=>getComputedStyle(el).backgroundColor)).toBe('rgba(245, 250, 255, 0.78)');
  const before=await page.locator('.map-main').boundingBox();
  await page.getByRole('button',{name:'收起侧栏'}).click();
  await expect(page.locator('.left-rail')).toBeHidden();
  const after=await page.locator('.map-main').boundingBox();expect(after!.width).toBeGreaterThan(before!.width+200);
  await page.reload();await expect(page.locator('.left-rail')).toBeHidden();
  if(process.env.QA_SCREENSHOT_DIR)await page.screenshot({path:`${process.env.QA_SCREENSHOT_DIR}/battle-desktop.png`});
  await page.getByRole('button',{name:'展开侧栏'}).click();await expect(page.locator('.left-rail')).toBeVisible();
  await page.getByRole('button',{name:'收起侧栏'}).click();
  await page.setViewportSize({width:390,height:844});await page.reload();
  await expect(feed).toBeVisible();await expect(page.locator('.left-rail')).toBeHidden();
  expect(await page.evaluate(()=>document.documentElement.scrollWidth>innerWidth)).toBe(false);
  const feedBox=await feed.boundingBox(),toolsBox=await page.locator('.map-tools').boundingBox();
  expect(feedBox!.x+feedBox!.width).toBeLessThanOrEqual(toolsBox!.x);
  if(process.env.QA_SCREENSHOT_DIR)await page.screenshot({path:`${process.env.QA_SCREENSHOT_DIR}/battle-mobile.png`});
  await page.getByRole('button',{name:'展开侧栏'}).click();await expect(page.locator('.left-rail')).toBeVisible();
  await page.getByRole('button',{name:'收起侧栏'}).click();await expect(page.locator('.left-rail')).toBeHidden();
  expect(errors).toEqual([]);
});

test('跨级礼包逐一弹窗，Hack收获随后展示；未知收据恢复仍通知礼包',async({page})=>{
  await mount(page);
  const levelRewards=[2,3].map(level=>({level,items:[{type:'pulse',level,quantity:20},{type:'resonator',level,quantity:20},{type:'cube',level,quantity:10}]}));
  let requestId='';
  await page.route('**/api/portals/*/hack',route=>{requestId=route.request().postDataJSON().requestId;return route.fulfill({status:503,json:{error:{code:'RESULT_UNKNOWN',message:'结果未确认'}}})});
  await page.route('**/api/commands/*',route=>route.fulfill({json:{requestId,committedSeq:'2',result:{type:'hack',portalId:origin.id,items:[],key:true,cost:50,ap:100,counterDamage:0,levelRewards}}}));
  await page.getByRole('button',{name:/^Hack/}).click();
  await page.getByRole('button',{name:'确认上次操作结果'}).click();
  const reward=page.getByRole('dialog',{name:'晋升 L2 · 升级礼包'});await expect(reward).toBeVisible();
  await expect(reward.locator('.reward-pulse')).toContainText('×20');
  await expect(reward.locator('.reward-resonator')).toContainText('×20');
  await expect(reward.locator('.reward-cube')).toContainText('×10');
  await expect(reward).toContainText('礼包已自动放入背包');
  if(process.env.QA_SCREENSHOT_DIR)await page.screenshot({path:`${process.env.QA_SCREENSHOT_DIR}/level-reward.png`});
  await page.keyboard.press('Escape');await expect(page.getByRole('dialog',{name:'晋升 L3 · 升级礼包'})).toBeVisible();
  await page.getByRole('button',{name:'继续探索'}).click();await expect(page.getByRole('dialog',{name:'入侵收获'})).toBeVisible();
  await page.keyboard.press('Escape');await expect(page.getByRole('dialog')).toHaveCount(0);
});

test('账号中英文改名校验20字符，右上角及部署人同步，桌面手机布局正常',async({page})=>{
  const state=fixture();await mount(page,state);const submitted=await gameActions(page,state);
  const errors:string[]=[];page.on('pageerror',error=>errors.push(error.message));
  await page.getByRole('button',{name:'账号设置'}).click();
  const account=page.getByRole('dialog',{name:'账号信息'}),input=account.getByLabel(/玩家名称/);
  await input.fill('星'.repeat(21));
  await expect(account.getByText('玩家名称最多 20 个字符')).toBeVisible();
  await expect(account.getByRole('button',{name:'保存名称'})).toBeDisabled();
  expect(submitted).toHaveLength(0);
  const name='星河探索者WindABCDEFGHIJK';
  expect([...name]).toHaveLength(20);
  await input.fill(name);await account.getByRole('button',{name:'保存名称'}).click();
  await expect(page.locator('.toast')).toContainText('玩家名称已更新');
  await expect(page.getByRole('button',{name:'修改玩家名称'})).toHaveText(name);
  await expect(account.getByRole('button',{name:'保存名称'})).toBeDisabled();
  if(process.env.QA_SCREENSHOT_DIR)await page.screenshot({path:`${process.env.QA_SCREENSHOT_DIR}/account-desktop.png`});
  await page.setViewportSize({width:390,height:844});
  await expect(input).toHaveValue(name);
  await page.evaluate(()=>new Promise<void>(resolve=>requestAnimationFrame(()=>requestAnimationFrame(()=>resolve()))));
  if(process.env.QA_SCREENSHOT_DIR)await page.screenshot({path:`${process.env.QA_SCREENSHOT_DIR}/account-mobile.png`});
  await account.getByRole('button',{name:'关闭',exact:true}).click();
  await expect(page.getByText(`部署人：${name}`)).toBeVisible();
  await expect(page.getByRole('button',{name:'修改玩家名称'})).toBeVisible();
  expect(await page.evaluate(()=>document.documentElement.scrollWidth>innerWidth)).toBe(false);
  if(process.env.QA_SCREENSHOT_DIR)await page.screenshot({path:`${process.env.QA_SCREENSHOT_DIR}/name-mobile.png`});
  await page.reload();
  await expect(page.getByRole('button',{name:'修改玩家名称'})).toHaveText(name);
  expect(submitted).toEqual([{type:'rename',payload:{name}}]);
  expect(errors).toEqual([]);
});

test('老玩家可手动打开玩法说明，四章内容与L8申请指引，手机可滚动且关闭恢复焦点',async({page})=>{
  await mount(page);await expect(page.getByRole('dialog',{name:'玩法说明'})).toHaveCount(0);
  const open=page.getByRole('button',{name:/玩法说明/});await open.click();
  const guide=page.getByRole('dialog',{name:'玩法说明'});
  await expect(guide.getByRole('heading',{name:'连成三角，建立领域'})).toBeVisible();
  if(process.env.QA_SCREENSHOT_DIR)await page.screenshot({path:`${process.env.QA_SCREENSHOT_DIR}/guide-desktop.png`});
  await guide.getByRole('button',{name:'核心参数'}).click();
  await expect(guide.getByText('AP · 成长经验')).toBeVisible();
  await expect(guide.getByText('MU · 领域计分值')).toBeVisible();
  await guide.getByRole('button',{name:'常用操作'}).click();
  await expect(guide.getByRole('heading',{name:'侵入攻击'})).toBeVisible();
  await guide.getByRole('button',{name:'进阶与安全'}).click();
  await expect(guide.getByText('L8 解锁')).toBeVisible();
  await page.setViewportSize({width:390,height:844});
  await expect(guide.getByRole('button',{name:'我知道了，开始探索'})).toBeVisible();
  expect(await page.evaluate(()=>document.documentElement.scrollWidth>innerWidth)).toBe(false);
  await page.evaluate(()=>new Promise<void>(resolve=>requestAnimationFrame(()=>requestAnimationFrame(()=>resolve()))));
  if(process.env.QA_SCREENSHOT_DIR)await page.screenshot({path:`${process.env.QA_SCREENSHOT_DIR}/guide-mobile.png`});
  await guide.getByRole('button',{name:'核心参数'}).click();
  await guide.getByText('MU · 领域计分值').scrollIntoViewIfNeeded();
  await expect(guide.getByText('MU · 领域计分值')).toBeVisible();
  await page.setViewportSize({width:1440,height:960});
  await page.keyboard.press('Escape');await expect(guide).toHaveCount(0);await expect(open).toBeFocused();
});

test('新玩家保存恢复码并选阵营后自动展示说明，关闭已读随账号保存且刷新不再弹出',async({page})=>{
  const state=fixture();state.player.faction=null;state.player.ap=0;state.player.xm=3000;state.player.inventory=[];
  state.player.tutorial={quick_start_pending_at:state.serverTime};
  let created=false;
  await page.routeWebSocket('**/api/events',()=>{});
  await page.route('**/api/session',r=>r.fulfill({json:{player:created?state.player:null,csrfToken:'test',commandEpoch:'test'}}));
  await page.route('**/api/anonymous-sessions',r=>{created=true;return r.fulfill({json:{player:state.player,recoveryCode:'LOCAL-TEST-CODE',csrfToken:'test',commandEpoch:'test'}})});
  await page.route('**/api/world/snapshot',r=>r.fulfill({json:state}));
  await page.route('**/api/po-applications/mine',r=>r.fulfill({json:{applications:[]}}));
  await page.route('**/api/social',r=>r.fulfill({json:{markers:[],alerts:[]}}));
  const submitted=await gameActions(page,state);
  await page.goto(process.env.BASE_URL ?? 'http://127.0.0.1:5174/');
  await page.getByRole('button',{name:'创建匿名身份'}).click();
  await page.getByRole('button',{name:'确认名称并进入'}).click();
  const guide=page.getByRole('dialog',{name:'玩法说明'});
  await expect(page.getByRole('dialog',{name:'保存恢复码'})).toBeVisible();
  await expect(guide).toHaveCount(0);
  await page.getByRole('button',{name:'我已保存'}).click();
  await expect(guide).toHaveCount(0);
  await page.locator('.faction-options').getByRole('button',{name:/蓝方/}).click();
  await expect(guide).toBeVisible();
  await page.reload();await expect(guide).toBeVisible();
  await guide.getByRole('button',{name:'我知道了，开始探索'}).click();
  await expect(guide).toHaveCount(0);
  expect(state.player.tutorial.quick_start_pending_at).toBeUndefined();
  expect(state.player.tutorial.quick_start_seen_at).toBeDefined();
  expect(submitted.map(item=>item.type)).toEqual(['faction','guide-read']);
  await page.evaluate(()=>localStorage.clear());await page.reload();
  await expect(page.getByRole('button',{name:'账号设置'})).toBeVisible();
  await expect(guide).toHaveCount(0);
  await page.getByRole('button',{name:/玩法说明/}).click();await expect(guide).toBeVisible();
  await guide.getByRole('button',{name:'关闭玩法说明'}).click();await expect(guide).toHaveCount(0);
  expect(submitted.map(item=>item.type)).toEqual(['faction','guide-read']);
});


test('等级位于名称左侧，经验条按当前等级区间显示并兼容满级与手机',async({page})=>{
  const state=fixture();state.player.ap=2250;state.player.name='这是二十个字的角色名称用于检查手机布局效果';
  await mount(page,state);
  const meter=page.getByRole('progressbar',{name:'等级经验'});
  await page.setViewportSize({width:320,height:740});
  for(const [ap,level,label,percent] of [[0,'L1','AP 0 / 500','0'],[2250,'L2','AP 1,750 / 3,500','50'],[4000,'L3','AP 0 / 10,000','0'],[240000,'L8','AP 240,000 · 已满级','100']] as const){
    state.player.ap=ap;await page.reload();
    await expect(page.locator('.player-level')).toHaveText(level);
    await expect(meter).toHaveAttribute('aria-valuetext',label);
    await expect(meter).toHaveAttribute('aria-valuenow',percent);
    expect(await meter.locator('span').evaluate(node=>node.getBoundingClientRect().right)).toBeLessThanOrEqual((await page.getByRole('button',{name:'账号设置',exact:true}).boundingBox())!.x);
  }
  state.player.ap=2250;state.player.xm=4000;await page.reload();
  if(await page.getByRole('button',{name:'收起侧栏'}).isVisible())await page.getByRole('button',{name:'收起侧栏'}).click();
  for(const [size,width,height] of [['desktop',1440,960],['mobile',390,844],['small-mobile',320,740]] as const){
    await page.setViewportSize({width,height});
    await page.evaluate(()=>new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve))));
    const name=await page.locator('.player-name').boundingBox(),level=await page.locator('.player-level').boundingBox(),bar=await meter.boundingBox();
    expect(level!.x+level!.width).toBeLessThanOrEqual(name!.x);
    expect(Math.abs(level!.y+level!.height/2-name!.y-name!.height/2)).toBeLessThan(2);
    expect(bar!.y).toBeGreaterThanOrEqual(name!.y+name!.height);
    const settings=await page.getByRole('button',{name:'账号设置',exact:true}).boundingBox();
    expect(bar!.x+bar!.width).toBeLessThanOrEqual(settings!.x);
    expect(settings!.x+settings!.width).toBeLessThanOrEqual(width);
    expect(await meter.locator('span').evaluate(node=>node.getBoundingClientRect().right)).toBeLessThanOrEqual(settings!.x);
    expect(await page.evaluate(()=>document.documentElement.scrollWidth>innerWidth)).toBe(false);
    if(process.env.QA_SCREENSHOT_DIR)await page.screenshot({path:`${process.env.QA_SCREENSHOT_DIR}/experience-${size}.png`});
  }
});

test('背包KEY定位远方PO并远程充能，不移动或消耗KEY，重复点击仍定位',async({page})=>{
  const state=fixture(),errors:string[]=[];
  const far=state.world.portals[target.id],dx=origin.x+150000-far.x,dy=origin.y+50000-far.y;
  far.x+=dx;far.y+=dy;far.resonators.forEach(r=>{if(r){r.x+=dx;r.y+=dy}});
  state.player.ap=2250;state.player.xm=4000;
  state.player.inventory.find(i=>i.type==='key')!.protected=true;
  refreshGroundXm(state.world,state.map,state.serverTime);
  page.on('pageerror',error=>errors.push(error.message));
  page.on('console',message=>{if(['error','warning'].includes(message.type()))errors.push(message.text())});
  let moves=0;await page.route('**/api/moves',route=>{moves++;return route.fulfill({json:{}})});
  await mount(page,state);const submitted=await gameActions(page,state);
  await page.getByRole('button',{name:'收起侧栏'}).click();
  for(const [size,width,height] of [['desktop',1440,960],['mobile',390,844]] as const){
    await page.setViewportSize({width,height});
    await page.getByRole('navigation',{name:'主导航'}).getByRole('button',{name:/背包/}).click();
    await page.getByRole('button',{name:`定位据点 ${target.name}`,exact:true}).click();
    await expect(page).toHaveURL(/127.0.0.1:5174/);
    await expect(page).toHaveTitle(/场域战争/);
    await expect(page.getByRole('heading',{name:target.name,exact:true})).toBeVisible();
    await expect(page.locator('.distance-line')).toContainText('持有 Key · 可远程充能');
    const point=await center(page,target.id),box=await page.locator('svg.world-map').boundingBox();
    expect(point.x).toBeGreaterThan(box!.x);expect(point.x).toBeLessThan(box!.x+box!.width);
    expect(point.y).toBeGreaterThan(box!.y);expect(point.y).toBeLessThan(box!.y+box!.height);
    if(size==='mobile')await expect.poll(async()=> (await center(page,target.id)).y < (await page.getByRole('complementary',{name:'据点详情'}).boundingBox())!.y).toBe(true);
    await expect(page.locator(`[data-portal-id="${target.id}"] circle[stroke="#286ee5"]`)).toBeVisible();
    await expect(page.getByRole('button',{name:'全部充能 远程充能 · 无需前往',exact:true})).toBeEnabled();
    await expect(page.locator('[data-xm-id]')).toHaveCount(0);
    for(let i=0;i<5;i++)await page.getByRole('button',{name:'放大地图',exact:true}).click();
    await expect(page.locator('[data-xm-id]')).toHaveCount(2000);
    await expect(page.locator('.xm-layer [stroke]')).toHaveCount(0);
    await expect(page.locator('.xm-layer circle')).toHaveCount(2000);
    await expect(page.locator('.xm-layer circle').first()).toHaveAttribute('fill','url(#xm-glow)');
    await page.getByRole('button',{name:'缩小地图',exact:true}).click();
    await expect(page.locator('[data-xm-id]')).toHaveCount(0);
    await page.getByRole('button',{name:'放大地图',exact:true}).click();
    await expect(page.locator('[data-xm-id]')).toHaveCount(2000);
    await expect(page.locator('vite-error-overlay')).toHaveCount(0);
    expect(await page.evaluate(()=>document.documentElement.scrollWidth>innerWidth)).toBe(false);
    if(process.env.QA_SCREENSHOT_DIR)await page.screenshot({path:`${process.env.QA_SCREENSHOT_DIR}/key-focus-${size}.png`});
  }
  const originalPosition={x:state.player.x,y:state.player.y},keys=structuredClone(state.player.inventory.filter(i=>i.type==='key'));
  await page.getByRole('button',{name:'全部充能 远程充能 · 无需前往',exact:true}).click();
  await expect(page.locator('.toast')).toHaveText('操作成功');
  expect(submitted).toHaveLength(1);expect(submitted[0].type).toBe('recharge');
  expect(submitted[0].payload.generations).toEqual(Object.fromEntries(Array.from({length:8},(_,i)=>[i,`g-${i}`])));
  expect(state.world.portals[target.id].resonators[2]!.energy).toBe(1000);
  expect(state.player.xm).toBeLessThan(4000);
  expect(state.player.inventory.filter(i=>i.type==='key')).toEqual(keys);
  expect({x:state.player.x,y:state.player.y}).toEqual(originalPosition);expect(state.player.movement).toBeNull();expect(moves).toBe(0);
  state.player.movement={from:originalPosition,to:{x:origin.x+20000,y:origin.y},startAt:Date.now(),arriveAt:Date.now()+60000};
  await page.reload();await page.getByRole('navigation',{name:'主导航'}).getByRole('button',{name:/背包/}).click();
  await page.getByRole('button',{name:`定位据点 ${target.name}`,exact:true}).click();
  await expect(page.getByRole('button',{name:/全部充能/})).toBeDisabled();
  expect(errors).toEqual([]);
});

test('在线玩家收到新玩家加入战报，刷新与手机保留阵营和名称且不重复',async({page})=>{
  const state=fixture();
  const errors:string[]=[];page.on('pageerror',e=>errors.push(e.message));page.on('console',e=>{if(['error','warning'].includes(e.type()))errors.push(e.text())});
  let invalidate:()=>void=()=>{throw new Error('WebSocket 未连接')};
  await mount(page,state);
  await page.routeWebSocket('**/api/events',socket=>{invalidate=()=>socket.send(JSON.stringify({type:'invalidate',committedSeq:state.world.seq,deliverySeq:1}));});
  await page.reload();
  const feed=page.getByRole('region',{name:'实时战报'});
  await expect(feed).toContainText('战场暂时平静');
  state.world.battleEvents=(['red','green','blue'] as const).map((faction,index)=>({id:`join-${index}`,at:Date.now(),kind:'join',faction,actor:['赤羽','绿叶','新玩家Wind'][index],portals:[]}));
  state.world.seq='2';invalidate();
  for(const text of ['红方阵营的赤羽加入了战斗','绿方阵营的绿叶加入了战斗','蓝方阵营的新玩家Wind加入了战斗'])await expect(feed.getByText(text,{exact:true})).toBeVisible();
  await expect(feed.getByRole('listitem')).toHaveCount(3);
  await expect(page.locator('vite-error-overlay')).toHaveCount(0);
  if(process.env.QA_SCREENSHOT_DIR)await page.screenshot({path:`${process.env.QA_SCREENSHOT_DIR}/join-feed-desktop.png`});
  await page.setViewportSize({width:390,height:844});await page.reload();
  await expect(feed.getByRole('listitem')).toHaveCount(3);
  await expect(feed.getByText('蓝方阵营的新玩家Wind加入了战斗',{exact:true})).toBeVisible();
  expect(await page.evaluate(()=>document.documentElement.scrollWidth>innerWidth)).toBe(false);
  if(process.env.QA_SCREENSHOT_DIR)await page.screenshot({path:`${process.env.QA_SCREENSHOT_DIR}/join-feed-mobile.png`});
  expect(errors).toEqual([]);
});
