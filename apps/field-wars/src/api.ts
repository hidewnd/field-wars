import {requestId as newRequestId, recoveryFingerprint} from './crypto';
import type { CommandEnvelope, Player, Snapshot } from '../../../shared/types';

export interface SessionResponse { player: Player | null; csrfToken: string; commandEpoch: string }
export interface CommandReceipt { requestId: string; committedSeq: string; serverTime: number; result: Record<string, unknown>; player?: Player; world?: Snapshot['world'] }
export interface ApiFailure { error: { code: string; message: string; details?: unknown }; requestId?: string }
export interface PendingCommand { path: string; envelope: CommandEnvelope }

export class ApiError extends Error {
  constructor(public code: string, message: string, public details?: unknown) { super(message); }
}

// 错误码仅用于内部重试/恢复判断；界面统一显示可读原因，兼容服务端几何错误只返回码的情况。
export function errorMessage(error: unknown): string {
  if (!(error instanceof Error)) return '操作未完成，请稍后重试';
  const messages: Record<string, string> = {
    LINK_EXISTS: '这两个据点已经连线', LINK_CROSSING: '连线路径被其他连线阻挡',
    LINK_THROUGH_PORTAL: '连线路径经过其他据点', FIELD_NESTING: '该连线形成的领域会与已有领域产生不允许的包含关系',
    LINK_GEOMETRY: '这两个据点无法建立有效连线', LINK_FACTION: '只能连接同阵营的据点',
    PORTAL_NOT_FOUND: '据点不存在或目标无效', KEY_REQUIRED: '需要目标据点的 Key',
    LINK_UNAVAILABLE: '两端须为八脚齐全的友方据点', LINK_RANGE: '目标超出当前据点射程', LINK_LIMIT: '当前据点的出线数量已达上限',
  };
  if (error instanceof ApiError && (error.message === error.code || /^[A-Z][A-Z0-9_]+$/.test(error.message))) {
    return messages[error.code] ?? '操作未完成，请刷新状态后重试';
  }
  return error.message;
}

async function parse<T>(response: Response, allowEmpty=false): Promise<T> {
  const body = await response.json().catch(() => null) as T | ApiFailure | null;
  if (!response.ok) {
    if (body===null) throw new ApiError('RESULT_UNKNOWN','服务器响应不完整，请使用原请求确认结果');
    const failure = body as ApiFailure | null;
    throw new ApiError(failure?.error?.code ?? `HTTP_${response.status}`, failure?.error?.message ?? '请求失败，请稍后重试', failure?.error?.details);
  }
  if (body===null && !allowEmpty) throw new ApiError('RESULT_UNKNOWN','响应正文缺失，请使用原请求确认结果');
  return body as T;
}

export async function get<T>(path: string): Promise<T> {
  return parse<T>(await fetch(path, { credentials: 'same-origin', cache: 'no-store' }));
}

export async function post<T>(path: string, body: object, csrfToken?: string, allowEmpty=false): Promise<T> {
  const response = await fetch(path, {
    method: 'POST', credentials: 'same-origin',
    headers: { 'content-type': 'application/json', ...(csrfToken ? { 'x-csrf-token': csrfToken } : {}) },
    body: JSON.stringify(body),
  });
  return parse<T>(response,allowEmpty);
}

export async function session(): Promise<SessionResponse> { return get('/api/session'); }
const pendingCreateKey='junction-beta:pending-create';
const pendingRecoverKey='junction-beta:pending-recover';
export function hasPendingCreate():boolean {return !!sessionStorage.getItem(pendingCreateKey);}
export async function createSession(): Promise<SessionResponse & { recoveryCode: string }> {
  const requestId=sessionStorage.getItem(pendingCreateKey) ?? newRequestId();
  sessionStorage.setItem(pendingCreateKey,requestId);
  try {
    let result:SessionResponse & {recoveryCode:string};
    try {result=await post('/api/anonymous-sessions',{requestId});}
    catch(error) {
      if (error instanceof ApiError) throw error;
      result=await post('/api/anonymous-sessions',{requestId});
    }
    if (!result.recoveryCode) throw new ApiError('RESULT_UNKNOWN','恢复码未返回，请使用原请求确认');
    sessionStorage.removeItem(pendingCreateKey);
    return result;
  } catch(error) {
    if (!unresolved(error)) sessionStorage.removeItem(pendingCreateKey);
    throw error;
  }
}
export async function recoverSession(recoveryCode: string): Promise<SessionResponse & { recoveryCode: string }> {
  const codeHash=recoveryFingerprint(recoveryCode);
  const saved=sessionStorage.getItem(pendingRecoverKey);
  const pending=saved ? JSON.parse(saved) as {requestId:string;fingerprint:string} : null;
  if (pending && pending.fingerprint!==codeHash) throw new ApiError('PENDING_RECOVERY','请使用上次输入的恢复码，先确认该次恢复结果');
  const requestId=pending?.requestId ?? newRequestId();
  sessionStorage.setItem(pendingRecoverKey,JSON.stringify({requestId,fingerprint:codeHash}));
  try {
    let result:SessionResponse & {recoveryCode:string};
    try {result=await post('/api/account/recover',{requestId,recoveryCode});}
    catch(error) {
      if (error instanceof ApiError) throw error;
      result=await post('/api/account/recover',{requestId,recoveryCode});
    }
    if (!result.recoveryCode) throw new ApiError('RESULT_UNKNOWN','新恢复码未返回，请使用原请求确认');
    sessionStorage.removeItem(pendingRecoverKey);
    return result;
  } catch(error) {
    if (!unresolved(error)) sessionStorage.removeItem(pendingRecoverKey);
    throw error;
  }
}
export async function generateRecoveryCode(csrfToken:string,accountId:string): Promise<{recoveryCode:string}> {
  const key=`junction-beta:pending-rotation:${accountId}`;
  const requestId=sessionStorage.getItem(key) ?? newRequestId();
  sessionStorage.setItem(key,requestId);
  try {
    let result:{recoveryCode:string};
    try {result=await post('/api/account/recovery-code',{requestId},csrfToken);}
    catch(error) {
      if (error instanceof ApiError) throw error;
      result=await post('/api/account/recovery-code',{requestId},csrfToken);
    }
    if (!result.recoveryCode) throw new ApiError('RESULT_UNKNOWN','新恢复码未返回，请使用原请求确认');
    sessionStorage.removeItem(key);
    return result;
  } catch(error) {
    if (!unresolved(error)) sessionStorage.removeItem(key);
    throw error;
  }
}
export async function logout(csrfToken:string): Promise<void> { await post('/api/account/logout',{},csrfToken,true); }
export async function revokeSessions(csrfToken:string): Promise<void> { await post('/api/account/revoke-sessions',{},csrfToken,true); }
export async function snapshot(): Promise<Snapshot> { return get('/api/world/snapshot'); }

function pendingKey(accountId:string) { return `junction-beta:pending:${accountId}`; }
export function pendingCommand(accountId:string): PendingCommand | null {
  const saved=sessionStorage.getItem(pendingKey(accountId));
  if (!saved) return null;
  try {
    const pending=JSON.parse(saved) as PendingCommand;
    if (typeof pending.path==='string' && pending.path.startsWith('/api/') &&
      typeof pending.envelope?.requestId==='string' && pending.envelope.payload &&
      typeof pending.envelope.commandEpoch==='string') return pending;
  } catch { /* 损坏的本地记录不能作为权威命令重放。 */ }
  sessionStorage.removeItem(pendingKey(accountId));
  return null;
}
function clearPending(accountId:string) {sessionStorage.removeItem(pendingKey(accountId));}
function unresolved(error:unknown) {
  return !(error instanceof ApiError) || ['RESULT_UNKNOWN','REQUEST_PENDING','WORLD_RECOVERING','OVERLOADED'].includes(error.code);
}
async function sendPending(state:Snapshot, pending:PendingCommand):Promise<CommandReceipt> {
  try {
    const receipt=await post<CommandReceipt>(pending.path,pending.envelope,state.csrfToken);
    clearPending(state.player.id);
    return receipt;
  } catch(error) {
    if (!unresolved(error)) clearPending(state.player.id);
    throw error;
  }
}
// 只有同一请求 ID 的收据或重放能解除未知结果；刷新后仍保留请求正文，不保存令牌。
export async function resolvePending(state:Snapshot):Promise<CommandReceipt> {
  const pending=pendingCommand(state.player.id);
  if (!pending) throw new ApiError('NO_PENDING_COMMAND','没有待确认操作');
  try {
    const receipt=await get<CommandReceipt>(`/api/commands/${encodeURIComponent(pending.envelope.requestId)}`);
    clearPending(state.player.id);
    return receipt;
  } catch(error) {
    if (!(error instanceof ApiError && ['NOT_FOUND','REQUEST_PENDING'].includes(error.code))) throw error;
    return sendPending(state,pending);
  }
}
export async function command(path: string, state: Snapshot, payload: Record<string, unknown>, targetVersion?: number, preview=false): Promise<CommandReceipt> {
  if (!preview && pendingCommand(state.player.id)) throw new ApiError('PENDING_COMMAND','先确认上次操作结果');
  const requestId = newRequestId();
  const envelope:CommandEnvelope = {
    requestId, seasonId: state.world.season.id, rulesetVersion: state.rulesetVersion,
    mapVersion: state.mapVersion, playerVersion: state.player.version,
    ...(targetVersion === undefined ? {} : { targetVersion }), payload,
    commandEpoch: state.commandEpoch,
  };
  if (preview) return post<CommandReceipt>(path,envelope,state.csrfToken);
  const pending={path,envelope};
  sessionStorage.setItem(pendingKey(state.player.id),JSON.stringify(pending));
  try {
    return await sendPending(state,pending);
  } catch (error) {
    if (error instanceof ApiError) throw error;
    try {
      const receipt=await get<CommandReceipt>(`/api/commands/${encodeURIComponent(requestId)}`);
      clearPending(state.player.id);
      return receipt;
    } catch (lookupError) {
      if (!(lookupError instanceof ApiError && ['NOT_FOUND','REQUEST_PENDING'].includes(lookupError.code))) throw lookupError;
      return sendPending(state,pending);
    }
  }
}

export function events(onInvalidate: () => void, onAlert: (value: Record<string, unknown>) => void): WebSocket {
  const protocol = location.protocol === 'https:' ? 'wss:' : 'ws:';
  const socket = new WebSocket(`${protocol}//${location.host}/api/events`);
  let deliverySeq=0;
  socket.onopen=onInvalidate;
  socket.onmessage = event => {
    try {
      const message = JSON.parse(String(event.data)) as { type?: string; [key: string]: unknown };
      const next=Number(message.deliverySeq);
      if (message.type==='resync') {deliverySeq=Number.isSafeInteger(next)?next:0;onInvalidate();return;}
      // 投递序号只在单条 WebSocket 内连续；重连以 resync 重设基线。
      if (!Number.isSafeInteger(next) || next!==deliverySeq+1) onInvalidate();
      if (Number.isSafeInteger(next)) deliverySeq=next;
      if (message.type === 'alert') onAlert(message);
      if (message.type === 'invalidate' || message.type === 'alert') onInvalidate();
    } catch { onInvalidate(); }
  };
  return socket;
}
