<script setup lang="ts">
import { computed, nextTick, onBeforeUnmount, onMounted, ref } from 'vue';
import type { BattleEvent, Faction, Item, LevelReward, Portal, Snapshot } from '../../../shared/types';
import { RULES, inventoryCount, levelForAp, xmCap } from '../../../shared/rules';
import { ApiError, errorMessage, command, createSession, events, generateRecoveryCode, get, hasPendingCreate, logout, pendingCommand, recoverSession, resolvePending, revokeSessions, session, snapshot, type CommandReceipt, type PendingCommand } from './api';
import {appPath} from './paths';
import {requestId} from './crypto';
import {playerNameError} from '../../../shared/profile';
import AdminView from './AdminView.vue';
import InventoryPanel from './InventoryPanel.vue';
import MapCanvas from './MapCanvas.vue';
import PortalPanel from './PortalPanel.vue';
import HackReward from './HackReward.vue';
import PlayerNameForm from './PlayerNameForm.vue';
import QuickStartGuide from './QuickStartGuide.vue';
import VersionUpdate from './VersionUpdate.vue';

const isAdmin = location.pathname === appPath('/admin');
const view = ref<'city'|'inventory'|'scores'>('city');
const state = ref<Snapshot | null>(null);
const selectedId = ref<string | null>(null);
const portalRef = ref<InstanceType<typeof PortalPanel> | null>(null);
const hackReward = ref<{portalName:string;items:Item[];cost:number;ap:number;counterDamage:number}|null>(null);
const levelRewards = ref<LevelReward[]>([]);
const leftHidden = ref(localStorage.getItem('junction-beta:left-hidden') === 'true' || (localStorage.getItem('junction-beta:left-hidden') === null && matchMedia('(max-width:700px)').matches));
const busy = ref(false);
const movementPending = ref(false);
const queuedMovement = ref<{kind: string; payload: Record<string,unknown>} | null>(null);
const loading = ref(true);
const loginError = ref('');
const recoveryCode = ref('');
const recoveryInput = ref('');
const recoverOpen = ref(false);
const createOpen = ref(false);
const newPlayerName = ref('');
const newPlayerNameError = computed(() => playerNameError(newPlayerName.value));
const manualGuideOpen = ref(false);
const toast = ref('');
const toastKind = ref<'success'|'error'|'pending'>('success');
const pending = ref<PendingCommand | null>(null);
const mapRef = ref<InstanceType<typeof MapCanvas> | null>(null);
const applicationMode = ref(false);
const applicationPoint = ref<{x:number;y:number}|null>(null);
const applicationName = ref('');
const applicationDescription = ref('');
const applications = ref<Record<string,unknown>[]>([]);
const markers = ref<Record<string,unknown>[]>([]);
const alerts = ref<Record<string,unknown>[]>([]);
const complaintOpen = ref(false);
const complaintText = ref('');
const fieldIds = ref<string[]>([]);
const tick = ref(Date.now());
let clock: number | undefined;
let socket: WebSocket | null = null;
let reconnect: number | undefined;
let toastTimer: number | undefined;
let disposed = false;
let refreshingArrival = false;
let refreshPromise: Promise<void> | null = null;
let refreshQueued = false;

const player = computed(() => state.value?.player ?? null);
// 新手引导等待恢复码保存与阵营选择完成，已读状态随账号保存。
const guideVisible = computed(() => !!player.value && !recoveryCode.value && !recoverOpen.value && !pending.value &&
  (manualGuideOpen.value || (!!player.value.faction && player.value.tutorial.quick_start_pending_at !== undefined)));
const world = computed(() => state.value?.world ?? null);
const selected = computed<Portal | null>(() => selectedId.value && world.value ? world.value.portals[selectedId.value] ?? null : null);
const playerLevel = computed(() => player.value ? levelForAp(player.value.ap) : 1);
const experience = computed(() => {
  const ap = player.value?.ap ?? 0;
  const floor = RULES.apThresholds[playerLevel.value - 1];
  const next = RULES.apThresholds[playerLevel.value];
  if (next === undefined) return { percent: 100, label: `AP ${ap.toLocaleString()} · 已满级` };
  const earned = ap - floor, required = next - floor;
  return { percent: earned / required * 100, label: `AP ${earned.toLocaleString()} / ${required.toLocaleString()}` };
});
const count = computed(() => player.value ? inventoryCount(player.value.inventory) : 0);
const remainingMs = computed(() => Math.max(0, (world.value?.season.endAt ?? 0) - tick.value));
const remaining = computed(() => `${Math.floor(remainingMs.value / 86400000)} 天 ${Math.floor(remainingMs.value % 86400000 / 3600000)} 小时`);
const activeScore = computed(() => world.value?.scores ?? {red:0,green:0,blue:0});
const factionNames: Record<Faction,string> = {red:'红方',green:'绿方',blue:'蓝方'};
const factionSymbols: Record<Faction,string> = {red:'●',green:'◆',blue:'▲'};
const battleEvents = computed(() => [...(world.value?.battleEvents ?? [])].reverse());
function battleText(event: BattleEvent): string {
  if (event.kind === 'join') return `${factionNames[event.faction]}阵营的${event.actor}加入了战斗`;
  const faction = event.faction === player.value?.faction ? '本阵营' : factionNames[event.faction];
  const names = event.portals.map(id => world.value?.portals[id]?.name ?? '据点');
  if (event.kind === 'score') return `${faction}获得 ${event.amount} 积分`;
  if (event.kind === 'capture') return `${faction} · ${event.actor} 占领了 ${names[0]}`;
  if (event.kind === 'link') return `${faction}建立连线：${names.join(' ↔ ')}`;
  if (event.kind === 'field') return `${faction}建立领域：${names.join(' / ')} · ${event.amount} MU`;
  if (event.kind === 'field-destroyed') return `${faction} · ${event.actor} 摧毁了领域场：${names.join(' / ')} · ${event.amount} MU`;
  return `${faction} · ${event.actor} 攻击了 ${names[0]}`;
}
function toggleLeft() {
  leftHidden.value = !leftHidden.value;
  localStorage.setItem('junction-beta:left-hidden', String(leftHidden.value));
}

function message(value: string, kind: 'success'|'error'|'pending'='success') { toast.value=value; toastKind.value=kind; window.clearTimeout(toastTimer); toastTimer=window.setTimeout(()=>toast.value='',5500); }
function showReceipt(receipt:CommandReceipt, refreshed:boolean) {
  const result=receipt.result;
  if (Array.isArray(result.levelRewards)) levelRewards.value.push(...result.levelRewards as LevelReward[]);
  if (result.type==='hack' && Array.isArray(result.items) && typeof result.key==='boolean') {
    const items=(result.items as Item[]).filter(item=>item.quantity>0).map(item=>({...item}));
    if (result.key) items.push({type:'key',level:1,portalId:String(result.portalId),quantity:1});
    if (!items.length) {hackReward.value=null;message('无任何收获');return;}
    hackReward.value={portalName:world.value?.portals[String(result.portalId)]?.name ?? '据点',items,
      cost:result.cost as number,ap:result.ap as number,counterDamage:result.counterDamage as number};
    window.clearTimeout(toastTimer);toast.value='';
  } else if (result.type==='guide-read') {manualGuideOpen.value=false;if(refreshed)toast.value='';else message('已确认，状态刷新中','pending');}
  else if (refreshed && result.type==='rename') message('玩家名称已更新');
  else if (refreshed && (result.type==='recycle' || result.type==='sugar')) message(`已恢复 ${result.restored} XM${Number(result.wasted)>0 ? `，超出上限 ${result.wasted} XM` : ''}`);
  else if (refreshed && result.type==='drop') message('已丢弃，道具已标记在当前位置');
  else if (refreshed && result.type==='pickup') message('已拾取，道具已放入背包');
  else message(refreshed?'操作成功':'操作已提交，状态刷新中，请稍后查看',refreshed?'success':'pending');
}
function loadSnapshot(): Promise<void> {
  if (refreshPromise) {refreshQueued=true;return refreshPromise;}
  refreshPromise=(async()=>{
    do {
      refreshQueued=false;
      const fresh=await snapshot(), old=state.value;
      if (!old || old.player.id!==fresh.player.id || BigInt(fresh.world.seq)>BigInt(old.world.seq) ||
        (fresh.world.seq===old.world.seq && fresh.serverTime>=old.serverTime)) {
        state.value=fresh;
        pending.value=pendingCommand(fresh.player.id);
        // 自动选点仅用于首次进入；后台同步不能重新打开已关闭详情或打断攻击菜单。
        if (!selectedId.value && !old) {
          const portals=Object.values(fresh.world.portals);
          selectedId.value=portals.sort((a,b)=>Math.hypot(a.x-fresh.player.x,a.y-fresh.player.y)-Math.hypot(b.x-fresh.player.x,b.y-fresh.player.y))[0]?.id ?? null;
        }
      }
    } while(refreshQueued);
  })().finally(()=>{refreshPromise=null;});
  return refreshPromise;
}
async function loadSecondary() {
  const results=await Promise.allSettled([get<{applications:Record<string,unknown>[]}>('/api/po-applications/mine'),get<{markers:Record<string,unknown>[];alerts:Record<string,unknown>[]}>('/api/social')]);
  if (results[0].status==='fulfilled') applications.value=results[0].value.applications ?? [];
  if (results[1].status==='fulfilled') { markers.value=results[1].value.markers ?? []; alerts.value=results[1].value.alerts ?? []; }
}
function connect() {
  if (socket) { socket.onclose=null; socket.close(); }
  socket=events(()=>{void loadSnapshot().catch(()=>message('同步暂不可用，稍后自动重试','pending'));}, alert=>{const name=world.value?.portals[String(alert.portalId)]?.name ?? '据点'; message(`${name} 受到攻击`, 'pending');void loadSecondary();});
  socket.onclose=()=>{if (!disposed) reconnect=window.setTimeout(connect,2000);};
}
async function bootstrap() {
  loading.value=true;
  try {
    if (hasPendingCreate()) {
      const resumed=await createSession();
      recoveryCode.value=resumed.recoveryCode;
      await loadSnapshot();void loadSecondary();connect();return;
    }
    const current=await session();
    if (current.player) { await loadSnapshot(); void loadSecondary(); connect(); }
  } catch(e) { if (!(e instanceof ApiError && (e.code==='UNAUTHORIZED' || e.code==='HTTP_401'))) loginError.value=errorMessage(e); }
  finally { loading.value=false; }
}
async function startCreate() {
  if (hasPendingCreate()) {await create();return;}
  newPlayerName.value=`玩家${requestId().slice(0,6)}`;
  loginError.value='';createOpen.value=true;
  await nextTick();document.getElementById('new-player-name')?.focus();
}
async function create() {
  if (busy.value || (!hasPendingCreate() && newPlayerNameError.value)) return;
  busy.value=true;loginError.value='';
  try {
    const result=await createSession(newPlayerName.value.trim());
    recoveryCode.value=result.recoveryCode;createOpen.value=false;
    await loadSnapshot();connect();
  } catch(e) {
    loginError.value=errorMessage(e);
    // 结果未知时返回入口，下次点击只重试原请求，避免编辑名称后误以为创建了另一个账号。
    if(hasPendingCreate())createOpen.value=false;
  } finally {busy.value=false;}
}
async function recover() { busy.value=true; loginError.value=''; try { const result=await recoverSession(recoveryInput.value.trim()); recoveryCode.value=result.recoveryCode; recoveryInput.value=''; recoverOpen.value=false; await loadSnapshot(); connect(); } catch(e) {loginError.value=errorMessage(e);} finally {busy.value=false;} }
async function copyCode() {
  if (navigator.clipboard) {
    try {await navigator.clipboard.writeText(recoveryCode.value);message('恢复码已复制');return;}
    catch { /* 浏览器拒绝剪贴板权限时改为选中文本，明确提示用户手动复制。 */ }
  }
  // 私网 HTTP 不提供 Clipboard API；选中可见恢复码，不把选中误报为复制成功。
  const element=document.querySelector('.recovery-code');
  if (!element) return;
  const range=document.createRange();range.selectNodeContents(element);
  const selection=window.getSelection();selection?.removeAllRanges();selection?.addRange(range);
  message('已选中恢复码，请手动复制并妥善保存');
}
function clearSession() {if(socket){socket.onclose=null;socket.close();socket=null;}state.value=null;pending.value=null;selectedId.value=null;levelRewards.value=[];hackReward.value=null;recoverOpen.value=false;recoveryCode.value='';manualGuideOpen.value=false;}
async function rotateCode() {if (!state.value || busy.value) return;busy.value=true;try {const result=await generateRecoveryCode(state.value.csrfToken,state.value.player.id);recoveryCode.value=result.recoveryCode;message('新恢复码已生成，请立即保存');}catch(e){message(errorMessage(e),e instanceof ApiError && e.code==='RESULT_UNKNOWN'?'pending':'error');}finally{busy.value=false;}}
async function signOut() {if (!state.value || busy.value) return;busy.value=true;try {await logout(state.value.csrfToken);clearSession();message('已退出');}catch(e){message(errorMessage(e),'error');}finally{busy.value=false;}}
async function revokeAllSessions() {if(!state.value || busy.value)return;busy.value=true;try{await revokeSessions(state.value.csrfToken);clearSession();message('全部会话已撤销，请用恢复码重新登录');}catch(e){message(errorMessage(e),'error');}finally{busy.value=false;}}
async function confirmPending() {
  if (!state.value || busy.value || !pending.value) return;
  busy.value=true;message('正在核对原请求收据…','pending');
  try {
    const receipt=await resolvePending(state.value);
    pending.value=null;
    let refreshed=true;
    try {await loadSnapshot();} catch {refreshed=false;}
    showReceipt(receipt,refreshed);
    void loadSecondary();
  } catch(error) {
    pending.value=pendingCommand(state.value.player.id);
    message(pending.value ? `结果仍待确认：${errorMessage(error)}` : errorMessage(error),pending.value?'pending':'error');
  } finally {busy.value=false;}
}

async function act(kind: string, payload: Record<string,unknown>={}) {
  if (!state.value) return;
  const isMovement = kind==='move' || kind==='cancel';
  if (busy.value) {
    // 请求串行提交以保持玩家版本与收据一致；连续改道或停止只保留最后一次意图。
    if (isMovement && movementPending.value) queuedMovement.value={kind,payload};
    else if (isMovement) message('正在处理操作，请稍后重试','pending');
    return;
  }
  if (pending.value) {message('请先确认上次操作结果','pending');return;}
  const path: Record<string,string>={
    rename:'/api/account/rename','guide-read':'/api/account/guide-read',
    faction:'/api/faction',move:'/api/moves',cancel:'/api/moves/cancel',hack:`/api/portals/${selectedId.value}/hack`,
    deploy:`/api/portals/${selectedId.value}/deploy`, 'deploy-all':`/api/portals/${selectedId.value}/deploy-all`,upgrade:`/api/portals/${selectedId.value}/upgrade`,
    attack:'/api/attacks',recharge:`/api/portals/${selectedId.value}/recharge`,mod:`/api/portals/${selectedId.value}/mods`,
    sugar:'/api/items/sugar/use',recycle:'/api/inventory/recycle',drop:'/api/inventory/drop',pickup:'/api/inventory/pickup','protect-key':'/api/items/key/protect',
    link:'/api/links',application:'/api/po-applications',
    withdraw:`/api/po-applications/${encodeURIComponent(String(payload.applicationId??''))}/withdraw`,marker:'/api/markers',complaint:'/api/complaints',
  };
  if (!path[kind]) return;
  busy.value=true; movementPending.value=isMovement; message('结果确认中…','pending');
  try {
    const targetVersion = kind==='link'
      ? world.value?.portals[String(payload.originId)]?.version
      : ['hack','deploy','deploy-all','upgrade','recharge','mod'].includes(kind) ? selected.value?.version : undefined;
    let commandPayload=kind==='withdraw'?{}:payload;
    if (kind==='recharge' && selected.value) {
      const resonators=selected.value.resonators;
      commandPayload=payload.slot===undefined
        ? {...payload,generations:Object.fromEntries(resonators.map((resonator,index)=>[index,resonator?.generation ?? null]))}
        : {...payload,generation:resonators[Number(payload.slot)]?.generation ?? null};
    }
    const receipt=await command(path[kind],state.value,commandPayload,targetVersion);
    pending.value=pendingCommand(state.value.player.id);
    if (kind==='application') {applicationPoint.value=null;applicationMode.value=false;applicationName.value='';applicationDescription.value='';}
    if (kind==='complaint') {complaintOpen.value=false;complaintText.value='';}
    let refreshed=true;
    try {await loadSnapshot();} catch {refreshed=false;}
    showReceipt(receipt,refreshed);
    void loadSecondary();
  } catch(e) {
    pending.value=pendingCommand(state.value.player.id);
    if (e instanceof ApiError && ['VERSION_CONFLICT','TARGET_CHANGED','SEASON_CHANGED','RULESET_CHANGED'].includes(e.code)) await loadSnapshot().catch(()=>{});
    message(errorMessage(e),pending.value?'pending':'error');
  } finally {
    busy.value=false; movementPending.value=false;
    const next=queuedMovement.value; queuedMovement.value=null;
    // 未知结果须先确认原收据，不能跨过它继续改道或停止。
    if (next && !pending.value) void act(next.kind,next.payload);
  }
}
function closeGuide() {
  if (busy.value) return;
  if (player.value?.tutorial.quick_start_pending_at !== undefined) void act('guide-read');
  else manualGuideOpen.value=false;
}
function onPoint(x:number,y:number) { if (applicationMode.value) { onApply(x,y); return; } void act('move',{x,y}); }
function onApply(x:number,y:number) {
  if (playerLevel.value<8) { message('达到 L8 后可以申请新 PO','error'); return; }
  applicationPoint.value={x,y}; applicationMode.value=false;
}
async function select(id:string) {
  selectedId.value=id;view.value='city';
  // 从背包返回时地图会重新挂载，同一 KEY 再次点击也需要定位。
  await nextTick();
  mapRef.value?.focusPortal(id);
}
function chooseFaction(faction:Faction) { void act('faction',{faction}); }
async function quickAction(kind:string,payload:Record<string,unknown>,portalId:string|null) {
  if (busy.value) return;
  if (pending.value) {message('请先确认上次操作结果','pending');return;}
  if (portalId) select(portalId);
  if (kind==='link' && portalId) {
    await nextTick();
    portalRef.value?.openLinks();
    return;
  }
  void act(kind,payload);
}
function nav(next:'city'|'inventory'|'scores') {view.value=next;}
function openAdmin() { window.location.href=appPath('/admin'); }
onMounted(()=>{if (!isAdmin) {void bootstrap();clock=window.setInterval(()=>{
  tick.value=Date.now();
  if (player.value?.movement && tick.value>=player.value.movement.arriveAt && !refreshingArrival) {
    refreshingArrival=true; void loadSnapshot().catch(()=>{}).finally(()=>refreshingArrival=false);
  }
},1000);}});
onBeforeUnmount(()=>{disposed=true;window.clearInterval(clock);window.clearTimeout(reconnect);window.clearTimeout(toastTimer);socket?.close();});
</script>

<template>
  <VersionUpdate :busy="busy || movementPending" />
  <AdminView v-if="isAdmin" />
  <div v-else-if="loading" class="screen-loading">正在进入场域战争…</div>
  <div v-else-if="!state" class="welcome-screen">
    <div class="welcome-art"><div class="welcome-brand">场域战争</div><h1>在城市之间<br />连接更多可能</h1><p>选择阵营，探索据点，亲手连出第一片领域。</p><div class="welcome-factions"><span>● 红方</span><span>◆ 绿方</span><span>▲ 蓝方</span></div></div>
    <div class="welcome-card">
      <h2>{{ recoverOpen ? '恢复身份' : createOpen ? '输入玩家名称' : '进入城市' }}</h2>
      <p>{{ recoverOpen ? '输入此前保存的恢复码，找回相同账号。' : '以匿名身份开始。账号创建后请立即保存恢复码。' }}</p>
      <form v-if="recoverOpen" @submit.prevent="recover"><label>恢复码<input v-model="recoveryInput" autocomplete="off" required /></label><button type="submit" class="primary-action" :disabled="busy">恢复账号</button><button type="button" class="text-button" @click="recoverOpen=false">返回</button></form>
      <form v-else-if="createOpen" @submit.prevent="create">
        <label for="new-player-name">玩家名称</label>
        <input id="new-player-name" v-model="newPlayerName" autocomplete="nickname" :disabled="busy" :aria-invalid="!!newPlayerNameError" aria-describedby="new-player-name-hint" required />
        <p id="new-player-name-hint" :class="{'error-text':!!newPlayerNameError}" aria-live="polite">{{ newPlayerNameError || '支持中英文，最多 20 个字符，可保留默认随机名称。' }}</p>
        <button type="submit" class="primary-action" :disabled="busy || !!newPlayerNameError">{{ busy ? '创建中…' : '确认名称并进入' }}</button>
        <button type="button" class="text-button" :disabled="busy" @click="createOpen=false;loginError=''">返回</button>
      </form>
      <div v-else><button type="button" class="primary-action" :disabled="busy" @click="startCreate">创建匿名身份</button><button type="button" class="text-button" :disabled="busy" @click="recoverOpen=true;loginError=''">已有恢复码？恢复身份</button></div>
      <p v-if="loginError" role="alert" class="error-text">{{ loginError }}</p>
    </div>
  </div>
  <div v-else class="app-shell" :class="{'left-hidden':leftHidden}">
    <header class="topbar">
      <a class="brand" :href="appPath('/')" @click.prevent="nav('city')">场域战争</a>
      <nav class="main-nav" aria-label="主导航"><button type="button" :class="{active:view==='city'}" @click="nav('city')">◧ <span>城市</span></button><button type="button" :class="{active:view==='inventory'}" @click="nav('inventory')">▣ <span>背包</span></button><button type="button" :class="{active:view==='scores'}" @click="nav('scores')">⚔ <span>战况</span></button></nav>
      <div class="top-scores"><div v-for="faction in (['red','green','blue'] as const)" :key="faction" class="top-score" :class="faction"><span>{{ factionSymbols[faction] }} {{ factionNames[faction] }}</span><strong>{{ activeScore[faction] }}</strong><i /></div></div>
      <div class="account-summary">
        <div class="player-identity">
          <div class="player-heading"><span class="player-level">L{{ playerLevel }}</span><button type="button" class="player-name" :title="player?.name" aria-label="修改玩家名称" @click="recoverOpen=true">{{ player?.name }}</button></div>
          <div class="ap-meter" role="progressbar" aria-label="等级经验" :aria-valuenow="experience.percent" :aria-valuemin="0" :aria-valuemax="100" :aria-valuetext="experience.label" :title="experience.label"><span>{{ experience.label }}</span><div class="ap-track"><i :style="{width:`${experience.percent}%`}" /></div></div>
        </div>
        <div class="xm-meter"><span>XM {{ player?.xm }} / {{ xmCap(playerLevel) }}</span><i :style="{width:`${Math.min(100,(player?.xm??0)/xmCap(playerLevel)*100)}%`}" /></div>
        <button type="button" class="icon-button" aria-label="账号设置" @click="recoverOpen=true">⚙</button>
      </div>
    </header>
    <div v-if="pending" class="pending-banner" role="status"><span>上次操作的结果尚未确认。确认前暂停新的操作，避免重复消耗。</span><button type="button" :disabled="busy" @click="confirmPending">确认上次操作结果</button></div>
    <template v-if="view==='city'">
      <aside v-show="!leftHidden" id="city-sidebar" class="left-rail"><section class="rail-section"><div class="rail-heading"><span class="rail-icon">▣</span><h2>七日赛季</h2><small>第 {{ Math.max(1,Math.ceil((tick-(world?.season.startAt??0))/86400000)) }} 天</small></div><p class="muted">距离赛季结束 {{ remaining }}</p></section><section class="rail-section rail-scores"><div v-for="faction in (['red','green','blue'] as const)" :key="faction" :class="faction"><span>{{ factionSymbols[faction] }}　{{ factionNames[faction] }}</span><b>{{ activeScore[faction] }}</b></div></section><section class="rail-section rail-actions"><button type="button" class="guide-tile" @click="manualGuideOpen=true">?　玩法说明 <span>›</span></button><button type="button" class="recovery-tile" @click="recoverOpen=true">⚿　账号与恢复码 <span>›</span></button><button type="button" :disabled="!player?.movement || busy" @click="act('cancel')">{{ player?.movement ? '停止移动' : '当前未移动' }}</button><button type="button" @click="applicationMode=!applicationMode">{{ applicationMode ? '取消申请选点' : '地图选点申请 PO' }}</button><button type="button" @click="complaintOpen=true">反馈与投诉</button></section><div class="rail-footer">在虚幻的城市之上<br />连接更多的可能</div></aside>
      <main class="map-main"><button type="button" class="rail-toggle" :aria-expanded="!leftHidden" aria-controls="city-sidebar" @click="toggleLeft">{{ leftHidden ? '展开侧栏' : '收起侧栏' }}</button><section class="battle-feed" aria-label="实时战报"><header><strong>实时战报</strong><span>最新攻防与阵营收益</span></header><ol role="log" aria-live="polite" aria-relevant="additions"><li v-for="event in battleEvents" :key="event.id"><time>{{ new Date(event.at).toLocaleTimeString('zh-CN',{hour:'2-digit',minute:'2-digit'}) }}</time><span :class="event.faction">{{ battleText(event) }}</span></li></ol><p v-if="!battleEvents.length">战场暂时平静，静候下一次行动</p></section><MapCanvas v-if="state && world && player" ref="mapRef" :map="state.map" :world="world" :player="player" :now="tick" :selected-id="selectedId" :application-mode="applicationMode" :movement-pending="movementPending || !!queuedMovement" @stop="act('cancel')" @select="select" @point="onPoint" @apply="onApply" @field="fieldIds=$event" @quick="quickAction" /><div v-if="world?.announcement" class="announcement">公告：{{ world.announcement }}</div><div v-if="applicationMode" class="map-hint">点击地图空白处申请新 PO · 移动中右键停止</div><div v-else class="map-hint">左键空白处移动 / 改道 · 右键停止 · 操作范围 {{ RULES.interactionRangeCm / 100 }} 米</div></main>
      <PortalPanel ref="portalRef" v-if="selected && player && world" :portal="selected" :world="world" :player="player" :now="tick" :busy="busy" @close="selectedId=null" @action="act" />
      <aside v-else class="detail-panel empty-detail"><h2>选择据点</h2><p>点击地图上的据点查看信息与行动。</p></aside>
    </template>
    <InventoryPanel v-else-if="view==='inventory' && player && world" :player="player" :portals="world.portals" :busy="busy" @action="act" @select="select" />
    <main v-else class="content-page scores-page"><div class="page-heading"><div><h1>战况</h1><p>每五分钟按占点数与领域 MU 计分。赛季结束后清空连线、领域与当期分。</p></div><span>剩余 {{ remaining }}</span></div><div class="score-list"><div v-for="faction in (['red','green','blue'] as const)" :key="faction" :class="faction"><span>{{ factionSymbols[faction] }} {{ factionNames[faction] }}</span><strong>{{ activeScore[faction] }}</strong></div></div><section class="score-secondary"><h2>我的成长</h2><p>等级 L{{ playerLevel }} · AP {{ player?.ap }} · 背包 {{ count }} 件</p><h2>我的 PO 申请</h2><div v-if="!applications.length" class="empty-state">暂无申请。达到 L8 后可在城市地图空白处右键或长按，选择申请。</div><div v-for="item in applications" :key="String(item.id)" class="application-row"><b>{{ item.name }}</b><span>{{ item.status }}</span><button v-if="item.status==='pending'" type="button" :disabled="busy" @click="act('withdraw',{applicationId:item.id})">撤回</button></div><h2>阵营标记与告警</h2><p>{{ markers.length }} 条标记 · {{ alerts.length }} 条告警</p><div v-for="(marker,index) in markers.slice(0,20)" :key="String(marker.id??index)" class="application-row"><span>◆ {{ world?.portals[String(marker.portalId)]?.name ?? marker.portalId }} · 至 {{ new Date(Number(marker.expiresAt)).toLocaleTimeString('zh-CN') }}</span><button type="button" class="soft-action" @click="select(String(marker.portalId))">查看</button></div><div v-for="(alert,index) in alerts.slice(0,20)" :key="index" class="application-row"><span>受击 {{ Number(alert.count) }} 次 · {{ world?.portals[String(alert.portalId)]?.name ?? alert.portalId }} · {{ new Date(Number(alert.at)).toLocaleString('zh-CN') }}</span><button type="button" class="soft-action" @click="select(String(alert.portalId))">查看</button></div></section></main>
    <div v-if="!player?.faction" class="modal-backdrop"><div class="dialog faction-dialog"><h2>选择阵营</h2><p>选定后无法更改。选择后即可领取新手包，探索城市。</p><div class="faction-options"><button v-for="faction in (['red','green','blue'] as const)" :key="faction" type="button" :class="faction" :disabled="busy" @click="chooseFaction(faction)">{{ factionSymbols[faction] }} {{ factionNames[faction] }}</button></div></div></div>
    <div v-if="recoveryCode || recoverOpen" class="modal-backdrop"><div class="dialog account-dialog" role="dialog" aria-modal="true" :aria-label="recoveryCode ? '保存恢复码' : '账号信息'"><h2>{{ recoveryCode ? '保存恢复码' : '账号信息' }}</h2><template v-if="recoveryCode"><p>请现在保存。恢复码只显示这一次，换设备或清理浏览器后可凭它找回账号。</p><code class="recovery-code">{{ recoveryCode }}</code><div class="dialog-actions"><button type="button" @click="copyCode">复制恢复码</button><button type="button" class="primary-action" @click="recoveryCode='';recoverOpen=false">我已保存</button></div></template><template v-else><p class="account-id">账号 ID · {{ player?.id }}</p><PlayerNameForm v-if="player" :name="player.name" :busy="busy || !!pending" @save="act('rename',{name:$event})" /><p>可以重新生成恢复码。新码生成后旧码立即失效。</p><button type="button" class="soft-action" :disabled="busy" @click="rotateCode">重新生成恢复码</button><button type="button" class="soft-action" :disabled="busy" @click="revokeAllSessions">撤销全部会话</button><button type="button" class="soft-action" @click="openAdmin">运营管理入口</button><div class="dialog-actions"><button type="button" @click="recoverOpen=false">关闭</button><button type="button" :disabled="busy" @click="signOut">退出账号</button></div></template></div></div>
    <div v-if="applicationPoint" class="modal-backdrop"><form class="dialog" @submit.prevent="act('application',{name:applicationName,description:applicationDescription,...applicationPoint})"><h2>申请新 PO</h2><p>坐标 {{ Math.round(applicationPoint.x/100) }}, {{ Math.round(applicationPoint.y/100) }} 米。与已批准据点至少相距 {{ RULES.newPortals.minApprovedSpacingCm / 100 }} 米，审核通过后生成中立据点。</p><label>名称（2–24 字）<input v-model="applicationName" minlength="2" maxlength="24" required /></label><label>介绍（10–200 字）<textarea v-model="applicationDescription" minlength="10" maxlength="200" rows="4" required /></label><div class="dialog-actions"><button type="button" @click="applicationPoint=null">取消</button><button type="submit" class="primary-action" :disabled="busy">提交申请</button></div></form></div>
    <div v-if="complaintOpen" class="modal-backdrop"><form class="dialog" @submit.prevent="act('complaint',{description:complaintText,portalId:selectedId})"><h2>反馈与投诉</h2><label>请描述问题<textarea v-model="complaintText" required maxlength="1000" rows="5" /></label><div class="dialog-actions"><button type="button" @click="complaintOpen=false">取消</button><button type="submit" class="primary-action" :disabled="busy">提交</button></div></form></div>
    <div v-if="fieldIds.length" class="modal-backdrop"><div class="dialog"><h2>领域</h2><p>此处叠加 {{ fieldIds.length }} 个领域，选择查看详情。</p><div v-for="id in fieldIds" :key="id" class="application-row"><span>{{ world?.fields.find(field=>field.id===id)?.faction }} · {{ world?.fields.find(field=>field.id===id)?.mu }} MU</span><small>{{ id }}</small></div><button type="button" class="soft-action" @click="fieldIds=[]">关闭</button></div></div>
    <QuickStartGuide v-if="guideVisible" :busy="busy" @close="closeGuide" />
    <HackReward v-if="levelRewards.length" :key="levelRewards[0].level" :reward-level="levelRewards[0].level" :items="levelRewards[0].items" portal-name="" :cost="0" :ap="0" :counter-damage="0" @close="levelRewards.shift()" />
    <HackReward v-else-if="hackReward" v-bind="hackReward" @close="hackReward=null" />
    <div v-if="toast" class="toast" :class="toastKind" role="status">{{ toast }}</div>
  </div>
</template>

<style scoped>
#new-player-name-hint{margin:8px 0 20px;font-size:13px;line-height:1.6}
.scores-page .application-row{align-items:center;gap:12px}.scores-page .application-row>span{min-width:0;overflow-wrap:anywhere}.scores-page .application-row>.soft-action{width:auto;min-height:36px;padding:8px 14px;flex:none}
.player-identity{display:flex;flex-direction:column;gap:4px;min-width:130px}.player-heading{display:flex;align-items:center;gap:7px;min-width:0}.player-level{flex:none;font-size:12px;color:#2366b7}.ap-meter{font-size:10px;color:#6984a5;line-height:1.3}.ap-meter>span{display:block;overflow:hidden;text-overflow:ellipsis}.ap-track{height:4px;margin-top:3px;border-radius:4px;overflow:hidden;background:#e5ecf6}.ap-track i{display:block;height:100%;background:#8b65ca;border-radius:inherit}.player-name{padding:0;border:0;background:none;color:#193e70;text-align:left;font-size:14px;font-weight:700;max-width:150px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}.account-dialog{max-height:calc(100dvh - 32px);overflow-y:auto}.account-dialog .account-id{font-size:12px;color:#7790ae;overflow-wrap:anywhere}.account-dialog>.soft-action{margin-bottom:8px}.guide-tile{display:flex;justify-content:space-between;align-items:center}.guide-tile span{margin-left:auto}
@media(max-width:700px){.account-summary{display:grid;grid-template-columns:minmax(0,1fr) 24px;gap:3px 4px;padding:0 6px;min-width:0;flex:1;align-content:center}.player-identity{grid-column:1;grid-row:1;min-width:0;gap:1px}.player-heading{gap:4px}.player-level{font-size:10px}.ap-meter{font-size:9px}.ap-track{height:3px;margin-top:1px}.player-name{font-size:11px;max-width:100%}.account-summary .xm-meter{grid-column:1;grid-row:2;width:100%;max-width:150px;font-size:9px;padding-bottom:4px}.account-summary .xm-meter i{height:3px}.account-summary .icon-button{grid-column:2;grid-row:1/3}.account-dialog{padding:22px}.account-dialog h2{font-size:23px}}
@media(max-width:380px){.brand{font-size:18px;padding:0 7px}.main-nav button{min-width:32px;padding:0 4px}.account-summary{padding:0 5px;gap:2px}.player-name{font-size:10px}}
</style>
