import {createHash} from 'node:crypto';
import {isIP} from 'node:net';
export interface Config {databaseUrl:string;secret:string;adminPassword:string;origin:string;lanOrigin?:string;cookieSecure:boolean;port:number;host:string}
export function readConfig():Config {
  const databaseUrl=process.env.DATABASE_URL, secret=process.env.SESSION_SECRET, adminPassword=process.env.ADMIN_PASSWORD;
  if(!databaseUrl || !secret || secret.length<32 || !adminPassword || adminPassword.length<16) throw new Error('DATABASE_URL、至少32字符SESSION_SECRET和至少16字符ADMIN_PASSWORD为必需配置');
  const origin=process.env.PUBLIC_ORIGIN??'http://localhost:8080';
  const url=new URL(origin);
  const cookieSecure=process.env.COOKIE_SECURE==='true';
  if(!['localhost','127.0.0.1','[::1]'].includes(url.hostname) && (url.protocol!=='https:' || !cookieSecure)) throw new Error('对外访问必须配置 HTTPS 和 COOKIE_SECURE=true');
  if(!['http:','https:'].includes(url.protocol) || url.origin!==origin) throw new Error('PUBLIC_ORIGIN 只能包含协议、主机和端口');
  const lanOrigin=process.env.LAN_ORIGIN;
  if(lanOrigin!==undefined) {
    const lan=new URL(lanOrigin), octets=lan.hostname.split('.').map(Number);
    const privateIp=isIP(lan.hostname)===4 && (octets[0]===10 || (octets[0]===172 && octets[1]>=16 && octets[1]<=31) || (octets[0]===192 && octets[1]===168));
    // 明文入口只允许显式配置的私网 IP；不能据此放开任意来源或公网 HTTP。
    if(lan.protocol!=='http:' || lan.origin!==lanOrigin || !privateIp) throw new Error('LAN_ORIGIN 必须是仅含协议、私网 IPv4 和端口的 HTTP 来源');
  }
  return {databaseUrl,secret,adminPassword,origin,lanOrigin,cookieSecure,port:Number(process.env.PORT??3000),host:process.env.HOST??'0.0.0.0'};
}
export function digest(value:unknown):string {return createHash('sha256').update(typeof value==='string'?value:JSON.stringify(value)).digest('hex')}

export function isAllowedOrigin(config:Config, origin:unknown):origin is string {
  return typeof origin==='string' && (origin===config.origin || origin===config.lanOrigin);
}
