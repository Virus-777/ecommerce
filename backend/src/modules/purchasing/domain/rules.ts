/**
 * Pure purchasing rules: quantities, money, receiving checks, labels and references. No I/O.
 */
import { AppError } from '../../../kernel/errors/index.js';
import { allocate, money, type Money } from '../../../kernel/lib/money.js';
import type * as common from '../../../spec/common.js';

/* ------------------------------------------------------------------ statuses */

export type PoStatus = 'draft' | 'sent' | 'partly_received' | 'received' | 'cancelled';
export type DeliveryStatus = 'expected' | 'delayed' | 'arrived' | 'receiving' | 'received' | 'received_with_issues' | 'cancelled';
export type ReceiptStatus = 'in_progress' | 'awaiting_confirmation' | 'confirmed' | 'cancelled';
export type ClaimStatus = 'open' | 'submitted' | 'settled' | 'rejected' | 'withdrawn';
export type ClaimKind = 'shortage' | 'damage' | 'wrong_item' | 'other';

/** Draft, Sent and Partly received count as open purchase orders (prototype: 5 open of 7, committed = their totals). */
export const OPEN_PO_STATUSES: readonly PoStatus[] = ['draft', 'sent', 'partly_received'];
/** Sent to the supplier and not finished: their open quantities are Incoming. */
export const INCOMING_PO_STATUSES: readonly PoStatus[] = ['sent', 'partly_received'];
/** Submitted receiving records (counted). */
export const SUBMITTED_RECEIPT_STATUSES: readonly ReceiptStatus[] = ['awaiting_confirmation', 'confirmed'];
/** Claims still being followed up. */
export const ACTIVE_CLAIM_STATUSES: readonly ClaimStatus[] = ['open', 'submitted'];

export const SEND_ACTION = 'purchasing.orders.send';
export const RECEIVING_DATASET = 'purchasing.admin.receiving';

/* ------------------------------------------------------------------ errors */

export const invalid = (path: string, message: string) => new AppError('VALIDATION_FAILED', message, { issues: [{ path, message }] });
export const invalidMany = (message: string, issues: { path: string; message: string }[]) => new AppError('VALIDATION_FAILED', message, { issues });

/* ------------------------------------------------------------------ actors (stored as JSON text) */

export const SYSTEM: common.Actor = { kind: 'system', id: null, name: 'Marketly' };

export const actorText = (a: common.Actor): string => JSON.stringify({ kind: a.kind, id: a.id ?? null, name: a.name ?? null });

export function parseActor(text: string | null | undefined): common.Actor | null {
  if (!text) return null;
  try {
    const a = JSON.parse(text) as common.Actor;
    if (a && typeof a === 'object' && typeof a.kind === 'string') return { kind: a.kind, id: a.id ?? null, name: a.name ?? null };
  } catch {
    /* a plain id */
  }
  return { kind: 'staff', id: text, name: null };
}

/* ------------------------------------------------------------------ lines and money */

export interface LineQty {
  qtyOrdered: number;
  qtyReceived: number;
  qtyClosed: number;
}

/** Units still to come: ordered − received − closed short, never below zero. */
export const openQty = (l: LineQty) => Math.max(l.qtyOrdered - l.qtyReceived - l.qtyClosed, 0);

/** Freight split over lines pro rata by line value (largest remainder, no cent lost). */
export function freightShares(freight: Money, lines: { unitCostAmount: number; qtyOrdered: number }[]): Money[] {
  return allocate(freight, lines.map((l) => l.unitCostAmount * l.qtyOrdered));
}

/** Buying cost per unit passed to inventory: PO unit cost plus the line's freight share per ordered unit. */
export function landedUnitCost(unitCostAmount: number, qtyOrdered: number, freightShare: Money): Money {
  const perUnit = qtyOrdered > 0 ? Math.round(freightShare.amount / qtyOrdered) : 0;
  return money(unitCostAmount + perUnit, freightShare.currency);
}

/* ------------------------------------------------------------------ receiving */

export interface CountedLine {
  purchaseOrderLineId: string;
  expected: number;
  received: number;
  damaged: number;
  photoIds: string[];
}

export const shortageOf = (l: { expected: number; received: number }) => Math.max(l.expected - l.received, 0);
export const overOf = (l: { expected: number; received: number }) => Math.max(l.received - l.expected, 0);
export const lineHasIssue = (l: { expected: number; received: number; damaged: number }) => shortageOf(l) > 0 || overOf(l) > 0 || l.damaged > 0;
export const receiptHasIssues = (lines: readonly { expected: number; received: number; damaged: number }[]) => lines.some(lineHasIssue);

/** Most units a PO line may receive in total: ordered plus the allowed over-receipt percentage (rounded down). */
export const maxReceivable = (qtyOrdered: number, overReceiptAllowedPct: number) => qtyOrdered + Math.floor((qtyOrdered * Math.max(overReceiptAllowedPct, 0)) / 100);

/**
 * OVER_RECEIPT when a counted line would take the PO line above ordered + the allowed over-receipt.
 * `alreadyReceived` is what earlier receipts recorded for the PO line.
 */
export function checkOverReceipt(lines: readonly { purchaseOrderLineId: string; received: number; qtyOrdered: number; alreadyReceived: number }[], pct: number) {
  const over = lines.filter((l) => l.alreadyReceived + l.received > maxReceivable(l.qtyOrdered, pct));
  if (over.length) {
    throw new AppError('OVER_RECEIPT', 'More units were counted than were ordered. Check the count or ask Purchasing to add a purchase order line.', {
      lines: over.map((l) => ({ purchaseOrderLineId: l.purchaseOrderLineId, received: l.received, allowed: Math.max(maxReceivable(l.qtyOrdered, pct) - l.alreadyReceived, 0) })),
    });
  }
}

/** DAMAGE_PHOTOS_REQUIRED when a damaged line has no photo. */
export function checkDamagePhotos(lines: readonly CountedLine[], required: boolean) {
  if (!required) return;
  const missing = lines.filter((l) => l.damaged > 0 && l.photoIds.length === 0);
  if (missing.length) {
    throw new AppError('DAMAGE_PHOTOS_REQUIRED', 'Add at least one photo to every line with damaged units.', { lines: missing.map((l) => l.purchaseOrderLineId) });
  }
}

/** PO event after a submitted receipt: everything in (receiveAll) or more to come (receivePart). */
export const receiveEvent = (lines: readonly LineQty[]): 'receiveAll' | 'receivePart' => (lines.every((l) => openQty(l) === 0) ? 'receiveAll' : 'receivePart');

/* ------------------------------------------------------------------ dates and labels */

const MONTH = new Intl.DateTimeFormat('en-US', { month: 'short', day: 'numeric', timeZone: 'UTC' });
/** 'Oct 6' from '2026-10-06' */
export const shortDate = (date: string) => MONTH.format(new Date(`${date}T00:00:00Z`));

export function addDays(date: string, days: number): string {
  const d = new Date(`${date}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}

/** Monday of the week of a date (YYYY-MM-DD). */
export function startOfWeek(date: string): string {
  const d = new Date(`${date}T00:00:00Z`);
  const dow = (d.getUTCDay() + 6) % 7; // Monday = 0
  return addDays(date, -dow);
}

export const minDate = (dates: readonly (string | null | undefined)[]): string | null =>
  dates.filter((d): d is string => !!d).reduce<string | null>((a, b) => (a === null || b < a ? b : a), null);
export const maxDate = (dates: readonly (string | null | undefined)[]): string | null =>
  dates.filter((d): d is string => !!d).reduce<string | null>((a, b) => (a === null || b > a ? b : a), null);

export interface LabelLine extends LineQty {
  expectedDate: string | null;
}

/** 'Oct 6 · 80 due Oct 13', 'Oct 16' or 'Not set' */
export function expectedLabel(poExpected: string | null, lines: readonly LabelLine[], status: PoStatus): string {
  const first = poExpected ?? minDate(lines.map((l) => l.expectedDate));
  if (!first) return 'Not set';
  const open = lines.filter((l) => openQty(l) > 0);
  if (status === 'partly_received' && open.length) {
    const units = open.reduce((n, l) => n + openQty(l), 0);
    const due = maxDate(open.map((l) => l.expectedDate ?? poExpected));
    if (due && due !== first) return `${shortDate(first)} · ${units} due ${shortDate(due)}`;
    return `${shortDate(first)} · ${units} still due`;
  }
  return shortDate(first);
}

/** 'Rest due Oct 13', 'Complete', 'Closed short' or null */
export function lineNote(l: LabelLine, poExpected: string | null): string | null {
  const open = openQty(l);
  if (open === 0 && l.qtyClosed > 0) return 'Closed short';
  if (open === 0 && l.qtyReceived > 0) return 'Complete';
  if (open > 0 && l.qtyReceived > 0) {
    const due = l.expectedDate ?? poExpected;
    return due ? `Rest due ${shortDate(due)}` : `${open} still due`;
  }
  return null;
}

/**
 * Late or short: sent to the supplier and either partly received with units still due,
 * a line past its expected date with units open, or a delivery marked delayed.
 */
export function isLateOrShort(status: PoStatus, poExpected: string | null, lines: readonly LabelLine[], anyDelayedDelivery: boolean, today: string): boolean {
  if (!INCOMING_PO_STATUSES.includes(status)) return false;
  const open = lines.filter((l) => openQty(l) > 0);
  if (!open.length) return false;
  if (status === 'partly_received' || anyDelayedDelivery) return true;
  return open.some((l) => {
    const due = l.expectedDate ?? poExpected;
    return !!due && due < today;
  });
}

/** 'Los Angeles, CA' from an address */
export const locationOf = (a: common.Address | null | undefined): string => (a ? [a.city, a.region].filter(Boolean).join(', ') : '');

/* ------------------------------------------------------------------ references */

export interface RefFormat {
  prefix: string;
  period: 'YYMM' | 'YYMMDD' | null;
  digits: number;
}

/** 'PUR-YYMM-NNNN' → { prefix: 'PUR', period: 'YYMM', digits: 4 } (falls back to the default for anything else). */
export function parseRefFormat(format: string, fallback: RefFormat): RefFormat {
  const m = /^([A-Z][A-Z0-9]*)-(?:(YYMMDD|YYMM)-)?(N{2,8})$/.exec(format.trim());
  if (!m) return fallback;
  return { prefix: m[1]!, period: (m[2] as RefFormat['period']) ?? null, digits: m[3]!.length };
}

/** The counter key for a reference: 'PUR-2610' for YYMM in October 2026. `day` is YYYY-MM-DD in the market zone. */
export function refStem(f: RefFormat, day: string): string {
  const yymmdd = day.replace(/-/g, '').slice(2);
  if (f.period === 'YYMM') return `${f.prefix}-${yymmdd.slice(0, 4)}`;
  if (f.period === 'YYMMDD') return `${f.prefix}-${yymmdd}`;
  return f.prefix;
}

/* ------------------------------------------------------------------ reorder suggestions */

/**
 * Units to order so stock covers `coverDays` of sales above the reorder point; without a sales
 * rate, back up to twice the reorder point. Never below the supplier's minimum order quantity.
 */
export function suggestedQuantity(input: { available: number; incoming: number; reorderPoint: number; avgDailySales: number | null; coverDays: number; minOrderQuantity: number | null }): number {
  const projected = input.available + input.incoming;
  const target = input.avgDailySales !== null && input.avgDailySales > 0 ? Math.ceil(input.avgDailySales * input.coverDays) + input.reorderPoint : Math.max(input.reorderPoint * 2, 1);
  return Math.max(target - projected, input.minOrderQuantity ?? 1, 1);
}

/* ------------------------------------------------------------------ performance */

const round2 = (n: number) => Math.round(n * 100) / 100;
export const pct = (part: number, whole: number): number | null => (whole > 0 ? round2((part / whole) * 100) : null);
export const days = (ms: number) => round2(ms / 86_400_000);
