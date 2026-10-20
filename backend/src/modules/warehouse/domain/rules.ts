/** Pure warehouse rules: bins and walking order, scans, deadlines, parcels, package numbering. No I/O. */
import type * as common from '../../../spec/common.js';
import type { BoxType, Dimensions, Weight } from '../../../spec/warehouse.js';

export const BIN_KINDS = ['pick', 'bulk', 'returns', 'quarantine', 'packing', 'dock'] as const;
/** Bins stock items are stored in (assignments, put-away of sellable units) */
export const STORAGE_KINDS: readonly string[] = ['pick', 'bulk'];
/** Fulfillment statuses still worked on in the warehouse */
export const ACTIVE_STATUSES = ['awaiting_pick', 'picking', 'picked', 'packing', 'on_hold'] as const;
/** Not packed yet (at risk and late counts) */
export const UNPACKED_STATUSES: readonly string[] = ['awaiting_pick', 'picking', 'picked', 'packing', 'on_hold'];
/** A wave is complete when each of its orders is in one of these */
export const WAVE_DONE_STATUSES: readonly string[] = ['packed', 'dispatched', 'on_hold', 'cancelled'];
/** Put-away of damaged units goes to any quarantine bin when no quarantine bin was known at receipt */
export const QUARANTINE = 'QUARANTINE';
export const NIL_UUID = '00000000-0000-0000-0000-000000000000';

export const SYSTEM: common.Actor = { kind: 'system', id: null, name: 'Warehouse' };

/* ---------------------------------------------------------------- scope */

export type WarehouseFulfilledBy = 'official_warehouse' | 'marketly_service';

/**
 * Which order groups the warehouse picks and packs: Official Store groups and Fulfilled by Marketly groups
 * (seller-owned stock at the service location). Groups sellers ship themselves → null.
 */
export function warehouseGroup(g: { ownerType: 'official' | 'seller'; fulfilledBy: 'official_warehouse' | 'seller' | 'marketly_service' }): WarehouseFulfilledBy | null {
  if (g.fulfilledBy === 'marketly_service' && g.ownerType === 'seller') return 'marketly_service';
  if (g.fulfilledBy === 'official_warehouse' && g.ownerType === 'official') return 'official_warehouse';
  return null;
}

/** Return parcels the warehouse expects: Official Store returns and Fulfilled by Marketly returns come to a Marketly warehouse */
export const comesToWarehouse = (r: { ownerType: 'official' | 'seller'; fulfilledBy?: 'official_warehouse' | 'seller' | 'marketly_service' | null }) => r.ownerType === 'official' || r.fulfilledBy === 'marketly_service';

/** Packing slip seller line of a Fulfilled by Marketly package */
export const soldByLine = (sellerName: string | null | undefined) => `Sold by ${sellerName?.trim() || 'the seller'} · Fulfilled by Marketly`;

export const actorText = (a: common.Actor): string => JSON.stringify({ kind: a.kind, id: a.id ?? null, name: a.name ?? null });
export function parseActor(text: string | null | undefined): common.Actor | null {
  if (!text) return null;
  try {
    const v = JSON.parse(text) as common.Actor;
    if (v && typeof v === 'object' && typeof v.kind === 'string') return { kind: v.kind, id: v.id ?? null, name: v.name ?? null };
  } catch {
    /* plain id */
  }
  return { kind: 'staff', id: text, name: null };
}

/* ---------------------------------------------------------------- bins */

/** A-03-2 → zone A (the segment before the first dash, or the leading letters) */
export function zoneOf(code: string): string {
  const c = code.trim().toUpperCase();
  const dash = c.split(/[-_.\s/]/)[0];
  if (dash && dash !== c) return dash;
  return c.match(/^[A-Z]+/)?.[0] ?? c.slice(0, 1);
}

export const normalizeCode = (code: string) => code.trim().toUpperCase().replace(/\s+/g, '');

/** Unique across locations (bins.barcode is unique; bin codes are unique per location) */
export const binBarcode = (locationId: string, code: string) => `BIN-${locationId.replace(/-/g, '').slice(-8).toUpperCase()}-${code}`;

/** Walking order: zone, then aisle and level compared as numbers (A-2-1 before A-10-1) */
export function compareBinCodes(a: string | null | undefined, b: string | null | undefined): number {
  if (!a && !b) return 0;
  if (!a) return 1;
  if (!b) return -1;
  const pa = a.split(/(\d+)/).filter(Boolean);
  const pb = b.split(/(\d+)/).filter(Boolean);
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
    const x = pa[i];
    const y = pb[i];
    if (x === undefined) return -1;
    if (y === undefined) return 1;
    const nx = /^\d+$/.test(x);
    const ny = /^\d+$/.test(y);
    if (nx && ny && Number(x) !== Number(y)) return Number(x) - Number(y);
    if (!(nx && ny) && x !== y) return x < y ? -1 : 1;
  }
  return 0;
}

/* ---------------------------------------------------------------- scans */

/** Does a scanned item code identify the stock item (SKU label, any case) or its id */
export function itemMatches(code: string, item: { sku: string; stockItemId: string; extraCodes?: (string | null | undefined)[] }): boolean {
  const c = normalizeCode(code);
  if (!c) return false;
  if (c === normalizeCode(item.sku)) return true;
  if (c === item.stockItemId.toUpperCase()) return true;
  return (item.extraCodes ?? []).some((x) => x && normalizeCode(x) === c);
}

export function binMatches(code: string, bin: { code: string; barcode: string }): boolean {
  const c = normalizeCode(code);
  return Boolean(c) && (c === normalizeCode(bin.code) || c === normalizeCode(bin.barcode));
}

export const looksLikeReturnRef = (code: string) => /^RT-/i.test(code.trim());

/* ---------------------------------------------------------------- deadlines and time */

export function deadlineOf(dueAt: Date, now: Date, dueSoonMinutes: number): common.Deadline {
  const ms = dueAt.getTime() - now.getTime();
  return { dueAt: dueAt.toISOString(), state: ms < 0 ? 'overdue' : ms <= dueSoonMinutes * 60_000 ? 'due_soon' : 'on_time' };
}

export const addDays = (date: string, days: number): string => {
  const d = new Date(`${date}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
};

const DAY_NAMES = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
/** 2026-10-14 → 'Wed, Oct 14' */
export function shortDay(date: string): string {
  const d = new Date(`${date.slice(0, 10)}T12:00:00Z`);
  return `${DAY_NAMES[d.getUTCDay()]}, ${MONTHS[d.getUTCMonth()]} ${d.getUTCDate()}`;
}

/** 'UPS Ground · arrives Tue, Oct 13' from the customer's delivery promise */
export function deliveryChoiceLabel(p: { methodName: string; carrier?: string | null; service?: string | null; arrival: common.DateRange }): string {
  const service = p.service ? (p.carrier && !p.service.toLowerCase().startsWith(p.carrier.toLowerCase()) ? `${p.carrier} ${p.service}` : p.service) : p.carrier ? `${p.carrier} ${p.methodName}` : p.methodName;
  const arrives = p.arrival.from === p.arrival.to ? shortDay(p.arrival.to) : `${shortDay(p.arrival.from)} – ${shortDay(p.arrival.to)}`;
  return `${service} · arrives ${arrives}`;
}

/** Whether a carrier quote is the service of the customer's delivery option */
export function matchesChoice(quote: { carrierName: string; serviceName: string }, promise: { carrier?: string | null; service?: string | null }): boolean {
  if (!promise.service && !promise.carrier) return false;
  const svc = quote.serviceName.toLowerCase();
  const carrier = quote.carrierName.toLowerCase();
  if (promise.carrier && !carrier.includes(promise.carrier.toLowerCase()) && !svc.includes(promise.carrier.toLowerCase())) return false;
  if (promise.service && !svc.includes(promise.service.toLowerCase())) return false;
  return true;
}

/* ---------------------------------------------------------------- parcels and boxes */

export const gramsOf = (w: Weight): number => Math.max(1, Math.round(w.unit === 'kg' ? w.value * 1000 : w.value * 453.59237));
export const cmOf = (v: number, unit: Dimensions['unit']) => Math.round((unit === 'in' ? v * 2.54 : v) * 10) / 10;
export const volumeOf = (d: Dimensions) => cmOf(d.length, d.unit) * cmOf(d.width, d.unit) * cmOf(d.height, d.unit);

export function parcelOf(weight: Weight | null, dims: Dimensions | null): { weightGrams: number; lengthCm: number | null; widthCm: number | null; heightCm: number | null } {
  return {
    weightGrams: weight ? gramsOf(weight) : 500,
    lengthCm: dims ? cmOf(dims.length, dims.unit) : null,
    widthCm: dims ? cmOf(dims.width, dims.unit) : null,
    heightCm: dims ? cmOf(dims.height, dims.unit) : null,
  };
}

export function validDimensions(d: Dimensions | null | undefined): boolean {
  return Boolean(d) && [d!.length, d!.width, d!.height].every((n) => typeof n === 'number' && Number.isFinite(n) && n > 0);
}

/**
 * Catalog has no item dimensions, so the suggestion goes by unit count: one unit → the smallest active mailer
 * (or box), several → the smallest box that is not the very smallest when there are more than three units.
 */
export function suggestBox(boxes: BoxType[], units: number): string | null {
  const active = boxes.filter((b) => b.active).sort((a, b) => volumeOf(a.dimensions) - volumeOf(b.dimensions));
  if (!active.length) return null;
  if (units <= 1) return (active.find((b) => b.kind === 'mailer') ?? active[0])!.id;
  const boxesOnly = active.filter((b) => b.kind === 'box');
  const list = boxesOnly.length ? boxesOnly : active;
  return (units > 3 && list.length > 1 ? list[1] : list[0])!.id;
}

/** What still blocks a label: items not scanned, no box or dimensions, no weight */
export function missingForLabel(p: { allScanned: boolean; hasBoxOrDims: boolean; hasWeight: boolean }, requireScan: boolean): string[] {
  const missing: string[] = [];
  if (requireScan && !p.allScanned) missing.push('items');
  if (!p.hasBoxOrDims) missing.push('box');
  if (!p.hasWeight) missing.push('weight');
  return missing;
}

/* ---------------------------------------------------------------- texts */

export const plural = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;

export function shortageHold(binCode: string | null, found: number, expected: number): string {
  const where = binCode ? `bin ${binCode}` : 'the bin';
  return found <= 0 ? `Shortage reported: ${where} empty. Inventory is checking.` : `Shortage reported: ${where} had ${found} of ${expected}. Inventory is checking.`;
}

export const damageHold = (label: string, quantity: number) => `Damage reported: ${quantity} × ${label}. Inventory is checking.`;

/** Pick-up times today (HH:MM market time) still ahead of `now` */
export function upcoming(times: string[], at: (time: string) => Date, now: Date): Date[] {
  return times
    .filter((t) => /^\d{1,2}:\d{2}$/.test(t))
    .map(at)
    .filter((d) => d.getTime() > now.getTime())
    .sort((a, b) => a.getTime() - b.getTime());
}

/**
 * Inside market business hours by the settings calendar (auto-wave runs only then). No calendar, or one that never
 * opens because no hours are set, counts as open: the job then runs every time, as it did before hours existed.
 */
export function inBusinessHours(cal: { isOpen(at: string): boolean; nextOpen(after: string): string } | undefined, now: Date): boolean {
  if (!cal) return true;
  const at = now.toISOString();
  // a calendar that never opens answers nextOpen with the time asked about
  return cal.isOpen(at) || cal.nextOpen(at) === at;
}
