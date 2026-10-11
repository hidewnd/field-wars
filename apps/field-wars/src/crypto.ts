import {sha256} from '@noble/hashes/sha2.js';

// 私网 HTTP 没有 randomUUID/subtle，仍用浏览器安全随机源生成符合 UUID v4 的请求标识。
export function requestId():string {
  const bytes=crypto.getRandomValues(new Uint8Array(16));
  bytes[6]=(bytes[6]&15)|64;
  bytes[8]=(bytes[8]&63)|128;
  const hex=Array.from(bytes,byte=>byte.toString(16).padStart(2,'0')).join('');
  return `${hex.slice(0,8)}-${hex.slice(8,12)}-${hex.slice(12,16)}-${hex.slice(16,20)}-${hex.slice(20)}`;
}

export function recoveryFingerprint(value:string):string {
  return Array.from(sha256(new TextEncoder().encode(value)),byte=>byte.toString(16).padStart(2,'0')).join('');
}
