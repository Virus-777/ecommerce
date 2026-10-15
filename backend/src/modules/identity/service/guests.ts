/**
 * Visitor sessions and order links: the guest orders a visitor session may see, and the emailed links that grant
 * them.
 */
import { AppError } from '../../../kernel/errors/index.js';
import { isUuid, newId } from '../../../kernel/lib/ids.js';
import type { GuestSession, OrderLinkRedemption } from '../../../spec/identity.js';
import { randomToken, tokenHash } from '../domain/crypto.js';
import { normalizeEmail } from '../domain/policy.js';
import { maskEmail } from '../domain/text.js';
import * as map from '../mappers.js';
import type { GuestSessionRow } from '../ports.js';
import type { IdentityRepository } from '../repository.js';
import { type Core, type Caller, DAY } from './core.js';

export class Guests {
  constructor(readonly core: Core) {}

  private async guestSession(g: GuestSessionRow, repo: IdentityRepository = this.core.repo): Promise<GuestSession> {
    return { id: g.id, createdAt: map.iso(g.created_at), expiresAt: map.iso(g.expires_at), orderIds: await repo.liveGrantOrderIds(g.id, this.core.now()) };
  }

  private liveGuest(g: GuestSessionRow | undefined, now: Date) {
    return g && !g.claimed_by_account_id && g.expires_at > now ? g : undefined;
  }

  /** Public API: let a guest session open one order */
  async grantGuestOrderAccess(guestSessionId: string, orderId: string, email: string, via: 'checkout' | 'lookup' | 'link'): Promise<GuestSession> {
    const s = await this.core.cfg();
    const now = this.core.now();
    const g = isUuid(guestSessionId) ? this.liveGuest(await this.core.repo.getGuestSession(guestSessionId), now) : undefined;
    if (!g) throw new AppError('NOT_FOUND', 'Guest session not found');
    await this.core.repo.upsertGrant({ guest_session_id: g.id, order_id: orderId, email_normalized: normalizeEmail(email), via, granted_at: now, expires_at: new Date(now.getTime() + s.guestOrderAccessDays * DAY) });
    await this.core.repo.updateGuestSession(g.id, { last_seen_at: now });
    return this.guestSession(g);
  }

  /** Public API: whether a guest session may open an order */
  async hasGuestOrderAccess(guestSessionId: string, orderId: string): Promise<boolean> {
    if (!isUuid(guestSessionId) || !isUuid(orderId)) return false;
    const now = this.core.now();
    const g = this.liveGuest(await this.core.repo.getGuestSession(guestSessionId), now);
    return Boolean(g) && (await this.core.repo.hasLiveGrant(guestSessionId, orderId, now));
  }

  /** Public API: emailed order link (token in the fragment; redeemed in the body) */
  async issueOrderLink(orderId: string, email: string, orderRef?: string): Promise<{ url: string; expiresAt: string }> {
    const s = await this.core.cfg();
    const now = this.core.now();
    const token = randomToken();
    const expiresAt = new Date(now.getTime() + s.orderLinkTtlDays * DAY);
    await this.core.repo.insertOrderLink({
      id: newId(),
      token_hash: tokenHash(token),
      order_id: orderId,
      order_ref: orderRef?.trim() || null,
      email_normalized: normalizeEmail(email),
      expires_at: expiresAt,
      last_redeemed_at: null,
      redeem_count: 0,
    });
    return { url: `${this.core.appUrl('store')}/orders/open#token=${token}`, expiresAt: map.iso(expiresAt) };
  }

  /**
   * POST /order-links/redeem: grants the caller's visitor session (or a new guest session) the order. A signed-in
   * customer gets the order without any guest access: a guest session would be one their app cannot use.
   */
  async redeemOrderLink(token: string, caller: Caller): Promise<OrderLinkRedemption> {
    const s = await this.core.cfg();
    const now = this.core.now();
    return this.core.repo.transaction(async (repo) => {
      const link = typeof token === 'string' && token.length >= 20 ? await repo.findOrderLinkByHash(tokenHash(token), { forUpdate: true }) : undefined;
      if (!link || link.expires_at <= now) throw new AppError('ORDER_LINK_INVALID', 'This order link has expired; use Guest order lookup');
      const found = { orderId: link.order_id, orderRef: link.order_ref ?? null, emailMasked: maskEmail(link.email_normalized) };
      const p = caller.principal;
      if (p?.kind === 'customer') {
        await repo.updateOrderLink(link.id, { last_redeemed_at: now, redeem_count: link.redeem_count + 1 });
        return { guestSession: null, ...found };
      }
      let g = p?.kind === 'visitor' && p.audience === 'store' && isUuid(p.sessionId) ? this.liveGuest(await repo.getGuestSession(p.sessionId, { forUpdate: true }), now) : undefined;
      if (!g) {
        g = {
          id: newId(),
          device_kind: 'web',
          created_at: now,
          last_seen_at: now,
          expires_at: new Date(now.getTime() + s.guestSessionTtlDays * DAY),
          claimed_by_account_id: null,
          claimed_at: null,
          audience: 'store',
          refresh_token_hash: tokenHash(randomToken('v.')),
          previous_token_hash: null,
          rotated_at: null,
        };
        await repo.insertGuestSession(g);
      }
      await repo.upsertGrant({ guest_session_id: g.id, order_id: link.order_id, email_normalized: link.email_normalized, via: 'link', granted_at: now, expires_at: new Date(now.getTime() + s.guestOrderAccessDays * DAY) });
      await repo.updateOrderLink(link.id, { last_redeemed_at: now, redeem_count: link.redeem_count + 1 });
      return { guestSession: await this.guestSession(g, repo), ...found };
    });
  }
}
