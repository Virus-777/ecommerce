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
};

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
