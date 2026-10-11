import type {GroundXm, MapData, Player, Point, World} from './types.js';
import {RULES, levelForAp, xmCap} from './rules.js';

export function refreshGroundXm(world: World, map: MapData, now: number): void {
  if (!RULES.features.groundXm || (world.nextGroundXmAt ?? 0) > now) return;
  const policy = RULES.groundXm;
  // 批次按现实时间固定，停机只补当前批次，不堆积历史资源；同批重试生成相同点位。
  const spawnedAt = Math.floor(now / policy.refreshIntervalMs) * policy.refreshIntervalMs;
  let seed = Math.floor(spawnedAt / policy.refreshIntervalMs) >>> 0;
  const random = () => { seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0; return seed / 0x100000000; };
  const points: GroundXm[] = [];
  const add = (x: number, y: number) => points.push({id: `xm:${spawnedAt}:${points.length}`,
    x: Math.max(0, Math.min(map.width, Math.round(x))), y: Math.max(0, Math.min(map.height, Math.round(y))),
    amount: policy.amount, spawnedAt, expiresAt: spawnedAt + policy.refreshIntervalMs});
  for (const portal of Object.values(world.portals).sort((a,b) => a.id.localeCompare(b.id))) {
    for (let index = 0; index < policy.perPortal; index++) {
      const angle = random() * Math.PI * 2, radius = Math.sqrt(random()) * policy.portalRadiusCm;
      add(portal.x + Math.cos(angle) * radius, portal.y + Math.sin(angle) * radius);
    }
  }
  for (let index = 0; index < policy.randomCount; index++) add(random() * map.width, random() * map.height);
  world.groundXm = points;
  world.nextGroundXmAt = spawnedAt + policy.refreshIntervalMs;
}

function movementPosition(player: Player, at: number): Point {
  const movement = player.movement;
  if (!movement) return player;
  const ratio = Math.max(0, Math.min(1, (at - movement.startAt) / (movement.arriveAt - movement.startAt)));
  return {x: movement.from.x + (movement.to.x - movement.from.x) * ratio,
    y: movement.from.y + (movement.to.y - movement.from.y) * ratio};
}

// previous 保留刷新前的移动轨迹，跨越能量点也能收集；出生前经过的路段不可追领。
export function absorbGroundXm(world: World, previous: Player, player: Player, now: number): number {
  const cap = xmCap(levelForAp(player.ap));
  if (!RULES.features.groundXm || player.xm >= cap || !player.faction || player.restrictedUntil > now) return 0;
  let restored = 0;
  for (const point of world.groundXm ?? []) {
    if (point.spawnedAt > now || point.expiresAt <= now || point.amount <= 0) continue;
    const from = movementPosition(previous, Math.max(previous.energyAt, point.spawnedAt));
    const to = movementPosition(previous, now);
    const dx = to.x - from.x, dy = to.y - from.y, length2 = dx * dx + dy * dy;
    const ratio = length2 ? Math.max(0, Math.min(1, ((point.x - from.x) * dx + (point.y - from.y) * dy) / length2)) : 0;
    if (Math.hypot(point.x - from.x - ratio * dx, point.y - from.y - ratio * dy) > RULES.interactionRangeCm) continue;
    const amount = Math.min(point.amount, cap - player.xm);
    player.xm += amount; point.amount -= amount; restored += amount;
    if (player.xm === cap) { player.energyRemainder = 0; break; }
  }
  if (restored) world.groundXm = world.groundXm!.filter(point => point.amount > 0);
  return restored;
}
