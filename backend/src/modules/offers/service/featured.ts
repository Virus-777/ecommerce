/**
 * The published featured-offer rule (versioned) and the featured decision per variant, condition group
 * and delivery zone: cached in featured_offers, marked dirty by offer changes and recomputed by the job.
 */
import { AppError, isAppError } from '../../../kernel/errors/index.js';
import type { DeliverTo, FeaturedCandidate, FeaturedDecision, FeaturedRule, FeaturedRuleInput, FeaturedRuleParameters } from '../../../spec/offers.js';
import { CONDITIONS, conditionGroup, DEFAULT_RULE, rankCandidates, reason, RULE_NOTES, TIE_BREAKERS, zoneKey, type ConditionGroup } from '../domain/rules.js';
import { actorText, featuredRule, iso, isoReq, money, SERVICE_INELIGIBLE, serviceHeld } from '../mappers.js';
import type { OfferRec, RuleRec } from '../ports.js';
import { invalid, invalidField, Part, SYSTEM, type By, type ProductCache } from './core.js';
import type { Facts } from './storefront.js';

interface Cached {
  deliverTo: DeliverTo;
  items: FeaturedCandidate[];
}

/** Statuses that take part in a featured decision (as candidates; only active ones can win) */
const CANDIDATE_STATUSES: OfferRec['status'][] = ['active', 'out_of_stock', 'ineligible', 'paused'];

export class FeaturedPart extends Part {
  #defaultEnsured = false;

  /* ================================================================ rule versions */

  async rules(): Promise<RuleRec[]> {
    let rows = await this.repo.rules();
    if (!rows.length && !this.#defaultEnsured) {
      // another caller may have seeded it meanwhile
      await this.repo.insertIfAbsent('featured_rules', {
        version: DEFAULT_RULE.version,
        text: DEFAULT_RULE.text,
        steps: DEFAULT_RULE.steps as never,
        parameters: DEFAULT_RULE.parameters as never,
        effective_from: new Date('2000-01-01T00:00:00Z'),
        reason: DEFAULT_RULE.reason,
        published_by: actorText(SYSTEM),
        published_at: new Date('2000-01-01T00:00:00Z'),
      });
      this.#defaultEnsured = true;
      rows = await this.repo.rules();
    }
    return rows;
  }

  async currentRule(): Promise<FeaturedRule> {
    const now = this.now();
    const rows = await this.rules();
    const current = rows.filter((r) => r.effective_from <= now).at(-1) ?? rows[0];
    return featuredRule(current!);
  }

  async ruleAdmin(): Promise<{ current: FeaturedRule; scheduled: FeaturedRule | null; history: FeaturedRule[] }> {
    const now = this.now();
    const rows = await this.rules();
    const current = await this.currentRule();
    const scheduled = rows.find((r) => r.effective_from > now);
    return { current, scheduled: scheduled ? featuredRule(scheduled) : null, history: rows.filter((r) => r.version !== current.version && r.effective_from <= now).map(featuredRule).reverse() };
  }

  summary(rule: FeaturedRule) {
    return { version: rule.version, steps: rule.steps, notes: rule.parameters.competingConditions.length === 1 && rule.parameters.competingConditions[0] === 'new' ? RULE_NOTES : RULE_NOTES.slice(1) };
  }

  async publishRule(input: FeaturedRuleInput, by: By): Promise<FeaturedRule> {
    const issues: { path: string; message: string }[] = [];
    if (!input.text?.trim()) issues.push({ path: 'text', message: 'Enter the published wording' });
    if (!input.steps?.length || input.steps.some((s) => !s.trim())) issues.push({ path: 'steps', message: 'List the steps customers see' });
    if (!input.reason?.trim()) issues.push({ path: 'reason', message: 'Give the reason for the new version' });
    const p = input.parameters as FeaturedRuleParameters | undefined;
    if (!p) issues.push({ path: 'parameters', message: 'Enter the rule parameters' });
    else {
      if (!Number.isInteger(p.minOnTimeDispatchPct) || p.minOnTimeDispatchPct < 0 || p.minOnTimeDispatchPct > 100) issues.push({ path: 'parameters.minOnTimeDispatchPct', message: '0 to 100' });
      if (!Number.isInteger(p.performanceWindowDays) || p.performanceWindowDays < 1 || p.performanceWindowDays > 365) issues.push({ path: 'parameters.performanceWindowDays', message: '1 to 365 days' });
      if (typeof p.deliveryDayAdjustmentPct !== 'number' || p.deliveryDayAdjustmentPct < 0 || p.deliveryDayAdjustmentPct > 100) issues.push({ path: 'parameters.deliveryDayAdjustmentPct', message: '0 to 100' });
      if (!p.competingConditions?.length || p.competingConditions.some((c) => !CONDITIONS.includes(c as never))) issues.push({ path: 'parameters.competingConditions', message: `Conditions are ${CONDITIONS.join(', ')}` });
      if ((p.tieBreakers ?? []).some((t) => !TIE_BREAKERS.includes(t as never))) issues.push({ path: 'parameters.tieBreakers', message: `Tie-breakers are ${TIE_BREAKERS.join(', ')}` });
    }
    const effectiveFrom = new Date(input.effectiveFrom);
    if (Number.isNaN(effectiveFrom.getTime())) issues.push({ path: 'effectiveFrom', message: 'Not a date-time' });
    if (issues.length) throw invalid(issues);
    const rows = await this.rules();
    if (rows.some((r) => r.effective_from > this.now() && effectiveFrom > this.now())) throw new AppError('CONFLICT', 'Another version is already scheduled; it must take effect first');
    const version = Math.max(0, ...rows.map((r) => r.version)) + 1;
    const now = this.now();
    const row = await this.repo.insert('featured_rules', {
      version,
      text: input.text.trim(),
      steps: input.steps.map((s) => s.trim()) as never,
      parameters: { ...p!, tieBreakers: p!.tieBreakers ?? [] } as never,
      effective_from: effectiveFrom < now ? now : effectiveFrom,
      reason: input.reason.trim(),
      published_by: actorText(by.actor),
      published_at: now,
    });
    this.core.publish('offers.featured_rule.published', { version, effectiveFrom: isoReq(row.effective_from) }, by);
    // decisions under the old version are recomputed when this one takes effect (rule_version differs)
    if (row.effective_from <= now) await this.repo.markFeaturedDirty({ ruleVersionNot: version });
    await this.core.audit(
      { action: 'offers.featured_rule.publish', actionLabel: 'Published a featured-offer rule version', category: 'settings', target: { type: 'featured_rule', id: String(version), ref: `v${version}`, label: 'Featured-offer rule' }, reason: input.reason, after: { version, effectiveFrom: iso(row.effective_from), parameters: p } },
      by,
    );
    return featuredRule(row);
  }

  /* ================================================================ decisions */

  /**
   * The featured decision for a variant at a delivery location. 'new' is the default competition
   * (the rule's competing conditions); 'used' and 'refurbished' compete within their filter.
   * Served from featured_offers while it is clean and on the current rule version.
   */
  async decision(variantId: string, group: ConditionGroup, deliverTo: DeliverTo, o: { productId?: string; facts?: Map<string, Facts>; rows?: OfferRec[]; refresh?: boolean } = {}): Promise<FeaturedDecision> {
    const rule = await this.currentRule();
    const granularity = String((await this.core.setting('featuredZoneGranularity')) ?? 'postal3');
    const zone = zoneKey(deliverTo.postalCode, granularity);
    const cached = await this.repo.getFeatured(variantId, group, zone);
    if (cached && !cached.dirty && cached.rule_version === rule.version && !o.refresh) {
      const c = cached.candidates as unknown as Cached;
      return { productId: cached.product_id, variantId, deliverTo, ruleVersion: cached.rule_version, winnerOfferId: cached.offer_id, candidates: c?.items ?? [], computedAt: isoReq(cached.computed_at) };
    }
    const computed = await this.compute(variantId, group, deliverTo, rule, o);
    const productId = computed.productId || cached?.product_id || o.productId;
    if (productId) {
      await this.repo.upsertFeatured({
        variant_id: variantId,
        condition_group: group,
        zone_key: zone,
        product_id: productId,
        offer_id: computed.winnerOfferId ?? null,
        rule_version: rule.version,
        candidates: { deliverTo, items: computed.candidates } as never,
        dirty: false,
        computed_at: this.now(),
      });
      if (cached && (cached.offer_id ?? null) !== (computed.winnerOfferId ?? null)) {
        this.core.publish('offers.featured.changed', { productId, variantId, conditionGroup: group, zoneKey: zone, fromOfferId: cached.offer_id, toOfferId: computed.winnerOfferId ?? null });
      }
    }
    return { ...computed, productId: productId ?? computed.productId };
  }

  private async compute(variantId: string, group: ConditionGroup, deliverTo: DeliverTo, rule: FeaturedRule, o: { productId?: string; facts?: Map<string, Facts>; rows?: OfferRec[] }): Promise<FeaturedDecision> {
    const all = o.rows ?? (await this.repo.find('offers', { variant_id: variantId, status: CANDIDATE_STATUSES }, { limit: 200 }));
    const competing = rule.parameters.competingConditions;
    const rows = all.filter((r) => CANDIDATE_STATUSES.includes(r.status) && (group === 'new' ? true : conditionGroup(r.condition) === group));
    const productId = rows[0]?.product_id ?? o.productId ?? '';
    const now = isoReq(this.now());
    if (!rows.length) return { productId, variantId, deliverTo, ruleVersion: rule.version, winnerOfferId: null, candidates: [], computedAt: now };
    const missing = rows.filter((r) => !o.facts?.has(r.id));
    const facts = new Map(o.facts ?? []);
    if (missing.length) for (const [k, v] of await this.parts.storefront.facts(missing, deliverTo, 1)) facts.set(k, v);
    const elig = new Map((await this.repo.getEligibility(rows.map((r) => r.id))).map((e) => [e.offer_id, e]));
    const names = await this.core.sellerNames(rows);
    const cands = rows.map((r) => {
      const f = facts.get(r.id)!;
      const e = elig.get(r.id);
      const reasons = [...(Array.isArray(e?.reasons) ? (e!.reasons as unknown as FeaturedCandidate['reasons']) : this.core.statusReasons(r))];
      const add = (code: Parameters<typeof reason>[0]) => !reasons.some((x) => x.code === code) && reasons.push(reason(code));
      // a Marketly-fulfilled offer the service does not let sell cannot be featured (decision D5)
      if (serviceHeld(r, f.fulfilment) && !reasons.some((x) => x.message === SERVICE_INELIGIBLE.message)) reasons.unshift(SERVICE_INELIGIBLE);
      if (r.status === 'active' && f.availability.state === 'out_of_stock') add('out_of_stock');
      if (!f.delivery.shipsToLocation) add('does_not_ship_to_location');
      if (group === 'new' && !competing.includes(r.condition)) add('condition_not_competing');
      const onTime = e?.seller_on_time_pct !== null && e?.seller_on_time_pct !== undefined ? Number(e.seller_on_time_pct) : r.owner_type === 'official' ? 100 : null;
      return {
        row: r,
        reasons,
        input: {
          offerId: r.id,
          eligible: reasons.length === 0,
          total: f.total.amount,
          itemPrice: f.unitPrice.amount,
          arrivesTo: f.delivery.arrivesTo ?? null,
          // effective dispatch (Offer.shipping): Marketly's for marketly_service offers
          dispatchDays: f.fulfilment.shipping.dispatch.businessDays,
          onTimePct: onTime,
          publishedAt: r.published_at,
          official: r.owner_type === 'official',
        },
      };
    });
    const ranked = rankCandidates(
      cands.map((c) => c.input),
      rule.parameters,
    );
    const byId = new Map(cands.map((c) => [c.row.id, c]));
    const candidates: FeaturedCandidate[] = ranked.map((x) => {
      const c = byId.get(x.offerId)!;
      return {
        offerId: x.offerId,
        sellerName: this.core.nameOf(c.row, names),
        condition: c.row.condition,
        eligible: x.eligible,
        reasons: c.reasons,
        total: money(x.total, c.row.currency),
        arrivesTo: x.arrivesTo,
        adjustedTotal: money(x.adjustedTotal, c.row.currency),
        rank: x.rank,
      };
    });
    const winner = ranked.find((x) => x.rank === 1);
    return { productId, variantId, deliverTo, ruleVersion: rule.version, winnerOfferId: winner?.offerId ?? null, candidates, computedAt: now };
  }

  /** Admin: why an offer is (or is not) featured, freshly computed */
  async explain(productId: string, variantId: string | undefined, postalCode: string | undefined, group: ConditionGroup = 'new'): Promise<FeaturedDecision> {
    const product = await this.core.productAdmin(productId);
    if (!product) throw new AppError('NOT_FOUND', 'Product not found');
    const variant = variantId ? product.product.variants.find((v) => v.id === variantId) : product.product.variants[0];
    if (!variant) throw new AppError('NOT_FOUND', 'Variant not found');
    return this.decision(variant.id, group, this.parts.storefront.deliverTo(postalCode), { productId, refresh: true });
  }

  /** POST /featured-decisions/recompute: marks decisions dirty for the job */
  async queueRecompute(productId: string | null | undefined, by: By): Promise<{ queued: number }> {
    if (productId && !(await this.core.productAdmin(productId))) throw invalidField('productId', 'Unknown product');
    const queued = productId ? await this.repo.markFeaturedDirty({ productIds: [productId] }) : await this.repo.markFeaturedDirty({ all: true });
    await this.core.audit(
      { action: 'offers.featured.recompute', actionLabel: productId ? 'Recomputed featured offers for a product' : 'Recomputed all featured offers', category: 'catalog', target: productId ? { type: 'product', id: productId } : { type: 'featured_rule', id: 'all', label: 'All featured decisions' }, after: { queued } },
      by,
    );
    return { queued };
  }

  /* ================================================================ jobs */

  /** offers.recompute-featured: dirty rows, rows on an old rule version, and (nightly) anything older than a day */
  async recompute(): Promise<void> {
    const rule = await this.currentRule();
    await this.repo.markFeaturedDirty({ ruleVersionNot: rule.version, olderThan: new Date(this.now().getTime() - 86_400_000) });
    for (let round = 0; round < 10; round++) {
      const rows = await this.repo.dirtyFeatured(200);
      if (!rows.length) return;
      for (const row of rows) {
        const c = row.candidates as unknown as Cached | null;
        const deliverTo = c?.deliverTo ?? this.parts.storefront.deliverTo(undefined);
        try {
          await this.decision(row.variant_id, row.condition_group, deliverTo, { productId: row.product_id, refresh: true });
        } catch (err) {
          if (isAppError(err) && err.status < 500) {
            await this.repo.upsertFeatured({ ...row, dirty: false, computed_at: this.now() });
            continue;
          }
          this.ctx.log.error({ err, variantId: row.variant_id }, 'offers: featured decision failed');
          await this.repo.upsertFeatured({ ...row, dirty: false, computed_at: this.now() });
        }
      }
      if (rows.length < 200) return;
    }
  }

  /** offers.reevaluate-eligibility: seller standing from sellers into offer_eligibility */
  async reevaluate(): Promise<void> {
    const rule = await this.currentRule();
    const rows = await this.repo.allOffers({ excludeStatuses: ['removed'] }, 10_000);
    const bySeller = new Map<string, OfferRec[]>();
    const official: OfferRec[] = [];
    for (const r of rows) {
      if (!r.seller_id) official.push(r);
      else bySeller.set(r.seller_id, [...(bySeller.get(r.seller_id) ?? []), r]);
    }
    const sellerIds = [...bySeller.keys()];
    for (let i = 0; i < sellerIds.length; i += 50) {
      const chunk = sellerIds.slice(i, i + 50);
      const standing = await this.core.sellerStanding(chunk, rule.parameters.minOnTimeDispatchPct);
      for (const id of chunk) await this.core.refreshEligibility(bySeller.get(id)!, standing);
    }
    await this.core.refreshEligibility(official);
    await this.refreshOfficialShipsFrom();
    await this.backfillTitles();
    await this.backfillReturnTerms();
  }

  /**
   * Official Store ships-from follows the inventory default location (decision O3). Inventory publishes no event when
   * the default location changes, so the hourly job rewrites every live Official Store offer whose label differs.
   * Not a terms change (termsVersion stays): delivery estimates are computed live.
   */
  async refreshOfficialShipsFrom(): Promise<number> {
    const label = await this.parts.manage.officialShipsFrom();
    return this.repo.updateWhere('offers', { owner_type: 'official', status: { op: '<>', value: 'removed' }, ships_from: { op: '<>', value: label } }, { ships_from: label, updated_at: this.now() });
  }

  /**
   * Offers saved before return_policy_version / return_category_exception existed get them from returns.resolveTerms
   * (the version in force now). Only while returns is on: off, nothing can be filled and the rows wait. Walks the rows
   * by id (keyset), at most `max` per run; rows returns cannot answer for stay null and are retried next run.
   */
  async backfillReturnTerms(max = 1000): Promise<number> {
    if (!this.ctx.tryUse('returns')) return 0;
    const cache: ProductCache = new Map();
    let filled = 0;
    let after: string | null = null;
    for (let seen = 0; seen < max; ) {
      const rows: OfferRec[] = await this.repo.find('offers', { return_policy_version: null, status: { op: '<>', value: 'removed' }, ...(after ? { id: { op: '>', value: after } } : {}) }, { orderBy: [['id', 'asc']], limit: 100 });
      if (!rows.length) break;
      for (const r of rows) {
        const p = await this.core.productAdmin(r.product_id, cache).catch(() => null);
        const b = await this.parts.manage.baseline(r.seller_id, p?.product.categoryId ?? null, r.condition);
        if (b.policyVersion) {
          await this.repo.update('offers', r.id, { return_policy_version: b.policyVersion, return_category_exception: b.categoryException });
          filled++;
        }
      }
      seen += rows.length;
      after = rows[rows.length - 1]!.id;
      if (rows.length < 100) break;
    }
    return filled;
  }

  /** Offers created before titles existed get theirs from catalog, a bounded batch per run */
  async backfillTitles(limit = 200): Promise<number> {
    const rows = await this.repo.find('offers', { title: '' }, { limit });
    const cache: ProductCache = new Map();
    let n = 0;
    for (const r of rows) if (await this.core.ensureTitle(r, cache)) n++;
    return n;
  }
}
