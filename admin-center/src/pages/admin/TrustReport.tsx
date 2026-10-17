import { Fragment, useEffect, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Link, useNavigate, useParams } from 'react-router';
import { call, errorMessage, useApi } from '@marketly/web-shared/api';
import { AdminLayout } from '@marketly/web-shared/layouts';
import { cx } from '@marketly/web-shared/lib/cx';
import { useCountdown, useView } from '@marketly/web-shared/lib/hooks';
import { href } from '@marketly/web-shared/routes';
import {
  Alert, Avatar, Badge, Button, Card, Deadline, Dialog, EmptyState, Field, Icon, IconButton, Img, KeyValue, OptionCard, PageHeader, Select, StatusBadge, TableWrap, Tabs, Textarea, Timeline, announce,
} from '@marketly/web-shared/ui';
import { useStaffSession } from '@/app/session';
import { LoadError, SkeletonLines, dateTime, shortDate } from '@/app/parts';
import { STATUS_LABEL, reporterOutcomeFor, subjectHref, subjectIcon, subjectKind, typeOf, type ReportRow, type TrustReportDetail } from './data/trust';
import {
  TRUST_ACTIONS, actionDef, actionsFor, available, factorsOf, isClosed, nextStepOf, paramsFor, reasonCode, timelineOf,
  type CaseAction, type Reversible, type TrustActionKey,
} from './data/trust-reports';
import { RESOLVE_OUTCOMES, canReopenStatus, canResolveStatus, openWithOwners, outcomeLabel, type ResolveOutcome } from './data/trust-decisions';
import { RecommendationItem, type Done } from './TrustRecommendations';
import './TrustReport.css';

// Trust report (admin/trust-report): designed in React after the design export, following
// reports/Best ecommerce site UX patterns.md, "Trust and risk report detail".
// Views: '' investigation · 'take-action' = action dialog · 'decision-recorded' = after an action
// (status and timeline updated, success alert, next case prompt). J / K open the next / previous
// report in the queue. Trust recommends; actions owned by other teams are sent to that team, as on
// the Trust and risk queue.
// Data: the URL carries the ref (TR-…): GET /api/admin/trust/reports?q=<ref> resolves the id, then
// GET /reports/{id} (nextStep: the recommended next step; subjectHistory: other reports and enforcements per
// subject). Actions: POST /reports/{id}/assign, /resolve (Resolve, with an outcome), /dismiss (Dismiss, no action),
// /reopen (closed reports), /evidence-requests (Request info), POST /evidence-requests/{id}/cancel (Withdraw request),
// /recommendations + /recommendations/{id}/route (Restrict listing, Hold payouts, Suspend). Each recommendation on
// the report can be sent, withdrawn or (by the owner team) accepted or declined in place (TrustRecommendations).
// J / K walk GET /reports?status=active (the server filters to open, under review and escalated).
//
// Rules applied here (blueprint "Create and edit forms"): the dialog's submit button is never
// disabled, errors show on submit; the result is an inline alert, not a toast (it is not a
// background job).

type View = 'take-action' | 'decision-recorded';
type EvTab = 'entities' | 'attachments' | 'history';

const BAND_CLASS = { high: 'high', medium: 'med', low: 'low' } as const;
const BAND_LABEL = { high: 'High', medium: 'Medium', low: 'Low' } as const;
const UNDO: Record<Reversible, { text: string; icon: 'undo-2' | 'lock'; cls: string }> = {
  yes: { text: 'Can be undone', icon: 'undo-2', cls: 't-success-text' },
  partly: { text: 'Only partly reversible', icon: 'lock', cls: 't-warning-text' },
  no: { text: 'Cannot be undone', icon: 'lock', cls: 't-danger-text' },
};
const RESULT_LABEL: Record<string, string> = { fail: 'Failed', warn: 'Warning', info: 'Info', ok: 'Passed' };
const REQUEST_LABEL: Record<string, string> = { open: 'Waiting', answered: 'Answered', expired: 'Expired', cancelled: 'Cancelled' };

const reportHref = (ref: string) => href('admin/trust-report', '', { ref });

/** Which design action a recorded recommendation belongs to. */
const KEY_OF: Record<string, TrustActionKey> = {
  suspend_offer: 'restrict-listing',
  suspend_product: 'restrict-listing',
  hold_payout: 'hold-payouts',
  suspend_seller: 'suspend',
  restrict_customer_account: 'suspend',
};

interface Draft {
  action: TrustActionKey;
  /** Reason code; for Resolve, the outcome key. */
  reason: string;
  note: string;
  /** Resolve and Dismiss: what the reporter is told (prefilled from the outcome or reason, editable). */
  reporter: string;
}

interface Recorded extends Draft {
  at: string;
  /** Owner actions: sent to the owner team (routed), or drafted and waiting for a decider to route it. */
  routed?: boolean;
}

function Sla({ label, seconds }: { label: string; seconds: number }) {
  const [h, m] = useCountdown(seconds);
  const hrs = Number(h);
  return (
    <span role="timer" aria-live="off">
      <Deadline tone={hrs < 4 ? 'warning' : 'ok'}>
        {label} · {hrs} h {m} m left
      </Deadline>
    </span>
  );
}

function Frame({ refId, children }: { refId: string; children: React.ReactNode }) {
  return (
    <AdminLayout active="trust">
      <PageHeader crumbs={[{ label: 'Customers and service' }, { label: 'Trust and risk', to: href('admin/trust') }, { label: refId }]} title={`Trust report ${refId}`} />
      {children}
    </AdminLayout>
  );
}

function NotFound({ refId }: { refId: string }) {
  return (
    <AdminLayout active="trust">
      <PageHeader crumbs={[{ label: 'Customers and service' }, { label: 'Trust and risk', to: href('admin/trust') }, { label: refId }]} title="Trust report not found" />
      <Card pad>
        <EmptyState
          icon="search-x"
          title={`There is no trust report ${refId}`}
          as="h2"
          action={
            <Button to={href('admin/trust')} icon="shield-alert">
              Go to Trust and risk
            </Button>
          }
        >
          Reports are numbered like TR-0001. The report may have been merged into another one; closed reports are in Action history.
        </EmptyState>
      </Card>
    </AdminLayout>
  );
}

export default function TrustReport() {
  const { ref = '' } = useParams();
  const { api } = useApi();
  const lookup = useQuery({
    queryKey: ['trust', 'report-ref', ref],
    queryFn: async () => {
      const page = await call(api.GET('/api/admin/trust/reports', { params: { query: { q: ref, limit: 10 } } }));
      return page.items.find((r) => r.ref.toLowerCase() === ref.toLowerCase())?.id ?? null;
    },
  });
  const id = lookup.data ?? '';
  const report = useQuery({ queryKey: ['trust', 'report', id], enabled: !!id, queryFn: () => call(api.GET('/api/admin/trust/reports/{id}', { params: { path: { id } } })) });

  if (lookup.isError || report.isError) {
    const e = lookup.error ?? report.error;
    return (
      <Frame refId={ref}>
        <LoadError error={e} onRetry={() => void (lookup.isError ? lookup.refetch() : report.refetch())} />
      </Frame>
    );
  }
  if (lookup.isSuccess && !lookup.data) return <NotFound refId={ref} />;
  if (!report.data) {
    return (
      <Frame refId={ref}>
        <div className="ab-main wide">
          <Card pad>
            <SkeletonLines rows={6} />
          </Card>
          <Card pad>
            <SkeletonLines rows={4} />
          </Card>
        </div>
      </Frame>
    );
  }
  // Keyed by report so state resets when J/K moves to another report.
  return <Investigation key={report.data.id} d={report.data} />;
}

function Investigation({ d }: { d: TrustReportDetail }) {
  const { api } = useApi();
  const qc = useQueryClient();
  const { accountId, name: me, can } = useStaffSession();
  const navigate = useNavigate();
  const [view, setView] = useView<View>();
  const [recorded, setRecorded] = useState<Recorded | null>(null);
  const actions = actionsFor(d);
  const step = nextStepOf(d, actions);
  const [draft, setDraft] = useState<Draft>({ action: step?.action ?? 'request-info', reason: '', note: '', reporter: '' });
  const [notice, setNotice] = useState<Done | null>(null);
  const [reopening, setReopening] = useState(false);
  const [reopenReason, setReopenReason] = useState('');
  const [reopenTried, setReopenTried] = useState(false);
  const [attempted, setAttempted] = useState(false);
  const [allFactors, setAllFactors] = useState(false);
  const [tab, setTab] = useState<EvTab>('entities');

  const canInvestigate = can('trust.reports.investigate');
  const canDecide = can('trust.reports.decide');
  const allowed = (k: TrustActionKey) => (k === 'resolve' || k === 'dismiss' ? canDecide : canInvestigate);

  // A12: the server returns active reports only, highest risk first (the first 100 are enough for J / K).
  const queue = useQuery({ queryKey: ['trust', 'reports', 'queue', 'nav'], queryFn: () => call(api.GET('/api/admin/trust/reports', { params: { query: { status: 'active', sort: 'risk', limit: 100 } } })) });
  const rows: ReportRow[] = queue.data?.items ?? [];
  const idx = rows.findIndex((x) => x.id === d.id);
  const prev = idx > 0 ? rows[idx - 1] : undefined;
  const next = idx >= 0 ? rows[idx + 1] : rows[0]?.id !== d.id ? rows[0] : undefined;

  // J = next report, K = previous (as in Stripe Radar reviews and Gmail). Ignored while typing or in a dialog.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.defaultPrevented || e.metaKey || e.ctrlKey || e.altKey) return;
      const t = e.target as HTMLElement;
      if (/^(INPUT|TEXTAREA|SELECT)$/.test(t.tagName) || t.isContentEditable || document.querySelector('[data-dialog]')) return;
      const k = e.key.toLowerCase();
      if (k === 'j' && next) navigate(reportHref(next.ref));
      else if (k === 'k' && prev) navigate(reportHref(prev.ref));
    };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [next, prev, navigate]);

  const refresh = () => {
    void qc.invalidateQueries({ queryKey: ['trust'] });
    void qc.invalidateQueries({ queryKey: ['workqueues', 'queues'] });
    void qc.invalidateQueries({ queryKey: ['notifications', 'summary', 'staff'] });
  };

  const assign = useMutation({
    mutationFn: () => call(api.POST('/api/admin/trust/reports/{id}/assign', { params: { path: { id: d.id } }, body: { staffId: accountId } })),
    onSuccess: (r) => {
      qc.setQueryData(['trust', 'report', d.id], r);
      refresh();
      announce(`${d.ref} assigned to you`);
    },
  });

  const withdraw = useMutation({
    mutationFn: (id: string) => call(api.POST('/api/admin/trust/evidence-requests/{id}/cancel', { params: { path: { id } }, body: {} })),
    onSuccess: () => {
      refresh();
      announce('Request withdrawn');
    },
  });

  const reopen = useMutation({
    mutationFn: () => call(api.POST('/api/admin/trust/reports/{id}/reopen', { params: { path: { id: d.id } }, body: { reason: reopenReason.trim() } })),
    onSuccess: (r) => {
      qc.setQueryData(['trust', 'report', d.id], r);
      refresh();
      setReopening(false);
      setView('', { replace: true });
      setNotice({ title: 'Report reopened', text: `${d.ref} is back under review. The earlier decision stays in the timeline.` });
      announce(`${d.ref} reopened`);
    },
  });

  const submitM = useMutation({
    mutationFn: async (v: Draft): Promise<Recorded> => {
      const c = actions[v.action];
      if (!available(c)) throw new Error('This action does not apply to the report.');
      const at = new Date().toISOString();
      if (v.action === 'resolve') {
        // Resolve runs from under review or escalated; an open report is assigned to you first.
        if (!canResolveStatus(d.status) && canInvestigate) await call(api.POST('/api/admin/trust/reports/{id}/assign', { params: { path: { id: d.id } }, body: { staffId: accountId } }));
        const summary = v.note.trim() ? `${outcomeLabel(v.reason)}. ${v.note.trim()}` : outcomeLabel(v.reason);
        await call(api.POST('/api/admin/trust/reports/{id}/resolve', { params: { path: { id: d.id } }, body: { outcome: v.reason as ResolveOutcome, summary, reporterOutcome: v.reporter.trim() } }));
        return { ...v, at };
      }
      const text = v.note.trim() ? `${v.reason}. ${v.note.trim()}` : v.reason;
      if (v.action === 'dismiss') {
        await call(api.POST('/api/admin/trust/reports/{id}/dismiss', { params: { path: { id: d.id } }, body: { reason: text, reporterOutcome: v.reporter.trim() || reporterOutcomeFor(v.reason) } }));
        return { ...v, at };
      }
      if (v.action === 'request-info' && c.to) {
        const to = { type: c.to.type, id: c.to.id, ref: c.to.ref, label: c.to.label };
        await call(api.POST('/api/admin/trust/reports/{id}/evidence-requests', { params: { path: { id: d.id } }, body: { to, question: text, dueAt: new Date(Date.now() + 5 * 86_400_000).toISOString() } }));
        return { ...v, at };
      }
      if (!c.rec) throw new Error('This action does not apply to the report.');
      // Acting on an unassigned report makes you its assignee.
      if (!d.assignee && canInvestigate) await call(api.POST('/api/admin/trust/reports/{id}/assign', { params: { path: { id: d.id } }, body: { staffId: accountId } }));
      const rec = await call(
        api.POST('/api/admin/trust/reports/{id}/recommendations', {
          params: { path: { id: d.id } },
          body: { action: c.rec.action, label: c.what, targets: c.rec.targets.map((t) => ({ type: t.type, id: t.id, ref: t.ref, label: t.label })), params: paramsFor(c.rec.action, v.reason, v.note), rationale: text },
        }),
      );
      if (!canDecide) return { ...v, at, routed: false };
      await call(api.POST('/api/admin/trust/recommendations/{id}/route', { params: { path: { id: rec.id } } }));
      return { ...v, at, routed: true };
    },
    onSuccess: (r) => {
      setRecorded(r);
      setView('decision-recorded', { replace: true });
      announce(`${actionDef(r.action).label} recorded for ${d.ref}`);
      refresh();
    },
  });

  const decided = view === 'decision-recorded';
  // Opening ?view=decision-recorded directly shows the latest recorded decision on the report.
  const latestRec = [...d.recommendations].reverse().find((x) => KEY_OF[x.action]);
  const resolution = d.resolution as { outcome?: string; summary?: string; decidedAt?: string } | null | undefined;
  const fallback: Recorded | null = resolution
    ? resolution.outcome === 'dismissed'
      ? { action: 'dismiss', reason: resolution.summary ?? '', note: '', reporter: '', at: resolution.decidedAt ?? d.updatedAt }
      : { action: 'resolve', reason: resolution.outcome ?? '', note: '', reporter: '', at: resolution.decidedAt ?? d.updatedAt }
    : latestRec
      ? { action: KEY_OF[latestRec.action], reason: latestRec.rationale, note: '', reporter: '', at: latestRec.routedAt ?? d.updatedAt, routed: latestRec.state !== 'pending' }
      : null;
  const shown = decided ? (recorded ?? fallback) : null;

  /* ----- Dialog ----- */
  const sel = actionDef(draft.action);
  const selC: CaseAction = actions[draft.action];
  const selCase = available(selC) && allowed(draft.action) ? selC : null;
  const errors = attempted
    ? {
        action: selCase ? undefined : 'Choose an action that applies to this report.',
        reason: draft.reason ? undefined : draft.action === 'resolve' ? 'Choose the outcome.' : 'Choose a reason code. It is written to Action history with this decision.',
        reporter: (draft.action === 'resolve' || draft.action === 'dismiss') && !draft.reporter.trim() ? 'Write what the reporter is told.' : undefined,
      }
    : {};
  const set = <K extends keyof Draft>(k: K, v: Draft[K]) => setDraft((x) => ({ ...x, [k]: v }));
  // Choosing an outcome (Resolve) or reason (Dismiss) prefills what the reporter is told; staff can edit it.
  const chooseReason = (v: string) =>
    setDraft((x) => ({
      ...x,
      reason: v,
      reporter: x.action === 'resolve' ? (RESOLVE_OUTCOMES.find((o) => o.value === v)?.reporter ?? '') : x.action === 'dismiss' && v ? reporterOutcomeFor(v) : x.reporter,
    }));
  // Resolve is refused while a recommendation is with an owner team, unless the outcome is "referred".
  const withOwners = openWithOwners(d).length;
  const reasonOptions =
    draft.action === 'resolve'
      ? RESOLVE_OUTCOMES.filter((o) => !withOwners || o.value === 'referred').map((o) => ({ value: o.value, label: o.label }))
      : sel.reasons.map((x) => ({ value: x, label: x }));

  const openAction = (k: TrustActionKey = step?.action ?? 'request-info') => {
    setDraft({ action: k, reason: '', note: '', reporter: '' });
    setAttempted(false);
    submitM.reset();
    setView('take-action');
  };
  const submit = () => {
    setAttempted(true);
    if (!selCase || !draft.reason || ((draft.action === 'resolve' || draft.action === 'dismiss') && !draft.reporter.trim())) return;
    submitM.mutate(draft);
  };

  const outcome = shown ? { def: actionDef(shown.action), c: actions[shown.action] } : null;
  const outcomeOwner = outcome && available(outcome.c) ? outcome.c.owner : '';

  /* ----- Factors ----- */
  const factors = factorsOf(d);
  const raising = factors.filter((f) => f.dir === 'raises');
  const lowering = factors.filter((f) => f.dir === 'lowers');
  const shownRaising = allFactors ? raising : raising.slice(0, 3);
  const shownLowering = allFactors ? lowering : lowering.slice(0, 2);
  const hidden = factors.length - shownRaising.length - shownLowering.length;

  const type = typeOf(d.type);
  const band = BAND_CLASS[d.riskLevel];
  const media = d.evidence.flatMap((e) => e.media.map((m) => ({ m, e })));
  const reporter = (d.reporter ?? {}) as { name?: string | null; organization?: string | null };
  const reporterName = reporter.organization ?? reporter.name ?? (d.source === 'automated' ? 'automated detection' : 'a reporter');
  const meta = `${d.source === 'automated' ? 'Detected' : 'Reported'} ${shortDate(d.createdAt)} by ${reporterName}${d.reporterCount > 1 ? ` and ${d.reporterCount - 1} more` : ''}`;
  const history = d.subjectHistory ?? [];
  const histLabel = d.subjects.some((x) => x.type === 'seller') ? 'Seller history' : d.subjects.some((x) => x.type === 'customer') ? 'Account history' : 'History';
  const tabs = [
    { label: 'Related entities', value: 'entities' as const, count: d.subjects.length + d.linkedCaseRefs.length },
    { label: 'Attachments', value: 'attachments' as const, count: media.length },
    { label: histLabel, value: 'history' as const, count: history.reduce((n, h) => n + h.totalReports, 0) + d.evidence.length + d.evidenceRequests.length },
  ];
  const recDef = step?.action ? actionDef(step.action) : null;
  const recC = step?.action ? actions[step.action] : null;
  const assignee = d.assignee;
  const secondsLeft = d.deadline ? Math.max(0, Math.round((new Date(d.deadline.dueAt).getTime() - Date.now()) / 1000)) : 0;
  const override = d.riskOverride as { score?: number; reason?: string; at?: string } | null | undefined;
  const timeline = timelineOf(d, dateTime);

  return (
    <AdminLayout active="trust">
      <PageHeader
        crumbs={[{ label: 'Customers and service' }, { label: 'Trust and risk', to: href('admin/trust') }, { label: d.ref }]}
        eyebrow={`Trust report · ${type.label}`}
        title={`Trust report ${d.ref}`}
        sub={d.title}
        actions={
          <>
            <StatusBadge status={STATUS_LABEL[d.status] ?? d.status} />
            <nav className="trr-queue" aria-label="Queue">
              {prev ? <IconButton icon="chevron-left" label={`Previous report, ${prev.ref} (K)`} to={reportHref(prev.ref)} /> : <IconButton icon="chevron-left" label="Previous report" disabled />}
              <span className="pos">{idx >= 0 ? `${idx + 1} of ${rows.length}` : `${rows.length} open`}</span>
              {next ? <IconButton icon="chevron-right" label={`Next report, ${next.ref} (J)`} to={reportHref(next.ref)} /> : <IconButton icon="chevron-right" label="Next report" disabled />}
              <span className="no-phone xs muted row gap-1 nowrap" aria-hidden="true">
                <span className="trr-kbd">J</span>
                <span className="trr-kbd">K</span>
              </span>
            </nav>
            {(canInvestigate || canDecide) && !isClosed(d) && (
              <Button size="sm" icon="gavel" onClick={() => openAction()}>
                Take action
              </Button>
            )}
            {canDecide && canReopenStatus(d.status) && (
              <Button
                variant="secondary"
                size="sm"
                icon="undo-2"
                onClick={() => {
                  setReopening(true);
                  setReopenReason('');
                  setReopenTried(false);
                  reopen.reset();
                }}
              >
                Reopen
              </Button>
            )}
          </>
        }
      />

      <div className="card pad trr-strip">
        <span className="row gap-3">
          {shown ? (
            <Deadline>Decision recorded {dateTime(shown.at)}</Deadline>
          ) : d.deadline && !isClosed(d) ? (
            <Sla label={`Decision due ${dateTime(d.deadline.dueAt)} PT`} seconds={secondsLeft} />
          ) : (
            <span className="xs muted">{STATUS_LABEL[d.status] ?? d.status}</span>
          )}
          <span className="xs muted">{meta}</span>
        </span>
        <span className="who">
          {assignee ? (
            <>
              <Avatar name={assignee.name} className="ab-av-sm" />
              <span className="ab-cell">
                <span className="small strong">{assignee.staffId === accountId ? `${me || assignee.name} (you)` : assignee.name}</span>
                <span className="xs muted">Assignee</span>
              </span>
            </>
          ) : (
            <span className="ab-cell">
              <span className="small strong t-warning-text">Unassigned</span>
              <span className="xs muted">Nobody owns this report yet</span>
            </span>
          )}
          {assignee?.staffId !== accountId && canInvestigate && !isClosed(d) && (
            <Button variant="secondary" size="sm" icon="user-check" onClick={() => assign.mutate()} disabled={assign.isPending}>
              Assign to me
            </Button>
          )}
        </span>
      </div>
      {assign.isError && (
        <Alert tone="danger" title="The report wasn’t assigned">
          {errorMessage(assign.error)}
        </Alert>
      )}
      {notice && (
        <Alert tone="success" title={notice.title}>
          {notice.text}
        </Alert>
      )}

      {decided && shown && outcome && (
        <>
          <Alert
            tone="success"
            title={outcome.def.byTrust ? outcome.def.recorded : shown.routed === false ? `${outcome.def.label} drafted` : `${outcome.def.label} sent to ${outcomeOwner || 'the owning team'}`}
          >
            {shown.reason && (
              <>
                {shown.action === 'resolve' ? 'Outcome' : 'Reason code'} <span className="mono">{reasonCode(shown.reason)}</span> was written to Action history.{' '}
              </>
            )}
            {!outcome.def.byTrust && shown.routed === false ? `A Trust and Risk decider sends it to ${outcomeOwner.split(' · ')[0]}. ` : ''}
            {!outcome.def.byTrust && shown.routed !== false ? `${(outcomeOwner || 'The owning team').split(' · ')[0]} carries it out and records it; the status updates here. ` : ''}
            <Link to={href('admin/audit', '', undefined, { q: d.ref })}>See it in Action history</Link>
          </Alert>
          <div className="card pad trr-next">
            {next ? (
              <>
                <span className="row gap-3 nowrap min-w-0">
                  <span className={`ab-risk t-${next.riskLevel === 'high' ? 'high' : 'med'}`} aria-label={`Risk score ${next.riskScore} of 100`}>
                    {next.riskScore}
                  </span>
                  <span className="ab-cell">
                    <span className="xs muted">Next in queue · {next.ref}</span>
                    <span className="small strong">{next.title}</span>
                  </span>
                </span>
                <span className="row gap-2 nowrap">
                  <span className="no-phone xs muted">
                    or press <span className="trr-kbd">J</span>
                  </span>
                  <Button size="sm" iconRight="arrow-right" to={reportHref(next.ref)}>
                    Open {next.ref}
                  </Button>
                </span>
              </>
            ) : (
              <>
                <span className="small strong">That was the last report in the queue.</span>
                <Button variant="secondary" size="sm" to={href('admin/trust')}>
                  Back to Trust and risk
                </Button>
              </>
            )}
          </div>
        </>
      )}

      <div className="ab-main wide">
        <div className="stack gap-5">
          <Card title="Verdict" sub={override?.score != null ? `Score set to ${override.score} by hand: ${override.reason ?? ''}` : `Scored ${dateTime(d.updatedAt)}${d.detector ? ` by rule ${d.detector}` : ''}`}>
            <div className="trr-verdict">
              <div className={`trr-band t-${band}`}>
                <span className="b">{BAND_LABEL[d.riskLevel]} risk</span>
                <span className="s">Score {d.riskScore} / 100</span>
              </div>
              <p className="trr-why">{d.description || d.title}</p>
            </div>
          </Card>

          <Card
            title="Risk factors"
            sub="The signals that moved the score most. No single factor decides the band."
            foot={
              factors.length > 5 || hidden > 0 || allFactors ? (
                <Button variant="ghost" size="sm" icon={allFactors ? 'chevrons-down-up' : 'chevrons-up-down'} aria-expanded={allFactors} onClick={() => setAllFactors((x) => !x)}>
                  {allFactors ? 'Show fewer' : `Show all ${factors.length} factors`}
                </Button>
              ) : undefined
            }
          >
            <div className="trr-factors">
              {[
                { title: 'Raising risk', icon: 'arrow-up' as const, cls: 't-danger-text', list: shownRaising, total: raising.length },
                { title: 'Lowering risk', icon: 'arrow-down' as const, cls: 't-success-text', list: shownLowering, total: lowering.length },
              ].map((g) => (
                <div className="trr-fgroup" key={g.title}>
                  <h3>
                    <Icon name={g.icon} className={cx('ic-sm', g.cls)} />
                    {g.title} <span className="muted">({g.total})</span>
                  </h3>
                  {g.list.length ? (
                    <ul className="trr-flist">
                      {g.list.map((f) => (
                        <li key={f.title + f.detail} className={`t-${f.dir}`}>
                          <Icon name={f.dir === 'raises' ? 'arrow-up' : 'arrow-down'} />
                          <span className="strong">{f.title}</span>
                          <Badge tone={f.weight === 'Strong' ? 'outline' : ''}>{f.weight}</Badge>
                          <span className="d">{f.detail}</span>
                        </li>
                      ))}
                    </ul>
                  ) : (
                    <span className="trr-empty-group">None found.</span>
                  )}
                </div>
              ))}
            </div>
          </Card>

          <Card title="Evidence" className="trr-ev" flush>
            <div className="card-body trr-tabs">
              <Tabs items={tabs} active={tab} onChange={setTab} label="Evidence" />
            </div>
            {tab === 'entities' && (
              <div role="tabpanel" aria-label="Related entities">
                <TableWrap label="Related entities table">
                  <table className="table">
                    <thead>
                      <tr>
                        <th scope="col">Entity</th>
                        <th scope="col">Linked by</th>
                        <th className="col-pin" scope="col">
                          Status
                        </th>
                      </tr>
                    </thead>
                    <tbody>
                      {d.subjects.map((e) => (
                        <tr key={e.type + e.id}>
                          <td>
                            <span className="trr-ent">
                              <Icon name={subjectIcon(e.type)} className="ic-sm" />
                              <span className="ab-cell">
                                <span className="xs muted">{subjectKind(e.type)}</span>
                                <Link className="strong" to={subjectHref(e)}>
                                  {e.label}
                                </Link>
                                {e.ref && !e.label.includes(e.ref) && <span className="xs muted">{e.ref}</span>}
                              </span>
                            </span>
                          </td>
                          <td>
                            <span className="small minw-200 cell-text">{d.source === 'automated' && d.detector ? `Matched by rule ${d.detector}` : 'Named in the report'}</span>
                          </td>
                          <td className="col-pin">{e.statusLabel ? <StatusBadge status={e.statusLabel} /> : <span className="xs muted">—</span>}</td>
                        </tr>
                      ))}
                      {d.linkedCaseRefs.map((c) => (
                        <tr key={c}>
                          <td>
                            <span className="trr-ent">
                              <Icon name="life-buoy" className="ic-sm" />
                              <span className="ab-cell">
                                <span className="xs muted">Case</span>
                                <Link className="strong" to={href('admin/case', '', { ref: c })}>
                                  {c}
                                </Link>
                              </span>
                            </span>
                          </td>
                          <td>
                            <span className="small minw-200 cell-text">Linked support case</span>
                          </td>
                          <td className="col-pin">
                            <span className="xs muted">—</span>
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </TableWrap>
              </div>
            )}
            {tab === 'attachments' && (
              <div role="tabpanel" aria-label="Attachments" className="card-body">
                {media.length ? (
                  <div className="ab-photos">
                    {media.map(({ m, e }) => (
                      <figure key={m.id}>
                        <Img icon="file-text" tint="5" className="r43" src={m.url} alt={m.alt ?? ''} />
                        <figcaption>
                          <b>{m.alt || e.text}</b>
                          <br />
                          {e.source.replace(/_/g, ' ')} · {shortDate(e.addedAt)}
                        </figcaption>
                      </figure>
                    ))}
                  </div>
                ) : (
                  <span className="small muted">No photos or documents on this report yet.</span>
                )}
              </div>
            )}
            {tab === 'history' && (
              <div role="tabpanel" aria-label={histLabel} className="card-body">
                <KeyValue
                  pairs={[
                    ['Reported by', `${reporterName}${d.reporterCount > 1 ? ` (${d.reporterCount} reports merged)` : ''}`],
                    ['Source', d.source.replace(/_/g, ' ')],
                    ['Linked cases', d.linkedCaseRefs.length ? d.linkedCaseRefs.join(', ') : 'None'],
                    ['Merged reports', String(d.mergedReportIds.length)],
                  ]}
                />
                {history.length > 0 && (
                  <>
                    <div className="divider" />
                    <ul className="trr-hist">
                      {history.map((h) => (
                        <li key={`${h.subject.type}:${h.subject.id}`}>
                          <span className="ab-cell">
                            <span className="small">
                              <Link className="strong" to={subjectHref(h.subject)}>
                                {h.subject.label}
                              </Link>{' '}
                              · {subjectKind(h.subject.type)}
                            </span>
                            <span className="xs muted">
                              {h.totalReports ? `${h.totalReports} other ${h.totalReports === 1 ? 'report' : 'reports'}` : 'No other reports'}
                              {h.reports.length > 0 && ': '}
                              {h.reports.map((r, n) => (
                                <Fragment key={r.id}>
                                  {n > 0 && ', '}
                                  <Link to={reportHref(r.ref)}>{r.ref}</Link> {r.title} ({shortDate(r.createdAt)}, {(STATUS_LABEL[r.status] ?? r.status).toLowerCase()}
                                  {r.outcome ? `, ${r.outcome.replace(/_/g, ' ')}` : ''})
                                </Fragment>
                              ))}
                            </span>
                          </span>
                          <Badge tone={h.enforcementsInForce ? 'warning' : ''}>{h.enforcementsInForce ? `${h.enforcementsInForce} in force` : 'No actions in force'}</Badge>
                        </li>
                      ))}
                    </ul>
                  </>
                )}
                <div className="divider" />
                {withdraw.isError && <Alert tone="danger" title="The request wasn’t withdrawn">{errorMessage(withdraw.error)}</Alert>}
                <ul className="trr-hist">
                  {d.evidenceRequests.map((q) => (
                    <li key={q.id}>
                      <span className="ab-cell">
                        <span className="small">
                          Asked {q.to.label}: {q.question}
                        </span>
                        <span className="xs muted">Due {dateTime(q.dueAt)}{q.answer ? ` · Answer: ${q.answer}` : ''}</span>
                      </span>
                      {q.state === 'open' && canInvestigate && (
                        <Button variant="ghost" size="sm" onClick={() => withdraw.mutate(q.id)} disabled={withdraw.isPending} srLabel={`to ${q.to.label}`}>
                          Withdraw request
                        </Button>
                      )}
                      <StatusBadge status={REQUEST_LABEL[q.state] ?? q.state} />
                    </li>
                  ))}
                  {d.evidence.map((e) => (
                    <li key={e.id}>
                      <span className="ab-cell">
                        <span className="small">{e.text}</span>
                        <span className="xs muted">
                          {dateTime(e.addedAt)} · {e.source.replace(/_/g, ' ')}
                        </span>
                      </span>
                      <StatusBadge status={RESULT_LABEL[e.result ?? 'info'] ?? 'Info'} />
                    </li>
                  ))}
                </ul>
              </div>
            )}
          </Card>

          <Card title="Actions on this report" sub="Trust recommends; the owning team carries out the action and records its reason">
            {d.recommendations.length ? (
              <ul className="ab-route">
                {d.recommendations.map((a) => (
                  <RecommendationItem key={a.id} r={a} onDone={setNotice} />
                ))}
              </ul>
            ) : (
              <span className="small muted">No actions recommended yet.</span>
            )}
          </Card>
        </div>

        <div className="stack gap-5">
          {!decided && !isClosed(d) && step && (
            <Card
              title="Recommended next step"
              className="trr-rec"
              sub={recDef ? `${step.label} · ${recDef.byTrust ? 'done by Trust' : `sent to ${recC && available(recC) ? recC.owner : 'the owning team'}`}` : step.label}
            >
              {step.detail && <p className="small">{step.detail}</p>}
              {recDef ? (
                allowed(recDef.key) ? (
                  <Button size="sm" icon={recDef.icon} onClick={() => openAction(recDef.key)}>
                    {recDef.label}: review and confirm
                  </Button>
                ) : (
                  <span className="xs muted">Your role can view this report but not take this action.</span>
                )
              ) : step.key === 'assign' && canInvestigate && !d.assignee ? (
                <Button size="sm" icon="user-plus" onClick={() => assign.mutate()} disabled={assign.isPending}>
                  Assign to me
                </Button>
              ) : null}
            </Card>
          )}

          <Card title="Actions" sub="Every action needs a reason code, which is written to Action history">
            <ul className="trr-acts">
              {TRUST_ACTIONS.map((a) => {
                const c = actions[a.key];
                if (!available(c) || !allowed(a.key)) {
                  return (
                    <li key={a.key} className="is-off">
                      <span className="ic">
                        <Icon name={a.icon} />
                      </span>
                      <span className="ab-cell">
                        <span className="small strong">{a.label}</span>
                        <span className="xs muted">{!available(c) ? `Does not apply: ${c.unavailable}` : 'Your role can’t take this action.'}</span>
                      </span>
                    </li>
                  );
                }
                const u = UNDO[a.reversible];
                return (
                  <li key={a.key}>
                    <span className="ic">
                      <Icon name={a.icon} />
                    </span>
                    <span className="ab-cell">
                      <span className="small strong">{a.label}</span>
                      <span className="xs muted">
                        {c.what} · {a.byTrust ? 'done by Trust' : `sent to ${c.owner}`}
                      </span>
                      <span className={cx('trr-undo', u.cls)}>
                        <Icon name={u.icon} />
                        {u.text}
                      </span>
                    </span>
                    <Button variant="secondary" size="sm" onClick={() => openAction(a.key)} srLabel={a.label}>
                      Choose
                    </Button>
                  </li>
                );
              })}
            </ul>
          </Card>

          <Card title="Timeline" sub="Every report, assignment and action, oldest first">
            <Timeline events={timeline} />
          </Card>
        </div>
      </div>

      <Dialog
        open={view === 'take-action'}
        onClose={() => setView('')}
        title={`Take action on ${d.ref}`}
        size="lg"
        foot={
          <>
            <Button variant="ghost" onClick={() => setView('')}>
              Cancel
            </Button>
            <Button variant={draft.action === 'suspend' ? 'danger' : 'primary'} onClick={submit} disabled={submitM.isPending}>
              {available(selC) ? selC.submit : sel.submit}
            </Button>
          </>
        }
      >
        <p className="small sub">{d.title}</p>
        {submitM.isError && (
          <Alert tone="danger" title="The action wasn’t recorded">
            {errorMessage(submitM.error)}
          </Alert>
        )}
        <fieldset className="stack gap-2 fieldset-reset">
          <legend className="label">Action</legend>
          {TRUST_ACTIONS.map((a) => {
            const c = actions[a.key];
            const u = UNDO[a.reversible];
            const ok = available(c) && allowed(a.key);
            return (
              <OptionCard
                key={a.key}
                id={`tra-${a.key}`}
                name="tra-action"
                title={
                  <span className="row gap-2">
                    <span className="small strong">{a.label}</span>
                    {a.key === step?.action && <Badge tone="brand">Recommended</Badge>}
                  </span>
                }
                body={!available(c) ? `Does not apply: ${c.unavailable}` : !allowed(a.key) ? 'Your role can’t take this action.' : `${c.what} · ${a.byTrust ? 'done by Trust' : `sent to ${c.owner}`}`}
                right={ok ? <span className={cx('trr-undo', u.cls)}>{u.text}</span> : undefined}
                checked={draft.action === a.key}
                disabled={!ok}
                onChange={() => setDraft((x) => ({ ...x, action: a.key, reason: '', reporter: '' }))}
              />
            );
          })}
        </fieldset>
        {errors.action && (
          <span className="error-text">
            <Icon name="circle-alert" className="ic-sm" />
            {errors.action}
          </span>
        )}
        {selCase && (
          <div className="panel trr-conseq">
            <span className="small strong">What happens</span>
            <span className="r">
              <Icon name="info" />
              <span>{selCase.consequence}</span>
            </span>
            <span className="r">
              <Icon name={UNDO[sel.reversible].icon} />
              <span>{sel.undo}</span>
            </span>
            <span className="r">
              <Icon name="user-round" />
              <span>
                {sel.byTrust
                  ? 'Done by Trust and Risk as soon as you confirm.'
                  : canDecide
                    ? `Trust recommends; ${selCase.owner} carries it out from their queue and records it. Above their approval limit it waits for approval.`
                    : `Saved as a draft recommendation; a Trust and Risk decider sends it to ${selCase.owner}.`}
              </span>
            </span>
            {selCase.done && (
              <span className="r">
                <Icon name="circle-check" />
                <span>Already in place: {selCase.done}</span>
              </span>
            )}
          </div>
        )}
        <Field
          label={draft.action === 'resolve' ? 'Outcome' : 'Reason code'}
          hint={
            draft.action === 'resolve' && withOwners
              ? 'Only “Referred” can close it while a recommendation is with an owner team. Withdraw the recommendation, or wait for the owner’s decision, to record another outcome.'
              : draft.reason
                ? <>Written to Action history as <span className="mono">{reasonCode(draft.reason)}</span></>
                : 'Written to Action history with your name and this report'
          }
          error={errors.reason}
        >
          <Select id="tra-reason" options={[{ value: '', label: draft.action === 'resolve' ? 'Select the outcome' : 'Select a reason code' }, ...reasonOptions]} value={draft.reason} onChange={(e) => chooseReason(e.target.value)} />
        </Field>
        <Field label={draft.action === 'resolve' ? 'Summary for the record' : 'Note for the record'} optional hint={draft.action === 'request-info' ? 'Sent with the request, so write it for the person you are asking.' : 'Staff only. Saved with the reason code.'}>
          <Textarea id="tra-note" placeholder="What you checked and why" value={draft.note} onChange={(e) => set('note', e.target.value)} />
        </Field>
        {(draft.action === 'resolve' || draft.action === 'dismiss') && (
          <Field label="What the reporter is told" hint="Shown to the reporter with the outcome in their account. Never name the other party." error={errors.reporter}>
            <Textarea id="tra-reporter" value={draft.reporter} onChange={(e) => set('reporter', e.target.value)} placeholder="Choose the outcome or reason to start from a suggested message" />
          </Field>
        )}
      </Dialog>

      <Dialog
        open={reopening}
        onClose={() => setReopening(false)}
        title={`Reopen ${d.ref}`}
        foot={
          <>
            <Button variant="ghost" onClick={() => setReopening(false)}>
              Cancel
            </Button>
            <Button
              onClick={() => {
                setReopenTried(true);
                if (reopenReason.trim()) reopen.mutate();
              }}
              disabled={reopen.isPending}
            >
              Reopen report
            </Button>
          </>
        }
      >
        <p className="small sub">The report goes back to Under review with a new decision deadline. The earlier outcome stays in the timeline and Action history.</p>
        {reopen.isError && (
          <Alert tone="danger" title="The report wasn’t reopened">
            {errorMessage(reopen.error)}
          </Alert>
        )}
        <Field label="What changed" hint="For example: new evidence from the brand owner" error={reopenTried && !reopenReason.trim() ? 'Say why the report is reopened.' : undefined}>
          <Textarea id="tra-reopen" value={reopenReason} onChange={(e) => setReopenReason(e.target.value)} />
        </Field>
      </Dialog>
    </AdminLayout>
  );
}
