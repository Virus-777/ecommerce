// API helpers for the admin Shipping settings screen (design: pages/admin/admin-shipping.html).
// Data: GET /api/admin/shipping/{summary,carriers,methods,profiles,zones,dispatch-targets,notices,free-shipping-rules}.
import type { components } from '@marketly/web-shared/api';

type S = components['schemas'];
export type Carrier = S['shipping.Carrier'];
export type ShippingMethod = S['shipping.ShippingMethod'];
export type Zone = S['shipping.Zone'];
export type ShippingProfile = S['shipping.ShippingProfile'];
export type ServiceNotice = S['shipping.ServiceNotice'];
export type FreeShippingRule = S['shipping.FreeShippingRule'];
export type NoticeInput = S['shipping.NoticeInput'];

export type NoticeKind = NoticeInput['kind'];
export type Surface = NoticeInput['surfaces'][number];

/** Notice type select -> API kind. */
export const NOTICE_TYPES: Array<{ value: NoticeKind; label: string }> = [
  { value: 'disruption', label: 'Service interruption' },
  { value: 'holiday', label: 'Holiday' },
  { value: 'carrier_closure', label: 'Carrier closure' },
  { value: 'weather', label: 'Weather' },
  { value: 'holiday_cutoffs', label: 'Holiday cutoffs' },
];

/** Delay select -> notice effect and the short text for the notices table. */
export const NOTICE_DELAYS: Array<{ value: string; label: string; short: string; effect: NoticeInput['effect'] }> = [
  { value: '1', label: '+1 business day', short: '+1 day', effect: { extraTransitDays: { min: 1, max: 1 }, noPickup: false, noDelivery: false, noDispatch: false } },
  { value: '1-2', label: '+1–2 business days', short: '+1–2 days', effect: { extraTransitDays: { min: 1, max: 2 }, noPickup: false, noDelivery: false, noDispatch: false } },
  { value: '3', label: '+3 business days', short: '+3 days', effect: { extraTransitDays: { min: 3, max: 3 }, noPickup: false, noDelivery: false, noDispatch: false } },
  { value: 'pause', label: 'Pause delivery to this area', short: 'delivery paused', effect: { extraTransitDays: null, noPickup: false, noDelivery: true, noDispatch: false } },
];

export const NOTICE_AUDIENCE: Array<{ value: 'all' | 'official' | 'marketplace'; label: string }> = [
  { value: 'all', label: 'Official Store and all sellers' },
  { value: 'official', label: 'Official Store only' },
  { value: 'marketplace', label: 'Marketplace sellers only' },
];

export const NOTICE_PLACES: Array<{ id: string; surface: Surface; label: string; short: string }> = [
  { id: 'aa-sn-s1', surface: 'product', label: 'Product page delivery estimate', short: 'product pages' },
  { id: 'aa-sn-s2', surface: 'checkout', label: 'Checkout delivery options', short: 'checkout' },
  { id: 'aa-sn-s3', surface: 'tracking', label: 'Order tracking for affected packages', short: 'tracking' },
];

export const STATUS_LABEL: Record<string, string> = { draft: 'Draft', scheduled: 'Scheduled', live: 'Live', ended: 'Ended', withdrawn: 'Withdrawn', active: 'Active', inactive: 'Inactive' };

/** "956xx, 957xx, CA, Zone name" -> postal prefixes, states and zone ids. */
export function parseArea(text: string, zones: Zone[]) {
  const postalPrefixes: string[] = [];
  const regions: string[] = [];
  const zoneIds: string[] = [];
  const unknown: string[] = [];
  for (const raw of text.split(/[,;]+/)) {
    const t = raw.trim().replace(/^zip codes?\s+/i, '');
    if (!t) continue;
    const zip = t.match(/^(\d{3,5})x*$/i);
    if (zip) postalPrefixes.push(zip[1]!);
    else if (/^[A-Za-z]{2}$/.test(t)) regions.push(t.toUpperCase());
    else {
      const z = zones.find((x) => x.name.toLowerCase() === t.toLowerCase());
      if (z) zoneIds.push(z.id);
      else unknown.push(t);
    }
  }
  return { postalPrefixes, regions, zoneIds, unknown };
}

/** 2026-10-06 + 2026-10-11 -> "Oct 6–11"; Oct 30 + Nov 2 -> "Oct 30 – Nov 2". */
export function whenLabel(from: string, to: string) {
  const f = (d: string, o: Intl.DateTimeFormatOptions) => new Date(`${d.slice(0, 10)}T12:00:00Z`).toLocaleDateString('en-US', { timeZone: 'UTC', ...o });
  if (!from) return '';
  const [fm, fd] = [f(from, { month: 'short' }), f(from, { day: 'numeric' })];
  if (!to || to.slice(0, 10) === from.slice(0, 10)) return `${fm} ${fd}`;
  const [tm, td] = [f(to, { month: 'short' }), f(to, { day: 'numeric' })];
  return fm === tm ? `${fm} ${fd}–${td}` : `${fm} ${fd} – ${tm} ${td}`;
}

/** Notice effect -> "UPS Ground +1–2 days", "No USPS pickup or delivery". */
export function effectLabel(n: Pick<ServiceNotice, 'effect' | 'carrierCodes' | 'carrierServiceIds'>, carriers: Carrier[]) {
  const services = carriers.flatMap((c) => c.services);
  const who = n.carrierServiceIds.length
    ? n.carrierServiceIds.map((id) => services.find((s) => s.id === id)?.name ?? 'Service').join(', ')
    : n.carrierCodes.length
      ? n.carrierCodes.map((code) => carriers.find((c) => c.code === code)?.name ?? code.toUpperCase()).join(', ')
      : 'All carriers';
  const e = n.effect;
  const parts: string[] = [];
  if (e.extraTransitDays) parts.push(`${who} +${e.extraTransitDays.min === e.extraTransitDays.max ? e.extraTransitDays.min : `${e.extraTransitDays.min}–${e.extraTransitDays.max}`} day${e.extraTransitDays.max === 1 ? '' : 's'}`);
  if (e.noPickup && e.noDelivery) parts.push(`No ${who} pickup or delivery`);
  else if (e.noDelivery) parts.push(`${who} delivery paused`);
  else if (e.noPickup) parts.push(`No ${who} pickup`);
  if (e.noDispatch) parts.push('No dispatch; estimates skip the day');
  return parts.join(' · ') || who;
}

/** Grams -> "4.4 lb". */
export const lb = (g: number) => `${Math.round((g / 453.592) * 10) / 10} lb`;

/** The price tier that applies at a weight (by_weight), or the single tier (flat). */
export function priceAt(m: ShippingProfile['methods'][number], grams: number) {
  const tiers = m.tiers ?? [];
  if (m.rateType !== 'by_weight') return tiers[0]?.price ?? null;
  return (tiers.find((t) => t.upToGrams == null || grams <= t.upToGrams) ?? tiers[tiers.length - 1])?.price ?? null;
}

/** "14:00" -> "2:00 PM" */
export const clock = (hhmm: string) => {
  const [h = 0, m = 0] = hhmm.split(':').map(Number);
  return `${((h + 11) % 12) + 1}:${String(m).padStart(2, '0')} ${h < 12 ? 'AM' : 'PM'}`;
};
const DAY: Record<string, string> = { mon: 'Mon', tue: 'Tue', wed: 'Wed', thu: 'Thu', fri: 'Fri', sat: 'Sat', sun: 'Sun' };
/** ["mon"…"fri"] -> "Mon–Fri" */
export const dayRange = (days: string[]) => (days.length > 2 ? `${DAY[days[0]!] ?? days[0]}–${DAY[days[days.length - 1]!] ?? days[days.length - 1]}` : days.map((d) => DAY[d] ?? d).join(', '));

/** "2 min ago", "3 h ago", "Oct 12" */
export function ago(iso?: string | null) {
  if (!iso) return '';
  const ms = Date.now() - new Date(iso).getTime();
  const min = Math.round(ms / 60_000);
  if (min < 1) return 'just now';
  if (min < 60) return `${min} min ago`;
  const h = Math.round(min / 60);
  if (h < 48) return `${h} h ago`;
  return new Date(iso).toLocaleDateString('en-US', { month: 'short', day: 'numeric', timeZone: 'America/Los_Angeles' });
}
