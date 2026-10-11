import {describe, expect, it} from 'vitest';
import {advanceWorld, applyCommand, createPlayer, createWorld, GameError, refreshPlayer} from '../shared/engine.js';
import type {CommandContext, Faction, MapData, Player, Portal, World} from '../shared/types.js';
import {RULES} from '../shared/rules.js';

function portal(id: string, x: number, y: number): Portal {
  return {id, name: id, x, y, districtId: 'd', faction: null, version: 0,
    resonators: Array(8).fill(null), mods: Array(4).fill(null)};
}
const points = [portal('A', 10000, 10000), portal('B', 20000, 10000), portal('C', 15000, 18000)];
const map: MapData = {version: 'beta-v1', width: 100000, height: 100000, districts: [], spawns: [], water: [], rails: [], centers: [], portals: points};
let serial = 0;
function ctx(now = 0, roll = .5): CommandContext {return {now, map, random: () => roll, id: () => `gen-${++serial}`};}
function doCommand(world: World, player: Player, type: string, portalId?: string, payload: Record<string, unknown> = {}, now = 0) {
  return applyCommand(world, player, {type, portalId, payload}, ctx(now));
}
function rejectedCode(action: () => unknown): string {
  try {action();} catch (error) {
    expect(error).toBeInstanceOf(GameError);
    return (error as GameError).code;
  }
  throw new Error('预期命令被拒绝');
}
function joined(): {world: World; player: Player} {
  const world = createWorld(map, 0), player = createPlayer('p', '玩家', 0, points[0]);
  const joined = doCommand(world, player, 'faction', undefined, {faction: 'red'});
  return {world: joined.world, player: joined.player};
}
function linkedWorld(): World {
  const world = createWorld(map, 0);
  for (const [id, x, y] of [['D', 70000, 70000], ['E', 80000, 70000], ['F', 75000, 78000]] as const) {
    world.portals[id] = portal(id, x, y);
  }
  for (const point of Object.values(world.portals)) {
    point.faction = 'blue';
    point.resonators = Array.from({length: 8}, (_, slot) => ({level: 1, energy: 1000, owner: 'enemy', x: point.x, y: point.y,
      generation: `${point.id}-${slot}`, nextDecayAt: 172800000}));
  }
  world.links = [['A', 'B'], ['B', 'C'], ['A', 'C'], ['D', 'E'], ['E', 'F'], ['D', 'F']].map(([origin, destination]) =>
    ({id: `${origin}|${destination}`, origin, destination, faction: 'blue', owner: 'enemy'}));
  world.fields = [
    {id: 'A|B|C', vertices: ['A', 'B', 'C'], links: ['A|B', 'B|C', 'A|C'], faction: 'blue', owner: 'enemy', mu: 1, large: false},
    {id: 'D|E|F', vertices: ['D', 'E', 'F'], links: ['D|E', 'E|F', 'D|F'], faction: 'blue', owner: 'enemy', mu: 1, large: false},
  ];
  return world;
}

describe('beta-v1 纯规则引擎', () => {
  it.each(['red','green','blue'])('首次选择 %s 阵营记录加入战报，重复选择不产生新战报', faction => {
    const world=createWorld(map,0),player=createPlayer('new','新玩家Wind',0,points[0]);
    expect(world.battleEvents ?? []).toEqual([]);
    const out=doCommand(world,player,'faction',undefined,{faction},100);
    expect(out.world.battleEvents).toEqual([{id:expect.any(String),at:100,kind:'join',faction,actor:'新玩家Wind',portals:[]}]);
    expect(rejectedCode(()=>doCommand(out.world,out.player,'faction',undefined,{faction},200))).toBe('FACTION_LOCKED');
    expect(out.world.battleEvents).toHaveLength(1);
    const renamed=doCommand(out.world,out.player,'rename',undefined,{name:'后来改名'},200);
    expect(renamed.world.battleEvents).toEqual(out.world.battleEvents);
  });

  it.each(['风', 'Wind', '星'.repeat(20), 'W'.repeat(20), '探索者Wind2026', '𠮷'.repeat(20)])('改名支持中英文与20字符边界：%s', name => {
    const {world,player}=joined();
    const out=doCommand(world,player,'rename',undefined,{name:` ${name} `});
    expect(out.player.name).toBe(name);
    expect(out.player).toMatchObject({id:player.id,ap:player.ap,xm:player.xm,inventory:player.inventory,faction:player.faction});
    expect(player.name).toBe('玩家');
  });

  it.each(['星'.repeat(21), 'W'.repeat(21), '', '  ', '风\nWind', '风\u200bWind', null, 42])('非法名称不改写账号：%s', name => {
    const {world,player}=joined(),before=structuredClone({world,player});
    expect(rejectedCode(()=>doCommand(world,player,'rename',undefined,{name}))).toBe('INVALID_INPUT');
    expect({world,player}).toEqual(before);
  });

  it('改名同步本人已部署脚和据点版本，保留他人署名、历史战报和资产', () => {
    const {player}=joined(),world=linkedWorld();
    world.portals.A.resonators[0]!.owner=player.id;
    world.portals.A.resonators[0]!.ownerName=player.name;
    world.portals.A.resonators[1]!.ownerName='他人';
    world.battleEvents=[{id:'old',at:0,kind:'attack',faction:'red',actor:player.name,portals:['A']}];
    const out=doCommand(world,player,'rename',undefined,{name:'新名字Wind'});
    expect(out.world.portals.A.resonators[0]!.ownerName).toBe('新名字Wind');
    expect(out.world.portals.A.resonators[1]!.ownerName).toBe('他人');
    expect(out.world.portals.A.version).toBe(world.portals.A.version+1);
    expect(out.world.portals.B).toEqual(world.portals.B);
    expect(out.world.battleEvents).toEqual(world.battleEvents);
    expect(out.world.links).toEqual(world.links);
    expect(out.world.fields).toEqual(world.fields);
  });

  it('新账号携带新手引导，关闭后保存已读且重复确认保留原时间；老账号不补弹', () => {
    const {world,player}=joined();
    expect(player.tutorial.quick_start_pending_at).toBe(0);
    const seen=doCommand(world,player,'guide-read',undefined,{},100);
    expect(seen.player.tutorial).toEqual({quick_start_seen_at:100});
    const again=doCommand(seen.world,seen.player,'guide-read',undefined,{},200);
    expect(again.player.tutorial).toEqual({quick_start_seen_at:100});
    player.tutorial={first_field_at:1};
    expect(doCommand(world,player,'guide-read').player.tutorial).toEqual({first_field_at:1});
  });

  it('自动批量部署按背包从高到低填槽并遵守配额，固定等级只使用指定脚', () => {
    const {world,player}=joined(); player.ap=240000; player.xm=10000;
    player.inventory=[{type:'resonator',level:8,quantity:3},{type:'resonator',level:6,quantity:3},{type:'resonator',level:1,quantity:8}];
    const auto=doCommand(world,player,'deploy-all','A');
    expect(auto.world.portals.A.resonators.map(r=>r?.level)).toEqual([8,6,6,1,1,1,1,1]);
    expect(auto.world.portals.A.resonators.every(r=>r?.ownerName==='玩家')).toBe(true);
    const fixed=doCommand(world,player,'deploy-all','A',{level:6});
    expect(fixed.world.portals.A.resonators.filter(Boolean).map(r=>r?.level)).toEqual([6,6]);
    expect(fixed.player.inventory.find(i=>i.level===8)?.quantity).toBe(3);
  });

  it('单脚升级保留位置，更新部署人名称；等级不足和个人配额拒绝', () => {
    const world=linkedWorld(),{player}=joined(); player.faction='blue'; player.ap=240000; player.xm=10000;
    player.inventory=[{type:'resonator',level:8,quantity:2}];
    const out=doCommand(world,player,'upgrade','A',{slot:0,level:8});
    expect(out.world.portals.A.resonators[0]).toMatchObject({level:8,owner:player.id,ownerName:player.name,x:10000,y:10000});
    expect(rejectedCode(()=>doCommand(out.world,out.player,'upgrade','A',{slot:1,level:8}))).toBe('QUOTA_EXCEEDED');
    player.ap=0;
    expect(rejectedCode(()=>doCommand(world,player,'upgrade','A',{slot:0,level:8}))).toBe('LEVEL_LOCKED');
  });

  it('丢弃使用真实位置，不回能量；跨阵营拾取守恒且重复拾取不再发放', () => {
    const {world,player}=joined();
    const out=doCommand(world,player,'drop',undefined,{type:'pulse',level:1,quantity:2,x:99999,y:99999});
    const drop=out.world.droppedItems![0];
    expect(drop).toMatchObject({x:player.x,y:player.y,item:{type:'pulse',level:1,quantity:2}});
    expect(out.player.xm).toBe(player.xm);
    expect(out.player.inventory.find(i=>i.type==='pulse')?.quantity).toBe(10);
    const recipient=createPlayer('other','拾取者',0,player);recipient.faction='blue';
    const picked=doCommand(out.world,recipient,'pickup',undefined,{dropId:drop.id});
    expect(picked.player.inventory).toEqual([{type:'pulse',level:1,quantity:2}]);
    expect(picked.world.droppedItems).toEqual([]);
    expect(rejectedCode(()=>doCommand(picked.world,picked.player,'pickup',undefined,{dropId:drop.id}))).toBe('DROP_NOT_FOUND');
    expect(world.droppedItems).toBeUndefined();
  });

  it.each([3000,3001])('拾取距离%d厘米严格按30米边界，超范围和满背包不移除物品', distance => {
    const {world,player}=joined();
    const dropped=doCommand(world,player,'drop',undefined,{type:'cube',level:1,quantity:1});
    const recipient=createPlayer('other','拾取者',0,{x:player.x+distance,y:player.y});
    const payload={dropId:dropped.world.droppedItems![0].id};
    if(distance===3000)expect(doCommand(dropped.world,recipient,'pickup',undefined,payload).player.inventory).toHaveLength(1);
    else expect(rejectedCode(()=>doCommand(dropped.world,recipient,'pickup',undefined,payload))).toBe('OUT_OF_RANGE');
    recipient.x=player.x;recipient.inventory=[{type:'pulse',level:1,quantity:500}];
    expect(rejectedCode(()=>doCommand(dropped.world,recipient,'pickup',undefined,payload))).toBe('INVENTORY_FULL');
    expect(dropped.world.droppedItems).toHaveLength(1);
  });

  it('丢弃拒绝受保护Key、无效数量和移动中操作，允许丢弃高等级装备', () => {
    const {world,player}=joined();
    player.inventory=[{type:'key',level:1,quantity:1,portalId:'A',protected:true},{type:'pulse',level:8,quantity:1}];
    expect(rejectedCode(()=>doCommand(world,player,'drop',undefined,{type:'key',portalId:'A',quantity:1}))).toBe('ITEM_PROTECTED');
    expect(rejectedCode(()=>doCommand(world,player,'drop',undefined,{type:'pulse',level:8,quantity:0}))).toBe('INVALID_INPUT');
    expect(doCommand(world,player,'drop',undefined,{type:'pulse',level:8,quantity:1}).world.droppedItems).toHaveLength(1);
    player.movement={from:player,to:{x:11000,y:10000},startAt:0,arriveAt:1000};
    expect(rejectedCode(()=>doCommand(world,player,'drop',undefined,{type:'pulse',level:8,quantity:1}))).toBe('MOVING');
    expect(world.droppedItems).toBeUndefined();
  });

  it('糖块回收与使用共享收益、等级、满能量和冷却限制', () => {
    const {world,player}=joined();player.xm=1200;
    const used=doCommand(world,player,'sugar',undefined,{level:1});
    const recycled=doCommand(world,player,'recycle',undefined,{type:'cube',level:1,quantity:1});
    expect(recycled.player).toEqual(used.player);
    expect(recycled.result).toMatchObject({restored:1000,wasted:0});
    expect(rejectedCode(()=>doCommand(recycled.world,recycled.player,'sugar',undefined,{level:1},999))).toBe('COOLDOWN');
    expect(rejectedCode(()=>doCommand(used.world,used.player,'recycle',undefined,{type:'cube',level:1,quantity:1},999))).toBe('COOLDOWN');
    player.xm=3000;
    expect(rejectedCode(()=>doCommand(world,player,'recycle',undefined,{type:'cube',level:1,quantity:1}))).toBe('ALREADY_FULL');
    player.xm=1200;
    expect(rejectedCode(()=>doCommand(world,player,'recycle',undefined,{type:'cube',level:8,quantity:1}))).toBe('LEVEL_LOCKED');
  });
  it('新手三点形成首场，动作成本2100XM且AP为7964', () => {
    let {world, player} = joined();
    let cost = 0, now = 0;
    for (const point of points) {
      player.x = point.x; player.y = point.y;
      let out = doCommand(world, player, 'hack', point.id, {}, now);
      cost += out.result.cost as number; world = out.world; player = out.player;
      out = doCommand(world, player, 'deploy-all', point.id, {level: 1}, now);
      expect(out.result.entries).toHaveLength(8);
      cost += out.result.cost as number; world = out.world; player = out.player;
    }
    for (const [origin, destination] of [['B', 'A'], ['C', 'B'], ['A', 'C']]) {
      player.x = world.portals[origin].x; player.y = world.portals[origin].y;
      const out = doCommand(world, player, 'link', origin, {destinationId: destination}, now);
      cost += out.result.cost as number; world = out.world; player = out.player; now += 2000;
    }
    expect(cost).toBe(2100);
    expect(player.ap).toBe(7964);
    expect(world.links).toHaveLength(3);
    expect(world.fields).toHaveLength(1);
    expect(world.battleEvents?.filter(event=>event.kind==='link')).toHaveLength(3);
    expect(world.battleEvents?.filter(event=>event.kind==='field')).toMatchObject([{portals:expect.arrayContaining(['A','B','C']),amount:world.fields[0].mu}]);
    expect(player.tutorial.first_field_at).toBeDefined();
  });

  it('499件成功Hack收下完整8件，失败不会修改传入状态', () => {
    const {world, player} = joined();
    player.inventory = [{type: 'resonator', level: 1, quantity: 499}];
    const out = doCommand(world, player, 'hack', 'A');
    expect(out.result.inventoryCount).toBe(507);
    expect(out.player.inventory.find(i => i.type === 'key' && i.portalId === 'A')?.quantity).toBe(1);
    expect(player.inventory[0].quantity).toBe(499);
    expect(() => doCommand(out.world, out.player, 'hack', 'B')).toThrowError(GameError);
    expect(out.player.inventory.find(i => i.type === 'key' && i.portalId === 'A')?.quantity).toBe(1);
  });

  it('两件热沉只缩短后续友方Hack冷却，边界毫秒仍须等待', () => {
    const {world, player} = joined();
    world.portals.A.faction = 'red';
    world.portals.A.mods[0] = {type: 'heatsink', owner: 'p'};
    world.portals.A.mods[1] = {type: 'heatsink', owner: 'p'};
    const first = doCommand(world, player, 'hack', 'A');
    expect(first.player.hacks.A.readyAt).toBe(129600);
    expect(rejectedCode(() => doCommand(first.world, first.player, 'hack', 'A', {}, 129599))).toBe('COOLDOWN');
    const second = doCommand(first.world, first.player, 'hack', 'A', {}, 129600);
    expect(second.player.hacks.A.times).toEqual([0, 129600]);
    second.world.portals.A.mods = Array(4).fill(null);
    expect(second.player.hacks.A.readyAt).toBe(259200);
    const third = doCommand(second.world, second.player, 'hack', 'A', {}, 259200);
    expect(third.player.hacks.A.readyAt).toBe(439200);
  });

  it('多重Hack移除后立即按新额度校验，四小时窗口边界不保留最早记录', () => {
    let {world, player} = joined();
    world.portals.A.faction = 'red';
    world.portals.A.mods[0] = {type: 'multihack', owner: 'p'};
    for (let i = 0; i < 5; i++) {
      const out = doCommand(world, player, 'hack', 'A', {}, i * 180000);
      world = out.world; player = out.player;
    }
    expect(player.hacks.A.times).toHaveLength(5);
    world.portals.A.mods[0] = null;
    const xm = player.xm;
    expect(rejectedCode(() => doCommand(world, player, 'hack', 'A', {}, 900000))).toBe('BURNOUT');
    expect(player.xm).toBe(xm);
    expect(player.hacks.A.times).toHaveLength(5);
    // 恰满四小时仅移除首条，此时窗口内仍有四次；第二条过期后才可再次Hack。
    expect(rejectedCode(() => doCommand(world, player, 'hack', 'A', {}, 14400000))).toBe('BURNOUT');
    const afterWindow = doCommand(world, player, 'hack', 'A', {}, 14580000);
    expect(afterWindow.player.hacks.A.times).toEqual([360000, 540000, 720000, 14580000]);
  });

  it('糖块按缺口恢复并浪费溢出，满XM与独立冷却均不耗物品', () => {
    const {world, player} = joined();
    player.xm = 2500;
    const first = doCommand(world, player, 'sugar', undefined, {level: 1});
    expect(first.result).toMatchObject({restored: 500, wasted: 500});
    expect(first.player.xm).toBe(3000);
    expect(first.player.inventory.find(i => i.type === 'cube' && i.level === 1)?.quantity).toBe(3);
    expect(rejectedCode(() => doCommand(first.world, first.player, 'sugar', undefined, {level: 1}, 1000))).toBe('ALREADY_FULL');
    first.player.xm = 0;
    expect(rejectedCode(() => doCommand(first.world, first.player, 'sugar', undefined, {level: 1}, 999))).toBe('COOLDOWN');
    const second = doCommand(first.world, first.player, 'sugar', undefined, {level: 1}, 1000);
    expect(second.result).toMatchObject({restored: 1000, wasted: 0});
    expect(second.player.inventory.find(i => i.type === 'cube' && i.level === 1)?.quantity).toBe(2);
    expect(first.player.inventory.find(i => i.type === 'cube' && i.level === 1)?.quantity).toBe(3);
  });

  it('回收可释放满XM背包空间，受保护Key不能被混入批量回收', () => {
    const {world, player} = joined();
    player.inventory.push({type: 'key', level: 1, portalId: 'A', quantity: 2, protected: true});
    player.inventory.push({type: 'key', level: 1, portalId: 'A', quantity: 1});
    expect(rejectedCode(() => doCommand(world, player, 'recycle', undefined, {type: 'key', portalId: 'A', quantity: 2}))).toBe('ITEM_PROTECTED');
    expect(player.inventory.filter(i => i.type === 'key').map(i => i.quantity)).toEqual([2, 1]);
    const key = doCommand(world, player, 'recycle', undefined, {type: 'key', portalId: 'A', quantity: 1});
    expect(key.result).toMatchObject({restored: 0, wasted: 20});
    expect(key.player.inventory.filter(i => i.type === 'key')).toEqual([{type: 'key', level: 1, portalId: 'A', quantity: 2, protected: true}]);
    key.player.xm = 2500;
    const cube = doCommand(key.world, key.player, 'recycle', undefined, {type: 'cube', level: 1, quantity: 1});
    expect(cube.result).toMatchObject({restored: 500, wasted: 500});
    expect(cube.player.xm).toBe(3000);
    expect(cube.player.inventory.find(i => i.type === 'cube' && i.level === 1)?.quantity).toBe(3);
  });

  it('敌方Hack反击先扣成本再扣XM，普通物品减半但保底Key保留', () => {
    const {world, player} = joined();
    world.portals.A.faction = 'blue';
    world.portals.A.resonators[0] = {level: 1, energy: 1000, owner: 'opponent', x: points[0].x, y: points[0].y,
      generation: 'enemy', nextDecayAt: 86_400_000};
    player.xm = 200;
    const out = applyCommand(world, player, {type: 'hack', portalId: 'A', payload: {}}, ctx(0, 0));
    expect(out.result.countered).toBe(true);
    expect(out.result.counterDamage).toBe(150);
    expect(out.player.xm).toBe(0);
    expect(out.player.inventory.find(i => i.type === 'key' && i.portalId === 'A')?.quantity).toBe(1);
    expect(out.player.ap).toBe(100);
  });

  it('脉冲等级共用1000毫秒冷却，999拒绝且1000允许', () => {
    const {world, player} = joined();
    const enemy = world.portals.A;
    enemy.faction = 'blue';
    enemy.resonators[0] = {level: 1, energy: 1000, owner: 'opponent', x: enemy.x, y: enemy.y, generation: 'e', nextDecayAt: 86_400_000};
    const first = doCommand(world, player, 'attack', undefined, {level: 1});
    expect(first.result.hits).toBe(1);
    expect(() => doCommand(first.world, first.player, 'attack', undefined, {level: 1}, 999)).toThrowError(/冷却/);
    expect(doCommand(first.world, first.player, 'attack', undefined, {level: 1}, 1000).result.hits).toBe(1);
    expect(world.portals.A.resonators[0]?.energy).toBe(1000);
  });

  it('攻击距离档在840厘米边界由150降至75，整数平方裁定', () => {
    const at = (distance: number) => {
      const {world, player} = joined();
      const enemy = world.portals.A; enemy.faction = 'blue';
      enemy.resonators[0] = {level: 1, energy: 1000, owner: 'enemy', x: player.x + distance, y: player.y,
        generation: 'g', nextDecayAt: 86_400_000};
      return doCommand(world, player, 'attack', undefined, {level: 1}).world.portals.A.resonators[0]?.energy;
    };
    expect(at(839)).toBe(850);
    expect(at(840)).toBe(925);
    expect(at(4200)).toBe(991);
  });

  it('PO中心在武器范围外但合法外置脚在范围内，仍可命中', () => {
    const {world, player} = joined();
    const enemy = world.portals.A; enemy.faction = 'blue';
    enemy.x = player.x + 4300;
    enemy.resonators[0] = {level: 1, energy: 1000, owner: 'enemy', x: player.x + 4100, y: player.y,
      generation: 'g', nextDecayAt: 86_400_000};
    const out = doCommand(world, player, 'attack', undefined, {level: 1});
    expect(out.result.hits).toBe(1);
    expect(out.world.portals.A.resonators[0]?.energy).toBe(991);
  });

  it('事务私有世界可复用同一副本，默认调用仍保留入参', () => {
    const {world, player} = joined();
    const fresh = applyCommand(world, player, {type: 'deploy', portalId: 'A', payload: {level: 1}}, ctx());
    expect(world.portals.A.resonators.filter(Boolean)).toHaveLength(0);
    expect(fresh.world.portals.A.resonators.filter(Boolean)).toHaveLength(1);
    const privateWorld = structuredClone(world);
    const privateResult = applyCommand(privateWorld, player, {type: 'deploy', portalId: 'A', payload: {level: 1}}, ctx(), false);
    expect(privateResult.world).toBe(privateWorld);
    expect(privateWorld.portals.A.resonators.filter(Boolean)).toHaveLength(1);
  });

  it('单玩家L8每点只能部署一只，八槽平均等级分母固定', () => {
    const {world, player} = joined();
    player.ap = 240000;
    player.inventory.push({type: 'resonator', level: 8, quantity: 8});
    let out = doCommand(world, player, 'deploy', 'A', {level: 8, slot: 0});
    expect(() => doCommand(out.world, out.player, 'deploy', 'A', {level: 8, slot: 1})).toThrowError(/配额/);
    expect(out.world.portals.A.resonators[0]?.level).toBe(8);
    expect(out.world.portals.A.resonators.filter(Boolean)).toHaveLength(1);
  });

  it('远程充能效率0.95，缺口12扣13且保留原衰减时钟', () => {
    const {world, player} = joined();
    player.ap = 14000;
    player.x = 0; player.y = 0; player.xm = 1000;
    player.inventory.push({type: 'key', level: 1, portalId: 'A', quantity: 1});
    const portal = world.portals.A;
    portal.x = 10_000_000; portal.y = 0; portal.faction = 'red';
    portal.resonators[0] = {level: 1, energy: 988, owner: 'p', x: portal.x, y: portal.y, generation: 'g', nextDecayAt: 86_400_000};
    const out = doCommand(world, player, 'recharge', 'A', {slot: 0, amount: 1000});
    expect(out.result.delivered).toBe(12);
    expect(out.result.cost).toBe(13);
    expect(out.world.portals.A.resonators[0]?.nextDecayAt).toBe(86_400_000);
  });

  it('远程充能必须持有目标Key，保护Key可用且不消耗，移动和敌方仍拒绝', () => {
    const {world,player}=joined();const portal=world.portals.B;portal.faction='red';
    portal.resonators[0]={level:1,energy:500,owner:'p',x:portal.x,y:portal.y,generation:'key-test',nextDecayAt:86400000};
    expect(rejectedCode(()=>doCommand(world,player,'recharge','B',{amount:1000}))).toBe('KEY_REQUIRED');
    player.inventory.push({type:'key',level:1,portalId:'A',quantity:1});
    expect(rejectedCode(()=>doCommand(world,player,'recharge','B',{amount:1000}))).toBe('KEY_REQUIRED');
    player.inventory.push({type:'key',level:1,portalId:'B',quantity:1,protected:true});
    const out=doCommand(world,player,'recharge','B',{amount:1000});
    expect(out.world.portals.B.resonators[0]!.energy).toBe(1000);
    expect(out.player.inventory).toEqual(player.inventory);expect(out.player.movement).toBeNull();
    expect(out.player.x).toBe(player.x);expect(out.player.y).toBe(player.y);
    portal.faction='blue';
    expect(rejectedCode(()=>doCommand(world,player,'recharge','B',{amount:1000}))).toBe('NOT_FRIENDLY');
    portal.faction='red';player.movement={from:{x:player.x,y:player.y},to:{x:portal.x,y:portal.y},startAt:0,arriveAt:10000};
    expect(rejectedCode(()=>doCommand(world,player,'recharge','B',{amount:1000}))).toBe('MOVING');
  });

  it('充能generation不匹配时不扣XM，全部充能检查八槽版本', () => {
    const {world, player} = joined();
    const portal = world.portals.A; portal.faction = 'red'; player.xm = 1000;
    portal.resonators[0] = {level: 1, energy: 500, owner: 'p', x: portal.x, y: portal.y, generation: 'new', nextDecayAt: 86_400_000};
    expect(() => doCommand(world, player, 'recharge', 'A', {slot: 0, generation: 'old'})).toThrowError(/替换/);
    expect(() => doCommand(world, player, 'recharge', 'A', {generations: {'0': 'old'}})).toThrowError(/替换/);
    expect(player.xm).toBe(1000);
    expect(portal.resonators[0]?.energy).toBe(500);
  });

  it('攻击无命中拒绝不扣资源；两脚断网、零脚中立并清MOD', () => {
    const {world, player} = joined();
    const enemy = world.portals.A; enemy.faction = 'blue';
    player.x = 90000; player.y = 90000;
    enemy.resonators = Array.from({length: 3}, (_, i) => ({level: 1, energy: i === 0 ? 1 : 1000, owner: 'enemy', x: enemy.x, y: enemy.y,
      generation: `g${i}`, nextDecayAt: 86_400_000})).concat(Array(5).fill(null));
    enemy.mods[0] = {type: 'heatsink', owner: 'enemy'};
    world.links.push({id: 'A|B', origin: 'A', destination: 'B', faction: 'blue', owner: 'enemy'});
    expect(() => doCommand(world, player, 'attack', undefined, {level: 1})).toThrowError(/没有敌方脚/);
    expect(player.inventory.find(i => i.type === 'pulse')?.quantity).toBe(12);
    player.x = enemy.x; player.y = enemy.y;
    const out = doCommand(world, player, 'attack', undefined, {level: 1});
    expect(out.world.portals.A.faction).toBe('blue');
    expect(out.world.portals.A.resonators.filter(Boolean)).toHaveLength(2);
    expect(out.world.links).toHaveLength(0);
    out.player.ap = 240000;
    out.player.inventory.push({type: 'pulse', level: 8, quantity: 1});
    const cleared = doCommand(out.world, out.player, 'attack', undefined, {level: 8}, 1000);
    expect(cleared.world.portals.A.faction).toBeNull();
    expect(cleared.world.portals.A.mods.every(m => !m)).toBe(true);
  });

  it('攻击仅受伤不拆网；满八脚被打掉一只立即拆相连线场，保留无关网络', () => {
    const world = linkedWorld();
    const player = joined().player;
    const wounded = doCommand(world, player, 'attack', undefined, {level: 1});
    expect(wounded.result).toMatchObject({destroyed: 0, links: 0, fields: 0});
    expect(wounded.world.links).toHaveLength(6);
    expect(wounded.world.fields).toHaveLength(2);
    expect(wounded.world.battleEvents?.filter(event => event.kind === 'field-destroyed')).toEqual([]);
    wounded.world.portals.A.resonators[0]!.energy = 1;
    const broken = doCommand(wounded.world, wounded.player, 'attack', undefined, {level: 1}, 1000);
    expect(broken.world.portals.A.resonators.filter(Boolean)).toHaveLength(7);
    expect(broken.result).toMatchObject({destroyed: 1, links: 2, fields: 1});
    expect(broken.world.links.map(link => link.id)).toEqual(['B|C', 'D|E', 'E|F', 'D|F']);
    expect(broken.world.fields.map(field => field.id)).toEqual(['D|E|F']);
    expect(broken.world.battleEvents?.filter(event => event.kind === 'field-destroyed')).toEqual([
      {id: expect.any(String), at: 1000, faction: 'red', actor: '玩家', kind: 'field-destroyed', portals: ['A', 'B', 'C'], amount: 1},
    ]);
    const again = doCommand(broken.world, broken.player, 'attack', undefined, {level: 1}, 2000);
    expect(again.world.battleEvents?.filter(event => event.kind === 'field-destroyed')).toHaveLength(1);
    expect(world.links).toHaveLength(6);
  });

  it('6小时自然衰减令满八脚降到七脚时立即拆相连线场', () => {
    const world = linkedWorld();
    world.portals.A.resonators[0]!.energy = 150;
    world.portals.A.resonators[0]!.nextDecayAt = 21600000;
    const due = advanceWorld(world, 21600000);
    expect(due.world.portals.A.resonators.filter(Boolean)).toHaveLength(7);
    expect(due.world.portals.A.faction).toBe('blue');
    expect(due.world.links.map(link => link.id)).toEqual(['B|C', 'D|E', 'E|F', 'D|F']);
    expect(due.world.fields.map(field => field.id)).toEqual(['D|E|F']);
    expect(world.links).toHaveLength(6);
    expect(world.portals.A.resonators[0]?.energy).toBe(150);
  });

  it('部署满现实6小时扣满能量15%，多周期补算与逐次推进一致且不重复扣减',()=>{
    const {world,player}=joined();
    const deployed=doCommand(world,player,'deploy','A',{slot:0,level:1},1234);
    const first=1234+6*3600000;
    expect(deployed.world.portals.A.resonators[0]!.nextDecayAt).toBe(first);
    expect(advanceWorld(deployed.world,first-1).world.portals.A.resonators[0]!.energy).toBe(1000);
    const once=advanceWorld(deployed.world,first).world;
    expect(once.portals.A.resonators[0]!.energy).toBe(850);
    expect(advanceWorld(once,first).world).toEqual(once);
    const second=first+6*3600000;
    expect(advanceWorld(deployed.world,second).world).toEqual(advanceWorld(once,second).world);
    expect(advanceWorld(deployed.world,first+6*6*3600000).world.portals.A.faction).toBeNull();
  });

  it('两件护盾叠加减伤且本次伤害取MOD破坏前状态', () => {
    const {world, player} = joined();
    const enemy = world.portals.A; enemy.faction = 'blue';
    enemy.resonators[0] = {level: 1, energy: 1000, owner: 'enemy', x: enemy.x, y: enemy.y, generation: 'g', nextDecayAt: 86_400_000};
    enemy.mods[0] = {type: 'shield', owner: 'enemy'}; enemy.mods[1] = {type: 'shield', owner: 'enemy'};
    const out = applyCommand(world, player, {type: 'attack', payload: {level: 1}}, ctx(0, 0));
    expect(out.world.portals.A.resonators[0]?.energy).toBe(940);
    expect(out.world.portals.A.mods.filter(Boolean)).toHaveLength(1);
  });

  it('连线只按起点八槽射程裁定，失败不扣Key或XM', () => {
    const {world, player} = joined();
    player.inventory.push({type: 'key', level: 1, portalId: 'B', quantity: 1});
    world.portals.B.x = world.portals.A.x + RULES.minimumPortalRangeCm + 1;
    for (const id of ['A', 'B']) {
      world.portals[id].faction = 'red';
      world.portals[id].resonators = Array.from({length: 8}, (_, index) => ({level: 1, energy: 1000, owner: 'p',
        x: world.portals[id].x, y: world.portals[id].y, generation: `g-${id}-${index}`, nextDecayAt: 86_400_000}));
    }
    expect(() => doCommand(world, player, 'link', 'A', {destinationId: 'B'})).toThrowError(/射程/);
    expect(player.xm).toBe(3000);
    expect(player.inventory.find(i => i.type === 'key' && i.portalId === 'B')?.quantity).toBe(1);
    expect(world.links).toHaveLength(0);
  });

  it('建线时起点或终点仅七脚都拒绝，目标Key和XM不被消耗', () => {
    const {world, player} = joined();
    for (const id of ['A', 'B']) {
      world.portals[id].faction = 'red';
      world.portals[id].resonators = Array.from({length: 8}, (_, slot) => ({level: 1, energy: 1000, owner: 'p',
        x: world.portals[id].x, y: world.portals[id].y, generation: `${id}-${slot}`, nextDecayAt: 86400000}));
    }
    player.inventory.push({type: 'key', level: 1, portalId: 'B', quantity: 1});
    world.portals.A.resonators[7] = null;
    expect(rejectedCode(() => doCommand(world, player, 'link', 'A', {destinationId: 'B'}))).toBe('LINK_UNAVAILABLE');
    world.portals.A.resonators[7] = {...world.portals.A.resonators[6]!, generation: 'A-7'};
    world.portals.B.resonators[7] = null;
    expect(rejectedCode(() => doCommand(world, player, 'link', 'A', {destinationId: 'B'}))).toBe('LINK_UNAVAILABLE');
    expect(player.xm).toBe(3000);
    expect(player.inventory.find(item => item.type === 'key' && item.portalId === 'B')?.quantity).toBe(1);
    expect(world.links).toHaveLength(0);
  });

  it('连线必须扣目标Key，禁用Glyph命令直接拒绝', () => {
    const {world, player} = joined();
    for (const id of ['A', 'B']) {
      world.portals[id].faction = 'red';
      world.portals[id].resonators = Array.from({length: 8}, (_, index) => ({level: 1, energy: 1000, owner: 'p',
        x: world.portals[id].x, y: world.portals[id].y, generation: `g-${id}-${index}`, nextDecayAt: 86_400_000}));
    }
    player.inventory.push({type: 'key', level: 1, portalId: 'A', quantity: 1});
    expect(() => doCommand(world, player, 'link', 'A', {destinationId: 'B'})).toThrowError(/目标PO Key/);
    player.inventory.push({type: 'key', level: 1, portalId: 'B', quantity: 1});
    const out = doCommand(world, player, 'link', 'A', {destinationId: 'B'});
    expect(out.player.inventory.find(i => i.type === 'key' && i.portalId === 'A')?.quantity).toBe(1);
    expect(out.player.inventory.find(i => i.type === 'key' && i.portalId === 'B')).toBeUndefined();
    expect(() => doCommand(world, player, 'glyph')).toThrowError(/未知命令/);
  });

  it('同刻先检查点、切季、后衰减，跨周归档旧分', () => {
    const world = createWorld(map, 0);
    world.portals.A.faction = 'red';
    world.portals.A.resonators[0] = {level: 1, energy: 150, owner: 'p', x: points[0].x, y: points[0].y,
      generation: 'g', nextDecayAt: 604_800_000};
    const result = advanceWorld(world, 604_800_000);
    expect(result.checkpoints).toHaveLength(2016);
    expect(result.checkpoints.at(-1)?.scores.red).toBe(20160);
    expect(result.seasons).toHaveLength(1);
    expect(result.seasons[0].scores.red).toBe(20160);
    expect(result.world.season.id).toBe(2);
    expect(result.world.portals.A.faction).toBeNull();
    expect(result.world.scores.red).toBe(0);
    expect(world.portals.A.faction).toBe('red');
  });

  it.each([2999,3000,3001])('操作距离%d厘米按30米含边界判定', distance => {
    const {world,player}=joined(); player.x+=distance;
    if(distance<=3000) expect(doCommand(world,player,'hack','A').result.type).toBe('hack');
    else expect(rejectedCode(()=>doCommand(world,player,'hack','A'))).toBe('OUT_OF_RANGE');
  });

  it('缩小操作距离后，旧40米偏移的脚仍按真实武器射程命中',()=>{
    const {world,player}=joined();
    const enemy=world.portals.B; enemy.x=player.x+7800; enemy.y=player.y; enemy.faction='blue';
    enemy.resonators[0]={level:1,energy:1000,owner:'enemy',x:enemy.x-4000,y:enemy.y,generation:'legacy',nextDecayAt:86400000};
    const result=doCommand(world,player,'attack',undefined,{level:1});
    expect(result.world.portals.B.resonators[0]!.energy).toBeLessThan(1000);
  });

  it('移动改道从当前权威坐标开始，取消后不再继续前进',()=>{
    const {world,player}=joined();
    const first=doCommand(world,player,'move',undefined,{x:22000,y:10000});
    const reroute=doCommand(first.world,first.player,'move',undefined,{x:16000,y:22000},5000);
    expect(reroute.player.movement).toMatchObject({from:{x:16000,y:10000},to:{x:16000,y:22000},startAt:5000,arriveAt:15000});
    const stopped=doCommand(reroute.world,reroute.player,'move-cancel',undefined,{},7500);
    expect(stopped.player).toMatchObject({x:16000,y:13000,movement:null});
    expect(refreshPlayer(stopped.player,20000)).toMatchObject({x:16000,y:13000,movement:null});
  });

  it('移动改道、取消与离线XM恢复按整数毫秒处理' , () => {
    let {world, player} = joined();
    player.xm = 0;
    const move = doCommand(world, player, 'move', undefined, {x: 22000, y: 10000});
    expect(move.player.movement?.arriveAt).toBe(10000);
    const midway = refreshPlayer(move.player, 5000);
    expect(midway.x).toBe(16000);
    expect(midway.xm).toBe(25);
    const cancel = doCommand(move.world, midway, 'move-cancel', undefined, {}, 5000);
    expect(cancel.player.x).toBe(16000);
    expect(cancel.player.movement).toBeNull();
  });
});

describe('高阶掉落、逐级礼包与公共战报', () => {
  it.each([[.86,2],[.96,3],[.99,4]])('中立 Hack 抽样 %s 获得 L%s 装备', (roll, expected) => {
    const {world,player}=joined();
    const out=applyCommand(world,player,{type:'hack',portalId:'A',payload:{}},ctx(0,roll));
    expect((out.result.items as {level:number}[]).map(item=>item.level)).toEqual(Array(7).fill(expected));
  });
  it('高级据点掉落封顶 L8，拥有高阶物资不越过使用等级限制',()=>{
    const {player}=joined(),world=linkedWorld();
    world.portals.A.resonators.forEach(r=>{if(r)r.level=8});
    const out=applyCommand(world,player,{type:'hack',portalId:'A',payload:{}},ctx(0,.995));
    expect((out.result.items as {level:number}[]).every(item=>item.level===8)).toBe(true);
    expect(rejectedCode(()=>doCommand(out.world,out.player,'attack',undefined,{level:8}))).toBe('LEVEL_LOCKED');
  });
  it('占领升级完整发放50件礼包，背包溢出仍保留且后续不重复发放',()=>{
    const {world,player}=joined();player.inventory=[{type:'resonator',level:1,quantity:500}];
    const out=doCommand(world,player,'deploy','A',{level:1});
    expect(out.result.levelRewards).toEqual([{level:2,items:[{type:'pulse',level:2,quantity:20},{type:'resonator',level:2,quantity:20},{type:'cube',level:2,quantity:10}]}]);
    expect(out.player.inventory.reduce((n,i)=>n+i.quantity,0)).toBe(549);
    expect(out.world.battleEvents?.filter(e=>e.kind==='capture')).toMatchObject([{kind:'capture',actor:'玩家',faction:'red',portals:['A']}]);
    const next=doCommand(out.world,out.player,'deploy','A',{level:1});
    expect(next.result.levelRewards).toBeUndefined();expect(next.world.battleEvents?.filter(e=>e.kind==='capture')).toHaveLength(1);
    expect(player.inventory).toEqual([{type:'resonator',level:1,quantity:500}]);
  });
  it('同一次攻击跨越多级逐级发包，攻击每个命中据点均有战报',()=>{
    const {player}=joined(),world=linkedWorld();player.ap=499;
    for(const po of Object.values(world.portals)){
      po.x=player.x;po.y=player.y;
      po.resonators.forEach(r=>{if(r){r.x=player.x;r.y=player.y;r.energy=1}});
    }
    const out=doCommand(world,player,'attack',undefined,{level:1});
    expect((out.result.levelRewards as {level:number}[]).map(r=>r.level)).toEqual([2,3]);
    for(const level of [2,3])expect(out.player.inventory.filter(i=>i.level===level).reduce((n,i)=>n+i.quantity,0)).toBe(50);
    expect(out.world.battleEvents?.filter(e=>e.kind==='attack')).toHaveLength(6);
    expect(out.world.battleEvents?.filter(e=>e.kind==='field-destroyed')).toMatchObject([
      {faction:'red',actor:'玩家',portals:['A','B','C'],amount:1},
      {faction:'red',actor:'玩家',portals:['D','E','F'],amount:1},
    ]);
    expect(world.fields).toHaveLength(2);
    expect(world.battleEvents).toBeUndefined();
  });
  it('计分战报只记本次收益且最多保存40条，失败不写战报',()=>{
    const world=linkedWorld(),{player}=joined();
    const next=advanceWorld(world,300000);
    expect(next.world.battleEvents).toMatchObject([{kind:'score',faction:'blue',amount:62}]);
    expect(()=>doCommand(world,player,'deploy','A',{level:1})).toThrow();
    expect(world.battleEvents).toBeUndefined();
    expect(advanceWorld(world,300000*50).world.battleEvents).toHaveLength(40);
  });
});
