/**
 * Sessions: refresh-token rotation (with reuse detection), sign-out, staff idle checks, revocations for the
 * token verifiers, and the seller contexts a member may switch between.
 */
import type { Principal as KernelPrincipal } from '../../../kernel/auth/index.js';
import { AppError } from '../../../kernel/errors/index.js';
import { isUuid } from '../../../kernel/lib/ids.js';
import type { SellerContext, SessionTokens } from '../../../spec/identity.js';
import { randomToken, tokenHash } from '../domain/crypto.js';
import { lockInForce } from '../domain/policy.js';
import * as map from '../mappers.js';
import type { SessionRow } from '../ports.js';
import { type Core, type Caller, type WithCookie, KIND_OF, MIN, DAY, REVOCATION_OVERLAP_MS, seconds } from './core.js';
import type { Authentication } from './authentication.js';

export class Sessions {
  constructor(
    readonly core: Core,
    readonly authentication: Authentication,
  ) {}

  /**
   * Middleware check for refresh and sign-out (kernel/auth/authorities.ts). The previous token
   * still counts during the grace window (parallel refresh); outside it, reuse revokes the session.
   */
  async verifyRefreshToken(refreshToken: string): Promise<{ sessionId: string; accountId?: string; audience: string; kind: string } | null> {
    if (typeof refreshToken !== 'string' || refreshToken.length < 20 || refreshToken.length > 200) return null;
    // on every refresh and sign-out: read only the two settings this needs
    const [refreshReuseGraceSeconds, staffIdleMinutes] = await Promise.all([this.core.ctx.settings.get('refreshReuseGraceSeconds'), this.core.ctx.settings.get('staffIdleMinutes')]);
    const s = { refreshReuseGraceSeconds, staffIdleMinutes };
    const now = this.core.now();
    const hash = tokenHash(refreshToken);
    if (refreshToken.startsWith('v.')) {
      const g = await this.core.repo.findGuestSessionByRefreshHash(hash);
      if (!g || g.claimed_by_account_id || g.expires_at <= now) return null;
      if (g.refresh_token_hash !== hash) {
        if (!this.inGrace(g.rotated_at, s, now)) {
          await this.core.repo.updateGuestSession(g.id, { expires_at: now }); // reuse: the visitor session ends
          return null;
        }
      }
      return { sessionId: g.id, audience: g.audience, kind: 'visitor' };
    }
    const session = await this.core.repo.findSessionByRefreshHash(hash);
    if (!session || !this.sessionLive(session, s, now)) return null;
    if (session.refresh_token_hash !== hash && !this.inGrace(session.last_refreshed_at, s, now)) {
      await this.refreshReused(session, now);
      return null;
    }
    return { sessionId: session.id, accountId: session.account_id, audience: session.audience, kind: KIND_OF[session.audience] };
  }

  private inGrace(rotatedAt: Date | null, s: { refreshReuseGraceSeconds: number }, now: Date) {
    return Boolean(rotatedAt && now.getTime() - rotatedAt.getTime() <= s.refreshReuseGraceSeconds * 1000);
  }

  private sessionLive(x: SessionRow, s: { staffIdleMinutes: number }, now: Date) {
    return this.sessionState(x, s, now) === 'live';
  }

  /** Staff sessions go idle after staffIdleMinutes without a request (last_active_at, kept by touchStaffSession) */
  private sessionState(x: SessionRow, s: { staffIdleMinutes: number }, now: Date): 'live' | 'revoked' | 'expired' | 'idle' {
    if (x.revoked_at) return 'revoked';
    if (x.expires_at <= now || x.absolute_expires_at <= now) return 'expired';
    if (x.audience === 'admin' && now.getTime() - x.last_active_at.getTime() > s.staffIdleMinutes * MIN) return 'idle';
    return 'live';
  }

  /**
   * Middleware check on every admin request (kernel/auth/chain.ts, cached 5 s per server): the session is
   * live, and the request is activity that keeps it from going idle. The write happens at most once a
   * minute per session, so a busy staff member costs one indexed read per few seconds.
   */
  async touchStaffSession(sessionId: string): Promise<{ live: boolean; reason?: 'revoked' | 'expired' | 'idle' | 'unknown' }> {
    const session = await this.core.repo.getSession(sessionId);
    if (!session || session.audience !== 'admin') return { live: false, reason: 'unknown' };
    const now = this.core.now();
    const state = this.sessionState(session, { staffIdleMinutes: await this.core.ctx.settings.get('staffIdleMinutes') }, now);
    if (state !== 'live') return { live: false, reason: state };
    if (now.getTime() - session.last_active_at.getTime() >= MIN) await this.core.repo.updateSession(session.id, { last_active_at: now });
    return { live: true };
  }

  /** A rotated refresh token came back after the grace window: theft signal (docs/03 §5: no account lock) */
  private async refreshReused(session: SessionRow, now: Date) {
    await this.core.repo.transaction(async (repo) => {
      const ids = await repo.revokeSessions({ accountId: session.account_id, sessionIds: [session.id] }, 'refresh_token_reused', now);
      if (ids.length) await this.core.securityEvent(repo, session.account_id, 'refresh_token_reused', 'blocked', { audience: session.audience, device: await repo.getDevice(session.device_id) });
    });
  }

  /** POST /sessions/refresh: rotates the refresh token (same new pair within the grace window) */
  async refreshSession(refreshToken: string, via: 'cookie' | 'body', caller: Caller): Promise<WithCookie<SessionTokens>> {
    const s = await this.core.cfg();
    const now = this.core.now();
    const hash = tokenHash(refreshToken);
    const web = via === 'cookie';
    const wrap = (t: SessionTokens) => {
      const out = this.core.deliver({ tokens: t }, web, now);
      return { result: out.result.tokens!, cookie: out.cookie };
    };

    if (refreshToken.startsWith('v.')) {
      const out = await this.core.repo.transaction(async (repo) => {
        const g = await repo.findGuestSessionByRefreshHash(hash, { forUpdate: true });
        if (!g || g.claimed_by_account_id || g.expires_at <= now) return null;
        const current = g.refresh_token_hash === hash;
        if (!current && !this.inGrace(g.rotated_at, s, now)) return null;
        // the token that follows the presented one; for a parallel refresh in the grace window it is the current one
        const next = this.core.keys.nextRefreshToken(g.id, refreshToken);
        if (!current && tokenHash(next) !== g.refresh_token_hash) return null;
        const expires = new Date(now.getTime() + s.visitorRefreshDays * DAY);
        const patch = current
          ? { refresh_token_hash: tokenHash(next), previous_token_hash: hash, rotated_at: now, last_seen_at: now, expires_at: expires }
          : { last_seen_at: now };
        await repo.updateGuestSession(g.id, patch);
        return this.core.visitorTokens({ ...g, ...patch }, next, s);
      });
      if (!out) throw new AppError('REFRESH_TOKEN_INVALID', 'Sign in again');
      return wrap(out);
    }

    const out = await this.core.repo.transaction(async (repo): Promise<SessionTokens | AppError> => {
      const session = await repo.findSessionByRefreshHash(hash, { forUpdate: true });
      if (!session || !this.sessionLive(session, s, now)) return new AppError('REFRESH_TOKEN_INVALID', 'Sign in again');
      const current = session.refresh_token_hash === hash;
      const next = this.core.keys.nextRefreshToken(session.id, refreshToken);
      if (!current && (!this.inGrace(session.last_refreshed_at, s, now) || tokenHash(next) !== session.refresh_token_hash)) return new AppError('REFRESH_TOKEN_INVALID', 'Sign in again');
      let account = (await repo.getAccount(session.account_id, { forUpdate: true }))!;
      account = await this.authentication.liftExpiredLock(repo, account, now);
      // failed-sign-in locks only block new sign-ins; staff locks revoked the sessions already
      if (lockInForce(account, now) && account.locked_by) return new AppError('ACCOUNT_LOCKED', 'This account is locked', { lockedUntil: map.isoOrNull(account.locked_until), cause: 'staff_action' });
      if (account.status === 'disabled' || (account.status === 'closed' && session.audience !== 'seller')) return new AppError('ACCOUNT_DISABLED', 'This account is disabled');
      if (session.seller_id && session.audience === 'seller') {
        const access = await repo.getSellerAccess(account.id, session.seller_id);
        if (!access || access.revoked_at) return new AppError('REFRESH_TOKEN_INVALID', 'You no longer act for this seller; sign in again');
      }
      let row = session;
      if (current) {
        const patch = { refresh_token_hash: tokenHash(next), previous_token_hash: hash, last_refreshed_at: now, last_active_at: now };
        await repo.updateSession(session.id, patch);
        row = { ...session, ...patch };
        await repo.updateDevice(session.device_id, { last_active_at: now, last_ip: caller.client.ip });
        await repo.updateAccount(account.id, { last_active_at: now });
      }
      return this.core.sessionTokens(row, next, s);
    });
    if (out instanceof AppError) {
      // the middleware accepted the token a moment ago: it was revoked or rotated in between
      throw out;
    }
    return wrap(out);
  }

  /** POST /sessions/sign-out: ends the session the refresh token belongs to (idempotent) */
  async signOut(refreshToken: string, via: 'cookie' | 'body', caller: Caller): Promise<WithCookie<null>> {
    const now = this.core.now();
    const hash = tokenHash(refreshToken);
    if (refreshToken.startsWith('v.')) {
      const g = await this.core.repo.findGuestSessionByRefreshHash(hash);
      if (g && g.expires_at > now) await this.core.repo.updateGuestSession(g.id, { expires_at: now });
    } else {
      await this.core.repo.transaction(async (repo) => {
        const session = await repo.findSessionByRefreshHash(hash, { forUpdate: true });
        if (!session || session.revoked_at) return;
        const ids = await repo.revokeSessions({ accountId: session.account_id, sessionIds: [session.id] }, 'signOut', now);
        if (ids.length) await this.core.securityEvent(repo, session.account_id, 'signed_out', 'completed', { audience: session.audience, device: await repo.getDevice(session.device_id), client: caller.client });
      });
    }
    return { result: null, ...(via === 'cookie' ? { cookie: 'clear' as const } : {}) };
  }

  /** GET /session/sellers */
  async listSellerContexts(principal: KernelPrincipal): Promise<SellerContext[]> {
    const id = principal.accountId;
    if (!id || !isUuid(id)) return [];
    return (await this.core.repo.activeSellerAccess(id)).map(map.sellerContext);
  }

  /** POST /session/seller-context: re-issues the session's tokens bound to the chosen seller */
  async switchSellerContext(sellerId: string, caller: Caller): Promise<WithCookie<SessionTokens>> {
    const s = await this.core.cfg();
    const now = this.core.now();
    const a = await this.core.accountOf(caller.principal);
    const sid = caller.principal?.sessionId;
    const out = await this.core.repo.transaction(async (repo) => {
      const session = sid && isUuid(sid) ? await repo.getSession(sid, { forUpdate: true }) : undefined;
      if (!session || session.account_id !== a.id || !this.sessionLive(session, s, now)) throw new AppError('NOT_FOUND', 'Session not found');
      const access = await repo.getSellerAccess(a.id, sellerId);
      if (!access || access.revoked_at) throw new AppError('NO_SELLER_ACCESS', 'You cannot act for that seller');
      // new refresh token; the old one simply stops working (it is not kept as "previous", so a
      // stale copy in another tab is refused (the middleware answers 401 UNAUTHORIZED token_invalid) instead of ending the session)
      const refreshToken = randomToken('s.');
      const patch = {
        seller_id: access.seller_id,
        seller_member_id: access.seller_member_id,
        refresh_token_hash: tokenHash(refreshToken),
        previous_token_hash: null,
        last_refreshed_at: now,
      };
      await repo.updateSession(session.id, patch);
      await repo.updateSellerAccess(a.id, access.seller_id, { last_used_at: now });
      const device = await repo.getDevice(session.device_id);
      await this.core.securityEvent(repo, a.id, 'seller_context_switched', 'completed', { audience: 'seller', device, client: caller.client, detail: { sellerName: access.seller_name } });
      return { tokens: this.core.sessionTokens({ ...session, ...patch }, refreshToken, s), web: device?.kind === 'web' };
    });
    const d = this.core.deliver({ tokens: out.tokens }, out.web, now);
    return { result: d.result.tokens!, cookie: d.cookie };
  }

  /** Allow an account to sign in to Seller Center for this seller (called again to refresh the label) */
  async grantSellerContext(input: { accountId: string; sellerId: string; memberId: string; sellerName: string; roleLabel: string; isOwner: boolean }): Promise<void> {
    const now = this.core.now();
    await this.core.repo.transaction(async (repo) => {
      const a = isUuid(input.accountId) ? await repo.getAccount(input.accountId) : undefined;
      if (!a || a.realm !== 'member') throw new AppError('NOT_FOUND', 'Member account not found');
      const prior = await repo.getSellerAccess(a.id, input.sellerId);
      const fresh = !prior || prior.revoked_at !== null;
      await repo.upsertSellerAccess({
        account_id: a.id,
        seller_id: input.sellerId,
        seller_member_id: input.memberId,
        seller_name: input.sellerName,
        role_label: input.roleLabel,
        is_owner: input.isOwner,
        granted_at: fresh ? now : prior!.granted_at,
        revoked_at: null,
        last_used_at: prior?.last_used_at ?? null,
      });
      // a new membership (re-invited member): sessions bound to the old one end
      if (prior && prior.seller_member_id !== input.memberId) await repo.revokeSessions({ accountId: a.id, sellerId: input.sellerId }, 'membership_changed', now);
      if (fresh) await this.core.securityEvent(repo, a.id, 'seller_access_granted', 'completed', { audience: 'seller', actor: { kind: 'system' }, detail: { sellerName: input.sellerName, role: input.roleLabel } });
    });
  }

  /** Remove seller access and revoke sessions bound to that seller */
  async revokeSellerContext(accountId: string, sellerId: string, reason: string): Promise<void> {
    const now = this.core.now();
    await this.core.repo.transaction(async (repo) => {
      const access = isUuid(accountId) ? await repo.getSellerAccess(accountId, sellerId) : undefined;
      if (!access || access.revoked_at) return;
      await repo.updateSellerAccess(accountId, sellerId, { revoked_at: now });
      const ids = await repo.revokeSessions({ accountId, sellerId }, 'seller_access_revoked', now);
      await this.core.securityEvent(repo, accountId, 'seller_access_revoked', 'completed', { audience: 'seller', actor: { kind: 'system' }, reason, detail: { sellerName: access.seller_name, sessions: ids.length } });
    });
  }

  /** Sign an account out everywhere (or in one area) */
  async revokeSessions(accountId: string, reason: string, audience?: 'store' | 'seller' | 'admin'): Promise<number> {
    if (!isUuid(accountId)) return 0;
    const now = this.core.now();
    return this.core.repo.transaction(async (repo) => {
      if (!(await repo.getAccount(accountId))) return 0;
      const ids = await this.core.revoke(repo, { accountId, audience }, reason, now, !audience);
      await this.core.securityEvent(repo, accountId, audience ? 'session_revoked' : 'signed_out_everywhere', 'completed', { audience: audience ?? null, actor: { kind: 'system' }, reason, detail: { sessions: ids.length } });
      return ids.length;
    });
  }

  /**
   * Revoked sessions and account-wide revocations since a cursor. Without a cursor: the last
   * access-token lifetime. Polled by every server every few seconds.
   */
  async revocationsSince(cursor?: string): Promise<{ sessions: { sessionId: string; at: string }[]; accounts: { accountId: string; validAfter: string }[]; cursor: string }> {
    const now = this.core.now();
    let since: Date;
    const parsed = cursor ? Date.parse(cursor) : NaN;
    if (Number.isFinite(parsed)) since = new Date(parsed - REVOCATION_OVERLAP_MS);
    else since = new Date(now.getTime() - ((await this.core.ctx.settings.get('accessTokenTtlMinutes')) + 1) * MIN);
    const [sessions, guests, accounts] = await Promise.all([this.core.repo.revokedSessionsSince(since), this.core.repo.claimedGuestSessionsSince(since), this.core.repo.accountRevocationsSince(since)]);
    return {
      sessions: [...sessions, ...guests].map((x) => ({ sessionId: x.id, at: map.iso(x.at) })),
      accounts: accounts.map((x) => ({ accountId: x.id, validAfter: map.iso(x.at) })),
      cursor: map.iso(now),
    };
  }
}
