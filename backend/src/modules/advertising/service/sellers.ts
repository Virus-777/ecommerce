/**
 * Seller sponsored campaigns (phase 3): requests for the seller's own active offers with stock, daily and
 * total spending limits, Marketly review, pause/resume by the seller, results and ad charges. Sellers only
 * ever reach their own campaigns (another seller's id is 404).
 */
import { AppError } from '../../../kernel/errors/index.js';
import { isUuid } from '../../../kernel/lib/ids.js';
import type { PageRequest } from '../../../kernel/lib/pagination.js';
import type { AdCampaignInput, CreativeInput, PricingOption, SellerAdCampaign, SellerAdRequestInput, SellerAdsSummary } from '../../../spec/advertising.js';
import type * as common from '../../../spec/common.js';
import { billingLabel, EXAMPLE_RATES } from '../domain/rules.js';
import { adCampaignMachine } from '../domain/state-machines.js';
import { decodeActor, invalid, notFound, Part, type By } from './core.js';
import type { Model } from './views.js';

const AUDIENCE_NOTE = 'Shown to shoppers on the pages you chose, labelled Sponsored. No personal targeting; paid placement never changes the order of other results.';

export interface PromotableOffer {
  offerId: string;
  productId: string;
  title: string;
  sku?: string | null;
  image?: common.MediaRef | null;
  stockLabel: string;
  eligible: boolean;
  reason?: string | null;
}

const toPageInput = (page: PageRequest): common.PageInput => (page.mode === 'page' ? { page: page.page, limit: page.limit } : { ...(page.cursor ? { cursor: page.cursor } : {}), limit: page.limit });

export class SellerPart extends Part {
  /* ---------------------------------------------------------------- reads */

  async summary(sellerId: string, q: { from?: string; to?: string }): Promise<SellerAdsSummary> {
    const to = q.to ?? this.core.today();
    const from = q.from ?? this.core.addDays(to, -29);
    if (from > to) throw invalid([{ path: 'from', message: 'The start must be before the end' }]);
    const campaigns = await this.repo.find('campaigns', { seller_id: sellerId });
    const totals = campaigns.length ? await this.repo.totals(campaigns.map((c) => c.id), { from, to }) : new Map();
    const sum = (k: 'spend' | 'clicks' | 'attributedOrders') => [...totals.values()].reduce((a, t) => a + t[k], 0);
    const rules = await this.core.rules();
    return {
      range: { from, to },
      spend: this.core.money(sum('spend')),
      clicks: sum('clicks'),
      attributedOrders: sum('attributedOrders'),
      attributionDays: rules.attributionDays,
      statementNote: 'Ad charges appear on your statement as their own line, separate from sales commission. Unused budget is never charged.',
    };
  }

  async list(sellerId: string, q: { status?: string }, page: PageRequest): Promise<common.Page<SellerAdCampaign>> {
    const res = await this.repo.listCampaigns({ sellerId, ...(q.status ? { statuses: q.status.split(',').map((s) => s.trim()) } : {}) }, page);
    const models = await this.parts.views.models(res.items);
    const out: SellerAdCampaign[] = [];
    for (const m of models) out.push(await this.view(m, { light: true }));
    return { ...res, items: out };
  }

  async get(sellerId: string, id: string): Promise<SellerAdCampaign> {
    if (!isUuid(id)) throw notFound('Campaign');
    return this.view(await this.parts.views.model(id, { sellerId }));
  }

  async view(m: Model, o: { light?: boolean } = {}): Promise<SellerAdCampaign> {
    const r = m.row;
    const rules = await this.core.rules();
    const [summary] = await this.parts.views.summaries([r], 'seller');
    const totals = await this.repo.totals([r.id]);
    const creatives = await this.parts.views.creativesOf(m);
    const checks = o.light ? null : await this.parts.campaigns.checksFor(m);
    const previews = o.light ? null : await this.parts.serving.preview(m, 'light').catch(() => null);
    const offers = m.items.filter((i) => i.kind === 'offer');
    const promotes = offers.length === 1 ? (offers[0]!.label ?? '1 offer') : offers.length ? `${offers.length} offers: ${offers.map((i) => i.label ?? 'Offer').join(', ')}` : 'Your store';
    return {
      campaign: summary!,
      promotes,
      billingLabel: billingLabel(r.billing, r.rate, r.currency, true),
      spend: this.core.money(r.spent, r.currency),
      dailyLimit: this.core.money(r.daily_limit ?? 0, r.currency),
      totalLimit: this.core.money(r.total_limit ?? 0, r.currency),
      audienceNote: AUDIENCE_NOTE,
      reviewChecks: checks?.checks ?? [],
      creatives,
      previews,
      timeline: o.light ? [] : await this.parts.views.timeline(r.id),
      nextSteps: this.nextSteps(r.status, r.starts_at, r.time_zone),
      metrics: this.parts.views.metrics(totals.get(r.id), rules.attributionDays, r.currency),
    };
  }

  private nextSteps(status: string, startsAt: Date | null, tz: string): string[] {
    const start = startsAt ? new Intl.DateTimeFormat('en-US', { month: 'short', day: 'numeric', timeZone: tz || this.core.tz() }).format(startsAt) : 'the start date';
    switch (status) {
      case 'draft':
        return ['Check the preview and submit for Marketly review', 'Nothing runs or is charged until it is approved and scheduled'];
      case 'in_review':
        return ['Marketly reviews the request (placement, limits and claims)', 'Editing it now sends it back to the start of review'];
      case 'approved':
      case 'scheduled':
        return [`Starts ${start}`, 'You can pause it at any time'];
      case 'live':
        return ['Pause it at any time; charges stop with delivery', 'Charges appear on your statement as their own line'];
      case 'paused':
        return ['Resume when you are ready (campaigns paused by Marketly are resumed by Marketly)'];
      case 'finished':
        return ['Create a new request to advertise again'];
      case 'rejected':
        return ['Read the reason, fix the request and create a new one'];
      default:
        return [];
    }
  }

  pricing(type?: string): PricingOption[] {
    const cur = this.core.currency();
    const types = type ? [type] : ['sponsored_product', 'sponsored_store'];
    const out: PricingOption[] = [];
    for (const t of types) {
      const r = EXAMPLE_RATES[t];
      if (!r) continue;
      const opts: [PricingOption['billing'], number][] = t === 'sponsored_product' ? [['cpc', r.cpc], ['fixed_daily', r.fixed_daily]] : [['cpm', r.cpm], ['fixed_daily', r.fixed_daily]];
      for (const [billing, rate] of opts) out.push({ billing, rate: this.core.money(rate, cur), label: billingLabel(billing, rate, cur, true), isExample: true });
    }
    return out;
  }

  async promotableOffers(sellerId: string, q: { q?: string }, page: PageRequest): Promise<common.Page<PromotableOffer>> {
    const offers = this.ctx.tryUse('offers');
    if (!offers) return { items: [], nextCursor: null };
    const res = await offers.listOffersAdmin({ sellerId, status: ['active'], ...(q.q ? { q: q.q } : {}) }, toPageInput(page));
    const info = await this.core.offerInfo(res.items.map((o) => o.id));
    const items = res.items.map((o) => {
      const i = info?.get(o.id) ?? null;
      return {
        offerId: o.id,
        productId: o.productId,
        title: i?.title ?? o.sellerSku,
        sku: o.sellerSku,
        image: i?.image ?? null,
        stockLabel: i?.available === null || i?.available === undefined ? 'Stock unknown' : `${i.available} in stock`,
        eligible: Boolean(i?.promotable),
        reason: i?.reason ?? null,
      };
    });
    return { ...res, items };
  }

  /* ---------------------------------------------------------------- requests */

  private async assertPaidAdsOn(sellerId: string) {
    const rules = await this.core.rules();
    if (!rules.paidSellerAdsEnabled) throw this.ctx.error('PAID_ADS_DISABLED', 'Paid seller advertising is not enabled yet.');
    const can = await this.core.optional('sellers', (s) => s.canSell(sellerId, { activity: 'advertising' }));
    if (can && !can.allowed) throw new AppError('FORBIDDEN', can.reason ?? 'Advertising is restricted for this account', { restrictionId: can.restrictionId ?? null, appealRoute: can.appealRoute ?? null });
  }

  /** Own active offers with enough stock only (OFFER_NOT_PROMOTABLE otherwise) */
  private async checkOffers(sellerId: string, offerIds: readonly string[]) {
    const api = this.ctx.tryUse('offers');
    if (!api) throw this.ctx.error('OFFER_NOT_PROMOTABLE', 'Offers cannot be checked right now; try again later.');
    this.core.forgetOffers(offerIds);
    const info = await this.core.offerInfo(offerIds);
    for (const id of offerIds) {
      const own = isUuid(id) ? await api.getOwnOffer(sellerId, id).catch(() => null) : null;
      if (!own) throw this.ctx.error('OFFER_NOT_PROMOTABLE', 'This offer is not one of your offers.', { offerId: id });
      const i = info?.get(id);
      if (!i?.promotable) throw this.ctx.error('OFFER_NOT_PROMOTABLE', `This offer can't be promoted: ${i?.reason ?? 'not active'}.`, { offerId: id, reason: i?.reason ?? null });
    }
    return info!;
  }

  private async toInput(sellerId: string, input: SellerAdRequestInput, keep: { textCreativeIds?: string[] } = {}): Promise<AdCampaignInput> {
    const issues: { path: string; message: string }[] = [];
    if (input.type === 'sponsored_product' && !input.offerIds?.length) issues.push({ path: 'offerIds', message: 'Choose at least one offer' });
    if ((input.offerIds?.length ?? 0) > 10) issues.push({ path: 'offerIds', message: '10 offers at most' });
    if (input.headline && input.headline.trim().length > 40) issues.push({ path: 'headline', message: 'The card headline is 40 characters at most' });
    if (input.dailyLimit && input.totalLimit && input.dailyLimit.amount > input.totalLimit.amount) issues.push({ path: 'dailyLimit', message: 'The daily limit cannot be above the total limit' });
    if (!(input.dailyLimit?.amount > 0)) issues.push({ path: 'dailyLimit', message: 'Set a daily limit' });
    if (!(input.totalLimit?.amount > 0)) issues.push({ path: 'totalLimit', message: 'Set a total limit' });
    if (input.type === 'sponsored_product' && input.billing !== 'cpc' && input.billing !== 'fixed_daily') issues.push({ path: 'billing', message: 'Per click or fixed daily fee' });
    if (issues.length) throw invalid(issues);
    const info = input.offerIds?.length ? await this.checkOffers(sellerId, input.offerIds) : new Map();
    const first = input.offerIds?.[0] ? info.get(input.offerIds[0]) : null;
    const rate = EXAMPLE_RATES[input.type]?.[input.billing] ?? EXAMPLE_RATES.sponsored_product!.cpc;
    const creativeIds = [...(input.creativeIds ?? [])];
    if (!input.headline?.trim()) creativeIds.push(...(keep.textCreativeIds ?? []));
    return {
      name: input.name,
      advertiser: { kind: 'seller', sellerId },
      goal: 'seller_offer',
      placementKey: input.type,
      pages: input.pages,
      pageCategoryIds: input.categoryIds ?? [],
      audience: { mode: 'all', regions: [], visitors: 'all', signIn: 'everyone', categoryIds: [] },
      destination: first ? { kind: 'offer', targetId: first.offer.id, url: `/product/${first.productId}?offer=${first.offer.id}` } : { kind: 'seller_store', targetId: sellerId, url: `/store/${sellerId}` },
      promoted: [...(input.offerIds ?? []).map((id) => ({ kind: 'offer' as const, id, label: info.get(id)?.title ?? null })), ...(input.type === 'sponsored_store' ? [{ kind: 'seller_store' as const, id: sellerId, label: null }] : [])],
      startsAt: input.startsAt,
      endsAt: input.endsAt,
      timeZone: this.core.tz(),
      priority: 2,
      budget: { billing: input.billing, rate: this.core.money(rate), dailyLimit: input.dailyLimit, totalLimit: input.totalLimit, spent: this.core.money(0) },
      stopWithPromotion: false,
      creativeIds: [...new Set(creativeIds)],
      afterApproval: 'schedule',
    };
  }

  /** Validated request values; the card headline becomes a text creative once everything else is valid */
  private async requestValues(sellerId: string, input: SellerAdRequestInput, by: By, keep: { textCreativeIds?: string[] } = {}) {
    const v = await this.parts.campaigns.values(await this.toInput(sellerId, input, keep), { origin: 'seller_request', sellerId });
    if (input.headline?.trim()) {
      const text: CreativeInput = { kind: 'text', device: 'any', placementKey: input.type, headline: input.headline.trim() };
      const c = await this.parts.creatives.create(text, by, { sellerId });
      v.creatives.push({ creative_id: c.id, device: 'any' });
    }
    return v;
  }

  async uploadCreative(sellerId: string, input: CreativeInput, by: By) {
    return this.parts.creatives.create({ ...input, advertiser: null }, by, { sellerId });
  }

  async create(sellerId: string, input: SellerAdRequestInput, by: By): Promise<SellerAdCampaign> {
    await this.assertPaidAdsOn(sellerId);
    const v = await this.requestValues(sellerId, input, by);
    const row = await this.parts.campaigns.insertDraft(v, by);
    return this.get(sellerId, row.id);
  }

  /** Edits a request; a request in review goes back to the start of review, an approved one back to draft */
  async update(sellerId: string, id: string, input: SellerAdRequestInput, by: By): Promise<SellerAdCampaign> {
    if (!isUuid(id)) throw notFound('Campaign');
    const m = await this.parts.views.model(id, { sellerId });
    const status = m.row.status;
    if (status !== 'draft' && status !== 'in_review' && status !== 'approved') throw new AppError('ILLEGAL_TRANSITION', `A ${status} campaign can't be edited; create a new request`, { from: status, event: 'edit' });
    const creatives = await this.repo.getMany(
      'creatives',
      m.creatives.map((c) => c.creative_id),
    );
    const v = await this.requestValues(sellerId, input, by, { textCreativeIds: creatives.filter((c) => c.kind === 'text').map((c) => c.id) });
    const res = await this.repo.transaction(async (tx) => {
      const locked = await tx.get('campaigns', id, { forUpdate: true });
      if (!locked || locked.seller_id !== sellerId) throw notFound('Campaign');
      if (locked.status !== 'draft' && locked.status !== 'in_review' && locked.status !== 'approved') throw new AppError('ILLEGAL_TRANSITION', 'The campaign changed while it was being edited', { from: locked.status, event: 'edit' });
      // editing in review goes back to the start of review (withdraw); an approved request returns to draft (edit)
      const to = locked.status === 'in_review' ? adCampaignMachine.next('in_review', 'withdraw') : locked.status === 'approved' ? adCampaignMachine.next('approved', 'edit') : 'draft';
      const after = await tx.update('campaigns', id, { ...v.row, status: to, updated_at: this.now(), version: locked.version + 1 });
      await tx.removeWhere('campaign_items', { campaign_id: id });
      await tx.removeWhere('campaign_creatives', { campaign_id: id });
      for (const it of v.items) await tx.insert('campaign_items', { ...it, campaign_id: id });
      for (const c of v.creatives) await tx.insertIfAbsent('campaign_creatives', { campaign_id: id, creative_id: c.creative_id, device: c.device });
      await this.core.log(tx, id, 'edit', by, { from: locked.status, to, reason: locked.status === 'in_review' ? 'Edited during review; back to the start of review' : locked.status === 'approved' ? 'Edited after approval; back to draft' : null });
      return { before: locked, after };
    });
    if (res.before.status !== res.after.status) this.parts.campaigns.statusChanged(res.after, res.before.status, 'Edited by the seller', by);
    return this.get(sellerId, id);
  }

  async submit(sellerId: string, id: string, by: By): Promise<SellerAdCampaign> {
    await this.assertPaidAdsOn(sellerId);
    await this.parts.campaigns.submit(id, null, by, { sellerId });
    return this.get(sellerId, id);
  }

  async withdraw(sellerId: string, id: string, by: By): Promise<SellerAdCampaign> {
    await this.parts.campaigns.transition(id, 'withdraw', by, { sellerId, reason: 'Withdrawn by the seller' });
    return this.get(sellerId, id);
  }

  async pause(sellerId: string, id: string, by: By): Promise<SellerAdCampaign> {
    await this.parts.campaigns.pause(id, 'Paused by the seller', by, { sellerId });
    return this.get(sellerId, id);
  }

  /** Only campaigns the seller paused; Marketly's pauses are resumed by staff */
  async resume(sellerId: string, id: string, by: By): Promise<SellerAdCampaign> {
    if (!isUuid(id)) throw notFound('Campaign');
    const row = await this.repo.get('campaigns', id);
    if (!row || row.seller_id !== sellerId) throw notFound('Campaign');
    if (row.status === 'paused') {
      const pausedBy = decodeActor(row.paused_by);
      if (pausedBy && pausedBy.kind !== 'seller') throw new AppError('ILLEGAL_TRANSITION', 'Marketly paused this campaign; only Marketly can resume it.', { from: 'paused', event: 'resume', pausedBy: pausedBy.kind });
    }
    await this.parts.campaigns.resume(id, 'Resumed by the seller', by, { sellerId });
    return this.get(sellerId, id);
  }
}
