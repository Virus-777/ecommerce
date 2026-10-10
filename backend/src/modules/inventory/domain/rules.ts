/**
 * Pure stock rules (no I/O): the five stock groups, moves between them, stock state, reason labels,
 * weighted average cost and the reservation state derived from its lines.
 */
import type { StockQuantities } from '../../../spec/inventory.js';

export type Group = 'available' | 'reserved' | 'incoming' | 'damaged_held' | 'returned';
export type GroupOrOutside = Group | 'outside';
export type StockState = 'in_stock' | 'low_stock' | 'out_of_stock';
export type ReservationState = 'held' | 'allocated' | 'fulfilled' | 'released' | 'expired';

export const GROUPS: readonly Group[] = ['available', 'reserved', 'incoming', 'damaged_held', 'returned'];

/** API field of each group in StockQuantities */
export const FIELD: Record<Group, keyof StockQuantities> = {
  available: 'available',
  reserved: 'reserved',
  incoming: 'incoming',
  damaged_held: 'damagedHeld',
  returned: 'returned',
};

export const GROUP_INFO: Record<Group, { label: string; meaning: string }> = {
  available: { label: 'Available', meaning: 'Sellable to new customers' },
  reserved: { label: 'Reserved', meaning: 'Held during checkout or allocated to accepted orders' },
  incoming: { label: 'Incoming', meaning: 'Expected from suppliers or transfers, or received and waiting for confirmation' },
  damaged_held: { label: 'Damaged or held', meaning: 'Awaiting inspection or unsuitable for sale' },
  returned: { label: 'Returned', meaning: 'Received back, needs a condition decision' },
};

export const zeroQty = (): StockQuantities => ({ available: 0, reserved: 0, incoming: 0, damagedHeld: 0, returned: 0 });

export const addQty = (a: StockQuantities, b: StockQuantities): StockQuantities => ({
  available: a.available + b.available,
  reserved: a.reserved + b.reserved,
  incoming: a.incoming + b.incoming,
  damagedHeld: a.damagedHeld + b.damagedHeld,
  returned: a.returned + b.returned,
});

export const isGroup = (g: string): g is Group => (GROUPS as readonly string[]).includes(g);

/** Units a group holds (outside is unlimited) */
export const unitsIn = (q: StockQuantities, g: GroupOrOutside): number => (g === 'outside' ? Number.POSITIVE_INFINITY : q[FIELD[g]]);

/** Quantities after moving n units from one group to another (outside = entering or leaving stock). */
export function applyMove(q: StockQuantities, from: GroupOrOutside, to: GroupOrOutside, n: number): StockQuantities {
  const out = { ...q };
  if (from !== 'outside') out[FIELD[from]] -= n;
  if (to !== 'outside') out[FIELD[to]] += n;
  return out;
}

/**
 * Sellable rule (Fulfilled by Marketly, decision D4): whether an item's Available units at a location can be sold.
 * The location must be sellable and active; a seller item sells from its service location when one is set
 * (stock_items.service_location_id) and otherwise only from its own (seller) location; company locations never sell
 * a seller item that is not designated there, and company stock sells from company locations only.
 */
export function sellsFrom(
  item: { owner_type: string; service_location_id: string | null },
  loc: { id: string; owner_type: string; sellable: boolean; active: boolean } | undefined,
): boolean {
  if (!loc || !loc.sellable || !loc.active) return false;
  if (item.owner_type === 'seller') return item.service_location_id ? loc.id === item.service_location_id : loc.owner_type === 'seller';
  return loc.owner_type === 'official';
}

/** Units physically held (valued at cost): everything except Incoming */
export const onHand = (q: StockQuantities) => q.available + q.reserved + q.damagedHeld + q.returned;

/** Stock state from the sellable Available quantity and the low-stock threshold (null = no low state). */
export function stockState(available: number, threshold: number | null | undefined): StockState {
  if (available <= 0) return 'out_of_stock';
  if (threshold !== null && threshold !== undefined && available <= threshold) return 'low_stock';
  return 'in_stock';
}

/** Weighted average unit cost after adding units at a cost (minor units, rounded half up). */
export function weightedAverage(current: number | null, currentUnits: number, addCost: number, addUnits: number): number {
  if (addUnits <= 0) return current ?? addCost;
  if (current === null || currentUnits <= 0) return addCost;
  return Math.round((current * currentUnits + addCost * addUnits) / (currentUnits + addUnits));
}

/* ---------------------------------------------------------------- reasons */

export const SELLER_REASONS = ['received_stock', 'count_correction', 'damaged_or_defective', 'lost_or_missing', 'returned_item_restocked', 'moved_to_another_channel', 'other'] as const;
export const STAFF_REASONS = ['quality_hold', 'damaged_in_warehouse', 'count_correction', 'found_stock', 'theft_or_loss', 'write_off', 'repair', 'supplier_return', 'other'] as const;

const REASON_LABELS: Record<string, string> = {
  // seller adjustments
  received_stock: 'Received stock',
  count_correction: 'Count correction',
  damaged_or_defective: 'Damaged or defective',
  lost_or_missing: 'Lost or missing',
  returned_item_restocked: 'Returned item restocked',
  moved_to_another_channel: 'Moved to another sales channel',
  other: 'Other',
  // staff adjustments
  quality_hold: 'Quality hold',
  damaged_in_warehouse: 'Damaged in warehouse',
  found_stock: 'Found stock',
  theft_or_loss: 'Theft or loss',
  write_off: 'Write-off',
  repair: 'Repair',
  supplier_return: 'Return to supplier',
  // system movements
  initial: 'Opening stock',
  bulk_update: 'Bulk update',
  checkout_hold: 'Checkout hold',
  hold_released: 'Checkout hold released',
  hold_expired: 'Checkout hold expired',
  order_cancelled: 'Order item cancelled',
  staff_release: 'Released by staff',
  dispatched: 'Dispatched',
  purchase_order_sent: 'Purchase order sent',
  purchase_order_changed: 'Purchase order changed',
  purchase_order_cancelled: 'Purchase order cancelled or short-closed',
  received_over_expected: 'Received more than expected',
  receipt_confirmed: 'Received and confirmed',
  receipt_damaged: 'Damaged on receipt',
  receipt_not_accepted: 'Received units not accepted',
  return_received: 'Return received',
  return_restock: 'Return restocked',
  return_different_condition: 'Return restocked in a different condition',
  return_damaged_stock: 'Return kept as damaged stock',
  return_repair: 'Return sent for repair',
  return_to_supplier: 'Return to supplier',
  return_write_off: 'Return written off',
  pick_shortage: 'Pick shortage',
  damage_found: 'Damage found at packing',
  reallocated: 'Reallocated to order',
  transfer_shipped: 'Transfer sent',
  transfer_received: 'Transfer received',
  transfer_short: 'Transfer short on arrival',
  count_difference: 'Stock count difference',
  allocated_for_order: 'Allocated for a replacement or exchange',
  allocation_released: 'Replacement or exchange allocation released',
  hold_unmatched: 'Held units not on the accepted order',
  merged_out: 'Merged into another SKU',
  merged_in: 'Merged from another SKU',
  // Fulfilled by Marketly (seller stock in a Marketly warehouse)
  service_inbound_expected: 'Inbound shipment to Marketly',
  service_inbound_changed: 'Inbound shipment to Marketly changed',
  service_inbound_closed: 'Inbound shipment to Marketly closed',
  service_return_received: 'Return received at Marketly',
  service_return_restocked: 'Return restocked at Marketly',
  service_return_unsellable: 'Return kept as unsellable at Marketly',
  service_return_disposed: 'Return disposed of at Marketly',
  service_removal_reserved: 'Set aside for a removal order',
  service_removal_completed: 'Removal order completed',
  service_found: 'Found at Marketly',
  service_reconcile: 'Reconciled with the fulfillment service',
};

/** moveServiceStock reason codes (contract K7) */
export const SERVICE_REASONS = [
  'service_return_received',
  'service_return_restocked',
  'service_return_unsellable',
  'service_return_disposed',
  'service_removal_reserved',
  'service_removal_completed',
  'service_found',
  'service_reconcile',
] as const;

export const reasonLabel = (code: string) => REASON_LABELS[code] ?? code.replace(/_/g, ' ').replace(/^./, (c) => c.toUpperCase());

/** 'Halden Aurora ANC Headphones, Black' → product title and variant label */
export function splitLabel(label: string): { productTitle: string; variantLabel: string } {
  const i = label.lastIndexOf(', ');
  return i > 0 ? { productTitle: label.slice(0, i), variantLabel: label.slice(i + 2) } : { productTitle: label, variantLabel: '' };
}

/* ---------------------------------------------------------------- reservations */

export interface LineQty {
  quantity: number;
  fulfilled: number;
  released: number;
  state: string;
}

/** Units still reserved for a line */
export const openQty = (l: LineQty) => Math.max(0, l.quantity - l.fulfilled - l.released);

/** A line's state after its quantities changed: open lines keep held/allocated; closed lines are fulfilled or released. */
export function lineStateAfter(l: LineQty, closedAs: 'released' | 'expired' = 'released'): ReservationState {
  if (openQty(l) > 0) return (l.state === 'allocated' ? 'allocated' : 'held');
  if (l.fulfilled > 0) return 'fulfilled';
  return l.state === 'expired' ? 'expired' : closedAs;
}

/** The reservation's state is the furthest state of its open lines; with none open, how they ended. */
export function reservationStateOf(lines: { state: string }[]): ReservationState {
  const states = new Set(lines.map((l) => l.state));
  if (states.has('allocated')) return 'allocated';
  if (states.has('held')) return 'held';
  if (states.has('fulfilled')) return 'fulfilled';
  if (states.has('released')) return 'released';
  if (states.has('expired')) return 'expired';
  return 'released';
}

export interface MappableLine {
  id: string;
  stockItemId: string;
  /** Units of the line (open units for a line nothing has left yet) */
  quantity: number;
  orderItemId: string | null;
  /** Nothing fulfilled or released yet, so the line may be split between order items */
  splittable: boolean;
}

export interface LineMapping {
  lineId: string;
  orderItemId: string | null;
  /** The line's new quantity (the first piece) */
  quantity: number;
  /** Further pieces, each a new line at the same location (orderItemId null: units the order did not ask for) */
  extra: { orderItemId: string | null; quantity: number }[];
}

/**
 * Maps a reservation's lines to the order's items (orders.order.accepted items) by stock item and quantity.
 * Lines already mapped (checkout's attachOrder) keep their order item and count against it; free lines are
 * matched on exact quantity first, then filled in item order, splitting a line when it spans two order items
 * (a hold has one line per stock item and location, an order one item per offer line). Only lines that change
 * are returned.
 */
export function mapLinesToItems(lines: MappableLine[], items: { orderItemId: string; stockItemId: string; quantity: number }[]): LineMapping[] {
  const out: LineMapping[] = [];
  for (const stockItemId of new Set(lines.map((l) => l.stockItemId))) {
    const need = new Map<string, number>();
    for (const i of items) if (i.stockItemId === stockItemId && i.quantity > 0) need.set(i.orderItemId, (need.get(i.orderItemId) ?? 0) + i.quantity);
    if (!need.size) continue;
    const own = lines.filter((l) => l.stockItemId === stockItemId);
    for (const l of own) if (l.orderItemId && need.has(l.orderItemId)) need.set(l.orderItemId, Math.max(0, need.get(l.orderItemId)! - l.quantity));
    const free = own.filter((l) => !l.orderItemId && l.quantity > 0);
    const done = new Set<string>();
    // exact quantity first
    for (const l of free) {
      const hit = [...need].find(([, n]) => n === l.quantity);
      if (!hit) continue;
      need.set(hit[0], 0);
      done.add(l.id);
      out.push({ lineId: l.id, orderItemId: hit[0], quantity: l.quantity, extra: [] });
    }
    for (const l of free.filter((x) => !done.has(x.id))) {
      const open = [...need].filter(([, n]) => n > 0);
      if (!open.length) break;
      if (!l.splittable) {
        const [oid, n] = open.reduce((a, b) => (b[1] > a[1] ? b : a));
        need.set(oid, Math.max(0, n - l.quantity));
        out.push({ lineId: l.id, orderItemId: oid, quantity: l.quantity, extra: [] });
        continue;
      }
      const pieces: { orderItemId: string | null; quantity: number }[] = [];
      let left = l.quantity;
      for (const [oid, n] of open) {
        if (left <= 0) break;
        const take = Math.min(left, n);
        need.set(oid, n - take);
        pieces.push({ orderItemId: oid, quantity: take });
        left -= take;
      }
      if (left > 0) pieces.push({ orderItemId: null, quantity: left });
      out.push({ lineId: l.id, orderItemId: pieces[0]!.orderItemId, quantity: pieces[0]!.quantity, extra: pieces.slice(1) });
    }
  }
  return out;
}

/** Customer-facing label of an offer's stock */
export function availabilityLabel(state: StockState, quantity: number, purchaseLimit: number | null): string {
  if (state === 'out_of_stock') return 'Out of stock';
  if (state === 'low_stock') return `${quantity} left`;
  if (purchaseLimit !== null) return `Limit ${purchaseLimit} per customer`;
  return 'In stock';
}

/** Days between two YYYY-MM-DD dates */
export const addDays = (date: string, days: number): string => {
  const d = new Date(`${date}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
};
