import {createCipheriv, createDecipheriv, createHash, createHmac, randomBytes, randomUUID, timingSafeEqual} from 'node:crypto';
import '@fastify/cookie';
import type {FastifyReply, FastifyRequest} from 'fastify';
import {BETA_MAP} from '../shared/map.js';
import {createPlayer, GameError} from '../shared/engine.js';
import type {Player} from '../shared/types.js';
import {isAllowedOrigin, type Config} from './config.js';
import type {Store} from './store.js';

const PLAYER_COOKIE = 'cc_session';
const ADMIN_COOKIE = 'cc_admin';
const PLAYER_TTL = 30 * 24 * 60 * 60 * 1000;
const ADMIN_TTL = 8 * 60 * 60 * 1000;
const PLAYER_COOKIE_MAX_AGE = 400 * 24 * 60 * 60;

function hash(value: string): string {return createHash('sha256').update(value).digest('hex');}
function equal(a: string, b: string): boolean {
  const first = Buffer.from(a), second = Buffer.from(b);
  return first.length === second.length && timingSafeEqual(first, second);
}
function validToken(value: unknown): value is string {
  return typeof value === 'string' && /^[A-Za-z0-9_-]{43}$/.test(value);
}
function validRequestId(value: unknown): value is string {
  // 恢复码可由初始化请求ID确定性重建，因此该ID必须来自高熵随机UUID。
  return typeof value === 'string' && /^[a-f\d]{8}-[a-f\d]{4}-4[a-f\d]{3}-[89ab][a-f\d]{3}-[a-f\d]{12}$/i.test(value);
}
interface SecretReceipt {id: string; encryptedCode: string; encryptedToken?: string}

export class Auth {
  constructor(private readonly config: Config, private readonly store: Store) {}

  private encrypt(value: string): string {
    const key = createHash('sha256').update(`auth-receipt:${this.config.secret}`).digest();
    const iv = randomBytes(12);
    const cipher = createCipheriv('aes-256-gcm', key, iv);
    const content = Buffer.concat([cipher.update(value, 'utf8'), cipher.final()]);
    return [iv, cipher.getAuthTag(), content].map(part => part.toString('base64url')).join('.');
  }

  private decrypt(value: string): string {
    const [ivText, tagText, contentText] = value.split('.');
    if (!ivText || !tagText || contentText === undefined) throw new GameError('RECEIPT_INVALID', '恢复收据无效');
    const key = createHash('sha256').update(`auth-receipt:${this.config.secret}`).digest();
    const decipher = createDecipheriv('aes-256-gcm', key, Buffer.from(ivText, 'base64url'));
    decipher.setAuthTag(Buffer.from(tagText, 'base64url'));
    return Buffer.concat([decipher.update(Buffer.from(contentText, 'base64url')), decipher.final()]).toString('utf8');
  }

  private origin(req: FastifyRequest): void {
    if (!isAllowedOrigin(this.config, req.headers.origin)) throw new GameError('ORIGIN_DENIED', '请求来源不匹配');
  }

  private cookie(req: FastifyRequest, reply: FastifyReply, token: string, admin: boolean): void {
    reply.setCookie(admin ? ADMIN_COOKIE : PLAYER_COOKIE, token, {
      path: '/', httpOnly: true, secure: this.config.cookieSecure && req.headers.origin !== this.config.lanOrigin, sameSite: 'strict',
      // 服务端按30天空闲期续期；浏览器保留凭证更久，避免活跃用户被固定Cookie寿命截断。
      maxAge: admin ? Math.floor(ADMIN_TTL / 1000) : PLAYER_COOKIE_MAX_AGE,
    });
  }

  async authenticate(req: FastifyRequest, admin = false): Promise<{id: string; token: string}> {
    const token = req.cookies[admin ? ADMIN_COOKIE : PLAYER_COOKIE];
    if (!validToken(token)) throw new GameError('UNAUTHORIZED', '请先登录');
    const now = Date.now();
    if (admin) {
      const result = await this.store.pool.query('SELECT token_hash FROM admin_sessions WHERE token_hash=$1 AND expires_at>$2', [hash(token), now]);
      if (!result.rowCount) throw new GameError('UNAUTHORIZED', '管理会话已失效');
      return {id: 'admin', token};
    }
    const result = await this.store.pool.query('SELECT account_id::text AS id,expires_at FROM sessions WHERE token_hash=$1 AND expires_at>$2', [hash(token), now]);
    if (!result.rowCount) throw new GameError('UNAUTHORIZED', '身份会话已失效');
    if (Number(result.rows[0].expires_at) < now + PLAYER_TTL / 2) {
      const extended = await this.store.pool.query('UPDATE sessions SET expires_at=$1 WHERE token_hash=$2 AND expires_at>$3 RETURNING token_hash', [now + PLAYER_TTL, hash(token), now]);
      if (!extended.rowCount) throw new GameError('UNAUTHORIZED', '身份会话已失效');
    }
    return {id: result.rows[0].id as string, token};
  }

  async protect(req: FastifyRequest, admin = false): Promise<{id: string; token: string}> {
    this.origin(req);
    const identity = await this.authenticate(req, admin);
    const submitted = req.headers['x-csrf-token'];
    if (typeof submitted !== 'string' || !equal(submitted, this.csrf(identity.token))) throw new GameError('CSRF_DENIED', '安全令牌无效');
    return identity;
  }

  csrf(token: string): string {
    return createHmac('sha256', this.config.secret).update(`csrf:${token}`).digest('base64url');
  }

  epoch(id: string): string {
    const epoch = this.store.executorEpoch;
    const signature = createHmac('sha256', this.config.secret).update(`epoch:${id}:${epoch}`).digest('base64url');
    return `v1.${epoch}.${signature}`;
  }

  verifyEpoch(id: string, value: string): void {
    if (typeof value !== 'string' || !equal(value, this.epoch(id))) throw new GameError('COMMAND_EPOCH_CHANGED', '执行器已更新，请刷新页面');
  }

  async anonymous(req: FastifyRequest, reply: FastifyReply, requestId: string): Promise<{player: Player; recoveryCode?: string; csrfToken: string; commandEpoch: string}> {
    this.origin(req);
    if (!validRequestId(requestId)) throw new GameError('INVALID_INPUT', '请求标识无效');
    const existing = await this.authenticate(req).catch((error: unknown) => {
      if (error instanceof GameError && error.code === 'UNAUTHORIZED') return null;
      throw error;
    });
    if (existing) {
      const player = await this.store.player(existing.id);
      const initHash = hash(`init:${requestId}`);
      const row = (await this.store.pool.query('SELECT init_hash FROM accounts WHERE id=$1', [existing.id])).rows[0] as {init_hash: string} | undefined;
      const recoveryCode = row?.init_hash === initHash
        ? `cc-${createHmac('sha256', this.config.secret).update(`recovery:${requestId}`).digest('base64url')}` : undefined;
      return {player, ...(recoveryCode ? {recoveryCode} : {}), csrfToken: this.csrf(existing.token), commandEpoch: this.epoch(existing.id)};
    }

    // 初次响应丢失时用同一高熵请求 ID 复得账号与恢复码；数据库只保存哈希。
    const initHash = hash(`init:${requestId}`);
    const recoveryCode = `cc-${createHmac('sha256', this.config.secret).update(`recovery:${requestId}`).digest('base64url')}`;
    const token = randomBytes(32).toString('base64url');
    const account = await this.store.transaction(async tx => {
      let row = (await tx.client.query('SELECT id::text,state FROM accounts WHERE init_hash=$1 FOR UPDATE', [initHash])).rows[0] as {id: string; state: Player} | undefined;
      if (!row) {
        const id = randomUUID();
        const recentAfter = tx.now - 30 * 60 * 1000;
        const birthRow = (await tx.client.query("SELECT value FROM operations WHERE name='birthCounts' FOR UPDATE")).rows[0] as {value: Record<string, number[]>} | undefined;
        const counts = birthRow?.value ?? {};
        const candidates = BETA_MAP.spawns.map(spawn => ({spawn, times: (counts[spawn.id] ?? []).filter(time => time > recentAfter)}));
        candidates.sort((a, b) => a.times.length - b.times.length || a.spawn.id.localeCompare(b.spawn.id));
        const spawn = candidates[0]?.spawn;
        if (!spawn) throw new GameError('MAP_INVALID', '地图缺少出生点');
        counts[spawn.id] = [...candidates[0].times, tx.now];
        await tx.client.query("INSERT INTO operations(name,value) VALUES('birthCounts',$1) ON CONFLICT(name) DO UPDATE SET value=EXCLUDED.value", [counts]);
        const player = createPlayer(id, `玩家${id.slice(0, 6)}`, tx.now, spawn);
        await tx.client.query('INSERT INTO accounts(id,state,recovery_hash,init_hash,created_at) VALUES($1,$2,$3,$4,$5)',
          [id, player, hash(recoveryCode), initHash, tx.now]);
        row = {id, state: player};
      }
      await tx.client.query('INSERT INTO sessions(token_hash,account_id,expires_at) VALUES($1,$2,$3)', [hash(token), row.id, tx.now + PLAYER_TTL]);
      return row;
    });
    this.cookie(req, reply, token, false);
    return {player: account.state, recoveryCode, csrfToken: this.csrf(token), commandEpoch: this.epoch(account.id)};
  }

  async recover(req: FastifyRequest, reply: FastifyReply, recoveryCode: string, requestId: string): Promise<{player: Player; recoveryCode: string; csrfToken: string; commandEpoch: string}> {
    this.origin(req);
    if (typeof recoveryCode !== 'string' || !/^cc-[A-Za-z0-9_-]{43}$/.test(recoveryCode)) throw new GameError('RECOVERY_INVALID', '恢复码无效');
    if (!validRequestId(requestId)) throw new GameError('INVALID_INPUT', '请求标识无效');
    const rotatedCode = `cc-${randomBytes(32).toString('base64url')}`;
    const token = randomBytes(32).toString('base64url');
    const oldHash = hash(recoveryCode);
    const receipt = await this.store.transaction<SecretReceipt>(async tx => {
      const row = (await tx.client.query('SELECT id::text,state FROM accounts WHERE recovery_hash=$1 FOR UPDATE', [hash(recoveryCode)])).rows[0] as {id: string; state: Player} | undefined;
      if (!row) throw new GameError('RECOVERY_INVALID', '恢复码无效或已使用');
      await tx.client.query('UPDATE accounts SET recovery_hash=$1,init_hash=$2 WHERE id=$3', [hash(rotatedCode), hash(randomUUID()), row.id]);
      await tx.client.query('DELETE FROM sessions WHERE account_id=$1', [row.id]);
      await tx.client.query('INSERT INTO sessions(token_hash,account_id,expires_at) VALUES($1,$2,$3)', [hash(token), row.id, tx.now + PLAYER_TTL]);
      return {id: row.id, encryptedCode: this.encrypt(rotatedCode), encryptedToken: this.encrypt(token)};
    }, {actor: `recover:${oldHash}`, id: requestId, digest: hash(`recover:${oldHash}`)});
    const issuedToken = this.decrypt(receipt.encryptedToken!);
    const issuedCode = this.decrypt(receipt.encryptedCode);
    const active = await this.store.pool.query('SELECT 1 FROM sessions s JOIN accounts a ON a.id=s.account_id WHERE s.token_hash=$1 AND s.expires_at>$2 AND a.recovery_hash=$3',
      [hash(issuedToken), Date.now(), hash(issuedCode)]);
    if (!active.rowCount) throw new GameError('RECOVERY_ALREADY_REPLACED', '此恢复收据对应的会话已被后续恢复撤销');
    this.cookie(req, reply, issuedToken, false);
    return {player: await this.store.player(receipt.id), recoveryCode: issuedCode, csrfToken: this.csrf(issuedToken), commandEpoch: this.epoch(receipt.id)};
  }

  async rotateRecovery(req: FastifyRequest, requestId: string): Promise<{player: Player; recoveryCode: string; csrfToken: string; commandEpoch: string}> {
    const identity = await this.protect(req);
    if (!validRequestId(requestId)) throw new GameError('INVALID_INPUT', '请求标识无效');
    const rotatedCode = `cc-${randomBytes(32).toString('base64url')}`;
    const receipt = await this.store.transaction<SecretReceipt>(async tx => {
      const row = (await tx.client.query('SELECT state FROM accounts WHERE id=$1 FOR UPDATE', [identity.id])).rows[0] as {state: Player} | undefined;
      if (!row) throw new GameError('UNAUTHORIZED', '身份不存在');
      await tx.client.query('UPDATE accounts SET recovery_hash=$1,init_hash=$2 WHERE id=$3', [hash(rotatedCode), hash(randomUUID()), identity.id]);
      return {id: identity.id, encryptedCode: this.encrypt(rotatedCode)};
    }, {actor: identity.id, id: requestId, digest: hash('rotate-recovery')});
    const issuedCode = this.decrypt(receipt.encryptedCode);
    const current = await this.store.pool.query('SELECT 1 FROM accounts WHERE id=$1 AND recovery_hash=$2', [receipt.id, hash(issuedCode)]);
    if (!current.rowCount) throw new GameError('RECOVERY_ALREADY_REPLACED', '此恢复收据已被后续轮换取代');
    return {player: await this.store.player(receipt.id), recoveryCode: issuedCode, csrfToken: this.csrf(identity.token), commandEpoch: this.epoch(identity.id)};
  }

  async logout(req: FastifyRequest, reply: FastifyReply, admin = false): Promise<void> {
    const identity = await this.protect(req, admin);
    await this.store.pool.query(admin ? 'DELETE FROM admin_sessions WHERE token_hash=$1' : 'DELETE FROM sessions WHERE token_hash=$1', [hash(identity.token)]);
    reply.clearCookie(admin ? ADMIN_COOKIE : PLAYER_COOKIE, {path: '/'});
  }

  async revokeSessions(req: FastifyRequest, reply: FastifyReply): Promise<void> {
    const identity = await this.protect(req);
    await this.store.pool.query('DELETE FROM sessions WHERE account_id=$1', [identity.id]);
    reply.clearCookie(PLAYER_COOKIE, {path: '/'});
  }

  async adminLogin(req: FastifyRequest, reply: FastifyReply, password: string): Promise<{csrfToken: string; commandEpoch: string}> {
    this.origin(req);
    if (typeof password !== 'string' || !equal(hash(password), hash(this.config.adminPassword))) throw new GameError('UNAUTHORIZED', '管理员密码错误');
    const token = randomBytes(32).toString('base64url');
    await this.store.pool.query('INSERT INTO admin_sessions(token_hash,expires_at) VALUES($1,$2)', [hash(token), Date.now() + ADMIN_TTL]);
    this.cookie(req, reply, token, true);
    return {csrfToken: this.csrf(token), commandEpoch: this.epoch('admin')};
  }
}
