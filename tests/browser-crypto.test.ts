import {createHash,webcrypto} from 'node:crypto';
import {afterEach,expect,it,vi} from 'vitest';
import {requestId,recoveryFingerprint} from '../apps/field-wars/src/crypto';
afterEach(()=>vi.unstubAllGlobals());
it('仅有 getRandomValues 的 HTTP 环境仍生成随机 UUID v4',()=>{
  vi.stubGlobal('crypto',{getRandomValues:webcrypto.getRandomValues.bind(webcrypto)});
  const ids=Array.from({length:100},()=>requestId());
  expect(new Set(ids).size).toBe(ids.length);
  for(const id of ids)expect(id).toMatch(/^[a-f\d]{8}-[a-f\d]{4}-4[a-f\d]{3}-[89ab][a-f\d]{3}-[a-f\d]{12}$/);
});
it.each(['','abc','cc-恢复码测试','cc-'+ 'a'.repeat(43)])('恢复码指纹与既有 SHA-256 格式一致：%s',value=>{
  vi.stubGlobal('crypto',{getRandomValues:webcrypto.getRandomValues.bind(webcrypto)});
  expect(recoveryFingerprint(value)).toBe(createHash('sha256').update(value).digest('hex'));
});
