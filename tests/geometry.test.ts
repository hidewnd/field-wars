import { describe, expect, it } from 'vitest';
import { BETA_MAP, validateBetaMap } from '../shared/map.js';
import { RULES, levelForAp, portalLevel, portalRange } from '../shared/rules.js';
import { distanceSquared, fieldMu, isLargeField, lineClearanceAtLeast, segmentsConflict, triangleContains, validateLink, validateNewPortalLocation } from '../shared/geometry.js';
import type { Field, Link, Portal, World } from '../shared/types.js';

function point(id: string, x: number, y: number): Portal {
  return {id, name:id, districtId:'D-01', x, y, faction:'red', version:0,
    resonators:Array(8).fill({level:1,energy:1000,owner:'p',x,y,generation:'g',nextDecayAt:0}), mods:[null,null,null,null]};
}

function world(portals: Portal[], links: Link[] = [], fields: Field[] = []): World {
  return {seq:'0',logicalAt:0,season:{id:1,startAt:0,endAt:1},nextCheckpoint:1,
    portals:Object.fromEntries(portals.map(portal => [portal.id,portal])),links,fields,
    scores:{red:0,green:0,blue:0},maintenance:false,announcement:''};
}

describe('冻结地图和规则', () => {
  it('20 区各有可用的 L1 核心三角，范围表为冻结的 65 个整数厘米值', () => {
    expect(() => validateBetaMap()).not.toThrow();
    expect(RULES.rangeCm).toHaveLength(65);
    expect(RULES.rangeCm[8]).toBe(16_000);
    expect(RULES.rangeCm[64]).toBe(2_352_534);
    for (const district of BETA_MAP.districts) {
      const core = BETA_MAP.portals.filter(portal => portal.districtId === district.id && portal.role === 'core');
      expect(core).toHaveLength(3);
      expect(core.every((portal, index) => core.every((other, j) => index === j || distanceSquared(portal, other) <= 16_000n ** 2n))).toBe(true);
      expect(fieldMu(core[0], core[1], core[2])).toBeGreaterThan(0);
    }
    expect(levelForAp(499)).toBe(1);
    expect(levelForAp(500)).toBe(2);
    expect(portalLevel(point('a',0,0))).toBe(1);
    expect(portalRange(point('a',0,0))).toBe(RULES.minimumPortalRangeCm);
  });
  it('L1连线范围为320米，混合升级不缩短射程，高等级保留原范围',()=>{
    const portal=point('a',0,0);
    expect(portalRange(portal)).toBe(32000);
    portal.resonators=portal.resonators.map((r,index)=>({...r!,level:index===0?2:1}));
    expect(portalRange(portal)).toBeGreaterThanOrEqual(32000);
    portal.resonators=portal.resonators.map(r=>({...r!,level:8}));
    expect(portalRange(portal)).toBe(RULES.rangeCm[64]);
  });
});

describe('精确线场几何', () => {
  it('1000 米恰属小场，边界之外才算大场；整数根 MU 在阈值两侧稳定', () => {
    const a={x:0,y:0}, b={x:100_000,y:0}, c={x:0,y:100_000};
    expect(isLargeField(a,b,{x:50_000,y:1})).toBe(false);
    expect(isLargeField(a,b,c)).toBe(true);
    expect(fieldMu(a,b,c)).toBe(35);
    expect(fieldMu(a,{x:1,y:0},{x:0,y:1})).toBe(1);
  });

  it('允许复用共同端点，拒绝交叉、部分共线与穿过第三点', () => {
    const a={x:0,y:0}, b={x:10,y:10}, c={x:10,y:0}, d={x:0,y:10};
    expect(segmentsConflict(a,b,c,d)).toBe(true);
    expect(segmentsConflict(a,b,a,d)).toBe(false);
    expect(segmentsConflict(a,b,{x:5,y:5},{x:15,y:15})).toBe(true);
    expect(() => validateLink(world([point('A',0,0),point('B',20,0),point('C',10,0)]),'A','B','p')).toThrowError('LINK_THROUGH_PORTAL');
  });

  it('闭合时枚举所有共同邻点，一条边创建全部合法场', () => {
    const ps=[point('A',0,0),point('B',100,0),point('C',0,100),point('D',100,-100)];
    const links:Link[]=[{id:'A|C',origin:'A',destination:'C',faction:'red',owner:'p'},
      {id:'B|C',origin:'B',destination:'C',faction:'red',owner:'p'},
      {id:'A|D',origin:'A',destination:'D',faction:'red',owner:'p'},
      {id:'B|D',origin:'B',destination:'D',faction:'red',owner:'p'}];
    expect(validateLink(world(ps,links),'A','B','p').fields.map(field => field.id)).toEqual(['A|B|C','A|B|D']);
  });

  it('大场真包含与建造顺序无关，边界接触仍按包含处理', () => {
    const outer:[{x:number;y:number},{x:number;y:number},{x:number;y:number}]=[{x:0,y:0},{x:300_000,y:0},{x:0,y:300_000}];
    const inner:[{x:number;y:number},{x:number;y:number},{x:number;y:number}]=[{x:0,y:0},{x:120_000,y:0},{x:0,y:120_000}];
    expect(triangleContains(inner,outer)).toBe(true);
    expect(triangleContains(outer,inner)).toBe(false);
  });

  it('新增点缓冲包含河岸线宽，距边界恰好达标', () => {
    const terrain={points:[{x:0,y:0},{x:10_000,y:0}],halfWidth:100};
    expect(lineClearanceAtLeast({x:5_000,y:1_100},terrain,1_000)).toBe(true);
    expect(lineClearanceAtLeast({x:5_000,y:1_099},terrain,1_000)).toBe(false);
    const map={...BETA_MAP,water:[],rails:[]};
    expect(() => validateNewPortalLocation(map,[],{x:15_000,y:15_000},'D-01')).not.toThrow();
    expect(RULES.newPortals.minApprovedSpacingCm).toBe(500);
    expect(RULES.newPortals.cityBoundaryClearanceCm).toBe(15_000);
    expect(RULES.newPortals.waterShoreClearanceCm).toBe(12_000);
    expect(RULES.newPortals.railCenterlineClearanceCm).toBe(8_000);
    expect(() => validateNewPortalLocation(map,[{x:15_000,y:15_000}],{x:15_499,y:15_000},'D-01')).toThrowError('PO_SPACING');
    expect(() => validateNewPortalLocation(map,[{x:15_000,y:15_000}],{x:15_500,y:15_000},'D-01')).not.toThrow();
    expect(BETA_MAP.water[0].halfWidth).toBe(15_000);
    expect(BETA_MAP.rails[0].halfWidth).toBe(0);
    expect(BETA_MAP.water[0].points).toHaveLength(329);
    expect(BETA_MAP.rails[0].points).toHaveLength(6);
    for(const portal of BETA_MAP.portals) {
      expect(BETA_MAP.water.every(line=>lineClearanceAtLeast(portal,line,12_000))).toBe(true);
      expect(BETA_MAP.rails.every(line=>lineClearanceAtLeast(portal,line,8_000))).toBe(true);
    }
  });

  it('跨阵营大场真包含在先内后外与先外后内均拒绝', () => {
    const inner=[point('I1',0,0),point('I2',120_000,0),point('I3',0,120_000)];
    const outer=[point('O1',-50_000,-10_000),point('O2',300_000,-10_000),point('O3',-50_000,300_000)];
    const innerField:Field={id:'I1|I2|I3',vertices:['I1','I2','I3'],links:[],faction:'green',owner:'g',mu:100,large:true};
    const outerField:Field={id:'O1|O2|O3',vertices:['O1','O2','O3'],links:[],faction:'green',owner:'g',mu:100,large:true};
    const innerLinks:Link[]=[{id:'I1|I3',origin:'I1',destination:'I3',faction:'red',owner:'r'},
      {id:'I2|I3',origin:'I2',destination:'I3',faction:'red',owner:'r'}];
    const outerLinks:Link[]=[{id:'O1|O3',origin:'O1',destination:'O3',faction:'red',owner:'r'},
      {id:'O2|O3',origin:'O2',destination:'O3',faction:'red',owner:'r'}];
    expect(() => validateLink(world([...inner,...outer.map(portal=>({...portal,faction:'green' as const}))],innerLinks,[outerField]),'I1','I2','r')).toThrowError('FIELD_NESTING');
    expect(() => validateLink(world([...inner.map(portal=>({...portal,faction:'green' as const})),...outer],outerLinks,[innerField]),'O1','O2','r')).toThrowError('FIELD_NESTING');
  });

  it('同一新边闭合两场时一场违规则整条边和所有候选均不创建', () => {
    const ps=[point('A',0,0),point('B',120_000,0),point('C',0,120_000),point('D',0,-120_000),
      point('E',-50_000,-10_000),point('F',300_000,-10_000),point('G',-50_000,300_000)];
    const links:Link[]=[{id:'A|C',origin:'A',destination:'C',faction:'red',owner:'r'},
      {id:'B|C',origin:'B',destination:'C',faction:'red',owner:'r'},
      {id:'A|D',origin:'A',destination:'D',faction:'red',owner:'r'},
      {id:'B|D',origin:'B',destination:'D',faction:'red',owner:'r'}];
    const old:Field={id:'E|F|G',vertices:['E','F','G'],links:[],faction:'green',owner:'g',mu:100,large:true};
    const state=world(ps.map(portal=>['E','F','G'].includes(portal.id)?{...portal,faction:'green' as const}:portal),links,[old]),before=structuredClone(state);
    expect(() => validateLink(state,'A','B','r')).toThrowError('FIELD_NESTING');
    expect(state).toEqual(before);
  });
});
