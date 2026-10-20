/**
 * Seller unit costs per offer (doc 09 §3.1): the cost history of an offer, setting a cost for one offer or many,
 * the cost in force on a day (public API unitCostsAt, used by reports for product cost and profit) and the cost in
 * force today on the seller's own views. Rows are never edited: a new cost is a new row, and the cost for a day is
 * the row with the latest effective_from on or before it (ties: the latest saved).
 *
 * A seller's costs are private: only the seller's own views and reports' seller figures read them, and the audit
 * entries name the offer and the day but not the amount (staff read the audit trail).
 */
import { isAppError } from '../../../kernel/errors/index.js';
import { addCalendarDays, isIsoDate } from '../../../kernel/lib/dates.js';
import { isUuid, newId } from '../../../kernel/lib/ids.js';
import type { PageRequest } from '../../../kernel/lib/pagination.js';
import type * as common from '../../../spec/common.js';
import type { OfferCost, OfferCostError, OfferCostItem } from '../../../spec/offers.js';
import { money, offerCost } from '../mappers.js';
import type { CostRec, OfferRec } from '../ports.js';
import { invalid, invalidField, Part, type By } from './core.js';

/** How far back a cost may start, so sales of the last 400 days (the reports range) can get a cost */
export const COST_DAYS_BACK = 400;
/** How far ahead a cost may start: tomorrow, for a supplier price that changes overnight */
export const COST_DAYS_AHEAD = 1;
/** Items per POST /costs */
export const MAX_COST_ITEMS = 500;

export interface CostInput {
  unitCost: common.Money;
  effectiveFrom?: string | null;
  note?: string | null;
}

/** The cost in force on the seller's views: amount and the day it started */
export interface CurrentCost {
  unitCost: common.Money;
  from: string;
}

export class CostsPart extends Part {
  /* ================================================================ reads */

  /** GET /offers/{id}/costs: the seller's own offer only (another seller's is not found) */
  async history(sellerId: string, offerId: string, page: PageRequest): Promise<common.Page<OfferCost>> {
    const offer = await this.core.ownRow(sellerId, offerId);
    const p = await this.repo.costHistory(offer.id, page);
    return { ...p, items: p.items.map(offerCost) };
  }

  /** The cost in force today per offer (seller views); offers without one are left out */
  async current(offerIds: readonly string[]): Promise<Map<string, CurrentCost>> {
    const today = this.core.today();
    const rows = await this.repo.costsUpTo([...new Set(offerIds.filter(isUuid))], today);
    const out = new Map<string, CurrentCost>();
    // rows come newest first per offer: the first one of each offer is in force today
    for (const r of rows) if (!out.has(r.offer_id)) out.set(r.offer_id, { unitCost: money(r.unit_cost_minor, r.currency), from: r.effective_from });
    return out;
  }

  /**
   * Public API unitCostsAt: the cost in force for each offer at each time, in the order given (null without one).
   * One query for all items: every row of the named offers up to the latest day asked about, newest first, then
   * per item the first row on or before its day.
   */
  async costsAt(items: readonly { offerId: string; at: string | Date }[]): Promise<(common.Money | null)[]> {
    const asked = (items ?? []).map((i) => {
      const at = i?.at instanceof Date ? i.at : new Date(i?.at ?? NaN);
      return { offerId: i?.offerId, day: Number.isNaN(at.getTime()) ? null : this.core.today(at) };
    });
    const valid = asked.filter((a): a is { offerId: string; day: string } => isUuid(a.offerId) && a.day !== null);
    if (!valid.length) return asked.map(() => null);
    const latest = valid.reduce((max, a) => (a.day > max ? a.day : max), valid[0]!.day);
    const rows = await this.repo.costsUpTo([...new Set(valid.map((a) => a.offerId))], latest);
    const byOffer = new Map<string, CostRec[]>();
    for (const r of rows) {
      const list = byOffer.get(r.offer_id);
      if (list) list.push(r);
      else byOffer.set(r.offer_id, [r]);
    }
    return asked.map((a) => {
      if (!a.offerId || a.day === null) return null;
      const r = byOffer.get(a.offerId)?.find((x) => x.effective_from <= a.day!);
      return r ? money(r.unit_cost_minor, r.currency) : null;
    });
  }

  /* ================================================================ writes */

  /** PUT /offers/{id}/cost */
  async setOne(sellerId: string, offerId: string, input: CostInput, by: By): Promise<OfferCost> {
    const offer = await this.core.ownRow(sellerId, offerId);
    const row = this.newRow(offer, input, by);
    await this.save([row], by);
    await this.core.audit(
      {
        action: 'offers.offer.cost_set',
        actionLabel: 'Set a unit cost',
        category: 'catalog',
        target: this.parts.manage.target(offer),
        // the amount stays out of the audit trail: staff read it, and a seller's costs are private
        after: { effectiveFrom: row.effective_from },
        visibleToSeller: true,
      },
      by,
    );
    return offerCost(row);
  }

  /** POST /costs: each item is saved or refused on its own */
  async setMany(sellerId: string, items: readonly OfferCostItem[], by: By): Promise<{ saved: number; errors: OfferCostError[] }> {
    if (!Array.isArray(items) || items.length < 1 || items.length > MAX_COST_ITEMS) throw invalidField('items', `Send 1 to ${MAX_COST_ITEMS} costs at a time`);
    const offers = new Map((await this.repo.getMany('offers', items.map((i) => i.offerId).filter(isUuid))).map((o) => [o.id, o]));
    const rows: CostRec[] = [];
    const errors: OfferCostError[] = [];
    const seen = new Set<string>();
    for (const item of items) {
      const offer = offers.get(item.offerId);
      if (!offer || offer.owner_type !== 'seller' || offer.seller_id !== sellerId) {
        errors.push({ offerId: item.offerId, code: 'NOT_FOUND', message: 'Offer not found' });
        continue;
      }
      // two rows for one offer saved at the same moment would tie: the list must name each offer once
      if (seen.has(offer.id)) {
        errors.push({ offerId: item.offerId, code: 'VALIDATION_FAILED', message: 'This offer appears more than once; send one cost per offer' });
        continue;
      }
      seen.add(offer.id);
      try {
        rows.push(this.newRow(offer, item, by));
      } catch (err) {
        if (!isAppError(err) || err.code !== 'VALIDATION_FAILED') throw err;
        errors.push({ offerId: item.offerId, code: 'VALIDATION_FAILED', message: err.message });
      }
    }
    await this.save(rows, by);
    if (rows.length) {
      await this.core.audit(
        {
          action: 'offers.offer.costs_set',
          actionLabel: `Set unit costs for ${rows.length} offer${rows.length === 1 ? '' : 's'}`,
          category: 'catalog',
          target: { type: 'seller', id: sellerId, sellerId, label: `${rows.length} offer${rows.length === 1 ? '' : 's'}` },
          relatedTargets: rows.map((r) => this.parts.manage.target(offers.get(r.offer_id)!)),
          after: { saved: rows.length, refused: errors.length },
          visibleToSeller: true,
        },
        by,
      );
    }
    return { saved: rows.length, errors };
  }

  /**
   * A bulk file row's unit cost, effective today (BulkPart.apply). The file was validated at upload; the
   * amount is checked again here like any other cost.
   */
  bulkRow(offer: OfferRec, amount: number, by: By): CostRec {
    return this.newRow(offer, { unitCost: money(amount, offer.currency) }, by);
  }

  /** Inserts the rows, then one offers.offer.cost_changed per row (after the write, as every event) */
  async save(rows: readonly CostRec[], by: By): Promise<void> {
    if (!rows.length) return;
    await this.repo.insertMany('offer_costs', [...rows]);
    for (const r of rows) {
      this.core.publish('offers.offer.cost_changed', { offerId: r.offer_id, sellerId: r.seller_id, productId: r.product_id, unitCost: money(r.unit_cost_minor, r.currency), effectiveFrom: r.effective_from }, by);
    }
  }

  /** A new cost row for a seller offer, or VALIDATION_FAILED */
  private newRow(offer: OfferRec, input: CostInput, by: By): CostRec {
    const issues: { path: string; message: string }[] = [];
    const cost = input?.unitCost;
    const amount = Number(cost?.amount);
    if (!cost || !Number.isInteger(amount)) issues.push({ path: 'unitCost', message: 'Enter the unit cost in cents, e.g. 1250 for $12.50' });
    else if (amount < 0) issues.push({ path: 'unitCost', message: 'The unit cost cannot be negative' });
    else if (cost.currency !== offer.currency) issues.push({ path: 'unitCost.currency', message: `The unit cost must be in ${offer.currency}, the offer's currency` });

    const today = this.core.today();
    const day = input?.effectiveFrom ?? today;
    if (!isIsoDate(day)) issues.push({ path: 'effectiveFrom', message: 'Give the day as YYYY-MM-DD' });
    else if (day < addCalendarDays(today, -COST_DAYS_BACK)) issues.push({ path: 'effectiveFrom', message: `A cost can start at most ${COST_DAYS_BACK} days back` });
    else if (day > addCalendarDays(today, COST_DAYS_AHEAD)) issues.push({ path: 'effectiveFrom', message: 'A cost can start at most 1 day ahead' });

    const note = input?.note?.trim() || null;
    if (note && note.length > 500) issues.push({ path: 'note', message: 'Keep the note under 500 characters' });
    if (issues.length) throw invalid(issues, issues[0]!.message);

    return {
      id: newId(),
      offer_id: offer.id,
      seller_id: offer.seller_id!,
      product_id: offer.product_id,
      unit_cost_minor: amount,
      currency: offer.currency,
      effective_from: day,
      note,
      set_by_id: isUuid(by.actor.id) ? by.actor.id! : null,
      set_by_name: by.actor.name?.trim() || 'Seller team member',
      created_at: this.now(),
    };
  }
}
