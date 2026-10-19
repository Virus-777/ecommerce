import { useState } from 'react';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { call, errorMessage, useApi } from '@marketly/web-shared/api';
import { Alert, Button, Dialog, Field, OptionCard, Select, Textarea, announce } from '@marketly/web-shared/ui';
import { useStaffSession } from '@/app/session';
import { useStaffOptions } from './data/audit';
import type { TrustAppeal } from './data/trust';
import { APPEAL_OUTCOMES, appealActionable, type AppealOutcome } from './data/trust-decisions';
import type { Done } from './TrustRecommendations';

// Assign and decide Trust appeals from the Appeals card on admin/trust (review §2a #7).
// POST /api/admin/trust/appeals/{id}/assign {reviewerId} (open → under review) and …/{id}/decide {outcome,
// explanation, changes?} (from under review). The reviewer must not be the person who recommended or accepted the
// original action (SAME_REVIEWER_NOT_ALLOWED); overturning reverses the enforcement. Seller account appeals
// (source "sellers") are mirrored read-only here and decided in Sellers.

type Mode = 'assign' | 'decide';

export function AppealActions({ a, onDone }: { a: TrustAppeal; onDone: (d: Done) => void }) {
  const { api } = useApi();
  const qc = useQueryClient();
  const { can, accountId, name: me } = useStaffSession();
  const canDecide = can('trust.appeals.decide');
  // The staff picker lists members, which needs access.roles.view; without it the reviewer can only be you.
  const staff = useStaffOptions(canDecide && can('access.roles.view'));
  const [mode, setMode] = useState<Mode | null>(null);
  const [reviewer, setReviewer] = useState('');
  const [outcome, setOutcome] = useState<AppealOutcome | ''>('');
  const [explanation, setExplanation] = useState('');
  const [changes, setChanges] = useState('');
  const [attempted, setAttempted] = useState(false);

  const refresh = () => {
    void qc.invalidateQueries({ queryKey: ['trust'] });
    void qc.invalidateQueries({ queryKey: ['workqueues', 'queues'] });
  };

  const assign = useMutation({
    mutationFn: (reviewerId: string) => call(api.POST('/api/admin/trust/appeals/{id}/assign', { params: { path: { id: a.id } }, body: { reviewerId } })),
    onSuccess: (out) => {
      setMode(null);
      refresh();
      onDone({ title: 'Reviewer assigned', text: `${out.ref} is with ${out.reviewer?.name ?? 'the reviewer'} to decide by the deadline.` });
      announce(`${out.ref} assigned`);
    },
  });

  const decide = useMutation({
    mutationFn: () =>
      call(
        api.POST('/api/admin/trust/appeals/{id}/decide', {
          params: { path: { id: a.id } },
          body: { outcome: outcome as AppealOutcome, explanation: explanation.trim(), ...(outcome === 'partly_overturn' && changes.trim() ? { changes: { summary: changes.trim() } } : {}) },
        }),
      ),
    onSuccess: (out) => {
      setMode(null);
      refresh();
      const label = APPEAL_OUTCOMES.find((x) => x.value === outcome)?.label.toLowerCase() ?? 'decided';
      onDone({
        title: 'Appeal decided',
        text: `${out.ref}: ${label}. ${outcome === 'overturn' ? 'The action is reversed and the owning team gets a work item to check the undo. ' : ''}The appellant is told the outcome and your explanation in their account.`,
      });
      announce(`${out.ref} decided`);
    },
  });

  if (!canDecide || !appealActionable(a)) {
    return a.source === 'sellers' && appealActionable(a) ? <span className="xs muted">Decided in Sellers</span> : null;
  }

  const open = (m: Mode) => {
    setMode(m);
    setReviewer('');
    setOutcome('');
    setExplanation('');
    setChanges('');
    setAttempted(false);
    assign.reset();
    decide.reset();
  };
  // The original decider never reviews (the server also refuses whoever recommended or accepted the action).
  const iDecided = a.originalDecider.staffId === accountId;
  const options = [...staff.entries()].filter(([id]) => id !== a.originalDecider.staffId).map(([value, label]) => ({ value, label: value === accountId ? `${label} (you)` : label }));
  if (!iDecided && !options.some((o) => o.value === accountId)) options.unshift({ value: accountId, label: `${me || 'Me'} (you)` });
  const errors = attempted
    ? {
        reviewer: reviewer ? undefined : 'Choose who reviews the appeal.',
        outcome: outcome ? undefined : 'Choose the outcome.',
        explanation: explanation.trim() ? undefined : 'Explain the decision. The appellant reads it.',
        changes: outcome === 'partly_overturn' && !changes.trim() ? 'Describe what changes.' : undefined,
      }
    : {};
  const submit = () => {
    setAttempted(true);
    if (mode === 'assign') {
      if (reviewer) assign.mutate(reviewer);
      return;
    }
    if (!outcome || !explanation.trim() || (outcome === 'partly_overturn' && !changes.trim())) return;
    decide.mutate();
  };
  const err = mode === 'assign' ? assign.error : decide.error;
  const notReviewer = !!a.reviewer && a.reviewer.staffId !== accountId;

  return (
    <span className="row gap-2 nowrap">
      <Button variant="ghost" size="sm" onClick={() => open('assign')} srLabel={a.ref}>
        {a.reviewer ? 'Reassign' : 'Assign'}
      </Button>
      {/* Usually the assigned reviewer decides; the server refuses only people tied to the original action. */}
      {a.state === 'under_review' && !iDecided && (
        <Button variant="secondary" size="sm" onClick={() => open('decide')} srLabel={a.ref}>
          Decide
        </Button>
      )}
      <Dialog
        open={mode !== null}
        onClose={() => setMode(null)}
        title={mode === 'assign' ? `Assign ${a.ref}` : `Decide ${a.ref}`}
        foot={
          <>
            <Button variant="ghost" onClick={() => setMode(null)}>
              Cancel
            </Button>
            <Button onClick={submit} disabled={assign.isPending || decide.isPending}>
              {mode === 'assign' ? 'Assign reviewer' : 'Record decision'}
            </Button>
          </>
        }
      >
        <p className="small sub">
          {a.appellantName} appeals: {a.decisionAppealed}
        </p>
        {err && (
          <Alert tone="danger" title={mode === 'assign' ? 'The reviewer wasn’t assigned' : 'The decision wasn’t recorded'}>
            {errorMessage(err)}
          </Alert>
        )}
        {mode === 'assign' ? (
          <Field label="Reviewer" hint={`Someone other than ${a.originalDecider.name}, who made the original decision, and whoever recommended or accepted it.`} error={errors.reviewer}>
            <Select id={`ap-${a.id}-rev`} options={[{ value: '', label: 'Choose a reviewer' }, ...options]} value={reviewer} onChange={(e) => setReviewer(e.target.value)} />
          </Field>
        ) : (
          <>
            {notReviewer && <p className="xs muted">{a.reviewer!.name} is the assigned reviewer. Decide only if you are taking it over.</p>}
            <div className="panel small">
              <span className="strong">Their argument</span>
              <p>{a.argument}</p>
            </div>
            <fieldset className="stack gap-2 fieldset-reset">
              <legend className="label">Outcome</legend>
              {APPEAL_OUTCOMES.map((o) => (
                <OptionCard key={o.value} id={`ap-${a.id}-${o.value}`} name={`ap-${a.id}-out`} title={o.label} body={o.body} checked={outcome === o.value} onChange={() => setOutcome(o.value)} />
              ))}
            </fieldset>
            {errors.outcome && <span className="error-text">{errors.outcome}</span>}
            {outcome === 'partly_overturn' && (
              <Field label="What changes" hint="The owning team applies it, for example a shorter restriction" error={errors.changes}>
                <Textarea id={`ap-${a.id}-chg`} value={changes} onChange={(e) => setChanges(e.target.value)} />
              </Field>
            )}
            <Field label="Explanation for the appellant" hint="Shown to them with the outcome, and written to Action history" error={errors.explanation}>
              <Textarea id={`ap-${a.id}-exp`} value={explanation} onChange={(e) => setExplanation(e.target.value)} />
            </Field>
          </>
        )}
      </Dialog>
    </span>
  );
}
