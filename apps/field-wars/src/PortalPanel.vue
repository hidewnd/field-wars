<script setup lang="ts">
import { computed, ref } from 'vue';
import type { Item, Player, Portal, World } from '../../../shared/types';
import { RULES, inventoryCount, levelForAp, portalLevel, portalRange } from '../../../shared/rules';
import { GeometryError } from '../../../shared/geometry';
import { validateLinkTarget } from '../../../shared/linking';

const props = defineProps<{ portal: Portal; world: World; player: Player; now: number; busy: boolean }>();
const emit = defineEmits<{
  close: []; action: [kind: string, payload: Record<string, unknown>];
}>();
const tab = ref<'point'|'resources'|'links'>('point');
defineExpose({ openLinks: () => { tab.value = 'links'; } });
const level = ref(1);
const deployLevel = ref(0);
const slot = ref(0);
const amount = ref(1000);
const modType = ref<'shield'|'heatsink'|'multihack'>('shield');
const position = computed(() => {
  const move=props.player.movement;
  if (!move) return props.player;
  const progress=Math.min(1,Math.max(0,(props.now-move.startAt)/(move.arriveAt-move.startAt)));
  return {x:move.from.x+(move.to.x-move.from.x)*progress,y:move.from.y+(move.to.y-move.from.y)*progress};
});
const distanceCm = computed(() => Math.hypot(props.portal.x - position.value.x, props.portal.y - position.value.y));
const distance = computed(() => Math.ceil(distanceCm.value / 100));
const near = computed(() => distanceCm.value <= RULES.interactionRangeCm && !props.player.movement);
const own = computed(() => props.portal.faction === props.player.faction && !!props.player.faction);
const keys = computed(() => props.player.inventory.filter(i => i.type === 'key' && i.portalId === props.portal.id).reduce((count, item) => count + item.quantity, 0));
const keyItem = computed(() => props.player.inventory.find(i => i.type === 'key' && i.portalId === props.portal.id));
const maxLevel = computed(() => levelForAp(props.player.ap));
const portalLevelValue = computed(() => portalLevel(props.portal));
const range = computed(() => Math.round(portalRange(props.portal) / 100));
const filled = computed(() => props.portal.resonators.filter(Boolean).length);
const selectedResonator = computed(() => props.portal.resonators[slot.value]);
const slotItems = computed(() => {
  if ((!own.value && props.portal.faction) || !props.player.faction || (selectedResonator.value && filled.value !== 8)) return [];
  return props.player.inventory.filter(item => item.type === 'resonator' && item.quantity > 0 && item.level <= maxLevel.value
    && item.level > (selectedResonator.value?.level ?? 0)
    && props.portal.resonators.filter(r => r?.owner === props.player.id && r.level === item.level).length < RULES.resonators.quotaPerPlayerPerPortal[item.level])
    .sort((a,b) => b.level - a.level);
});
const modFilled = computed(() => props.portal.mods.filter(Boolean).length);
const ownItems = computed(() => props.player.inventory.filter(i => i.quantity > 0 && (i.type !== 'key' || i.portalId === props.portal.id)));
const modNames = { shield: '护盾', heatsink: '散热片', multihack: '多次 Hack' };
const hackWait = computed(() => Math.max(0, Math.ceil(((props.player.hacks[props.portal.id]?.readyAt ?? 0) - props.now) / 1000)));
const attackWait = computed(() => Math.max(0, Math.ceil(((props.player.cooldowns.attack ?? 0) - props.now) / 1000)));
const rechargeWait = computed(() => Math.max(0, Math.ceil(((props.player.cooldowns.recharge ?? 0) - props.now) / 1000)));
const linkTargets = computed(() => {
  const origin = props.portal;
  if (!origin) return [];
  const targets = [];
  for (const target of Object.values(props.world.portals)) {
    try { validateLinkTarget(props.world, props.player, origin.id, target.id); }
    catch (error) { if (error instanceof GeometryError) continue; throw error; }
    targets.push({portal: target, distance: Math.ceil(Math.hypot(target.x-origin.x,target.y-origin.y)/100),
      keys: props.player.inventory.filter(item=>item.type==='key' && item.portalId===target.id).reduce((sum,item)=>sum+item.quantity,0)});
  }
  return targets.sort((a,b)=>a.distance-b.distance || a.portal.id.localeCompare(b.portal.id));
});
const linkBlocked = computed(() => {
  const origin=props.portal;
  if (props.player.movement) return '移动中，请停止移动后连线';
  if (!origin || Math.hypot(origin.x-props.player.x,origin.y-props.player.y)>RULES.interactionRangeCm) return `请前往当前据点${RULES.interactionRangeCm / 100}米内连线`;
  if (props.player.xm<RULES.linkXmCost) return `连线需要 ${RULES.linkXmCost} XM`;
  const seconds=Math.ceil(((props.player.cooldowns.link ?? 0)-props.now)/1000);
  return seconds>0 ? `连线冷却 ${seconds} 秒` : '';
});
function energyPercent(level:number,energy:number) { return Math.round(energy/(RULES.resonators.energy[level] ?? 1000)*100); }
function itemName(item: Item) { return item.type === 'key' ? '本点 Key' : ({ resonator: '脚', pulse: '脉冲', cube: '糖块', shield: '护盾', heatsink: '散热片', multihack: '多次 Hack' } as Record<string,string>)[item.type] ?? item.type; }
function act(kind: string, payload: Record<string, unknown> = {}) { emit('action', kind, payload); }
</script>

<template>
  <aside class="detail-panel" aria-label="据点详情">
    <header class="detail-head">
      <div><h2>{{ portal.name }}</h2><p><span class="faction-indicator" :class="portal.faction ?? 'neutral'">{{ portal.faction === 'red' ? '●' : portal.faction === 'green' ? '◆' : portal.faction === 'blue' ? '▲' : '○' }}</span>{{ portal.faction === 'red' ? '红方' : portal.faction === 'green' ? '绿方' : portal.faction === 'blue' ? '蓝方' : '中立' }} · L{{ portalLevelValue }} · {{ distance }} 米</p></div>
      <button type="button" class="icon-button" aria-label="关闭详情" @click="emit('close')">×</button>
    </header>
    <div class="distance-line">{{ portal.districtId }} <span>{{ player.movement ? '移动中，请先停止' : near ? '可交互' : '距交互范围较远' }}</span></div>
    <nav class="tabs" aria-label="据点信息">
      <button type="button" :class="{active:tab==='point'}" @click="tab='point'">据点</button>
      <button type="button" :class="{active:tab==='resources'}" @click="tab='resources'">资源</button>
      <button type="button" :class="{active:tab==='links'}" @click="tab='links'">连线</button>
    </nav>
    <div class="detail-scroll">
      <template v-if="tab === 'point'">
        <section class="panel-section resonator-section compact-section">
          <div class="section-title"><h3>八脚 <small>{{ filled }} / 8</small></h3><span>射程 {{ range }} 米</span></div>
          <div class="resonator-grid">
            <button v-for="(resonator, index) in portal.resonators" :key="index" type="button" class="resonator" :class="{filled:!!resonator,active:slot===index}" :aria-label="resonator ? `第${index+1}槽 L${resonator.level}，能量${resonator.energy}，选择此脚` : `选择第${index+1}空槽`" :aria-pressed="slot===index" :title="resonator ? `第${index+1}槽 · L${resonator.level} · ${resonator.energy} 能量` : `空槽 ${index+1}`" @click="slot=index">
              <span>{{ resonator ? `L${resonator.level}` : '+' }}</span><small v-if="resonator">{{ energyPercent(resonator.level,resonator.energy) }}%</small>
            </button>
          </div>
          <p class="selected-slot">已选第 {{ slot + 1 }} 槽 · {{ portal.resonators[slot] ? `L${portal.resonators[slot]?.level}，${portal.resonators[slot]?.energy} 能量` : '空槽' }}</p>
          <p v-if="selectedResonator" class="selected-slot">部署人：{{ selectedResonator.ownerName ?? (selectedResonator.owner === player.id ? player.name : '未知玩家') }}</p>
          <div class="slot-equipment" aria-label="选中槽位可用装备">
            <h4>{{ selectedResonator ? '可升级的脚' : '可部署的脚' }}</h4>
            <button v-for="item in slotItems" :key="item.level" type="button" :disabled="busy || !near || player.xm < item.level * RULES.resonators.xmCostPerLevel" @click="act(selectedResonator ? 'upgrade' : 'deploy',{level:item.level,slot})">{{ selectedResonator ? '升级至' : '部署' }} L{{ item.level }} <small>×{{ item.quantity }} · {{ item.level * RULES.resonators.xmCostPerLevel }} XM</small></button>
            <p v-if="!slotItems.length" class="muted">{{ selectedResonator && own && filled !== 8 ? '填满友方据点八个槽位后可升级' : '背包中暂无符合等级与配额的脚' }}</p>
          </div>
        </section>
        <section class="panel-section actions-section compact-section">
          <div class="section-title"><h3>快捷行动</h3><span v-if="keys">本点 Key {{ keys }} 把</span></div>
          <button v-if="!near" type="button" class="primary-action go-button" :disabled="busy" @click="act('move',{x:portal.x,y:portal.y})">前往据点</button>
          <div class="quick-actions">
            <button type="button" :disabled="busy || !near || hackWait>0 || inventoryCount(player.inventory)>=500" @click="act('hack')">Hack <small>{{ hackWait ? `${hackWait} 秒后可用` : '获取资源' }}</small></button>
            <button type="button" :disabled="busy || !near || filled===8 || (!!portal.faction && !own)" @click="act('deploy-all',deployLevel ? {level:deployLevel} : {})">批量部署 <small>{{ deployLevel ? `固定 L${deployLevel} 脚` : '按背包等级从高到低' }}</small></button>
            <button type="button" :disabled="busy || !own || rechargeWait>0 || !filled || (!near && !keys)" @click="act('recharge',{amount})">全部充能 <small>{{ rechargeWait ? `${rechargeWait} 秒后可用` : '恢复脚能量' }}</small></button>
            <button type="button" :disabled="busy" @click="tab='links'">连线 <small>查看可连据点</small></button>
          </div>
          <div class="level-picker"><label for="deploy-level">批量部署等级</label><select id="deploy-level" v-model.number="deployLevel"><option :value="0">自动 · 从高到低</option><option v-for="n in maxLevel" :key="n" :value="n">固定 L{{ n }}</option></select></div>
          <div class="level-picker"><label for="item-level">攻击器等级</label><select id="item-level" v-model.number="level"><option v-for="n in maxLevel" :key="n" :value="n">L{{ n }}</option></select></div>
          <button type="button" class="soft-action attack-button" :disabled="busy || !!player.movement || attackWait>0" @click="act('attack',{level})">{{ attackWait ? `脉冲攻击 · ${attackWait} 秒后可用` : `脉冲攻击 · L${level}` }}</button>
          <details class="advanced-actions"><summary>单槽操作与阵营协作</summary><div class="two-actions secondary-actions">
            <button type="button" :disabled="busy || !player.faction" @click="act('marker',{portalId:portal.id})">标记据点</button>
          </div></details>
        </section>
      </template>
      <template v-else-if="tab === 'resources'">
        <section class="panel-section"><h3>充能</h3><p class="muted">远程充能需持有本点 Key；本地充能无需 Key。</p><div class="inline-controls"><label>投入 XM <input v-model.number="amount" type="number" min="1" max="1000" step="100" /></label><button type="button" :disabled="busy || !own || rechargeWait>0 || !portal.resonators[slot] || (!near && !keys)" @click="act('recharge',{slot,amount})">{{ rechargeWait ? `冷却 ${rechargeWait} 秒` : '充能选中脚' }}</button></div><button type="button" class="soft-action" :disabled="busy || !own || rechargeWait>0 || !filled || (!near && !keys)" @click="act('recharge',{amount})">全部充能</button></section>
        <section class="panel-section"><h3>MOD（{{ modFilled }} / 4）</h3><div class="mod-list"><div v-for="(mod,index) in portal.mods" :key="index">{{ index+1 }}. {{ mod ? modNames[mod.type] : '空槽' }}</div></div><div class="inline-controls"><select v-model="modType" aria-label="选择 MOD 类型"><option value="shield">护盾</option><option value="heatsink">散热片</option><option value="multihack">多次 Hack</option></select><button type="button" :disabled="busy || !near || !own || modFilled>=4" @click="act('mod',{type:modType})">安装 MOD</button></div></section>
        <section class="panel-section"><h3>相关背包</h3><div v-if="!ownItems.length" class="empty-state">没有本点 Key 或可用装备</div><div v-for="item in ownItems" :key="`${item.type}-${item.level}-${item.portalId}-${!!item.protected}`" class="inventory-row"><span>{{ itemName(item) }} <small v-if="item.level">L{{ item.level }}</small><small v-if="item.protected"> · 已保护</small></span><b>×{{ item.quantity }}</b></div><div v-if="keyItem" class="inline-controls"><span>保护本点 Key</span><button type="button" :disabled="busy" @click="act('protect-key',{portalId:portal.id,protected:!keyItem.protected})">{{ keyItem.protected ? '取消保护' : '保护' }}</button></div></section>
      </template>
      <template v-else>
        <section class="panel-section link-targets" aria-label="可连线据点">
          <div class="section-title"><h3>可连线据点</h3><span>{{ linkTargets.length }} 个</span></div>
          <p class="muted">射程 {{ range }} 米 · 每次消耗 {{ RULES.linkXmCost }} XM</p>
          <p v-if="linkBlocked" class="muted" role="status">{{ linkBlocked }}</p>
          <div v-if="!linkTargets.length" class="empty-state">暂无可连线据点。需持有目标 Key，两端为八脚齐全的友方据点，且射程内无阻挡。</div>
          <button v-for="target in linkTargets" :key="target.portal.id" type="button" class="link-target" :disabled="busy || !!linkBlocked" :aria-label="`连线至 ${target.portal.name}`" @click="act('link',{originId:portal.id,destinationId:target.portal.id})">
            <span><strong>{{ target.portal.name }}</strong><small>{{ target.distance }} 米 · Key {{ target.keys }} 把</small></span><span class="target-action">连线 →</span>
          </button>
          <p class="muted link-rule">任一端缺少一只脚，关联连线与领域立即消失。</p>
        </section>
      </template>
    </div>
  </aside>
</template>

<style scoped>
.link-target{display:flex;align-items:center;justify-content:space-between;gap:12px;width:100%;padding:13px 12px;margin:9px 0;border:1px solid #dce7f6;border-radius:10px;background:#f5f8fe;text-align:left;color:#245b9d}
.link-target strong{display:block;font-size:14px}.link-target small{display:block;margin-top:5px;font-size:12px;color:#728aab}.target-action{flex-shrink:0;font-size:13px;font-weight:700}.link-rule{font-size:12px;margin-top:16px}
.detail-panel {padding-top: 18px;}
.detail-head h2 {margin-bottom: 6px; overflow-wrap: anywhere;}
.distance-line {display: flex; justify-content: space-between; gap: 8px; padding: 8px 0 11px; text-align: left;}
.tabs button {flex: 1; padding: 11px 8px;}
.compact-section {padding: 15px 0;}
.section-title h3 {margin-bottom: 10px;}
.section-title h3 small {margin-left: 4px; color: #7189a8; font-size: 12px; font-weight: 500;}
.resonator-grid {gap: 8px; padding: 0;}
.resonator {width: 42px; height: 42px; font-size: 19px;}
.resonator.filled {font-size: 13px;}
.selected-slot {margin: 9px 0 0; color: #597492; font-size: 12px;}
.slot-equipment{margin-top:12px;display:flex;flex-wrap:wrap;gap:6px}.slot-equipment h4{width:100%;margin:0 0 2px;font-size:12px;color:#597492}.slot-equipment button{border:1px solid #bfd1e9;border-radius:7px;padding:7px 9px;background:#f6faff;color:#164f9e;font-size:12px}.slot-equipment small{display:block;margin-top:3px;color:#6984a5}.slot-equipment p{font-size:12px;margin:0}
.go-button {min-height: 40px; margin-bottom: 8px; font-size: 14px;}
.quick-actions {display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); gap: 8px;}
.quick-actions button {min-width: 0; min-height: 56px; border: 1px solid #bfd1e9; border-radius: 8px; background: #f6faff; color: #164f9e; font-weight: 700;}
.quick-actions button:first-child {background: #edf5ff; border-color: #9fc2f3;}
.quick-actions button small {display: block; margin-top: 3px; color: #6984a5; font-size: 11px; font-weight: 400;}
.level-picker {margin-top: 10px;}
.attack-button {min-height: 40px; margin-top: 9px;}
.advanced-actions {margin-top: 11px; border-top: 1px solid #e5edf7; padding-top: 10px;}
.advanced-actions summary {cursor: pointer; color: #4b6d96; font-size: 12px;}
.advanced-actions .two-actions {margin-top: 10px;}
.link-meta {margin: 0 0 14px; color: #315b8c; font-size: 13px;}
.text-action {display: block; width: 100%; margin-top: 10px; padding: 9px; border: 0; background: transparent; color: #2866b9; font-size: 13px;}
@media (max-width: 700px) {
  .detail-panel {padding-top: 13px;}
  .compact-section {padding: 12px 0;}
  .resonator {width: 39px; height: 39px;}
  .quick-actions button {min-height: 50px;}
}
</style>
