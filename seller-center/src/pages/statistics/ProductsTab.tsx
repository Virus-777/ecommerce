import { useMemo, useState } from 'react';
import { Link } from 'react-router';
import { errorMessage } from '@marketly/web-shared/api';
import { num } from '@marketly/web-shared/lib/format';
import { href } from '@marketly/web-shared/routes';
import {
  Alert, Badge, BarsChart, Button, Card, ChartFrame, Dialog, fmtMoney, fmtMoneyCompact, LoadError, rowsFrom, SegmentedControl, seriesTable, TableWrap, TextInput,
} from '@marketly/web-shared/ui';
import { useSellerSession } from '@/app/session';
import { fmtPeriod } from '../data/finance';
import { kpiOf, metaOf, type ReportQuery } from '../data/reports';
import { clampCostDay, costEarliest, costToday, COST_PERMISSION, MAX_COST_DAYS_BACK, parseCost, UnitCostCell, useSetCosts } from '../data/costs';
import { breakdownOf, cellText, centsOf, KpiTile, M, metaLine, ReportCallouts, reportTable, STATS, unavailable, useSellerReport, type ReportColumn } from '../data/statistics';

// Statistics → Products (seller.profit_by_product, docs/09 §3.3): profit, margin and what has no cost yet; the
// products with the most and the least profit; and the table per product, whose unit cost can be set in place
// (PUT offers/offers/{id}/cost). Products without a cost get a callout that opens one form for all of them
// (POST offers/costs), or the bulk update file for many.

type Row = Record<string, unknown> & { offerId?: string | null; productId?: string | null; product?: string; costSet?: boolean };
type Rank = 'top' | 'lowest';

/** Columns the table shows in other ways: ids (links), the cost flag (a badge) and the unit cost (its own cell). */
const HIDDEN = new Set(['offerId', 'productId', 'costSet', 'image']);
const isUnitCost = (key: string) => /^(current)?_?unit_?cost$/i.test(key) || key === 'currentUnitCost';
const RANK_SERIES = [{ key: 'profit', label: 'Profit' }];

export function ProductsTab({ query, periodFrom }: { query: ReportQuery; periodFrom: string }) {
  const { can } = useSellerSession();
  const canEditCost = can(COST_PERMISSION);
  const report = useSellerReport(STATS.profitByProduct, query);
  const [rank, setRank] = useState<Rank>('top');
  const [bulkOpen, setBulkOpen] = useState(false);
  const r = report.data;
  const meta = metaOf(r);
  const range = fmtPeriod(meta?.range).replace(' – ', ' to ');

  const table = reportTable(r);
  const rows = (table?.rows ?? []) as Row[];
  const unitCostKey = table?.columns.find((c) => isUnitCost(c.key))?.key ?? 'unitCost';
  const columns = (table?.columns ?? []).filter((c) => !HIDDEN.has(c.key) && !isUnitCost(c.key));
  const [first, ...rest] = columns;
  const missing = rows.filter((x) => x.costSet === false && x.offerId);
  // the count KPI when the report has it; otherwise the table's own rows without a cost
  const missingCount = kpiOf(r, M.productsWithoutCost)?.value ?? missing.length;
  const firstCostDay = clampCostDay(periodFrom);

  const ranking = useMemo(() => {
    const list = breakdownOf<{ key: string | null; label: string; amount?: unknown }>(r, rank === 'top' ? 'top_profit' : 'lowest_profit');
    return rowsFrom(
      list.map((b) => b.label),
      { profit: list.map((b) => centsOf(b.amount)) },
      list.map((b) => b.key ?? b.label),
    );
  }, [r, rank]);

  return (
    <>
      {r && <p className="small muted">{metaLine(r)}</p>}
      {report.isError && <LoadError error={report.error} title="We couldn’t load profit by product" forbiddenHint="Profit by product needs the permission to view balances. Ask the store owner if you need it." onRetry={() => void report.refetch()} />}
      <div className="sb-kpis">
        <KpiTile result={r} metricKey={M.profit} label="Profit" />
        <KpiTile result={r} metricKey={M.marginPct} label="Margin" />
        <KpiTile result={r} metricKey={M.productsWithoutCost} label="Products without a cost" value={(k) => num(k.value)} />
        <KpiTile result={r} metricKey={M.salesWithoutCost} label="Item sales without a cost" />
      </div>
      {r && missingCount > 0 && (
        <Alert tone="warning" title={`${num(missingCount)} product${missingCount === 1 ? ' has' : 's have'} no unit cost`}>
          Profit and margin leave out the sales of products without a cost. Add what you paid per unit; a cost can start up to {MAX_COST_DAYS_BACK} days back, so the sales of this period count too.{' '}
          <span className="row gap-2" style={{ marginTop: 'var(--sp-2)', flexWrap: 'wrap' }}>
            {canEditCost && missing.length > 0 && (
              <Button size="sm" icon="pencil" onClick={() => setBulkOpen(true)}>
                Enter missing costs
              </Button>
            )}
            <Link className="small strong" to={href('seller/bulk-update')}>
              Use a bulk update file
            </Link>
          </span>
        </Alert>
      )}
      <ChartFrame
        titleAs="h2"
        title={rank === 'top' ? 'Most profit' : 'Least profit'}
        sub={`By product, ${range || 'this period'}; products without a cost are left out`}
        actions={<SegmentedControl<Rank> label="Show" items={[{ value: 'top', label: 'Most' }, { value: 'lowest', label: 'Least' }]} active={rank} onChange={setRank} />}
        loading={!r && !report.isError}
        refreshing={report.isPlaceholderData}
        empty={r && !ranking.length ? (unavailable(r, M.profit) ? 'Profit is not available yet.' : 'No sales with a cost in this period.') : false}
        height={Math.max(160, ranking.length * 32)}
        table={seriesTable(ranking, RANK_SERIES, fmtMoney, { xLabel: 'Product' })}
      >
        <BarsChart rows={ranking} series={RANK_SERIES} fmt={fmtMoney} axisFmt={fmtMoneyCompact} horizontal label={`${rank === 'top' ? 'Products with the most profit' : 'Products with the least profit'}, ${range}`} />
      </ChartFrame>
      <ReportCallouts result={r} />
      <Card flush titleAs="h3" title="Profit by product" sub={canEditCost ? 'Set a unit cost with the pencil; it applies from the day you choose' : 'Unit costs are set by members who manage costs'}>
        <TableWrap label="Profit by product">
          <table className="table">
            <thead>
              <tr>
                {first ? (
                  <>
                    <th scope="col">{first.label}</th>
                    {rest.map((c) => (
                      <th key={c.key} scope="col" className="r nowrap">
                        {c.label}
                      </th>
                    ))}
                  </>
                ) : (
                  <th scope="col">Product</th>
                )}
                <th scope="col" className="r nowrap">
                  Unit cost
                </th>
              </tr>
            </thead>
            <tbody>
              {!r &&
                [0, 1, 2].map((i) => (
                  <tr key={i}>
                    <td colSpan={2}>
                      <span className="sk sk-line" />
                    </td>
                  </tr>
                ))}
              {r && rows.length === 0 && (
                <tr>
                  <td colSpan={columns.length + 1}>
                    <span className="small muted">No sales in this period.</span>
                  </td>
                </tr>
              )}
              {rows.map((row, i) => (
                <ProductRow key={String(row.offerId ?? row.productId ?? i)} row={row} first={first} rest={rest} unitCostKey={unitCostKey} canEdit={canEditCost} from={firstCostDay} />
              ))}
            </tbody>
          </table>
        </TableWrap>
      </Card>
      {bulkOpen && <MissingCostsDialog open onClose={() => setBulkOpen(false)} rows={missing} from={firstCostDay} />}
    </>
  );
}

function ProductRow({ row, first, rest, unitCostKey, canEdit, from }: { row: Row; first?: ReportColumn; rest: ReportColumn[]; unitCostKey: string; canEdit: boolean; from: string }) {
  const name = typeof row.product === 'string' ? row.product : first ? cellText(row[first.key], first.unit) : 'Product';
  const cost = row[unitCostKey];
  const money = cost && typeof cost === 'object' && 'amount' in cost ? (cost as { amount: number; currency: string }) : typeof cost === 'number' ? { amount: cost, currency: 'USD' } : null;
  return (
    <tr>
      <th scope="row" className="minw-200">
        <span className="stack gap-0">
          <span className="small strong">{name}</span>
          {row.costSet === false && (
            <span>
              <Badge tone="warning">No cost</Badge>
            </span>
          )}
        </span>
      </th>
      {rest.map((c) => (
        <td key={c.key} className="r num nowrap">
          {cellText(row[c.key], c.unit)}
        </td>
      ))}
      <td className="r">{row.offerId ? <UnitCostCell offerId={row.offerId} current={money} currency={money?.currency} from={from} canEdit={canEdit} label={name} /> : <span className="small muted">—</span>}</td>
    </tr>
  );
}

/** One form for every product without a cost: an amount each, one start day for all (POST offers/costs). */
function MissingCostsDialog({ open, onClose, rows, from }: { open: boolean; onClose: () => void; rows: Row[]; from: string }) {
  const [values, setValues] = useState<Record<string, string>>({});
  const [day, setDay] = useState(from);
  const save = useSetCosts();
  const list = rows.slice(0, 500);
  const items = list.flatMap((x) => {
    const cents = parseCost(values[x.offerId!] ?? '');
    return cents === null ? [] : [{ offerId: x.offerId!, unitCost: { amount: cents, currency: 'USD' }, effectiveFrom: day }];
  });
  const bad = list.some((x) => (values[x.offerId!] ?? '').trim() !== '' && parseCost(values[x.offerId!]!) === null);
  const close = () => {
    save.reset();
    setValues({});
    onClose();
  };
  const done = save.data;
  return (
    <Dialog
      open={open}
      onClose={close}
      title="Enter missing costs"
      foot={
        done ? (
          <Button onClick={close}>Done</Button>
        ) : (
          <>
            <Button variant="ghost" onClick={close}>
              Cancel
            </Button>
            <Button disabled={!items.length || bad || !day || save.isPending} onClick={() => save.mutate(items)}>
              {save.isPending ? 'Saving…' : `Save ${items.length || ''} cost${items.length === 1 ? '' : 's'}`.replace('  ', ' ')}
            </Button>
          </>
        )
      }
    >
      {done ? (
        <div className="stack gap-2">
          <Alert tone={done.errors.length ? 'warning' : 'success'} title={`${done.saved} unit cost${done.saved === 1 ? '' : 's'} saved`}>
            {done.errors.length ? `${done.errors.length} could not be saved: ${done.errors.map((e) => `${rows.find((x) => x.offerId === e.offerId)?.product ?? e.offerId} (${e.code === 'NOT_FOUND' ? 'offer not found' : 'check the amount and day'})`).join(', ')}.` : 'Profit figures update within a minute.'}
          </Alert>
        </div>
      ) : (
        <div className="stack gap-3">
          <p className="small muted">What you paid for one unit, in dollars. Leave a product empty to skip it.</p>
          <label className="row gap-2 small" style={{ flexWrap: 'wrap' }}>
            <span className="strong">Costs apply from</span>
            <TextInput id="mc-from" ctl="sm" type="date" value={day} min={costEarliest()} max={costToday()} style={{ width: '10rem' }} onChange={(e) => setDay(e.target.value)} />
          </label>
          {save.isError && (
            <Alert tone="danger" title="The costs weren’t saved">
              {errorMessage(save.error)}
            </Alert>
          )}
          <TableWrap label="Products without a cost">
            <table className="table">
              <thead>
                <tr>
                  <th scope="col">Product</th>
                  <th scope="col" className="r">
                    Unit cost
                  </th>
                </tr>
              </thead>
              <tbody>
                {list.map((x) => {
                  const v = values[x.offerId!] ?? '';
                  return (
                    <tr key={x.offerId!}>
                      <th scope="row" className="small">
                        {x.product ?? x.offerId}
                      </th>
                      <td className="r">
                        <TextInput id={`mc-${x.offerId}`} ctl="sm" prefix="$" inputMode="decimal" aria-label={`Unit cost of ${x.product ?? 'this product'}`} value={v} error={v.trim() !== '' && parseCost(v) === null} style={{ width: '7rem' }} onChange={(e) => setValues({ ...values, [x.offerId!]: e.target.value })} />
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </TableWrap>
          {rows.length > 500 && <p className="xs muted">The first 500 products are listed; use a bulk update file for the rest.</p>}
        </div>
      )}
    </Dialog>
  );
}

