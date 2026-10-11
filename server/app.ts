import Fastify,{type FastifyRequest} from 'fastify';
import cookie from '@fastify/cookie';
import websocket from '@fastify/websocket';
import type {WebSocket} from 'ws';
import {randomUUID} from 'node:crypto';
import {Store} from './store.js';
import {Auth} from './auth.js';
import type {Config} from './config.js';
import {digest,isAllowedOrigin} from './config.js';
import {BETA_MAP} from '../shared/map.js';
import {RULES} from '../shared/rules.js';
import {applyCommand,GameError} from '../shared/engine.js';
import type {CommandEnvelope,GameCommand} from '../shared/types.js';
import {registerOperations} from './operations.js';

const uuid=/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
function envelope(request:FastifyRequest):CommandEnvelope {
 const b=request.body as CommandEnvelope|undefined;
 if(!b||!uuid.test(b.requestId)||!Number.isSafeInteger(b.seasonId)||!Number.isSafeInteger(b.playerVersion)||typeof b.rulesetVersion!=='string'||typeof b.mapVersion!=='string'||typeof b.commandEpoch!=='string'||!b.payload||typeof b.payload!=='object'||Array.isArray(b.payload)||(b.targetVersion!==undefined&&!Number.isSafeInteger(b.targetVersion)))throw new GameError('INVALID_INPUT','命令格式不完整，请刷新后重试');
 return b;
}
export async function buildApp(config:Config) {
 const app=Fastify({logger:false,bodyLimit:16_384,requestTimeout:15_000});
 const store=new Store(config.databaseUrl,config.secret);
 await store.start();
 const auth=new Auth(config,store);
 await app.register(cookie);
 await app.register(websocket,{options:{maxPayload:4096}});
 app.setErrorHandler((error,request,reply)=>{
  const e=error as GameError;
  const code=e instanceof GameError?e.code:((error as {validation?:unknown}).validation?'INVALID_INPUT':'INTERNAL_ERROR');
  const status=['UNAUTHORIZED','SESSION_EXPIRED'].includes(code)?401:['FORBIDDEN','CSRF_INVALID','ORIGIN_INVALID','CSRF_DENIED','ORIGIN_DENIED'].includes(code)?403:['NOT_FOUND','PORTAL_NOT_FOUND'].includes(code)?404:['WORLD_RECOVERING','RESULT_UNKNOWN','OVERLOADED'].includes(code)?503:code==='INTERNAL_ERROR'?500:409;
  if(status===500) process.stderr.write(`request failed: ${error instanceof Error?error.name:'Error'}\n`);
  reply.code(status).send({error:{code,message:e instanceof GameError?e.message:'请求未完成，请使用原请求标识确认结果',...(e instanceof GameError&&e.details?{details:e.details}:{})},requestId:(request.body as {requestId?:string})?.requestId});
 });
 app.addHook('onSend',async(_request,reply,payload)=>{reply.header('Cache-Control','no-store');reply.header('X-Content-Type-Options','nosniff');return payload});
 app.get('/health/live',async()=>({status:'alive'}));
 app.get('/health/ready',async(_req,reply)=>{
  try{await store.snapshot();if(!store.ready)throw new Error('recovering');return {status:'ready',rulesetVersion:'beta-v1',mapVersion:BETA_MAP.version}}
  catch{return reply.code(503).send({status:'recovering'})}
 });
 app.get('/api/session',async request=>{
  try{const session=await auth.authenticate(request);return {player:await store.player(session.id),csrfToken:auth.csrf(session.token),commandEpoch:auth.epoch(session.id)}}
  catch(error){if(error instanceof GameError&&['UNAUTHORIZED','SESSION_EXPIRED'].includes(error.code))return {player:null,csrfToken:'',commandEpoch:''};throw error}
 });
 app.post('/api/anonymous-sessions',async(request,reply)=>auth.anonymous(request,reply,(request.body as {requestId?:unknown})?.requestId as string));
 app.post('/api/account/recover',async(request,reply)=>auth.recover(request,reply,(request.body as {recoveryCode?:unknown})?.recoveryCode as string,(request.body as {requestId?:unknown})?.requestId as string));
 app.post('/api/account/recovery-code',request=>auth.rotateRecovery(request,(request.body as {requestId:string}).requestId));
 app.post('/api/account/logout',(request,reply)=>auth.logout(request,reply));
 app.post('/api/account/revoke-sessions',(request,reply)=>auth.revokeSessions(request,reply));
 app.post('/api/admin/logout',(request,reply)=>auth.logout(request,reply,true));
 app.get('/api/me',async request=>{const s=await auth.authenticate(request);return {player:await store.player(s.id)}});
 app.get<{Params:{id:string}}>('/api/seasons/:id/scores',async request=>{await auth.authenticate(request);const id=Number(request.params.id);if(!Number.isSafeInteger(id)||id<1)throw new GameError('INVALID_INPUT','赛季编号无效');const world=await store.snapshot();if(id===world.season.id)return {season:world.season,scores:world.scores};const row=(await store.pool.query('SELECT id,start_at,end_at,scores FROM seasons WHERE id=$1',[id])).rows[0];if(!row)throw new GameError('NOT_FOUND','赛季不存在');return row});
 for(const path of ['/api/attacks/charge','/api/portals/:id/glyph/start','/api/glyph/:id/submit','/api/trades','/api/chat'])app.post(path,async request=>{await auth.protect(request);throw new GameError('FEATURE_DISABLED','此功能尚未在内测版本开放')});
 app.get('/api/ruleset',async()=>({ruleset:RULES,rulesHash:digest(RULES),mapHash:digest(BETA_MAP)}));
 app.get('/api/world/snapshot',async request=>{
  const session=await auth.authenticate(request);
  const state=await store.personalSnapshot(session.id);
  return {...state,serverTime:Date.now(),rulesetVersion:'beta-v1',mapVersion:BETA_MAP.version,map:BETA_MAP,csrfToken:auth.csrf(session.token),commandEpoch:auth.epoch(session.id)};
 });
 app.get('/api/inventory',async request=>{const s=await auth.authenticate(request);const p=await store.player(s.id);return {inventory:p.inventory,playerVersion:p.version}});
 app.get<{Params:{id:string}}>('/api/portals/:id',async request=>{
  await auth.authenticate(request);const w=await store.snapshot();const portal=w.portals[request.params.id];if(!portal)throw new GameError('PORTAL_NOT_FOUND','PO不存在');return {portal,committedSeq:w.seq};
 });
 app.get<{Params:{id:string}}>('/api/commands/:id',async request=>{
  const s=await auth.authenticate(request);if(!uuid.test(request.params.id))throw new GameError('INVALID_INPUT','请求标识无效');
  const row=(await store.pool.query('SELECT result FROM command_receipts WHERE actor=$1 AND request_id=$2',[s.id,request.params.id])).rows[0];
  if(!row)throw new GameError('NOT_FOUND','尚未找到已提交结果，可使用原请求重试');return row.result;
 });
 const routes:[string,string][]=[['/api/account/rename','rename'],['/api/account/guide-read','guide-read'],['/api/faction','faction'],['/api/moves','move'],['/api/moves/cancel','move-cancel'],['/api/attacks','attack'],['/api/items/sugar/use','sugar'],['/api/inventory/recycle','recycle'],['/api/inventory/drop','drop'],['/api/inventory/pickup','pickup'],['/api/links','link'],['/api/links/preview','link-preview'],...['hack','deploy','deploy-all','upgrade','recharge','mods'].map(action=>[`/api/portals/:id/${action}`,action==='mods'?'mod':action] as [string,string])];
 for(const [path,type] of routes)app.post(path,async request=>{
  const session=await auth.protect(request);const body=envelope(request);
  if(((request.params as {id?:string}).id || type==='link') && body.targetVersion===undefined)throw new GameError('INVALID_INPUT','需要当前据点版本');
  const command:GameCommand={type,payload:body.payload,portalId:type.startsWith('link')?body.payload.originId as string:(request.params as {id?:string}).id};
  if(type==='link-preview'){
   auth.verifyEpoch(session.id,body.commandEpoch);
   const state=await store.personalSnapshot(session.id);
   if(state.world.maintenance)throw new GameError('WORLD_RECOVERING','世界维护中');
   if(state.player.restrictedUntil>Date.now())throw new GameError('ACCOUNT_RESTRICTED','账号受到临时限制');
   const result=applyCommand(state.world,state.player,command,{now:Date.now(),random:Math.random,id:randomUUID,map:BETA_MAP});
   return {requestId:body.requestId,committedSeq:state.world.seq,serverTime:Date.now(),result:result.result,player:state.player};
  }
  return store.command(session.id,body,command,async()=>{await auth.authenticate(request);auth.verifyEpoch(session.id,body.commandEpoch)});
 });
 registerOperations(app,store,auth);
 // 只转发已提交事件箱的公共墓碑；私有告警按当前会话身份投递。
 const connections=new Map<WebSocket,{id:string;token:string;delivery:number}>();
 let cursor=(await store.snapshot()).seq,polling=false;
 app.get('/api/events',{websocket:true,preValidation:async request=>{
  if(!isAllowedOrigin(config,request.headers.origin))throw new GameError('ORIGIN_INVALID','来源不匹配');await auth.authenticate(request);
 }},(socket,request)=>{
  void auth.authenticate(request).then(session=>{
   if(socket.readyState!==1)return;
   connections.set(socket,{...session,delivery:0});store.online.set(session.id,(store.online.get(session.id)??0)+1);
   socket.send(JSON.stringify({type:'resync',committedSeq:cursor,deliverySeq:0}));
  }).catch(()=>socket.close(1008,'session expired'));
  socket.on('error',()=>socket.close());
  socket.on('close',()=>{const c=connections.get(socket);if(c){const n=(store.online.get(c.id)??1)-1;if(n>0)store.online.set(c.id,n);else store.online.delete(c.id)}connections.delete(socket)});
 });
 const poll=setInterval(()=>{if(polling||!connections.size)return;polling=true;void (async()=>{
  // 固定本轮连接集合，避免查询期间新接入的会话被误判为已撤销。
  const batch=Array.from(connections.entries());
  const rows=await store.pool.query('SELECT seq::text,event FROM outbox WHERE seq>$1 ORDER BY seq LIMIT 1000',[cursor]);
  const active=await store.pool.query('SELECT token_hash FROM sessions WHERE token_hash=ANY($1::text[]) AND expires_at>$2',[batch.map(([,c])=>digest(c.token)),Date.now()]);
  const tokens=new Set(active.rows.map(r=>r.token_hash));
  const deleted:Record<string,unknown[]>={links:[],fields:[],resonators:[],mods:[]};
  const privateAlerts=new Map<string,{accountId:string;portalId:string;count:number;at:number}>();
  for(const row of rows.rows){for(const kind of Object.keys(deleted))deleted[kind].push(...(row.event.deleted?.[kind]??[]));
   for(const alert of row.event.privateAlerts??[])privateAlerts.set(`${alert.accountId}:${alert.portalId}`,alert);
  }
  const latest=rows.rows.at(-1)?.seq;
  for(const [socket,c] of batch){
   if(!tokens.has(digest(c.token))){socket.close(1008,'session expired');continue}
   if(socket.bufferedAmount>262_144){socket.close(1013,'resync required');continue}
   if(socket.readyState!==1)continue;
   if(latest)socket.send(JSON.stringify({type:'invalidate',committedSeq:latest,deleted,deliverySeq:++c.delivery}));
   for(const alert of privateAlerts.values())if(c.id===alert.accountId)socket.send(JSON.stringify({type:'alert',portalId:alert.portalId,count:alert.count,at:alert.at,committedSeq:latest,deliverySeq:++c.delivery}));
  }
  if(latest)cursor=latest;
 })().catch(()=>{for(const socket of connections.keys())socket.close(1013,'world unavailable')}).finally(()=>{polling=false})},250);
 poll.unref();
 app.get('/api/admin/metrics',async request=>{await auth.authenticate(request,true);return {...store.metrics,queueSize:store.queueSize,online:connections.size}});
 app.addHook('onClose',async()=>{clearInterval(poll);for(const socket of connections.keys())socket.terminate();await store.close()});
 return app;
}
