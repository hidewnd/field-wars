<script setup lang="ts">
import {nextTick, onBeforeUnmount, onMounted, ref} from 'vue';
import {RULES} from '../../../shared/rules';
const props=defineProps<{busy:boolean}>();
const emit=defineEmits<{close:[]}>();
const section=ref('start');
const dialog=ref<HTMLElement|null>(null);
const previousFocus=document.activeElement as HTMLElement|null;
function close(){if(!props.busy)emit('close');}
function onKey(event:KeyboardEvent){
  if(event.key==='Escape'){event.preventDefault();event.stopPropagation();close();}
  if(event.key!=='Tab')return;
  const buttons=dialog.value?.querySelectorAll<HTMLButtonElement>('button:not(:disabled)');
  if(!buttons?.length)return;
  const first=buttons[0],last=buttons[buttons.length-1];
  if(event.shiftKey&&document.activeElement===first){event.preventDefault();last.focus();}
  else if(!event.shiftKey&&document.activeElement===last){event.preventDefault();first.focus();}
}
onMounted(async()=>{await nextTick();dialog.value?.querySelector('button')?.focus()});
onBeforeUnmount(()=>{if(previousFocus?.isConnected)previousFocus.focus()});
</script>

<template>
  <div class="modal-backdrop guide-backdrop" @click.self="close" @keydown="onKey">
    <section ref="dialog" class="dialog guide-dialog" role="dialog" aria-modal="true" aria-labelledby="guide-title" aria-describedby="guide-intro">
      <header class="guide-header"><div><span class="eyebrow">场域战争 · 新手指南</span><h2 id="guide-title">玩法说明</h2></div><button type="button" class="icon-button" aria-label="关闭玩法说明" :disabled="busy" @click="close">×</button></header>
      <p id="guide-intro">占领据点，连接城市，为你的阵营建立领域。</p>
      <nav class="guide-nav" aria-label="玩法章节"><button v-for="[key,label] in [['start','快速开始'],['stats','核心参数'],['actions','常用操作'],['advanced','进阶与安全']]" :key="key" type="button" :aria-pressed="section===key" :class="{active:section===key}" @click="section=key">{{ label }}</button></nav>
      <div class="guide-content">
        <template v-if="section==='start'">
          <div class="guide-tip">第一次游玩？先尝试在附近据点完成一次 Hack。</div>
          <ol class="start-steps">
            <li><span>01</span><div><h3>靠近据点，获取装备</h3><p>点击地图空白处移动，到据点 {{ RULES.interactionRangeCm/100 }} 米内停下。点击据点后选择 Hack，获得脚、攻击器、糖块和 Key。</p></div></li>
            <li><span>02</span><div><h3>部署八脚，占领并守住据点</h3><p>在中立据点部署第一只脚即可占领。批量部署默认从高等级到低等级补齐空槽；选中单槽可部署，友方满八脚后可升级。</p></div></li>
            <li><span>03</span><div><h3>连成三角，建立领域</h3><p>持有目标 Key，在友方满八脚据点打开“连线”。两端都须满八脚，每次消耗 1 把目标 Key 和 {{ RULES.linkXmCost }} XM；三点合法闭合即可成场。</p></div></li>
          </ol>
          <p class="guide-note">L1 据点最低连线范围 {{ RULES.minimumPortalRangeCm/100 }} 米。能否连接还取决于起点射程、连线阻挡和领域规则，可用目标会列在详情中。</p>
        </template>
        <dl v-else-if="section==='stats'" class="parameter-grid">
          <div><dt>PO · 据点</dt><dd>地图上的行动节点，可被占领、部署脚、充能及连线。颜色表示所属阵营。</dd></div>
          <div><dt>AP · 成长经验</dt><dd>占领、部署、连线、建场等行动会获得 AP，累积后提升玩家等级。</dd></div>
          <div><dt>L1–L8 · 玩家等级</dt><dd>决定可使用的装备等级和 XM 上限。玩家等级与据点等级是两个不同参数。</dd></div>
          <div><dt>XM · 行动能量</dt><dd>部署、Hack、攻击等行动消耗 XM。每秒恢复 {{ RULES.player.xmPerSecond }} XM，也可使用糖块或回收装备补充。</dd></div>
          <div><dt>八脚 · 据点基础</dt><dd>每点 8 个槽位，据点等级按八槽总等级计算。脚有独立能量，降到零会消失；不足八脚会断开相关连线与领域。</dd></div>
          <div><dt>MU · 领域计分值</dt><dd>每 {{ RULES.checkpointMs/60000 }} 分钟，为阵营结算据点与领域收益。MU 参与阵营计分，不是玩家升级经验。</dd></div>
        </dl>
        <div v-else-if="section==='actions'" class="action-list">
          <article><h3>移动与地图</h3><p>左键点空白处移动或改道；移动中右键停止。拖动平移、滚轮缩放；手机可长按打开快捷菜单。</p></article>
          <article><h3>侵入攻击</h3><p>静止时右键或长按地图，展开第一项“侵入攻击”，选择背包中的攻击器等级。攻击从玩家当前位置发出，消耗攻击器和 XM。</p></article>
          <article><h3>充能与维护</h3><p>靠近友方据点可充能，持有本点 Key 可远程充能。脚每 {{ RULES.resonators.decayIntervalMs/3600000 }} 小时衰减其等级满能量的 {{ RULES.resonators.decayPercent }}%，记得定期维护。</p></article>
          <article><h3>背包与拾取</h3><p>背包上限 {{ RULES.player.inventoryLimit }} 件，满包先使用、回收或丢弃。落地道具可在 {{ RULES.interactionRangeCm/100 }} 米内拾取；受保护的 Key 不能丢弃或回收。</p></article>
          <article><h3>糖块与冷却</h3><p>糖块每级最多恢复 {{ RULES.items.cubeRecoveryPerLevel }} XM，回收与使用效果相同；超出能量上限的部分会浪费。行动存在冷却，以按钮提示为准。</p></article>
        </div>
        <template v-else>
          <div class="unlock-card"><span>L8 解锁</span><h3>申请新的 PO</h3><p>达到 L8 后，点击左侧“地图选点申请 PO”，选择位置并填写名称和介绍，提交后等待审核。</p><p>与已有据点至少相距 {{ RULES.newPortals.minApprovedSpacingCm/100 }} 米，还需满足城市边界、水域、铁路和区域容量等条件；提交前会校验。</p></div>
          <div class="action-list"><article><h3>阵营与赛季</h3><p>阵营选定后不可更改。每 {{ RULES.seasonMs/86400000 }} 天结算赛季；领域被摧毁会失去后续收益，已经获得的阵营积分不会倒扣。</p></article><article><h3>保存恢复码</h3><p>恢复码用于找回身份，请妥善保存，不要分享。右上角账号设置可修改玩家名称；改名不会改变账号或已有资产。</p></article><article><h3>操作结果待确认时</h3><p>如果网络中断，请使用“确认上次操作结果”，待结果确认后再继续，避免重复消耗。</p></article></div>
        </template>
      </div>
      <footer class="guide-footer"><span>之后可从左侧“玩法说明”随时重看</span><button type="button" :disabled="busy" @click="close">{{ busy ? '保存中…' : '我知道了，开始探索' }}</button></footer>
    </section>
  </div>
</template>

<style scoped>
.guide-backdrop{background:#102e526e;backdrop-filter:blur(4px)}.guide-dialog{width:min(700px,100%);max-height:calc(100dvh - 40px);padding:26px;display:flex;flex-direction:column;overflow:hidden}.guide-header{display:flex;justify-content:space-between;align-items:flex-start;gap:16px}.eyebrow{font-size:11px;letter-spacing:.12em;color:#6383a8}.guide-header h2{margin:7px 0 0;font-size:27px}.guide-dialog>p{font-size:13px;margin:10px 0 20px}.guide-nav{display:grid;grid-template-columns:repeat(4,minmax(0,1fr));gap:5px;padding:4px;background:#edf3fb;border-radius:10px;flex-shrink:0}.guide-nav button{padding:10px 3px;border:0;border-radius:7px;background:transparent;color:#607f9f;font-size:13px}.guide-nav button.active{background:white;color:#1f63c6;font-weight:700;box-shadow:0 2px 6px #15396512}.guide-content{overflow:auto;min-height:0;padding:20px 2px 10px}.guide-content h3{font-size:15px;margin:0 0 6px}.guide-content p{font-size:13px;line-height:1.75;margin:0}.guide-tip{padding:12px 14px;border-radius:8px;background:#eaf4ff;color:#2761a4;font-size:13px;margin-bottom:18px}.start-steps{list-style:none;padding:0;margin:0;display:grid;gap:20px}.start-steps li{display:flex;gap:14px}.start-steps li>span{display:grid;place-items:center;flex-shrink:0;width:33px;height:33px;border-radius:10px;background:#eef4fe;color:#2968c4;font-size:13px;font-weight:750}.guide-content .guide-note{margin:20px 0 0;padding-top:14px;border-top:1px solid #e3ebf5;font-size:12px;color:#7289a4}.parameter-grid{margin:0;display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:12px}.parameter-grid>div{border:1px solid #e1eaf4;border-radius:10px;padding:15px;background:#f8faff}.parameter-grid dt{font-size:14px;font-weight:700;color:#245795}.parameter-grid dd{font-size:13px;line-height:1.75;color:#647f9f;margin:8px 0 0}.action-list{display:grid;gap:16px}.action-list article+article{padding-top:14px;border-top:1px solid #e5edf7}.unlock-card{padding:18px;border:1px solid #cfdef5;background:#f0f6ff;border-radius:10px;margin-bottom:20px}.unlock-card>span{display:inline-block;font-size:11px;color:#2467c3;margin-bottom:9px;font-weight:700}.unlock-card p+p{margin-top:8px}.guide-footer{display:flex;justify-content:space-between;align-items:center;gap:12px;padding-top:16px;border-top:1px solid #e4edf7;margin-top:8px;flex-shrink:0}.guide-footer span{font-size:11px;color:#7b91ac}.guide-footer button{border:0;border-radius:8px;padding:11px 16px;background:#2468d6;color:white;white-space:nowrap;font-size:13px}
@media(max-width:600px){.guide-backdrop{padding:12px}.guide-dialog{padding:19px;max-height:calc(100dvh - 24px)}.guide-header h2{font-size:23px}.parameter-grid{grid-template-columns:1fr}.guide-nav button{font-size:12px}.guide-footer{flex-direction:column-reverse;align-items:stretch;text-align:center}.guide-footer button{min-height:40px}.guide-content{padding-top:16px}.start-steps{gap:16px}.start-steps li{gap:10px}}
</style>
