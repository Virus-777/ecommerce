import { Fragment, useEffect, useMemo, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Link, useParams } from 'react-router';
import { ApiError, call, errorMessage, useApi, type Api } from '@marketly/web-shared/api';
import { AdminLayout } from '@marketly/web-shared/layouts';
import { cx } from '@marketly/web-shared/lib/cx';
import { useScrollRegion, useView } from '@marketly/web-shared/lib/hooks';
import { href } from '@marketly/web-shared/routes';
import { Alert, Badge, Button, Card, Checkbox, EmptyState, Field, Icon, KeyValue, PageHeader, Select, StatusBadge, Textarea, TextInput, announce, type IconName, type Tone } from '@marketly/web-shared/ui';
import { useStaffSession } from '@/app/session';
import { LoadError, SkeletonLines, date, dateTime, deadlineLabel, shortDate } from '@/app/parts';
import { MessageDialog } from './data/seller-message';
import { UUID_RE, cap, endOfDayIso, isoDay, type ApplicationAdmin, type ApplicationRow } from './data/seller';
import { ApproveDialog, CheckResultDialog, TrustReviewDialog, type ApproveBody } from './data/seller-decisions';

type Check = ApplicationAdmin['checks'][number];

// Design: pages/admin/admin-seller-application.html
// Views: "request-information" and "reject" replace the Decision card with an inline form.
// Route /sellers/applications/:ref carries the application ref (SA-…) or id; an unknown ref (e.g. the sidebar's
// sample link) shows the applications waiting for a decision.
// Data: GET /api/admin/sellers/applications (q = ref; the waiting list), GET …/applications/{id} (ApplicationAdmin).
// Writes: POST …/{id}/start-review, /assign, /request-information, /approve (after a confirm dialog with the note,
// payout hold and condition options), /reject, /notes, /checks/{checkId}/result (manual result: offline the automated
// provider is a dev stub), /checks/{checkId}/rerun, /trust-review, POST /api/admin/messaging/conversations (applicationId).

type Need = { id: string; title: string; detail: string; neededFor: string; documentKind?: string; defaultOn: boolean };
type TimelineEvt = { t: string; d: string; state: 'done' | 'current' | 'warn' | 'danger' };

const STEPS = ['Applied', 'Checks', 'Under review', 'Decision', 'Store setup', 'Launch ready'];
const OPEN = new Set(['submitted', 'under_review', 'information_required']);
const STATE_LABEL: Record<string, string> = {
  draft: 'Draft',
  submitted: 'Applied',
  under_review: 'Under review',
  information_required: 'Information required',
  approved: 'Approved',
  rejected: 'Rejected',
  withdrawn: 'Withdrawn',
  expired: 'Expired',
};
const CHECK_META: Record<string, { icon: IconName; title: string }> = {
  identity: { icon: 'id-card', title: 'Identity' },
  business_registration: { icon: 'building-2', title: 'Business registration' },
  tax_id: { icon: 'file-text', title: 'Tax ID' },
  payout_account: { icon: 'landmark', title: 'Payout account' },
  return_address: { icon: 'map-pin', title: 'Return address' },
  sanctions: { icon: 'shield', title: 'Sanctions screening' },
};
const RESULT: Record<string, { label: string; tone: Tone }> = {
  passed: { label: 'Passed', tone: 'success' },
  needs_attention: { label: 'Needs attention', tone: 'warning' },
  failed: { label: 'Failed', tone: 'danger' },
  pending: { label: 'Pending', tone: 'info' },
};
const RISK_TONE: Record<string, Tone> = { high: 'danger', medium: 'warning', low: 'info' };
const DOC_KIND: Record<string, string> = {
  owner_id: 'verification',
  business_registration: 'business',
  tax_form: 'verification',
  bank_letter: 'payout',
  proof_of_address: 'return_address',
  category_certificate: 'category',
  authorization_letter: 'business',
  other: 'business',
};
const CHECK_NEED: Record<string, string> = { identity: 'verification', business_registration: 'business', tax_id: 'verification', payout_account: 'payout', return_address: 'return_address', sanctions: 'verification' };

const REJECT_REASONS = [
  { value: 'unverified_identity_or_business', label: 'Could not verify identity or business' },
  { value: 'outside_assortment', label: 'Products outside the allowed assortment' },
  { value: 'risk_review_failed', label: 'Risk review not passed' },
  { value: 'duplicate_account', label: 'Duplicate account' },
  { value: 'incomplete', label: 'Application incomplete' },
  { value: 'other', label: 'Other' },
] as const;
type RejectCode = (typeof REJECT_REASONS)[number]['value'];
const REAPPLY = [
  { value: 'immediately', label: 'Immediately' },
  { value: 'after_30_days', label: '30 days' },
  { value: 'after_90_days', label: '90 days' },
  { value: 'not_eligible', label: 'Not eligible' },
] as const;
type Reapply = (typeof REAPPLY)[number]['value'];
const REMINDERS = [
  { value: 'three_days_before', label: '3 days before the deadline' },
  { value: 'none', label: 'No reminder' },
] as const;

interface Address {
  line1?: string;
  line2?: string | null;
  city?: string;
  region?: string;
  postalCode?: string;
}
const addr = (a?: Address | null) => (a ? [a.line1, a.line2, a.city, [a.region, a.postalCode].filter(Boolean).join(' ')].filter(Boolean).join(', ') : '');
const fileSize = (b?: number | null) => (!b ? '' : b >= 1_048_576 ? `${(b / 1_048_576).toFixed(1)} MB` : `${Math.max(1, Math.round(b / 1024))} KB`);

async function resolveApplication(api: Api, ref: string): Promise<{ id: string; row?: ApplicationRow } | null> {
  if (UUID_RE.test(ref)) return { id: ref };
  const page = await call(api.GET('/api/admin/sellers/applications', { params: { query: { q: ref, limit: 10 } } }));
  const row = page.items.find((r) => r.ref.toLowerCase() === ref.toLowerCase());
  return row ? { id: row.id, row } : null;
}

/** Progress steps with the design's "Step n of m" screen-reader text. */
function AppSteps({ current }: { current: number }) {
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

/** Timeline with the design's "At risk:" note on amber events. */
function EventTimeline({ events }: { events: TimelineEvt[] }) {
  return (
    <ol className="timeline">
      {events.map((e, i) => (
        <li key={`${i}-${e.t}`} className={`ev is-${e.state}`}>
          {e.state === 'warn' && <span className="sr-only">At risk: </span>}
          <span className="dot" aria-hidden="true" />
          <div className="stack gap-1">
            <span className="t">{e.t}</span>
            <span className="d">{e.d}</span>
          </div>
        </li>
      ))}
    </ol>
  );
}

/** Unknown ref: the applications waiting for a decision. */
function Waiting({ refParam }: { refParam: string }) {
  const { api } = useApi();
  const list = useQuery({ queryKey: ['sellers', 'applications', 'list', 'all'], queryFn: () => call(api.GET('/api/admin/sellers/applications', { params: { query: { limit: 100 } } })) });
  const open = (list.data?.items ?? []).filter((a) => OPEN.has(a.state));
  return (
    <AdminLayout active="applications">
      <PageHeader crumbs={[{ label: 'Sellers', to: href('admin/sellers') }, { label: 'Applications' }]} title="Seller applications" sub={`No application matches “${refParam}”. Choose one waiting for a decision.`} />
      <Card title="Waiting for a decision" titleAs="h2">
        {list.isLoading ? (
          <SkeletonLines rows={3} />
        ) : list.isError ? (
          <LoadError error={list.error} onRetry={() => void list.refetch()} />
        ) : open.length ? (
          <ul className="list">
            {open.map((a) => (
              <li key={a.id}>
                <span className="grow stack gap-0">
                  <Link className="small strong" to={href('admin/seller-application', '', { ref: a.ref })}>
                    {a.storeName}
                  </Link>
                  <span className="xs muted">{`${a.ref} · ${a.applicantName}${a.submittedAt ? ` · applied ${shortDate(a.submittedAt)}` : ''}`}</span>
                </span>
                <StatusBadge status={STATE_LABEL[a.state] ?? cap(a.state)} />
              </li>
            ))}
          </ul>
        ) : (
          <EmptyState icon="file-check" title="No applications waiting">
            New applications appear here when businesses submit them.
          </EmptyState>
        )}
      </Card>
    </AdminLayout>
  );
}

export default function SellerApplication() {
  const { ref = '' } = useParams();
  const { api } = useApi();
  const qc = useQueryClient();
  const { can, accountId } = useStaffSession();
  const [view, setView] = useView<'request-information' | 'reject'>();
  const [flash, setFlash] = useState<{ title: string; body: string } | null>(null);
  const [message, setMessage] = useState(false);
  const [note, setNote] = useState('');
  const [approving, setApproving] = useState(false);
  const [recording, setRecording] = useState<Check | null>(null);
  const [askTrust, setAskTrust] = useState(false);

  const resolved = useQuery({ queryKey: ['sellers', 'applications', 'resolve', ref], queryFn: () => resolveApplication(api, ref), staleTime: Infinity });
  const id = resolved.data?.id;
  const detail = useQuery({ queryKey: ['sellers', 'applications', 'detail', id], queryFn: () => call(api.GET('/api/admin/sellers/applications/{id}', { params: { path: { id: id! } } })) as Promise<ApplicationAdmin>, enabled: !!id });
  const d = detail.data;
  const app = d?.application;

  // Request information form
  const needs: Need[] = useMemo(() => {
    if (!d) return [];
    const out: Need[] = [];
    for (const r of d.requiredDocuments.filter((x) => !x.uploaded)) out.push({ id: `doc-${r.kind}-${r.label}`, title: r.label, detail: r.reason, neededFor: DOC_KIND[r.kind] ?? 'verification', documentKind: r.kind, defaultOn: true });
    for (const c of d.checks.filter((x) => x.result === 'needs_attention' || x.result === 'failed')) out.push({ id: `chk-${c.id}`, title: `${CHECK_META[c.kind]?.title ?? cap(c.kind)}: ${c.summary}`, detail: c.summary, neededFor: CHECK_NEED[c.kind] ?? 'verification', defaultOn: true });
    out.push({ id: 'proof-address', title: 'Proof of address for the return address', detail: 'A utility bill, lease or bank statement for the return address', neededFor: 'return_address', documentKind: 'proof_of_address', defaultOn: false });
    out.push({ id: 'owner-id', title: 'Photo ID for an additional business owner', detail: 'Every owner with 25% or more needs a photo ID', neededFor: 'verification', documentKind: 'owner_id', defaultOn: false });
    return out;
  }, [d]);
  const [picked, setPicked] = useState<Record<string, boolean>>({});
  useEffect(() => setPicked(Object.fromEntries(needs.map((n) => [n.id, n.defaultOn]))), [needs]);
  const [due, setDue] = useState(isoDay(14));
  const [reminder, setReminder] = useState<'three_days_before' | 'none'>('three_days_before');
  const [msg, setMsg] = useState('');
  const [reqTried, setReqTried] = useState(false);

  // Reject form
  const [reason, setReason] = useState<'' | RejectCode>('');
  const [explain, setExplain] = useState('');
  const [reapply, setReapply] = useState<Reapply>('after_30_days');

  const refresh = () => {
    void qc.invalidateQueries({ queryKey: ['sellers'] });
    void qc.invalidateQueries({ queryKey: ['workqueues', 'queues'] });
    void qc.invalidateQueries({ queryKey: ['notifications', 'summary', 'staff'] });
  };
  const path = { id: id ?? '' };

  const startReview = useMutation({
    mutationFn: () => call(api.POST('/api/admin/sellers/applications/{id}/start-review', { params: { path } })),
    onSuccess: () => (announce('Review started'), refresh()),
  });
  const assign = useMutation({
    mutationFn: () => call(api.POST('/api/admin/sellers/applications/{id}/assign', { params: { path }, body: { reviewerId: accountId } })),
    onSuccess: () => (announce('Assigned to you'), refresh()),
  });
  const requestInfo = useMutation({
    mutationFn: (items: Need[]) =>
      call(
        api.POST('/api/admin/sellers/applications/{id}/request-information', {
          params: { path },
          body: { items: items.map((n) => ({ title: n.title, detail: n.detail, neededFor: n.neededFor, documentKind: n.documentKind ?? null })), message: msg.trim(), dueAt: endOfDayIso(due), reminder },
        }),
      ),
    onSuccess: (_r, items) => {
      setFlash({
        title: `Information requested from ${app?.account ? ((app.account as { contactName?: string }).contactName ?? 'the applicant') : 'the applicant'}`,
        body: `${items.length} item${items.length > 1 ? 's' : ''} requested. Reply by ${date(due)}${reminder === 'three_days_before' ? ', with a reminder 3 days before' : ''}. The application closes if there is no reply.`,
      });
      setView('');
      refresh();
    },
  });
  const reject = useMutation({
    mutationFn: () => call(api.POST('/api/admin/sellers/applications/{id}/reject', { params: { path }, body: { reasonCode: reason as RejectCode, explanation: explain.trim(), reapply } })),
    onSuccess: () => {
      setFlash({ title: 'Application rejected', body: `The applicant gets your explanation by email. Can reapply after: ${REAPPLY.find((r) => r.value === reapply)?.label.toLowerCase()}. Recorded in Action history.` });
      setView('');
      refresh();
    },
  });
  const approve = useMutation({
    mutationFn: (body: ApproveBody) => call(api.POST('/api/admin/sellers/applications/{id}/approve', { params: { path }, body })),
    onSuccess: (res) => {
      setApproving(false);
      const approved = res.application.state === 'approved';
      setFlash(
        approved
          ? { title: 'Seller approved', body: `${storeName} can now set up their store. Products still need review before they go live.` }
          : { title: 'Approval sent for review', body: 'A second reviewer must confirm this approval before the seller can set up their store.' },
      );
      refresh();
    },
  });
  const addNote = useMutation({
    mutationFn: () => call(api.POST('/api/admin/sellers/applications/{id}/notes', { params: { path }, body: { body: note.trim() } })),
    onSuccess: () => (setNote(''), announce('Note added'), void qc.invalidateQueries({ queryKey: ['sellers', 'applications', 'detail', id] })),
  });
  // Run an automated check again (e.g. after the applicant uploaded a new document).
  const rerun = useMutation({
    mutationFn: (checkId: string) => call(api.POST('/api/admin/sellers/applications/{id}/checks/{checkId}/rerun', { params: { path: { id: id ?? '', checkId } } })),
    onSuccess: (c) => (announce(`Check ran again: ${cap(c.result)}`), refresh()),
  });
  const done = (title: string, body: string) => (setFlash({ title, body }), refresh());
  // approve errors show in its confirm dialog
  const writeError = [startReview, assign, rerun].find((m) => m.isError)?.error;

  if (resolved.isSuccess && !resolved.data) return <Waiting refParam={ref} />;
  const notFound = detail.error instanceof ApiError && detail.error.status === 404;
  if (notFound) return <Waiting refParam={ref} />;
  const loadError = resolved.error ?? detail.error;
  if (loadError || !d || !app) {
    return (
      <AdminLayout active="applications">
        <PageHeader crumbs={[{ label: 'Sellers' }, { label: 'Applications' }, { label: ref }]} title={loadError ? 'Seller application' : <span className="sk sk-line short" aria-label="Loading" />} />
        {loadError ? (
          <LoadError error={loadError} onRetry={() => void (resolved.error ? resolved.refetch() : detail.refetch())} />
        ) : (
          <div className="aa-split">
            <Card title="Business and store details">
              <SkeletonLines rows={5} />
            </Card>
            <Card title="Decision" titleAs="h3">
              <SkeletonLines rows={3} />
            </Card>
          </div>
        )}
      </AdminLayout>
    );
  }

  const account = (app.account ?? {}) as { contactName?: string; contactPhone?: string; workEmail?: string; storeName?: string; sellerType?: string };
  const business = (app.business ?? {}) as { legalName?: string; storeName?: string; businessType?: string; stateOfRegistration?: string; registryNumber?: string; address?: Address; supportHours?: string; plannedProducts?: string; shippingPlan?: string; website?: string };
  const verification = (app.verification ?? {}) as { taxIdType?: string; taxIdLast4?: string };
  const returnAddress = (app.returnAddress ?? {}) as { sameAsBusiness?: boolean; address?: Address };
  const storeName = account.storeName ?? business.storeName ?? app.ref;
  const owner = account.contactName ?? 'the applicant';
  const state = app.state;
  const status = STATE_LABEL[state] ?? cap(state);
  const decided = !OPEN.has(state);
  const canReview = can('sellers.applications.review');
  const canDecide = can('sellers.applications.decide');
  const shownStatus = view === 'request-information' && state === 'under_review' ? 'Information required' : status;

  const BUSINESS: Array<[string, string]> = [
    ['Legal name', business.legalName ?? '—'],
    ['Type', business.businessType ? cap(business.businessType).replace(/^Llc$/, 'Limited liability company') : '—'],
    ['Registered', [business.stateOfRegistration, business.registryNumber].filter(Boolean).join(' · ') || '—'],
    [(verification.taxIdType ?? 'Tax ID').toUpperCase(), verification.taxIdLast4 ? `•• •••${verification.taxIdLast4}` : '—'],
    ['Address', addr(business.address) || '—'],
    ['Seller type', account.sellerType ? cap(account.sellerType) : '—'],
  ];
  const CONTACT: Array<[string, string]> = [
    ['Owner', account.contactName ?? '—'],
    ['Email', account.workEmail ?? '—'],
    ['Phone', account.contactPhone ?? '—'],
    ['Support hours', business.supportHours ?? '—'],
  ];
  const accepted = app.agreementsAccepted;
  const STORE: Array<[string, string]> = [
    ['Store name', storeName],
    ...(resolved.data?.row?.categories.length ? ([['Categories', resolved.data.row.categories.join(', ')]] as Array<[string, string]>) : []),
    ['Planned products', business.plannedProducts ?? '—'],
    ['Shipping', business.shippingPlan ?? '—'],
    ['Return address', returnAddress.sameAsBusiness ? `Same as business address` : addr(returnAddress.address) || '—'],
    [
      'Agreement',
      accepted.length
        ? `${app.agreementsRequired.map((g) => `${g.title} ${g.versionLabel}`).join(', ')} accepted ${dateTime(accepted[accepted.length - 1]!.acceptedAt)}`
        : `${accepted.length} of ${app.agreementsRequired.length} accepted`,
    ],
  ];

  const checks = d.checks;
  const passed = checks.filter((c) => c.result === 'passed').length;
  // "Pending" checks are still running; only failed and needs-attention ones need the reviewer.
  const running = checks.filter((c) => c.result === 'pending').length;
  const attention = checks.length - passed - running;
  const checksSub = [`${passed} passed`, `${attention} need${attention === 1 ? 's' : ''} attention`, running ? `${running} running` : ''].filter(Boolean).join(' · ');
  const canWorkChecks = canReview && !decided;
  const missingDocs = d.requiredDocuments.filter((r) => !r.uploaded);
  const canApprove = canDecide && state === 'under_review' && d.approveBlockedBy.length === 0;
  const risk = d.riskReview;
  const flags = (risk.flags ?? []) as Array<{ severity?: string; text?: string }>;

  const anyNeed = needs.some((n) => picked[n.id]);
  const reqErrors = {
    needs: reqTried && !anyNeed ? 'Choose at least one item the applicant must send.' : '',
    due: reqTried && !due ? 'Enter a reply-by date.' : '',
    msg: reqTried && !msg.trim() ? 'Write a message to the applicant. They see it in the email and on their application.' : '',
  };
  const rejectErrors = {
    reason: !reason ? 'Choose a reason.' : '',
    explain: !explain.trim() ? 'Write an explanation. The applicant sees this text, so say what was checked and what they can do next.' : '',
  };
  const canReject = !rejectErrors.reason && !rejectErrors.explain;

  const sendRequest = () => {
    setReqTried(true);
    if (!anyNeed || !due || !msg.trim()) return;
    requestInfo.mutate(needs.filter((n) => picked[n.id]));
  };

  const timeline: TimelineEvt[] = app.timeline.map((e) => ({
    t: cap(e.label),
    d: [dateTime(e.at), e.actor?.name].filter(Boolean).join(' · '),
    state: /reject/i.test(e.label) ? 'danger' : /information|attention/i.test(e.label) ? 'warn' : 'done',
  }));
  if (!decided) {
    const target = d.deadline?.dueAt ?? app.decisionTargetAt;
    timeline.push(
      state === 'information_required' && app.informationRequest
        ? { t: 'Information required', d: `Reply by ${shortDate(app.informationRequest.dueAt)}`, state: 'current' }
        : { t: 'Decision', d: target ? deadlineLabel(target) : 'Waiting', state: 'current' },
    );
  }
  const decision = app.decision;
  const targetAt = d.deadline?.dueAt ?? app.decisionTargetAt;

  const decisionCard = (
    <Card title="Decision" sub={targetAt ? `Decision target: ${date(targetAt)}` : undefined} titleAs="h3">
      {decided ? (
        <Alert tone={state === 'approved' ? 'success' : 'info'} title={`Decision: ${status}`}>
          {state === 'approved'
            ? 'Store setup is next.'
            : decision
              ? `${decision.explanation}${decision.canReapplyFrom ? ` Can reapply from ${date(decision.canReapplyFrom)}.` : decision.notEligibleToReapply ? ' Not eligible to reapply.' : ''}`
              : `The application is ${status.toLowerCase()}.`}
        </Alert>
      ) : !canDecide && !canReview ? (
        <span className="small muted">You can view this application but not decide it.</span>
      ) : (
        <div className="stack gap-2">
          {state === 'submitted' && canReview && (
            <Button variant="secondary" size="sm" icon="play" disabled={startReview.isPending} onClick={() => startReview.mutate()}>
              Start review
            </Button>
          )}
          {canDecide && (
            <>
              <label className={cx('opt-card', !canApprove && 'is-disabled')} htmlFor="aa-ap-d1">
                {/* Opens the confirm dialog: approving on the radio itself let one mis-click approve a seller. */}
                <input type="radio" name="aa-ap-d" id="aa-ap-d1" disabled={!canApprove || approve.isPending} checked={false} onChange={() => (approve.reset(), setApproving(true))} />
                <span className="stack gap-1 grow">
                  <span className="small strong">Approve</span>
                  <span className="small sub">Seller can set up their store. Products still need review before they go live.</span>
                </span>
              </label>
              {!canApprove && (
                <span className="xs t-warning-text strong" style={{ paddingLeft: 'var(--sp-4)' }}>
                  <Icon name="lock" className="ic-sm" />{' '}
                  {d.approveBlockedBy.length ? `Resolve before approving: ${d.approveBlockedBy.join('; ')}.` : state === 'submitted' ? 'Start the review before approving.' : 'Waiting for the applicant’s reply.'}
                </span>
              )}
            </>
          )}
          {canReview && (
            <Link className="opt-card link-inherit u-td-none" to={href('admin/seller-application', 'request-information', { ref })} preventScrollReset>
              <span className="stack gap-1 grow">
                <span className="small strong">Request information</span>
                <span className="small sub">Ask for documents with a deadline</span>
              </span>
              <Icon name="chevron-right" className="ic-sm" />
            </Link>
          )}
          {canDecide && (
            <Link className="opt-card link-inherit u-td-none" to={href('admin/seller-application', 'reject', { ref })} preventScrollReset>
              <span className="stack gap-1 grow">
                <span className="small strong">Reject</span>
                <span className="small sub">Explanation required</span>
              </span>
              <Icon name="chevron-right" className="ic-sm" />
            </Link>
          )}
        </div>
      )}
      <span className="xs muted">Approval does not publish products or allow payouts. Payout readiness and product approval are tracked separately.</span>
    </Card>
  );

  const requestCard = (
    <Card
      title="Request information"
      sub="Status changes to Information required. The applicant gets an email and a task in their application."
      titleAs="h3"
      foot={
        <>
          <Button variant="ghost" to={href('admin/seller-application', '', { ref })}>
            Back
          </Button>
          <Button icon="send" onClick={sendRequest} disabled={requestInfo.isPending}>
            Send request
          </Button>
        </>
      }
    >
      {requestInfo.isError && (
        <Alert tone="danger" title="We couldn’t send the request">
          {errorMessage(requestInfo.error)}
        </Alert>
      )}
      <div className="stack gap-2">
        <span className="label">What the applicant must send</span>
        {needs.map((n) => (
          <Checkbox key={n.id} id={`aa-ap-${n.id}`} label={<span className="small">{n.title}</span>} checked={!!picked[n.id]} onChange={(e) => setPicked((s) => ({ ...s, [n.id]: e.target.checked }))} />
        ))}
        {reqErrors.needs && (
          <span className="error-text">
            <Icon name="circle-alert" className="ic-sm" />
            {reqErrors.needs}
          </span>
        )}
      </div>
      <div className="grid md2 gap-3">
        <Field label="Reply by" hint="14 days. The application closes if there is no reply." error={reqErrors.due}>
          <TextInput id="aa-ap-due" type="date" min={isoDay(1)} value={due} error={!!reqErrors.due} onChange={(e) => setDue(e.target.value)} placeholder="" />
        </Field>
        <Field label="Reminder">
          <Select id="aa-ap-rem" options={[...REMINDERS]} value={reminder} onChange={(e) => setReminder(e.target.value as 'three_days_before' | 'none')} />
        </Field>
      </div>
      <Field label="Message to applicant" error={reqErrors.msg}>
        <Textarea id="aa-ap-msg" value={msg} onChange={(e) => setMsg(e.target.value)} placeholder={`Thanks for applying. To finish our review, please upload…`} />
      </Field>
    </Card>
  );

  const rejectCard = (
    <Card
      title="Reject application"
      sub="The applicant reads your explanation. Rejections are recorded in Action history."
      titleAs="h3"
      foot={
        <>
          <Button variant="ghost" to={href('admin/seller-application', '', { ref })}>
            Back
          </Button>
          <Button variant="danger" icon="circle-x" disabled={!canReject || reject.isPending} onClick={() => reject.mutate()}>
            Reject application
          </Button>
        </>
      }
    >
      {reject.isError && (
        <Alert tone="danger" title="We couldn’t reject the application">
          {errorMessage(reject.error)}
        </Alert>
      )}
      <Field label="Reason" error={rejectErrors.reason}>
        <Select id="aa-ap-rr" options={[{ value: '', label: 'Choose a reason' }, ...REJECT_REASONS]} value={reason} onChange={(e) => setReason(e.target.value as RejectCode)} />
      </Field>
      <Field label="Explanation to applicant" error={rejectErrors.explain}>
        <Textarea id="aa-ap-rx" value={explain} onChange={(e) => setExplain(e.target.value)} placeholder="Explain what we checked, why the application cannot be approved and what would change the outcome" />
      </Field>
      <Field label="Can reapply after">
        <Select id="aa-ap-ra" options={[...REAPPLY]} value={reapply} onChange={(e) => setReapply(e.target.value as Reapply)} />
      </Field>
      <Alert tone="info" title="Before you reject">
        {`${checksSub}. Requesting information is usually the right step when documents can fix the issue.`}
      </Alert>
    </Card>
  );

  const panel = decided ? decisionCard : view === 'request-information' && canReview ? requestCard : view === 'reject' && canDecide ? rejectCard : decisionCard;
  const reviewerName = d.reviewer?.name;

  return (
    <AdminLayout active="applications">
      <PageHeader
        crumbs={[{ label: 'Sellers', to: href('admin/sellers') }, { label: 'Applications' }, { label: storeName }]}
        title={storeName}
        sub={
          <>
            {[`Application ${app.ref}`, app.submittedAt ? `applied ${date(app.submittedAt)}` : '', reviewerName ? `reviewer ${reviewerName}` : 'no reviewer yet'].filter(Boolean).join(' · ')} · <StatusBadge status={shownStatus} />
          </>
        }
        actions={
          <>
            {can('messaging.conversations.participate') && (
              <Button variant="secondary" size="sm" icon="mail" onClick={() => setMessage(true)}>
                Message applicant
              </Button>
            )}
            {canReview && !decided && d.reviewer?.id !== accountId && (
              <Button variant="secondary" size="sm" icon="user-plus" disabled={assign.isPending} onClick={() => assign.mutate()}>
                Assign to me
              </Button>
            )}
          </>
        }
      />
      {flash && (
        <Alert tone="success" title={flash.title}>
          {flash.body}
        </Alert>
      )}
      {writeError ? (
        <Alert tone="danger" title="That didn’t work">
          {errorMessage(writeError)}
        </Alert>
      ) : null}
      <AppSteps current={state === 'approved' ? 4 : state === 'rejected' || state === 'withdrawn' || state === 'expired' ? 3 : state === 'submitted' ? 1 : 2} />
      <div className="aa-split">
        <div className="stack gap-5">
          <Card title="Business and store details">
            <div className="aa-2">
              <div className="aa-sec">
                <span className="h4">Business</span>
                <KeyValue pairs={BUSINESS} />
              </div>
              <div className="aa-sec">
                <span className="h4">Contact</span>
                <KeyValue pairs={CONTACT} />
              </div>
            </div>
            <div className="aa-sec">
              <span className="h4">Store</span>
              <KeyValue pairs={STORE} />
            </div>
          </Card>
          <Card title="Verification checks" sub={checksSub} titleAs="h3">
            {checks.length ? (
              checks.map((c) => {
                const meta = CHECK_META[c.kind] ?? { icon: 'circle-check' as IconName, title: cap(c.kind) };
                const res = RESULT[c.result] ?? RESULT.pending!;
                return (
                  <div key={c.id} className={cx('aa-chk', `t-${res.tone === 'info' ? 'warning' : res.tone}`)}>
                    <Icon name={meta.icon} />
                    <div className="stack gap-1">
                      <div className="row between">
                        <span className="small strong">{meta.title}</span>
                        <Badge tone={res.tone}>{res.label}</Badge>
                      </div>
                      <span className="small sub">{c.summary}</span>
                      <span className="xs muted">{[c.source === 'automated' ? 'Automated check' : 'Manual check', c.checkedBy?.name ?? c.provider, c.checkedAt ? dateTime(c.checkedAt) : ''].filter(Boolean).join(' · ')}</span>
                      {c.acceptedWithNote && <span className="xs muted">{`Accepted with note: ${c.acceptedWithNote}`}</span>}
                      {canWorkChecks && (
                        <span className="row gap-2">
                          <Button variant={c.result === 'passed' ? 'ghost' : 'secondary'} size="sm" onClick={() => setRecording(c)}>
                            Record result
                          </Button>
                          {c.result !== 'pending' && (
                            <Button variant="ghost" size="sm" icon="refresh-cw" disabled={rerun.isPending} onClick={() => rerun.mutate(c.id)}>
                              Run again
                            </Button>
                          )}
                        </span>
                      )}
                    </div>
                  </div>
                );
              })
            ) : (
              <span className="small muted">No checks have run yet.</span>
            )}
          </Card>
          <Card
            title="Risk flags from Trust and Risk"
            sub={risk.reviewedBy?.name ? `${risk.reviewedBy.name}${risk.reviewedAt ? ` · reviewed ${shortDate(risk.reviewedAt)}` : ''}` : risk.state === 'requested' ? 'Review requested' : 'No Trust and Risk review needed'}
            titleAs="h3"
            actions={
              canWorkChecks && risk.state !== 'requested' ? (
                <Button variant="ghost" size="sm" icon="shield-alert" onClick={() => setAskTrust(true)}>
                  Ask Trust and Risk
                </Button>
              ) : undefined
            }
          >
            {flags.length ? (
              <ul className="list">
                {flags.map((f, i) => (
                  <li key={i}>
                    <Badge tone={RISK_TONE[(f.severity ?? 'low').toLowerCase()] ?? 'info'}>{cap(f.severity ?? 'low')}</Badge>
                    <span className="grow small">{f.text}</span>
                  </li>
                ))}
              </ul>
            ) : (
              <span className="small muted">No risk flags.</span>
            )}
            <span className="xs muted">
              {risk.recommendation ? `Recommendation: ${risk.recommendation}. ` : ''}
              {d.duplicateSignals.length ? `Linked accounts: ${d.duplicateSignals.join('; ')}.` : 'No signs of a linked or previously closed account.'}
            </span>
          </Card>
          <Card title="Documents" sub={`${app.documents.length} uploaded · ${missingDocs.length} missing`} titleAs="h3">
            <div className="stack gap-2">
              {app.documents.map((doc) => (
                <div key={doc.id} className="aa-doc">
                  <Icon name={doc.kind === 'owner_id' ? 'id-card' : 'file-text'} />
                  <span className="grow">{doc.fileName}</span>
                  <span className="xs muted">{fileSize(doc.sizeBytes)}</span>
                  {doc.file ? (
                    <Button variant="ghost" size="sm" onClick={() => doc.file && window.open(doc.file.url, '_blank', 'noopener')}>
                      View
                    </Button>
                  ) : (
                    <span className="xs muted">File unavailable</span>
                  )}
                </div>
              ))}
              {missingDocs.map((r) => (
                <div key={`${r.kind}-${r.label}`} className="aa-doc u-bs-dashed">
                  <Icon name="file-x" />
                  <span className="grow t-danger-text strong">{`${r.label} · not uploaded`}</span>
                </div>
              ))}
              {!app.documents.length && !missingDocs.length && <span className="small muted">No documents.</span>}
            </div>
          </Card>
        </div>
        <div className="stack gap-5">
          {panel}
          <Card title="Status timeline" titleAs="h3">
            <EventTimeline events={timeline} />
          </Card>
          <Card title="Notes" titleAs="h3">
            {d.notes.map((n) => (
              <div key={n.id} className="aa-note">
                <span className="row between xs">
                  <b>{n.author.name ?? 'Staff'}</b>
                  <span className="muted">{dateTime(n.createdAt)}</span>
                </span>
                <span>{n.body}</span>
              </div>
            ))}
            {canReview ? (
              <>
                <Field label="Add a note" error={addNote.isError ? errorMessage(addNote.error) : undefined}>
                  <Textarea id="aa-ap-note" placeholder="Visible to staff only" value={note} onChange={(e) => setNote(e.target.value)} />
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
      <MessageDialog open={message} onClose={() => setMessage(false)} to={owner} target={{ applicationId: app.id }} onSent={(b) => setFlash({ title: 'Message sent', body: b })} />
      {approving && <ApproveDialog storeName={storeName} pending={approve.isPending} error={approve.error} onClose={() => setApproving(false)} onConfirm={(b) => approve.mutate(b)} />}
      {recording && <CheckResultDialog applicationId={app.id} check={recording} title={CHECK_META[recording.kind]?.title ?? cap(recording.kind)} onClose={() => setRecording(null)} onDone={done} />}
      {askTrust && <TrustReviewDialog applicationId={app.id} onClose={() => setAskTrust(false)} onDone={done} />}
    </AdminLayout>
  );
}

