import { useMutation, useQuery } from '@tanstack/react-query';
import type { ReactNode } from 'react';
import { useSearchParams } from 'react-router';
import { call, errorMessage, useApi } from '@marketly/web-shared/api';
import { formatMoney, num, type MoneyValue } from '@marketly/web-shared/lib/format';
import { Alert, announce, Button, Card, Stat, TableWrap, type ReportSeriesPick } from '@marketly/web-shared/ui';
import { useSellerSession } from '@/app/session';
import { download, fmtPeriod, waitForExport } from './finance';
import { kpiOf, metaOf, statDelta, zoneLabel, type Kpi, type ReportQuery, type ReportResult } from './reports';

// Statistics (seller/reports, docs/09 §4.2): the report keys of the four tabs and the pieces every tab shares —
// running a report for the page's period, its KPI tiles (with "not available" and comparison deltas), its callouts,
// its period table and its CSV export.
// API: POST /api/seller/reports/reports/{key}/query, POST reports/exports → GET reports/exports/{id}.

/** Report keys of the Statistics tabs (docs/09 §3.3; GET /api/seller/reports/catalogue). */
export const STATS = {
  earnings: 'seller.earnings',
  profitByProduct: 'seller.profit_by_product',
  service: 'seller.service_performance',
} as const;

/** Metric keys of seller.earnings (KPIs and series) and seller.profit_by_product (KPIs). */
export const M = {
  itemSales: 'seller.item_sales',
  shippingCharged: 'seller.shipping_charged',
  refunds: 'seller.refunds',
  fees: 'seller.fees',
  adSpend: 'seller.ad_spend',
  serviceFees: 'seller.service_fees',
  labelCharges: 'seller.label_charges',
  adjustments: 'seller.adjustments',
  netEarnings: 'seller.net_earnings',
  productCost: 'seller.product_cost',
  profit: 'seller.profit',
  marginPct: 'seller.margin_pct',
  paidOut: 'seller.paid_out',
  costCoveragePct: 'seller.cost_coverage_pct',
  productsWithoutCost: 'seller.products_without_cost',
  salesWithoutCost: 'seller.sales_without_cost',
  onTimeDispatch: 'service.on_time_dispatch',
  validTracking: 'service.valid_tracking',
  sellerCancellations: 'service.seller_cancellations',
  deliveryExceptions: 'service.delivery_exceptions',
} as const;

/** The finance permission the money reports (earnings, profit by product) need besides reports.seller.view. */
export const MONEY_PERMISSION = 'finance.balances.view';

/** Runs one seller report for the period; keeps the previous result on screen while a new period loads. */
export function useSellerReport(key: string, query: ReportQuery, enabled = true) {
  const { api } = useApi();
  const { sellerId } = useSellerSession();
  return useQuery({
    queryKey: ['reports', key, sellerId, query],
    queryFn: () => call(api.POST('/api/seller/reports/reports/{key}/query', { params: { path: { key } }, body: query })) as Promise<ReportResult>,
    enabled,
    placeholderData: (prev) => prev,
  });
}

/**
 * The key a series has in the result. Older reports name series by the metric's suffix (`on_time_dispatch`), the
 * money reports by the metric key (`seller.net_earnings`); this accepts either so the tabs need not care.
 */
export function seriesKey(result: ReportResult | undefined, metricKey: string): string {
  const short = metricKey.slice(metricKey.indexOf('.') + 1);
  const s = result?.series.find((x) => x.key === metricKey) ?? result?.series.find((x) => x.key === short);
  return s?.key ?? metricKey;
}

/** seriesFromReport picks for metric keys, resolved to the result's series keys (see seriesKey). */
export const picks = (result: ReportResult | undefined, items: Array<{ key: string; label?: string; axis?: 'left' | 'right' }>): ReportSeriesPick[] =>
  items.map((i) => ({ ...i, key: seriesKey(result, i.key) }));

/** True when the report says a metric has no figures (its source module is off, or not built yet). */
export const unavailable = (result: ReportResult | undefined, key: string) => ((result as { unavailable?: string[] } | undefined)?.unavailable ?? []).includes(key);

/** A breakdown of the result by key (rows typed by the caller). */
export function breakdownOf<R>(result: ReportResult | undefined, key: string): R[] {
  const b = ((result?.breakdowns ?? []) as Array<{ key: string; rows: R[] }>).find((x) => x.key === key);
  return b?.rows ?? [];
}

/** Cents of a Money value or a plain number (breakdown rows carry Money). */
export const centsOf = (v: unknown): number => (typeof v === 'number' ? v : v && typeof v === 'object' && 'amount' in v ? Number((v as MoneyValue).amount) : 0);

/** The skeleton of a KPI tile while the first result loads. */
export const statSkeleton = (
  <div className="stack gap-2">
    <span className="sk sk-line short" />
    <span className="sk h-30" />
  </div>
);

/** "vs Sep 1 – Sep 30" under the first tile when the result was compared. */
export const compareNote = (result?: ReportResult) => {
  const cr = metaOf(result)?.compareRange;
  return cr ? `vs ${fmtPeriod(cr)}` : undefined;
};

/**
 * How far the profit figures of seller.earnings can be trusted, from seller.cost_coverage_pct (the share of item
 * sales whose offer has a unit cost):
 * - 'none': there were item sales but none has a cost, so profit would only repeat net earnings and margin read
 *   0.0%; the tiles show "—" and ask for unit costs instead;
 * - 'partial': some sales have a cost; the figures stand with "Costs set for 42.5% of item sales";
 * - 'full': every sale has a cost, or there were no item sales (nothing is missing).
 */
export function costCoverage(result?: ReportResult): { state: 'none' | 'partial' | 'full'; note: string | null } {
  const coverage = kpiOf(result, M.costCoveragePct);
  const sales = kpiOf(result, M.itemSales);
  if (!coverage || unavailable(result, M.costCoveragePct) || !sales || sales.value <= 0) return { state: 'full', note: null };
  if (coverage.value <= 0) return { state: 'none', note: null };
  if (coverage.value < 100) return { state: 'partial', note: `Costs set for ${coverage.display} of item sales` };
  return { state: 'full', note: null };
}

/**
 * One KPI tile of a report: the backend's display value and comparison delta; "Not available" when the report
 * lists the metric as unavailable; a skeleton until the first result. `blank` shows "—" with that note instead of
 * the figure (profit and margin when no sale has a unit cost).
 */
export function KpiTile({ result, metricKey, label, note, value, blank }: { result?: ReportResult; metricKey: string; label: string; note?: string | false | null; value?: (k: Kpi) => string; blank?: ReactNode }) {
  if (!result) return <div className="card pad">{statSkeleton}</div>;
  const k = kpiOf(result, metricKey);
  if (!k || unavailable(result, metricKey) || blank) {
    return (
      <div className="card pad">
        <Stat label={label} value="—" note={blank || 'Not available yet'} />
      </div>
    );
  }
  const d = statDelta(k);
  return (
    <div className="card pad">
      <Stat label={label} value={value ? value(k) : k.display} {...d} note={note || k.note || undefined} />
    </div>
  );
}

interface Callout {
  kind: 'info' | 'warning';
  title: string;
  body: string;
}

/** The report's notes (date basis, freshness, missing costs) as alerts. */
export function ReportCallouts({ result, skip = [] }: { result?: ReportResult; skip?: string[] }) {
  const list = ((result as { callouts?: Callout[] } | undefined)?.callouts ?? []).filter((c) => !skip.includes(c.title));
  if (!list.length) return null;
  return (
    <div className="stack gap-2">
      {list.map((c) => (
        <Alert key={c.title} tone={c.kind === 'warning' ? 'warning' : 'info'} title={c.title}>
          {c.body}
        </Alert>
      ))}
    </div>
  );
}

/** "Figures by order date, Pacific Time. Refreshed Oct 21, 9:14 AM." from the result's meta. */
export function metaLine(result?: ReportResult): string {
  const m = metaOf(result);
  if (!m) return '';
  const basis = (m.dateBasisLabel ?? 'by order date').replace(/^By/, 'by');
  const fresh = m.freshAsOf ? ` Refreshed ${new Date(m.freshAsOf).toLocaleString('en-US', { timeZone: 'America/Los_Angeles', month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' })}.` : '';
  return `${fmtPeriod(m.range, true)} · figures ${basis}, ${zoneLabel(m.timeZone)}.${fresh}`;
}

/* ---------------- the report's own table (columns with units, rows, totals) ---------------- */

export interface ReportColumn {
  key: string;
  label: string;
  unit: string;
  align?: string;
}
export interface ReportTableData {
  columns: ReportColumn[];
  rows: Array<Record<string, unknown>>;
  totals?: Record<string, unknown>;
}

export const reportTable = (result?: ReportResult) => (result?.table ?? null) as ReportTableData | null;

/** One cell of a report table by the column's unit: Money → $1,234.50, percent → 12.5%, count → 1,234. */
export function cellText(v: unknown, unit: string): string {
  if (v === null || v === undefined || v === '') return '—';
  if (typeof v === 'boolean') return v ? 'Yes' : 'No';
  if (typeof v === 'object' && v && 'amount' in v) return formatMoney(v as MoneyValue);
  if (typeof v === 'number') {
    if (unit === 'money') return formatMoney({ amount: v, currency: 'USD' });
    if (unit === 'percent') return `${v.toFixed(1)}%`;
    return num(Math.round(v * 10) / 10);
  }
  return String(v);
}

/**
 * The report's period table: one row per day/week/month with every column, and the totals. The first column is
 * the period; rows carry a readable `label` next to the raw `period` key, which is shown instead.
 */
export function ReportTableCard({ result, title, sub, label, hide = [] }: { result?: ReportResult; title: string; sub?: string; label: string; hide?: string[] }) {
  const t = reportTable(result);
  if (!result || !t || !t.rows.length) return null;
  const cols = t.columns.filter((c) => !hide.includes(c.key));
  const [first, ...rest] = cols;
  if (!first) return null;
  const firstText = (r: Record<string, unknown>) => (typeof r.label === 'string' && r.label ? r.label : cellText(r[first.key], first.unit));
  return (
    <Card flush titleAs="h3" title={title} sub={sub}>
      <TableWrap label={label}>
        <table className="table">
          <thead>
            <tr>
              {cols.map((c, i) => (
                <th key={c.key} scope="col" className={i ? 'r nowrap' : undefined}>
                  {c.label}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {t.rows.map((r, i) => (
              <tr key={i}>
                <th scope="row" className="nowrap">
                  {firstText(r)}
                </th>
                {rest.map((c) => (
                  <td key={c.key} className="r num nowrap">
                    {cellText(r[c.key], c.unit)}
                  </td>
                ))}
              </tr>
            ))}
          </tbody>
          {t.totals && (
            <tfoot>
              <tr>
                <th scope="row">Total</th>
                {rest.map((c) => (
                  <td key={c.key} className="r num strong nowrap">
                    {c.key in t.totals! ? cellText(t.totals![c.key], c.unit) : ''}
                  </td>
                ))}
              </tr>
            </tfoot>
          )}
        </table>
      </TableWrap>
    </Card>
  );
}

/* ---------------- CSV export of a report for the period ---------------- */

/** Starts a CSV export of a report for the query, waits for it and downloads it (POST reports/exports). */
export function useReportExport(reportKey: string | null, query: ReportQuery, periodLabel: string) {
  const { api } = useApi();
  return useMutation({
    mutationFn: async () => {
      if (!reportKey) throw new Error('This tab has no export.');
      const job = await call(api.POST('/api/seller/reports/exports', { body: { reportKey, query, format: 'csv' } }));
      announce(`Exporting the figures for ${periodLabel} as CSV`);
      const ready = await waitForExport(() => call(api.GET('/api/seller/reports/exports/{id}', { params: { path: { id: job.id } } })), job);
      download(ready.downloadUrl!);
      return ready;
    },
    onSuccess: (j) => announce(`Export ${j.ref} is ready`),
  });
}

/** The export's failure, shown under the page header. */
export function ExportError({ error }: { error: unknown }) {
  if (!error) return null;
  return (
    <Alert tone="danger" title="The export didn’t finish">
      {errorMessage(error)}
    </Alert>
  );
}

/** Retry button for a failed report. */
export const retry = (refetch: () => unknown) => (
  <Button variant="ghost" size="sm" onClick={() => void refetch()}>
    Try again
  </Button>
);

/** Link to another Statistics tab that keeps the page's period (the URL's preset, range, grain and comparison). */
export function useTabLink() {
  const [params] = useSearchParams();
  return (view: string) => {
    const p = new URLSearchParams(params);
    if (view) p.set('view', view);
    else p.delete('view');
    return `?${p.toString()}`;
  };
}
