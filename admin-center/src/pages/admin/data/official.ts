import type { components } from '@marketly/web-shared/api';

// Admin Official Store (design: pages/admin/admin-official*.html), fed by GET /api/admin/offers/official/offers,
// GET /api/admin/finance/trading and the caller's approval limits (access/me).

export type OfficialRow = components['schemas']['offers.OfficialOfferRow'];
export type PriceChange = components['schemas']['offers.PriceChange'];
export type Trading = components['schemas']['finance.TradingSummary'];
export type OfferStatusKey = OfficialRow['offer']['status'];

export const STATUS_LABEL: Record<OfferStatusKey, string> = {
  draft: 'Draft',
  active: 'Active',
  paused: 'Hidden',
  out_of_stock: 'Out of stock',
  ineligible: 'Ineligible',
  removed: 'Removed',
};

/** Status filter options → list query. */
export const STATUS_FILTERS: Array<{ value: string; label: string; query: { status?: OfferStatusKey; stockState?: 'in_stock' | 'low_stock' | 'out_of_stock' } }> = [
  { value: '', label: 'All statuses', query: {} },
  { value: 'active', label: 'Active', query: { status: 'active' } },
  { value: 'paused', label: 'Hidden', query: { status: 'paused' } },
  { value: 'out', label: 'Out of stock', query: { stockState: 'out_of_stock' } },
  { value: 'low', label: 'Low stock', query: { stockState: 'low_stock' } },
];

export type Period = '7' | '14' | '30';

/** The calendar range (Pacific dates) of the last `days` days, today included. */
export function periodRange(days: number, now = new Date()): { from: string; to: string } {
  const day = (d: Date) => d.toLocaleDateString('en-CA', { timeZone: 'America/Los_Angeles' });
  return { from: day(new Date(now.getTime() - (days - 1) * 86_400_000)), to: day(now) };
}

/** The price-change limit (percent) of the staff member's roles: null = no limit, 0 = not permitted. */
export function priceLimitPct(limits: Array<{ action: { key: string }; value: { authority: string; limitNumber?: number | null } }> | undefined): number | null {
  const mine = (limits ?? []).filter((l) => l.action.key === 'offers.prices.change' && l.value.authority === 'permitted');
  if (!mine.length) return 0;
  if (mine.some((l) => l.value.limitNumber == null)) return null;
  return Math.max(...mine.map((l) => l.value.limitNumber ?? 0));
}

/** "Price change to $129.00 waiting for approval" / "$129.00 from Oct 12". */
export function pendingNote(pc: PriceChange | null | undefined, fmt: (iso: string) => string, money: (m: { amount: number; currency: string }) => string): string | undefined {
  if (!pc) return undefined;
  if (pc.state === 'pending_approval') return `Price change to ${money(pc.to)} waiting for ${pc.approval?.approvers.join(' or ') || 'approval'}`;
  if (pc.state === 'scheduled') return `${money(pc.to)} from ${pc.startsAt ? fmt(pc.startsAt) : 'now'}`;
  return undefined;
}
