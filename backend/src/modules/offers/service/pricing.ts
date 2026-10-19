/**
 * Prices: price history (the single source for honest was-prices), seller price changes (with the
 * large-change confirmation), Official Store price changes (scheduled, approval-gated through access,
 * reverted at endsAt), the schedule job and the nightly was-price check.
 */
import { AppError, isAppError } from '../../../kernel/errors/index.js';
import { isUuid, newId } from '../../../kernel/lib/ids.js';
import type { PageRequest } from '../../../kernel/lib/pagination.js';
import type * as catalog from '../../../spec/catalog.js';
import type * as common from '../../../spec/common.js';
import type { CompareAtInput, PriceChange, PriceChangeRequest, PriceChangeResult, SellerPriceItem } from '../../../spec/offers.js';
import { changePct, formatMoney, listPriceOnFile, lowestInWindow, verifyLowestBasis, type PriceSpan } from '../domain/rules.js';
import { priceChangeMachine } from '../domain/state-machines.js';
import { actorOf, iso, isoReq, money } from '../mappers.js';
import type { OfferRec, PriceChangeRec } from '../ports.js';
import type { OffersRepository } from '../repository.js';
import { invalidField, notFound, Part, SYSTEM, type By, type ProductCache } from './core.js';

/** Offers per batch of the was-price job */
const VERIFY_BATCH = 500;

export const APPROVAL_ACTION = 'offers.prices.change';
const OPEN_STATES = ['scheduled', 'pending_approval'];

type Source = 'seller' | 'seller_bulk' | 'official' | 'official_bulk';

export class PricingPart extends Part {
  /* ================================================================ history */

  async history(offerId: string, repo: OffersRepository = this.repo): Promise<PriceSpan[]> {
    const rows = await repo.find('offer_price_history', { offer_id: offerId }, { orderBy: [['valid_from', 'asc']] });
    return rows.map((h) => ({ price: Number(h.price_amount), from: h.valid_from, to: h.valid_to }));
  }

  /** When the current price started (the sale start for a was-price on the current price) */
  saleStartOf(row: OfferRec, history: readonly PriceSpan[]): Date {
    const current = [...history].reverse().find((h) => h.to === null);
    return current?.from ?? row.updated_at;
  }

  /**
   * Checks a was-price. lowest_30_days: the offer's own price history must cover the look-back window
   * before the sale and the was-price may not exceed the lowest price charged in it. list_price: the
   * manufacturer list price catalog staff set on the variant (never the product specs). Unverifiable →
   * WAS_PRICE_NOT_VERIFIED.
   */
  async verifyCompareAt(c: CompareAtInput, price: common.Money, o: { product: catalog.ProductAdmin | null; variantId: string; history: readonly PriceSpan[]; saleStart: Date }): Promise<{ amount: common.Money; basis: CompareAtInput['basis'] }> {
    if (c.amount.currency !== this.core.currency || !Number.isInteger(c.amount.amount) || c.amount.amount <= 0) throw invalidField('compareAt.amount', `Enter the was-price in ${this.core.currency}`);
    if (c.amount.amount <= price.amount) throw this.core.error('WAS_PRICE_NOT_VERIFIED', 'The was-price must be higher than the price', { basis: c.basis });
    if (c.basis === 'list_price') {
      const list = listPriceOnFile(o.product?.product, o.variantId, this.core.currency);
      if (list === null) throw this.core.error('WAS_PRICE_NOT_VERIFIED', 'There is no manufacturer list price on file for this product', { basis: c.basis });
      if (c.amount.amount > list) throw this.core.error('WAS_PRICE_NOT_VERIFIED', `The was-price is above the list price on file (${formatMoney(this.core.money(list))})`, { basis: c.basis, listPrice: this.core.money(list) });
      return { amount: c.amount, basis: c.basis };
    }
    const days = await this.core.lookbackDays();
    const check = verifyLowestBasis(o.history, c.amount.amount, o.saleStart, days);
    if (!check.verified) {
      throw this.core.error('WAS_PRICE_NOT_VERIFIED', check.reason ?? 'The was-price is not supported by this offer\'s price history', { basis: c.basis, lookbackDays: days, lowest: check.lowest === null ? null : this.core.money(check.lowest) });
    }
    return { amount: c.amount, basis: c.basis };
  }

  async lowestPrice(offerId: string, sinceDays: number, before?: string): Promise<common.Money | null> {
    const row = isUuid(offerId) ? await this.repo.get('offers', offerId) : undefined;
    if (!row) return null;
    const end = before ? new Date(before) : this.now();
    if (Number.isNaN(end.getTime())) throw invalidField('before', 'Not a date-time');
    const days = Math.max(0, Number(sinceDays) || 0);
    const low = lowestInWindow(await this.history(offerId), new Date(end.getTime() - days * 86_400_000), end);
    return low === null ? null : money(low, row.currency);
  }

  async priceRange(offerId: string, sinceDays: number) {
    const row = isUuid(offerId) ? await this.repo.get('offers', offerId) : undefined;
    if (!row) return null;
    const end = this.now();
    const start = new Date(end.getTime() - Math.max(0, Number(sinceDays) || 0) * 86_400_000);
    const spans = (await this.history(offerId)).filter((s) => s.from < end && (!s.to || s.to > start));
    if (!spans.length) return null;
    const prices = spans.map((s) => s.price);
    const lowest = Math.min(...prices);
    const highest = Math.max(...prices);
    const current = Number(row.price_amount);
    return { lowest: money(lowest, row.currency), highest: money(highest, row.currency), current: money(current, row.currency), unchanged: lowest === highest && highest === current };
  }

  /* ================================================================ applying a price */

  /**
   * In a transaction on the locked offer: closes the price in force, opens the new one, stops older
   * pending reverts and bumps termsVersion when the offer has been published.
   */
  private async applyTx(tx: OffersRepository, offer: OfferRec, change: { id: string; to: number; compareAt: { amount: number; basis: string } | null; saleEndsAt: Date | null; actor: common.Actor }): Promise<OfferRec> {
    const now = this.now();
    await tx.updateWhere('offer_price_history', { offer_id: offer.id, valid_to: null }, { valid_to: now });
    await tx.insert('offer_price_history', {
      id: newId(),
      offer_id: offer.id,
      price_amount: change.to,
      compare_at_amount: change.compareAt?.amount ?? null,
      valid_from: now,
      valid_to: null,
      price_change_id: change.id,
      actor_kind: change.actor.kind,
      actor_id: change.actor.id ?? null,
    });
    // a newer price supersedes the revert an older change was waiting for
    for (const old of await tx.find('price_changes', { offer_id: offer.id, state: 'applied', revert_to_amount: { op: 'is not', value: null } })) {
      if (old.id !== change.id) await tx.update('price_changes', old.id, { revert_to_amount: null });
    }
    return tx.update('offers', offer.id, {
      price_amount: change.to,
      compare_at_amount: change.compareAt?.amount ?? null,
      compare_at_basis: change.compareAt?.basis ?? null,
      compare_at_verified: Boolean(change.compareAt),
      sale_ends_at: change.saleEndsAt,
      terms_version: offer.published_at ? offer.terms_version + 1 : offer.terms_version,
      updated_at: now,
    });
  }

  private announce(before: OfferRec, after: OfferRec, changeId: string | null, by: By) {
    this.core.publish(
      'offers.offer.price_changed',
      {
        offerId: after.id,
        productId: after.product_id,
        variantId: after.variant_id,
        sellerId: after.seller_id,
        ownerType: after.owner_type,
        from: money(before.price_amount, before.currency),
        to: money(after.price_amount, after.currency),
        compareAt: after.compare_at_amount !== null && after.compare_at_verified ? money(after.compare_at_amount, after.currency) : null,
        priceChangeId: changeId,
        termsVersion: after.terms_version,
      },
      by,
    );
  }

  private async pendingFor(offerId: string): Promise<PriceChangeRec | undefined> {
    return this.repo.findOne('price_changes', { offer_id: offerId, state: OPEN_STATES });
  }

  private pendingError(p: PriceChangeRec) {
    return this.core.error('PRICE_CHANGE_PENDING', 'Another price change is scheduled or waiting for approval for this offer. Cancel it first.', { priceChangeId: p.id });
  }

  /* ================================================================ seller prices */

  async largeThreshold(): Promise<number> {
    const v = Number(await this.core.setting('largeSellerPriceChangePct'));
    return Number.isFinite(v) && v > 0 ? v : 50;
  }

  /**
   * One seller price change, applied now. Large changes on a published offer need confirmLarge; a new
   * was-price is checked against the history before now; a new price without one drops the old was-price
   * (every was-price claim is checked against the price it is shown with).
   */
  /** LARGE_PRICE_CHANGE_UNCONFIRMED when a published offer's price moves more than largeSellerPriceChangePct (checked before anything is saved) */
  async assertLargeChangeConfirmed(row: OfferRec, price: common.Money) {
    if (!row.published_at) return;
    const from = Number(row.price_amount);
    const pct = changePct(from, price.amount);
    if (Math.abs(pct) > (await this.largeThreshold())) {
      throw this.core.error('LARGE_PRICE_CHANGE_UNCONFIRMED', `This changes the price by ${pct}%. Confirm large price changes to apply it.`, { offers: [{ offerId: row.id, from: money(from, row.currency), to: price, changePct: pct }] });
    }
  }

  async changeSellerPrice(
    row: OfferRec,
    item: { price: common.Money; compareAt?: CompareAtInput | null; saleEndsAt?: string | null },
    by: By,
    o: { confirmLarge: boolean; source: Source; product?: catalog.ProductAdmin | null; bulkJobId?: string | null },
  ): Promise<{ offer: OfferRec; change: PriceChangeRec }> {
    if (row.status === 'removed') throw new AppError('ILLEGAL_TRANSITION', 'Removed offers cannot change price', { from: 'removed', event: 'priceChange' });
    const pending = await this.pendingFor(row.id);
    if (pending) throw this.pendingError(pending);
    const product = o.product !== undefined ? o.product : await this.core.productAdmin(row.product_id);
    await this.parts.manage.checkPrice(item.price, product?.product.categoryId ?? null);
    const from = Number(row.price_amount);
    const pct = changePct(from, item.price.amount);
    if (row.published_at && !o.confirmLarge && Math.abs(pct) > (await this.largeThreshold())) {
      throw this.core.error('LARGE_PRICE_CHANGE_UNCONFIRMED', `This changes the price by ${pct}%. Confirm large price changes to apply it.`, { offers: [{ offerId: row.id, from: money(from, row.currency), to: item.price, changePct: pct }] });
    }
    const history = await this.history(row.id);
    let compareAt: { amount: number; basis: string } | null = null;
    if (item.compareAt) {
      const v = await this.verifyCompareAt(item.compareAt, item.price, { product, variantId: row.variant_id, history, saleStart: this.now() });
      compareAt = { amount: v.amount.amount, basis: v.basis };
    }
    if (item.saleEndsAt) this.parts.manage.checkSaleEnd(item.saleEndsAt);
    const saleEndsAt = compareAt ? (item.saleEndsAt !== undefined ? (item.saleEndsAt ? new Date(item.saleEndsAt) : null) : row.sale_ends_at) : null;
    const id = newId();
    const now = this.now();
    const { before, after, change } = await this.repo.transaction(async (tx) => {
      const locked = await this.core.offerRow(row.id, { repo: tx, forUpdate: true });
      if (locked.status === 'removed') throw new AppError('ILLEGAL_TRANSITION', 'Removed offers cannot change price', { from: 'removed', event: 'priceChange' });
      const change = await tx.insert('price_changes', {
        id,
        offer_id: row.id,
        from_amount: Number(locked.price_amount),
        to_amount: item.price.amount,
        change_pct: changePct(Number(locked.price_amount), item.price.amount).toFixed(2),
        compare_at_amount: compareAt?.amount ?? null,
        compare_at_basis: compareAt?.basis ?? null,
        starts_at: null,
        ends_at: saleEndsAt,
        revert_to_amount: saleEndsAt ? Number(locked.price_amount) : null,
        reason: null,
        source: o.source,
        bulk_job_id: o.bulkJobId ?? null,
        state: priceChangeMachine.next('requested', 'apply'),
        approval_request_id: null,
        requested_by_kind: by.actor.kind,
        requested_by_id: by.actor.id ?? null,
        decided_at: null,
        applied_at: now,
        created_at: now,
      });
      const after = await this.applyTx(tx, locked, { id, to: item.price.amount, compareAt, saleEndsAt, actor: by.actor });
      return { before: locked, after, change };
    });
    this.announce(before, after, id, by);
    await this.core.markDirty([after.variant_id]);
    return { offer: after, change };
  }

  /** POST /price-changes (seller): each item on its own; large changes refuse the whole call unless confirmed */
  async changeOwnPrices(sellerId: string, body: { items: SellerPriceItem[]; confirmLargeChange?: boolean | null }, by: By): Promise<{ results: PriceChangeResult[] }> {
    const max = Number(await this.core.setting('maxSelectedPriceChanges')) || 100;
    if (!body.items?.length) throw invalidField('items', 'Choose at least one offer');
    if (body.items.length > max) throw invalidField('items', `Change up to ${max} prices at a time`);
    const ids = body.items.map((i) => i.offerId);
    if (new Set(ids).size !== ids.length) throw invalidField('items', 'Each offer can appear once');
    const rows = new Map((await this.repo.getMany('offers', ids.filter(isUuid))).filter((r) => r.owner_type === 'seller' && r.seller_id === sellerId).map((r) => [r.id, r]));
    if (!body.confirmLargeChange) {
      const threshold = await this.largeThreshold();
      const large = body.items
        .map((i) => ({ i, r: rows.get(i.offerId) }))
        .filter(({ i, r }) => r && r.published_at && r.status !== 'removed' && i.price.currency === r.currency && Math.abs(changePct(Number(r.price_amount), i.price.amount)) > threshold)
        .map(({ i, r }) => ({ offerId: r!.id, from: money(r!.price_amount, r!.currency), to: i.price, changePct: changePct(Number(r!.price_amount), i.price.amount) }));
      if (large.length) throw this.core.error('LARGE_PRICE_CHANGE_UNCONFIRMED', `${large.length} price change${large.length === 1 ? ' is' : 's are'} above ${threshold}%. Confirm to apply them.`, { offers: large });
    }
    const results: PriceChangeResult[] = [];
    for (const item of body.items) {
      const row = rows.get(item.offerId);
      if (!row) {
        results.push({ offerId: item.offerId, ok: false, change: null, error: { code: 'NOT_FOUND', message: 'Offer not found' } });
        continue;
      }
      try {
        const { change } = await this.changeSellerPrice(row, { price: item.price, compareAt: item.compareAt, saleEndsAt: item.saleEndsAt }, by, { confirmLarge: true, source: 'seller' });
        results.push({ offerId: item.offerId, ok: true, change: (await this.toPriceChanges([change]))[0]!, error: null });
      } catch (err) {
        if (!isAppError(err) || err.status >= 500) throw err;
        results.push({ offerId: item.offerId, ok: false, change: null, error: { code: err.code, message: err.message, ...(err.details !== undefined ? { details: err.details } : {}) } });
      }
    }
    return { results };
  }

  /* ================================================================ Official Store prices */

  /**
   * Within the caller's price-change limit (access) the change is applied now or scheduled; above it,
   * it waits for approval. The price reverts at endsAt.
   */
  async requestOfficial(id: string, body: PriceChangeRequest, by: By, o: { source?: Source; bulkJobId?: string | null } = {}): Promise<PriceChangeRec> {
    const row = await this.core.officialRow(id);
    if (row.status === 'removed') throw new AppError('ILLEGAL_TRANSITION', 'Removed offers cannot change price', { from: 'removed', event: 'priceChange' });
    if (!body.reason?.trim()) throw invalidField('reason', 'Give the reason for the price change');
    const pending = await this.pendingFor(row.id);
    if (pending) throw this.pendingError(pending);
    const product = await this.core.productAdmin(row.product_id);
    if (body.price.currency !== this.core.currency || !Number.isInteger(body.price.amount) || body.price.amount <= 0) throw invalidField('price', `Enter a price above zero in ${this.core.currency}`);
    const now = this.now();
    const startsAt = body.startsAt ? new Date(body.startsAt) : null;
    const endsAt = body.endsAt ? new Date(body.endsAt) : null;
    if (endsAt && endsAt <= (startsAt && startsAt > now ? startsAt : now)) throw invalidField('endsAt', 'The end must be after the start');
    if (body.price.amount === Number(row.price_amount) && !body.compareAt) throw invalidField('price', 'The new price is the same as the current price');
    let compareAt: { amount: number; basis: string } | null = null;
    if (body.compareAt) {
      const v = await this.verifyCompareAt(body.compareAt, body.price, { product, variantId: row.variant_id, history: await this.history(row.id), saleStart: startsAt && startsAt > now ? startsAt : now });
      compareAt = { amount: v.amount.amount, basis: v.basis };
    }
    const from = Number(row.price_amount);
    const pct = changePct(from, body.price.amount);

    // authority comes from access only (granting offers.official.price does not raise the limit)
    const access = this.ctx.tryUse('access');
    let decision: 'allowed' | 'approval_required' = 'allowed';
    let note: string | null = null;
    if (access) {
      if (!by.principal) throw new AppError('FORBIDDEN', 'A staff member must request Official Store price changes');
      const check = await access.check(by.principal as never, APPROVAL_ACTION, { number: Math.abs(pct) });
      if (check.decision === 'denied') throw new AppError('FORBIDDEN', check.reason, { action: APPROVAL_ACTION });
      decision = check.decision;
      note = check.reason;
    }
    const changeId = newId();
    let change = await this.repo.insert('price_changes', {
      id: changeId,
      offer_id: row.id,
      from_amount: from,
      to_amount: body.price.amount,
      change_pct: pct.toFixed(2),
      compare_at_amount: compareAt?.amount ?? null,
      compare_at_basis: compareAt?.basis ?? null,
      starts_at: startsAt,
      ends_at: endsAt,
      revert_to_amount: endsAt ? from : null,
      reason: body.reason.trim(),
      source: o.source ?? 'official',
      bulk_job_id: o.bulkJobId ?? null,
      state: 'requested',
      approval_request_id: null,
      requested_by_kind: by.actor.kind,
      requested_by_id: by.actor.id ?? null,
      decided_at: null,
      applied_at: null,
      created_at: now,
    });
    if (decision === 'approval_required') {
      const approval = await access!.requestApproval({
        action: APPROVAL_ACTION,
        target: { type: 'price_change', id: changeId, ref: row.seller_sku, label: `${row.seller_sku}: ${formatMoney(money(from, row.currency))} → ${formatMoney(body.price)}`, sellerId: null, screen: 'admin/official' },
        amount: body.price,
        quantity: null,
        summary: `Official Store price change ${formatMoney(money(from, row.currency))} → ${formatMoney(body.price)} (${pct > 0 ? '+' : ''}${pct}%) on ${row.seller_sku}`,
        details: { offerId: row.id, from: money(from, row.currency), to: body.price, changePct: pct, startsAt: body.startsAt ?? null, endsAt: body.endsAt ?? null },
        reason: body.reason.trim(),
        requestedBy: by.principal as never,
      });
      change = await this.repo.update('price_changes', changeId, { state: priceChangeMachine.next('requested', 'requestApproval'), approval_request_id: approval.id });
    } else if (startsAt && startsAt > now) {
      change = await this.repo.update('price_changes', changeId, { state: priceChangeMachine.next('requested', 'schedule') });
    } else {
      change = await this.applyChange(change, 'apply', by);
    }
    if (o.source !== 'official_bulk') {
      await this.core.audit(
        {
          action: 'offers.official.price_change',
          actionLabel: 'Changed an Official Store price',
          category: 'catalog',
          target: this.parts.manage.target(row),
          reason: body.reason,
          before: { price: money(from, row.currency) },
          after: { price: body.price, compareAt: compareAt ? money(compareAt.amount, row.currency) : null, startsAt: body.startsAt ?? null, endsAt: body.endsAt ?? null, state: change.state, changePct: pct },
          approvalRequestId: change.approval_request_id,
          approvalNote: decision === 'allowed' ? note : null,
        },
        by,
      );
    }
    return change;
  }

  /** requested|scheduled → applied: the new price takes effect now */
  async applyChange(change: PriceChangeRec, event: 'apply' | 'start', by: By): Promise<PriceChangeRec> {
    const result = await this.repo.transaction(async (tx) => {
      const locked = (await tx.get('price_changes', change.id, { forUpdate: true }))!;
      const state = priceChangeMachine.next(locked.state as never, event as never);
      const offer = await this.core.offerRow(locked.offer_id, { repo: tx, forUpdate: true });
      if (offer.status === 'removed') {
        return { skipped: await tx.update('price_changes', locked.id, { state: priceChangeMachine.next(locked.state === 'scheduled' ? 'scheduled' : 'pending_approval', 'cancel'), decided_at: this.now(), reason: `${locked.reason ?? ''} (offer removed)`.trim() }) };
      }
      const from = Number(offer.price_amount);
      const keepCompare = locked.compare_at_amount !== null ? { amount: Number(locked.compare_at_amount), basis: locked.compare_at_basis! } : null;
      const after = await this.applyTx(tx, offer, { id: locked.id, to: Number(locked.to_amount), compareAt: keepCompare, saleEndsAt: keepCompare ? locked.ends_at : null, actor: actorOf(locked.requested_by_kind, locked.requested_by_id) });
      const updated = await tx.update('price_changes', locked.id, { state, applied_at: this.now(), revert_to_amount: locked.ends_at ? from : null, from_amount: from });
      return { before: offer, after, updated };
    });
    if ('skipped' in result) return result.skipped!;
    this.announce(result.before, result.after, change.id, by);
    await this.core.markDirty([result.after.variant_id]);
    return result.updated;
  }

  /** applied → reverted at endsAt: back to revertTo, the sale's was-price ends */
  private async revert(change: PriceChangeRec): Promise<void> {
    const result = await this.repo.transaction(async (tx) => {
      const locked = (await tx.get('price_changes', change.id, { forUpdate: true }))!;
      if (locked.state !== 'applied' || locked.revert_to_amount === null) return null;
      const offer = await this.core.offerRow(locked.offer_id, { repo: tx, forUpdate: true });
      const state = priceChangeMachine.next('applied', 'revert');
      if (offer.status === 'removed') {
        await tx.update('price_changes', locked.id, { state, revert_to_amount: locked.revert_to_amount });
        return null;
      }
      const after = await this.applyTx(tx, offer, { id: locked.id, to: Number(locked.revert_to_amount), compareAt: null, saleEndsAt: null, actor: SYSTEM });
      await tx.update('price_changes', locked.id, { state, revert_to_amount: locked.revert_to_amount });
      return { before: offer, after };
    });
    if (!result) return;
    this.announce(result.before, result.after, change.id, { actor: SYSTEM });
    await this.core.markDirty([result.after.variant_id]);
  }

  async cancel(id: string, reasonText: string, by: By): Promise<PriceChangeRec> {
    if (!reasonText?.trim()) throw invalidField('reason', 'Give the reason for cancelling');
    const change = isUuid(id) ? await this.repo.get('price_changes', id) : undefined;
    if (!change) throw notFound('Price change');
    const updated = await this.repo.transaction(async (tx) => {
      const locked = (await tx.get('price_changes', id, { forUpdate: true }))!;
      const state = priceChangeMachine.next(locked.state as never, 'cancel');
      return tx.update('price_changes', id, { state, decided_at: this.now(), reason: [locked.reason, `Cancelled: ${reasonText.trim()}`].filter(Boolean).join(' · ') });
    });
    if (change.approval_request_id) {
      await this.core.optional('access', 'cancelApproval', (a) => a.cancelApproval(change.approval_request_id!, by.actor, reasonText.trim()));
    }
    if (change.bulk_job_id) await this.bulkRowOutcome(change, 'skipped');
    const offer = await this.repo.get('offers', change.offer_id);
    await this.core.audit(
      { action: 'offers.price_change.cancel', actionLabel: 'Cancelled a price change', category: 'catalog', target: offer ? this.parts.manage.target(offer) : { type: 'price_change', id }, reason: reasonText, before: { state: change.state }, after: { state: updated.state } },
      by,
    );
    return updated;
  }

  /** access.approval.decided for offers.prices.change */
  async onApprovalDecided(e: { requestId: string; actionKey: string; outcome: string; decidedBy?: common.Actor | null }) {
    if (e.actionKey !== APPROVAL_ACTION) return;
    const change = await this.repo.findOne('price_changes', { approval_request_id: e.requestId });
    if (!change) {
      this.ctx.log.info({ requestId: e.requestId }, 'offers: approval decided for an unknown price change, ignored');
      return;
    }
    if (change.state !== 'pending_approval') return; // already decided (event delivered twice)
    const by: By = { actor: e.decidedBy ?? SYSTEM };
    if (e.outcome !== 'approved') {
      const event = e.outcome === 'rejected' ? 'reject' : 'cancel';
      await this.repo.update('price_changes', change.id, { state: priceChangeMachine.next('pending_approval', event), decided_at: this.now() });
      if (change.bulk_job_id) await this.bulkRowOutcome(change, 'skipped');
      return;
    }
    const scheduled = await this.repo.update('price_changes', change.id, { state: priceChangeMachine.next('pending_approval', 'approve'), decided_at: this.now() });
    if (!scheduled.starts_at || scheduled.starts_at <= this.now()) {
      try {
        await this.applyChange(scheduled, 'start', by);
      } catch (err) {
        if (!isAppError(err) || err.status >= 500) throw err;
        this.ctx.log.warn({ err, priceChangeId: change.id }, 'offers: approved price change could not start');
      }
    }
    if (change.bulk_job_id) await this.bulkRowOutcome(change, 'applied');
  }

  private async bulkRowOutcome(change: PriceChangeRec, result: 'applied' | 'skipped') {
    const row = await this.repo.findOne('bulk_update_rows', { job_id: change.bulk_job_id!, offer_id: change.offer_id, result: 'pending_approval' });
    if (row) await this.repo.updateBulkRow(row.job_id, row.row_no, { result });
  }

  /* ================================================================ jobs */

  /** offers.apply-price-schedule: start due changes, revert ended ones */
  async applySchedule(): Promise<void> {
    const now = this.now();
    for (let round = 0; round < 20; round++) {
      const due = (await this.repo.find('price_changes', { state: 'scheduled' }, { orderBy: [['starts_at', 'asc']], limit: 200 })).filter((c) => !c.starts_at || c.starts_at <= now);
      if (!due.length) break;
      for (const c of due) {
        try {
          await this.applyChange(c, 'start', { actor: SYSTEM });
        } catch (err) {
          this.ctx.log.error({ err, priceChangeId: c.id }, 'offers: scheduled price change failed to start');
        }
      }
      if (due.length < 200) break;
    }
    // applied changes whose revert was superseded by a newer price (revert_to_amount cleared) simply end
    const ending = await this.repo.find('price_changes', { state: 'applied', ends_at: { op: '<=', value: now }, revert_to_amount: { op: 'is not', value: null } }, { orderBy: [['ends_at', 'asc']], limit: 500 });
    for (const c of ending) {
      try {
        await this.revert(c);
      } catch (err) {
        this.ctx.log.error({ err, priceChangeId: c.id }, 'offers: price revert failed');
      }
    }
  }

  /**
   * offers.verify-compare-at: drop was-prices whose basis no longer holds and tell the owner (offers.offer.updated).
   * Walks every live offer with a was-price by id, 500 at a time.
   */
  async verifyCompareAtJob(): Promise<void> {
    const days = await this.core.lookbackDays();
    const now = this.now();
    const cache = new Map();
    for (let after: string | null = null; ; ) {
      const rows: OfferRec[] = await this.repo.find('offers', { compare_at_amount: { op: 'is not', value: null }, status: { op: '<>', value: 'removed' }, ...(after ? { id: { op: '>', value: after } } : {}) }, { orderBy: [['id', 'asc']], limit: VERIFY_BATCH });
      for (const row of rows) await this.recheckCompareAt(row, days, now, cache);
      if (rows.length < VERIFY_BATCH) return;
      after = rows.at(-1)!.id;
    }
  }

  /** One offer of the was-price job: dropped when its basis no longer holds */
  private async recheckCompareAt(row: OfferRec, days: number, now: Date, cache: ProductCache): Promise<void> {
    let holds = row.compare_at_verified;
    if (holds && row.sale_ends_at && row.sale_ends_at <= now) holds = false;
    if (holds && row.compare_at_basis === 'list_price') {
      const product = await this.core.productAdmin(row.product_id, cache);
      const list = listPriceOnFile(product?.product, row.variant_id, this.core.currency);
      holds = list !== null && Number(row.compare_at_amount) <= list;
    }
    if (holds && row.compare_at_basis === 'lowest_30_days') {
      const history = await this.history(row.id);
      const start = this.saleStartOf(row, history);
      const check = verifyLowestBasis(history, Number(row.compare_at_amount), start, days);
      // a sale price in force longer than the look-back window has become the regular price
      holds = check.verified && now.getTime() - start.getTime() <= days * 86_400_000;
    }
    if (holds) return;
    const after = await this.repo.transaction(async (tx) => {
      const locked = await this.core.offerRow(row.id, { repo: tx, forUpdate: true });
      if (locked.compare_at_amount === null) return null;
      await tx.updateWhere('offer_price_history', { offer_id: row.id, valid_to: null }, { compare_at_amount: null });
      return tx.update('offers', row.id, {
        compare_at_amount: null,
        compare_at_basis: null,
        compare_at_verified: false,
        sale_ends_at: null,
        terms_version: locked.published_at ? locked.terms_version + 1 : locked.terms_version,
        updated_at: now,
      });
    });
    if (!after) return;
    if (after.published_at) this.core.publish('offers.offer.updated', { offerId: after.id, productId: after.product_id, termsVersion: after.terms_version, fields: ['compareAt'] });
    await this.core.markDirty([after.variant_id]);
  }

  /* ================================================================ views */

  async listChanges(query: { state?: string; offerId?: string; ownerType?: 'official' | 'seller' }, page: PageRequest) {
    const p = await this.repo.listPriceChanges({ ...(query.state ? { states: [query.state] } : {}), ...(query.offerId ? { offerId: query.offerId } : {}), ...(query.ownerType ? { ownerType: query.ownerType } : {}) }, page);
    return { ...p, items: await this.toPriceChanges(p.items) };
  }

  async changesFor(offerId: string, limit = 50): Promise<PriceChange[]> {
    return this.toPriceChanges(await this.repo.find('price_changes', { offer_id: offerId }, { orderBy: [['created_at', 'desc']], limit }));
  }

  async toPriceChanges(rows: readonly PriceChangeRec[]): Promise<PriceChange[]> {
    if (!rows.length) return [];
    const offers = new Map((await this.repo.getMany('offers', rows.map((r) => r.offer_id))).map((o) => [o.id, o]));
    // inventory and access have no batch reads here: one call per stock item and per request, side by side
    const stockIds = [...new Set([...offers.values()].flatMap((o) => (o.owner_type === 'official' ? [o.stock_item_id] : [])))];
    const requestIds = [...new Set(rows.flatMap((r) => (r.approval_request_id ? [r.approval_request_id] : [])))];
    const [summaries, costList, infoList] = await Promise.all([
      this.parts.views.summaries([...offers.values()]),
      Promise.all(stockIds.map((id) => this.core.soft('inventory.getUnitCost', () => this.ctx.use('inventory').getUnitCost(id)))),
      Promise.all(requestIds.map((id) => this.core.optional('access', 'approvalInfo', (a) => a.approvalInfo(id)))),
    ]);
    const costs = new Map(stockIds.map((id, i) => [id, costList[i] ?? null]));
    const approvals = new Map(requestIds.map((id, i): [string, common.ApprovalInfo] => [id, infoList[i] ?? { required: true, reason: null, approvalRequestId: id, approvers: [] }]));
    const margin = (price: number, cost: common.Money | null | undefined) => (cost && price > 0 ? Math.round(((price - cost.amount) / price) * 1000) / 10 : null);
    return rows.flatMap((r) => {
      const o = offers.get(r.offer_id);
      if (!o) return [];
      const cost = o.owner_type === 'official' ? costs.get(o.stock_item_id) : null;
      return [
        {
          id: r.id,
          offerId: r.offer_id,
          offer: summaries.get(o.id)!,
          from: money(r.from_amount, o.currency),
          to: money(r.to_amount, o.currency),
          changePct: Number(r.change_pct),
          compareAt: r.compare_at_amount !== null ? money(r.compare_at_amount, o.currency) : null,
          startsAt: iso(r.starts_at),
          endsAt: iso(r.ends_at),
          revertTo: r.revert_to_amount !== null ? money(r.revert_to_amount, o.currency) : null,
          marginBeforePct: margin(Number(r.from_amount), cost),
          marginAfterPct: margin(Number(r.to_amount), cost),
          reason: r.reason,
          source: r.source as PriceChange['source'],
          state: r.state as PriceChange['state'],
          approval: r.approval_request_id ? (approvals.get(r.approval_request_id) ?? null) : null,
          requestedBy: actorOf(r.requested_by_kind, r.requested_by_id),
          createdAt: isoReq(r.created_at),
          appliedAt: iso(r.applied_at),
        } satisfies PriceChange,
      ];
    });
  }
}
