/**
 * Cart and checkout: evaluation (pure read), reservations that hold budget, usage and deal stock while
 * payment runs (atomic conditional updates, idempotent per checkout key), commits bound to order items,
 * releases, reversals after cancellations and refunds, and the funding split finance reads.
 */
import { createHash } from 'node:crypto';
import { AppError } from '../../../kernel/errors/index.js';
import type { EventPayload } from '../../../kernel/events/index.js';
import { newId } from '../../../kernel/lib/ids.js';
import type * as common from '../../../spec/common.js';
import type { CartEvaluation, CartEvaluationInput, FundingSplit, Redemption, RedemptionReservation, RefundShare, RejectedCode } from '../../../spec/promotions.js';
import { evaluate, type CouponCandidate, type EvalLine, type Hold, type PriceOption } from '../domain/evaluate.js';
import { flashItemMachine, redemptionMachine } from '../domain/state-machines.js';
import { COUPON_KINDS, m, moneyLabel, needsConsent, PRICE_KINDS, SHIPPING_KINDS, type CampaignModel } from '../domain/rules.js';
import { iso, toRedemption } from '../mappers.js';
import type { FlashItemRec, PromotionsRepository, RedemptionLineRec, RedemptionRec } from '../ports.js';
import { invalid, notFound, Part, SYSTEM, type By } from './core.js';

/** What an evaluation row keeps: the input, the answer and the holds a reservation takes */
export interface StoredEvaluation {
  input: CartEvaluationInput;
  customerKey: string | null;
  at: string;
  result: Omit<CartEvaluation, 'changes'>;
  holds: Hold[];
}

const sha = (s: string) => createHash('sha256').update(s).digest('hex');

/** A stable UUID (version 5 layout) from a name: the same evaluation and key give the same reservation */
export function stableUuid(name: string): string {
  const h = sha(name).slice(0, 32).split('');
  h[12] = '5';
  h[16] = '89ab'[parseInt(h[16]!, 16) % 4]!;
  const s = h.join('');
  return `${s.slice(0, 8)}-${s.slice(8, 12)}-${s.slice(12, 16)}-${s.slice(16, 20)}-${s.slice(20, 32)}`;
}

export const guestKey = (guestSessionId: string) => `guest:${sha(guestSessionId).slice(0, 40)}`;

export class CheckoutPart extends Part {
  /* ---------------------------------------------------------------- evaluation */

  isClippable = (c: CampaignModel) => Boolean(c.deals?.show && c.deals.section === 'coupons');
  /** Applies without a code or clip: no shared or unique codes and not a clip coupon */
  isAutomatic = (c: CampaignModel) => !c.code && !c.hasUniqueCodes && !this.isClippable(c);

  async lineAttrs(lines: CartEvaluationInput['lines']): Promise<EvalLine[]> {
    const out: EvalLine[] = [];
    for (const l of lines) {
      out.push({ ...l, attrs: { offerId: l.offerId, productId: l.productId, sellerId: l.sellerId, official: l.officialStore, categoryIds: await this.core.categoryChain(l.categoryId), brandId: l.brandId ?? null } });
    }
    return out;
  }

  async isNewCustomer(customerId: string): Promise<boolean | null> {
    const recent = await this.core.optional('orders', (o) => o.listRecentForCustomer(customerId, 1));
    if (recent) return recent.length === 0;
    const used = await this.repo.count('redemptions', { customer_id: customerId, state: ['committed', 'partially_reversed', 'reversed'] });
    return used ? false : null;
  }

  async evaluateCart(input: CartEvaluationInput): Promise<CartEvaluation> {
    const now = this.now();
    const at = input.at ? new Date(input.at) : now;
    if (Number.isNaN(at.getTime())) throw invalid([{ path: 'at', message: 'Not a date' }]);
    const issues = input.lines.flatMap((l, i) => [...(l.quantity < 0 ? [{ path: `lines.${i}.quantity`, message: 'Quantity cannot be negative' }] : []), ...(l.unitPrice.amount < 0 ? [{ path: `lines.${i}.unitPrice`, message: 'Price cannot be negative' }] : [])]);
    if (new Set(input.lines.map((l) => l.lineId)).size !== input.lines.length) issues.push({ path: 'lines', message: 'Line ids must be unique' });
    if (issues.length) throw invalid(issues);
    const currency = input.lines[0]?.unitPrice.currency ?? this.core.currency();
    const customerId = input.customerId ?? null;
    const customerKey = customerId ?? (input.guestSessionId ? guestKey(input.guestSessionId) : null);
    const lines = await this.lineAttrs(input.lines);

    // campaigns that may apply
    const running = await this.core.models(await this.repo.runningCampaigns(at));
    const priceCampaigns = running.filter((c) => PRICE_KINDS.includes(c.kind));
    const offerIds = lines.map((l) => l.offerId);
    const eligibleRows = await this.repo.eligibleFor(offerIds, priceCampaigns.map((c) => c.id));
    const flashRows = priceCampaigns.some((c) => c.kind === 'flash_sale') ? await this.repo.find('flash_items', { campaign_id: priceCampaigns.filter((c) => c.kind === 'flash_sale').map((c) => c.id), offer_id: offerIds }) : [];

    // coupon candidates: typed codes, clipped coupons, automatic offers
    const rejected: RejectedCode[] = [];
    const candidates: CouponCandidate[] = [];
    const typed = [...new Set(input.codes.map((c) => c.trim()).filter(Boolean))];
    const active = await this.repo.activeCodes(typed);
    const codeCampaignIds = [...new Set(active.map((c) => c.campaign_id))];
    const codeCampaigns = new Map((await this.core.models(await this.repo.getMany('campaigns', codeCampaignIds))).map((c) => [c.id, c]));
    const inactive = typed.length ? await this.repo.anyCodes(typed.filter((t) => !active.some((a) => a.code.toUpperCase() === t.toUpperCase()))) : [];
    for (const code of typed) {
      const row = active.find((a) => a.code.toUpperCase() === code.toUpperCase());
      const c = row ? codeCampaigns.get(row.campaign_id) : undefined;
      if (!row || !c) {
        const old = inactive.find((a) => a.code.toUpperCase() === code.toUpperCase());
        rejected.push(old ? { code, reason: 'expired', message: 'This code is no longer active.', details: [] } : { code, reason: 'not_found', message: "We couldn't find this code. Check the spelling.", details: [] });
        continue;
      }
      if (!COUPON_KINDS.includes(c.kind) && !SHIPPING_KINDS.includes(c.kind)) {
        rejected.push({ code, reason: 'not_found', message: "This code can't be used in the cart.", details: [] });
        continue;
      }
      candidates.push({ campaign: c, source: 'code', code, codeInfo: { id: row.id, code: row.code, kind: row.kind, maxRedemptions: row.max_redemptions, redemptions: row.redemptions, active: row.active, assignedCustomerId: row.assigned_customer_id } });
    }
    const couponKinds = (c: CampaignModel) => COUPON_KINDS.includes(c.kind) || SHIPPING_KINDS.includes(c.kind);
    if (customerId) {
      const clips = await this.repo.find('coupon_clips', { customer_id: customerId });
      const codes = new Map((await this.repo.getMany('coupon_codes', clips.map((c) => c.code_id).filter((x): x is string => Boolean(x)))).map((c) => [c.id, c]));
      for (const clip of clips) {
        const c = running.find((r) => r.id === clip.campaign_id);
        if (!c || !couponKinds(c)) continue;
        const cr = clip.code_id ? codes.get(clip.code_id) : undefined;
        candidates.push({ campaign: c, source: 'clipped', code: cr?.code ?? c.code, codeInfo: cr ? { id: cr.id, code: cr.code, kind: cr.kind, maxRedemptions: cr.max_redemptions, redemptions: cr.redemptions, active: cr.active, assignedCustomerId: cr.assigned_customer_id } : null });
      }
    }
    for (const c of running) if (couponKinds(c) && this.isAutomatic(c)) candidates.push({ campaign: c, source: 'automatic', code: null, codeInfo: null });

    const all = [...priceCampaigns, ...candidates.map((x) => x.campaign)];
    const ids = [...new Set(all.map((c) => c.id))];
    const consents = await this.parts.participation.consents(all.filter(needsConsent).map((c) => c.id));
    const usage = new Map<string, { uses: number; units: number }>();
    if (customerKey && ids.length) {
      // per campaign, and per flash item (`campaignId:offerId`) for deal purchase limits
      const keys = [customerKey, ...new Set(offerIds.map((o) => `${customerKey}:${o}`))];
      for (const u of await this.repo.find('usage_counters', { campaign_id: ids, customer_key: keys })) {
        usage.set(u.customer_key === customerKey ? u.campaign_id : `${u.campaign_id}:${u.customer_key.slice(customerKey.length + 1)}`, { uses: u.uses, units: u.units });
      }
    }
    const isNew = customerId && all.some((c) => c.eligibility.audience === 'new_customers') ? await this.isNewCustomer(customerId) : null;

    const priceOptions = new Map<string, PriceOption[]>();
    for (const line of lines) {
      const opts: PriceOption[] = [];
      for (const c of priceCampaigns) {
        if (!eligibleRows.some((e) => e.campaign_id === c.id && e.offer_id === line.offerId)) continue;
        let consentBps: number | null = null;
        if (!line.officialStore && needsConsent(c)) {
          const s = consents.get(c.id)?.get(line.sellerId);
          if (!s || !s.offerIds.has(line.offerId)) continue;
          consentBps = s.platformBps;
        }
        const f = c.kind === 'flash_sale' ? flashRows.find((x) => x.campaign_id === c.id && x.offer_id === line.offerId) : undefined;
        if (c.kind === 'flash_sale' && !f) continue;
        opts.push({ campaign: c, consentBps, flash: f ? { dealPrice: f.deal_price, dealStock: f.deal_stock, claimed: f.claimed, reserved: f.reserved, purchaseLimit: f.purchase_limit, state: f.state } : null });
      }
      priceOptions.set(line.lineId, opts);
    }

    const shipping = input.shipping ? Object.fromEntries(Object.entries(input.shipping).map(([k, v]) => [k, v.amount])) : null;
    const out = evaluate({
      at,
      currency,
      customerId,
      signedIn: Boolean(customerId),
      isNewCustomer: isNew,
      region: input.region ?? null,
      couponsPerPackage: Math.max(1, Number(await this.core.setting('couponsPerSellerPackage')) || 1),
      lines,
      shipping,
      priceOptions,
      coupons: candidates,
      rejected,
      usage,
      consents,
    });

    const ttl = await this.core.ttlMinutes();
    const evaluationId = newId();
    const validUntil = new Date(now.getTime() + ttl * 60_000);
    const result: Omit<CartEvaluation, 'changes'> = { evaluationId, validUntil: validUntil.toISOString(), lines: out.lines, packages: out.packages, applied: out.applied, rejected: out.rejected, totals: out.totals };
    const hash = sha(JSON.stringify({ c: customerKey, l: input.lines.map((l) => [l.lineId, l.offerId, l.quantity, l.unitPrice.amount]), k: typed.map((t) => t.toUpperCase()).sort(), r: input.region ?? null }));
    const previous = await this.repo.findOne('evaluations', { input_hash: hash }, { orderBy: [['valid_until', 'desc']] });
    const changes = previous ? this.changes((previous.result as unknown as StoredEvaluation).result, result, currency) : [];
    const stored: StoredEvaluation = { input, customerKey, at: at.toISOString(), result, holds: out.holds };
    await this.repo.insert('evaluations', { id: evaluationId, input_hash: hash, result: stored as never, valid_until: validUntil });
    return { ...result, changes };
  }

  /** Differences from the previous evaluation of the same cart, in words */
  changes(before: Omit<CartEvaluation, 'changes'>, after: Omit<CartEvaluation, 'changes'>, currency: string): string[] {
    const out: string[] = [];
    const name = (a: { label: string; code?: string | null }) => a.code ?? a.label;
    for (const a of before.applied) {
      const now = after.applied.find((x) => x.campaignId === a.campaignId);
      if (!now) {
        const why = after.rejected.find((r) => a.code && r.code.toUpperCase() === a.code.toUpperCase());
        out.push(`${name(a)} no longer applies${why ? `: ${why.message}` : ''}`);
      } else if (now.amount.amount !== a.amount.amount) out.push(`${name(a)} changed from ${moneyLabel(a.amount.amount, currency)} to ${moneyLabel(now.amount.amount, currency)}`);
    }
    for (const a of after.applied) if (!before.applied.some((x) => x.campaignId === a.campaignId)) out.push(`${name(a)} now applies`);
    return out;
  }

  /* ---------------------------------------------------------------- reservations */

  async storedEvaluation(evaluationId: string): Promise<{ stored: StoredEvaluation; validUntil: Date }> {
    const row = await this.repo.get('evaluations', evaluationId);
    if (!row) throw notFound('Evaluation');
    return { stored: row.result as unknown as StoredEvaluation, validUntil: new Date(row.valid_until) };
  }

  async reserve(evaluationId: string, idempotencyKey: string): Promise<RedemptionReservation> {
    if (!idempotencyKey?.trim()) throw invalid([{ path: 'idempotencyKey', message: 'An idempotency key is required' }]);
    const reservationId = stableUuid(`${evaluationId}:${idempotencyKey}`);
    const existing = await this.repo.find('redemptions', { reservation_id: reservationId });
    const ttl = await this.core.ttlMinutes();
    if (existing.length && existing.some((r) => r.state !== 'expired')) {
      const exp = existing.map((r) => r.expires_at).filter(Boolean).map((d) => new Date(d!).getTime());
      return { reservationId, evaluationId, expiresAt: new Date(exp.length ? Math.min(...exp) : this.now().getTime() + ttl * 60_000).toISOString() };
    }
    // the same checkout reserving a newer quote: the older hold goes back first
    for (const old of new Set((await this.repo.find('redemptions', { idempotency_key: idempotencyKey, state: 'reserved' })).map((r) => r.reservation_id))) {
      if (old !== reservationId) await this.release(old);
    }
    const { stored, validUntil } = await this.storedEvaluation(evaluationId);
    const now = this.now();
    if (validUntil.getTime() < now.getTime()) throw new AppError('CONFLICT', 'The quote has expired. Check the cart again.', { evaluationId });
    const expiresAt = new Date(now.getTime() + ttl * 60_000);
    const holds = [...stored.holds].sort((a, b) => a.campaignId.localeCompare(b.campaignId));
    const soldOut: FlashItemRec[] = [];
    const customerId = stored.input.customerId ?? null;
    await this.repo.transaction(async (tx) => {
      for (const h of holds) {
        const camp = await tx.get('campaigns', h.campaignId);
        const running = camp && ['scheduled', 'live'].includes(camp.status) && new Date(camp.starts_at).getTime() <= now.getTime() && now.getTime() < new Date(camp.ends_at).getTime();
        if (!running) throw this.ctx.error('COUPON_NOT_ELIGIBLE', `${camp?.name ?? 'A promotion'} is no longer available`, { reason: 'expired', campaignId: h.campaignId });
        const added = await tx.addCampaignUsage(h.campaignId, h.amount, 1);
        if (added === 'budget') throw this.ctx.error('BUDGET_EXHAUSTED', `${camp.name} has run out of budget`, { campaignId: h.campaignId });
        if (added !== 'ok') throw this.ctx.error('USAGE_LIMIT_REACHED', `${camp.name} has been fully used`, { campaignId: h.campaignId, limit: 'total' });
        if (stored.customerKey) {
          const u = await tx.addCustomerUsage(h.campaignId, stored.customerKey, 1, h.units, { perCustomer: camp.per_customer, perCustomerUnits: camp.kind === 'flash_sale' ? null : camp.per_customer_units });
          if (u === 'uses') throw this.ctx.error('USAGE_LIMIT_REACHED', `You've already used ${camp.name} the maximum number of times`, { campaignId: h.campaignId, limit: 'per_customer' });
          if (u === 'units') throw this.ctx.error('PURCHASE_LIMIT_EXCEEDED', `${camp.name} is limited to ${camp.per_customer_units} units per customer`, { campaignId: h.campaignId, limit: camp.per_customer_units });
        }
        if (h.codeId && !(await tx.addCodeRedemption(h.codeId))) throw this.ctx.error('USAGE_LIMIT_REACHED', 'This code has already been used', { campaignId: h.campaignId, limit: 'code' });
        for (const f of h.flash) {
          const row = await tx.reserveDealStock(h.campaignId, f.offerId, f.qty);
          if (!row) throw this.ctx.error('DEAL_SOLD_OUT', 'The flash deal is sold out. The regular offer is still available.', { campaignId: h.campaignId, offerId: f.offerId });
          if (stored.customerKey) {
            const u = await tx.addCustomerUsage(h.campaignId, `${stored.customerKey}:${f.offerId}`, 0, f.qty, { perCustomer: null, perCustomerUnits: row.purchase_limit });
            if (u !== 'ok') throw this.ctx.error('PURCHASE_LIMIT_EXCEEDED', `Limit ${row.purchase_limit} per customer at the deal price`, { campaignId: h.campaignId, offerId: f.offerId, limit: row.purchase_limit });
          }
          if (row.claimed + row.reserved >= row.deal_stock && row.state === 'active') {
            soldOut.push(await tx.update('flash_items', row.id, { state: this.core.step(flashItemMachine, row.state, 'sellOut'), sold_out_at: now }));
          }
        }
        const redemptionId = newId();
        await tx.insert('redemptions', {
          id: redemptionId,
          campaign_id: h.campaignId,
          code_id: h.codeId,
          reservation_id: reservationId,
          idempotency_key: idempotencyKey,
          evaluation_id: evaluationId,
          order_id: null,
          customer_id: customerId,
          guest_key: customerId ? null : stored.customerKey,
          state: redemptionMachine.initial,
          amount: h.amount,
          platform_part: h.platform,
          seller_part: h.seller,
          reversed: 0,
          currency: stored.result.totals.total.currency,
          expires_at: expiresAt,
          created_at: now,
        });
        if (h.lines.length) await tx.insertMany('redemption_lines', h.lines.map((l) => ({ redemption_id: redemptionId, line_id: l.lineId, order_item_id: null, offer_id: l.offerId, seller_id: l.sellerId, quantity: l.quantity, amount: l.amount, platform_part: l.platform, seller_part: l.seller, reversed: 0 })));
      }
    });
    for (const f of soldOut) this.core.publish('promotions.flash_item.sold_out', { campaignId: f.campaign_id, offerId: f.offer_id, at: now.toISOString() });
    for (const h of holds) await this.budgetWarning(h.campaignId, h.amount);
    return { reservationId, evaluationId, expiresAt: expiresAt.toISOString() };
  }

  /** promotions.budget.threshold_reached once, when budget use crosses budgetWarningPct */
  async budgetWarning(campaignId: string, added: number) {
    if (added <= 0) return;
    const row = await this.repo.get('campaigns', campaignId);
    if (!row || row.budget_amount === null || row.budget_amount <= 0) return;
    const pct = Number(await this.core.setting('budgetWarningPct')) || 90;
    const before = row.budget_used - added;
    if (before * 100 >= pct * row.budget_amount || row.budget_used * 100 < pct * row.budget_amount) return;
    if (await this.repo.findOne('campaign_log', { campaign_id: campaignId, action: 'budget.threshold_reached' })) return;
    await this.repo.transaction((tx) => this.core.log(tx, campaignId, 'budget.threshold_reached', { actor: SYSTEM }, `${pct}% of the budget used`));
    this.core.publish('promotions.budget.threshold_reached', { campaignId, budget: m(row.budget_amount, row.currency), used: m(row.budget_used, row.currency) });
  }

  async redemptionsView(rows: RedemptionRec[], repo: PromotionsRepository = this.repo): Promise<Redemption[]> {
    if (!rows.length) return [];
    const lines = await repo.find('redemption_lines', { redemption_id: rows.map((r) => r.id) });
    const codes = new Map((await repo.getMany('coupon_codes', rows.map((r) => r.code_id).filter((x): x is string => Boolean(x)))).map((c) => [c.id, c.code]));
    return rows.map((r) => toRedemption(r, { code: r.code_id ? (codes.get(r.code_id) ?? null) : null, orderRef: null, items: lines.filter((l) => l.redemption_id === r.id).reduce((a, l) => a + l.quantity, 0) }));
  }

  async commit(reservationId: string, orderId: string, orderItemIds: Record<string, string>, by: By = { actor: SYSTEM }): Promise<Redemption[]> {
    const rows = await this.repo.find('redemptions', { reservation_id: reservationId });
    if (!rows.length) return [];
    const done = rows.filter((r) => r.state !== 'reserved' && r.state !== 'expired');
    if (done.some((r) => r.order_id && r.order_id !== orderId)) throw new AppError('CONFLICT', 'This reservation is already used by another order', { reservationId });
    if (rows.every((r) => r.state === 'expired')) throw new AppError('CONFLICT', 'The reservation has expired. Check the cart again.', { reservationId });
    const committed: RedemptionRec[] = [];
    await this.repo.transaction(async (tx) => {
      for (const r of rows) {
        const cur = await tx.get('redemptions', r.id, { forUpdate: true });
        if (!cur || cur.state !== 'reserved') continue;
        const state = this.core.step(redemptionMachine, cur.state, 'commit');
        committed.push(await tx.update('redemptions', r.id, { state, order_id: orderId, expires_at: null }));
        const lines = await tx.find('redemption_lines', { redemption_id: r.id });
        for (const l of lines) {
          const item = orderItemIds[l.line_id];
          if (item) await tx.updateWhere('redemption_lines', { redemption_id: r.id, line_id: l.line_id }, { order_item_id: item });
        }
        const camp = await tx.get('campaigns', r.campaign_id);
        if (camp?.kind === 'flash_sale') for (const l of lines) if (l.quantity > 0) await tx.claimDealStock(r.campaign_id, l.offer_id, l.quantity);
      }
    });
    for (const r of committed) this.core.publish('promotions.coupon.redeemed', { redemptionId: r.id, campaignId: r.campaign_id, orderId, amount: m(r.amount, r.currency), platformPart: m(r.platform_part, r.currency), sellerPart: m(r.seller_part, r.currency) }, by);
    for (const id of new Set(committed.map((r) => r.campaign_id))) await this.parts.campaigns.endIfExhausted(id);
    return this.redemptionsView(await this.repo.find('redemptions', { reservation_id: reservationId }));
  }

  /** Gives held budget, usage and deal stock back; committed redemptions are untouched */
  async release(reservationId: string): Promise<void> {
    const rows = await this.repo.find('redemptions', { reservation_id: reservationId, state: 'reserved' });
    if (!rows.length) return;
    await this.repo.transaction(async (tx) => {
      for (const r of rows) {
        const cur = await tx.get('redemptions', r.id, { forUpdate: true });
        if (!cur || cur.state !== 'reserved') continue;
        await tx.update('redemptions', r.id, { state: this.core.step(redemptionMachine, cur.state, 'release'), expires_at: null });
        const lines = await tx.find('redemption_lines', { redemption_id: r.id });
        const camp = await tx.get('campaigns', r.campaign_id);
        const priceKind = camp && PRICE_KINDS.includes(camp.kind as never);
        const units = priceKind ? lines.reduce((a, l) => a + l.quantity, 0) : 0;
        await tx.subtractCampaignUsage(r.campaign_id, r.amount, 1);
        const key = r.customer_id ?? r.guest_key;
        if (key) await tx.subtractCustomerUsage(r.campaign_id, key, 1, units);
        if (r.code_id) await tx.subtractCodeRedemption(r.code_id);
        if (camp?.kind === 'flash_sale') {
          for (const l of lines) {
            if (l.quantity <= 0) continue;
            const f = await tx.releaseDealStock(r.campaign_id, l.offer_id, l.quantity);
            if (key) await tx.subtractCustomerUsage(r.campaign_id, `${key}:${l.offer_id}`, 0, l.quantity);
            if (f && f.state === 'sold_out' && f.claimed + f.reserved < f.deal_stock) await tx.update('flash_items', f.id, { state: this.core.step(flashItemMachine, f.state, 'restock'), sold_out_at: null });
          }
        }
      }
    });
  }

  /* ---------------------------------------------------------------- funding split and refunds */

  async committedLines(orderItemId: string): Promise<{ line: RedemptionLineRec; redemption: RedemptionRec }[]> {
    const lines = await this.repo.find('redemption_lines', { order_item_id: orderItemId });
    if (!lines.length) return [];
    const reds = new Map((await this.repo.getMany('redemptions', lines.map((l) => l.redemption_id))).map((r) => [r.id, r]));
    return lines
      .map((line) => ({ line, redemption: reds.get(line.redemption_id)! }))
      .filter((x) => x.redemption && ['committed', 'partially_reversed', 'reversed'].includes(x.redemption.state))
      .sort((a, b) => a.redemption.campaign_id.localeCompare(b.redemption.campaign_id));
  }

  async fundingSplitFor(orderItemId: string): Promise<FundingSplit> {
    const list = await this.committedLines(orderItemId);
    const cur = list[0]?.redemption.currency ?? this.core.currency();
    const campaigns = new Map((await this.repo.getMany('campaigns', list.map((x) => x.redemption.campaign_id))).map((c) => [c.id, c]));
    const codes = new Map((await this.repo.getMany('coupon_codes', list.map((x) => x.redemption.code_id).filter((x): x is string => Boolean(x)))).map((c) => [c.id, c.code]));
    const allocations = list.map(({ line, redemption }) => {
      const code = redemption.code_id ? (codes.get(redemption.code_id) ?? null) : null;
      return { campaignId: redemption.campaign_id, code, label: code ? `Coupon ${code}` : (campaigns.get(redemption.campaign_id)?.name ?? 'Promotion'), amount: m(line.amount, cur), platformPart: m(line.platform_part, cur), sellerPart: m(line.seller_part, cur) };
    });
    return {
      orderItemId,
      allocations,
      sellerFunded: m(
        allocations.reduce((a, x) => a + x.sellerPart.amount, 0),
        cur,
      ),
      platformFunded: m(
        allocations.reduce((a, x) => a + x.platformPart.amount, 0),
        cur,
      ),
    };
  }

  async refundShare(orderItemId: string, quantity: number): Promise<RefundShare> {
    if (!Number.isInteger(quantity) || quantity < 0) throw invalid([{ path: 'quantity', message: 'Quantity must be a whole number of units' }]);
    const list = await this.committedLines(orderItemId);
    const campaigns = new Map((await this.repo.getMany('campaigns', list.map((x) => x.redemption.campaign_id))).map((c) => [c.id, c]));
    const cur = list[0]?.redemption.currency ?? this.core.currency();
    let share = 0;
    let platform = 0;
    for (const { line } of list.filter((x) => COUPON_KINDS.includes((campaigns.get(x.redemption.campaign_id)?.kind ?? '') as never))) {
      const remaining = line.amount - line.reversed;
      if (remaining <= 0 || line.quantity <= 0) continue;
      const part = quantity >= line.quantity ? remaining : Math.min(remaining, Math.round((line.amount * quantity) / line.quantity));
      share += part;
      platform += line.amount ? Math.round((part * line.platform_part) / line.amount) : 0;
    }
    return { orderItemId, quantity, couponShare: m(share, cur), platformPart: m(platform, cur), sellerPart: m(share - platform, cur) };
  }

  /** Reverses `amountFor(line)` on each committed line of an order item; once per source event */
  async reverseItem(orderItemId: string, sourceId: string, amountFor: (line: RedemptionLineRec) => number, o: { restoreBudget: boolean; restoreUses: boolean; returnUnits: number; byLine?: boolean }): Promise<number> {
    const list = await this.committedLines(orderItemId);
    let total = 0;
    for (const { line, redemption } of list) {
      const key = `${sourceId}:${redemption.id}:${orderItemId}`;
      if (await this.repo.findOne('campaign_log', { campaign_id: redemption.campaign_id, action: 'redemption.reversed', reason: key })) continue;
      const amount = Math.min(Math.max(0, amountFor(line)), line.amount - line.reversed);
      const camp = await this.repo.get('campaigns', redemption.campaign_id);
      const units = o.returnUnits > 0 && camp && PRICE_KINDS.includes(camp.kind as never) ? Math.min(o.returnUnits, line.quantity) : 0;
      if (amount <= 0 && !units) continue;
      const result = await this.repo.transaction(async (tx) => {
        const red = await tx.get('redemptions', redemption.id, { forUpdate: true });
        if (!red || !['committed', 'partially_reversed'].includes(red.state)) return null;
        const reversed = red.reversed + amount;
        const state = amount > 0 ? this.core.step(redemptionMachine, red.state, reversed >= red.amount ? 'reverse' : 'partialReverse') : red.state;
        await tx.update('redemptions', red.id, { reversed, state });
        await tx.updateWhere('redemption_lines', { redemption_id: red.id, line_id: line.line_id }, { reversed: line.reversed + amount });
        const full = reversed >= red.amount;
        const restoreUse = o.restoreUses && full;
        if (o.restoreBudget || restoreUse) await tx.subtractCampaignUsage(red.campaign_id, o.restoreBudget ? amount : 0, restoreUse ? 1 : 0);
        const ck = red.customer_id ?? red.guest_key;
        if (ck && (restoreUse || units)) await tx.subtractCustomerUsage(red.campaign_id, ck, restoreUse ? 1 : 0, units);
        if (restoreUse && red.code_id) await tx.subtractCodeRedemption(red.code_id);
        if (units && camp?.kind === 'flash_sale') {
          const f = await tx.unclaimDealStock(red.campaign_id, line.offer_id, units);
          if (ck) await tx.subtractCustomerUsage(red.campaign_id, `${ck}:${line.offer_id}`, 0, units);
          if (f && f.state === 'sold_out' && f.claimed + f.reserved < f.deal_stock) await tx.update('flash_items', f.id, { state: this.core.step(flashItemMachine, f.state, 'restock'), sold_out_at: null });
        }
        await this.core.log(tx, red.campaign_id, 'redemption.reversed', { actor: SYSTEM }, key, { redemptionId: red.id, orderItemId, amount, units });
        return red;
      });
      if (!result || amount <= 0) continue;
      const platform = line.amount ? Math.round((amount * line.platform_part) / line.amount) : 0;
      this.core.publish('promotions.redemption.reversed', { redemptionId: redemption.id, orderItemId, amount: m(amount, redemption.currency), platformPart: m(platform, redemption.currency), sellerPart: m(amount - platform, redemption.currency) });
      total += amount;
    }
    return total;
  }

  /* ---------------------------------------------------------------- events consumed */

  async onOrderPlaced(e: EventPayload<'orders.order.placed'>) {
    const reserved = await this.repo.find('redemptions', { idempotency_key: e.checkoutSessionId, state: 'reserved' });
    for (const rid of new Set(reserved.map((r) => r.reservation_id))) {
      try {
        await this.commit(rid, e.orderId, {});
      } catch (err) {
        this.ctx.log.warn({ err, orderId: e.orderId }, 'promotions: could not commit the reservation of a placed order');
      }
    }
  }

  async onItemCancelled(e: EventPayload<'orders.item.cancelled'>) {
    const restore = Boolean(await this.core.setting('restoreUsageOnCancel'));
    await this.reverseItem(e.itemId, `cancel:${e.cancellationId}`, (line) => (e.quantity >= line.quantity ? line.amount - line.reversed : Math.round((line.amount * e.quantity) / Math.max(1, line.quantity))), {
      restoreBudget: true,
      restoreUses: restore && e.beforeDispatch,
      returnUnits: e.beforeDispatch ? e.quantity : 0,
    });
  }

  async onRefundApproved(e: EventPayload<'returns.refund.approved'>) {
    const restoreBudget = Boolean(await this.core.setting('refundRestoresBudget'));
    let share = Math.max(0, e.breakdown.discountShare.amount);
    // the coupon share of the refunded items, spread over their allocations by remaining value
    const perItem = await Promise.all(e.orderItemIds.map(async (id) => ({ id, lines: await this.committedLines(id) })));
    const remaining = perItem.reduce((a, x) => a + x.lines.reduce((b, l) => b + (l.line.amount - l.line.reversed), 0), 0);
    share = Math.min(share, remaining);
    for (const item of perItem) {
      const itemRemaining = item.lines.reduce((b, l) => b + (l.line.amount - l.line.reversed), 0);
      const itemShare = remaining ? Math.round((share * itemRemaining) / remaining) : 0;
      await this.reverseItem(item.id, `refund:${e.refundRequestId}`, (line) => (itemRemaining ? Math.round((itemShare * (line.amount - line.reversed)) / itemRemaining) : 0), { restoreBudget, restoreUses: false, returnUnits: 0 });
      for (const campaignId of new Set(item.lines.map((l) => l.redemption.campaign_id))) {
        const key = `refund:${e.refundRequestId}:${item.id}`;
        if (await this.repo.findOne('campaign_log', { campaign_id: campaignId, action: 'returned', reason: key })) continue;
        await this.repo.transaction((tx) => this.core.log(tx, campaignId, 'returned', { actor: e.approvedBy ?? SYSTEM }, key, { items: 1, orderItemId: item.id }));
      }
    }
  }

  async onPaymentFailed(e: EventPayload<'payments.payment.failed'>) {
    const reserved = await this.repo.find('redemptions', { idempotency_key: e.checkoutSessionId, state: 'reserved' });
    for (const rid of new Set(reserved.map((r) => r.reservation_id))) await this.release(rid);
  }

  /** Job: release reservations past expiresAt; drop old unused evaluations */
  async releaseExpired() {
    const now = this.now();
    for (const id of await this.repo.expiredReservations(now, 200)) await this.release(id);
    await this.repo.deleteStaleEvaluations(new Date(now.getTime() - 86_400_000), 500);
  }

}
