import {randomUUID} from 'node:crypto';
import type {FastifyInstance, FastifyRequest, FastifyReply} from 'fastify';
import {BETA_MAP} from '../shared/map.js';
import {RULES, levelForAp, xmCap} from '../shared/rules.js';
import {GeometryError, validateNewPortalLocation} from '../shared/geometry.js';
import {advanceWorld, GameError, refreshPlayer} from '../shared/engine.js';
import type {Player, Portal} from '../shared/types.js';
import {digest} from './config.js';
import type {Store, Transaction} from './store.js';

interface Identity {id:string;token:string}
export interface OperationsAuth {
  authenticate(req:FastifyRequest, admin?:boolean):Promise<Identity>;
  protect(req:FastifyRequest, admin?:boolean):Identity|Promise<Identity>;
  verifyEpoch(id:string,value:string):boolean|void;
  csrf(token:string):string;
  adminLogin(req:FastifyRequest,reply:FastifyReply,password:string):unknown|Promise<unknown>;
  epoch(id:string):string;
}
interface Envelope {requestId:string;commandEpoch:string;seasonId?:number;rulesetVersion?:string;mapVersion?:string;playerVersion?:number;payload:Record<string,unknown>}
const UUID=/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

function fail(code:string, message:string):never {throw new GameError(code,message)}
function bodyOf(req:FastifyRequest):Envelope {
  const body=req.body as Partial<Envelope>|undefined;
  if (!body || typeof body.requestId!=='string' || !UUID.test(body.requestId)
    || typeof body.commandEpoch!=='string' || !body.payload || typeof body.payload!=='object' || Array.isArray(body.payload)) {
    fail('INVALID_REQUEST','请求格式无效');
  }
  return body as Envelope;
}
function string(value:unknown,max:number,min=1):string {
  if(typeof value!=='string')fail('INVALID_REQUEST','文本格式无效');
  const result=value.trim();
  if([...result].length<min||[...result].length>max||/[\u0000-\u001f\u007f]/u.test(result))fail('INVALID_REQUEST','文本长度或内容无效');
  return result;
}
function integer(value:unknown):number {
  if(typeof value!=='number'||!Number.isSafeInteger(value))fail('INVALID_REQUEST','坐标或数字无效');
  return value;
}
function uuid(value:unknown):string {
  if(typeof value!=='string'||!UUID.test(value))fail('INVALID_REQUEST','标识格式无效');
  return value;
}
function verify(auth:OperationsAuth,id:string,epoch:string):void {
  if(auth.verifyEpoch(id,epoch)===false)fail('SESSION_CHANGED','会话已更新，请刷新');
}
async function identity(req:FastifyRequest,auth:OperationsAuth,admin=false):Promise<Identity> {
  return auth.protect(req,admin);
}
function validLocation(approved:Portal[],point:{x:number;y:number},districtId:string):void {
  try {validateNewPortalLocation(BETA_MAP,approved,point,districtId)}
  catch(error) {if(error instanceof GeometryError)fail(error.code,'申请点位不符合冻结地图的间距或地形要求');throw error}
}
async function readPlayer(tx:Transaction,id:string):Promise<Player> {
  const row=(await tx.client.query('SELECT state FROM accounts WHERE id=$1 FOR UPDATE',[id])).rows[0];
  if(!row)fail('UNAUTHORIZED','身份不存在');
  return refreshPlayer(row.state as Player,tx.now);
}
async function playerWrite<T>(req:FastifyRequest,store:Store,auth:OperationsAuth,action:string,work:(tx:Transaction,player:Player,payload:Record<string,unknown>)=>Promise<T>) {
  const who=await identity(req,auth), body=bodyOf(req);
  const receipt={actor:who.id,id:body.requestId,digest:digest({action,params:req.params,body})};
  return store.transaction(async tx=>{
    await auth.authenticate(req);
    verify(auth,who.id,body.commandEpoch);
    const player=await readPlayer(tx,who.id);
    if(player.restrictedUntil>tx.now)fail('ACCOUNT_RESTRICTED','账号暂时受到限制');
    await store.persistDue(tx,advanceWorld(tx.world,tx.now));
    if(tx.world.maintenance)fail('WORLD_RECOVERING','世界维护中');
    if(body.seasonId!==tx.world.season.id)fail('SEASON_CHANGED','赛季已更新，请刷新');
    if(body.rulesetVersion!==RULES.version||body.mapVersion!==BETA_MAP.version)fail('RULESET_CHANGED','规则版本已更新');
    if(body.playerVersion!==player.version)fail('VERSION_CONFLICT','个人状态已更新，请刷新');
    const result=await work(tx,player,body.payload);
    player.version++;
    await tx.client.query('UPDATE accounts SET state=$1 WHERE id=$2',[player,who.id]);
    return {requestId:body.requestId,committedSeq:tx.seq,serverTime:tx.now,result,player};
  },receipt);
}
async function audit(tx:Transaction,action:string,target:string,reason:string,actor:string,detail:Record<string,unknown>={}) {
  await tx.client.query('INSERT INTO admin_audit(actor,action,reason,detail,seq,created_at) VALUES($1,$2,$3,$4,$5,$6)',
    [actor,action,reason,{target,...detail},tx.seq,tx.now]);
}
async function adminWrite<T>(req:FastifyRequest,store:Store,auth:OperationsAuth,action:string,work:(tx:Transaction,payload:Record<string,unknown>,reason:string,actor:string)=>Promise<T>) {
  const who=await identity(req,auth,true), body=bodyOf(req);
  const receipt={actor:`admin:${who.id}`,id:body.requestId,digest:digest({action,params:req.params,body})};
  return store.transaction(async tx=>{
    await auth.authenticate(req,true);
    verify(auth,'admin',body.commandEpoch);
    await store.persistDue(tx,advanceWorld(tx.world,tx.now));
    const reason=string(body.payload.reason,RULES.operations.reasonMaxLength,RULES.operations.reasonMinLength);
    const result=await work(tx,body.payload,reason,who.id);
    return {requestId:body.requestId,committedSeq:tx.seq,serverTime:tx.now,result};
  },receipt);
}
function applicationRow(row:{id:string;account_id:string;state:Record<string,unknown>;created_at:string}) {
  const createdAt=Number(row.created_at);
  const status=row.state.status==='pending'&&createdAt+RULES.newPortals.applicationTtlMs<=Date.now()?'expired':row.state.status;
  return {id:row.id,accountId:row.account_id,...row.state,status,createdAt};
}
function complaintRow(row:{id:string;account_id:string;state:Record<string,unknown>;created_at:string}) {
  return {id:row.id,accountId:row.account_id,...row.state,createdAt:Number(row.created_at)};
}

export function registerOperations(app:FastifyInstance,store:Store,auth:OperationsAuth):void {
  app.get('/api/social',async req=>{
    const who=await auth.authenticate(req), player=await store.player(who.id);
    const now=Date.now();
    const [markers,alerts]=await Promise.all([
      player.faction?store.pool.query('SELECT id,account_id,portal_id,expires_at FROM markers WHERE faction=$1 AND expires_at>$2 ORDER BY expires_at DESC LIMIT $3',[player.faction,now,RULES.social.markerMaxPerFaction]):Promise.resolve({rows:[]}),
      store.pool.query('SELECT portal_id,count,last_at FROM alerts WHERE account_id=$1 ORDER BY last_at DESC LIMIT 50',[who.id]),
    ]);
    return {markers:markers.rows.map(row=>({id:row.id,accountId:row.account_id,portalId:row.portal_id,expiresAt:Number(row.expires_at)})),
      alerts:alerts.rows.map(row=>({portalId:row.portal_id,count:row.count,at:Number(row.last_at)}))};
  });
  app.get('/api/po-applications/mine',async req=>{
    const who=await auth.authenticate(req);
    const rows=await store.pool.query('SELECT id,account_id,state,created_at FROM applications WHERE account_id=$1 ORDER BY created_at DESC LIMIT 100',[who.id]);
    return {applications:rows.rows.map(applicationRow)};
  });
  app.post('/api/po-applications',req=>playerWrite(req,store,auth,'apply-po',async(tx,player,payload)=>{
    if(levelForAp(player.ap)<8)fail('LEVEL_REQUIRED','达到 L8 后才能申请新据点');
    const name=string(payload.name,RULES.newPortals.nameMaxLength,RULES.newPortals.nameMinLength);
    const description=string(payload.description,RULES.newPortals.descriptionMaxLength,RULES.newPortals.descriptionMinLength);
    const x=integer(payload.x), y=integer(payload.y);
    const district=BETA_MAP.districts.find(item=>x>=item.bounds[0]&&x<item.bounds[2]&&y>=item.bounds[1]&&y<item.bounds[3]);
    if(!district)fail('PO_DISTRICT','坐标不在可申请城区');
    const history=await tx.client.query('SELECT state,created_at FROM applications WHERE account_id=$1 AND created_at>$2',[player.id,tx.now-RULES.newPortals.submissionWindowMs]);
    if(history.rows.length>=RULES.newPortals.maxSubmissionsPerWindow)fail('APPLICATION_LIMIT','七天内最多提交两次申请');
    if(history.rows.filter(row=>row.state.status==='pending'&&Number(row.created_at)+RULES.newPortals.applicationTtlMs>tx.now).length>=RULES.newPortals.maxPendingPerAccount)fail('APPLICATION_PENDING','当前已有待审申请');
    const pending=await tx.client.query("SELECT state FROM applications WHERE state->>'status'='pending' AND created_at>$1",[tx.now-RULES.newPortals.applicationTtlMs]);
    if(Object.keys(tx.world.portals).length+pending.rows.length>=RULES.newPortals.maxTotal ||
      Object.values(tx.world.portals).filter(portal=>portal.districtId===district.id).length+pending.rows.filter(row=>row.state.districtId===district.id).length>=RULES.newPortals.maxPerDistrict) fail('PO_CAPACITY','当前城区或全城申请名额已满');
    validLocation(Object.values(tx.world.portals),{x,y},district.id);
    const id=randomUUID(),state={name,description,x,y,districtId:district.id,status:'pending',expiresAt:tx.now+RULES.newPortals.applicationTtlMs};
    await tx.client.query('INSERT INTO applications(id,account_id,state,created_at) VALUES($1,$2,$3,$4)',[id,player.id,state,tx.now]);
    return {application:{id,accountId:player.id,...state}};
  }));
  app.post<{Params:{id:string}}>('/api/po-applications/:id/withdraw',req=>playerWrite(req,store,auth,'withdraw-po',async(tx,player)=>{
    const id=uuid(req.params.id);
    const row=(await tx.client.query('SELECT account_id,state,created_at FROM applications WHERE id=$1 FOR UPDATE',[id])).rows[0];
    if(!row||row.account_id!==player.id)fail('NOT_FOUND','申请不存在');
    if(row.state.status!=='pending'||Number(row.created_at)+RULES.newPortals.applicationTtlMs<=tx.now)fail('APPLICATION_CLOSED','申请已经处理或过期');
    const state={...row.state,status:'withdrawn',withdrawnAt:tx.now};
    await tx.client.query('UPDATE applications SET state=$1 WHERE id=$2',[state,id]);
    return {application:{id,...state}};
  }));
  app.post('/api/markers',req=>playerWrite(req,store,auth,'marker',async(tx,player,payload)=>{
    const portalId=string(payload.portalId,100),portal=tx.world.portals[portalId];
    if(!portal)fail('PORTAL_NOT_FOUND','据点不存在');
    if(!player.faction)fail('FACTION_REQUIRED','请先选择阵营');
    const recent=await tx.client.query('SELECT 1 FROM markers WHERE account_id=$1 AND expires_at>$2 LIMIT 1',[player.id,tx.now+RULES.social.markerTtlMs-RULES.social.markerCooldownMs]);
    if(recent.rowCount)fail('MARKER_COOLDOWN','十秒后才能再次标记');
    await tx.client.query('DELETE FROM markers WHERE expires_at<=$1',[tx.now]);
    const active=await tx.client.query('SELECT id FROM markers WHERE faction=$1 ORDER BY expires_at ASC',[player.faction]);
    for(const row of active.rows.slice(0,Math.max(0,active.rows.length-(RULES.social.markerMaxPerFaction-1))))await tx.client.query('DELETE FROM markers WHERE id=$1',[row.id]);
    const id=randomUUID(),expiresAt=tx.now+RULES.social.markerTtlMs;
    await tx.client.query('INSERT INTO markers(id,faction,account_id,portal_id,expires_at) VALUES($1,$2,$3,$4,$5)',[id,player.faction,player.id,portalId,expiresAt]);
    return {marker:{id,portalId,expiresAt}};
  }));
  app.post('/api/complaints',req=>playerWrite(req,store,auth,'complaint',async(tx,player,payload)=>{
    const description=string(payload.description,RULES.social.complaintMaxLength,RULES.social.complaintMinLength);
    const portalId=payload.portalId===null||payload.portalId===undefined?null:string(payload.portalId,100);
    if(portalId&&!tx.world.portals[portalId])fail('PORTAL_NOT_FOUND','据点不存在');
    const id=randomUUID(),state={description,portalId,status:'pending'};
    await tx.client.query('INSERT INTO complaints(id,account_id,state,created_at) VALUES($1,$2,$3,$4)',[id,player.id,state,tx.now]);
    return {complaint:{id,...state}};
  }));
  app.post('/api/items/key/protect',req=>playerWrite(req,store,auth,'protect-key',async(_tx,player,payload)=>{
    const portalId=string(payload.portalId,100);
    if(typeof payload.protected!=='boolean')fail('INVALID_REQUEST','保护状态无效');
    const keys=player.inventory.filter(item=>item.type==='key'&&item.portalId===portalId&&item.quantity>0);
    if(!keys.length)fail('ITEM_NOT_FOUND','没有此据点 Key');
    for(const key of keys)key.protected=payload.protected;
    return {portalId,protected:payload.protected};
  }));

  app.post('/api/admin/login',async(req,reply)=>auth.adminLogin(req,reply,string((req.body as {password?:unknown})?.password,100,1)));
  app.get('/api/admin/state',async req=>{
    const who=await auth.authenticate(req,true);
    const [applications,complaints,auditRows,accounts,world]=await Promise.all([
      store.pool.query('SELECT id,account_id,state,created_at FROM applications ORDER BY created_at DESC LIMIT 200'),
      store.pool.query('SELECT id,account_id,state,created_at FROM complaints ORDER BY created_at DESC LIMIT 200'),
      store.pool.query('SELECT actor,action,reason,detail,seq,created_at FROM admin_audit ORDER BY id DESC LIMIT 200'),
      store.pool.query('SELECT id,state FROM accounts ORDER BY created_at DESC LIMIT 200'),store.snapshot(),
    ]);
    return {applications:applications.rows.map(applicationRow),
      complaints:complaints.rows.map(complaintRow),
      audit:auditRows.rows.map(row=>({actor:row.actor,action:row.action,reason:row.reason,target:row.detail.target,seq:String(row.seq),at:Number(row.created_at)})),
      accounts:accounts.rows.map(row=>({id:row.id,name:row.state.name,faction:row.state.faction,level:levelForAp(row.state.ap),restrictedUntil:row.state.restrictedUntil})),
      world:{seq:world.seq,season:world.season,scores:world.scores,maintenance:world.maintenance,announcement:world.announcement,nextCheckpoint:world.nextCheckpoint},
      publicsummary:{portalCount:Object.keys(world.portals).length,linkCount:world.links.length,fieldCount:world.fields.length},
      rules:RULES,csrfToken:auth.csrf(who.token),commandEpoch:auth.epoch('admin')};
  });
  app.get<{Params:{id:string}}>('/api/admin/commands/:id',async req=>{
    const who=await auth.authenticate(req,true);
    uuid(req.params.id);
    const row=(await store.pool.query('SELECT result FROM command_receipts WHERE actor=$1 AND request_id=$2',[`admin:${who.id}`,req.params.id])).rows[0];
    if(!row)fail('NOT_FOUND','尚未找到已提交结果，可使用原请求重试');
    return row.result;
  });
  app.post<{Params:{id:string}}>('/api/admin/po-applications/:id/review',req=>adminWrite(req,store,auth,'review-po',async(tx,payload,reason,actor)=>{
    const id=uuid(req.params.id),decision=payload.decision;
    if(decision!=='approve'&&decision!=='reject')fail('INVALID_REQUEST','审核决定无效');
    const row=(await tx.client.query('SELECT account_id,state,created_at FROM applications WHERE id=$1 FOR UPDATE',[id])).rows[0];
    if(!row)fail('NOT_FOUND','申请不存在');
    if(row.state.status!=='pending')fail('APPLICATION_CLOSED','申请已经处理');
    if(Number(row.created_at)+RULES.newPortals.applicationTtlMs<=tx.now)fail('APPLICATION_EXPIRED','申请已过期');
    let portalId:string|undefined;
    if(decision==='approve'){
      const {x,y,districtId,name}=row.state;
      validLocation(Object.values(tx.world.portals),{x,y},districtId);
      if(Object.keys(tx.world.portals).length>=RULES.newPortals.maxTotal || Object.values(tx.world.portals).filter(portal=>portal.districtId===districtId).length>=RULES.newPortals.maxPerDistrict)fail('PO_CAPACITY','城区或全城据点已达上限');
      portalId=`PO-N-${id}`;
      const portal:Portal={id:portalId,name,districtId,x,y,faction:null,version:0,resonators:Array(8).fill(null),mods:Array(4).fill(null)};
      tx.world.portals[portalId]=portal;
    }
    const state={...row.state,status:decision==='approve'?'approved':'rejected',reviewedAt:tx.now,portalId,reviewReason:reason};
    await tx.client.query('UPDATE applications SET state=$1 WHERE id=$2',[state,id]);
    await audit(tx,'review-po',id,reason,actor,{decision,portalId});
    return {application:{id,...state}};
  }));
  app.post<{Params:{id:string}}>('/api/admin/complaints/:id/review',req=>adminWrite(req,store,auth,'review-complaint',async(tx,payload,reason,actor)=>{
    const decision=payload.decision;
    if(decision!=='resolve'&&decision!=='reject')fail('INVALID_REQUEST','审核决定无效');
    const id=uuid(req.params.id);
    const row=(await tx.client.query('SELECT state FROM complaints WHERE id=$1 FOR UPDATE',[id])).rows[0];
    if(!row)fail('NOT_FOUND','投诉不存在');
    if(row.state.status!=='pending')fail('COMPLAINT_CLOSED','投诉已经处理');
    const state={...row.state,status:decision==='resolve'?'resolved':'rejected',reviewedAt:tx.now,reviewReason:reason};
    await tx.client.query('UPDATE complaints SET state=$1 WHERE id=$2',[state,id]);
    await audit(tx,'review-complaint',id,reason,actor,{decision});
    return {complaint:{id,...state}};
  }));
  app.post('/api/admin/restrict',req=>adminWrite(req,store,auth,'restrict',async(tx,payload,reason,actor)=>{
    const accountId=uuid(payload.accountId),until=integer(payload.until);
    if(until!==0&&(until<tx.now||until>tx.now+RULES.operations.restrictionMaxMs))fail('INVALID_REQUEST','限制期限须在未来30天内，0 表示解除');
    const player=await readPlayer(tx,accountId),before=player.restrictedUntil;
    player.restrictedUntil=until;player.version++;
    await tx.client.query('UPDATE accounts SET state=$1 WHERE id=$2',[player,accountId]);
    await audit(tx,'restrict',accountId,reason,actor,{before,until});
    return {accountId,restrictedUntil:until};
  }));
  app.post('/api/admin/maintenance',req=>adminWrite(req,store,auth,'maintenance',async(tx,payload,reason,actor)=>{
    if(typeof payload.enabled!=='boolean')fail('INVALID_REQUEST','维护状态无效');
    const before=tx.world.maintenance;tx.world.maintenance=payload.enabled;
    await audit(tx,'maintenance','world',reason,actor,{before,enabled:payload.enabled});
    return {maintenance:payload.enabled};
  }));
  app.post('/api/admin/announcement',req=>adminWrite(req,store,auth,'announcement',async(tx,payload,reason,actor)=>{
    const value=payload.text===null||payload.text===''?'':string(payload.text,RULES.operations.announcementMaxLength);
    const before=tx.world.announcement;tx.world.announcement=value;
    await audit(tx,'announcement','world',reason,actor,{before,text:value});
    return {announcement:value};
  }));
  app.post('/api/admin/compensate',req=>adminWrite(req,store,auth,'compensate',async(tx,payload,reason,actor)=>{
    const accountId=uuid(payload.accountId),amount=integer(payload.xm);
    if(amount<1||amount>RULES.operations.compensationMaxXm)fail('INVALID_REQUEST','补偿量须为1至10000 XM');
    const player=await readPlayer(tx,accountId),before=player.xm;
    player.xm=Math.min(xmCap(levelForAp(player.ap)),player.xm+amount);player.version++;
    await tx.client.query('UPDATE accounts SET state=$1 WHERE id=$2',[player,accountId]);
    await audit(tx,'compensate',accountId,reason,actor,{before,requested:amount,credited:player.xm-before,after:player.xm});
    return {accountId,credited:player.xm-before,xm:player.xm};
  }));
}
