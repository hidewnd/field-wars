<script setup lang="ts">
import { computed, ref } from 'vue';
import type { Item, Player, World } from '../../../shared/types';
import { inventoryCount, RULES } from '../../../shared/rules';
import { appPath } from './paths';

const props = defineProps<{ player: Player; portals: World['portals']; busy: boolean }>();
const emit = defineEmits<{ action: [kind: string, payload: Record<string, unknown>]; select: [portalId: string] }>();
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
      <img class="item-symbol" :src="appPath(`/items/${item.type}-v1.png`)" width="56" height="56" alt="" aria-hidden="true" />
      <div class="item-info"><button v-if="item.type==='key' && item.portalId && portals[item.portalId]" type="button" class="key-name" :aria-label="`定位据点 ${portals[item.portalId].name}`" @click="emit('select',item.portalId)">{{ portals[item.portalId].name }}</button><b v-else-if="item.type==='key'">{{ item.portalId ?? '未知据点' }}</b><b v-else>{{ displayName[item.type] }} <span v-if="item.level">L{{ item.level }}</span></b><small v-if="item.type==='key'">据点 Key · {{ item.protected ? '已保护' : '未保护' }} · 点击名称定位</small><small>回收恢复 {{ recovery(item) }} XM{{ item.type==='cube' ? ' · 与使用相同' : '' }}</small></div>
      <strong>×{{ item.quantity }}</strong>
      <div class="item-actions">
      <button v-if="item.type==='cube'" type="button" :disabled="busy || !!player.movement" @click="emit('action','sugar',{level:item.level})">使用</button>
      <button v-if="item.type==='key'" type="button" :disabled="busy" @click="emit('action','protect-key',{portalId:item.portalId,protected:!item.protected})">{{ item.protected ? '取消保护' : '保护' }}</button>
      <button type="button" :disabled="busy || !!player.movement || !!item.protected" @click="drop(item)">丢弃</button>
      <button type="button" class="danger-button" :disabled="busy || !!player.movement || !!item.protected" @click="recycle(item)">回收</button>
      </div>
    </div>
  </section>
</template>

<style scoped>
.item-row{flex-wrap:wrap;gap:10px}.item-symbol{display:block;width:56px;height:56px;flex:0 0 56px;object-fit:contain}.item-info{min-width:160px;overflow-wrap:anywhere}.item-info small{display:block}.item-row button{min-height:36px}
.item-info .key-name{display:block;max-width:100%;padding:0;border:0;background:none;color:#2366b7;font:inherit;font-weight:700;text-align:left;white-space:normal;overflow-wrap:anywhere;text-decoration:underline;text-underline-offset:3px}.key-name:hover{color:#154886}
.inventory-filters{flex-wrap:wrap}.inventory-filters button,.page-heading>strong{white-space:nowrap;flex-shrink:0}
.item-actions{display:flex;gap:10px;flex-wrap:wrap}.item-actions>button{border:1px solid #bad1ee;background:#f8fbff;color:#2366b7;border-radius:6px;padding:8px}
@media(max-width:600px){.item-row{display:grid;grid-template-columns:56px minmax(0,1fr) auto}.item-info{min-width:0}.item-actions{grid-column:1/-1}}
</style>
