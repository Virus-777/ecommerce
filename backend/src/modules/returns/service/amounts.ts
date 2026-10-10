/**
 * Money facts from other modules: what was paid per order item (orders) and what is still refundable
 * (payments, the cap for every refund), and the itemised breakdown of a return refund.
 */
import { money } from '../../../kernel/lib/money.js';
import type * as common from '../../../spec/common.js';
import type { RefundBreakdown, RefundDeduction } from '../../../spec/returns.js';
import { computeBreakdown, type BreakdownResult, type PaidLine } from '../domain/rules.js';
import type { ItemRec, ReturnRec } from '../ports.js';
import type { Core } from './core.js';

export interface Remaining {
  items: Map<string, { paid: number; refunded: number; inFlight: number; remaining: number }>;
}

export class Amounts {
  constructor(private readonly core: Core) {}

  /** Paid amounts per order item (orders.getPaidAmounts) */
  async paidLines(orderId: string): Promise<Map<string, PaidLine>> {
    const rows = await this.core.ctx.use('orders').getPaidAmounts(orderId);
    return new Map(
      rows.map((r) => [
        r.orderItemId,
        { orderItemId: r.orderItemId, quantity: r.quantity, itemAmount: r.itemAmount.amount, discountShare: r.discountShare.amount, shippingShare: r.shippingShare.amount, taxShare: r.taxShare.amount, paid: r.paid.amount },
      ]),
    );
  }

  /**
   * What payments says is still refundable per item. strict: errors propagate (money decisions);
   * otherwise null when payments cannot answer (estimates and panels fall back to the paid amounts).
   */
  async remaining(orderId: string, orderItemIds: string[], strict: boolean): Promise<Remaining | null> {
    const call = () => this.core.ctx.use('payments').remainingRefundable(orderId, orderItemIds);
    const r = strict ? await call() : await this.core.quiet('remaining refundable', call);
    if (!r) return null;
    return { items: new Map(r.items.map((i) => [i.orderItemId, { paid: i.paid.amount, refunded: i.refunded.amount, inFlight: i.inFlight.amount, remaining: i.remaining.amount }])) };
  }

  async methodLabel(ret: ReturnRec): Promise<string> {
    const meta = ret.terms_snapshot.meta;
    if (ret.remedy === 'store_credit') return 'Marketly store credit';
    if (meta.paymentMethodLabel) return meta.paymentMethodLabel;
    const id = meta.paymentIntentId;
    const label = id ? await this.core.quiet('payment method label', () => this.core.ctx.use('payments').methodLabel(id)) : undefined;
    return label ?? 'Original payment method';
  }

  /** Breakdown of a return's refund from its items */
  async forReturn(
    ret: ReturnRec,
    items: ItemRec[],
    o: { deductions?: RefundDeduction[]; amount?: number | null; strict: boolean; withReturnShipping: boolean },
  ): Promise<BreakdownResult> {
    const paid = await this.paidLines(ret.order_id);
    const ids = items.map((i) => i.order_item_id);
    const rem = await this.remaining(ret.order_id, ids, o.strict);
    const meta = ret.terms_snapshot.meta;
    const fault = meta.reasonGroup !== 'change_of_mind';
    const com = ret.terms_snapshot.terms.responsibilities.find((r) => r.reasonGroup === meta.reasonGroup);
    return computeBreakdown({
      lines: items.map((i) => {
        const p = paid.get(i.order_item_id) ?? { orderItemId: i.order_item_id, quantity: i.quantity, itemAmount: i.unit_price * i.quantity, discountShare: 0, shippingShare: 0, taxShare: 0, paid: i.unit_price * i.quantity };
        return { paid: p, quantity: i.quantity, remaining: rem?.items.get(i.order_item_id)?.remaining ?? null };
      }),
      currency: items[0]?.currency ?? this.core.currency,
      originalShippingRefunded: com?.originalShippingRefunded ?? fault,
      returnShippingDeduction: o.withReturnShipping ? meta.customerFee : 0,
      deductions: o.deductions ?? [],
      amount: o.amount ?? null,
    });
  }

  breakdown(b: BreakdownResult, currency: string, deductions: RefundDeduction[], destination: string, isEstimate: boolean): RefundBreakdown {
    const m = (n: number) => money(n, currency);
    return {
      itemAmount: m(b.itemAmount),
      discountShare: m(b.discountShare),
      shippingRefund: m(b.shippingRefund),
      returnShippingDeduction: m(b.returnShippingDeduction),
      deductions,
      taxRefund: b.taxRefund > 0 ? m(b.taxRefund) : null,
      total: m(b.total),
      maxRefundable: m(b.maxRefundable),
      destination,
      isEstimate,
    };
  }

  /** Sum of money values in one currency */
  static sum(list: (common.Money | null | undefined)[], currency: string): common.Money {
    return money(
      list.reduce((s, m) => s + (m?.amount ?? 0), 0),
      currency,
    );
  }
}
