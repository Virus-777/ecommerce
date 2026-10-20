/**
 * Pure cart rules (no I/O): notice kinds and severities, reconciling detected changes with the
 * notices already stored, line state, quantity limits, package keys and customer-facing sentences.
 */
import type { Json } from '../../../kernel/lib/json.js';
import { format as formatMoney, money, type Money } from '../../../kernel/lib/money.js';
import type { CartItem, CartNotice, CartPackage } from '../../../spec/cart.js';
import type * as offers from '../../../spec/offers.js';
import type { NoticeRow } from '../ports.js';

export type NoticeKind = CartNotice['kind'];
export type Severity = CartNotice['severity'];
export type NoticeAction = CartNotice['actions'][number];
export type LineState = CartItem['state'];
export type LimitKind = 'purchase_limit' | 'stock' | 'line_maximum';

/** blocking = excluded from checkout; warning = included after the customer accepts; info = shown once */
export const SEVERITY: Record<NoticeKind, Severity> = {
  price_increased: 'warning',
  price_decreased: 'info',
  out_of_stock: 'blocking',
  quantity_reduced: 'warning',
  purchase_limit_reduced: 'warning',
  offer_ended: 'blocking',
  seller_unavailable: 'blocking',
  product_unavailable: 'blocking',
  not_shippable: 'blocking',
  delivery_estimate_changed: 'info',
  coupon_no_longer_applies: 'info',
  terms_changed: 'warning',
};

/** A new notice replaces open notices of the same family (a price rise replaces a price drop) */
const FAMILY: Record<NoticeKind, string> = {
  price_increased: 'price',
  price_decreased: 'price',
  out_of_stock: 'stock',
  quantity_reduced: 'stock',
  purchase_limit_reduced: 'limit',
  offer_ended: 'offer_ended',
  seller_unavailable: 'seller_unavailable',
  product_unavailable: 'product_unavailable',
  not_shippable: 'not_shippable',
  delivery_estimate_changed: 'delivery',
  coupon_no_longer_applies: 'coupon',
  terms_changed: 'terms',
};

export type JsonObject = { [key: string]: Json };

/** A change detected on a line by the current check */
export interface DesiredNotice {
  kind: NoticeKind;
  previous: JsonObject;
  current: JsonObject;
}

export const desired = (kind: NoticeKind, previous: JsonObject = {}, current: JsonObject = {}): DesiredNotice => ({ kind, previous, current });

const obj = (j: Json | undefined): JsonObject => (j && typeof j === 'object' && !Array.isArray(j) ? (j as JsonObject) : {});

/** What makes two notices of one kind "the same change" (alternatives and wording may refresh) */
export function signature(kind: NoticeKind, current: Json): string {
  const c = obj(current);
  switch (kind) {
    case 'price_increased':
    case 'price_decreased':
      return `${c.price}`;
    case 'quantity_reduced':
      return `${c.available}`;
    case 'purchase_limit_reduced':
      return `${c.limit}`;
    case 'delivery_estimate_changed':
      return `${c.message ?? ''}`;
    case 'coupon_no_longer_applies':
      return `${c.code ?? ''}`;
    case 'terms_changed':
      return `${c.termsVersion ?? ''}`;
    default:
      return '';
  }
}

export interface NoticePlan {
  /** Notices open after the plan is applied */
  open: NoticeRow[];
  insert: NoticeRow[];
  resolve: string[];
}

/**
 * Reconciles one line's stored notices with what the current check detected. Open warnings and
 * blocking notices that are no longer detected are resolved; info notices stay until shown (they are
 * accepted automatically) and are never repeated for the same change.
 */
export function planNotices(itemId: string, stored: NoticeRow[], detected: DesiredNotice[], now: Date, newId: () => string): NoticePlan {
  const open = stored.filter((n) => !n.resolved_at);
  const resolve = new Set<string>();
  const matched = new Set<string>();
  const insert: NoticeRow[] = [];
  for (const d of detected) {
    const sig = signature(d.kind, d.current);
    const same = open.find((o) => o.kind === d.kind && !resolve.has(o.id) && signature(o.kind as NoticeKind, o.current) === sig);
    if (same) {
      matched.add(same.id);
      continue;
    }
    for (const o of open) if (o.kind === d.kind) resolve.add(o.id);
    const severity = SEVERITY[d.kind];
    if (severity === 'info' && stored.some((s) => s.kind === d.kind && s.resolved_at && signature(s.kind as NoticeKind, s.current) === sig)) continue;
    for (const o of open) if (o.kind !== d.kind && FAMILY[o.kind as NoticeKind] === FAMILY[d.kind]) resolve.add(o.id);
    insert.push({
      id: newId(),
      item_id: itemId,
      kind: d.kind,
      severity,
      previous: d.previous,
      current: d.current,
      detected_at: now,
      accepted_at: severity === 'info' ? now : null,
      resolved_at: null,
    });
  }
  for (const o of open) {
    if (matched.has(o.id) || resolve.has(o.id)) continue;
    if (o.severity !== 'info') resolve.add(o.id);
  }
  return { open: [...open.filter((o) => !resolve.has(o.id)), ...insert], insert, resolve: [...resolve] };
}

/** Derived from the open notices (state machine "Cart line availability") */
export function lineState(open: readonly { severity: string }[]): LineState {
  if (open.some((n) => n.severity === 'blocking')) return 'unavailable';
  if (open.some((n) => n.severity === 'warning')) return 'needs_attention';
  return 'ok';
}

/** Condition group of an offer condition (new, used, refurbished), as offers compares them */
export const conditionGroupOf = (c: string): string => (c === 'new' || c === 'refurbished' ? c : 'used');

/** min(offer purchase limit, available stock, platform line maximum), with what sets it */
export function lineMaximum(purchaseLimit: number | null, available: number | null, lineMax: number): { max: number; limitKind: LimitKind } {
  let max = lineMax;
  let limitKind: LimitKind = 'line_maximum';
  if (purchaseLimit !== null && purchaseLimit < max) {
    max = purchaseLimit;
    limitKind = 'purchase_limit';
  }
  if (available !== null && available < max) {
    max = Math.max(available, 0);
    limitKind = 'stock';
  }
  return { max, limitKind };
}

export const minLimit = (...limits: (number | null | undefined)[]): number | null => {
  const l = limits.filter((x): x is number => typeof x === 'number');
  return l.length ? Math.min(...l) : null;
};

export type FulfilledBy = CartPackage['fulfilledBy'];

/** Who ships a line when nothing else says so: the Official Store's warehouse, or the seller */
export const defaultFulfilledBy = (ownerType: string): FulfilledBy => (ownerType === 'official' ? 'official_warehouse' : 'seller');

/**
 * The offer's effective customer-facing fulfilment (Offer.shipping: who ships it, the profile it is quoted with, its
 * dispatch and ships-from). Cart never reads shippingProfileId and dispatch directly; the fallback only covers an offer
 * read without shipping resolved (offers always resolves it).
 */
export function shippingOf(offer: offers.Offer): offers.OfferShipping {
  return offer.shipping ?? { fulfilledBy: offer.fulfilledBy ?? defaultFulfilledBy(offer.ownerType), profileId: offer.shippingProfileId, dispatch: offer.dispatch };
}

/**
 * Stable grouping key: owner type + seller id + fulfilledBy + ship-from (the same function as checkout), so a seller's
 * Marketly-fulfilled and self-shipped items are separate packages
 */
export const packageKey = (ownerType: string, sellerId: string | null, fulfilledBy: string, shipsFrom: string) => `${ownerType}:${sellerId ?? 'official'}:${fulfilledBy}:${shipsFrom}`;

export const plural = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;

/** 'Oct 8' in the market time zone */
export const shortDate = (iso: string | Date, timeZone: string) =>
  new Intl.DateTimeFormat('en-US', { month: 'short', day: 'numeric', timeZone }).format(typeof iso === 'string' ? new Date(iso) : iso);

export const fmt = (amount: number, currency: string) => formatMoney(money(amount, currency));

export interface MessageContext {
  sellerName: string;
  currency: string;
  timeZone: string;
  quantity: number;
}

/** The customer-facing sentence for a notice */
export function noticeMessage(kind: NoticeKind, previous: Json, current: Json, c: MessageContext): string {
  const p = obj(previous);
  const n = obj(current);
  switch (kind) {
    case 'price_increased': {
      const by = typeof n.changedBy === 'string' && n.changedBy ? n.changedBy : null;
      const at = typeof n.changedAt === 'string' ? n.changedAt : null;
      const who = by ? ` ${by} updated this offer${at ? ` on ${shortDate(at, c.timeZone)}` : ''}.` : '';
      return `Price changed since you added it: was ${fmt(Number(p.price), c.currency)}, now ${fmt(Number(n.price), c.currency)}.${who}`;
    }
    case 'price_decreased':
      return `Good news: the price dropped from ${fmt(Number(p.price), c.currency)} to ${fmt(Number(n.price), c.currency)}.`;
    case 'out_of_stock':
      return `Out of stock from ${c.sellerName}. It stays in your cart but can't be checked out.`;
    case 'quantity_reduced':
      return `Only ${n.available} left from ${c.sellerName}. You have ${p.quantity ?? c.quantity} in your cart.`;
    case 'purchase_limit_reduced':
      return `Limit ${n.limit} per customer. You have ${p.quantity ?? c.quantity} in your cart.`;
    case 'offer_ended':
      return `${c.sellerName} is no longer selling this item. It can't be checked out.`;
    case 'seller_unavailable':
      return `${c.sellerName} can't sell this item right now. It stays in your cart but can't be checked out.`;
    case 'product_unavailable':
      return `This product is no longer available. It can't be checked out.`;
    case 'not_shippable':
      return n.postalCode
        ? `${c.sellerName} doesn't ship this item to ${n.postalCode}.`
        : `${c.sellerName} doesn't ship this item to your delivery location.`;
    case 'delivery_estimate_changed':
      return typeof n.message === 'string' && n.message ? n.message : 'The delivery estimate for this item changed.';
    case 'coupon_no_longer_applies':
      return `Coupon ${n.code} no longer applies to this item.`;
    case 'terms_changed':
      return `${c.sellerName} updated the delivery, return or warranty terms of this offer since you added it. Review them to continue.`;
  }
}

/** Actions the UI offers for a notice */
export function noticeActions(kind: NoticeKind, o: { alternatives: boolean; saveForLater: boolean; notifyMe: boolean }): NoticeAction[] {
  const choose: NoticeAction[] = o.alternatives ? ['choose_offer'] : [];
  const save: NoticeAction[] = o.saveForLater ? ['save_for_later'] : [];
  switch (kind) {
    case 'price_increased':
    case 'terms_changed':
      return ['accept', 'remove', ...choose];
    case 'quantity_reduced':
    case 'purchase_limit_reduced':
      return ['accept', 'reduce_quantity', 'remove'];
    case 'out_of_stock':
      return ['remove', ...choose, ...save, ...(o.notifyMe ? (['notify_me'] as NoticeAction[]) : [])];
    case 'offer_ended':
    case 'seller_unavailable':
    case 'product_unavailable':
    case 'not_shippable':
      return ['remove', ...choose, ...save];
    default:
      return [];
  }
}

/** Offer status → the blocking notice an unsellable offer gives its lines (null = sellable) */
export function offerBlock(status: string, reasonCode?: string | null): NoticeKind | null {
  if (status === 'active') return null;
  if (status === 'out_of_stock') return 'out_of_stock';
  if (reasonCode === 'seller_restricted' || reasonCode === 'seller_suspended' || reasonCode === 'seller_closed') return 'seller_unavailable';
  if (reasonCode === 'product_hidden' || reasonCode === 'product_suspended') return 'product_unavailable';
  return 'offer_ended';
}

/** Reason sent with OFFER_UNAVAILABLE */
export const unavailableReason: Record<string, string> = {
  out_of_stock: 'out_of_stock',
  offer_ended: 'offer_ended',
  seller_unavailable: 'seller_unavailable',
  product_unavailable: 'product_unavailable',
};

export const unavailableMessage: Record<string, string> = {
  out_of_stock: 'This offer is out of stock.',
  offer_ended: 'This offer is no longer available.',
  seller_unavailable: "This seller can't sell this item right now.",
  product_unavailable: 'This product is no longer available.',
};

/** Postal codes: US ZIP or ZIP+4; elsewhere 3–10 letters, digits, spaces or dashes */
export function validPostalCode(country: string, code: string): boolean {
  if (country === 'US') return /^\d{5}(-\d{4})?$/.test(code);
  return /^[A-Za-z0-9][A-Za-z0-9 -]{1,8}[A-Za-z0-9]$/.test(code);
}

/** Stored coupon codes with the lines each covered at the last check */
export interface StoredCoupon {
  code: string;
  covered: string[];
}

export function storedCoupons(j: Json): StoredCoupon[] {
  if (!Array.isArray(j)) return [];
  return j
    .map((c) => (typeof c === 'string' ? { code: c, covered: [] } : c && typeof c === 'object' && !Array.isArray(c) && typeof c.code === 'string' ? { code: c.code, covered: Array.isArray(c.covered) ? c.covered.filter((x): x is string => typeof x === 'string') : [] } : null))
    .filter((c): c is StoredCoupon => c !== null);
}

export const normalizeCode = (code: string) => code.trim().toUpperCase();

export const addDays = (d: Date, days: number) => new Date(d.getTime() + days * 86_400_000);

/** Rows grouped by a key, groups in the order of their first row (Map.groupBy, which the ES2023 lib lacks) */
export function groupBy<T>(rows: readonly T[], key: (row: T) => string): Map<string, T[]> {
  const out = new Map<string, T[]>();
  for (const row of rows) {
    const k = key(row);
    const group = out.get(k);
    if (group) group.push(row);
    else out.set(k, [row]);
  }
  return out;
}