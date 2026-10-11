<script setup lang="ts">
import { computed, ref } from 'vue';
import type { Item, Player } from '../../../shared/types';
import { inventoryCount, RULES } from '../../../shared/rules';

const props = defineProps<{ player: Player; busy: boolean }>();
const emit = defineEmits<{ action: [kind: string, payload: Record<string, unknown>] }>();
const filter = ref('all');
const displayName: Record<string, string> = { resonator: '共鸣脚', pulse: '脉冲器', cube: '糖块', key: '据点 Key', shield: '护盾', heatsink: '散热片', multihack: '多次 Hack' };
const grouped = computed(() => props.player.inventory.filter(i => i.quantity > 0 && (filter.value === 'all' || i.type === filter.value || (filter.value === 'mod' && ['shield','heatsink','multihack'].includes(i.type)))).sort((a,b) => a.type.localeCompare(b.type) || b.level - a.level));
const count = computed(() => inventoryCount(props.player.inventory));
function recycle(item: Item) {
  if (!confirm(`确认回收 ${displayName[item.type]} L${item.level} ×1？`)) return;
  emit('action', 'recycle', { type:item.type, level:item.level, portalId:item.portalId, quantity:1 });
}
function drop(item: Item) {
  if (!confirm(`确认将 ${displayName[item.type]} L${item.level} ×1 丢弃在当前位置？其他玩家可以拾取。`)) return;
  emit('action', 'drop', {type:item.type,level:item.level,portalId:item.portalId,quantity:1});
}
function recovery(item: Item) {
  if (item.type==='cube') return item.level * RULES.items.cubeRecoveryPerLevel;
  if (item.type==='key') return RULES.items.recycleKey;
  return ['shield','heatsink','multihack'].includes(item.type) ? RULES.items.recycleMod : item.level * RULES.items.recycleResonatorAndPulsePerLevel;
}
</script>

<template>
  <section class="content-page inventory-page">
    <div class="page-heading"><div><h1>背包</h1><p>所有物品由服务器保存。超出上限后，先使用或回收物品才能继续 Hack。</p></div><strong :class="{danger:count>=500}">{{ count }} / 500</strong></div>
    <div class="inventory-filters">
      <button v-for="entry in [['all','全部'],['resonator','脚'],['pulse','脉冲'],['cube','糖块'],['key','Key'],['mod','MOD'] ]" :key="entry[0]" type="button" :class="{active:filter===entry[0]}" @click="filter=entry[0]">{{ entry[1] }}</button>
    </div>
    <div v-if="!grouped.length" class="empty-state">该分类暂无物品。前往据点 Hack 获取资源。</div>
    <div v-for="item in grouped" :key="`${item.type}-${item.level}-${item.portalId}-${!!item.protected}`" class="item-row">
      <div class="item-symbol">{{ item.type === 'key' ? '⌑' : item.type === 'cube' ? '▧' : item.type === 'pulse' ? '✣' : '◈' }}</div>
      <div class="item-info"><b>{{ displayName[item.type] }} <span v-if="item.level">L{{ item.level }}</span></b><small v-if="item.portalId">{{ item.portalId }} · {{ item.protected ? '已保护' : '未保护' }}</small><small>回收恢复 {{ recovery(item) }} XM{{ item.type==='cube' ? ' · 与使用相同' : '' }}</small></div>
      <strong>×{{ item.quantity }}</strong>
      <button v-if="item.type==='cube'" type="button" :disabled="busy || !!player.movement" @click="emit('action','sugar',{level:item.level})">使用</button>
      <button v-if="item.type==='key'" type="button" :disabled="busy" @click="emit('action','protect-key',{portalId:item.portalId,protected:!item.protected})">{{ item.protected ? '取消保护' : '保护' }}</button>
      <button type="button" :disabled="busy || !!player.movement || !!item.protected" @click="drop(item)">丢弃</button>
      <button type="button" class="danger-button" :disabled="busy || !!player.movement || !!item.protected" @click="recycle(item)">回收</button>
    </div>
  </section>
</template>

<style scoped>
.item-row{flex-wrap:wrap;gap:10px}.item-info{min-width:120px}.item-info small{display:block}.item-row button{min-height:36px}
.inventory-filters{flex-wrap:wrap}.inventory-filters button,.page-heading>strong{white-space:nowrap;flex-shrink:0}
</style>
