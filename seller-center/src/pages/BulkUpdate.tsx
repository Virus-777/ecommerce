import { useEffect, useRef, useState, type ReactNode } from 'react';
import { keepPreviousData, useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useSearchParams } from 'react-router';
import { ApiError, call, errorMessage, uploadMedia, useApi, type components } from '@marketly/web-shared/api';
import { SellerLayout } from '@marketly/web-shared/layouts';
import { cx } from '@marketly/web-shared/lib/cx';
import { useView } from '@marketly/web-shared/lib/hooks';
import { formatMoney } from '@marketly/web-shared/lib/format';
import { href } from '@marketly/web-shared/routes';
import { Alert, Button, Card, EmptyState, Icon, PageHeader, Pager, SegmentedControl, StatusLegend, Steps, TableWrap, announce, type IconName } from '@marketly/web-shared/ui';
import { useSellerSession } from '@/app/session';
import { LoadError, SkeletonRows, fmtFull, fmtWhen, openDownload, useSellerSettings, type Money } from './data/catalog-parts';

// Design: pages/seller/seller-bulk-update.html (step 3, preview of an uploaded CSV) · view "applied" = step 4
// done, correction report and upload history. Data: offers bulk updates — GET …/template (prefilled CSV),
// media upload (purpose bulk_file) + POST …/bulk-updates (parse and validate), GET …/{id} and …/{id}/rows
// (preview), POST …/{id}/apply, GET …/{id}/correction-report, GET …/bulk-updates (history). The optional
// unit_cost column saves a unit cost from today (docs/09 §3.1); the preview shows it when the file has one.
// ?job=<id> opens one upload; without it the latest preview (or, on ?view=applied, the latest applied file).

type View = 'applied';
type Job = components['schemas']['offers.BulkUpdateJob'];
type Row = components['schemas']['offers.BulkUpdateRow'];
type Filter = 'all' | 'errors' | 'ready';

const ROWS_LIMIT = 50;
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

function Change({ from, to, money: isMoney }: { from: number | Money; to: number | Money; money?: boolean }) {
  const f = (v: number | Money) => (isMoney ? formatMoney(v as Money) : String(v));
  return (
    <span className="num nowrap">
      <span className="sa-strike">{f(from)}</span>
      <span className="sa-arrow">→</span>
      <b>{f(to)}</b>
    </span>
  );
}

const pctText = (n: number) => `${n > 0 ? '+' : n < 0 ? '−' : ''}${Math.abs(n).toLocaleString('en-US', { maximumFractionDigits: 1 })}%`;

function PriceCell({ r }: { r: Row }) {
  if (!r.priceFrom && !r.priceTo) return <span className="xs muted">No value</span>;
  if (r.priceFrom && r.priceTo && r.priceFrom.amount !== r.priceTo.amount)
    return (
      <span className="stack gap-0">
        <Change from={r.priceFrom} to={r.priceTo} money />
        {r.largeChange && r.changePct != null && <span className="xs t-warning-text strong">Large change {pctText(r.changePct)}</span>}
      </span>
    );
  const v = r.priceTo ?? r.priceFrom;
  return <span className={cx('num', !r.priceTo || r.priceTo.amount === r.priceFrom?.amount ? 'muted' : '')}>{formatMoney(v!)}</span>;
}

/** unit_cost column: the cost in force when the file was read → the cost the row sets (from today). */
function CostCell({ r }: { r: Row }) {
  if (!r.unitCostTo) return r.unitCostFrom ? <span className="num muted">{formatMoney(r.unitCostFrom)}</span> : <span className="xs muted">No value</span>;
  if (r.unitCostFrom && r.unitCostFrom.amount !== r.unitCostTo.amount) return <Change from={r.unitCostFrom} to={r.unitCostTo} money />;
  return <span className="num">{formatMoney(r.unitCostTo)}</span>;
}

function QtyCell({ r }: { r: Row }) {
  if (r.quantityFrom == null && r.quantityTo == null) return <span className="xs muted">No value</span>;
  if (r.quantityFrom != null && r.quantityTo != null && r.quantityFrom !== r.quantityTo) return <Change from={r.quantityFrom} to={r.quantityTo} />;
  return <span className="num muted">{r.quantityTo ?? r.quantityFrom}</span>;
}

const KPI = ({ icon, k, v, d }: { icon: IconName; k: string; v: ReactNode; d?: string }) => (
  <div className="card pad">
    <div className="stat">
      <span className="k">
        <Icon name={icon} className="ic-sm" />
        {k}
      </span>
      <span className="v">{v}</span>
      {d && <span className="d">{d}</span>}
    </div>
  </div>
);

const RESULT_BADGE: Record<Row['result'], { label: string; cls: string }> = {
  ready: { label: 'Ready', cls: 'badge t-success' },
  unchanged: { label: 'Unchanged', cls: 'badge' },
  applied: { label: 'Applied', cls: 'badge t-success' },
  skipped: { label: 'Skipped', cls: 'badge t-danger' },
  pending_approval: { label: 'Waiting for approval', cls: 'badge t-warning' },
  error: { label: 'Error', cls: 'badge t-danger' },
};

export default function BulkUpdate() {
  const { api, session } = useApi();
  const qc = useQueryClient();
  const { sellerId, can } = useSellerSession();
  const [view, setView] = useView<View>();
  const [params, setParams] = useSearchParams();
  const [filter, setFilter] = useState<Filter>('all');
  const [page, setPage] = useState(1);
  const [fileError, setFileError] = useState('');
  const [needsConfirm, setNeedsConfirm] = useState(false);
  const input = useRef<HTMLInputElement>(null);
  const allowed = can('offers.bulk.update');

  const counts = useQuery({ queryKey: ['offers', 'counts', sellerId], queryFn: () => call(api.GET('/api/seller/offers/offers/counts')) });
  const history = useQuery({
    queryKey: ['offers', 'bulk-updates', sellerId],
    queryFn: () => call(api.GET('/api/seller/offers/bulk-updates', { params: { query: { limit: 10 } } })),
    enabled: allowed,
  });
  const fallback = (history.data?.items ?? []).find((j) => (view === 'applied' ? j.state === 'applied' : j.state === 'preview_ready' || j.state === 'uploaded' || j.state === 'applying'));
  const jobId = params.get('job') ?? fallback?.id ?? '';
  const job = useQuery({
    queryKey: ['offers', 'bulk-update', sellerId, jobId],
    queryFn: () => call(api.GET('/api/seller/offers/bulk-updates/{id}', { params: { path: { id: jobId } } })),
    enabled: allowed && !!jobId,
    refetchInterval: (q) => (q.state.data && (q.state.data.state === 'uploaded' || q.state.data.state === 'applying') ? 1500 : false),
  });
  const j = job.data;
  const applied = j?.state === 'applied';
  const result = filter === 'errors' ? (applied ? 'skipped' : 'error') : filter === 'ready' ? (applied ? 'applied' : 'ready') : undefined;
  const rows = useQuery({
    queryKey: ['offers', 'bulk-update', sellerId, jobId, 'rows', j?.state, result ?? 'all', page],
    queryFn: () => call(api.GET('/api/seller/offers/bulk-updates/{id}/rows', { params: { path: { id: jobId }, query: { page, limit: ROWS_LIMIT, ...(result ? { result } : {}) } } })),
    enabled: !!j && (j.state === 'preview_ready' || j.state === 'applied'),
    placeholderData: keepPreviousData,
  });
  // Rows that need fixing (errors before applying, skipped rows after) for the correction report card.
  const errorRows = useQuery({
    queryKey: ['offers', 'bulk-update', sellerId, jobId, 'rows', j?.state, 'errors-all'],
    queryFn: () => call(api.GET('/api/seller/offers/bulk-updates/{id}/rows', { params: { path: { id: jobId }, query: { limit: 100, result: 'skipped' } } })),
    enabled: !!j && applied,
  });

  // Rows that change a live offer's price by more than the large-change limit: applying them needs confirmLargeChanges,
  // so they are listed for confirmation before the file is applied.
  const largeRows = useQuery({
    queryKey: ['offers', 'bulk-update', sellerId, jobId, 'rows', j?.state, 'large'],
    queryFn: async () => {
      const out: Row[] = [];
      let cursor: string | undefined;
      for (let i = 0; i < 60; i++) {
        const p = await call(api.GET('/api/seller/offers/bulk-updates/{id}/rows', { params: { path: { id: jobId }, query: { limit: 100, result: 'ready', ...(cursor ? { cursor } : {}) } } }));
        out.push(...p.items.filter((r) => r.largeChange));
        if (!p.nextCursor) break;
        cursor = p.nextCursor;
      }
      return out;
    },
    enabled: !!j && j.state === 'preview_ready' && j.totals.priceChanges > 0,
  });
  const large = largeRows.data ?? [];
  const largePct = useSellerSettings().num('offers.largeSellerPriceChangePct');

  useEffect(() => setPage(1), [filter, jobId]);
  // The view follows the job: an applied file shows step 4.
  useEffect(() => {
    if (!j) return;
    if (applied && view !== 'applied') setView('applied', { replace: true });
    if (!applied && view === 'applied' && params.get('job')) setView('', { replace: true });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [j?.state]);

  const openJob = (id: string) => {
    const next = new URLSearchParams(params);
    next.set('job', id);
    next.delete('view');
    setParams(next, { replace: true });
  };

  const upload = useMutation({
    mutationFn: async (f: File) => {
      if (!/\.(csv|xlsx)$/i.test(f.name)) throw new ApiError(415, 'FILE_TYPE_NOT_ALLOWED', 'Upload the CSV template (or an .xlsx file) with the columns seller_sku, price and quantity.');
      const asset = await uploadMedia(session, f, 'bulk_file');
      let created = await call(api.POST('/api/seller/offers/bulk-updates', { body: { fileId: asset.id } }));
      for (let i = 0; i < 60 && created.state === 'uploaded'; i++) {
        await sleep(1500);
        created = await call(api.GET('/api/seller/offers/bulk-updates/{id}', { params: { path: { id: created.id } } }));
      }
      return created;
    },
    onSuccess: (created) => {
      setFileError(created.state === 'failed' ? (created.failure ?? 'We couldn’t read that file.') : '');
      setFilter('all');
      setNeedsConfirm(false);
      qc.setQueryData(['offers', 'bulk-update', sellerId, created.id], created);
      void qc.invalidateQueries({ queryKey: ['offers', 'bulk-updates', sellerId] });
      openJob(created.id);
      const t = created.totals;
      announce(`${t.rows} rows read from ${created.fileName}: ${t.ready} ready, ${t.errors} with errors`);
    },
    onError: (e) => {
      const issues = e instanceof ApiError ? (e.details.issues as Array<{ message: string }> | undefined) : undefined;
      const msg = issues?.length ? `${errorMessage(e)} ${issues.map((i) => i.message).join(' ')}` : errorMessage(e);
      setFileError(msg);
      announce(msg);
    },
  });

  const apply = useMutation({
    mutationFn: async (confirm: boolean) => {
      let done = await call(api.POST('/api/seller/offers/bulk-updates/{id}/apply', { params: { path: { id: jobId } }, body: confirm ? { confirmLargeChanges: true } : {} }));
      for (let i = 0; i < 60 && done.state === 'applying'; i++) {
        await sleep(1500);
        done = await call(api.GET('/api/seller/offers/bulk-updates/{id}', { params: { path: { id: jobId } } }));
      }
      return done;
    },
    onSuccess: (done) => {
      setNeedsConfirm(false);
      qc.setQueryData(['offers', 'bulk-update', sellerId, done.id], done);
      void qc.invalidateQueries({ queryKey: ['offers'] });
      void qc.invalidateQueries({ queryKey: ['inventory'] });
      setFilter('all');
      setView('applied');
      announce(`${done.totals.applied} rows applied`);
    },
    onError: (e) => {
      if (e instanceof ApiError && e.code === 'LARGE_PRICE_CHANGE_UNCONFIRMED') setNeedsConfirm(true);
    },
  });

  const template = useMutation({
    mutationFn: () => call(api.GET('/api/seller/offers/bulk-updates/template')),
    onSuccess: (link) => {
      openDownload(link.url, link.fileName);
      announce('Template downloaded');
    },
  });
  const report = useMutation({
    mutationFn: (id: string) => call(api.GET('/api/seller/offers/bulk-updates/{id}/correction-report', { params: { path: { id } } })),
    onSuccess: (link) => {
      openDownload(link.url, link.fileName);
      announce('Correction report downloaded');
    },
  });

  const pick = () => input.current?.click();
  const t = j?.totals;
  const shown = rows.data?.items ?? [];
  // the unit cost column only when the file has one (older templates have no unit_cost)
  const withCost = shown.some((r) => r.unitCostTo || r.unitCostFrom);
  const shownTotal = rows.data?.total ?? shown.length;
  const reportRows = applied ? (errorRows.data?.items ?? []) : [];
  const busy = upload.isPending || j?.state === 'uploaded';
  const writeError = [template, report].find((m) => m.isError);

  const top = (
    <>
      <PageHeader crumbs={[{ label: 'Inventory', to: href('seller/inventory') }, { label: 'Bulk update' }]} title="Bulk price and stock update" sub="Update prices and quantities for many SKUs with one CSV file." />
      <Steps items={['Download template', 'Upload file', 'Check preview', 'Apply']} current={applied ? 4 : j ? 2 : 0} />
    </>
  );

  if (!allowed)
    return (
      <SellerLayout active="inventory">
        {top}
        <section className="card">
          <EmptyState icon="lock" as="h2" title="Bulk updates aren’t part of your role" action={<Button to={href('seller/inventory')}>Back to inventory</Button>}>
            Ask the store owner for the bulk update permission, or change prices and stock one offer at a time.
          </EmptyState>
        </section>
      </SellerLayout>
    );

  return (
    <SellerLayout active="inventory">
      {top}
      <input ref={input} type="file" accept=".csv,text/csv,.xlsx" hidden onChange={(e) => (e.target.files?.[0] && upload.mutate(e.target.files[0]), (e.target.value = ''))} />
      <div className="grid md2">
        <div className="card pad stack gap-2">
          <span className="row gap-2">
            <Icon name="file-down" />
            <span className="strong">1. Download the template</span>
          </span>
          <p className="small sub">Prefilled with your {counts.data ? `${counts.data.all} ` : ''}SKUs, current prices, quantities and unit costs. Columns: seller_sku, price, quantity and unit_cost.</p>
          <p className="xs muted">
            <span className="mono">unit_cost</span> is optional: what one unit costs you, in dollars (like 42.50). A value saves a new cost from today, used for profit in Statistics; an empty cell keeps the current cost. Changing costs needs the permission to manage costs.
          </p>
          <div className="row gap-2">
            <Button variant="secondary" size="sm" icon="download" onClick={() => template.mutate()} disabled={template.isPending}>
              {template.isPending ? 'Preparing…' : 'Download template'}
            </Button>
          </div>
        </div>
        <div className="card pad stack gap-2">
          <span className="row gap-2">
            <Icon name="file-up" />
            <span className="strong">2. Upload your file</span>
          </span>
          <div className="panel row gap-2 nowrap">
            <Icon name="file-spreadsheet" className="ic-sm" />
            <span className="small grow truncate">{busy ? (upload.variables?.name ?? j?.fileName ?? 'Reading your file…') : (j?.fileName ?? 'No file uploaded yet')}</span>
            <span className="xs muted">{busy ? 'Checking…' : t ? `${t.rows} rows` : 'CSV, up to 25 MB'}</span>
          </div>
          <div className="row gap-2">
            <Button variant="ghost" size="sm" onClick={pick} disabled={busy}>
              {j ? 'Replace file' : 'Upload file'}
            </Button>
          </div>
        </div>
      </div>
      {fileError && (
        <Alert tone="danger" title="We couldn't read that file">
          {fileError}
        </Alert>
      )}
      {writeError && (
        <Alert tone="danger" title="The download didn’t start">
          {errorMessage(writeError.error)}
        </Alert>
      )}
      {(history.isError || job.isError) && <LoadError error={history.error ?? job.error} onRetry={() => void (history.isError ? history.refetch() : job.refetch())} />}
      {jobId && !j && !job.isError ? (
        <section className="card">
          <SkeletonRows rows={4} thumb={false} />
        </section>
      ) : j?.state === 'failed' ? (
        <Alert tone="danger" title="We couldn't read that file">
          {j.failure ?? 'Check the columns and try again.'} Download the template, fill it in and upload it again.
        </Alert>
      ) : j?.state === 'expired' ? (
        <Alert tone="warning" title="This preview expired">
          Prices and stock may have changed since {fmtWhen(j.uploadedAt)}. Upload the file again to check it.
        </Alert>
      ) : applied && t ? (
        <>
          <Alert tone="success" title={`${t.applied} row${t.applied === 1 ? '' : 's'} applied`}>
            Applied {fmtFull(j!.appliedAt)}
            {j!.appliedBy?.name ? ` by ${j!.appliedBy.name}` : ''}. New prices and quantities are live on your offers now.
            {t.skipped ? ` ${t.skipped} row${t.skipped === 1 ? ' was' : 's were'} skipped.` : ''}
            {t.pendingApproval ? ` ${t.pendingApproval} waiting for approval.` : ''}
          </Alert>
          <div className="sa-kpis">
            <KPI icon="circle-check" k="Updated" v={t.applied} />
            <KPI icon="circle-alert" k="Skipped" v={<span className={cx(t.skipped > 0 && 't-danger-text')}>{t.skipped}</span>} d={t.skipped ? 'See correction report' : undefined} />
            <KPI icon="tag" k="Price changes" v={t.priceChanges} />
            <KPI icon="boxes" k="Stock changes" v={t.stockChanges} d={'Recorded as "Bulk update"'} />
          </div>
          {reportRows.length > 0 && (
            <Card
              title="Correction report"
              sub={`${reportRows.length} row${reportRows.length === 1 ? ' was' : 's were'} not applied. Fix and upload just these rows.`}
              actions={
                <Button size="sm" icon="download" onClick={() => report.mutate(j!.id)} disabled={report.isPending}>
                  Download report (CSV)
                </Button>
              }
              flush
            >
              <TableWrap label="Correction report table">
                <table className="table">
                  <thead>
                    <tr>
                      <th scope="col">Row</th>
                      <th scope="col">Seller SKU</th>
                      <th scope="col">What to fix</th>
                    </tr>
                  </thead>
                  <tbody>
                    {reportRows.map((r) => (
                      <tr key={r.row} className="is-flagged">
                        <td>
                          <span className="sr-only">Urgent: </span>
                          <span className="num xs muted">{r.row}</span>
                        </td>
                        <td>
                          <span className="mono xs nowrap" title={r.sellerSku}>
                            {r.sellerSku}
                          </span>
                        </td>
                        <td>
                          <span className="small">{r.error?.message ?? 'Not applied'}</span>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </TableWrap>
              <StatusLegend items={[{ tone: 'danger', label: 'Red edge = urgent: overdue or past target' }]} />
            </Card>
          )}
          <Card title="Upload history" titleAs="h3" flush>
            {!history.data ? (
              <SkeletonRows rows={2} thumb={false} />
            ) : (
              <TableWrap label="Upload history table">
                <table className="table">
                  <thead>
                    <tr>
                      <th scope="col">File</th>
                      <th scope="col">Uploaded</th>
                      <th scope="col">By</th>
                      <th className="r" scope="col">
                        Applied
                      </th>
                      <th className="r" scope="col">
                        Skipped
                      </th>
                      <th scope="col">
                        <span className="sr-only">Actions</span>
                      </th>
                    </tr>
                  </thead>
                  <tbody>
                    {history.data.items.map((h: Job) => (
                      <tr key={h.id}>
                        <td>
                          <a
                            href="#"
                            onClick={(e) => {
                              e.preventDefault();
                              openJob(h.id);
                            }}
                          >
                            {h.fileName}
                          </a>
                        </td>
                        <td>{fmtWhen(h.uploadedAt)}</td>
                        <td>{h.uploadedBy.name ?? (h.state === 'applied' ? h.appliedBy?.name : null) ?? (h.uploadedBy.kind === 'seller' ? 'Your team' : 'Marketly')}</td>
                        <td className="r">{h.state === 'applied' ? h.totals.applied : '—'}</td>
                        <td className="r">{h.state === 'applied' ? h.totals.skipped : h.state === 'preview_ready' ? 'Not applied' : h.state.replace('_', ' ')}</td>
                        <td>
                          {h.totals.errors > 0 || h.totals.skipped > 0 ? (
                            <a
                              className="small"
                              href="#"
                              onClick={(e) => {
                                e.preventDefault();
                                report.mutate(h.id);
                              }}
                            >
                              Report
                            </a>
                          ) : null}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </TableWrap>
            )}
          </Card>
        </>
      ) : j && t ? (
        <>
          <div className="sa-kpis">
            <KPI icon="file-spreadsheet" k="Rows in file" v={t.rows} />
            <KPI icon="circle-check" k="Ready to apply" v={t.ready} d={`${t.priceChanges} price · ${t.stockChanges} stock changes`} />
            <KPI icon="circle-alert" k="Errors" v={<span className={cx(t.errors > 0 && 't-danger-text')}>{t.errors}</span>} d="Skipped unless fixed" />
            <KPI icon="minus" k="Unchanged" v={t.unchanged} />
          </div>
          {t.errors > 0 && (
            <Alert tone="warning" title={`${t.errors} row${t.errors === 1 ? ' has' : 's have'} errors`}>
              Rows with errors are skipped. Nothing changes until you apply. Fix them in your file and upload again, or apply the {t.ready} valid rows now and download the correction report.
            </Alert>
          )}
          {needsConfirm && (
            <Alert tone="warning" title="Some prices change a lot">
              {large.length
                ? `${large.length} row${large.length === 1 ? ' changes a price' : 's change prices'} by more than ${largePct !== undefined ? `${largePct}%` : 'the large-change limit'}: ${large
                    .slice(0, 5)
                    .map((r) => `${r.sellerSku} ${r.priceFrom ? formatMoney(r.priceFrom) : ''} → ${r.priceTo ? formatMoney(r.priceTo) : ''}${r.changePct != null ? ` (${pctText(r.changePct)})` : ''}`)
                    .join('; ')}${large.length > 5 ? `; and ${large.length - 5} more` : ''}.`
                : `At least one row changes a price by more than ${largePct !== undefined ? `${largePct}%` : 'the large-change limit'}.`}{' '}
              Check the preview, then confirm to apply.{' '}
              <Button size="sm" variant="secondary" onClick={() => apply.mutate(true)} disabled={apply.isPending}>
                Confirm and apply
              </Button>
            </Alert>
          )}
          {apply.isError && !needsConfirm && (
            <Alert tone="danger" title="The file wasn’t applied">
              {errorMessage(apply.error)}
            </Alert>
          )}
          <Card
            title="Preview"
            sub={`${j.fileName} · uploaded ${fmtWhen(j.uploadedAt)}${j.uploadedBy.name ? ` by ${j.uploadedBy.name}` : ''} · apply by ${fmtWhen(j.expiresAt)}`}
            actions={
              <SegmentedControl<Filter>
                items={[
                  { value: 'all', label: 'All rows' },
                  { value: 'errors', label: `Errors (${t.errors})` },
                  { value: 'ready', label: `Ready (${t.ready})` },
                ]}
                active={filter}
                onChange={setFilter}
              />
            }
            flush
            foot={
              <>
                <span className="xs muted grow">
                  Showing {shown.length} of {filter === 'all' ? t.rows : shownTotal} rows
                </span>
                {(rows.data?.totalPages ?? 1) > 1 && <Pager page={page} total={rows.data!.totalPages!} onPage={setPage} only="website" />}
                <Button variant="secondary" size="sm" icon="download" onClick={() => report.mutate(j.id)} disabled={!t.errors || report.isPending}>
                  Download correction report
                </Button>
                <Button variant="secondary" size="sm" icon="upload" onClick={pick} disabled={busy}>
                  Upload a corrected file
                </Button>
                <Button size="sm" onClick={() => (large.length && !needsConfirm ? setNeedsConfirm(true) : apply.mutate(needsConfirm))} disabled={!t.ready || apply.isPending || j.state !== 'preview_ready' || largeRows.isFetching}>
                  {apply.isPending || j.state === 'applying' ? 'Applying…' : `Apply ${t.ready} valid row${t.ready === 1 ? '' : 's'}`}
                </Button>
              </>
            }
          >
            {j.state === 'uploaded' || !rows.data ? (
              <SkeletonRows rows={4} thumb={false} />
            ) : (
              <TableWrap label="Preview table">
                <table className="table">
                  <thead>
                    <tr>
                      <th scope="col">Row</th>
                      <th scope="col">Seller SKU</th>
                      <th scope="col">Product</th>
                      <th scope="col">Price</th>
                      <th scope="col">Quantity</th>
                      {withCost && <th scope="col">Unit cost</th>}
                      <th scope="col">Result</th>
                    </tr>
                  </thead>
                  <tbody>
                    {shown.map((r) => (
                      <tr key={r.row} className={r.error ? 'is-flagged' : ''}>
                        <td>
                          {r.error && <span className="sr-only">Urgent: </span>}
                          <span className="num xs muted">{r.row}</span>
                        </td>
                        <td>
                          <span className="mono xs nowrap" title={r.sellerSku}>
                            {r.sellerSku}
                          </span>
                        </td>
                        <td>{r.productLabel ? <span className="small">{r.productLabel}</span> : <span className="xs muted">Not found</span>}</td>
                        <td>
                          <PriceCell r={r} />
                        </td>
                        <td>
                          <QtyCell r={r} />
                        </td>
                        {withCost && (
                          <td>
                            <CostCell r={r} />
                          </td>
                        )}
                        <td>
                          {r.error ? (
                            <span className="error-text wrap items-start u-maxw-36ch">
                              <Icon name="circle-alert" className="ic-sm" />
                              <span>{r.error.message}</span>
                            </span>
                          ) : (
                            <span className={RESULT_BADGE[r.result].cls}>{RESULT_BADGE[r.result].label}</span>
                          )}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </TableWrap>
            )}
            {rows.data && shown.length === 0 && <EmptyState icon="search-x" title={filter === 'errors' ? 'No rows with errors' : 'No rows to show'} />}
            {shown.some((r) => r.error) && <StatusLegend items={[{ tone: 'danger', label: 'Red edge = urgent: overdue or past target' }]} />}
          </Card>
        </>
      ) : !jobId && history.data ? (
        <section className="card">
          <EmptyState icon="file-spreadsheet" as="h2" title="Upload a file to see the preview" action={<Button icon="upload" onClick={pick} disabled={busy}>{busy ? 'Checking your file…' : 'Upload file'}</Button>}>
            Download the template, change prices or quantities, then upload it. Nothing changes until you check the preview and apply it.
          </EmptyState>
        </section>
      ) : null}
      <p className="xs muted row gap-1 nowrap top">
        <Icon name="info" className="ic-sm" />
        <span className="wrap">Price changes over {largePct !== undefined ? `${largePct}%` : 'the large-change limit'} in one update and broad catalog edits need extra confirmation. Stock changes are recorded with the reason "Bulk update" and your name.</span>
      </p>
    </SellerLayout>
  );
}
