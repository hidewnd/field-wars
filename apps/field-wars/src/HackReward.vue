<script setup lang="ts">
import { computed, nextTick, onBeforeUnmount, onMounted, ref } from 'vue';
import type { Item } from '../../../shared/types';

const props = defineProps<{ rewardLevel?: number; portalName: string; items: Item[]; cost: number; ap: number; counterDamage: number }>();
const emit = defineEmits<{ close: [] }>();
const dialog = ref<HTMLElement | null>(null);
const previousFocus = document.activeElement as HTMLElement | null;
const names: Record<Item['type'], string> = { resonator: '共振脚', pulse: '脉冲器', cube: '糖块', key: '据点 Key', shield: '护盾', heatsink: '热沉', multihack: '多重 Hack' };
// 收据逐件记录掉落；只在展示层按物品与等级合并，不通过库存差值猜测奖励。
const rewards = computed(() => {
  const groups = new Map<string, Item>();
  for (const item of props.items) {
    const key = `${item.type}:${item.level}:${item.portalId ?? ''}`;
    const previous = groups.get(key);
    if (previous) previous.quantity += item.quantity;
    else groups.set(key, { ...item });
  }
  return [...groups.values()];
});
function onKey(event: KeyboardEvent) {
  if (event.key === 'Escape') { event.preventDefault(); emit('close'); }
  if (event.key !== 'Tab') return;
  const buttons = dialog.value?.querySelectorAll<HTMLButtonElement>('button');
  if (!buttons?.length) return;
  const first = buttons[0], last = buttons[buttons.length - 1];
  if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last.focus(); }
  else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first.focus(); }
}
onMounted(async () => { await nextTick(); dialog.value?.querySelector('button')?.focus(); });
onBeforeUnmount(() => { if (previousFocus?.isConnected) previousFocus.focus(); });
</script>

<template>
  <div class="modal-backdrop reward-backdrop" @click.self="emit('close')" @keydown="onKey">
    <section ref="dialog" class="dialog reward-dialog" role="dialog" aria-modal="true" aria-labelledby="reward-title" aria-describedby="reward-description">
      <header class="reward-heading"><div><span class="reward-eyebrow">{{ rewardLevel ? 'LEVEL UP' : 'HACK COMPLETE' }}</span><h2 id="reward-title">{{ rewardLevel ? `晋升 L${rewardLevel} · 升级礼包` : '入侵收获' }}</h2></div><button type="button" class="icon-button" :aria-label="rewardLevel ? '关闭升级礼包' : '关闭收获'" @click="emit('close')">×</button></header>
      <p id="reward-description">{{ rewardLevel ? '恭喜升级！礼包已自动放入背包' : `${portalName} · 物品已放入背包` }}</p>
      <ul class="reward-grid">
        <li v-for="item in rewards" :key="`${item.type}-${item.level}-${item.portalId}`" class="reward-item" :class="`reward-${item.type}`">
          <svg class="reward-icon" viewBox="0 0 48 48" aria-hidden="true" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round">
            <g v-if="item.type==='key'"><circle cx="17" cy="17" r="9"/><path d="m23 23 16 16m-7-7 5-5m-1 9 5-5"/></g>
            <g v-else-if="item.type==='resonator'"><path d="m24 5 10 17-10 21-10-21Z"/><path d="M14 22h20M24 5v38"/></g>
            <g v-else-if="item.type==='pulse'"><circle cx="24" cy="24" r="6"/><path d="M13 13a16 16 0 0 0 0 22m22-22a16 16 0 0 1 0 22M7 7a24 24 0 0 0 0 34M41 7a24 24 0 0 1 0 34"/></g>
            <g v-else-if="item.type==='cube'"><path d="m24 5 16 9v20l-16 9-16-9V14Zm-16 9 16 10 16-10M24 24v19"/></g>
            <path v-else-if="item.type==='shield'" d="m24 5 15 6v14c0 9-15 18-15 18S9 34 9 25V11Zm-7 18 5 5 10-11"/>
            <g v-else-if="item.type==='heatsink'"><path d="M12 9v30M20 9v30M28 9v30M36 9v30M7 17h34M7 31h34"/></g>
            <g v-else><rect x="8" y="8" width="32" height="32" rx="7"/><path d="M16 17v14m16-14v14M16 24h16M24 12v5m0 14v5"/></g>
          </svg>
          <div class="reward-item-name">{{ names[item.type] }}<small v-if="['resonator','pulse','cube'].includes(item.type)">L{{ item.level }}</small></div>
          <strong>×{{ item.quantity }}</strong>
        </li>
      </ul>
      <div v-if="!rewardLevel" class="reward-summary"><span>消耗 {{ cost }} XM</span><span v-if="ap">+{{ ap }} AP</span><span v-if="counterDamage" class="reward-counter">反击 −{{ counterDamage }} XM</span></div>
      <button type="button" class="primary-action" @click="emit('close')">继续探索</button>
    </section>
  </div>
</template>

<style scoped>
.reward-backdrop{background:#0e2b5366;backdrop-filter:blur(3px)}
.reward-dialog{width:min(420px,100%);max-height:calc(100dvh - 32px);overflow:auto;padding:24px}
.reward-heading{display:flex;align-items:center;justify-content:space-between;gap:12px}
.reward-heading h2{margin:4px 0 0;font-size:24px}.reward-heading .icon-button{align-self:flex-start}
.reward-eyebrow{font-size:10px;letter-spacing:.15em;color:#3874bd;font-weight:750}
.reward-dialog>p{font-size:13px;margin:10px 0 18px}
.reward-grid{list-style:none;margin:0 0 18px;padding:0;display:grid;grid-template-columns:repeat(3,minmax(0,1fr));gap:10px}
.reward-item{min-width:0;background:#f3f7fd;border:1px solid #e0eaf6;border-radius:12px;text-align:center;padding:13px 4px 11px;color:#2d67b2}
.reward-key{background:#fff9e9;border-color:#f0e4bb;color:#a37a26}
.reward-icon{display:block;width:38px;height:38px;margin:0 auto 9px}
.reward-item-name{font-size:12px;color:#315479;min-height:34px}.reward-item-name small{display:block;font-size:10px;color:#6b84a2;margin-top:2px}
.reward-item strong{display:block;font-size:16px;margin-top:3px}.reward-summary{display:flex;flex-wrap:wrap;gap:8px 16px;font-size:12px;color:#7187a0;margin-bottom:18px}
.reward-counter{color:#b44b5c}.reward-dialog>.primary-action{min-height:42px;font-size:14px}
@media(max-width:420px){.reward-dialog{padding:20px}.reward-grid{gap:8px}}
</style>
