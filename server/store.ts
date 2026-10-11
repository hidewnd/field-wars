import {Pool,type PoolClient} from 'pg';
import {EventEmitter} from 'node:events';
import {randomUUID,createHmac} from 'node:crypto';
import {BETA_MAP} from '../shared/map.js';
import {RULES} from '../shared/rules.js';
import {applyCommand,advanceWorld,GameError,refreshPlayer} from '../shared/engine.js';
import {absorbGroundXm,refreshGroundXm} from '../shared/ground-xm.js';
import type {World,Player,GameCommand,CommandEnvelope,DueResult} from '../shared/types.js';
import {digest} from './config.js';
export interface Transaction {client:PoolClient;world:World;before:World;now:number;seq:string;actorPlayer?:Player;playerUpdate?:Player;playerUpdates?:Player[];alerts?:{accountId:string;portalId:string;count:number;at:number}[]}
export class Store {
 readonly pool:Pool; readonly events=new EventEmitter();
 private tail:Promise<unknown>=Promise.resolve(); private queued=0; private epoch=''; private cache:World|null=null;
 private stopping=false; private recovering=false; private timer:ReturnType<typeof setInterval>|null=null;
 private pending=new Map<string,{digest:string;promise:Promise<unknown>}>();
 metrics={committed:0,rejected:0,unknown:0,queueMs:[] as number[],commandMs:[] as number[]};
 constructor(databaseUrl:string,private secret:string) {this.pool=new Pool({connectionString:databaseUrl,max:12,connectionTimeoutMillis:5000});this.pool.on('error',()=>{this.recovering=true})}
 async start() {
  const client=await this.pool.connect();
  try {
   await client.query('BEGIN');
   const r=await client.query('UPDATE worlds SET epoch=epoch+1 WHERE id=1 RETURNING epoch::text,rules_hash,map_hash');
   if(!r.rows.length)throw new Error('WORLD_NOT_INITIALIZED');
   if(r.rows[0].rules_hash!==digest(RULES)||r.rows[0].map_hash!==digest(BETA_MAP))throw new Error('RULESET_MISMATCH');
   this.epoch=r.rows[0].epoch; await client.query('COMMIT');
   this.cache=await this.readWorld(client);
  } catch(e){await client.query('ROLLBACK');throw e}finally{client.release()}
  await this.tick();
  this.timer=setInterval(()=>void this.tick().catch(()=>{this.recovering=true}),1000);this.timer.unref();
 }
 get executorEpoch(){return this.epoch}
 readonly online=new Map<string,number>();
 get ready(){return !!this.cache&&!this.recovering&&!this.stopping}
 get queueSize(){return this.queued}
 async close(){this.stopping=true;if(this.timer)clearInterval(this.timer);await this.tail.catch(()=>{});await this.pool.end()}
 private enqueue<T>(work:()=>Promise<T>):Promise<T> {
  if(this.stopping) return Promise.reject(new GameError('WORLD_RECOVERING','世界正在维护，请稍后重试'));
  if(this.queued>=1024)return Promise.reject(new GameError('OVERLOADED','当前操作较多，请稍后重试'));
  this.queued++;const entered=performance.now();
  const run=this.tail.then(async()=>{this.metrics.queueMs.push(performance.now()-entered);if(this.metrics.queueMs.length>10000)this.metrics.queueMs.shift();if(this.recovering)await this.recoverCommittedState();return work()});
  this.tail=run.catch(()=>{});return run.finally(()=>{this.queued--});
 }
 private async recoverCommittedState():Promise<void> {
  // 新连接取得世界锁意味着上一个未知 COMMIT 已结束；只读恢复完成前禁止执行下一条写入。
  let client:PoolClient|undefined;
  try {
   client=await this.pool.connect();
   await client.query('BEGIN');
   const row=(await client.query('SELECT state,seq::text,epoch::text FROM worlds WHERE id=1 FOR UPDATE')).rows[0];
   if(row.epoch!==this.epoch)throw new GameError('WORLD_RECOVERING','执行器已交接');
   this.cache=null;
   const committed=await this.readWorld(client,row);
   await client.query('ROLLBACK');
   this.cache=committed;this.recovering=false;
  }catch(error){
   if(client)await client.query('ROLLBACK').catch(()=>{});
   this.recovering=true;
   throw new GameError('WORLD_RECOVERING','正在确认已提交状态，暂不执行新操作');
  }finally{client?.release()}
 }
 private async readWorld(client:PoolClient,row?:{state:Omit<World,'portals'>;seq:string},clone=true):Promise<World> {
  const r=row??(await client.query('SELECT state,seq::text FROM worlds WHERE id=1')).rows[0];
  if(this.cache && this.cache.seq===r.seq) return clone?structuredClone(this.cache):this.cache;
  const portals=Object.fromEntries((await client.query('SELECT id,state FROM portals')).rows.map(p=>[p.id,p.state]));
  return {...r.state,seq:r.seq,portals};
 }
 async snapshot():Promise<World> {
  const r=(await this.pool.query('SELECT epoch::text,seq::text FROM worlds WHERE id=1')).rows[0];
  if(r.epoch!==this.epoch)throw new GameError('WORLD_RECOVERING','执行器已交接，请刷新连接');
  if(this.cache&&this.cache.seq===r.seq)return structuredClone(this.cache);
  const c=await this.pool.connect();try{await c.query('BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY');const w=await this.readWorld(c);await c.query('COMMIT');return w}finally{c.release()}
 }
 async personalSnapshot(id:string):Promise<{world:World;player:Player}> {
  const client=await this.pool.connect();
  try {
   await client.query('BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY');
   const row=(await client.query('SELECT state,seq::text,epoch::text FROM worlds WHERE id=1')).rows[0];
   if(row.epoch!==this.epoch)throw new GameError('WORLD_RECOVERING','执行器已交接');
   const world=await this.readWorld(client,row);
   const p=(await client.query('SELECT state FROM accounts WHERE id=$1',[id])).rows[0];
   if(!p)throw new GameError('UNAUTHORIZED','身份不存在');
   await client.query('COMMIT');
   return {world,player:refreshPlayer(p.state,Math.max(Date.now(),p.state.energyAt))};
  }catch(error){await client.query('ROLLBACK').catch(()=>{});throw error}finally{client.release()}
 }
 async player(id:string):Promise<Player>{const r=await this.pool.query('SELECT state FROM accounts WHERE id=$1',[id]);if(!r.rowCount)throw new GameError('UNAUTHORIZED','请恢复或创建身份');return refreshPlayer(r.rows[0].state,Date.now())}
 async transaction<T>(callback:(tx:Transaction)=>Promise<T>,receipt?:{actor:string;id:string;digest:string}):Promise<T> {
  return this.enqueue(async()=>{
   const client=await this.pool.connect();let commitStarted=false;let released=false;let tx:Transaction|undefined;let value:T;
   try{
    await client.query('BEGIN');
    const r=(await client.query(`SELECT state,seq::text,epoch::text,
     (SELECT jsonb_build_object('digest',digest,'result',result) FROM command_receipts WHERE actor=$1 AND request_id=$2::uuid) AS receipt,
     (SELECT state FROM accounts WHERE id=$3::uuid) AS player
     FROM worlds WHERE id=1 FOR UPDATE`,[receipt?.actor??null,receipt?.id??null,receipt&&/^[0-9a-f]{8}-[0-9a-f-]{27}$/i.test(receipt.actor)?receipt.actor:null])).rows[0];
    if(r.epoch!==this.epoch)throw new GameError('WORLD_RECOVERING','执行器已交接');
    if(receipt){const old=r.receipt;if(old){if(old.digest!==receipt.digest)throw new GameError('REQUEST_ID_REUSED','请求标识已用于另一操作');await client.query('ROLLBACK');return old.result as T}}
    const before=await this.readWorld(client,r,false);const world=structuredClone(before);const now=Math.max(Date.now(),world.logicalAt);const seq=(BigInt(r.seq)+1n).toString();
    tx={client,world,before,now,seq,actorPlayer:r.player??undefined};
    value=await callback(tx);
    await this.persist(tx,receipt,value);
    commitStarted=true;await client.query('COMMIT');
    this.cache=tx.world;this.recovering=false;this.metrics.committed++;
    this.events.emit('commit',{seq});return value;
   }catch(e){
    if(commitStarted){
     // COMMIT 回包中断不能按失败重抽；先冻结，再用新连接查收据与数据库提交水位。
     this.recovering=true;this.metrics.unknown++;
     client.release(true);released=true;
     if(receipt){try{const found=(await this.pool.query('SELECT result FROM command_receipts WHERE actor=$1 AND request_id=$2',[receipt.actor,receipt.id])).rows[0];if(found){await this.recoverCommittedState();return found.result as T}}catch{/* 数据库仍不可查询，保持停写状态。 */}}
     throw new GameError('RESULT_UNKNOWN','结果正在确认，请使用原请求重试');
    }
    await client.query('ROLLBACK').catch(()=>{});this.metrics.rejected++;throw e;
   }finally{if(!released)client.release()}
  });
 }
 private async persist(tx:Transaction,receipt?:{actor:string;id:string;digest:string},value?:unknown){
  tx.world.seq=tx.seq;tx.world.logicalAt=tx.now;
  const changed=Object.values(tx.world.portals).filter(p=>!tx.before.portals[p.id] || p.version!==tx.before.portals[p.id].version);
  const {portals,...state}=tx.world;
  const deleted={
   links:tx.before.links.filter(l=>!tx.world.links.some(x=>x.id===l.id)).map(l=>l.id),
   fields:tx.before.fields.filter(f=>!tx.world.fields.some(x=>x.id===f.id)).map(f=>f.id),
   resonators:changed.flatMap(p=>tx.before.portals[p.id]?.resonators.flatMap((r,slot)=>r&&r.generation!==p.resonators[slot]?.generation?[{portalId:p.id,slot,generation:r.generation}]:[])??[]),
   mods:changed.flatMap(p=>tx.before.portals[p.id]?.mods.flatMap((m,slot)=>m&&!p.mods[slot]?[{portalId:p.id,slot}]:[])??[]),
  };
  // 合并一次命令的写入往返，仍由同一连接上的显式事务和同步 COMMIT 保证原子持久性。
  const result=await tx.client.query(`WITH portal_write AS (
   INSERT INTO portals(id,state) SELECT p->>'id',p FROM jsonb_array_elements($1::jsonb) p ON CONFLICT(id) DO UPDATE SET state=EXCLUDED.state
  ), player_write AS (UPDATE accounts a SET state=p FROM jsonb_array_elements($2::jsonb) p WHERE a.id=(p->>'id')::uuid),
  world_write AS (UPDATE worlds SET state=$3::jsonb,seq=$4::bigint WHERE id=1 AND epoch=$5::bigint RETURNING seq),
  event_write AS (INSERT INTO outbox(seq,event,created_at) SELECT seq,$6::jsonb,$7::bigint FROM world_write),
  receipt_write AS (INSERT INTO command_receipts(actor,request_id,digest,result,seq,created_at)
   SELECT $8::text,$9::uuid,$10::text,$11::jsonb,seq,$7::bigint FROM world_write WHERE $8::text IS NOT NULL)
  SELECT seq::text FROM world_write`,[JSON.stringify(changed),JSON.stringify(tx.playerUpdate?[tx.playerUpdate]:tx.playerUpdates??[]),
   JSON.stringify(state),tx.seq,this.epoch,JSON.stringify({type:'invalidate',committedSeq:tx.seq,deleted,privateAlerts:tx.alerts??[]}),tx.now,
   receipt?.actor??null,receipt?.id??null,receipt?.digest??null,JSON.stringify(value??null)]);
  if(result.rowCount!==1)throw new GameError('WORLD_RECOVERING','执行器已交接');
 }
 async persistDue(tx:Transaction,due:DueResult){
  tx.world=due.world;
  refreshGroundXm(tx.world,BETA_MAP,tx.now);
  for(const cp of due.checkpoints)await tx.client.query('INSERT INTO checkpoints(season_id,checkpoint_index,at_ms,scores) VALUES($1,$2,$3,$4) ON CONFLICT DO NOTHING',[cp.seasonId,cp.index,cp.at,cp.scores]);
  for(const s of due.seasons)await tx.client.query('INSERT INTO seasons(id,start_at,end_at,scores) VALUES($1,$2,$3,$4) ON CONFLICT DO NOTHING',[s.id,s.startAt,s.endAt,s.scores]);
 }
 private hasDue(world:World,now:number){return (world.nextGroundXmAt??0)<=now||world.nextCheckpoint<=now||world.season.endAt<=now||Object.values(world.portals).some(p=>p.resonators.some(r=>r&&r.nextDecayAt<=now))}
 async tick(){
  if(this.stopping)return;
  const w=this.cache;const now=Math.max(Date.now(),w?.logicalAt??0);
  const onlineIds=Array.from(this.online.keys());
  const players=(await this.pool.query("SELECT state FROM accounts WHERE id=ANY($1::uuid[]) OR state->'movement'<>'null'::jsonb ORDER BY id",[onlineIds])).rows.map(row=>row.state as Player);
  // 无资源变更时不制造世界序号和广播；这里只做预检，真正领取须在世界锁内重读。
  if(w && !this.recovering && !this.hasDue(w,now)) {
   const preview=structuredClone(w);
   if(!players.some(player=>{
    // 预检读取期间可能已有命令提交，或系统时钟回拨；不得倒退玩家时间。
    const at=Math.max(now,player.energyAt);
    return (player.movement && player.movement.arriveAt<=at)||absorbGroundXm(preview,player,refreshPlayer(player,at),at)>0;
   }))return;
  }
  await this.transaction(async tx=>{
   if(this.hasDue(tx.world,tx.now))await this.persistDue(tx,advanceWorld(tx.world,tx.now));
   if(tx.world.maintenance)return null;
   const rows=await tx.client.query('SELECT state FROM accounts WHERE id=ANY($1::uuid[]) ORDER BY id',[players.map(player=>player.id)]);
   tx.playerUpdates=[];
   for(const row of rows.rows){
    const previous=row.state as Player,player=refreshPlayer(previous,tx.now);
    const restored=absorbGroundXm(tx.world,previous,player,tx.now);
    // 到达后落盘清除移动状态，避免已完成旅途永久参与每秒扫描。
    if(restored>0 || (previous.movement && !player.movement)){player.version++;tx.playerUpdates.push(player)}
   }
   return null;
  });
 }
 async command(actor:string,envelope:CommandEnvelope,command:GameCommand,verifyEpoch:()=>void|Promise<void>){
  const hash=digest({envelope,command});const key=actor+':'+envelope.requestId;
  const previous=this.pending.get(key);if(previous){if(previous.digest!==hash)throw new GameError('REQUEST_ID_REUSED','请求标识已用于另一操作');return previous.promise}
  const start=performance.now();
  const promise=this.transaction(async tx=>{
   await verifyEpoch();
   const p=tx.actorPlayer;
   if(!p)throw new GameError('UNAUTHORIZED','身份不存在');
   if(p.restrictedUntil>tx.now)throw new GameError('ACCOUNT_RESTRICTED','账号暂时受到限制');
   if(this.hasDue(tx.world,tx.now))await this.persistDue(tx,advanceWorld(tx.world,tx.now));
   if(tx.world.maintenance)throw new GameError('WORLD_RECOVERING','世界维护中');
   if(envelope.seasonId!==tx.world.season.id)throw new GameError('SEASON_CHANGED','赛季已更新，请刷新');
   if(envelope.rulesetVersion!=='beta-v1'||envelope.mapVersion!==BETA_MAP.version)throw new GameError('RULESET_CHANGED','规则版本已更新');
   if(envelope.playerVersion!==p.version)throw new GameError('VERSION_CONFLICT','个人状态已更新，请刷新后操作');
   if(command.portalId && envelope.targetVersion!==undefined && tx.world.portals[command.portalId]?.version!==envelope.targetVersion)throw new GameError('TARGET_CHANGED','据点状态已变化');
   // 随机上下文按账号与请求唯一绑定，明确回滚后的同请求重试也不会换一批抽样。
   let counter=0;
   const random=()=>createHmac('sha256',this.secret).update(`${actor}:${envelope.requestId}:${counter++}`).digest().readUInt32BE(0)/0x100000000;
   const result=applyCommand(tx.world,p,command,{now:tx.now,random,id:randomUUID,map:BETA_MAP},false);
   tx.world=result.world;result.player.version=p.version+1;
   tx.playerUpdate=result.player;
   for(const alert of result.alerts??[]){
    const rows=await tx.client.query("SELECT id,state FROM accounts WHERE state->>'faction'=$1 AND id=ANY($2::uuid[])",[alert.faction,Array.from(this.online.keys())]);
    for(const row of rows.rows){const player=row.state as Player;if(!this.online.has(row.id))continue;if(!alert.owners.includes(row.id)&&!player.inventory.some(i=>i.type==='key'&&i.portalId===alert.portalId&&i.quantity>0))continue;
     const old=await tx.client.query('UPDATE alerts SET count=count+1,last_at=$1 WHERE account_id=$2 AND portal_id=$3 AND first_at>$4 RETURNING id,count',[tx.now,row.id,alert.portalId,tx.now-RULES.social.alertCoalesceMs]);
     if(!old.rowCount)await tx.client.query('INSERT INTO alerts(account_id,portal_id,first_at,last_at) VALUES($1,$2,$3,$3)',[row.id,alert.portalId,tx.now]);
     (tx.alerts??=[]).push({accountId:row.id,portalId:alert.portalId,count:old.rows[0]?.count??1,at:tx.now});
    }
   }
   return {requestId:envelope.requestId,committedSeq:tx.seq,serverTime:tx.now,effectiveAt:tx.now,seasonId:tx.world.season.id,rulesetVersion:RULES.version,mapVersion:BETA_MAP.version,result:result.result,player:result.player};
  },{actor,id:envelope.requestId,digest:hash});
  this.pending.set(key,{digest:hash,promise});
  return promise.finally(()=>{this.pending.delete(key);this.metrics.commandMs.push(performance.now()-start);if(this.metrics.commandMs.length>10000)this.metrics.commandMs.shift()});
 }
}
