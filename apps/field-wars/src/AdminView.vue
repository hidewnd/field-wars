<script setup lang="ts">
import { onMounted, ref } from 'vue';
import {requestId as newRequestId} from './crypto';
import {appPath} from './paths';
import { ApiError, errorMessage, get, post } from './api';

interface AdminState { applications: Record<string, unknown>[]; complaints: Record<string, unknown>[]; audit: Record<string, unknown>[]; world: {seq:string;season:{id:number;startAt:number;endAt:number};scores:Record<string,number>;maintenance:boolean;announcement:string;nextCheckpoint:number}; accounts: Record<string, unknown>[]; rules?: Record<string,unknown>; publicsummary?:{portalCount:number;linkCount:number;fieldCount:number}; csrfToken?: string; commandEpoch?: string }
const password = ref('');
const csrf = ref('');
const commandEpoch = ref('');
const state = ref<AdminState | null>(null);
const error = ref('');
const notice = ref('');
const busy = ref(false);
const reason = ref('');
const announcement = ref('');
const restrictAccount = ref('');
const restrictHours = ref(24);
const compensationAccount = ref('');
const compensationXm = ref(0);
function textOf(record: Record<string, unknown>, key: string) { const value=record[key]; return value === undefined || value === null ? '—' : String(value); }
function timeOf(value:unknown) {const date=new Date(Number(value));return Number.isFinite(date.getTime())?date.toLocaleString('zh-CN'):'—';}
async function refresh() { try { const fresh=await get<AdminState>('/api/admin/state'); state.value=fresh; csrf.value=fresh.csrfToken ?? csrf.value; commandEpoch.value=fresh.commandEpoch ?? commandEpoch.value; error.value=''; } catch (e) { state.value=null; error.value=errorMessage(e); } }
async function login() { busy.value=true; error.value=''; try { const result=await post<{csrfToken:string;commandEpoch:string}>('/api/admin/login',{password:password.value}); csrf.value=result.csrfToken; commandEpoch.value=result.commandEpoch; password.value=''; await refresh(); } catch(e) { error.value=errorMessage(e); } finally { busy.value=false; } }
async function logout() {busy.value=true;try{await post('/api/admin/logout',{},csrf.value,true);state.value=null;csrf.value='';commandEpoch.value='';notice.value='';}catch(e){error.value=errorMessage(e);}finally{busy.value=false;}}
async function mutate(path: string, payload: Record<string, unknown>) {
  if (!reason.value.trim()) { error.value='请填写操作原因'; return; }
  busy.value=true; error.value=''; notice.value='';
  try {
    const requestId=newRequestId(),body={requestId,commandEpoch:commandEpoch.value,payload};
    try {await post(path,body,csrf.value);}
    catch (failure) {
      if (failure instanceof ApiError) throw failure;
      try {await get(`/api/admin/commands/${requestId}`);}
      catch (lookup) {
        if (!(lookup instanceof ApiError && lookup.code==='NOT_FOUND')) throw lookup;
        await post(path,body,csrf.value);
      }
    }
    notice.value='操作已保存'; reason.value=''; await refresh();
  } catch(e) { error.value = e instanceof ApiError ? errorMessage(e) : '结果确认中，请刷新审核记录核对'; }
  finally { busy.value=false; }
}
onMounted(refresh);
</script>

<template>
  <main class="admin-page">
    <header class="admin-top"><a :href="appPath('/')">← 返回城市</a><h1>场域战争 · 运营</h1><div v-if="state" class="inline-controls"><button type="button" @click="refresh">刷新</button><button type="button" :disabled="busy" @click="logout">退出管理</button></div></header>
    <form v-if="!state" class="admin-login" @submit.prevent="login"><h2>管理员登录</h2><p>使用部署时生成的管理员密码。</p><label>密码<input v-model="password" type="password" autocomplete="current-password" required /></label><button type="submit" class="primary-action" :disabled="busy">登录</button></form>
    <template v-else>
      <div class="admin-grid">
        <section class="admin-card"><h2>世界状态</h2><p>{{ state.rules?.version }} · 赛季 {{ state.world.season.id }} · 世界序号 {{ state.world.seq }}</p><p>{{ timeOf(state.world.season.startAt) }} 至 {{ timeOf(state.world.season.endAt) }}</p><p>红 {{ state.world.scores.red }} · 绿 {{ state.world.scores.green }} · 蓝 {{ state.world.scores.blue }}</p><p>据点 {{ state.publicsummary?.portalCount }} · 连线 {{ state.publicsummary?.linkCount }} · 领域 {{ state.publicsummary?.fieldCount }}</p><p>下次计分 {{ timeOf(state.world.nextCheckpoint) }} · 维护：{{ state.world.maintenance ? '已开启' : '未开启' }}</p><details><summary>查看冻结规则（只读）</summary><pre class="rules-json">{{ JSON.stringify(state.rules,null,2) }}</pre></details><label>操作原因<input v-model="reason" maxlength="200" placeholder="记录在审计日志中" /></label><div class="inline-controls"><button type="button" :disabled="busy" @click="mutate('/api/admin/maintenance',{enabled:!state.world.maintenance,reason})">{{ state.world.maintenance ? '结束维护' : '开启维护' }}</button></div><label>公告<textarea v-model="announcement" maxlength="500" rows="3" /></label><button type="button" :disabled="busy" @click="mutate('/api/admin/announcement',{text:announcement,reason})">发布公告</button></section>
        <section class="admin-card"><h2>PO 申请（{{ state.applications.length }}）</h2><div v-if="!state.applications.length" class="empty-state">暂无申请</div><div v-for="application in state.applications" :key="String(application.id)" class="admin-record"><b>{{ textOf(application,'name') }}</b><p>{{ textOf(application,'description') }}</p><small>申请人 {{ textOf(application,'accountId') }} · {{ textOf(application,'status') }} · {{ textOf(application,'x') }}, {{ textOf(application,'y') }}</small><div v-if="application.status==='pending'" class="inline-controls"><button type="button" :disabled="busy" @click="mutate(`/api/admin/po-applications/${application.id}/review`,{decision:'approve',reason})">通过</button><button type="button" :disabled="busy" class="danger-button" @click="mutate(`/api/admin/po-applications/${application.id}/review`,{decision:'reject',reason})">驳回</button></div></div></section>
        <section class="admin-card"><h2>投诉（{{ state.complaints.length }}）</h2><div v-if="!state.complaints.length" class="empty-state">暂无投诉</div><div v-for="complaint in state.complaints" :key="String(complaint.id)" class="admin-record"><b>{{ textOf(complaint,'id') }}</b><p>{{ textOf(complaint,'description') }}</p><small>{{ textOf(complaint,'status') }} · {{ textOf(complaint,'portalId') }}</small><button v-if="complaint.status==='pending'" type="button" :disabled="busy" @click="mutate(`/api/admin/complaints/${complaint.id}/review`,{decision:'resolve',reason})">标记已处理</button></div></section>
        <section class="admin-card"><h2>账号限制与补偿</h2><label>账号 ID<input v-model="restrictAccount" /></label><label>限制小时数<input v-model.number="restrictHours" type="number" min="1" max="720" /></label><div class="inline-controls"><button type="button" :disabled="busy" @click="mutate('/api/admin/restrict',{accountId:restrictAccount,until:Date.now()+restrictHours*3600000,reason})">限制账号</button><button type="button" :disabled="busy" @click="mutate('/api/admin/restrict',{accountId:restrictAccount,until:0,reason})">解除限制</button></div><hr /><label>补偿账号 ID<input v-model="compensationAccount" /></label><label>补偿 XM<input v-model.number="compensationXm" type="number" min="1" /></label><button type="button" :disabled="busy" @click="mutate('/api/admin/compensate',{accountId:compensationAccount,xm:compensationXm,reason})">执行补偿</button></section>
        <section class="admin-card wide"><h2>操作审计</h2><div class="admin-table"><table><thead><tr><th>时间</th><th>操作</th><th>对象</th><th>原因</th></tr></thead><tbody><tr v-for="(entry,index) in state.audit" :key="index"><td>{{ timeOf(entry.at) }}</td><td>{{ textOf(entry,'action') }}</td><td>{{ textOf(entry,'target') }}</td><td>{{ textOf(entry,'reason') }}</td></tr></tbody></table></div></section>
      </div>
    </template>
    <p v-if="error" class="toast error" role="alert">{{ error }}</p><p v-if="notice" class="toast success" role="status">{{ notice }}</p>
  </main>
</template>
