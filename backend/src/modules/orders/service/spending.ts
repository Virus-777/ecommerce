/**
 * The customer's spending statistics (GET /api/store/orders/spending, Android account/statistics): what they spent
 * in a period, its trend and breakdowns, read from their orders.
 *
 * Spent = what the customer paid for items not cancelled (price after discounts, plus their shipping and tax
 * shares, i.e. paid_amount) minus refunds on them. Cancelled items count apart, whether or not they had been
 * charged. Orders count by the market day they were placed; a refund counts on its order's day. Orders still
 * waiting for payment are left out.
 */
import { isAppError } from '../../../kernel/errors/index.js';
import { dateInZone } from '../../../kernel/lib/clock.js';
import { money } from '../../../kernel/lib/money.js';
import {
  bucketOf,
  buckets,
  pointLabel,
  previousPeriod,
  round1,
  statPeriod,
  weekdayOf,
  TOP_ROWS as TOP,
  WEEKDAYS,
  WEEKDAY_LABELS as WEEKDAY_LABEL,
  type StatPeriod,
  type StatRange,
} from '../../../kernel/lib/stats-period.js';
import type * as common from '../../../spec/common.js';
import type { CustomerSpending, SpendingProduct, SpendingShare, SpendingWeekday } from '../../../spec/orders.js';
import { dayStart, discountSum } from '../domain/rules.js';
import { type Agg, type Core } from './core.js';
import type { Views } from './views.js';

type Range = StatRange;
type Grain = CustomerSpending['grain'];

export interface SpendingQuery {
  range?: Range;
  from?: string;
  to?: string;
  grain?: Grain;
}

/** Most orders read for one answer (a customer's whole history in practice) */
const MAX_ORDERS = 5000;

/* ------------------------------------------------------------------ the part */

interface Tally {
  amount: number;
  orders: Set<string>;
  units: number;
  label: string;
}

export class Spending {
  constructor(
    private readonly core: Core,
    private readonly views: Views,
  ) {}

  async forCustomer(customerId: string | null, q: SpendingQuery): Promise<CustomerSpending> {
    const tz = this.core.tz;
    const today = this.core.today();
    const period = statPeriod(q, today, await this.firstDay(customerId, q, today));
    const { from, to, all, grain } = period;
    const orders = customerId ? await this.ordersIn(customerId, from, to) : [];
    const currency = orders[0]?.order.currency ?? this.core.ctx.config.market.currency;
    const m = (amount: number): common.Money => money(amount, currency);

    const totals = { spent: 0, refunded: 0, cancelled: 0, savings: 0, shipping: 0, tax: 0, orders: 0, units: 0 };
    let largest: { agg: Agg; amount: number } | null = null;
    const starts = buckets(from, to, grain);
    const points = new Map(starts.map((s) => [s, { spent: 0, refunded: 0, orders: 0 }]));
    const weekdays = WEEKDAYS.map(() => ({ amount: 0, orders: 0 }));
    const categories = new Map<string, Tally & { categoryId: string | null }>();
    const sellers = new Map<string, Tally>();
    const payments = new Map<string, Tally>();
    const products = new Map<string, { units: number; amount: number; last: Date; item: Agg['items'][number] }>();
    const tally = (map: Map<string, Tally>, key: string, label: string, orderId: string, amount: number, units: number) => {
      const t = map.get(key) ?? { amount: 0, orders: new Set<string>(), units: 0, label };
      t.amount += amount;
      t.units += units;
      if (amount > 0 || units > 0) t.orders.add(orderId);
      map.set(key, t);
    };
    const paths = await this.categoryRoots(orders.flatMap((a) => a.items.map((i) => i.category_id)));

    for (const agg of orders) {
      const o = agg.order;
      let spent = 0;
      let refunded = 0;
      let units = 0;
      for (const i of agg.items) {
        if (i.state === 'cancelled') {
          totals.cancelled += i.paid_amount;
          continue;
        }
        const net = Math.max(0, i.paid_amount - i.refunded_amount);
        spent += net;
        refunded += i.refunded_amount;
        units += i.quantity;
        totals.savings += discountSum(i.discounts);
        totals.shipping += i.shipping_share;
        totals.tax += i.tax_share;

        const root = i.category_id ? paths.get(i.category_id) : undefined;
        const ck = root?.id ?? 'uncategorized';
        const c = categories.get(ck) ?? { amount: 0, orders: new Set<string>(), units: 0, label: root?.name ?? 'Uncategorized', categoryId: root?.id ?? null };
        c.amount += net;
        c.units += i.quantity;
        c.orders.add(o.id);
        categories.set(ck, c);

        const g = agg.groups.find((x) => x.id === i.group_id);
        const seller = g ? this.views.sellerLabel(g) : null;
        tally(sellers, seller?.ownerType === 'official' ? 'official' : (seller?.id ?? seller?.name ?? 'unknown'), seller?.name ?? 'Seller', o.id, net, i.quantity);

        const p = products.get(i.product_id);
        if (!p) products.set(i.product_id, { units: i.quantity, amount: net, last: o.placed_at, item: i });
        else {
          p.units += i.quantity;
          p.amount += net;
          if (o.placed_at > p.last) Object.assign(p, { last: o.placed_at, item: i });
        }
      }
      if (units === 0) continue; // every item cancelled
      totals.spent += spent;
      totals.refunded += refunded;
      totals.units += units;
      totals.orders += 1;
      if (!largest || spent > largest.amount) largest = { agg, amount: spent };
      const day = dateInZone(o.placed_at, tz);
      const point = points.get(bucketOf(day, grain, from));
      if (point) Object.assign(point, { spent: point.spent + spent, refunded: point.refunded + refunded, orders: point.orders + 1 });
      const w = weekdays[weekdayOf(day)]!;
      w.amount += spent;
      w.orders += 1;
      tally(payments, o.payment_method_label || 'Other', o.payment_method_label || 'Other', o.id, spent, units);
    }

    const shares = (map: Map<string, Tally>): SpendingShare[] => {
      const rows = [...map.entries()].filter(([, t]) => t.amount > 0).sort((a, b) => b[1].amount - a[1].amount);
      const pct = (n: number) => (totals.spent > 0 ? round1((n / totals.spent) * 100) : 0);
      const row = (key: string, t: Tally): SpendingShare => ({ key, label: t.label, amount: m(t.amount), sharePct: pct(t.amount), orders: t.orders.size, units: t.units });
      if (rows.length <= TOP + 1) return rows.map(([k, t]) => row(k, t));
      const rest = rows.slice(TOP).reduce<Tally>((s, [, t]) => ({ amount: s.amount + t.amount, units: s.units + t.units, orders: new Set([...s.orders, ...t.orders]), label: 'Other' }), { amount: 0, units: 0, orders: new Set(), label: 'Other' });
      return [...rows.slice(0, TOP).map(([k, t]) => row(k, t)), row('other', rest)];
    };

    const top = [...products.entries()].filter(([, p]) => p.amount > 0).sort((a, b) => b[1].amount - a[1].amount).slice(0, TOP);
    const slugs = await this.core.productSlugs(top.map(([id]) => id));
    const topProducts: SpendingProduct[] = top.map(([id, p]) => ({
      productId: id,
      productSlug: slugs.get(id) ?? null,
      title: this.views.title(p.item),
      image: this.views.image(p.item),
      units: p.units,
      amount: m(p.amount),
      lastBoughtAt: p.last.toISOString(),
    }));

    const years = period.years;
    return {
      from,
      to,
      grain,
      currency,
      totals: {
        spent: m(totals.spent),
        refunded: m(totals.refunded),
        cancelled: m(totals.cancelled),
        savings: m(totals.savings),
        shipping: m(totals.shipping),
        tax: m(totals.tax),
        orders: totals.orders,
        units: totals.units,
        averageOrder: m(totals.orders ? Math.round(totals.spent / totals.orders) : 0),
        largestOrder: largest ? { orderId: largest.agg.order.id, ref: largest.agg.order.ref, placedAt: largest.agg.order.placed_at.toISOString(), amount: m(largest.amount) } : null,
      },
      previous: all || !customerId ? null : await this.previous(customerId, period, totals.spent, m),
      series: starts.map((s) => {
        const p = points.get(s)!;
        return { start: s, label: pointLabel(s, grain, years), spent: m(p.spent), refunded: m(p.refunded), orders: p.orders };
      }),
      byCategory: shares(categories),
      bySeller: shares(sellers),
      byPaymentMethod: shares(payments),
      byWeekday: weekdays.map((w, i): SpendingWeekday => ({ weekday: WEEKDAYS[i]!, label: WEEKDAY_LABEL[i]!, amount: m(w.amount), orders: w.orders })),
      topProducts,
    };
  }

  /** The market days asked for: from/to (both, at most 3 years), else the range (default last 12 months) */
  /** range=all starts at the customer's first counted order; every other range needs no lookup */
  private async firstDay(customerId: string | null, q: SpendingQuery, today: string): Promise<string | null> {
    if (q.from || q.to || q.range !== 'all' || !customerId) return null;
    const first = await this.core.repo.firstPaidOrderOf(customerId);
    return first ? dateInZone(first.placed_at, this.core.tz) : today;
  }

  /** The customer's orders placed from..to (market days), payment waiting left out */
  private async ordersIn(customerId: string, from: string, to: string): Promise<Agg[]> {
    const tz = this.core.tz;
    const f = { placedFrom: dayStart(from, tz), placedTo: dayStart(to, tz, true) };
    const out: Agg[] = [];
    let cursor: string | null = null;
    while (out.length < MAX_ORDERS) {
      const rows: common.Page<{ id: string }> = await this.core.repo.customerOrders(customerId, f, { mode: 'cursor', cursor, limit: 200 });
      const aggs = await this.core.loadMany(rows.items.map((r) => r.id));
      for (const r of rows.items) {
        const agg = aggs.get(r.id);
        if (agg && agg.order.lifecycle !== 'payment_pending') out.push(agg);
      }
      cursor = rows.nextCursor ?? null;
      if (!cursor) break;
    }
    return out;
  }

  /** The same number of days just before from: spent (same rules) and orders */
  private async previous(customerId: string, period: StatPeriod, spent: number, m: (n: number) => common.Money): Promise<CustomerSpending['previous']> {
    const { from: pFrom, to: pTo } = previousPeriod(period);
    let total = 0;
    let orders = 0;
    for (const agg of await this.ordersIn(customerId, pFrom, pTo)) {
      const kept = agg.items.filter((i) => i.state !== 'cancelled');
      if (!kept.length) continue;
      total += kept.reduce((s, i) => s + Math.max(0, i.paid_amount - i.refunded_amount), 0);
      orders += 1;
    }
    return { from: pFrom, to: pTo, spent: m(total), orders, changePct: total > 0 ? round1(((spent - total) / total) * 100) : null };
  }

  /** Each category's top-level category (id and name); catalog unavailable → none (the items count as Uncategorized) */
  private async categoryRoots(ids: (string | null)[]): Promise<Map<string, { id: string; name: string }>> {
    const unique = [...new Set(ids.filter((x): x is string => !!x))];
    const out = new Map<string, { id: string; name: string }>();
    if (!unique.length) return out;
    try {
      const paths = await this.core.ctx.use('catalog').getCategoryPaths(unique);
      for (const [id, p] of Object.entries(paths)) if (p.ids[0] && p.names[0]) out.set(id, { id: p.ids[0], name: p.names[0] });
    } catch (err) {
      if (!isAppError(err)) this.core.ctx.log.warn({ err }, 'orders: category names unavailable');
    }
    return out;
  }
}
