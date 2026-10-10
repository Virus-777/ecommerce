/**
 * Read views: campaign summaries and details, creatives, metrics, timelines and approval steps. Every
 * list loads what it needs in a few batched queries (stats, items, creatives, sellers, logs).
 */
import type { AdCampaign, AdCampaignSummary, ApprovalStep, Audience, CampaignMetrics, Creative, CreativeReview, CreativeUse, Destination, DismissalRule, FrequencyCap, LinkedPromotion, PromotedItem, ReviewCheck } from '../../../spec/advertising.js';
import type * as common from '../../../spec/common.js';
import { advertiserRef, allowedActions, budgetLabel, budgetOf, deliveryLabel, isPaid, pagesLabel, pct, periodLabel, shortDate, STEP_SCOPE } from '../domain/rules.js';
import type { CampaignRec, CreativeRec, ItemRec, PlacementRec, StatTotals, StepRec } from '../ports.js';
import { decodeActor, notFound, Part } from './core.js';

/** A campaign row with its placement, promoted items and creatives */
export interface Model {
  row: CampaignRec;
  placement: PlacementRec;
  items: ItemRec[];
  creatives: { creative_id: string; device: string }[];
  pages: string[];
  categoryIds: string[];
  audience: Audience;
  destination: Destination;
  cap: FrequencyCap;
  dismissal: DismissalRule;
}

const PUBLIC_ITEM_KINDS = ['offer', 'product', 'seller_store', 'brand'];

const TIMELINE_LABEL: Record<string, string> = {
  create: 'Draft created',
  renew: 'Draft created by renewing',
  edit: 'Edited',
  submit: 'Submitted for approval',
  approve_step: 'Review step approved',
  approve: 'Approved',
  requestChanges: 'Changes requested',
  withdraw: 'Withdrawn from review',
  reject: 'Rejected',
  schedule: 'Scheduled',
  activate: 'Activated',
  start: 'Went live',
  pause: 'Paused',
  resume: 'Resumed',
  finish: 'Finished',
  archive: 'Archived',
  ending_soon_notice: 'Owner reminded: ending soon',
  repoint: 'Promoted product merged',
  after_approval_fallback: 'Scheduled instead of activated',
};


export class ViewsPart extends Part {
  /* ---------------------------------------------------------------- models */

  async models(rows: readonly CampaignRec[]): Promise<Model[]> {
    if (!rows.length) return [];
    const ids = rows.map((r) => r.id);
    const [items, creatives] = await Promise.all([this.repo.find('campaign_items', { campaign_id: ids }), this.repo.find('campaign_creatives', { campaign_id: ids })]);
    const out: Model[] = [];
    for (const row of rows) {
      const placement = await this.core.placementById(row.placement_id);
      if (!placement) continue;
      out.push({
        row,
        placement,
        items: items.filter((i) => i.campaign_id === row.id),
        creatives: creatives.filter((c) => c.campaign_id === row.id).map((c) => ({ creative_id: c.creative_id, device: c.device })),
        pages: (row.pages ?? []) as string[],
        categoryIds: (row.page_category_ids ?? []) as string[],
        audience: row.audience as unknown as Audience,
        destination: row.destination as unknown as Destination,
        cap: row.frequency_cap as unknown as FrequencyCap,
        dismissal: row.dismissal as unknown as DismissalRule,
      });
    }
    return out;
  }

  async model(id: string, o: { sellerId?: string } = {}): Promise<Model> {
    const row = await this.repo.get('campaigns', id);
    if (!row || (o.sellerId !== undefined && row.seller_id !== o.sellerId)) throw notFound('Campaign');
    const [m] = await this.models([row]);
    if (!m) throw notFound('Campaign');
    return m;
  }

  promoted(items: readonly ItemRec[]): PromotedItem[] {
    return items.filter((i) => PUBLIC_ITEM_KINDS.includes(i.kind)).map((i) => ({ kind: i.kind as PromotedItem['kind'], id: i.target_id, label: i.label }));
  }

  /* ---------------------------------------------------------------- metrics */

  async metricsFor(ids: readonly string[], days?: { from: string; to: string }): Promise<Map<string, StatTotals>> {
    return this.repo.totals(ids, days);
  }

  metrics(t: StatTotals | undefined, attributionDays: number, currency = this.core.currency()): CampaignMetrics {
    const s = t ?? { displays: 0, clicks: 0, dismissals: 0, spend: 0, attributedOrders: 0, attributedSales: 0 };
    return {
      displays: s.displays,
      clicks: s.clicks,
      ctrPct: pct(s.clicks, s.displays),
      dismissals: s.dismissals,
      dismissRatePct: pct(s.dismissals, s.displays),
      spend: this.core.money(s.spend, currency),
      attributedOrders: s.attributedOrders,
      attributedSales: this.core.money(s.attributedSales, currency),
      attributionDays,
    };
  }

  /* ---------------------------------------------------------------- summaries */

  async summaries(rows: readonly CampaignRec[], area: 'admin' | 'seller' = 'admin'): Promise<AdCampaignSummary[]> {
    if (!rows.length) return [];
    const ids = rows.map((r) => r.id);
    const now = this.now();
    const tz = this.core.tz();
    const endingSoonDays = await this.core.num('endingSoonDays', 3);
    const [totals, sellers, steps, models] = await Promise.all([
      this.repo.totals(ids),
      this.core.sellerNames(rows.map((r) => r.seller_id)),
      this.repo.find('approval_steps', { campaign_id: rows.filter((r) => r.status === 'in_review').map((r) => r.id) }),
      this.models(rows),
    ]);
    const byId = new Map(models.map((m) => [m.row.id, m]));
    return rows.map((r) => {
      const m = byId.get(r.id);
      const placement = m?.placement;
      const t = totals.get(r.id);
      const endingSoon = r.ends_at ? r.ends_at.getTime() - now.getTime() < endingSoonDays * 86_400_000 : false;
      return {
        id: r.id,
        ref: r.ref,
        name: r.name,
        advertiser: advertiserRef(r.advertiser_kind, r.seller_id, r.brand_id, r.billing, { seller: sellers.get(r.seller_id ?? ''), brand: this.brandName(m?.items ?? []) }),
        placementKey: placement?.key ?? 'unknown',
        placementName: placement?.name ?? 'Placement',
        pagesLabel: pagesLabel((r.pages ?? []) as string[]),
        startsAt: r.starts_at?.toISOString() ?? null,
        endsAt: r.ends_at?.toISOString() ?? null,
        periodLabel: periodLabel(r.starts_at, r.ends_at, r.status, now, r.time_zone || tz),
        budgetLabel: budgetLabel({ billing: r.billing, spent: r.spent, totalLimit: r.total_limit, dailyLimit: r.daily_limit, currency: r.currency, paid: isPaid(r.advertiser_kind, r.billing) }),
        deliveryLabel: m ? deliveryLabel(m.cap, m.audience) : '',
        displays: t?.displays ?? 0,
        clicks: t?.clicks ?? 0,
        status: r.status as AdCampaignSummary['status'],
        statusNote: this.statusNote(r, steps.filter((s) => s.campaign_id === r.id), area, tz),
        allowedActions: allowedActions(r.status, { origin: r.origin, area, pausedBySeller: decodeActor(r.paused_by)?.kind === 'seller', endingSoon }),
      };
    });
  }

  brandName(items: readonly ItemRec[]): string | null {
    return items.find((i) => i.kind === 'brand')?.label ?? null;
  }

  private statusNote(r: CampaignRec, steps: StepRec[], area: 'admin' | 'seller', tz: string): string | null {
    switch (r.status) {
      case 'paused': {
        const by = decodeActor(r.paused_by);
        if (!by || !r.paused_at) return r.paused_reason;
        const who = by.kind === 'seller' ? (area === 'seller' ? 'you' : 'the seller') : by.kind === 'system' ? 'Marketly (automatic)' : 'Marketly';
        return `Paused by ${who} ${shortDate(r.paused_at, tz)}${r.paused_reason ? ` · ${r.paused_reason}` : ''}`;
      }
      case 'in_review': {
        const latest = Math.max(0, ...steps.map((s) => s.submission));
        const waiting = steps.filter((s) => s.submission === latest && s.state === 'waiting').map((s) => (s.role === 'advertising' ? 'Advertising' : s.role === 'content' ? 'Content' : 'Marketing'));
        return waiting.length ? `Needs ${waiting.join(' and ')} review` : null;
      }
      case 'finished':
        return r.finished_reason ? FINISHED_NOTE[r.finished_reason] ?? r.finished_reason : null;
      case 'rejected':
        return r.rejected_reason;
      default:
        return null;
    }
  }

  /* ---------------------------------------------------------------- campaign detail */

  async campaign(m: Model): Promise<AdCampaign> {
    const r = m.row;
    const rules = await this.core.rules();
    const [totals, sellers, creatives, approvals, timeline, linked, checks] = await Promise.all([
      this.repo.totals([r.id]),
      this.core.sellerNames([r.seller_id]),
      this.creativesOf(m),
      this.approvals(r.id),
      this.timeline(r.id),
      this.linkedPromotion(r),
      this.parts.campaigns.checksFor(m),
    ]);
    const activate = this.activateInfo(r, linked);
    const [owner] = await this.core.named([r.owner_staff_id ? { kind: 'staff', id: r.owner_staff_id } : null]);
    const [createdBy, pausedBy] = await this.core.named([decodeActor(r.created_by), r.status === 'paused' ? decodeActor(r.paused_by) : null]);
    return {
      id: r.id,
      ref: r.ref,
      name: r.name,
      origin: r.origin,
      advertiser: advertiserRef(r.advertiser_kind, r.seller_id, r.brand_id, r.billing, { seller: sellers.get(r.seller_id ?? ''), brand: this.brandName(m.items) }),
      goal: r.goal,
      owner: owner ?? null,
      linkedPromotion: linked,
      placement: this.core.placementView(m.placement, await this.liveCount(m.placement.id)),
      pages: m.pages,
      pageCategoryIds: m.categoryIds,
      audience: m.audience,
      destination: m.destination,
      promoted: this.promoted(m.items),
      startsAt: r.starts_at?.toISOString() ?? null,
      endsAt: r.ends_at?.toISOString() ?? null,
      timeZone: r.time_zone,
      frequencyCap: m.cap,
      dismissal: m.dismissal,
      priority: r.priority,
      budget: budgetOf(r),
      stopWithPromotion: r.stop_with_promotion,
      afterApproval: r.after_approval,
      activateAllowed: activate.allowed,
      activateBlockedReason: activate.reason,
      creatives,
      status: r.status as AdCampaign['status'],
      pausedReason: r.status === 'paused' ? r.paused_reason : null,
      pausedBy: r.status === 'paused' ? (pausedBy ?? null) : null,
      pauseCause: (r.status === 'paused' ? r.pause_cause : null) as AdCampaign['pauseCause'],
      rejectedReason: r.status === 'rejected' || r.status === 'archived' ? r.rejected_reason : null,
      finishedReason: (r.status === 'finished' || r.status === 'archived' ? r.finished_reason : null) as AdCampaign['finishedReason'],
      approvals,
      checks: checks.checks,
      conflicts: checks.conflicts,
      metrics: this.metrics(totals.get(r.id), rules.attributionDays, r.currency),
      noteToReviewers: r.note_to_reviewers,
      timeline,
      createdBy: createdBy ?? { kind: 'system', id: null },
      createdAt: r.created_at.toISOString(),
      updatedAt: r.updated_at.toISOString(),
      version: r.version,
    };
  }

  async liveCount(placementId: string): Promise<number> {
    return this.repo.count('campaigns', { placement_id: placementId, status: 'live' });
  }

  async linkedPromotion(r: CampaignRec): Promise<LinkedPromotion | null> {
    if (!r.linked_promotion_id) return null;
    const p = await this.core.optional('promotions', (api) => api.getPublicCampaign(r.linked_promotion_id!));
    if (!p) return null;
    return { id: p.id, name: p.name, code: p.code ?? null, status: p.status, startsAt: p.period.startsAt, endsAt: p.period.endsAt };
  }

  /** Activate now is allowed once startsAt has passed and no linked promotion starts later */
  activateInfo(r: CampaignRec, linked: LinkedPromotion | null): { allowed: boolean; reason: string | null } {
    const now = this.now().getTime();
    const tz = r.time_zone || this.core.tz();
    if (r.starts_at && r.starts_at.getTime() > now) return { allowed: false, reason: `Not available: the campaign starts ${shortDate(r.starts_at, tz)}` };
    if (linked && new Date(linked.startsAt).getTime() > now) return { allowed: false, reason: `Not available: the linked promotion starts ${shortDate(new Date(linked.startsAt), tz)}` };
    return { allowed: true, reason: null };
  }

  async approvals(campaignId: string): Promise<ApprovalStep[]> {
    const steps = await this.repo.find('approval_steps', { campaign_id: campaignId }, { orderBy: [['submission', 'desc']] });
    if (!steps.length) return [];
    const latest = steps[0]!.submission;
    const current = steps.filter((s) => s.submission === latest).sort((a, b) => (a.role === 'advertising' ? -1 : b.role === 'advertising' ? 1 : 0));
    const reviewers = await this.core.named(current.map((s) => decodeActor(s.reviewer_id)));
    return current.map((s, i) => ({
      role: s.role as ApprovalStep['role'],
      reviewer: reviewers[i] ?? null,
      state: s.state as ApprovalStep['state'],
      decidedAt: s.decided_at?.toISOString() ?? null,
      note: s.note,
      scope: STEP_SCOPE[s.role] ?? '',
    }));
  }

  async timeline(campaignId: string): Promise<common.TimelineEvent[]> {
    const logs = await this.repo.find('campaign_log', { campaign_id: campaignId }, { orderBy: [['at', 'asc'], ['id', 'asc']], limit: 500 });
    const actors = await this.core.named(logs.map((l) => ({ kind: l.actor_kind as common.Actor['kind'], id: l.actor_id })));
    return logs.map((l, i) => ({
      at: l.at.toISOString(),
      label: TIMELINE_LABEL[l.action] ?? (l.action.startsWith('auto_pause:') ? 'Paused automatically' : l.action.startsWith('auto_resume:') ? 'Resumed automatically' : l.action),
      detail: l.reason,
      actor: actors[i] ?? null,
    }));
  }

  /* ---------------------------------------------------------------- creatives */

  async creativesOf(m: Model): Promise<Creative[]> {
    const rows = await this.repo.getMany(
      'creatives',
      m.creatives.map((c) => c.creative_id),
    );
    return this.creatives(rows);
  }

  async creatives(rows: readonly CreativeRec[]): Promise<Creative[]> {
    if (!rows.length) return [];
    const ids = rows.map((r) => r.id);
    const [reviews, links, sellers] = await Promise.all([
      this.repo.find('creative_reviews', { creative_id: ids }, { orderBy: [['at', 'asc']] }),
      this.repo.find('campaign_creatives', { creative_id: ids }),
      this.core.sellerNames(rows.map((r) => r.seller_id)),
    ]);
    const campaigns = await this.repo.getMany(
      'campaigns',
      links.map((l) => l.campaign_id),
    );
    const campaignById = new Map(campaigns.map((c) => [c.id, c]));
    const mediaIds = rows.map((r) => r.media_id).filter((x): x is string => Boolean(x));
    const refs = mediaIds.length ? await this.core.optionalMedia((api) => api.refs(mediaIds, 'medium')) : undefined;
    const refById = new Map((refs ?? []).map((r) => [r.id, r]));
    const reviewers = await this.core.named(reviews.map((rv) => decodeActor(rv.reviewer_id)));
    const placements = await this.core.placementRows();
    return rows.map((r) => {
      const used: CreativeUse[] = links
        .filter((l) => l.creative_id === r.id)
        .map((l) => campaignById.get(l.campaign_id))
        .filter((c): c is CampaignRec => Boolean(c))
        .map((c) => ({ campaignId: c.id, name: c.name, status: c.status }));
      const placement = placements.find((p) => p.key === r.placement_key);
      const own: CreativeReview[] = reviews
        .map((rv, i) => ({ rv, reviewer: reviewers[i] }))
        .filter((x) => x.rv.creative_id === r.id)
        .map(({ rv, reviewer }) => ({
          reviewer: reviewer ?? { kind: 'staff', id: rv.reviewer_id },
          role: rv.role as CreativeReview['role'],
          decision: rv.decision as CreativeReview['decision'],
          reasonCode: rv.reason_code as CreativeReview['reasonCode'],
          comment: rv.comment,
          at: rv.at.toISOString(),
        }));
      return {
        id: r.id,
        campaignId: used[0]?.campaignId ?? null,
        advertiser: advertiserRef(r.advertiser_kind, r.seller_id, r.brand_id, r.advertiser_kind === 'seller' || r.advertiser_kind === 'brand' ? 'cpc' : 'none', { seller: sellers.get(r.seller_id ?? '') }),
        kind: r.kind as Creative['kind'],
        device: r.device as Creative['device'],
        formatLabel: `${placement?.name ?? r.placement_key} · ${r.device === 'any' ? 'any device' : r.device}`,
        media: r.media_id ? (refById.get(r.media_id) ?? null) : null,
        fileName: r.file_name,
        width: r.width,
        height: r.height,
        bytes: r.bytes,
        durationSeconds: r.duration_seconds,
        captions: r.kind === 'video' ? false : null,
        headline: r.headline,
        body: r.body,
        buttonText: r.button_text,
        link: r.link,
        status: r.status as Creative['status'],
        linkCheck: r.link_check as never,
        autoChecks: (r.auto_checks ?? []) as unknown as ReviewCheck[],
        reviews: own,
        usedIn: used,
        createdAt: r.created_at.toISOString(),
        createdBy: decodeActor(r.created_by) ?? { kind: 'system', id: null },
      };
    });
  }
}

export const FINISHED_NOTE: Record<string, string> = {
  ended: 'Ended on schedule',
  budget_reached: 'Spending limit reached',
  delivery_cap_reached: 'Delivery cap reached',
  promotion_ended: 'Linked promotion ended',
  offer_unavailable: 'Promoted offer unavailable',
  stopped_early: 'Stopped early',
  seller_restricted: 'Seller suspended',
};
