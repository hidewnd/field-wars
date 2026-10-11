<script setup lang="ts">
import { onBeforeUnmount, onMounted, ref } from 'vue';
import { fetchFrontendVersion, frontendRefreshUrl, startVersionChecks } from './version';

defineProps<{ busy: boolean }>();
const dialog = ref<HTMLDialogElement | null>(null);
const refreshing = ref(false);
const error = ref('');
let latestVersion = '';
let remindAt = 0;
let stop: (() => void) | undefined;
let refreshRequest: AbortController | undefined;

function defer() {
  if (refreshing.value) return;
  remindAt = Date.now() + 5 * 60_000;
  dialog.value?.close();
}

async function refresh() {
  if (refreshing.value) return;
  refreshing.value = true;
  error.value = '';
  refreshRequest = new AbortController();
  const timeout = window.setTimeout(() => refreshRequest?.abort(), 10_000);
  try {
    const version = await fetchFrontendVersion(refreshRequest.signal);
    location.replace(frontendRefreshUrl(version));
  } catch {
    error.value = '暂时无法获取新版本，请检查网络后重试。当前页面已保留。';
    refreshing.value = false;
  } finally {
    window.clearTimeout(timeout);
  }
}

onMounted(() => {
  if (!import.meta.env.PROD) return;
  stop = startVersionChecks(import.meta.env.VITE_APP_VERSION, version => {
    if (refreshing.value) return;
    if (!version) {
      latestVersion = '';
      dialog.value?.close();
      return;
    }
    if (version !== latestVersion) remindAt = 0;
    latestVersion = version;
    if (Date.now() >= remindAt && !dialog.value?.open) {
      error.value = '';
      dialog.value?.showModal();
    }
  });
});
onBeforeUnmount(() => { stop?.(); refreshRequest?.abort(); });
</script>

<template>
  <dialog ref="dialog" class="version-dialog" aria-labelledby="version-title" aria-describedby="version-description" @cancel.prevent="defer">
    <div class="version-icon" aria-hidden="true">↻</div>
    <p class="version-eyebrow">版本更新</p>
    <h2 id="version-title">发现新版本</h2>
    <p id="version-description">场域战争已发布新版本。刷新页面后，即可使用最新内容与功能修复。</p>
    <div class="version-details">
      <p>刷新时将重新加载页面，并更新本地缓存的页面资源。</p>
      <p>已保存的游戏进度和账号信息会保留；尚未提交的输入将丢失，请先完成当前操作。</p>
    </div>
    <p v-if="busy" class="version-status" role="status">操作正在提交，请稍候再刷新。</p>
    <p v-if="error" class="error-text" role="alert">{{ error }}</p>
    <footer class="version-actions">
      <button type="button" class="text-button" :disabled="refreshing" @click="defer">稍后更新（5 分钟后提醒）</button>
      <button type="button" class="primary-action" :disabled="busy || refreshing" @click="refresh">{{ refreshing ? '正在获取新版本…' : '立即刷新' }}</button>
    </footer>
  </dialog>
</template>

<style scoped>
.version-dialog{border:1px solid #dbe6f4;border-radius:18px;width:min(440px,calc(100vw - 32px));max-height:calc(100dvh - 32px);overflow:auto;padding:28px;color:#193e70;box-shadow:0 20px 70px #09244b40}
.version-dialog::backdrop{background:#09244b89}
.version-icon{display:grid;place-items:center;width:48px;height:48px;border-radius:14px;background:#eaf2ff;color:#2468d6;font-size:32px}
.version-eyebrow{font-size:12px;letter-spacing:.12em;color:#627fa3;margin:20px 0 8px}
.version-dialog h2{font-size:25px;margin:0 0 14px}
#version-description,.version-details p,.version-status{font-size:14px;line-height:1.75;color:#577293}
.version-details{background:#f3f7fc;border-radius:10px;padding:14px 16px;margin:20px 0}
.version-details p{margin:0}.version-details p+p{margin-top:10px}
.version-actions{display:grid;gap:6px;margin-top:18px}
.version-actions .text-button{font-size:13px;color:#627b9c}
.version-actions .primary-action{background:#2468d6;border-color:#2468d6;min-height:48px}
.version-actions button:focus-visible{outline:3px solid #8cb6fa;outline-offset:3px}
.version-actions button:disabled{opacity:.55;cursor:wait}
@media(max-width:480px){.version-dialog{padding:23px}.version-dialog h2{font-size:23px}}
</style>
