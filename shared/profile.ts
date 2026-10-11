export const PLAYER_NAME_LIMIT = 20;

export function playerNameError(value: unknown): string {
  if (typeof value !== 'string' || !value.trim()) return '请输入玩家名称';
  // 按 Unicode 字符计数，中文和英文各占一个字符；禁止控制符和不可见格式字符。
  if ([...value.trim()].length > PLAYER_NAME_LIMIT) return `玩家名称最多 ${PLAYER_NAME_LIMIT} 个字符`;
  if (/[\p{Cc}\p{Cf}]/u.test(value)) return '玩家名称不能包含换行或不可见字符';
  return '';
}
