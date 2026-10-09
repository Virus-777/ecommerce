/**
 * Seller-funded discounts (Seller Center): scoped to the seller's own offers (another seller's offer is
 * NOT_FOUND), no Finance step (draft → scheduled), pause, resume and end. Preview shows the customer price
 * and the seller's earnings per unit: seller-funded discounts lower the fee basis.
 */
import { AppError } from '../../../kernel/errors/index.js';
import type { PageRequest } from '../../../kernel/lib/pagination.js';
import type * as common from '../../../spec/common.js';
import type { CampaignInput, DiscountPreviewRequest, EarningsImpact, SellerDiscount, SellerDiscountInput } from '../../../spec/promotions.js';
import { promotionCampaignMachine } from '../domain/state-machines.js';
import { discountLabel, earningsImpact, fundingLabel, markdownOff, periodIssues, unitDiscount, type CampaignModel } from '../domain/rules.js';
import { toSummary } from '../mappers.js';
import type { CampaignRec } from '../ports.js';
import { invalid, notFound, Part, type By, type OfferCard } from './core.js';

const USABLE_OFFER = ['active', 'paused', 'out_of_stock'];

export class SellerDiscountsPart extends Part {
  async own(sellerId: string, id: string): Promise<{ row: CampaignRec; model: CampaignModel }> {
    const r = await this.core.campaign(id).catch(() => null);
    if (!r || r.row.owner_kind !== 'seller' || r.row.seller_id !== sellerId) throw notFound('Discount');
    return r;
  }

  /** The seller's own offers; another seller's or unknown offer → NOT_FOUND, unusable → OFFER_NOT_ELIGIBLE */
  async ownOffers(sellerId: string, offerIds: string[]): Promise<Map<string, OfferCard>> {
    const ids = [...new Set(offerIds)];
    if (!ids.length) throw invalid([{ path: 'offerIds', message: 'Choose at least one offer' }]);
    const cards = await this.core.offerCards(ids, { sellerId });
    const missing = ids.filter((id) => !cards.has(id));
    if (missing.length) throw new AppError('NOT_FOUND', 'Offer not found', { offerIds: missing });
    const problems = [...cards.values()].filter((c) => !USABLE_OFFER.includes(c.offer.status)).map((c) => ({ offerId: c.offer.id, reasons: [`Offer is ${c.offer.status.replace(/_/g, ' ')}`] }));
    if (problems.length) throw this.ctx.error('OFFER_NOT_ELIGIBLE', 'Some offers cannot be discounted', { offers: problems });
    return cards;
  }

  async toInput(sellerId: string, input: SellerDiscountInput, cards: Map<string, OfferCard>): Promise<CampaignInput> {
    const section = input.kind === 'markdown' ? 'clearance' : 'coupons';
    return {
      name: input.name,
      description: null,
      internalNote: null,
      discount: { ...input.discount, kind: input.kind },
      code: input.code ?? null,
      autoApply: !input.code?.trim(),
      startsAt: input.startsAt,
      endsAt: input.endsAt,
      timeZone: input.timeZone ?? String(await this.core.setting('marketTimeZone')),
      scope: { mode: 'offers', include: input.offerIds.map((id) => ({ kind: 'offer' as const, id, label: cards.get(id)?.title ?? null })), exclude: [] },
      eligibility: { audience: 'everyone' },
      limits: { perCustomer: input.perCustomer ?? null, perCustomerUnits: input.perCustomerUnits ?? null },
      funding: { owner: 'seller', platformShareBps: 0 },
      stacking: { withSellerMarkdowns: true, withOtherCoupons: input.combinesWithPlatformCoupons, withFreeShipping: true, withFlashSalePrices: false, exclusiveGroup: null },
      participation: null,
      deals: input.showOnDeals ? { show: true, section } : null,
      terms: null,
    };
  }

  async view(row: CampaignRec, c?: CampaignModel): Promise<SellerDiscount> {
    const model = c ?? (await this.core.models([row]))[0]!;
    const offerIds = model.scope.include.filter((t) => t.kind === 'offer').map((t) => t.id);
    const eligible = new Map((await this.repo.find('eligible_offers', { campaign_id: row.id })).map((e) => [e.offer_id, e]));
    const offers = await this.parts.campaigns.participationOffers(
      model,
      offerIds.map((id) => {
        const e = eligible.get(id);
        return { offerId: id, eligible: e ? e.eligible : true, reasons: e?.reason ? [e.reason] : [], included: true };
      }),
      { sellerId: row.seller_id!, sellerShareBps: 10000 },
    );
    const costs = (await this.repo.costTotals([row.id])).get(row.id);
    return {
      campaign: toSummary(model, undefined),
      discount: model.discount,
      discountLabel: discountLabel(model.discount, model.currency),
      offers,
      usedOrders: costs?.orders ?? 0,
      preview: offers[0]?.earnings ?? null,
    };
  }

  async list(sellerId: string, status: string | undefined, page: PageRequest): Promise<common.Page<SellerDiscount>> {
    const p = await this.repo.listCampaigns({ ownerKind: 'seller', sellerId, statuses: status ? status.split(',') : undefined }, page);
    const models = await this.core.models(p.items);
    const items = [];
    for (let i = 0; i < p.items.length; i++) items.push(await this.view(p.items[i]!, models[i]));
    return { ...p, items };
  }

  async get(sellerId: string, id: string): Promise<SellerDiscount> {
    const { row, model } = await this.own(sellerId, id);
    return this.view(row, model);
  }

  async preview(sellerId: string, body: DiscountPreviewRequest): Promise<{ customerPrice: common.Money; regularPrice: common.Money; earnings: EarningsImpact }> {
    const card = (await this.core.offerCards([body.offerId], { sellerId })).get(body.offerId);
    if (!card) throw notFound('Offer');
    const regular = card.offer.price.amount;
    let sellerShareBps = 10000;
    let words = 'seller funding';
    if (body.campaignId) {
      const part = await this.repo.findOne('participations', { campaign_id: body.campaignId, seller_id: sellerId });
      const camp = part ? (await this.core.campaign(body.campaignId)).model : null;
      if (!part || !camp) throw notFound('Campaign');
      sellerShareBps = part.seller_share_bps;
      words = fundingLabel(camp.funding).toLowerCase();
    }
    const off = body.discount.kind === 'markdown' ? markdownOff(body.discount, regular) : unitDiscount(body.discount, regular);
    const fee = await this.core.feeCalculator(card.categoryId, regular);
    const earnings = earningsImpact({ basePrice: regular, discount: off, sellerShareBps, feeRateBps: fee.rateBps, currency: card.offer.price.currency, isExample: fee.isExample, fundingWords: words, feeAt: fee.feeAt });
    return { customerPrice: earnings.customerPays, regularPrice: card.offer.price, earnings };
  }

  async create(sellerId: string, input: SellerDiscountInput, by: By): Promise<SellerDiscount> {
    const cards = await this.ownOffers(sellerId, input.offerIds);
    const row = await this.parts.campaigns.create(await this.toInput(sellerId, input, cards), by, { ownerKind: 'seller', sellerId });
    const view = await this.view(row);
    await this.core.audit({ action: 'promotions.discount.create', actionLabel: 'Created a seller discount', category: 'other', target: { type: 'campaign', id: row.id, ref: row.ref, label: row.name, sellerId }, after: view.campaign, visibleToSeller: true }, by);
    return view;
  }

  async update(sellerId: string, id: string, input: SellerDiscountInput, by: By): Promise<SellerDiscount> {
    const { row, model } = await this.own(sellerId, id);
    if (model.status !== 'draft' && model.status !== 'scheduled') throw new AppError('ILLEGAL_TRANSITION', model.status === 'live' || model.status === 'paused' ? 'Live discounts can only be ended' : `A ${model.status} discount can't be edited`, { from: model.status, event: 'edit' });
    const cards = await this.ownOffers(sellerId, input.offerIds);
    const next = await this.toInput(sellerId, input, cards);
    let version = row.version;
    if (model.status === 'scheduled') {
      await this.parts.campaigns.transition(id, 'reopen', by, { reason: 'Edited by the seller' });
      version += 1;
    }
    await this.parts.campaigns.update(id, { ...next, version }, by);
    return this.get(sellerId, id);
  }

  async schedule(sellerId: string, id: string, by: By): Promise<SellerDiscount> {
    const { model } = await this.own(sellerId, id);
    this.core.step(promotionCampaignMachine, model.status, 'schedule');
    const offerIds = model.scope.include.filter((t) => t.kind === 'offer').map((t) => t.id);
    await this.ownOffers(sellerId, offerIds);
    const can = await this.core.optional('sellers', (s) => s.canSell(sellerId, { activity: 'promotions' }));
    if (can && !can.allowed) throw invalid([{ path: 'sellerId', message: can.reason ?? 'Your account cannot run promotions right now' }], 'Your account cannot run promotions right now');
    const issues = periodIssues(model.startsAt, model.endsAt, model.timeZone, this.now());
    if (issues.length) throw invalid(issues, 'The discount cannot be scheduled');
    await this.parts.campaigns.rebuildEligible(id);
    const blocked = await this.repo.find('eligible_offers', { campaign_id: id, eligible: false });
    if (blocked.length) throw this.ctx.error('OFFER_NOT_ELIGIBLE', 'Some offers cannot be discounted', { offers: blocked.map((b) => ({ offerId: b.offer_id, reasons: [b.reason ?? 'Not eligible'] })) });
    await this.parts.campaigns.publishSchedule(id, by);
    return this.get(sellerId, id);
  }

  async pause(sellerId: string, id: string, by: By): Promise<SellerDiscount> {
    await this.own(sellerId, id);
    await this.parts.campaigns.pause(id, null, by);
    return this.get(sellerId, id);
  }

  async resume(sellerId: string, id: string, by: By): Promise<SellerDiscount> {
    await this.own(sellerId, id);
    await this.parts.campaigns.resume(id, null, by);
    return this.get(sellerId, id);
  }

  /** End now when live or paused; cancel when it has not started */
  async end(sellerId: string, id: string, reason: string | null | undefined, by: By): Promise<SellerDiscount> {
    const { model } = await this.own(sellerId, id);
    if (model.status === 'live' || model.status === 'paused') await this.parts.campaigns.end(id, 'ended_early', by, reason ?? null);
    else await this.parts.campaigns.cancel(id, reason ?? 'Cancelled by the seller', by);
    await this.core.audit({ action: 'promotions.discount.end', actionLabel: model.status === 'live' || model.status === 'paused' ? 'Ended a seller discount' : 'Cancelled a seller discount', category: 'other', target: { type: 'campaign', id, ref: model.ref, label: model.name, sellerId }, reason: reason ?? null, visibleToSeller: true }, by);
    return this.get(sellerId, id);
  }
}
