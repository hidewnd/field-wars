import type { Field, Link, MapData, Point, TerrainLine, World } from './types.js';
import { RULES } from './rules.js';

export class GeometryError extends Error {
  constructor(public readonly code: string, public readonly details?: Record<string, unknown>) {
    super(code);
  }
}

export function distanceSquared(a: Point, b: Point): bigint {
  const dx = BigInt(a.x) - BigInt(b.x);
  const dy = BigInt(a.y) - BigInt(b.y);
  return dx * dx + dy * dy;
}

export function withinRange(a: Point, b: Point, rangeCm: number): boolean {
  return distanceSquared(a, b) <= BigInt(rangeCm) ** 2n;
}

export function lineClearanceAtLeast(point: Point, line: TerrainLine, clearanceCm: number): boolean {
  const required = BigInt(line.halfWidth + clearanceCm);
  const threshold = required * required;
  for (let index = 1; index < line.points.length; index++) {
    const a = line.points[index - 1], b = line.points[index];
    const dx = BigInt(b.x - a.x), dy = BigInt(b.y - a.y);
    const px = BigInt(point.x - a.x), py = BigInt(point.y - a.y);
    const length2 = dx * dx + dy * dy;
    if (length2 === 0n) {
      if (distanceSquared(point, a) < threshold) return false;
      continue;
    }
    const projection = px * dx + py * dy;
    if (projection <= 0n) {
      if (distanceSquared(point, a) < threshold) return false;
    } else if (projection >= length2) {
      if (distanceSquared(point, b) < threshold) return false;
    } else {
      const area = px * dy - py * dx;
      if (area * area < threshold * length2) return false;
    }
  }
  return true;
}

// 初始地图保持冻结；新增点只对已经批准的点检查规则中的最小间距。
export function validateNewPortalLocation(map: MapData, approved: Point[], point: Point, districtId: string): void {
  const district = map.districts.find(item => item.id === districtId);
  if (!district || point.x < district.bounds[0] || point.x >= district.bounds[2]
    || point.y < district.bounds[1] || point.y >= district.bounds[3]) throw new GeometryError('PO_DISTRICT');
  const policy = RULES.newPortals;
  if (point.x < policy.cityBoundaryClearanceCm || point.x > map.width - policy.cityBoundaryClearanceCm
    || point.y < policy.cityBoundaryClearanceCm || point.y > map.height - policy.cityBoundaryClearanceCm) throw new GeometryError('PO_BOUNDARY');
  if (approved.some(existing => distanceSquared(point, existing) < BigInt(policy.minApprovedSpacingCm) ** 2n)) throw new GeometryError('PO_SPACING');
  if (map.water.some(line => !lineClearanceAtLeast(point, line, policy.waterShoreClearanceCm))) throw new GeometryError('PO_WATER');
  if (map.rails.some(line => !lineClearanceAtLeast(point, line, policy.railCenterlineClearanceCm))) throw new GeometryError('PO_RAIL');
}

export function cross(a: Point, b: Point, c: Point): bigint {
  return (BigInt(b.x) - BigInt(a.x)) * (BigInt(c.y) - BigInt(a.y))
    - (BigInt(b.y) - BigInt(a.y)) * (BigInt(c.x) - BigInt(a.x));
}

function onSegment(a: Point, b: Point, p: Point): boolean {
  return cross(a, b, p) === 0n && p.x >= Math.min(a.x, b.x) && p.x <= Math.max(a.x, b.x)
    && p.y >= Math.min(a.y, b.y) && p.y <= Math.max(a.y, b.y);
}

function samePoint(a: Point, b: Point): boolean { return a.x === b.x && a.y === b.y; }
function sign(value: bigint): number { return value < 0n ? -1 : value > 0n ? 1 : 0; }

// 端点接触仅在两条边确实复用同一个 PO 时允许；共线部分重叠始终拒绝。
export function segmentsConflict(a: Point, b: Point, c: Point, d: Point): boolean {
  const abC = cross(a, b, c), abD = cross(a, b, d), cdA = cross(c, d, a), cdB = cross(c, d, b);
  if (abC === 0n && abD === 0n) {
    const useX = Math.abs(a.x - b.x) >= Math.abs(a.y - b.y);
    const first = [useX ? a.x : a.y, useX ? b.x : b.y].sort((x, y) => x - y);
    const second = [useX ? c.x : c.y, useX ? d.x : d.y].sort((x, y) => x - y);
    const low = Math.max(first[0], second[0]), high = Math.min(first[1], second[1]);
    if (high > low) return true;
    if (high < low) return false;
    const touching = [a, b].find(p => [c, d].some(q => samePoint(p, q)));
    return !touching;
  }
  if (sign(abC) * sign(abD) > 0 || sign(cdA) * sign(cdB) > 0) return false;
  if (abC === 0n && onSegment(a, b, c) && !samePoint(c, a) && !samePoint(c, b)) return true;
  if (abD === 0n && onSegment(a, b, d) && !samePoint(d, a) && !samePoint(d, b)) return true;
  if (cdA === 0n && onSegment(c, d, a) && !samePoint(a, c) && !samePoint(a, d)) return true;
  if (cdB === 0n && onSegment(c, d, b) && !samePoint(b, c) && !samePoint(b, d)) return true;
  if (sign(abC) * sign(abD) < 0 && sign(cdA) * sign(cdB) < 0) return true;
  // 一条边的端点落在另一条边的端点上是合法复用 PO。
  return false;
}

function isqrt(value: bigint): bigint {
  if (value < 2n) return value;
  let x = 1n << BigInt(Math.ceil(value.toString(2).length / 2));
  for (;;) {
    const next = (x + value / x) >> 1n;
    if (next >= x) return x;
    x = next;
  }
}

export function fieldMu(a: Point, b: Point, c: Point): number {
  const twiceArea = cross(a, b, c);
  const magnitude = twiceArea < 0n ? -twiceArea : twiceArea;
  if (magnitude === 0n) return 0;
  const divisor = 2n * 100n ** 2n * BigInt(RULES.muSqrtDivisorMeters) ** 2n;
  const candidate = isqrt(magnitude / divisor);
  return Number(candidate > BigInt(RULES.minimumFieldMu) ? candidate : BigInt(RULES.minimumFieldMu));
}

export function isLargeField(a: Point, b: Point, c: Point): boolean {
  const threshold = BigInt(RULES.largeFieldThresholdCm) ** 2n;
  return [distanceSquared(a, b), distanceSquared(b, c), distanceSquared(c, a)].some(length => length > threshold);
}

function inClosedTriangle(p: Point, a: Point, b: Point, c: Point): boolean {
  const sides = [cross(a, b, p), cross(b, c, p), cross(c, a, p)];
  return sides.every(side => side >= 0n) || sides.every(side => side <= 0n);
}

export function triangleContains(inner: [Point, Point, Point], outer: [Point, Point, Point]): boolean {
  if (cross(...outer) === 0n || cross(...inner) === 0n) return false;
  if (!inner.every(point => inClosedTriangle(point, ...outer))) return false;
  return !outer.every(point => inClosedTriangle(point, ...inner));
}

function edgeId(a: string, b: string): string { return [a, b].sort().join('|'); }
function fieldId(vertices: [string, string, string]): string { return vertices.join('|'); }

export function validateLink(world: World, originId: string, destinationId: string, ownerId: string): {link: Link; fields: Field[]} {
  const origin = world.portals[originId], destination = world.portals[destinationId];
  if (!origin || !destination || originId === destinationId) throw new GeometryError('PORTAL_NOT_FOUND');
  if (distanceSquared(origin, destination) === 0n) throw new GeometryError('LINK_GEOMETRY');
  const key = edgeId(originId, destinationId);
  if (world.links.some(existing => edgeId(existing.origin, existing.destination) === key)) throw new GeometryError('LINK_EXISTS');
  for (const portal of Object.values(world.portals)) {
    if (portal.id !== originId && portal.id !== destinationId && onSegment(origin, destination, portal)) {
      throw new GeometryError('LINK_THROUGH_PORTAL', {portalId: portal.id});
    }
  }
  for (const existing of world.links) {
    const from = world.portals[existing.origin], to = world.portals[existing.destination];
    if (from && to && segmentsConflict(origin, destination, from, to)) {
      throw new GeometryError('LINK_CROSSING', {linkId: existing.id});
    }
  }
  const faction = origin.faction;
  if (!faction || faction !== destination.faction) throw new GeometryError('LINK_FACTION');
  const link: Link = {id: key, origin: originId, destination: destinationId, faction, owner: ownerId};
  const neighborOfOrigin = new Map<string, Link>(), neighborOfDestination = new Map<string, Link>();
  for (const existing of world.links) {
    if (existing.faction !== faction) continue;
    if (existing.origin === originId || existing.destination === originId) neighborOfOrigin.set(existing.origin === originId ? existing.destination : existing.origin, existing);
    if (existing.origin === destinationId || existing.destination === destinationId) neighborOfDestination.set(existing.origin === destinationId ? existing.destination : existing.origin, existing);
  }
  const fields: Field[] = [];
  for (const [thirdId, firstEdge] of neighborOfOrigin) {
    const secondEdge = neighborOfDestination.get(thirdId), third = world.portals[thirdId];
    if (!secondEdge || !third || third.faction !== faction || cross(origin, destination, third) === 0n) continue;
    const vertices = [originId, destinationId, thirdId].sort() as [string, string, string];
    const id = fieldId(vertices);
    if (world.fields.some(existing => fieldId(existing.vertices) === id)) continue;
    fields.push({id, vertices, links: [link.id, firstEdge.id, secondEdge.id], faction, owner: ownerId, mu: fieldMu(origin, destination, third), large: isLargeField(origin, destination, third)});
  }
  const all = [...world.fields, ...fields];
  for (let i = 0; i < all.length; i++) {
    if (!all[i].large) continue;
    for (let j = i + 1; j < all.length; j++) {
      if (!all[j].large || (i < world.fields.length && j < world.fields.length)) continue;
      const va = all[i].vertices, vb = all[j].vertices;
      const a: [Point, Point, Point] = [world.portals[va[0]], world.portals[va[1]], world.portals[va[2]]];
      const b: [Point, Point, Point] = [world.portals[vb[0]], world.portals[vb[1]], world.portals[vb[2]]];
      if (triangleContains(a, b) || triangleContains(b, a)) {
        throw new GeometryError('FIELD_NESTING', {first: all[i].id, second: all[j].id});
      }
    }
  }
  return {link, fields};
}
