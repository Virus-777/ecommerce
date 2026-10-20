/**
 * Customer records and profiles: the customer behind an identity account (created on registration, kept in step
 * with email changes), the profile page, the account overview and whether the customer may order or message.
 */
import { SYSTEM_ACTOR } from '../../../kernel/auth/index.js';
import type { Scope } from '../../../kernel/auth/scope.js';
import { AppError, isAppError, isNotImplemented } from '../../../kernel/errors/index.js';
import type { EventPayload } from '../../../kernel/events/index.js';
import { dateInZone } from '../../../kernel/lib/clock.js';
import { isUuid, newId } from '../../../kernel/lib/ids.js';
import type {
  AccountOverview,
  CustomerProfile,
  CustomerSnapshot,
  OverviewAlert,
  OverviewTile,
  ProfileInput,
} from '../../../spec/customers.js';
import { cleanPhone, displayName, normalizeEmail } from '../domain/rules.js';
import { customerAccountStatusMachine } from '../domain/state-machines.js';
import * as map from '../mappers.js';
import type { CustomerRow, PreferencesRow } from '../ports.js';
import { type Core, type By, type PrefKey, PREFS, invalid, notFound, plural } from './core.js';

/** payment_failed alerts cover payments that failed in the last days */
const FAILED_PAYMENT_ALERT_DAYS = 7;

export class Profiles {
  constructor(readonly core: Core) {}

  /** The signed-in customer of an own-customer request (created from identity when the registration event has not arrived yet) */
  async ownCustomer(scope: Scope): Promise<CustomerRow> {
    if (scope.kind !== 'customer') throw new AppError('UNAUTHORIZED', 'Sign in to continue', { reason: 'sign_in_required' });
    const row =
      (scope.customerId ? await this.core.repo.getCustomer(scope.customerId) : undefined) ??
      (await this.core.repo.getCustomerByUserId(scope.accountId)) ??
      (await this.ensureCustomer(scope.accountId));
    if (!row) throw notFound('Customer profile');
    return row;
  }

  /** The customer of an identity account, created from the identity account if it is missing */
  async ensureCustomer(accountId: string): Promise<CustomerRow | undefined> {
    if (!isUuid(accountId)) return undefined;
    const existing = await this.core.repo.getCustomerByUserId(accountId);
    if (existing) return existing;
    const acct = await this.core.ctx.use('identity').getAccount(accountId);
    if (!acct || acct.realm !== 'member' || ['closed', 'disabled', 'invited'].includes(acct.status)) return undefined;
    const [first = '', ...rest] = acct.displayName.trim().split(/\s+/);
    const out = await this.createCustomer(
      { accountId, email: acct.email, firstName: first, lastName: rest.join(' '), marketingOptIn: false, emailVerifiedAt: acct.emailVerified ? this.core.now() : null },
      { actor: SYSTEM_ACTOR },
    );
    return out.row;
  }

  private async createCustomer(
    i: { accountId: string; email: string; firstName: string; lastName: string; marketingOptIn: boolean; emailVerifiedAt: Date | null },
    by: By,
  ): Promise<{ row: CustomerRow; created: boolean }> {
    const now = this.core.now();
    const id = newId();
    const email = normalizeEmail(i.email);
    const ref = await this.core.ctx.refs.next('CU', { digits: 6, daily: false });
    const out = await this.core.repo.transaction(async (repo) => {
      const inserted = await repo.insertCustomer({
        id,
        user_id: i.accountId,
        ref,
        first_name: i.firstName.trim().slice(0, 100),
        last_name: i.lastName.trim().slice(0, 100),
        email,
        email_verified_at: i.emailVerifiedAt,
        phone: null,
        phone_verified_at: null,
        account_status: customerAccountStatusMachine.initial,
        default_address_id: null,
        order_count: 0,
        total_spend_minor: 0,
        currency: this.core.ctx.config.market.currency,
        closed_at: null,
        created_at: now,
        updated_at: now,
      });
      if (!inserted) return { row: (await repo.getCustomerByUserId(i.accountId))!, created: false };
      const prefs: PreferencesRow = {
        customer_id: id,
        email_promotions: i.marketingOptIn,
        sms_promotions: false,
        push_promotions: false,
        wishlist_alerts: false,
        personalized_recommendations: true,
        recent_searches: true,
        updated_at: now,
      };
      await repo.upsertPreferences(prefs);
      await repo.insertConsent(
        (Object.keys(PREFS) as PrefKey[]).map((k) => ({
          id: newId(),
          customer_id: id,
          channel: PREFS[k][1],
          granted: prefs[PREFS[k][0]],
          source: 'registration',
          actor_kind: 'customer',
          actor_id: i.accountId,
          ip: null,
          at: now,
        })),
      );
      await repo.deleteGuestBuyer(email); // the guest moves to the customer list
      return { row: (await repo.getCustomer(id))!, created: true };
    });
    if (out.created) this.core.ctx.events.publish('customers.customer.created', { customerId: out.row.id, userId: i.accountId }, this.core.meta(by));
    return out;
  }

  /** Name, email, phone, account status and what the customer may do now */
  async getCustomer(customerId: string): Promise<CustomerSnapshot | null> {
    if (!isUuid(customerId)) return null;
    const s = await this.core.repo.standingById(customerId, this.core.now());
    return s ? map.snapshot(s) : null;
  }

  /** Resolve the customer for an identity session (the kernel calls this for every own-customer request, so it stays one lookup) */
  async getCustomerByUserId(userId: string): Promise<CustomerSnapshot | null> {
    if (!isUuid(userId)) return null;
    const s = await this.core.repo.standingByUserId(userId, this.core.now());
    return s ? map.snapshot(s) : null;
  }

  /** False while the account is suspended, closed or has an active ordering restriction */
  async canPlaceOrders(customerId: string): Promise<{ allowed: boolean; reason?: string }> {
    const s = isUuid(customerId) ? await this.core.repo.standingById(customerId, this.core.now()) : undefined;
    if (!s) return { allowed: false, reason: 'Customer not found' };
    const st = map.status(s.row);
    if (st === 'closed') return { allowed: false, reason: 'This account is closed' };
    if (st === 'suspended') return { allowed: false, reason: 'This account is suspended; existing orders stay available' };
    if (s.orderBlock) return { allowed: false, reason: 'New orders are paused on this account; existing orders stay available' };
    return { allowed: true };
  }

  /** False during an active messaging restriction. Replies inside open cases stay allowed (support decides). */
  async canSendMessages(customerId: string): Promise<{ allowed: boolean; reason?: string; until?: string }> {
    const s = isUuid(customerId) ? await this.core.repo.standingById(customerId, this.core.now()) : undefined;
    if (!s) return { allowed: false, reason: 'Customer not found' };
    const st = map.status(s.row);
    if (st === 'closed') return { allowed: false, reason: 'This account is closed' };
    if (st === 'suspended') return { allowed: false, reason: 'This account is suspended' };
    if (s.messageBlock) {
      return { allowed: false, reason: 'Sending new messages is paused on this account', ...(s.messageBlockUntil ? { until: map.iso(s.messageBlockUntil) } : {}) };
    }
    return { allowed: true };
  }

  /**
   * False while the account is suspended or closed, or has an active reviews (or account) restriction. Without a
   * customer record there is no restriction to apply (reviews checks the purchase itself).
   */
  async canWriteReviews(customerId: string): Promise<{ allowed: boolean; reason?: string }> {
    const s = isUuid(customerId) ? await this.core.repo.standingById(customerId, this.core.now()) : undefined;
    if (!s) return { allowed: true };
    const st = map.status(s.row);
    if (st === 'closed') return { allowed: false, reason: 'This account is closed' };
    if (st === 'suspended') return { allowed: false, reason: 'This account is suspended' };
    if (s.reviewBlock) return { allowed: false, reason: 'Reviews, questions and feedback are paused on this account' };
    return { allowed: true };
  }

  /**
   * Guest checkout with the email of a customer account that cannot place orders is refused too (otherwise an
   * ordering restriction is one sign-out away). The reason does not tell a stranger about the account.
   */
  async canGuestOrder(email: string): Promise<{ allowed: boolean; reason?: string }> {
    const c = email?.trim() ? await this.core.repo.findCustomerByEmail(email.trim().toLowerCase()) : undefined;
    if (!c || (await this.canPlaceOrders(c.id)).allowed) return { allowed: true };
    return { allowed: false, reason: 'Orders with this email can’t be placed as a guest. Sign in to your account, or contact support.' };
  }

  async getProfile(scope: Scope): Promise<CustomerProfile> {
    return this.profileOf(await this.ownCustomer(scope));
  }

  private async profileOf(c: CustomerRow): Promise<CustomerProfile> {
    return map.profile(c, await this.core.repo.listRestrictions(c.id, { activeAt: this.core.now() }), this.core.tz);
  }

  async updateProfile(scope: Scope, body: ProfileInput, by: By): Promise<CustomerProfile> {
    const c = await this.ownCustomer(scope);
    const patch: Partial<CustomerRow> = {};
    const fields: string[] = [];
    const name = (key: 'firstName' | 'lastName', col: 'first_name' | 'last_name', label: string) => {
      const raw = body[key];
      if (raw === undefined || raw === null) return;
      const v = raw.replace(/\s+/g, ' ').trim();
      if (!v) throw invalid(key, `Enter your ${label}`);
      if (v.length > 100) throw invalid(key, `Use at most 100 characters for your ${label}`);
      if (v !== c[col]) {
        patch[col] = v;
        fields.push(key);
      }
    };
    name('firstName', 'first_name', 'first name');
    name('lastName', 'last_name', 'last name');
    let newPhone: string | null = null;
    if (body.phone !== undefined) {
      const raw = body.phone?.trim() ?? '';
      const phone = raw ? cleanPhone(raw) : null;
      if (raw && !phone) throw invalid('phone', 'Enter a mobile number with country code, e.g. +1 503 555 0100');
      if (phone !== c.phone) {
        patch.phone = phone;
        patch.phone_verified_at = null; // a new number is unverified until identity confirms the code
        fields.push('phone');
        newPhone = phone;
      }
    }
    if (!fields.length) return this.profileOf(c);
    const row = await this.core.repo.updateCustomer(c.id, { ...patch, updated_at: this.core.now() });
    this.core.ctx.events.publish('customers.profile.updated', { customerId: c.id, fields }, this.core.meta(by));
    if (newPhone) {
      try {
        await this.core.ctx.use('identity').startPhoneVerification(c.user_id, newPhone);
      } catch (err) {
        // text message codes arrive with SMS (phase 2); until then the number stays unverified
        this.core.ctx.log.info({ code: isAppError(err) ? err.code : undefined, customerId: c.id }, 'customers: phone verification not started');
      }
    }
    return this.profileOf(row);
  }

  /** One source of the aggregate: answers within the budget, or is listed in `unavailable` */
  async gather<T>(key: string, missing: string[], budgetMs: number, call: (() => Promise<T>) | undefined): Promise<T | undefined> {
    if (!call) {
      missing.push(key);
      return undefined;
    }
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      return await Promise.race([
        call(),
        new Promise<never>((_, reject) => {
          timer = setTimeout(() => reject(new Error(`no answer within ${budgetMs} ms`)), budgetMs);
        }),
      ]);
    } catch (err) {
      if (!isNotImplemented(err)) this.core.ctx.log.warn({ err, source: key }, 'customers: overview source unavailable');
      missing.push(key);
      return undefined;
    } finally {
      clearTimeout(timer);
    }
  }

  async getAccountOverview(scope: Scope): Promise<AccountOverview> {
    const c = await this.ownCustomer(scope);
    const budget = await this.core.ctx.settings.get('overviewSourceTimeoutMs');
    const missing: string[] = [];
    const orders = this.core.ctx.tryUse('orders');
    const messaging = this.core.ctx.tryUse('messaging');
    const wallet = this.core.ctx.tryUse('wallet');
    // recent orders, open returns and cases are read with the alert sources
    const [progress, unread, credit, sources] = await Promise.all([
      this.gather('orders_in_progress', missing, budget, orders && (() => orders.countInProgress(c.id))),
      this.gather('unread_messages', missing, budget, messaging && (() => messaging.unreadCount({ kind: 'customer', id: c.id }))),
      this.gather('store_credit', missing, budget, wallet && (() => wallet.getBalance(c.id))),
      this.alertSources(c.id, missing, budget),
    ]);
    const { recent, openReturns, cases } = sources;

    const tiles: OverviewTile[] = [
      {
        key: 'orders_in_progress',
        count: progress?.inProgress ?? null,
        note: progress?.delayedPackages ? `${plural(progress.delayedPackages, 'package')} delayed` : null,
        available: progress !== undefined,
      },
      { key: 'open_returns', count: openReturns?.total ?? null, available: openReturns !== undefined },
      { key: 'unread_messages', count: unread ?? null, available: unread !== undefined },
      { key: 'store_credit', amount: credit?.available ?? null, available: credit !== undefined },
    ];

    const menuCounts: Record<string, number> = {};
    if (progress) menuCounts['account/orders'] = progress.inProgress;
    if (openReturns) menuCounts['account/returns'] = openReturns.total;
    if (unread !== undefined) menuCounts['account/messages'] = unread;

    const shownReturns = (openReturns?.items ?? []).slice(0, 2);
    const slugs = await this.productSlugs(shownReturns.map((r) => r.item?.productId).filter((id): id is string => !!id), budget);
    return {
      customer: { firstName: c.first_name, displayName: displayName(c.first_name, c.last_name), email: c.email, memberSince: dateInZone(c.created_at, this.core.tz) },
      tiles,
      alerts: this.alertsOf(sources),
      recentOrders: (recent ?? []).slice(0, 3).map((o) => ({ orderId: o.id, ref: o.ref, placedAt: o.placedAt, total: o.total, statusLabel: o.statusLabel, packageCount: o.packageCount, thumbnails: o.thumbnails ?? [], itemStates: o.itemStates ?? {} })),
      openCases: (cases?.items ?? []).slice(0, 3).map((k) => ({
        caseId: k.id,
        ref: k.ref,
        subject: k.subject,
        statusLabel: k.statusLabel,
        handledBy: k.handledBy?.name ?? null,
        nextUpdateBy: k.nextAction?.due?.dueAt ?? null,
        orderRef: k.orderRef ?? null,
        sellerName: k.handledBy?.kind === 'seller' ? k.handledBy.name : null,
      })),
      openReturns: shownReturns.map((r) => ({
        returnId: r.id,
        ref: r.ref,
        productTitle: r.item?.title ?? '',
        productId: r.item?.productId ?? null,
        productSlug: (r.item?.productId && slugs.get(r.item.productId)) || null,
        image: null,
        returnStatus: r.statusLabel,
        refundStatus: r.refundStatus ?? 'Requested',
      })),
      menuCounts,
      unavailable: [...new Set(missing)],
      generatedAt: map.iso(this.core.now()),
    };
  }

  /** The account overview's alerts on their own (GraphQL Customer.overviewAlerts): sources that do not answer are left out */
  async overviewAlerts(customerId: string): Promise<OverviewAlert[]> {
    const budget = await this.core.ctx.settings.get('overviewSourceTimeoutMs');
    return this.alertsOf(await this.alertSources(customerId, [], budget));
  }

  /** The sources the alerts (and the recent orders, open returns and cases lists) are read from, each within the budget */
  private async alertSources(customerId: string, missing: string[], budget: number) {
    const orders = this.core.ctx.tryUse('orders');
    const returns = this.core.ctx.tryUse('returns');
    const support = this.core.ctx.tryUse('support');
    const payments = this.core.ctx.tryUse('payments');
    const since = new Date(this.core.now().getTime() - FAILED_PAYMENT_ALERT_DAYS * 24 * 3_600_000).toISOString();
    const [recent, delayed, openReturns, cases, failedPayments] = await Promise.all([
      this.gather('recent_orders', missing, budget, orders && (() => orders.listRecentForCustomer(customerId, 3))),
      this.gather('delay_alerts', missing, budget, orders && (() => orders.listDelayedItemsForCustomer(customerId))),
      // more than the two listed, so a return waiting on the customer further down still raises its alert
      this.gather('open_returns', missing, budget, returns && (() => returns.listOpenForCustomer(customerId, 10))),
      this.gather('open_cases', missing, budget, support && (() => support.listOpenCasesForCustomer(customerId, 3))),
      this.gather('failed_payments', missing, budget, payments && (() => payments.listFailedPaymentsForCustomer(customerId, since))),
    ]);
    return { recent, delayed, openReturns, cases, failedPayments };
  }

  /** Alerts in a fixed order: delays, failed payments, payments being checked, returns and cases waiting on the customer */
  private alertsOf(s: Awaited<ReturnType<Profiles['alertSources']>>): OverviewAlert[] {
    const alerts: OverviewAlert[] = [];
    for (const d of s.delayed ?? []) {
      alerts.push({
        kind: 'item_delayed',
        title: `${d.title} is delayed`,
        body: `${d.sellerName} needs more time${d.newDispatchBy ? `; it should ship by ${dateInZone(new Date(d.newDispatchBy), this.core.tz)}` : ''}.`,
        orderId: d.orderId,
        orderRef: d.orderRef,
        caseRef: d.caseRef ?? null,
        actions: d.options,
      });
    }
    for (const p of s.failedPayments ?? []) {
      alerts.push({
        kind: 'payment_failed',
        title: p.orderRef ? `Payment for order ${p.orderRef} didn’t go through` : 'Your payment didn’t go through',
        body: `${p.message} The order was cancelled and nothing was charged.`,
        orderId: p.orderId ?? null,
        orderRef: p.orderRef ?? null,
        actions: ['view_order'],
      });
    }
    for (const o of s.recent ?? []) {
      if (o.status?.flags?.includes('payment_checking')) {
        alerts.push({ kind: 'payment_being_checked', title: 'We’re checking your payment', body: `Order ${o.ref} starts as soon as the payment is confirmed.`, orderId: o.id, orderRef: o.ref, actions: ['wait'] });
      }
    }
    for (const r of s.openReturns?.items ?? []) {
      // returns' customer labels: info_requested = Waiting for you, approved = Approved (send it back)
      if (r.status !== 'info_requested' && r.status !== 'approved') continue;
      const title = r.item?.title ?? 'your item';
      alerts.push({
        kind: 'return_action_needed',
        title: r.status === 'info_requested' ? `Return ${r.ref} is waiting on you` : `Send back ${title}`,
        body: r.nextStep || (r.status === 'info_requested' ? `${r.sellerName} asked a question about ${title}.` : `Your return ${r.ref} is approved; send the item back.`),
        orderId: r.orderId,
        orderRef: r.orderRef,
        returnRef: r.ref,
        actions: ['view_return'],
      });
    }
    for (const k of s.cases?.items ?? []) {
      if (k.nextAction?.youNeedToAct) {
        alerts.push({ kind: 'case_waiting_on_you', title: `Case ${k.ref} is waiting on you`, body: k.nextAction.label, caseRef: k.ref, orderRef: k.orderRef ?? null, orderId: k.orderId ?? null, actions: ['view_case'] });
      }
    }
    return alerts;
  }

  /** Current product slugs for product links, within the budget; empty when catalog is off or slow */
  private async productSlugs(productIds: string[], budget: number): Promise<Map<string, string>> {
    if (!productIds.length) return new Map();
    const catalog = this.core.ctx.tryUse('catalog');
    const rows = await this.gather('product_links', [], budget, catalog && (() => catalog.getProducts([...new Set(productIds)])));
    return new Map((rows ?? []).map((r) => [r.product.id, r.product.slug]));
  }

  /** identity.user.registered: profile, default preferences and the first consent rows; the guest buyer row goes */
  async onUserRegisteredFromIdentity(event: EventPayload<'identity.user.registered'>): Promise<void> {
    await this.createCustomer(
      { accountId: event.accountId, email: event.email, firstName: event.firstName, lastName: event.lastName, marketingOptIn: event.marketingOptIn, emailVerifiedAt: null },
      { actor: { kind: 'customer', id: event.accountId } },
    );
  }

  /** identity.user.verified: email or phone verified */
  async onUserVerifiedFromIdentity(event: EventPayload<'identity.user.verified'>): Promise<void> {
    const c = (await this.core.repo.getCustomerByUserId(event.accountId)) ?? (await this.ensureCustomer(event.accountId));
    if (!c) {
      this.core.ctx.log.info({ accountId: event.accountId }, 'customers: verification for an account without a customer profile; ignored');
      return;
    }
    const at = new Date(event.at);
    if (event.channel === 'email') {
      const email = normalizeEmail(event.email);
      if (c.email === email && c.email_verified_at) return;
      await this.core.repo.updateCustomer(c.id, { email, email_verified_at: at, updated_at: this.core.now() });
    } else {
      const phone = event.phone ?? c.phone;
      if (!phone || (c.phone === phone && c.phone_verified_at)) return;
      await this.core.repo.updateCustomer(c.id, { phone, phone_verified_at: at, updated_at: this.core.now() });
    }
  }

  /** identity.email.changed: mirrored email and its verification date */
  async onEmailChangedFromIdentity(event: EventPayload<'identity.email.changed'>): Promise<void> {
    const c = await this.core.repo.getCustomerByUserId(event.accountId);
    if (!c) return;
    const now = this.core.now();
    await this.core.repo.updateCustomer(c.id, { email: normalizeEmail(event.newEmail), email_verified_at: now, updated_at: now });
  }
}
