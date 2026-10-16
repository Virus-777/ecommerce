import { useState, type ReactNode } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Link, useParams } from 'react-router';
import { ApiError, call, errorMessage, useApi } from '@marketly/web-shared/api';
import AdminSellerQuery from '@marketly/web-shared/api/graphql/admin/AdminSeller.graphql?raw';
import { AdminLayout } from '@marketly/web-shared/layouts';
import { cx } from '@marketly/web-shared/lib/cx';
import { useView } from '@marketly/web-shared/lib/hooks';
import { formatMoney } from '@marketly/web-shared/lib/format';
import { href } from '@marketly/web-shared/routes';
import { Alert, Badge, Button, Card, Deadline, Dialog, EmptyState, Field, Icon, KeyValue, LogoTile, Meter, OptionCard, PageHeader, Select, StatusBadge, SummaryRow, TableWrap, Tabs, Textarea, TextInput, announce } from '@marketly/web-shared/ui';
import { useStaffSession } from '@/app/session';
import { LoadError, SkeletonLines, date, dateTime, deadlineLabel, deadlineTone, monthYear, shortDate } from '@/app/parts';
import { MessageDialog } from './data/seller-message';
import {
  CLOSED_GROUP, CLOSED_RETURN, cap, initialsOf, isoDay, statusLabel, tintOf,
  type AdminSellerGql, type Obligations, type Owner, type Payouts, type Restriction, type SellerDetail,
} from './data/seller';

// Design: pages/admin/admin-seller.html · view "suspend-seller" = the suspend dialog.
// Route /sellers/:slug carries the seller's store slug (the list links) or its id; both go straight to the detail route.
// Data: GET /api/admin/sellers/sellers/{slug|id} (account, restrictions, performance, appeals, payouts, notes, history;
// kept on REST: the page's restriction editing and typed detail come from it), the AdminSeller screen query (open
// orders, returns and cases; approvals waiting on the seller), GET …/{id}/suspension-impact and
// POST /api/admin/access/authority-checks (sellers.sellers.suspend: the eligible second reviewers).
// Writes: POST …/{id}/suspend (always a second reviewer), PATCH /api/admin/sellers/restrictions/{id},
// POST …/{id}/notes, POST /api/admin/messaging/conversations.

type ObKind = 'orders' | 'returns' | 'cases';
type Tone = 'success' | 'warning' | 'danger';
interface ObRow {
  key: string;
  ref: string;
  to?: string;
  item: string;
  status: string;
  deadline?: { tone: 'ok' | 'warning' | 'danger'; text: string };
  urgent?: boolean;
}
interface HistoryEvent {
  t: string;
  d: string;
  state: 'done' | 'current' | 'warn' | 'danger';
  body?: string;
}

const NOTE: Record<Tone, string> = { success: 'Within target', warning: 'Near target', danger: 'Below target' };
const OB_META: Record<ObKind, { tab: string; col: string }> = { orders: { tab: 'Orders', col: 'Order' }, returns: { tab: 'Returns', col: 'Return' }, cases: { tab: 'Cases', col: 'Case' } };
const OB_KINDS: ObKind[] = ['orders', 'returns', 'cases'];

const SUSPEND_ORDER_OPTIONS = [
  { id: 'aa-ss-o1', value: 'seller_keeps_fulfilling', title: 'Seller keeps fulfilling open orders' },
  { id: 'aa-ss-o2', value: 'cancel_unshipped_and_refund', title: 'Cancel unshipped orders and refund customers' },
] as const;
type OrderChoice = (typeof SUSPEND_ORDER_OPTIONS)[number]['value'];
const SUSPEND_REASONS = [
  { value: 'repeated_late_dispatch', label: 'Repeated late dispatch after restriction' },
  { value: 'counterfeit_or_unsafe', label: 'Counterfeit or unsafe products' },
  { value: 'fraud_or_abuse', label: 'Fraud or abuse' },
  { value: 'unresolved_cases', label: 'Failure to resolve cases' },
  { value: 'policy_violation', label: 'Policy violation' },
  { value: 'other', label: 'Other' },
] as const;
type ReasonCode = (typeof SUSPEND_REASONS)[number]['value'];

interface SuspendDraft {
  orders: OrderChoice;
  reason: '' | ReasonCode;
  date: string;
  details: string;
  reviewer: string;
}
const blank = (): SuspendDraft => ({ orders: 'seller_keeps_fulfilling', reason: '', date: isoDay(14), details: '', reviewer: '' });

function validate(d: SuspendDraft) {
  const e: Partial<Record<keyof SuspendDraft, string>> = {};
  if (!d.reason) e.reason = 'Choose a reason.';
  if (!d.date.trim()) e.date = 'Enter a review date.';
  if (!d.details.trim()) e.details = 'Write the details shown to the seller. Include facts and what the seller can do to resolve it.';
  if (!d.reviewer) e.reviewer = 'Choose a second reviewer.';
  return e;
}


/** Meter fill for a metric: percent "at least" targets show the value; others show value against twice the limit. */
function meterPct(value: number, target?: { comparator?: string; threshold?: number; unit?: string }) {
  if (!target) return Math.min(100, value);
  if (target.comparator === 'gte' && target.unit === 'percent') return Math.min(100, Math.max(0, value));
  if (!target.threshold) return value > 0 ? Math.min(100, value * 20) : 0;
  return Math.min(100, Math.round((value / (target.threshold * 2)) * 100));
}
const metricTone = (s: string): Tone => (s === 'meets' ? 'success' : s === 'watch' ? 'warning' : 'danger');

/** Timeline with the design's "At risk:" note on amber events. */
function HistoryTimeline({ events }: { events: HistoryEvent[] }) {
  return (
    <ol className="timeline">
      {events.map((e, i) => (
        <li key={`${i}-${e.t}`} className={`ev is-${e.state}`}>
          {e.state === 'warn' && <span className="sr-only">At risk: </span>}
          <span className="dot" aria-hidden="true" />
          <div className="stack gap-1">
            <span className="t">{e.t}</span>
            <span className="d">{e.d}</span>
            {e.body && <div className="small sub">{e.body}</div>}
          </div>
        </li>
      ))}
    </ol>
  );
}

const restrictionPairs = (r: Restriction): Array<[string, string]> =>
  [
    ['Reason', r.reason],
    ['Affected activity', r.affectedSummary],
    ['Not affected', r.stillWorks.join('; ')],
    ['To resolve', r.toResolve],
    ['Appeal route', `${r.appealRoute.howTo}, by ${shortDate(r.appealRoute.deadline)}. Decided by ${r.appealRoute.reviewer}${r.appealRoute.secondAppealTo ? `; a second appeal goes to ${r.appealRoute.secondAppealTo}` : ''}.`],
    ['Set by', [r.setBy.name, r.recommendedBy?.name ? `recommended by ${r.recommendedBy.name}` : ''].filter(Boolean).join(' · ')],
  ].filter((p): p is [string, string] => !!p[1]);

export default function Seller() {
  const { slug = '' } = useParams();
  const { api, gql } = useApi();
  const qc = useQueryClient();
  const { can, accountId } = useStaffSession();
  const [view, setView] = useView<'suspend-seller'>();
  const [flash, setFlash] = useState<{ title: string; body: string } | null>(null);
  const [obTab, setObTab] = useState<ObKind>('orders');
  const [draft, setDraft] = useState<SuspendDraft>(blank);
  const [tried, setTried] = useState(false);
  const [note, setNote] = useState('');
  const [message, setMessage] = useState(false);
  const [editing, setEditing] = useState<Restriction | null>(null);

  // The detail route accepts the store slug or the id.
  const detail = useQuery({
    queryKey: ['sellers', 'detail', slug],
    queryFn: () => call(api.GET('/api/admin/sellers/sellers/{id}', { params: { path: { id: slug } } })) as Promise<SellerDetail>,
    enabled: !!slug,
    retry: (n, e) => !(e instanceof ApiError && e.status === 404) && n < 2,
  });
  const id = detail.data?.account.id;
  const screen = useQuery({
    queryKey: ['sellers', 'screen', id],
    queryFn: () => gql<AdminSellerGql>(AdminSellerQuery, { id, orderPaging: { limit: 50 }, returnPaging: { limit: 50 }, casePaging: { limit: 50 }, trustPaging: { limit: 1 }, historyPaging: { limit: 1 } }, 'AdminSeller'),
    enabled: !!id,
    retry: false,
  });
  const canSuspend = can('sellers.accounts.suspend');
  const impact = useQuery({
    queryKey: ['sellers', 'suspension-impact', id],
    queryFn: () => call(api.GET('/api/admin/sellers/sellers/{id}/suspension-impact', { params: { path: { id: id! } } })),
    enabled: !!id && canSuspend && view === 'suspend-seller',
  });
  // Who may approve a suspension now (backups included), without needing access to the staff list.
  const members = useQuery({
    queryKey: ['access', 'authority', 'sellers.sellers.suspend'],
    queryFn: () => call(api.POST('/api/admin/access/authority-checks', { body: { action: 'sellers.sellers.suspend' } })),
    enabled: canSuspend && view === 'suspend-seller',
    retry: false,
  });
  const reviewers = (members.data?.eligibleApprovers ?? []).filter((m) => m.accountId !== accountId);

  const d = detail.data;
  const sellerId = d?.account.id ?? '';
  const refresh = () => {
    void qc.invalidateQueries({ queryKey: ['sellers'] });
    void qc.invalidateQueries({ queryKey: ['workqueues', 'queues'] });
    void qc.invalidateQueries({ queryKey: ['notifications', 'summary', 'staff'] });
  };

  // GraphQL approvals waiting on this seller: a suspension sent for second review shows as pending.
  const pendingApprovals = ((screen.data?.data?.sellerAdmin as { pendingApprovals?: Array<{ status: string; action?: { label?: string | null } | null }> } | null)?.pendingApprovals ?? []).filter(
    (a) => /pending|waiting|open/i.test(a.status) && /suspen/i.test(a.action?.label ?? ''),
  );
  const [sentForReview, setSentForReview] = useState(false);
  const pending = sentForReview || pendingApprovals.length > 0;
  const suspended = d?.account.status === 'suspended' || d?.account.status === 'closed';

  const suspend = useMutation({
    mutationFn: (dr: SuspendDraft) =>
      call(
          api.POST('/api/admin/sellers/sellers/{id}/suspend', {
            params: { path: { id: sellerId } },
            body: { reasonCode: dr.reason as ReasonCode, reason: dr.details.trim(), reviewDate: dr.date, openOrders: dr.orders, secondReviewerId: dr.reviewer },
          }),
        ),
    onSuccess: (res, dr) => {
      const reviewer = reviewers.find((m) => m.accountId === dr.reviewer)?.name ?? 'The second reviewer';
      if (res.state === 'pending_approval') {
        setSentForReview(true);
        setFlash({ title: 'Suspension sent for second review', body: `${reviewer} has been asked to approve the suspension. New sales continue until it is approved.` });
      } else {
        setFlash({ title: 'Seller suspended', body: `New sales from ${d?.account.storeName ?? 'this seller'} are stopped. Review date ${date(dr.date)}.` });
      }
      announce('Suspension submitted');
      setView('');
      refresh();
    },
  });

  const addNote = useMutation({
    mutationFn: () => call(api.POST('/api/admin/sellers/sellers/{id}/notes', { params: { path: { id: sellerId } }, body: { body: note.trim() } })),
    onSuccess: () => {
      setNote('');
      announce('Note added');
      void qc.invalidateQueries({ queryKey: ['sellers', 'detail', id] });
    },
  });

  const errors = tried ? validate(draft) : {};
  const set = <K extends keyof SuspendDraft>(k: K, v: SuspendDraft[K]) => setDraft((x) => ({ ...x, [k]: v }));
  const openSuspend = () => {
    setDraft(blank());
    setTried(false);
    suspend.reset();
    setView('suspend-seller');
  };
  const close = () => setView('');
  const submit = () => {
    setTried(true);
    if (Object.keys(validate(draft)).length) return;
    suspend.mutate(draft);
  };

  const notFound = detail.error instanceof ApiError && detail.error.status === 404;
  if (notFound) {
    return (
      <AdminLayout active="sellers">
        <PageHeader crumbs={[{ label: 'Sellers', to: href('admin/sellers') }, { label: 'Not found' }]} title="Seller not found" />
        <EmptyState icon="search-x" title="We couldn’t find this seller" action={<Button variant="secondary" size="sm" to={href('admin/sellers')}>Back to sellers</Button>}>
          {`No seller matches “${slug}”.`}
        </EmptyState>
      </AdminLayout>
    );
  }
  const loadError = detail.error;
  if (loadError || !d) {
    return (
      <AdminLayout active="sellers">
        <PageHeader crumbs={[{ label: 'Sellers', to: href('admin/sellers') }, { label: '…' }]} title={<span className="sk sk-line short" aria-label="Loading" />} />
        {loadError ? (
          <LoadError error={loadError} onRetry={() => void detail.refetch()} />
        ) : (
          <div className="aa-split">
            <Card title="Performance vs targets" titleAs="h3">
              <SkeletonLines rows={4} />
            </Card>
            <Card title="Account" titleAs="h3">
              <SkeletonLines rows={4} />
            </Card>
          </div>
        )}
      </AdminLayout>
    );
  }

  const a = d.account;
  const owner = (d.owner ?? {}) as Owner;
  const payouts = (d.payouts ?? null) as Payouts | null;
  const manager = (a.accountManager as { name?: string } | null)?.name;
  const location = [d.business.address?.city, d.business.address?.region].filter(Boolean).join(', ');
  const status = statusLabel(a.status);
  const statusBadge = pending ? <StatusBadge status="Suspension pending" tone="danger" /> : <StatusBadge status={status} />;
  const activeRestrictions = d.restrictions.filter((r) => r.state === 'active' || r.state === 'pending_approval');
  const canRestrict = can('sellers.accounts.restrict');

  // Performance: every metric but policy violations (shown in the note under the grid).
  const metrics = d.performance.metrics.filter((m) => m.key !== 'policy_violations');
  const violations = d.performance.metrics.find((m) => m.key === 'policy_violations');
  const feedback = (d.performance.feedback ?? {}) as { positivePct?: number | null; ratingCount?: number | null };
  const windowDays = d.performance.metrics[0]?.target.windowDays ?? 30;

  // Open obligations: the screen query's lists, or the REST summary when the query fails.
  const g = screen.data?.data;
  const rest = (d.obligations ?? {}) as Obligations;
  const obligations: Record<ObKind, ObRow[]> = g
    ? {
        orders: (g.ordersAdmin?.items ?? []).flatMap((o) =>
          o.groups
            .filter((gr) => (!gr.seller || gr.seller.id === sellerId) && !CLOSED_GROUP.has(gr.status))
            .map((gr) => {
              const tone = deadlineTone(gr.dispatchDeadline?.state);
              return {
                key: gr.id,
                ref: o.ref,
                to: href('admin/order', '', { ref: o.ref }),
                item: gr.itemsSummary ?? '',
                status: gr.statusLabel ?? cap(gr.status),
                deadline: gr.dispatchDeadline ? { tone, text: gr.deadlineLabel ?? deadlineLabel(gr.dispatchDeadline.dueAt, 'Dispatch by') } : undefined,
                urgent: tone === 'danger',
              };
            }),
        ),
        returns: (g.sellerAdmin?.returns?.items ?? [])
          .filter((r) => !CLOSED_RETURN.has(r.status))
          .map((r) => {
            const tone = deadlineTone(r.nextDeadline?.state);
            return {
              key: r.id,
              ref: r.ref,
              to: href('admin/returns'),
              item: r.orderRef ? `Order ${r.orderRef}` : '',
              status: r.statusLabel ?? cap(r.status),
              deadline: r.nextDeadline ? { tone, text: deadlineLabel(r.nextDeadline.dueAt) } : undefined,
              urgent: tone === 'danger',
            };
          }),
        cases: (g.sellerAdmin?.cases?.items ?? []).map((c) => {
          const tone = deadlineTone(c.expectedResponse?.state);
          return {
            key: c.id,
            ref: c.ref,
            to: href('admin/case', '', { ref: c.ref }),
            item: c.subject ?? '',
            status: c.statusLabel ?? cap(c.status),
            deadline: c.expectedResponse ? { tone, text: deadlineLabel(c.expectedResponse.dueAt, 'Reply by') } : undefined,
            urgent: tone === 'danger',
          };
        }),
      }
    : {
        orders: (rest.overdueOrders ?? []).map((o) => ({
          key: o.orderId,
          ref: o.orderRef,
          to: href('admin/order', '', { ref: o.orderRef }),
          item: o.itemTitle ?? '',
          status: o.statusLabel ?? 'Overdue',
          deadline: o.deadline ? { tone: deadlineTone(o.deadline.state), text: deadlineLabel(o.deadline.dueAt) } : undefined,
          urgent: true,
        })),
        returns: (rest.openReturns ?? []).map((r) => ({ key: r.id, ref: r.ref, to: href('admin/returns'), item: '', status: 'Open' })),
        cases: (rest.openCases ?? []).map((c) => ({ key: c.id, ref: c.ref, to: href('admin/case', '', { ref: c.ref }), item: '', status: 'Open' })),
      };
  const obRows = obligations[obTab];
  const others = OB_KINDS.filter((k) => k !== obTab && obligations[k].length);

  const history: HistoryEvent[] = d.history.map((e, i) => ({
    t: cap(e.label),
    d: [dateTime(e.at), e.actor?.name].filter(Boolean).join(' · '),
    state: i === 0 && /appeal|pending|received/i.test(e.label) ? 'current' : /restrict|hold|warning|suspend/i.test(e.label) ? 'warn' : 'done',
    body: e.detail ?? undefined,
  }));

  const v = a.verification;
  const pa = a.productApproval;
  const accountKv: Array<[string, ReactNode]> = [
    ['Account status', statusBadge],
    ['Verification', [v.state === 'verified' ? 'Verified seller label granted' : `Verified label ${cap(v.state).toLowerCase()}`, v.reason].filter(Boolean).join(' · ')],
    ...(pa ? ([['Product approval', `${pa.approved} approved · ${pa.inReview} waiting${pa.submissionsBlocked ? ' (submissions blocked)' : ''}`]] as Array<[string, string]>) : []),
    ['Payout readiness', [a.payoutReadiness.destinationLabel, a.payoutReadiness.note].filter(Boolean).join(' · ')],
    ['Legal name', a.legalName],
    ['Contact', [owner.email, owner.phone].filter(Boolean).join(' · ') || '—'],
  ];

  const impactData = impact.data;
  const orderBody: Record<OrderChoice, string> = {
    seller_keeps_fulfilling: impactData ? `${impactData.openOrdersWithinDeadline} order${impactData.openOrdersWithinDeadline === 1 ? ' is' : 's are'} within their dispatch deadline` : 'Open orders stay with the seller',
    cancel_unshipped_and_refund: impactData ? `${impactData.openOrders} order${impactData.openOrders === 1 ? '' : 's'} · ${formatMoney(impactData.unshippedValue)} · Finance approval may be needed` : 'Customers are refunded',
  };
  const effects = (impactData?.effects ?? []) as Array<{ area: string; effect: string }>;

  const suspendButton = !canSuspend ? null : pending ? (
    <Button variant="danger-soft" size="sm" icon="ban" disabled>
      Suspension pending
    </Button>
  ) : suspended ? null : (
    <Button variant="danger-soft" size="sm" icon="ban" to={href('admin/seller', 'suspend-seller', { slug })} onClick={(e) => (e.preventDefault(), openSuspend())}>
      Suspend
    </Button>
  );

  return (
    <AdminLayout active="sellers">
      <PageHeader
        crumbs={[{ label: 'Sellers', to: href('admin/sellers') }, { label: a.storeName }]}
        title={
          <span className="row gap-3">
            <LogoTile initials={initialsOf(a.storeName)} tint={tintOf(a.id)} />
            <span>{a.storeName}</span>
          </span>
        }
        sub={
          <>
            {[location, a.sellerSince ? `seller since ${monthYear(a.sellerSince)}` : '', owner.name ? `owner ${owner.name}` : '', manager ? `account manager ${manager}` : ''].filter(Boolean).join(' · ')} · {statusBadge}{' '}
            <span className="xs muted">{v.state === 'verified' ? 'Verified' : 'Not verified'}</span>
          </>
        }
        actions={
          <>
            {can('messaging.conversations.participate') && (
              <Button variant="secondary" size="sm" icon="mail" onClick={() => setMessage(true)}>
                Message seller
              </Button>
            )}
            {canRestrict && activeRestrictions[0]?.state === 'active' && (
              <Button variant="secondary" size="sm" icon="pencil" onClick={() => setEditing(activeRestrictions[0]!)}>
                Edit restriction
              </Button>
            )}
            {suspendButton}
          </>
        }
      />
      {flash && (
        <Alert tone="success" title={flash.title}>
          {flash.body}
        </Alert>
      )}
      {d.unavailable.length > 0 && (
        <Alert tone="info" title="Some details are not available">
          {d.unavailable.join(' · ')}
        </Alert>
      )}
      {activeRestrictions.map((r) => (
        <section key={r.id} className="card u-bc-warning">
          <div className="card-head">
            <div className="row gap-2">
              <Icon name="triangle-alert" />
              <h2 className="h4">{r.state === 'pending_approval' ? `Restriction waiting for approval: ${r.title}` : `Active restriction since ${date(r.startedAt ?? a.statusSince)}`}</h2>
            </div>
            <Badge tone="warning" icon="calendar">
              {`Review ${shortDate(r.reviewDate)}`}
            </Badge>
          </div>
          <div className="card-body">
            <KeyValue pairs={restrictionPairs(r)} />
            {r.pendingChange && <span className="xs t-warning-text strong">A change to this restriction is waiting for a second reviewer.</span>}
          </div>
        </section>
      ))}
      <div className="aa-split">
        <div className="stack gap-5">
          <Card title="Performance vs targets" sub={`Last ${windowDays} days · ${d.performance.orderCount} order${d.performance.orderCount === 1 ? '' : 's'}`} titleAs="h3">
            <div className="aa-perf">
              {metrics.map((m) => {
                const tone = metricTone(m.status);
                return (
                  <div key={m.key} className="aa-metric">
                    <span className="xs strong muted">{m.label}</span>
                    <span className="row between base">
                      <span className="v">{m.display}</span>
                      <span className="xs muted">{`Target ${m.target.display.replace(/^At least /, '≥ ').replace(/^At most /, '≤ ')}`}</span>
                    </span>
                    <Meter pct={meterPct(m.value, m.target)} tone={tone} label={`${m.display} target ${m.target.display}`} />
                    {tone === 'success' ? (
                      <span className="xs muted">{NOTE.success}</span>
                    ) : (
                      <>
                        <span className={`xs strong meter-note t-${tone}-text`}>{NOTE[tone]}</span>
                        {m.detail && <span className={`xs t-${tone}-text strong`}>{m.detail}</span>}
                      </>
                    )}
                  </div>
                );
              })}
            </div>
            <span className="xs muted">
              {violations ? `Policy violations in ${violations.target.windowDays} days: ${violations.display}. ` : ''}
              {feedback.positivePct != null && feedback.ratingCount ? `Seller feedback: ${Math.round(feedback.positivePct)}% positive from ${feedback.ratingCount} ratings.` : 'No seller feedback yet.'}
            </span>
          </Card>
          <Card title="Open obligations" sub="Stay accessible during any restriction or suspension" titleAs="h3" flush>
            <Tabs items={OB_KINDS.map((k) => ({ value: k, label: OB_META[k].tab, count: obligations[k].length }))} active={obTab} onChange={setObTab} />
            {screen.isLoading ? (
              <SkeletonLines rows={3} />
            ) : obRows.length ? (
              <TableWrap label="Open obligations table">
                <table className="table">
                  <thead>
                    <tr>
                      <th scope="col">{OB_META[obTab].col}</th>
                      <th scope="col">Item</th>
                      <th scope="col">Status</th>
                      <th scope="col">Deadline</th>
                    </tr>
                  </thead>
                  <tbody>
                    {obRows.map((r) => (
                      <tr key={r.key} className={cx(r.urgent && 'is-flagged')}>
                        <td>
                          {r.urgent && <span className="sr-only">Urgent: </span>}
                          {r.to ? (
                            <Link className="mono strong nowrap" to={r.to} title={r.ref}>
                              {r.ref}
                            </Link>
                          ) : (
                            <span className="mono strong nowrap">{r.ref}</span>
                          )}
                        </td>
                        <td>{r.item || <span className="muted">—</span>}</td>
                        <td>
                          <StatusBadge status={r.status} />
                        </td>
                        <td>{r.deadline ? <Deadline tone={r.deadline.tone}>{r.deadline.text}</Deadline> : <span className="muted">—</span>}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </TableWrap>
            ) : (
              <div className="card-body">
                <span className="small muted">{`No open ${OB_META[obTab].tab.toLowerCase()}.`}</span>
              </div>
            )}
            {obRows.some((r) => r.urgent) && (
              <p className="status-legend status-legend--edge">
                <span className="sr-only">Legend: </span>
                <span className="sl sl-danger">
                  <i aria-hidden="true" />
                  Red edge = urgent: overdue or past target
                </span>
              </p>
            )}
            {others.length > 0 && (
              <div className="card-body u-pt-sp-2">
                <span className="xs muted">
                  Also open: {others.map((k) => `${OB_META[k].tab.toLowerCase()} ${listRefs(obligations[k].map((r) => r.ref))}`).join(' · ')}.
                </span>
              </div>
            )}
          </Card>
          <Card title="Appeals" titleAs="h3" flush>
            {d.appeals.length ? (
              <TableWrap label="Appeals table">
                <table className="table">
                  <thead>
                    <tr>
                      <th scope="col">Appeal</th>
                      <th scope="col">Submitted</th>
                      <th scope="col">Argument</th>
                      <th scope="col">Owner</th>
                      <th scope="col">Status</th>
                    </tr>
                  </thead>
                  <tbody>
                    {d.appeals.map((ap) => {
                      const open = ap.state === 'submitted' || ap.state === 'under_review';
                      const decision = ap.decision as { outcome?: string; decidedAt?: string } | null | undefined;
                      return (
                        <tr key={ap.id}>
                          <td>
                            <span className="mono nowrap" title={ap.ref}>
                              {ap.ref}
                            </span>
                          </td>
                          <td>{shortDate(ap.submittedAt)}</td>
                          <td>
                            <span className="small">{ap.argument}</span>
                          </td>
                          <td>{ap.reviewer?.name ?? <span className="muted">Not assigned</span>}</td>
                          <td>
                            <span className="stack gap-1">
                              <StatusBadge status={cap(ap.state)} />
                              {open ? (
                                <Deadline tone={deadlineTone(ap.decideBy.state)}>{deadlineLabel(ap.decideBy.dueAt, 'Decide by')}</Deadline>
                              ) : decision?.outcome ? (
                                <span className="xs muted">{`${cap(decision.outcome)}${decision.decidedAt ? ` · ${shortDate(decision.decidedAt)}` : ''}`}</span>
                              ) : null}
                            </span>
                          </td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
              </TableWrap>
            ) : (
              <div className="card-body">
                <span className="small muted">No appeals.</span>
              </div>
            )}
          </Card>
          <Card
            title="Action history"
            titleAs="h3"
            actions={
              <Link className="small strong" to={href('admin/audit')}>
                Full log
              </Link>
            }
          >
            {history.length ? <HistoryTimeline events={history} /> : <span className="small muted">No actions recorded yet.</span>}
          </Card>
        </div>
        <div className="stack gap-5">
          <Card title="Account" titleAs="h3">
            <KeyValue pairs={accountKv} />
          </Card>
          <Card
            title="Payouts and holds"
            titleAs="h3"
            actions={
              <Link className="small strong" to={href('admin/payouts')}>
                Finance view
              </Link>
            }
          >
            {payouts ? (
              <>
                <div className="stack gap-2">
                  <SummaryRow k="Pending earnings" v={formatMoney(payouts.pending) || '—'} />
                  <SummaryRow k="Available" v={formatMoney(payouts.available) || '—'} />
                  <SummaryRow k="Held" v={payouts.held?.amount ? <span className="t-warning-text strong">{formatMoney(payouts.held)}</span> : formatMoney(payouts.held) || '—'} />
                </div>
                {(payouts.holds ?? []).map((h, i) => (
                  <div key={i} className="panel stack gap-1">
                    <span className="small strong">{`Hold · ${formatMoney(h.amount)}`}</span>
                    <span className="xs sub">{[h.reason ? `Reason: ${h.reason}.` : '', h.reviewDate ? `Review date ${shortDate(h.reviewDate)}.` : '', h.setBy?.name ? `Set by ${h.setBy.name}.` : ''].filter(Boolean).join(' ')}</span>
                  </div>
                ))}
                {payouts.nextPayout?.scheduledFor && (
                  <>
                    <div className="row between small">
                      <span>{`Next payout · ${shortDate(payouts.nextPayout.scheduledFor)}`}</span>
                      <StatusBadge status="Scheduled" />
                    </div>
                    <span className="xs muted">
                      {`${formatMoney(payouts.nextPayout.estimatedAmount)} to ${payouts.nextPayout.destination?.label ?? 'the payout account'}. `}
                      {payouts.nextPayout.note ? `${payouts.nextPayout.note}. ` : ''}Scheduled is not paid; the seller sees "Paid" only after the bank confirms.
                    </span>
                  </>
                )}
              </>
            ) : (
              <span className="small muted">Balances need finance access.</span>
            )}
          </Card>
          <Card title="Notes" titleAs="h3">
            {d.notes.map((n) => (
              <div key={n.id} className="aa-note">
                <span className="row between xs">
                  <b>{n.author.name ?? 'Staff'}</b>
                  <span className="muted">{shortDate(n.createdAt)}</span>
                </span>
                <span>{n.body}</span>
              </div>
            ))}
            {can('sellers.notes.write') ? (
              <>
                <Field label="Add a note" error={addNote.isError ? errorMessage(addNote.error) : undefined}>
                  <Textarea id="aa-sd-note" placeholder="Visible to staff only" value={note} onChange={(e) => setNote(e.target.value)} />
                </Field>
                {note.trim() && (
                  <Button size="sm" variant="secondary" disabled={addNote.isPending} onClick={() => addNote.mutate()}>
                    Save note
                  </Button>
                )}
              </>
            ) : (
              !d.notes.length && <span className="small muted">No notes.</span>
            )}
          </Card>
        </div>
      </div>

      <Dialog
        open={view === 'suspend-seller' && canSuspend && !pending}
        onClose={close}
        title={`Suspend ${a.storeName}`}
        size="lg"
        foot={
          <>
            <Button variant="ghost" onClick={close}>
              Cancel
            </Button>
            <Button variant="danger" icon="send" onClick={submit} disabled={suspend.isPending}>
              Send to second reviewer
            </Button>
          </>
        }
      >
        <Alert tone="danger" title="Suspension stops all new sales">
          Customers can no longer buy from {a.storeName}. Existing orders, returns and cases stay open and accessible to the seller and our teams until they are resolved.
        </Alert>
        {suspend.isError && (
          <Alert tone="danger" title="We couldn’t send the suspension">
            {errorMessage(suspend.error)}
          </Alert>
        )}
        <div className="stack gap-2">
          <span className="label">What happens</span>
          {impact.isLoading ? (
            <SkeletonLines rows={3} />
          ) : impact.isError ? (
            <LoadError error={impact.error} onRetry={() => void impact.refetch()} />
          ) : (
            <TableWrap label={`Suspend ${a.storeName} table`}>
              <table className="table">
                <thead>
                  <tr>
                    <th scope="col">Area</th>
                    <th scope="col">Effect</th>
                  </tr>
                </thead>
                <tbody>
                  {effects.map((e) => (
                    <tr key={e.area}>
                      <td>
                        <span className="small strong">{e.area}</span>
                      </td>
                      <td>
                        <span className="small">{e.effect}</span>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </TableWrap>
          )}
        </div>
        <div className="stack gap-2">
          <span className="label">Open orders</span>
          {SUSPEND_ORDER_OPTIONS.map((o) => (
            <OptionCard key={o.id} id={o.id} name="aa-ss-o" title={<span className="small strong">{o.title}</span>} body={orderBody[o.value]} checked={draft.orders === o.value} onChange={() => set('orders', o.value)} />
          ))}
        </div>
        <div className="grid md2 gap-3">
          <Field label="Reason" error={errors.reason}>
            <Select id="aa-ss-r" options={[{ value: '', label: 'Choose a reason' }, ...SUSPEND_REASONS]} value={draft.reason} onChange={(e) => set('reason', e.target.value as ReasonCode)} />
          </Field>
          <Field label="Review date" error={errors.date}>
            <TextInput id="aa-ss-d" type="date" min={isoDay(1)} value={draft.date} error={!!errors.date} onChange={(e) => set('date', e.target.value)} placeholder="" />
          </Field>
        </div>
        <Field label="Details shown to the seller" hint="Required. Include facts and what the seller can do to resolve it." error={errors.details}>
          <Textarea id="aa-ss-x" value={draft.details} onChange={(e) => set('details', e.target.value)} placeholder="" />
        </Field>
        <div className="well stack gap-2">
          <Field label="Second reviewer" hint="Suspension takes effect only after a second reviewer approves." error={errors.reviewer ?? (members.isError ? `We couldn’t load the eligible reviewers: ${errorMessage(members.error)}` : undefined)}>
            <Select
              id="aa-ss-rv"
              options={[{ value: '', label: members.isLoading ? 'Loading…' : 'Choose a reviewer' }, ...reviewers.map((m) => ({ value: m.accountId, label: `${m.name} · ${m.roleLabel ?? 'Staff'}${m.away ? ' · away' : ''}` }))]}
              value={draft.reviewer}
              onChange={(e) => set('reviewer', e.target.value)}
            />
          </Field>
          <span className="xs muted">Appeal route: seller can appeal in Seller Center within 14 days. Appeals are decided by someone who did not make this decision.</span>
        </div>
      </Dialog>

      {editing && <EditRestriction r={editing} onClose={() => setEditing(null)} onDone={(t, b) => (setFlash({ title: t, body: b }), refresh())} />}
      <MessageDialog open={message} onClose={() => setMessage(false)} to={a.storeName} target={{ sellerId }} onSent={(b) => setFlash({ title: 'Message sent', body: b })} />
    </AdminLayout>
  );
}

/** Edit an active restriction (reason, how to resolve, review date) with a reason for the change. */
function EditRestriction({ r, onClose, onDone }: { r: Restriction; onClose: () => void; onDone: (title: string, body: string) => void }) {
  const { api } = useApi();
  const [reason, setReason] = useState(r.reason);
  const [toResolve, setToResolve] = useState(r.toResolve);
  const [reviewDate, setReviewDate] = useState(r.reviewDate.slice(0, 10));
  const [why, setWhy] = useState('');
  const [tried, setTried] = useState(false);
  const save = useMutation({
    mutationFn: () =>
      call(
        api.PATCH('/api/admin/sellers/restrictions/{id}', {
          params: { path: { id: r.id } },
          body: { reason: reason.trim(), toResolve: toResolve.trim(), reviewDate, changeReason: why.trim() },
        }),
      ),
    onSuccess: (res) => {
      onDone(res.pendingChange ? 'Change sent for approval' : 'Restriction updated', res.pendingChange ? `The change waits for ${res.approval?.approvers.join(' or ') || 'a second reviewer'}. The current restriction stays in force until then.` : `${res.title} was updated. The seller sees the new details.`);
      onClose();
    },
  });
  const whyError = tried && !why.trim() ? 'Say why you are changing the restriction.' : undefined;
  return (
    <Dialog
      open
      onClose={onClose}
      title="Edit restriction"
      foot={
        <>
          <Button variant="ghost" onClick={onClose}>
            Cancel
          </Button>
          <Button
            disabled={save.isPending}
            onClick={() => {
              setTried(true);
              if (why.trim() && reason.trim() && toResolve.trim() && reviewDate) save.mutate();
            }}
          >
            Save changes
          </Button>
        </>
      }
    >
      {save.isError && (
        <Alert tone="danger" title="We couldn’t save the change">
          {errorMessage(save.error)}
        </Alert>
      )}
      <Field label="Reason shown to the seller">
        <Textarea id="aa-er-reason" value={reason} onChange={(e) => setReason(e.target.value)} />
      </Field>
      <Field label="To resolve">
        <Textarea id="aa-er-resolve" value={toResolve} onChange={(e) => setToResolve(e.target.value)} />
      </Field>
      <Field label="Review date">
        <TextInput id="aa-er-date" type="date" value={reviewDate} onChange={(e) => setReviewDate(e.target.value)} />
      </Field>
      <Field label="Reason for the change" hint="Recorded in the audit log." error={whyError}>
        <Textarea id="aa-er-why" value={why} onChange={(e) => setWhy(e.target.value)} />
      </Field>
      <span className="xs muted">Open orders, returns, cases and messages keep working.</span>
    </Dialog>
  );
}

/** ["a", "b"] -> "a and b"; ["a", "b", "c"] -> "a, b, c" (as in the design copy). */
function listRefs(refs: string[]) {
  return refs.length === 2 ? `${refs[0]} and ${refs[1]}` : refs.join(', ');
}
