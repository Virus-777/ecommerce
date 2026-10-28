/**
 * Software statistics (GET /api/store/software/statistics, the app's Statistics › Softwares tab): what the customer
 * paid for apps and packs in a period, what reached their library, the trend and the breakdowns.
 *
 * Money comes from purchases, counted on the market day the payment went through (paid_at); app counts come from
 * entitlements, counted on the day each app was added. Purchases still waiting for payment are left out; failed and
 * cancelled ones are counted apart as notPaid. A pack counts once at its price, adds every app in it to the library,
 * and is split across its apps' categories and companies by each app's share of the pack price.
 */
import { money } from '../../../kernel/lib/money.js';
import {
  average,
  bucketOf,
  buckets,
  emptyWeekdays,
  pointLabel,
  previousPeriod,
  shares,
  statPeriod,
  statPrevious,
  tallyInto,
  weekdayOf,
  weekdayRows,
  TOP_ROWS,
  type PeriodQuery,
  type StatPeriod,
  type StatTally,
} from '../../../kernel/lib/stats-period.js';
import type * as common from '../../../spec/common.js';
import type { SoftwareStatApp, SoftwareStatistics } from '../../../spec/software.js';
import { dateInZone } from '../../../kernel/lib/clock.js';
import type { AppRow, EntitlementRow, PackRow, PurchaseRow, ReviewRow } from '../ports.js';
import { SoftwarePurchases } from './purchases.js';

/** Most rows read for one answer (a customer's whole software history in practice) */
const MAX_ROWS = 5000;
const SOURCE_LABEL: Record<string, string> = { free: 'Free', purchase: 'Bought on their own', pack: 'In a pack', staff: 'Added by Marketly' };

export class SoftwareStatisticsPart extends SoftwarePurchases {
  async statisticsFor(customerId: string, q: PeriodQuery): Promise<SoftwareStatistics> {
    const today = dateInZone(this.now(), this.tz);
    const [purchasesAll, entitlementsAll, reviewsAll] = await Promise.all([
      this.repo.customerPurchases(customerId),
      this.repo.customerEntitlements(customerId),
      this.repo.customerReviews(customerId),
    ]);
    const purchases = purchasesAll.filter((p) => p.status !== 'pending_payment' && p.status !== 'requires_action').slice(0, MAX_ROWS);
    const entitlements = entitlementsAll.slice(0, MAX_ROWS);
    const day = (at: Date) => dateInZone(at, this.tz);
    const purchaseDay = (p: PurchaseRow) => day(p.paid_at ?? p.updated_at);
    const period = statPeriod(q, today, this.firstDay(purchases, entitlements, day, today));

    const within = (d: string) => d >= period.from && d <= period.to;
    const inPeriod = purchases.filter((p) => within(purchaseDay(p)));
    const added = entitlements.filter((e) => within(day(e.created_at)));
    const reviews = reviewsAll.filter((r) => within(day(r.created_at)));
    const currency = inPeriod.find((p) => p.status === 'paid')?.currency ?? purchases[0]?.currency ?? this.currency;

    return this.report({ period, purchases: inPeriod, added, reviews, currency, purchaseDay, allPurchases: purchases });
  }

  /** range=all starts at the first payment or library addition */
  private firstDay(purchases: PurchaseRow[], entitlements: EntitlementRow[], day: (at: Date) => string, today: string): string {
    const days = [...purchases.filter((p) => p.status === 'paid' && p.paid_at).map((p) => day(p.paid_at!)), ...entitlements.map((e) => day(e.created_at))];
    return days.length ? days.reduce((a, b) => (a < b ? a : b)) : today;
  }

  private async report(input: {
    period: StatPeriod;
    purchases: PurchaseRow[];
    added: EntitlementRow[];
    reviews: ReviewRow[];
    currency: string;
    purchaseDay: (p: PurchaseRow) => string;
    allPurchases: PurchaseRow[];
  }): Promise<SoftwareStatistics> {
    const { period, purchases, added, reviews, currency, purchaseDay, allPurchases } = input;
    const m = (amount: number): common.Money => money(amount, currency);
    const paidRows = purchases.filter((p) => p.status === 'paid');

    const apps = await this.appsOf([...paidRows.flatMap((p) => (p.items as { appId?: string }[] | null)?.map((i) => i.appId) ?? []), ...added.map((e) => e.app_id)]);
    const packs = await this.packsOf(paidRows.map((p) => p.pack_id));
    const categories = await this.categoryNames();

    const totals = { paid: 0, notPaid: 0, packs: 0, licenceKeys: 0, stars: 0 };
    let largest: { row: PurchaseRow; amount: number } | null = null;

    const starts = buckets(period.from, period.to, period.grain);
    const points = new Map(starts.map((s) => [s, { amount: 0, count: 0 }]));
    const weekdays = emptyWeekdays();
    const byCategory = new Map<string, StatTally>();
    const byCompany = new Map<string, StatTally>();
    const bySource = new Map<string, StatTally>();
    const topApps = new Map<string, { amount: number; apps: number; at: Date; row: PurchaseRow; app?: AppRow; pack?: PackRow }>();

    for (const p of purchases) {
      if (p.status !== 'paid') {
        totals.notPaid += p.amount;
        continue;
      }
      const d = purchaseDay(p);
      totals.paid += p.amount;
      if (p.pack_id) totals.packs += 1;
      if (!largest || p.amount > largest.amount) largest = { row: p, amount: p.amount };
      const point = points.get(bucketOf(d, period.grain, period.from));
      if (point) {
        point.amount += p.amount;
        point.count += 1;
      }
      const w = weekdays[weekdayOf(d)]!;
      w.amount += p.amount;
      w.count += 1;

      // A pack's price is split across its apps by what each would cost on its own, so the category and company
      // rows add up to the pack price; apps with no price of their own share what is left evenly.
      const items = ((p.items as { appId?: string }[] | null) ?? []).map((i) => i.appId).filter((id): id is string => Boolean(id));
      for (const [appId, slice] of this.split(items, p.amount, apps)) {
        const app = apps.get(appId);
        const categoryId = app?.category_id ?? 'other';
        tallyInto(byCategory, categoryId, app ? (categories.get(categoryId) ?? 'Other') : 'Other', p.id, slice, 1);
        const company = (app?.company as { name?: string } | null)?.name;
        tallyInto(byCompany, company ?? 'other', company ?? 'Other', p.id, slice, 1);
      }

      const key = p.pack_id ?? p.app_id ?? p.id;
      const at = p.paid_at ?? p.updated_at;
      const seen = topApps.get(key);
      if (!seen) topApps.set(key, { amount: p.amount, apps: Math.max(1, items.length), at, row: p, app: p.app_id ? apps.get(p.app_id) : undefined, pack: p.pack_id ? packs.get(p.pack_id) : undefined });
      else {
        seen.amount += p.amount;
        seen.apps = Math.max(seen.apps, items.length);
        if (at > seen.at) seen.at = at;
      }
    }

    for (const e of added) {
      tallyInto(bySource, e.source, SOURCE_LABEL[e.source] ?? e.source, e.id, 0, 1);
      if (e.licence_key) totals.licenceKeys += 1;
    }
    for (const r of reviews) totals.stars += r.stars;

    const freeApps = added.filter((e) => e.source === 'free').length;
    const top: SoftwareStatApp[] = [...topApps.values()]
      .filter((t) => t.amount > 0)
      .sort((a, b) => b.amount - a.amount)
      .slice(0, TOP_ROWS)
      .map((t): SoftwareStatApp => ({
        appId: t.app?.id ?? null,
        slug: t.pack?.slug ?? t.app?.slug ?? null,
        title: t.pack?.name ?? t.app?.title ?? t.row.title,
        icon: null,
        company: (t.app?.company as { name?: string } | null)?.name ?? null,
        apps: t.apps,
        amount: m(t.amount),
        boughtAt: t.at.toISOString(),
      }));
    const icons = await this.refsMap(top.map((t) => (t.appId ? apps.get(t.appId)?.icon_id : null)), 'thumb');
    for (const t of top) {
      const iconId = t.appId ? apps.get(t.appId)?.icon_id : null;
      if (iconId) t.icon = icons.get(iconId) ?? null;
    }

    return {
      from: period.from,
      to: period.to,
      grain: period.grain,
      currency,
      totals: {
        paid: m(totals.paid),
        notPaid: m(totals.notPaid),
        purchases: paidRows.length,
        appsAdded: added.length,
        paidApps: added.length - freeApps,
        freeApps,
        packs: totals.packs,
        licenceKeys: totals.licenceKeys,
        reviews: reviews.length,
        averageRating: average(totals.stars, reviews.length),
        averagePurchase: m(paidRows.length ? Math.round(totals.paid / paidRows.length) : 0),
        largestPurchase: largest
          ? { purchaseId: largest.row.id, ref: largest.row.ref, title: largest.row.title, paidAt: (largest.row.paid_at ?? largest.row.updated_at).toISOString(), amount: m(largest.amount) }
          : null,
      },
      previous: period.all ? null : this.previous(period, allPurchases, purchaseDay, totals.paid, currency),
      series: starts.map((s) => {
        const p = points.get(s)!;
        return { start: s, label: pointLabel(s, period.grain, period.years), amount: m(p.amount), secondary: null, count: p.count };
      }),
      byCategory: shares(byCategory, { total: totals.paid, currency }),
      byCompany: shares(byCompany, { total: totals.paid, currency }),
      bySource: shares(bySource, { total: added.length, currency, by: 'count', top: 4 }),
      byWeekday: weekdayRows(weekdays, currency),
      topApps: top,
    };
  }

  /** The same number of days just before the period: paid and purchases, counted the same way */
  private previous(period: StatPeriod, all: PurchaseRow[], dayOf: (p: PurchaseRow) => string, paid: number, currency: string): common.StatPrevious {
    const { from, to } = previousPeriod(period);
    let amount = 0;
    let count = 0;
    for (const p of all) {
      if (p.status !== 'paid') continue;
      const d = dayOf(p);
      if (d < from || d > to) continue;
      amount += p.amount;
      count += 1;
    }
    return statPrevious(from, to, amount, count, paid, currency);
  }

  /** Each app's slice of a purchase: its own price's share, or an even split when none of them has one */
  private split(appIds: string[], amount: number, apps: Map<string, AppRow>): [string, number][] {
    if (!appIds.length) return [];
    if (appIds.length === 1) return [[appIds[0]!, amount]];
    const weights = appIds.map((id) => Math.max(0, apps.get(id)?.sale_price ?? apps.get(id)?.price ?? 0));
    const total = weights.reduce((a, b) => a + b, 0);
    const out: [string, number][] = [];
    let left = amount;
    appIds.forEach((id, i) => {
      // the last row takes the rounding remainder, so the slices add up to the price exactly
      const slice = i === appIds.length - 1 ? left : total > 0 ? Math.round((weights[i]! / total) * amount) : Math.round(amount / appIds.length);
      out.push([id, slice]);
      left -= slice;
    });
    return out;
  }

  private async appsOf(ids: (string | null | undefined)[]): Promise<Map<string, AppRow>> {
    const unique = [...new Set(ids.filter((id): id is string => Boolean(id)))];
    if (!unique.length) return new Map();
    return new Map((await this.repo.appsByIds(unique)).map((a) => [a.id, a]));
  }

  private async packsOf(ids: (string | null | undefined)[]): Promise<Map<string, PackRow>> {
    const unique = [...new Set(ids.filter((id): id is string => Boolean(id)))];
    if (!unique.length) return new Map();
    const rows = await Promise.all(unique.map((id) => this.repo.getPack(id)));
    return new Map(rows.filter((p): p is PackRow => Boolean(p)).map((p) => [p.id, p]));
  }

  private async categoryNames(): Promise<Map<string, string>> {
    return new Map((await this.repo.listCategories()).map((c) => [c.id, c.name]));
  }
}
