<script setup lang="ts">
import { computed, nextTick, onBeforeUnmount, onMounted, ref, watch } from 'vue';
import type { Field, MapData, Player, Portal, World } from '../../../shared/types';
import { RULES, levelForAp } from '../../../shared/rules';

const props = defineProps<{ map: MapData; world: World; player: Player; now: number; selectedId: string | null; applicationMode: boolean }>();
const emit = defineEmits<{ select: [id: string]; point: [x: number, y: number]; apply: [x: number, y: number]; field: [ids: string[]]; quick: [kind: string, payload: Record<string, unknown>, portalId: string | null] }>();
const svg = ref<SVGSVGElement | null>(null);
const menuElement = ref<HTMLElement | null>(null);
const menu = ref<{ x: number; y: number; worldX: number; worldY: number; portalId: string | null } | null>(null);
const viewport = ref({ width: 900, height: 720 });
const center = ref({ x: props.player.x, y: props.player.y });
const span = ref(window.matchMedia('(max-width: 700px)').matches ? 60000 : 90000);
const dragging = ref(false);
const hoveredId = ref<string | null>(null);
const focusedId = ref<string | null>(null);
let start: { x: number; y: number; cx: number; cy: number; pointerId: number } | null = null;
let moved = false;
let pointerPortalId: string | null = null;
let pointerFieldId: string | null = null;
let longPress: number | undefined;
let resize: ResizeObserver | null = null;

const ratio = computed(() => viewport.value.height / viewport.value.width);
const frame = computed(() => {
  const width=span.value, height=span.value*ratio.value;
  const drawerOffset = viewport.value.width <= 700 && props.selectedId ? Math.min(viewport.value.height * .62, 610) * width / viewport.value.width / 2 : 0;
  return {
    x: width >= props.map.width ? (props.map.width-width)/2 : Math.max(0,Math.min(props.map.width-width,center.value.x-width/2)),
    y: height >= props.map.height ? (props.map.height-height)/2 : Math.max(0,Math.min(props.map.height-height,center.value.y+drawerOffset-height/2)),
    width,height,
  };
});
const viewBox = computed(() => `${frame.value.x} ${frame.value.y} ${frame.value.width} ${frame.value.height}`);
const backgroundStyle = computed(() => ({
  left: `${-frame.value.x / span.value * viewport.value.width}px`,
  top: `${-frame.value.y / span.value * viewport.value.width}px`,
  width: `${props.map.width / span.value * viewport.value.width}px`,
  height: `${props.map.height / span.value * viewport.value.width}px`,
}));
const markerSize = computed(() => span.value / viewport.value.width * 8);
const grouped = computed(() => span.value > 680000);
const visiblePortals = computed(() => Object.values(props.world.portals).filter(p => p.x >= frame.value.x - 30000 && p.x <= frame.value.x + frame.value.width + 30000 && p.y >= frame.value.y - 30000 && p.y <= frame.value.y + frame.value.height + 30000));
const showResonators = computed(() => !grouped.value);
const portalVisuals = computed(() => visiblePortals.value.map(portal => {
  const feet: { slot: number; level: number; energy: number; x: number; y: number }[] = [];
  if (showResonators.value) portal.resonators.forEach((resonator, slot) => {
    if (!resonator) return;
    const dx = resonator.x - portal.x, dy = resonator.y - portal.y;
    const actual = Math.hypot(dx, dy);
    // 默认沿权威坐标的方位与距离显示；缩小时设最小半径，真实距离仍决定半径先后。
    let angle = actual ? Math.atan2(dy, dx) : slot * Math.PI / 4;
    let radius = Math.max(actual, markerSize.value * 3) + actual * .15;
    let x = Math.cos(angle) * radius, y = Math.sin(angle) * radius;
    const overlaps = () => feet.some(foot => Math.hypot(foot.x - x, foot.y - y) < markerSize.value * 2.15);
    if (overlaps()) {
      // 权威坐标重合或像素级近重合时，才按固定槽位展开，确保八脚逐只可辨。
      angle = slot * Math.PI / 4;
      x = Math.cos(angle) * radius; y = Math.sin(angle) * radius;
      while (overlaps()) { radius += markerSize.value * 2.2; x = Math.cos(angle) * radius; y = Math.sin(angle) * radius; }
    }
    feet.push({ slot, level: resonator.level, energy: resonator.energy, x, y });
  });
  const nameY = feet.length ? Math.min(...feet.map(foot => foot.y)) - markerSize.value * 2 : -markerSize.value * 2;
  return { portal, feet, nameY };
}));
const clusters = computed(() => props.map.districts.map(d => {
  const points = Object.values(props.world.portals).filter(p => p.districtId === d.id);
  return { district: d, count: points.length, x: points.reduce((n, p) => n + p.x, 0) / points.length, y: points.reduce((n, p) => n + p.y, 0) / points.length };
}));
const selected = computed(() => props.selectedId ? props.world.portals[props.selectedId] : null);
const playerPosition = computed(() => {
  const m = props.player.movement;
  if (!m) return { x: props.player.x, y: props.player.y };
  const progress = Math.min(1, Math.max(0, (props.now - m.startAt) / (m.arriveAt - m.startAt)));
  return { x: Math.round(m.from.x + (m.to.x - m.from.x) * progress), y: Math.round(m.from.y + (m.to.y - m.from.y) * progress) };
});
const factionColor: Record<string, string> = { red: '#d55462', green: '#158966', blue: '#2c6ce8' };
function color(portal: Portal) { return portal.faction ? factionColor[portal.faction] : '#68788e'; }
function fieldPoints(field: Field) { return field.vertices.map(id => { const p = props.world.portals[id]; return `${p?.x ?? 0},${p?.y ?? 0}`; }).join(' '); }
function closeMenu() { menu.value = null; }
function jump(x: number, y: number) { closeMenu(); center.value = { x, y }; span.value = Math.min(span.value, 380000); }
function zoom(factor: number) { closeMenu(); span.value = Math.max(28000, Math.min(2200000, span.value * factor)); }
function locate() { jump(playerPosition.value.x, playerPosition.value.y); }
function toPoint(event: PointerEvent | MouseEvent) {
  const rect = svg.value!.getBoundingClientRect();
  return { x: Math.round(frame.value.x + (event.clientX - rect.left) / rect.width * frame.value.width), y: Math.round(frame.value.y + (event.clientY - rect.top) / rect.height * frame.value.height) };
}
function hitPortal(clientX: number, clientY: number, target?: EventTarget | null) {
  if (grouped.value || !svg.value) return null;
  const rect = svg.value.getBoundingClientRect();
  const scale = rect.width / frame.value.width;
  const worldX = frame.value.x + (clientX - rect.left) / scale;
  const worldY = frame.value.y + (clientY - rect.top) / scale;
  let nearest: string | null = null;
  let best = 24;
  for (const { portal, feet } of portalVisuals.value) {
    const centerDistance = Math.hypot(portal.x - worldX, portal.y - worldY) * scale;
    if (centerDistance <= best) { best = centerDistance; nearest = portal.id; }
    for (const foot of feet) {
      const endX = portal.x + foot.x, endY = portal.y + foot.y;
      const footDistance = Math.hypot(endX - worldX, endY - worldY) * scale;
      const lineX = endX - portal.x, lineY = endY - portal.y;
      const t = Math.max(0, Math.min(1, ((worldX - portal.x) * lineX + (worldY - portal.y) * lineY) / (lineX * lineX + lineY * lineY)));
      const rodDistance = Math.hypot(portal.x + t * lineX - worldX, portal.y + t * lineY - worldY) * scale;
      const distance = Math.min(footDistance, rodDistance);
      if (distance <= best) { best = distance; nearest = portal.id; }
    }
  }
  // 标签可超出圆形命中区；其 DOM 归属仍指向同一个真实 PO。
  if (!nearest && target instanceof Element) return target.closest('[data-portal-id]')?.getAttribute('data-portal-id') ?? null;
  return nearest;
}
async function openMenu(clientX: number, clientY: number, target?: EventTarget | null) {
  if (!svg.value) return;
  const point = toPoint({ clientX, clientY } as MouseEvent);
  menu.value = { x: clientX, y: clientY, worldX: point.x, worldY: point.y, portalId: hitPortal(clientX, clientY, target) };
  await nextTick();
  if (!menu.value || !menuElement.value) return;
  menu.value = { ...menu.value, x: Math.max(8, Math.min(menu.value.x, window.innerWidth - menuElement.value.offsetWidth - 8)), y: Math.max(8, Math.min(menu.value.y, window.innerHeight - menuElement.value.offsetHeight - 8)) };
  menuElement.value.querySelector<HTMLButtonElement>('button')?.focus();
}
function menuAction(kind: string) {
  const current = menu.value;
  if (!current) return;
  closeMenu();
  if (kind === 'apply') emit('apply', current.worldX, current.worldY);
  else if (kind === 'point') emit('point', current.worldX, current.worldY);
  else if (kind === 'select' && current.portalId) emit('select', current.portalId);
  else if (kind === 'attack') {
    const level = Math.max(1, ...props.player.inventory.filter(item => item.type === 'pulse' && item.quantity > 0 && item.level <= levelForAp(props.player.ap)).map(item => item.level));
    emit('quick', 'attack', { level }, null);
  } else emit('quick', kind, {}, current.portalId);
}
function onPointerDown(event: PointerEvent) {
  if (event.button !== 0) return;
  closeMenu();
  pointerPortalId = (event.target as Element).closest('[data-portal-id]')?.getAttribute('data-portal-id') ?? null;
  pointerFieldId = (event.target as Element).closest('[data-field-id]')?.getAttribute('data-field-id') ?? null;
  svg.value?.setPointerCapture(event.pointerId);
  start = { x: event.clientX, y: event.clientY, cx: center.value.x, cy: center.value.y, pointerId: event.pointerId };
  moved = false;
  if (event.pointerType === 'touch') {
    longPress = window.setTimeout(() => {
      if (!moved && start) { start = null; void openMenu(event.clientX, event.clientY, event.target); }
    }, 600);
  }
}
function onPointerMove(event: PointerEvent) {
  if (!start) return;
  const dx = event.clientX - start.x; const dy = event.clientY - start.y;
  if (Math.hypot(dx, dy) > 8) { moved = true; window.clearTimeout(longPress); dragging.value = true; closeMenu(); }
  if (moved) center.value = { x: start.cx - dx * span.value / viewport.value.width, y: start.cy - dy * span.value / viewport.value.width };
}
function onPointerUp(event: PointerEvent) {
  window.clearTimeout(longPress);
  if (start?.pointerId !== event.pointerId) return;
  const portalId = start && !moved ? hitPortal(event.clientX, event.clientY, event.target) ?? hitPortal(start.x, start.y) ?? pointerPortalId : null;
  if (portalId) emit('select', portalId);
  else if (start && !moved && pointerFieldId) {
    const point=toPoint(event);
    const ids=props.world.fields.filter(field=>{
      const vertices=field.vertices.map(id=>props.world.portals[id]);
      if (vertices.some(v=>!v)) return false;
      const [a,b,c]=vertices;
      const sign=(p:Portal,q:Portal)=> (point.x-q.x)*(p.y-q.y)-(p.x-q.x)*(point.y-q.y);
      const s1=sign(a,b),s2=sign(b,c),s3=sign(c,a);
      return !(s1<0||s2<0||s3<0)||!(s1>0||s2>0||s3>0);
    }).map(field=>field.id);
    emit('field',ids.length?ids:[pointerFieldId]);
  }
  else if (start && !moved) {
    const p = toPoint(event);
    if (props.applicationMode) emit('apply', p.x, p.y); else emit('point', p.x, p.y);
  }
  start = null; dragging.value = false;
  pointerPortalId = null;
  pointerFieldId = null;
}
function onPointerCancel() { window.clearTimeout(longPress); start = null; moved = false; dragging.value = false; pointerPortalId = null; pointerFieldId = null; }
function onWheel(event: WheelEvent) { event.preventDefault(); zoom(event.deltaY > 0 ? 1.2 : 1 / 1.2); }
function onContext(event: MouseEvent) { event.preventDefault(); onPointerCancel(); void openMenu(event.clientX, event.clientY, event.target); }
function onKey(event: KeyboardEvent) { if (event.key === 'Escape') closeMenu(); }
function onOutside(event: PointerEvent) { if (menu.value && !menuElement.value?.contains(event.target as Node) && !svg.value?.contains(event.target as Node)) closeMenu(); }
function focusPortal(id: string) { const portal = props.world.portals[id]; if (portal) jump(portal.x, portal.y); }
watch(() => props.selectedId, id => { if (id) focusPortal(id); });
onMounted(() => { resize = new ResizeObserver(entries => { const r = entries[0]?.contentRect; if (r) viewport.value = { width: Math.max(1, r.width), height: Math.max(1, r.height) }; }); if (svg.value) resize.observe(svg.value); window.addEventListener('keydown', onKey); document.addEventListener('pointerdown', onOutside); });
onBeforeUnmount(() => { resize?.disconnect(); window.clearTimeout(longPress); window.removeEventListener('keydown', onKey); document.removeEventListener('pointerdown', onOutside); });
defineExpose({ locate, zoom, focusPortal });
</script>

<template>
  <div class="map-wrap">
    <img class="map-background" src="/city-background.svg" alt="" :style="backgroundStyle" />
    <svg ref="svg" class="world-map" :viewBox="viewBox" role="img" aria-label="场域战争地图，拖动平移、滚轮缩放、点击据点查看；右键或长按打开快捷操作" @pointerdown="onPointerDown" @pointermove="onPointerMove" @pointerup="onPointerUp" @pointercancel="onPointerCancel" @wheel="onWheel" @contextmenu="onContext">
      <g class="field-layer">
        <polygon v-for="field in world.fields" :key="field.id" :data-field-id="field.id" :points="fieldPoints(field)" :fill="factionColor[field.faction]" fill-opacity=".16" :stroke="factionColor[field.faction]" :stroke-width="markerSize * .35" stroke-opacity=".55" />
      </g>
      <g class="link-layer">
        <line v-for="link in world.links" :key="link.id" :x1="world.portals[link.origin]?.x" :y1="world.portals[link.origin]?.y" :x2="world.portals[link.destination]?.x" :y2="world.portals[link.destination]?.y" :stroke="factionColor[link.faction]" :stroke-width="markerSize * .38" stroke-opacity=".7" />
      </g>
      <g v-if="grouped">
        <g v-for="cluster in clusters" :key="cluster.district.id" class="cluster" :transform="`translate(${cluster.x} ${cluster.y})`" tabindex="0" role="button" :aria-label="`${cluster.district.name}，${cluster.count}个据点，点击放大`" @pointerdown.stop="jump(cluster.x, cluster.y)" @keydown.enter="jump(cluster.x, cluster.y)">
          <circle :r="markerSize * 3" fill="#fff" stroke="#9fb7d6" :stroke-width="markerSize * .35" />
          <text text-anchor="middle" dominant-baseline="middle" :font-size="markerSize * 2.1" fill="#173461" font-weight="700">{{ cluster.count }}</text>
        </g>
      </g>
      <g v-else>
        <g v-for="visual in portalVisuals" :key="visual.portal.id" class="portal-marker" :data-portal-id="visual.portal.id" :transform="`translate(${visual.portal.x} ${visual.portal.y})`" tabindex="0" role="button" :aria-label="`${visual.portal.name}，${visual.portal.faction ?? '中立'}，${visual.feet.length}只脚`" @pointerenter="hoveredId = visual.portal.id" @pointerleave="hoveredId = null" @focus="focusedId = visual.portal.id" @blur="focusedId = null" @keydown.enter="emit('select', visual.portal.id)" @keydown.space.prevent="emit('select', visual.portal.id)" @keydown.shift.f10.prevent="openMenu(svg!.getBoundingClientRect().left + (visual.portal.x - frame.x) / frame.width * viewport.width, svg!.getBoundingClientRect().top + (visual.portal.y - frame.y) / frame.height * viewport.height)">
          <g v-for="foot in visual.feet" :key="foot.slot" :data-resonator-slot="foot.slot" :aria-label="`第${foot.slot + 1}脚，L${foot.level}，能量${foot.energy}`">
            <line :x1="0" :y1="0" :x2="foot.x" :y2="foot.y" :stroke="color(visual.portal)" :stroke-width="markerSize * .35" stroke-opacity=".65" />
            <circle :cx="foot.x" :cy="foot.y" :r="markerSize * 1.05" fill="white" :stroke="color(visual.portal)" :stroke-width="markerSize * .3" />
            <circle :cx="foot.x" :cy="foot.y" :r="markerSize * .82" :fill="color(visual.portal)" :fill-opacity="Math.max(.2, foot.energy / (RULES.resonators.energy[foot.level] || 1))" />
            <text :x="foot.x" :y="foot.y + markerSize * .38" text-anchor="middle" :font-size="markerSize * 1.2" font-weight="800" fill="white" stroke="#173966" :stroke-width="markerSize * .14" paint-order="stroke">{{ foot.level }}</text>
          </g>
          <circle :r="markerSize * 1.55" fill="white" :stroke="color(visual.portal)" :stroke-width="markerSize * .65" />
          <circle :r="markerSize * .7" :fill="color(visual.portal)" />
          <circle v-if="visual.portal.id === selectedId" :r="markerSize * 1.12" fill="none" stroke="#286ee5" :stroke-width="markerSize * .22" opacity=".9" />
          <text v-if="viewport.width > 700 && (!visual.feet.length || visual.portal.id === selectedId || visual.portal.id === hoveredId || visual.portal.id === focusedId)" :y="visual.nameY" text-anchor="middle" :font-size="markerSize * 1.8" font-weight="700" fill="#16335a" paint-order="stroke" stroke="white" :stroke-width="markerSize * .5">{{ visual.portal.name }}</text>
        </g>
      </g>
      <g v-if="player.movement" pointer-events="none">
        <line :x1="player.movement.from.x" :y1="player.movement.from.y" :x2="player.movement.to.x" :y2="player.movement.to.y" stroke="#2468dc" :stroke-width="markerSize * .3" stroke-dasharray="12 9" />
      </g>
      <g :transform="`translate(${playerPosition.x} ${playerPosition.y})`" pointer-events="none">
        <circle :r="markerSize * 2.8" fill="#2c6ce8" fill-opacity=".15" />
        <circle :r="markerSize * 1.1" fill="#1f66dc" stroke="white" :stroke-width="markerSize * .5" />
      </g>
      <circle v-if="selected" :cx="selected.x" :cy="selected.y" :r="4000" fill="none" stroke="#286ee5" :stroke-width="markerSize * .28" stroke-dasharray="10 8" pointer-events="none" />
    </svg>
    <div class="map-north" aria-hidden="true">N<br /><span>▲</span></div>
    <div class="map-tools">
      <button type="button" aria-label="放大地图" @click="zoom(1 / 1.35)">+</button>
      <button type="button" aria-label="缩小地图" @click="zoom(1.35)">−</button>
      <button type="button" class="locate-btn" @click="locate">定位</button>
    </div>
    <div class="map-caption">城市网格 · {{ map.version }}　缩放 {{ Math.round(map.width / span) }}×</div>
    <Teleport to="body">
      <div v-if="menu" ref="menuElement" class="map-quick-menu" role="menu" aria-label="地图快捷操作" :style="{ left: `${menu.x}px`, top: `${menu.y}px` }" @pointerdown.stop>
        <div class="map-quick-title">{{ menu.portalId ? world.portals[menu.portalId]?.name : '地图位置' }}</div>
        <template v-if="menu.portalId">
          <button type="button" role="menuitem" @click="menuAction('select')">查看详情</button>
          <button type="button" role="menuitem" @click="menuAction('hack')">入侵 Hack</button>
          <button type="button" role="menuitem" @click="menuAction('deploy-all')">批量部署</button>
          <button type="button" role="menuitem" @click="menuAction('link')">连线</button>
        </template>
        <div v-if="menu.portalId" class="map-quick-divider" role="separator"></div>
        <button type="button" role="menuitem" @click="menuAction('attack')">当前位置攻击</button>
        <button type="button" role="menuitem" @click="menuAction('point')">前往此处</button>
        <button type="button" role="menuitem" @click="menuAction('apply')">申请新 PO</button>
      </div>
    </Teleport>
  </div>
</template>

<style scoped>
.map-wrap{position:relative}
.map-quick-menu{position:fixed;z-index:40;width:174px;max-height:calc(100dvh - 16px);overflow:auto;padding:6px;background:#fff;border:1px solid #cad9e9;border-radius:9px;box-shadow:0 10px 26px #123d6b38;color:#163861}
.map-quick-title{padding:5px 9px 7px;font-size:12px;font-weight:750;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;border-bottom:1px solid #e4edf6;margin-bottom:3px}
.map-quick-divider{height:1px;background:#e4edf6;margin:3px 4px}
.map-quick-menu button{display:block;width:100%;border:0;border-radius:5px;background:#fff;color:#204d81;text-align:left;font-size:13px;font-weight:620;padding:9px 10px}
.map-quick-menu button:hover,.map-quick-menu button:focus-visible{background:#eaf3ff;color:#155db7}
</style>
