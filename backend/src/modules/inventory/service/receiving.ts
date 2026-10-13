/**
 * Incoming stock from purchase orders and the confirmation of received deliveries (Incoming → Available / Damaged
 * or held).
 */
import { inventoryError } from '../errors.js';
import { newId } from '../../../kernel/lib/ids.js';
import type { PageRequest } from '../../../kernel/lib/pagination.js';
import type * as common from '../../../spec/common.js';
import type { ConfirmInboundRequest, InboundReceipt, MovementRef } from '../../../spec/inventory.js';
import { inboundConfirmationMachine } from '../domain/state-machines.js';
import { addDays, onHand, weightedAverage } from '../domain/rules.js';
import { actorText, SYSTEM_ACTOR, receiptSourceOf } from '../mappers.js';
import type { Row } from '../ports.js';
import { StockTx } from '../stock-tx.js';
import { DEFAULT_HOLD_REVIEW_DAYS, invalid, notFound, type StaffBy, type Core } from './core.js';

export class Receiving {
  constructor(private readonly core: Core) {}

  /** Adds Incoming when a purchase order is sent; repeated calls replace the open quantities for that PO */
  async expectIncoming(purchaseOrderId: string, purchaseOrderRef: string, locationId: string, lines: { stockItemId: string; quantity: number; expectedDate: string }[]): Promise<void> {
    for (const [i, l] of lines.entries()) if (!Number.isInteger(l.quantity) || l.quantity < 0) throw invalid(`lines[${i}].quantity`, 'Quantity must be 0 or more');
    const location = await this.core.repo.get('locations', locationId);
    if (!location || location.owner_type !== 'official') throw invalid('locationId', 'Unknown company stock location');
    const items = await this.core.repo.items({ ids: lines.map((l) => l.stockItemId), includeArchived: true });
    for (const [i, l] of lines.entries()) if (!items.find((it) => it.id === l.stockItemId && it.owner_type === 'official')) throw invalid(`lines[${i}].stockItemId`, 'Unknown company stock item');
    const ref: MovementRef = { kind: 'purchase_order', id: purchaseOrderId, label: `Purchase order ${purchaseOrderRef}` };
    await this.core.stock('incoming', (st) =>
      this.replaceIncoming(st, { sourceKind: 'purchase_order', sourceId: purchaseOrderId, sourceRef: purchaseOrderRef, locationId, lines, ref, sent: 'purchase_order_sent', changed: 'purchase_order_changed' }),
    );
  }

  /**
   * The open Incoming of one source (a purchase order or a Fulfilled by Marketly inbound shipment) becomes `lines`:
   * lines no longer on it (or moved to another location) leave Incoming, the others are raised or lowered to their
   * quantity. Inside the caller's stock transaction.
   */
  async replaceIncoming(
    st: StockTx,
    o: {
      sourceKind: 'purchase_order' | 'service_inbound';
      sourceId: string;
      sourceRef: string;
      locationId: string;
      lines: { stockItemId: string; quantity: number; expectedDate?: string | null }[];
      ref: MovementRef;
      sent: string;
      changed: string;
    },
  ): Promise<void> {
    const { locationId, ref } = o;
    const existing = await st.tx.expectations({ sourceKind: o.sourceKind, sourceId: o.sourceId }, { forUpdate: true });
    await st.lock([...o.lines.map((l) => l.stockItemId), ...existing.map((e) => e.stock_item_id)]);
    const wanted = new Map<string, { quantity: number; expectedDate: string | null }>();
    for (const l of o.lines) wanted.set(l.stockItemId, { quantity: (wanted.get(l.stockItemId)?.quantity ?? 0) + l.quantity, expectedDate: l.expectedDate ?? null });
    // lines no longer on the source, or moved to another location: their open units leave Incoming
    for (const e of existing) {
      const w = wanted.get(e.stock_item_id);
      if (w && e.location_id === locationId) continue;
      const n = Math.min(e.quantity_open, st.qty(e.stock_item_id, e.location_id).incoming);
      if (n > 0) await st.move(e.stock_item_id, e.location_id, 'incoming', 'outside', n, { reason: o.changed, ref, actor: SYSTEM_ACTOR });
      await st.tx.update('incoming_expectations', e.id, { quantity_open: 0 });
      e.quantity_open = 0;
    }
    for (const [itemId, w] of wanted) {
      const e = existing.find((x) => x.stock_item_id === itemId && x.location_id === locationId);
      const before = e?.quantity_open ?? 0;
      const delta = w.quantity - before;
      if (delta > 0) await st.move(itemId, locationId, 'outside', 'incoming', delta, { reason: e ? o.changed : o.sent, ref, actor: SYSTEM_ACTOR });
      if (delta < 0) {
        const n = Math.min(-delta, st.qty(itemId, locationId).incoming);
        if (n > 0) await st.move(itemId, locationId, 'incoming', 'outside', n, { reason: o.changed, ref, actor: SYSTEM_ACTOR });
      }
      if (e) await st.tx.update('incoming_expectations', e.id, { quantity_open: w.quantity, expected_date: w.expectedDate, source_ref: o.sourceRef });
      else await st.tx.insert('incoming_expectations', { id: newId(), stock_item_id: itemId, location_id: locationId, source_kind: o.sourceKind, source_id: o.sourceId, source_ref: o.sourceRef, quantity_open: w.quantity, expected_date: w.expectedDate });
    }
  }

  /** Cancelled or short-closed purchase orders */
  async cancelIncoming(purchaseOrderId: string, lines?: { stockItemId: string; quantity: number }[]): Promise<void> {
    await this.core.stock('incoming', async (st) => {
      const existing = await st.tx.expectations({ sourceKind: 'purchase_order', sourceId: purchaseOrderId, openOnly: true }, { forUpdate: true });
      await st.lock(existing.map((e) => e.stock_item_id));
      for (const e of existing) {
        const asked = lines ? lines.filter((l) => l.stockItemId === e.stock_item_id).reduce((n, l) => n + Math.max(0, l.quantity), 0) : e.quantity_open;
        const cancel = Math.min(asked, e.quantity_open);
        if (cancel <= 0) continue;
        const n = Math.min(cancel, st.qty(e.stock_item_id, e.location_id).incoming);
        if (n > 0) await st.move(e.stock_item_id, e.location_id, 'incoming', 'outside', n, { reason: 'purchase_order_cancelled', ref: { kind: 'purchase_order', id: purchaseOrderId, label: `Purchase order ${e.source_ref}` }, actor: SYSTEM_ACTOR });
        await st.tx.update('incoming_expectations', e.id, { quantity_open: e.quantity_open - cancel });
      }
    });
  }

  /** Counted receipt waiting for the Inventory Manager to confirm what can be sold */
  async submitInbound(receipt: { receiptId: string; receiptRef: string; purchaseOrderId: string; purchaseOrderRef: string; supplierName: string; locationId: string; receivedBy: common.Actor; receivedAt: string; lines: { stockItemId: string; expected: number; received: number; damaged: number; binCode?: string; unitCost: common.Money }[] }): Promise<InboundReceipt> {
    const existing = await this.core.repo.inboundByReceipt(receipt.receiptId);
    if (existing) return (await this.core.inboundsApi([existing]))[0]!;
    if (!receipt.lines?.length) throw invalid('lines', 'A receipt needs at least one line');
    const location = await this.core.repo.get('locations', receipt.locationId);
    if (!location || location.owner_type !== 'official') throw invalid('locationId', 'Unknown company stock location');
    const items = await this.core.repo.items({ ids: receipt.lines.map((l) => l.stockItemId), includeArchived: true });
    const seen = new Set<string>();
    for (const [i, l] of receipt.lines.entries()) {
      if (!items.find((it) => it.id === l.stockItemId && it.owner_type === 'official')) throw invalid(`lines[${i}].stockItemId`, 'Unknown company stock item');
      if (seen.has(l.stockItemId)) throw invalid(`lines[${i}].stockItemId`, 'Each stock item appears once per receipt');
      seen.add(l.stockItemId);
      if (![l.expected, l.received, l.damaged].every((n) => Number.isInteger(n) && n >= 0)) throw invalid(`lines[${i}]`, 'Quantities must be whole numbers, 0 or more');
      if (l.damaged > l.received) throw invalid(`lines[${i}].damaged`, 'Damaged units cannot exceed received units');
      if (!Number.isInteger(l.unitCost?.amount) || l.unitCost.amount < 0) throw invalid(`lines[${i}].unitCost`, 'Unit cost must be 0 or more');
    }
    const id = newId();
    const ref: MovementRef = { kind: 'receipt', id: receipt.receiptId, label: `Received ${receipt.purchaseOrderRef}` };
    const inserted = await this.core.stock('incoming', async (st) => {
      const row = await st.tx.insertIfAbsent(
        'inbound_receipts',
        {
          id,
          receipt_id: receipt.receiptId,
          receipt_ref: receipt.receiptRef,
          source_kind: 'purchase_order',
          source_id: receipt.purchaseOrderId,
          source_ref: receipt.purchaseOrderRef,
          owner_type: 'official',
          seller_id: null,
          purchase_order_id: receipt.purchaseOrderId,
          purchase_order_ref: receipt.purchaseOrderRef,
          supplier_name: receipt.supplierName,
          location_id: receipt.locationId,
          received_by: actorText(receipt.receivedBy),
          received_at: new Date(receipt.receivedAt),
          state: 'awaiting_confirmation',
          confirmed_by: null,
          confirmed_at: null,
          note: null,
        },
      );
      if (!row) return false;
      await st.tx.insertInboundLines(
        receipt.lines.map((l) => ({ inbound_id: id, stock_item_id: l.stockItemId, expected: l.expected, received: l.received, damaged: l.damaged, bin_code: l.binCode ?? null, unit_cost_amount: l.unitCost.amount, sellable: null, reason: null })),
      );
      const expectations = await st.tx.expectations({ sourceKind: 'purchase_order', sourceId: receipt.purchaseOrderId }, { forUpdate: true });
      await st.lock(receipt.lines.map((l) => l.stockItemId));
      for (const l of receipt.lines) {
        // received units stay in Incoming until confirmed: they come off the open purchase order quantity
        const e = expectations.find((x) => x.stock_item_id === l.stockItemId && x.location_id === receipt.locationId);
        const fromOrder = Math.min(l.received, e?.quantity_open ?? 0, st.qty(l.stockItemId, receipt.locationId).incoming);
        if (e && fromOrder > 0) await st.tx.update('incoming_expectations', e.id, { quantity_open: e.quantity_open - fromOrder });
        const extra = l.received - fromOrder;
        if (extra > 0) await st.move(l.stockItemId, receipt.locationId, 'outside', 'incoming', extra, { reason: 'received_over_expected', ref, actor: receipt.receivedBy });
      }
      return true;
    });
    const row = inserted ? await this.core.repo.get('inbound_receipts', id) : await this.core.repo.inboundByReceipt(receipt.receiptId);
    return (await this.core.inboundsApi([row!]))[0]!;
  }

  async listInbound(query: { state?: string; source?: 'purchase_order' | 'service_inbound' }, page: PageRequest): Promise<common.Page<InboundReceipt>> {
    const p = await this.core.repo.pageInbound({ ...(query.state ? { state: query.state } : {}), ...(query.source ? { source: query.source } : {}) }, page);
    return { ...p, items: await this.core.inboundsApi(p.items) };
  }

  async getInbound(id: string): Promise<InboundReceipt> {
    const r = await this.core.repo.get('inbound_receipts', id);
    if (!r) throw notFound('Receipt');
    return (await this.core.inboundsApi([r]))[0]!;
  }

  async confirmInbound(id: string, body: ConfirmInboundRequest, by: StaffBy): Promise<InboundReceipt> {
    const receipt = await this.core.repo.get('inbound_receipts', id);
    if (!receipt) throw notFound('Receipt');
    inboundConfirmationMachine.next(receipt.state as 'awaiting_confirmation', 'confirm');
    if (body.checked !== true) throw invalid('checked', 'Confirm that you counted and checked these units');
    const lines = await this.core.repo.inboundLines([id]);
    const decided = new Map<string, { sellable: number; damaged: number; reason: string | null }>();
    for (const [i, l] of (body.lines ?? []).entries()) {
      const line = lines.find((x) => x.stock_item_id === l.stockItemId);
      if (!line) throw invalid(`lines[${i}].stockItemId`, 'This stock item is not on the receipt');
      if (!Number.isInteger(l.sellable) || l.sellable < 0 || !Number.isInteger(l.damaged) || l.damaged < 0) throw invalid(`lines[${i}]`, 'Quantities must be whole numbers, 0 or more');
      if (l.sellable + l.damaged > line.received) throw inventoryError('SELLABLE_EXCEEDS_RECEIVED', `Sellable and damaged units of ${l.stockItemId} add up to more than the ${line.received} received`, { stockItemId: l.stockItemId, received: line.received });
      if (l.sellable !== line.received - l.damaged && !l.reason?.trim()) throw invalid(`lines[${i}].reason`, 'Say why the sellable quantity differs from received minus damaged');
      decided.set(l.stockItemId, { sellable: l.sellable, damaged: l.damaged, reason: l.reason?.trim() || null });
    }
    const source = receiptSourceOf(receipt);
    const service = source.kind === 'service_inbound';
    const ref: MovementRef = { kind: 'receipt', id: receipt.receipt_id, label: `Received ${source.ref}` };
    const reviewDate = addDays(this.core.today(), DEFAULT_HOLD_REVIEW_DAYS);
    await this.core.stock(
      'receipt_confirmed',
      async (st) => {
        const locked = (await st.tx.get('inbound_receipts', id, { forUpdate: true }))!;
        const state = inboundConfirmationMachine.next(locked.state as 'awaiting_confirmation', 'confirm');
        await st.lock(lines.map((l) => l.stock_item_id));
        if (service) {
          await this.#confirmServiceLines(st, locked, lines, decided, { ref, reviewDate, actor: by.actor });
          await st.tx.update('inbound_receipts', id, { state, confirmed_by: actorText(by.actor), confirmed_at: st.now, note: body.note ?? null });
          return;
        }
        for (const line of lines) {
          const d = decided.get(line.stock_item_id) ?? { sellable: Math.max(0, line.received - line.damaged), damaged: line.damaged, reason: null };
          const item = st.item(line.stock_item_id);
          // weighted average cost over units on hand plus the units accepted at the receipt's cost
          const accepted = d.sellable + d.damaged;
          if (accepted > 0) {
            const cost = weightedAverage(item.unit_cost_amount === null ? null : Number(item.unit_cost_amount), onHand(st.total(item.id)), Number(line.unit_cost_amount), accepted);
            st.items.set(item.id, await st.tx.update('stock_items', item.id, { unit_cost_amount: cost, ...(line.bin_code && !item.primary_bin_code ? { primary_bin_code: line.bin_code } : {}) }));
          }
          if (d.sellable > 0) await st.move(item.id, locked.location_id, 'incoming', 'available', d.sellable, { reason: 'receipt_confirmed', note: d.reason, ref, actor: by.actor });
          if (d.damaged > 0)
            await st.move(item.id, locked.location_id, 'incoming', 'damaged_held', d.damaged, { reason: 'receipt_damaged', ref, actor: by.actor, hold: { reasonCode: 'receipt_damaged', reviewDate, reason: 'Supplier claim follow-up', sourceRef: receipt.receipt_ref } });
          const rejected = line.received - accepted;
          if (rejected > 0) await st.move(item.id, locked.location_id, 'incoming', 'outside', rejected, { reason: 'receipt_not_accepted', note: d.reason, ref, actor: by.actor });
          await st.tx.updateInboundLine(id, item.id, { sellable: d.sellable, damaged: d.damaged, reason: d.reason });
        }
        // no backorders at launch: open pick shortages on these SKUs are listed on the receipt (openPickShortages) for the
        // Inventory Manager to reallocate first; nothing is allocated automatically
        await st.tx.update('inbound_receipts', id, { state, confirmed_by: actorText(by.actor), confirmed_at: st.now, note: body.note ?? null });
      },
      this.core.meta(by),
    );
    const api = await this.getInbound(id);
    this.core.ctx.events.publish(
      'inventory.receipt.confirmed',
      { inboundId: id, receiptId: receipt.receipt_id, source, ownerType: receipt.owner_type, sellerId: receipt.seller_id, purchaseOrderId: receipt.purchase_order_id, locationId: receipt.location_id, lines: api.lines, confirmedBy: by.actor },
      this.core.meta(by),
    );
    await this.core.audit(
      {
        action: 'inventory.inbound.confirm',
        actionLabel: service ? 'Confirmed received Fulfilled by Marketly stock' : 'Confirmed received stock',
        category: 'inventory',
        target: { type: 'receipt', id: receipt.receipt_id, ref: receipt.receipt_ref, label: `${receipt.supplier_name} · ${source.ref}`, screen: 'ops/receiving', ...(receipt.seller_id ? { sellerId: receipt.seller_id } : {}) },
        after: api.totals,
        reason: body.note ?? null,
      },
      by,
    );
    return api;
  }

  /**
   * Confirmation of a Fulfilled by Marketly receipt (seller stock at the service location): no unit cost and no
   * valuation. Each line's units come out of the inbound shipment's open Incoming (as far as it goes) into Available
   * (sellable) and Damaged or held (damaged), units not accepted leave Incoming, and units beyond the open Incoming
   * are added from outside.
   */
  async #confirmServiceLines(
    st: StockTx,
    receipt: Row<'inbound_receipts'>,
    lines: Row<'inbound_lines'>[],
    decided: Map<string, { sellable: number; damaged: number; reason: string | null }>,
    o: { ref: MovementRef; reviewDate: string; actor: common.Actor },
  ) {
    const loc = receipt.location_id;
    const expectations = receipt.source_id ? await st.tx.expectations({ sourceKind: 'service_inbound', sourceId: receipt.source_id }, { forUpdate: true }) : [];
    for (const line of lines) {
      const d = decided.get(line.stock_item_id) ?? { sellable: Math.max(0, line.received - line.damaged), damaged: line.damaged, reason: null };
      const item = st.item(line.stock_item_id);
      const e = expectations.find((x) => x.stock_item_id === item.id && x.location_id === loc);
      let pool = Math.min(line.received, e?.quantity_open ?? 0, st.qty(item.id, loc).incoming);
      if (e && pool > 0) await st.tx.update('incoming_expectations', e.id, { quantity_open: e.quantity_open - pool });
      const base = { ref: o.ref, actor: o.actor };
      const hold = { reasonCode: 'receipt_damaged', reviewDate: o.reviewDate, reason: 'Damaged on arrival (Fulfilled by Marketly)', sourceRef: receipt.receipt_ref };
      const put = async (n: number, to: 'available' | 'damaged_held') => {
        if (n <= 0) return;
        const fromIncoming = Math.min(n, pool);
        pool -= fromIncoming;
        const reason = to === 'available' ? 'receipt_confirmed' : 'receipt_damaged';
        const extra = to === 'damaged_held' ? { hold } : {};
        if (fromIncoming > 0) await st.move(item.id, loc, 'incoming', to, fromIncoming, { ...base, ...extra, reason, note: d.reason });
        if (n - fromIncoming > 0) await st.move(item.id, loc, 'outside', to, n - fromIncoming, { ...base, ...extra, reason: 'received_over_expected', note: d.reason });
      };
      await put(d.sellable, 'available');
      await put(d.damaged, 'damaged_held');
      // the rest of the units counted against the inbound were not accepted: they leave Incoming
      if (pool > 0) await st.move(item.id, loc, 'incoming', 'outside', pool, { ...base, reason: 'receipt_not_accepted', note: d.reason });
      if (line.bin_code && !item.primary_bin_code) st.items.set(item.id, await st.tx.update('stock_items', item.id, { primary_bin_code: line.bin_code }));
      await st.tx.updateInboundLine(receipt.id, item.id, { sellable: d.sellable, damaged: d.damaged, reason: d.reason });
    }
  }
}
