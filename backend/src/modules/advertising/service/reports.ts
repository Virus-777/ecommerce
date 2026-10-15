/**
 * Performance from the daily_stats read model (displays, clicks, dismissals, spend, attributed purchases by
 * campaign and market day), the Admin dashboard tile and the stats roll-up job.
 */
import type { AdCampaignSummary, AdsDashboard, CampaignDayPerformance, DailyAdPoint, PerformanceReport, PlacementStat } from '../../../spec/advertising.js';
import type * as common from '../../../spec/common.js';
import type * as identity from '../../../spec/identity.js';
import type * as reports from '../../../spec/reports.js';
import { AppError } from '../../../kernel/errors/index.js';
import { advertiserIsOwn, sourceKinds } from '../domain/rules.js';
import type { CampaignRec, StatRec, StatTotals } from '../ports.js';
import { invalid, notFound, Part } from './core.js';
import { isUuid } from '../../../kernel/lib/ids.js';

const ZERO: StatTotals = { displays: 0, clicks: 0, dismissals: 0, spend: 0, attributedOrders: 0, attributedSales: 0 };
const add = (a: StatTotals, r: StatRec): StatTotals => ({
  displays: a.displays + r.displays,
  clicks: a.clicks + r.clicks,
  dismissals: a.dismissals + r.dismissals,
  spend: a.spend + r.spend,
  attributedOrders: a.attributedOrders + r.attributed_orders,
  attributedSales: a.attributedSales + r.attributed_sales,
});

/**
 * The admin campaign list export (G72). reports must list the key in its export dataset registry (ExportDatasetKey and
 * the exportDatasets setting): until then registering it is refused and the dataset is not offered.
 */
export const CAMPAIGNS_DATASET = 'advertising.admin.campaigns';
const EXPORT_PAGE = 500;

export class ReportsPart extends Part {
  /* ---------------------------------------------------------------- exports */

  async registerDataset(): Promise<void> {
    const api = this.ctx.tryUse('reports');
    if (!api) return;
    const columns = [
      ['ref', 'Campaign'],
      ['name', 'Name'],
      ['advertiser', 'Advertiser'],
      ['placement', 'Placement'],
      ['pages', 'Pages'],
      ['period', 'Period'],
      ['startsAt', 'Starts'],
      ['endsAt', 'Ends'],
      ['budget', 'Budget'],
      ['displays', 'Displays'],
      ['clicks', 'Clicks'],
      ['status', 'Status'],
    ].map(([key, label]) => ({ key: key!, label: label! }));
    try {
      await api.registerDataset({ key: CAMPAIGNS_DATASET as reports.ExportDataset['key'], owner: 'advertising', title: 'Ad campaigns', permission: 'advertising.campaigns.view', audience: 'staff', screens: ['admin/ads'], available: true, phase: 1, columns });
    } catch (err) {
      this.ctx.log.debug({ err, dataset: CAMPAIGNS_DATASET }, 'advertising: export dataset not registered');
    }
  }

  /** Rows of the campaign list export: the admin list filters, staff only, 500 a page */
  async exportRows(dataset: string, filters: unknown, principal: identity.Principal, cursor?: string): Promise<{ rows: unknown[]; nextCursor?: string }> {
    if (dataset !== CAMPAIGNS_DATASET) throw new AppError('NOT_FOUND', `Unknown dataset ${dataset}`);
    if (principal?.kind !== 'staff') throw new AppError('FORBIDDEN', 'Ad campaigns are exported by staff only');
    const f = (filters && typeof filters === 'object' ? filters : {}) as Record<string, unknown>;
    const text = (k: string) => (typeof f[k] === 'string' && f[k] ? (f[k] as string) : undefined);
    const q = { q: text('q'), source: text('source'), placementKey: text('placementKey'), status: text('status'), linkedPromotionId: text('linkedPromotionId') };
    const page = await this.parts.campaigns.list(Object.fromEntries(Object.entries(q).filter(([, v]) => v !== undefined)), { mode: 'cursor', cursor: cursor ?? null, limit: EXPORT_PAGE });
    const rows = page.items.map((c: AdCampaignSummary) => ({
      ref: c.ref,
      name: c.name,
      advertiser: c.advertiser.name,
      placement: c.placementName,
      pages: c.pagesLabel,
      period: c.periodLabel,
      startsAt: c.startsAt ?? '',
      endsAt: c.endsAt ?? '',
      budget: c.budgetLabel,
      displays: c.displays,
      clicks: c.clicks,
      status: c.status,
    }));
    return { rows, ...(page.nextCursor ? { nextCursor: page.nextCursor } : {}) };
  }

  /* ---------------------------------------------------------------- reads */

  private range(from: string | undefined, to: string | undefined, fallbackDays = 7): common.DateRange {
    const t = to ?? this.core.today();
    const f = from ?? this.core.addDays(t, -(fallbackDays - 1));
    if (f > t) throw invalid([{ path: 'from', message: 'The start must be on or before the end' }]);
    if (this.core.addDays(f, 366) < t) throw invalid([{ path: 'from', message: 'A report covers a year at most' }]);
    return { from: f, to: t };
  }

  private days(r: common.DateRange): string[] {
    const out: string[] = [];
    for (let d = r.from; d <= r.to && out.length < 400; d = this.core.addDays(d, 1)) out.push(d);
    return out;
  }

  /** A report over campaigns (all when null) */
  async report(range: common.DateRange, campaigns: readonly CampaignRec[] | null): Promise<PerformanceReport> {
    const rules = await this.core.rules();
    const ids = campaigns ? campaigns.map((c) => c.id) : null;
    const rows = await this.repo.statsInRange(range, ids);
    const today = this.core.today();
    const byDay = new Map<string, StatTotals>();
    let total = ZERO;
    for (const r of rows) {
      byDay.set(r.day, add(byDay.get(r.day) ?? ZERO, r));
      total = add(total, r);
    }
    const daily: DailyAdPoint[] = this.days(range).map((d) => {
      const t = byDay.get(d) ?? ZERO;
      return { date: d, displays: t.displays, clicks: t.clicks, dismissals: t.dismissals, spend: this.core.money(t.spend), partial: d >= today };
    });
    // placements of the campaigns in the rows
    const campaignRows = campaigns ?? (await this.repo.getMany('campaigns', [...new Set(rows.map((r) => r.campaign_id))]));
    const placementOf = new Map<string, string>();
    for (const c of campaignRows) placementOf.set(c.id, (await this.core.placementById(c.placement_id))?.key ?? 'unknown');
    const byPlacement = new Map<string, StatTotals>();
    for (const r of rows) {
      const k = placementOf.get(r.campaign_id) ?? 'unknown';
      byPlacement.set(k, add(byPlacement.get(k) ?? ZERO, r));
    }
    const placements: PlacementStat[] = [...byPlacement.entries()].map(([placementKey, t]) => ({ placementKey, displays: t.displays, clicks: t.clicks, dismissals: t.dismissals, spend: this.core.money(t.spend), attributedOrders: t.attributedOrders }));
    const opening = byPlacement.get('opening_fullscreen');
    return {
      range,
      timeZone: this.core.tz(),
      metrics: this.parts.views.metrics(total, rules.attributionDays),
      openingAdClosedPct: opening && opening.displays ? Math.round((opening.dismissals / opening.displays) * 10_000) / 100 : null,
      daily,
      byPlacement: placements,
      attributionNote: `A purchase counts when it happens within ${rules.attributionDays} day${rules.attributionDays === 1 ? '' : 's'} of a click on the ad. Paid campaigns never guarantee purchases.`,
    };
  }

  async campaignReport(id: string, q: { from?: string; to?: string }): Promise<PerformanceReport> {
    const c = isUuid(id) ? await this.repo.get('campaigns', id) : undefined;
    if (!c) throw notFound('Campaign');
    const today = this.core.today();
    const start = c.starts_at ? this.core.today(c.starts_at) : today;
    const end = c.ends_at ? this.core.today(c.ends_at) : today;
    const to = q.to ?? (end < today ? end : today);
    const from = q.from ?? (start < to ? (this.core.addDays(start, 366) < to ? this.core.addDays(to, -365) : start) : to);
    return this.report(this.range(from, to), [c]);
  }

  async performance(q: { from: string; to: string; source?: string }): Promise<PerformanceReport> {
    const range = this.range(q.from, q.to);
    const kinds = sourceKinds(q.source);
    const campaigns = kinds ? await this.repo.find('campaigns', { advertiser_kind: kinds }) : null;
    return this.report(range, campaigns);
  }

  async dailyPerformance(range: common.DateRange, filter?: { campaignId?: string; sellerId?: string }): Promise<CampaignDayPerformance[]> {
    const r = this.range(range?.from, range?.to);
    let campaigns: CampaignRec[] | null = null;
    if (filter?.campaignId) campaigns = isUuid(filter.campaignId) ? await this.repo.find('campaigns', { id: filter.campaignId, ...(filter.sellerId ? { seller_id: filter.sellerId } : {}) }) : [];
    else if (filter?.sellerId) campaigns = isUuid(filter.sellerId) ? await this.repo.find('campaigns', { seller_id: filter.sellerId }) : [];
    const rows = await this.repo.statsInRange(r, campaigns?.map((c) => c.id) ?? null);
    const byId = new Map((campaigns ?? (await this.repo.getMany('campaigns', [...new Set(rows.map((x) => x.campaign_id))]))).map((c) => [c.id, c]));
    const today = this.core.today();
    return rows.map((x) => {
      const c = byId.get(x.campaign_id);
      const cur = c?.currency ?? this.core.currency();
      return {
        date: x.day,
        campaignId: x.campaign_id,
        campaignRef: c?.ref ?? '',
        sellerId: c?.seller_id ?? null,
        displays: x.displays,
        clicks: x.clicks,
        dismissals: x.dismissals,
        attributedOrders: x.attributed_orders,
        attributedSales: this.core.money(x.attributed_sales, cur),
        spend: this.core.money(x.spend, cur),
        partial: x.day >= today,
      };
    });
  }

  /* ---------------------------------------------------------------- dashboard */

  async dashboard(q: { from?: string; to?: string; listLimit?: number } = {}): Promise<AdsDashboard & { liveList: AdCampaignSummary[] }> {
    const now = this.now();
    const t = now.getTime();
    const limit = Math.min(Math.max(q.listLimit ?? 5, 0), 50);
    const endingDays = await this.core.num('endingSoonDays', 3);
    const rules = await this.core.rules();
    const open = await this.repo.find('campaigns', { status: ['in_review', 'approved', 'scheduled', 'live', 'paused'] }, { limit: 5000 });
    const live = open.filter((c) => c.status === 'live');
    const upcoming = open.filter((c) => (c.status === 'approved' || c.status === 'scheduled') && c.starts_at && c.starts_at.getTime() > t && c.starts_at.getTime() <= t + 7 * 86_400_000).sort((a, b) => a.starts_at!.getTime() - b.starts_at!.getTime());
    const ending = open.filter((c) => ['scheduled', 'live', 'paused'].includes(c.status) && c.ends_at && c.ends_at.getTime() > t && c.ends_at.getTime() <= t + endingDays * 86_400_000).sort((a, b) => a.ends_at!.getTime() - b.ends_at!.getTime());
    const waiting = open.filter((c) => c.status === 'in_review');
    const submitted = await this.repo.lastLogs(
      waiting.map((c) => c.id),
      ['submit'],
    );
    const waitedSince = waiting.map((c) => submitted.get(c.id)?.at ?? c.updated_at).sort((a, b) => a.getTime() - b.getTime());
    const waitingSorted = [...waiting].sort((a, b) => (submitted.get(a.id)?.at ?? a.updated_at).getTime() - (submitted.get(b.id)?.at ?? b.updated_at).getTime());

    // this month (market time)
    const today = this.core.today(now);
    const monthStart = `${today.slice(0, 8)}01`;
    const monthTotals = await this.repo.totals(null, { from: monthStart, to: today });
    const month = [...monthTotals.values()].reduce((a, x) => ({ ...a, spend: a.spend + x.spend, attributedOrders: a.attributedOrders + x.attributedOrders, attributedSales: a.attributedSales + x.attributedSales }), ZERO);
    const posted = await this.repo.find('ad_charges', { state: 'posted', day: { op: '>=', value: monthStart } }, { limit: 20_000 });
    const billed = posted.filter((c) => c.day <= today).reduce((a, c) => a + c.amount, 0);
    const finishedThisMonth = await this.repo.find('campaigns', { status: ['finished', 'archived'], updated_at: { op: '>=', value: this.core.dayStart(monthStart) } }, { limit: 5000 });
    const paidFinished = finishedThisMonth.filter((c) => !advertiserIsOwn(c.advertiser_kind) && c.billing !== 'none' && c.total_limit !== null);
    const unused = paidFinished.reduce((a, c) => a + Math.max((c.total_limit ?? 0) - c.spent, 0), 0);
    const cancelled = finishedThisMonth.filter((c) => c.finished_reason && ['stopped_early', 'seller_restricted', 'offer_unavailable'].includes(c.finished_reason)).length;

    const views = this.parts.views;
    const [waitingList, upcomingStarts, endingSoonList, liveList] = await Promise.all([views.summaries(waitingSorted.slice(0, limit)), views.summaries(upcoming.slice(0, limit)), views.summaries(ending.slice(0, limit)), views.summaries(live.slice(0, limit))]);
    const range = this.range(q.from, q.to);
    return {
      liveNow: { total: live.length, own: live.filter((c) => advertiserIsOwn(c.advertiser_kind)).length, paid: live.filter((c) => !advertiserIsOwn(c.advertiser_kind)).length },
      startingIn7Days: upcoming.length,
      nextStartAt: upcoming[0]?.starts_at?.toISOString() ?? null,
      endingSoon: ending.length,
      waitingApproval: waiting.length,
      oldestWaitingDays: waitedSince.length ? Math.floor((t - waitedSince[0]!.getTime()) / 86_400_000) : null,
      spendThisMonth: this.core.money(month.spend),
      attributedOrders: month.attributedOrders,
      attributedSales: this.core.money(month.attributedSales),
      attributionDays: rules.attributionDays,
      waitingList,
      upcomingStarts,
      endingSoonList,
      billing: { modelLabel: 'Per click or fixed daily fee (example rates)', billedThisMonth: this.core.money(billed), unusedBudgetReturned: this.core.money(unused), cancelledCampaigns: cancelled },
      performance: await this.report(range, null),
      liveList,
    };
  }

  /* ---------------------------------------------------------------- roll-up */

  /** Job advertising.stats-rollup: the last three market days from ad_events and attributions */
  async rollup(): Promise<void> {
    const today = this.core.today();
    await this.repo.rollup(this.core.span(this.core.addDays(today, -2), today), this.core.tz());
  }
}
