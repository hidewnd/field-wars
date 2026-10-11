import {readFile,readdir} from 'node:fs/promises';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {Pool} from 'pg';
import {digest,readConfig} from './config.js';
import {BETA_MAP,validateBetaMap} from '../shared/map.js';
import {RULES} from '../shared/rules.js';
import {createWorld} from '../shared/engine.js';

export async function migrate(databaseUrl:string):Promise<void> {
 const pool=new Pool({connectionString:databaseUrl}); const client=await pool.connect();
 try {
  await client.query('BEGIN');
  await client.query('SELECT pg_advisory_xact_lock(746219)');
  const files=(await readdir(path.resolve('server/migrations'))).filter(n=>/^\d+_.+\.sql$/.test(n)).sort();
  const exists=(await client.query("SELECT to_regclass('public.schema_migrations') AS t")).rows[0].t;
  const applied=exists?(await client.query('SELECT version,checksum FROM schema_migrations ORDER BY version')).rows:[];
  if(applied.length>files.length) throw new Error('数据库版本高于当前程序，禁止降级启动');
  for(const filename of files) {
   const sql=await readFile(path.resolve('server/migrations',filename),'utf8'); const version=Number(filename.split('_')[0]); const checksum=digest(sql);
   const old=applied.find(r=>r.version===version);
   if(old) {if(old.checksum!==checksum) throw new Error('已应用迁移摘要不一致: '+filename);continue}
   await client.query(sql);
   await client.query('INSERT INTO schema_migrations(version,checksum) VALUES($1,$2)',[version,checksum]);
  }
  validateBetaMap();
  const row=(await client.query('SELECT rules_hash,map_hash FROM worlds WHERE id=1 FOR UPDATE')).rows[0];
  if(row && (row.rules_hash!==digest(RULES)||row.map_hash!==digest(BETA_MAP))) throw new Error('规则或地图与既有世界不一致，需显式迁移');
  if(!row){
   const world=createWorld(BETA_MAP,Date.now()); const {portals,...state}=world;
   await client.query('INSERT INTO worlds(id,rules_hash,map_hash,state) VALUES(1,$1,$2,$3)',[digest(RULES),digest(BETA_MAP),state]);
   await client.query('INSERT INTO portals(id,state) SELECT p->>\'id\',p FROM jsonb_array_elements($1::jsonb) p',[JSON.stringify(Object.values(portals))]);
  }
  await client.query('COMMIT');
 } catch(e){await client.query('ROLLBACK');throw e} finally {client.release();await pool.end()}
}
if(process.argv[1] && path.resolve(process.argv[1])===fileURLToPath(import.meta.url)) {
 migrate(readConfig().databaseUrl).then(()=>console.log('数据库迁移和世界初始化完成')).catch(error=>{const message=error instanceof Error?error.message:'';const diagnostic=/^(数据库版本高于|已应用迁移摘要|规则或地图与既有世界|MAP_)/.test(message)?message:'数据库连接或迁移执行失败，请检查连接配置及数据库日志';console.error('数据库迁移失败：'+diagnostic);process.exitCode=1});
}
