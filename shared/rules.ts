import data from './beta-v1.json' with { type: 'json' };
import type { Item, Portal } from './types.js';

// 所有玩法端只读取同一份冻结表；射程表的索引是八槽等级总和，而不是显示等级。
export const RULES = data;

export function levelForAp(ap: number): number {
  for (let index = RULES.apThresholds.length - 1; index >= 0; index--) {
    if (ap >= RULES.apThresholds[index]) return index + 1;
  }
  return 1;
}

export function xmCap(level: number): number {
  return RULES.xmCaps[Math.max(0, Math.min(7, Math.trunc(level) - 1))];
}

export function portalLevel(portal: Portal): number {
  const sum = portal.resonators.reduce<number>((total, resonator) => total + (resonator?.level ?? 0), 0);
  return sum === 0 ? 0 : Math.max(1, Math.floor(sum / 8));
}

export function portalRange(portal: Portal): number {
  const sum = portal.resonators.reduce<number>((total, resonator) => total + (resonator?.level ?? 0), 0);
  // 低等级射程设下限，混合升级不会使射程倒退；更高等级继续使用原表。
  return sum ? Math.max(RULES.minimumPortalRangeCm, RULES.rangeCm[sum] ?? 0) : 0;
}

export function inventoryCount(items: Item[]): number {
  return items.reduce((total, item) => total + item.quantity, 0);
}
