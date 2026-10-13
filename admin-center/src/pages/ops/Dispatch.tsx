import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useEffect, useRef, useState } from 'react';
import { Link } from 'react-router';
import { call, errorMessage, newIdempotencyKey, useApi } from '@marketly/web-shared/api';
import { OpsLayout } from '@marketly/web-shared/layouts';
import { cx } from '@marketly/web-shared/lib/cx';
import { formatMoney, type MoneyValue } from '@marketly/web-shared/lib/format';
import { useView } from '@marketly/web-shared/lib/hooks';
import { href } from '@marketly/web-shared/routes';
import { Alert, Badge, Button, Card, Checkbox, Deadline, Dialog, Field, Icon, IconButton, PageHeader, SearchInput, Select, StatusBadge, TableWrap, Textarea, TextInput, announce } from '@marketly/web-shared/ui';
import { LoadError, SkeletonLines, dateTime, deadlineTone, shortDate } from '@/app/parts';
import { useStaffSession } from '@/app/session';
import { ACTIONS, CLAIM_STATUS, RESOLUTIONS, SELLER_FILTERS, TABS, type ActionKey, type DispatchView, type ExceptionKind } from './data/dispatch';
import { EDGE_RISK, EDGE_URGENT, EmptyRow, OpsLegend, SkeletonRows } from './data/shared';

// Design: pages/ops/ops-dispatch.html (Late dispatch) and the views seller-cannot-fulfill, missing-tracking,
// lost-or-damaged, delivery-failed: one exception queue per tab.
// API: GET shipping/exceptions (kind, sellerType, customerNotNotified, q), GET shipping/exceptions/counts,
// POST exceptions/{id}/notify-customer | notify-seller | request-tracking | escalate | resolve,
// GET/POST shipping/claims, GET shipping/carriers, GET orders/orders/{id} + POST orders/orders/{id}/cancel-items (idempotent).

interface Exception {
  id: string;
  kind: ExceptionKind;
  orderId: string;
  orderRef: string;
  shipmentId: string | null;
  ownerType: 'official' | 'seller';
  sellerName: string | null;
  itemsSummary: string;
  orderItemIds: string[];
  situation: string;
  requiredResponse: string;
  nextStep: string | null;
  customerNotifiedAt: string | null;
  sellerNotifiedAt: string | null;
  owner: { staffId?: string | null; name: string } | null;
  deadline: { dueAt: string; state: string };
  deadlineLabel: string;
  status: 'open' | 'in_progress' | 'escalated' | 'resolved' | 'closed';
  escalatedTo: string | null;
  sellerResponse: string | null;
  claimId: string | null;
}
interface Counts {
  sellerCannotFulfill: number;
  lateDispatch: number;
  missingTracking: number;
  lostOrDamaged: number;
  failedDelivery: number;
  customerNotNotified: number;
}
interface CarrierClaim {
  id: string;
  claimNumber: string | null;
  carrierCode: string;
  carrierName: string;
  orderRef: string;
  amount: MoneyValue;
  filedAt: string | null;
  status: string;
  owner: string;
  approval: { required?: boolean; state?: string } | null;
}
interface Carrier {
  code: string;
  name: string;
  status: string;
}

const isOpen = (e: Exception) => e.status !== 'resolved' && e.status !== 'closed';
const official = (e: Exception) => e.ownerType === 'official';

/** Actions in order (the first is the row button, the rest sit under "More actions"), by kind and progress. */
function actionsFor(e: Exception): ActionKey[] {
  const seller = !official(e);
  switch (e.kind) {
    case 'seller_cannot_fulfill':
      return ['cancel', 'contact'];
    case 'late_dispatch':
      return seller ? (e.sellerNotifiedAt ? (e.escalatedTo ? ['contact'] : ['escalate', 'contact']) : ['notify', 'contact']) : ['contact'];
    case 'missing_tracking':
      return seller ? (e.escalatedTo ? ['track'] : ['track', 'escalate']) : ['track'];
    case 'lost_or_damaged':
      return e.claimId || !e.shipmentId ? ['contact'] : ['claim', 'contact'];
    case 'failed_delivery':
      return seller ? ['contact', 'notify'] : ['contact'];
  }
}

function Notified({ e }: { e: Exception }) {
  if (!e.customerNotifiedAt)
    return (
      <Badge tone="danger" icon="bell-off">
        Not notified
      </Badge>
    );
  return (
    <span className="stack gap-0">
      <Badge tone="success" icon="check">
        Notified
      </Badge>
      <span className="xs muted nowrap">{dateTime(e.customerNotifiedAt)}</span>
    </span>
  );
}

function SellerCell({ e }: { e: Exception }) {
  return (
    <span className="stack gap-1 items-start">
      <span className="small nowrap">{official(e) ? 'Marketly Official' : (e.sellerName ?? 'Seller')}</span>
      {official(e) ? (
        <Badge tone="brand" icon="badge-check">
          Official
        </Badge>
      ) : (
        <Badge tone="outline">Marketplace</Badge>
      )}
    </span>
  );
}

const edgeOf = (e: Exception) => {
  const t = deadlineTone(e.deadline.state);
  return t === 'danger' || (!e.customerNotifiedAt && e.status === 'open' && t !== 'ok') ? 'flagged' : t === 'warning' ? 'warn' : '';
};

interface ClaimDraft {
  exceptionId: string;
  carrier: string;
  amount: string;
  what: string;
}

export default function Dispatch() {
  const { api } = useApi();
  const qc = useQueryClient();
  const staff = useStaffSession();
  const [view] = useView<Exclude<DispatchView, ''>>();
  const [q, setQ] = useState('');
  const [search, setSearch] = useState('');
  const [sellerF, setSellerF] = useState('all');
  const [ownerF, setOwnerF] = useState('');
  const [notNotified, setNotNotified] = useState(false);
  const [done, setDone] = useState('');
  const [menuFor, setMenuFor] = useState<string | null>(null);
  const [cancelFor, setCancelFor] = useState<string | null>(null);
  const [resolveFor, setResolveFor] = useState<{ id: string; kind: string; note: string } | null>(null);
  const [claim, setClaim] = useState<ClaimDraft | null>(null);
  const [claimTried, setClaimTried] = useState(false);
  const cancelKey = useRef(newIdempotencyKey());

  useEffect(() => {
    const t = setTimeout(() => setSearch(q.trim()), 300);
    return () => clearTimeout(t);
  }, [q]);

  const tab = TABS.find((t) => t.view === view) ?? TABS[1];
  const canManage = staff.can('shipping.exceptions.manage');
  const canClaim = staff.can('shipping.claims.manage');
  const canCancel = staff.can('orders.orders.cancel');

  const params = { kind: tab.kind, sellerType: sellerF as 'all', customerNotNotified: notNotified || undefined, q: search || undefined, limit: 100 };
  const list = useQuery({ queryKey: ['shipping', 'exceptions', params], queryFn: () => call(api.GET('/api/admin/shipping/exceptions', { params: { query: params } })) as Promise<{ items: Exception[] }> });
  const counts = useQuery({ queryKey: ['shipping', 'exceptions', 'counts'], queryFn: () => call(api.GET('/api/admin/shipping/exceptions/counts')) as Promise<Counts> });
  const claims = useQuery({ queryKey: ['shipping', 'claims'], queryFn: () => call(api.GET('/api/admin/shipping/claims', { params: { query: { limit: 20 } as never } })) as Promise<{ items: CarrierClaim[] }>, enabled: canClaim });
  const carriers = useQuery({ queryKey: ['shipping', 'carriers'], queryFn: () => call(api.GET('/api/admin/shipping/carriers')) as Promise<Carrier[]>, enabled: canClaim && !!claim });
  // Lost or damaged exceptions with a shipment, for a claim opened from the Carrier claims card.
  const claimable = useQuery({
    queryKey: ['shipping', 'exceptions', { kind: 'lost_or_damaged', claimable: true }],
    queryFn: () => call(api.GET('/api/admin/shipping/exceptions', { params: { query: { kind: 'lost_or_damaged', limit: 100 } } })) as Promise<{ items: Exception[] }>,
    enabled: canClaim && !!claim,
  });

  const rows = (list.data?.items ?? []).filter(isOpen);
  const owners = [...new Set(rows.map((r) => r.owner?.name).filter(Boolean) as string[])].sort();
  const filtered = rows.filter((r) => !ownerF || (ownerF === '-' ? !r.owner : r.owner?.name === ownerF));
  const legend = [
    ...(filtered.some((r) => edgeOf(r) === 'flagged') ? [{ tone: 'danger' as const, label: EDGE_URGENT }] : []),
    ...(filtered.some((r) => edgeOf(r) === 'warn') ? [{ tone: 'warning' as const, label: EDGE_RISK }] : []),
  ];

  const finish = (msg: string) => {
    setDone(msg);
    announce(msg);
    void qc.invalidateQueries({ queryKey: ['shipping'] });
    void qc.invalidateQueries({ queryKey: ['workqueues', 'queues'] });
  };

  const act = useMutation({
    mutationFn: async ({ e, a }: { e: Exception; a: ActionKey }) => {
      const path = { params: { path: { id: e.id } } };
      switch (a) {
        case 'contact':
          await call(api.POST('/api/admin/shipping/exceptions/{id}/notify-customer', { ...path, body: {} }));
          return `Message sent to the customer on ${e.orderRef}. It is logged on the order.`;
        case 'notify':
          await call(api.POST('/api/admin/shipping/exceptions/{id}/notify-seller', { ...path, body: {} }));
          return `${e.sellerName ?? 'The seller'} notified about ${e.orderRef}. Their reply comes to this queue.`;
        case 'escalate':
          await call(api.POST('/api/admin/shipping/exceptions/{id}/escalate', { ...path, body: { to: 'seller_manager', reason: `${tab.label}: ${e.situation}` } }));
          return `${e.orderRef} escalated to the Seller Manager.`;
        case 'track':
          await call(api.POST('/api/admin/shipping/exceptions/{id}/request-tracking', { ...path, body: { dueAt: new Date(Date.now() + 24 * 3_600_000).toISOString() } }));
          return `Valid tracking requested from ${e.sellerName ?? 'the seller'} for ${e.orderRef}. The customer keeps seeing "Shipped, tracking pending".`;
        default:
          return '';
      }
    },
    onSuccess: (msg) => msg && finish(msg),
  });

  const cancel = useMutation({
    mutationFn: async (e: Exception) => {
      const order = (await call(api.GET('/api/admin/orders/orders/{id}', { params: { path: { id: e.orderId } } }))) as { order: { groups: Array<{ items: Array<{ id: string; quantity: number; cancelledQuantity?: number }> }> } };
      const items = order.order.groups
        .flatMap((g) => g.items)
        .filter((i) => e.orderItemIds.includes(i.id))
        .map((i) => ({ itemId: i.id, quantity: Math.max(1, i.quantity - (i.cancelledQuantity ?? 0)) }));
      return call(
        api.POST('/api/admin/orders/orders/{id}/cancel-items', {
          params: { path: { id: e.orderId }, header: { 'Idempotency-Key': cancelKey.current } },
          body: { items, reasonCode: e.kind === 'seller_cannot_fulfill' ? 'seller_cannot_fulfill' : e.kind === 'late_dispatch' ? 'overdue_dispatch' : 'other', reason: e.situation, notifyCustomer: true },
        } as never),
      );
    },
    onSuccess: (_r, e) => {
      cancelKey.current = newIdempotencyKey();
      setCancelFor(null);
      finish(`Item cancelled on ${e.orderRef}. The refund goes to the customer's original payment method.`);
    },
  });

  const resolve = useMutation({
    mutationFn: (v: { id: string; kind: string; note: string }) => call(api.POST('/api/admin/shipping/exceptions/{id}/resolve', { params: { path: { id: v.id } }, body: { kind: v.kind, note: v.note } as never })),
    onSuccess: (_r, v) => {
      const e = rows.find((x) => x.id === v.id);
      setResolveFor(null);
      finish(`${e?.orderRef ?? 'Exception'} marked resolved and removed from ${tab.label}.`);
    },
  });

  const claimRow = claim ? (rows.find((r) => r.id === claim.exceptionId) ?? claimable.data?.items.find((r) => r.id === claim.exceptionId)) : undefined;
  const validateClaim = (d: ClaimDraft) => {
    const e: Partial<Record<keyof ClaimDraft, string>> = {};
    if (!d.exceptionId) e.exceptionId = 'Choose the lost or damaged order.';
    if (!d.carrier) e.carrier = 'Choose the carrier.';
    if (!(Number(d.amount) > 0)) e.amount = 'Enter the claim amount.';
    if (!d.what.trim()) e.what = 'Describe what happened to the package.';
    return e;
  };
  const openClaim = useMutation({
    mutationFn: (d: ClaimDraft) =>
      call(
        api.POST('/api/admin/shipping/claims', {
          body: { shipmentId: claimRow!.shipmentId!, exceptionId: claimRow!.id, carrierCode: d.carrier, amount: { amount: Math.round(Number(d.amount) * 100), currency: 'USD' }, note: d.what.trim() } as never,
        }),
      ) as Promise<CarrierClaim>,
    onSuccess: (c) => {
      setClaim(null);
      finish(c.approval?.required || c.status === 'draft' ? `Claim for ${c.orderRef} sent to Finance for approval.` : `Carrier claim${c.claimNumber ? ` ${c.claimNumber}` : ''} filed with ${c.carrierName}.`);
    },
  });
  const submitClaim = () => {
    if (!claim) return;
    setClaimTried(true);
    if (Object.keys(validateClaim(claim)).length || !claimRow?.shipmentId) return;
    openClaim.mutate(claim);
  };

  const run = (e: Exception, a: ActionKey) => {
    setMenuFor(null);
    setDone('');
    if (a === 'cancel') {
      cancel.reset();
      setCancelFor(e.id);
    } else if (a === 'claim') {
      setClaimTried(false);
      openClaim.reset();
      setClaim({ exceptionId: e.id, carrier: '', amount: '', what: e.situation });
    } else act.mutate({ e, a });
  };
  const allowed = (a: ActionKey) => (a === 'cancel' ? canCancel : a === 'claim' ? canClaim : canManage);

  const claimErrors = claim && claimTried ? validateClaim(claim) : {};
  const menuRow = rows.find((r) => r.id === menuFor);
  const cancelRow = rows.find((r) => r.id === cancelFor);

  const actionButton = (r: Exception) => {
    const acts = actionsFor(r).filter(allowed);
    if (!canManage && !acts.length) return <span className="xs muted">View only</span>;
    if (!acts.length)
      return canManage ? (
        <IconButton icon="ellipsis" size="sm" label={`More actions for ${r.orderRef}`} aria-haspopup="dialog" onClick={() => setMenuFor(r.id)} />
      ) : (
        <span className="xs muted">No action needed</span>
      );
    const a = ACTIONS[acts[0]];
    return (
      <>
        <button type="button" className={cx('btn btn-sm', acts.length > 1 ? 'btn-primary' : 'btn-ghost')} onClick={() => run(r, acts[0])} disabled={act.isPending}>
          <Icon name={a.icon} />
          <span>{a.label}</span>
          <span className="sr-only"> {r.orderRef}</span>
        </button>
        <IconButton icon="ellipsis" size="sm" label={`More actions for ${r.orderRef}`} aria-haspopup="dialog" onClick={() => setMenuFor(r.id)} />
      </>
    );
  };
  const orderHref = (ref: string) => href('admin/order', '', { ref });
  const response = (r: Exception) => r.sellerResponse ?? r.nextStep ?? r.requiredResponse;
  const item = (r: Exception) => (r.situation ? `${r.itemsSummary} · ${r.situation}` : r.itemsSummary);

  return (
    <OpsLayout active="dispatch">
      <PageHeader
        title="Dispatch and delivery exceptions"
        sub="Official Store and marketplace orders that are late, unclear or failed. Shipping owns these; seller problems go to the Seller Manager when performance action is needed."
        actions={
          <Button variant="secondary" size="sm" icon="download" disabled title="Exception exports aren’t available yet">
            Export
          </Button>
        }
      />
      <OpsLegend
        kind="number"
        items={[
          { tone: 'danger', label: 'Red number = urgent: overdue or past target' },
          { tone: 'warning', label: 'Amber number = at risk: due soon or near target' },
        ]}
      />
      <div className="tabs" role="tablist">
        {TABS.map((t) => {
          const on = t.view === tab.view;
          const n = counts.data?.[t.countKey];
          const hot = on && rows.some((r) => deadlineTone(r.deadline.state) === 'danger');
          return (
            <Link key={t.label} className={cx('tab', on && 'is-active')} role="tab" aria-selected={on} to={href('ops/dispatch', t.view)} preventScrollReset onClick={() => setDone('')}>
              <Icon name={t.icon} className="ic-sm" />
              {t.label}
              {n != null &&
                (hot ? (
                  <span className="count t-danger-soft">
                    {n}
                    <span className="sr-only"> overdue</span>
                  </span>
                ) : (
                  <span className="count">{n}</span>
                ))}
            </Link>
          );
        })}
      </div>
      <div className="panel row gap-3 nowrap top">
        <Icon name="clipboard-list" />
        <span className="stack gap-0">
          <span className="small strong">Required response: {tab.label}</span>
          <span className="small sub">{tab.response}</span>
        </span>
      </div>
      {tab.view === 'missing-tracking' && (
        <Alert tone="info" title={'Customers see "Shipped, tracking pending"'}>
          The order page does not show In transit or Delivered until the carrier confirms a scan.
        </Alert>
      )}
      {done && <Alert tone="success" title={done} />}
      {act.error && <Alert tone="danger">{errorMessage(act.error)}</Alert>}
      {!canManage && <Alert tone="info">You can view these exceptions. Shipping managers act on them.</Alert>}
      <div className="toolbar">
        <SearchInput id="dp-q" placeholder="Search order, seller or tracking number" value={q} onChange={setQ} />
        <label className="sr-only" htmlFor="dp-seller">
          Seller
        </label>
        <Select id="dp-seller" options={SELLER_FILTERS} value={sellerF} onChange={(e) => setSellerF(e.target.value)} />
        <label className="sr-only" htmlFor="dp-owner">
          Owner
        </label>
        <Select id="dp-owner" options={[{ value: '', label: 'All owners' }, { value: '-', label: 'Unassigned' }, ...owners.map((o) => ({ value: o, label: o }))]} value={ownerF} onChange={(e) => setOwnerF(e.target.value)} />
        <Checkbox id="dp-notn" label="Customer not notified" checked={notNotified} onChange={(e) => setNotNotified(e.target.checked)} />
      </div>
      <Card title={tab.label} sub={list.data ? `${rows.length} open · showing ${filtered.length}` : 'Loading…'} flush>
        {list.error ? (
          <div className="card-body">
            <LoadError error={list.error} onRetry={() => void list.refetch()} />
          </div>
        ) : (
          <>
            <div className="no-phone">
              <TableWrap label={`${tab.label} table`}>
                <table className="table">
                  <thead>
                    <tr>
                      <th scope="col">Order</th>
                      <th scope="col">Seller</th>
                      <th scope="col">Item and situation</th>
                      <th scope="col">Customer notified</th>
                      <th scope="col">Required response</th>
                      <th scope="col">Owner</th>
                      <th scope="col">Deadline</th>
                      <th className="col-pin" scope="col">
                        Actions
                      </th>
                    </tr>
                  </thead>
                  <tbody>
                    {list.isPending && <SkeletonRows cols={8} />}
                    {!list.isPending && !filtered.length && <EmptyRow cols={8}>{rows.length ? 'No exceptions match these filters.' : `No open ${tab.label.toLowerCase()} exceptions.`}</EmptyRow>}
                    {filtered.map((r) => {
                      const edge = edgeOf(r);
                      return (
                        <tr key={r.id} className={cx(edge === 'flagged' && 'is-flagged', edge === 'warn' && 'is-warn')}>
                          <td>
                            {edge === 'flagged' && <span className="sr-only">Urgent: </span>}
                            {edge === 'warn' && <span className="sr-only">At risk: </span>}
                            <Link className="mono nowrap" to={orderHref(r.orderRef)} title={r.orderRef}>
                              {r.orderRef}
                            </Link>
                          </td>
                          <td>
                            <SellerCell e={r} />
                          </td>
                          <td>
                            <span className="small minw-200 cell-text">{item(r)}</span>
                          </td>
                          <td>
                            <Notified e={r} />
                          </td>
                          <td>
                            <span className="small minw-160 cell-text">{response(r)}</span>
                          </td>
                          <td>
                            <span className="small nowrap">{r.owner?.name ?? 'Unassigned'}</span>
                          </td>
                          <td>
                            <Deadline tone={deadlineTone(r.deadline.state)}>{r.deadlineLabel}</Deadline>
                          </td>
                          <td className="col-pin">
                            <div className="ac-acts">{actionButton(r)}</div>
                          </td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
              </TableWrap>
              {legend.length > 0 && <OpsLegend items={legend} />}
            </div>
            <div className="ac-mlist only-phone">
              {list.isPending && <SkeletonLines rows={3} />}
              {filtered.map((r) => {
                const edge = edgeOf(r);
                const acts = actionsFor(r).filter(allowed);
                return (
                  <div key={r.id} className={cx('ac-mi', edge === 'flagged' && 'is-flagged', edge === 'warn' && 'is-warn')}>
                    {edge === 'flagged' && <span className="sr-only">Urgent: </span>}
                    {edge === 'warn' && <span className="sr-only">At risk: </span>}
                    <div className="row between gap-2 nowrap top">
                      <span className="small strong min-w-0">
                        <Link className="mono nowrap" to={orderHref(r.orderRef)}>
                          {r.orderRef}
                        </Link>
                      </span>
                      <Deadline tone={deadlineTone(r.deadline.state)}>{r.deadlineLabel}</Deadline>
                    </div>
                    <div className="xs sub">
                      {official(r) ? 'Marketly Official · Official' : `${r.sellerName ?? 'Seller'} · Marketplace`}
                    </div>
                    <div className="xs sub">{item(r)}</div>
                    <div className="xs sub">
                      Customer notified: {r.customerNotifiedAt ? `Yes · ${dateTime(r.customerNotifiedAt)}` : 'No'} · Owner {r.owner?.name ?? 'Unassigned'}
                    </div>
                    <div className="xs sub">
                      <b>{response(r)}</b>
                    </div>
                    {acts.length > 0 && (
                      <div className="row gap-2 mt-1-5">
                        {acts.slice(0, 2).map((a) => (
                          <Button key={a} variant="ghost" size="sm" icon={ACTIONS[a].icon} onClick={() => run(r, a)}>
                            {ACTIONS[a].label}
                          </Button>
                        ))}
                      </div>
                    )}
                  </div>
                );
              })}
              {!list.isPending && !filtered.length && <div className="ac-mi xs sub">{rows.length ? 'No exceptions match these filters.' : `No open ${tab.label.toLowerCase()} exceptions.`}</div>}
            </div>
            {legend.length > 0 && <OpsLegend className="only-phone" items={legend} />}
          </>
        )}
      </Card>
      {canClaim && (
        <Card
          title="Carrier claims"
          titleAs="h3"
          sub="Claims over the approval limit need Finance approval"
          flush
          actions={
            <Button
              variant="secondary"
              size="sm"
              icon="file-plus"
              onClick={() => {
                setClaimTried(false);
                openClaim.reset();
                setClaim({ exceptionId: '', carrier: '', amount: '', what: '' });
              }}
            >
              Open carrier claim
            </Button>
          }
        >
          {claims.error ? (
            <div className="card-body">
              <LoadError error={claims.error} onRetry={() => void claims.refetch()} />
            </div>
          ) : (
            <>
              <div className="no-phone">
                <TableWrap label="Carrier claims table">
                  <table className="table">
                    <thead>
                      <tr>
                        <th scope="col">Claim</th>
                        <th scope="col">Carrier</th>
                        <th scope="col">Order</th>
                        <th className="r" scope="col">
                          Amount
                        </th>
                        <th scope="col">Filed</th>
                        <th scope="col">Status</th>
                        <th className="col-pin" scope="col">
                          Owner
                        </th>
                      </tr>
                    </thead>
                    <tbody>
                      {claims.isPending && <SkeletonRows cols={7} rows={2} />}
                      {!claims.isPending && !claims.data?.items.length && <EmptyRow cols={7}>No carrier claims yet.</EmptyRow>}
                      {claims.data?.items.map((c) => (
                        <tr key={c.id}>
                          <td>
                            <span className="mono small nowrap" title={c.claimNumber ?? ''}>
                              {c.claimNumber ?? 'Not filed yet'}
                            </span>
                          </td>
                          <td>{c.carrierName}</td>
                          <td>
                            <Link className="mono nowrap" to={orderHref(c.orderRef)} title={c.orderRef}>
                              {c.orderRef}
                            </Link>
                          </td>
                          <td className="r">{formatMoney(c.amount)}</td>
                          <td>{c.filedAt ? shortDate(c.filedAt) : '—'}</td>
                          <td>
                            <StatusBadge status={CLAIM_STATUS[c.status] ?? c.status} />
                          </td>
                          <td className="col-pin">
                            <span className="small">{c.owner}</span>
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </TableWrap>
              </div>
              <div className="ac-mlist only-phone">
                {claims.data?.items.map((c) => (
                  <div key={c.id} className="ac-mi">
                    <div className="row between gap-2 nowrap top">
                      <span className="small strong min-w-0">
                        <span className="mono">{c.claimNumber ?? 'Not filed yet'}</span>
                      </span>
                      <StatusBadge status={CLAIM_STATUS[c.status] ?? c.status} />
                    </div>
                    <div className="xs sub">
                      {c.carrierName} · {formatMoney(c.amount)} · filed {c.filedAt ? shortDate(c.filedAt) : '—'}
                    </div>
                    <div className="xs sub">
                      Order <span className="mono">{c.orderRef}</span> · {c.owner}
                    </div>
                  </div>
                ))}
              </div>
            </>
          )}
        </Card>
      )}

      <Dialog open={!!menuRow} onClose={() => setMenuFor(null)} title={menuRow ? `Actions for ${menuRow.orderRef}` : 'Actions'} size="sm">
        {menuRow && (
          <div className="menu-list">
            {actionsFor(menuRow)
              .filter(allowed)
              .map((a) => (
                <button key={a} type="button" onClick={() => run(menuRow, a)}>
                  <Icon name={ACTIONS[a].icon} />
                  {ACTIONS[a].label}
                </button>
              ))}
            <Link to={orderHref(menuRow.orderRef)}>
              <Icon name="external-link" />
              Open order
            </Link>
            {canManage && (
              <button
                type="button"
                onClick={() => {
                  setMenuFor(null);
                  resolve.reset();
                  setResolveFor({ id: menuRow.id, kind: RESOLUTIONS[menuRow.kind][0].value, note: '' });
                }}
              >
                <Icon name="circle-check" />
                Mark resolved
              </button>
            )}
          </div>
        )}
      </Dialog>

      <Dialog
        open={!!resolveFor}
        onClose={() => setResolveFor(null)}
        title="Mark resolved"
        size="sm"
        foot={
          <>
            <Button variant="ghost" onClick={() => setResolveFor(null)}>
              Cancel
            </Button>
            <Button icon="circle-check" onClick={() => resolveFor?.note.trim() && resolve.mutate(resolveFor)} disabled={!resolveFor?.note.trim() || resolve.isPending}>
              Mark resolved
            </Button>
          </>
        }
      >
        {resolveFor && (
          <>
            {resolve.error && <Alert tone="danger">{errorMessage(resolve.error)}</Alert>}
            <Field label="Outcome">
              <Select id="rs-kind" options={RESOLUTIONS[rows.find((r) => r.id === resolveFor.id)?.kind ?? tab.kind]} value={resolveFor.kind} onChange={(e) => setResolveFor({ ...resolveFor, kind: e.target.value })} />
            </Field>
            <Field label="Note">
              <Textarea id="rs-note" value={resolveFor.note} onChange={(e) => setResolveFor({ ...resolveFor, note: e.target.value })} />
            </Field>
          </>
        )}
      </Dialog>

      <Dialog
        open={!!cancelRow}
        onClose={() => setCancelFor(null)}
        title="Cancel item and refund"
        size="sm"
        foot={
          <>
            <Button variant="ghost" onClick={() => setCancelFor(null)}>
              Keep item
            </Button>
            <Button variant="danger" icon="circle-x" onClick={() => cancelRow && cancel.mutate(cancelRow)} disabled={cancel.isPending}>
              Cancel and refund
            </Button>
          </>
        }
      >
        {cancelRow && (
          <>
            {cancel.error && <Alert tone="danger">{errorMessage(cancel.error)}</Alert>}
            <p className="small">
              {cancelRow.itemsSummary} on <span className="mono">{cancelRow.orderRef}</span>, sold by {official(cancelRow) ? 'Marketly Official' : cancelRow.sellerName}.
            </p>
            <Alert tone="info" title="The customer is told right away">
              The refund goes to the original payment method. The seller's cancellation rate updates.
            </Alert>
          </>
        )}
      </Dialog>

      <Dialog
        open={!!claim}
        onClose={() => setClaim(null)}
        title="Open carrier claim"
        foot={
          <>
            <Button variant="ghost" onClick={() => setClaim(null)}>
              Cancel
            </Button>
            <Button icon="file-plus" onClick={submitClaim} disabled={openClaim.isPending}>
              File claim
            </Button>
          </>
        }
      >
        {claim && (
          <>
            {openClaim.error && <Alert tone="danger">{errorMessage(openClaim.error)}</Alert>}
            <div className="ac-fgrid">
              <Field label="Order" error={claimErrors.exceptionId ?? (claimTried && claimRow && !claimRow.shipmentId ? 'This order has no shipment to claim for.' : undefined)}>
                <Select
                  id="cl-order"
                  className="mono"
                  options={[
                    { value: '', label: 'Choose an order' },
                    ...[...(claimable.data?.items ?? []), ...rows]
                      .filter((r, i, a) => r.kind === 'lost_or_damaged' && isOpen(r) && r.shipmentId && !r.claimId && a.findIndex((x) => x.id === r.id) === i)
                      .map((r) => ({ value: r.id, label: `${r.orderRef} · ${r.itemsSummary}` })),
                  ]}
                  value={claim.exceptionId}
                  onChange={(e) => setClaim({ ...claim, exceptionId: e.target.value })}
                />
              </Field>
              <Field label="Carrier" error={claimErrors.carrier}>
                <Select id="cl-carrier" options={[{ value: '', label: 'Choose a carrier' }, ...(carriers.data ?? []).filter((c) => c.status === 'active').map((c) => ({ value: c.code, label: c.name }))]} value={claim.carrier} onChange={(e) => setClaim({ ...claim, carrier: e.target.value })} />
              </Field>
              <Field label="Claim amount" error={claimErrors.amount}>
                <TextInput id="cl-amount" type="number" min={0} prefix="$" value={claim.amount} error={!!claimErrors.amount} onChange={(e) => setClaim({ ...claim, amount: e.target.value })} />
              </Field>
              <div className="full">
                <Field label="What happened" error={claimErrors.what}>
                  <Textarea id="cl-what" value={claim.what} onChange={(e) => setClaim({ ...claim, what: e.target.value })} />
                </Field>
              </div>
            </div>
            <Alert tone="info" title="Finance approval may be needed">
              Claims above the approval limit go to Finance before they are filed with the carrier.
            </Alert>
          </>
        )}
      </Dialog>
    </OpsLayout>
  );
}
