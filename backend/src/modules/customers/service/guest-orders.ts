/**
 * Guest buyers: orders placed without an account, the order look-up (rate limited) and emailed order links.
 */
import { createHmac } from 'node:crypto';
import type { Principal } from '../../../kernel/auth/index.js';
import { AppError } from '../../../kernel/errors/index.js';
import type { EventPayload } from '../../../kernel/events/index.js';
import { isUuid, newId } from '../../../kernel/lib/ids.js';
import type { PageRequest } from '../../../kernel/lib/pagination.js';
import { secretFor } from '../../../kernel/lib/secrets.js';
import type * as common from '../../../spec/common.js';
import type { GuestBuyerRow, GuestOrderAccess } from '../../../spec/customers.js';
import type * as identity from '../../../spec/identity.js';
import { normalizeEmail } from '../domain/rules.js';
import * as map from '../mappers.js';
import type { CustomersRepository } from '../repository.js';
import { type Core, HOUR } from './core.js';
import type { Admin } from './admin.js';

export class GuestOrders {
  constructor(
    readonly core: Core,
    readonly admin: Admin,
  ) {}

  private emailHash(email: string) {
    return createHmac('sha256', secretFor(this.core.ctx.config, 'customers.guest-lookup')).update(normalizeEmail(email)).digest('hex');
  }

  /** Per IP and per email, guestLookupAttemptsPerHour */
  private async limitLookups(emailHash: string, ip: string) {
    const limit = await this.core.ctx.settings.get('guestLookupAttemptsPerHour');
    const since = new Date(this.core.now().getTime() - HOUR);
    const [byEmail, byIp] = await Promise.all([this.core.repo.countLookupAttempts({ emailHash }, since), this.core.repo.countLookupAttempts({ ip }, since)]);
    if (byEmail >= limit || byIp >= limit) throw new AppError('RATE_LIMITED', 'Too many lookups; try again in an hour', { retryAfterSeconds: 3600 });
  }

  async lookupGuestOrder(principal: Principal, body: { orderRef: string; email: string }, ip: string): Promise<GuestOrderAccess> {
    const email = normalizeEmail(body.email);
    const hash = this.emailHash(email);
    await this.limitLookups(hash, ip);
    const orders = this.core.ctx.tryUse('orders');
    const ref = body.orderRef.trim().toUpperCase();
    const match = orders && ref ? await orders.findGuestOrder(ref, email) : null;
    const found = match?.orderId ? { orderId: match.orderId } : null;
    const guestSessionId = principal.kind === 'visitor' && isUuid(principal.sessionId) ? principal.sessionId : null;
    await this.core.repo.insertLookupAttempt({ id: newId(), email_hash: hash, ip, guest_session_id: guestSessionId, succeeded: !!found, order_id: found?.orderId ?? null, at: this.core.now() });
    // only guest orders open here (G29e): a registered customer's order asks to sign in, whatever email was given
    if (match?.signInRequired) throw this.core.ctx.error('GUEST_ORDER_SIGN_IN_REQUIRED', 'This order belongs to a Marketly account. Sign in to see it.');
    // the same answer whichever part was wrong
    if (!found) throw new AppError('GUEST_ORDER_NOT_FOUND', 'No order matches that order number and email');
    const identityApi = this.core.ctx.use('identity');
    let granted = false;
    let accessUntil = map.iso(this.core.now());
    if (guestSessionId) {
      const session = await identityApi.grantGuestOrderAccess(guestSessionId, found.orderId, email, 'lookup');
      granted = true;
      accessUntil = session.expiresAt;
    }
    const member = await identityApi.findAccountByEmail(email, 'member');
    return { orderId: found.orderId, orderRef: ref, granted, accessUntil, canCreateAccount: !member };
  }

  /** Always answers 202 so it cannot be used to probe which emails have orders */
  async sendGuestOrderLinks(body: { email: string }, ip: string): Promise<void> {
    const email = normalizeEmail(body.email);
    const hash = this.emailHash(email);
    await this.limitLookups(hash, ip);
    try {
      const orders = this.core.ctx.tryUse('orders');
      const list = orders ? await orders.listGuestOrdersByEmail(email) : [];
      await this.core.repo.insertLookupAttempt({ id: newId(), email_hash: hash, ip, guest_session_id: null, succeeded: list.length > 0, order_id: null, at: this.core.now() });
      if (!list.length) return;
      const identityApi = this.core.ctx.use('identity');
      const recent = [...list].sort((a, b) => b.placedAt.localeCompare(a.placedAt)).slice(0, 20);
      const links = await Promise.all(recent.map(async (o) => ({ ...o, ...(await identityApi.issueOrderLink(o.orderId, email, o.ref)) })));
      const first = links[0]!;
      await this.core.ctx.tryUse('notifications')?.notify({
        topic: 'customer.order.guest_link',
        recipients: [{ kind: 'guest_email', email }],
        context: { order: { ref: first.ref }, guest: { url: first.url }, orders: links.map((l) => ({ ref: l.ref, url: l.url, placedAt: l.placedAt, expiresAt: l.expiresAt })) },
        link: { kind: 'order', id: first.orderId, ref: first.ref, label: 'Open order', screen: 'account/order', url: first.url },
        dedupeKey: `guest-links:${hash}:${Math.floor(this.core.now().getTime() / (10 * 60_000))}`,
      });
    } catch (err) {
      this.core.ctx.log.warn({ err }, 'customers: guest order links not sent');
    }
  }

  async listGuestBuyers(query: { q?: string; orderedFrom?: string; orderedTo?: string }, page: PageRequest): Promise<common.Page<GuestBuyerRow>> {
    const p = await this.core.repo.listGuestBuyers({ q: query.q, orderedFrom: this.admin.dateFrom(query.orderedFrom), orderedTo: this.admin.dateTo(query.orderedTo) }, page);
    // support keeps no guest-buyer lookup, so open cases stay unknown (null) for guests
    return { ...p, items: p.items.map((g) => map.guestBuyer(g, null)) };
  }

  /** orders.order.placed: guest buyer row for guest checkouts; order count, spend and the used address's lastUsedAt for customers */
  async onOrderPlacedFromOrders(event: EventPayload<'orders.order.placed'>, eventId?: string): Promise<void> {
    const placedAt = new Date(event.placedAt);
    const c = event.customerId ? await this.core.repo.getCustomer(event.customerId) : undefined;
    if (event.customerId && !c) this.core.ctx.log.warn({ customerId: event.customerId, orderId: event.orderId, eventId }, 'customers: order for an unknown customer; ignored');
    const email = event.guestEmail ? normalizeEmail(event.guestEmail) : null;
    // a member with the guest email: orders attaches the order on verification, no guest buyer row
    const guest = email && !(await this.core.repo.findCustomerByEmail(email)) ? email : null;
    if (!c && !guest) return;
    // the saved address the order used comes in the payload (no orders lookup); only this customer's own address counts
    const used = c && event.deliveryAddressId ? await this.core.repo.getAddress(c.id, event.deliveryAddressId) : undefined;
    await this.core.repo.transaction(async (repo) => {
      // the claim commits with the counts: a second delivery of the same order changes nothing
      if (!(await repo.claim(`order-placed:${event.orderId}`))) return;
      if (c) {
        const cur = (await repo.getCustomer(c.id, { forUpdate: true }))!;
        const same = cur.order_count === 0 || cur.currency === event.total.currency;
        await repo.updateCustomer(cur.id, {
          order_count: cur.order_count + 1,
          total_spend_minor: same ? Number(cur.total_spend_minor) + event.total.amount : Number(cur.total_spend_minor),
          currency: cur.order_count === 0 ? event.total.currency : cur.currency,
          updated_at: this.core.now(),
        });
        if (used && (!used.last_used_at || used.last_used_at < placedAt)) await repo.updateAddress(used.id, { last_used_at: placedAt });
      }
      if (guest) await this.recordGuestOrder(repo, event, guest, event.contactName?.trim() || guest.split('@')[0]!);
    });
  }

  /** Guest buyer row for a guest checkout (inside the consumer's transaction) */
  private async recordGuestOrder(repo: CustomersRepository, event: EventPayload<'orders.order.placed'>, email: string, name: string) {
    const placedAt = new Date(event.placedAt);
    const g = await repo.getGuestBuyer(email, { forUpdate: true });
    if (!g) {
      await repo.insertGuestBuyer({
        id: newId(),
        email_normalized: email,
        email: event.guestEmail!,
        name,
        order_count: 1,
        total_spend: event.total.amount,
        currency: event.total.currency,
        first_order_at: placedAt,
        last_order_at: placedAt,
        last_order_id: event.orderId,
        last_order_ref: event.ref,
      });
      return;
    }
    if (g.last_order_id === event.orderId) return; // recorded before the inbox existed
    const later = placedAt >= g.last_order_at;
    await repo.updateGuestBuyer(g.id, {
      order_count: g.order_count + 1,
      total_spend: Number(g.total_spend) + (g.currency === event.total.currency ? event.total.amount : 0),
      first_order_at: placedAt < g.first_order_at ? placedAt : g.first_order_at,
      ...(later ? { last_order_at: placedAt, last_order_id: event.orderId, last_order_ref: event.ref, name, email: event.guestEmail! } : {}),
    });
  }
}
