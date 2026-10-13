import { useEffect, useRef, useState, type ReactNode } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Link, useParams } from 'react-router';
import { ApiError, call, errorMessage, newIdempotencyKey, useApi } from '@marketly/web-shared/api';
import { AdminLayout } from '@marketly/web-shared/layouts';
import { cx } from '@marketly/web-shared/lib/cx';
import { formatMoney, initials } from '@marketly/web-shared/lib/format';
import { useView } from '@marketly/web-shared/lib/hooks';
import { href } from '@marketly/web-shared/routes';
import {
  Alert, Avatar, Badge, Button, Card, Checkbox, Deadline, Dialog, Field, Icon, Img, KeyValue, LogoTile, OptionCard, PageHeader, Price, SegmentedControl, Select, StatusBadge, Textarea, TextInput, announce,
  type Tone,
} from '@marketly/web-shared/ui';
import { useStaffSession } from '@/app/session';
import { LoadError, SkeletonLines, date, dateTime, dayKey, deadlineLabel, deadlineTone } from '@/app/parts';
import { STEP_UP_HINT, needsStepUp, sentForApproval, stepUpHeader, type FeeRules } from './data/finance';
import { useDebounced } from './data/customers';
import {
  CHARGED, ESCALATE_TO, OUTCOMES, OUTCOME_LABEL, PRIORITY_LABEL, REMEDY_LABEL, pacificEndOfDay, toMinor,
  type ApiPriority, type Assignee, type CaseDetail, type CaseMessage, type CaseRow, type ChargedTo, type DecisionInput, type Outcome,
} from './data/cases';

// Design: pages/admin/admin-case.html (investigating) · view "decision-recorded" = after "Record decision and send to Finance".
// Data: the route's CS-… ref resolves through GET /api/admin/support/cases?q=<ref> to the case id; then
// GET /support/cases/{id} (case file), /payments/orders/{orderId}/refundable (refund cap), /finance/fee-rules
// (earnings estimate; refundImpactPreview in the AdminCase query fails on Money.formatted, G37) and
// POST /access/authority-checks (the decider's approval limit). Writes: messages, assign, escalate,
// decision-draft, decide (Idempotency-Key, step-up code), resolve. "decision-recorded" follows the case's decision.

/* ---------------- Evidence ---------------- */

interface Ev {
  t: string;
  d: string;
  state: 'done' | 'current' | 'warn' | 'danger';
  body?: string | null;
}

/** Timeline with the design's "At risk:" prefix on warning events (the shared Timeline has none). */
function EvTimeline({ events }: { events: Ev[] }) {
  return (
    <ol className="timeline">
      {events.map((e, i) => (
        <li key={i} className={`ev is-${e.state}`}>
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

/* ---------------- Conversation ---------------- */

type MsgKind = 'customer' | 'seller' | 'staff' | 'note';
const MSG: Record<CaseMessage['role'], { kind: MsgKind; badge: string; tone: Tone }> = {
  customer: { kind: 'customer', badge: 'Customer', tone: '' },
  seller: { kind: 'seller', badge: 'Seller', tone: 'info' },
  marketly_staff: { kind: 'staff', badge: 'Marketly staff', tone: 'brand' },
  internal_note: { kind: 'note', badge: 'Internal note', tone: 'warning' },
  system: { kind: 'staff', badge: 'Marketly', tone: 'brand' },
};
const AUDIENCE_SUFFIX: Record<CaseMessage['audience'], string> = { all: ' · to both parties', customer: ' · to customer', seller: ' · to seller', internal: '' };

type Audience = 'both' | 'customer' | 'seller' | 'note';
const AUDIENCES: Array<{ value: Audience; label: string }> = [
  { value: 'both', label: 'Reply to both' },
  { value: 'customer', label: 'Customer only' },
  { value: 'seller', label: 'Seller only' },
  { value: 'note', label: 'Internal note' },
];
const API_AUDIENCE: Record<Audience, CaseMessage['audience']> = { both: 'all', customer: 'customer', seller: 'seller', note: 'internal' };

/* ---------------- Decision ---------------- */

type RemedyChoice = 'refund' | 'replacement' | 'partial_refund';
const REMEDIES: Array<{ value: RemedyChoice; title: string; body: string }> = [
  { value: 'refund', title: 'Refund the item', body: 'Customer keeps the order if it arrives and may return it free' },
  { value: 'replacement', title: 'Replacement by a deadline', body: 'Seller ships with tracking by the deadline; refund if no carrier scan' },
  { value: 'partial_refund', title: 'Partial refund', body: 'For a delay the customer accepts' },
];

interface Draft {
  outcome: Outcome;
  remedy: RemedyChoice;
  amount: string;
  charged: ChargedTo;
  reason: string;
  appeal: string;
  notify: boolean;
}

const plusDays = (n: number) => dayKey(new Date(Date.now() + n * 86_400_000));
const dollarsText = (minor: number) => (minor / 100).toFixed(2);

function validate(d: Draft, max: number | null) {
  const e: Partial<Record<keyof Draft, string>> = {};
  if (d.remedy !== 'replacement') {
    const n = toMinor(d.amount);
    if (Number.isNaN(n) || n <= 0) e.amount = 'Enter the refund amount.';
    else if (max != null && n > max) e.amount = `The most you can refund for this item is ${formatMoney({ amount: max, currency: 'USD' })}.`;
  }
  if (!d.reason.trim()) e.reason = 'Enter the reason. Both parties see it with the decision.';
  if (!/^\d{4}-\d{2}-\d{2}$/.test(d.appeal)) e.appeal = 'Enter the appeal deadline.';
  return e;
}

function toInput(d: Draft, itemIds: string[]): DecisionInput {
  const amount = d.remedy === 'replacement' ? null : { amount: toMinor(d.amount), currency: 'USD' };
  return {
    outcome: d.outcome,
    remedies: [{ kind: d.remedy, amount, chargedTo: d.charged, orderItemIds: itemIds.length ? itemIds : null, dueAt: d.remedy === 'replacement' ? pacificEndOfDay(plusDays(4)) : null }],
    reason: d.reason.trim(),
    appealDeadline: pacificEndOfDay(d.appeal),
    notifyParties: d.notify,
  };
}

function fromInput(x: DecisionInput, fallback: Draft): Draft {
  const r = x.remedies[0];
  const remedy: RemedyChoice = r?.kind === 'replacement' || r?.kind === 'partial_refund' ? r.kind : 'refund';
  return {
    outcome: x.outcome,
    remedy,
    amount: r?.amount ? dollarsText(r.amount.amount) : fallback.amount,
    charged: (r?.chargedTo as ChargedTo | undefined) ?? fallback.charged,
    reason: x.reason,
    appeal: x.appealDeadline ? dayKey(x.appealDeadline) : fallback.appeal,
    notify: x.notifyParties,
  };
}

function SumList({ rows }: { rows: Array<[string, ReactNode]> }) {
  return (
    <div className="ab-sumlist">
      {rows.map(([k, v]) => (
        <div key={k}>
          <span>{k}</span>
          <span>{v}</span>
        </div>
      ))}
    </div>
  );
}

const EV_STATE = (i: number, n: number): Ev['state'] => (i === n - 1 ? 'current' : 'done');

/** Resolves the route's CS-… ref to the case id: open cases first, then closed ones. */
async function resolveCaseId(api: ReturnType<typeof useApi>['api'], ref: string): Promise<string | null> {
  for (const tab of ['all_open', 'closed'] as const) {
    const page = await call(api.GET('/api/admin/support/cases', { params: { query: { tab, q: ref, limit: 10 } } }));
    const hit = (page.items as CaseRow[]).find((c) => c.ref === ref);
    if (hit) return hit.id;
  }
  return null;
}

export default function Case() {
  const { api } = useApi();
  const qc = useQueryClient();
  const { can, accountId, name: myName } = useStaffSession();
  const { ref = '' } = useParams();
  const [view, setView] = useView<'decision-recorded'>();
  const [draft, setDraft] = useState<Draft | null>(null);
  const [attempted, setAttempted] = useState(false);
  const [audience, setAudience] = useState<Audience>('both');
  const [reply, setReply] = useState('');
  const [replyErr, setReplyErr] = useState('');
  const [notice, setNotice] = useState<{ tone: 'success' | 'info' | 'danger'; title: string; body: string } | null>(null);
  const [code, setCode] = useState('');
  const [askCode, setAskCode] = useState(false);
  const decideKey = useRef(newIdempotencyKey());
  const [side, setSide] = useState<null | 'assign' | 'escalate'>(null);
  const [assignTo, setAssignTo] = useState('');
  const [escalateTo, setEscalateTo] = useState<(typeof ESCALATE_TO)[number]['value']>('support_lead');
  const [sideReason, setSideReason] = useState('');
  const [sideErr, setSideErr] = useState('');

  const canHandle = can('support.cases.handle');
  const canAssign = can('support.cases.assign');
  const canDecide = can('support.disputes.decide');

  const idQ = useQuery({ queryKey: ['support', 'case', 'resolve', ref], queryFn: () => resolveCaseId(api, ref), staleTime: Infinity });
  const caseId = idQ.data ?? undefined;
  const detail = useQuery({
    queryKey: ['support', 'case', caseId],
    queryFn: () => call(api.GET('/api/admin/support/cases/{id}', { params: { path: { id: caseId! } } })) as Promise<CaseDetail>,
    enabled: !!caseId,
  });
  const data = detail.data;
  const c = data?.case;
  const orderId = c?.order?.id;
  const refundable = useQuery({
    queryKey: ['payments', 'refundable', orderId],
    queryFn: () => call(api.GET('/api/admin/payments/orders/{orderId}/refundable', { params: { path: { orderId: orderId! } } })),
    enabled: !!orderId && canDecide,
    retry: false,
  });
  const fees = useQuery({ queryKey: ['finance', 'fee-rules'], queryFn: () => call(api.GET('/api/admin/finance/fee-rules')) as Promise<FeeRules>, enabled: can('finance.ledger.view'), retry: false });
  const assignees = useQuery({ queryKey: ['support', 'assignees'], queryFn: () => call(api.GET('/api/admin/support/assignees')) as Promise<Assignee[]>, enabled: canAssign && side === 'assign' });

  const itemIds = (c?.items ?? []).map((i) => i.orderItemId);
  const refundItems = (refundable.data?.items ?? []).filter((i) => !itemIds.length || itemIds.includes(i.orderItemId));
  const maxRefund = refundable.data ? refundItems.reduce((n, i) => n + i.remaining.amount, 0) : null;
  const paidTotal = refundItems.reduce((n, i) => n + i.paid.amount, 0);

  const defaults: Draft = {
    outcome: 'customer_favored',
    remedy: 'refund',
    amount: maxRefund != null ? dollarsText(maxRefund) : '',
    charged: 'seller',
    reason: '',
    appeal: plusDays(7),
    notify: true,
  };
  // The form starts from the saved draft, otherwise from the refund cap once it is known.
  useEffect(() => {
    if (draft || !data) return;
    if (data.decisionDraft) setDraft(fromInput(data.decisionDraft.draft, defaults));
    else if (maxRefund != null || !orderId || refundable.isError || !canDecide) setDraft(defaults);
  }, [data, maxRefund, draft, orderId, refundable.isError, canDecide]); // eslint-disable-line react-hooks/exhaustive-deps

  const form = draft ?? defaults;
  const refundMinor = form.remedy === 'replacement' ? 0 : toMinor(form.amount) || 0;
  const checkAmount = useDebounced(refundMinor, 400);
  const authority = useQuery({
    queryKey: ['access', 'authority', 'support.remedies.approve', checkAmount],
    queryFn: () => call(api.POST('/api/admin/access/authority-checks', { body: { action: 'support.remedies.approve', amount: { money: { amount: checkAmount, currency: 'USD' } } } })),
    enabled: canDecide && checkAmount > 0 && form.charged !== 'seller' && !c?.decision,
    retry: false,
  });

  const errors = attempted ? validate(form, maxRefund) : {};
  const set = <K extends keyof Draft>(k: K, v: Draft[K]) => setDraft({ ...form, [k]: v });
  const rateBps = fees.data?.active.defaultRateBps;
  const feeShare = rateBps != null ? Math.round((refundMinor * rateBps) / 10_000) : null;

  const refresh = () => {
    void qc.invalidateQueries({ queryKey: ['support', 'case', caseId] });
    void qc.invalidateQueries({ queryKey: ['support', 'cases'] });
    void qc.invalidateQueries({ queryKey: ['workqueues', 'queues'] });
  };

  const send = useMutation({
    mutationFn: (v: { body: string; audience: CaseMessage['audience'] }) => call(api.POST('/api/admin/support/cases/{id}/messages', { params: { path: { id: caseId! } }, body: v })),
    onSuccess: () => {
      setReply('');
      setReplyErr('');
      refresh();
      announce('Message sent');
    },
    onError: (e) => setReplyErr(errorMessage(e)),
  });
  const saveDraft = useMutation({
    mutationFn: (x: DecisionInput) => call(api.PUT('/api/admin/support/cases/{id}/decision-draft', { params: { path: { id: caseId! } }, body: x })),
    onSuccess: () => {
      announce('Draft saved');
      setNotice({ tone: 'success', title: 'Draft saved', body: 'Only staff see the draft. Nothing is sent to the parties until you record the decision.' });
      void qc.invalidateQueries({ queryKey: ['support', 'case', caseId] });
    },
    onError: (e) => setNotice({ tone: 'danger', title: 'The draft wasn’t saved', body: errorMessage(e) }),
  });
  const decide = useMutation({
    mutationFn: (v: { input: DecisionInput; code: string }) =>
      call(
        api.POST('/api/admin/support/cases/{id}/decide', {
          params: { path: { id: caseId! }, header: { 'Idempotency-Key': decideKey.current, ...stepUpHeader(v.code) } as { 'Idempotency-Key': string } },
          body: v.input,
        }),
      ) as Promise<CaseDetail>,
    onSuccess: (r) => {
      qc.setQueryData(['support', 'case', caseId], r);
      refresh();
      setAskCode(false);
      setView('decision-recorded');
      announce(r.pendingApproval ? 'Decision sent for approval' : 'Decision recorded');
      setNotice(
        r.pendingApproval
          ? { tone: 'info', title: 'Decision sent for approval', body: r.pendingApproval.reason ?? `The remedy is above your limit. ${r.pendingApproval.approvers.join(', ') || 'Finance'} approves it before the refund is sent.` }
          : null,
      );
    },
    onError: (e) => {
      if (needsStepUp(e)) {
        setAskCode(true);
        decideKey.current = newIdempotencyKey();
      } else if (sentForApproval(e)) {
        refresh();
        setNotice({ tone: 'info', title: 'Decision sent for approval', body: 'The remedy is above your limit. It was sent to an approver; nothing is published until it is approved.' });
      }
    },
  });
  const assign = useMutation({
    mutationFn: (v: { ownerId: string; reason: string }) => call(api.POST('/api/admin/support/cases/{id}/assign', { params: { path: { id: caseId! } }, body: { ownerId: v.ownerId, reason: v.reason || null } })),
    onSuccess: () => {
      refresh();
      setSide(null);
      announce('Case reassigned');
    },
    onError: (e) => setSideErr(errorMessage(e)),
  });
  const escalate = useMutation({
    mutationFn: (v: { to: (typeof ESCALATE_TO)[number]['value']; reason: string }) => call(api.POST('/api/admin/support/cases/{id}/escalate', { params: { path: { id: caseId! } }, body: v })),
    onSuccess: (_r, v) => {
      refresh();
      setSide(null);
      setNotice({ tone: 'success', title: `Escalated to ${ESCALATE_TO.find((x) => x.value === v.to)?.label}`, body: 'The team is notified and the case moves to their queue.' });
    },
    onError: (e) => setSideErr(errorMessage(e)),
  });
  const resolve = useMutation({
    mutationFn: (summary: string) => call(api.POST('/api/admin/support/cases/{id}/resolve', { params: { path: { id: caseId! } }, body: { summary } })),
    onSuccess: () => {
      refresh();
      announce('Case resolved');
    },
    onError: (e) => setNotice({ tone: 'danger', title: 'The case wasn’t resolved', body: errorMessage(e) }),
  });

  const record = () => {
    setAttempted(true);
    if (Object.keys(validate(form, maxRefund)).length) return;
    if (askCode && !/^\d{6}$/.test(code.trim())) return;
    decide.mutate({ input: toInput(form, itemIds), code: code.trim() });
  };
  const doSend = () => {
    if (!reply.trim()) {
      setReplyErr('Write a message before sending.');
      return;
    }
    send.mutate({ body: reply.trim(), audience: API_AUDIENCE[audience] });
  };
  const openSide = (k: 'assign' | 'escalate') => {
    setSide(k);
    setSideReason('');
    setSideErr('');
    setAssignTo('');
  };
  const doSide = () => {
    if (side === 'assign') {
      const owner = assignTo || accountId;
      assign.mutate({ ownerId: owner, reason: sideReason.trim() });
    } else if (side === 'escalate') {
      if (!sideReason.trim()) {
        setSideErr('Enter the reason for the escalation.');
        return;
      }
      escalate.mutate({ to: escalateTo, reason: sideReason.trim() });
    }
  };

  /* ---------- states ---------- */

  const notFound = idQ.isSuccess && idQ.data === null;
  const loadErr = idQ.error ?? detail.error;
  const crumbs = [{ label: 'Cases and disputes', to: href('admin/cases') }, { label: ref }];
  if (notFound || (detail.error instanceof ApiError && detail.error.status === 404)) {
    return (
      <AdminLayout active="cases">
        <PageHeader crumbs={crumbs} title={`Case ${ref}`} />
        <Alert tone="warning" title="Case not found">
          No case matches {ref}.{' '}
          <Link to={href('admin/cases')}>Back to cases and disputes</Link>
        </Alert>
      </AdminLayout>
    );
  }
  if (loadErr || !c || !data) {
    return (
      <AdminLayout active="cases">
        <PageHeader crumbs={crumbs} title={`Case ${ref}`} />
        {loadErr ? (
          <LoadError error={loadErr} onRetry={() => void (idQ.error ? idQ.refetch() : detail.refetch())} />
        ) : (
          <div className="ab-main wide">
            <div className="stack gap-5">
              <div className="card pad">
                <SkeletonLines rows={4} />
              </div>
              <div className="card pad">
                <SkeletonLines rows={6} />
              </div>
            </div>
            <div className="card pad">
              <SkeletonLines rows={6} />
            </div>
          </div>
        )}
      </AdminLayout>
    );
  }

  /* ---------- page ---------- */

  const decision = c.decision;
  const decided = !!decision || (view === 'decision-recorded' && !!data.pendingApproval);
  const isDispute = c.kind === 'dispute';
  const item = c.items[0];
  const customer = data.customer;
  const seller = data.seller;
  const terms = data.purchaseTerms;
  const owner = data.owner?.name;
  const open = !['resolved', 'closed'].includes(c.status);
  const photos = data.evidence.flatMap((e) => e.media.map((m) => ({ m, caption: `${e.party === 'customer' ? 'Customer' : e.party === 'seller' ? 'Seller' : 'Staff'}: ${e.note ?? e.kind}, ${date(e.at)}` })));
  const conversation = c.messages;
  const remedies = c.remedies;
  const refundRemedy = remedies.find((r) => r.amount);
  const remediesDone = remedies.every((r) => r.status === 'completed' || r.status === 'cancelled');
  const needsApproval = authority.data?.decision === 'approval_required';
  const chargedText = CHARGED.find((x) => x.value === form.charged)!.text;

  return (
    <AdminLayout active="cases">
      <PageHeader
        crumbs={crumbs}
        eyebrow={`${isDispute ? 'Dispute' : 'Case'} · ${c.category.label}`}
        title={`${isDispute ? 'Dispute' : 'Case'} ${c.ref}`}
        sub={
          <>
            {c.order && (
              <>
                Order{' '}
                <Link className="mono nowrap" to={href('admin/order', '', { ref: c.order.ref })}>
                  {c.order.ref}
                </Link>{' '}
                ·{' '}
              </>
            )}
            {item ? `${item.title} · ` : ''}opened {date(c.openedAt)}
            {c.status === 'reopened' ? ' · reopened' : ''}
          </>
        }
        actions={
          <>
            <StatusBadge status={c.statusLabel} />
            <Badge tone={c.priority === 'high' || c.priority === 'urgent' ? 'danger' : c.priority === 'medium' ? 'warning' : ''} icon={c.priority === 'high' || c.priority === 'urgent' ? 'arrow-up' : undefined}>
              {PRIORITY_LABEL[c.priority as ApiPriority]}
            </Badge>
            {canAssign && open && (
              <Button variant="secondary" size="sm" icon="user-round" onClick={() => openSide('assign')}>
                Reassign
              </Button>
            )}
            {canHandle && c.can.escalate && open && (
              <Button variant="secondary" size="sm" icon="arrow-up-right" onClick={() => openSide('escalate')}>
                Escalate
              </Button>
            )}
          </>
        }
      />
      {notice && (
        <Alert tone={notice.tone} title={notice.title}>
          {notice.body}
        </Alert>
      )}
      <div className="card pad">
        <div className="row between gap-4">
          {decision ? (
            <>
              <span className="row gap-2">
                <Icon name="circle-check" />
                <span className="stack gap-0">
                  <b className="small">Decision published {decision.publishedAt ? dateTime(decision.publishedAt) : dateTime(decision.decidedAt)}</b>
                  <span className="xs muted">
                    Next: {c.nextAction.label}
                    {decision.appealDeadline ? ` · appeal window open until ${date(decision.appealDeadline)}` : ''}
                  </span>
                </span>
              </span>
              {decision.appealDeadline && <Deadline>Appeal window: until {date(decision.appealDeadline)}</Deadline>}
            </>
          ) : (
            <>
              <span className="row gap-4">
                {data.deadlines.length ? (
                  data.deadlines.map((dl) => (
                    <Deadline key={dl.label} tone={deadlineTone(dl.deadline.state)}>
                      {dl.label}: {deadlineLabel(dl.deadline.dueAt, '').replace(/^ /, '')}
                    </Deadline>
                  ))
                ) : (
                  <span className="xs muted">No open deadlines</span>
                )}
              </span>
              <span className="xs muted">
                Owner {owner ?? 'unassigned'}
                {data.financeReviewer?.name ? ` · Finance reviewer ${data.financeReviewer.name}` : ''}
              </span>
            </>
          )}
        </div>
      </div>
      <div className="ab-main wide">
        <div className="stack gap-5">
          <div className="grid md2 gap-4">
            <Card title="Customer">
              {customer ? (
                <>
                  <div className="row gap-3">
                    <Avatar name={customer.name} />
                    <span className="ab-cell">
                      <span className="strong">{customer.id ? <Link to={href('admin/customers', 'customer-detail', undefined, { customer: customer.id })}>{customer.name}</Link> : customer.name}</span>
                      <span className="xs muted">
                        {[customer.location, `${customer.orders} ${customer.orders === 1 ? 'order' : 'orders'}`, `${customer.openCases} open ${customer.openCases === 1 ? 'case' : 'cases'}`].filter(Boolean).join(' · ')}
                      </span>
                    </span>
                  </div>
                  <KeyValue pairs={[['Asks for', customer.asksFor ?? '—'], ['Contact', customer.email ?? '—']]} />
                </>
              ) : (
                <p className="small sub">No customer on this case.</p>
              )}
            </Card>
            <Card title="Seller" titleAs="h3">
              {seller ? (
                <>
                  <div className="row gap-3">
                    <LogoTile initials={initials(seller.name)} tint="1" />
                    <span className="ab-cell">
                      <span className="strong">{seller.id && seller.ownerType === 'seller' ? <Link to={href('admin/seller', '', { slug: seller.id })}>{seller.name}</Link> : seller.name}</span>
                      <span className="xs muted">{[seller.location, seller.verified ? 'Verified seller' : null].filter(Boolean).join(' · ')}</span>
                    </span>
                  </div>
                  <KeyValue
                    pairs={[
                      ['Offers', seller.offers ?? '—'],
                      ['On-time dispatch', seller.onTimeDispatchPct != null ? <span className={cx(seller.onTimeDispatchPct < 95 && 't-warning-text')}>{seller.onTimeDispatchPct}% this month</span> : '—'],
                    ]}
                  />
                </>
              ) : (
                <p className="small sub">No seller on this case.</p>
              )}
            </Card>
          </div>
          {terms && (
            <Card title="Purchase terms at time of order" titleAs="h3" sub={`Snapshot taken ${dateTime(terms.snapshotAt)} · purchase terms v${terms.termsVersion}`}>
              <div className="row top gap-4">
                <Img icon="package" tint="1" className="thumb" src={item?.imageUrl ?? undefined} alt="" />
                <div className="grow">
                  <KeyValue
                    pairs={[
                      ['Item', terms.item],
                      [
                        'Price paid',
                        <>
                          <Price amount={terms.pricePaid.amount / 100} was={terms.listPrice ? terms.listPrice.amount / 100 : null} /> {terms.discountNote && <span className="xs muted">{terms.discountNote}</span>}
                        </>,
                      ],
                      ['Promised delivery', `${terms.promisedDelivery}${terms.dispatchBy ? ` · dispatch by ${date(terms.dispatchBy)}` : ''}`],
                      ['Shipping', terms.shipping],
                      ['Returns', terms.returns],
                      ['Payment', terms.payment],
                    ]}
                  />
                </div>
              </div>
            </Card>
          )}
          <Card title="Shipment evidence" titleAs="h3">
            {data.shipmentEvidence.length ? (
              <EvTimeline events={data.shipmentEvidence.map((e, i, a) => ({ t: e.label, d: dateTime(e.at), state: EV_STATE(i, a.length), body: e.detail }))} />
            ) : (
              <p className="small sub">No shipment recorded for this order.</p>
            )}
          </Card>
          <Card title="Photos and files" titleAs="h3" sub={`${photos.length} ${photos.length === 1 ? 'file' : 'files'} · uploaded by parties`}>
            {photos.length ? (
              <div className="ab-photos">
                {photos.map((p) => (
                  <figure key={p.m.id}>
                    <Img icon="image" tint="3" className="r43" src={p.m.url} alt={p.m.alt ?? ''} />
                    <figcaption>{p.caption}</figcaption>
                  </figure>
                ))}
              </div>
            ) : (
              <p className="small sub">No photos or files yet.</p>
            )}
          </Card>
          <Card title="Conversation" titleAs="h3" sub="Customer, seller and staff messages in one place. Internal notes are never shown to the parties.">
            <div className="ab-conv">
              {conversation.length === 0 && <p className="small sub">No messages yet.</p>}
              {conversation.map((m) => {
                const k = m.audience === 'internal' ? MSG.internal_note : MSG[m.role];
                return (
                  <div key={m.id} className={`ab-msg is-${k.kind}`}>
                    <span className="who">
                      <b>{m.authorLabel}</b>
                      <Badge tone={k.tone}>{k.badge}</Badge>
                      <span>
                        {dateTime(m.at)}
                        {k.kind === 'staff' ? AUDIENCE_SUFFIX[m.audience] : ''}
                      </span>
                    </span>
                    <p>{m.body}</p>
                  </div>
                );
              })}
            </div>
            {canHandle && c.can.reply ? (
              <div className="stack gap-2">
                <SegmentedControl items={AUDIENCES} active={audience} onChange={setAudience} />
                <Field label="Message" error={replyErr || undefined}>
                  <Textarea
                    id="cd-reply"
                    placeholder={audience === 'note' ? 'Write an internal note' : 'Write a reply'}
                    value={reply}
                    onChange={(e) => {
                      setReply(e.target.value);
                      if (replyErr) setReplyErr('');
                    }}
                  />
                </Field>
                <div className="row between">
                  <Button variant="ghost" size="sm" icon="paperclip" disabled title="Attaching files from the case page isn’t available yet">
                    Attach file
                  </Button>
                  <Button size="sm" icon="send" onClick={doSend} disabled={send.isPending}>
                    Send
                  </Button>
                </div>
              </div>
            ) : (
              <p className="xs muted">{canHandle ? 'Replies are closed on this case.' : 'Your role can read this case but not reply.'}</p>
            )}
          </Card>
        </div>
        <div className="stack gap-5">
          {decided && decision ? (
            <Card
              title="Decision"
              titleAs="h3"
              sub={`Recorded ${dateTime(decision.decidedAt)}${decision.decidedBy.name ? ` by ${decision.decidedBy.name}` : ''}`}
              foot={
                <>
                  {canHandle && c.can.reply && (
                    <Button variant="secondary" size="sm" onClick={() => document.getElementById('cd-reply')?.focus()}>
                      Add update
                    </Button>
                  )}
                  {canHandle && (
                    <Button size="sm" disabled={!open || !remediesDone || resolve.isPending} title={remediesDone ? undefined : 'The case closes after every remedy is complete'} onClick={() => resolve.mutate(decision.reason)}>
                      Resolve case
                    </Button>
                  )}
                </>
              }
            >
              <Alert tone="success" title={`${OUTCOME_LABEL[decision.outcome as Outcome] ?? decision.outcome}: ${remedies.map((r) => REMEDY_LABEL[r.kind]).join(', ') || 'no remedy'}`}>
                {decision.reason}
              </Alert>
              <SumList
                rows={[
                  ...(refundRemedy?.amount ? ([['Refund to customer', <b>{formatMoney(refundRemedy.amount)}</b>]] as Array<[string, ReactNode]>) : []),
                  ...(terms ? ([['Item price paid', formatMoney(terms.pricePaid)]] as Array<[string, ReactNode]>) : []),
                  ...(refundRemedy?.chargedTo ? ([['Charged to', CHARGED.find((x) => x.value === refundRemedy.chargedTo)?.label ?? refundRemedy.chargedTo]] as Array<[string, ReactNode]>) : []),
                ]}
              />
              <div className="divider" />
              <ul className="ab-approvals">
                <li>
                  <span className="n is-done">
                    <Icon name="check" className="ic-sm" />
                  </span>
                  <span className="ab-cell">
                    <span className="strong">{decision.decidedBy.name ?? 'Marketly'} · Support</span>
                    <span className="xs muted">Decision recorded {dateTime(decision.decidedAt)}</span>
                  </span>
                  <StatusBadge status="Decision made" />
                </li>
                {remedies.map((r) => (
                  <li key={r.id}>
                    <span className={cx('n', r.status === 'completed' && 'is-done')}>{r.status === 'completed' ? <Icon name="check" className="ic-sm" /> : <Icon name="loader" className="ic-sm" />}</span>
                    <span className="ab-cell">
                      <span className="strong">
                        {REMEDY_LABEL[r.kind].charAt(0).toUpperCase() + REMEDY_LABEL[r.kind].slice(1)}
                        {r.amount ? ` ${formatMoney(r.amount)}` : ''}
                      </span>
                      <span className="xs muted">{[r.destination, r.note].filter(Boolean).join(' · ')}</span>
                    </span>
                    <StatusBadge status={r.statusLabel} />
                  </li>
                ))}
              </ul>
              {refundRemedy && refundRemedy.status !== 'completed' && (
                <Alert tone="info" title={refundRemedy.status === 'pending_approval' ? 'Refund waiting for approval' : 'Refund approved, not yet received'}>
                  {refundRemedy.status === 'pending_approval'
                    ? 'Finance approves the refund within their limit before it is sent. The case stays open until the refund shows Sent.'
                    : 'The customer sees Processing until the card network confirms. The case stays open until the refund shows Sent.'}
                </Alert>
              )}
              <KeyValue
                pairs={[
                  ['Appeal deadline', <b>{decision.appealDeadline ? dateTime(decision.appealDeadline) : '—'}</b>],
                  ['Published to', decision.publishedAt ? `${[customer?.name, seller?.name].filter(Boolean).join(' and ')} · ${dateTime(decision.publishedAt)}` : 'Not sent yet: use Add update to notify the parties'],
                  ['Appeal route', decision.appealRoute],
                  ...(c.appeal ? ([['Appeal', `${c.appeal.status}${c.appeal.reviewer?.name ? ` · reviewer ${c.appeal.reviewer.name}` : ''}`]] as Array<[string, ReactNode]>) : []),
                ]}
              />
            </Card>
          ) : (
            <Card
              title="Decision"
              titleAs="h3"
              sub={data.pendingApproval ? 'Decision waiting for approval' : `Decision target: ${c.category.resolutionBusinessDays} business days from escalation`}
              foot={
                canDecide && open ? (
                  <>
                    <Button variant="ghost" size="sm" disabled={saveDraft.isPending} onClick={() => saveDraft.mutate(toInput(form, itemIds))}>
                      Save draft
                    </Button>
                    <Button size="sm" onClick={record} disabled={decide.isPending || !!data.pendingApproval}>
                      Record decision and send to Finance
                    </Button>
                  </>
                ) : undefined
              }
            >
              {data.pendingApproval && (
                <Alert tone="info" title="Sent for approval">
                  {data.pendingApproval.reason ?? 'The remedy is above the decider’s limit.'} {data.pendingApproval.approvers.length ? `Approvers: ${data.pendingApproval.approvers.join(', ')}.` : ''}
                </Alert>
              )}
              {!canDecide ? (
                <p className="small sub">Your role can’t decide disputes. A Support lead records the decision.</p>
              ) : !open ? (
                <p className="small sub">This case is {c.statusLabel.toLowerCase()}.</p>
              ) : (
                <>
                  {data.decisionDraft && (
                    <p className="xs muted">
                      Draft saved {dateTime(data.decisionDraft.savedAt)}
                      {data.decisionDraft.savedBy.name ? ` by ${data.decisionDraft.savedBy.name}` : ''}
                    </p>
                  )}
                  {decide.error && !needsStepUp(decide.error) && !sentForApproval(decide.error) && (
                    <Alert tone="danger" title="The decision wasn’t recorded">
                      {errorMessage(decide.error)}
                    </Alert>
                  )}
                  <Field label="Decision">
                    <Select id="cd-dec" options={OUTCOMES} value={form.outcome} onChange={(e) => set('outcome', e.target.value as Outcome)} />
                  </Field>
                  <fieldset className="stack gap-2 fieldset-reset">
                    <legend className="label">Remedy</legend>
                    {REMEDIES.map((m, i) => (
                      <OptionCard key={m.value} id={`cd-rem-${i + 1}`} name="cd-rem" title={<span className="small strong">{m.title}</span>} body={m.body} checked={form.remedy === m.value} onChange={() => set('remedy', m.value)} />
                    ))}
                  </fieldset>
                  <Field
                    label="Refund amount"
                    hint={maxRefund != null ? `Maximum refundable for ${itemIds.length > 1 ? 'these items' : 'this item'}: ${formatMoney({ amount: maxRefund, currency: 'USD' })} (paid ${formatMoney({ amount: paidTotal, currency: 'USD' })}, less refunds already sent or on their way).` : 'The refundable amount couldn’t be loaded; the server checks the cap.'}
                    error={errors.amount}
                  >
                    <TextInput id="cd-amt" prefix="$" value={form.amount} error={!!errors.amount} inputMode="decimal" disabled={form.remedy === 'replacement'} onChange={(e) => set('amount', e.target.value)} />
                  </Field>
                  <Field label="Charged to">
                    <Select id="cd-who" options={CHARGED.map((x) => ({ value: x.value, label: x.label }))} value={form.charged} onChange={(e) => set('charged', e.target.value as ChargedTo)} />
                  </Field>
                  {feeShare != null && form.charged !== 'platform' && (
                    <div className="panel stack gap-1 small">
                      <div className="sum-row">
                        <span>Seller earnings (estimate)</span>
                        <span>−{formatMoney({ amount: Math.max(0, (form.charged === 'shared' ? Math.round(refundMinor / 2) : refundMinor) - (form.charged === 'shared' ? Math.round(feeShare / 2) : feeShare)), currency: 'USD' })}</span>
                      </div>
                      <div className="sum-row">
                        <span>Marketplace fee returned</span>
                        <span>{formatMoney({ amount: form.charged === 'shared' ? Math.round(feeShare / 2) : feeShare, currency: 'USD' })}</span>
                      </div>
                    </div>
                  )}
                  {needsApproval && (
                    <Alert tone="warning" title="Finance approval needed">
                      {authority.data!.reason} This remedy goes to {authority.data!.eligibleApprovers.map((a) => a.name).join(', ') || authority.data!.eligibleApproverRoles.map((r) => r.name).join(', ') || 'Finance'} before the refund is sent.
                    </Alert>
                  )}
                  <Field label="Reason shared with both parties" error={errors.reason}>
                    <Textarea id="cd-why" placeholder="" className={cx(errors.reason && 'is-error')} value={form.reason} onChange={(e) => set('reason', e.target.value)} />
                  </Field>
                  <Field label="Appeal deadline" hint="11:59 PM Pacific on this day. Published to the customer and the seller." error={errors.appeal}>
                    <TextInput id="cd-appeal" type="date" icon="calendar" value={form.appeal} error={!!errors.appeal} min={plusDays(1)} onChange={(e) => set('appeal', e.target.value)} />
                  </Field>
                  <Checkbox
                    id="cd-notify"
                    label={`Notify ${[customer?.name, seller?.name].filter(Boolean).join(' and ') || 'both parties'} with the decision and appeal route`}
                    checked={form.notify}
                    onChange={(e) => set('notify', e.target.checked)}
                  />
                  {askCode && (
                    <Field label="2-step code" hint={STEP_UP_HINT} error={attempted && !/^\d{6}$/.test(code.trim()) ? 'Enter the 6-digit code.' : undefined}>
                      <TextInput id="cd-code" inputMode="numeric" autoComplete="one-time-code" value={code} onChange={(e) => setCode(e.target.value)} />
                    </Field>
                  )}
                  {refundMinor > 0 && <p className="xs muted">Refund of {formatMoney({ amount: refundMinor, currency: 'USD' })} charged to {chargedText}.</p>}
                </>
              )}
            </Card>
          )}
          <Card title="Case history" titleAs="h3">
            <EvTimeline events={data.history.map((e, i, a) => ({ t: e.label, d: `${dateTime(e.at)}${e.actor?.name ? ` · by ${e.actor.name}` : e.actor?.kind === 'customer' ? ' · by customer' : e.actor?.kind === 'seller' ? ' · by seller' : ''}`, state: EV_STATE(i, a.length), body: e.detail }))} />
          </Card>
        </div>
      </div>

      <Dialog
        open={side !== null}
        onClose={() => setSide(null)}
        title={side === 'assign' ? `Reassign ${c.ref}` : `Escalate ${c.ref}`}
        size="sm"
        foot={
          <>
            <Button variant="ghost" onClick={() => setSide(null)}>
              Cancel
            </Button>
            <Button onClick={doSide} disabled={assign.isPending || escalate.isPending}>
              {side === 'assign' ? 'Reassign' : 'Escalate'}
            </Button>
          </>
        }
      >
        {sideErr && (
          <Alert tone="danger" title="That didn’t work">
            {sideErr}
          </Alert>
        )}
        {side === 'assign' ? (
          <Field label="New owner">
            <Select
              id="cd-owner"
              value={assignTo}
              onChange={(e) => setAssignTo(e.target.value)}
              options={[
                ...(assignees.data ?? []).filter((a) => a.staffId !== accountId).map((a) => ({ value: a.staffId, label: `${a.name}${a.role ? `, ${a.role}` : ''} (${a.openCases} open)${a.away ? ' · away' : ''}` })),
                { value: '', label: `${myName || 'Me'} (you)` },
              ]}
            />
          </Field>
        ) : (
          <Field label="Escalate to">
            <Select id="cd-esc" value={escalateTo} onChange={(e) => setEscalateTo(e.target.value as typeof escalateTo)} options={ESCALATE_TO} />
          </Field>
        )}
        <Field label="Reason" optional={side === 'assign'} error={side === 'escalate' && sideErr && !sideReason.trim() ? sideErr : undefined}>
          <Textarea id="cd-side-reason" value={sideReason} onChange={(e) => setSideReason(e.target.value)} />
        </Field>
      </Dialog>
    </AdminLayout>
  );
}
