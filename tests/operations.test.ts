import {randomUUID} from 'node:crypto';
import {afterAll,afterEach,beforeAll,beforeEach,describe,expect,it} from 'vitest';
import {Pool} from 'pg';
import type {FastifyInstance} from 'fastify';
import {buildApp} from '../server/app.js';
import {migrate} from '../server/migrate.js';
import type {Player,Snapshot} from '../shared/types.js';

const databaseUrl=process.env.OPERATIONS_TEST_DATABASE_URL;
const suite=databaseUrl?describe:describe.skip;
const origin='http://localhost:8080';
const secret='operations-integration-secret-at-least-32-characters';
const adminPassword='operations-test-admin-password';
let pool:Pool,app:FastifyInstance;
type Session={id:string;cookie:string;csrf:string};
type Admin={cookie:string;csrf:string;epoch:string};

function assertTestDatabase(url:string) {
  const name=decodeURIComponent(new URL(url).pathname.slice(1));
  if(!/(^|[_-])test([_-]|$)/i.test(name))throw new Error('OPERATIONS_TEST_DATABASE_URL 必须是独立 test 数据库');
}
async function reset() {
  const exists=(await pool.query("SELECT to_regclass('public.worlds') AS name")).rows[0].name;
  if(exists)await pool.query('TRUNCATE worlds,portals,accounts,sessions,command_receipts,outbox,checkpoints,seasons,applications,complaints,admin_audit,admin_sessions,markers,alerts,operations RESTART IDENTITY CASCADE');
  await migrate(databaseUrl!);
}
async function session():Promise<Session> {
  const response=await app.inject({method:'POST',url:'/api/anonymous-sessions',headers:{origin},payload:{requestId:randomUUID()}});
  expect(response.statusCode,response.body).toBe(200);
  return {id:response.json().player.id,cookie:String(response.headers['set-cookie']).split(';')[0],csrf:response.json().csrfToken};
}
async function snapshot(s:Session):Promise<Snapshot> {
  const response=await app.inject({method:'GET',url:'/api/world/snapshot',headers:{cookie:s.cookie}});
  expect(response.statusCode,response.body).toBe(200);
  return response.json() as Snapshot;
}
async function playerCommand(s:Session,url:string,payload:Record<string,unknown>,requestId=randomUUID()) {
  const state=await snapshot(s);
  return app.inject({method:'POST',url,headers:{origin,cookie:s.cookie,'x-csrf-token':s.csrf},payload:{requestId,
    commandEpoch:state.commandEpoch,seasonId:state.world.season.id,rulesetVersion:state.rulesetVersion,
    mapVersion:state.mapVersion,playerVersion:state.player.version,payload}});
}
async function admin():Promise<Admin> {
  const response=await app.inject({method:'POST',url:'/api/admin/login',headers:{origin},payload:{password:adminPassword}});
  expect(response.statusCode,response.body).toBe(200);
  return {cookie:String(response.headers['set-cookie']).split(';')[0],csrf:response.json().csrfToken,epoch:response.json().commandEpoch};
}
async function adminCommand(s:Admin,url:string,payload:Record<string,unknown>,requestId=randomUUID()) {
  return app.inject({method:'POST',url,headers:{origin,cookie:s.cookie,'x-csrf-token':s.csrf},payload:{requestId,commandEpoch:s.epoch,payload}});
}
async function levelEight(s:Session) {
  const state=(await pool.query('SELECT state FROM accounts WHERE id=$1',[s.id])).rows[0].state as Player;
  state.ap=240_000;
  await pool.query('UPDATE accounts SET state=$1 WHERE id=$2',[state,s.id]);
}
async function apply(s:Session,x:number,y:number,name:string) {
  return playerCommand(s,'/api/po-applications',{name,description:'一处可供玩家访问的公共空间',x,y});
}

suite('独立 PostgreSQL 的运营与阵营功能',()=>{
  beforeAll(async()=>{
    assertTestDatabase(databaseUrl!);
    pool=new Pool({connectionString:databaseUrl});
    const name=(await pool.query('SELECT current_database() AS name')).rows[0].name as string;
    if(!/(^|[_-])test([_-]|$)/i.test(name))throw new Error('实际连接的数据库不是独立测试库');
  });
  beforeEach(async()=>{
    await reset();
    app=await buildApp({databaseUrl:databaseUrl!,secret,adminPassword,origin,cookieSecure:false,port:0,host:'127.0.0.1'});
  });
  afterEach(async()=>{await app?.close()});
  afterAll(async()=>{await pool?.end()});

  it('同位置待审可并存，批准时重验间距；原请求重放不重复建点或审计',async()=>{
    const a=await session(),b=await session();await levelEight(a);await levelEight(b);
    const first=await apply(a,20_000,20_000,'测试新点甲');
    const second=await apply(b,20_000,20_000,'测试新点乙');
    expect(first.statusCode,first.body).toBe(200);expect(second.statusCode,second.body).toBe(200);
    const firstId=first.json().result.application.id as string,secondId=second.json().result.application.id as string;
    const operator=await admin(),requestId=randomUUID(),payload={decision:'approve',reason:'地形与点距检查通过'};
    const approved=await adminCommand(operator,`/api/admin/po-applications/${firstId}/review`,payload,requestId);
    expect(approved.statusCode,approved.body).toBe(200);
    const replay=await adminCommand(operator,`/api/admin/po-applications/${firstId}/review`,payload,requestId);
    expect(replay.statusCode,replay.body).toBe(200);
    expect(replay.json()).toEqual(approved.json());
    const reused=await adminCommand(operator,`/api/admin/po-applications/${secondId}/review`,payload,requestId);
    expect(reused.statusCode).toBe(409);expect(reused.json().error.code).toBe('REQUEST_ID_REUSED');
    const conflict=await adminCommand(operator,`/api/admin/po-applications/${secondId}/review`,payload);
    expect(conflict.statusCode).toBe(409);expect(conflict.json().error.code).toBe('PO_SPACING');
    const portals=await pool.query("SELECT id FROM portals WHERE id LIKE 'PO-N-%'");
    expect(portals.rowCount).toBe(1);
    const audits=await pool.query("SELECT id FROM admin_audit WHERE action='review-po'");
    expect(audits.rowCount).toBe(1);
  });

  it('新 PO 间距严格 5 米：499 厘米审批拒绝，500 厘米审批通过',async()=>{
    const a=await session(),near=await session(),edge=await session();
    await levelEight(a);await levelEight(near);await levelEight(edge);
    const first=await apply(a,20_000,20_000,'间距原点');
    const tooNear=await apply(near,20_499,20_000,'相距不足');
    const exact=await apply(edge,20_500,20_000,'相距达标');
    for(const response of [first,tooNear,exact])expect(response.statusCode,response.body).toBe(200);
    const operator=await admin();
    const review=async(id:string)=>adminCommand(operator,`/api/admin/po-applications/${id}/review`,{decision:'approve',reason:'复核冻结地图点距'});
    expect((await review(first.json().result.application.id)).statusCode).toBe(200);
    const rejected=await review(tooNear.json().result.application.id);
    expect(rejected.statusCode).toBe(409);
    expect(rejected.json().error.code).toBe('PO_SPACING');
    const allowed=await review(exact.json().result.application.id);
    expect(allowed.statusCode,allowed.body).toBe(200);
    expect((await pool.query("SELECT id FROM portals WHERE id LIKE 'PO-N-%'")).rowCount).toBe(2);
    const submitNear=await session(),submitEdge=await session();
    await levelEight(submitNear);await levelEight(submitEdge);
    const rejectedSubmission=await apply(submitNear,20_000,20_499,'申请过近');
    expect(rejectedSubmission.statusCode).toBe(409);
    expect(rejectedSubmission.json().error.code).toBe('PO_SPACING');
    const allowedSubmission=await apply(submitEdge,20_000,20_500,'申请边界');
    expect(allowedSubmission.statusCode,allowedSubmission.body).toBe(200);
  });

  it('申请资格及城区/全城名额计入待审，并允许本人撤回释放名额',async()=>{
    const novice=await session(),candidate=await session();
    const denied=await apply(novice,20_000,20_000,'尚未解锁');
    expect(denied.json().error.code).toBe('LEVEL_REQUIRED');
    await levelEight(candidate);
    const first=await apply(candidate,20_000,20_000,'准备撤回');
    expect(first.statusCode,first.body).toBe(200);
    const id=first.json().result.application.id as string;
    const withdrawn=await playerCommand(candidate,`/api/po-applications/${id}/withdraw`,{});
    expect(withdrawn.statusCode,withdrawn.body).toBe(200);
    const repeat=await playerCommand(candidate,`/api/po-applications/${id}/withdraw`,{});
    expect(repeat.json().error.code).toBe('APPLICATION_CLOSED');
    // 七个待审占满 D-01 剩余容量；它们不参与点距检测。
    for(let i=0;i<7;i++)await pool.query('INSERT INTO applications(id,account_id,state,created_at) VALUES($1,$2,$3,$4)',
      [randomUUID(),novice.id,{name:`配额${i}`,description:'测试容量',districtId:'D-01',status:'pending',x:20_000,y:20_000},Date.now()]);
    const full=await apply(candidate,50_000,20_000,'城区满额');
    expect(full.json().error.code).toBe('PO_CAPACITY');
    for(let i=0;i<93;i++)await pool.query('INSERT INTO applications(id,account_id,state,created_at) VALUES($1,$2,$3,$4)',
      [randomUUID(),novice.id,{name:`全城配额${i}`,description:'测试容量',districtId:'D-03',status:'pending',x:820_000,y:20_000},Date.now()]);
    const cityFull=await apply(candidate,420_000,20_000,'全城满额');
    expect(cityFull.json().error.code).toBe('PO_CAPACITY');
  });

  it('后台会话独立，补偿按自然恢复结算且留审计；限制可解除，公告可查看',async()=>{
    const player=await session(),operator=await admin();
    const notAdmin=await app.inject({method:'GET',url:'/api/admin/state',headers:{cookie:player.cookie}});
    expect(notAdmin.statusCode).toBe(401);
    const state=(await pool.query('SELECT state FROM accounts WHERE id=$1',[player.id])).rows[0].state as Player;
    state.xm=100;state.energyAt=Date.now()-10_000;
    await pool.query('UPDATE accounts SET state=$1 WHERE id=$2',[state,player.id]);
    const compensation=await adminCommand(operator,'/api/admin/compensate',{accountId:player.id,xm:200,reason:'修复已核实资源缺口'});
    expect(compensation.statusCode,compensation.body).toBe(200);
    expect(compensation.json().result.credited).toBe(200);
    const after=await snapshot(player);
    expect(after.player.xm).toBeGreaterThanOrEqual(350);
    const restricted=await adminCommand(operator,'/api/admin/restrict',{accountId:player.id,until:Date.now()+3_600_000,reason:'临时限制违规操作'});
    expect(restricted.statusCode,restricted.body).toBe(200);
    const cleared=await adminCommand(operator,'/api/admin/restrict',{accountId:player.id,until:0,reason:'核查结束解除限制'});
    expect(cleared.statusCode,cleared.body).toBe(200);
    expect((await snapshot(player)).player.restrictedUntil).toBe(0);
    const announcement=await adminCommand(operator,'/api/admin/announcement',{text:'今晚例行维护',reason:'发布运营通知'});
    expect(announcement.statusCode,announcement.body).toBe(200);
    expect((await snapshot(player)).world.announcement).toBe('今晚例行维护');
    const audit=(await pool.query('SELECT action,reason FROM admin_audit ORDER BY id')).rows;
    expect(audit.map(row=>row.action)).toEqual(['compensate','restrict','restrict','announcement']);
  });

  it('阵营标记仅同阵营可见，受击告警只返回本人记录，投诉可独立处理',async()=>{
    const red=await session(),redMate=await session(),blue=await session();
    for(const [s,faction] of [[red,'red'],[redMate,'red'],[blue,'blue']] as const){
      const result=await playerCommand(s,'/api/faction',{faction});expect(result.statusCode,result.body).toBe(200);
    }
    const portalId=Object.keys((await snapshot(red)).world.portals)[0];
    const marker=await playerCommand(red,'/api/markers',{portalId});
    expect(marker.statusCode,marker.body).toBe(200);
    const read=async(s:Session)=>(await app.inject({method:'GET',url:'/api/social',headers:{cookie:s.cookie}})).json();
    expect((await read(redMate)).markers).toHaveLength(1);
    expect((await read(blue)).markers).toHaveLength(0);
    await pool.query('INSERT INTO alerts(account_id,portal_id,first_at,last_at) VALUES($1,$2,$3,$3)',[red.id,portalId,Date.now()]);
    expect((await read(red)).alerts).toHaveLength(1);
    expect((await read(redMate)).alerts).toHaveLength(0);
    const complaint=await playerCommand(red,'/api/complaints',{description:'这个据点说明与实际地点不一致',portalId});
    expect(complaint.statusCode,complaint.body).toBe(200);
    const operator=await admin();
    const reviewed=await adminCommand(operator,`/api/admin/complaints/${complaint.json().result.complaint.id}/review`,{decision:'resolve',reason:'已核对并记录'});
    expect(reviewed.statusCode,reviewed.body).toBe(200);
    expect(reviewed.json().result.complaint.status).toBe('resolved');
  });
});
