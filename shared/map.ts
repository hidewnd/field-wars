import data from '../maps/beta-v1.json' with { type: 'json' };
import type { MapData } from './types.js';

export const BETA_MAP = data as MapData;

export function initialPortals(): MapData['portals'] {
  return BETA_MAP.portals.map(portal => ({ ...portal, resonators: Array(8).fill(null), mods: Array(4).fill(null) }));
}

export function validateBetaMap(map: MapData = BETA_MAP): void {
  if (map.version !== 'beta-v1' || map.width !== 2_000_000 || map.height !== 1_600_000 || map.districts.length !== 20 || map.spawns.length !== 20 || map.portals.length !== 100) {
    throw new Error('MAP_VERSION_OR_COUNT');
  }
  const ids = new Set(map.portals.map(portal => portal.id));
  if (ids.size !== 100) throw new Error('MAP_DUPLICATE_PO');
  for (const district of map.districts) {
    const points = map.portals.filter(portal => portal.districtId === district.id);
    if (points.length !== 5 || points.filter(portal => portal.role === 'core').length !== 3 || map.spawns.filter(spawn => spawn.districtId === district.id).length !== 1) {
      throw new Error('MAP_DISTRICT_CLUSTER');
    }
  }
}
