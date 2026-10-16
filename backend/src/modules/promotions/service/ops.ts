/**
 * Reactions to other modules' events (offers, inventory, catalog, sellers) and the scheduled jobs:
 * start and end campaigns on time, refresh the resolved offer sets, roll up results.
 * Consumers are idempotent and ignore records they don't know.
 */
import type { EventPayload } from '../../../kernel/events/index.js';
import { flashItemMachine } from '../domain/state-machines.js';
import { moneyFull } from '../domain/rules.js';
import { Part, SYSTEM, type By } from './core.js';

const OPEN = ['draft', 'in_review', 'changes_requested', 'approved', 'scheduled', 'live', 'paused'];
const PUBLISHED = ['scheduled', 'live', 'paused'];

export class OpsPart extends Part {
  /** Campaign ids (not over) whose resolved offer set holds an offer */
  async campaignsWithOffer(offerId: string, statuses = OPEN): Promise<string[]> {
    const rows = await this.repo.find('eligible_offers', { offer_id: offerId });
    if (!rows.length) return [];
    const camps = await this.repo.getMany('campaigns', [...new Set(rows.map((r) => r.campaign_id))]);
    return camps.filter((c) => statuses.includes(c.status)).map((c) => c.id);
  }

  async markIneligible(offerIds: string[], reason: string, campaignIds?: string[]) {
    if (!offerIds.length) return;
    await this.repo.updateWhere('eligible_offers', { offer_id: offerIds, ...(campaignIds ? { campaign_id: campaignIds } : {}) }, { eligible: false, reason, refreshed_at: this.now() });
  }

  /** Flash items of an offer stop (deactivated or hidden offer) */
  async endFlashItems(offerIds: string[], reason: string) {
    if (!offerIds.length) return;
    const items = await this.repo.find('flash_items', { offer_id: offerIds, state: ['active', 'sold_out'] });
    const campaigns = new Map((await this.repo.getMany('campaigns', items.map((f) => f.campaign_id))).map((c) => [c.id, c]));
    for (const f of items) {
      const camp = campaigns.get(f.campaign_id);
      if (!camp || !OPEN.includes(camp.status)) continue;
      await this.repo.transaction(async (tx) => {
        await tx.update('flash_items', f.id, { state: this.core.step(flashItemMachine, f.state, 'end') });
        await this.core.log(tx, f.campaign_id, 'flash_item.removed', { actor: SYSTEM }, reason, { offerId: f.offer_id });
      });
    }
  }

  /* ---------------------------------------------------------------- events */

  async onOfferPriceChanged(e: EventPayload<'offers.offer.price_changed'>) {
    if (e.to.amount <= e.from.amount || !e.sellerId) return;
    const pos = await this.repo.find('participation_offers', { offer_id: e.offerId, included: true });
    if (!pos.length) return;
    const parts = await this.repo.find('participations', { id: pos.map((p) => p.participation_id), state: ['accepted', 'withdrawal_requested'] } as never);
    const campaigns = new Map((await this.repo.getMany('campaigns', parts.map((p) => p.campaign_id))).map((c) => [c.id, c]));
    for (const p of parts) {
      const camp = campaigns.get(p.campaign_id);
      if (!camp || !PUBLISHED.includes(camp.status)) continue;
      const note = `Price raised from ${moneyFull(e.from.amount, e.from.currency)} to ${moneyFull(e.to.amount, e.to.currency)} during the campaign`;
      const key = `${e.offerId}:${e.priceChangeId ?? e.termsVersion}`;
      if (await this.repo.findOne('campaign_log', { campaign_id: p.campaign_id, action: 'participation.price_raised', reason: key })) continue;
      await this.repo.transaction(async (tx) => {
        await tx.update('participations', p.id, { reason: note, updated_at: this.now() });
        await this.core.log(tx, p.campaign_id, 'participation.price_raised', { actor: SYSTEM }, key, { participationId: p.id, sellerId: p.seller_id, offerId: e.offerId, note });
      });
    }
  }

  async onOfferStatusChanged(e: EventPayload<'offers.offer.status_changed'>) {
    if (e.to === e.from) return;
    if (e.to !== 'active') {
      const ids = await this.campaignsWithOffer(e.offerId);
      if (ids.length) await this.markIneligible([e.offerId], `Offer is ${e.to.replace(/_/g, ' ')}`, ids);
      if (['paused', 'removed', 'ineligible', 'draft'].includes(e.to)) await this.endFlashItems([e.offerId], `Offer is ${e.to.replace(/_/g, ' ')}`);
      return;
    }
    for (const id of await this.campaignsWithOffer(e.offerId)) await this.parts.campaigns.refreshEligibleQuietly(id);
  }

  async onStockChanged(e: EventPayload<'inventory.stock.changed'>) {
    if (!e.offerId) return;
    // stock changes are frequent: the offer's flash items, eligible rows and their campaigns in three reads
    const items = await this.repo.find('flash_items', { offer_id: e.offerId, state: ['active', 'sold_out'] });
    const rows = await this.repo.find('eligible_offers', { offer_id: e.offerId });
    const campaigns = new Map((await this.repo.getMany('campaigns', [...items, ...rows].map((r) => r.campaign_id))).map((c) => [c.id, c]));
    for (const f of items) {
      const camp = campaigns.get(f.campaign_id);
      if (!camp || !OPEN.includes(camp.status)) continue;
      const left = f.deal_stock - f.claimed - f.reserved;
      if (left <= e.available) continue;
      const dealStock = f.claimed + f.reserved + Math.max(0, e.available);
      const soldOut = dealStock <= f.claimed + f.reserved && f.state === 'active';
      await this.repo.transaction(async (tx) => {
        await tx.update('flash_items', f.id, { deal_stock: dealStock, ...(soldOut ? { state: this.core.step(flashItemMachine, f.state, 'sellOut'), sold_out_at: this.now() } : {}) });
        await this.core.log(tx, f.campaign_id, 'flash_item.stock_capped', { actor: SYSTEM }, `Deal stock capped at available stock (${e.available})`, { offerId: f.offer_id, dealStock });
      });
      if (soldOut) this.core.publish('promotions.flash_item.sold_out', { campaignId: f.campaign_id, offerId: f.offer_id, at: this.now().toISOString() });
    }
    // participation stock rules
    for (const r of rows) {
      const camp = campaigns.get(r.campaign_id);
      const minStock = (camp?.participation as { minStock?: number | null } | null)?.minStock;
      if (!camp || !OPEN.includes(camp.status) || minStock == null) continue;
      const below = e.available < minStock;
      const reason = `Needs at least ${minStock} units in stock (you have ${e.available})`;
      if (below && r.eligible) await this.repo.updateWhere('eligible_offers', { campaign_id: r.campaign_id, offer_id: r.offer_id }, { eligible: false, reason, refreshed_at: this.now() });
      if (!below && !r.eligible && r.reason?.startsWith('Needs at least')) await this.repo.updateWhere('eligible_offers', { campaign_id: r.campaign_id, offer_id: r.offer_id }, { eligible: true, reason: null, refreshed_at: this.now() });
    }
  }

  async onProductPublicationChanged(e: EventPayload<'catalog.product.publication_changed'>) {
    let offerIds: string[] = [];
    try {
      offerIds = (await this.parts.campaigns.allOffers({ productId: e.productId }, 500)).map((o) => o.id);
    } catch (err) {
      this.ctx.log.warn({ err, productId: e.productId }, 'promotions: offers of a product unavailable');
      return;
    }
    if (!offerIds.length) return;
    if (['hidden', 'suspended', 'removed', 'archived'].includes(e.to)) {
      await this.markIneligible(offerIds, `Product ${e.to}: ${e.reason}`);
      await this.endFlashItems(offerIds, `Product ${e.to}`);
      return;
    }
    const ids = new Set<string>();
    for (const o of offerIds) for (const id of await this.campaignsWithOffer(o)) ids.add(id);
    for (const id of ids) await this.parts.campaigns.refreshEligibleQuietly(id);
  }

  async onProductMerged(e: EventPayload<'catalog.product.merged'>) {
    const targets = await this.repo.find('campaign_targets', { kind: 'product', target_id: e.duplicateProductId });
    for (const t of targets) {
      await this.repo.transaction(async (tx) => {
        const kept = await tx.findOne('campaign_targets', { campaign_id: t.campaign_id, kind: 'product', target_id: e.keptProductId });
        if (kept) await tx.removeWhere('campaign_targets', { campaign_id: t.campaign_id, kind: 'product', target_id: e.duplicateProductId });
        else await tx.updateWhere('campaign_targets', { campaign_id: t.campaign_id, kind: 'product', target_id: e.duplicateProductId }, { target_id: e.keptProductId });
        await this.core.log(tx, t.campaign_id, 'scope.product_merged', { actor: SYSTEM }, e.reason, { from: e.duplicateProductId, to: e.keptProductId });
      });
      await this.parts.campaigns.refreshEligibleQuietly(t.campaign_id);
    }
  }

  async onSellerRestricted(e: EventPayload<'sellers.seller.restricted'>) {
    if (!e.affectedActivities.some((a) => a === 'promotions' || a === 'sales')) return;
    const reason = `Seller restricted: ${e.reason}`;
    if (!e.categoryIds.length) {
      await this.parts.participation.removeSellerEverywhere(e.sellerId, reason);
      const rows = await this.repo.find('eligible_offers', { seller_id: e.sellerId, eligible: true });
      await this.markIneligible([...new Set(rows.map((r) => r.offer_id))], reason);
      return;
    }
    // restriction limited to categories: only the seller's offers in those categories leave
    const rows = await this.repo.find('eligible_offers', { seller_id: e.sellerId, eligible: true });
    const cards = await this.core.offerCards([...new Set(rows.map((r) => r.offer_id))]).catch(() => new Map());
    const hit = [...cards.values()].filter((c) => c.attrs.categoryIds.some((id: string) => e.categoryIds.includes(id))).map((c) => c.offer.id as string);
    await this.markIneligible(hit, reason);
    if (hit.length) await this.repo.updateWhere('participation_offers', { offer_id: hit }, { included: false, eligible: false });
  }

  async onSellerSuspended(e: EventPayload<'sellers.seller.suspended'>) {
    const by: By = { actor: SYSTEM };
    const reason = `Seller suspended: ${e.reason}`;
    await this.parts.participation.removeSellerEverywhere(e.sellerId, reason, by);
    const rows = await this.repo.find('eligible_offers', { seller_id: e.sellerId, eligible: true });
    await this.markIneligible([...new Set(rows.map((r) => r.offer_id))], reason);
    for (const c of await this.repo.find('campaigns', { owner_kind: 'seller', seller_id: e.sellerId, status: ['scheduled', 'live'] })) {
      await this.parts.campaigns.pause(c.id, reason, by);
    }
  }

  /* ---------------------------------------------------------------- jobs */

  async startDue() {
    const due = await this.repo.find('campaigns', { status: 'scheduled', starts_at: { op: '<=', value: this.now() } }, { orderBy: [['starts_at', 'asc']], limit: 100 });
    for (const c of due) await this.parts.campaigns.start(c.id);
  }

  async endDue() {
    const now = this.now();
    const due = await this.repo.find('campaigns', { status: ['scheduled', 'live', 'paused'], ends_at: { op: '<=', value: now } }, { orderBy: [['ends_at', 'asc']], limit: 100 });
    for (const c of due) {
      if (c.status === 'scheduled') await this.parts.campaigns.start(c.id);
      await this.parts.campaigns.end(c.id, 'period_over', { actor: SYSTEM });
    }
  }

  async refreshEligible() {
    const rows = await this.repo.find('campaigns', { status: ['scheduled', 'live'] }, { orderBy: [['updated_at', 'asc']], limit: 50 });
    for (const c of rows) await this.parts.campaigns.refreshEligibleQuietly(c.id);
  }

  async resultsRollup() {
    const since = new Date(this.now().getTime() - 30 * 86_400_000);
    const rows = await this.repo.find('campaigns', { status: ['live', 'paused', 'ended'], updated_at: { op: '>=', value: since } }, { limit: 200 });
    const active = await this.repo.find('campaigns', { status: ['live', 'paused'] }, { limit: 200 });
    for (const id of new Set([...rows, ...active].map((c) => c.id))) {
      for (const r of await this.parts.campaigns.rollupCampaign(id)) await this.repo.upsertResult(r);
    }
  }
}
