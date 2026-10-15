/**
 * Item-level cancellations: customer requests (seller confirms by respondBy or they are auto-accepted;
 * Official Store items are accepted at once until picking starts), seller "cannot fulfill" and staff
 * cancellations (accepted directly), withdrawals, declines and staff decisions. Every accepted cancellation
 * publishes orders.item.cancelled per item with the refund breakdown (payments sends it).
 */
import { AppError } from '../../../kernel/errors/index.js';
import type { EventPayload } from '../../../kernel/events/index.js';
import { money } from '../../../kernel/lib/money.js';
import { newId } from '../../../kernel/lib/ids.js';
import type { CancellableItem, CancellationLineInput, CancellationOptions, CancellationRequest, RefundPreview } from '../../../spec/orders.js';
import { cancellationRequestMachine } from '../domain/state-machines.js';
import { CANCELLABLE, fmt, is, marketlyFulfils, refundLines, respondBy, shortDate, SHIPPED_OR_LATER, sumMoney, type ItemState } from '../domain/rules.js';
import type { CancellationRec, GroupRec, ItemRec, StoredCancellationLine } from '../ports.js';
import type { OrdersRepository } from '../repository.js';
import { Batch, invalid, notFound, SYSTEM, type Agg, type By, type Core } from './core.js';
import { Views } from './views.js';

type Initiator = 'customer' | 'seller' | 'staff' | 'system';
interface Line {
  item: ItemRec;
  quantity: number;
}

const ALTERNATIVE: Partial<Record<ItemState, CancellableItem['alternative']>> = {
  shipped: 'refuse_delivery',
  delivered: 'return',
  return_requested: 'view_return',
  returned: 'view_return',
};
const REASON: Partial<Record<ItemState, string>> = {
  pending_payment: 'Payment is still being checked. You can cancel once it is accepted.',
  shipped: 'Already shipped. You can refuse the delivery or return it after it arrives.',
  delivered: 'Already delivered. You can return it instead.',
  return_requested: 'A return is already open for this item.',
  returned: 'Already returned.',
  refunded: 'Already refunded.',
  cancelled: 'Already cancelled.',
  cancellation_requested: 'Cancellation already requested.',
};

export class Cancellations {
  constructor(
    private readonly core: Core,
    private readonly views: Views,
  ) {}

  /* ---------------------------------------------------------------- validation and refunds */

  /** Checks the requested lines; throws the spec's errors (details per item) */
  resolve(agg: Agg, input: readonly CancellationLineInput[], o: { groupId?: string; customer?: boolean } = {}): Line[] {
    if (!input?.length) throw invalid([{ path: 'items', message: 'Choose at least one item' }]);
    const issues: { path: string; message: string }[] = [];
    const seen = new Set<string>();
    const blocked: { itemId: string; reason: string; alternative: string | null }[] = [];
    const lines: Line[] = [];
    input.forEach((l, idx) => {
      const item = agg.items.find((i) => i.id === l.itemId && (!o.groupId || i.group_id === o.groupId));
      if (!item) return issues.push({ path: `items[${idx}].itemId`, message: 'Not an item of this order' });
      if (seen.has(l.itemId)) return issues.push({ path: `items[${idx}].itemId`, message: 'Each item once' });
      seen.add(l.itemId);
      if (!(Number.isInteger(l.quantity) && l.quantity >= 1)) return issues.push({ path: `items[${idx}].quantity`, message: 'Quantity must be at least 1' });
      lines.push({ item, quantity: l.quantity });
    });
    if (issues.length) throw invalid(issues);
    for (const { item } of lines) {
      if (item.state === 'cancellation_requested') {
        const pending = agg.cancellations.find((c) => c.status === 'requested' && c.items.some((x) => x.itemId === item.id));
        if (o.customer) throw this.core.error('CANCELLATION_ALREADY_REQUESTED', 'A cancellation request already covers this item.', { cancellationId: pending?.id ?? null, itemId: item.id });
        blocked.push({ itemId: item.id, reason: 'A customer cancellation request covers this item; answer it instead.', alternative: null });
        continue;
      }
      if (agg.order.lifecycle !== 'open' || !is(CANCELLABLE, item.state)) {
        blocked.push({ itemId: item.id, reason: REASON[item.state as ItemState] ?? 'This item cannot be cancelled now.', alternative: ALTERNATIVE[item.state as ItemState] ?? null });
      }
    }
    if (blocked.length) throw this.core.error('CANCELLATION_NOT_ALLOWED', 'Some items cannot be cancelled now.', { items: blocked });
    for (const { item, quantity } of lines) {
      if (quantity > item.quantity) throw this.core.error('QUANTITY_EXCEEDS_REMAINING', `You can cancel at most ${item.quantity} of this item.`, { max: item.quantity, itemId: item.id });
    }
    return lines;
  }

  /** Refund estimate for lines of one group (shipping only when the whole group ends up cancelled before dispatch) */
  groupRefund(agg: Agg, group: GroupRec, lines: readonly Line[]): RefundPreview {
    const currency = agg.order.currency;
    const groupItems = agg.items.filter((i) => i.group_id === group.id);
    const covered = new Map(lines.map((l) => [l.item.id, l.quantity]));
    const wholeGroup =
      groupItems.every((i) => !is(SHIPPED_OR_LATER, i.state)) && groupItems.every((i) => i.state === 'cancelled' || covered.get(i.id) === i.quantity);
    const refundedShipping = agg.cancellations
      .filter((c) => c.group_id === group.id && c.status === 'accepted')
      .reduce((s, c) => s + c.refund_preview.shippingRefund.amount, 0);
    const previewLines = refundLines(
      lines.map((l) => ({ itemId: l.item.id, title: this.views.title(l.item), quantity: l.quantity, line: l.item })),
      currency,
      wholeGroup ? Math.max(0, group.shipping_total - refundedShipping) : null,
    );
    return this.preview(previewLines, agg);
  }

  preview(lines: RefundPreview['lines'], agg: Agg): RefundPreview {
    const c = agg.order.currency;
    return {
      lines,
      itemAmount: sumMoney(lines.map((l) => l.itemAmount), c),
      discountShare: sumMoney(lines.map((l) => l.discountShare), c),
      shippingRefund: sumMoney(lines.map((l) => l.shippingRefund), c),
      taxRefund: sumMoney(lines.map((l) => l.taxRefund), c),
      total: sumMoney(lines.map((l) => l.refund), c),
      destination: agg.order.payment_method_label,
      timingNote: Views.TIMING_NOTE,
      statusNote: Views.STATUS_NOTE,
    };
  }

  byGroup(lines: readonly Line[]): Map<string, Line[]> {
    const out = new Map<string, Line[]>();
    for (const l of lines) out.set(l.item.group_id, [...(out.get(l.item.group_id) ?? []), l]);
    return out;
  }

  /* ---------------------------------------------------------------- store */

  options(agg: Agg): CancellationOptions {
    const items: CancellableItem[] = agg.items.map((i) => {
      const g = agg.groups.find((x) => x.id === i.group_id)!;
      const eligible = agg.order.lifecycle === 'open' && is(CANCELLABLE, i.state);
      let refundEstimate = null;
      if (eligible) refundEstimate = this.groupRefund(agg, g, [{ item: i, quantity: i.quantity }]).total;
      return {
        itemId: i.id,
        title: this.views.title(i),
        variantLabel: this.views.variantLabel(i),
        image: this.views.image(i),
        sellerName: this.views.sellerLabel(g).name,
        quantity: i.quantity,
        maxQuantity: eligible ? i.quantity : 0,
        state: i.state,
        eligible,
        reason: eligible ? 'Not shipped yet. Free to cancel.' : (REASON[i.state as ItemState] ?? 'This item cannot be cancelled now.'),
        alternative: eligible ? null : (ALTERNATIVE[i.state as ItemState] ?? (i.state === 'shipped' ? 'track' : null)),
        refundEstimate,
      };
    });
    return { orderId: agg.order.id, orderRef: agg.order.ref, cutoffRule: 'You can cancel an item until its seller marks it shipped.', items, refundDestination: agg.order.payment_method_label };
  }

  previewFor(agg: Agg, input: readonly CancellationLineInput[]): RefundPreview {
    const lines = this.resolve(agg, input, { customer: true });
    const all: RefundPreview['lines'] = [];
    for (const [groupId, ls] of this.byGroup(lines)) all.push(...this.groupRefund(agg, agg.groups.find((g) => g.id === groupId)!, ls).lines);
    return this.preview(all, agg);
  }

  /** One request per seller group; Official Store items not yet picked are accepted at once */
  async request(orderId: string, input: { items: CancellationLineInput[]; reasonCode: string; note?: string | null }, by: By & { idempotencyKey?: string }): Promise<{ requests: CancellationRequest[] }> {
    const cfg = await this.core.cfg();
    const key = by.idempotencyKey ?? null;
    if (key) {
      const prior = await this.core.repo.find('cancellations', { order_id: orderId, idempotency_key: { op: 'is not', value: null } });
      const mine = prior.filter((c) => c.idempotency_key?.startsWith(`${key}:`));
      if (mine.length) return this.answer(orderId, mine.map((c) => c.id));
    }
    const ids = await this.core.write(
      orderId,
      by,
      async (tx, agg, batch) => {
        const lines = this.resolve(agg, input.items, { customer: true });
        const created: string[] = [];
        for (const [groupId, ls] of this.byGroup(lines)) {
          const group = agg.groups.find((g) => g.id === groupId)!;
          // Official Store and Fulfilled by Marketly groups: instant until warehouse picking starts, then the Order
          // Manager decides (decision D6); seller groups wait for the seller
          const instant = marketlyFulfils(group) && (cfg.officialCancelUntil !== 'picking_started' || ls.every((l) => l.item.state !== 'preparing'));
          const id = await this.createDirect(tx, batch, agg, group, ls, {
            initiatedBy: 'customer',
            reasonCode: input.reasonCode,
            reason: input.note ?? null,
            idempotencyKey: key ? `${key}:${groupId}` : null,
            pending: instant ? null : respondBy(this.core.now(), cfg.sellerCancellationResponse, this.core.tz),
          });
          created.push(id);
        }
        return created;
      },
      cfg,
    );
    return this.answer(orderId, ids);
  }

  private async answer(orderId: string, ids: string[]): Promise<{ requests: CancellationRequest[] }> {
    const agg = (await this.core.load(orderId))!;
    return { requests: ids.map((id) => this.views.cancellation(agg, agg.cancellations.find((c) => c.id === id)!)) };
  }

  async one(orderId: string, cancellationId: string): Promise<CancellationRequest> {
    const agg = await this.core.load(orderId);
    const c = agg?.cancellations.find((x) => x.id === cancellationId);
    if (!agg || !c) throw notFound('Cancellation');
    return this.views.cancellation(agg, c);
  }

  /**
   * Creates a cancellation for some lines of one group: `pending` (a respondBy) makes it a customer request
   * waiting for the seller; otherwise it is accepted at once.
   */
  private async createDirect(
    tx: OrdersRepository,
    batch: Batch,
    agg: Agg,
    group: GroupRec,
    lines: Line[],
    o: { initiatedBy: Initiator; reasonCode: string; reason: string | null; idempotencyKey: string | null; pending: Date | null; trustReportId?: string | null; countsAgainstSeller?: boolean; notifyCustomer?: boolean },
  ): Promise<string> {
    const now = this.core.now();
    const id = newId();
    const refund = this.groupRefund(agg, group, lines);
    const stored: StoredCancellationLine[] = [];
    const acted: ItemRec[] = [];
    for (const l of lines) {
      const { part } = await this.core.split(tx, batch, l.item, l.quantity, agg.order.currency, 'cancellation');
      stored.push({ itemId: part.id, title: this.views.title(part), variantLabel: this.views.variantLabel(part), quantity: l.quantity, shipped: false });
      acted.push(part);
    }
    await tx.insert('cancellations', {
      id,
      order_id: agg.order.id,
      group_id: group.id,
      initiated_by: o.initiatedBy,
      reason_code: o.reasonCode,
      reason: o.reason,
      items: stored,
      status: o.pending ? 'requested' : cancellationRequestMachine.next('requested', 'accept'),
      respond_by: o.pending,
      decided_by: o.pending ? null : batch.by.actor,
      decided_at: o.pending ? null : now,
      decline_reason: null,
      refund_preview: refund,
      refund_status: o.pending ? 'none' : refund.total.amount > 0 ? 'requested' : 'none',
      payment_refund_id: null,
      idempotency_key: o.idempotencyKey,
      created_at: now,
    });
    const titles = stored.map((s) => `${s.title}${s.quantity > 1 ? ` × ${s.quantity}` : ''}`).join(', ');
    if (o.pending) {
      for (const item of acted) await this.core.move(tx, batch, item, 'request_cancellation', { reason: o.reasonCode, patch: { state_before_request: item.state } });
      const byMarketly = marketlyFulfils(group);
      await this.core.timeline(tx, agg.order.id, [
        {
          group_id: group.id,
          visibility: 'customer',
          label: 'Cancellation requested',
          detail: byMarketly
            ? `${titles}. Our warehouse has started on this package; Marketly will confirm by ${shortDate(o.pending, this.core.tz)}.`
            : `${titles}. ${group.seller_name} has until ${shortDate(o.pending, this.core.tz)} to confirm.`,
          actor: batch.by.actor,
        },
        byMarketly
          ? { group_id: group.id, visibility: 'seller', label: 'Buyer asked to cancel', detail: `${titles}. Marketly's Order Manager decides, as the warehouse has started on this package.`, actor: batch.by.actor }
          : { group_id: group.id, visibility: 'seller', label: 'Buyer asked to cancel', detail: `${titles}. Respond by ${o.pending.toISOString()} or it is accepted automatically if nothing has shipped.`, actor: batch.by.actor },
      ]);
      batch.push('orders.cancellation.requested', {
        cancellationId: id,
        orderId: agg.order.id,
        groupId: group.id,
        sellerId: group.seller_id,
        fulfilledBy: group.fulfilled_by as EventPayload<'orders.cancellation.requested'>['fulfilledBy'],
        itemIds: stored.map((s) => s.itemId),
        respondBy: o.pending.toISOString(),
      });
      return id;
    }
    for (const item of acted) await this.core.move(tx, batch, item, 'cancel', { reason: o.reasonCode, patch: { refund_status: refund.total.amount > 0 ? 'requested' : item.refund_status } });
    if (o.initiatedBy === 'customer') batch.push('orders.cancellation.decided', { cancellationId: id, orderId: agg.order.id, ...this.core.recipient(agg.order), outcome: 'accepted', by: batch.by.actor });
    await this.afterAccepted(tx, batch, agg, group, id, stored, refund, {
      initiatedBy: o.initiatedBy,
      reasonCode: o.reasonCode,
      trustReportId: o.trustReportId ?? null,
      countsAgainstSeller: o.countsAgainstSeller ?? false,
      notifyCustomer: o.notifyCustomer ?? true,
      label: o.initiatedBy === 'customer' ? 'Items cancelled at your request' : o.initiatedBy === 'seller' ? `${group.seller_name} cancelled items` : 'Items cancelled by Marketly',
      detail: titles,
      reason: o.reason,
    });
    return id;
  }

  /** Item events, credit note and timeline for an accepted cancellation */
  private async afterAccepted(
    tx: OrdersRepository,
    batch: Batch,
    agg: Agg,
    group: GroupRec,
    cancellationId: string,
    lines: readonly StoredCancellationLine[],
    refund: RefundPreview,
    o: { initiatedBy: Initiator; reasonCode: string; trustReportId: string | null; countsAgainstSeller: boolean; notifyCustomer?: boolean; label: string; detail: string; reason: string | null },
  ) {
    for (const l of lines) {
      const item = (await tx.get('order_items', l.itemId))!;
      const line = refund.lines.find((x) => x.itemId === l.itemId);
      const zero = money(0, agg.order.currency);
      batch.push('orders.item.cancelled', {
        orderId: agg.order.id,
        ref: agg.order.ref,
        ...this.core.recipient(agg.order),
        groupId: group.id,
        ownerType: group.owner_type as 'official' | 'seller',
        sellerId: group.seller_id,
        fulfilledBy: group.fulfilled_by as EventPayload<'orders.item.cancelled'>['fulfilledBy'],
        itemId: item.id,
        offerId: item.offer_id,
        stockItemId: item.stock_item_id,
        quantity: l.quantity,
        cancellationId,
        initiatedBy: o.initiatedBy,
        reasonCode: o.reasonCode,
        beforeDispatch: true,
        countsAgainstSeller: o.countsAgainstSeller,
        notifyCustomer: o.notifyCustomer ?? true,
        refund: line
          ? { itemAmount: line.itemAmount, discountShare: line.discountShare, shippingRefund: line.shippingRefund, taxRefund: line.taxRefund, total: line.refund }
          : { itemAmount: zero, discountShare: zero, shippingRefund: zero, taxRefund: zero, total: zero },
        paymentIntentId: agg.order.payment_intent_id,
        trustReportId: o.trustReportId,
      });
    }
    if (refund.total.amount > 0) {
      const n = (await tx.count('documents', { order_id: agg.order.id, kind: 'credit_note' })) + 1;
      await tx.insert('documents', { id: newId(), order_id: agg.order.id, group_id: group.id, kind: 'credit_note', number: `${agg.order.ref}-C${n}`, issued_at: this.core.now() });
    }
    const refundText = refund.total.amount > 0 ? ` Refund of ${fmt(refund.total.amount, agg.order.currency)} requested to ${refund.destination}; no money has moved yet.` : '';
    await this.core.timeline(tx, agg.order.id, [
      { group_id: group.id, visibility: 'customer', label: o.label, detail: `${o.detail}.${refundText}`, actor: batch.by.actor },
      { group_id: group.id, visibility: 'seller', label: 'Items cancelled', detail: o.detail, actor: batch.by.actor },
      ...(o.reason && batch.by.actor.kind === 'staff' ? [{ group_id: group.id, visibility: 'staff' as const, label: 'Staff cancelled items', detail: o.detail, reason: o.reason, actor: batch.by.actor }] : []),
    ]);
  }

  /** requested → accepted (seller, staff or auto) or declined → accepted (staff override) */
  async accept(orderId: string, cancellationId: string, by: By, o: { outcome: 'accepted' | 'auto_accepted'; reason?: string | null; groupId?: string; bySeller?: boolean }): Promise<CancellationRequest> {
    await this.core.write(orderId, by, async (tx, agg, batch) => {
      const c = agg.cancellations.find((x) => x.id === cancellationId && (!o.groupId || x.group_id === o.groupId));
      if (!c) throw notFound('Cancellation');
      if (o.bySeller) this.core.refuseMarketly(agg.groups.find((g) => g.id === c.group_id)!, 'answer its cancellation requests');
      if (c.status === 'accepted') return; // already accepted: idempotent
      const event = c.status === 'declined' ? 'staff_override' : o.outcome === 'auto_accepted' ? 'auto_accept' : 'accept';
      const status = cancellationRequestMachine.next(c.status as 'requested', event as 'accept');
      const group = agg.groups.find((g) => g.id === c.group_id)!;
      const items = c.items.map((l) => agg.items.find((i) => i.id === l.itemId)!).filter(Boolean);
      // refund recomputed now: the group may have changed since the request
      const refund = this.groupRefund(
        agg,
        group,
        items.map((i) => ({ item: i, quantity: i.quantity })),
      );
      for (const item of items) {
        if (item.state === 'cancellation_requested') await this.core.move(tx, batch, item, 'accept_cancellation', { reason: c.reason_code, patch: { state_before_request: null, refund_status: refund.total.amount > 0 ? 'requested' : item.refund_status } });
        else await this.core.move(tx, batch, item, 'cancel', { reason: o.reason ?? c.reason_code, patch: { refund_status: refund.total.amount > 0 ? 'requested' : item.refund_status } });
      }
      await tx.update('cancellations', c.id, { status, decided_by: by.actor, decided_at: this.core.now(), refund_preview: refund, refund_status: refund.total.amount > 0 ? 'requested' : 'none' });
      batch.push('orders.cancellation.decided', { cancellationId: c.id, orderId, ...this.core.recipient(agg.order), outcome: o.outcome, by: by.actor });
      await this.afterAccepted(tx, batch, agg, group, c.id, c.items, refund, {
        initiatedBy: c.initiated_by as Initiator,
        reasonCode: c.reason_code,
        trustReportId: null,
        countsAgainstSeller: false,
        label: o.outcome === 'auto_accepted' ? 'Cancellation accepted automatically' : 'Cancellation accepted',
        detail: c.items.map((l) => l.title).join(', '),
        reason: o.reason ?? null,
      });
    });
    return this.one(orderId, cancellationId);
  }

  /** requested → declined: items go back to the state they had (a decline because of shipment needs a tracked shipment) */
  async decline(orderId: string, cancellationId: string, by: By, o: { reason: string; note?: string | null; groupId?: string; byStaff?: boolean; bySeller?: boolean }): Promise<CancellationRequest> {
    await this.core.write(orderId, by, async (tx, agg, batch) => {
      const c = agg.cancellations.find((x) => x.id === cancellationId && (!o.groupId || x.group_id === o.groupId));
      if (!c) throw notFound('Cancellation');
      if (o.bySeller) this.core.refuseMarketly(agg.groups.find((g) => g.id === c.group_id)!, 'answer its cancellation requests');
      const status = cancellationRequestMachine.next(c.status as 'requested', 'decline');
      if (o.reason === 'already_shipped') {
        const itemIds = new Set(c.items.map((l) => l.itemId));
        const tracked = agg.shipments.some(
          (s) => s.group_id === c.group_id && s.tracking_number && (s.item_ids.some((id) => itemIds.has(id)) || agg.items.some((i) => itemIds.has(i.id) && i.shipment_id === s.shipment_id)),
        );
        if (!tracked) throw this.core.error('SHIPMENT_REQUIRED', 'Record the shipment with its tracking number before declining because it shipped.');
      }
      await this.restore(tx, batch, agg, c, 'decline_cancellation');
      const reasonText = o.reason === 'already_shipped' ? 'Already shipped' : (o.note ?? o.reason);
      await tx.update('cancellations', c.id, { status, decided_by: by.actor, decided_at: this.core.now(), decline_reason: [reasonText, o.note && o.reason === 'already_shipped' ? o.note : null].filter(Boolean).join(': ') });
      batch.push('orders.cancellation.decided', { cancellationId: c.id, orderId, ...this.core.recipient(agg.order), outcome: 'declined', by: by.actor });
      await this.core.timeline(tx, orderId, [
        {
          group_id: c.group_id,
          visibility: 'customer',
          label: 'Cancellation declined',
          detail: o.reason === 'already_shipped' ? 'The items had already shipped. You can refuse the delivery or return them after they arrive.' : 'The seller could not cancel these items. Contact support if you need help.',
          actor: by.actor,
        },
        { group_id: c.group_id, visibility: 'seller', label: 'Cancellation declined', detail: reasonText, actor: by.actor },
        ...(o.byStaff ? [{ group_id: c.group_id, visibility: 'staff' as const, label: 'Staff declined a cancellation', reason: o.note ?? o.reason, actor: by.actor }] : []),
      ]);
    });
    return this.one(orderId, cancellationId);
  }

  async withdraw(orderId: string, cancellationId: string, by: By): Promise<CancellationRequest> {
    await this.core.write(orderId, by, async (tx, agg, batch) => {
      const c = agg.cancellations.find((x) => x.id === cancellationId);
      if (!c) throw notFound('Cancellation');
      const status = cancellationRequestMachine.next(c.status as 'requested', 'withdraw');
      await this.restore(tx, batch, agg, c, 'decline_cancellation');
      await tx.update('cancellations', c.id, { status, decided_by: by.actor, decided_at: this.core.now() });
      batch.push('orders.cancellation.decided', { cancellationId: c.id, orderId, ...this.core.recipient(agg.order), outcome: 'withdrawn', by: by.actor });
      await this.core.timeline(tx, orderId, [
        { group_id: c.group_id, visibility: 'customer', label: 'Cancellation request withdrawn', detail: 'The items continue as normal.', actor: by.actor },
        { group_id: c.group_id, visibility: 'seller', label: 'Buyer withdrew the cancellation request', actor: by.actor },
      ]);
    });
    return this.one(orderId, cancellationId);
  }

  /** Items under a request go back to the state held before it */
  private async restore(tx: OrdersRepository, batch: Batch, agg: Agg, c: CancellationRec, event: 'decline_cancellation') {
    for (const l of c.items) {
      const item = agg.items.find((i) => i.id === l.itemId);
      if (!item || item.state !== 'cancellation_requested') continue;
      await this.core.move(tx, batch, item, event, { to: item.state_before_request ?? 'confirmed', patch: { state_before_request: null } });
    }
  }

  /** Seller cannot fulfill: accepted directly, counts toward the seller's cancellation rate */
  async sellerCancel(orderId: string, groupId: string, input: { items: CancellationLineInput[]; reasonCode: string; note?: string | null }, by: By & { idempotencyKey?: string }): Promise<CancellationRequest> {
    const key = by.idempotencyKey ? `${by.idempotencyKey}:${groupId}` : null;
    if (key) {
      const prior = (await this.core.repo.find('cancellations', { order_id: orderId, idempotency_key: key }))[0];
      if (prior) return this.one(orderId, prior.id);
    }
    const id = await this.core.write(orderId, by, async (tx, agg, batch) => {
      const group = agg.groups.find((g) => g.id === groupId)!;
      this.core.refuseMarketly(group, 'cancel its items');
      const lines = this.resolve(agg, input.items, { groupId });
      // shipping voids a label only when its whole parcel is cancelled: the seller voids it first
      const onLabel = lines.filter((l) => this.views.onUnusedLabel(agg, l.item.id));
      if (onLabel.length) {
        throw this.core.error('CANCELLATION_NOT_ALLOWED', 'Some items are on a shipping label. Void the label first, then cancel the items.', {
          items: onLabel.map((l) => ({ itemId: l.item.id, reason: 'This item is on a shipping label the carrier does not have yet. Void the label first.', alternative: null })),
        });
      }
      return this.createDirect(tx, batch, agg, group, lines, { initiatedBy: 'seller', reasonCode: input.reasonCode, reason: input.note ?? null, idempotencyKey: key, pending: null, countsAgainstSeller: true });
    });
    return this.one(orderId, id);
  }

  /** Staff cancellation of unshipped items, one accepted cancellation per group */
  async staffCancel(
    orderId: string,
    input: { items: CancellationLineInput[]; reasonCode: string; reason: string; notifyCustomer: boolean; trustReportId?: string | null },
    by: By & { idempotencyKey?: string },
  ): Promise<{ requests: CancellationRequest[] }> {
    if (!input.reason?.trim()) throw invalid([{ path: 'reason', message: 'Give a reason' }]);
    const key = by.idempotencyKey ?? null;
    if (key) {
      const prior = (await this.core.repo.find('cancellations', { order_id: orderId, idempotency_key: { op: 'is not', value: null } })).filter((c) => c.idempotency_key?.startsWith(`${key}:`));
      if (prior.length) return this.answer(orderId, prior.map((c) => c.id));
    }
    const counts = ['seller_cannot_fulfill', 'overdue_dispatch'].includes(input.reasonCode);
    const ids = await this.core.write(orderId, by, async (tx, agg, batch) => {
      const lines = this.resolve(agg, input.items);
      const out: string[] = [];
      for (const [groupId, ls] of this.byGroup(lines)) {
        const group = agg.groups.find((g) => g.id === groupId)!;
        out.push(
          await this.createDirect(tx, batch, agg, group, ls, {
            initiatedBy: 'staff',
            reasonCode: input.reasonCode,
            reason: input.reason,
            idempotencyKey: key ? `${key}:${groupId}` : null,
            pending: null,
            trustReportId: input.trustReportId ?? null,
            countsAgainstSeller: counts,
            notifyCustomer: input.notifyCustomer !== false,
          }),
        );
      }
      return out;
    });
    return this.answer(orderId, ids);
  }

  /** Job orders.auto-accept-cancellations: requests past respondBy with nothing shipped */
  async autoAccept(): Promise<{ accepted: number }> {
    let accepted = 0;
    const due = await this.core.repo.dueCancellationRequests(this.core.now(), 200);
    for (const c of due) {
      const items = await this.core.repo.find('order_items', { id: c.items.map((l) => l.itemId) });
      if (!items.length || items.some((i) => i.state !== 'cancellation_requested')) continue;
      try {
        await this.accept(c.order_id, c.id, { actor: SYSTEM }, { outcome: 'auto_accepted' });
        accepted++;
      } catch (err) {
        if (!(err instanceof AppError)) throw err;
        this.core.ctx.log.warn({ err, cancellationId: c.id }, 'orders: auto-accept skipped');
      }
    }
    return { accepted };
  }
}
