/**
 * Ad campaigns through their lifecycle (plan ch. 16): drafts, checks, submission, the review steps
 * (Advertising plus Content or Marketing), schedule/activate, pause/resume, finish, archive and renew.
 * Every status change goes through `transition`, which locks the row, writes the timeline and publishes
 * advertising.campaign.status_changed after the commit.
 */
import { AppError } from '../../../kernel/errors/index.js';
import { isUuid, newId } from '../../../kernel/lib/ids.js';
import type { PageRequest } from '../../../kernel/lib/pagination.js';
import type { AdCampaign, AdCampaignInput, AdCampaignSummary, AdPreview, CampaignCheckResult, Conflict, DismissalRule, FrequencyCap, PromotedItem, ReviewCheck } from '../../../spec/advertising.js';
import type * as common from '../../../spec/common.js';
import { adCampaignMachine } from '../domain/state-machines.js';
import { advertiserIsOwn, dismissalLabel, frequencyLabel, hasDiscountClaim, isPageType, isPaid, linkState, missingDevices, OVERLAY_KEYS, shortDate, sourceKinds, stepFor, requiredSteps, type ReviewRole } from '../domain/rules.js';
import type { AdvertisingRepository, CampaignRec, ItemRec, PlacementRec } from '../ports.js';
import { encodeActor, invalid, notFound, Part, SYSTEM, type By } from './core.js';
import { OFFER_PRODUCT, type Model } from './views.js';

type Status = AdCampaign['status'];
type Issue = { path: string; message: string };

export interface TransitionOptions {
  to?: Status;
  reason?: string | null;
  patch?: Partial<CampaignRec>;
  logAction?: string;
  sellerId?: string;
  /** Extra check on the locked row (throws to refuse) */
  guard?: (row: CampaignRec) => void;
}

/** Normalized campaign values ready for the row */
export interface CampaignValues {
  row: Omit<CampaignRec, 'id' | 'ref' | 'status' | 'spent' | 'created_by' | 'created_at' | 'updated_at' | 'version' | 'paused_reason' | 'finished_reason'>;
  items: Omit<ItemRec, 'campaign_id'>[];
  creatives: { creative_id: string; device: string }[];
  placement: PlacementRec;
}

const LIVE_STATES: readonly string[] = ['scheduled', 'live', 'paused'];
const OPEN_STATES: readonly string[] = ['in_review', 'approved', 'scheduled', 'live', 'paused'];
const toDate = (s: string | null | undefined) => (s ? new Date(s) : null);
const validDate = (d: Date | null) => d !== null && !Number.isNaN(d.getTime());

function validZone(tz: string): boolean {
  try {
    new Intl.DateTimeFormat('en-US', { timeZone: tz });
    return true;
  } catch {
    return false;
  }
}

export class CampaignsPart extends Part {
  /* ================================================================ reads */

  async list(q: { q?: string; source?: string; placementKey?: string; status?: string; linkedPromotionId?: string }, page: PageRequest): Promise<common.Page<AdCampaignSummary>> {
    const placement = q.placementKey ? await this.core.placementByKey(q.placementKey) : undefined;
    if (q.placementKey && !placement) return { items: [], nextCursor: null, ...(page.mode === 'page' ? { page: page.page, totalPages: 1, total: 0 } : {}) };
    const res = await this.repo.listCampaigns(
      {
        ...(q.q ? { q: q.q } : {}),
        ...(sourceKinds(q.source) ? { advertiserKinds: sourceKinds(q.source) } : {}),
        ...(placement ? { placementId: placement.id } : {}),
        ...(q.status ? { statuses: q.status.split(',').map((s) => s.trim()).filter(Boolean) } : {}),
        ...(q.linkedPromotionId ? { linkedPromotionId: q.linkedPromotionId } : {}),
      },
      page,
    );
    return { ...res, items: await this.parts.views.summaries(res.items) };
  }

  async view(id: string, o: { sellerId?: string } = {}): Promise<AdCampaign> {
    if (!isUuid(id)) throw notFound('Campaign');
    return this.parts.views.campaign(await this.parts.views.model(id, o));
  }

  async check(id: string): Promise<CampaignCheckResult> {
    if (!isUuid(id)) throw notFound('Campaign');
    const m = await this.parts.views.model(id);
    const r = await this.checksFor(m);
    return { checks: r.checks, conflicts: r.conflicts, estimatedWeeklyReach: r.reach, canSubmit: !r.failed && m.row.status === 'draft' };
  }

  async preview(id: string, theme: 'light' | 'dark' = 'light', o: { sellerId?: string } = {}): Promise<AdPreview> {
    if (!isUuid(id)) throw notFound('Campaign');
    const m = await this.parts.views.model(id, o);
    return this.parts.serving.preview(m, theme);
  }

  /* ================================================================ checks */

  /** Blocked pages, overlaps, labels, claims vs promotion, availability, links, reach estimate */
  async checksFor(m: Model): Promise<{ checks: ReviewCheck[]; conflicts: Conflict[]; failed: boolean; reach: number | null }> {
    const r = m.row;
    const rules = await this.core.rules();
    const now = this.now();
    const tz = r.time_zone || this.core.tz();
    const checks: ReviewCheck[] = [];
    const add = (state: ReviewCheck['state'], label: string, detail: string | null = null) => checks.push({ state, label, detail });
    const eligible = (m.placement.eligible_pages ?? []) as string[];

    // pages
    const blocked = m.pages.filter((p) => rules.blockedPages.includes(p));
    const notEligible = m.pages.filter((p) => !eligible.includes(p));
    if (!m.pages.length) add('fail', 'Pages', 'Choose at least one page');
    else if (blocked.length) add('fail', 'Blocked pages', `Ads never cover ${blocked.join(', ')}`);
    else if (notEligible.length) add('fail', 'Pages', `${m.placement.name} can't show on ${notEligible.join(', ')}`);
    else add('ok', 'Blocked pages', 'Not on checkout, payment results, order tracking or returns');
    if (!m.placement.enabled) add('fail', 'Placement', `${m.placement.name} is turned off`);

    // label and close control
    add(rules.labelRequired ? 'ok' : 'info', 'Ad label', `"${m.placement.label}" label shown on every display`);
    if (OVERLAY_KEYS.includes(m.placement.key)) add(m.dismissal.mode === 'not_dismissible' ? 'fail' : 'ok', 'Close control', m.dismissal.mode === 'not_dismissible' ? 'Overlays must have a visible close control' : `Visible close control, at least ${rules.closeControlMinPx} px`);

    // schedule
    if (!r.starts_at || !r.ends_at || r.ends_at.getTime() <= r.starts_at.getTime()) add('fail', 'Schedule', 'The end must be after the start');
    else if (r.ends_at.getTime() <= now.getTime()) add('fail', 'Schedule', 'The campaign ends in the past');
    else add('ok', 'Schedule', `${shortDate(r.starts_at, tz)} – ${shortDate(r.ends_at, tz)} (${tz})`);

    // budget
    if (isPaid(r.advertiser_kind, r.billing)) {
      if (r.rate === null || r.daily_limit === null || r.total_limit === null) add('fail', 'Spending limits', 'Paid campaigns need a rate, a daily and a total limit');
      else add('ok', 'Spending limits', 'Daily and total limits set; unused budget is never charged');
    }

    // creatives
    const creatives = await this.repo.getMany(
      'creatives',
      m.creatives.map((c) => c.creative_id),
    );
    const usable = creatives.filter((c) => c.status !== 'rejected');
    if (!creatives.length && m.placement.key !== 'sponsored_product') add('fail', 'Creatives', 'Add at least one creative');
    else if (creatives.length) {
      const missing = missingDevices((m.placement.formats ?? []) as never, usable.map((c) => c.device));
      if (missing.length) add('fail', 'Creatives', `Missing ${missing.join(' and ')} creative`);
      else add('ok', 'Creatives', `${creatives.length} creative${creatives.length === 1 ? '' : 's'} for ${m.placement.name}`);
      const rejected = creatives.filter((c) => c.status === 'rejected');
      if (rejected.length) add('fail', 'Creative review', `${rejected.length} creative${rejected.length === 1 ? ' was' : 's were'} rejected; replace ${rejected.length === 1 ? 'it' : 'them'}`);
      const wrong = creatives.filter((c) => c.placement_key !== m.placement.key);
      if (wrong.length) add('fail', 'Creative format', `${wrong.length} creative${wrong.length === 1 ? ' is' : 's are'} made for another placement`);
      if (creatives.some((c) => c.kind === 'video') && m.placement.key !== 'video') add('warn', 'Video', 'Video is stored but not served until a video placement is on');
    }

    // links
    const dest = linkState(m.destination?.url);
    if (dest.state === 'fail') add('fail', 'Destination link', dest.detail);
    else add(dest.state === 'info' ? 'fail' : dest.state, 'Destination link', dest.state === 'info' ? 'Add a destination' : dest.detail);
    const broken = creatives.filter((c) => (c.link_check as { state?: string } | null)?.state === 'fail');
    if (broken.length) add('fail', 'Creative links', `Broken link on ${broken.length} creative${broken.length === 1 ? '' : 's'}`);

    // promoted offers
    const offerIds = m.items.filter((i) => i.kind === 'offer').map((i) => i.target_id);
    if (offerIds.length) {
      const info = await this.core.offerInfo(offerIds);
      if (!info) add('info', 'Promoted offers', 'Availability not checked (offers unavailable)');
      else {
        const bad = offerIds.filter((id) => !info.get(id)?.promotable);
        if (bad.length) add('fail', 'Promoted offers', bad.map((id) => `${info.get(id)?.title ?? 'Offer'}: ${info.get(id)?.reason ?? 'not found'}`).join('; '));
        else add('ok', 'Promoted offers', `${offerIds.length} offer${offerIds.length === 1 ? '' : 's'} active and in stock`);
      }
    }

    // linked promotion and claims
    const claims = creatives.some((c) => hasDiscountClaim(c.headline) || hasDiscountClaim(c.body));
    if (r.linked_promotion_id) {
      const state = await this.core.optional('promotions', (p) => p.isCampaignActive(r.linked_promotion_id!));
      const promo = await this.parts.views.linkedPromotion(r);
      if (!state) add('info', 'Linked promotion', 'Not checked (promotions unavailable)');
      else if (state.active) add('ok', 'Linked promotion', `${promo?.name ?? 'Promotion'} is running`);
      else if (state.reason === 'not_started' || state.reason === 'not_published') add('info', 'Linked promotion', promo ? `${promo.name} starts ${shortDate(new Date(promo.startsAt), tz)}` : 'Not started yet');
      else if (state.reason === 'paused') add('warn', 'Linked promotion', 'The promotion is paused; the ad pauses with it');
      else add('fail', 'Linked promotion', `The promotion is not running (${(state.reason ?? 'ended').replace(/_/g, ' ')})`);
      add('info', 'Claims vs promotion', claims ? `Discount claims are checked against ${promo?.name ?? 'the promotion'} by the Content reviewer` : 'No discount claims in the creatives');
    } else if (claims) add('warn', 'Claims vs promotion', 'A creative claims a discount but no promotion is linked');
    add('info', 'Contrast', 'Check text contrast on both themes in the preview');

    const conflicts = await this.conflicts(m);
    const reachBase = await this.repo.reach(m.placement.key, new Date(now.getTime() - 7 * 86_400_000));
    const reach = reachBase ? Math.round(reachBase * (m.audience?.mode === 'selected' ? 0.4 : 1)) : null;
    return { checks, conflicts, failed: checks.some((c) => c.state === 'fail'), reach };
  }

  /** Other open campaigns on the same placement with overlapping dates and pages */
  async conflicts(m: Model): Promise<Conflict[]> {
    const r = m.row;
    if (!r.starts_at || !r.ends_at) return [];
    const others = await this.repo.find('campaigns', { placement_id: r.placement_id, status: OPEN_STATES as string[], id: { op: '<>', value: r.id } }, { limit: 200 });
    const overlay = OVERLAY_KEYS.includes(m.placement.key);
    const out: Conflict[] = [];
    for (const o of others) {
      if (!o.starts_at || !o.ends_at) continue;
      if (o.starts_at.getTime() >= r.ends_at.getTime() || o.ends_at.getTime() <= r.starts_at.getTime()) continue;
      const pages = ((o.pages ?? []) as string[]).filter((p) => m.pages.includes(p));
      if (!pages.length) continue;
      const order = o.priority === r.priority ? 'equal priority rotates evenly' : o.priority > r.priority ? `${o.name} has higher priority and shows first` : 'this campaign has higher priority and shows first';
      out.push({
        campaignId: o.id,
        name: o.name,
        from: new Date(Math.max(o.starts_at.getTime(), r.starts_at.getTime())).toISOString(),
        to: new Date(Math.min(o.ends_at.getTime(), r.ends_at.getTime())).toISOString(),
        pages,
        resolution: overlay ? `Only one overlay shows at a time; ${order}` : `Both rotate in this position; ${order}`,
      });
    }
    return out;
  }

  /* ================================================================ create and edit */

  /** Validates an AdCampaignInput (staff) into row values */
  async values(input: AdCampaignInput, o: { origin: 'staff' | 'seller_request'; sellerId?: string; keepPlacementOff?: boolean } = { origin: 'staff' }): Promise<CampaignValues> {
    const issues: Issue[] = [];
    const rules = await this.core.rules();
    const placement = await this.core.placementByKey(input.placementKey);
    if (!placement) throw invalid([{ path: 'placementKey', message: `Unknown placement ${input.placementKey}` }]);
    if (!placement.enabled && !o.keepPlacementOff) throw this.ctx.error('PLACEMENT_DISABLED', `${placement.name} is turned off${placement.availability === 'later' ? ' (later phase)' : ''}.`);

    // pages
    const eligible = (placement.eligible_pages ?? []) as string[];
    const pages = [...new Set(input.pages ?? [])];
    const badPages = pages.filter((p) => !isPageType(p) || rules.blockedPages.includes(p) || !eligible.includes(p));
    if (!pages.length) issues.push({ path: 'pages', message: 'Choose at least one page' });
    if (badPages.length) {
      throw this.ctx.error('PAGE_NOT_ELIGIBLE', `${placement.name} can't show on ${badPages.join(', ')}.`, {
        issues: badPages.map((p) => ({ path: 'pages', message: rules.blockedPages.includes(p) ? `${p} is blocked for all ads` : `${p} is not an eligible page for ${placement.name}` })),
        eligiblePages: eligible.filter((p) => !rules.blockedPages.includes(p)),
      });
    }

    // advertiser
    const adv = input.advertiser;
    if (adv.kind === 'seller' && !isUuid(adv.sellerId)) issues.push({ path: 'advertiser.sellerId', message: 'Choose the seller' });
    if (adv.kind === 'brand' && !isUuid(adv.brandId)) issues.push({ path: 'advertiser.brandId', message: 'Choose the brand' });
    if (o.sellerId && (adv.kind !== 'seller' || adv.sellerId !== o.sellerId)) issues.push({ path: 'advertiser', message: 'Sellers advertise their own store only' });

    // schedule
    const startsAt = toDate(input.startsAt);
    const endsAt = toDate(input.endsAt);
    if (!validDate(startsAt)) issues.push({ path: 'startsAt', message: 'Start date is not valid' });
    if (!validDate(endsAt)) issues.push({ path: 'endsAt', message: 'End date is not valid' });
    else if (validDate(startsAt) && endsAt!.getTime() <= startsAt!.getTime()) issues.push({ path: 'endsAt', message: 'The end must be after the start' });
    else if (endsAt!.getTime() <= this.now().getTime()) issues.push({ path: 'endsAt', message: 'The end is in the past' });
    const timeZone = input.timeZone?.trim() || this.core.tz();
    if (!validZone(timeZone)) issues.push({ path: 'timeZone', message: 'Unknown time zone' });
    if (!Number.isInteger(input.priority) || input.priority < 1 || input.priority > 3) issues.push({ path: 'priority', message: 'Priority is 1 (low), 2 (normal) or 3 (high)' });
    if (!input.name?.trim()) issues.push({ path: 'name', message: 'Name the campaign' });
    else if (input.name.trim().length > 120) issues.push({ path: 'name', message: '120 characters at most' });

    // frequency and dismissal
    const capIn = input.frequencyCap ?? ((placement.frequency_cap ?? null) as FrequencyCap | null);
    const cap: FrequencyCap = capIn ? { ...capIn, label: capIn.label?.trim() || frequencyLabel(capIn) } : { label: 'No cap' };
    for (const [k, v] of [['perSession', cap.perSession], ['perDay', cap.perDay], ['perCampaign', cap.perCampaign]] as const) if (v !== undefined && v !== null && (!Number.isInteger(v) || v < 1)) issues.push({ path: `frequencyCap.${k}`, message: 'Whole number, 1 or more' });
    if (cap.perWindow && (!Number.isInteger(cap.perWindow.count) || cap.perWindow.count < 1 || !Number.isInteger(cap.perWindow.days) || cap.perWindow.days < 1 || cap.perWindow.days > 30)) issues.push({ path: 'frequencyCap.perWindow', message: 'A count of 1 or more within 1 to 30 days' });
    const dIn = input.dismissal ?? (placement.dismissal as unknown as DismissalRule);
    const dismissal: DismissalRule = { ...dIn, label: dIn.label?.trim() || dismissalLabel(dIn) };
    if (dismissal.mode === 'days' && (!Number.isInteger(dismissal.days) || (dismissal.days ?? 0) < 1)) issues.push({ path: 'dismissal.days', message: 'How many days a dismissal hides the campaign' });
    if (OVERLAY_KEYS.includes(placement.key) && dismissal.mode === 'not_dismissible') issues.push({ path: 'dismissal.mode', message: 'Overlays always have a visible close control' });

    // budget: own promotions have no charge; paid ads need a rate and limits
    const own = advertiserIsOwn(adv.kind);
    const b = input.budget ?? null;
    const billing = own ? 'none' : (b?.billing ?? 'none');
    const cur = this.core.currency();
    const amount = (m: common.Money | null | undefined, path: string) => {
      if (!m) return null;
      if (m.currency !== cur) issues.push({ path, message: `Amounts are in ${cur}` });
      if (!Number.isSafeInteger(m.amount) || m.amount < 0) issues.push({ path, message: 'Whole minor units, zero or more' });
      return m.amount;
    };
    const rate = billing === 'none' ? null : amount(b?.rate, 'budget.rate');
    const dailyLimit = billing === 'none' ? null : amount(b?.dailyLimit, 'budget.dailyLimit');
    const totalLimit = billing === 'none' ? null : amount(b?.totalLimit, 'budget.totalLimit');
    if (billing !== 'none') {
      if (!rate) issues.push({ path: 'budget.rate', message: 'Set the rate' });
      if (!dailyLimit) issues.push({ path: 'budget.dailyLimit', message: 'Set a daily spending limit' });
      if (!totalLimit) issues.push({ path: 'budget.totalLimit', message: 'Set a total spending limit' });
      if (dailyLimit && totalLimit && dailyLimit > totalLimit) issues.push({ path: 'budget.dailyLimit', message: 'The daily limit cannot be above the total limit' });
    }
    const deliveryCap = b?.deliveryCap ?? null;
    if (deliveryCap !== null && (!Number.isInteger(deliveryCap) || deliveryCap < 1)) issues.push({ path: 'budget.deliveryCap', message: 'Whole number of displays, 1 or more' });

    // destination
    const dest = input.destination;
    if (linkState(dest?.url).state === 'fail') issues.push({ path: 'destination.url', message: linkState(dest?.url).detail });

    // linked promotion
    if (input.linkedPromotionId) {
      const promo = await this.core.optional('promotions', (p) => p.getPublicCampaign(input.linkedPromotionId!));
      if (promo === null) issues.push({ path: 'linkedPromotionId', message: 'Promotion not found' });
    }
    if (input.stopWithPromotion && !input.linkedPromotionId) issues.push({ path: 'stopWithPromotion', message: 'Link a promotion first' });

    // creatives
    const creativeIds = [...new Set(input.creativeIds ?? [])];
    const creatives = creativeIds.length ? await this.repo.getMany('creatives', creativeIds.filter(isUuid)) : [];
    for (const id of creativeIds) {
      const c = creatives.find((x) => x.id === id);
      if (!c || (o.sellerId && c.seller_id !== o.sellerId)) issues.push({ path: 'creativeIds', message: `Creative ${id} not found` });
      else if (c.placement_key !== placement.key) issues.push({ path: 'creativeIds', message: `Creative ${id} is made for another placement` });
      else if (c.status === 'rejected') issues.push({ path: 'creativeIds', message: `Creative ${id} was rejected` });
      else if (!o.sellerId && adv.kind === 'seller' && c.seller_id && c.seller_id !== adv.sellerId) issues.push({ path: 'creativeIds', message: `Creative ${id} belongs to another seller` });
    }

    // promoted items (offers also index their product)
    const promoted: PromotedItem[] = input.promoted ?? [];
    const items: Omit<ItemRec, 'campaign_id'>[] = [];
    const offerIds = promoted.filter((p) => p.kind === 'offer').map((p) => p.id);
    const info = offerIds.length ? await this.core.offerInfo(offerIds) : new Map();
    for (const p of promoted) {
      if (!isUuid(p.id)) {
        issues.push({ path: 'promoted', message: `${p.id} is not an id` });
        continue;
      }
      const oi = p.kind === 'offer' ? info?.get(p.id) : undefined;
      if (p.kind === 'offer' && info && !oi) issues.push({ path: 'promoted', message: `Offer ${p.id} not found` });
      if (p.kind === 'offer' && oi && adv.kind === 'seller' && oi.offer.sellerId !== adv.sellerId) issues.push({ path: 'promoted', message: 'Sellers can only promote their own offers' });
      items.push({ kind: p.kind, target_id: p.id, label: p.label ?? oi?.title ?? null });
      if (oi) items.push({ kind: OFFER_PRODUCT, target_id: oi.productId, label: p.id });
    }
    if (issues.length) throw invalid(issues);

    return {
      placement,
      items,
      creatives: creatives.map((c) => ({ creative_id: c.id, device: c.device })),
      row: {
        name: input.name.trim(),
        origin: o.origin,
        advertiser_kind: adv.kind,
        seller_id: adv.kind === 'seller' ? (adv.sellerId ?? null) : null,
        brand_id: adv.kind === 'brand' ? (adv.brandId ?? null) : null,
        goal: input.goal,
        owner_staff_id: input.ownerStaffId ?? null,
        linked_promotion_id: input.linkedPromotionId ?? null,
        placement_id: placement.id,
        pages: pages as never,
        page_category_ids: (input.pageCategoryIds ?? []) as never,
        audience: { ...input.audience, regions: input.audience?.regions ?? [], categoryIds: input.audience?.categoryIds ?? [] } as never,
        destination: dest as never,
        starts_at: startsAt,
        ends_at: endsAt,
        time_zone: timeZone,
        frequency_cap: cap as never,
        dismissal: dismissal as never,
        priority: input.priority,
        billing,
        rate,
        daily_limit: dailyLimit,
        total_limit: totalLimit,
        delivery_cap: deliveryCap,
        currency: cur,
        stop_with_promotion: Boolean(input.stopWithPromotion && input.linkedPromotionId),
        after_approval: input.afterApproval ?? 'schedule',
        note_to_reviewers: input.noteToReviewers ?? null,
      },
    };
  }

  /** Inserts a campaign draft with its items and creatives */
  async insertDraft(v: CampaignValues, by: By, logAction = 'create', reason: string | null = null): Promise<CampaignRec> {
    const ref = await this.ctx.refs.next('AD', { digits: 4 });
    const now = this.now();
    const id = newId();
    const row = await this.repo.transaction(async (tx) => {
      const r = await tx.insert('campaigns', {
        ...v.row,
        id,
        ref,
        status: adCampaignMachine.initial,
        spent: 0,
        paused_reason: null,
        finished_reason: null,
        created_by: encodeActor(by.actor),
        created_at: now,
        updated_at: now,
        version: 1,
      });
      await this.writeLinks(tx, id, v);
      await this.core.log(tx, id, logAction, by, { to: 'draft', reason });
      return r;
    });
    return row;
  }

  private async writeLinks(tx: AdvertisingRepository, id: string, v: Pick<CampaignValues, 'items' | 'creatives'>) {
    await tx.removeWhere('campaign_items', { campaign_id: id });
    await tx.removeWhere('campaign_creatives', { campaign_id: id });
    for (const it of v.items) await tx.insert('campaign_items', { ...it, campaign_id: id });
    for (const c of v.creatives) await tx.insertIgnore('campaign_creatives', { campaign_id: id, creative_id: c.creative_id, device: c.device });
  }

  async create(input: AdCampaignInput, by: By): Promise<AdCampaign> {
    const v = await this.values(input, { origin: 'staff' });
    const row = await this.insertDraft(v, by);
    const view = await this.view(row.id);
    await this.core.audit({ action: 'advertising.campaign.create', actionLabel: `Created ad campaign ${row.ref}`, target: this.target(row), after: { name: row.name, placement: v.placement.key, pages: v.row.pages, startsAt: input.startsAt, endsAt: input.endsAt } }, by);
    return view;
  }

  /**
   * Edit a draft (an approved campaign returns to draft). Scheduled, live and paused campaigns accept only an
   * end-date change; other edits need a renewed copy.
   */
  async update(id: string, body: { changes: AdCampaignInput; version: number }, by: By): Promise<AdCampaign> {
    if (!isUuid(id)) throw notFound('Campaign');
    const m = await this.parts.views.model(id);
    const r = m.row;
    if (r.version !== body.version) throw new AppError('CONFLICT', 'The campaign changed since you opened it; reload and try again', { version: r.version });
    if (LIVE_STATES.includes(r.status)) return this.changeEnd(m, body.changes, by);
    if (r.status !== 'draft' && r.status !== 'approved') throw new AppError('ILLEGAL_TRANSITION', `A campaign that is ${r.status.replace('_', ' ')} can't be edited`, { from: r.status, event: 'edit' });
    const v = await this.values(body.changes, { origin: r.origin });
    const before = r;
    const after = await this.repo.transaction(async (tx) => {
      const locked = await tx.get('campaigns', id, { forUpdate: true });
      if (!locked) throw notFound('Campaign');
      if (locked.version !== body.version) throw new AppError('CONFLICT', 'The campaign changed since you opened it; reload and try again', { version: locked.version });
      const status = locked.status === 'approved' ? adCampaignMachine.next('approved', 'edit') : locked.status;
      const updated = await tx.update('campaigns', id, { ...v.row, origin: locked.origin, status, updated_at: this.now(), version: locked.version + 1 });
      await this.writeLinks(tx, id, v);
      await this.core.log(tx, id, 'edit', by, { from: locked.status, to: status, reason: locked.status === 'approved' ? 'Edited after approval; back to draft' : null });
      return updated;
    });
    if (before.status !== after.status) this.statusChanged(after, before.status, 'Edited after approval', by);
    await this.core.audit({ action: 'advertising.campaign.update', actionLabel: `Edited ad campaign ${r.ref}`, target: this.target(r), before: { status: before.status, name: before.name, pages: before.pages, startsAt: before.starts_at, endsAt: before.ends_at }, after: { status: after.status, name: after.name, pages: after.pages, startsAt: after.starts_at, endsAt: after.ends_at } }, by);
    return this.view(id);
  }

  /** Running campaigns: only the end date may change */
  private async changeEnd(m: Model, changes: AdCampaignInput, by: By): Promise<AdCampaign> {
    const r = m.row;
    const changed = this.changedFields(m, changes).filter((f) => f !== 'endsAt');
    if (changed.length) throw new AppError('ILLEGAL_TRANSITION', `A ${r.status} campaign accepts only pause, resume, finish and end-date changes; renew it to change ${changed.join(', ')}`, { from: r.status, event: 'edit', fields: changed });
    const endsAt = toDate(changes.endsAt);
    if (!validDate(endsAt)) throw invalid([{ path: 'changes.endsAt', message: 'End date is not valid' }]);
    if (endsAt!.getTime() <= this.now().getTime() || (r.starts_at && endsAt!.getTime() <= r.starts_at.getTime())) throw invalid([{ path: 'changes.endsAt', message: 'The new end must be after the start and in the future' }]);
    if (endsAt!.getTime() === r.ends_at?.getTime()) return this.view(r.id);
    await this.repo.transaction(async (tx) => {
      const locked = await tx.get('campaigns', r.id, { forUpdate: true });
      if (!locked) throw notFound('Campaign');
      await tx.update('campaigns', r.id, { ends_at: endsAt, updated_at: this.now(), version: locked.version + 1 });
      await this.core.log(tx, r.id, 'edit', by, { reason: `End date changed to ${endsAt!.toISOString()}` });
    });
    this.parts.serving.invalidate();
    await this.core.audit({ action: 'advertising.campaign.update', actionLabel: `Changed the end date of ${r.ref}`, target: this.target(r), before: { endsAt: r.ends_at }, after: { endsAt } }, by);
    return this.view(r.id);
  }

  /** Fields of an input that differ from the campaign (dates by instant, lists as sets) */
  changedFields(m: Model, c: AdCampaignInput): string[] {
    const r = m.row;
    const set = (xs: readonly string[] | null | undefined) => JSON.stringify([...new Set(xs ?? [])].sort());
    const time = (s: string | null | undefined) => (s ? new Date(s).getTime() : null);
    const strip = (x: unknown) => (x && typeof x === 'object' ? JSON.stringify(Object.fromEntries(Object.entries(x as object).filter(([k, v]) => k !== 'label' && k !== 'estimatedWeeklyReach' && v !== null && v !== undefined).sort())) : JSON.stringify(x ?? null));
    const out: string[] = [];
    if (c.name.trim() !== r.name) out.push('name');
    if (c.placementKey !== m.placement.key) out.push('placementKey');
    if (set(c.pages) !== set(m.pages)) out.push('pages');
    if (time(c.startsAt) !== (r.starts_at?.getTime() ?? null)) out.push('startsAt');
    if (time(c.endsAt) !== (r.ends_at?.getTime() ?? null)) out.push('endsAt');
    if (c.priority !== r.priority) out.push('priority');
    if (set(c.creativeIds) !== set(m.creatives.map((x) => x.creative_id))) out.push('creativeIds');
    if ((c.destination?.url ?? '') !== (m.destination?.url ?? '')) out.push('destination');
    if ((c.linkedPromotionId ?? null) !== r.linked_promotion_id) out.push('linkedPromotionId');
    if (c.advertiser.kind !== r.advertiser_kind || (c.advertiser.sellerId ?? null) !== (r.advertiser_kind === 'seller' ? r.seller_id : null)) out.push('advertiser');
    if (c.audience && strip(c.audience) !== strip(m.audience)) out.push('audience');
    if (c.frequencyCap && strip(c.frequencyCap) !== strip(m.cap)) out.push('frequencyCap');
    if (c.budget && ((c.budget.dailyLimit?.amount ?? null) !== r.daily_limit || (c.budget.totalLimit?.amount ?? null) !== r.total_limit || (c.budget.rate?.amount ?? null) !== r.rate)) out.push('budget');
    return out;
  }

  /* ================================================================ lifecycle */

  target(r: Pick<CampaignRec, 'id' | 'ref' | 'name'>) {
    return { type: 'ad_campaign', id: r.id, ref: r.ref, label: r.name, screen: 'admin/ad-campaign' };
  }

  statusChanged(r: CampaignRec, from: string, reason: string | null, by: By) {
    this.core.publish('advertising.campaign.status_changed', { campaignId: r.id, from, to: r.status, reason: reason ?? null, advertiserKind: r.advertiser_kind, sellerId: r.seller_id, linkedPromotionId: r.linked_promotion_id }, by);
    this.parts.serving.invalidate();
  }

  /** One lifecycle step: lock, check the machine, update, log; event after the commit */
  async transition(id: string, event: string, by: By, o: TransitionOptions = {}): Promise<{ before: CampaignRec; after: CampaignRec }> {
    if (!isUuid(id)) throw notFound('Campaign');
    const res = await this.repo.transaction(async (tx) => {
      const before = await tx.get('campaigns', id, { forUpdate: true });
      if (!before || (o.sellerId !== undefined && before.seller_id !== o.sellerId)) throw notFound('Campaign');
      o.guard?.(before);
      const to = adCampaignMachine.next(before.status as Status, event as never, o.to as never) as Status;
      const after = await tx.update('campaigns', id, { ...o.patch, status: to, updated_at: this.now(), version: before.version + 1 });
      await this.core.log(tx, id, o.logAction ?? event, by, { from: before.status, to, reason: o.reason ?? null });
      return { before, after };
    });
    this.statusChanged(res.after, res.before.status, o.reason ?? null, by);
    return res;
  }

  async submit(id: string, note: string | null | undefined, by: By, o: { sellerId?: string } = {}): Promise<CampaignRec> {
    if (!isUuid(id)) throw notFound('Campaign');
    const m = await this.parts.views.model(id, o);
    if (!adCampaignMachine.can(m.row.status as Status, 'submit')) adCampaignMachine.next(m.row.status as Status, 'submit');
    const result = await this.checksFor(m);
    const failed = result.checks.filter((c) => c.state === 'fail');
    if (failed.length) throw this.ctx.error('CHECKS_FAILED', `Fix ${failed.length} check${failed.length === 1 ? '' : 's'} before submitting: ${failed.map((c) => c.label).join(', ')}.`, { checks: result.checks });
    if (m.row.after_approval === 'activate') {
      const a = this.parts.views.activateInfo(m.row, await this.parts.views.linkedPromotion(m.row));
      if (!a.allowed) throw this.ctx.error('PROMOTION_NOT_STARTED', `${a.reason}. Choose "Schedule for the start time" instead.`);
    }
    const roles = requiredSteps(m.row.advertiser_kind);
    const { after } = await this.transition(id, 'submit', by, {
      ...o,
      reason: note ?? null,
      patch: { note_to_reviewers: note ?? m.row.note_to_reviewers },
      guard: (row) => {
        if (row.version !== m.row.version) throw new AppError('CONFLICT', 'The campaign changed while it was being submitted');
      },
    });
    const submission = Math.max(0, ...(await this.repo.find('approval_steps', { campaign_id: id })).map((s) => s.submission)) + 1;
    await this.repo.transaction(async (tx) => {
      for (const role of roles) await tx.insert('approval_steps', { id: newId(), campaign_id: id, submission, role, reviewer_id: null, state: 'waiting', note: null, decided_at: null });
      for (const c of m.creatives) await tx.updateWhere('creatives', { id: c.creative_id, status: ['draft', 'changes_requested'] }, { status: 'in_review' });
    });
    return after;
  }

  /** One review step; the campaign is approved when all are, then the afterApproval choice applies */
  /** The caller's review step on this campaign, from their access roles (body.role only picks among them) */
  private async campaignRole(row: CampaignRec, requested: ReviewRole | null | undefined, by: By): Promise<ReviewRole> {
    const steps = await this.repo.find('approval_steps', { campaign_id: row.id }, { orderBy: [['submission', 'desc']] });
    const latest = steps[0]?.submission ?? 0;
    const current = steps.filter((s) => s.submission === latest);
    const stepOf = (r: ReviewRole) => {
      const slot = stepFor(r, row.advertiser_kind);
      return slot ? current.find((s) => (slot === 'advertising' ? s.role === 'advertising' : s.role === 'content' || s.role === 'marketing')) : undefined;
    };
    return this.core.reviewRoleFor(by, requested, { applicable: (r) => stepFor(r, row.advertiser_kind) !== null, waiting: (r) => stepOf(r)?.state === 'waiting' });
  }

  async approve(id: string, input: { role?: ReviewRole | null; note?: string | null }, by: By): Promise<AdCampaign> {
    if (!isUuid(id)) throw notFound('Campaign');
    const row = await this.repo.get('campaigns', id);
    if (!row) throw notFound('Campaign');
    const body = { ...input, role: await this.campaignRole(row, input.role, by) };
    const slot = stepFor(body.role, row.advertiser_kind);
    if (!slot) throw invalid([{ path: 'role', message: 'Marketing reviews own promotions; seller and brand ads need Content' }], 'This role cannot approve this campaign');
    const reviewer = encodeActor(by.actor);
    const done = await this.repo.transaction(async (tx) => {
      const locked = await tx.get('campaigns', id, { forUpdate: true });
      if (!locked) throw notFound('Campaign');
      if (locked.status !== 'in_review') adCampaignMachine.next(locked.status as Status, 'approve');
      const steps = await tx.find('approval_steps', { campaign_id: id }, { orderBy: [['submission', 'desc']] });
      const latest = steps[0]?.submission ?? 0;
      const current = steps.filter((s) => s.submission === latest);
      const step = current.find((s) => (slot === 'advertising' ? s.role === 'advertising' : s.role === 'content' || s.role === 'marketing'));
      if (!step) throw new AppError('ILLEGAL_TRANSITION', 'No review step for this role', { from: locked.status, event: 'approve' });
      if (step.state === 'approved') throw new AppError('ILLEGAL_TRANSITION', `The ${step.role} step is already approved`, { from: locked.status, event: 'approve' });
      if (current.some((s) => s.id !== step.id && s.state === 'approved' && s.reviewer_id === reviewer)) throw this.ctx.error('SAME_REVIEWER', 'You already approved another step of this campaign; a second person must approve this one.');
      await tx.update('approval_steps', step.id, { state: 'approved', reviewer_id: reviewer, note: body.note ?? null, decided_at: this.now(), role: body.role === 'marketing' ? 'marketing' : step.role });
      const all = current.every((s) => s.id === step.id || s.state === 'approved');
      if (!all) {
        await this.core.log(tx, id, 'approve_step', by, { reason: `${body.role} approved${body.note ? `: ${body.note}` : ''}` });
        return { approved: false, before: locked, after: locked };
      }
      const after = await tx.update('campaigns', id, { status: adCampaignMachine.next('in_review', 'approve'), updated_at: this.now(), version: locked.version + 1 });
      await this.core.log(tx, id, 'approve', by, { from: 'in_review', to: 'approved', reason: body.note ?? null });
      const links = await tx.find('campaign_creatives', { campaign_id: id });
      await tx.updateWhere('creatives', { id: links.map((l) => l.creative_id), status: 'in_review' }, { status: 'approved' });
      return { approved: true, before: locked, after };
    });
    await this.core.audit({ action: 'advertising.campaign.approve', actionLabel: done.approved ? `Approved ad campaign ${row.ref}` : `Approved the ${body.role} step of ${row.ref}`, target: this.target(row), reason: body.note ?? null, after: { role: body.role, status: done.after.status } }, by);
    if (done.approved) {
      this.statusChanged(done.after, 'in_review', body.note ?? null, by);
      await this.applyAfterApproval(done.after);
    }
    return this.view(id);
  }

  /** The submitter's choice, applied by the system: schedule, or activate while still allowed (else schedule, noted) */
  private async applyAfterApproval(r: CampaignRec) {
    const sys: By = { actor: SYSTEM };
    if (r.after_approval === 'activate') {
      const a = this.parts.views.activateInfo(r, await this.parts.views.linkedPromotion(r));
      if (a.allowed) {
        await this.transition(r.id, 'activate', sys, { reason: 'Activated as chosen before approval' });
        return;
      }
      await this.transition(r.id, 'schedule', sys, { reason: `Scheduled instead of activated: ${a.reason}`, logAction: 'after_approval_fallback' });
      return;
    }
    await this.transition(r.id, 'schedule', sys, { reason: 'Scheduled as chosen before approval' });
    if (r.starts_at && r.starts_at.getTime() <= this.now().getTime()) await this.parts.ops.startDue([r.id]);
  }

  async requestChanges(id: string, input: { role?: ReviewRole | null; reason: string }, by: By): Promise<AdCampaign> {
    const reason = input.reason?.trim();
    if (!reason) throw invalid([{ path: 'reason', message: 'Say what needs to change' }]);
    if (!isUuid(id)) throw notFound('Campaign');
    const row = await this.repo.get('campaigns', id);
    if (!row) throw notFound('Campaign');
    const body = { ...input, role: await this.campaignRole(row, input.role, by) };
    const { before } = await this.transition(id, 'requestChanges', by, { reason });
    await this.markSteps(id, body.role, 'changes_requested', reason, by);
    await this.core.audit({ action: 'advertising.campaign.request-changes', actionLabel: `Requested changes to ${before.ref}`, target: this.target(before), reason, after: { role: body.role } }, by);
    return this.view(id);
  }

  async reject(id: string, reason: string, by: By, o: { audit?: boolean } = {}): Promise<CampaignRec> {
    const text = reason?.trim();
    if (!text) throw invalid([{ path: 'reason', message: 'Give a reason' }]);
    const { before, after } = await this.transition(id, 'reject', by, { reason: text, patch: { paused_reason: text } });
    await this.markSteps(id, null, 'rejected', text, by);
    if (o.audit !== false) await this.core.audit({ action: 'advertising.campaign.reject', actionLabel: `Rejected ${before.ref}`, target: this.target(before), reason: text }, by);
    return after;
  }

  private async markSteps(id: string, role: ReviewRole | null, state: string, note: string, by: By) {
    const steps = await this.repo.find('approval_steps', { campaign_id: id }, { orderBy: [['submission', 'desc']] });
    const latest = steps[0]?.submission;
    const slotOf = (r: string) => (r === 'advertising' ? 'advertising' : 'content');
    for (const s of steps.filter((x) => x.submission === latest && x.state === 'waiting')) {
      if (role && slotOf(role) !== slotOf(s.role)) continue;
      await this.repo.update('approval_steps', s.id, { state, note, reviewer_id: encodeActor(by.actor), decided_at: this.now() });
    }
  }

  async schedule(id: string, by: By): Promise<AdCampaign> {
    const { before } = await this.transition(id, 'schedule', by);
    await this.core.audit({ action: 'advertising.campaign.schedule', actionLabel: `Scheduled ${before.ref}`, target: this.target(before) }, by);
    if (before.starts_at && before.starts_at.getTime() <= this.now().getTime()) await this.parts.ops.startDue([id]);
    return this.view(id);
  }

  async activate(id: string, by: By): Promise<AdCampaign> {
    if (!isUuid(id)) throw notFound('Campaign');
    const row = await this.repo.get('campaigns', id);
    if (!row) throw notFound('Campaign');
    if (!adCampaignMachine.can(row.status as Status, 'activate')) adCampaignMachine.next(row.status as Status, 'activate');
    const a = this.parts.views.activateInfo(row, await this.parts.views.linkedPromotion(row));
    if (!a.allowed) throw this.ctx.error('PROMOTION_NOT_STARTED', `${a.reason}. Schedule it instead.`);
    const { before } = await this.transition(id, 'activate', by);
    await this.core.audit({ action: 'advertising.campaign.activate', actionLabel: `Activated ${before.ref}`, target: this.target(before) }, by);
    return this.view(id);
  }

  /** Staff or seller pause; automatic pauses use a cause (auto_pause:<cause>) so the matching event can resume them */
  async pause(id: string, reason: string | null, by: By, o: { sellerId?: string; cause?: string; audit?: boolean } = {}): Promise<CampaignRec> {
    const text = reason?.trim() || null;
    if (!o.cause && by.actor.kind === 'staff' && !text) throw invalid([{ path: 'reason', message: 'Give a reason' }]);
    const { before, after } = await this.transition(id, 'pause', by, { reason: text, patch: { paused_reason: text }, logAction: o.cause ? `auto_pause:${o.cause}` : 'pause', ...(o.sellerId ? { sellerId: o.sellerId } : {}) });
    if (o.audit) await this.core.audit({ action: 'advertising.campaign.pause', actionLabel: `Paused ${before.ref}`, target: this.target(before), reason: text }, by);
    return after;
  }

  /** Back to live, or to scheduled when the start is still ahead; promoted offers and the linked promotion must be available */
  async resume(id: string, reason: string | null, by: By, o: { sellerId?: string; logAction?: string; audit?: boolean; skipAvailability?: boolean } = {}): Promise<CampaignRec> {
    if (!isUuid(id)) throw notFound('Campaign');
    const row = await this.repo.get('campaigns', id);
    if (!row || (o.sellerId !== undefined && row.seller_id !== o.sellerId)) throw notFound('Campaign');
    if (row.status !== 'paused') adCampaignMachine.next(row.status as Status, 'resume', 'live');
    if (!o.skipAvailability) {
      const problem = await this.unavailability(row);
      if (problem) throw this.ctx.error('AD_UNAVAILABLE', problem);
    }
    const to: Status = row.starts_at && row.starts_at.getTime() > this.now().getTime() ? 'scheduled' : 'live';
    const { before, after } = await this.transition(id, 'resume', by, { to, reason: reason?.trim() || null, patch: { paused_reason: null }, logAction: o.logAction ?? 'resume', ...(o.sellerId ? { sellerId: o.sellerId } : {}) });
    if (o.audit) await this.core.audit({ action: 'advertising.campaign.resume', actionLabel: `Resumed ${before.ref}`, target: this.target(before), reason: reason ?? null }, by);
    return after;
  }

  /** Why the campaign can't run now (promoted offer unavailable, linked promotion inactive), or null */
  async unavailability(row: CampaignRec): Promise<string | null> {
    const items = await this.repo.find('campaign_items', { campaign_id: row.id, kind: 'offer' });
    if (items.length) {
      this.core.forgetOffers(items.map((i) => i.target_id));
      const info = await this.core.offerInfo(items.map((i) => i.target_id));
      const bad = info ? items.filter((i) => !info.get(i.target_id)?.promotable) : [];
      if (bad.length) return `Promoted offer unavailable: ${bad.map((i) => info?.get(i.target_id)?.reason ?? 'not found').join('; ')}`;
    }
    if (row.linked_promotion_id) {
      const s = await this.core.optional('promotions', (p) => p.isCampaignActive(row.linked_promotion_id!));
      if (s && !s.active && s.reason !== 'not_started') return `The linked promotion is not running (${(s.reason ?? 'inactive').replace(/_/g, ' ')})`;
    }
    return null;
  }

  async finish(id: string, finishedReason: NonNullable<AdCampaign['finishedReason']>, reason: string | null, by: By, o: { audit?: boolean } = {}): Promise<CampaignRec> {
    const { before, after } = await this.transition(id, 'finish', by, { reason: reason ?? null, patch: { finished_reason: finishedReason } });
    if (after.seller_id && after.billing !== 'none') await this.parts.billing.accrueCampaign(after.id).catch((err) => this.ctx.log.warn({ err, campaignId: id }, 'advertising: charges not accrued at finish'));
    if (o.audit) await this.core.audit({ action: 'advertising.campaign.finish', actionLabel: `Finished ${before.ref} early`, target: this.target(before), reason }, by);
    return after;
  }

  async archive(id: string, by: By): Promise<AdCampaign> {
    await this.transition(id, 'archive', by);
    return this.view(id);
  }

  /** A new draft copy with new dates (renew deliberately; not a transition) */
  async renew(id: string, body: { startsAt: string; endsAt: string }, by: By): Promise<AdCampaign> {
    if (!isUuid(id)) throw notFound('Campaign');
    const m = await this.parts.views.model(id);
    const r = m.row;
    if (!['finished', 'archived', 'scheduled', 'live', 'paused'].includes(r.status)) throw new AppError('ILLEGAL_TRANSITION', 'Only finished or running campaigns can be renewed', { from: r.status, event: 'renew' });
    const startsAt = toDate(body.startsAt);
    const endsAt = toDate(body.endsAt);
    if (!validDate(startsAt) || !validDate(endsAt) || endsAt!.getTime() <= startsAt!.getTime()) throw invalid([{ path: 'endsAt', message: 'The end must be after the start' }]);
    if (endsAt!.getTime() <= this.now().getTime()) throw invalid([{ path: 'endsAt', message: 'The end is in the past' }]);
    const { id: _id, ref: _ref, status: _s, spent: _sp, created_by: _cb, created_at: _ca, updated_at: _ua, version: _v, paused_reason: _pr, finished_reason: _fr, ...rest } = r;
    const row = await this.insertDraft({ placement: m.placement, items: m.items.map(({ campaign_id: _c, ...i }) => i), creatives: m.creatives, row: { ...rest, starts_at: startsAt, ends_at: endsAt } }, by, 'renew', `Renewed from ${r.ref}`);
    await this.core.audit({ action: 'advertising.campaign.renew', actionLabel: `Renewed ${r.ref} as ${row.ref}`, target: this.target(row), relatedTargets: [this.target(r)], after: { startsAt: body.startsAt, endsAt: body.endsAt } }, by);
    return this.view(row.id);
  }
}
