/** Fulfilled by Marketly: seller-owned stock at the service location, its inbound shipments and receipts. */
import { isIsoDate } from '../../../kernel/lib/dates.js';
import { createHash } from 'node:crypto';
import { AppError } from '../../../kernel/errors/index.js';
import { inventoryError } from '../errors.js';
import { isUuid, newId } from '../../../kernel/lib/ids.js';
import type * as common from '../../../spec/common.js';
import type { InboundReceipt, InventoryPublicApi, StockItem, StockQuantities } from '../../../spec/inventory.js';
import { addDays, GROUPS, SERVICE_REASONS, type GroupOrOutside } from '../domain/rules.js';
import { actorText, SYSTEM_ACTOR } from '../mappers.js';
import type { Row } from '../ports.js';
import { DEFAULT_HOLD_REVIEW_DAYS, invalid, notFound, type Core } from './core.js';
import type { Receiving } from './receiving.js';

/** moveServiceStock: the ledger row id derived from the caller's idempotency key (a name-based UUID, version 8) */
function serviceMovementId(key: string): string {
  const b = createHash('sha256').update(`inventory.moveServiceStock:${key}`).digest().subarray(0, 16);
  b[6] = 0x80 | (b[6]! & 0x0f);
  b[8] = 0x80 | (b[8]! & 0x3f);
  const h = b.toString('hex');
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20)}`;
}

/** The quantities at the movement's location right after it */
const afterOf = (m: Row<'stock_movements'>): StockQuantities => (typeof m.after === 'string' ? JSON.parse(m.after) : m.after) as unknown as StockQuantities;

export class ServiceStock {
  constructor(private readonly core: Core, private readonly receiving: Receiving) {}

  /** An active company warehouse: a service location or the destination of an inbound shipment */
  async #companyWarehouse(locationId: string | null | undefined, path = 'locationId'): Promise<Row<'locations'>> {
    const loc = isUuid(locationId) ? await this.core.repo.get('locations', locationId) : undefined;
    if (!loc || loc.owner_type !== 'official' || loc.kind !== 'warehouse' || !loc.active) throw invalid(path, 'Choose an active company warehouse');
    return loc;
  }

  /** Seller stock items by id; every one must exist and belong to one seller (`sellerId` when given) */
  async #sellerItems(ids: string[], path: (i: number) => string, sellerId?: string): Promise<Map<string, Row<'stock_items'>>> {
    const rows = new Map((await this.core.repo.items({ ids: [...new Set(ids.filter((id) => isUuid(id)))], includeArchived: true })).map((r) => [r.id, r]));
    let owner = sellerId ?? null;
    for (const [i, id] of ids.entries()) {
      const item = rows.get(id);
      if (!item || item.owner_type !== 'seller') throw invalid(path(i), 'Unknown seller stock item');
      owner ??= item.seller_id;
      if (item.seller_id !== owner) throw invalid(path(i), sellerId ? "This stock item is not the seller's" : 'All stock items must belong to one seller');
    }
    return rows;
  }

  /**
   * Designates the company location a seller item sells from (null returns it to the seller's own location). While
   * set, the item sells only there and the seller's own-location units are kept but not on sale (decision D4).
   * Publishes inventory.stock.changed (cause service_location); the same value again is a no-op.
   */
  async setServiceLocation(stockItemId: string, locationId: string | null, actor: common.Actor): Promise<StockItem> {
    if (!actor?.kind) throw invalid('actor', 'Say who changes where the item sells from');
    const item = isUuid(stockItemId) ? await this.core.repo.get('stock_items', stockItemId) : undefined;
    if (!item) throw notFound();
    if (item.owner_type !== 'seller') throw invalid('stockItemId', 'Only seller stock can be Fulfilled by Marketly');
    const target = locationId ?? null;
    if (target !== null) await this.#companyWarehouse(target);
    if ((item.service_location_id ?? null) === target) return this.core.itemApi(item);
    await this.core.stock(
      'service_location',
      async (st) => {
        await st.lock([item.id]);
        if ((st.item(item.id).service_location_id ?? null) === target) return;
        st.touch(item.id, await st.tx.update('stock_items', item.id, { service_location_id: target, updated_at: st.now }));
      },
      { actor },
    );
    return this.core.itemApi(await this.core.item(item.id));
  }

  /**
   * One atomic movement of a seller item at its service location (null = outside stock). Idempotent per key through
   * the inbox: the ledger row's id is derived from the key, so the same key answers with the first movement.
   * Publishes inventory.stock.changed (and stock.low), never inventory.adjustment.recorded.
   */
  async moveServiceStock(input: Parameters<InventoryPublicApi['moveServiceStock']>[0]): Promise<{ movementId: string; levels: StockQuantities }> {
    const key = input?.key?.trim();
    if (!key) throw invalid('key', 'A service stock movement needs its idempotency key');
    const movementId = serviceMovementId(key);
    const first = await this.core.repo.get('stock_movements', movementId);
    if (first) return { movementId, levels: afterOf(first) };
    const from: GroupOrOutside = input.from ?? 'outside';
    const to: GroupOrOutside = input.to ?? 'outside';
    for (const [path, g] of [['from', from], ['to', to]] as const) if (g !== 'outside' && !(GROUPS as readonly string[]).includes(g)) throw invalid(path, 'Not a stock group');
    if (from === to) throw invalid('to', 'Choose two different stock groups');
    if (from === 'reserved' || to === 'reserved') throw inventoryError('RESERVED_NOT_ADJUSTABLE', 'Reserved units belong to orders; they move through reservations');
    if (!Number.isInteger(input.quantity) || input.quantity <= 0) throw invalid('quantity', 'Quantity must be at least 1');
    if (!(SERVICE_REASONS as readonly string[]).includes(input.reasonCode)) throw invalid('reasonCode', 'Not a Fulfilled by Marketly reason');
    if (!input.ref?.kind || !input.ref.id || !input.ref.label) throw invalid('ref', 'Say what the movement is for');
    if (!input.actor?.kind) throw invalid('actor', 'Say who moves the stock');
    const item = isUuid(input.stockItemId) ? await this.core.repo.get('stock_items', input.stockItemId) : undefined;
    if (!item) throw notFound();
    const notHere = () => invalid('locationId', 'This item is not Fulfilled by Marketly from that location');
    if (item.owner_type !== 'seller' || !item.service_location_id || item.service_location_id !== input.locationId) throw notHere();
    const label = input.ref.label;
    const moved = await this.core.stock(
      'service_stock',
      async (st) => {
        if (!(await st.tx.claimEvent(`service-move:${key}`))) return null;
        await st.lock([item.id]);
        if (st.item(item.id).service_location_id !== input.locationId) throw notHere();
        return st.move(item.id, input.locationId, from, to, input.quantity, {
          movementId,
          reason: input.reasonCode,
          ref: input.ref,
          actor: input.actor,
          ...(to === 'damaged_held' ? { hold: { reasonCode: input.reasonCode, reviewDate: addDays(this.core.today(), DEFAULT_HOLD_REVIEW_DAYS), reason: label, sourceRef: label } } : {}),
          insufficient: (have) =>
            inventoryError('INSUFFICIENT_STOCK', `Only ${have} unit${have === 1 ? '' : 's'} in ${from.replace('_', ' ')} for ${item.sku}`, { group: from, lines: [{ stockItemId: item.id, requested: input.quantity, available: have }] }),
        });
      },
      { actor: input.actor },
    );
    const m = moved ?? (await this.core.repo.get('stock_movements', movementId));
    if (!m) throw new AppError('CONFLICT', 'The same movement is being applied at the same time; try again');
    return { movementId: m.id, levels: afterOf(m) };
  }

  /** Incoming at the service location for a submitted inbound shipment; repeated calls replace the open quantities */
  async expectServiceInbound(input: { inboundId: string; ref: string; locationId: string; lines: { stockItemId: string; quantity: number; expectedDate?: string }[] }): Promise<void> {
    if (!isUuid(input?.inboundId)) throw invalid('inboundId', 'Not an inbound shipment id');
    if (!input.ref?.trim()) throw invalid('ref', 'The inbound shipment needs its reference');
    const location = await this.#companyWarehouse(input.locationId);
    const lines = input.lines ?? [];
    for (const [i, l] of lines.entries()) {
      if (!Number.isInteger(l.quantity) || l.quantity < 0) throw invalid(`lines[${i}].quantity`, 'Quantity must be 0 or more');
      if (l.expectedDate != null && !isIsoDate(l.expectedDate)) throw invalid(`lines[${i}].expectedDate`, 'Not a date (YYYY-MM-DD)');
    }
    await this.#sellerItems(
      lines.map((l) => l.stockItemId),
      (i) => `lines[${i}].stockItemId`,
    );
    const ref = input.ref.trim();
    await this.core.stock('incoming', (st) =>
      this.receiving.replaceIncoming(st, {
        sourceKind: 'service_inbound',
        sourceId: input.inboundId,
        sourceRef: ref,
        locationId: location.id,
        lines,
        ref: { kind: 'service_inbound', id: input.inboundId, label: `Inbound ${ref}` },
        sent: 'service_inbound_expected',
        changed: 'service_inbound_changed',
      }),
    );
  }

  /**
   * Removes the open Incoming of a cancelled or completed inbound shipment. Units already counted on a receipt that
   * waits for confirmation stay in Incoming (confirmInbound takes them); no-op when nothing is open.
   */
  async cancelServiceInbound(inboundId: string): Promise<void> {
    if (!isUuid(inboundId)) throw invalid('inboundId', 'Not an inbound shipment id');
    await this.core.stock('incoming', async (st) => {
      const open = await st.tx.expectations({ sourceKind: 'service_inbound', sourceId: inboundId, openOnly: true }, { forUpdate: true });
      if (!open.length) return;
      const waiting = await st.tx.inboundWhere({ sourceKind: 'service_inbound', sourceId: inboundId, state: 'awaiting_confirmation' });
      const counted = new Map<string, number>();
      for (const l of await st.tx.inboundLines(waiting.map((r) => r.id))) {
        const r = waiting.find((x) => x.id === l.inbound_id)!;
        counted.set(`${l.stock_item_id}:${r.location_id}`, (counted.get(`${l.stock_item_id}:${r.location_id}`) ?? 0) + l.received);
      }
      await st.lock(open.map((e) => e.stock_item_id));
      for (const e of open) {
        const keep = Math.min(e.quantity_open, counted.get(`${e.stock_item_id}:${e.location_id}`) ?? 0);
        const n = Math.min(e.quantity_open - keep, st.qty(e.stock_item_id, e.location_id).incoming);
        if (n > 0) await st.move(e.stock_item_id, e.location_id, 'incoming', 'outside', n, { reason: 'service_inbound_closed', ref: { kind: 'service_inbound', id: inboundId, label: `Inbound ${e.source_ref}` }, actor: SYSTEM_ACTOR });
        if (keep !== e.quantity_open) await st.tx.update('incoming_expectations', e.id, { quantity_open: keep });
      }
    });
  }

  /**
   * A counted Fulfilled by Marketly receiving record waiting for the Inventory Manager (decision D3): like
   * submitInbound without cost. The units stay in Incoming until confirmInbound; same receiptId returns the first receipt.
   */
  async submitServiceReceipt(receipt: Parameters<InventoryPublicApi['submitServiceReceipt']>[0]): Promise<InboundReceipt> {
    if (!isUuid(receipt?.receiptId)) throw invalid('receiptId', 'Not a receipt id');
    const existing = await this.core.repo.inboundByReceipt(receipt.receiptId);
    if (existing) return (await this.core.inboundsApi([existing]))[0]!;
    if (!isUuid(receipt.inboundId)) throw invalid('inboundId', 'Not an inbound shipment id');
    if (!isUuid(receipt.sellerId)) throw invalid('sellerId', 'Not a seller id');
    for (const f of ['receiptRef', 'inboundRef', 'sellerName'] as const) if (!receipt[f]?.trim()) throw invalid(f, 'Required');
    if (!receipt.receivedBy?.kind) throw invalid('receivedBy', 'Say who counted the units');
    const receivedAt = new Date(receipt.receivedAt);
    if (Number.isNaN(receivedAt.getTime())) throw invalid('receivedAt', 'Not a valid time');
    if (!receipt.lines?.length) throw invalid('lines', 'A receipt needs at least one line');
    const location = await this.#companyWarehouse(receipt.locationId);
    await this.#sellerItems(
      receipt.lines.map((l) => l.stockItemId),
      (i) => `lines[${i}].stockItemId`,
      receipt.sellerId,
    );
    const seen = new Set<string>();
    for (const [i, l] of receipt.lines.entries()) {
      if (seen.has(l.stockItemId)) throw invalid(`lines[${i}].stockItemId`, 'Each stock item appears once per receipt');
      seen.add(l.stockItemId);
      if (![l.expected, l.received, l.damaged].every((n) => Number.isInteger(n) && n >= 0)) throw invalid(`lines[${i}]`, 'Quantities must be whole numbers, 0 or more');
      if (l.damaged > l.received) throw invalid(`lines[${i}].damaged`, 'Damaged units cannot exceed received units');
    }
    const id = newId();
    const inserted = await this.core.repo.transaction(async (tx) => {
      const row = await tx.insertIfAbsent(
        'inbound_receipts',
        {
          id,
          receipt_id: receipt.receiptId,
          receipt_ref: receipt.receiptRef.trim(),
          source_kind: 'service_inbound',
          source_id: receipt.inboundId,
          source_ref: receipt.inboundRef.trim(),
          owner_type: 'seller',
          seller_id: receipt.sellerId,
          purchase_order_id: null,
          purchase_order_ref: null,
          supplier_name: receipt.sellerName.trim(),
          location_id: location.id,
          received_by: actorText(receipt.receivedBy),
          received_at: receivedAt,
          state: 'awaiting_confirmation',
          confirmed_by: null,
          confirmed_at: null,
          note: null,
        },
      );
      if (!row) return false;
      // the counted units stay in Incoming (against the inbound shipment) until the Inventory Manager confirms them
      await tx.insertInboundLines(receipt.lines.map((l) => ({ inbound_id: id, stock_item_id: l.stockItemId, expected: l.expected, received: l.received, damaged: l.damaged, bin_code: l.binCode ?? null, unit_cost_amount: null, sellable: null, reason: null })));
      return true;
    });
    const row = inserted ? await this.core.repo.get('inbound_receipts', id) : await this.core.repo.inboundByReceipt(receipt.receiptId);
    return (await this.core.inboundsApi([row!]))[0]!;
  }
}
