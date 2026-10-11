<script setup lang="ts">
import {computed, ref, watch} from 'vue';
import {PLAYER_NAME_LIMIT, playerNameError} from '../../../shared/profile';
const props=defineProps<{name:string;busy:boolean}>();
const emit=defineEmits<{save:[name:string]}>();
const draft=ref(props.name);
const error=computed(()=>playerNameError(draft.value));
const length=computed(()=>[...draft.value.trim()].length);
watch(()=>props.name,name=>{draft.value=name});
function save(){if(!props.busy && !error.value)emit('save',draft.value.trim());}
</script>

<template>
  <form class="name-form" @submit.prevent="save">
    <label for="player-name">玩家名称 <span :class="{invalid:!!error}">{{ length }} / {{ PLAYER_NAME_LIMIT }}</span></label>
    <div class="name-input"><input id="player-name" v-model="draft" autocomplete="nickname" :disabled="busy" :aria-invalid="!!error" aria-describedby="player-name-hint" placeholder="输入你的游戏名称" /><button type="submit" :disabled="busy || !!error || draft.trim()===name">{{ busy ? '保存中…' : '保存名称' }}</button></div>
    <p id="player-name-hint" :class="{invalid:!!error}" aria-live="polite">{{ error || '支持中英文，最多 20 个字符。' }}</p>
  </form>
</template>

<style scoped>
.name-form{padding:16px;background:#f4f8fe;border:1px solid #deE8f5;border-radius:10px;margin:18px 0}.name-form label{display:flex;justify-content:space-between;margin:0 0 8px}.name-form label span{font-weight:400;color:#7790ae}.name-input{display:flex;gap:8px}.name-input input{min-width:0}.name-input button{flex-shrink:0;border:0;border-radius:7px;background:#2468d6;color:white;font-size:13px;padding:8px 12px}.name-form p{font-size:12px;margin:8px 0 0;line-height:1.5}.name-form .invalid{color:#b33f50}
@media(max-width:420px){.name-form{padding:12px}.name-input{flex-wrap:wrap}.name-input button{width:100%;min-height:38px}}
</style>
