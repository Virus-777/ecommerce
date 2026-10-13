// Shared pieces of the Seller Center catalog, offer and inventory screens (Products, CatalogMatch,
// ProductNew, Offer, Inventory, BulkUpdate): load/skeleton states, labels for API enums, money input
// helpers, dates, CSV and export downloads.
import { useEffect, useRef, useState } from 'react';
import { ApiError, errorMessage, type components } from '@marketly/web-shared/api';
import { Alert, Button, type IconName } from '@marketly/web-shared/ui';

export type Money = components['schemas']['Money'];
export type ExportJob = components['schemas']['reports.ExportJob'];

/** A failed read: the error and a Try again button (API.md rule 4). */
export function LoadError({ error, onRetry, title = 'We couldn’t load this' }: { error: unknown; onRetry: () => void; title?: string }) {
  return (
    <Alert tone="danger" title={title}>
      {errorMessage(error)}{' '}
      <Button variant="secondary" size="sm" onClick={onRetry}>
        Try again
      </Button>
    </Alert>
  );
}

/** Skeleton rows for a list card while it loads. */
export function SkeletonRows({ rows = 3, thumb = true }: { rows?: number; thumb?: boolean }) {
  return (
    <div className="sk-list pad" role="status" aria-label="Loading">
      {Array.from({ length: rows }, (_, i) => (
        <div key={i} className="sk-row" aria-hidden="true">
          {thumb && <span className="sk sk-thumb" />}
          <span className="sk-lines">
            <span className="sk sk-line" />
            <span className="sk sk-line short" />
          </span>
        </div>
      ))}
    </div>
  );
}

/** Page skeleton for a form screen: a few cards of lines. */
export function FormSkeleton({ cards = 3 }: { cards?: number }) {
  return (
    <div className="stack gap-5" role="status" aria-label="Loading">
      {Array.from({ length: cards }, (_, i) => (
        <section key={i} className="card" aria-hidden="true">
          <SkeletonRows rows={i === 0 ? 2 : 3} thumb={i === 0} />
        </section>
      ))}
    </div>
  );
}

/** The value, settled for `ms` before it changes (search boxes). */
export function useDebounced<T>(value: T, ms = 300) {
  const [v, setV] = useState(value);
  useEffect(() => {
    const t = setTimeout(() => setV(value), ms);
    return () => clearTimeout(t);
  }, [value, ms]);
  return v;
}

/** Calls `onVisible` when the returned element scrolls into view (phone lists load the next page). */
export function useInView<T extends HTMLElement>(onVisible: () => void, enabled: boolean) {
  const ref = useRef<T | null>(null);
  const cb = useRef(onVisible);
  cb.current = onVisible;
  useEffect(() => {
    const el = ref.current;
    if (!el || !enabled || typeof IntersectionObserver === 'undefined') return;
    const io = new IntersectionObserver((entries) => entries.some((e) => e.isIntersecting) && cb.current(), { rootMargin: '200px' });
    io.observe(el);
    return () => io.disconnect();
  }, [enabled]);
  return ref;
}

/* ---------------- labels for API enums ---------------- */

export type Condition = 'new' | 'used_like_new' | 'used_good' | 'used_acceptable' | 'refurbished';
export const CONDITIONS: Condition[] = ['new', 'used_like_new', 'used_good', 'used_acceptable', 'refurbished'];
export const CONDITION_LABEL: Record<Condition, string> = {
  new: 'New',
  used_like_new: 'Used – Like new',
  used_good: 'Used – Good',
  used_acceptable: 'Used – Acceptable',
  refurbished: 'Refurbished',
};
export const conditionLabel = (c?: string | null) => CONDITION_LABEL[(c ?? '').toLowerCase() as Condition] ?? c ?? '';

export type Review = 'Approved' | 'Draft' | 'Submitted' | 'Changes requested' | 'Rejected';
export const REVIEW_LABEL: Record<string, Review> = { draft: 'Draft', submitted: 'Submitted', changes_requested: 'Changes requested', approved: 'Approved', rejected: 'Rejected' };
export const reviewLabel = (s?: string | null): Review => REVIEW_LABEL[(s ?? '').toLowerCase()] ?? 'Draft';

/** Seller stock adjustment reasons (inventory SellerAdjustmentRequest.reasonCode). */
export type AdjustReason = 'received_stock' | 'count_correction' | 'damaged_or_defective' | 'lost_or_missing' | 'returned_item_restocked' | 'moved_to_another_channel' | 'other';
export const ADJUST_REASONS: Array<{ value: AdjustReason; label: string }> = [
  { value: 'received_stock', label: 'Received new stock' },
  { value: 'count_correction', label: 'Count correction' },
  { value: 'damaged_or_defective', label: 'Damaged or defective' },
  { value: 'lost_or_missing', label: 'Lost or missing' },
  { value: 'returned_item_restocked', label: 'Returned item restocked' },
  { value: 'moved_to_another_channel', label: 'Moved to another channel' },
  { value: 'other', label: 'Other' },
];

export type StockState = 'in_stock' | 'low_stock' | 'out_of_stock';
export const STOCK_LABEL: Record<StockState, string> = { in_stock: 'In stock', low_stock: 'Low stock', out_of_stock: 'Out of stock' };

/** "Midnight black" / "Color: Black · Size: M" from a variant's options (map or name/value list). */
export function optionsLabel(options?: Record<string, string> | Array<{ name: string; value: string }> | null): string {
  if (!options) return '';
  const list = Array.isArray(options) ? options.map((o) => [o.name, o.value] as const) : Object.entries(options);
  if (list.length === 1) return list[0][1];
  return list.map(([k, v]) => `${k}: ${v}`).join(' · ');
}

/** Placeholder tile icon for a product without an image (by category words). */
export function iconFor(...words: Array<string | null | undefined>): IconName {
  const s = words.filter(Boolean).join(' ').toLowerCase();
  if (/headphone|earbud|buds/.test(s)) return 'headphones';
  if (/speaker/.test(s)) return 'speaker';
  if (/cable|adapter/.test(s)) return 'cable';
  if (/ssd|storage|drive/.test(s)) return 'hard-drive';
  if (/camera/.test(s)) return 'camera';
  if (/monitor|laptop|computer/.test(s)) return 'monitor';
  if (/watch|wearable/.test(s)) return 'watch';
  return 'package';
}

/* ---------------- money input ---------------- */

/** "189", "189.00", "$1,189.5" → minor units; null when not a positive amount. */
export function toMinor(s: string): number | null {
  const t = s.replace(/[$,\s]/g, '');
  if (!/^\d+(\.\d{1,2})?$/.test(t)) return null;
  const n = Math.round(Number(t) * 100);
  return n > 0 ? n : null;
}
/** 18900 → "189.00" (input value). */
export const inputAmount = (m?: Money | null) => (m ? (m.amount / 100).toFixed(2) : '');

/* ---------------- dates ---------------- */

const TZ = { timeZone: 'America/Los_Angeles' } as const;
/** "Oct 6, 4:30 PM" in market time. */
export const fmtWhen = (iso?: string | null) =>
  iso ? new Date(iso).toLocaleString('en-US', { ...TZ, month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' }) : '';
/** "Oct 6" */
export const fmtDay = (iso?: string | null) => (iso ? new Date(iso).toLocaleDateString('en-US', { ...TZ, month: 'short', day: 'numeric' }) : '');
/** "Oct 6, 2026, 2:18 PM PT" */
export const fmtFull = (iso?: string | null) =>
  iso ? `${new Date(iso).toLocaleString('en-US', { ...TZ, month: 'short', day: 'numeric', year: 'numeric', hour: 'numeric', minute: '2-digit' })} PT` : '';

/* ---------------- files ---------------- */

export function downloadCsv(name: string, rows: string[][]) {
  const csv = rows.map((r) => r.map((c) => (/[",\n]/.test(c) ? `"${c.replace(/"/g, '""')}"` : c)).join(',')).join('\n');
  const url = URL.createObjectURL(new Blob([csv], { type: 'text/csv' }));
  const a = document.createElement('a');
  a.href = url;
  a.download = name;
  a.click();
  URL.revokeObjectURL(url);
}

/** Opens a signed download link (export files, templates, correction reports). */
export function openDownload(url: string, fileName?: string | null) {
  const a = document.createElement('a');
  a.href = url;
  if (fileName) a.download = fileName;
  a.rel = 'noopener';
  a.click();
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));


/** Polls an export job (reports) until it is ready, then returns it; throws when it fails or takes too long. */
export async function waitForExport(first: ExportJob, poll: (id: string) => Promise<ExportJob>, timeoutMs = 60_000): Promise<ExportJob> {
  let job = first;
  const until = Date.now() + timeoutMs;
  while (job.state === 'queued' || job.state === 'running') {
    if (Date.now() > until) throw new ApiError(504, 'EXPORT_TIMEOUT', 'The export is taking longer than usual. Try again in a moment.');
    await sleep(1200);
    job = await poll(job.id);
  }
  if (job.state !== 'ready' || !job.downloadUrl) throw new ApiError(422, 'EXPORT_FAILED', job.error || 'The export failed. Try again.');
  return job;
}
