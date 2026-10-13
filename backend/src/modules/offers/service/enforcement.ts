/**
 * Reactions to other modules: seller restrictions, suspensions and closure (scenario 7: only the
 * affected offers stop selling), launch review, catalog publication / approval / merges / edits,
 * stock changes, trust enforcement and campaign changes. Consumers are idempotent and ignore unknown records.
 */
import { isAppError } from '../../../kernel/errors/index.js';
import { isUuid, newId } from '../../../kernel/lib/ids.js';
import type { EventPayload } from '../../../kernel/events/index.js';
import type * as common from '../../../spec/common.js';
import type { StatusReason } from '../../../spec/offers.js';
import { activityLabel, inScope, type ScopeLike } from '../domain/rules.js';
import { enforcementIdOf, offerTitle, SERVICE_HOLD, strings } from '../mappers.js';
import type { OfferRec } from '../ports.js';
import { DuplicateKeyError } from '../repository.js';
import { Part, SYSTEM, type By, type ProductCache, type TransitionSpec } from './core.js';

type Source = NonNullable<TransitionSpec['source']>;
const STOPPABLE: OfferRec['status'][] = ['active', 'paused', 'out_of_stock'];
const SELLER_APPEAL = 'Appeal from Seller Center > Account health';
const SERVICE_ACTIVITY = 'Sales of this offer';

export class EnforcementPart extends Part {
  /* ================================================================ helpers */

  private sourceOf(r: OfferRec): { kind?: string; id?: string | null } {
    return (r.ineligible_source ?? {}) as { kind?: string; id?: string | null };
  }

  /** Makes offers ineligible (stops new sales of these offers only); already-ineligible ones are left as they are */
  async makeIneligible(rows: readonly OfferRec[], source: Source, reason: StatusReason, by: By, log: TransitionSpec['log'] = {}): Promise<number> {
    let n = 0;
    for (const r of rows) {
      if (!STOPPABLE.includes(r.status)) continue;
      try {
        await this.core.move(r.id, {
          event: 'makeIneligible',
          by,
          source,
          reason,
          log: { reasonCode: reason.code, reason: reason.text, affectedActivity: reason.affectedActivity ?? null, appealRoute: reason.appealRoute ?? null, reviewDate: reason.reviewDate ?? null, ...log },
          guard: (x) => {
            if (!STOPPABLE.includes(x.status)) throw Object.assign(new Error('moved'), { skip: true });
          },
        });
        n++;
      } catch (err) {
        if ((err as { skip?: boolean }).skip) continue;
        throw err;
      }
    }
    return n;
  }

  /** What still stops an offer from selling, besides a staff hold */
  async blockingCause(r: OfferRec, cache: ProductCache = new Map()): Promise<{ source: Source; reason: StatusReason } | null> {
    const by: By = { actor: SYSTEM };
    const product = await this.core.productAdmin(r.product_id, cache);
    if (product && product.publication !== 'active') {
      const code = product.publication === 'suspended' ? 'product_suspended' : 'product_hidden';
      return { source: { kind: 'product', id: r.product_id }, reason: this.core.statusReason(code, product.publication === 'suspended' ? 'The product is suspended in the catalog' : 'The product is hidden in the catalog', by) };
    }
    if (r.seller_id) {
      const check = await this.core.soft('sellers.canSell', () => this.ctx.use('sellers').canSell(r.seller_id!, { activity: 'sales', ...(product?.product.categoryId ? { categoryId: product.product.categoryId } : {}), condition: r.condition, offerId: r.id }));
      if (check && !check.allowed) {
        const snap = (await this.core.sellerSnapshots([r.seller_id])).get(r.seller_id);
        if (snap?.status === 'suspended') return { source: { kind: 'suspension', id: check.restrictionId ?? null }, reason: this.core.statusReason('seller_suspended', check.reason ?? 'The seller account is suspended', by, { appealRoute: check.appealRoute ?? SELLER_APPEAL }) };
        if (snap?.status === 'closed') return { source: { kind: 'suspension', id: null }, reason: this.core.statusReason('seller_closed', check.reason ?? 'The seller account is closed', by) };
        if (check.restrictionId) return { source: { kind: 'restriction', id: check.restrictionId }, reason: this.core.statusReason('seller_restricted', check.reason ?? 'Sales are restricted', by, { affectedActivity: activityLabel(['sales']), appealRoute: check.appealRoute ?? SELLER_APPEAL }) };
      }
    }
    // Fulfilled by Marketly says the offer does not sell (enrollment suspended or offboarding). Only an answer counts:
    // with the service off nothing here would ever lift a hold, and the read paths already show the offer Ineligible.
    if (r.fulfilled_by === 'marketly_service') {
      const terms = (await this.core.optional('fulfillment-service', 'getServiceTerms', (fs) => fs.getServiceTerms([r.id])))?.[r.id];
      if (terms && !terms.sellable) return { source: { kind: 'fulfillment_service', id: terms.skuEnrollmentId }, reason: this.core.statusReason('fulfillment_service_suspended', SERVICE_HOLD[terms.notSellableReason ?? 'service_unavailable'], by, { affectedActivity: SERVICE_ACTIVITY }) };
    }
    return null;
  }

  /** restoreEligibility, unless another cause still stops the offer (then the hold switches to it) */
  async restoreOrSwitch(r: OfferRec, o: { by: By; log?: TransitionSpec['log']; force?: boolean }, cache?: ProductCache): Promise<OfferRec> {
    if (r.status !== 'ineligible') return r;
    const cause = await this.blockingCause(r, cache);
    if (cause) {
      return this.repo.update('offers', r.id, { ineligible_source: cause.source as never, status_reason: cause.reason as never, updated_at: this.now() });
    }
    const back = r.status_before_ineligible === 'paused' ? undefined : ((await this.core.available([r.stock_item_id])).get(r.stock_item_id) ?? 0);
    const t = await this.core.move(r.id, { event: 'restoreEligibility', by: o.by, available: back, reason: null, log: o.log });
    return t.after;
  }

  private async categoryOf(r: OfferRec, cache: ProductCache) {
    return (await this.core.productAdmin(r.product_id, cache))?.product.categoryId ?? null;
  }

  private async sourced(kind: string, id: string): Promise<OfferRec[]> {
    const rows = await this.repo.find('offers', { status: 'ineligible' }, { limit: 10_000 });
    return rows.filter((r) => {
      const s = this.sourceOf(r);
      return s.kind === kind && s.id === id;
    });
  }

  /* ================================================================ sellers */

  async onSellerRestricted(e: EventPayload<'sellers.seller.restricted'>, actor?: common.Actor) {
    if (!e.affectedActivities.includes('sales')) return; // other activities are checked when the seller acts
    const by: By = { actor: actor ?? SYSTEM };
    const cache: ProductCache = new Map();
    const rows = await this.repo.find('offers', { seller_id: e.sellerId, status: STOPPABLE });
    const covered: OfferRec[] = [];
    for (const r of rows) if (inScope(e.scope as ScopeLike, r, (e.scope as ScopeLike)?.categoryIds?.length ? await this.categoryOf(r, cache) : null)) covered.push(r);
    const reason = this.core.statusReason('seller_restricted', e.reason, by, { affectedActivity: activityLabel(e.affectedActivities, e.scope as ScopeLike), appealRoute: e.appealRoute, reviewDate: e.reviewDate?.slice(0, 10) ?? null });
    await this.makeIneligible(covered, { kind: 'restriction', id: e.restrictionId }, reason, by);
  }

  async onRestrictionUpdated(e: EventPayload<'sellers.restriction.updated'>) {
    const by: By = { actor: SYSTEM };
    const cache: ProductCache = new Map();
    const sales = e.affectedActivities.includes('sales');
    const held = await this.sourced('restriction', e.restrictionId);
    const covers = async (r: OfferRec) => sales && inScope(e.scope as ScopeLike, r, (e.scope as ScopeLike)?.categoryIds?.length ? await this.categoryOf(r, cache) : null);
    let template: StatusReason | null = null;
    for (const r of held) {
      if (await covers(r)) {
        template ??= (r.status_reason as StatusReason | null) ?? null;
        continue;
      }
      await this.restoreOrSwitch(r, { by, log: { reasonCode: 'restriction_updated', reason: 'No longer covered by the restriction' } }, cache);
    }
    if (!sales) return;
    const fresh: OfferRec[] = [];
    for (const r of await this.repo.find('offers', { seller_id: e.sellerId, status: STOPPABLE })) if (await covers(r)) fresh.push(r);
    if (!fresh.length) return;
    const reason = template
      ? { ...template, affectedActivity: activityLabel(e.affectedActivities, e.scope as ScopeLike), reviewDate: e.reviewDate?.slice(0, 10) ?? null, at: this.now().toISOString() }
      : this.core.statusReason('seller_restricted', 'Sales are restricted', by, { affectedActivity: activityLabel(e.affectedActivities, e.scope as ScopeLike), appealRoute: SELLER_APPEAL, reviewDate: e.reviewDate?.slice(0, 10) ?? null });
    await this.makeIneligible(fresh, { kind: 'restriction', id: e.restrictionId }, reason, by);
  }

  async onRestrictionLifted(e: EventPayload<'sellers.restriction.lifted'>) {
    const by: By = { actor: SYSTEM };
    const cache: ProductCache = new Map();
    for (const r of await this.sourced('restriction', e.restrictionId)) {
      if (r.seller_id !== e.sellerId) continue;
      await this.restoreOrSwitch(r, { by, log: { reasonCode: 'restriction_lifted', reason: e.reason } }, cache);
    }
  }

  async onSellerSuspended(e: EventPayload<'sellers.seller.suspended'>) {
    const by: By = { actor: SYSTEM };
    const rows = await this.repo.find('offers', { seller_id: e.sellerId, status: STOPPABLE });
    const reason = this.core.statusReason('seller_suspended', e.reason, by, { affectedActivity: 'All sales', appealRoute: SELLER_APPEAL, reviewDate: e.reviewDate?.slice(0, 10) ?? null });
    await this.makeIneligible(rows, { kind: 'suspension', id: e.suspensionId }, reason, by);
  }

  async onSellerReinstated(e: EventPayload<'sellers.seller.reinstated'>) {
    const by: By = { actor: SYSTEM };
    const cache: ProductCache = new Map();
    const ids = new Set([e.liftedRestrictionId, e.endedSuspensionId].filter((x): x is string => Boolean(x)));
    const rows = (await this.repo.find('offers', { seller_id: e.sellerId, status: 'ineligible' })).filter((r) => {
      const s = this.sourceOf(r);
      return (s.kind === 'restriction' || s.kind === 'suspension') && ((s.id && ids.has(s.id)) || (!s.id && s.kind === 'suspension'));
    });
    for (const r of rows) {
      const s = this.sourceOf(r);
      if (s.id && e.remainingRestrictionIds.includes(s.id)) continue;
      await this.restoreOrSwitch(r, { by, log: { reasonCode: 'seller_reinstated', reason: `Seller reinstated (${e.to})` } }, cache);
    }
  }

  async onLaunchReviewDecided(e: EventPayload<'sellers.launch_review.decided'>) {
    if (e.outcome !== 'passed') return; // changes needed: the drafts keep waiting
    const drafts = await this.repo.find('offers', { seller_id: e.sellerId, status: 'draft', publish_on_approval: true });
    for (const d of drafts) {
      if ((d.status_reason as StatusReason | null)?.code === 'awaiting_launch_review') await this.repo.update('offers', d.id, { status_reason: null, updated_at: this.now() });
    }
    await this.parts.manage.publishWaiting(await this.repo.find('offers', { seller_id: e.sellerId, status: 'draft', publish_on_approval: true }), 'launch review passed');
  }

  async onSellerClosed(e: EventPayload<'sellers.seller.closed'>) {
    const by: By = { actor: e.closedBy ?? SYSTEM };
    const rows = await this.repo.find('offers', { seller_id: e.sellerId, status: { op: '<>', value: 'removed' } });
    const reason = this.core.statusReason('seller_closed', 'The seller account was closed', by);
    for (const r of rows) {
      try {
        await this.core.move(r.id, { event: 'remove', by, reason, log: { reasonCode: 'seller_closed', reason: e.reasonCode } });
      } catch (err) {
        if (!isAppError(err) || err.code !== 'ILLEGAL_TRANSITION') throw err;
      }
    }
  }

  /* ================================================================ catalog */

  async onProductPublicationChanged(e: EventPayload<'catalog.product.publication_changed'>) {
    const by: By = { actor: SYSTEM };
    if (e.to === 'hidden' || e.to === 'suspended') {
      const rows = await this.repo.find('offers', { product_id: e.productId, status: STOPPABLE });
      const reason = this.core.statusReason(e.to === 'suspended' ? 'product_suspended' : 'product_hidden', e.reason || (e.to === 'suspended' ? 'The product is suspended in the catalog' : 'The product is hidden in the catalog'), by);
      await this.makeIneligible(rows, { kind: 'product', id: e.productId }, reason, by);
      return;
    }
    if (e.to === 'active') {
      const cache: ProductCache = new Map();
      for (const r of await this.sourced('product', e.productId)) await this.restoreOrSwitch(r, { by, log: { reasonCode: 'product_active', reason: e.reason } }, cache);
      await this.parts.manage.publishWaiting(await this.repo.find('offers', { product_id: e.productId, status: 'draft', publish_on_approval: true }), 'product active');
    }
  }

  async onProductApproved(e: EventPayload<'catalog.product.approved'>) {
    await this.parts.views.refreshContentGaps(e.productId);
    await this.parts.manage.publishWaiting(await this.repo.find('offers', { product_id: e.productId, status: 'draft', publish_on_approval: true }), 'product approved');
  }

  /** Offers move to the kept product by variant options; unmatched ones are paused (product_merged) */
  async onProductMerged(e: EventPayload<'catalog.product.merged'>) {
    const rows = await this.repo.find('offers', { product_id: e.duplicateProductId });
    if (!rows.length) return;
    const [dup, kept] = await Promise.all([this.core.productAdmin(e.duplicateProductId), this.core.productAdmin(e.keptProductId)]);
    if (!kept) {
      this.ctx.log.warn({ keptProductId: e.keptProductId }, 'offers: merge into an unknown product, ignored');
      return;
    }
    const by: By = { actor: SYSTEM };
    const key = (o: Record<string, string>) => JSON.stringify(Object.entries(o).map(([k, v]) => [k.toLowerCase(), v.toLowerCase()]).sort());
    for (const r of rows) {
      const from = dup?.product.variants.find((v) => v.id === r.variant_id);
      let target = from ? kept.product.variants.find((v) => key(v.options) === key(from.options)) : undefined;
      if (!target && e.intoVariantId && (!e.newVariantId || e.newVariantId === r.variant_id)) target = kept.product.variants.find((v) => v.id === e.intoVariantId);
      if (!target && kept.product.variants.length === 1 && (dup?.product.variants.length ?? 1) === 1) target = kept.product.variants[0];
      let moved = false;
      if (target) {
        try {
          await this.repo.transaction(async (tx) => {
            const locked = await this.core.offerRow(r.id, { repo: tx, forUpdate: true });
            await tx.update('offers', r.id, { product_id: kept.product.id, variant_id: target!.id, title: offerTitle(kept.product.title, target!.options), terms_version: locked.published_at ? locked.terms_version + 1 : locked.terms_version, updated_at: this.now() });
          });
          moved = true;
          // the stock item follows the offer to the kept product and variant
          await this.ctx.use('inventory').updateStockItem(r.stock_item_id, { productId: kept.product.id, variantId: target.id }, by.actor);
          await this.core.markDirty([r.variant_id, target.id]);
          if (r.published_at) this.core.publish('offers.offer.updated', { offerId: r.id, productId: kept.product.id, termsVersion: r.terms_version + 1, fields: ['productId', 'variantId'] });
        } catch (err) {
          if (!(err instanceof DuplicateKeyError)) throw err; // the seller already has a New offer there
        }
      }
      if (moved) continue;
      const reason = this.core.statusReason('product_merged', `The product was merged into ${kept.product.title}; no matching variant was found. Review the offer and create it on the right variant.`, by);
      if (r.status === 'active' || r.status === 'out_of_stock') await this.core.move(r.id, { event: 'pause', by, reason, log: { reasonCode: 'product_merged', reason: reason.text } });
      else if (r.status !== 'removed') await this.repo.update('offers', r.id, { status_reason: reason as never, updated_at: this.now() });
    }
    await this.parts.views.refreshContentGaps(e.keptProductId);
  }

  /**
   * Box contents changed: offers whose missingItems name items no longer in the box, or that miss new box items,
   * get missing_items_stale and offers.offer.missing_items_stale once per flag (the seller is asked to review; the
   * offer stays on sale). Titles and content gaps are refreshed from catalog.
   */
  async onProductUpdated(e: EventPayload<'catalog.product.updated'>) {
    const p = await this.core.productAdmin(e.productId);
    if (!p) return;
    const box = p.product.includedItems;
    const lower = (list: readonly string[]) => list.map((x) => x.toLowerCase());
    const rows = await this.repo.find('offers', { product_id: e.productId, status: { op: '<>', value: 'removed' } });
    for (const r of rows) {
      const missing = strings(r.missing_items);
      const included = strings(r.included_items);
      const stale = missing.filter((m) => !lower(box).includes(m.toLowerCase()));
      const newBoxItems = box.filter((b) => !lower([...included, ...missing]).includes(b.toLowerCase()));
      const title = offerTitle(p.product.title, p.product.variants.find((v) => v.id === r.variant_id)?.options);
      const flag = stale.length > 0 || newBoxItems.length > 0;
      const patch: Partial<OfferRec> = {};
      if (title !== r.title) patch.title = title;
      if (flag && !r.missing_items_stale) patch.missing_items_stale = true;
      if (Object.keys(patch).length) await this.repo.update('offers', r.id, { ...patch, updated_at: this.now() });
      if (patch.missing_items_stale) {
        this.core.publish('offers.offer.missing_items_stale', { offerId: r.id, productId: r.product_id, variantId: r.variant_id, ownerType: r.owner_type, sellerId: r.seller_id, title, staleItems: stale, newBoxItems });
      }
      if (!stale.length) continue;
      const already = await this.repo.findOne('offer_status_log', { offer_id: r.id, event: 'review_missing_items', reason: `Review missing items: ${stale.join(', ')} are no longer in the product's box` });
      if (already) continue;
      await this.repo.insert('offer_status_log', {
        id: newId(),
        offer_id: r.id,
        from_status: r.status,
        to_status: r.status,
        event: 'review_missing_items',
        reason_code: 'product_updated',
        reason: `Review missing items: ${stale.join(', ')} are no longer in the product's box`,
        affected_activity: null,
        appeal_route: null,
        review_date: null,
        actor_kind: 'system',
        actor_id: null,
        at: this.now(),
      });
    }
    await this.parts.views.refreshContentGaps(e.productId);
  }

  /* ================================================================ stock, trust, campaigns */

  async onStockChanged(e: EventPayload<'inventory.stock.changed'>) {
    const r = e.offerId && isUuid(e.offerId) ? await this.repo.get('offers', e.offerId) : await this.repo.findOne('offers', { stock_item_id: e.stockItemId, status: { op: '<>', value: 'removed' } });
    if (!r) {
      this.ctx.log.debug({ stockItemId: e.stockItemId }, 'offers: stock change for no offer, ignored');
      return;
    }
    const by: By = { actor: SYSTEM };
    try {
      if (e.available <= 0 && r.status === 'active') await this.core.move(r.id, { event: 'stockDepleted', by, guard: (x) => this.guardStatus(x, 'active') });
      else if (e.available > 0 && r.status === 'out_of_stock') await this.core.move(r.id, { event: 'stockRestored', by, guard: (x) => this.guardStatus(x, 'out_of_stock') });
      else await this.core.markDirty([r.variant_id]);
    } catch (err) {
      if ((err as { skip?: boolean }).skip) return;
      throw err;
    }
  }

  private guardStatus(r: OfferRec, expected: string) {
    if (r.status !== expected) throw Object.assign(new Error('moved'), { skip: true });
  }

  async onEnforcementRecorded(e: EventPayload<'trust.enforcement.recorded'>, actor?: common.Actor) {
    if (e.alreadyApplied) return;
    const targets = (e.targets ?? []) as { type?: string; id?: string }[];
    const ids = targets.filter((t) => t?.type === 'offer' && isUuid(t.id)).map((t) => t.id!);
    if (!ids.length) return;
    const params = (e.params ?? {}) as { mode?: string; reviewDate?: string };
    const by: By = { actor: actor ?? { kind: 'system', id: null, name: 'Trust and Risk' } };
    const hold = params.mode === 'hold' || /hold/i.test(e.action);
    for (const r of await this.repo.getMany('offers', ids)) {
      if (r.status === 'removed') continue;
      if (hold) {
        const reason = this.core.statusReason('enforcement', e.reason, by, { reviewDate: params.reviewDate?.slice(0, 10) ?? null, appealRoute: e.appealDeadline ? `Appeal before ${e.appealDeadline.slice(0, 10)}` : null });
        await this.makeIneligible([r], { kind: 'enforcement', id: e.enforcementId }, reason, by, { trustEnforcementId: e.enforcementId });
      } else {
        // status_reason keeps the enforcement id so a reversal finds the offers it removed
        const reason = { ...this.core.statusReason('enforcement', e.reason, by, { appealRoute: e.appealDeadline ? `Appeal before ${e.appealDeadline.slice(0, 10)}` : null }), enforcementId: e.enforcementId };
        await this.core.move(r.id, { event: 'remove', by, reason, log: { reasonCode: 'enforcement', reason: e.reason, trustEnforcementId: e.enforcementId } });
      }
    }
  }

  /**
   * trust.enforcement.reversed: undoes what onEnforcementRecorded did for that enforcement, once per event (inbox).
   * Offers it removed go back to Paused (reinstate path: inventory unarchives the stock item; the seller resumes);
   * offers it held are released to their previous status (or switch to another cause still stopping them). Offers
   * someone else changed since (seller ended, staff removed for another reason, hold replaced) are left alone and
   * the skip is written to offer_status_log; trust's owner work item covers the rest.
   */
  async onEnforcementReversed(e: EventPayload<'trust.enforcement.reversed'>, eventId: string | undefined, actor?: common.Actor) {
    const targets = (e.targets ?? []) as { type?: string; id?: string }[];
    const ids = targets.filter((t) => t?.type === 'offer' && isUuid(t.id)).map((t) => t.id!);
    if (!ids.length) return;
    if (!(await this.repo.transaction((tx) => tx.claim(eventId ?? `enforcement-reversed:${e.enforcementId}`)))) return;
    const by: By = { actor: actor ?? e.reversedBy ?? { kind: 'system', id: null, name: 'Trust and Risk' } };
    const text = `Enforcement ${e.ref} reversed${e.appealId ? ' after an appeal' : ''}: ${e.reason}`;
    for (const r of await this.repo.getMany('offers', ids)) {
      const mine = enforcementIdOf(r) === e.enforcementId;
      try {
        if (mine && r.status === 'removed') {
          await this.parts.manage.reinstate(r.id, text, by, { trustEnforcementId: e.enforcementId });
          continue;
        }
        if (mine && r.status === 'ineligible') {
          await this.restoreOrSwitch(r, { by, log: { reasonCode: 'enforcement_reversed', reason: text, trustEnforcementId: e.enforcementId } });
          continue;
        }
      } catch (err) {
        if (!isAppError(err) || err.status >= 500) throw err;
        await this.noteSkipped(r, `${text}. Not undone: ${err.message}`);
        continue;
      }
      await this.noteSkipped(r, `${text}. Not undone: the offer was changed by someone else since`);
    }
  }

  /** A reversal that changes nothing on this offer, kept in its status log */
  private async noteSkipped(r: OfferRec, reasonText: string) {
    await this.repo.insert('offer_status_log', {
      id: newId(),
      offer_id: r.id,
      from_status: r.status,
      to_status: r.status,
      event: 'enforcement_reversed',
      reason_code: 'enforcement_reversal_skipped',
      reason: reasonText,
      affected_activity: null,
      appeal_route: null,
      review_date: null,
      actor_kind: 'system',
      actor_id: null,
      at: this.now(),
    });
  }

  async onCampaignStarted(e: EventPayload<'promotions.campaign.started'>) {
    const rows = await this.repo.getMany('offers', e.offerIds.filter(isUuid));
    if (rows.length) await this.core.markDirty(rows.map((r) => r.variant_id));
    else await this.repo.markFeaturedDirty({ all: true });
  }

  async onCampaignEnded(_e: EventPayload<'promotions.campaign.ended'>) {
    // the event names no offers: every cached decision is recomputed by the job
    await this.repo.markFeaturedDirty({ all: true });
  }

  /* ================================================================ Fulfilled by Marketly */

  /**
   * fulfillment-service.offer.service_changed, once per event (inbox): fulfilled_by follows the service; a change of
   * who ships is a customer-visible terms change (termsVersion bumped, offers.offer.updated). sellable false makes the
   * offer Ineligible (fulfillment_service_suspended; it never switches to seller shipping, decision D5); sellable true,
   * or leaving the service, restores offers held by the service. Featured decisions for the variant are recomputed.
   */
  async onServiceChanged(e: EventPayload<'fulfillment-service.offer.service_changed'>, eventId: string | undefined, actor?: common.Actor) {
    const r = isUuid(e.offerId) ? await this.repo.get('offers', e.offerId) : undefined;
    if (!r || r.owner_type !== 'seller' || r.seller_id !== e.sellerId) {
      this.ctx.log.warn({ offerId: e.offerId, sellerId: e.sellerId }, 'offers: service change for no matching seller offer, ignored');
      return;
    }
    const by: By = { actor: actor ?? SYSTEM };
    const applied = await this.repo.transaction(async (tx) => {
      if (!(await tx.claim(eventId ?? `service-changed:${e.offerId}:${e.reason}:${e.at}`))) return null;
      const locked = await this.core.offerRow(e.offerId, { repo: tx, forUpdate: true });
      if (locked.fulfilled_by === e.fulfilledBy) return { row: locked, bumped: false };
      const bumped = Boolean(locked.published_at);
      const row = await tx.update('offers', locked.id, { fulfilled_by: e.fulfilledBy, ...(bumped ? { terms_version: locked.terms_version + 1 } : {}), updated_at: this.now() });
      return { row, bumped };
    });
    if (!applied) return;
    const row = applied.row;
    if (applied.bumped) this.core.publish('offers.offer.updated', { offerId: row.id, productId: row.product_id, termsVersion: row.terms_version, fields: ['fulfilledBy'] }, by);
    await this.core.markDirty([row.variant_id]);

    if (e.fulfilledBy === 'marketly_service' && !e.sellable) {
      const text = SERVICE_HOLD[e.reason === 'enrollment_offboarding' ? 'enrollment_offboarding' : e.reason === 'enrollment_suspended' ? 'enrollment_suspended' : 'service_unavailable'];
      const reason = this.core.statusReason('fulfillment_service_suspended', text, by, { affectedActivity: SERVICE_ACTIVITY });
      await this.makeIneligible([row], { kind: 'fulfillment_service', id: e.skuEnrollmentId }, reason, by);
      return;
    }
    if (row.status === 'ineligible' && this.sourceOf(row).kind === 'fulfillment_service') {
      await this.restoreOrSwitch(row, { by, log: { reasonCode: e.reason, reason: e.fulfilledBy === 'seller' ? 'The offer left Fulfilled by Marketly' : 'Fulfilled by Marketly sells the offer again' } });
    }
  }
}
