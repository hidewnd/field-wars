/**
 * 隔离库中的真实 HTTP 负载工具。例：
 * TEST_DATABASE_URL=postgres://.../confluence_test node --import tsx tests/load.ts --mode attack --sessions 500 --rate 500 --seconds 60
 * 此脚本会重建专用 test 库内的业务数据；绝不可指向常规部署库。
 */
import {createHash,randomUUID} from 'node:crypto';
import {readFileSync} from 'node:fs';
import os from 'node:os';
import {Pool} from 'pg';
import WebSocket from 'ws';
import {buildApp} from '../server/app.js';
import {migrate} from '../server/migrate.js';
import {digest} from '../server/config.js';
import {BETA_MAP} from '../shared/map.js';
import {RULES} from '../shared/rules.js';
import type {Player, Portal, Snapshot} from '../shared/types.js';

type Mode = 'move' | 'attack';
type Account = {id:string;cookie:string;csrf:string;epoch:string;version:number;x:number;y:number;busy:boolean;readyAt:number};
type Result = {status:number;code:string;durationMs:number;queueEstimateMs:number|null;effective:boolean};
const databaseUrl = process.env.TEST_DATABASE_URL;
if (!databaseUrl) throw new Error('必须提供 TEST_DATABASE_URL，且只能指向独立 test 数据库');
const dbName = decodeURIComponent(new URL(databaseUrl).pathname.slice(1));
if (!/(^|[_-])test([_-]|$)/i.test(dbName)) throw new Error('数据库名称必须含独立 test 段，拒绝清理非测试库');

function arg(name:string, fallback:string):string {
  const index = process.argv.indexOf(`--${name}`);
  return index < 0 ? fallback : process.argv[index+1] ?? fallback;
}
const mode = arg('mode','move') as Mode;
const sessions = Number(arg('sessions','20'));
const rate = Number(arg('rate','30'));
const seconds = Number(arg('seconds','10'));
const snapshotClients = Number(arg('snapshot-clients',String(Math.min(10,sessions))));
if (!['move','attack'].includes(mode) || !Number.isSafeInteger(sessions) || sessions<1 || sessions>500 ||
    !Number.isFinite(rate) || rate<1 || rate>500 || !Number.isFinite(seconds) || seconds<1 || seconds>1800 ||
    !Number.isSafeInteger(snapshotClients)||snapshotClients<1||snapshotClients>sessions) {
  throw new Error('参数范围：mode=move|attack，sessions=1..500，rate=1..500，seconds=1..1800，snapshot-clients=1..sessions');
}
if (mode === 'attack' && rate > sessions) throw new Error('有效攻击负载每账号每秒最多一次；rate 不能超过 sessions');

const config = {databaseUrl, secret:'isolated-load-test-secret-at-least-32-characters',adminPassword:'isolated-load-test-admin-password',
  origin:'http://127.0.0.1:8080',cookieSecure:false,host:'127.0.0.1',port:0};
const pool = new Pool({connectionString:databaseUrl});
let app:Awaited<ReturnType<typeof buildApp>>|undefined;
let sockets:WebSocket[]=[];
let maintainSockets=true;
const reconnectTimers=new Set<ReturnType<typeof setTimeout>>();
const disconnectCodes=new Map<string,number>(),automaticReconnectMs:number[]=[];
let reconnectFailures=0;
const pendingVisible=new Map<string,{serverTime:number;monitor:number}>(),visibilityMs:number[]=[];
const desiredVisibleSeq=Array<bigint>(snapshotClients).fill(0n),confirmedVisibleSeq=Array<bigint>(snapshotClients).fill(0n);
const confirmedVisibleAt=Array<number>(snapshotClients).fill(0),snapshotInFlight=Array<boolean>(snapshotClients).fill(false);
let visibilitySamplesRequested=0,visibilitySnapshotRequests=0,visibilitySnapshotFailures=0;
const sourceHashes=Object.fromEntries(['server/store.ts','server/app.ts','shared/engine.ts','tests/load.ts']
  .map(path=>[path,createHash('sha256').update(readFileSync(path)).digest('hex')]));

async function reset() {
  const client=await pool.connect();
  try {
    const actual=(await client.query('SELECT current_database() AS name')).rows[0].name as string;
    if(!/(^|[_-])test([_-]|$)/i.test(actual))throw new Error('实际连接不是 test 数据库');
    const exists=(await client.query("SELECT to_regclass('public.worlds') AS name")).rows[0].name;
    if(exists)await client.query('TRUNCATE worlds,portals,accounts,sessions,command_receipts,outbox,checkpoints,seasons,applications,complaints,admin_audit,admin_sessions,markers,alerts,operations RESTART IDENTITY CASCADE');
  }finally{client.release()}
  await migrate(databaseUrl!);
}

async function start():Promise<string> {
  app=await buildApp(config);
  const address=await app.listen({host:'127.0.0.1',port:0});
  return address;
}
async function stop(){await app?.close();app=undefined}
function confirmVisibleSnapshot(slot:number,snapshot:Snapshot,expected:bigint):void {
  const seq=BigInt(snapshot.world.seq);
  if(seq<expected)throw new Error(`快照序号 ${seq} 落后于已收到的推送 ${expected}`);
  if(seq<confirmedVisibleSeq[slot])throw new Error('快照序号倒退');
  confirmedVisibleSeq[slot]=seq;confirmedVisibleAt[slot]=Date.now();
  for(const [pendingSeq,pending] of pendingVisible)if(pending.monitor===slot&&BigInt(pendingSeq)<=seq){
    visibilityMs.push(Math.max(0,confirmedVisibleAt[slot]-pending.serverTime));pendingVisible.delete(pendingSeq);
  }
}
function requestVisibleSnapshot(base:string,account:Account,slot:number,seq:bigint):void {
  if(seq>desiredVisibleSeq[slot])desiredVisibleSeq[slot]=seq;
  if(snapshotInFlight[slot])return;
  snapshotInFlight[slot]=true;
  void (async()=>{
    try {
      while(confirmedVisibleSeq[slot]<desiredVisibleSeq[slot]&&maintainSockets){
        const expected=desiredVisibleSeq[slot];visibilitySnapshotRequests++;
        const response=await fetch(base+'/api/world/snapshot',{headers:{cookie:account.cookie}});
        if(!response.ok)throw new Error(`可见快照 ${response.status}`);
        confirmVisibleSnapshot(slot,await response.json() as Snapshot,expected);
      }
    }catch{visibilitySnapshotFailures++}
    finally{snapshotInFlight[slot]=false}
  })();
}
async function connectSessions(base:string,accounts:Account[]):Promise<void> {
  const url=base.replace(/^http/,'ws')+'/api/events';
  const openAccount=(account:Account,slot:number,disconnectedAt?:number):Promise<WebSocket>=>new Promise((resolve,reject)=>{
    const socket=new WebSocket(url,{headers:{Origin:config.origin,Cookie:account.cookie}});
    let opened=false,measured=false;
    socket.on('error',()=>{});
    socket.on('message',raw=>{
      try {
        const message=JSON.parse(String(raw)) as {type?:string;committedSeq?:string};
        if(message.type==='resync'&&disconnectedAt!==undefined&&!measured){
          measured=true;
          void fetch(base+'/api/world/snapshot',{headers:{cookie:account.cookie}}).then(async response=>{
            if(!response.ok)throw new Error(`自动重连快照 ${response.status}`);
            const snapshot=await response.json() as Snapshot;
            if(slot<snapshotClients)confirmVisibleSnapshot(slot,snapshot,0n);
            automaticReconnectMs.push(performance.now()-disconnectedAt);
          }).catch(()=>{reconnectFailures++});
        }
        if(slot<snapshotClients&&message.type==='invalidate'&&message.committedSeq)
          requestVisibleSnapshot(base,account,slot,BigInt(message.committedSeq));
      } catch {/* 无法解析的帧不得算作推送或重连成功。 */}
    });
    socket.once('open',()=>{opened=true;sockets[slot]=socket;resolve(socket)});
    socket.once('error',error=>{if(!opened)reject(error)});
    socket.on('close',(code,reason)=>{
      if(!maintainSockets||!opened)return;
      const key=`${code}:${String(reason)}`;
      disconnectCodes.set(key,(disconnectCodes.get(key)??0)+1);
      const started=performance.now();
      // 真实客户端在断线后恢复订阅，并以一致快照补齐缺口；失败仍保留计数。
      const reconnect=()=>{
        if(!maintainSockets)return;
        const timer=setTimeout(()=>{
          reconnectTimers.delete(timer);
          if(!maintainSockets)return;
          void openAccount(account,slot,started).catch(()=>{reconnectFailures++;reconnect()});
        },200);
        reconnectTimers.add(timer);
      };
      reconnect();
    });
  });
  for(let start=0;start<accounts.length;start+=50) {
    await Promise.all(accounts.slice(start,start+50).map((account,index)=>openAccount(account,start+index)));
  }
}
async function disconnectSessions(){
  maintainSockets=false;
  for(const timer of reconnectTimers)clearTimeout(timer);
  reconnectTimers.clear();
  for(const socket of sockets)socket?.terminate();
  sockets=[];
}
async function createAccounts(base:string):Promise<Account[]> {
  const output:Account[]=[];
  for(let i=0;i<sessions;i++) {
    const response=await fetch(base+'/api/anonymous-sessions',{method:'POST',headers:{origin:config.origin,'content-type':'application/json'},
      body:JSON.stringify({requestId:randomUUID()})});
    if(!response.ok) throw new Error(`创建会话失败 ${response.status}: ${await response.text()}`);
    const body=await response.json() as {player:Player;csrfToken:string;commandEpoch:string};
    const cookie=response.headers.get('set-cookie')?.split(';')[0];
    if(!cookie)throw new Error('匿名会话未返回 Cookie');
    output.push({id:body.player.id,cookie,csrf:body.csrfToken,epoch:body.commandEpoch,version:body.player.version,
      x:body.player.x,y:body.player.y,busy:false,readyAt:0});
  }
  return output;
}

async function refreshSessions(base:string,accounts:Account[]):Promise<void> {
  for(const account of accounts) {
    const response=await fetch(base+'/api/session',{headers:{cookie:account.cookie}});
    if(!response.ok)throw new Error(`重启后会话失效 ${response.status}`);
    const body=await response.json() as {player:Player;csrfToken:string;commandEpoch:string};
    if(body.player.id!==account.id)throw new Error('重启后账号身份不一致');
    account.csrf=body.csrfToken;account.epoch=body.commandEpoch;account.version=body.player.version;
    account.x=body.player.x;account.y=body.player.y;account.readyAt=body.player.cooldowns.attack??0;
  }
}

async function prepareAttack(accounts:Account[]):Promise<void> {
  const client=await pool.connect();
  try {
    await client.query('BEGIN');
    const records=(await client.query('SELECT id,state FROM portals ORDER BY id')).rows as {id:string;state:Portal}[];
    for(const row of records) {
      const p=row.state;
      p.faction='blue'; p.version++;
      p.resonators=Array.from({length:8},(_,slot)=>({level:8,energy:6000,owner:'load-enemy',x:p.x,y:p.y,
        generation:`load-${p.id}-${slot}`,nextDecayAt:Date.now()+86_400_000}));
      p.mods=Array.from({length:4},()=>({type:'shield' as const,owner:'load-enemy'}));
      await client.query('UPDATE portals SET state=$1 WHERE id=$2',[p,row.id]);
    }
    for(let i=0;i<accounts.length;i++) {
      const p=records[i%records.length].state;
      const row=(await client.query('SELECT state FROM accounts WHERE id=$1',[accounts[i].id])).rows[0];
      const player=row.state as Player;
      // 距敌点45米，位于 L2 脉冲48米范围内且避开40米反击圈。
      const offsets=[[4500,0],[-4500,0],[0,4500],[0,-4500],[3182,3182],[-3182,3182],[3182,-3182],[-3182,-3182]];
      const position=offsets.map(([dx,dy])=>({x:p.x+dx,y:p.y+dy}))
        .filter(point=>point.x>=0&&point.x<=BETA_MAP.width&&point.y>=0&&point.y<=BETA_MAP.height)
        .map(point=>({point,clearance:Math.min(...records.filter(other=>other.id!==p.id)
          .map(other=>Math.hypot(point.x-other.state.x,point.y-other.state.y)))}))
        .sort((left,right)=>right.clearance-left.clearance)[0]?.point;
      if(!position)throw new Error(`据点 ${p.id} 没有合法负载站位`);
      player.faction='red';player.ap=240000;player.xm=10000;player.x=position.x;player.y=position.y;
      player.inventory=[{type:'pulse',level:2,quantity:Math.ceil(seconds*rate/sessions)+10}];
      player.version++;
      accounts[i].version=player.version;accounts[i].x=position.x;accounts[i].y=position.y;
      await client.query('UPDATE accounts SET state=$1 WHERE id=$2',[player,player.id]);
    }
    await client.query('COMMIT');
  } catch(error){await client.query('ROLLBACK');throw error}finally{client.release()}
}

function percentile(values:number[],p:number):number|null {
  if(!values.length)return null;
  const sorted=[...values].sort((a,b)=>a-b);
  return Number(sorted[Math.min(sorted.length-1,Math.ceil(p*sorted.length)-1)].toFixed(2));
}

async function sample(base:string,account:Account,world:Snapshot['world'],index:number):Promise<Result> {
  const requestId=randomUUID();
  const payload=mode==='attack'?{level:2}:{x:Math.max(0,Math.min(BETA_MAP.width,account.x+(account.version%2?1000:-1000))),y:account.y};
  const url=mode==='attack'?'/api/attacks':'/api/moves';
  const started=Date.now(), timer=performance.now();
  const envelope={requestId,seasonId:world.season.id,rulesetVersion:RULES.version,mapVersion:BETA_MAP.version,
    playerVersion:account.version,commandEpoch:account.epoch,payload};
  try {
    const response=await fetch(base+url,{method:'POST',headers:{origin:config.origin,'content-type':'application/json',
      cookie:account.cookie,'x-csrf-token':account.csrf},body:JSON.stringify(envelope)});
    const data=await response.json() as {player?:Player;serverTime?:number;committedSeq?:string;result?:Record<string,unknown>;error?:{code:string}};
    if(response.ok&&data.player){account.version=data.player.version;account.x=data.player.x;account.y=data.player.y;
      account.readyAt=data.player.cooldowns.attack??0}
    const effective=response.ok&&(mode==='move'||Number(data.result?.hits??0)>0);
    if(effective&&index%10===0&&data.committedSeq&&typeof data.serverTime==='number'){
      visibilitySamplesRequested++;
      const monitor=Math.floor(index/10)%snapshotClients;
      if(BigInt(data.committedSeq)<=confirmedVisibleSeq[monitor])
        visibilityMs.push(Math.max(0,confirmedVisibleAt[monitor]-data.serverTime));
      else pendingVisible.set(data.committedSeq,{serverTime:data.serverTime,monitor});
    }
    return {status:response.status,code:response.ok?'OK':data.error?.code??'UNKNOWN',
      durationMs:performance.now()-timer,queueEstimateMs:typeof data.serverTime==='number'?Math.max(0,data.serverTime-started):null,effective};
  } catch(error) {
    return {status:0,code:error instanceof Error?error.name:'NETWORK_ERROR',durationMs:performance.now()-timer,
      queueEstimateMs:null,effective:false};
  }
}

async function run():Promise<void> {
  const wallStarted=new Date().toISOString();
  await reset();
  let base=await start();
  const accounts=await createAccounts(base);
  if(mode==='attack'){
    await stop();
    await prepareAttack(accounts);
    base=await start();
    await refreshSessions(base,accounts);
  }
  const first=await fetch(base+'/api/world/snapshot',{headers:{cookie:accounts[0].cookie}});
  if(!first.ok)throw new Error('初始快照不可用');
  const world=(await first.json() as Snapshot).world;
  await connectSessions(base,accounts);
  // 开测前主动打断一条连接，验证压测客户端确实能够自动补订阅并读取一致快照。
  const probeSocket=sockets[0];
  probeSocket.terminate();
  const probeDeadline=performance.now()+5000;
  while((sockets[0]===probeSocket||sockets[0]?.readyState!==WebSocket.OPEN||automaticReconnectMs.length===0)&&
    performance.now()<probeDeadline)await new Promise(resolve=>setTimeout(resolve,25));
  if(sockets[0]===probeSocket||sockets[0]?.readyState!==WebSocket.OPEN||automaticReconnectMs.length===0)
    throw new Error('压测客户端自动重连和快照探针未在5秒内完成');
  const adminLogin=await fetch(base+'/api/admin/login',{method:'POST',headers:{origin:config.origin,'content-type':'application/json'},
    body:JSON.stringify({password:config.adminPassword})});
  if(!adminLogin.ok)throw new Error(`负载指标鉴权失败 ${adminLogin.status}`);
  const adminCookie=adminLogin.headers.get('set-cookie')?.split(';')[0];
  if(!adminCookie)throw new Error('管理员指标会话没有 Cookie');
  const pgVersion=(await pool.query('SHOW server_version')).rows[0].server_version;
  const syncCommit=(await pool.query('SHOW synchronous_commit')).rows[0].synchronous_commit;
  const attempts=Math.floor(rate*seconds), results:Result[]=[];
  const pending=new Set<Promise<void>>();
  let skippedBusy=0;
  const startAt=performance.now();
  for(let i=0;i<attempts;i++) {
    const due=startAt+i*1000/rate;
    const delay=due-performance.now();
    if(delay>0)await new Promise(resolve=>setTimeout(resolve,delay));
    const account=accounts[i%accounts.length];
    if(account.busy){skippedBusy++;continue}
    // 下一次有效攻击不得靠越过权威冷却提前发包；等待时间计入总历时。
    if(mode==='attack'&&account.readyAt>Date.now())await new Promise(resolve=>setTimeout(resolve,account.readyAt-Date.now()+1));
    account.busy=true;
    const task=sample(base,account,world,i).then(result=>{results.push(result)}).finally(()=>{account.busy=false;pending.delete(task)});
    pending.add(task);
  }
  await Promise.all(pending);
  const actualSeconds=(performance.now()-startAt)/1000;
  await new Promise(resolve=>setTimeout(resolve,600));
  const onlineDeadline=performance.now()+3000;
  while((sockets.filter(socket=>socket?.readyState===WebSocket.OPEN).length<sessions||pendingVisible.size>0)&&performance.now()<onlineDeadline)
    await new Promise(resolve=>setTimeout(resolve,50));
  const connectedSessionsAtEnd=sockets.filter(socket=>socket?.readyState===WebSocket.OPEN).length;
  const metricsResponse=await fetch(base+'/api/admin/metrics',{headers:{cookie:adminCookie}});
  if(!metricsResponse.ok)throw new Error(`服务端队列指标不可用 ${metricsResponse.status}`);
  const metrics=await metricsResponse.json() as {queueMs:number[];commandMs:number[];queueSize:number;online:number};
  maintainSockets=false;
  for(const timer of reconnectTimers)clearTimeout(timer);
  reconnectTimers.clear();
  const monitor=sockets[0];monitor?.terminate();
  const reconnectStarted=performance.now();
  const replacement=new WebSocket(base.replace(/^http/,'ws')+'/api/events',
    {headers:{Origin:config.origin,Cookie:accounts[0].cookie}});
  let reconnectMs:number|null=null;
  await new Promise<void>((resolve,reject)=>{
    const timeout=setTimeout(()=>reject(new Error('重连后5秒内未收到基准帧')),5000);
    replacement.once('error',reject);
    replacement.on('message',async raw=>{
      try {const message=JSON.parse(String(raw)) as {type?:string};if(message.type!=='resync')return;
        const response=await fetch(base+'/api/world/snapshot',{headers:{cookie:accounts[0].cookie}});
        if(!response.ok)throw new Error(`重连快照 ${response.status}`);
        await response.json();reconnectMs=performance.now()-reconnectStarted;clearTimeout(timeout);resolve();
      }catch(error){reject(error)}
    });
  });
  replacement.terminate();
  const effective=results.filter(r=>r.effective), latency=effective.map(r=>r.durationMs), queue=results.flatMap(r=>r.queueEstimateMs===null?[]:[r.queueEstimateMs]);
  const finalWorld=(await pool.query('SELECT seq::text,state FROM worlds WHERE id=1')).rows[0];
  const receipts=Number((await pool.query('SELECT count(*)::integer AS n FROM command_receipts')).rows[0].n);
  const accountState=await pool.query("SELECT count(*)::integer AS total,count(*) FILTER(WHERE (state->>'xm')::integer<0 OR EXISTS(SELECT 1 FROM jsonb_array_elements(state->'inventory') item WHERE (item->>'quantity')::integer<=0))::integer AS invalid FROM accounts");
  const outbox=(await pool.query('SELECT count(*)::bigint AS count,min(seq)::text AS first,max(seq)::text AS last FROM outbox')).rows[0];
  const invariants={accounts:accountState.rows[0].total,invalidPlayerStates:accountState.rows[0].invalid,
    outboxRows:String(outbox.count),outboxFirst:outbox.first,outboxLast:outbox.last,
    continuousOutbox:String(outbox.count)===finalWorld.seq&&outbox.first==='1'&&outbox.last===finalWorld.seq,
    receiptsMatchSuccess:receipts===results.filter(r=>r.status===200).length};
  const rejected=Object.entries(results.reduce<Record<string,number>>((acc,r)=>{if(r.code!=='OK')acc[r.code]=(acc[r.code]??0)+1;return acc},{}));
  const report={startedAt:wallStarted,finishedAt:new Date().toISOString(),mode,requested:{sessions,ratePerSecond:rate,seconds,attempts},
    actual:{seconds:Number(actualSeconds.toFixed(2)),connectedSessions:connectedSessionsAtEnd,sent:results.length,skippedBusy,effective:effective.length,
      effectivePerSecond:Number((effective.length/actualSeconds).toFixed(2)),httpSuccess:results.filter(r=>r.status===200).length,
      rejected:Object.fromEntries(rejected),p50Ms:percentile(latency,.5),p95Ms:percentile(latency,.95),
      queueWaitEstimateP95Ms:percentile(queue,.95),queueWaitEstimateNote:'以同机客户端发送时刻到服务端提交时刻估计，包含HTTP开销；非服务端内部队列计时',
      snapshotClients,allSessionsFetchSnapshots:snapshotClients===sessions,visibilitySnapshotRequests,visibilitySnapshotFailures,
      commitToVisibleRequestedSamples:visibilitySamplesRequested,commitToVisibleSamples:visibilityMs.length,
      commitToVisibleMissingSamples:pendingVisible.size,commitToVisibleP95Ms:percentile(visibilityMs,.95),
      visibilityDefinition:'收到覆盖命令序号的 WebSocket 通知后实际读取一致快照，验证 world.seq 不小于命令 committedSeq',
      reconnectSnapshotMs:reconnectMs,
      disconnectCodeCounts:Object.fromEntries(disconnectCodes),forcedReconnectProbes:1,automaticReconnectCount:automaticReconnectMs.length,
      automaticReconnectP95Ms:percentile(automaticReconnectMs,.95),automaticReconnectFailures:reconnectFailures,
      internalQueueP95Ms:percentile(metrics.queueMs,.95),internalCommandP95Ms:percentile(metrics.commandMs,.95),
      queueSizeAtEnd:metrics.queueSize,onlineAtEnd:metrics.online,
      receiptRows:receipts,worldSeq:finalWorld.seq,invariants},
    environment:{node:process.version,platform:process.platform,architecture:process.arch,cpuModel:os.cpus()[0]?.model,
      cpuCount:os.cpus().length,memoryGiB:Number((os.totalmem()/2**30).toFixed(2)),postgres:pgVersion,
      synchronousCommit:syncCommit,ruleHash:digest(RULES),mapHash:digest(BETA_MAP),sourceHashes},
    pass:connectedSessionsAtEnd===sessions&&metrics.online===sessions&&invariants.accounts===sessions&&
      invariants.invalidPlayerStates===0&&invariants.continuousOutbox&&invariants.receiptsMatchSuccess&&
      effective.length>=attempts*.99&&percentile(latency,.95)!<=300&&
      visibilityMs.length===visibilitySamplesRequested&&visibilitySnapshotFailures===0&&
      percentile(visibilityMs,.95)!<=1000&&reconnectMs!==null&&reconnectMs<=3000&&
      reconnectFailures===0&&(automaticReconnectMs.length===0||percentile(automaticReconnectMs,.95)!<=3000)};
  console.log(JSON.stringify(report,null,2));
  if(!report.pass)process.exitCode=1;
}

run().catch(error=>{console.error(error);process.exitCode=1}).finally(async()=>{await disconnectSessions();await stop().catch(()=>{});await pool.end().catch(()=>{})});
