import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Fragment, useEffect, useRef, useState, type FormEvent } from 'react';
import { Link, useNavigate } from 'react-router';
import { call, errorMessage, useApi, useUploads, type UploadItem } from '@marketly/web-shared/api';
import { OpsLayout } from '@marketly/web-shared/layouts';
import { cx } from '@marketly/web-shared/lib/cx';
import { formatMoney, num, type MoneyValue } from '@marketly/web-shared/lib/format';
import { useScrollRegion, useView } from '@marketly/web-shared/lib/hooks';
import { href } from '@marketly/web-shared/routes';
import { Alert, Badge, Breadcrumbs, Button, Card, Checkbox, EmptyState, Field, Icon, Img, KeyValue, PageHeader, Stat, StatusBadge, SummaryRow, TableWrap, Tabs, Textarea, TextInput, announce, type Tone } from '@marketly/web-shared/ui';
import { LoadError, SkeletonLines, dateTime, shortDate, time, dayKey } from '@/app/parts';
import { useStaffSession } from '@/app/session';
import { EDGE_RISK, EDGE_URGENT, EmptyRow, OpsLegend, SkeletonRows } from './data/shared';

// Design: pages/ops/ops-receiving.html (Expected list) · view "receiving-<po ref>" (design: receiving-pur-2610-0042) =
// receiving one purchase order's delivery.
// API: GET purchasing/deliveries, GET purchasing/deliveries/stats, POST purchasing/deliveries/{id}/arrive (check in),
// POST purchasing/deliveries/{id}/receipts (start receiving), GET/PATCH purchasing/receipts/{id}, POST receipts/{id}/submit,
// GET inventory/inbound + POST inventory/inbound/{id}/confirm (Inventory Manager makes the units sellable).

type Tab = 'expected' | 'receiving' | 'issues' | 'completed';
type DeliveryStatus = 'expected' | 'delayed' | 'arrived' | 'receiving' | 'received' | 'received_with_issues' | 'cancelled';

interface Delivery {
  id: string;
  purchaseOrderId: string;
  purchaseOrderRef: string;
  supplierName: string;
  carrier: string | null;
  trackingRef: string | null;
  windowFrom: string;
  windowTo: string;
  lineCount: number;
  units: number;
  status: DeliveryStatus;
  delayReason: string | null;
  arrivedAt: string | null;
  dock: string | null;
  receiptId: string | null;
}
interface Stats {
  expectedToday: number;
  expectedTodayUnits: number;
  arrivedNotReceived: number;
  arrivedNote: string | null;
  receivedThisWeek: number;
  receivedThisWeekUnits: number;
  openShortages: number;
  shortageOwner: { name?: string | null } | null;
  tabCounts: { expected: number; receiving: number; receivedWithIssues: number; completed: number };
}
interface MediaRef {
  id: string;
  url: string;
  alt?: string | null;
}
interface ReceiptLine {
  purchaseOrderLineId: string;
  stockItemId: string;
  sku: string;
  label: string;
  image: MediaRef | null;
  expected: number;
  received: number;
  damaged: number;
  binCode: string | null;
  photos: MediaRef[];
}
interface Receipt {
  id: string;
  ref: string;
  purchaseOrderRef: string;
  deliveryId: string;
  supplierName: string;
  status: 'in_progress' | 'awaiting_confirmation' | 'confirmed' | 'cancelled';
  lines: ReceiptLine[];
  totals: { expected: number; received: number; damaged: number; shortage: number; sellable: number | null };
  buyingCost: MoneyValue | null;
  note: string | null;
  receivedBy: { name?: string | null } | null;
  startedAt: string;
  confirmedBy: { name?: string | null } | null;
}
interface Inbound {
  id: string;
  receiptId: string;
  state: 'awaiting_confirmation' | 'confirmed';
}

const STATUS: Record<DeliveryStatus, { label: string; tone: Tone }> = {
  expected: { label: 'Incoming', tone: '' },
  delayed: { label: 'Delayed', tone: 'warning' },
  arrived: { label: 'Arrived', tone: 'info' },
  receiving: { label: 'Receiving', tone: 'info' },
  received: { label: 'Completed', tone: 'success' },
  received_with_issues: { label: 'Received with issues', tone: 'warning' },
  cancelled: { label: 'Cancelled', tone: '' },
};
const TAB_STATUSES: Record<Tab, DeliveryStatus[]> = {
  // The Expected tab lists every open delivery, the design's default table.
  expected: ['arrived', 'receiving', 'expected', 'delayed', 'received_with_issues'],
  receiving: ['arrived', 'receiving'],
  issues: ['received_with_issues'],
  completed: ['received'],
};

const STEPS = ['Check in', 'Count lines', 'Record issues', 'Put away', 'Make available'];
const viewFor = (ref: string) => `receiving-${ref.toLowerCase()}`;

const windowLabel = (d: Delivery) => {
  const today = dayKey(new Date());
  const day = dayKey(d.windowFrom) === today ? 'Today' : shortDate(d.windowFrom);
  return `${day}, ${time(d.windowFrom)} – ${time(d.windowTo)}`;
};
const statusLabel = (d: Delivery) => (d.status === 'arrived' && d.dock ? `Arrived, dock ${d.dock}` : STATUS[d.status].label);

/** Progress steps with the design's "Step n of m" screen-reader text on the current step. */
function ReceivingSteps({ current }: { current: number }) {
  const ref = useScrollRegion<HTMLOListElement>();
  return (
    <ol className="steps" aria-label="Progress" ref={ref} data-scroll-region="">
      {STEPS.map((s, i) => (
        <Fragment key={s}>
          {i > 0 && <li className="bar" aria-hidden="true" />}
          <li className={cx('step', i < current && 'is-done', i === current && 'is-current')} aria-current={i === current ? 'step' : undefined}>
            {i < current && <span className="sr-only">Completed: </span>}
            <span className="n">{i < current ? <Icon name="check" className="ic-sm" /> : i + 1}</span>
            {i === current && <span className="sr-only">{`Step ${i + 1} of ${STEPS.length}: `}</span>}
            {s}
          </li>
        </Fragment>
      ))}
    </ol>
  );
}

function useDeliveries() {
  const { api } = useApi();
  return useQuery({ queryKey: ['purchasing', 'deliveries'], queryFn: () => call(api.GET('/api/admin/purchasing/deliveries', { params: { query: { limit: 100 } } })) as Promise<{ items: Delivery[] }> });
}

function DeliveryList({ notice }: { notice: string }) {
  const { api } = useApi();
  const qc = useQueryClient();
  const navigate = useNavigate();
  const staff = useStaffSession();
  const [tab, setTab] = useState<Tab>('expected');
  const deliveries = useDeliveries();
  const stats = useQuery({ queryKey: ['purchasing', 'deliveries', 'stats'], queryFn: () => call(api.GET('/api/admin/purchasing/deliveries/stats', { params: { query: {} } })) as Promise<Stats> });
  const canRecord = staff.can('purchasing.receipts.record');

  const all = (deliveries.data?.items ?? []).filter((d) => d.status !== 'cancelled');
  const rows = all.filter((d) => TAB_STATUSES[tab].includes(d.status));
  const delayed = all.filter((d) => d.status === 'delayed');
  const st = stats.data;
  const subs: Record<Tab, string> = {
    expected: 'Expected arrivals from Purchasing',
    receiving: 'Deliveries being counted at the dock',
    issues: 'Shortages and damage waiting on Purchasing',
    completed: 'Received and made available',
  };

  const arrive = useMutation({
    mutationFn: (d: Delivery) => call(api.POST('/api/admin/purchasing/deliveries/{id}/arrive', { params: { path: { id: d.id } }, body: {} })),
    onSuccess: (_r, d) => {
      announce(`${d.purchaseOrderRef} checked in`);
      void qc.invalidateQueries({ queryKey: ['purchasing'] });
    },
  });
  const start = useMutation({
    mutationFn: (d: Delivery) => (d.receiptId ? Promise.resolve(null) : call(api.POST('/api/admin/purchasing/deliveries/{id}/receipts', { params: { path: { id: d.id } } }))),
    onSuccess: (_r, d) => {
      void qc.invalidateQueries({ queryKey: ['purchasing'] });
      void navigate(href('ops/receiving', viewFor(d.purchaseOrderRef)));
    },
  });
  const actionError = arrive.error ?? start.error;

  const poLink = (d: Delivery, cls = 'mono nowrap') =>
    d.receiptId || d.status === 'arrived' ? (
      <Link className={cls} to={href('ops/receiving', viewFor(d.purchaseOrderRef))} title={d.purchaseOrderRef}>
        {d.purchaseOrderRef}
      </Link>
    ) : (
      <span className={cls} title={d.purchaseOrderRef}>
        {d.purchaseOrderRef}
      </span>
    );
  const action = (d: Delivery) => {
    if (d.status === 'arrived' || (d.status === 'receiving' && d.receiptId)) {
      return canRecord ? (
        <button type="button" className="btn btn-primary btn-sm" onClick={() => start.mutate(d)} disabled={start.isPending}>
          <span>{d.status === 'receiving' ? 'Continue receiving' : 'Start receiving'}</span>
          <span className="sr-only"> {d.purchaseOrderRef}</span>
        </button>
      ) : (
        <Link className="btn btn-ghost btn-sm" to={href('ops/receiving', viewFor(d.purchaseOrderRef))}>
          <span>View</span>
          <span className="sr-only"> {d.purchaseOrderRef}</span>
        </Link>
      );
    }
    if ((d.status === 'expected' || d.status === 'delayed') && canRecord) {
      return (
        <button type="button" className="btn btn-ghost btn-sm" onClick={() => arrive.mutate(d)} disabled={arrive.isPending}>
          <span>Check in</span>
          <span className="sr-only"> {d.purchaseOrderRef}</span>
        </button>
      );
    }
    if (d.receiptId) {
      return (
        <Link className="btn btn-ghost btn-sm" to={href('ops/receiving', viewFor(d.purchaseOrderRef))}>
          <span>View</span>
          <span className="sr-only"> {d.purchaseOrderRef}</span>
        </Link>
      );
    }
    return null;
  };
  const late = (d: Delivery) => d.status === 'delayed' || d.status === 'received_with_issues';
  const carrierLabel = (d: Delivery) => [d.carrier, d.trackingRef].filter(Boolean).join(' · ') || '—';

  return (
    <>
      <PageHeader
        title="Receiving"
        sub="Inbound purchase deliveries · Reno, NV · Purchasing orders, Warehouse receives, Inventory confirms what can be sold"
        actions={
          <Button variant="secondary" size="sm" icon="download" disabled title="Receiving exports aren’t available yet">
            Export
          </Button>
        }
      />
      {notice && <Alert tone="success" title={notice} />}
      {actionError && <Alert tone="danger">{errorMessage(actionError)}</Alert>}
      {stats.error ? (
        <LoadError error={stats.error} onRetry={() => void stats.refetch()} />
      ) : (
        <div className="ac-kpis">
          <div className="card pad">{st ? <Stat label="Expected today" value={String(st.expectedToday)} note={`${num(st.expectedTodayUnits)} units`} /> : <span className="sk sk-line" />}</div>
          <div className="card pad">{st ? <Stat label="Arrived, not received" value={String(st.arrivedNotReceived)} note={st.arrivedNote ?? 'Dock clear'} /> : <span className="sk sk-line" />}</div>
          <div className="card pad">{st ? <Stat label="Received this week" value={String(st.receivedThisWeek)} note={`${num(st.receivedThisWeekUnits)} units`} /> : <span className="sk sk-line" />}</div>
          <div className="card pad">{st ? <Stat label="Open shortages" value={String(st.openShortages)} note={st.shortageOwner?.name ? `with ${st.shortageOwner.name}` : 'None waiting'} /> : <span className="sk sk-line" />}</div>
        </div>
      )}
      <Tabs
        items={[
          { label: 'Expected', value: 'expected', count: st?.tabCounts.expected },
          { label: 'Receiving', value: 'receiving', count: st?.tabCounts.receiving },
          { label: 'Received with issues', value: 'issues', count: st?.tabCounts.receivedWithIssues },
          { label: 'Completed', value: 'completed' },
        ]}
        active={tab}
        onChange={setTab}
      />
      <Card title="Purchase deliveries" sub={subs[tab]} flush>
        {deliveries.error ? (
          <div className="card-body">
            <LoadError error={deliveries.error} onRetry={() => void deliveries.refetch()} />
          </div>
        ) : (
          <>
            <div className="no-phone">
              <TableWrap label="Purchase deliveries table">
                <table className="table">
                  <thead>
                    <tr>
                      <th scope="col">Purchase order</th>
                      <th scope="col">Supplier</th>
                      <th scope="col">Expected</th>
                      <th scope="col">Carrier</th>
                      <th className="r" scope="col">Lines</th>
                      <th className="r" scope="col">Units</th>
                      <th scope="col">Status</th>
                      <th scope="col">
                        <span className="sr-only">Actions</span>
                      </th>
                    </tr>
                  </thead>
                  <tbody>
                    {deliveries.isPending && <SkeletonRows cols={8} />}
                    {!deliveries.isPending && !rows.length && <EmptyRow cols={8}>No purchase deliveries here.</EmptyRow>}
                    {rows.map((d) => (
                      <tr key={d.id} className={cx(late(d) && 'is-warn')}>
                        <td>
                          {late(d) && <span className="sr-only">At risk: </span>}
                          {poLink(d)}
                        </td>
                        <td>
                          <span className="small strong">{d.supplierName}</span>
                        </td>
                        <td>
                          <span className="small nowrap">{d.arrivedAt && d.status !== 'arrived' ? `Received ${shortDate(d.arrivedAt)}` : windowLabel(d)}</span>
                        </td>
                        <td>
                          <span className="xs sub">{carrierLabel(d)}</span>
                        </td>
                        <td className="r">{d.lineCount}</td>
                        <td className="r">{d.units}</td>
                        <td>
                          <StatusBadge status={statusLabel(d)} tone={STATUS[d.status].tone} />
                        </td>
                        <td>{action(d)}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </TableWrap>
              <OpsLegend items={[{ tone: 'warning', label: EDGE_RISK }]} />
            </div>
            <div className="ac-mlist only-phone">
              {deliveries.isPending && <SkeletonLines rows={3} />}
              {!deliveries.isPending && !rows.length && <div className="ac-mi xs sub">No purchase deliveries here.</div>}
              {rows.map((d) => (
                <div key={d.id} className={cx('ac-mi', late(d) && 'is-warn')}>
                  {late(d) && <span className="sr-only">At risk: </span>}
                  <div className="row between gap-2 nowrap top">
                    <span className="small strong min-w-0">{poLink(d)}</span>
                    <StatusBadge status={statusLabel(d)} tone={STATUS[d.status].tone} />
                  </div>
                  <div className="xs sub">
                    {d.supplierName} · {d.lineCount} lines · {d.units} units
                  </div>
                  <div className="xs sub">{windowLabel(d)}</div>
                  <div className="xs sub">{carrierLabel(d)}</div>
                  {action(d) && <div className="row gap-2 mt-1-5">{action(d)}</div>}
                </div>
              ))}
            </div>
            <OpsLegend className="only-phone" items={[{ tone: 'warning', label: EDGE_RISK }]} />
          </>
        )}
      </Card>
      <div className="grid lg2 gap-5">
        {delayed.length > 0 ? (
          <Alert tone="warning" title={`${delayed[0].purchaseOrderRef} running late`}>
            {delayed[0].delayReason ?? 'The delivery window passed without arrival.'} Expected {windowLabel(delayed[0])}. Its units stay in Incoming until then.
            {delayed.length > 1 && ` ${delayed.length - 1} more ${delayed.length === 2 ? 'delivery is' : 'deliveries are'} late.`}
          </Alert>
        ) : (
          <div />
        )}
        <Card title="Who does what" titleAs="h3">
          <KeyValue
            pairs={[
              ['Purchasing', 'Purchasing Manager orders stock and tracks arrival'],
              ['Warehouse', 'Warehouse staff count, record shortages and damage, put away'],
              ['Inventory', 'Inventory Manager confirms the sellable quantity'],
            ]}
          />
        </Card>
      </div>
    </>
  );
}

function LineBadge({ l }: { l: ReceiptLine }) {
  const short = l.expected - l.received;
  if (l.damaged > 0)
    return (
      <Badge tone="danger" icon="circle-alert">
        {l.damaged} damaged
      </Badge>
    );
  if (short > 0)
    return (
      <Badge tone="warning" icon="triangle-alert">
        Short {short}
      </Badge>
    );
  if (short < 0)
    return (
      <Badge tone="warning" icon="triangle-alert">
        Over {-short}
      </Badge>
    );
  return (
    <Badge tone="success" icon="check">
      Matches
    </Badge>
  );
}

/** Damage photos for one line: the photos already on the receipt plus new uploads (inspection_photo). */
function LinePhotos({ line, disabled, onIds }: { line: ReceiptLine; disabled: boolean; onIds: (ids: string[]) => void }) {
  const uploads = useUploads('inspection_photo', { max: 6, accept: /^image\// });
  const input = useRef<HTMLInputElement>(null);
  const ids = [...line.photos.map((p) => p.id), ...uploads.assetIds];
  const key = ids.join(',');
  useEffect(() => onIds(key ? key.split(',') : []), [key]); // eslint-disable-line react-hooks/exhaustive-deps
  const pending: UploadItem[] = uploads.items.filter((i) => i.status !== 'ready' || !i.url);
  return (
    <div className="ac-photos">
      {line.photos.map((p) => (
        <div key={p.id} className="ac-photo">
          <Img icon="image" src={p.url} alt={p.alt ?? ''} />
          <span className="xs muted">Saved</span>
        </div>
      ))}
      {uploads.items
        .filter((i) => i.status === 'ready' && i.url)
        .map((i) => (
          <div key={i.key} className="ac-photo">
            <Img icon="image" src={i.url} alt="" />
            <span className="xs muted">{i.name}</span>
          </div>
        ))}
      {pending.map((i) => (
        <div key={i.key} className="ac-photo">
          <Img icon="image" />
          <span className={cx('xs', i.status === 'failed' ? 't-danger-text' : 'muted')}>{i.status === 'failed' ? (i.error ?? 'Upload failed') : 'Uploading…'}</span>
        </div>
      ))}
      <div className="ac-photo">
        <input ref={input} type="file" accept="image/*" multiple hidden onChange={(e) => uploads.add(Array.from(e.target.files ?? []))} />
        <Button variant="secondary" size="sm" block icon="camera" disabled={disabled} onClick={() => input.current?.click()}>
          Add photo
        </Button>
      </div>
    </div>
  );
}

interface LineDraft {
  received: number;
  damaged: number;
  binCode: string;
  photoIds: string[];
}

function ReceivePo({ poRef, onSaveLater }: { poRef: string; onSaveLater: (ref: string) => void }) {
  const { api } = useApi();
  const qc = useQueryClient();
  const staff = useStaffSession();
  const deliveries = useDeliveries();
  const delivery = deliveries.data?.items.find((d) => d.purchaseOrderRef.toLowerCase() === poRef && d.status !== 'cancelled');
  const receipt = useQuery({
    queryKey: ['purchasing', 'receipt', delivery?.receiptId],
    queryFn: () => call(api.GET('/api/admin/purchasing/receipts/{id}', { params: { path: { id: delivery!.receiptId! } } })) as Promise<Receipt>,
    enabled: !!delivery?.receiptId,
  });
  const r = receipt.data;
  const canRecord = staff.can('purchasing.receipts.record');
  const canConfirm = staff.can('inventory.inbound.confirm');

  const [drafts, setDrafts] = useState<Record<string, LineDraft>>({});
  const [note, setNote] = useState('');
  const [confirmed, setConfirmed] = useState(false);
  const [scan, setScan] = useState('');
  const [scanMsg, setScanMsg] = useState<{ ok: boolean; text: string } | null>(null);
  const [tried, setTried] = useState(false);
  const loadedFor = useRef('');

  useEffect(() => {
    if (!r || loadedFor.current === r.id) return;
    loadedFor.current = r.id;
    setDrafts(Object.fromEntries(r.lines.map((l) => [l.purchaseOrderLineId, { received: l.received, damaged: l.damaged, binCode: l.binCode ?? '', photoIds: l.photos.map((p) => p.id) }])));
    setNote(r.note ?? '');
  }, [r]);

  const editable = !!r && r.status === 'in_progress' && canRecord;
  const lines = (r?.lines ?? []).map((l) => ({ ...l, ...(drafts[l.purchaseOrderLineId] ?? {}) }));
  const setLine = (id: string, patch: Partial<LineDraft>) => setDrafts((d) => ({ ...d, [id]: { ...d[id], ...patch } }));
  const toInt = (v: string) => Math.max(0, Math.floor(Number(v) || 0));

  const expected = lines.reduce((a, l) => a + l.expected, 0);
  const received = lines.reduce((a, l) => a + l.received, 0);
  const damaged = lines.reduce((a, l) => a + Math.min(l.damaged, l.received), 0);
  const shortage = lines.reduce((a, l) => a + Math.max(0, l.expected - l.received), 0);
  const sellable = received - damaged;
  const missingPhotos = lines.filter((l) => l.damaged > 0 && !(drafts[l.purchaseOrderLineId]?.photoIds.length ?? l.photos.length));
  const missingBins = lines.filter((l) => !String(drafts[l.purchaseOrderLineId]?.binCode ?? l.binCode ?? '').trim());
  const canFinish = confirmed && !missingPhotos.length && !missingBins.length && received > 0;

  const patchBody = () => ({
    lines: lines.map((l) => {
      const d = drafts[l.purchaseOrderLineId];
      return { purchaseOrderLineId: l.purchaseOrderLineId, received: l.received, damaged: Math.min(l.damaged, l.received), binCode: (d?.binCode ?? l.binCode ?? '') || undefined, photoIds: d?.photoIds ?? l.photos.map((p) => p.id) };
    }),
    note: note.trim() || undefined,
  });
  const invalidate = () => {
    void qc.invalidateQueries({ queryKey: ['purchasing'] });
    void qc.invalidateQueries({ queryKey: ['inventory'] });
    void qc.invalidateQueries({ queryKey: ['workqueues', 'queues'] });
  };

  const save = useMutation({
    mutationFn: () => call(api.PATCH('/api/admin/purchasing/receipts/{id}', { params: { path: { id: r!.id } }, body: patchBody() as never })),
    onSuccess: () => {
      invalidate();
      onSaveLater(r!.purchaseOrderRef);
    },
  });

  const finish = useMutation({
    mutationFn: async () => {
      let current = r!;
      if (current.status === 'in_progress') {
        await call(api.PATCH('/api/admin/purchasing/receipts/{id}', { params: { path: { id: current.id } }, body: patchBody() as never }));
        current = (await call(api.POST('/api/admin/purchasing/receipts/{id}/submit', { params: { path: { id: current.id } }, body: { raiseClaims: true } as never }))) as Receipt;
      }
      if (!canConfirm) return { confirmed: false };
      const inbound = (await call(api.GET('/api/admin/inventory/inbound', { params: { query: { limit: 100 } as never } }))) as { items: Inbound[] };
      const item = inbound.items.find((i) => i.receiptId === current.id && i.state === 'awaiting_confirmation');
      if (!item) return { confirmed: false };
      await call(
        api.POST('/api/admin/inventory/inbound/{id}/confirm', {
          params: { path: { id: item.id } },
          body: { checked: true, lines: current.lines.map((l) => ({ stockItemId: l.stockItemId, sellable: l.received - Math.min(l.damaged, l.received), damaged: Math.min(l.damaged, l.received) })), note: note.trim() || undefined } as never,
        }),
      );
      return { confirmed: true };
    },
    onSuccess: (res) => {
      announce(res.confirmed ? `${sellable} units available for sale` : 'Receiving submitted. Inventory confirms the sellable units.');
      invalidate();
    },
    onSettled: () => void receipt.refetch(),
  });

  const onScan = (e: FormEvent) => {
    e.preventDefault();
    const code = scan.trim().toUpperCase();
    if (!code) return;
    const l = lines.find((x) => x.sku.toUpperCase() === code);
    if (!l) {
      setScanMsg({ ok: false, text: `${code} is not on ${r?.purchaseOrderRef}. Set the unit aside and tell Purchasing.` });
    } else {
      setLine(l.purchaseOrderLineId, { received: l.received + 1 });
      setScanMsg({ ok: true, text: `${code}: received ${l.received + 1} of ${l.expected}` });
    }
    announce(!l ? `${code} is not on this purchase order` : `${code} counted`);
    setScan('');
  };

  const submit = () => {
    setTried(true);
    if (!canFinish) return;
    finish.mutate();
  };

  if (deliveries.isPending || (delivery?.receiptId && receipt.isPending)) {
    return (
      <>
        <div className="page-head">
          <div className="t">
            <Breadcrumbs items={[{ label: 'Receiving', to: href('ops/receiving') }, { label: poRef.toUpperCase() }]} />
            <h1 className="h1">Receiving {poRef.toUpperCase()}</h1>
          </div>
        </div>
        <SkeletonLines rows={6} />
      </>
    );
  }
  const loadError = deliveries.error ?? receipt.error;
  if (loadError) return <LoadError error={loadError} onRetry={() => void (deliveries.error ? deliveries.refetch() : receipt.refetch())} />;
  if (!delivery || !r) {
    return (
      <>
        <h1 className="sr-only">Receiving {poRef.toUpperCase()}</h1>
        <EmptyState icon="package" title={delivery ? 'Receiving hasn’t started' : 'Delivery not found'} as="h2" action={<Button to={href('ops/receiving')}>Back to Receiving</Button>}>
          {delivery ? `${delivery.purchaseOrderRef} has to be checked in and started from the Receiving list first.` : `There is no open delivery for ${poRef.toUpperCase()}.`}
        </EmptyState>
      </>
    );
  }

  const done = r.status === 'awaiting_confirmation' || r.status === 'confirmed';
  const step = r.status === 'confirmed' ? STEPS.length : r.status === 'awaiting_confirmation' ? 4 : shortage > 0 || damaged > 0 ? 2 : 1;
  const busy = save.isPending || finish.isPending;

  return (
    <>
      <div className="page-head">
        <div className="t">
          <Breadcrumbs items={[{ label: 'Receiving', to: href('ops/receiving') }, { label: r.purchaseOrderRef }]} />
          <h1 className="h1">Receiving {r.purchaseOrderRef}</h1>
          <p className="sub small">
            {[r.supplierName, delivery.arrivedAt ? `arrived ${time(delivery.arrivedAt)}${delivery.dock ? `, dock ${delivery.dock}` : ''}` : '', r.receivedBy?.name ? `received by ${r.receivedBy.name}` : ''].filter(Boolean).join(' · ')}
          </p>
        </div>
        <div className="actions">
          <Button variant="secondary" size="sm" icon="printer" onClick={() => window.print()}>
            Print labels
          </Button>
        </div>
      </div>
      <ReceivingSteps current={step} />
      {r.status === 'confirmed' && (
        <Alert tone="success" title={`${r.totals.sellable ?? sellable} units available for sale`}>
          Put away to the bins below. {r.totals.shortage > 0 && `Purchasing has the ${r.totals.shortage}-unit shortage claim. `}
          <Link to={href('ops/receiving')}>Back to Receiving</Link>
        </Alert>
      )}
      {r.status === 'awaiting_confirmation' && (
        <Alert tone="info" title="Counted. Waiting for the Inventory Manager">
          The units stay in Incoming until the Inventory Manager confirms the sellable quantity. {r.totals.shortage > 0 && `Purchasing has the ${r.totals.shortage}-unit shortage. `}
          <Link to={href('ops/receiving')}>Back to Receiving</Link>
        </Alert>
      )}
      {(save.error || finish.error) && <Alert tone="danger">{errorMessage(save.error ?? finish.error)}</Alert>}
      <div className="ac-main">
        <div className="stack gap-4">
          <div className="row between">
            <h2 className="h3">Lines</h2>
            <span className="xs muted">
              {lines.length} lines · {expected} expected · {received} received
            </span>
          </div>
          <form className="row gap-2" onSubmit={onScan}>
            <label className="sr-only" htmlFor="rc-scan">
              Scan or enter SKU
            </label>
            <TextInput id="rc-scan" icon="scan-barcode" placeholder="Scan or enter SKU to count 1 unit" value={scan} onChange={(e) => setScan(e.target.value)} disabled={!editable} autoComplete="off" />
            <Button type="submit" variant="secondary" size="sm" disabled={!editable}>
              Count
            </Button>
          </form>
          {scanMsg && (
            <span className={cx('xs', scanMsg.ok ? 'muted' : 't-danger-text')} role="status">
              {scanMsg.text}
            </span>
          )}
          <div className="ac-lines">
            {lines.map((l, i) => {
              const short = l.expected - l.received;
              const flagged = l.damaged > 0;
              const warn = !flagged && short !== 0;
              const bin = drafts[l.purchaseOrderLineId]?.binCode ?? l.binCode ?? '';
              const hasPhotos = (drafts[l.purchaseOrderLineId]?.photoIds.length ?? l.photos.length) > 0;
              return (
                <article key={l.purchaseOrderLineId} className={cx('ac-line', flagged && 'is-flagged', warn && 'is-warn')}>
                  {flagged && <span className="sr-only">Urgent: </span>}
                  {warn && <span className="sr-only">At risk: </span>}
                  <div className="row gap-3 nowrap top">
                    <Img icon="package" src={l.image?.url} alt={l.image?.alt ?? ''} className="thumb" />
                    <span className="stack gap-0 grow">
                      <span className="small strong">{l.label}</span>
                      <span className="xs mono muted">{l.sku}</span>
                    </span>
                    <LineBadge l={l} />
                  </div>
                  <div className="ac-line-nums">
                    <div className="field">
                      <label className="label" htmlFor={`rc-exp-${i}`}>
                        Expected
                      </label>
                      <input className="input ac-qty" id={`rc-exp-${i}`} value={l.expected} readOnly />
                    </div>
                    <div className="field">
                      <label className="label" htmlFor={`rc-rec-${i}`}>
                        Received
                      </label>
                      <input className="input ac-qty" id={`rc-rec-${i}`} type="number" min={0} value={l.received} disabled={!editable} onChange={(e) => setLine(l.purchaseOrderLineId, { received: toInt(e.target.value) })} />
                    </div>
                    <div className="field">
                      <label className="label" htmlFor={`rc-dmg-${i}`}>
                        Damaged
                      </label>
                      <input className={cx('input ac-qty', l.damaged > l.received && 'is-error')} id={`rc-dmg-${i}`} type="number" min={0} value={l.damaged} disabled={!editable} onChange={(e) => setLine(l.purchaseOrderLineId, { damaged: toInt(e.target.value) })} />
                    </div>
                    <div className="field">
                      <label className="label" htmlFor={`rc-loc-${i}`}>
                        Put-away bin
                      </label>
                      <input className={cx('input ac-loc', tried && !bin.trim() && 'is-error')} id={`rc-loc-${i}`} value={bin} disabled={!editable} onChange={(e) => setLine(l.purchaseOrderLineId, { binCode: e.target.value.toUpperCase() })} />
                    </div>
                  </div>
                  {short > 0 && (
                    <div className="panel xs sub row gap-2">
                      <Icon name="triangle-alert" className="ic-sm" />
                      <span>{short} units short. Purchasing is told automatically and raises a supplier claim. Shortage stays on the purchase record.</span>
                    </div>
                  )}
                  {short < 0 && (
                    <div className="panel xs sub row gap-2">
                      <Icon name="triangle-alert" className="ic-sm" />
                      <span>{-short} units more than ordered. Extra units stay in Incoming until Purchasing accepts them.</span>
                    </div>
                  )}
                  {l.damaged > 0 && (
                    <div className="stack gap-2">
                      <span className="xs strong">Damage photos (required)</span>
                      <LinePhotos line={l} disabled={!editable} onIds={(ids) => setLine(l.purchaseOrderLineId, { photoIds: ids })} />
                      {tried && !hasPhotos ? (
                        <span className="error-text">
                          <Icon name="circle-alert" className="ic-sm" />
                          Add at least one photo of the damage.
                        </span>
                      ) : (
                        <span className="xs muted">Damaged units go to Damaged or held. They are not offered for sale.</span>
                      )}
                    </div>
                  )}
                </article>
              );
            })}
          </div>
          <OpsLegend items={[{ tone: 'danger', label: EDGE_URGENT }, { tone: 'warning', label: EDGE_RISK }]} />
          <Field label="Receiving note" optional>
            <Textarea id="rc-note" value={note} onChange={(e) => setNote(e.target.value)} disabled={!editable} />
          </Field>
        </div>
        <div className="stack gap-5">
          <Card
            title="Make available for sale"
            titleAs="h3"
            sub="Inventory Manager confirms the sellable quantity"
            foot={
              r.status === 'confirmed' || (done && !canConfirm) ? (
                <Button variant="secondary" size="sm" to={href('ops/receiving')}>
                  Back to Receiving
                </Button>
              ) : !canRecord && r.status === 'in_progress' ? (
                <span className="xs muted">Warehouse staff with receiving access count this delivery.</span>
              ) : (
                <>
                  {r.status === 'in_progress' && (
                    <Button variant="ghost" size="sm" onClick={() => save.mutate()} disabled={busy}>
                      Save and finish later
                    </Button>
                  )}
                  <Button size="sm" icon="circle-check" onClick={submit} disabled={busy || (tried && !canFinish)}>
                    {finish.isPending ? 'Saving…' : canConfirm ? `Make ${sellable} units available` : 'Finish counting'}
                  </Button>
                </>
              )
            }
          >
            <SummaryRow k="Received" v={`${num(received)} units`} />
            <SummaryRow k="Damaged or held" v={`−${damaged} units`} />
            <SummaryRow k="Shortage reported to Purchasing" v={`${shortage} units`} />
            <div className="divider" />
            <div className="row between base">
              <span className="small strong">Sellable now</span>
              <span className="ac-big">{sellable}</span>
            </div>
            <KeyValue pairs={lines.map((l) => [l.sku, `${l.received - Math.min(l.damaged, l.received)} → bin ${(drafts[l.purchaseOrderLineId]?.binCode ?? l.binCode) || '—'}`])} />
            {r.status === 'confirmed' ? (
              <Alert tone="success" title="Available for sale">
                Customers can buy these units now{r.confirmedBy?.name ? `. Confirmed by ${r.confirmedBy.name}` : ''}.
              </Alert>
            ) : (
              <Alert tone="info" title="Stays in Incoming until confirmed">
                Customers cannot buy these units until the Inventory Manager confirms.{!canConfirm && ' You can finish counting; the Inventory Manager confirms the sellable quantity.'}
              </Alert>
            )}
            {r.status !== 'confirmed' && (canRecord || canConfirm) && (
              <Checkbox id="rc-confirm" label={`I counted and checked these units. ${staff.name}`} checked={confirmed} disabled={busy} onChange={(e) => setConfirmed(e.target.checked)} />
            )}
            {tried && !canFinish && (
              <span className="error-text">
                <Icon name="circle-alert" className="ic-sm" />
                {!confirmed ? 'Confirm that you counted and checked these units.' : missingPhotos.length ? 'Add damage photos for every line with damaged units.' : missingBins.length ? 'Enter a put-away bin for every line.' : 'There are no received units to make available.'}
              </span>
            )}
          </Card>
          <Card title="Delivery record" titleAs="h3">
            <KeyValue
              pairs={[
                ['Supplier', r.supplierName],
                ['Purchase order', <span className="mono">{r.purchaseOrderRef}</span>],
                ['Carrier', [delivery.carrier, delivery.trackingRef].filter(Boolean).join(' · ') || '—'],
                ['Expected', windowLabel(delivery)],
                ['Arrived', delivery.arrivedAt ? `${dateTime(delivery.arrivedAt)}${delivery.dock ? `, dock ${delivery.dock}` : ''}` : '—'],
                ['Buying cost', r.buyingCost ? formatMoney(r.buyingCost) : '—'],
              ]}
            />
          </Card>
        </div>
      </div>
    </>
  );
}

export default function Receiving() {
  const [view, setView] = useView();
  const [notice, setNotice] = useState('');
  const poRef = view.startsWith('receiving-') ? view.slice('receiving-'.length) : '';

  return (
    <OpsLayout active="receiving">
      {poRef ? (
        <ReceivePo
          key={poRef}
          poRef={poRef}
          onSaveLater={(ref) => {
            setNotice(`Saved. ${ref} stays in Receiving until it is finished.`);
            setView('');
          }}
        />
      ) : (
        <DeliveryList notice={notice} />
      )}
    </OpsLayout>
  );
}
