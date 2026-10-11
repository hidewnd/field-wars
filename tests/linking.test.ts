import {describe,expect,it} from 'vitest';
import {validateLinkTarget} from '../shared/linking.js';
import {RULES} from '../shared/rules.js';
import {createPlayer} from '../shared/engine.js';
import type {Faction,Link,Player,Portal,World} from '../shared/types.js';

function portal(id:string,x:number,y:number,faction:Faction='red',legs=8):Portal {
  return {id,name:id,districtId:'D-01',x,y,faction,version:1,
    resonators:Array.from({length:8},(_,slot)=>slot<legs?{level:1,energy:1000,owner:'player',x,y,generation:`${id}-${slot}`,nextDecayAt:86_400_000}:null),
    mods:[null,null,null,null]};
}
function setup(destinationX=10_000):{world:World;player:Player} {
  const player=createPlayer('player','测试者',0,{x:0,y:0});
  player.faction='red';player.inventory=[{type:'key',level:1,portalId:'B',quantity:1}];
  const a=portal('A',0,0),b=portal('B',destinationX,0);
  return {player,world:{seq:'0',logicalAt:0,season:{id:1,startAt:0,endAt:604_800_000},nextCheckpoint:300_000,
    portals:{A:a,B:b},links:[],fields:[],scores:{red:0,green:0,blue:0},maintenance:false,announcement:''}};
}
function code(work:()=>unknown):string {
  try{work();return 'OK'}catch(error){return (error as {code?:string}).code??'UNKNOWN'}
}

describe('连线候选和最终命令共用目标资格',()=>{
  it('仅持有目标 B 的正数量 Key 才列为可选，保护 Key 不妨碍手动连线',()=>{
    const {world,player}=setup();
    const before=structuredClone(world);
    expect(validateLinkTarget(world,player,'A','B').link.id).toBe('A|B');
    expect(world).toEqual(before);
    player.inventory=[{type:'key',level:1,portalId:'C',quantity:4}];
    expect(code(()=>validateLinkTarget(world,player,'A','B'))).toBe('KEY_REQUIRED');
    player.inventory=[{type:'key',level:1,portalId:'B',quantity:0}];
    expect(code(()=>validateLinkTarget(world,player,'A','B'))).toBe('KEY_REQUIRED');
    player.inventory=[{type:'key',level:2,portalId:'B',quantity:1}];
    expect(code(()=>validateLinkTarget(world,player,'A','B'))).toBe('KEY_REQUIRED');
    player.inventory=[{type:'key',level:1,portalId:'B',quantity:1,protected:true}];
    expect(code(()=>validateLinkTarget(world,player,'A','B'))).toBe('OK');
  });

  it('任一端不足八脚、目标敌对或玩家未选阵营都排除',()=>{
    const {world,player}=setup();
    world.portals.A=portal('A',0,0,'red',7);
    expect(code(()=>validateLinkTarget(world,player,'A','B'))).toBe('LINK_UNAVAILABLE');
    world.portals.A=portal('A',0,0);
    world.portals.B=portal('B',10_000,0,'red',7);
    expect(code(()=>validateLinkTarget(world,player,'A','B'))).toBe('LINK_UNAVAILABLE');
    world.portals.B=portal('B',10_000,0,'blue');
    expect(code(()=>validateLinkTarget(world,player,'A','B'))).toBe('LINK_UNAVAILABLE');
    world.portals.B=portal('B',10_000,0);
    player.faction=null;
    expect(code(()=>validateLinkTarget(world,player,'A','B'))).toBe('LINK_UNAVAILABLE');
  });

  it('L1 满脚射程精确含端点，超出一厘米排除；八条出线后排除',()=>{
    const edge=setup(RULES.rangeCm[8]);
    expect(code(()=>validateLinkTarget(edge.world,edge.player,'A','B'))).toBe('OK');
    edge.world.portals.B.x++;
    expect(code(()=>validateLinkTarget(edge.world,edge.player,'A','B'))).toBe('LINK_RANGE');
    const saturated=setup();
    saturated.world.links=Array.from({length:RULES.link.maxOutgoing},(_,index):Link=>({
      id:`A|C${index}`,origin:'A',destination:`C${index}`,faction:'red',owner:'other'}));
    expect(code(()=>validateLinkTarget(saturated.world,saturated.player,'A','B'))).toBe('LINK_LIMIT');
  });

  it('已有边、交叉边和穿第三 PO 在候选层与命令层得到同一几何错误',()=>{
    const {world,player}=setup();
    world.links=[{id:'A|B',origin:'A',destination:'B',faction:'red',owner:'other'}];
    expect(code(()=>validateLinkTarget(world,player,'A','B'))).toBe('LINK_EXISTS');
    world.links=[];world.portals.C=portal('C',5_000,0);
    expect(code(()=>validateLinkTarget(world,player,'A','B'))).toBe('LINK_THROUGH_PORTAL');
    world.portals.C=portal('C',5_000,-2_000);
    world.portals.D=portal('D',5_000,2_000);
    world.links=[{id:'C|D',origin:'C',destination:'D',faction:'red',owner:'other'}];
    expect(code(()=>validateLinkTarget(world,player,'A','B'))).toBe('LINK_CROSSING');
  });

  it('相同目标、未知 PO 都不是合法候选',()=>{
    const {world,player}=setup();
    expect(code(()=>validateLinkTarget(world,player,'A','A'))).toBe('PORTAL_NOT_FOUND');
    expect(code(()=>validateLinkTarget(world,player,'A','missing'))).toBe('PORTAL_NOT_FOUND');
  });
});
