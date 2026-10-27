/**
 * Food delivery statistics (GET /api/store/food/statistics, the app's Statistics › Food tab): what the customer
 * spent on food in a period, the trend and the breakdowns, read from their food orders.
 *
 * The card is charged when an order is delivered, so spent counts delivered orders: the dishes and the delivery
 * fee. An order the customer cancelled or the restaurant declined is never charged and counts apart as
 * notDelivered; one still on its way counts in neither, but shows in byStatus. Orders still waiting for payment are
 * left out. Orders count by the market day and hour they were placed.
 */
import { dateInZone, hourInZone } from '../../../kernel/lib/clock.js';
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
import type { FoodStatDish, FoodStatHourBlock, FoodStatistics } from '../../../spec/food.js';
import type { ItemRow, OrderRow, ReviewRow, StoredOrderLine } from '../ports.js';
import { FoodOrders } from './orders.js';

/** Most orders read for one answer (a customer's whole food history in practice) */
const MAX_ORDERS = 5000;
/** Orders that never became a real order: they are not counted at all */
const UNPAID = new Set(['payment_pending', 'payment_failed']);
/** Never charged: counted apart from spent */
const NOT_DELIVERED = new Set(['cancelled', 'declined']);

const STATUS_LABEL: Record<string, string> = {
  placed: 'Waiting to be accepted',
  accepted: 'Accepted',
  preparing: 'Being prepared',
  on_the_way: 'On the way',
  delivered: 'Delivered',
  cancelled: 'Cancelled',
  declined: 'Declined',
};

/** Four-hour blocks, by the hour the order was placed */
const HOURS = [0, 4, 8, 12, 16, 20] as const;
const HOUR_LABEL = ['12 am', '4 am', '8 am', '12 pm', '4 pm', '8 pm'] as const;

/** Order lines as stored: plain minor-unit numbers and the picture's asset id */
const linesOf = (v: unknown): StoredOrderLine[] => (Array.isArray(v) ? (v as StoredOrderLine[]).filter((l) => l && typeof l.itemId === 'string') : []);

export class FoodStatisticsPart extends FoodOrders {
  async statisticsFor(customerId: string, q: PeriodQuery): Promise<FoodStatistics> {
    const today = dateInZone(this.now(), this.tz);
    const [ordersAll, reviewsAll] = await Promise.all([this.repo.customerOrders(customerId), this.repo.customerReviews(customerId)]);
    const counted = ordersAll
      .filter((o) => !UNPAID.has(o.status))
      // the id breaks a tie, so two orders placed in the same moment always come out in the same order
      .sort((a, b) => (a.placed_at ?? a.created_at).getTime() - (b.placed_at ?? b.created_at).getTime() || a.id.localeCompare(b.id))
      .slice(0, MAX_ORDERS);
    const placedAt = (o: OrderRow) => o.placed_at ?? o.created_at;
    const dayOf = (o: OrderRow) => dateInZone(placedAt(o), this.tz);
    const period = statPeriod(q, today, counted.length ? dayOf(counted[0]!) : today);

    const within = (d: string) => d >= period.from && d <= period.to;
    const orders = counted.filter((o) => within(dayOf(o)));
    const reviews = reviewsAll.filter((r) => within(dateInZone(r.created_at, this.tz)));
    const currency = orders[0]?.currency ?? counted[0]?.currency ?? this.currency;
    return this.report({ period, orders, reviews, currency, dayOf, placedAt, all: counted });
  }

  private async report(input: {
    period: StatPeriod;
    orders: OrderRow[];
    reviews: ReviewRow[];
    currency: string;
    dayOf: (o: OrderRow) => string;
    placedAt: (o: OrderRow) => Date;
    all: OrderRow[];
  }): Promise<FoodStatistics> {
    const { period, orders, reviews, currency, dayOf, placedAt, all } = input;
    const m = (amount: number): common.Money => money(amount, currency);
    const delivered = orders.filter((o) => o.status === 'delivered');

    const totals = { spent: 0, delivery: 0, dishesTotal: 0, notDelivered: 0, dishes: 0, minutes: 0, timed: 0, stars: 0 };
    let largest: { order: OrderRow; amount: number } | null = null;

    const starts = buckets(period.from, period.to, period.grain);
    const points = new Map(starts.map((s) => [s, { amount: 0, secondary: 0, count: 0 }]));
    const weekdays = emptyWeekdays();
    const hours = HOURS.map(() => ({ amount: 0, count: 0 }));
    const restaurants = new Map<string, StatTally>();
    const sections = new Map<string, StatTally>();
    const statuses = new Map<string, StatTally>();
    const dishes = new Map<string, { units: number; amount: number; last: Date; line: StoredOrderLine; restaurant: string }>();

    const sectionNames = await this.sectionNames(delivered);

    for (const o of orders) {
      const day = dayOf(o);
      const point = points.get(bucketOf(day, period.grain, period.from));
      tallyInto(statuses, o.status, STATUS_LABEL[o.status] ?? o.status, o.id, o.status === 'delivered' ? o.total : 0, 0);
      if (NOT_DELIVERED.has(o.status)) {
        totals.notDelivered += o.total;
        if (point) point.secondary += o.total;
        continue;
      }
      if (o.status !== 'delivered') continue; // on its way: not charged yet, and not a loss either

      totals.spent += o.total;
      totals.delivery += o.delivery_fee;
      totals.dishesTotal += o.subtotal;
      if (!largest || o.total > largest.amount) largest = { order: o, amount: o.total };
      if (o.delivered_at) {
        totals.minutes += (o.delivered_at.getTime() - placedAt(o).getTime()) / 60_000;
        totals.timed += 1;
      }
      if (point) {
        point.amount += o.total;
        point.count += 1;
      }
      const w = weekdays[weekdayOf(day)]!;
      w.amount += o.total;
      w.count += 1;
      const block = Math.floor(hourInZone(placedAt(o), this.tz) / 4);
      const h = hours[Math.min(Math.max(block, 0), hours.length - 1)]!;
      h.amount += o.total;
      h.count += 1;

      const name = this.restaurantName(o);
      const lines = linesOf(o.lines);
      const units = lines.reduce((s, l) => s + l.quantity, 0);
      totals.dishes += units;
      tallyInto(restaurants, o.restaurant_id, name, o.id, o.total, units);

      for (const l of lines) {
        const section = sectionNames.get(l.itemId);
        // Sections are each restaurant's own, so rows group by name: two restaurants' "Pizza" is one row
        tallyInto(sections, section ? section.name.toLowerCase() : 'other', section?.name ?? 'Other', o.id, l.total, l.quantity);
        const seen = dishes.get(l.itemId);
        const at = placedAt(o);
        if (!seen) dishes.set(l.itemId, { units: l.quantity, amount: l.total, last: at, line: l, restaurant: name });
        else {
          seen.units += l.quantity;
          seen.amount += l.total;
          if (at > seen.last) Object.assign(seen, { last: at, line: l, restaurant: name });
        }
      }
    }
    for (const r of reviews) totals.stars += r.stars;

    const top = [...dishes.entries()].sort((a, b) => b[1].amount - a[1].amount).slice(0, TOP_ROWS);
    const pictures = await this.refsMap(top.map(([, d]) => d.line.imageId), 'thumb');
    const topDishes: FoodStatDish[] = top.map(([itemId, d]): FoodStatDish => ({
      itemId,
      name: d.line.name,
      image: d.line.imageId ? (pictures.get(d.line.imageId) ?? null) : null,
      restaurant: d.restaurant,
      units: d.units,
      amount: m(d.amount),
      lastOrderedAt: d.last.toISOString(),
    }));

    const byHour: FoodStatHourBlock[] = HOURS.map((hour, i) => ({ hour, label: HOUR_LABEL[i]!, amount: m(hours[i]!.amount), count: hours[i]!.count }));

    return {
      from: period.from,
      to: period.to,
      grain: period.grain,
      currency,
      totals: {
        spent: m(totals.spent),
        delivery: m(totals.delivery),
        dishesTotal: m(totals.dishesTotal),
        notDelivered: m(totals.notDelivered),
        orders: delivered.length,
        dishes: totals.dishes,
        restaurants: new Set(delivered.map((o) => o.restaurant_id)).size,
        averageOrder: m(delivered.length ? Math.round(totals.spent / delivered.length) : 0),
        averageDeliveryMinutes: average(totals.minutes, totals.timed),
        reviews: reviews.length,
        averageRating: average(totals.stars, reviews.length),
        largestOrder: largest
          ? { orderId: largest.order.id, ref: largest.order.ref, restaurant: this.restaurantName(largest.order), placedAt: placedAt(largest.order).toISOString(), amount: m(largest.amount) }
          : null,
      },
      previous: period.all ? null : this.previous(period, all, dayOf, totals.spent, currency),
      series: starts.map((s) => {
        const p = points.get(s)!;
        return { start: s, label: pointLabel(s, period.grain, period.years), amount: m(p.amount), secondary: m(p.secondary), count: p.count };
      }),
      byRestaurant: shares(restaurants, { total: totals.spent, currency }),
      byMenuSection: shares(sections, { total: totals.dishesTotal, currency }),
      byStatus: shares(statuses, { total: orders.length, currency, by: 'count', top: 6 }),
      byWeekday: weekdayRows(weekdays, currency),
      byHour,
      topDishes,
    };
  }

  /** The same number of days just before the period: spent and delivered orders, counted the same way */
  private previous(period: StatPeriod, all: OrderRow[], dayOf: (o: OrderRow) => string, spent: number, currency: string): common.StatPrevious {
    const { from, to } = previousPeriod(period);
    let amount = 0;
    let count = 0;
    for (const o of all) {
      const day = dayOf(o);
      if (day < from || day > to || o.status !== 'delivered') continue;
      amount += o.total;
      count += 1;
    }
    return statPrevious(from, to, amount, count, spent, currency);
  }

  /** Each ordered item's menu section name; an item the restaurant has removed since has none (it counts as Other) */
  private async sectionNames(orders: OrderRow[]): Promise<Map<string, { id: string; name: string }>> {
    const itemIds = [...new Set(orders.flatMap((o) => linesOf(o.lines).map((l) => l.itemId)))];
    const out = new Map<string, { id: string; name: string }>();
    if (!itemIds.length) return out;
    const items: ItemRow[] = await this.repo.itemsByIds(itemIds);
    const sections = new Map((await this.repo.sectionsByIds([...new Set(items.map((i) => i.section_id))])).map((s) => [s.id, s.name]));
    for (const i of items) {
      const name = sections.get(i.section_id);
      if (name) out.set(i.id, { id: i.section_id, name });
    }
    return out;
  }

  /** The restaurant's name as it was at order time (the snapshot) */
  private restaurantName(o: OrderRow): string {
    const r = o.restaurant as { name?: string } | null;
    return typeof r?.name === 'string' && r.name ? r.name : 'Restaurant';
  }
}
