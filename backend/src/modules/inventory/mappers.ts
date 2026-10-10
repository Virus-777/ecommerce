/** Rows (snake_case) → API types (camelCase). One place per type. */
import { money } from '../../kernel/lib/money.js';
import type { Actor, MediaRef, Money } from '../../spec/common.js';
import type {
  Discrepancy,
  IncomingCue,
  InboundLine,
  InboundReceipt,
  Location,
  Movement,
  MovementRef,
  ReceiptSource,
  Reservation,
  ReservationLine,
  ReturnOutcome,
  StockCount,
  StockItem,
  StockQuantities,
  Transfer,
} from '../../spec/inventory.js';
import { addQty, onHand, reasonLabel, sellsFrom, stockState, zeroQty } from './domain/rules.js';
import type { Row } from './ports.js';
import { levelQty } from './stock-tx.js';

export const SYSTEM_ACTOR: Actor = { kind: 'system', id: 'inventory', name: 'Inventory' };

export const actorText = (a: Actor): string => JSON.stringify({ kind: a.kind, id: a.id ?? null, name: a.name ?? null });

export function actorOf(text: string | null | undefined): Actor | null {
  if (!text) return null;
  try {
    const a = JSON.parse(text) as Actor;
    if (a && typeof a === 'object' && typeof a.kind === 'string') return { kind: a.kind, id: a.id ?? null, name: a.name ?? null };
  } catch {
    /* plain text */
  }
  return { kind: 'system', id: null, name: text };
}

export const iso = (d: Date) => d.toISOString();
export const isoOrNull = (d: Date | null | undefined) => (d ? d.toISOString() : null);

export const unitCostOf = (item: Row<'stock_items'>): Money | null =>
  item.owner_type === 'official' && item.unit_cost_amount !== null ? money(Number(item.unit_cost_amount), item.currency.trim()) : null;

export const effectiveThreshold = (item: Row<'stock_items'>, defaultSellerThreshold: number): number | null =>
  item.low_stock_threshold ?? (item.owner_type === 'seller' ? defaultSellerThreshold : null);

export const incomingCue = (e: Row<'incoming_expectations'>): IncomingCue => ({ quantity: e.quantity_open, expectedDate: e.expected_date, purchaseOrderRef: e.source_ref });

export function toLocation(l: Row<'locations'>): Location {
  return {
    id: l.id,
    code: l.code,
    name: l.name,
    kind: l.kind as Location['kind'],
    ownerType: l.owner_type as Location['ownerType'],
    sellerId: l.seller_id,
    address: (l.address as unknown as Location['address']) ?? null,
    timeZone: l.time_zone,
    sellable: l.sellable,
    active: l.active,
    isDefault: l.is_default,
  };
}

export interface ItemContext {
  levels: Row<'stock_levels'>[];
  locations: Map<string, Row<'locations'>>;
  expectations: Row<'incoming_expectations'>[];
  defaultSellerThreshold: number;
  /** Quantities at this location only */
  locationId?: string;
  /** From catalog: the variant's first image, else the product's */
  image?: MediaRef | null;
}

/** Available units the item can sell: sellable, active locations under the sellable rule (sellsFrom) */
export const sellableAvailable = (item: Row<'stock_items'>, levels: Row<'stock_levels'>[], locations: Map<string, Row<'locations'>>) =>
  levels.reduce((n, l) => n + (l.stock_item_id === item.id && sellsFrom(item, locations.get(l.location_id)) ? l.available : 0), 0);

/** A seller item Fulfilled by Marketly: it has a service location */
export const isServiceItem = (item: Row<'stock_items'>) => item.owner_type === 'seller' && !!item.service_location_id;

const sumQty = (levels: Row<'stock_levels'>[]) => levels.reduce((sum, l) => addQty(sum, levelQty(l)), zeroQty());

export function toStockItem(item: Row<'stock_items'>, c: ItemContext): StockItem {
  const service = isServiceItem(item);
  // a service item's quantities are those at its service location ('At Marketly'); its own-location units are apart
  const levels = c.locationId ? c.levels.filter((l) => l.location_id === c.locationId) : service ? c.levels.filter((l) => l.location_id === item.service_location_id) : c.levels;
  const quantities = sumQty(levels);
  const available = sellableAvailable(item, c.levels, c.locations);
  const threshold = effectiveThreshold(item, c.defaultSellerThreshold);
  const unitCost = unitCostOf(item);
  const next = c.expectations.find((e) => e.quantity_open > 0);
  return {
    id: item.id,
    ownerType: item.owner_type,
    sellerId: item.seller_id,
    sku: item.sku,
    offerId: item.offer_id,
    productId: item.product_id,
    variantId: item.variant_id,
    condition: item.condition,
    label: item.label,
    image: c.image ?? null,
    quantities,
    state: item.archived ? 'out_of_stock' : stockState(available, threshold),
    lowStockThreshold: threshold,
    reorderQuantity: item.reorder_quantity,
    unitCost,
    valueAtCost: unitCost ? money(unitCost.amount * onHand(quantities), unitCost.currency) : null,
    binCode: item.primary_bin_code,
    nextIncoming: next ? incomingCue(next) : null,
    serviceLocationId: item.owner_type === 'seller' ? item.service_location_id : null,
    ownLocationQuantities: service ? sumQty(c.levels.filter((l) => c.locations.get(l.location_id)?.owner_type === 'seller')) : null,
    archived: item.archived,
    updatedAt: iso(item.updated_at),
  };
}

export function toMovement(m: Row<'stock_movements'>, sku: string): Movement {
  const ref: MovementRef | null = m.ref_kind && m.ref_id ? { kind: m.ref_kind as MovementRef['kind'], id: m.ref_id, label: m.ref_label ?? '' } : null;
  return {
    id: m.id,
    stockItemId: m.stock_item_id,
    sku,
    locationId: m.location_id,
    fromGroup: m.from_group as Movement['fromGroup'],
    toGroup: m.to_group as Movement['toGroup'],
    quantity: m.quantity,
    reasonCode: m.reason_code,
    reasonLabel: reasonLabel(m.reason_code),
    note: m.note,
    reference: ref,
    actor: { kind: m.actor_kind as Actor['kind'], id: m.actor_id, name: m.actor_name },
    approvedBy: actorOf(m.approved_by),
    at: iso(m.at),
    after: (typeof m.after === 'string' ? JSON.parse(m.after) : m.after) as unknown as StockQuantities,
  };
}

export function toReservationLine(l: Row<'reservation_lines'>, sku: string): ReservationLine {
  return {
    id: l.id,
    stockItemId: l.stock_item_id,
    sku,
    locationId: l.location_id,
    orderItemId: l.order_item_id,
    quantity: l.quantity,
    fulfilledQuantity: l.fulfilled_qty,
    releasedQuantity: l.released_qty,
    state: l.state as ReservationLine['state'],
  };
}

export function toReservation(r: Row<'reservations'>, lines: ReservationLine[]): Reservation {
  return {
    id: r.id,
    key: r.key,
    source: r.source,
    state: r.state as Reservation['state'],
    orderId: r.order_id,
    orderRef: r.order_ref,
    expiresAt: r.state === 'held' ? isoOrNull(r.expires_at) : null,
    lines,
    releasedReason: r.released_reason,
    createdAt: iso(r.created_at),
  };
}

export function toInboundLine(l: Row<'inbound_lines'>, item: Row<'stock_items'> | undefined, outOfStockNow: boolean, currency: string): InboundLine {
  return {
    stockItemId: l.stock_item_id,
    sku: item?.sku ?? '',
    label: item?.label ?? '',
    expected: l.expected,
    received: l.received,
    damaged: l.damaged,
    shortage: Math.max(0, l.expected - l.received),
    binCode: l.bin_code,
    unitCost: l.unit_cost_amount === null ? null : money(Number(l.unit_cost_amount), item?.currency.trim() ?? currency),
    sellable: l.sellable ?? Math.max(0, l.received - l.damaged),
    outOfStockNow,
  };
}

/** What a receipt's units arrive against: the purchase order, or the Fulfilled by Marketly inbound shipment */
export const receiptSourceOf = (r: Row<'inbound_receipts'>): ReceiptSource => ({
  kind: r.source_kind,
  id: r.source_id ?? r.purchase_order_id ?? r.receipt_id,
  ref: r.source_ref ?? r.purchase_order_ref ?? r.receipt_ref,
});

export function toInbound(r: Row<'inbound_receipts'>, lines: InboundLine[], openPickShortages: number): InboundReceipt {
  return {
    id: r.id,
    receiptId: r.receipt_id,
    receiptRef: r.receipt_ref,
    source: receiptSourceOf(r),
    ownerType: r.owner_type,
    sellerId: r.seller_id,
    purchaseOrderId: r.purchase_order_id,
    purchaseOrderRef: r.purchase_order_ref,
    supplierName: r.supplier_name,
    locationId: r.location_id,
    receivedBy: actorOf(r.received_by) ?? SYSTEM_ACTOR,
    receivedAt: iso(r.received_at),
    state: r.state as InboundReceipt['state'],
    lines,
    totals: {
      received: lines.reduce((n, l) => n + l.received, 0),
      damaged: lines.reduce((n, l) => n + l.damaged, 0),
      shortage: lines.reduce((n, l) => n + l.shortage, 0),
      sellable: lines.reduce((n, l) => n + l.sellable, 0),
    },
    openPickShortages,
    confirmedBy: actorOf(r.confirmed_by),
    confirmedAt: isoOrNull(r.confirmed_at),
  };
}

export function toReturnOutcome(r: Row<'return_outcomes'>, item: Row<'stock_items'> | undefined, movements: Movement[]): ReturnOutcome {
  return {
    id: r.id,
    returnId: r.return_id,
    returnRef: r.return_ref,
    orderRef: r.order_ref,
    stockItemId: r.stock_item_id,
    sku: item?.sku ?? '',
    label: item?.label ?? '',
    quantity: r.quantity,
    inspectedCondition: r.inspected_condition,
    proposedOutcome: r.proposed_outcome as ReturnOutcome['proposedOutcome'],
    proposedTargetSku: r.proposed_target_sku,
    state: r.state as ReturnOutcome['state'],
    recordedOutcome: (r.recorded_outcome as ReturnOutcome['recordedOutcome']) ?? null,
    targetStockItemId: r.target_stock_item_id,
    movements,
    recordedBy: actorOf(r.recorded_by),
    recordedAt: isoOrNull(r.recorded_at),
    inspectedAt: iso(r.inspected_at),
  };
}

export function toDiscrepancy(d: Row<'discrepancies'>, item: Row<'stock_items'> | undefined, photos: MediaRef[]): Discrepancy {
  return {
    id: d.id,
    kind: d.kind as Discrepancy['kind'],
    stockItemId: d.stock_item_id,
    sku: item?.sku ?? '',
    label: item?.label ?? '',
    locationId: d.location_id,
    binCode: d.bin_code,
    quantity: d.quantity,
    orderId: d.order_id,
    orderRef: d.order_ref,
    note: d.note,
    photos,
    reportedBy: actorOf(d.reported_by) ?? SYSTEM_ACTOR,
    reportedAt: iso(d.reported_at),
    state: d.state as Discrepancy['state'],
    resolution: (d.resolution as Discrepancy['resolution']) ?? null,
    resolutionNote: d.resolution_note,
    resolvedBy: actorOf(d.resolved_by),
    resolvedAt: isoOrNull(d.resolved_at),
  };
}

export const photoIdsOf = (d: Row<'discrepancies'>): string[] => {
  const v = typeof d.photo_media_ids === 'string' ? JSON.parse(d.photo_media_ids) : d.photo_media_ids;
  return Array.isArray(v) ? (v as string[]) : [];
};

export function toTransfer(t: Row<'transfers'>, lines: Row<'transfer_lines'>[], skus: Map<string, string>): Transfer {
  return {
    id: t.id,
    ref: t.ref,
    fromLocationId: t.from_location_id,
    toLocationId: t.to_location_id,
    state: t.state as Transfer['state'],
    lines: lines.map((l) => ({ stockItemId: l.stock_item_id, sku: skus.get(l.stock_item_id) ?? '', quantity: l.quantity, receivedQuantity: l.received_quantity })),
    createdBy: actorOf(t.created_by) ?? SYSTEM_ACTOR,
    note: t.note,
    shippedAt: isoOrNull(t.shipped_at),
    receivedAt: isoOrNull(t.received_at),
  };
}

export function toCount(c: Row<'stock_counts'>, lines: Row<'count_lines'>[], skus: Map<string, string>): StockCount {
  return {
    id: c.id,
    locationId: c.location_id,
    scope: c.scope,
    state: c.state as StockCount['state'],
    lines: lines.map((l) => ({ stockItemId: l.stock_item_id, sku: skus.get(l.stock_item_id) ?? '', binCode: l.bin_code, expected: l.expected, counted: l.counted })),
    createdBy: actorOf(c.created_by) ?? SYSTEM_ACTOR,
    submittedAt: isoOrNull(c.submitted_at),
  };
}
