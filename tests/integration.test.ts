import {randomUUID} from 'node:crypto';
import {afterAll, afterEach, beforeAll, beforeEach, describe, expect, it} from 'vitest';
import {Pool} from 'pg';
import type {FastifyInstance} from 'fastify';
import WebSocket from 'ws';
import {buildApp} from '../server/app.js';
import {migrate} from '../server/migrate.js';
import {Store} from '../server/store.js';
import {RULES} from '../shared/rules.js';
import {BETA_MAP} from '../shared/map.js';
import type {Field, Link, Player, Portal, Snapshot} from '../shared/types.js';

const databaseUrl = process.env.TEST_DATABASE_URL;
const suite = databaseUrl ? describe : describe.skip;
const origin = 'http://localhost:8080';
const secret = 'integration-test-session-secret-at-least-32-characters';
const adminPassword = 'integration-test-admin-password';
let pool: Pool;
let app: FastifyInstance;

function isolatedDatabase(url: string): void {
  const parsed = new URL(url);
  const name = decodeURIComponent(parsed.pathname.slice(1));
  if (!/(^|[_-])test([_-]|$)/i.test(name)) {
    throw new Error('TEST_DATABASE_URL 必须指向库名包含独立 test 段的专用数据库；禁止清理其他数据库');
  }
}

async function reset(): Promise<void> {
  const client = await pool.connect();
  try {
    const exists=(await client.query("SELECT to_regclass('public.worlds') AS name")).rows[0].name;
    if(exists)await client.query('TRUNCATE worlds,portals,accounts,sessions,command_receipts,outbox,checkpoints,seasons,applications,complaints,admin_audit,admin_sessions,markers,alerts,operations RESTART IDENTITY CASCADE');
  } finally { client.release(); }
  await migrate(databaseUrl!);
}

type Session = {cookie: string; csrf: string; recoveryCode: string; player: Player};
async function createSession(): Promise<Session> {
  const response = await app.inject({method: 'POST', url: '/api/anonymous-sessions',
    headers: {origin}, payload: {requestId: randomUUID()}});
  expect(response.statusCode, response.body).toBe(200);
  const body = response.json();
  const cookie = response.headers['set-cookie'];
  expect(cookie).toBeTruthy();
  return {cookie: String(Array.isArray(cookie) ? cookie[0] : cookie).split(';')[0], csrf: body.csrfToken,
    recoveryCode: body.recoveryCode, player: body.player};
}
async function snapshot(session: Session): Promise<Snapshot> {
  const response = await app.inject({method: 'GET', url: '/api/world/snapshot', headers: {cookie: session.cookie}});
  expect(response.statusCode, response.body).toBe(200);
  return response.json() as Snapshot;
}
function envelope(state: Snapshot, payload: Record<string, unknown>, requestId = randomUUID(), targetVersion?: number) {
  return {requestId, seasonId: state.world.season.id, rulesetVersion: state.rulesetVersion,
    mapVersion: state.mapVersion, playerVersion: state.player.version, commandEpoch: state.commandEpoch,
    ...(targetVersion === undefined ? {} : {targetVersion}), payload};
}
async function command(session: Session, url: string, body: Record<string, unknown>) {
  return app.inject({method: 'POST', url, headers: {origin, cookie: session.cookie, 'x-csrf-token': session.csrf}, payload: body});
}
async function chooseFaction(session: Session, faction: 'red'|'green'|'blue' = 'red') {
  const state = await snapshot(session);
  const response = await command(session, '/api/faction', envelope(state, {faction}));
  expect(response.statusCode, response.body).toBe(200);
  return response.json();
}
async function setPlayer(session: Session, change: (player: Player) => void): Promise<void> {
  const player = structuredClone((await pool.query('SELECT state FROM accounts WHERE id=$1', [session.player.id])).rows[0].state) as Player;
  change(player);
  await pool.query('UPDATE accounts SET state=$1 WHERE id=$2', [player, player.id]);
}
async function replacePortalScene(portals: Portal[], links: Link[] = [], fields: Field[] = []): Promise<void> {
  await app.close();
  await pool.query('DELETE FROM portals');
  for (const portal of portals) await pool.query('INSERT INTO portals(id,state) VALUES($1,$2)',[portal.id,portal]);
  const state=(await pool.query('SELECT state FROM worlds WHERE id=1')).rows[0].state;
  await pool.query('UPDATE worlds SET state=$1 WHERE id=1',[{...state,links,fields}]);
  app=await buildApp({databaseUrl:databaseUrl!,secret,adminPassword,origin,cookieSecure:false,port:0,host:'127.0.0.1'});
}
function fullPortal(id:string,x:number,y:number,faction:'red'|'green',owner:string):Portal {
  return {id,name:id,districtId:'D-01',x,y,faction,version:1,mods:[null,null,null,null],
    resonators:Array.from({length:8},(_,slot)=>({level:8,energy:6000,owner,x,y,
      generation:`${id}-${slot}`,nextDecayAt:Date.now()+86_400_000}))};
}

suite('独立 PostgreSQL 的 HTTP 集成验收', () => {
  beforeAll(async () => {
    isolatedDatabase(databaseUrl!);
    pool = new Pool({connectionString: databaseUrl});
    const current = (await pool.query('SELECT current_database() AS name')).rows[0].name as string;
    if (!/(^|[_-])test([_-]|$)/i.test(current)) throw new Error('实际连接的数据库不是独立测试库');
  });
  beforeEach(async () => {
    await reset();
    app = await buildApp({databaseUrl: databaseUrl!, secret, adminPassword, origin,
      cookieSecure: false, port: 0, host: '127.0.0.1'});
  });
  afterEach(async () => { await app?.close(); });
  afterAll(async () => { await pool?.end(); });

  it('匿名身份只发一次新手包；另一个会话不能查询其命令收据', async () => {
    const alice = await createSession(), bob = await createSession();
    const first = await chooseFaction(alice);
    const second = await snapshot(alice);
    expect(second.player.id).toBe(alice.player.id);
    expect(second.player.inventory).toEqual(first.player.inventory);
    const receipt = await app.inject({method: 'GET', url: `/api/commands/${first.requestId}`, headers: {cookie: bob.cookie}});
    expect(receipt.statusCode).toBe(404);
    expect((await snapshot(bob)).player.id).not.toBe(alice.player.id);
  });

  it('升级礼包与占领战报原子持久化；并发重放与重启不会重复发放', async () => {
    const owner=await createSession(), observer=await createSession();await chooseFaction(owner);
    const portal=BETA_MAP.portals[0];
    await setPlayer(owner,p=>{p.x=portal.x;p.y=portal.y;p.inventory=[{type:'resonator',level:1,quantity:500}]});
    const before=await snapshot(owner);
    const body=envelope(before,{level:1},randomUUID(),before.world.portals[portal.id].version);
    const path=`/api/portals/${portal.id}/deploy`;
    const replies=await Promise.all([command(owner,path,body),command(owner,path,body)]);
    for(const reply of replies)expect(reply.statusCode,reply.body).toBe(200);
    expect(replies[0].json()).toEqual(replies[1].json());
    expect(replies[0].json().result.levelRewards).toHaveLength(1);
    const after=await snapshot(owner);
    expect(after.player.inventory.reduce((n,i)=>n+i.quantity,0)).toBe(549);
    expect(after.world.battleEvents?.filter(e=>e.kind==='capture')).toHaveLength(1);
    expect((await snapshot(observer)).world.battleEvents).toEqual(after.world.battleEvents);
    await app.close();
    app=await buildApp({databaseUrl:databaseUrl!,secret,adminPassword,origin,cookieSecure:false,port:0,host:'127.0.0.1'});
    const replay=await command(owner,path,body);expect(replay.statusCode,replay.body).toBe(200);
    expect(replay.json()).toEqual(replies[0].json());
    const restored=await snapshot(owner);
    expect(restored.player.inventory).toEqual(after.player.inventory);
    expect(restored.world.battleEvents).toEqual(after.world.battleEvents);
  });

  it('初次建号响应丢失后，同请求和已落地 Cookie 可复得原恢复码', async () => {
    const requestId=randomUUID();
    const first=await app.inject({method:'POST',url:'/api/anonymous-sessions',headers:{origin},payload:{requestId}});
    expect(first.statusCode,first.body).toBe(200);
    const cookie=String(first.headers['set-cookie']).split(';')[0];
    const repeated=await app.inject({method:'POST',url:'/api/anonymous-sessions',
      headers:{origin,cookie},payload:{requestId}});
    expect(repeated.statusCode,repeated.body).toBe(200);
    expect(repeated.json().player.id).toBe(first.json().player.id);
    expect(repeated.json().recoveryCode).toBe(first.json().recoveryCode);
    expect(Number((await pool.query('SELECT count(*)::integer AS n FROM accounts')).rows[0].n)).toBe(1);
  });

  it('新账号按已持久化出生计数分散到不同出生点', async () => {
    const first=await createSession(),second=await createSession();
    expect([first.player.x,first.player.y]).not.toEqual([second.player.x,second.player.y]);
    const counts=(await pool.query("SELECT value FROM operations WHERE name='birthCounts'")).rows[0].value as Record<string,number[]>;
    expect(Object.values(counts).filter(times=>times.length>0)).toHaveLength(2);
    expect(Object.values(counts).reduce((sum,times)=>sum+times.length,0)).toBe(2);
  });

  it('真实 HTTP 从三次 Hack 和部署走到首场，成本与持久世界一致', async () => {
    const session=await createSession();await chooseFaction(session);
    const district=BETA_MAP.districts[0].id;
    const [a,b,c]=BETA_MAP.portals.filter(portal=>portal.districtId===district&&portal.role==='core');
    expect([a,b,c]).toHaveLength(3);
    let cost=0;
    for(const portal of [a,b,c]) {
      await setPlayer(session,player=>{player.x=portal.x;player.y=portal.y;player.movement=null});
      let state=await snapshot(session);
      const hacked=await command(session,`/api/portals/${portal.id}/hack`,envelope(state,{},randomUUID(),state.world.portals[portal.id].version));
      expect(hacked.statusCode,hacked.body).toBe(200);
      cost+=Number(hacked.json().result.cost);
      state=await snapshot(session);
      const deployed=await command(session,`/api/portals/${portal.id}/deploy-all`,envelope(state,{level:1},randomUUID(),state.world.portals[portal.id].version));
      expect(deployed.statusCode,deployed.body).toBe(200);
      expect(deployed.json().result.entries).toHaveLength(8);
      cost+=Number(deployed.json().result.cost);
    }
    for(const [index,[originPortal,destinationPortal]] of [[b,a],[c,b],[a,c]].entries()) {
      if(index)await new Promise(resolve=>setTimeout(resolve,2100));
      await setPlayer(session,player=>{player.x=originPortal.x;player.y=originPortal.y;player.movement=null});
      const state=await snapshot(session);
      const linked=await command(session,'/api/links',envelope(state,
        {originId:originPortal.id,destinationId:destinationPortal.id},randomUUID(),state.world.portals[originPortal.id].version));
      expect(linked.statusCode,linked.body).toBe(200);
      cost+=Number(linked.json().result.cost);
    }
    const final=await snapshot(session);
    expect(cost).toBe(2100);
    expect(final.world.links).toHaveLength(3);
    expect(final.world.fields).toHaveLength(1);
    expect(final.player.tutorial.first_field_at).toBeDefined();
    const persisted=(await pool.query('SELECT state FROM worlds WHERE id=1')).rows[0].state;
    expect(persisted.fields).toHaveLength(1);
  });

  it('恢复码使用后轮换，旧恢复码和旧会话都失效', async () => {
    const session=await createSession();
    const requestId=randomUUID();
    const recovered=await app.inject({method:'POST',url:'/api/account/recover',headers:{origin},payload:{recoveryCode:session.recoveryCode,requestId}});
    expect(recovered.statusCode,recovered.body).toBe(200);
    const body=recovered.json() as {player:Player;recoveryCode:string};
    expect(body.player.id).toBe(session.player.id);
    expect(body.recoveryCode).not.toBe(session.recoveryCode);
    const replay=await app.inject({method:'POST',url:'/api/account/recover',headers:{origin},payload:{recoveryCode:session.recoveryCode,requestId}});
    expect(replay.statusCode,replay.body).toBe(200);
    expect(replay.json().recoveryCode).toBe(body.recoveryCode);
    expect(String(replay.headers['set-cookie']).split(';')[0]).toBe(String(recovered.headers['set-cookie']).split(';')[0]);
    const oldCode=await app.inject({method:'POST',url:'/api/account/recover',headers:{origin},payload:{recoveryCode:session.recoveryCode,requestId:randomUUID()}});
    expect(oldCode.statusCode).toBeGreaterThanOrEqual(400);
    expect(oldCode.json().error.code).toBe('RECOVERY_INVALID');
    const oldSession=await app.inject({method:'GET',url:'/api/world/snapshot',headers:{cookie:session.cookie}});
    expect(oldSession.statusCode).toBe(401);
    const newCookie=String(recovered.headers['set-cookie']).split(';')[0];
    const current=await app.inject({method:'GET',url:'/api/world/snapshot',headers:{cookie:newCookie}});
    expect(current.statusCode,current.body).toBe(200);
    expect(current.json().player.id).toBe(session.player.id);
  });

  it('同账号多会话可被统一撤销，登出也立即失效', async () => {
    const requestId=randomUUID();
    const first=await app.inject({method:'POST',url:'/api/anonymous-sessions',headers:{origin},payload:{requestId}});
    const second=await app.inject({method:'POST',url:'/api/anonymous-sessions',headers:{origin},payload:{requestId}});
    expect(first.statusCode).toBe(200);expect(second.statusCode).toBe(200);
    expect(first.json().player.id).toBe(second.json().player.id);
    const firstCookie=String(first.headers['set-cookie']).split(';')[0];
    const secondCookie=String(second.headers['set-cookie']).split(';')[0];
    const revoke=await app.inject({method:'POST',url:'/api/account/revoke-sessions',
      headers:{origin,cookie:firstCookie,'x-csrf-token':first.json().csrfToken}});
    expect(revoke.statusCode).toBeLessThan(300);
    for(const cookie of [firstCookie,secondCookie]){
      const old=await app.inject({method:'GET',url:'/api/world/snapshot',headers:{cookie}});
      expect(old.statusCode).toBe(401);
    }
    const fresh=await createSession();
    const logout=await app.inject({method:'POST',url:'/api/account/logout',
      headers:{origin,cookie:fresh.cookie,'x-csrf-token':fresh.csrf}});
    expect(logout.statusCode).toBeLessThan(300);
    expect((await app.inject({method:'GET',url:'/api/world/snapshot',headers:{cookie:fresh.cookie}})).statusCode).toBe(401);
  });

  it('同请求同正文重放收据，换正文拒绝，且只扣一次资源', async () => {
    const session = await createSession(); await chooseFaction(session);
    const state = await snapshot(session), id = randomUUID();
    const body = envelope(state, {x: state.player.x + 1000, y: state.player.y}, id);
    const first = await command(session, '/api/moves', body);
    expect(first.statusCode, first.body).toBe(200);
    const again = await command(session, '/api/moves', body);
    expect(again.statusCode, again.body).toBe(200);
    expect(again.json()).toEqual(first.json());
    const changed = await command(session, '/api/moves', {...body, payload: {...body.payload, x: state.player.x + 2000}});
    expect(changed.statusCode).toBeGreaterThanOrEqual(400);
    expect(changed.json().error.code).toBe('REQUEST_ID_REUSED');
  });

  it('N=499 并发 Hack 只允许一次完整奖励，库存超过 500 后拒绝', async () => {
    const session = await createSession(); await chooseFaction(session);
    const state = await snapshot(session);
    const portal = Object.values(state.world.portals)[0];
    expect(portal).toBeDefined();
    await setPlayer(session, player => {player.inventory = [{type:'resonator',level:1,quantity:499}]; player.x=portal.x;player.y=portal.y;});
    const prepared = await snapshot(session);
    const [first, second] = await Promise.all([
      command(session, `/api/portals/${portal.id}/hack`, envelope(prepared, {}, randomUUID(), portal.version)),
      command(session, `/api/portals/${portal.id}/hack`, envelope(prepared, {}, randomUUID(), portal.version)),
    ]);
    expect([first.statusCode, second.statusCode].filter(code => code === 200)).toHaveLength(1);
    const after = await snapshot(session);
    const winning = first.statusCode === 200 ? first.json() : second.json();
    expect(after.player.inventory.reduce((sum, item) => sum + item.quantity, 0)).toBe(winning.result.inventoryCount);
    expect(winning.result.inventoryCount).toBeGreaterThan(500);
    expect(after.player.inventory.find(item => item.type === 'key' && item.portalId === portal.id)?.quantity).toBe(1);
    const retry = await command(session, `/api/portals/${portal.id}/hack`, envelope(after, {}, randomUUID(), portal.version));
    expect(retry.statusCode).toBeGreaterThanOrEqual(400);
    expect(retry.json().error.code).toBe('INVENTORY_FULL');
  });

  it('充能遇到已替换的脚 generation 拒绝且不扣 XM', async () => {
    const session=await createSession();await chooseFaction(session);
    const portal=Object.values((await snapshot(session)).world.portals)[0];
    await app.close();
    const occupied={...portal,faction:'red' as const,version:portal.version+1,
      resonators:[{level:1,energy:988,owner:session.player.id,x:portal.x,y:portal.y,
        generation:'new-generation',nextDecayAt:Date.now()+86_400_000},...Array(7).fill(null)]};
    await pool.query('UPDATE portals SET state=$1 WHERE id=$2',[occupied,portal.id]);
    await setPlayer(session,player=>{player.x=portal.x;player.y=portal.y;player.ap=14000;player.xm=1000});
    app=await buildApp({databaseUrl:databaseUrl!,secret,adminPassword,origin,cookieSecure:false,port:0,host:'127.0.0.1'});
    const state=await snapshot(session);
    const stale=await command(session,`/api/portals/${portal.id}/recharge`,envelope(state,
      {slot:0,amount:1000,generation:'old-generation'},randomUUID(),occupied.version));
    expect(stale.statusCode).toBeGreaterThanOrEqual(400);
    expect(stale.json().error.code).toBe('GENERATION_CHANGED');
    const unchanged=await snapshot(session);
    expect(unchanged.player.xm).toBe(1000);
    expect(unchanged.world.portals[portal.id].resonators[0]?.energy).toBe(988);
    const valid=await command(session,`/api/portals/${portal.id}/recharge`,envelope(unchanged,
      {slot:0,amount:1000,generation:'new-generation'},randomUUID(),occupied.version));
    expect(valid.statusCode,valid.body).toBe(200);
    expect((await snapshot(session)).world.portals[portal.id].resonators[0]?.energy).toBe(1000);
  });

  it('数据库写入失败时世界、账号和收据均不泄漏暂存结果', async () => {
    const session = await createSession(); await chooseFaction(session);
    const before = await snapshot(session);
    const body = envelope(before, {x: before.player.x + 1000, y: before.player.y});
    await pool.query('ALTER TABLE outbox ADD CONSTRAINT integration_force_rollback CHECK (false) NOT VALID');
    try {
      const failed = await command(session, '/api/moves', body);
      expect(failed.statusCode).toBeGreaterThanOrEqual(400);
      const after = await snapshot(session);
      expect(after.world.seq).toBe(before.world.seq);
      expect(after.player.movement).toEqual(before.player.movement);
      const receipt = await pool.query('SELECT 1 FROM command_receipts WHERE actor=$1 AND request_id=$2', [session.player.id, body.requestId]);
      expect(receipt.rowCount).toBe(0);
    } finally {
      await pool.query('ALTER TABLE outbox DROP CONSTRAINT integration_force_rollback');
    }
  });

  it('缺少 CSRF 或跨源的写入都被拒绝', async () => {
    const session = await createSession();
    const state = await snapshot(session);
    const body = envelope(state, {faction: 'red'});
    const noCsrf = await app.inject({method:'POST',url:'/api/faction',headers:{origin,cookie:session.cookie},payload:body});
    expect(noCsrf.statusCode).toBe(403);
    const wrongOrigin = await app.inject({method:'POST',url:'/api/faction',headers:{origin:'https://evil.example',cookie:session.cookie,'x-csrf-token':session.csrf},payload:body});
    expect(wrongOrigin.statusCode).toBe(403);
    expect((await snapshot(session)).player.faction).toBeNull();
  });

  it('关闭的 Glyph、蓄力、交易与聊天入口逐项拒绝且不改状态', async () => {
    expect(RULES.features.glyph).toBe(false);
    expect(RULES.features.chargeAttack).toBe(false);
    expect(RULES.features.trade).toBe(false);
    expect(RULES.features.chat).toBe(false);
    const session=await createSession();await chooseFaction(session);
    const before=await snapshot(session),portal=Object.values(before.world.portals)[0];
    for(const path of ['/api/attacks/charge',`/api/portals/${portal.id}/glyph/start`,
      `/api/glyph/${randomUUID()}/submit`,'/api/trades','/api/chat']){
      const response=await command(session,path,envelope(before,{level:1,portalId:portal.id}));
      expect(response.statusCode,response.body).toBe(409);
      expect(response.json().error.code).toBe('FEATURE_DISABLED');
    }
    const after=await snapshot(session);
    expect(after.world.seq).toBe(before.world.seq);
    expect(after.player.inventory).toEqual(before.player.inventory);
    expect(after.player.xm).toBe(before.player.xm);
  });

  it('一条边闭合两场，其中一场被包含时整笔连线原子拒绝', async () => {
    const user=await createSession();await chooseFaction(user);
    const locations:[string,number,number,'red'|'green'][]=[
      ['A',500_000,500_000,'red'],['B',620_000,500_000,'red'],
      ['C',500_000,620_000,'red'],['D',500_000,380_000,'red'],
      ['E',450_000,490_000,'green'],['F',800_000,490_000,'green'],['G',450_000,800_000,'green']];
    const portals=locations.map(([id,x,y,faction])=>fullPortal(id,x,y,faction,user.player.id));
    const links:Link[]=[['A','C'],['B','C'],['A','D'],['B','D']].map(([origin,destination])=>({
      id:[origin,destination].sort().join('|'),origin,destination,faction:'red',owner:user.player.id}));
    const oldField:Field={id:'E|F|G',vertices:['E','F','G'],links:[],faction:'green',owner:user.player.id,mu:100,large:true};
    await replacePortalScene(portals,links,[oldField]);
    await setPlayer(user,player=>{player.x=500_000;player.y=500_000;player.ap=240_000;player.xm=10_000;
      player.inventory=[{type:'key',level:1,portalId:'B',quantity:1}]});
    // 再次启动以让执行器从夹具读取账号；预览和正式写入都必须看同一冻结场景。
    await app.close();
    app=await buildApp({databaseUrl:databaseUrl!,secret,adminPassword,origin,cookieSecure:false,port:0,host:'127.0.0.1'});
    const before=await snapshot(user),requestId=randomUUID();
    const failed=await command(user,'/api/links',envelope(before,{originId:'A',destinationId:'B'},requestId,before.world.portals.A.version));
    expect(failed.statusCode).toBeGreaterThanOrEqual(400);
    expect(failed.json().error.code).toBe('FIELD_NESTING');
    const after=await snapshot(user);
    expect(after.world.seq).toBe(before.world.seq);
    expect(after.world.links).toEqual(before.world.links);
    expect(after.world.fields).toEqual(before.world.fields);
    expect(after.player.inventory).toEqual(before.player.inventory);
    expect(after.player.xm).toBe(before.player.xm);
    expect(after.player.ap).toBe(before.player.ap);
    expect(Number((await pool.query('SELECT count(*)::integer AS n FROM command_receipts WHERE actor=$1 AND request_id=$2',
      [user.player.id,requestId])).rows[0].n)).toBe(0);
  });

  it('两名玩家并发建交叉线时仅一条提交，败者不扣目标 Key 和 XM', async () => {
    const first=await createSession(),second=await createSession();
    await chooseFaction(first);await chooseFaction(second);
    await replacePortalScene([
      fullPortal('A',500_000,500_000,'red',first.player.id),fullPortal('B',600_000,600_000,'red',first.player.id),
      fullPortal('C',600_000,500_000,'red',second.player.id),fullPortal('D',500_000,600_000,'red',second.player.id)]);
    await setPlayer(first,player=>{player.x=500_000;player.y=500_000;player.ap=240_000;player.xm=10_000;
      player.inventory=[{type:'key',level:1,portalId:'B',quantity:1}]});
    await setPlayer(second,player=>{player.x=600_000;player.y=500_000;player.ap=240_000;player.xm=10_000;
      player.inventory=[{type:'key',level:1,portalId:'D',quantity:1}]});
    await app.close();
    app=await buildApp({databaseUrl:databaseUrl!,secret,adminPassword,origin,cookieSecure:false,port:0,host:'127.0.0.1'});
    const [beforeFirst,beforeSecond]=await Promise.all([snapshot(first),snapshot(second)]);
    const [one,two]=await Promise.all([
      command(first,'/api/links',envelope(beforeFirst,{originId:'A',destinationId:'B'},randomUUID(),beforeFirst.world.portals.A.version)),
      command(second,'/api/links',envelope(beforeSecond,{originId:'C',destinationId:'D'},randomUUID(),beforeSecond.world.portals.C.version))]);
    expect([one.statusCode,two.statusCode].filter(code=>code===200)).toHaveLength(1);
    const rejected=one.statusCode===200?two:one;
    expect(rejected.json().error.code).toBe('LINK_CROSSING');
    const [afterFirst,afterSecond]=await Promise.all([snapshot(first),snapshot(second)]);
    expect(afterFirst.world.links).toHaveLength(1);
    expect(afterFirst.world.links).toEqual(afterSecond.world.links);
    expect(afterFirst.world.fields).toHaveLength(0);
    for(const [won,before,after,key] of [
      [one.statusCode===200,beforeFirst,afterFirst,'B'],[two.statusCode===200,beforeSecond,afterSecond,'D']
    ] as const){
      expect(after.player.xm).toBe(before.player.xm-(won?RULES.linkXmCost:0));
      expect(after.player.inventory.find(item=>item.type==='key'&&item.portalId===key)?.quantity??0).toBe(won?0:1);
    }
  });

  it('重启后命令收据与账号状态仍可读取', async () => {
    const session = await createSession(); const receipt = await chooseFaction(session);
    const before = await snapshot(session);
    await app.close();
    app = await buildApp({databaseUrl:databaseUrl!,secret,adminPassword,origin,cookieSecure:false,port:0,host:'127.0.0.1'});
    const after = await snapshot(session);
    expect(after.player.id).toBe(before.player.id);
    expect(after.player.inventory).toEqual(before.player.inventory);
    const recovered = await app.inject({method:'GET',url:`/api/commands/${receipt.requestId}`,headers:{cookie:session.cookie}});
    expect(recovered.statusCode,recovered.body).toBe(200);
    expect(recovered.json()).toEqual(receipt);
  });

  it('新执行器接管后旧进程不能继续写入', async () => {
    const session = await createSession();
    const before = await snapshot(session);
    const successor = new Store(databaseUrl!, secret);
    try {
      await successor.start();
      const old = await command(session, '/api/faction', envelope(before, {faction:'red'}));
      expect(old.statusCode).toBeGreaterThanOrEqual(400);
      expect(old.json().error.code).toBe('WORLD_RECOVERING');
      const persisted = (await pool.query('SELECT state FROM accounts WHERE id=$1',[session.player.id])).rows[0].state as Player;
      expect(persisted.faction).toBeNull();
    } finally { await successor.close(); }
  });

  it('COMMIT 已生效但回包中断时按收据恢复，不重新执行', async () => {
    const actor = (await createSession()).player.id;
    const executor = new Store(databaseUrl!, secret);
    const id = randomUUID();
    try {
      await executor.start();
      let injected = false;
      const receipt = {actor,id,digest:'commit-response-lost'};
      const result = await executor.transaction(async tx => {
        tx.world.announcement = '已持久提交';
        const query = tx.client.query.bind(tx.client);
        const client = tx.client as unknown as {query:(sql:string,values?:unknown[])=>Promise<unknown>};
        client.query = async (sql,values) => {
          const answer = await query(sql,values);
          if(sql === 'COMMIT' && !injected) {injected=true;throw new Error('模拟提交回包中断')}
          return answer;
        };
        return {marker:id};
      },receipt);
      expect(injected).toBe(true);
      expect(result).toEqual({marker:id});
      const seq = (await pool.query('SELECT seq::text FROM worlds WHERE id=1')).rows[0].seq as string;
      const replay = await executor.transaction(async()=>{throw new Error('重复请求不应进入业务回调')},receipt);
      expect(replay).toEqual(result);
      expect((await pool.query('SELECT seq::text FROM worlds WHERE id=1')).rows[0].seq).toBe(seq);
      expect((await executor.snapshot()).announcement).toBe('已持久提交');
    } finally {await executor.close()}
  });

  it('未知提交且首次收据查询失败时，队列先恢复已提交世界再允许后续写入', async () => {
    const actor=(await createSession()).player.id;
    await app.close();
    const executor=new Store(databaseUrl!,secret),requestId=randomUUID();
    const receipt={actor,id:requestId,digest:'unknown-commit-first-receipt-query-fails'};
    const originalPoolQuery=executor.pool.query.bind(executor.pool);
    const originalConnect=executor.pool.connect.bind(executor.pool);
    const patchedPool=executor.pool as unknown as {
      query:(sql:string,values?:unknown[])=>Promise<unknown>;
      connect:()=>Promise<unknown>;
    };
    let failReceiptOnce=true,blockRecovery=false,callbackEntered=false;
    try {
      await executor.start();
      patchedPool.query=async(sql,values)=>{
        if(failReceiptOnce&&sql.startsWith('SELECT result FROM command_receipts')){
          failReceiptOnce=false;throw new Error('模拟首次收据查询失败');
        }
        return originalPoolQuery(sql,values);
      };
      await expect(executor.transaction(async tx=>{
        tx.world.announcement='已提交但回包未知';
        const original=tx.client.query.bind(tx.client);
        const client=tx.client as unknown as {query:(sql:string,values?:unknown[])=>Promise<unknown>};
        client.query=async(sql,values)=>{
          const result=await original(sql,values);
          if(sql==='COMMIT')throw new Error('模拟 COMMIT 成功但回包丢失');
          return result;
        };
        return {marker:requestId};
      },receipt)).rejects.toMatchObject({code:'RESULT_UNKNOWN'});
      expect(executor.ready).toBe(false);
      const afterUnknown=(await pool.query('SELECT seq::text,state FROM worlds WHERE id=1')).rows[0];
      expect(afterUnknown.state.announcement).toBe('已提交但回包未知');
      expect(Number((await pool.query('SELECT count(*)::integer AS n FROM command_receipts WHERE actor=$1 AND request_id=$2',
        [actor,requestId])).rows[0].n)).toBe(1);

      blockRecovery=true;
      patchedPool.connect=async()=>{
        if(blockRecovery)throw new Error('模拟数据库暂不可查询');
        return originalConnect();
      };
      await expect(executor.transaction(async()=>{callbackEntered=true;return null})).rejects.toMatchObject({code:'WORLD_RECOVERING'});
      expect(callbackEntered).toBe(false);
      expect(executor.ready).toBe(false);
      expect((await pool.query('SELECT seq::text FROM worlds WHERE id=1')).rows[0].seq).toBe(afterUnknown.seq);

      blockRecovery=false;
      const next=await executor.transaction(async tx=>{
        callbackEntered=true;
        expect(tx.world.announcement).toBe('已提交但回包未知');
        tx.world.announcement='恢复后继续执行';
        return {continued:true};
      });
      expect(next).toEqual({continued:true});
      expect(callbackEntered).toBe(true);
      expect(executor.ready).toBe(true);
      expect((await pool.query('SELECT seq::text FROM worlds WHERE id=1')).rows[0].seq)
        .toBe((BigInt(afterUnknown.seq)+1n).toString());
      expect(await executor.transaction(async()=>{throw new Error('已提交请求不可重做')},receipt)).toEqual({marker:requestId});
    } finally {
      patchedPool.query=originalPoolQuery;
      patchedPool.connect=originalConnect;
      await executor.close();
      app=await buildApp({databaseUrl:databaseUrl!,secret,adminPassword,origin,cookieSecure:false,port:0,host:'127.0.0.1'});
    }
  });

  it('管理员并发审批同一申请只生成一个中立 PO，且玩家不能访问后台', async () => {
    const session=await createSession(); await chooseFaction(session);
    await setPlayer(session,player=>{player.ap=240000});
    const state=await snapshot(session);
    const applied=await command(session,'/api/po-applications',envelope(state,
      {name:'内测新增点',description:'用于并发审批验收的新据点',x:15000,y:15000}));
    expect(applied.statusCode,applied.body).toBe(200);
    const applicationId=applied.json().result.application.id as string;
    const denied=await app.inject({method:'GET',url:'/api/admin/state',headers:{cookie:session.cookie}});
    expect(denied.statusCode).toBe(401);
    const login=await app.inject({method:'POST',url:'/api/admin/login',headers:{origin},payload:{password:adminPassword}});
    expect(login.statusCode,login.body).toBe(200);
    const admin=login.json() as {csrfToken:string;commandEpoch:string};
    const cookie=String(login.headers['set-cookie']).split(';')[0];
    const review=(requestId:string)=>app.inject({method:'POST',url:`/api/admin/po-applications/${applicationId}/review`,
      headers:{origin,cookie,'x-csrf-token':admin.csrfToken},
      payload:{requestId,commandEpoch:admin.commandEpoch,payload:{decision:'approve',reason:'地图位置已复核'}}});
    const firstId=randomUUID(),secondId=randomUUID();
    const [first,second]=await Promise.all([review(firstId),review(secondId)]);
    expect([first.statusCode,second.statusCode].filter(code=>code===200)).toHaveLength(1);
    const winner=first.statusCode===200?first:second;
    const winnerId=first.statusCode===200?firstId:secondId;
    const replay=await review(winnerId);
    expect(replay.statusCode,replay.body).toBe(200);
    expect(replay.json()).toEqual(winner.json());
    expect((await snapshot(session)).world.portals[`PO-N-${applicationId}`]).toMatchObject({faction:null});
    expect(Number((await pool.query("SELECT count(*)::integer AS n FROM portals WHERE id=$1",[`PO-N-${applicationId}`])).rows[0].n)).toBe(1);
    expect(Number((await pool.query("SELECT count(*)::integer AS n FROM admin_audit WHERE action='review-po' AND detail->>'target'=$1",[applicationId])).rows[0].n)).toBe(1);

    const other=await createSession();await chooseFaction(other);
    await setPlayer(other,player=>{player.ap=240000});
    const otherState=await snapshot(other);
    const otherApplied=await command(other,'/api/po-applications',envelope(otherState,
      {name:'另一个申请点',description:'用于审核请求标识隔离测试',x:415000,y:15000}));
    expect(otherApplied.statusCode,otherApplied.body).toBe(200);
    const otherId=otherApplied.json().result.application.id as string;
    const reused=await app.inject({method:'POST',url:`/api/admin/po-applications/${otherId}/review`,
      headers:{origin,cookie,'x-csrf-token':admin.csrfToken},
      payload:{requestId:winnerId,commandEpoch:admin.commandEpoch,payload:{decision:'approve',reason:'地图位置已复核'}}});
    expect(reused.statusCode).toBeGreaterThanOrEqual(400);
    expect(reused.json().error.code).toBe('REQUEST_ID_REUSED');
    expect((await snapshot(other)).world.portals[`PO-N-${otherId}`]).toBeUndefined();
  });

  it('停机跨周后按历史检查点结算，并保留玩家资产', async () => {
    const session=await createSession();await chooseFaction(session);
    const before=await snapshot(session);
    const portal=Object.values(before.world.portals)[0];
    const oldInventory=before.player.inventory;
    await app.close();
    const endAt=Date.now()-1000,startAt=endAt-RULES.seasonMs;
    const state={...before.world,logicalAt:startAt,season:{id:1,startAt,endAt},nextCheckpoint:startAt+RULES.checkpointMs};
    const {portals:unused,...worldState}=state;
    await pool.query('UPDATE worlds SET state=$1 WHERE id=1',[worldState]);
    const occupied={...portal,faction:'red' as const,version:portal.version+1,
      resonators:[{level:1,energy:150,owner:session.player.id,x:portal.x,y:portal.y,
        generation:'cross-season-test',nextDecayAt:endAt},...Array(7).fill(null)]};
    await pool.query('UPDATE portals SET state=$1 WHERE id=$2',[occupied,portal.id]);
    app=await buildApp({databaseUrl:databaseUrl!,secret,adminPassword,origin,cookieSecure:false,port:0,host:'127.0.0.1'});
    const after=await snapshot(session);
    expect(after.world.season.id).toBe(2);
    expect(after.world.portals[portal.id].faction).toBeNull();
    expect(after.world.scores.red).toBe(0);
    expect(after.player.inventory).toEqual(oldInventory);
    const archive=(await pool.query('SELECT scores FROM seasons WHERE id=1')).rows[0].scores;
    expect(archive.red).toBe(20160);
    expect(Number((await pool.query('SELECT count(*)::integer AS n FROM checkpoints WHERE season_id=1')).rows[0].n)).toBe(2016);
  });

  it('WebSocket 阵营告警只到授权账号，公共流不含私有库存', async () => {
    const alice=await createSession(),bob=await createSession();
    await chooseFaction(alice,'red');await chooseFaction(bob,'blue');
    const portal=Object.values((await snapshot(alice)).world.portals)[0];
    await app.close();
    await pool.query('UPDATE portals SET state=$1 WHERE id=$2',[{...portal,faction:'red',version:portal.version+1,
      resonators:[{level:1,energy:1000,owner:alice.player.id,x:portal.x,y:portal.y,
        generation:'alert-target',nextDecayAt:Date.now()+86_400_000},...Array(7).fill(null)]},portal.id]);
    await setPlayer(bob,player=>{player.x=portal.x;player.y=portal.y;player.xm=1000;
      player.inventory.push({type:'pulse',level:1,quantity:1})});
    app=await buildApp({databaseUrl:databaseUrl!,secret,adminPassword,origin,cookieSecure:false,port:0,host:'127.0.0.1'});
    const address=await app.listen({host:'127.0.0.1',port:0});
    const socket=(session:Session)=>new WebSocket(address.replace(/^http/,'ws')+'/api/events',
      {headers:{Origin:origin,Cookie:session.cookie}});
    const a=socket(alice),b=socket(bob);
    const aMessages:Record<string,unknown>[]=[],bMessages:Record<string,unknown>[]=[];
    a.on('message',data=>aMessages.push(JSON.parse(String(data))));
    b.on('message',data=>bMessages.push(JSON.parse(String(data))));
    try {
      await Promise.all([a,b].map(ws=>new Promise<void>((resolve,reject)=>{ws.once('open',resolve);ws.once('error',reject)})));
      const readyAt=Date.now()+2000;
      while((!aMessages.some(message=>message.type==='resync')||!bMessages.some(message=>message.type==='resync'))&&Date.now()<readyAt)
        await new Promise(resolve=>setTimeout(resolve,10));
      expect(aMessages.some(message=>message.type==='resync')).toBe(true);
      expect(bMessages.some(message=>message.type==='resync')).toBe(true);
      const state=await snapshot(bob);
      const attacked=await command(bob,'/api/attacks',envelope(state,{level:1}));
      expect(attacked.statusCode,attacked.body).toBe(200);
      await new Promise(resolve=>setTimeout(resolve,650));
      expect(aMessages.some(message=>message.type==='alert'&&message.portalId===portal.id)).toBe(true);
      expect(bMessages.some(message=>message.type==='alert')).toBe(false);
      expect([...aMessages,...bMessages].some(message=>JSON.stringify(message).includes('inventory'))).toBe(false);
    } finally {a.terminate();b.terminate()}
  });

  it('两个待审申请同址时审批重验距离，只允许一个入图', async () => {
    const users=await Promise.all([createSession(),createSession()]);
    const ids:string[]=[];
    for(const user of users) {
      await chooseFaction(user);
      await setPlayer(user,player=>{player.ap=240000});
      const state=await snapshot(user);
      const response=await command(user,'/api/po-applications',envelope(state,
        {name:'待审同址点',description:'审核阶段再次检查已批准点间距',x:15000,y:15000}));
      expect(response.statusCode,response.body).toBe(200);
      ids.push(response.json().result.application.id);
    }
    const login=await app.inject({method:'POST',url:'/api/admin/login',headers:{origin},payload:{password:adminPassword}});
    const admin=login.json() as {csrfToken:string;commandEpoch:string};
    const cookie=String(login.headers['set-cookie']).split(';')[0];
    const review=(id:string)=>app.inject({method:'POST',url:`/api/admin/po-applications/${id}/review`,
      headers:{origin,cookie,'x-csrf-token':admin.csrfToken},
      payload:{requestId:randomUUID(),commandEpoch:admin.commandEpoch,payload:{decision:'approve',reason:'核对坐标及间距'}}});
    const first=await review(ids[0]),second=await review(ids[1]);
    expect(first.statusCode,first.body).toBe(200);
    expect(second.statusCode).toBeGreaterThanOrEqual(400);
    expect(second.json().error.code).toBe('PO_SPACING');
    expect(Number((await pool.query("SELECT count(*)::integer AS n FROM portals WHERE id LIKE 'PO-N-%'")).rows[0].n)).toBe(1);
  });

  it('管理员独立鉴权和 CSRF；临时限制可以显式解除并审计', async () => {
    const user=await createSession();
    const login=await app.inject({method:'POST',url:'/api/admin/login',headers:{origin},payload:{password:adminPassword}});
    expect(login.statusCode,login.body).toBe(200);
    const admin=login.json() as {csrfToken:string;commandEpoch:string};
    const cookie=String(login.headers['set-cookie']).split(';')[0];
    const restriction={requestId:randomUUID(),commandEpoch:admin.commandEpoch,
      payload:{accountId:user.player.id,until:Date.now()+60_000,reason:'自动化验收限制'}};
    const missingCsrf=await app.inject({method:'POST',url:'/api/admin/restrict',headers:{origin,cookie},payload:restriction});
    expect(missingCsrf.statusCode).toBe(403);
    const wrongCookie=await app.inject({method:'POST',url:'/api/admin/restrict',
      headers:{origin,cookie:user.cookie,'x-csrf-token':admin.csrfToken},payload:restriction});
    expect(wrongCookie.statusCode).toBe(401);
    const restrict=await app.inject({method:'POST',url:'/api/admin/restrict',
      headers:{origin,cookie,'x-csrf-token':admin.csrfToken},payload:restriction});
    expect(restrict.statusCode,restrict.body).toBe(200);
    const release=await app.inject({method:'POST',url:'/api/admin/restrict',
      headers:{origin,cookie,'x-csrf-token':admin.csrfToken},
      payload:{requestId:randomUUID(),commandEpoch:admin.commandEpoch,
        payload:{accountId:user.player.id,until:0,reason:'验收解除限制'}}});
    expect(release.statusCode,release.body).toBe(200);
    expect((await snapshot(user)).player.restrictedUntil).toBe(0);
    expect(Number((await pool.query("SELECT count(*)::integer AS n FROM admin_audit WHERE action='restrict' AND detail->>'target'=$1",[user.player.id])).rows[0].n)).toBe(2);
  });
});

if (!databaseUrl) console.warn('集成测试跳过：未提供 TEST_DATABASE_URL（必须是独立 test 数据库）');
