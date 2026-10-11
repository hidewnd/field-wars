import {randomUUID} from 'node:crypto';
import {afterAll,beforeAll,beforeEach,describe,expect,it} from 'vitest';
import {Pool} from 'pg';
import {migrate} from '../server/migrate.js';
import {Store} from '../server/store.js';
import {digest} from '../server/config.js';
import {createPlayer} from '../shared/engine.js';
import {BETA_MAP} from '../shared/map.js';
import {RULES} from '../shared/rules.js';
import type {Field,Link,Player,Portal} from '../shared/types.js';

const databaseUrl=process.env.MIGRATION_TEST_DATABASE_URL;
const suite=databaseUrl?describe:describe.skip;
const initialRulesHash='52ff47dbebbb352e7c8786c4a56b35ca9a18b9d97f56ba7acb6e819c64536d28';
const previousRulesHash='8b7a995ee5ba28076fb7b7464729836c9e4efde1b2e2d703e26e23f8e0bfaa64';
let pool:Pool;

function assertDedicatedDatabase(url:string,name:string):void {
  const parsed=new URL(url);
  const requested=decodeURIComponent(parsed.pathname.slice(1));
  if(!/(^|[_-])test([_-]|$)/i.test(requested)||requested!==name)
    throw new Error('MIGRATION_TEST_DATABASE_URL 必须指向已核对名称的独立 test 数据库');
}

async function resetSchema():Promise<void> {
  // 只在已核对的专用 test 库中重建空 schema，以验证第一轮迁移而非残留表结构。
  await pool.query('DROP SCHEMA public CASCADE');
  await pool.query('CREATE SCHEMA public');
}

async function worldRow() {
  return (await pool.query('SELECT epoch::text,seq::text,rules_hash,map_hash,state FROM worlds WHERE id=1')).rows[0];
}

suite('独立 PostgreSQL 的规则升级迁移',()=>{
  beforeAll(async()=>{
    pool=new Pool({connectionString:databaseUrl});
    const name=(await pool.query('SELECT current_database() AS name')).rows[0].name as string;
    assertDedicatedDatabase(databaseUrl!,name);
    expect(digest(RULES)).not.toBe(previousRulesHash);
  });
  beforeEach(resetSchema);
  afterAll(async()=>{await pool?.end()});

  it('006升级007压缩旧脚期限但保留已到期事件，保留资产且重复迁移不变',async()=>{
    await migrate(databaseUrl!);
    const now=Date.now(),po=BETA_MAP.portals[0];
    const foot={level:1,energy:850,owner:'legacy',x:po.x,y:po.y,generation:'legacy',nextDecayAt:now+86400000};
    const portal={...po,faction:'red',version:8,resonators:[foot,{...foot,generation:'due',nextDecayAt:now-1000},...Array(6).fill(null)]};
    await pool.query('UPDATE portals SET state=$1 WHERE id=$2',[portal,po.id]);
    await pool.query('DELETE FROM schema_migrations WHERE version=7');
    await pool.query('UPDATE worlds SET rules_hash=$1 WHERE id=1',['c6ab8b6a8147dad4b39bf948507e3798ef844c892c303d267a6ff5922b823d1c']);
    const before=await worldRow();
    await migrate(databaseUrl!);
    const updated=(await pool.query('SELECT state FROM portals WHERE id=$1',[po.id])).rows[0].state;
    expect(updated.resonators[0].nextDecayAt).toBeGreaterThanOrEqual(now+21600000);
    expect(updated.resonators[0].nextDecayAt).toBeLessThanOrEqual(Date.now()+21600000);
    expect(updated).toEqual({...portal,version:9,resonators:[{...foot,nextDecayAt:updated.resonators[0].nextDecayAt},portal.resonators[1],...Array(6).fill(null)]});
    const after=await worldRow();
    expect(after).toEqual({...before,rules_hash:digest(RULES),epoch:(BigInt(before.epoch)+1n).toString()});
    await migrate(databaseUrl!);expect(await worldRow()).toEqual(after);
    expect((await pool.query('SELECT state FROM portals WHERE id=$1',[po.id])).rows[0].state).toEqual(updated);
  });

  it('全新空库一次建成七版迁移和恰好 100 个初始 PO',async()=>{
    await migrate(databaseUrl!);
    const versions=(await pool.query('SELECT version FROM schema_migrations ORDER BY version')).rows.map(row=>row.version);
    expect(versions).toEqual([1,2,3,4,5,6,7]);
    expect(Number((await pool.query('SELECT count(*)::integer AS n FROM portals')).rows[0].n)).toBe(100);
    const world=await worldRow();
    expect(world.rules_hash).toBe(digest(RULES));
    expect(world.map_hash).toBe(digest(BETA_MAP));
    expect(world.seq).toBe('0');
    expect(world.epoch).toBe('0');
  });

  it('001 旧世界串联升级至 007 保留资产和序号；代次隔离旧执行器且重复迁移无变化',async()=>{
    await migrate(databaseUrl!);
    const now=Date.now(),portal=BETA_MAP.portals[0],accountId=randomUUID(),receiptId=randomUUID();
    const occupied:Portal={...portal,faction:'red',version:portal.version+1,
      resonators:[{level:1,energy:1000,owner:accountId,ownerName:'旧世界玩家',x:portal.x,y:portal.y,
        generation:'migration-existing-resonator',nextDecayAt:now+3_600_000},...Array(7).fill(null)]};
    const player:Player=createPlayer(accountId,'旧世界玩家',now,{x:portal.x,y:portal.y});
    player.faction='red';player.ap=12345;player.xm=2345;player.version=7;
    player.inventory=[{type:'key',level:1,portalId:portal.id,quantity:3}];
    await pool.query('UPDATE portals SET state=$1 WHERE id=$2',[occupied,portal.id]);
    await pool.query('INSERT INTO accounts(id,state,recovery_hash,init_hash,created_at) VALUES($1,$2,$3,$4,$5)',
      [accountId,player,`recovery-${accountId}`,`init-${accountId}`,now]);
    const original=await worldRow();
    await pool.query('UPDATE worlds SET state=$1,seq=1 WHERE id=1',[
      {...original.state,announcement:'旧世界公告',scores:{red:77,green:3,blue:0}}]);
    await pool.query('INSERT INTO command_receipts(actor,request_id,digest,result,seq,created_at) VALUES($1,$2,$3,$4,1,$5)',
      [accountId,receiptId,'migration-fixture',{requestId:receiptId,marker:'原收据'},now]);

    const oldExecutor=new Store(databaseUrl!,'migration-test-secret-at-least-32-characters');
    try {
      await oldExecutor.start();
      await pool.query('DELETE FROM schema_migrations WHERE version IN (2,3,4,5,6,7)');
      await pool.query('UPDATE worlds SET rules_hash=$1 WHERE id=1',[initialRulesHash]);
      const before=await worldRow();
      const beforePortals=(await pool.query('SELECT id,state FROM portals ORDER BY id')).rows;
      const beforeAccounts=(await pool.query('SELECT id,state,recovery_hash,init_hash,created_at FROM accounts ORDER BY id')).rows;
      const beforeReceipts=(await pool.query('SELECT actor,request_id,digest,result,seq::text,created_at FROM command_receipts ORDER BY request_id')).rows;

      await migrate(databaseUrl!);
      const after=await worldRow();
      expect(after.rules_hash).toBe(digest(RULES));
      expect(after.map_hash).toBe(before.map_hash);
      expect(after.epoch).toBe((BigInt(before.epoch)+6n).toString());
      expect(after.seq).toBe(before.seq);
      expect(after.state).toEqual(before.state);
      expect((await pool.query('SELECT id,state FROM portals ORDER BY id')).rows).toEqual(beforePortals);
      expect((await pool.query('SELECT id,state,recovery_hash,init_hash,created_at FROM accounts ORDER BY id')).rows).toEqual(beforeAccounts);
      expect((await pool.query('SELECT actor,request_id,digest,result,seq::text,created_at FROM command_receipts ORDER BY request_id')).rows).toEqual(beforeReceipts);
      await expect(oldExecutor.snapshot()).rejects.toMatchObject({code:'WORLD_RECOVERING'});
      await migrate(databaseUrl!);
      expect(await worldRow()).toEqual(after);
      expect((await pool.query('SELECT version FROM schema_migrations ORDER BY version')).rows.map(row=>row.version)).toEqual([1,2,3,4,5,6,7]);
    }finally{await oldExecutor.close()}
  });

  it('002 旧世界拆除七脚端点关联线和依赖场，写连续墓碑事件且不奖励 AP',async()=>{
    await migrate(databaseUrl!);
    const now=Date.now(),accountId=randomUUID(),receiptId=randomUUID();
    const [a,b,c,d,e]=BETA_MAP.portals.slice(0,5).map(portal=>portal.id);
    const ids=[a,b,c,d,e];
    for(const [index,id] of ids.entries()){
      const base=BETA_MAP.portals[index];
      const resonators=Array.from({length:8},(_,slot)=>index===0&&slot===7?null:{
        level:1,energy:1000,owner:accountId,ownerName:'迁移保留玩家',x:base.x,y:base.y,
        generation:`${id}-${slot}`,nextDecayAt:now+3_600_000});
      await pool.query('UPDATE portals SET state=$1 WHERE id=$2',[
        {...base,faction:'red',version:1,resonators},id]);
    }
    const edge=(x:string,y:string)=>[x,y].sort().join('|');
    const links:Link[]=[[a,b],[a,c],[b,c],[c,d],[c,e],[d,e]].map(([origin,destination])=>({
      id:edge(origin,destination),origin,destination,faction:'red',owner:accountId}));
    const fields:Field[]=[
      {id:[a,b,c].sort().join('|'),vertices:[a,b,c],links:[edge(a,b),edge(a,c),edge(b,c)],faction:'red',owner:accountId,mu:5,large:false},
      {id:[c,d,e].sort().join('|'),vertices:[c,d,e],links:[edge(c,d),edge(c,e),edge(d,e)],faction:'red',owner:accountId,mu:7,large:false}];
    const player=createPlayer(accountId,'迁移保留玩家',now,{x:BETA_MAP.portals[0].x,y:BETA_MAP.portals[0].y});
    player.faction='red';player.ap=8765;player.xm=4321;
    await pool.query('INSERT INTO accounts(id,state,recovery_hash,init_hash,created_at) VALUES($1,$2,$3,$4,$5)',
      [accountId,player,`recovery-${accountId}`,`init-${accountId}`,now]);
    const original=await worldRow();
    await pool.query('UPDATE worlds SET seq=6,state=$1 WHERE id=1',[
      {...original.state,seq:'6',links,fields,scores:{red:41,green:0,blue:0},announcement:'旧世界保留公告'}]);
    await pool.query('INSERT INTO command_receipts(actor,request_id,digest,result,seq,created_at) VALUES($1,$2,$3,$4,6,$5)',
      [accountId,receiptId,'old-receipt',{requestId:receiptId,marker:'历史收据'},now]);
    await pool.query(`INSERT INTO outbox(seq,event,created_at)
      SELECT n,jsonb_build_object('type','invalidate','committedSeq',n::text,
        'deleted',jsonb_build_object('links','[]'::jsonb,'fields','[]'::jsonb,
          'resonators','[]'::jsonb,'mods','[]'::jsonb),'privateAlerts','[]'::jsonb),$1
      FROM generate_series(1,6) AS n`,[now]);

    const oldExecutor=new Store(databaseUrl!,'migration-test-secret-at-least-32-characters');
    try{
      await oldExecutor.start();
      await pool.query('DELETE FROM schema_migrations WHERE version IN (3,4,5,6,7)');
      await pool.query('UPDATE worlds SET rules_hash=$1 WHERE id=1',[previousRulesHash]);
      const before=await worldRow();
      const beforePortals=(await pool.query('SELECT id,state FROM portals ORDER BY id')).rows;
      const beforeAccounts=(await pool.query('SELECT id,state FROM accounts ORDER BY id')).rows;
      const beforeReceipts=(await pool.query('SELECT actor,request_id,result,seq::text FROM command_receipts')).rows;

      await migrate(databaseUrl!);
      const after=await worldRow();
      expect(after.rules_hash).toBe(digest(RULES));
      expect(after.epoch).toBe((BigInt(before.epoch)+5n).toString());
      expect(after.seq).toBe('7');
      expect(after.state.seq).toBe('7');
      expect(after.state.links).toEqual(links.slice(2));
      expect(after.state.fields).toEqual([fields[1]]);
      expect(after.state.scores).toEqual(before.state.scores);
      expect(after.state.announcement).toBe(before.state.announcement);
      expect((await pool.query('SELECT id,state FROM portals ORDER BY id')).rows).toEqual(beforePortals);
      expect((await pool.query('SELECT id,state FROM accounts ORDER BY id')).rows).toEqual(beforeAccounts);
      expect((await pool.query('SELECT actor,request_id,result,seq::text FROM command_receipts')).rows).toEqual(beforeReceipts);
      expect((await pool.query('SELECT state FROM accounts WHERE id=$1',[accountId])).rows[0].state.ap).toBe(8765);
      const events=(await pool.query('SELECT seq::text,event FROM outbox ORDER BY seq')).rows;
      expect(events.map(row=>row.seq)).toEqual(['1','2','3','4','5','6','7']);
      expect(events[6].event).toMatchObject({type:'invalidate',committedSeq:'7',
        deleted:{links:[edge(a,b),edge(a,c)],fields:[fields[0].id],resonators:[],mods:[]},privateAlerts:[]});
      await expect(oldExecutor.snapshot()).rejects.toMatchObject({code:'WORLD_RECOVERING'});
      await migrate(databaseUrl!);
      expect(await worldRow()).toEqual(after);
      expect(Number((await pool.query('SELECT count(*)::integer AS n FROM outbox')).rows[0].n)).toBe(7);
      const replacement=new Store(databaseUrl!,'migration-test-secret-at-least-32-characters');
      try{
        await replacement.start();
        const snapshot=await replacement.snapshot();
        expect(snapshot.seq).toBe('7');
        expect(snapshot.links).toEqual(links.slice(2));
        expect(snapshot.fields).toEqual([fields[1]]);
      }finally{await replacement.close()}
    }finally{await oldExecutor.close()}
  });

  it('004升级至007保留旧40米脚与世界状态，未知摘要拒绝且事务回滚',async()=>{
    await migrate(databaseUrl!);
    const po=BETA_MAP.portals[0];
    const oldPortal={...po,faction:'red',resonators:[{level:1,energy:1000,owner:'legacy',x:po.x+4000,y:po.y,generation:'legacy',nextDecayAt:Date.now()+3600000},...Array(7).fill(null)]};
    await pool.query('UPDATE portals SET state=$1 WHERE id=$2',[oldPortal,po.id]);
    await pool.query('DELETE FROM schema_migrations WHERE version IN (5,6,7)');
    await pool.query('UPDATE worlds SET rules_hash=$1 WHERE id=1',['854452ad6a4eeae20c1d5a64864da9a5891d3a920920cc0c576e965b20b97166']);
    const before=await worldRow();
    await migrate(databaseUrl!);
    const after=await worldRow();
    expect(after).toEqual({...before,rules_hash:digest(RULES),epoch:(BigInt(before.epoch)+3n).toString()});
    expect((await pool.query('SELECT state FROM portals WHERE id=$1',[po.id])).rows[0].state).toEqual(oldPortal);
    await migrate(databaseUrl!);expect(await worldRow()).toEqual(after);
    await pool.query('DELETE FROM schema_migrations WHERE version IN (5,6,7)');
    await pool.query('UPDATE worlds SET rules_hash=$1 WHERE id=1',['unknown-004-hash']);
    const invalid=await worldRow();
    await expect(migrate(databaseUrl!)).rejects.toThrow('规则摘要不匹配');
    expect(await worldRow()).toEqual(invalid);
    expect((await pool.query('SELECT version FROM schema_migrations WHERE version IN (5,6,7)')).rows).toEqual([]);
  });

  it('003 升级至007只更新规则摘要和代次，不回填旧等级礼包，重复迁移不变',async()=>{
    await migrate(databaseUrl!);
    const original=await worldRow();
    const player=createPlayer(randomUUID(),'历史等级',Date.now(),BETA_MAP.portals[0]);
    player.ap=240000;player.faction='red';
    await pool.query('INSERT INTO accounts(id,state,recovery_hash,init_hash,created_at) VALUES($1,$2,$3,$4,$5)',
      [player.id,player,`recovery-${player.id}`,`init-${player.id}`,player.createdAt]);
    await pool.query('DELETE FROM schema_migrations WHERE version IN (4,5,6,7)');
    await pool.query('UPDATE worlds SET rules_hash=$1 WHERE id=1',['0ffdd0e607b88611db790b45531c53337b1b431205ab81c827a0a84f182f6e1f']);
    await migrate(databaseUrl!);
    const after=await worldRow();
    expect(after.rules_hash).toBe(digest(RULES));expect(after.state).toEqual(original.state);
    expect(after.epoch).toBe((BigInt(original.epoch)+4n).toString());
    expect((await pool.query('SELECT state FROM accounts WHERE id=$1',[player.id])).rows[0].state).toEqual(player);
    await migrate(databaseUrl!);expect(await worldRow()).toEqual(after);
  });

  it('未知旧规则摘要拒绝升级，迁移事务回滚且不改世界或执行器代次',async()=>{
    await migrate(databaseUrl!);
    await pool.query('DELETE FROM schema_migrations WHERE version IN (3,4,5,6,7)');
    await pool.query('UPDATE worlds SET rules_hash=$1 WHERE id=1',['unrelated-rules-hash']);
    const before=await worldRow();
    const count=Number((await pool.query('SELECT count(*)::integer AS n FROM portals')).rows[0].n);
    await expect(migrate(databaseUrl!)).rejects.toThrow(/规则摘要不匹配/);
    expect(await worldRow()).toEqual(before);
    expect(Number((await pool.query('SELECT count(*)::integer AS n FROM portals')).rows[0].n)).toBe(count);
    expect((await pool.query('SELECT version FROM schema_migrations ORDER BY version')).rows.map(row=>row.version)).toEqual([1,2]);
  });

  it('005升级007回填历史部署人姓名，保留脚属性、背包和地面物品，重复迁移不变',async()=>{
    await migrate(databaseUrl!);
    const id=randomUUID(),now=Date.now(),po=BETA_MAP.portals[0];
    const player=createPlayer(id,'历史部署人',now,po);
    await pool.query('INSERT INTO accounts(id,state,recovery_hash,init_hash,created_at) VALUES($1,$2,$3,$4,$5)',[id,player,`recovery-${id}`,`init-${id}`,now]);
    const foot={level:1,energy:987,owner:id,x:po.x,y:po.y,generation:'legacy',nextDecayAt:now+3600000};
    const portal={...po,version:7,resonators:[foot,...Array(7).fill(null)]};
    await pool.query('UPDATE portals SET state=$1 WHERE id=$2',[portal,po.id]);
    const before=await worldRow();
    before.state.droppedItems=[{id:'old-drop',x:po.x,y:po.y,droppedAt:now,item:{type:'key',level:1,portalId:po.id,quantity:1}}];
    await pool.query('UPDATE worlds SET state=$1 WHERE id=1',[before.state]);
    await pool.query('DELETE FROM schema_migrations WHERE version IN (6,7)');
    await pool.query('UPDATE worlds SET rules_hash=$1 WHERE id=1',['08d64d0669a96f9154d72814c4fb1e797befcc51b0d6b2a5ee858ae93394bff7']);
    await migrate(databaseUrl!);
    expect((await pool.query('SELECT state FROM portals WHERE id=$1',[po.id])).rows[0].state).toEqual({...portal,version:8,resonators:[{...foot,ownerName:'历史部署人'},...Array(7).fill(null)]});
    expect((await pool.query('SELECT state FROM accounts WHERE id=$1',[id])).rows[0].state).toEqual(player);
    const after=await worldRow();expect(after.state).toEqual(before.state);expect(after.rules_hash).toBe(digest(RULES));
    await migrate(databaseUrl!);expect(await worldRow()).toEqual(after);
  });
});

if(!databaseUrl)console.warn('迁移测试跳过：未提供 MIGRATION_TEST_DATABASE_URL（必须是独立 test 数据库）');
