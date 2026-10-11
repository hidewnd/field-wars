import {describe, expect, it} from 'vitest';
import {absorbGroundXm, refreshGroundXm} from '../shared/ground-xm.js';
import {applyCommand, createPlayer, createWorld, refreshPlayer} from '../shared/engine.js';
import {BETA_MAP} from '../shared/map.js';
import type {GroundXm} from '../shared/types.js';

function fixture() {
  const world=createWorld(BETA_MAP,0), player=createPlayer('collector','收集者',0,{x:10000,y:10000});
  player.faction='red';player.xm=1000;
  world.groundXm=[{id:'point',x:10000,y:10000,amount:50,spawnedAt:0,expiresAt:300000}];
  return {world,player};
}

describe('共享地面 XM',()=>{
  it('现实五分钟一批，PO 周边与随机点有界且同批重试相同，重启不刷回已领取点',()=>{
    const {world}=fixture();refreshGroundXm(world,BETA_MAP,1);
    const points=structuredClone(world.groundXm!);
    expect(points).toHaveLength(Object.keys(world.portals).length*18+200);
    expect(new Set(points.map(p=>p.id)).size).toBe(points.length);
    expect(points.every(p=>p.amount===50 && p.x>=0 && p.x<=BETA_MAP.width && p.y>=0 && p.y<=BETA_MAP.height)).toBe(true);
    const portals=Object.values(world.portals).sort((a,b)=>a.id.localeCompare(b.id));
    portals.forEach((portal,index)=>expect(points.slice(index*18,index*18+18).every(p=>Math.hypot(p.x-portal.x,p.y-portal.y)<=4501)).toBe(true));
    world.groundXm!.shift();const restarted=JSON.parse(JSON.stringify(world));
    refreshGroundXm(restarted,BETA_MAP,299999);expect(restarted.groundXm).toEqual(points.slice(1));
    const fresh=createWorld(BETA_MAP,0);refreshGroundXm(fresh,BETA_MAP,1);expect(fresh.groundXm).toEqual(points);
    refreshGroundXm(restarted,BETA_MAP,300000);expect(restarted.groundXm[0].id).not.toBe(points[0].id);
    refreshGroundXm(restarted,BETA_MAP,86400001);expect(restarted.groundXm).toHaveLength(points.length);
    expect(restarted.nextGroundXmAt).toBe(86700000);
  });

  it.each([2999,3000,3001])('距离 %i 厘米按30米含边界自动收集',distance=>{
    const {world,player}=fixture();world.groundXm![0].x+=distance;
    expect(absorbGroundXm(world,player,player,0)).toBe(distance<=3000?50:0);
    expect(world.groundXm).toHaveLength(distance<=3000?0:1);
  });

  it('满能量不消耗，部分吸收封顶并留下剩余量；另一玩家只能取剩余量',()=>{
    const {world,player}=fixture();player.xm=3000;
    expect(absorbGroundXm(world,player,player,0)).toBe(0);
    expect(world.groundXm![0].amount).toBe(50);
    player.xm=2980;expect(absorbGroundXm(world,player,player,0)).toBe(20);
    expect(player.xm).toBe(3000);expect(world.groundXm![0].amount).toBe(30);
    const other={...player,id:'other',xm:0};expect(absorbGroundXm(world,other,other,0)).toBe(30);
    expect(absorbGroundXm(world,other,other,0)).toBe(0);expect(world.groundXm).toEqual([]);
  });

  it('快速移动经过范围可吸收，但点生成前经过的路段、过期点不可领取',()=>{
    const {world,player}=fixture();
    player.movement={from:{x:0,y:10000},to:{x:24000,y:10000},startAt:0,arriveAt:20000};player.x=0;
    const point=world.groundXm![0];
    const cases:[Partial<GroundXm>,number][]=[[{},50],[{spawnedAt:18000},0],[{expiresAt:10000},0]];
    for(const [change,expected] of cases){
      world.groundXm=[{...point,amount:50,...change}];
      const refreshed=refreshPlayer(player,20000);
      expect(absorbGroundXm(world,player,refreshed,20000)).toBe(expected);
    }
  });

  it.each(['move','move-cancel'])('改道/停止 %s 先结算旧路径，失败命令不修改世界和玩家',type=>{
    const {world,player}=fixture();player.x=0;
    player.movement={from:{x:0,y:10000},to:{x:48000,y:10000},startAt:0,arriveAt:40000};
    const context={now:20000,map:BETA_MAP,random:()=>.5,id:()=> 'test'};
    const before=structuredClone({world,player});
    expect(()=>applyCommand(world,player,{type:'unknown',payload:{}},context)).toThrow();
    expect({world,player}).toEqual(before);
    const out=applyCommand(world,player,{type,payload:{x:24000,y:30000}},context);
    expect(out.player.xm).toBe(1150);expect(out.world.groundXm).toEqual([]);
    expect(out.player.x).toBe(24000);
  });
});
