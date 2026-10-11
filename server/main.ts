import {buildApp} from './app.js';
import {readConfig} from './config.js';
const config=readConfig();
const app=await buildApp(config);
await app.listen({port:config.port,host:config.host});
process.stdout.write(`场域战争 beta-v1 已就绪，端口 ${config.port}\n`);
for(const signal of ['SIGINT','SIGTERM'] as const)process.once(signal,()=>{void app.close().then(()=>process.exit(0)).catch(()=>process.exit(1))});
