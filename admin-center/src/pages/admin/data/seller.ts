// API helpers shared by the admin seller screens (Sellers list, Seller 360, Seller application review).
// Data: GET /api/admin/sellers/sellers (+ /stats, /{id}), /applications (+ /{id}), the AdminSeller screen query.
import { useEffect, useRef, useState } from 'react';
import type { components } from '@marketly/web-shared/api';
import type { Tint } from '@marketly/web-shared/data/fixtures';
import { formatMoney, type MoneyValue, initials, tileTint } from '@marketly/web-shared/lib/format';

type S = components['schemas'];
export type SellerRow = S['sellers.SellerRow'];
export type SellerDetail = S['sellers.SellerAdminDetail'];
export type Restriction = S['sellers.Restriction'];
export type Appeal = S['sellers.Appeal'];
export type ApplicationAdmin = S['sellers.ApplicationAdmin'];
export type ApplicationRow = S['sellers.ApplicationRow'];
export type Actor = S['Actor'];
export type TimelineEvent = S['TimelineEvent'];

/** API seller status -> the design's label. */
export const SELLER_STATUS: Record<string, string> = {
  applied: 'Applied',
  information_required: 'Information required',
  under_review: 'Under review',
  approved: 'Approved',
  restricted: 'Restricted',
  suspended: 'Suspended',
  closed: 'Closed',
};

/** "partly_overturned" -> "Partly overturned" */
export const cap = (s: string) => {
  const t = s.replace(/_/g, ' ').toLowerCase();
  return t.charAt(0).toUpperCase() + t.slice(1);
};
export const statusLabel = (s?: string | null) => (s ? (SELLER_STATUS[s.toLowerCase()] ?? cap(s)) : '');

/** Store name -> logo tile initials and a stable tint (the API sends a logo image; the design shows tiles). */
export const initialsOf = (name: string) => initials(name);
export const tintOf = (name: string): Tint => tileTint(name) as Tint;

export const signedMoney = (m?: MoneyValue | null) => (!m ? '—' : m.amount < 0 ? `−${formatMoney({ ...m, amount: -m.amount })}` : formatMoney(m));

/** { positivePct, ratingCount } from reviews (OpenAPI types it unknown, G20). */
export interface Feedback {
  positivePct?: number | null;
  ratingCount?: number | null;
}
export const feedbackLabel = (f: unknown) => {
  const v = (f ?? {}) as Feedback;
  return v.positivePct != null && v.ratingCount ? `${Math.round(v.positivePct)}% · ${v.ratingCount.toLocaleString('en-US')}` : '';
};

/** sellers.SellerAdminDetail.owner */
export interface Owner {
  name?: string | null;
  email?: string | null;
  phone?: string | null;
}

/** sellers.SellerAdminDetail.payouts */
export interface Payouts {
  pending?: MoneyValue | null;
  available?: MoneyValue | null;
  held?: MoneyValue | null;
  // finance's Hold names who placed it `placedBy`
  holds?: Array<{ amount?: MoneyValue | null; reason?: string | null; reviewDate?: string | null; placedBy?: Actor | null }>;
  nextPayout?: {
    scheduledFor?: string | null;
    estimatedAmount?: MoneyValue | null;
    destination?: { label?: string | null; status?: string | null } | null;
    arrivesNote?: string | null;
    note?: string | null;
  } | null;
}

/** sellers.SellerAdminDetail.obligations */
export interface Obligations {
  openOrders?: number;
  overdueOrders?: Array<{ orderId: string; orderRef: string; itemTitle?: string | null; statusLabel?: string | null; deadline?: { dueAt: string; state?: string | null } | null }>;
  openReturns?: Array<{ id: string; ref: string }>;
  openCases?: Array<{ id: string; ref: string }>;
}

type Due = { dueAt: string; state?: string | null } | null;

/** AdminSeller screen query: the parts the seller page uses (orders, returns, cases). */
export interface AdminSellerGql {
  sellerAdmin: {
    id: string;
    returns?: { items: Array<{ id: string; ref: string; orderRef?: string | null; status: string; statusLabel?: string | null; nextDeadline?: Due }> } | null;
    cases?: { items: Array<{ id: string; ref: string; subject?: string | null; status: string; statusLabel?: string | null; expectedResponse?: Due }> } | null;
  } | null;
  ordersAdmin?: {
    items: Array<{
      id: string;
      ref: string;
      groups: Array<{ id: string; seller?: { id: string } | null; status: string; statusLabel?: string | null; deadlineLabel?: string | null; dispatchDeadline?: Due; itemsSummary?: string | null }>;
    }>;
  } | null;
}

export const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** Order group statuses that are finished (everything else still needs the seller). */
export const CLOSED_GROUP = new Set(['DELIVERED', 'CANCELLED', 'COMPLETED', 'REFUNDED', 'RETURNED', 'CLOSED', 'SHIPPED', 'IN_TRANSIT']);
/** Return statuses that are finished. */
export const CLOSED_RETURN = new Set(['REJECTED', 'REFUNDED', 'CLOSED', 'CANCELLED', 'WITHDRAWN', 'COMPLETED', 'EXPIRED']);

/** Input value that follows `value` after `ms` without changes. */
export function useDebounced<T>(value: T, ms = 300): T {
  const [v, setV] = useState(value);
  useEffect(() => {
    const t = setTimeout(() => setV(value), ms);
    return () => clearTimeout(t);
  }, [value, ms]);
  return v;
}

/** Calls `onVisible` when the returned element scrolls into view (phone "load more"). */
export function useInView<T extends HTMLElement>(onVisible: () => void, enabled: boolean) {
  const ref = useRef<T | null>(null);
  const cb = useRef(onVisible);
  cb.current = onVisible;
  useEffect(() => {
    const el = ref.current;
    if (!el || !enabled || typeof IntersectionObserver === 'undefined') return;
    const io = new IntersectionObserver((es) => {
      if (es.some((e) => e.isIntersecting)) cb.current();
    });
    io.observe(el);
    return () => io.disconnect();
  }, [enabled]);
  return ref;
}

/** Today + n days as YYYY-MM-DD in Pacific time (date inputs). */
export const isoDay = (daysFromToday: number) => new Date(Date.now() + daysFromToday * 86_400_000).toLocaleDateString('en-CA', { timeZone: 'America/Los_Angeles' });

/** The Pacific calendar day of a YYYY-MM-DD date input as an end-of-day ISO instant (API datetimes). */
export const endOfDayIso = (day: string) => new Date(`${day}T23:59:00-07:00`).toISOString();
