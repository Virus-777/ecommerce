import type { components } from '@marketly/web-shared/api';
import { ApiError } from '@marketly/web-shared/api';
import { money, type MoneyValue } from '@marketly/web-shared/lib/format';
import { href } from '@marketly/web-shared/routes';
import type { IconName } from '@marketly/web-shared/ui';

// Seller Center finance screens (seller/finance, seller/statement): API types, labels and formatting
// helpers shared by the two pages, and the export helpers Reports reuses
// (API: docs/api/modules/finance.md and reports.md, Seller API).

export type Balances = components['schemas']['finance.SellerBalances'];
export type LedgerEntry = components['schemas']['finance.LedgerEntry'];
export type Payout = components['schemas']['finance.Payout'];
export type Destination = components['schemas']['finance.DestinationStatus'];
export type Statement = components['schemas']['finance.Statement'];
export type StatementLine = components['schemas']['finance.StatementLine'];
export type FinanceRef = components['schemas']['finance.Reference'];
export type ExportJob = components['schemas']['reports.ExportJob'];

/** Ledger segments: the API's `type` filter values the design shows. */
export type TxFilter = 'all' | 'sales' | 'fees' | 'refunds' | 'payouts';

/** Icon per ledger entry type (design: shopping-bag sale, percent fee, undo-2 refund, landmark payout…). */
export const LEDGER_ICON: Record<LedgerEntry['type'], IconName> = {
  sale: 'shopping-bag',
  shipping_charge: 'truck',
  seller_discount: 'tag',
  marketplace_fee: 'percent',
  fee_refund: 'percent',
  refund: 'undo-2',
  refund_after_payout: 'undo-2',
  hold: 'lock',
  hold_release: 'circle-check',
  adjustment: 'scale',
  ad_charge: 'megaphone',
  service_fee: 'percent',
  charge_credit: 'scale',
  seller_credit: 'scale',
  label_charge: 'tag',
  chargeback: 'circle-alert',
  payout: 'landmark',
  payout_returned: 'landmark',
  owed_offset: 'scale',
  cancellation: 'x',
};

export const PAYOUT_STATUS: Record<Payout['status'], string> = {
  pending: 'Pending',
  on_hold: 'On hold',
  processing: 'Processing',
  paid: 'Paid',
  failed: 'Failed',
  cancelled: 'Cancelled',
};

/** Dollars of a money value (minor units). */
export const amt = (m?: MoneyValue | null) => (m ? m.amount / 100 : 0);

/** +$118.00 / −$11.80 (true minus sign, as in the design). Takes dollars. */
export const signedMoney = (n: number, plus = true) => (n < 0 ? `−${money(-n)}` : `${plus ? '+' : ''}${money(n)}`);

/** Signed money of an API value. */
export const signed = (m?: MoneyValue | null, plus = true) => signedMoney(amt(m), plus);

const PT = 'America/Los_Angeles';

/** A calendar date from the API (YYYY-MM-DD), read without time-zone shifts. */
const day = (d: string) => new Date(`${d.slice(0, 10)}T12:00:00Z`);

/** "Fri, Oct 16, 2026" (date-only fields). */
export const fmtDay = (d?: string | null, o: { weekday?: boolean; year?: boolean } = { weekday: true, year: true }) =>
  d ? day(d).toLocaleDateString('en-US', { timeZone: 'UTC', month: 'short', day: 'numeric', ...(o.weekday ? { weekday: 'short' } : {}), ...(o.year ? { year: 'numeric' } : {}) }) : '';

/** "Oct 8, 9:14 AM" (timestamps, market time). */
export const fmtTime = (iso?: string | null, o: { year?: boolean; weekday?: boolean } = {}) =>
  iso
    ? new Date(iso).toLocaleString('en-US', { timeZone: PT, month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit', ...(o.year ? { year: 'numeric' } : {}), ...(o.weekday ? { weekday: 'short' } : {}) })
    : '';

/** "Sep 28 – Oct 4" (statement and sales periods); a one-day period shows one date. */
export const fmtPeriod = (p?: { from: string; to: string } | null, year = false) => {
  if (!p) return '';
  const strip = (s: string) => s.replace(/, \d{4}$/, '');
  const a = strip(fmtDay(p.from, { year: true }));
  const b = fmtDay(p.to, { year: true });
  if (p.from === p.to) return year ? b : strip(b);
  return `${a} – ${year ? b : strip(b)}`;
};

/** Link target for a finance reference: orders and returns by their human ref, payouts by their statement. */
export function refHref(r?: FinanceRef | null, statementRef?: string | null): string | undefined {
  if (!r?.ref) return undefined;
  if ((r.kind === 'order' || r.kind === 'order_item') && r.ref.startsWith('MK-')) return href('seller/order', undefined, { ref: r.ref });
  if ((r.kind === 'return' || r.kind === 'refund') && r.ref.startsWith('RT-')) return href('seller/return', undefined, { ref: r.ref });
  if (r.kind === 'payout' && statementRef) return href('seller/statement', undefined, { ref: statementRef });
  if (r.kind === 'statement') return href('seller/statement', undefined, { ref: r.ref });
  return undefined;
}

/** "2026-07-15": the market-time date N days before today. */
export const isoDaysAgo = (n: number) => {
  const d = new Date();
  d.setDate(d.getDate() - n);
  return d.toLocaleDateString('en-CA', { timeZone: PT });
};

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/**
 * Waits for an async export (reports.ExportJob) to finish and returns the ready job with its download link.
 * Exports run in the reports module's job (every minute), so this can take a minute or two.
 */
export async function waitForExport(get: () => Promise<ExportJob>, first: ExportJob, timeoutMs = 5 * 60_000): Promise<ExportJob> {
  let job = first;
  const until = Date.now() + timeoutMs;
  while (job.state === 'queued' || job.state === 'running') {
    if (Date.now() > until) throw new ApiError(504, 'EXPORT_TIMEOUT', `Export ${job.ref} is still being prepared. Try again in a few minutes.`);
    await sleep(3000);
    job = await get();
  }
  if (job.state !== 'ready' || !job.downloadUrl) throw new ApiError(422, 'EXPORT_FAILED', job.error || `Export ${job.ref} couldn’t be prepared.`);
  return job;
}

/** Starts the browser download of a signed link. */
export function download(url: string) {
  const a = document.createElement('a');
  a.href = url;
  a.rel = 'noopener';
  a.download = '';
  document.body.appendChild(a);
  a.click();
  a.remove();
}
