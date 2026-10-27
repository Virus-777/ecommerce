/**
 * Farm machine statistics (GET /api/store/farm/statistics, the app's Statistics › Farm tab): what the customer's
 * machines cost in a period, the trend and the breakdowns, read from their farm orders.
 *
 * Spent = the machine, its attachments and delivery of every order the dealer has not rejected and the customer has
 * not cancelled, whether or not the card has been charged yet: a pay-on-delivery order counts in full while only its
 * deposit is paid, and depositsPaid and dueOnDelivery split it. Cancelled and rejected orders count apart. Orders
 * still waiting for payment are left out. Orders count by the market day they were placed.
 */
import { isAppError } from '../../../kernel/errors/index.js';
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
import type { FarmStatistics, FarmStatMachine, OrderAttachment, OrderMachine } from '../../../spec/farm.js';
import type { OrderRow } from '../ports.js';
import { FarmOrders } from './orders.js';

/** Most orders read for one answer (a customer's whole farm history in practice) */
const MAX_ORDERS = 2000;
/** Orders that never became a real order: they are not counted at all */
const UNPAID = new Set(['payment_pending', 'payment_failed']);
/** The dealer or the customer called it off: counted apart from spent */
const DROPPED = new Set(['cancelled', 'rejected']);

const PAYMENT_LABEL: Record<string, string> = { pay_in_full: 'Pay in full', installments: 'Installments', pay_on_delivery: 'Pay on delivery' };

const machineOf = (v: unknown): OrderMachine | null => {
  const m = v as OrderMachine | null;
  return m && typeof m === 'object' && typeof m.productId === 'string' ? m : null;
};
const attachmentsOf = (v: unknown): OrderAttachment[] => (Array.isArray(v) ? (v as OrderAttachment[]).filter((a) => a && typeof a.productId === 'string') : []);

export class FarmStatisticsPart extends FarmOrders {
  async statisticsFor(customerId: string, q: PeriodQuery): Promise<FarmStatistics> {
    const today = this.today();
    const all = await this.countedOrders(customerId);
    const dayOf = (o: OrderRow) => dateInZone(o.placed_at ?? o.created_at, this.tz);
    const period = statPeriod(q, today, all.length ? dayOf(all[0]!) : today);
    const inPeriod = all.filter((o) => {
      const day = dayOf(o);
      return day >= period.from && day <= period.to;
    });
    const currency = inPeriod[0]?.currency ?? all[0]?.currency ?? this.currency;
    return this.report(period, inPeriod, currency, dayOf, all);
  }

  /** The customer's orders that became real orders, oldest first */
  private async countedOrders(customerId: string): Promise<OrderRow[]> {
    const rows = await this.repo.customerOrders(customerId);
    return rows
      .filter((o) => !UNPAID.has(o.status))
      // the id breaks a tie, so two orders placed in the same moment always come out in the same order
      .sort((a, b) => (a.placed_at ?? a.created_at).getTime() - (b.placed_at ?? b.created_at).getTime() || a.id.localeCompare(b.id))
      .slice(0, MAX_ORDERS);
  }

  private async report(period: StatPeriod, orders: OrderRow[], currency: string, dayOf: (o: OrderRow) => string, all: OrderRow[]): Promise<FarmStatistics> {
    const m = (amount: number): common.Money => money(amount, currency);
    const kept = orders.filter((o) => !DROPPED.has(o.status));

    const totals = { spent: 0, cancelled: 0, delivery: 0, attachments: 0, depositsPaid: 0, dueOnDelivery: 0, machines: 0, attachmentCount: 0 };
    let largest: { order: OrderRow; amount: number } | null = null;
    let deliveredDays = 0;
    let delivered = 0;

    const starts = buckets(period.from, period.to, period.grain);
    const points = new Map(starts.map((s) => [s, { amount: 0, secondary: 0, count: 0 }]));
    const weekdays = emptyWeekdays();
    const types = new Map<string, StatTally>();
    const dealers = new Map<string, StatTally>();
    const payments = new Map<string, StatTally>();
    const machines = new Map<string, { units: number; amount: number; last: Date; machine: OrderMachine }>();

    const typeNames = await this.machineTypes(kept);

    for (const o of orders) {
      const day = dayOf(o);
      const point = points.get(bucketOf(day, period.grain, period.from));
      const dropped = DROPPED.has(o.status);
      if (dropped) {
        totals.cancelled += o.total;
        if (point) point.secondary += o.total;
        continue;
      }
      const delivery = Math.max(0, o.total - o.machine_price - o.attachments_total);
      totals.spent += o.total;
      totals.delivery += delivery;
      totals.attachments += o.attachments_total;
      totals.machines += 1;
      const atts = attachmentsOf(o.attachments);
      totals.attachmentCount += atts.length;
      if (o.payment_option === 'pay_on_delivery') {
        if (o.captured) totals.depositsPaid += o.card_amount;
        totals.dueOnDelivery += Math.max(0, o.total - o.card_amount);
      }
      if (!largest || o.total > largest.amount) largest = { order: o, amount: o.total };
      if (o.delivered_at && o.placed_at) {
        deliveredDays += (o.delivered_at.getTime() - o.placed_at.getTime()) / 86_400_000;
        delivered += 1;
      }
      if (point) {
        point.amount += o.total;
        point.count += 1;
      }
      const w = weekdays[weekdayOf(day)]!;
      w.amount += o.total;
      w.count += 1;

      const machine = machineOf(o.machine);
      const type = machine ? typeNames.get(machine.productId) : undefined;
      tallyInto(types, type?.typeId ?? 'other', type?.typeName ?? 'Other machines', o.id, o.total, 1);
      tallyInto(dealers, o.dealer_id, this.dealerName(o), o.id, o.total, 1);
      tallyInto(payments, o.payment_option, PAYMENT_LABEL[o.payment_option] ?? o.payment_option, o.id, o.total, 1);

      if (machine) {
        const placed = o.placed_at ?? o.created_at;
        const seen = machines.get(machine.productId);
        if (!seen) machines.set(machine.productId, { units: 1, amount: o.machine_price, last: placed, machine });
        else {
          seen.units += 1;
          seen.amount += o.machine_price;
          if (placed > seen.last) Object.assign(seen, { last: placed, machine });
        }
      }
    }

    const topMachines: FarmStatMachine[] = [...machines.entries()]
      .sort((a, b) => b[1].amount - a[1].amount)
      .slice(0, TOP_ROWS)
      .map(([productId, p]): FarmStatMachine => ({
        productId,
        productSlug: p.machine.slug ?? null,
        title: p.machine.title,
        image: p.machine.image ?? null,
        orders: p.units,
        amount: m(p.amount),
        lastOrderedAt: p.last.toISOString(),
      }));

    return {
      from: period.from,
      to: period.to,
      grain: period.grain,
      currency,
      totals: {
        spent: m(totals.spent),
        cancelled: m(totals.cancelled),
        delivery: m(totals.delivery),
        attachments: m(totals.attachments),
        depositsPaid: m(totals.depositsPaid),
        dueOnDelivery: m(totals.dueOnDelivery),
        orders: kept.length,
        machines: totals.machines,
        attachmentCount: totals.attachmentCount,
        averageOrder: m(kept.length ? Math.round(totals.spent / kept.length) : 0),
        averageDeliveryDays: average(deliveredDays, delivered),
        largestOrder: largest
          ? { orderId: largest.order.id, ref: largest.order.ref, placedAt: (largest.order.placed_at ?? largest.order.created_at).toISOString(), amount: m(largest.amount) }
          : null,
      },
      previous: period.all ? null : this.previous(period, all, dayOf, totals.spent, currency),
      series: starts.map((s) => {
        const p = points.get(s)!;
        return { start: s, label: pointLabel(s, period.grain, period.years), amount: m(p.amount), secondary: m(p.secondary), count: p.count };
      }),
      byMachineType: shares(types, { total: totals.spent, currency }),
      byDealer: shares(dealers, { total: totals.spent, currency }),
      byPaymentOption: shares(payments, { total: totals.spent, currency, top: 3 }),
      byWeekday: weekdayRows(weekdays, currency),
      topMachines,
    };
  }

  /** The same number of days just before the period: spent and orders, counted the same way */
  private previous(period: StatPeriod, all: OrderRow[], dayOf: (o: OrderRow) => string, spent: number, currency: string): common.StatPrevious {
    const { from, to } = previousPeriod(period);
    let amount = 0;
    let count = 0;
    for (const o of all) {
      const day = dayOf(o);
      if (day < from || day > to || DROPPED.has(o.status)) continue;
      amount += o.total;
      count += 1;
    }
    return statPrevious(from, to, amount, count, spent, currency);
  }

  /** The department's machine type per product; departments off or the machine no longer picked → none (Other) */
  private async machineTypes(orders: OrderRow[]): Promise<Map<string, { typeId: string; typeName: string }>> {
    const ids = [...new Set(orders.map((o) => machineOf(o.machine)?.productId).filter((id): id is string => Boolean(id)))];
    const out = new Map<string, { typeId: string; typeName: string }>();
    if (!ids.length) return out;
    const api = this.departments;
    if (!api) return out;
    try {
      for (const [productId, type] of Object.entries(await api.farmMachineTypes(ids))) out.set(productId, type);
    } catch (err) {
      if (!isAppError(err)) this.ctx.log.warn({ err }, 'farm: machine types unavailable');
    }
    return out;
  }

  /** The dealer's name as it was at order time (the snapshot), else the id */
  private dealerName(o: OrderRow): string {
    const d = o.dealer as { name?: string } | null;
    return typeof d?.name === 'string' && d.name ? d.name : 'Dealer';
  }
}
