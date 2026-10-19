import { useEffect, useState, type ReactNode } from 'react';
import { keepPreviousData, useInfiniteQuery, useMutation, useQuery } from '@tanstack/react-query';
import { Link } from 'react-router';
import { call, errorMessage, useApi } from '@marketly/web-shared/api';
import { SellerLayout } from '@marketly/web-shared/layouts';
import { cx } from '@marketly/web-shared/lib/cx';
import { useIsPhone, useView } from '@marketly/web-shared/lib/hooks';
import { href } from '@marketly/web-shared/routes';
import { Alert, Badge, Button, Card, Deadline, Icon, KeyValue, LazyLoad, PageHeader, Pager, SearchInput, Select, StatusBadge, TableWrap, Tabs, announce } from '@marketly/web-shared/ui';
import { useSellerSession } from '@/app/session';
import { API_TAB, RETURN_PERIODS, RETURN_REASONS, deadlineTone, fmtDate, fmtDateTime, money, rowEdge, tabCount, useDebounced, useInView, type ReturnTab, type SellerReturnRow } from './data/returns';

// Design: pages/seller/seller-returns.html · views: received-to-inspect, disputes, closed (the list tabs).
// Data: GET /api/seller/returns/requests (tab, q, reason, period; page on the website, cursor on the phone),
// …/requests/counts (queue tiles and tab totals), …/terms (return address and terms), POST …/requests/exports.

const LIMIT = 25;

const TABS: Array<{ value: ReturnTab; label: string }> = [
  { value: '', label: 'Return requests' },
  { value: 'received-to-inspect', label: 'Received, to inspect' },
  { value: 'disputes', label: 'Disputes' },
  { value: 'closed', label: 'Closed' },
];

const DUE_HEAD: Record<ReturnTab, string> = { '': 'Respond by', 'received-to-inspect': 'Inspect by', disputes: 'Next deadline', closed: 'Outcome' };

const rowLink = (tab: ReturnTab, r: SellerReturnRow) => href('seller/return', tab === 'received-to-inspect' ? 'inspect-and-refund' : '', { ref: r.ref });
const edgeSr = (r: SellerReturnRow) => (rowEdge(r.deadline) === 'flagged' ? 'Urgent: ' : rowEdge(r.deadline) === 'warn' ? 'At risk: ' : '');
const edgeClass = (r: SellerReturnRow) => (rowEdge(r.deadline) === 'flagged' ? 'is-flagged' : rowEdge(r.deadline) === 'warn' ? 'is-warn' : '');
const itemText = (r: SellerReturnRow) => `${r.item.title}${r.item.quantity > 1 ? ` × ${r.item.quantity}` : ''}${r.itemCount > 1 ? ` + ${r.itemCount - 1} more` : ''}`;
const zero = (r: SellerReturnRow) => ({ amount: 0, currency: r.amount.currency });

function Due({ r, nowrap }: { r: SellerReturnRow; nowrap?: boolean }) {
  return r.deadline ? <Deadline tone={deadlineTone(r.deadline)}>{r.deadlineLabel}</Deadline> : <span className={cx('xs sub', nowrap && 'nowrap')}>{r.deadlineLabel}</span>;
}

function SupportBadge({ tone }: { tone: 'danger' | 'info' }) {
  return (
    <Badge tone={tone} icon="shield">
      Marketly support involved
    </Badge>
  );
}
const supportTone = (r: SellerReturnRow): 'danger' | 'info' => (r.deadline ? 'danger' : 'info');

/** Queue tile with the design's screen-reader urgency note for both tones ((urgent) / (at risk)). */
function Tile({ n, label, sub, tone, to }: { n: ReactNode; label: string; sub: ReactNode; tone?: 'danger' | 'warning'; to: string }) {
  return (
    <Link className={cx('queue-tile', tone && `t-${tone}`)} to={to}>
      <span className="qn">
        {n}
        {tone && <span className="sr-only">{tone === 'danger' ? ' (urgent)' : ' (at risk)'}</span>}
      </span>
      <span className="stack gap-0 grow">
        <span className="small strong">{label}</span>
        <span className="xs muted">{sub}</span>
      </span>
      <Icon name="chevron-right" className="ic-sm" />
    </Link>
  );
}

function EdgeLegend({ danger, warning }: { danger: boolean; warning: boolean }) {
  if (!danger && !warning) return null;
  return (
    <p className="status-legend status-legend--edge">
      <span className="sr-only">Legend: </span>
      {danger && (
        <span className="sl sl-danger">
          <i aria-hidden="true" />
          Red edge = urgent: overdue or past target
        </span>
      )}
      {warning && (
        <span className="sl sl-warning">
          <i aria-hidden="true" />
          Amber edge = at risk: due soon or near target
        </span>
      )}
    </p>
  );
}

const sk = <span className="sk sk-line" aria-hidden="true" />;

export default function Returns() {
  const { api } = useApi();
  const { sellerId, can } = useSellerSession();
  const isPhone = useIsPhone();
  const [view, setView] = useView<Exclude<ReturnTab, ''>>();
  const tab = (TABS.some((t) => t.value === view) ? view : '') as ReturnTab;
  const [q, setQ] = useState('');
  const [reason, setReason] = useState('');
  const [period, setPeriod] = useState<(typeof RETURN_PERIODS)[number]['value']>('last_30_days');
  const [page, setPage] = useState(1);
  const search = useDebounced(q.trim());
  const filter = { tab: API_TAB[tab], q: search || undefined, reason: reason || undefined, period };
  useEffect(() => setPage(1), [tab, search, reason, period]);

  const counts = useQuery({ queryKey: ['returns', 'counts', sellerId], queryFn: () => call(api.GET('/api/seller/returns/requests/counts')) });
  const terms = useQuery({ queryKey: ['returns', 'terms', sellerId], queryFn: () => call(api.GET('/api/seller/returns/terms')) });
  const list = (paging: { page?: number; cursor?: string }) => call(api.GET('/api/seller/returns/requests', { params: { query: { ...filter, ...paging, limit: LIMIT } } }));
  const pageQ = useQuery({ queryKey: ['returns', 'list', sellerId, { ...filter, page }], queryFn: () => list({ page }), enabled: !isPhone, placeholderData: keepPreviousData });
  const phoneQ = useInfiniteQuery({
    queryKey: ['returns', 'list', sellerId, 'cursor', filter],
    initialPageParam: '',
    queryFn: ({ pageParam }) => list(pageParam ? { cursor: pageParam } : {}),
    getNextPageParam: (last) => last.nextCursor ?? undefined,
    enabled: isPhone,
  });
  const active = isPhone ? phoneQ : pageQ;
  const rows: SellerReturnRow[] = isPhone ? (phoneQ.data?.pages.flatMap((p) => p.items) ?? []) : (pageQ.data?.items ?? []);
  const totalPages = pageQ.data?.totalPages ?? 1;
  const more = useInView<HTMLDivElement>(() => void phoneQ.fetchNextPage(), isPhone && phoneQ.hasNextPage && !phoneQ.isFetchingNextPage);

  const c = counts.data;
  const t = terms.data;
  const inTab = tabCount(c, tab) ?? rows.length;
  const hasDanger = rows.some((r) => rowEdge(r.deadline) === 'flagged');
  const hasWarn = rows.some((r) => rowEdge(r.deadline) === 'warn');
  const closed = tab === 'closed';
  const dueFirst = tab === '';
  const loading = active.isPending;
  const periodLabel = RETURN_PERIODS.find((p) => p.value === period)!.label;

  const intro: Record<ReturnTab, string> = {
    '': 'Approve, reject with a reason or request information before the respond-by time. If you miss it, Marketly support may decide the return.',
    'received-to-inspect': `Record the item condition and your refund decision within ${t ? `${t.baseline.inspectionTargetBusinessDays} business day${t.baseline.inspectionTargetBusinessDays === 1 ? '' : 's'}` : 'the target time'} of receipt.`,
    disputes: 'Marketly support reviews purchase terms, shipment evidence, photos and messages, then records a decision. Each decision has an appeal deadline.',
    closed: `Returns closed ${period === 'this_year' ? 'this year' : `in the ${periodLabel.toLowerCase()}`}. Refunds show the amount actually sent to the customer.`,
  };

  // CSV export of the current tab and filters: the export job runs in the background, then downloads.
  const exportCsv = useMutation({
    mutationFn: async () => {
      let job = await call(api.POST('/api/seller/returns/requests/exports', { body: { filters: filter, format: 'csv' } }));
      announce('Preparing your export…');
      const until = Date.now() + 120_000;
      while ((job.state === 'queued' || job.state === 'running') && Date.now() < until) {
        await new Promise((r) => setTimeout(r, 2000));
        job = await call(api.GET('/api/seller/returns/requests/exports/{id}', { params: { path: { id: job.id } } }));
      }
      if (job.state === 'failed' || job.state === 'expired') throw new Error('The export failed. Try again.');
      if (job.state !== 'ready' || !job.downloadUrl) throw new Error('The export is taking longer than usual. Try again in a few minutes.');
      return job;
    },
    onSuccess: (job) => {
      announce(`Exported ${job.rowCount ?? ''} ${closed ? 'closed returns' : 'cases'} to CSV`.replace('  ', ' '));
      window.location.assign(job.downloadUrl!);
    },
  });

  const overdue = c?.responseOverdue ?? 0;
  const waiting = c?.awaitingResponse ?? 0;
  const disputesDue = c?.disputesNeedingEvidence ?? 0;
  const addr = t?.returnAddress;
  const defectPaidBy = t?.baseline.responsibilities.find((x) => x.reasonGroup === 'defective')?.paidBy ?? 'seller';

  return (
    <SellerLayout active="returns">
      <PageHeader
        title="Returns and cases"
        sub="All times Pacific. Customers see your response target on their return page."
        actions={
          <>
            {can('returns.requests.export') && (
              <Button variant="secondary" size="sm" icon="download" onClick={() => exportCsv.mutate()} disabled={exportCsv.isPending}>
                {exportCsv.isPending ? 'Exporting…' : 'Export'}
              </Button>
            )}
            <Button variant="secondary" size="sm" icon="file-text" to={href('seller/store')}>
              Return policy
            </Button>
          </>
        }
      />
      {exportCsv.isError && (
        <Alert tone="danger" title="Export failed">
          {errorMessage(exportCsv.error)}
        </Alert>
      )}
      {counts.isError ? (
        <Alert tone="danger" title="We couldn’t load your return queues">
          {errorMessage(counts.error)}{' '}
          <Button variant="secondary" size="sm" onClick={() => void counts.refetch()}>
            Try again
          </Button>
        </Alert>
      ) : (
        <div className="sb-kpis">
          <Tile n={c ? overdue : sk} tone={overdue ? 'danger' : undefined} label="Response overdue" sub={c ? (overdue ? `${c.overdueRef ?? ''}${c.overdueRef ? ' · ' : ''}Marketly may step in` : 'Nothing overdue') : sk} to={href('seller/returns')} />
          <Tile n={c ? waiting : sk} tone={waiting ? 'warning' : undefined} label="Waiting for your response" sub={c ? (c.nextResponseDueAt ? `Next due ${fmtDateTime(c.nextResponseDueAt)}` : 'Nothing waiting') : sk} to={href('seller/returns')} />
          <Tile n={c ? c.toInspect : sk} label="Received, to inspect" sub={c ? (c.oldestReceivedAt ? `Oldest received ${fmtDate(c.oldestReceivedAt)}` : 'Nothing to inspect') : sk} to={href('seller/returns', 'received-to-inspect')} />
          <Tile n={c ? disputesDue : sk} tone={disputesDue ? 'danger' : undefined} label="Dispute needs evidence" sub={c ? (c.nextEvidenceDueAt ? `Due ${fmtDateTime(c.nextEvidenceDueAt)}` : 'No evidence requested') : sk} to={href('seller/returns', 'disputes')} />
        </div>
      )}
      <p className="status-legend status-legend--number">
        <span className="sr-only">Legend: </span>
        <span className="sl sl-danger">
          <i aria-hidden="true" />
          Red number = urgent: overdue or past target
        </span>
        <span className="sl sl-warning">
          <i aria-hidden="true" />
          Amber number = at risk: due soon or near target
        </span>
      </p>
      <div className="sb-main">
        <section className="card">
          <div className="u-p-0-sp-2">
            <Tabs items={TABS.map((x) => ({ ...x, count: tabCount(c, x.value) }))} active={tab} onChange={(v) => setView(v as Exclude<ReturnTab, ''>)} />
          </div>
          <div className="stack gap-3 u-p-sp-4">
            <div className="toolbar">
              <SearchInput id="rt-q" placeholder="Search return, order or SKU" value={q} onChange={setQ} />
              <label className="sr-only" htmlFor="rt-reason">
                Reason
              </label>
              <Select id="rt-reason" options={RETURN_REASONS} value={reason} onChange={(e) => setReason(e.target.value)} />
              <label className="sr-only" htmlFor="rt-period">
                Period
              </label>
              <Select id="rt-period" options={RETURN_PERIODS} value={period} onChange={(e) => setPeriod(e.target.value as typeof period)} />
            </div>
            <p className="xs sub">{intro[tab]}</p>
          </div>
          {active.isError ? (
            <div className="u-p-sp-4">
              <Alert tone="danger" title="We couldn’t load these returns">
                {errorMessage(active.error)}{' '}
                <Button variant="secondary" size="sm" onClick={() => void active.refetch()}>
                  Try again
                </Button>
              </Alert>
            </div>
          ) : (
            <>
              <div className="no-phone">
                <TableWrap label="Returns and cases table">
                  <table className="table">
                    <thead>
                      <tr>
                        <th scope="col">Return</th>
                        {dueFirst && <th scope="col">{DUE_HEAD[tab]}</th>}
                        <th scope="col">Item</th>
                        <th scope="col">Reason</th>
                        <th className="r" scope="col">
                          {closed ? 'Refunded' : 'Amount'}
                        </th>
                        <th scope="col">Requested</th>
                        {!dueFirst && <th scope="col">{DUE_HEAD[tab]}</th>}
                        <th className="col-pin" scope="col">
                          Status
                        </th>
                      </tr>
                    </thead>
                    <tbody>
                      {loading &&
                        Array.from({ length: 4 }, (_, i) => (
                          <tr key={i} className="sk-row" aria-hidden="true">
                            <td colSpan={7}>{sk}</td>
                          </tr>
                        ))}
                      {rows.map((r) => (
                        <tr key={r.id} className={edgeClass(r)}>
                          <td>
                            {rowEdge(r.deadline) && <span className="sr-only">{edgeSr(r)}</span>}
                            <div className="stack gap-0">
                              <Link className="mono nowrap" to={rowLink(tab, r)} title={r.ref}>
                                {r.ref}
                              </Link>
                              {r.platformInvolved && (
                                <span className="row gap-1 mt-1">
                                  <SupportBadge tone={supportTone(r)} />
                                </span>
                              )}
                              <span className="xs muted mono nowrap">{r.orderRef}</span>
                            </div>
                          </td>
                          {dueFirst && (
                            <td>
                              <Due r={r} />
                            </td>
                          )}
                          <td>
                            <div className="stack gap-0 minw-200">
                              <span className="small strong">{itemText(r)}</span>
                              {r.item.sku && (
                                <span className="xs muted mono nowrap" title={r.item.sku}>
                                  {r.item.sku}
                                </span>
                              )}
                            </div>
                          </td>
                          <td>
                            <div className="stack gap-0 minw-160">
                              <span className="small">{r.reason}</span>
                              {r.detailNote && <span className="xs muted">{r.detailNote}</span>}
                            </div>
                          </td>
                          <td className="r">
                            <span className="num">{money(closed ? (r.refundedAmount ?? zero(r)) : r.amount)}</span>
                          </td>
                          <td>
                            <span className="xs sub nowrap">{fmtDateTime(r.requestedAt)}</span>
                          </td>
                          {!dueFirst && (
                            <td>
                              <Due r={r} />
                            </td>
                          )}
                          <td className="col-pin">
                            <StatusBadge status={r.statusLabel} />
                          </td>
                        </tr>
                      ))}
                      {!loading && !rows.length && (
                        <tr>
                          <td colSpan={7}>
                            <span className="small sub">{search || reason ? 'No cases match these filters.' : closed ? 'No returns closed in this period.' : 'Nothing here right now.'}</span>
                          </td>
                        </tr>
                      )}
                    </tbody>
                  </table>
                </TableWrap>
                <EdgeLegend danger={hasDanger} warning={hasWarn} />
              </div>
              <div className="only-phone bt">
                <div className="sb-mlist">
                  {rows.map((r) => (
                    <Link key={r.id} to={rowLink(tab, r)} className={edgeClass(r)}>
                      {rowEdge(r.deadline) && <span className="sr-only">{edgeSr(r)}</span>}
                      <span className="row between">
                        <span className="mono small strong">{r.ref}</span>
                        <StatusBadge status={r.statusLabel} />
                      </span>
                      <span className="small strong">{itemText(r)}</span>
                      <span className="xs sub">
                        {r.reason}
                        {r.detailNote ? ` · ${r.detailNote}` : ''}
                      </span>
                      <span className="row between">
                        <span className="num small strong">{money(r.amount)}</span>
                        <Due r={r} />
                      </span>
                      {r.platformInvolved && (
                        <span>
                          <SupportBadge tone={supportTone(r)} />
                        </span>
                      )}
                    </Link>
                  ))}
                  {!loading && !rows.length && <span className="small sub">{search || reason ? 'No cases match these filters.' : 'Nothing here right now.'}</span>}
                </div>
                {(loading || rows.length > 0) && <div ref={more}>{loading || phoneQ.hasNextPage ? <LazyLoad /> : <LazyLoad end />}</div>}
                <EdgeLegend danger={hasDanger} warning={hasWarn} />
              </div>
            </>
          )}
          <div className="card-foot">
            <span className="xs muted grow">
              {loading ? '' : `${isPhone ? rows.length : (pageQ.data?.total ?? rows.length)} of ${inTab} ${closed ? 'closed returns' : 'cases'}`}
            </span>
            {!isPhone && totalPages > 1 && <Pager page={page} total={totalPages} onPage={setPage} only="website" />}
          </div>
        </section>
        <div className="stack gap-5">
          <Card
            title="Return address"
            sub="Printed on prepaid labels and shown to customers"
            actions={
              can('returns.terms.manage') ? (
                <Link className="small strong" to={href('seller/store')}>
                  <Icon name="pencil" className="ic-sm" /> Edit
                </Link>
              ) : undefined
            }
          >
            {terms.isError ? (
              <Alert tone="danger">
                {errorMessage(terms.error)}{' '}
                <Button variant="secondary" size="sm" onClick={() => void terms.refetch()}>
                  Try again
                </Button>
              </Alert>
            ) : (
              <div className="row top gap-3">
                <Icon name="map-pin" />
                {addr ? (
                  <div className="stack gap-0 small">
                    <span className="strong">{addr.name}</span>
                    <span>{[addr.line1, addr.line2].filter(Boolean).join(', ')}</span>
                    <span>
                      {addr.city}, {addr.region} {addr.postalCode}
                    </span>
                    {t?.receivingHours && <span className="muted">Receiving hours {t.receivingHours}</span>}
                  </div>
                ) : (
                  <div className="stack gap-1 grow" aria-hidden="true">
                    {sk}
                    {sk}
                    {sk}
                  </div>
                )}
              </div>
            )}
            <p className="xs muted">A new address applies to new return requests. Returns already on their way keep the address on their label.</p>
          </Card>
          <Card title="Your return terms" titleAs="h3" sub="Within the platform baseline">
            {t ? (
              <KeyValue
                pairs={[
                  ['Return window', `${t.windowDays} days after delivery`],
                  ['Change of mind', t.freeReturns || t.changeOfMindPaidBy === 'seller' ? 'You pay return shipping (free returns)' : 'Customer pays return shipping'],
                  ['Defective, damaged, wrong item', defectPaidBy === 'seller' ? 'You pay return shipping' : 'Customer pays return shipping'],
                  ['Response target', `Within ${t.responseTargetBusinessDays} business day${t.responseTargetBusinessDays === 1 ? '' : 's'}`],
                  ['Refund target', `Within ${t.refundTargetDays} day${t.refundTargetDays === 1 ? '' : 's'} of receipt`],
                ]}
              />
            ) : (
              !terms.isError && (
                <div className="stack gap-2" aria-hidden="true">
                  {sk}
                  {sk}
                  {sk}
                </div>
              )
            )}
            <p className="xs muted">Customers see these terms before they buy. Orders keep the terms accepted at purchase.</p>
          </Card>
        </div>
      </div>
    </SellerLayout>
  );
}
