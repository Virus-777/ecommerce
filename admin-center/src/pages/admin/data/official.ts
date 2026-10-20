import type { components } from '@marketly/web-shared/api';

// Admin Official Store (design: pages/admin/admin-official*.html), fed by GET /api/admin/offers/official/offers,
// GET /api/admin/finance/trading and the caller's approval limits (access/me).

export type OfficialRow = components['schemas']['offers.OfficialOfferRow'];
export type PriceChange = components['schemas']['offers.PriceChange'];
export type TradingSummary = components['schemas']['finance.TradingSummary'];
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

/** The price-change limit (percent) of the staff member's roles: null = no limit, 0 = not permitted. */
export function priceLimitPct(limits: Array<{ action: { key: string }; value: { authority: string; limitNumber?: number | null } }> | undefined): number | null {
  const mine = (limits ?? []).filter((l) => l.action.key === 'offers.prices.change' && l.value.authority === 'permitted');
  if (!mine.length) return 0;
  if (mine.some((l) => l.value.limitNumber == null)) return null;
  return Math.max(...mine.map((l) => l.value.limitNumber ?? 0));
}

/**
 * The warning shown when part of company sales had no unit cost when sold. The backend counts those sales in the gross
 * margin with no cost (grossMargin = productSales − costOfGoodsSold), so the margin reads higher than it is; the
 * Financial statistics Official Store P&L leaves them out of the margin instead and warns the same way.
 */
export function uncostedNote(t: TradingSummary | undefined, money: (m: { amount: number; currency: string }) => string): string | undefined {
  if (!t || t.uncostedSales.amount <= 0) return undefined;
  const share = t.productSales.amount > 0 ? ` (${((t.uncostedSales.amount / t.productSales.amount) * 100).toFixed(1)}% of company sales)` : '';
  return `${money(t.uncostedSales)}${share} had no unit cost when sold. It counts in the gross margin with no cost, so the margin shows higher than it is.`;
}

/** "Price change to $129.00 waiting for approval" / "$129.00 from Oct 12". */
export function pendingNote(pc: PriceChange | null | undefined, fmt: (iso: string) => string, money: (m: { amount: number; currency: string }) => string): string | undefined {
  if (!pc) return undefined;
  if (pc.state === 'pending_approval') return `Price change to ${money(pc.to)} waiting for ${pc.approval?.approvers.join(' or ') || 'approval'}`;
  if (pc.state === 'scheduled') return `${money(pc.to)} from ${pc.startsAt ? fmt(pc.startsAt) : 'now'}`;
  return undefined;
}
