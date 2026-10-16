import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useEffect, useRef, useState } from 'react';
import { Link, useNavigate, useSearchParams } from 'react-router';
import { call, errorMessage, newIdempotencyKey, useApi, useUploads } from '@marketly/web-shared/api';
import { OpsLayout } from '@marketly/web-shared/layouts';
import { cx } from '@marketly/web-shared/lib/cx';
import { formatMoney, type MoneyValue } from '@marketly/web-shared/lib/format';
import { useView } from '@marketly/web-shared/lib/hooks';
import { href } from '@marketly/web-shared/routes';
import { Alert, Breadcrumbs, Button, Card, Checkbox, Deadline, EmptyState, Field, Icon, Img, KeyValue, OptionCard, PageHeader, Stat, StatusBadge, SummaryRow, TableWrap, Tabs, Textarea, TextInput, Timeline, announce, type TimelineEvent } from '@marketly/web-shared/ui';
import { LoadError, SkeletonLines, dateTime, deadlineLabel, deadlineTone, shortDate } from '@/app/parts';
import { useStaffSession } from '@/app/session';
import { ExportButton, ExportNotice } from '@/pages/admin/data/export-button';
import { useDatasetExport } from '@/pages/admin/data/report-export';
import { CONDITIONS, OUTCOMES, outcomeDisabled, stockMovement, type Grade, type Outcome } from './data/returns';
import { BeforeAfter, EDGE_RISK, EDGE_URGENT, EmptyRow, OpsLegend, SkeletonRows } from './data/shared';

// Design: pages/ops/ops-return-inspection.html (queue) · view "inspecting-<return ref>" (design: inspecting-rt-261005-0212)
// = the inspection bench for one return.
// API: GET returns/inspections (tab received | arriving | decided), GET returns/inspections/stats,
// POST returns/requests/{id}/start-inspection, GET returns/requests/{id} (ReturnCase: checklist, draft, payment, timeline),
// PUT returns/requests/{id}/inspection-draft, POST returns/requests/{id}/inspection, POST returns/requests/{id}/remedy
// (idempotent; Returns Manager decides the refund, which then waits for Finance approval).

type Tab = 'received' | 'arriving' | 'decided';

interface QueueRow {
  returnId: string;
  ref: string;
  orderRef: string;
  item: { title: string; sku: string; imageUrl: string | null; quantity: number };
  reason: string;
  receivedAt: string | null;
  expectedAt: string | null;
  inspector: { name?: string | null } | null;
  status: string;
  target: { dueAt: string; state: string } | null;
}
interface Stats {
  waiting: number;
  overdue: number;
  overdueRef: string | null;
  arrivingThisWeek: number;
  refundsWithFinance: number;
  refundsWithFinanceAmount: MoneyValue;
  tabCounts: { received: number; arriving: number; decidedThisWeek: number };
}
interface ChecklistItem {
  key: string;
  kind: 'contents' | 'serial' | 'functional' | 'hygiene' | 'condition';
  label: string;
  required: boolean;
}
interface ReturnCase {
  detail: {
    id: string;
    ref: string;
    orderRef: string;
    status: string;
    statusLabel: string;
    items: Array<{ title: string; sku: string; imageUrl: string | null; quantity: number; unitPrice: MoneyValue }>;
    reason: string;
    details: string | null;
    timeline: Array<{ at: string; label: string; detail?: string | null }>;
    refund: { status?: string; amount?: MoneyValue } | null;
  };
  customer: { displayName: string };
  payment: { itemPaid: MoneyValue; shippingPaid: MoneyValue; maxRefundable: MoneyValue; refundedSoFar: MoneyValue; methodLabel: string };
  inspection: { inspectedBy?: { name?: string | null }; grade: Grade; proposedStockOutcome: Outcome; notes: string | null; media: Array<{ url: string }> } | null;
  refundRequest: { status?: string; amount?: MoneyValue; approverLabel?: string | null } | null;
  inspectionChecklist: { items: ChecklistItem[] } | null;
  inspectionDraft: { inspection: Partial<DraftInput>; savedAt: string } | null;
  inspector: { name?: string | null } | null;
  deadlines: { inspectBy?: { dueAt: string; state: string } | null };
}
interface DraftInput {
  grade: Grade;
  checks: Array<{ key?: string; label: string; passed: boolean }>;
  missingParts: string[];
  notes: string;
  mediaIds: string[];
  proposedStockOutcome: Outcome;
}

const benchView = (ref: string) => `inspecting-${ref.toLowerCase()}`;
const usd = (amount: number): MoneyValue => ({ amount, currency: 'USD' });
const isUrgent = (r: QueueRow) => deadlineTone(r.target?.state) === 'danger';
const isRisk = (r: QueueRow) => deadlineTone(r.target?.state) === 'warning';

/* ---------------- Queue ---------------- */

function Queue() {
  const { api } = useApi();
  const qc = useQueryClient();
  const navigate = useNavigate();
  const staff = useStaffSession();
  const [tab, setTab] = useState<Tab>('received');
  const canInspect = staff.can('returns.inspections.record');
  const inspectionsExport = useDatasetExport('returns.admin.inspections');
  const list = useQuery({ queryKey: ['returns', 'inspections', tab], queryFn: () => call(api.GET('/api/admin/returns/inspections', { params: { query: { tab, limit: 100 } } })) as Promise<{ items: QueueRow[] }> });
  const stats = useQuery({ queryKey: ['returns', 'inspections', 'stats'], queryFn: () => call(api.GET('/api/admin/returns/inspections/stats')) as Promise<Stats> });
  const start = useMutation({
    mutationFn: (r: QueueRow) => call(api.POST('/api/admin/returns/requests/{id}/start-inspection', { params: { path: { id: r.returnId } }, body: {} })),
    onSuccess: (_x, r) => {
      void qc.invalidateQueries({ queryKey: ['returns'] });
      void navigate(href('ops/return-inspection', benchView(r.ref)));
    },
  });

  const rows = list.data?.items ?? [];
  const st = stats.data;
  const legend = [...(rows.some(isUrgent) ? [{ tone: 'danger' as const, label: EDGE_URGENT }] : []), ...(rows.some(isRisk) ? [{ tone: 'warning' as const, label: EDGE_RISK }] : [])];
  const target = (r: QueueRow) =>
    r.target ? <Deadline tone={deadlineTone(r.target.state)}>{deadlineLabel(r.target.dueAt, 'Inspect by')}</Deadline> : <Deadline tone="ok">{tab === 'arriving' ? 'Not received' : r.status}</Deadline>;
  const received = (r: QueueRow) => (r.receivedAt ? shortDate(r.receivedAt) : r.expectedAt ? `Arriving ${shortDate(r.expectedAt)}` : '—');

  const action = (r: QueueRow) => {
    if (tab !== 'received') return null;
    const cont = !!r.inspector;
    if (!canInspect)
      return (
        <Link className="btn btn-sm btn-ghost" to={href('ops/return-inspection', benchView(r.ref))}>
          <span>View</span>
          <span className="sr-only"> {r.ref}</span>
        </Link>
      );
    return (
      <button type="button" className={cx('btn btn-sm', cont ? 'btn-primary' : 'btn-secondary')} onClick={() => start.mutate(r)} disabled={start.isPending}>
        <span>{cont ? 'Continue' : 'Inspect'}</span>
        <span className="sr-only"> {r.ref}</span>
      </button>
    );
  };
  const refLink = (r: QueueRow) =>
    tab === 'arriving' ? (
      <span className="mono nowrap" title={r.ref}>
        {r.ref}
      </span>
    ) : (
      <Link className="mono nowrap" to={href('ops/return-inspection', benchView(r.ref))} title={r.ref}>
        {r.ref}
      </Link>
    );

  return (
    <>
      <PageHeader
        title="Return inspection"
        sub="Official Store returns received at Reno, NV. Warehouse inspects, Inventory records the stock outcome, Finance approves the refund."
        actions={
          staff.can('reports.exports.create') && staff.can('returns.inspections.record') ? <ExportButton exp={inspectionsExport} filters={{ tab }} /> : undefined
        }
      />
      <ExportNotice exp={inspectionsExport} />
      {start.error && <Alert tone="danger">{errorMessage(start.error)}</Alert>}
      {stats.error ? (
        <LoadError error={stats.error} onRetry={() => void stats.refetch()} />
      ) : (
        <div className="ac-kpis">
          <div className="card pad">{st ? <Stat label="Waiting for inspection" value={String(st.waiting)} note="target 2 business days" /> : <span className="sk sk-line" />}</div>
          <div className="card pad">{st ? <Stat label="Overdue" value={String(st.overdue)} note={st.overdueRef ?? 'none'} /> : <span className="sk sk-line" />}</div>
          <div className="card pad">{st ? <Stat label="Arriving this week" value={String(st.arrivingThisWeek)} note="tracked separately from deliveries" /> : <span className="sk sk-line" />}</div>
          <div className="card pad">{st ? <Stat label="Refunds with Finance" value={String(st.refundsWithFinance)} note={`${formatMoney(st.refundsWithFinanceAmount)} proposed`} /> : <span className="sk sk-line" />}</div>
        </div>
      )}
      <Tabs
        items={[
          { label: 'Received', value: 'received', count: st?.tabCounts.received },
          { label: 'Arriving', value: 'arriving', count: st?.tabCounts.arriving },
          { label: 'Decided this week', value: 'decided', count: st?.tabCounts.decidedThisWeek },
        ]}
        active={tab}
        onChange={setTab}
      />
      <Card title="Return queue" flush>
        {list.error ? (
          <div className="card-body">
            <LoadError error={list.error} onRetry={() => void list.refetch()} />
          </div>
        ) : (
          <>
            <div className="no-phone">
              <TableWrap label="Return queue table">
                <table className="table">
                  <thead>
                    <tr>
                      <th scope="col">Return</th>
                      <th scope="col">Item</th>
                      <th scope="col">Reason</th>
                      <th scope="col">Received</th>
                      <th scope="col">Inspector</th>
                      <th scope="col">Status</th>
                      <th scope="col">Target</th>
                      <th className="col-pin" scope="col">
                        <span className="sr-only">Actions</span>
                      </th>
                    </tr>
                  </thead>
                  <tbody>
                    {list.isPending && <SkeletonRows cols={8} />}
                    {!list.isPending && !rows.length && <EmptyRow cols={8}>{tab === 'received' ? 'No returns are waiting at the inspection bench.' : tab === 'arriving' ? 'No returns on the way.' : 'No inspections decided this week.'}</EmptyRow>}
                    {rows.map((r) => (
                      <tr key={r.returnId} className={cx(isUrgent(r) && 'is-flagged', isRisk(r) && 'is-warn')}>
                        <td>
                          {isUrgent(r) && <span className="sr-only">Urgent: </span>}
                          {isRisk(r) && <span className="sr-only">At risk: </span>}
                          <span className="stack gap-0">
                            {refLink(r)}
                            <span className="xs mono muted nowrap" title={r.orderRef}>
                              {r.orderRef}
                            </span>
                          </span>
                        </td>
                        <td>
                          <div className="cell-main">
                            <Img icon="package" src={r.item.imageUrl ?? undefined} className="tiny" />
                            <span className="small">{r.item.title}</span>
                          </div>
                        </td>
                        <td>
                          <span className="small">{r.reason}</span>
                        </td>
                        <td>
                          <span className="small nowrap">{received(r)}</span>
                        </td>
                        <td>
                          <span className="small nowrap">{r.inspector?.name ?? (tab === 'arriving' ? '—' : 'Unassigned')}</span>
                        </td>
                        <td>
                          <StatusBadge status={r.status} />
                        </td>
                        <td>{target(r)}</td>
                        <td className="col-pin">{action(r)}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </TableWrap>
              {legend.length > 0 && <OpsLegend items={legend} />}
            </div>
            <div className="ac-mlist only-phone">
              {list.isPending && <SkeletonLines rows={3} />}
              {rows.map((r) => (
                <div key={r.returnId} className={cx('ac-mi', isUrgent(r) && 'is-flagged', isRisk(r) && 'is-warn')}>
                  {isUrgent(r) && <span className="sr-only">Urgent: </span>}
                  {isRisk(r) && <span className="sr-only">At risk: </span>}
                  <div className="row between gap-2 nowrap top">
                    <span className="small strong min-w-0">{refLink(r)}</span>
                    <StatusBadge status={r.status} />
                  </div>
                  <div className="xs sub">{r.item.title}</div>
                  <div className="xs sub">
                    {r.reason} · received {received(r)}
                  </div>
                  <div className="xs sub">{target(r)}</div>
                </div>
              ))}
              {!list.isPending && !rows.length && <div className="ac-mi xs sub">Nothing in this tab.</div>}
            </div>
            {legend.length > 0 && <OpsLegend className="only-phone" items={legend} />}
          </>
        )}
      </Card>
    </>
  );
}

/* ---------------- Inspection bench ---------------- */

function Bench({ returnId }: { returnId: string }) {
  const { api } = useApi();
  const qc = useQueryClient();
  const staff = useStaffSession();
  const canInspect = staff.can('returns.inspections.record');
  const canDecide = staff.can('returns.requests.manage');
  const rc = useQuery({ queryKey: ['returns', 'case', returnId], queryFn: () => call(api.GET('/api/admin/returns/requests/{id}', { params: { path: { id: returnId } } })) as Promise<ReturnCase> });
  const c = rc.data;
  const photos = useUploads('inspection_photo', { max: 10, accept: /^image\// });
  const fileRef = useRef<HTMLInputElement>(null);
  const remedyKey = useRef(newIdempotencyKey());

  const [grade, setGrade] = useState<Grade | ''>('');
  const [checks, setChecks] = useState<Record<string, boolean>>({});
  const [outcome, setOutcome] = useState<Outcome | ''>('');
  const [why, setWhy] = useState('');
  const [deduction, setDeduction] = useState('');
  const [savedIds, setSavedIds] = useState<string[]>([]);
  const [tried, setTried] = useState(false);
  const [saved, setSaved] = useState(false);
  const loaded = useRef(false);

  useEffect(() => {
    if (!c || loaded.current) return;
    loaded.current = true;
    const d = c.inspectionDraft?.inspection;
    if (d) {
      setGrade(d.grade ?? '');
      setOutcome(d.proposedStockOutcome ?? '');
      setWhy(d.notes ?? '');
      setSavedIds(d.mediaIds ?? []);
      setChecks(Object.fromEntries((d.checks ?? []).map((k) => [k.key ?? k.label, k.passed])));
    }
  }, [c]);

  const items = c?.inspectionChecklist?.items ?? [];
  const isChecked = (k: ChecklistItem) => checks[k.key] ?? false;
  const missing = items.filter((k) => k.kind === 'contents' && !isChecked(k));
  const failed = items.filter((k) => k.kind !== 'contents' && !isChecked(k));
  const deductionMinor = Math.round((Number(deduction) || 0) * 100);
  const maxRefundable = c?.payment.maxRefundable.amount ?? 0;
  const refund = Math.max(0, maxRefundable - deductionMinor);
  const move = stockMovement(outcome, grade);
  const mediaIds = [...savedIds, ...photos.assetIds];
  const done = !!c?.inspection;
  const disabled = done || !canInspect;

  const errors = {
    photos: mediaIds.length === 0 ? 'Add at least one photo of the returned item.' : '',
    condition: !grade ? 'Choose the condition of the item.' : '',
    outcome: !outcome ? 'Propose an outcome for the Returns Manager.' : '',
    why: deductionMinor > 0 && !why.trim() ? 'Explain the deduction. The customer sees this reason.' : deductionMinor > maxRefundable ? 'The deduction can’t be more than the refundable amount.' : '',
  };
  const shown = tried ? errors : { photos: '', condition: '', outcome: '', why: '' };
  const nErrors = Object.values(errors).filter(Boolean).length;

  const input = (): DraftInput => ({
    grade: grade as Grade,
    checks: items.map((k) => ({ key: k.key, label: k.label, passed: isChecked(k) })),
    missingParts: missing.map((k) => k.label),
    notes: why.trim(),
    mediaIds,
    proposedStockOutcome: outcome as Outcome,
  });
  const refresh = () => {
    void qc.invalidateQueries({ queryKey: ['returns'] });
    void qc.invalidateQueries({ queryKey: ['workqueues', 'queues'] });
  };

  const saveDraft = useMutation({
    mutationFn: () => call(api.PUT('/api/admin/returns/requests/{id}/inspection-draft', { params: { path: { id: returnId } }, body: { inspection: input() } as never })),
    onSuccess: () => {
      setSaved(true);
      announce('Inspection saved');
    },
  });
  const send = useMutation({
    mutationFn: async () => {
      const i = input();
      await call(
        api.POST('/api/admin/returns/requests/{id}/inspection', {
          params: { path: { id: returnId } },
          body: { ...i, conditionOutcome: i.missingParts.length ? 'missing_parts' : 'as_described', regradeCondition: outcome === 'different_condition' ? (grade === 'good' ? 'Used – Good' : 'Used – Like new') : undefined } as never,
        }),
      );
      if (!canDecide) return false;
      await call(
        api.POST('/api/admin/returns/requests/{id}/remedy', {
          params: { path: { id: returnId }, header: { 'Idempotency-Key': remedyKey.current } },
          body: (deductionMinor > 0
            ? { kind: 'partial_refund', amount: usd(refund), deductions: [{ label: missing.length ? `Missing ${missing.map((m) => m.label).join(', ')}` : 'Deduction', amount: usd(deductionMinor), reason: why.trim() }], explanation: why.trim() }
            : { kind: 'full_refund' }) as never,
        } as never),
      );
      return true;
    },
    onSuccess: (decided) => {
      announce(decided ? `Inspection sent to Finance. Proposed refund ${formatMoney(usd(refund))}` : 'Inspection recorded. The Returns Manager decides the refund.');
      refresh();
    },
  });

  if (rc.isPending) {
    return (
      <>
        <div className="page-head">
          <div className="t">
            <Breadcrumbs items={[{ label: 'Return inspection', to: href('ops/return-inspection') }, { label: 'Loading' }]} />
            <h1 className="h1">Inspecting</h1>
          </div>
        </div>
        <SkeletonLines rows={6} />
      </>
    );
  }
  if (rc.error || !c) return <LoadError error={rc.error} onRetry={() => void rc.refetch()} />;

  const d = c.detail;
  const item = d.items[0];
  const inspector = c.inspector?.name ?? c.inspection?.inspectedBy?.name ?? staff.name;
  const refundState = c.refundRequest ?? d.refund;
  const events: TimelineEvent[] = [
    ...d.timeline.map((e) => ({ t: e.label, d: dateTime(e.at), state: 'done' as const, body: e.detail ?? undefined })),
    { t: 'Inspection', d: `${done ? 'Done' : 'Today'} · ${inspector}`, state: done ? 'done' : 'current' },
    { t: 'Refund decision', d: 'Returns Manager, then Finance', state: refundState ? 'current' : '' },
  ];

  return (
    <>
      <div className="page-head">
        <div className="t">
          <Breadcrumbs items={[{ label: 'Return inspection', to: href('ops/return-inspection') }, { label: d.ref }]} />
          <h1 className="h1">Inspecting {d.ref}</h1>
          <p className="sub small">
            Order {d.orderRef} · {item?.title} · reason: {d.reason} · inspector {inspector}
          </p>
        </div>
        <div className="actions">
          <StatusBadge status={done ? 'Decision made' : d.statusLabel} />
        </div>
      </div>
      {done && (
        <Alert tone="success" title={refundState?.amount ? `Sent to Finance: ${formatMoney(refundState.amount)} proposed refund` : 'Inspection recorded'}>
          {refundState ? 'Finance approves the refund. The customer sees "Refund under review" until then.' : 'The Returns Manager decides the refund next.'} <Link to={href('ops/return-inspection')}>Back to the return queue</Link>
        </Alert>
      )}
      {send.error && <Alert tone="danger">{errorMessage(send.error)}</Alert>}
      {tried && nErrors > 0 && !done && (
        <Alert tone="danger" title={`Finish ${nErrors} step${nErrors > 1 ? 's' : ''} before sending`}>
          {Object.values(errors).filter(Boolean).join(' ')}
        </Alert>
      )}
      <div className="ac-main">
        <div className="stack gap-5">
          <Card title="Photos" sub={`${mediaIds.length + (c.inspection?.media.length ?? 0)} taken at the inspection bench`}>
            {(c.inspection?.media.length || photos.items.length || savedIds.length > 0) && (
              <div className="ac-photos">
                {c.inspection?.media.map((m, k) => (
                  <div key={m.url} className="ac-photo">
                    <Img icon="image" src={m.url} />
                    <span className="xs muted">Photo {k + 1}</span>
                  </div>
                ))}
                {savedIds.map((id, k) => (
                  <div key={id} className="ac-photo">
                    <Img icon="image" />
                    <span className="xs muted">Saved photo {k + 1}</span>
                  </div>
                ))}
                {photos.items.map((p) => (
                  <div key={p.key} className="ac-photo">
                    <Img icon="image" src={p.url} />
                    <span className={cx('xs', p.status === 'failed' ? 't-danger-text' : 'muted')}>{p.status === 'uploading' ? 'Uploading…' : p.status === 'failed' ? (p.error ?? 'Upload failed') : p.name}</span>
                  </div>
                ))}
              </div>
            )}
            {!disabled && (
              <div
                className="dropzone"
                onDragOver={(e) => e.preventDefault()}
                onDrop={(e) => {
                  e.preventDefault();
                  photos.add(Array.from(e.dataTransfer.files));
                }}
              >
                <Icon name="image-plus" className="ic-lg" />
                <span className="small strong u-c-text">Add more photos</span>
                <span className="xs">JPG or PNG from the bench camera</span>
                <input
                  ref={fileRef}
                  type="file"
                  hidden
                  accept="image/jpeg,image/png"
                  multiple
                  onChange={(e) => {
                    photos.add(Array.from(e.target.files ?? []));
                    e.target.value = '';
                  }}
                />
                <Button variant="secondary" size="sm" onClick={() => fileRef.current?.click()}>
                  Browse files
                </Button>
              </div>
            )}
            {photos.error && <span className="xs t-danger-text">{photos.error}</span>}
            {shown.photos && (
              <span className="error-text">
                <Icon name="circle-alert" className="ic-sm" />
                {shown.photos}
              </span>
            )}
          </Card>
          <Card title="Condition" titleAs="h3">
            <div className="grid md2 gap-2" role="radiogroup" aria-label="Condition">
              {CONDITIONS.map((o, k) => (
                <OptionCard
                  key={o.id}
                  id={`rq-c${k + 1}`}
                  name="rq-cond"
                  title={<span className="small strong">{o.title}</span>}
                  body={o.body}
                  checked={(c.inspection?.grade ?? grade) === o.id}
                  disabled={disabled}
                  onChange={() => {
                    setSaved(false);
                    setGrade(o.id);
                    if (outcome && outcomeDisabled(outcome, o.id)) setOutcome('');
                  }}
                />
              ))}
            </div>
            {shown.condition && (
              <span className="error-text">
                <Icon name="circle-alert" className="ic-sm" />
                {shown.condition}
              </span>
            )}
            <span className="small strong">Contents and checks</span>
            {items.length ? (
              <div className="ac-perm">
                {items.map((k, i) => (
                  <Checkbox
                    key={k.key}
                    id={`rq-k${i + 1}`}
                    label={k.label}
                    checked={isChecked(k)}
                    disabled={disabled}
                    onChange={(e) => {
                      setSaved(false);
                      setChecks((x) => ({ ...x, [k.key]: e.target.checked }));
                    }}
                  />
                ))}
              </div>
            ) : (
              <span className="xs muted">The checklist appears once the return is received.</span>
            )}
            {!done &&
              missing.map((k) => (
                <Alert key={k.key} tone="warning" title={`Missing part: ${k.label}`}>
                  The Returns Manager decides whether a deduction applies.
                </Alert>
              ))}
            {!done && grade && failed.length > 0 && (
              <Alert tone="danger" title={`Check not passed: ${failed.map((k) => k.label).join(', ')}`}>
                Record what you found in the photos. Choose Repair, Return to supplier or Write off unless the Returns Manager says otherwise.
              </Alert>
            )}
          </Card>
          <Card title="Outcome" titleAs="h3" sub="Proposed by the inspector, decided by the Returns Manager">
            <div className="stack gap-2" role="radiogroup" aria-label="Outcome">
              {OUTCOMES.map((o, k) => (
                <OptionCard
                  key={o.id}
                  id={`rq-o${k}`}
                  name="rq-out"
                  title={<span className="small strong">{o.title}</span>}
                  body={o.body}
                  checked={(c.inspection?.proposedStockOutcome ?? outcome) === o.id}
                  disabled={disabled || outcomeDisabled(o.id, grade)}
                  onChange={() => {
                    setSaved(false);
                    setOutcome(o.id);
                  }}
                />
              ))}
            </div>
            {shown.outcome && (
              <span className="error-text">
                <Icon name="circle-alert" className="ic-sm" />
                {shown.outcome}
              </span>
            )}
            {move && (
              <div className="well stack gap-2">
                <span className="small strong">Stock outcome, recorded by Inventory</span>
                <KeyValue
                  pairs={[
                    ['Movement', <BeforeAfter b={`Returned · ${item?.quantity ?? 1} unit`} a={move} />],
                    ['SKU', <span className="mono">{item?.sku}</span>],
                    ['Recorded by', `Inventory Manager · ${done ? 'notified' : 'waiting'}`],
                  ]}
                />
              </div>
            )}
          </Card>
        </div>
        <div className="stack gap-5">
          <Card
            title="Proposed refund"
            titleAs="h3"
            sub="Sent to Finance for approval"
            foot={
              canInspect ? (
                <>
                  <Button variant="ghost" size="sm" onClick={() => saveDraft.mutate()} disabled={disabled || saveDraft.isPending}>
                    {saved ? 'Saved' : 'Save inspection'}
                  </Button>
                  <Button
                    size="sm"
                    icon="send"
                    onClick={() => {
                      setTried(true);
                      if (!nErrors && !photos.uploading) send.mutate();
                    }}
                    disabled={disabled || send.isPending}
                  >
                    {done ? 'Sent to Finance' : canDecide ? 'Send to Finance' : 'Record inspection'}
                  </Button>
                </>
              ) : (
                <span className="xs muted">Warehouse staff with inspection access record this.</span>
              )
            }
          >
            {saveDraft.error && <span className="xs t-danger-text">{errorMessage(saveDraft.error)}</span>}
            <SummaryRow k="Item price" v={formatMoney(c.payment.itemPaid)} />
            <SummaryRow k="Original shipping" v={formatMoney(c.payment.shippingPaid)} />
            {c.payment.refundedSoFar.amount > 0 && <SummaryRow k="Refunded so far" v={`−${formatMoney(c.payment.refundedSoFar)}`} />}
            <SummaryRow k="Refundable" v={formatMoney(c.payment.maxRefundable)} />
            {deductionMinor > 0 && <SummaryRow k={missing.length ? `Missing ${missing.map((m) => m.label).join(', ')}` : 'Deduction'} v={`−${formatMoney(usd(deductionMinor))}`} />}
            <div className="divider" />
            <SummaryRow className="total" k="Proposed refund" v={formatMoney(refundState?.amount ?? usd(refund))} />
            {canDecide && !done && (
              <Field label="Deduction" optional hint="For missing parts or damage, per the returns policy">
                <TextInput id="rq-ded" type="number" min={0} prefix="$" value={deduction} onChange={(e) => setDeduction(e.target.value)} />
              </Field>
            )}
            <Field label={canDecide ? 'Reason for deduction' : 'Inspection notes'} error={shown.why || undefined}>
              <Textarea id="rq-why" value={c.inspection?.notes ?? why} disabled={disabled} onChange={(e) => setWhy(e.target.value)} />
            </Field>
            <div className="panel xs sub stack gap-1">
              <span>
                <Icon name="landmark" className="ic-sm" /> {c.refundRequest?.approverLabel ? `Finance approver: ${c.refundRequest.approverLabel}` : 'Finance approves the refund within its approval limits'}
              </span>
              <span>Refund to {c.payment.methodLabel} within 5 business days after approval.</span>
            </div>
            <Alert tone="info" title="Approved is not paid">
              The customer sees "Refund under review" now, "Approved" after Finance, and "Sent" only when the payment provider confirms.
            </Alert>
          </Card>
          <Card title="Return record" titleAs="h3">
            <Timeline events={events} />
          </Card>
        </div>
      </div>
    </>
  );
}

/** Resolves the return ref in the URL (inspecting-<ref>, or ?view=inspecting&rt=<ref>) to its id from the queue lists. */
function BenchByRef({ refNo }: { refNo: string }) {
  const { api } = useApi();
  const found = useQuery({
    queryKey: ['returns', 'inspections', 'find', refNo],
    queryFn: async () => {
      for (const tab of ['received', 'decided'] as const) {
        const r = (await call(api.GET('/api/admin/returns/inspections', { params: { query: { tab, limit: 100 } } }))) as { items: QueueRow[] };
        const hit = r.items.find((x) => x.ref.toLowerCase() === refNo.toLowerCase());
        if (hit) return hit.returnId;
      }
      return null;
    },
  });
  if (found.isPending) return <SkeletonLines rows={6} />;
  if (found.error)
    return (
      <>
        <h1 className="sr-only">Return inspection</h1>
        <LoadError error={found.error} onRetry={() => void found.refetch()} />
      </>
    );
  if (!found.data) {
    return (
      <>
        <h1 className="sr-only">Return inspection</h1>
        <EmptyState icon="rotate-ccw" title={`${refNo.toUpperCase()} is not at the inspection bench`} as="h2" action={<Button to={href('ops/return-inspection')}>Back to the return queue</Button>}>
          It has not been received yet, or the return number is wrong.
        </EmptyState>
      </>
    );
  }
  return <Bench key={found.data} returnId={found.data} />;
}

export default function ReturnInspection() {
  const [view] = useView();
  const [params] = useSearchParams();
  const ref = view === 'inspecting' ? (params.get('rt') ?? '') : view.startsWith('inspecting-') ? view.slice('inspecting-'.length) : '';
  return <OpsLayout active="return-inspection">{ref ? <BenchByRef refNo={ref} /> : <Queue />}</OpsLayout>;
}
