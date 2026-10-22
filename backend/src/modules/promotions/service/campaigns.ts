/**
 * Platform campaigns (admin): drafts, edits, the resolved offer set, Finance funding confirmation with
 * approval limits, scheduling, pause/resume/end/cancel, flash items, codes, redemptions, results and history.
 */
import { randomInt } from 'node:crypto';
import { AppError } from '../../../kernel/errors/index.js';
import { isUuid, newId } from '../../../kernel/lib/ids.js';
import { pageOf, type PageRequest } from '../../../kernel/lib/pagination.js';
import type * as common from '../../../spec/common.js';
import { OFFICIAL_STORE_ID, OFFICIAL_STORE_NAME } from '../../../spec/common.js';
import type * as offers from '../../../spec/offers.js';
import type {
  Campaign,
  CampaignInput,
  CampaignLogEntry,
  CampaignPatch,
  CampaignResult,
  CampaignSummary,
  CouponCode,
  DailyPoint,
  FlashItem,
  FlashItemInput,
  IssuedCoupon,
  ParticipationOffer,
  PricePreview,
  PromotionsDashboard,
  ReadinessItem,
  Redemption,
  ReviewCheck,
  TabCount,
} from '../../../spec/promotions.js';
import { flashItemMachine, promotionCampaignMachine } from '../domain/state-machines.js';
import {
  budgetIssues,
  codeIssues,
  COUPON_KINDS,
  discountIssues,
  discountLabel,
  earningsImpact,
  fundingIssues,
  fundingLabel,
  limitIssues,
  m,
  markdownOff,
  materialFields,
  moneyFull,
  normalizeCode,
  periodIssues,
  platformShareBps,
  PRICE_KINDS,
  scopeCheck,
  SHIPPING_KINDS,
  unitDiscount,
  type CampaignModel,
  type Issue,
} from '../domain/rules.js';
import { decodeActor, encodeActor, iso, isoOrNull, periodOf, toCode, toFundingReview, toLogEntry, toRedemption, toSummary, unitsPerRedemption } from '../mappers.js';
import type { CampaignRec, CodeRec, EligibleRec, FlashItemRec, FundingReviewRec, ResultRec, TargetRec } from '../ports.js';
import type { PromotionsRepository } from '../repository.js';
import { invalid, notFound, Part, SYSTEM, type By, type OfferCard } from './core.js';

const CLOSED = ['ended', 'cancelled'];
const DATASET = 'promotions.admin.campaigns';
const CODE_ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
/** A random unique code: 8 characters without look-alikes (0/O, 1/I), after the prefix when there is one */
const randomCode = (prefix?: string | null) => {
  const rand = Array.from({ length: 8 }, () => CODE_ALPHABET[randomInt(CODE_ALPHABET.length)]).join('');
  return prefix ? `${prefix}-${rand}` : rand;
};

export interface ListCampaignsQuery {
  q?: string;
  status?: string;
  kind?: string;
  fundingOwner?: 'platform' | 'seller' | 'shared';
  ownerKind?: 'platform' | 'seller';
  sellerId?: string;
}

/** Row fields and targets of a campaign from its input */
export function campaignFields(input: CampaignInput, currency: string): { row: Partial<CampaignRec>; targets: Omit<TargetRec, 'campaign_id'>[] } {
  return {
    row: {
      name: input.name.trim(),
      description: input.description ?? null,
      internal_note: input.internalNote ?? null,
      kind: input.discount.kind,
      discount: input.discount as never,
      // authoritative (decision P1); default false: no code and not automatic = clip-only
      auto_apply: input.autoApply ?? false,
      starts_at: new Date(input.startsAt),
      ends_at: new Date(input.endsAt),
      time_zone: input.timeZone,
      scope_mode: input.scope.mode,
      eligibility: input.eligibility as never,
      budget_amount: input.limits.budget?.amount ?? null,
      usage_cap: input.limits.usageCap ?? null,
      per_customer: input.limits.perCustomer ?? null,
      per_order: input.limits.perOrder ?? null,
      per_customer_units: input.limits.perCustomerUnits ?? null,
      funding_owner: input.funding.owner,
      platform_share_bps: input.funding.owner === 'shared' ? (input.funding.platformShareBps ?? null) : input.funding.owner === 'platform' ? 10000 : 0,
      cost_center: input.funding.costCenter ?? null,
      funding_note: input.funding.note ?? null,
      stacking: input.stacking as never,
      exclusive_group: input.stacking.exclusiveGroup ?? null,
      participation: (input.participation ?? null) as never,
      deals: (input.deals ?? null) as never,
      terms: input.terms ?? null,
      currency: input.limits.budget?.currency ?? input.discount.amountOff?.currency ?? input.discount.minSpend?.currency ?? currency,
    },
    targets: [
      ...input.scope.include.map((t) => ({ kind: t.kind, target_id: t.id, excluded: false, label: t.label ?? null })),
      ...input.scope.exclude.map((t) => ({ kind: t.kind, target_id: t.id, excluded: true, label: t.label ?? null })),
    ].filter((t, i, all) => all.findIndex((x) => x.kind === t.kind && x.target_id === t.target_id) === i),
  };
}

/** CampaignInput of a stored campaign (to merge a patch onto) */
export function inputOf(c: CampaignModel, internalNote: string | null): CampaignInput {
  return {
    name: c.name,
    description: c.description,
    internalNote,
    discount: c.discount,
    code: c.code,
    autoApply: c.autoApply,
    startsAt: c.startsAt.toISOString(),
    endsAt: c.endsAt.toISOString(),
    timeZone: c.timeZone,
    scope: c.scope,
    eligibility: c.eligibility,
    limits: c.limits,
    funding: c.funding,
    stacking: c.stacking,
    participation: c.participation,
    deals: c.deals,
    terms: c.terms,
  };
}

export class CampaignsPart extends Part {
  #datasetRegistered?: Promise<void>;

  /* ---------------------------------------------------------------- validation */

  inputIssues(input: CampaignInput): Issue[] {
    const issues: Issue[] = [];
    if (!input.name?.trim()) issues.push({ path: 'name', message: 'Give the campaign a name' });
    issues.push(...discountIssues(input.discount, { phase3: this.ctx.config.launchPhase >= 3 }));
    issues.push(...periodIssues(new Date(input.startsAt), new Date(input.endsAt), input.timeZone, null));
    issues.push(...limitIssues(input.limits));
    issues.push(...codeIssues(input.code));
    if (input.scope.mode !== 'sitewide' && !input.scope.include.length) issues.push({ path: 'scope.include', message: 'Choose what the campaign covers' });
    if (input.eligibility.audience === 'regions' && !input.eligibility.regions?.length) issues.push({ path: 'eligibility.regions', message: 'Choose at least one region' });
    if (input.funding.platformShareBps != null && (input.funding.platformShareBps < 0 || input.funding.platformShareBps > 10000)) issues.push({ path: 'funding.platformShareBps', message: 'Share must be between 0% and 100%' });
    return issues;
  }

  async assertCodeFree(code: string | null, campaignId: string | null) {
    if (code && (await this.repo.codeTaken(code, campaignId))) throw this.ctx.error('CODE_TAKEN', `The code ${code} is already used by another campaign`);
  }

  /** Replace the shared code of a campaign (inside a transaction) */
  async setSharedCode(repo: PromotionsRepository, campaignId: string, code: string | null) {
    const current = await repo.find('coupon_codes', { campaign_id: campaignId, kind: 'shared', active: true });
    if (current.length === 1 && current[0]!.code.toUpperCase() === code) return;
    await repo.updateWhere('coupon_codes', { campaign_id: campaignId, kind: 'shared', active: true }, { active: false });
    if (!code) return;
    try {
      await repo.insert('coupon_codes', { id: newId(), campaign_id: campaignId, code, kind: 'shared', max_redemptions: null, redemptions: 0, assigned_customer_id: null, issue_key: null, active: true, created_at: this.now() });
    } catch (err) {
      if (/unique|duplicate/i.test(String((err as Error).message))) throw this.ctx.error('CODE_TAKEN', `The code ${code} is already used by another campaign`);
      throw err;
    }
  }

  /* ---------------------------------------------------------------- create, read, edit */

  async create(input: CampaignInput, by: By, o: { ownerKind?: 'platform' | 'seller'; sellerId?: string | null } = {}): Promise<CampaignRec> {
    const issues = this.inputIssues(input);
    if (issues.length) throw invalid(issues);
    const code = normalizeCode(input.code);
    await this.assertCodeFree(code, null);
    const ref = await this.ctx.refs.next('PRM', { digits: 4 });
    const { row, targets } = campaignFields(input, this.core.currency());
    const now = this.now();
    const id = newId();
    const created = await this.repo.transaction(async (tx) => {
      const rec = await tx.insert('campaigns', {
        ...(row as CampaignRec),
        id,
        ref,
        owner_kind: o.ownerKind ?? 'platform',
        seller_id: o.sellerId ?? null,
        budget_used: 0,
        usage_count: 0,
        status: 'draft',
        ended_reason: null,
        approval_request_id: null,
        created_by: encodeActor(by.actor),
        created_at: now,
        updated_at: now,
        version: 1,
      });
      if (targets.length) await tx.insertMany('campaign_targets', targets.map((t) => ({ ...t, campaign_id: id })));
      await this.setSharedCode(tx, id, code);
      await this.core.log(tx, id, 'created', by);
      return rec;
    });
    await this.refreshEligibleQuietly(id);
    return created;
  }

  async createCampaign(input: CampaignInput, by: By): Promise<Campaign> {
    const rec = await this.create(input, by);
    const view = await this.view(rec.id);
    await this.core.audit({ action: 'promotions.campaign.create', actionLabel: 'Created campaign', category: 'other', target: { type: 'campaign', id: rec.id, ref: rec.ref, label: rec.name }, after: view }, by);
    return view;
  }

  async list(q: ListCampaignsQuery, page: PageRequest): Promise<common.Page<CampaignSummary>> {
    const p = await this.repo.listCampaigns(
      { q: q.q, statuses: q.status ? q.status.split(',').map((s) => s.trim()) : undefined, kind: q.kind, fundingOwner: q.fundingOwner, ownerKind: q.ownerKind, sellerId: q.sellerId },
      page,
    );
    return { ...p, items: await this.summaries(p.items) };
  }

  async summaries(rows: CampaignRec[]): Promise<CampaignSummary[]> {
    const models = await this.core.models(rows);
    const reviews = await this.latestReviews(rows.map((r) => r.id));
    return models.map((c) => toSummary(c, reviews.get(c.id)));
  }

  async latestReviews(ids: string[]): Promise<Map<string, FundingReviewRec>> {
    const out = new Map<string, FundingReviewRec>();
    if (!ids.length) return out;
    for (const r of await this.repo.find('funding_reviews', { campaign_id: ids }, { orderBy: [['sent_at', 'asc']] })) out.set(r.campaign_id, r);
    return out;
  }

  /** Full campaign for the admin screens */
  async view(id: string): Promise<Campaign> {
    const { row, model: c } = await this.core.campaign(id);
    const [eligibleRows, review, participations, costs, codeCount, flashCount] = await Promise.all([
      this.repo.find('eligible_offers', { campaign_id: id }),
      this.latestReviews([id]).then((r) => r.get(id)),
      this.repo.find('participations', { campaign_id: id }),
      this.repo.costTotals([id]).then((x) => x.get(id)),
      this.repo.count('coupon_codes', { campaign_id: id, kind: 'unique' }),
      this.repo.count('flash_items', { campaign_id: id }),
    ]);
    const eligible = eligibleRows.filter((e) => e.eligible);
    const count = (s: string) => participations.filter((p) => p.state === s).length;
    const summary = participations.length || c.participation?.inviteSellers ? { invited: participations.length, accepted: count('accepted') + count('withdrawal_requested'), pending: count('invited'), declined: count('declined') + count('expired'), withdrawn: count('withdrawn') + count('removed') } : null;
    let fundingReview = null;
    if (review && c.ownerKind === 'platform') {
      const approval = review.approval_request_id ? ((await this.core.optional('access', (a) => a.approvalInfo(review.approval_request_id!))) ?? { required: true, approvalRequestId: review.approval_request_id, approvers: [] }) : null;
      const reviewerName = review.reviewer_id ? await this.core.optional('access', (a) => a.getStaffRef(review.reviewer_id!)) : undefined;
      fundingReview = toFundingReview(review, c.currency, review.reviewer_id ? { kind: 'staff', id: review.reviewer_id, ...(reviewerName?.name ? { name: reviewerName.name } : {}) } : null, approval);
      fundingReview.costCenter = c.funding.costCenter ?? null;
      if (c.status === 'draft') fundingReview.state = 'not_sent';
    }
    const cur = c.currency;
    return {
      id: c.id,
      ref: c.ref,
      name: c.name,
      description: c.description,
      internalNote: row.internal_note,
      ownerKind: c.ownerKind,
      sellerId: c.sellerId,
      discount: c.discount,
      code: c.code,
      autoApply: c.autoApply,
      codeCount,
      period: periodOf(c),
      scope: c.scope,
      eligibility: c.eligibility,
      limits: c.limits,
      funding: c.funding,
      stacking: c.stacking,
      participation: c.participation,
      participationSummary: summary,
      deals: c.deals,
      terms: c.terms,
      status: c.status,
      endedReason: (row.ended_reason as Campaign['endedReason']) ?? null,
      locked: c.status === 'in_review',
      eligible: {
        offers: eligible.length,
        sellers: new Set(eligible.filter((e) => !e.official_store).map((e) => e.seller_id)).size,
        officialStore: eligible.some((e) => e.official_store),
        excludedOffers: eligibleRows.length - eligible.length,
      },
      fundingReview,
      readiness: this.readiness(c, review, summary, flashCount),
      budgetUsed: m(c.budgetUsed, cur),
      redemptions: costs?.redemptions ?? 0,
      discountCost: { total: m(costs?.total ?? 0, cur), platform: m(costs?.platform ?? 0, cur), seller: m(costs?.seller ?? 0, cur) },
      createdBy: decodeActor(row.created_by),
      createdAt: iso(row.created_at),
      updatedAt: iso(row.updated_at),
      version: row.version,
    };
  }

  readiness(c: CampaignModel, review: FundingReviewRec | undefined, p: Campaign['participationSummary'], flashCount: number): ReadinessItem[] {
    const published = ['scheduled', 'live', 'paused', 'ended'].includes(c.status);
    const items: ReadinessItem[] = [{ role: 'Marketing', state: c.status === 'draft' || c.status === 'changes_requested' ? 'waiting' : 'done', label: c.status === 'changes_requested' ? 'Changes requested by Finance' : 'Campaign set up' }];
    if (c.ownerKind === 'platform') {
      const confirmed = ['approved', ...['scheduled', 'live', 'paused', 'ended']].includes(c.status);
      items.push({
        role: 'Finance',
        state: confirmed ? 'done' : c.status === 'in_review' ? 'waiting' : 'info',
        label: confirmed ? 'Funding confirmed' : c.status === 'in_review' ? (review?.approval_request_id ? 'Waiting for budget approval' : 'Waiting for Finance') : 'Send to Finance to confirm funding',
      });
    }
    if (p) items.push({ role: 'Sellers', state: p.pending ? 'waiting' : p.accepted ? 'done' : 'info', label: `${p.accepted} of ${p.invited} invited sellers joined${p.pending ? ` · ${p.pending} not answered` : ''}` });
    if (c.kind === 'flash_sale') items.push({ role: 'Marketing', state: flashCount ? 'done' : 'waiting', label: flashCount ? `${flashCount} flash items set` : 'Add flash items' });
    items.push({ role: 'Content', state: 'info', label: 'Campaign page and banners are set up in Content' });
    items.push({ role: 'Marketing', state: published ? 'done' : 'waiting', label: published ? 'Scheduled' : 'Schedule to publish' });
    return items;
  }

  async update(id: string, patch: CampaignPatch, by: By): Promise<Campaign> {
    const { row, model: c } = await this.core.campaign(id);
    if (c.status === 'in_review') throw this.ctx.error('CAMPAIGN_LOCKED', 'Edits are locked while Finance reviews the funding. Withdraw it first.');
    if (patch.version !== row.version) throw new AppError('CONFLICT', 'Someone else changed this campaign. Reload and try again.', { version: row.version });
    if (CLOSED.includes(c.status)) throw new AppError('ILLEGAL_TRANSITION', `A ${c.status} campaign can't be edited`, { from: c.status });
    const current = inputOf(c, row.internal_note);
    const { version: _v, ...fields } = patch;
    const merged: CampaignInput = { ...current };
    for (const [k, v] of Object.entries(fields)) if (v !== undefined && v !== null) (merged as unknown as Record<string, unknown>)[k] = v;
    if (patch.code === null) merged.code = current.code;
    const material = materialFields(fields as Record<string, unknown>, current as unknown as Record<string, unknown>);
    let status = c.status;
    if (material.length) {
      if (c.status === 'approved' || c.status === 'scheduled') status = this.core.step(promotionCampaignMachine, c.status, 'reopen');
      else if (c.status === 'live' || c.status === 'paused') throw new AppError('ILLEGAL_TRANSITION', `Only the name, description and terms of a ${c.status} campaign can change; end it and create a new one`, { from: c.status, fields: material });
    }
    const issues = this.inputIssues(merged);
    if (issues.length) throw invalid(issues);
    const code = normalizeCode(merged.code);
    await this.assertCodeFree(code, id);
    const { row: next, targets } = campaignFields(merged, c.currency);
    const after = await this.repo.transaction(async (tx) => {
      const locked = await tx.get('campaigns', id, { forUpdate: true });
      if (!locked || locked.version !== patch.version) throw new AppError('CONFLICT', 'Someone else changed this campaign. Reload and try again.');
      const rec = await tx.update('campaigns', id, { ...next, status, updated_at: this.now(), version: row.version + 1, ...(status === 'draft' && status !== c.status ? { approval_request_id: null } : {}) });
      await tx.removeWhere('campaign_targets', { campaign_id: id });
      if (targets.length) await tx.insertMany('campaign_targets', targets.map((t) => ({ ...t, campaign_id: id })));
      await this.setSharedCode(tx, id, code);
      await this.core.log(tx, id, status !== c.status ? 'reopened' : 'edited', by, null, { fields: Object.keys(fields), material });
      return rec;
    });
    if (material.includes('scope') || material.includes('participation')) await this.refreshEligibleQuietly(id);
    const view = await this.view(id);
    await this.core.audit({ action: 'promotions.campaign.update', actionLabel: status !== c.status ? 'Edited campaign (reopened for Finance)' : 'Edited campaign', category: 'other', target: { type: 'campaign', id, ref: after.ref, label: after.name }, before: current, after: view }, by);
    return view;
  }

  /* ---------------------------------------------------------------- the resolved offer set */

  /** All offers a list filter returns, page by page (bounded) */
  async allOffers(filter: Parameters<offers.OffersPublicApi['listOffersAdmin']>[0], cap = 2000): Promise<offers.Offer[]> {
    const api = this.ctx.use('offers');
    const out: offers.Offer[] = [];
    let cursor: string | undefined;
    do {
      const p = await api.listOffersAdmin(filter, { limit: 100, ...(cursor ? { cursor } : {}) });
      out.push(...p.items);
      cursor = p.nextCursor ?? undefined;
    } while (cursor && out.length < cap);
    return out;
  }

  /** Offers a campaign's scope may cover (before scope rules) */
  async candidateOfferIds(c: CampaignModel): Promise<string[]> {
    if (c.kind === 'flash_sale') return (await this.repo.find('flash_items', { campaign_id: c.id })).map((f) => f.offer_id);
    const ids = new Set<string>();
    const active = { status: ['active'] };
    if (c.ownerKind === 'seller') {
      const own = c.scope.include.filter((t) => t.kind === 'offer').map((t) => t.id);
      if (own.length && c.scope.mode === 'offers') return own;
      for (const o of await this.allOffers({ sellerId: c.sellerId!, ...active })) ids.add(o.id);
      return [...ids];
    }
    const broad = c.scope.mode === 'sitewide' || c.scope.include.some((t) => t.kind === 'category' || t.kind === 'brand');
    if (broad) for (const o of await this.allOffers(active)) ids.add(o.id);
    for (const t of c.scope.include) {
      if (t.kind === 'offer') ids.add(t.id);
      else if (t.kind === 'product') for (const o of await this.allOffers({ productId: t.id, ...active })) ids.add(o.id);
      else if (t.kind === 'seller') for (const o of await this.allOffers({ sellerId: t.id, ...active })) ids.add(o.id);
      else if (t.kind === 'official_store') for (const o of await this.allOffers({ official: true, ...active })) ids.add(o.id);
    }
    return [...ids];
  }

  /** Why an offer can't take part (participation rules of a platform campaign) */
  async ruleReasons(c: CampaignModel, card: OfferCard): Promise<string[]> {
    const reasons: string[] = [];
    if (card.offer.status !== 'active') reasons.push(`Offer is ${card.offer.status.replace(/_/g, ' ')}`);
    const p = c.participation;
    if (!p || c.ownerKind !== 'platform') return reasons;
    if (p.minStock != null && card.stock != null && card.stock < p.minStock) reasons.push(`Needs at least ${p.minStock} units in stock (you have ${card.stock})`);
    if (p.maxDispatchDays != null && card.offer.dispatch.businessDays > p.maxDispatchDays) reasons.push(`Ships in ${card.offer.dispatch.businessDays} business days; the campaign needs ${p.maxDispatchDays} or fewer`);
    if (p.noPriceIncreaseDays != null) {
      const range = await this.ctx
        .use('offers')
        .priceRange(card.offer.id, p.noPriceIncreaseDays)
        .catch(() => null);
      if (range && range.current.amount > range.lowest.amount) reasons.push(`Price was raised in the last ${p.noPriceIncreaseDays} days`);
    }
    if (p.minRating != null) {
      const r = await this.core.optional('reviews', (rv) => rv.getRatingSummaries([card.offer.productId]));
      const avg = r?.[0]?.average;
      if (avg != null && avg < p.minRating) reasons.push(`Rating ${avg.toFixed(1)} is below ${p.minRating.toFixed(1)}`);
    }
    return reasons;
  }

  /** Rebuild eligible_offers for a campaign (scope change, scheduling, offer events, the 15-minute job) */
  async rebuildEligible(id: string): Promise<number> {
    const { model: c } = await this.core.campaign(id);
    const ids = await this.candidateOfferIds(c);
    const cards = await this.core.offerCards(ids);
    const sellerOk = new Map<string, string | null>();
    for (const sid of new Set([...cards.values()].map((x) => x.offer.sellerId).filter((s): s is string => Boolean(s)))) {
      const r = await this.core.optional('sellers', (s) => s.canSell(sid, { activity: 'promotions' }));
      sellerOk.set(sid, r && !r.allowed ? (r.reason ?? 'Seller cannot run promotions now') : null);
    }
    const now = this.now();
    const rows: EligibleRec[] = [];
    for (const card of cards.values()) {
      const s = scopeCheck(c, card.attrs);
      if (!s.ok && !s.excluded) continue;
      const reasons = s.ok ? await this.ruleReasons(c, card) : [s.reason];
      const blocked = card.offer.sellerId ? sellerOk.get(card.offer.sellerId) : null;
      if (blocked) reasons.push(blocked);
      rows.push({ campaign_id: c.id, offer_id: card.offer.id, seller_id: card.offer.sellerId ?? card.offer.id, official_store: card.offer.ownerType === 'official', eligible: reasons.length === 0, reason: reasons[0] ?? null, refreshed_at: now });
    }
    await this.repo.transaction(async (tx) => {
      await tx.removeWhere('eligible_offers', { campaign_id: c.id });
      if (rows.length) await tx.insertMany('eligible_offers', rows);
    });
    return rows.filter((r) => r.eligible).length;
  }

  /** Rebuild when offers can answer; drafts keep their old set otherwise */
  async refreshEligibleQuietly(id: string) {
    try {
      await this.rebuildEligible(id);
    } catch (err) {
      this.ctx.log.debug({ err, campaignId: id }, 'promotions: eligible offers not rebuilt');
    }
  }

  /** Customer price of an offer under a campaign rule */
  campaignPrice(c: CampaignModel, regular: number, flash?: FlashItemRec): number {
    // above the price the item was set with the deal does not apply (evaluate)
    if (c.kind === 'flash_sale') return flash && regular <= flash.regular_price ? Math.min(regular, flash.deal_price) : regular;
    if (c.kind === 'markdown') return regular - markdownOff(c.discount, regular);
    return regular - unitDiscount(c.discount, regular);
  }

  /** ParticipationOffer rows for offers of a campaign */
  async participationOffers(c: CampaignModel, rows: { offerId: string; eligible: boolean; reasons: string[]; included: boolean }[], o: { sellerId?: string; sellerShareBps?: number } = {}): Promise<ParticipationOffer[]> {
    const cards = await this.core.offerCards(rows.map((r) => r.offerId), o.sellerId ? { sellerId: o.sellerId } : {});
    const flash = c.kind === 'flash_sale' ? new Map((await this.repo.find('flash_items', { campaign_id: c.id })).map((f) => [f.offer_id, f])) : new Map<string, FlashItemRec>();
    const out: ParticipationOffer[] = [];
    for (const r of rows) {
      const card = cards.get(r.offerId);
      if (!card) continue;
      const regular = card.offer.price.amount;
      const price = this.campaignPrice(c, regular, flash.get(r.offerId));
      const official = card.offer.ownerType === 'official';
      let earnings = null;
      if (!official) {
        const fee = await this.core.feeCalculator(card.categoryId, regular);
        earnings = earningsImpact({ basePrice: regular, discount: regular - price, sellerShareBps: o.sellerShareBps ?? 10000 - platformShareBps(c), feeRateBps: fee.rateBps, currency: card.offer.price.currency, isExample: fee.isExample, fundingWords: fundingLabel(c.funding).toLowerCase(), feeAt: fee.feeAt });
      }
      out.push({
        offerId: r.offerId,
        productId: card.offer.productId,
        title: card.title,
        sku: card.offer.sellerSku,
        image: card.image,
        stock: card.stock ?? 0,
        eligible: r.eligible,
        ineligibleReasons: r.reasons,
        included: r.included,
        regularPrice: card.offer.price,
        campaignPrice: m(price, card.offer.price.currency),
        earnings,
      });
    }
    return out;
  }

  async listEligibleOffers(id: string, q: { sellerId?: string; eligible?: boolean }, page: PageRequest): Promise<common.Page<ParticipationOffer>> {
    const { model: c } = await this.core.campaign(id);
    const p = await this.repo.page('eligible_offers', { campaign_id: id, ...(q.sellerId ? { seller_id: q.sellerId } : {}), ...(q.eligible !== undefined ? { eligible: q.eligible } : {}) }, page, { column: 'offer_id', direction: 'asc', id: 'offer_id' });
    const included = new Set<string>();
    if (c.ownerKind === 'platform' && c.participation?.inviteSellers) {
      const parts = await this.repo.find('participations', { campaign_id: id, state: ['accepted', 'withdrawal_requested'] });
      if (parts.length) for (const po of await this.repo.find('participation_offers', { participation_id: parts.map((x) => x.id), included: true })) included.add(po.offer_id);
    }
    const items = await this.participationOffers(
      c,
      p.items.map((e) => ({ offerId: e.offer_id, eligible: e.eligible, reasons: e.reason ? [e.reason] : [], included: e.eligible && (e.official_store || !c.participation?.inviteSellers || included.has(e.offer_id)) })),
    );
    return { ...p, items };
  }

  /* ---------------------------------------------------------------- preview */

  async previewPrice(id: string, offerId: string | null | undefined): Promise<PricePreview> {
    const { model: c } = await this.core.campaign(id);
    let card: OfferCard | undefined;
    const pick = offerId ?? (await this.repo.findOne('eligible_offers', { campaign_id: id, eligible: true }, { orderBy: [['offer_id', 'asc']] }))?.offer_id;
    if (pick) card = (await this.core.offerCards([pick])).get(pick);
    if (offerId && !card) throw notFound('Offer');
    const cur = card?.offer.price.currency ?? c.currency;
    const regular = card?.offer.price.amount ?? 10000;
    const flash = card && c.kind === 'flash_sale' ? await this.repo.findOne('flash_items', { campaign_id: id, offer_id: card.offer.id }) : undefined;
    const price = this.campaignPrice(c, regular, flash);
    const off = regular - price;
    const priceKind = PRICE_KINDS.includes(c.kind);
    const label = discountLabel(c.discount, cur);
    const sellerName = card?.sellerName ?? 'Example seller';
    const freeShip = c.kind === 'free_shipping' || Boolean(c.discount.freeShipping);
    const discountLine = { label: c.code ? `Coupon ${c.code}` : c.name, amount: m(-off, cur), kind: 'discount' as const };
    const itemLine = { label: card?.title ?? 'Example product', amount: m(priceKind ? price : regular, cur), kind: 'item' as const };
    const total = (priceKind ? price : regular - off) as number;
    const cartLines = [itemLine, ...(!priceKind && off ? [discountLine] : []), ...(freeShip ? [{ label: 'Shipping', amount: m(0, cur), kind: 'shipping' as const }] : []), { label: 'Total', amount: m(total, cur), kind: 'total' as const }];
    return {
      productCard: { productTitle: card?.title ?? 'Example product', image: card?.image ?? null, price: m(priceKind ? price : regular, cur), wasPrice: priceKind && off ? m(regular, cur) : null, badge: c.kind === 'flash_sale' ? 'Flash deal' : priceKind ? label : c.code ? `Coupon: ${label}` : label, sellerName },
      cart: { packageLabel: `Package from ${sellerName}`, lines: cartLines },
      checkout: { lines: cartLines, appliedNote: priceKind ? `${c.name}: price already reduced` : c.code ? `${c.code} applied: you save ${moneyFull(off, cur)}` : `${c.name} applied automatically${off ? `: you save ${moneyFull(off, cur)}` : ''}` },
    };
  }

  /* ---------------------------------------------------------------- Finance review */

  async buildChecks(c: CampaignModel, by: By): Promise<{ checks: ReviewCheck[]; platformMax: number; sellersMax: number }> {
    const checks: ReviewCheck[] = [];
    const budget = c.limits.budget?.amount ?? null;
    const share = platformShareBps(c);
    const platformMax = budget === null ? 0 : Math.round((budget * share) / 10000);
    const sellersMax = budget === null ? 0 : budget - platformMax;
    if (budget === null) checks.push({ state: 'warn', label: 'No budget set', detail: 'The discount cost is not capped' });
    else {
      const check = await this.core.optional('access', (a) => a.check(this.core.principalOf(by), 'promotions.budgets.approve', { money: m(platformMax, c.currency) }));
      checks.push(
        check?.decision === 'allowed' || !check
          ? { state: 'ok', label: 'Budget within the Marketing limit', detail: `Platform budget ${moneyFull(platformMax, c.currency)}` }
          : { state: 'warn', label: 'Budget above the Marketing limit', detail: `${moneyFull(platformMax, c.currency)} needs Finance approval: ${check.reason}` },
      );
    }
    checks.push({ state: 'ok', label: "Platform share does not reduce seller proceeds", detail: 'Commission is charged on the price after the seller-funded part; the platform part is credited to seller proceeds' });
    if (c.participation?.inviteSellers) {
      const parts = await this.repo.find('participations', { campaign_id: c.id });
      const accepted = parts.filter((p) => p.state === 'accepted' || p.state === 'withdrawal_requested');
      const mismatch = accepted.filter((p) => p.platform_share_bps !== share);
      checks.push(
        mismatch.length
          ? { state: 'fail', label: 'Seller share does not match consent', detail: `${mismatch.length} sellers consented to a different split` }
          : { state: accepted.length ? 'ok' : 'info', label: 'Seller share matches consent', detail: `${accepted.length} sellers consented${parts.some((p) => p.state === 'invited') ? `; ${parts.filter((p) => p.state === 'invited').length} not answered yet` : ''}` },
      );
    }
    checks.push(c.funding.costCenter ? { state: 'info', label: `Cost center ${c.funding.costCenter}`, detail: 'Finance checks the remaining balance' } : { state: c.funding.owner === 'seller' ? 'info' : 'warn', label: 'No cost center', detail: c.funding.owner === 'seller' ? 'Seller funded' : 'Set a cost center for the platform-funded part' });
    return { checks, platformMax, sellersMax };
  }

  async submit(id: string, note: string | null | undefined, by: By): Promise<Campaign> {
    const { model: c } = await this.core.campaign(id);
    if (c.ownerKind === 'seller') throw new AppError('ILLEGAL_TRANSITION', 'Seller discounts are seller-funded and skip Finance; schedule them instead', { from: c.status, event: 'submit' });
    const next = this.core.step(promotionCampaignMachine, c.status, 'submit');
    const issues: Issue[] = [...periodIssues(c.startsAt, c.endsAt, c.timeZone, this.now()), ...discountIssues(c.discount, { phase3: this.ctx.config.launchPhase >= 3 }), ...fundingIssues(c.funding, c.participation), ...limitIssues(c.limits)];
    if (c.scope.mode !== 'sitewide' && !c.scope.include.length) issues.push({ path: 'scope.include', message: 'The scope is empty' });
    issues.push(...budgetIssues(c));
    if (c.kind === 'flash_sale' && !(await this.repo.count('flash_items', { campaign_id: id }))) issues.push({ path: 'flashItems', message: 'Add flash items first' });
    if (!issues.length && PRICE_KINDS.includes(c.kind)) {
      const n = await this.rebuildEligible(id);
      if (!n) issues.push({ path: 'scope', message: 'No eligible offers in scope' });
    }
    if (issues.length) throw invalid(issues, 'The campaign is not ready for Finance');
    const { checks, platformMax, sellersMax } = await this.buildChecks(c, by);
    await this.repo.transaction(async (tx) => {
      const row = await tx.get('campaigns', id, { forUpdate: true });
      this.core.step(promotionCampaignMachine, row!.status, 'submit');
      await tx.update('campaigns', id, { status: next, updated_at: this.now(), version: row!.version + 1, approval_request_id: null });
      await tx.insert('funding_reviews', { id: newId(), campaign_id: id, state: 'waiting', sent_at: this.now(), reviewer_id: null, decided_at: null, checks: checks as never, platform_max: platformMax, sellers_max: sellersMax, expected_sales: null, margin_impact_pts: null, comment: null, approval_request_id: null });
      await this.core.log(tx, id, 'submitted', by, note ?? null);
    });
    this.core.publish('promotions.campaign.submitted', { campaignId: id, budget: c.limits.budget ?? null, fundingOwner: c.funding.owner }, by);
    return this.audited(id, 'promotions.campaign.submit', 'Sent campaign to Finance', by, note);
  }

  async withdraw(id: string, by: By): Promise<Campaign> {
    const review = await this.transition(id, 'withdraw', by, { reviewState: 'not_sent' });
    if (review?.approval_request_id) await this.core.optional('access', (a) => a.cancelApproval(review.approval_request_id!, by.actor, 'Campaign withdrawn from Finance review'));
    return this.audited(id, 'promotions.campaign.withdraw', 'Withdrew campaign from Finance review', by);
  }

  async confirmFunding(id: string, body: { comment?: string | null; costCenter?: string | null }, by: By): Promise<Campaign> {
    const { row, model: c } = await this.core.campaign(id);
    this.core.step(promotionCampaignMachine, c.status, 'confirmFunding');
    await this.refuseOwnCampaign(row, by);
    // sent before a budget was required: without one the platform cost can't be checked against any limit
    const noBudget = budgetIssues(c);
    if (noBudget.length) throw invalid(noBudget, 'Send the campaign back to Marketing to set a budget');
    const review = (await this.latestReviews([id])).get(id);
    if (review?.approval_request_id && review.state === 'waiting') throw new AppError('APPROVAL_REQUIRED', 'The budget is waiting for approval', { approvalRequestId: review.approval_request_id });
    const platformMax = review?.platform_max ?? 0;
    const access = this.ctx.tryUse('access');
    if (access && c.limits.budget) {
      const principal = this.core.principalOf(by);
      const check = await access.check(principal, 'promotions.budgets.approve', { money: m(platformMax, c.currency) });
      if (check.decision === 'denied') throw new AppError('FORBIDDEN', check.reason);
      if (check.decision === 'approval_required') {
        const req = await access.requestApproval({
          action: 'promotions.budgets.approve',
          target: { type: 'promotion_campaign', id, ref: row.ref, label: row.name, screen: 'admin/promotion-new' },
          amount: m(platformMax, c.currency),
          summary: `Platform budget of ${moneyFull(platformMax, c.currency)} for ${row.name}`,
          details: { fundingOwner: c.funding.owner, budget: c.limits.budget, platformShareBps: platformShareBps(c) },
          reason: body.comment ?? 'Funding confirmation',
          requestedBy: principal,
        });
        await this.repo.transaction(async (tx) => {
          if (review) await tx.update('funding_reviews', review.id, { approval_request_id: req.id, reviewer_id: by.actor.id ?? null, comment: body.comment ?? review.comment });
          await tx.update('campaigns', id, { approval_request_id: req.id, ...(body.costCenter ? { cost_center: body.costCenter } : {}), updated_at: this.now() });
          await this.core.log(tx, id, 'funding.approval_requested', by, body.comment ?? null, { approvalRequestId: req.id });
        });
        return this.audited(id, 'promotions.campaign.funding_approval_requested', 'Requested budget approval', by, body.comment, req.id);
      }
    }
    await this.finishConfirmation(id, by, body.comment ?? null, body.costCenter ?? null);
    return this.audited(id, 'promotions.campaign.confirm_funding', 'Confirmed campaign funding', by, body.comment);
  }

  /** Separation of duties (G65a): whoever created the campaign or last sent it to Finance can't confirm its funding */
  private async refuseOwnCampaign(row: CampaignRec, by: By): Promise<void> {
    if (await this.isOwnCampaign(row, by)) {
      throw this.ctx.error('SAME_REVIEWER', 'You created or submitted this campaign: another Finance member confirms its funding');
    }
  }

  /** Whoever created the campaign or last sent it to Finance */
  private async isOwnCampaign(row: CampaignRec, by: By): Promise<boolean> {
    const me = by.actor.id;
    if (!me) return false;
    const submitted = (await this.repo.find('campaign_log', { campaign_id: row.id, action: 'submitted' }, { orderBy: [['at', 'desc']], limit: 1 }))[0];
    return decodeActor(row.created_by)?.id === me || submitted?.actor_id === me;
  }

  /** in_review → approved with the review confirmed; publishes funding_confirmed */
  async finishConfirmation(id: string, by: By, comment: string | null, costCenter: string | null) {
    const review = await this.repo.transaction(async (tx) => {
      const row = await tx.get('campaigns', id, { forUpdate: true });
      if (!row) throw notFound('Campaign');
      const status = this.core.step(promotionCampaignMachine, row.status, 'confirmFunding');
      await tx.update('campaigns', id, { status, approval_request_id: null, ...(costCenter ? { cost_center: costCenter } : {}), updated_at: this.now(), version: row.version + 1 });
      // what Finance confirmed: a live or paused flash sale can only change within it
      for (const f of await tx.find('flash_items', { campaign_id: id })) await tx.update('flash_items', f.id, { approved_deal_price: f.deal_price, approved_deal_stock: f.deal_stock, approved_purchase_limit: f.purchase_limit });
      const r = (await tx.find('funding_reviews', { campaign_id: id }, { orderBy: [['sent_at', 'desc']], limit: 1 }))[0];
      if (r) await tx.update('funding_reviews', r.id, { state: 'confirmed', reviewer_id: r.reviewer_id ?? by.actor.id ?? null, decided_at: this.now(), comment: comment ?? r.comment });
      await this.core.log(tx, id, 'funding.confirmed', by, comment);
      return r;
    });
    const c = (await this.core.campaign(id)).model;
    this.core.publish('promotions.campaign.funding_confirmed', { campaignId: id, platformMaximum: m(review?.platform_max ?? 0, c.currency), sellersMaximum: m(review?.sellers_max ?? 0, c.currency) }, by);
  }

  async requestChanges(id: string, reason: string, by: By): Promise<Campaign> {
    const review = await this.transition(id, 'requestChanges', by, { reviewState: 'changes_requested', reason });
    if (review?.approval_request_id) await this.core.optional('access', (a) => a.cancelApproval(review.approval_request_id!, by.actor, 'Finance requested changes'));
    this.core.publish('promotions.campaign.changes_requested', { campaignId: id, reason }, by);
    return this.audited(id, 'promotions.campaign.request_changes', 'Sent campaign back to Marketing', by, reason);
  }

  /** A campaign transition that also updates the latest funding review */
  async transition(id: string, event: string, by: By, o: { reviewState?: string; reason?: string; to?: string } = {}): Promise<FundingReviewRec | undefined> {
    return this.repo.transaction(async (tx) => {
      const row = await tx.get('campaigns', id, { forUpdate: true });
      if (!row) throw notFound('Campaign');
      const status = this.core.step(promotionCampaignMachine, row.status, event, o.to);
      await tx.update('campaigns', id, { status, updated_at: this.now(), version: row.version + 1, ...(o.reviewState ? { approval_request_id: null } : {}) });
      const r = (await tx.find('funding_reviews', { campaign_id: id }, { orderBy: [['sent_at', 'desc']], limit: 1 }))[0];
      if (r && o.reviewState) await tx.update('funding_reviews', r.id, { state: o.reviewState, reviewer_id: by.actor.kind === 'staff' ? (by.actor.id ?? r.reviewer_id) : r.reviewer_id, decided_at: this.now(), comment: o.reason ?? r.comment, approval_request_id: null });
      await this.core.log(tx, id, event, by, o.reason ?? null);
      return r;
    });
  }

  async audited(id: string, action: string, label: string, by: By, reason?: string | null, approvalRequestId?: string): Promise<Campaign> {
    const view = await this.view(id);
    await this.core.audit({ action, actionLabel: label, category: 'other', target: { type: 'campaign', id, ref: view.ref, label: view.name }, after: { status: view.status }, reason: reason ?? null, ...(approvalRequestId ? { approvalRequestId } : {}) }, by);
    return view;
  }

  /** access.approval.decided for promotions.budgets.approve */
  async onApprovalDecided(e: { requestId: string; actionKey: string; module: string; target: { id: string }; outcome: string; decidedBy?: common.Actor | null; reason?: string | null }) {
    if (e.module !== 'promotions' || e.actionKey !== 'promotions.budgets.approve') return;
    const row = await this.repo.get('campaigns', e.target.id);
    if (!row || row.approval_request_id !== e.requestId || row.status !== 'in_review') return;
    const by: By = { actor: e.decidedBy ?? SYSTEM };
    if (e.outcome === 'approved' && (await this.isOwnCampaign(row, by))) {
      // separation of duties holds in the Approvals Inbox too: the request is closed and the campaign stays in review
      const note = 'Approved by the person who created or submitted the campaign; another Finance member confirms the funding';
      await this.repo.transaction(async (tx) => {
        await tx.update('campaigns', row.id, { approval_request_id: null, updated_at: this.now() });
        await tx.updateWhere('funding_reviews', { campaign_id: row.id, approval_request_id: e.requestId }, { approval_request_id: null });
        await this.core.log(tx, row.id, 'funding.approval_ignored', by, note, { approvalRequestId: e.requestId });
      });
      await this.audited(row.id, 'promotions.campaign.funding_approval_ignored', 'Budget approval by its own creator or submitter ignored', by, note, e.requestId);
    } else if (e.outcome === 'approved') {
      await this.finishConfirmation(row.id, by, e.reason ?? null, null);
      await this.audited(row.id, 'promotions.campaign.confirm_funding', 'Budget approved; funding confirmed', by, e.reason, e.requestId);
    } else if (e.outcome === 'rejected') {
      const reason = e.reason ?? 'Budget approval rejected';
      await this.transition(row.id, 'requestChanges', by, { reviewState: 'changes_requested', reason });
      this.core.publish('promotions.campaign.changes_requested', { campaignId: row.id, reason }, by);
    } else {
      await this.repo.transaction(async (tx) => {
        await tx.update('campaigns', row.id, { approval_request_id: null, updated_at: this.now() });
        await tx.updateWhere('funding_reviews', { campaign_id: row.id, approval_request_id: e.requestId }, { approval_request_id: null });
        await this.core.log(tx, row.id, 'funding.approval_closed', by, `Approval ${e.outcome}`);
      });
    }
  }

  /* ---------------------------------------------------------------- publishing lifecycle */

  async schedule(id: string, by: By): Promise<Campaign> {
    const { model: c } = await this.core.campaign(id);
    if (c.ownerKind === 'platform' && c.status === 'draft') throw new AppError('ILLEGAL_TRANSITION', 'Platform campaigns need Finance to confirm funding before they are scheduled', { from: c.status, event: 'schedule' });
    this.core.step(promotionCampaignMachine, c.status, 'schedule');
    const issues = periodIssues(c.startsAt, c.endsAt, c.timeZone, this.now());
    if (c.kind === 'flash_sale' && !(await this.repo.count('flash_items', { campaign_id: id }))) issues.push({ path: 'flashItems', message: 'Add flash items first' });
    if (issues.length) throw invalid(issues, 'The campaign cannot be scheduled');
    await this.refreshEligibleQuietly(id);
    await this.publishSchedule(id, by);
    return this.audited(id, 'promotions.campaign.schedule', 'Scheduled campaign', by);
  }

  /** → scheduled, publish scheduled, and start at once when the start time has come */
  async publishSchedule(id: string, by: By) {
    await this.transition(id, 'schedule', by);
    const { model: c } = await this.core.campaign(id);
    this.core.publish('promotions.campaign.scheduled', { campaignId: id, startsAt: c.startsAt.toISOString(), endsAt: c.endsAt.toISOString(), sellerId: c.sellerId }, by);
    if (c.startsAt.getTime() <= this.now().getTime()) await this.start(id, by);
  }

  /** scheduled → live at the start time */
  async start(id: string, by: By = { actor: SYSTEM }) {
    const started = await this.repo.transaction(async (tx) => {
      const row = await tx.get('campaigns', id, { forUpdate: true });
      if (!row || row.status !== 'scheduled') return null;
      await tx.update('campaigns', id, { status: this.core.step(promotionCampaignMachine, row.status, 'start'), updated_at: this.now(), version: row.version + 1 });
      await this.core.log(tx, id, 'started', by);
      return row;
    });
    if (!started) return;
    const offerIds = (await this.repo.find('eligible_offers', { campaign_id: id, eligible: true }, { limit: 1000 })).map((e) => e.offer_id);
    this.core.publish('promotions.campaign.started', { campaignId: id, kind: started.kind, offerIds, endsAt: iso(started.ends_at) }, by);
  }

  async pause(id: string, reason: string | null, by: By): Promise<void> {
    await this.transition(id, 'pause', by, { reason: reason ?? undefined });
    this.core.publish('promotions.campaign.paused', { campaignId: id, reason }, by);
  }

  async resume(id: string, reason: string | null, by: By): Promise<void> {
    const { model: c } = await this.core.campaign(id);
    if (c.endsAt.getTime() <= this.now().getTime()) throw invalid([{ path: 'endsAt', message: 'The campaign period is over' }], 'The campaign cannot resume');
    const to = c.startsAt.getTime() <= this.now().getTime() ? 'live' : 'scheduled';
    await this.transition(id, 'resume', by, { reason: reason ?? undefined, to });
    this.core.publish('promotions.campaign.resumed', { campaignId: id }, by);
    if (to === 'live' && !(await this.repo.findOne('campaign_log', { campaign_id: id, action: 'started' }))) {
      await this.repo.transaction((tx) => this.core.log(tx, id, 'started', by));
      const offerIds = (await this.repo.find('eligible_offers', { campaign_id: id, eligible: true }, { limit: 1000 })).map((e) => e.offer_id);
      this.core.publish('promotions.campaign.started', { campaignId: id, kind: c.kind, offerIds, endsAt: c.endsAt.toISOString() }, by);
    }
  }

  /** live|paused → ended with a reason; codes stop working, flash items end. Idempotent for already ended campaigns. */
  async end(id: string, reason: 'period_over' | 'budget_exhausted' | 'usage_cap_reached' | 'ended_early' | 'sold_out', by: By, note?: string | null): Promise<boolean> {
    const ended = await this.repo.transaction(async (tx) => {
      const row = await tx.get('campaigns', id, { forUpdate: true });
      if (!row) throw notFound('Campaign');
      if (row.status === 'ended' && reason !== 'ended_early') return false;
      const status = this.core.step(promotionCampaignMachine, row.status, 'end');
      await tx.update('campaigns', id, { status, ended_reason: reason, updated_at: this.now(), version: row.version + 1 });
      await tx.updateWhere('coupon_codes', { campaign_id: id, active: true }, { active: false });
      for (const f of await tx.find('flash_items', { campaign_id: id, state: ['active', 'sold_out'] })) await tx.update('flash_items', f.id, { state: this.core.step(flashItemMachine, f.state, 'end') });
      await this.core.log(tx, id, 'ended', by, note ?? reason, { reason });
      return true;
    });
    if (ended) this.core.publish('promotions.campaign.ended', { campaignId: id, reason }, by);
    return ended;
  }

  async cancel(id: string, reason: string, by: By): Promise<void> {
    const review = await this.repo.transaction(async (tx) => {
      const row = await tx.get('campaigns', id, { forUpdate: true });
      if (!row) throw notFound('Campaign');
      const status = this.core.step(promotionCampaignMachine, row.status, 'cancel');
      await tx.update('campaigns', id, { status, approval_request_id: null, updated_at: this.now(), version: row.version + 1 });
      await tx.updateWhere('coupon_codes', { campaign_id: id, active: true }, { active: false });
      await this.core.log(tx, id, 'cancelled', by, reason);
      return row.approval_request_id;
    });
    if (review) await this.core.optional('access', (a) => a.cancelApproval(review, by.actor, 'Campaign cancelled'));
    this.core.publish('promotions.campaign.cancelled', { campaignId: id, reason }, by);
  }

  /** End campaigns whose budget, usage cap or deal stock is used up (after commits) */
  async endIfExhausted(campaignId: string) {
    const row = await this.repo.get('campaigns', campaignId);
    if (!row || !['live', 'paused'].includes(row.status)) return;
    const held = (await this.repo.heldAmounts([campaignId])).get(campaignId) ?? 0;
    const committed = row.budget_used - held;
    if (row.budget_amount !== null && committed >= row.budget_amount) return void (await this.end(campaignId, 'budget_exhausted', { actor: SYSTEM }));
    const open = await this.repo.count('redemptions', { campaign_id: campaignId, state: 'reserved' });
    if (row.usage_cap !== null && row.usage_count >= row.usage_cap && !open) return void (await this.end(campaignId, 'usage_cap_reached', { actor: SYSTEM }));
    if (row.kind === 'flash_sale') {
      const items = await this.repo.find('flash_items', { campaign_id: campaignId });
      if (items.length && items.every((f) => f.state === 'ended' || f.claimed >= f.deal_stock)) await this.end(campaignId, 'sold_out', { actor: SYSTEM });
    }
  }

  /* ---------------------------------------------------------------- flash items */

  /** o.storefront leaves out items whose offer now costs more than the regular price they were set with: no deal price applies (evaluate) */
  async flashItems(c: CampaignModel, rows?: FlashItemRec[], o: { storefront?: boolean } = {}): Promise<FlashItem[]> {
    const items = rows ?? (await this.repo.find('flash_items', { campaign_id: c.id }, { orderBy: [['id', 'asc']] }));
    if (!items.length) return [];
    const cards = await this.core.offerCards(items.map((f) => f.offer_id), { withStock: false });
    const out: FlashItem[] = [];
    for (const f of items) {
      const card = cards.get(f.offer_id);
      if (o.storefront && card && card.offer.price.amount > f.regular_price) continue;
      const cur = card?.offer.price.currency ?? c.currency;
      const taken = f.claimed + f.reserved;
      out.push({
        id: f.id,
        offerId: f.offer_id,
        productId: card?.offer.productId ?? f.offer_id,
        title: card?.title ?? 'Offer',
        image: card?.image ?? null,
        sellerId: card?.offer.sellerId ?? card?.offer.id ?? f.offer_id,
        sellerName: card?.sellerName ?? 'Seller',
        sellerSlug: card?.sellerSlug ?? null,
        dealPrice: m(f.deal_price, cur),
        regularPrice: m(f.regular_price, cur),
        percentOffBps: f.regular_price > 0 ? Math.round(((f.regular_price - f.deal_price) * 10000) / f.regular_price) : 0,
        dealStock: f.deal_stock,
        claimed: f.claimed,
        claimedPct: f.deal_stock > 0 ? Math.min(100, Math.floor((taken * 100) / f.deal_stock)) : 100,
        purchaseLimit: f.purchase_limit,
        state: f.state as FlashItem['state'],
        soldOutAt: isoOrNull(f.sold_out_at),
        regularOffer: f.state === 'sold_out' ? { offerId: f.offer_id, regularPrice: m(card?.offer.price.amount ?? f.regular_price, cur), price: m(card?.offer.price.amount ?? f.regular_price, cur), wasPrice: null, wasPriceRule: null, badges: [], campaignId: null, purchaseLimit: null, flash: null, sellerPromos: [] } : null,
      });
    }
    return out;
  }

  async putFlashItems(id: string, items: FlashItemInput[], reason: string | null | undefined, by: By): Promise<FlashItem[]> {
    const { model: c } = await this.core.campaign(id);
    if (c.kind !== 'flash_sale') throw invalid([{ path: 'kind', message: 'Only flash sales have flash items' }]);
    if (c.status === 'in_review') throw this.ctx.error('CAMPAIGN_LOCKED', 'Edits are locked while Finance reviews the funding');
    if (CLOSED.includes(c.status)) throw new AppError('ILLEGAL_TRANSITION', `A ${c.status} campaign can't be edited`, { from: c.status });
    const dup = items.find((x, i) => items.findIndex((y) => y.offerId === x.offerId) !== i);
    if (dup) throw invalid([{ path: 'items', message: 'Each offer can appear once' }]);
    const cards = await this.core.offerCards(items.map((x) => x.offerId));
    const problems: { offerId: string; reasons: string[] }[] = [];
    const stockProblems: { offerId: string; available: number; dealStock: number }[] = [];
    const issues: Issue[] = [];
    items.forEach((x, i) => {
      const card = cards.get(x.offerId);
      const reasons: string[] = [];
      if (!card) reasons.push('Offer not found');
      else {
        if (card.offer.status !== 'active') reasons.push(`Offer is ${card.offer.status.replace(/_/g, ' ')}`);
        if (x.dealPrice.amount <= 0 || x.dealPrice.amount >= card.offer.price.amount) reasons.push('Deal price must be below the regular price');
        if (card.stock !== null && x.dealStock > card.stock) stockProblems.push({ offerId: x.offerId, available: card.stock, dealStock: x.dealStock });
      }
      if (x.dealStock < 1) issues.push({ path: `items.${i}.dealStock`, message: 'Deal stock must be at least 1' });
      if (x.purchaseLimit < 1) issues.push({ path: `items.${i}.purchaseLimit`, message: 'Purchase limit must be at least 1' });
      if (reasons.length) problems.push({ offerId: x.offerId, reasons });
    });
    if (issues.length) throw invalid(issues);
    if (problems.length) throw this.ctx.error('OFFER_NOT_ELIGIBLE', 'Some offers cannot be in this flash sale', { offers: problems });
    if (stockProblems.length) throw this.ctx.error('INSUFFICIENT_STOCK', 'Deal stock is above the available stock', { offers: stockProblems });
    // a sale Finance confirmed: before it starts any change goes back to Finance; once live it changes only within what was confirmed
    const reviewed = c.ownerKind !== 'seller';
    const before = new Map((await this.repo.find('flash_items', { campaign_id: id })).filter((f) => f.state !== 'ended').map((f) => [f.offer_id, f]));
    if (reviewed && (c.status === 'live' || c.status === 'paused')) {
      const above = items.flatMap((x) => {
        const f = before.get(x.offerId);
        const title = cards.get(x.offerId)!.title;
        if (!f) return [{ offerId: x.offerId, reason: `${title} was not in the sale Finance confirmed` }];
        // items confirmed before the approved values were kept: their current values are the ceiling
        const price = f.approved_deal_price ?? f.deal_price;
        const stock = f.approved_deal_stock ?? f.deal_stock;
        const limit = f.approved_purchase_limit ?? f.purchase_limit;
        const reasons = [
          ...(x.dealPrice.amount < price ? [`deal price below the confirmed ${moneyFull(price, c.currency)}`] : []),
          ...(x.dealStock > stock ? [`deal stock above the confirmed ${stock}`] : []),
          ...(x.purchaseLimit > limit ? [`purchase limit above the confirmed ${limit}`] : []),
        ];
        return reasons.length ? [{ offerId: x.offerId, reason: `${title}: ${reasons.join(', ')}` }] : [];
      });
      if (above.length) throw new AppError('ILLEGAL_TRANSITION', `A ${c.status} flash sale can only change within what Finance confirmed; end it and create a new one for more`, { from: c.status, items: above });
    }
    const changed = items.length !== before.size || items.some((x) => {
      const f = before.get(x.offerId);
      return !f || f.deal_price !== x.dealPrice.amount || f.deal_stock !== x.dealStock || f.purchase_limit !== x.purchaseLimit;
    });
    const reopen = reviewed && changed && (c.status === 'approved' || c.status === 'scheduled');
    const restocked: string[] = [];
    await this.repo.transaction(async (tx) => {
      if (reopen) {
        const row = (await tx.get('campaigns', id, { forUpdate: true }))!;
        await tx.update('campaigns', id, { status: this.core.step(promotionCampaignMachine, row.status, 'reopen'), approval_request_id: null, updated_at: this.now(), version: row.version + 1 });
        await this.core.log(tx, id, 'reopened', by, reason ?? null, { fields: ['flashItems'], material: ['flashItems'] });
      }
      const existing = new Map((await tx.find('flash_items', { campaign_id: id }, { forUpdate: true })).map((f) => [f.offer_id, f]));
      for (const x of items) {
        const card = cards.get(x.offerId)!;
        const cur = existing.get(x.offerId);
        if (cur) {
          if (x.dealStock < cur.claimed + cur.reserved) throw invalid([{ path: 'items', message: `Deal stock of ${card.title} can't go below the ${cur.claimed + cur.reserved} units already claimed` }]);
          let state = cur.state;
          if (cur.state === 'sold_out' && x.dealStock > cur.claimed + cur.reserved) {
            state = this.core.step(flashItemMachine, cur.state, 'restock');
            restocked.push(x.offerId);
          }
          if (cur.state === 'ended') throw new AppError('ILLEGAL_TRANSITION', `${card.title} has ended in this sale`, { from: 'ended' });
          await tx.update('flash_items', cur.id, { deal_price: x.dealPrice.amount, regular_price: card.offer.price.amount, deal_stock: x.dealStock, purchase_limit: x.purchaseLimit, state, ...(state === 'active' ? { sold_out_at: null } : {}) });
          existing.delete(x.offerId);
        } else {
          await tx.insert('flash_items', { id: newId(), campaign_id: id, offer_id: x.offerId, deal_price: x.dealPrice.amount, regular_price: card.offer.price.amount, deal_stock: x.dealStock, claimed: 0, reserved: 0, purchase_limit: x.purchaseLimit, state: 'active', sold_out_at: null, approved_deal_price: null, approved_deal_stock: null, approved_purchase_limit: null });
        }
      }
      for (const left of existing.values()) {
        if (left.claimed + left.reserved > 0) {
          if (left.state !== 'ended') await tx.update('flash_items', left.id, { state: this.core.step(flashItemMachine, left.state, 'end') });
        } else await tx.removeWhere('flash_items', { id: left.id });
      }
      await this.core.log(tx, id, 'flash_items.set', by, reason ?? null, { items: items.length, restocked });
    });
    await this.refreshEligibleQuietly(id);
    const result = await this.flashItems(c);
    await this.core.audit({ action: 'promotions.flash_items.set', actionLabel: reopen ? 'Set flash items (reopened for Finance)' : restocked.length ? 'Set flash items (restocked)' : 'Set flash items', category: 'other', target: { type: 'campaign', id, ref: c.ref, label: c.name }, after: items, reason: reason ?? null }, by);
    return result;
  }

  /* ---------------------------------------------------------------- codes */

  async generateCodes(id: string, body: { count: number; prefix?: string | null; maxRedemptionsEach?: number | null; assignedCustomerIds?: string[] | null }, by: By): Promise<{ created: number; sample: CouponCode[] }> {
    const { model: c } = await this.core.campaign(id);
    if (CLOSED.includes(c.status)) throw new AppError('ILLEGAL_TRANSITION', `A ${c.status} campaign can't get new codes`, { from: c.status });
    const assigned = body.assignedCustomerIds ?? [];
    const count = Math.max(body.count, assigned.length);
    const issues: Issue[] = [];
    if (count < 1 || count > 10000) issues.push({ path: 'count', message: 'Generate between 1 and 10,000 codes' });
    const prefix = body.prefix ? normalizeCode(body.prefix) : null;
    if (prefix && !/^[A-Z0-9]{1,12}$/.test(prefix)) issues.push({ path: 'prefix', message: 'Prefix is up to 12 letters or digits' });
    if (body.maxRedemptionsEach != null && body.maxRedemptionsEach < 1) issues.push({ path: 'maxRedemptionsEach', message: 'Must be at least 1' });
    if (issues.length) throw invalid(issues);
    const now = this.now();
    const rows = Array.from({ length: count }, (_, i) => ({ id: newId(), campaign_id: id, code: randomCode(prefix), kind: 'unique' as const, max_redemptions: body.maxRedemptionsEach ?? 1, redemptions: 0, assigned_customer_id: assigned[i] ?? null, issue_key: null, active: true, created_at: now }));
    await this.repo.transaction(async (tx) => {
      await tx.insertMany('coupon_codes', rows);
      await this.core.log(tx, id, 'codes.generated', by, null, { count, prefix, assigned: assigned.length });
    });
    await this.core.audit({ action: 'promotions.codes.generate', actionLabel: `Generated ${count} unique codes`, category: 'other', target: { type: 'campaign', id, ref: c.ref, label: c.name }, after: { count, prefix, maxRedemptionsEach: body.maxRedemptionsEach ?? 1 } }, by);
    return { created: count, sample: rows.slice(0, 10).map(toCode) };
  }

  /**
   * One customer's own single-use code of a coupon campaign (a Daily rewards redemption). The campaign must be a coupon
   * campaign that is scheduled or running; the same key always answers the same code.
   */
  async issueCode(campaignId: string, customerId: string, key: string): Promise<IssuedCoupon> {
    const issued = async (code: CodeRec): Promise<IssuedCoupon> => {
      const { model: c } = await this.core.campaign(code.campaign_id);
      return { codeId: code.id, code: code.code, campaignId: c.id, title: c.description ?? c.name, endsAt: c.endsAt.toISOString() };
    };
    const before = await this.repo.findOne('coupon_codes', { issue_key: key });
    if (before) return issued(before);
    const row = isUuid(campaignId) ? await this.repo.get('campaigns', campaignId) : undefined;
    const c = row ? (await this.core.models([row]))[0] : undefined;
    const now = this.now();
    if (!c || ![...COUPON_KINDS, ...SHIPPING_KINDS].includes(c.kind) || !['scheduled', 'live'].includes(c.status) || c.endsAt.getTime() <= now.getTime())
      throw this.ctx.error('CAMPAIGN_NOT_ACTIVE', "This coupon campaign isn't running");
    // a new random code clashes with an active one very rarely: try again with another
    for (let attempt = 0; attempt < 5; attempt++) {
      const code: CodeRec = { id: newId(), campaign_id: c.id, code: randomCode(), kind: 'unique', max_redemptions: 1, redemptions: 0, assigned_customer_id: customerId, issue_key: key, active: true, created_at: now };
      const inserted = await this.repo.transaction(async (tx) => {
        if (!(await tx.insertIfAbsent('coupon_codes', code))) return false;
        await this.core.log(tx, c.id, 'code.issued', { actor: SYSTEM }, null, { codeId: code.id, customerId });
        return true;
      });
      if (inserted) return issued(code);
      const same = await this.repo.findOne('coupon_codes', { issue_key: key });
      if (same) return issued(same);
    }
    throw new AppError('CONFLICT', "Couldn't create a code. Try again.");
  }

  async listCodes(id: string, q: { q?: string; active?: boolean }, page: PageRequest): Promise<common.Page<CouponCode>> {
    await this.core.campaign(id);
    if (q.q?.trim()) {
      const term = q.q.trim().toUpperCase();
      const all = (await this.repo.find('coupon_codes', { campaign_id: id, ...(q.active !== undefined ? { active: q.active } : {}) }, { orderBy: [['created_at', 'desc'], ['id', 'desc']], limit: 20000 })).filter((c) => c.code.toUpperCase().includes(term));
      return pageOf(all.map(toCode), page);
    }
    const p = await this.repo.page('coupon_codes', { campaign_id: id, ...(q.active !== undefined ? { active: q.active } : {}) }, page, { column: 'created_at', direction: 'desc' });
    return { ...p, items: p.items.map(toCode) };
  }

  async deactivateCode(codeId: string, reason: string, by: By): Promise<CouponCode> {
    const code = await this.repo.get('coupon_codes', codeId);
    if (!code) throw notFound('Code');
    const after = await this.repo.transaction(async (tx) => {
      const rec = await tx.update('coupon_codes', codeId, { active: false });
      await this.core.log(tx, code.campaign_id, 'code.deactivated', by, reason, { codeId, code: code.code });
      return rec;
    });
    await this.core.audit({ action: 'promotions.code.deactivate', actionLabel: `Deactivated code ${code.code}`, category: 'other', target: { type: 'coupon_code', id: codeId, label: code.code }, relatedTargets: [{ type: 'campaign', id: code.campaign_id }], before: toCode(code), after: toCode(after), reason }, by);
    return toCode(after);
  }

  /* ---------------------------------------------------------------- redemptions, results, history */

  async orderRefs(orderIds: string[]): Promise<Map<string, string>> {
    const ids = [...new Set(orderIds.filter(Boolean))];
    const out = new Map<string, string>();
    if (!ids.length) return out;
    const r = await this.core.optional('orders', (o) => o.getOrdersByIds({ area: 'admin' }, ids));
    for (const [id, v] of Object.entries(r ?? {})) {
      const ref = (v as { ref?: string; order?: { ref?: string } } | null)?.ref ?? (v as { order?: { ref?: string } } | null)?.order?.ref;
      if (ref) out.set(id, ref);
    }
    return out;
  }

  async listRedemptions(id: string, state: string | undefined, page: PageRequest): Promise<common.Page<Redemption>> {
    await this.core.campaign(id);
    const p = await this.repo.page('redemptions', { campaign_id: id, ...(state ? { state: state.split(',') } : {}) }, page, { column: 'created_at', direction: 'desc' });
    const ids = p.items.map((r) => r.id);
    const [lines, codeRows, refs] = await Promise.all([
      ids.length ? this.repo.find('redemption_lines', { redemption_id: ids }) : [],
      this.repo.getMany('coupon_codes', p.items.map((r) => r.code_id).filter((x): x is string => Boolean(x))),
      this.orderRefs(p.items.map((r) => r.order_id ?? '')),
    ]);
    const codes = new Map(codeRows.map((c) => [c.id, c.code]));
    const units = unitsPerRedemption(lines);
    return {
      ...p,
      items: p.items.map((r) => toRedemption(r, { code: r.code_id ? (codes.get(r.code_id) ?? null) : null, orderRef: r.order_id ? (refs.get(r.order_id) ?? null) : null, items: units.get(r.id) ?? 0 })),
    };
  }

  /** Daily facts of a campaign recomputed from its redemptions (results roll-up) */
  async rollupCampaign(id: string): Promise<ResultRec[]> {
    const facts = await this.repo.resultFacts(id);
    const returns = await this.repo.find('campaign_log', { campaign_id: id, action: 'returned' });
    const days = new Map<string, ResultRec & { orderIds: Set<string> }>();
    const day = (d: string) => {
      let r = days.get(d);
      if (!r) days.set(d, (r = { campaign_id: id, day: d, sales: 0, orders: 0, cost_platform: 0, cost_seller: 0, redemptions: 0, returned_items: 0, official_cost_basis: 0, official_revenue: 0, orderIds: new Set() }));
      return r;
    };
    for (const f of facts) {
      const r = day(this.core.today(new Date(f.redemption.created_at)));
      const red = f.redemption;
      const platformNet = red.platform_part - (red.amount ? Math.round((red.reversed * red.platform_part) / red.amount) : 0);
      r.cost_platform += platformNet;
      r.cost_seller += red.amount - red.reversed - platformNet;
      if (red.state !== 'reversed') r.redemptions += 1;
      if (red.order_id) r.orderIds.add(red.order_id);
      const ev = (f.evaluation ?? {}) as { input?: { lines?: { lineId: string; officialStore: boolean }[] }; result?: { lines?: { lineId: string; regularUnitPrice: common.Money; lineDiscount: common.Money }[] } };
      const evLines = new Map((ev.result?.lines ?? []).map((l) => [l.lineId, l]));
      const official = new Set((ev.input?.lines ?? []).filter((l) => l.officialStore).map((l) => l.lineId));
      for (const l of f.lines) {
        const el = evLines.get(l.line_id);
        if (!el || l.quantity <= 0) continue;
        const regular = el.regularUnitPrice.amount * l.quantity;
        const paid = regular - el.lineDiscount.amount;
        r.sales += paid;
        if (official.has(l.line_id)) {
          r.official_revenue += paid;
          r.official_cost_basis += regular;
        }
      }
    }
    for (const l of returns) day(this.core.today(new Date(l.at))).returned_items += Number((l.detail as { items?: number } | null)?.items ?? 0);
    const out: ResultRec[] = [];
    for (const r of days.values()) {
      const { orderIds, ...row } = r;
      row.orders = orderIds.size;
      out.push(row);
    }
    return out;
  }

  async result(c: CampaignModel, rows: ResultRec[], status: string): Promise<CampaignResult> {
    const sum = (k: keyof ResultRec) => rows.reduce((a, r) => a + Number(r[k] ?? 0), 0);
    const cur = c.currency;
    const platform = sum('cost_platform');
    const seller = sum('cost_seller');
    const basis = sum('official_cost_basis');
    const orders = sum('orders');
    const joined = c.ownerKind === 'seller' ? 1 : await this.repo.count('participations', { campaign_id: c.id, state: ['accepted', 'withdrawal_requested'] });
    return {
      campaignId: c.id,
      name: c.name,
      status,
      period: periodOf(c),
      sales: m(sum('sales'), cur),
      orders,
      discountCost: { total: m(platform + seller, cur), platform: m(platform, cur), seller: m(seller, cur) },
      marginImpactPts: basis > 0 ? Math.round(((sum('official_revenue') - basis) / basis) * 1000) / 10 : null,
      marginNote: c.funding.owner === 'seller' ? 'Seller funded' : basis > 0 ? 'Official Store discount is a company cost' : 'Not affected',
      redemptions: sum('redemptions'),
      redemptionShareOfOrders: null,
      sellersJoined: joined,
      returnsRatePct: orders > 0 ? Math.round((sum('returned_items') / orders) * 1000) / 10 : null,
      budget: c.limits.budget ?? null,
      budgetUsed: m(c.budgetUsed, cur),
    };
  }

  async results(id: string): Promise<{ result: CampaignResult; daily: DailyPoint[]; bySeller: unknown[] }> {
    const { model: c } = await this.core.campaign(id);
    const rows = await this.rollupCampaign(id);
    rows.sort((a, b) => a.day.localeCompare(b.day));
    const today = this.core.today();
    const facts = await this.repo.resultFacts(id);
    const bySeller = new Map<string, { sales: number; sellerFunded: number; platformFunded: number }>();
    for (const f of facts) {
      const ev = (f.evaluation ?? {}) as { result?: { lines?: { lineId: string; regularUnitPrice: common.Money; lineDiscount: common.Money }[] } };
      const evLines = new Map((ev.result?.lines ?? []).map((l) => [l.lineId, l]));
      for (const l of f.lines) {
        const s = bySeller.get(l.seller_id) ?? { sales: 0, sellerFunded: 0, platformFunded: 0 };
        const el = evLines.get(l.line_id);
        if (el && l.quantity > 0) s.sales += el.regularUnitPrice.amount * l.quantity - el.lineDiscount.amount;
        const platformRev = l.amount ? Math.round((l.reversed * l.platform_part) / l.amount) : 0;
        s.platformFunded += l.platform_part - platformRev;
        s.sellerFunded += l.amount - l.reversed - (l.platform_part - platformRev);
        bySeller.set(l.seller_id, s);
      }
    }
    const names = await this.core.sellerNames([...bySeller.keys()]);
    return {
      result: await this.result(c, rows, c.status),
      daily: rows.map((r) => ({ date: r.day, value: m(r.cost_platform + r.cost_seller, c.currency), partial: r.day === today })),
      bySeller: [...bySeller.entries()].map(([sellerId, s]) => ({ sellerId, sellerName: sellerId === OFFICIAL_STORE_ID ? OFFICIAL_STORE_NAME : (names.get(sellerId) ?? OFFICIAL_STORE_NAME), sales: m(s.sales, c.currency), sellerFunded: m(s.sellerFunded, c.currency), platformFunded: m(s.platformFunded, c.currency) })),
    };
  }

  async history(id: string, page: PageRequest): Promise<common.Page<CampaignLogEntry>> {
    await this.core.campaign(id);
    const p = await this.repo.page('campaign_log', { campaign_id: id }, page, { column: 'at', direction: 'desc' });
    return { ...p, items: p.items.map(toLogEntry) };
  }

  async dashboard(q: { from?: string; to?: string }): Promise<PromotionsDashboard> {
    const to = q.to ?? this.core.today();
    const from = q.from ?? this.core.today(new Date(new Date(`${to}T12:00:00Z`).getTime() - 29 * 86_400_000));
    if (from > to) throw invalid([{ path: 'from', message: 'The start date is after the end date' }]);
    const rows = await this.repo.resultsInRange(from, to);
    const ids = [...new Set(rows.map((r) => r.campaign_id))];
    const models = new Map((await this.core.models(await this.repo.getMany('campaigns', ids))).map((c) => [c.id, c]));
    const cur = this.core.currency();
    const sum = (list: ResultRec[], k: keyof ResultRec) => list.reduce((a, r) => a + Number(r[k] ?? 0), 0);
    const platform = sum(rows, 'cost_platform');
    const seller = sum(rows, 'cost_seller');
    const orders = sum(rows, 'orders');
    const couponRows = rows.filter((r) => ['percent_coupon', 'fixed_coupon', 'min_spend', 'free_shipping'].includes(models.get(r.campaign_id)?.kind ?? ''));
    const basis = sum(rows, 'official_cost_basis');
    const statusRows = await this.repo.find('campaigns', {});
    const tab = (key: string, label: string, pred: (r: CampaignRec) => boolean): TabCount => ({ key, label, count: statusRows.filter(pred).length });
    const daily: DailyPoint[] = [];
    const today = this.core.today();
    for (let t = new Date(`${from}T12:00:00Z`).getTime(); daily.length < 400; t += 86_400_000) {
      const d = new Date(t).toISOString().slice(0, 10);
      if (d > to) break;
      const dayRows = rows.filter((r) => r.day === d);
      daily.push({ date: d, value: m(sum(dayRows, 'cost_platform') + sum(dayRows, 'cost_seller'), cur), partial: d === today });
    }
    const results: CampaignResult[] = [];
    for (const id of ids.slice(0, 50)) {
      const c = models.get(id);
      if (c) results.push(await this.result(c, rows.filter((r) => r.campaign_id === id), c.status));
    }
    const fromReports = await this.reportFigures(from, to);
    const margin = fromReports.marginBefore != null && fromReports.marginAfter != null ? Math.round((fromReports.marginAfter - fromReports.marginBefore) * 10) / 10 : null;
    return {
      range: { from, to },
      timeZone: this.ctx.config.market.timeZone,
      promotedSales: m(sum(rows, 'sales'), cur),
      promotedOrders: orders,
      discountCost: { total: m(platform + seller, cur), platform: m(platform, cur), seller: m(seller, cur) },
      sharedCost: m(
        rows.filter((r) => models.get(r.campaign_id)?.funding.owner === 'shared').reduce((a, r) => a + r.cost_platform + r.cost_seller, 0),
        cur,
      ),
      // Official Store margin % from reports: the same number of days before the range, and the range itself
      officialMargin: {
        before: fromReports.marginBefore,
        after: fromReports.marginAfter,
        changePts: margin ?? (basis > 0 ? Math.round(((sum(rows, 'official_revenue') - basis) / basis) * 1000) / 10 : null),
      },
      couponRedemptions: sum(couponRows, 'redemptions'),
      redemptionShareOfOrders: orders > 0 ? Math.round((sum(couponRows, 'orders') / orders) * 1000) / 10 : 0,
      returnsOnPromotedPct: orders > 0 ? Math.round((sum(rows, 'returned_items') / orders) * 1000) / 10 : 0,
      // the store-wide return rate from reports; null (never 0 as a stand-in) when reports is off or nothing sold
      storeReturnsPct: fromReports.storeReturnsPct,
      tabs: [
        tab('live', 'Live', (r) => r.status === 'live'),
        tab('scheduled', 'Scheduled', (r) => r.status === 'scheduled'),
        tab('in_review', 'Waiting for Finance', (r) => r.status === 'in_review'),
        tab('draft', 'Drafts', (r) => r.status === 'draft' || r.status === 'changes_requested' || r.status === 'approved'),
        tab('ended', 'Ended', (r) => r.status === 'ended' || r.status === 'cancelled'),
        tab('seller', 'Seller discounts', (r) => r.owner_kind === 'seller'),
      ],
      dailyCost: daily,
      results,
    };
  }

  /**
   * Official Store margin before and during a range, and the store-wide return rate, from reports
   * (reports.officialMargin, storeReturnRate). Nulls when reports is off or answers nothing.
   */
  private async reportFigures(from: string, to: string): Promise<{ marginBefore: number | null; marginAfter: number | null; storeReturnsPct: number | null }> {
    const api = this.ctx.tryUse('reports');
    if (!api) return { marginBefore: null, marginAfter: null, storeReturnsPct: null };
    const day = 86_400_000;
    const days = Math.round((Date.parse(`${to}T12:00:00Z`) - Date.parse(`${from}T12:00:00Z`)) / day) + 1;
    const shift = (d: string, n: number) => new Date(Date.parse(`${d}T12:00:00Z`) + n * day).toISOString().slice(0, 10);
    const quiet = async <T,>(what: string, fn: () => Promise<T>): Promise<T | null> => {
      try {
        return await fn();
      } catch (err) {
        this.ctx.log.warn({ err }, `promotions: ${what} from reports unavailable`);
        return null;
      }
    };
    const [before, after, returns] = await Promise.all([
      quiet('margin before', () => api.officialMargin({ from: shift(from, -days), to: shift(from, -1) })),
      quiet('margin', () => api.officialMargin({ from, to })),
      quiet('return rate', () => api.storeReturnRate({ from, to })),
    ]);
    return { marginBefore: before?.marginPct ?? null, marginAfter: after?.marginPct ?? null, storeReturnsPct: returns?.returnRatePct ?? null };
  }

  /* ---------------------------------------------------------------- reports export */

  registerDataset(): Promise<void> | undefined {
    const api = this.ctx.tryUse('reports');
    if (!api) return undefined;
    this.#datasetRegistered ??= api
      .registerDataset({
        key: DATASET,
        owner: 'promotions',
        title: 'Campaign results',
        permission: 'promotions.results.view',
        audience: 'staff',
        screens: ['admin/promotions'],
        available: true,
        phase: 1,
        columns: [
          { key: 'ref', label: 'Campaign' },
          { key: 'name', label: 'Name' },
          { key: 'status', label: 'Status' },
          { key: 'kind', label: 'Type' },
          { key: 'fundingOwner', label: 'Funded by' },
          { key: 'startsAt', label: 'Starts' },
          { key: 'endsAt', label: 'Ends' },
          { key: 'sales', label: 'Sales' },
          { key: 'orders', label: 'Orders' },
          { key: 'discountCost', label: 'Discount cost' },
          { key: 'platformFunded', label: 'Platform funded' },
          { key: 'sellerFunded', label: 'Seller funded' },
          { key: 'redemptions', label: 'Redemptions' },
          { key: 'budget', label: 'Budget' },
          { key: 'budgetUsed', label: 'Budget used' },
        ],
      })
      .catch((err) => {
        this.#datasetRegistered = undefined;
        this.ctx.log.debug({ err }, 'promotions: export dataset not registered');
      });
    return this.#datasetRegistered;
  }

  async exportRows(dataset: string, filters: unknown, cursor?: string): Promise<{ rows: unknown[]; nextCursor?: string }> {
    if (dataset !== DATASET) throw new AppError('NOT_FOUND', `Unknown dataset ${dataset}`);
    const q = (filters ?? {}) as ListCampaignsQuery;
    const p = await this.repo.listCampaigns({ q: q.q, statuses: q.status ? q.status.split(',') : undefined, kind: q.kind, fundingOwner: q.fundingOwner, ownerKind: q.ownerKind, sellerId: q.sellerId }, { mode: 'cursor', cursor: cursor ?? null, limit: 100 });
    const models = await this.core.models(p.items);
    const costs = await this.repo.costTotals(p.items.map((r) => r.id));
    const rows = models.map((c) => {
      const k = costs.get(c.id);
      return {
        ref: c.ref,
        name: c.name,
        status: c.status,
        kind: c.kind,
        fundingOwner: c.funding.owner,
        startsAt: c.startsAt.toISOString(),
        endsAt: c.endsAt.toISOString(),
        sales: null,
        orders: k?.orders ?? 0,
        discountCost: m(k?.total ?? 0, c.currency),
        platformFunded: m(k?.platform ?? 0, c.currency),
        sellerFunded: m(k?.seller ?? 0, c.currency),
        redemptions: k?.redemptions ?? 0,
        budget: c.limits.budget ?? null,
        budgetUsed: m(c.budgetUsed, c.currency),
      };
    });
    return { rows, ...(p.nextCursor ? { nextCursor: p.nextCursor } : {}) };
  }
}
