import {expect,test,type Page} from '@playwright/test';
import map from '../maps/beta-v1.json' with {type:'json'};
import {applyCommand,createPlayer,createWorld} from '../shared/engine';
import type {MapData,Snapshot} from '../shared/types';

const city=map as MapData;
function fixture():Snapshot {
 const now=Date.now(),portal=city.portals[0],player=createPlayer('map-test','地图测试',now,portal);
 player.tutorial={quick_start_seen_at:now};player.faction='blue';player.ap=240000;
 return {map:city,world:createWorld(city,now),player,serverTime:now,rulesetVersion:'beta-v1',mapVersion:'beta-v1',csrfToken:'test',commandEpoch:'test'};
}
async function mount(page:Page,state:Snapshot) {
 await page.routeWebSocket('**/api/events',()=>{});
 await page.route('**/api/session',r=>r.fulfill({json:{player:state.player,csrfToken:'test',commandEpoch:'test'}}));
 await page.route('**/api/world/snapshot',r=>r.fulfill({json:state}));
 await page.route('**/api/po-applications/mine',r=>r.fulfill({json:{applications:[]}}));
 await page.route('**/api/social',r=>r.fulfill({json:{markers:[],alerts:[]}}));
 await page.goto(process.env.BASE_URL ?? 'http://127.0.0.1:5178/');
 await expect(page.locator('svg.world-map')).toBeVisible();
 await page.getByRole('button',{name:'关闭详情'}).click();
 await page.getByRole('button',{name:'定位',exact:true}).click();
}
async function target(page:Page,dx:number,dy:number) {
 return page.locator('.player-marker').evaluate((node,delta)=>{
  const p=new DOMPoint(0,0).matrixTransform((node as SVGGraphicsElement).getScreenCTM()!);
  return {x:p.x+delta.dx,y:p.y+delta.dy};
 },{dx,dy});
}
async function mockMoves(page:Page,state:Snapshot,hold?:Promise<void>) {
 const requests:{path:string;payload:{x?:number;y?:number};version:number}[]=[];
 await page.route('**/api/moves{,/cancel}',async route=>{
  const body=route.request().postDataJSON(),path=new URL(route.request().url()).pathname;
  requests.push({path,payload:body.payload,version:body.playerVersion});
  if(requests.length===1 && hold)await hold;
  expect(body.playerVersion).toBe(state.player.version);
  const result=applyCommand(state.world,state.player,{type:path.endsWith('cancel')?'move-cancel':'move',payload:body.payload},{now:Date.now(),map:city,random:()=>.5,id:()=>crypto.randomUUID()});
  state.player=result.player;state.world={...result.world,seq:String(BigInt(state.world.seq)+1n)};state.serverTime=Date.now();
  await route.fulfill({json:{requestId:body.requestId,committedSeq:state.world.seq,serverTime:state.serverTime,result:result.result}});
 });
 return requests;
}

test.use({viewport:{width:1440,height:960}});
test('左键立即移动、途中改道、右键原地停留，无确认弹窗',async({page})=>{
 const state=fixture(),errors:string[]=[],dialogs:string[]=[];
 page.on('pageerror',e=>errors.push(e.message));page.on('console',m=>{if(m.type()==='error')errors.push(m.text())});
 page.on('dialog',async d=>{dialogs.push(d.message());await d.dismiss()});
 const requests=await mockMoves(page,state);await mount(page,state);
 const first=await target(page,120,100);await page.mouse.click(first.x,first.y);
 await expect.poll(()=>requests.length).toBe(1);await expect(page.locator('.toast')).toHaveText('操作成功');
 expect(state.player.movement).not.toBeNull();
 await expect(page.locator('.interaction-range')).toHaveAttribute('r','3000');
 const before=await page.locator('.player-marker').getAttribute('transform');
 await expect.poll(()=>page.locator('.player-marker').getAttribute('transform')).not.toBe(before);
 const next=await target(page,-110,120);await page.mouse.click(next.x,next.y);
 await expect.poll(()=>requests.length).toBe(2);await expect(page.locator('.toast')).toHaveText('操作成功');
 expect(requests[1].payload).not.toEqual(requests[0].payload);
 await page.mouse.click(next.x,next.y,{button:'right'});
 await expect.poll(()=>requests.length).toBe(3);await expect(page.locator('.toast')).toHaveText('操作成功');
 expect(requests[2].path).toBe('/api/moves/cancel');expect(state.player.movement).toBeNull();
 await expect(page.getByRole('menu')).toHaveCount(0);
 const stopped=await page.locator('.player-marker').getAttribute('transform');
 await page.waitForTimeout(1100);expect(await page.locator('.player-marker').getAttribute('transform')).toBe(stopped);
 expect(dialogs).toEqual([]);expect(errors).toEqual([]);expect(await page.title()).toBe('场域战争');
 await expect(page.locator('vite-error-overlay')).toHaveCount(0);
 if(process.env.QA_SCREENSHOT_DIR)await page.screenshot({path:`${process.env.QA_SCREENSHOT_DIR}/movement-desktop.png`});
});

test('请求处理中连续改道只提交最后一个目标',async({page})=>{
 let release!:()=>void;const hold=new Promise<void>(r=>{release=r});
 const state=fixture(),requests=await mockMoves(page,state,hold);await mount(page,state);
 const a=await target(page,120,100),b=await target(page,-120,100),c=await target(page,100,150);
 await page.mouse.click(a.x,a.y);await expect.poll(()=>requests.length).toBe(1);
 await page.mouse.click(b.x,b.y);await page.mouse.click(c.x,c.y);
 expect(requests).toHaveLength(1);release();
 await expect.poll(()=>requests.length).toBe(2);await expect(page.locator('.toast')).toHaveText('操作成功');
 const actual=await page.locator('svg.world-map').evaluate((svg,point)=>{const p=new DOMPoint(point.x,point.y).matrixTransform((svg as SVGSVGElement).getScreenCTM()!.inverse());return{x:Math.round(p.x),y:Math.round(p.y)}},c);
 expect(requests[1].payload).toEqual(actual);
});

test('首次移动尚未回包时右键停止，不打开菜单且不发送过期改道',async({page})=>{
 let release!:()=>void;const hold=new Promise<void>(r=>{release=r});
 const state=fixture(),requests=await mockMoves(page,state,hold);await mount(page,state);
 const a=await target(page,120,100),b=await target(page,-120,100);
 await page.mouse.click(a.x,a.y);await expect.poll(()=>requests.length).toBe(1);
 await page.mouse.click(b.x,b.y);await page.mouse.click(b.x,b.y,{button:'right'});
 await expect(page.getByRole('menu')).toHaveCount(0);release();
 await expect.poll(()=>requests.length).toBe(2);await expect(page.locator('.toast')).toHaveText('操作成功');
 expect(requests.map(r=>r.path)).toEqual(['/api/moves','/api/moves/cancel']);expect(state.player.movement).toBeNull();
});

test('移动结果未知时不越过原收据执行排队目标',async({page})=>{
 let release!:()=>void;const hold=new Promise<void>(r=>{release=r});let posts=0;
 await page.route('**/api/moves',async route=>{posts++;await hold;await route.fulfill({status:503,json:{error:{code:'RESULT_UNKNOWN',message:'结果未确认'}}})});
 await mount(page,fixture());const a=await target(page,120,100),b=await target(page,-120,100);
 await page.mouse.click(a.x,a.y);await expect.poll(()=>posts).toBe(1);await page.mouse.click(b.x,b.y);release();
 await expect(page.getByRole('button',{name:'确认上次操作结果'})).toBeVisible();
 await page.mouse.click(b.x,b.y);expect(posts).toBe(1);
});

test('30米圆随地图缩放保持真实半径，手机可见且无横向溢出',async({page})=>{
 await page.setViewportSize({width:390,height:844});await mount(page,fixture());
 const ring=page.locator('.interaction-range');await expect(ring).toHaveAttribute('r','3000');
 const old=(await ring.boundingBox())!.width;
 await page.getByRole('button',{name:'放大地图'}).click();
 await expect.poll(async()=> (await ring.boundingBox())!.width).toBeGreaterThan(old);
 await expect(ring).toHaveAttribute('r','3000');await expect(ring).toBeVisible();
 expect(await page.evaluate(()=>document.documentElement.scrollWidth>innerWidth)).toBe(false);
 if(process.env.QA_SCREENSHOT_DIR)await page.screenshot({path:`${process.env.QA_SCREENSHOT_DIR}/movement-mobile.png`});
});

test('据点操作按钮与30米实际边界一致',async({page})=>{
 const state=fixture();state.player.x+=3000;await mount(page,state);
 await page.locator(`[data-portal-id="${city.portals[0].id}"]`).click();
 await expect(page.getByRole('button',{name:/^Hack/})).toBeEnabled();
 state.player.x+=1;state.world.seq='2';state.serverTime=Date.now();await page.reload();
 await expect(page.getByRole('button',{name:/^Hack/})).toBeDisabled();
});
