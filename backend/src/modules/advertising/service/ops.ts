/**
 * Reactions to other modules (promotions, offers, inventory, catalog, sellers, trust, orders, content,
 * access) and the background jobs: start and finish on schedule, availability sweep, link checks, frequency
 * clean-up and ending-soon reminders. Consumers are idempotent and ignore records they don't know.
 */
import { AppError } from '../../../kernel/errors/index.js';
import type { EventPayload } from '../../../kernel/events/index.js';
import { isUuid, newId } from '../../../kernel/lib/ids.js';
import { adCampaignMachine, creativeReviewMachine } from '../domain/state-machines.js';
import type { CampaignRec } from '../ports.js';
import { encodeActor, Part, SYSTEM, SYSTEM_BY } from './core.js';

type CampaignStatus = Parameters<typeof adCampaignMachine.next>[0];
type CreativeStatus = Parameters<typeof creativeReviewMachine.next>[0];

/** How a trust enforcement id is kept with a revoke or reject reason */
export const enforcementMarker = (enforcementId: string) => `(enforcement ${enforcementId})`;
import { CHARGE_TARGET, VOID_ACTION } from './billing.js';
import { RULES_ACTION, RULES_TARGET } from './setup.js';

/** Automatic pauses the sweep may lift when the cause is gone (seller and trust pauses stay for staff) */
const SWEEP_RESUMABLE = ['offer', 'stock', 'product', 'availability', 'promotion'];
const BATCH = 500;

const ignoreIllegal = (err: unknown) => {
  if (!(err instanceof AppError) || (err.code !== 'ILLEGAL_TRANSITION' && err.code !== 'NOT_FOUND' && err.code !== 'AD_UNAVAILABLE')) throw err;
};

export class OpsPart extends Part {
  /* ================================================================ helpers */

  private async campaignsFor(kinds: string[], targetIds: string[]): Promise<CampaignRec[]> {
    const items = await this.repo.campaignsPromoting(kinds, targetIds);
    return this.repo.getMany('campaigns', [...new Set(items.map((i) => i.campaign_id))]);
  }

  /** Campaigns promoting these products, directly or through an offer of them (campaign_items.product_id) */
  private async campaignsForProducts(productIds: string[]): Promise<CampaignRec[]> {
    if (!productIds.length) return [];
    const items = await this.repo.find('campaign_items', { product_id: productIds });
    return this.repo.getMany('campaigns', [...new Set(items.map((i) => i.campaign_id))]);
  }

  async autoPause(rows: readonly CampaignRec[], cause: string, reason: string): Promise<number> {
    let n = 0;
    for (const r of rows.filter((x) => x.status === 'live' || x.status === 'scheduled')) {
      try {
        await this.parts.campaigns.pause(r.id, reason, SYSTEM_BY, { cause });
        n++;
      } catch (err) {
        ignoreIllegal(err);
      }
    }
    return n;
  }

  /** Resumes campaigns paused automatically for one of the causes (pause_cause), when they can run again */
  async autoResume(rows: readonly CampaignRec[], causes: readonly string[]): Promise<number> {
    const paused = rows.filter((x) => x.status === 'paused');
    if (!paused.length) return 0;
    let n = 0;
    for (const r of paused) {
      const cause = r.pause_cause;
      if (!cause || !causes.includes(cause)) continue;
      if (await this.parts.campaigns.unavailability(r)) continue;
      try {
        await this.parts.campaigns.resume(r.id, 'Available again', SYSTEM_BY, { logAction: `auto_resume:${cause}`, skipAvailability: true });
        n++;
      } catch (err) {
        ignoreIllegal(err);
      }
    }
    return n;
  }

  /* ================================================================ consumers */

  async onPromotionEnded(e: EventPayload<'promotions.campaign.ended'>) {
    if (!isUuid(e.campaignId)) return;
    const rows = await this.repo.find('campaigns', { linked_promotion_id: e.campaignId, status: ['scheduled', 'live', 'paused'], stop_with_promotion: true });
    for (const r of rows) await this.parts.campaigns.finish(r.id, 'promotion_ended', `Linked promotion ended (${e.reason.replace(/_/g, ' ')})`, SYSTEM_BY).catch(ignoreIllegal);
  }

  async onPromotionPaused(e: EventPayload<'promotions.campaign.paused'>) {
    if (!isUuid(e.campaignId)) return;
    const rows = await this.repo.find('campaigns', { linked_promotion_id: e.campaignId, status: ['scheduled', 'live'] });
    await this.autoPause(rows, 'promotion', `Linked promotion paused${e.reason ? `: ${e.reason}` : ''}`);
  }

  async onPromotionResumed(e: EventPayload<'promotions.campaign.resumed'>) {
    if (!isUuid(e.campaignId)) return;
    const rows = await this.repo.find('campaigns', { linked_promotion_id: e.campaignId, status: 'paused' });
    await this.autoResume(rows, ['promotion']);
  }

  async onOfferStatusChanged(e: EventPayload<'offers.offer.status_changed'>) {
    if (!isUuid(e.offerId)) return;
    this.core.forgetOffers([e.offerId]);
    const rows = await this.campaignsFor(['offer'], [e.offerId]);
    if (!rows.length) return;
    if (e.to !== 'active') await this.autoPause(rows, 'offer', `Promoted offer is ${e.to.replace(/_/g, ' ')}`);
    else await this.autoResume(rows, ['offer', 'stock']);
  }

  async onStockLow(e: EventPayload<'inventory.stock.low'>) {
    if (!e.offerId || !isUuid(e.offerId)) return;
    this.core.forgetOffers([e.offerId]);
    const min = await this.core.num('minPromotedStock', 10);
    if (e.available >= min) return;
    const rows = await this.campaignsFor(['offer'], [e.offerId]);
    await this.autoPause(rows, 'stock', `Promoted offer has ${e.available} left (minimum ${min})`);
  }

  async onStockChanged(e: EventPayload<'inventory.stock.changed'>) {
    if (!e.offerId || !isUuid(e.offerId)) return;
    this.core.forgetOffers([e.offerId]);
    const rows = await this.campaignsFor(['offer'], [e.offerId]);
    if (!rows.length) return;
    const min = await this.core.num('minPromotedStock', 10);
    if (e.available < min) await this.autoPause(rows, 'stock', `Promoted offer has ${e.available} left (minimum ${min})`);
    else await this.autoResume(rows, ['stock']);
  }

  async onProductPublicationChanged(e: EventPayload<'catalog.product.publication_changed'>) {
    if (!isUuid(e.productId)) return;
    const rows = await this.campaignsForProducts([e.productId]);
    if (!rows.length) return;
    this.core.forgetOffers();
    if (e.to === 'hidden' || e.to === 'suspended') await this.autoPause(rows, 'product', `Promoted product is ${e.to}`);
    else if (e.to === 'active') await this.autoResume(rows, ['product']);
  }

  async onSellerRestricted(e: EventPayload<'sellers.seller.restricted'>) {
    if (!isUuid(e.sellerId)) return;
    if (!e.affectedActivities?.some((a) => a === 'advertising' || a === 'sales')) return;
    const rows = await this.repo.find('campaigns', { seller_id: e.sellerId, status: ['scheduled', 'live'] });
    await this.autoPause(rows, 'seller', `Seller restricted: ${e.reason}`);
  }

  /** Finish the seller's ads (seller_restricted); charges only for delivery so far; requests in review are rejected */
  async onSellerSuspended(e: EventPayload<'sellers.seller.suspended'>) {
    if (!isUuid(e.sellerId)) return;
    const rows = await this.repo.find('campaigns', { seller_id: e.sellerId, status: ['scheduled', 'live', 'paused', 'in_review'] });
    for (const r of rows) {
      if (r.status === 'in_review') await this.parts.campaigns.reject(r.id, 'Seller suspended', SYSTEM_BY, { audit: false }).catch(ignoreIllegal);
      else await this.parts.campaigns.finish(r.id, 'seller_restricted', `Seller suspended: ${e.reason}`, SYSTEM_BY).catch(ignoreIllegal);
    }
  }

  /** Revoke creatives and reject requests that promote the enforced offer or product */
  async onEnforcementRecorded(e: EventPayload<'trust.enforcement.recorded'>) {
    const targets = (e.targets ?? []) as { type?: string; id?: string }[];
    const offerIds = targets.filter((t) => t.type === 'offer' && isUuid(t.id)).map((t) => t.id!);
    const productIds = targets.filter((t) => t.type === 'product' && isUuid(t.id)).map((t) => t.id!);
    if (!offerIds.length && !productIds.length) return;
    const rows = [...(await this.campaignsFor(['offer'], offerIds)), ...(await this.campaignsForProducts(productIds))];
    const seen = new Set<string>();
    // the enforcement id stays with the revoke or reject reason, so trust.enforcement.reversed can find them
    const reason = `Trust enforcement: ${e.reason} ${enforcementMarker(e.enforcementId)}`;
    for (const r of rows) {
      if (seen.has(r.id)) continue;
      seen.add(r.id);
      const links = await this.repo.find('campaign_creatives', { campaign_id: r.id });
      for (const l of links) await this.parts.creatives.revoke(l.creative_id, reason, SYSTEM_BY);
      if (r.status === 'in_review') await this.parts.campaigns.reject(r.id, reason, SYSTEM_BY, { audit: false }).catch(ignoreIllegal);
      else if (r.status === 'live' || r.status === 'scheduled') await this.autoPause([r], 'trust', reason);
    }
  }

  /**
   * trust.enforcement.reversed (inbox-claimed per event): creatives that enforcement revoked go back to review
   * (reinstate, never straight to approved) and seller requests it rejected reopen as drafts the seller may
   * resubmit. Ads finished because of it are not restarted. The campaign log records the reversal.
   */
  async onEnforcementReversed(e: EventPayload<'trust.enforcement.reversed'>, eventId?: string) {
    if (!isUuid(e.enforcementId)) return;
    const { creativeIds, campaignIds } = await this.repo.enforcementTargets(enforcementMarker(e.enforcementId));
    if (!creativeIds.length && !campaignIds.length) return;
    const note = `Trust enforcement ${e.ref} reversed: ${e.reason}`;
    const by = { actor: e.reversedBy ?? SYSTEM };
    const now = this.now();
    const changed = await this.repo.transaction(async (tx) => {
      if (!(await tx.claim(`enforcement-reversed:${eventId ?? e.enforcementId}`))) return null;
      const reopened: { row: CampaignRec; from: string }[] = [];
      const reinstated: string[] = [];
      for (const id of creativeIds) {
        const c = await tx.get('creatives', id, { forUpdate: true });
        if (!c || !creativeReviewMachine.can(c.status as CreativeStatus, 'reinstate')) continue;
        await tx.update('creatives', id, { status: creativeReviewMachine.next(c.status as CreativeStatus, 'reinstate') });
        await tx.insert('creative_reviews', { id: newId(), creative_id: id, reviewer_id: encodeActor(by.actor), role: 'advertising', decision: 'note', reason_code: null, comment: note, at: now });
        reinstated.push(id);
      }
      for (const id of campaignIds) {
        const c = await tx.get('campaigns', id, { forUpdate: true });
        if (!c || !adCampaignMachine.can(c.status as CampaignStatus, 'reopen')) continue;
        const to = adCampaignMachine.next(c.status as CampaignStatus, 'reopen');
        const row = await tx.update('campaigns', id, { status: to, paused_reason: null, paused_by: null, paused_at: null, pause_cause: null, rejected_reason: null, updated_at: now, version: c.version + 1 });
        await this.core.log(tx, id, 'reopen', by, { from: c.status, to, reason: note });
        reopened.push({ row, from: c.status });
      }
      return { reopened, reinstated };
    });
    if (!changed) return;
    for (const r of changed.reopened) this.parts.campaigns.statusChanged(r.row, r.from, note, by);
    for (const id of changed.reinstated) {
      const link = await this.repo.findOne('campaign_creatives', { creative_id: id });
      this.core.publish('advertising.creative.reviewed', { creativeId: id, campaignId: link?.campaign_id ?? null, decision: 'note', reasonCode: null }, by);
    }
    this.parts.serving.invalidate();
  }

  /**
   * Attribute the order to the last ad click within the attribution period: by customerId for signed-in shoppers,
   * for guests by visitorId (only on the payload when they allowed personalization; clicks made without it are kept
   * under a session key and never match). Neither: not attributed.
   */
  async onOrderPlaced(e: EventPayload<'orders.order.placed'>) {
    if (!isUuid(e.orderId) || (!e.customerId && !e.visitorId)) return;
    const rules = await this.core.rules();
    const placedAt = new Date(e.placedAt);
    const at = Number.isNaN(placedAt.getTime()) ? this.now() : placedAt;
    const since = new Date(at.getTime() - rules.attributionDays * 86_400_000);
    const click = e.customerId ? await this.repo.lastClick(e.customerId, since) : await this.repo.lastClickByVisitor(this.parts.serving.attributionKey(e.visitorId!), since);
    if (!click || click.at.getTime() > at.getTime() + 60_000) return;
    const c = await this.repo.get('campaigns', click.campaign_id);
    if (!c) return;
    const groups = e.groups ?? [];
    const amount = c.advertiser_kind === 'seller' ? groups.filter((g) => g.sellerId === c.seller_id).reduce((a, g) => a + g.total.amount, 0) : c.advertiser_kind === 'official_store' ? groups.filter((g) => g.ownerType === 'official').reduce((a, g) => a + g.total.amount, 0) : e.total.amount;
    if (amount <= 0) return;
    await this.repo.insertIgnore('attributions', { id: newId(), order_id: e.orderId, campaign_id: c.id, click_event_id: click.id, amount, currency: e.total.currency, attributed_at: at, reversed: false });
  }

  /** Reduce attributed sales for cancelled items (one adjustment per cancellation) */
  async onItemCancelled(e: EventPayload<'orders.item.cancelled'>) {
    if (!isUuid(e.orderId) || !isUuid(e.cancellationId)) return;
    const rows = (await this.repo.find('attributions', { order_id: e.orderId })).filter((a) => a.amount > 0);
    for (const a of rows) {
      const c = await this.repo.get('campaigns', a.campaign_id);
      if (!c) continue;
      if (c.advertiser_kind === 'seller' && c.seller_id !== e.sellerId) continue;
      if (c.advertiser_kind === 'official_store' && e.ownerType !== 'official') continue;
      const adjustments = await this.repo.find('attributions', { campaign_id: a.campaign_id, click_event_id: a.click_event_id, amount: { op: '<', value: 0 } });
      const remaining = a.amount + adjustments.reduce((s, x) => s + x.amount, 0);
      const reduce = Math.min(Math.max(e.refund?.itemAmount?.amount ?? 0, 0), remaining);
      if (reduce <= 0) continue;
      const inserted = await this.repo.insertIgnore('attributions', { id: newId(), order_id: e.cancellationId, campaign_id: a.campaign_id, click_event_id: a.click_event_id, amount: -reduce, currency: a.currency, attributed_at: this.now(), reversed: true });
      if (inserted && remaining - reduce <= 0) await this.repo.update('attributions', a.id, { reversed: true });
    }
  }

  /** Re-run link checks for creatives pointing at the page */
  async onPagePublished(e: EventPayload<'content.page.published'>) {
    if (!e.url) return;
    const rows = await this.repo.find('creatives', { link: e.url });
    for (const r of rows) await this.parts.creatives.refreshChecks(r);
  }

  async onApprovalDecided(e: EventPayload<'access.approval.decided'>, eventId?: string) {
    if (e.actionKey === RULES_ACTION && e.target?.type === RULES_TARGET) await this.parts.setup.onRulesDecided(e, eventId);
    else if (e.actionKey === VOID_ACTION && e.target?.type === CHARGE_TARGET) await this.parts.billing.onVoidDecided(e, eventId);
  }

  /** Repoint ads, requests and creatives from the duplicate product to the kept one; history stays on the ad */
  async onProductMerged(e: EventPayload<'catalog.product.merged'>) {
    if (!isUuid(e.duplicateProductId) || !isUuid(e.keptProductId)) return;
    const items = await this.repo.find('campaign_items', { product_id: [e.duplicateProductId] });
    const campaignIds = [...new Set(items.map((i) => i.campaign_id))];
    for (const id of campaignIds) {
      await this.repo.transaction(async (tx) => {
        await tx.updateWhere('campaign_items', { campaign_id: id, kind: 'product', target_id: e.duplicateProductId }, { target_id: e.keptProductId });
        await tx.updateWhere('campaign_items', { campaign_id: id, product_id: e.duplicateProductId }, { product_id: e.keptProductId });
        const c = await tx.get('campaigns', id, { forUpdate: true });
        const dest = (c?.destination ?? null) as { kind?: string; targetId?: string | null; url?: string } | null;
        if (c && dest && (dest.targetId === e.duplicateProductId || dest.url?.includes(e.duplicateProductId))) {
          await tx.update('campaigns', id, { destination: { ...dest, targetId: dest.targetId === e.duplicateProductId ? e.keptProductId : dest.targetId, url: (dest.url ?? '').split(e.duplicateProductId).join(e.keptProductId) } as never, updated_at: this.now() });
        }
        await this.core.log(tx, id, 'repoint', SYSTEM_BY, { reason: `Product merged into ${e.keptProductId}` });
      });
    }
    // creatives linking to the duplicate product page
    const creatives = await this.repo.find('creatives', { link: { op: 'is not', value: null } }, { limit: 20_000 });
    for (const cr of creatives.filter((x) => x.link?.includes(e.duplicateProductId))) {
      await this.repo.update('creatives', cr.id, { link: cr.link!.split(e.duplicateProductId).join(e.keptProductId) });
    }
    if (campaignIds.length) this.parts.serving.invalidate();
  }

  /* ================================================================ jobs */

  /** Scheduled campaigns past startsAt go live (or finish when their end has passed too) */
  async startDue(ids?: string[]): Promise<void> {
    const now = this.now();
    const rows = await this.repo.find('campaigns', { status: 'scheduled', starts_at: { op: '<=', value: now }, ...(ids ? { id: ids } : {}) }, { orderBy: [['starts_at', 'asc']], limit: BATCH });
    for (const r of rows) {
      if (r.ends_at && r.ends_at.getTime() <= now.getTime()) await this.parts.campaigns.finish(r.id, 'ended', null, SYSTEM_BY).catch(ignoreIllegal);
      else await this.parts.campaigns.transition(r.id, 'start', SYSTEM_BY).catch(ignoreIllegal);
    }
  }

  /** Running campaigns past endsAt finish; so do those that reached their delivery cap */
  async finishDue(): Promise<void> {
    const now = this.now();
    const ended = await this.repo.find('campaigns', { status: ['scheduled', 'live', 'paused'], ends_at: { op: '<=', value: now } }, { orderBy: [['ends_at', 'asc']], limit: BATCH });
    for (const r of ended) await this.parts.campaigns.finish(r.id, 'ended', null, SYSTEM_BY).catch(ignoreIllegal);
    const capped = await this.repo.find('campaigns', { status: ['live', 'paused'], delivery_cap: { op: 'is not', value: null } }, { limit: BATCH });
    for (const r of capped) {
      const shown = await this.repo.displaysIn(r.id, { from: new Date(0), to: new Date(now.getTime() + 1000) });
      if (shown >= (r.delivery_cap ?? Infinity)) await this.parts.campaigns.finish(r.id, 'delivery_cap_reached', `${shown} displays reached the delivery cap`, SYSTEM_BY).catch(ignoreIllegal);
    }
  }

  /** Pause ads for unavailable or low-stock promoted offers and inactive linked promotions; resume when available again */
  async availabilitySweep(): Promise<void> {
    this.core.forgetOffers();
    const running = await this.repo.find('campaigns', { status: ['scheduled', 'live'] }, { limit: BATCH * 4 });
    const withItems = new Set((await this.repo.find('campaign_items', { campaign_id: running.map((r) => r.id), kind: 'offer' })).map((i) => i.campaign_id));
    for (const r of running.filter((x) => withItems.has(x.id) || x.linked_promotion_id)) {
      const problem = await this.parts.campaigns.unavailability(r);
      if (problem) await this.autoPause([r], 'availability', problem);
    }
    const paused = await this.repo.find('campaigns', { status: 'paused' }, { limit: BATCH * 4 });
    await this.autoResume(paused, SWEEP_RESUMABLE);
  }

  /** Re-check destination links and promoted-offer availability for approved and live creatives */
  async linkCheck(): Promise<void> {
    const campaigns = await this.repo.find('campaigns', { status: ['approved', 'scheduled', 'live', 'paused'] }, { limit: BATCH * 4 });
    const links = await this.repo.find('campaign_creatives', { campaign_id: campaigns.map((c) => c.id) });
    const creatives = await this.repo.getMany(
      'creatives',
      links.map((l) => l.creative_id),
    );
    this.core.forgetOffers();
    for (const c of creatives.filter((x) => x.status === 'approved' || x.status === 'in_review').slice(0, BATCH)) {
      try {
        await this.parts.creatives.refreshChecks(c);
      } catch (err) {
        this.ctx.log.warn({ err, creativeId: c.id }, 'advertising: link check failed');
      }
    }
  }

  /** Delete frequency and suppression rows past their window (and rows of ended campaigns) */
  async expireFrequencyState(): Promise<void> {
    const now = this.now();
    const ended = await this.repo.find('campaigns', { status: ['finished', 'archived', 'rejected'] }, { orderBy: [['updated_at', 'desc']], limit: 1000 });
    // a running campaign with a total cap (perCampaign) keeps its counters until it ends
    const running = await this.repo.find('campaigns', { status: ['scheduled', 'live', 'paused'] });
    const keep = running.filter((c) => (c.frequency_cap as { perCampaign?: number | null } | null)?.perCampaign).map((c) => c.id);
    await this.repo.expireFrequency(
      now,
      new Date(now.getTime() - 31 * 86_400_000),
      ended.map((c) => c.id),
      keep,
    );
  }

  /**
   * Publishes advertising.campaign.ending_soon for live and scheduled campaigns ending within endingSoonDays, so
   * owners finish or renew deliberately (notifications tells the seller or the staff owner). Once per campaign and
   * end date: the inbox key commits with the timeline entry, so a rerun (or a second instance) sends nothing new;
   * a campaign renewed to a later end is reminded again before that end.
   */
  async endingSoonNotice(): Promise<number> {
    const now = this.now();
    const days = await this.core.num('endingSoonDays', 3);
    const horizon = new Date(now.getTime() + days * 86_400_000);
    // ends after now and within the window (the window's start is checked below)
    const rows = await this.repo.find('campaigns', { status: ['scheduled', 'live'], ends_at: { op: '<=', value: horizon } }, { orderBy: [['ends_at', 'desc']], limit: BATCH * 4 });
    let sent = 0;
    for (const r of rows) {
      if (!r.ends_at || r.ends_at <= now || r.ends_at > horizon) continue;
      const endsAt = r.ends_at;
      const when = new Intl.DateTimeFormat('en-US', { month: 'short', day: 'numeric', timeZone: r.time_zone || this.core.tz() }).format(endsAt);
      const claimed = await this.repo.transaction(async (tx) => {
        if (!(await tx.claim(`ending-soon:${r.id}:${endsAt.toISOString()}`))) return false;
        await this.core.log(tx, r.id, 'ending_soon_notice', { actor: SYSTEM }, { reason: `Ends ${when}: finish or renew deliberately` });
        return true;
      });
      if (!claimed) continue;
      this.core.publish('advertising.campaign.ending_soon', {
        campaignId: r.id,
        ref: r.ref,
        name: r.name,
        advertiserKind: r.advertiser_kind,
        sellerId: r.seller_id,
        ownerStaffId: r.owner_staff_id,
        endsAt: endsAt.toISOString(),
        daysLeft: Math.max(0, Math.ceil((endsAt.getTime() - now.getTime()) / 86_400_000)),
      });
      sent++;
    }
    return sent;
  }
}
