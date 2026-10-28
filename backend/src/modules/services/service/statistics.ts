/**
 * Service request statistics (GET /api/store/services/statistics, the app's Statistics › Welfare tab, and any other
 * area with ?area=): the customer's requests in a period, the trend and the breakdowns.
 *
 * These services are paid at the provider, so there is no record of what the customer paid. The report counts
 * requests, and `estimated` adds up the providers' price lists for the requests that have a fixed price per
 * request (per visit, per night, free), kept on the request when it was made. Requests charged by the hour are left
 * out of the estimate, because the hours worked are never recorded here. Requests made before the estimate was kept
 * fall back to the service's price list today. Requests count by the market day they were made, whichever day the
 * visit was, and cancelled and declined ones are counted too.
 */
import { dateInZone } from '../../../kernel/lib/clock.js';
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
import type { RequestDetails, ServiceStatistics, ServiceStatService } from '../../../spec/services.js';
import { requestEstimate, type Area } from '../domain/rules.js';
import type { ProviderRow, RequestRow, ReviewRow, ServiceRow } from '../ports.js';
import { ServicesDevices } from './devices.js';

/** Most requests read for one answer (a customer's whole history in practice) */
const MAX_REQUESTS = 5000;
const UNDER_WAY = new Set(['requested', 'confirmed', 'in_progress']);

const STATUS_LABEL: Record<string, string> = {
  requested: 'Waiting to be confirmed',
  confirmed: 'Confirmed',
  in_progress: 'In progress',
  completed: 'Completed',
  cancelled: 'Cancelled',
  declined: 'Declined',
};

const detailsOf = (v: unknown): RequestDetails => (v && typeof v === 'object' ? (v as RequestDetails) : {});

export class ServicesStatisticsPart extends ServicesDevices {
  async statisticsFor(customerId: string, q: PeriodQuery & { area?: Area }): Promise<ServiceStatistics> {
    const today = this.today();
    const [requestsAll, reviewsAll] = await Promise.all([this.repo.allCustomerRequests(customerId), this.repo.allCustomerReviews(customerId)]);
    const counted = requestsAll
      .filter((r) => !q.area || r.area === q.area)
      // the id breaks a tie, so two requests made in the same moment always come out in the same order
      .sort((a, b) => a.created_at.getTime() - b.created_at.getTime() || a.id.localeCompare(b.id))
      .slice(0, MAX_REQUESTS);
    const dayOf = (r: { created_at: Date }) => dateInZone(r.created_at, this.tz);
    const period = statPeriod(q, today, counted.length ? dayOf(counted[0]!) : today);

    const within = (d: string) => d >= period.from && d <= period.to;
    const requests = counted.filter((r) => within(dayOf(r)));
    // Reviews count on the day they were left, for a request of the area asked for — the request itself may be
    // older than the period, so they are matched against every request of the area, not only the period's.
    const ofArea = new Set(counted.map((r) => r.id));
    const reviews = reviewsAll.filter((v) => within(dayOf(v)) && (!q.area || ofArea.has(v.request_id)));
    return this.report({ period, area: q.area, requests, reviews, dayOf, all: counted });
  }

  private async report(input: {
    period: StatPeriod;
    area?: Area;
    requests: RequestRow[];
    reviews: ReviewRow[];
    dayOf: (r: { created_at: Date }) => string;
    all: RequestRow[];
  }): Promise<ServiceStatistics> {
    const { period, area, requests, reviews, dayOf, all } = input;
    const [services, providers] = await Promise.all([
      this.servicesOf(requests.map((r) => r.service_id)),
      this.providersOf(requests.map((r) => r.provider_id)),
    ]);
    const currency = requests.find((r) => r.estimated_currency)?.estimated_currency ?? [...services.values()][0]?.currency ?? this.currency;
    const m = (amount: number): common.Money => money(amount, currency);

    const totals = { estimated: 0, estimatedFrom: 0, completed: 0, underWay: 0, cancelled: 0, declined: 0, days: 0, finished: 0, stars: 0 };
    const starts = buckets(period.from, period.to, period.grain);
    const points = new Map(starts.map((s) => [s, { amount: 0, count: 0 }]));
    const weekdays = emptyWeekdays();
    const byService = new Map<string, StatTally>();
    const byProvider = new Map<string, StatTally>();
    const byPlan = new Map<string, StatTally>();
    const byStatus = new Map<string, StatTally>();
    const topServices = new Map<string, { requests: number; last: Date; service?: ServiceRow; provider?: ProviderRow }>();

    for (const r of requests) {
      const day = dayOf(r);
      const service = services.get(r.service_id);
      const provider = providers.get(r.provider_id);
      const estimate = this.estimateOf(r, service, currency);
      if (estimate != null) {
        totals.estimated += estimate;
        totals.estimatedFrom += 1;
      }
      if (r.status === 'completed') totals.completed += 1;
      else if (r.status === 'cancelled') totals.cancelled += 1;
      else if (r.status === 'declined') totals.declined += 1;
      else if (UNDER_WAY.has(r.status)) totals.underWay += 1;

      const finished = r.status === 'completed' ? this.completedAt(r) : null;
      if (finished) {
        totals.days += (finished.getTime() - r.created_at.getTime()) / 86_400_000;
        totals.finished += 1;
      }

      const point = points.get(bucketOf(day, period.grain, period.from));
      if (point) {
        point.amount += estimate ?? 0;
        point.count += 1;
      }
      const w = weekdays[weekdayOf(day)]!;
      w.amount += estimate ?? 0;
      w.count += 1;

      tallyInto(byService, r.service_id, service?.title ?? 'Service', r.id, estimate ?? 0, 0);
      tallyInto(byProvider, r.provider_id, provider?.name ?? 'Provider', r.id, estimate ?? 0, 0);
      const plan = detailsOf(r.details).plan?.trim();
      tallyInto(byPlan, plan ? plan.toLowerCase() : 'other', plan || 'No plan chosen', r.id, estimate ?? 0, 0);
      tallyInto(byStatus, r.status, STATUS_LABEL[r.status] ?? r.status, r.id, 0, 0);

      const seen = topServices.get(r.service_id);
      if (!seen) topServices.set(r.service_id, { requests: 1, last: r.created_at, service, provider });
      else {
        seen.requests += 1;
        if (r.created_at > seen.last) seen.last = r.created_at;
      }
    }
    for (const v of reviews) totals.stars += v.rating;

    const top = [...topServices.entries()].sort((a, b) => b[1].requests - a[1].requests).slice(0, TOP_ROWS);
    const images = await this.refsMap(top.map(([, t]) => (t.service?.image as { id?: string } | null)?.id), 'thumb');
    const topOut: ServiceStatService[] = top.map(([serviceId, t]): ServiceStatService => {
      const imageId = (t.service?.image as { id?: string } | null)?.id;
      return {
        serviceId,
        slug: t.service?.slug ?? null,
        title: t.service?.title ?? 'Service',
        image: imageId ? (images.get(imageId) ?? null) : null,
        provider: t.provider?.name ?? 'Provider',
        requests: t.requests,
        lastRequestedAt: t.last.toISOString(),
      };
    });

    const biggest = [...byProvider.entries()].sort((a, b) => b[1].records.size - a[1].records.size)[0];
    return {
      area: area ?? null,
      from: period.from,
      to: period.to,
      grain: period.grain,
      currency,
      totals: {
        requests: requests.length,
        completed: totals.completed,
        underWay: totals.underWay,
        cancelled: totals.cancelled,
        declined: totals.declined,
        services: byService.size,
        providers: byProvider.size,
        estimated: m(totals.estimated),
        estimatedFrom: totals.estimatedFrom,
        averageDays: average(totals.days, totals.finished),
        reviews: reviews.length,
        averageRating: average(totals.stars, reviews.length),
        topProvider: biggest
          ? { providerId: biggest[0], slug: providers.get(biggest[0])?.slug ?? null, name: biggest[1].label, requests: biggest[1].records.size }
          : null,
      },
      previous: period.all ? null : this.previous(period, all, dayOf, services, currency, requests.length),
      series: starts.map((s) => {
        const p = points.get(s)!;
        return { start: s, label: pointLabel(s, period.grain, period.years), amount: m(p.amount), secondary: null, count: p.count };
      }),
      byService: shares(byService, { total: requests.length, currency, by: 'count' }),
      byProvider: shares(byProvider, { total: requests.length, currency, by: 'count' }),
      byPlan: shares(byPlan, { total: requests.length, currency, by: 'count' }),
      byStatus: shares(byStatus, { total: requests.length, currency, by: 'count', top: 6 }),
      byWeekday: weekdayRows(weekdays, currency),
      topServices: topOut,
    };
  }

  /** The same number of days just before the period: requests and the estimate, counted the same way */
  private previous(period: StatPeriod, all: RequestRow[], dayOf: (r: { created_at: Date }) => string, services: Map<string, ServiceRow>, currency: string, now: number): common.StatPrevious {
    const { from, to } = previousPeriod(period);
    let amount = 0;
    let count = 0;
    for (const r of all) {
      const day = dayOf(r);
      if (day < from || day > to) continue;
      amount += this.estimateOf(r, services.get(r.service_id), currency) ?? 0;
      count += 1;
    }
    // The headline number is requests, so the change compares counts
    const prev = statPrevious(from, to, amount, count, now, currency);
    return { ...prev, changePct: count > 0 ? Math.round(((now - count) / count) * 1000) / 10 : null };
  }

  /**
   * What the price list said one request costs: the amount kept when it was made, else the service's price list
   * today (requests made before the estimate was kept). Null when the service charges by the hour.
   */
  private estimateOf(r: RequestRow, service: ServiceRow | undefined, currency: string): number | null {
    if (r.estimated_amount != null) return r.estimated_currency && r.estimated_currency !== currency ? null : r.estimated_amount;
    if (!service) return null;
    const fallback = requestEstimate(service, detailsOf(r.details).plan);
    return fallback && fallback.currency === currency ? fallback.amount : null;
  }

  /** When a completed request was completed, from its history */
  private completedAt(r: RequestRow): Date | null {
    const history = Array.isArray(r.history) ? (r.history as { status?: string; at?: string }[]) : [];
    const done = [...history].reverse().find((h) => h?.status === 'completed' && typeof h.at === 'string');
    const at = done?.at ? new Date(done.at) : null;
    return at && !Number.isNaN(at.getTime()) ? at : r.updated_at;
  }

  private async servicesOf(ids: string[]): Promise<Map<string, ServiceRow>> {
    const unique = [...new Set(ids)];
    if (!unique.length) return new Map();
    return new Map((await this.repo.servicesByIds(unique)).map((s) => [s.id, s]));
  }

  private async providersOf(ids: string[]): Promise<Map<string, ProviderRow>> {
    const unique = [...new Set(ids)];
    if (!unique.length) return new Map();
    return new Map((await this.repo.providersByIds(unique)).map((p) => [p.id, p]));
  }
}
