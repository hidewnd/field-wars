import type {BattleEvent, LevelReward, CommandContext, DueResult, Faction, GameCommand, GameResult, Item, ItemType, MapData, Player, Point, Portal, Resonator, World} from './types.js';
import {distanceSquared, withinRange} from './geometry.js';
import {validateLinkTarget} from './linking.js';
import {RULES, inventoryCount, levelForAp, portalLevel, xmCap} from './rules.js';
import {playerNameError} from './profile.js';
import {absorbGroundXm} from './ground-xm.js';

const ENERGY = RULES.resonators.energy;
const QUOTA = RULES.resonators.quotaPerPlayerPerPortal;
const DAMAGE = RULES.attack.damageByLevel;
const RADIUS = RULES.attack.radiusCmByLevel;
const COUNTER = RULES.hack.counterXmByLevel;
const SLOT_ANGLE = Array.from({length: 8}, (_, i) => i * Math.PI / 4);

export class GameError extends Error {
  constructor(public code: string, message: string, public details?: Record<string, unknown>) {
    super(message);
    this.name = 'GameError';
  }
}

function fail(code: string, message: string, details?: Record<string, unknown>): never { throw new GameError(code, message, details); }
function integer(value: unknown, name: string, min = 0, max = Number.MAX_SAFE_INTEGER): number {
  if (!Number.isSafeInteger(value) || (value as number) < min || (value as number) > max) fail('INVALID_INPUT', `${name}无效`);
  return value as number;
}
function text(value: unknown, name: string): string {
  if (typeof value !== 'string' || !value) fail('INVALID_INPUT', `${name}无效`);
  return value;
}
function level(value: unknown, player: Player): number {
  const n = integer(value, '等级', 1, 8);
  if (n > levelForAp(player.ap)) fail('LEVEL_LOCKED', '玩家等级不足');
  return n;
}
function ensureFaction(player: Player): Faction {
  if (!player.faction) fail('FACTION_REQUIRED', '请先选择阵营');
  return player.faction;
}
function ensureStill(player: Player): void { if (player.movement) fail('MOVING', '移动中不能执行此操作'); }
function enoughXm(player: Player, cost: number): void { if (player.xm < cost) fail('XM_INSUFFICIENT', 'XM不足', {cost, available: player.xm}); }
function random(ctx: CommandContext): number {
  const value = ctx.random();
  if (!Number.isFinite(value) || value < 0 || value >= 1) fail('RANDOM_INVALID', '随机源返回值无效');
  return value;
}
function chance(ctx: CommandContext, percent: number): boolean {return random(ctx) * 100 < percent;}
function ceilSqrt(value: bigint): bigint {
  if (value < 2n) return value;
  let low = 0n, high = 1n << BigInt(Math.ceil(value.toString(2).length / 2));
  while (low < high) {
    const middle = (low + high) >> 1n;
    if (middle * middle < value) low = middle + 1n;
    else high = middle;
  }
  return low;
}
function itemQuantity(player: Player, type: ItemType, itemLevel?: number, portalId?: string): number {
  return player.inventory.filter(i => i.type === type && i.level === (itemLevel ?? i.level) && i.portalId === portalId).reduce((n, i) => n + i.quantity, 0);
}
function addItem(player: Player, type: ItemType, itemLevel: number, quantity: number, portalId?: string): void {
  if (!quantity) return;
  const existing = player.inventory.find(i => i.type === type && i.level === itemLevel && i.portalId === portalId && !i.protected);
  if (existing) existing.quantity += quantity;
  else player.inventory.push({type, level: itemLevel, quantity, ...(portalId ? {portalId} : {})});
}
function takeItem(player: Player, type: ItemType, itemLevel: number, quantity: number, portalId?: string, includeProtected = true): void {
  if (itemQuantity(player, type, itemLevel, portalId) < quantity) fail('ITEM_INSUFFICIENT', '道具不足', {type, level: itemLevel, portalId, quantity});
  let rest = quantity;
  for (const item of player.inventory) {
    if (item.type !== type || item.level !== itemLevel || item.portalId !== portalId || (!includeProtected && item.protected)) continue;
    const used = Math.min(rest, item.quantity);
    item.quantity -= used; rest -= used;
    if (!rest) break;
  }
  if (rest) fail('ITEM_PROTECTED', '已保护的Key不能批量回收');
  player.inventory = player.inventory.filter(i => i.quantity > 0);
}
function getPortal(world: World, id: string | undefined): Portal {
  if (!id || !world.portals[id]) fail('PORTAL_NOT_FOUND', 'PO不存在');
  return world.portals[id];
}
function near(player: Player, portal: Portal): void {
  if (!withinRange(player, portal, RULES.interactionRangeCm)) fail('OUT_OF_RANGE', `距离PO超过${RULES.interactionRangeCm / 100}米`);
}
function cooldown(player: Player, name: string, now: number): void {
  if ((player.cooldowns[name] ?? 0) > now) fail('COOLDOWN', '操作冷却中', {readyAt: player.cooldowns[name]});
}
function award(player: Player, ap: number): void { player.ap += ap; }
// 战报与世界在同一事务提交；限制最近记录数量，避免快照随游戏时长增长。
function recordBattle(world: World, event: BattleEvent): void {
  world.battleEvents = [...(world.battleEvents ?? []), event].slice(-40);
}
function occupied(portal: Portal): number { return portal.resonators.filter(Boolean).length; }

export function createPlayer(id: string, name: string, now: number, spawn: Point): Player {
  return {id, name, x: spawn.x, y: spawn.y, faction: null, ap: 0, xm: RULES.player.starter.xm, energyAt: now, energyRemainder: 0,
    inventory: [], movement: null, cooldowns: {}, hacks: {}, version: 0, createdAt: now, tutorial: {quick_start_pending_at: now}, rechargeRemainder: 0, restrictedUntil: 0};
}

export function createWorld(map: MapData, now: number): World {
  const portals: World['portals'] = {};
  for (const p of map.portals) portals[p.id] = structuredClone(p);
  return {seq: '0', logicalAt: now, season: {id: 1, startAt: now, endAt: now + RULES.seasonMs},
    nextCheckpoint: now + RULES.checkpointMs, portals, links: [], fields: [], scores: {red: 0, green: 0, blue: 0}, maintenance: false, announcement: ''};
}

export function refreshPlayer(player: Player, now: number): Player {
  if (!Number.isSafeInteger(now) || now < player.energyAt) fail('TIME_INVALID', '时钟无效');
  const p = structuredClone(player);
  const elapsed = now - p.energyAt;
  const units = elapsed * RULES.player.xmPerSecond + p.energyRemainder;
  const cap = xmCap(levelForAp(p.ap));
  p.xm = Math.min(cap, p.xm + Math.floor(units / 1000));
  p.energyRemainder = p.xm === cap ? 0 : units % 1000;
  p.energyAt = now;
  if (p.movement) {
    const m = p.movement;
    if (now >= m.arriveAt) { p.x = m.to.x; p.y = m.to.y; p.movement = null; }
    else {
      const elapsedMove = Math.max(0, now - m.startAt);
      const duration = m.arriveAt - m.startAt;
      p.x = m.from.x + Math.trunc((m.to.x - m.from.x) * elapsedMove / duration);
      p.y = m.from.y + Math.trunc((m.to.y - m.from.y) * elapsedMove / duration);
    }
  }
  return p;
}

// 所有到期事件以历史时间推进；同刻先旧状态记分，再切季，最后衰减和拆网。
export function advanceWorld(world: World, now: number): DueResult {
  if (!Number.isSafeInteger(now) || now < world.logicalAt) fail('TIME_INVALID', '世界时钟无效');
  const w = structuredClone(world);
  const result: DueResult = {world: w, checkpoints: [], seasons: []};
  while (true) {
    let nextDecay = Infinity;
    for (const portal of Object.values(w.portals)) for (const r of portal.resonators) if (r && r.nextDecayAt < nextDecay) nextDecay = r.nextDecayAt;
    const at = Math.min(w.nextCheckpoint, w.season.endAt, nextDecay);
    if (at > now) break;
    w.logicalAt = at;
    if (w.nextCheckpoint === at) {
      const score: Record<Faction, number> = {red: 0, green: 0, blue: 0};
      for (const portal of Object.values(w.portals)) if (portal.faction) score[portal.faction] += RULES.pointScorePerCheckpoint;
      for (const field of w.fields) score[field.faction] += field.mu;
      for (const faction of ['red', 'green', 'blue'] as Faction[]) {
        w.scores[faction] += score[faction];
        if (score[faction]) recordBattle(w, {id: `score:${w.season.id}:${at}:${faction}`, at, faction, kind: 'score', portals: [], amount: score[faction]});
      }
      result.checkpoints.push({seasonId: w.season.id, index: (at - w.season.startAt) / RULES.checkpointMs, at, scores: structuredClone(w.scores)});
      w.nextCheckpoint += RULES.checkpointMs;
    }
    if (w.season.endAt === at) {
      result.seasons.push({...w.season, scores: structuredClone(w.scores)});
      const id = w.season.id + 1;
      w.season = {id, startAt: at, endAt: at + RULES.seasonMs};
      w.nextCheckpoint = at + RULES.checkpointMs;
      w.links = []; w.fields = []; w.scores = {red: 0, green: 0, blue: 0};
    }
    if (nextDecay === at) {
      for (const portal of Object.values(w.portals)) {
        let changed = false;
        for (let slot = 0; slot < portal.resonators.length; slot++) {
          const r = portal.resonators[slot];
          if (!r || r.nextDecayAt !== at) continue;
          r.energy -= Math.ceil(ENERGY[r.level] * RULES.resonators.decayPercent / 100);
          if (r.energy <= 0) portal.resonators[slot] = null;
          else r.nextDecayAt += RULES.resonators.decayIntervalMs;
          changed = true;
        }
        if (changed) { portal.version++; cleanNetwork(w, portal); }
      }
    }
  }
  w.logicalAt = now;
  return result;
}

function cleanNetwork(world: World, portal: Portal): {links: number; fields: number} {
  if (occupied(portal) === 0) {portal.faction = null; portal.mods = [null, null, null, null];}
  const beforeLinks = world.links.length, beforeFields = world.fields.length;
  if (occupied(portal) < RULES.link.minimumResonators) {
    world.links = world.links.filter(l => l.origin !== portal.id && l.destination !== portal.id);
  }
  world.links = world.links.filter(l => world.portals[l.origin]?.faction === l.faction && world.portals[l.destination]?.faction === l.faction);
  const current = new Set(world.links.map(l => l.id));
  world.fields = world.fields.filter(f => f.links.every(id => current.has(id)));
  return {links: beforeLinks - world.links.length, fields: beforeFields - world.fields.length};
}

function deployedResonator(player: Player, portal: Portal, slot: number, itemLevel: number, ctx: CommandContext): Resonator {
  // 半径由玩家当前位置确定，八个固定方位用整数厘米落点并校验城市边界。
  const radius = Math.hypot(player.x - portal.x, player.y - portal.y);
  const x = portal.x + Math.round(radius * Math.cos(SLOT_ANGLE[slot]));
  const y = portal.y + Math.round(radius * Math.sin(SLOT_ANGLE[slot]));
  if (x < 0 || x > ctx.map.width || y < 0 || y > ctx.map.height) fail('SLOT_OUT_OF_BOUNDS', '此站位会让脚越出城市');
  return {level: itemLevel, energy: ENERGY[itemLevel], owner: player.id, ownerName: player.name, x, y, generation: ctx.id(), nextDecayAt: ctx.now + RULES.resonators.decayIntervalMs};
}

function deploy(world: World, player: Player, portal: Portal, itemLevel: number, slot: number, ctx: CommandContext): number {
  const faction = ensureFaction(player);
  if (portal.faction && portal.faction !== faction) fail('ENEMY_PORTAL', '敌方PO不能部署');
  if (portal.resonators[slot]) fail('SLOT_OCCUPIED', '槽位已占用');
  const count = portal.resonators.filter(r => r?.owner === player.id && r.level === itemLevel).length;
  if (count >= QUOTA[itemLevel]) fail('QUOTA_EXCEEDED', '该等级脚配额已满');
  const cost = RULES.resonators.xmCostPerLevel * itemLevel;
  enoughXm(player, cost);
  const r = deployedResonator(player, portal, slot, itemLevel, ctx);
  takeItem(player, 'resonator', itemLevel, 1);
  const first = occupied(portal) === 0;
  portal.resonators[slot] = r; portal.faction = faction; portal.version++;
  player.xm -= cost;
  const ap = RULES.ap.deploy + (first ? RULES.ap.firstCapture : 0) + (occupied(portal) === 8 ? RULES.ap.fullPortal : 0);
  award(player, ap);
  return ap;
}

function sampleEquipmentLevel(ctx: CommandContext, poLevel: number): number {
  const roll = random(ctx) * 100;
  let cumulative = 0, offset = 0;
  for (let i = 0; i < RULES.hack.levelOffsets.length; i++) {
    cumulative += RULES.hack.levelWeights[i];
    if (roll < cumulative) {offset = RULES.hack.levelOffsets[i]; break;}
  }
  return Math.min(8, Math.max(1, poLevel + offset));
}

function hack(world: World, player: Player, portal: Portal, ctx: CommandContext): Record<string, unknown> {
  ensureStill(player); near(player, portal);
  if (inventoryCount(player.inventory) >= RULES.player.inventoryLimit) fail('INVENTORY_FULL', '背包已满，需先腾出空间');
  const poLevel = Math.max(1, portalLevel(portal));
  const cost = poLevel * RULES.hack.xmCostPerPortalLevel; enoughXm(player, cost);
  const history = player.hacks[portal.id] ?? {times: [], readyAt: 0};
  if (history.readyAt > ctx.now) fail('COOLDOWN', 'Hack冷却中', {readyAt: history.readyAt});
  const recent = history.times.filter(t => t > ctx.now - RULES.hack.burnoutWindowMs);
  const multi = portal.mods.filter(m => m?.type === 'multihack').length;
  if (recent.length >= RULES.hack.burnoutBase + RULES.hack.extraPerMultiHack * multi) fail('BURNOUT', '此PO暂时过热');
  const faction = ensureFaction(player);
  const enemy = portal.faction !== null && portal.faction !== faction;
  const friendly = portal.faction === faction;
  const ordinary: Item[] = [];
  const push = (type: ItemType, amount: number) => {for (let i = 0; i < amount; i++) ordinary.push({type, level: sampleEquipmentLevel(ctx, poLevel), quantity: 1});};
  const drops = friendly ? RULES.hack.drops.friendly : enemy ? RULES.hack.drops.enemy : RULES.hack.drops.neutral;
  push('resonator', drops[0]); push('pulse', drops[1]); push('cube', drops[2]);
  if (chance(ctx, RULES.hack.baseModChancePercent)) ordinary.push({type: RULES.hack.modTypes[Math.floor(random(ctx) * RULES.hack.modTypes.length)] as ItemType, level: 1, quantity: 1});
  const countered = enemy && chance(ctx, RULES.hack.enemyCounterChancePercent);
  let retained = ordinary;
  if (countered) {
    // 反击在完整普通奖励中做无放回抽样；Key 独立处理，不受减产影响。
    const count = Math.floor(ordinary.length * RULES.hack.counterKeepPercent / 100);
    const shuffled = [...ordinary];
    for (let i = 0; i < count; i++) {
      const j = i + Math.floor(random(ctx) * (shuffled.length - i));
      [shuffled[i], shuffled[j]] = [shuffled[j], shuffled[i]];
    }
    retained = shuffled.slice(0, count);
  }
  const hadKey = itemQuantity(player, 'key', 1, portal.id) > 0;
  const key = !hadKey || chance(ctx, RULES.hack.extraKeyChancePercent);
  player.xm -= cost;
  const counterDamage = countered ? Math.min(player.xm, COUNTER[poLevel]) : 0;
  player.xm -= counterDamage;
  for (const item of retained) addItem(player, item.type, item.level, item.quantity);
  if (key) addItem(player, 'key', 1, 1, portal.id);
  const heat = portal.mods.filter(m => m?.type === 'heatsink').length;
  let cooldownMs = enemy || !friendly ? RULES.hack.otherCooldownMs : RULES.hack.friendlyCooldownMs;
  if (heat) cooldownMs = Math.floor(cooldownMs * RULES.mods.firstHeatSinkCooldownPercent / 100 * ((RULES.mods.additionalHeatSinkCooldownPercent / 100) ** (heat - 1)));
  player.hacks[portal.id] = {times: [...recent, ctx.now], readyAt: ctx.now + cooldownMs};
  if (enemy) award(player, RULES.ap.enemyHack);
  player.tutorial.first_hack_at ??= ctx.now;
  return {type: 'hack', portalId: portal.id, cost, countered, counterDamage, items: retained, key, inventoryCount: inventoryCount(player.inventory), ap: enemy ? RULES.ap.enemyHack : 0};
}

function attack(world: World, player: Player, weaponLevel: number, ctx: CommandContext): {result: Record<string, unknown>; alerts: GameResult['alerts']} {
  ensureStill(player); ensureFaction(player); cooldown(player, 'attack', ctx.now);
  const cost = weaponLevel * RULES.attack.xmCostPerLevel; enoughXm(player, cost);
  if (itemQuantity(player, 'pulse', weaponLevel) < 1) fail('ITEM_INSUFFICIENT', '脉冲器不足');
  const hits: {portal: Portal; slot: number; damage: number}[] = [];
  const affected = new Map<string, {portal: Portal; level: number; faction: Faction; owners: string[]}>();
  for (const portal of Object.values(world.portals)) {
    if (!portal.faction || portal.faction === player.faction) continue;
    // 操作半径缩小后旧脚仍保留原坐标，不能用新部署半径粗筛，否则会漏掉可命中的旧脚。
    const shield = portal.mods.filter(m => m?.type === 'shield').length * RULES.mods.shieldReductionPercent / 100;
    const links = world.links.filter(l => l.origin === portal.id || l.destination === portal.id).length;
    const linkReduction = Math.floor((RULES.mods.linkReductionNumerator / RULES.mods.linkReductionDenominator) * Math.atan(links / Math.E)) / 100;
    const reduction = Math.min(RULES.mods.maxDamageReductionPercent / 100, shield + linkReduction);
    for (let i = 0; i < 8; i++) {
      const r = portal.resonators[i]; if (!r) continue;
      const d2 = distanceSquared(player, r);
      const radius = RADIUS[weaponLevel];
      if (d2 > BigInt(radius) * BigInt(radius)) continue;
      let band = 0;
      const bands = BigInt(RULES.attack.distanceBands), radiusSquared = BigInt(radius) ** 2n;
      for (let threshold = 1; threshold < RULES.attack.distanceBands; threshold++) {
        if (d2 * bands ** 2n >= BigInt(threshold) ** 2n * radiusSquared) band = threshold;
      }
      const damage = Math.max(1, Math.floor(DAMAGE[weaponLevel] * RULES.attack.bandFalloffBase ** -band * (1 - reduction)));
      hits.push({portal, slot: i, damage});
      if (!affected.has(portal.id)) affected.set(portal.id, {portal, level: Math.max(1, portalLevel(portal)), faction: portal.faction,
        owners: [...new Set(portal.resonators.filter((r): r is Resonator => Boolean(r)).map(r => r.owner))]});
    }
  }
  if (!hits.length) fail('NO_TARGET', '范围内没有敌方脚');
  takeItem(player, 'pulse', weaponLevel, 1); player.xm -= cost; player.cooldowns.attack = ctx.now + RULES.attack.cooldownMs;
  const beforeLinks = world.links.length, beforeFields = world.fields.length;
  let destroyed = 0;
  const alerts: NonNullable<GameResult['alerts']> = [];
  for (const hit of hits) {
    const r = hit.portal.resonators[hit.slot]; if (!r) continue;
    r.energy -= hit.damage;
    if (r.energy <= 0) {hit.portal.resonators[hit.slot] = null; destroyed++;}
  }
  for (const {portal, level: poLevel, faction, owners} of affected.values()) {
    alerts.push({portalId: portal.id, faction, owners});
    if (withinRange(player, portal, RULES.interactionRangeCm) && chance(ctx, RULES.attack.counterChancePercent)) player.xm = Math.max(0, player.xm - COUNTER[poLevel]);
    if (portal.mods.some(Boolean) && withinRange(player, portal, RADIUS[weaponLevel]) && chance(ctx, RULES.attack.modDestroyChancePercent)) {
      const indexes = portal.mods.flatMap((m, index) => m ? [index] : []);
      portal.mods[indexes[Math.floor(random(ctx) * indexes.length)]] = null;
    }
    portal.version++; cleanNetwork(world, portal);
  }
  const links = beforeLinks - world.links.length, fields = beforeFields - world.fields.length;
  const ap = destroyed * RULES.ap.destroyResonator + links * RULES.ap.destroyLink + fields * RULES.ap.destroyField;
  award(player, ap);
  return {result: {type: 'attack', level: weaponLevel, cost, hits: hits.length, destroyed, links, fields, ap}, alerts};
}

function recharge(player: Player, portal: Portal, slot: number | undefined, amount: number, ctx: CommandContext): Record<string, unknown> {
  ensureStill(player); const faction = ensureFaction(player);
  if (portal.faction !== faction) fail('NOT_FRIENDLY', '仅可充能友方PO');
  cooldown(player, 'recharge', ctx.now);
  const d2 = distanceSquared(player, portal);
  const local = d2 <= BigInt(RULES.interactionRangeCm ** 2);
  const playerLevel = levelForAp(player.ap);
  if (!local && itemQuantity(player, 'key', 1, portal.id) < 1) fail('KEY_REQUIRED', '远程充能需要目标Key');
  const denominator = local ? 1n : BigInt(RULES.recharge.remoteDenominatorCmPerLevel) * BigInt(playerLevel);
  // 距离向上取整至厘米，效率只会比几何真值更低；付款与送达全用整数分数计算。
  const distanceCm = local ? 0n : ceilSqrt(d2);
  const numerator = denominator - distanceCm;
  if (numerator * 100n < denominator * BigInt(RULES.recharge.remoteMinimumPercent)) fail('OUT_OF_RANGE', '远程充能距离过远');
  const slots = slot === undefined ? portal.resonators.map((r, i) => r ? i : -1).filter(i => i >= 0) : [slot];
  if (slot !== undefined && (slot < 0 || slot > 7 || !portal.resonators[slot])) fail('RESONATOR_NOT_FOUND', '脚不存在');
  const deficit = slots.reduce((n, i) => n + (ENERGY[portal.resonators[i]!.level] - portal.resonators[i]!.energy), 0);
  if (!deficit) fail('ALREADY_FULL', '脚能量已满');
  const budget = Math.min(amount, player.xm);
  if (budget <= 0) fail('XM_INSUFFICIENT', 'XM不足');
  const delivered = Math.min(deficit, Number(BigInt(budget) * numerator / denominator));
  if (!delivered) fail('XM_INSUFFICIENT', '可送达能量不足1');
  const cost = Number((BigInt(delivered) * denominator + numerator - 1n) / numerator);
  if (cost > budget) fail('XM_INSUFFICIENT', 'XM不足');
  let rest = delivered;
  // 全部模式按槽号轮流均分，满槽退出，分配总额先定后扣费。
  while (rest > 0) {
    let changed = false;
    for (const i of slots) {
      const r = portal.resonators[i]!;
      if (r.energy >= ENERGY[r.level]) continue;
      r.energy++; rest--; changed = true;
      if (!rest) break;
    }
    if (!changed) break;
  }
  player.xm -= cost;
  player.cooldowns.recharge = ctx.now + RULES.recharge.cooldownMs;
  portal.version++;
  const points = player.rechargeRemainder + delivered;
  const ap = Math.floor(points / RULES.recharge.apPerDeliveredXm);
  player.rechargeRemainder = points % RULES.recharge.apPerDeliveredXm;
  award(player, ap);
  return {type: 'recharge', portalId: portal.id, delivered, cost, loss: cost - delivered, ap};
}

export function applyCommand(world: World, player: Player, command: GameCommand, ctx: CommandContext, copyWorld = true): GameResult {
  if (!Number.isSafeInteger(ctx.now) || ctx.now < world.logicalAt) fail('TIME_INVALID', '命令时间无效');
  // false仅供数据库事务内的私有世界副本使用；普通调用仍克隆，以保证失败不修改入参。
  const w = copyWorld ? structuredClone(world) : world;
  const p = refreshPlayer(player, ctx.now);
  absorbGroundXm(w, player, p, ctx.now);
  const payload = command.payload ?? {};
  const previousFaction = command.portalId ? w.portals[command.portalId]?.faction : undefined;
  let result: Record<string, unknown>;
  let alerts: GameResult['alerts'];
  let destroyedFields: World['fields'] = [];
  if (w.maintenance) fail('MAINTENANCE', '世界维护中');
  if (p.restrictedUntil > ctx.now && command.type !== 'move-cancel') fail('RESTRICTED', '账号暂时受限');
  switch (command.type) {
    case 'rename': {
      const error = playerNameError(payload.name);
      if (error) fail('INVALID_INPUT', error);
      const name = (payload.name as string).trim();
      p.name = name;
      // 当前脚署名跟随账号改名，历史战报仍保留事件发生时的名字。
      for (const portal of Object.values(w.portals)) {
        let changed = false;
        for (const resonator of portal.resonators) {
          if (resonator?.owner === p.id && resonator.ownerName !== name) {resonator.ownerName = name; changed = true;}
        }
        if (changed) portal.version++;
      }
      result = {type: 'rename', name}; break;
    }
    case 'guide-read': {
      if (p.tutorial.quick_start_pending_at !== undefined) {
        delete p.tutorial.quick_start_pending_at;
        p.tutorial.quick_start_seen_at = ctx.now;
      }
      result = {type: 'guide-read'}; break;
    }
    case 'faction': {
      if (p.faction) fail('FACTION_LOCKED', '阵营不可重复选择');
      if (payload.faction !== 'red' && payload.faction !== 'green' && payload.faction !== 'blue') fail('INVALID_INPUT', '阵营无效');
      p.faction = payload.faction;
      addItem(p, 'resonator', 1, RULES.player.starter.resonatorsL1);
      addItem(p, 'pulse', 1, RULES.player.starter.pulsesL1);
      addItem(p, 'cube', 1, RULES.player.starter.cubesL1);
      result = {type: 'faction', faction: p.faction, starterItems: RULES.player.starter.resonatorsL1 + RULES.player.starter.pulsesL1 + RULES.player.starter.cubesL1}; break;
    }
    case 'move': {
      const x = integer(payload.x, 'x', 0, ctx.map.width), y = integer(payload.y, 'y', 0, ctx.map.height);
      const distanceCm = ceilSqrt(distanceSquared(p, {x, y}));
      const speed = BigInt(RULES.player.speedCmPerSecond);
      const duration = Number((distanceCm + speed - 1n) / speed) * 1000;
      p.movement = duration ? {from: {x: p.x, y: p.y}, to: {x, y}, startAt: ctx.now, arriveAt: ctx.now + duration} : null;
      result = {type: 'move', arriveAt: ctx.now + duration}; break;
    }
    case 'move-cancel': {
      if (!p.movement) fail('NOT_MOVING', '当前没有移动');
      p.movement = null; result = {type: 'move-cancel', x: p.x, y: p.y}; break;
    }
    case 'hack': result = hack(w, p, getPortal(w, command.portalId), ctx); break;
    case 'deploy':
    case 'deploy-all': {
      ensureStill(p); ensureFaction(p);
      const portal = getPortal(w, command.portalId); near(p, portal);
      const initialLevel = levelForAp(p.ap);
      if (command.type === 'deploy') {
        const itemLevel = level(payload.level, p);
        const slot = payload.slot === undefined ? portal.resonators.findIndex(r => !r) : integer(payload.slot, '槽位', 0, 7);
        if (slot < 0) fail('PORTAL_FULL', 'PO已满槽');
        const ap = deploy(w, p, portal, itemLevel, slot, ctx);
        result = {type: 'deploy', portalId: portal.id, slot, level: itemLevel, cost: itemLevel * RULES.resonators.xmCostPerLevel, ap};
      } else {
        const maxCount = payload.maxCount === undefined ? 8 : integer(payload.maxCount, '数量', 1, 8);
        const fixedLevel = payload.level === undefined ? undefined : integer(payload.level, '等级', 1, initialLevel);
        const entries: {slot: number; level: number}[] = [];
        let totalAp = 0, cost = 0;
        for (let i = 0; i < 8 && entries.length < maxCount; i++) {
          if (portal.resonators[i]) continue;
          let chosen = 0;
          for (let l = fixedLevel ?? initialLevel; l >= (fixedLevel ?? 1); l--) {
            if (itemQuantity(p, 'resonator', l) > 0 && portal.resonators.filter(r => r?.owner === p.id && r.level === l).length < QUOTA[l] && p.xm >= l * RULES.resonators.xmCostPerLevel) {chosen = l; break;}
          }
          if (!chosen) break;
          totalAp += deploy(w, p, portal, chosen, i, ctx);
          cost += chosen * RULES.resonators.xmCostPerLevel; entries.push({slot: i, level: chosen});
        }
        if (!entries.length) fail('NOTHING_TO_DEPLOY', '没有可部署的脚');
        result = {type: 'deploy-all', portalId: portal.id, entries, cost, ap: totalAp};
      }
      break;
    }
    case 'upgrade': {
      ensureStill(p); ensureFaction(p);
      const portal = getPortal(w, command.portalId); near(p, portal);
      if (portal.faction !== p.faction || occupied(portal) !== 8) fail('UPGRADE_UNAVAILABLE', '需先填满友方PO');
      const slot = integer(payload.slot, '槽位', 0, 7), itemLevel = level(payload.level, p);
      const old = portal.resonators[slot];
      if (!old || itemLevel <= old.level) fail('UPGRADE_UNAVAILABLE', '只能升级已有脚');
      if (portal.resonators.filter(r => r?.owner === p.id && r.level === itemLevel).length >= QUOTA[itemLevel]) fail('QUOTA_EXCEEDED', '该等级脚配额已满');
      const cost = itemLevel * RULES.resonators.xmCostPerLevel; enoughXm(p, cost); takeItem(p, 'resonator', itemLevel, 1);
      portal.resonators[slot] = {...old, level: itemLevel, energy: ENERGY[itemLevel], owner: p.id, ownerName: p.name, generation: ctx.id(), nextDecayAt: ctx.now + RULES.resonators.decayIntervalMs};
      portal.version++; p.xm -= cost;
      const ap = old.owner === p.id ? 0 : RULES.ap.upgradeOther; award(p, ap);
      result = {type: 'upgrade', portalId: portal.id, slot, level: itemLevel, cost, ap}; break;
    }
    case 'attack': {
      const previousFields = w.fields;
      const outcome = attack(w, p, level(payload.level, p), ctx);
      // 一次脉冲可能同时拆掉同一领域的多个顶点，按攻击前后的领域集合只记录一次。
      const survivingFields = new Set(w.fields.map(field => field.id));
      destroyedFields = previousFields.filter(field => !survivingFields.has(field.id));
      result = outcome.result; alerts = outcome.alerts; break;
    }
    case 'recharge': {
      const portal = getPortal(w, command.portalId);
      const slot = payload.slot === undefined ? undefined : integer(payload.slot, '槽位', 0, 7);
      const amount = payload.amount === undefined ? RULES.recharge.maxInputXm : integer(payload.amount, '投入', 1, RULES.recharge.maxInputXm);
      if (slot !== undefined && payload.generation !== undefined && payload.generation !== portal.resonators[slot]?.generation) fail('GENERATION_CHANGED', '脚已替换，请刷新后充能');
      if (slot === undefined && payload.generations !== undefined) {
        const generations = payload.generations;
        if (!generations || typeof generations !== 'object' || Array.isArray(generations)) fail('INVALID_INPUT', '脚版本无效');
        for (let i = 0; i < portal.resonators.length; i++) {
          if ((generations as Record<string, unknown>)[i] !== (portal.resonators[i]?.generation ?? null)) fail('GENERATION_CHANGED', '脚已替换，请刷新后充能');
        }
      }
      result = recharge(p, portal, slot, amount, ctx); break;
    }
    case 'sugar':
    case 'recycle': {
      // 糖块回收与使用共用等级、冷却、满能量和收益规则，不能借回收绕开使用限制。
      if (command.type === 'recycle' && payload.type !== 'cube') {
        ensureStill(p);
        const itemType = payload.type;
        if (typeof itemType !== 'string' || !['resonator', 'pulse', 'key', 'shield', 'heatsink', 'multihack'].includes(itemType)) fail('INVALID_INPUT', '道具类型无效');
        const itemLevel = ['key', 'shield', 'heatsink', 'multihack'].includes(itemType) ? 1 : integer(payload.level, '等级', 1, 8);
        const quantity = integer(payload.quantity, '数量', 1, 5000);
        const keyPortal = itemType === 'key' ? text(payload.portalId, 'Key目标') : undefined;
        takeItem(p, itemType as ItemType, itemLevel, quantity, keyPortal, false);
        const rewardEach = itemType === 'key' ? RULES.items.recycleKey : ['shield', 'heatsink', 'multihack'].includes(itemType) ? RULES.items.recycleMod : RULES.items.recycleResonatorAndPulsePerLevel * itemLevel;
        const restored = Math.min(xmCap(levelForAp(p.ap)) - p.xm, rewardEach * quantity);
        p.xm += restored;
        result = {type: 'recycle', itemType, level: itemLevel, quantity, restored, wasted: rewardEach * quantity - restored}; break;
      }
      if (command.type === 'recycle') integer(payload.quantity, '数量', 1, 1);
      ensureStill(p); cooldown(p, 'sugar', ctx.now);
      const itemLevel = level(payload.level, p), cap = xmCap(levelForAp(p.ap));
      if (p.xm >= cap) fail('ALREADY_FULL', 'XM已满');
      takeItem(p, 'cube', itemLevel, 1);
      const restored = Math.min(cap - p.xm, itemLevel * RULES.items.cubeRecoveryPerLevel);
      p.xm += restored; p.cooldowns.sugar = ctx.now + RULES.items.cubeCooldownMs;
      result = {type: command.type, itemType: 'cube', quantity: 1, level: itemLevel, restored, wasted: itemLevel * RULES.items.cubeRecoveryPerLevel - restored}; break;
    }
    case 'drop': {
      ensureStill(p);
      const itemType = payload.type;
      if (typeof itemType !== 'string' || !['resonator', 'pulse', 'cube', 'key', 'shield', 'heatsink', 'multihack'].includes(itemType)) fail('INVALID_INPUT', '道具类型无效');
      const itemLevel = ['key', 'shield', 'heatsink', 'multihack'].includes(itemType) ? 1 : integer(payload.level, '等级', 1, 8);
      const quantity = integer(payload.quantity, '数量', 1, 500);
      const keyPortal = itemType === 'key' ? text(payload.portalId, 'Key目标') : undefined;
      takeItem(p, itemType as ItemType, itemLevel, quantity, keyPortal, false);
      const drop = {id: ctx.id(), x: p.x, y: p.y, droppedAt: ctx.now,
        item: {type: itemType as ItemType, level: itemLevel, quantity, ...(keyPortal ? {portalId: keyPortal} : {})}};
      (w.droppedItems ??= []).push(drop);
      result = {type: 'drop', drop}; break;
    }
    case 'pickup': {
      ensureStill(p);
      const id = text(payload.dropId, '地面道具');
      const drop = w.droppedItems?.find(item => item.id === id);
      if (!drop) fail('DROP_NOT_FOUND', '道具已被拾取');
      if (!withinRange(p, drop, RULES.interactionRangeCm)) fail('OUT_OF_RANGE', `请靠近道具${RULES.interactionRangeCm / 100}米内拾取`);
      if (inventoryCount(p.inventory) + drop.item.quantity > RULES.player.inventoryLimit) fail('INVENTORY_FULL', '背包空间不足，请先使用、回收或丢弃物品');
      addItem(p, drop.item.type, drop.item.level, drop.item.quantity, drop.item.portalId);
      w.droppedItems = w.droppedItems!.filter(item => item.id !== id);
      result = {type: 'pickup', dropId: id, item: drop.item}; break;
    }
    case 'mod': {
      ensureStill(p); ensureFaction(p);
      const portal = getPortal(w, command.portalId); near(p, portal);
      if (portal.faction !== p.faction) fail('NOT_FRIENDLY', '仅可安装到友方PO');
      const type = payload.type;
      if (type !== 'shield' && type !== 'heatsink' && type !== 'multihack') fail('INVALID_INPUT', 'MOD类型无效');
      if (portal.mods.filter(m => m?.owner === p.id).length >= RULES.mods.perPlayerPerPortal) fail('MOD_QUOTA', '每人每PO最多两件MOD');
      const slot = portal.mods.findIndex(m => !m);
      if (slot < 0) fail('MOD_FULL', 'MOD槽已满');
      takeItem(p, type, 1, 1); portal.mods[slot] = {type, owner: p.id}; portal.version++; award(p, RULES.ap.installMod);
      result = {type: 'mod', portalId: portal.id, slot, modType: type, ap: RULES.ap.installMod}; break;
    }
    case 'link-preview':
    case 'link': {
      ensureStill(p); ensureFaction(p);
      const origin = getPortal(w, command.portalId); near(p, origin);
      const destinationId = text(payload.destinationId, '目标PO');
      enoughXm(p, RULES.linkXmCost);
      cooldown(p, 'link', ctx.now);
      let link, fields;
      try {({link, fields} = validateLinkTarget(w, p, origin.id, destinationId));}
      catch (error) {
        const e = error as Error & {code?: string; details?: Record<string, unknown>};
        const messages: Record<string, string> = {LINK_UNAVAILABLE: '两端须为满槽友方PO', LINK_RANGE: '超出起点射程',
          LINK_LIMIT: '起点已达八条出线', KEY_REQUIRED: '需要目标PO Key'};
        fail(e.code ?? 'LINK_GEOMETRY', messages[e.code ?? ''] ?? e.message, e.details);
      }
      if (command.type === 'link-preview') result = {type: 'link-preview', link, fields, cost: RULES.linkXmCost};
      else {
        takeItem(p, 'key', 1, 1, destinationId);
        p.xm -= RULES.linkXmCost; p.cooldowns.link = ctx.now + RULES.link.cooldownMs;
        w.links.push(link); w.fields.push(...fields);
        const ap = RULES.ap.link + RULES.ap.field * fields.length; award(p, ap);
        if (fields.length) p.tutorial.first_field_at ??= ctx.now;
        result = {type: 'link', link, fields, cost: RULES.linkXmCost, ap};
      }
      break;
    }
    default: fail('UNKNOWN_COMMAND', '未知命令');
  }
  if (command.type !== 'link-preview') {
    // 按本次 AP 跨越的每一级发包，收据回放由 Store 保证不重复执行；满包也不截断礼包。
    const levelRewards: LevelReward[] = [];
    for (let gained = levelForAp(player.ap) + 1; gained <= levelForAp(p.ap); gained++) {
      const items: Item[] = [
        {type: 'pulse', level: gained, quantity: RULES.player.levelUp.pulses},
        {type: 'resonator', level: gained, quantity: RULES.player.levelUp.resonators},
        {type: 'cube', level: gained, quantity: RULES.player.levelUp.cubes},
      ];
      for (const item of items) addItem(p, item.type, item.level, item.quantity);
      levelRewards.push({level: gained, items});
    }
    if (levelRewards.length) result.levelRewards = levelRewards;
    if (p.faction) {
      // 首次选定阵营才算加入战斗，与阵营及新手包一同提交，恢复登录不重复播报。
      if (command.type === 'faction') recordBattle(w, {id: ctx.id(), at: ctx.now, faction: p.faction, actor: p.name, kind: 'join', portals: []});
      if (['deploy', 'deploy-all'].includes(command.type) && previousFaction === null && command.portalId) {
        recordBattle(w, {id: ctx.id(), at: ctx.now, faction: p.faction, actor: p.name, kind: 'capture', portals: [command.portalId]});
      }
      if (command.type === 'link' && command.portalId) {
        recordBattle(w, {id: ctx.id(), at: ctx.now, faction: p.faction, actor: p.name, kind: 'link', portals: [command.portalId, String(payload.destinationId)]});
        for (const field of result.fields as World['fields']) recordBattle(w, {id: ctx.id(), at: ctx.now, faction: p.faction, actor: p.name, kind: 'field', portals: field.vertices, amount: field.mu});
      }
      for (const alert of alerts ?? []) recordBattle(w, {id: ctx.id(), at: ctx.now, faction: p.faction, actor: p.name, kind: 'attack', portals: [alert.portalId]});
      for (const field of destroyedFields) recordBattle(w, {id: ctx.id(), at: ctx.now, faction: p.faction, actor: p.name, kind: 'field-destroyed', portals: field.vertices, amount: field.mu});
    }
    p.version++; w.logicalAt = ctx.now;
  }
  return {world: w, player: p, result, ...(alerts ? {alerts} : {})};
}
