import type { Player, World } from './types.js';
import { RULES, portalRange } from './rules.js';
import { GeometryError, validateLink, withinRange } from './geometry.js';

// 列表和最终命令共用目标资格校验；玩家位置、XM、冷却仍由命令入口实时检查。
export function validateLinkTarget(world: World, player: Player, originId: string, destinationId: string) {
  const origin = world.portals[originId], destination = world.portals[destinationId];
  if (!origin || !destination || originId === destinationId) throw new GeometryError('PORTAL_NOT_FOUND');
  if (!player.faction || origin.faction !== player.faction || destination.faction !== player.faction
    || origin.resonators.filter(Boolean).length !== RULES.link.minimumResonators
    || destination.resonators.filter(Boolean).length !== RULES.link.minimumResonators) throw new GeometryError('LINK_UNAVAILABLE');
  if (!withinRange(origin, destination, portalRange(origin))) throw new GeometryError('LINK_RANGE');
  if (world.links.filter(link => link.origin === originId).length >= RULES.link.maxOutgoing) throw new GeometryError('LINK_LIMIT');
  if (!player.inventory.some(item => item.type === 'key' && item.level === 1 && item.portalId === destinationId && item.quantity > 0)) throw new GeometryError('KEY_REQUIRED');
  return validateLink(world, originId, destinationId, player.id);
}
