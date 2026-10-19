import { useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Link } from 'react-router';
import { call, errorMessage, useApi } from '@marketly/web-shared/api';
import { href } from '@marketly/web-shared/routes';
import { Alert, Badge, Button, Card, Dialog, EmptyState, Field, OptionCard, Pager, Select, TextInput, Textarea, announce } from '@marketly/web-shared/ui';
import { useStaffSession } from '@/app/session';
import { LoadError, SkeletonLines, dateTime } from '@/app/parts';
import { OWNER_TEAM, REC_STATE, ownerLabel, subjectHref, type Recommendation } from './data/trust';
import { decidable, externalRefHint, needsExternalRef, paramsSummary, withdrawable } from './data/trust-decisions';

// Owner-team decisions on Trust and Risk recommendations (review §2a #7). Trust recommends; the team that owns the
// action (Catalog, Seller Manager, Support, Finance…) accepts it, which records an Enforcement the owning module
// carries out, or declines it with a reason. Trust and Risk deciders can send a draft to the owner or withdraw it.
// Used on admin/trust (the "Recommendations" view: GET /api/admin/trust/recommendations, the caller's teams) and on
// admin/trust-report (the report's own recommendations, from GET /reports/{id}).
// Endpoints: POST /api/admin/trust/recommendations/{id}/decide {accept, reason, externalRef?},
// …/{id}/withdraw {reason}, …/{id}/route. None needs step-up or an Idempotency-Key.

export interface Done {
  title: string;
  text: string;
}

type Mode = 'decide' | 'withdraw';

/** Invalidates everything a recommendation decision changes: reports, the owner list, work queues, the bell. */
function useRefresh() {
  const qc = useQueryClient();
  return () => {
    void qc.invalidateQueries({ queryKey: ['trust'] });
    void qc.invalidateQueries({ queryKey: ['workqueues', 'queues'] });
    void qc.invalidateQueries({ queryKey: ['notifications', 'summary', 'staff'] });
  };
}

/**
 * One recommendation with the actions the viewer may take on it. `showTargets` lists the subjects (the owner list
 * has no report around it). Results are reported through `onDone` so the page shows them in its own notice.
 */
export function RecommendationItem({ r, showTargets, onDone }: { r: Recommendation; showTargets?: boolean; onDone: (d: Done) => void }) {
  const { api } = useApi();
  const refresh = useRefresh();
  const { can, accountId } = useStaffSession();
  const [mode, setMode] = useState<Mode | null>(null);
  const [accept, setAccept] = useState(true);
  const [reason, setReason] = useState('');
  const [externalRef, setExternalRef] = useState('');
  const [attempted, setAttempted] = useState(false);

  const canOwnerDecide = can('trust.recommendations.decide') && decidable(r);
  // Separate duties: whoever drafted or routed it can't decide it (SEPARATE_DUTIES); say so up front.
  const ownWork = !!accountId && (r.createdBy?.staffId === accountId || r.routedBy?.staffId === accountId);
  const canWithdraw = can('trust.reports.decide') && withdrawable(r);
  const canRoute = can('trust.reports.decide') && r.state === 'pending';
  const refNeeded = accept && needsExternalRef(r.action);

  const st = r.approvalRequestId && r.state === 'sent_to_owner' ? { label: 'Waiting for approval', tone: 'warning' as const } : (REC_STATE[r.state] ?? { label: r.state, tone: '' as const });
  const team = (OWNER_TEAM[r.ownerTeam] ?? r.ownerTeam).split(' · ')[0];

  const decide = useMutation({
    mutationFn: () =>
      call(
        api.POST('/api/admin/trust/recommendations/{id}/decide', {
          params: { path: { id: r.id } },
          body: { accept, reason: reason.trim(), ...(accept && externalRef.trim() ? { externalRef: externalRef.trim() } : {}) },
        }),
      ),
    onSuccess: (out) => {
      setMode(null);
      refresh();
      if (out.approval) {
        onDone({ title: 'Sent for approval', text: `Accepting “${r.label}” is above your approval limit, so it waits in the approvals Inbox. It is accepted when the request is approved.` });
        announce('Accept sent for approval');
      } else if (accept) {
        onDone({ title: 'Recommendation accepted', text: `“${r.label}” is accepted and recorded as an enforcement${out.enforcement?.ref ? ` (${out.enforcement.ref})` : ''}. ${needsExternalRef(r.action) ? 'It is linked to the record you named.' : 'The owning module carries it out; the report shows when it is applied.'}` });
        announce('Recommendation accepted');
      } else {
        onDone({ title: 'Recommendation declined', text: `“${r.label}” is declined. Trust and Risk sees your reason on the report.` });
        announce('Recommendation declined');
      }
    },
  });

  const withdraw = useMutation({
    mutationFn: () => call(api.POST('/api/admin/trust/recommendations/{id}/withdraw', { params: { path: { id: r.id } }, body: { reason: reason.trim() } })),
    onSuccess: () => {
      setMode(null);
      refresh();
      onDone({ title: 'Recommendation withdrawn', text: `“${r.label}” is withdrawn${r.state === 'sent_to_owner' ? ` and leaves ${team}’s queue` : ''}.` });
      announce('Recommendation withdrawn');
    },
  });

  const route = useMutation({
    mutationFn: () => call(api.POST('/api/admin/trust/recommendations/{id}/route', { params: { path: { id: r.id } } })),
    onSuccess: () => {
      refresh();
      onDone({ title: 'Sent to the owner team', text: `“${r.label}” is in ${team}’s queue to accept or decline.` });
      announce(`Sent to ${team}`);
    },
  });

  const open = (m: Mode) => {
    setMode(m);
    setAccept(true);
    setReason('');
    setExternalRef('');
    setAttempted(false);
    decide.reset();
    withdraw.reset();
  };
  const errors = attempted
    ? {
        reason: reason.trim() ? undefined : mode === 'withdraw' ? 'Say why it is withdrawn.' : accept ? 'Record the reason for the action.' : 'Say why it is declined.',
        externalRef: refNeeded && !externalRef.trim() ? 'Enter the reference of the record you created.' : undefined,
      }
    : {};
  const submit = () => {
    setAttempted(true);
    if (!reason.trim()) return;
    if (mode === 'withdraw') return withdraw.mutate();
    if (refNeeded && !externalRef.trim()) return;
    decide.mutate();
  };
  const busy = decide.isPending || withdraw.isPending;
  const err = mode === 'withdraw' ? withdraw.error : decide.error;
  const params = paramsSummary(r.params);

  return (
    <li>
      <span className="stack gap-0">
        <span className="small strong">{r.label}</span>
        <span className="xs muted">
          {ownerLabel(r)}
          {r.routedAt ? ` · sent ${dateTime(r.routedAt)}` : ''}
          {r.createdBy?.name ? ` · by ${r.createdBy.name}` : ''}
        </span>
        {showTargets && r.targets.length > 0 && (
          <span className="xs">
            {r.targets.map((t, i) => (
              <span key={t.type + t.id}>
                {i > 0 && ', '}
                <Link to={subjectHref(t)}>{t.label}</Link>
              </span>
            ))}
          </span>
        )}
      </span>
      <Badge tone={st.tone}>{st.label}</Badge>
      {(r.decisionReason || r.rationale) && <span className="xs sub">{r.decisionReason ? `Reason recorded: ${r.decisionReason}` : `Trust’s reason: ${r.rationale}`}</span>}
      {(canOwnerDecide || canWithdraw || canRoute) && (
        <span className="xs row gap-2">
          {canOwnerDecide &&
            (ownWork ? (
              <span className="xs muted">You drafted or sent this one, so someone else in {team} decides it.</span>
            ) : (
              <Button size="sm" onClick={() => open('decide')} srLabel={r.label}>
                Accept or decline
              </Button>
            ))}
          {canRoute && (
            <Button variant="secondary" size="sm" onClick={() => route.mutate()} disabled={route.isPending} srLabel={r.label}>
              Send to {team}
            </Button>
          )}
          {canWithdraw && (
            <Button variant="ghost" size="sm" onClick={() => open('withdraw')} srLabel={r.label}>
              Withdraw
            </Button>
          )}
        </span>
      )}
      {route.isError && <span className="xs error-text">It wasn’t sent: {errorMessage(route.error)}</span>}

      <Dialog
        open={mode !== null}
        onClose={() => setMode(null)}
        title={mode === 'withdraw' ? 'Withdraw recommendation' : 'Accept or decline'}
        foot={
          <>
            <Button variant="ghost" onClick={() => setMode(null)}>
              Cancel
            </Button>
            <Button variant={mode === 'withdraw' || !accept ? 'secondary' : 'primary'} onClick={submit} disabled={busy}>
              {mode === 'withdraw' ? 'Withdraw' : accept ? 'Accept and record' : 'Decline'}
            </Button>
          </>
        }
      >
        <p className="small strong">{r.label}</p>
        <p className="small sub">Trust’s reason: {r.rationale}</p>
        {params.length > 0 && <p className="xs muted">{params.join(' · ')}</p>}
        {err && (
          <Alert tone="danger" title={mode === 'withdraw' ? 'It wasn’t withdrawn' : 'The decision wasn’t recorded'}>
            {errorMessage(err)}
          </Alert>
        )}
        {mode === 'decide' && (
          <fieldset className="stack gap-2 fieldset-reset">
            <legend className="label">Decision</legend>
            <OptionCard id={`rec-${r.id}-accept`} name={`rec-${r.id}`} title="Accept" body={needsExternalRef(r.action) ? 'Records the enforcement against the record you created in your own screen.' : 'Records the enforcement; the owning module carries it out. Above your approval limit it waits for approval.'} checked={accept} onChange={() => setAccept(true)} />
            <OptionCard id={`rec-${r.id}-decline`} name={`rec-${r.id}`} title="Decline" body="Nothing changes for the subject. Trust and Risk sees your reason." checked={!accept} onChange={() => setAccept(false)} />
          </fieldset>
        )}
        {mode === 'decide' && refNeeded && (
          <Field label="Reference of what you did" hint={externalRefHint(r.action)} error={errors.externalRef}>
            <TextInput id={`rec-${r.id}-ref`} value={externalRef} error={!!errors.externalRef} onChange={(e) => setExternalRef(e.target.value)} placeholder="" />
          </Field>
        )}
        <Field label={mode === 'withdraw' ? 'Why it is withdrawn' : 'Reason for the record'} hint="Written to Action history with your name" error={errors.reason}>
          <Textarea id={`rec-${r.id}-reason`} value={reason} onChange={(e) => setReason(e.target.value)} placeholder={mode === 'withdraw' ? 'For example: new evidence clears the seller' : 'What you checked'} />
        </Field>
      </Dialog>
    </li>
  );
}

const STATE_OPTIONS = [
  { value: 'sent_to_owner', label: 'Waiting for my team' },
  { value: 'completed', label: 'Accepted' },
  { value: 'declined', label: 'Declined' },
  { value: 'withdrawn', label: 'Withdrawn' },
];

/**
 * The "Recommendations" view on admin/trust: recommendations routed to the teams whose actions the caller may
 * decide (the backend works the teams out from the caller's permissions), oldest first, with paging.
 */
export function useOwnerRecommendations(state = 'sent_to_owner', page = 1, enabled = true) {
  const { api } = useApi();
  return useQuery({
    queryKey: ['trust', 'recommendations', 'owner', state, page],
    enabled,
    queryFn: () => call(api.GET('/api/admin/trust/recommendations', { params: { query: { state: state as 'sent_to_owner', page, limit: 20 } } })),
  });
}

export function OwnerRecommendations({ onDone }: { onDone: (d: Done) => void }) {
  const [state, setState] = useState('sent_to_owner');
  const [page, setPage] = useState(1);
  const list = useOwnerRecommendations(state, page);
  const items = list.data?.items ?? [];
  const totalPages = list.data?.totalPages ?? 1;

  return (
    <Card
      title="Recommendations for your team"
      sub="Trust and Risk recommends; your team accepts (the action is recorded and carried out) or declines with a reason"
      actions={
        <Select
          id="trr-state"
          aria-label="Show"
          ctl="sm"
          options={STATE_OPTIONS}
          value={state}
          onChange={(e) => {
            setState(e.target.value);
            setPage(1);
          }}
        />
      }
    >
      {list.isPending ? (
        <SkeletonLines rows={3} />
      ) : list.isError ? (
        <LoadError error={list.error} onRetry={() => void list.refetch()} title="We couldn’t load the recommendations" />
      ) : items.length ? (
        <>
          <ul className="ab-route">
            {items.map((r) => (
              <RecommendationItem key={r.id} r={r} showTargets onDone={onDone} />
            ))}
          </ul>
          {totalPages > 1 && <Pager page={page} total={totalPages} onPage={setPage} />}
        </>
      ) : (
        <EmptyState icon="shield-check" title={state === 'sent_to_owner' ? 'Nothing waiting for your team' : 'None here'} as="h3">
          {state === 'sent_to_owner' ? 'When Trust and Risk sends your team a recommendation, it appears here and in My work queues.' : 'Recommendations your team decided appear here.'}
        </EmptyState>
      )}
      <p className="ab-note">
        Some actions are done in your own screen first (for example a payout hold in Finance); you then accept with that record’s reference. <Link to={href('admin/audit')}>Action history</Link> keeps every decision.
      </p>
    </Card>
  );
}
