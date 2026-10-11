import {afterEach,describe,expect,it,vi} from 'vitest';
import Fastify from 'fastify';
import cookie from '@fastify/cookie';
import {readConfig,isAllowedOrigin,type Config} from '../server/config.js';
import {Auth} from '../server/auth.js';
import type {Store} from '../server/store.js';

const config:Config={databaseUrl:'postgresql://test/test',secret:'test-secret-with-at-least-32-characters',adminPassword:'test-admin-password',origin:'https://game.hidewnd.cn',lanOrigins:['http://192.168.3.61:8080','http://192.168.3.65:8801'],cookieSecure:true,port:3000,host:'127.0.0.1'};
afterEach(()=>vi.unstubAllEnvs());
function env(lan:string) {
  vi.stubEnv('DATABASE_URL',config.databaseUrl);
  vi.stubEnv('SESSION_SECRET',config.secret);
  vi.stubEnv('ADMIN_PASSWORD',config.adminPassword);
  vi.stubEnv('PUBLIC_ORIGIN',config.origin);
  vi.stubEnv('COOKIE_SECURE','true');
  vi.stubEnv('LAN_ORIGINS',lan);
}
describe('部署来源边界',()=>{
  it.each(['http://10.0.0.1:8080','http://172.16.0.1','http://172.31.255.254','http://192.168.3.61:8080','http://192.168.3.61:8080,http://192.168.3.65:8801'])('只接受显式私网 IPv4 来源 %s',origin=>{
    env(origin);expect(readConfig().lanOrigins).toEqual(origin.split(','));
  });
  it.each(['http://8.8.8.8','http://172.15.0.1','http://172.32.0.1','http://example.com','http://192.168.3.61/path','http://user:pass@192.168.3.61','https://192.168.3.61',''])('拒绝非法 LAN 来源 %s',origin=>{
    env(origin);expect(()=>readConfig()).toThrow();
  });
  it('仍拒绝公网 HTTP 主入口和未开启 Secure 的公网 HTTPS',()=>{
    env(config.lanOrigins![0]);vi.stubEnv('PUBLIC_ORIGIN','http://game.hidewnd.cn');expect(()=>readConfig()).toThrow();
    vi.stubEnv('PUBLIC_ORIGIN',config.origin);vi.stubEnv('COOKIE_SECURE','false');expect(()=>readConfig()).toThrow();
  });
  it('来源必须精确匹配，未配置 LAN 时缺失来源也不能通过',()=>{
    expect(isAllowedOrigin(config,config.origin)).toBe(true);
    expect(isAllowedOrigin(config,config.lanOrigins![0])).toBe(true);
    for(const origin of [undefined,'null','https://evil.example','http://192.168.3.61:8081','http://game.hidewnd.cn'])expect(isAllowedOrigin(config,origin)).toBe(false);
    expect(isAllowedOrigin({...config,lanOrigins:undefined},undefined)).toBe(false);
  });
  it.each([[config.origin,true],[config.lanOrigins![0],false],[config.lanOrigins![1],false]] as const)('登录 Cookie 按已验证入口设置 Secure：%s',async(origin,secure)=>{
    const app=Fastify();await app.register(cookie);
    const query=vi.fn().mockResolvedValue({rowCount:1,rows:[{token_hash:'test'}]});
    const auth=new Auth(config,{pool:{query}} as unknown as Store);
    app.post('/login',(req,reply)=>auth.adminLogin(req,reply,config.adminPassword));
    app.post('/protected',req=>auth.protect(req,true));
    try {
      const response=await app.inject({method:'POST',url:'/login',headers:{origin}});
      expect(response.statusCode).toBe(200);
      const header=String(response.headers['set-cookie']);
      expect(header.includes('; Secure')).toBe(secure);expect(header).toContain('HttpOnly');expect(header).toContain('SameSite=Strict');
      const sessionCookie=header.split(';')[0];
      const missing=await app.inject({method:'POST',url:'/protected',headers:{origin,cookie:sessionCookie}});
      expect(missing.json().message).toBe('安全令牌无效');
      const valid=await app.inject({method:'POST',url:'/protected',headers:{origin,cookie:sessionCookie,'x-csrf-token':response.json().csrfToken}});
      expect(valid.statusCode).toBe(200);
      const denied=await app.inject({method:'POST',url:'/login',headers:{origin:'https://evil.example'}});
      expect(denied.headers['set-cookie']).toBeUndefined();expect(denied.json().message).toBe('请求来源不匹配');
    } finally {await app.close();}
  });
});
