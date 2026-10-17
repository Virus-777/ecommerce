// Seller decisions that finish the flows the Seller, Sellers and Seller application screens start (gap review §2a #7):
// reinstate a suspended seller, add or lift a restriction, send or resolve a warning, decide a launch readiness review
// and decide a seller appeal. None of these endpoints asks for step-up; adding a restriction above the caller's
// authority is saved as "waiting for approval" by the backend itself (it never answers APPROVAL_REQUIRED).
// Writes: POST /api/admin/sellers/sellers/{id}/reinstate, …/sellers/{id}/restrictions, …/restrictions/{id}/lift,
// …/sellers/{id}/warnings, …/warnings/{id}/resolve, …/sellers/{id}/launch-review/decide, …/appeals/{id}/assign,
// …/appeals/{id}/decide. Read: POST /api/admin/access/authority-checks (does a new restriction need a second reviewer).
import { useState, type ReactNode } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { call, errorMessage, useApi, type components } from '@marketly/web-shared/api';
import { Alert, Button, Checkbox, Dialog, Field, OptionCard, Select, Textarea, TextInput, announce } from '@marketly/web-shared/ui';
import { cap, isoDay, type Appeal, type Restriction } from './seller';

type S = components['schemas'];
export type RestrictionInput = S['sellers.RestrictionInput'];
export type SellerWarning = S['sellers.SellerWarning'];
export type LaunchReview = S['sellers.LaunchReview'];
type Activity = RestrictionInput['affectedActivities'][number];
type RestrictionReason = RestrictionInput['reasonCode'];

/** After any seller decision: the seller screens, the work queue counts and the staff notification badge. */
export function useSellerRefresh() {
  const qc = useQueryClient();
  return () => {
    void qc.invalidateQueries({ queryKey: ['sellers'] });
    void qc.invalidateQueries({ queryKey: ['workqueues'] });
    void qc.invalidateQueries({ queryKey: ['notifications', 'summary', 'staff'] });
  };
}

/* ------------------------------------------------------------------ restriction form (also used for approval conditions) */

export const RESTRICTION_REASONS: Array<{ value: RestrictionReason; label: string }> = [
  { value: 'performance', label: 'Performance below target' },
  { value: 'policy_violation', label: 'Policy violation' },
  { value: 'brand_claim', label: 'Brand claim' },
  { value: 'counterfeit_risk', label: 'Counterfeit risk' },
  { value: 'fraud_risk', label: 'Fraud risk' },
  { value: 'unresolved_cases', label: 'Unresolved cases' },
  { value: 'verification_lapsed', label: 'Verification lapsed' },
  { value: 'approval_condition', label: 'Condition of approval' },
  { value: 'other', label: 'Other' },
];
export const ACTIVITIES: Array<{ value: Activity; label: string }> = [
  { value: 'new_listings', label: 'New listings' },
  { value: 'new_offers', label: 'New offers' },
  { value: 'product_submissions', label: 'New product submissions' },
  { value: 'offer_reactivation', label: 'Reactivating paused offers' },
  { value: 'sales', label: 'Sales (offers stop being sold)' },
  { value: 'advertising', label: 'Advertising' },
  { value: 'promotions', label: 'Promotions' },
  { value: 'payout_schedule', label: 'Payout schedule' },
];

export interface RestrictionDraft {
  title: string;
  reasonCode: RestrictionReason;
  reason: string;
  affectedActivities: Activity[];
  toResolve: string;
  reviewDate: string;
}
export const blankRestriction = (reasonCode: RestrictionReason = 'performance'): RestrictionDraft => ({ title: '', reasonCode, reason: '', affectedActivities: ['new_listings'], toResolve: '', reviewDate: isoDay(30) });

/** The same checks the backend makes (enforcement.validateInput), so the form says what is missing before sending. */
export function restrictionErrors(d: RestrictionDraft): Partial<Record<keyof RestrictionDraft, string>> {
  const e: Partial<Record<keyof RestrictionDraft, string>> = {};
  if (!d.title.trim()) e.title = 'Give the restriction a short title, e.g. New listings in Cameras paused.';
  if (!d.reason.trim()) e.reason = 'State the facts and the rule. The seller reads this.';
  if (!d.affectedActivities.length) e.affectedActivities = 'Choose at least one affected activity.';
  if (!d.toResolve.trim()) e.toResolve = 'Tell the seller how to resolve it.';
  if (!d.reviewDate || d.reviewDate < isoDay(0)) e.reviewDate = 'Choose a review date from today on.';
  return e;
}
export const restrictionBody = (d: RestrictionDraft): RestrictionInput => ({
  title: d.title.trim(),
  reasonCode: d.reasonCode,
  reason: d.reason.trim(),
  affectedActivities: d.affectedActivities,
  toResolve: d.toResolve.trim(),
  reviewDate: d.reviewDate,
});

/** Fields of a restriction. It always applies to the whole account (the API's scope is left out). */
export function RestrictionFields({ idPrefix, draft, onChange, errors }: { idPrefix: string; draft: RestrictionDraft; onChange: (d: RestrictionDraft) => void; errors: Partial<Record<keyof RestrictionDraft, string>> }) {
  const set = <K extends keyof RestrictionDraft>(k: K, v: RestrictionDraft[K]) => onChange({ ...draft, [k]: v });
  const toggle = (a: Activity, on: boolean) => set('affectedActivities', on ? [...draft.affectedActivities, a] : draft.affectedActivities.filter((x) => x !== a));
  return (
    <>
      <div className="grid md2 gap-3">
        <Field label="Title" hint="Short label the seller sees" error={errors.title}>
          <TextInput id={`${idPrefix}-title`} value={draft.title} error={!!errors.title} onChange={(e) => set('title', e.target.value)} />
        </Field>
        <Field label="Reason">
          <Select id={`${idPrefix}-code`} options={RESTRICTION_REASONS} value={draft.reasonCode} onChange={(e) => set('reasonCode', e.target.value as RestrictionReason)} />
        </Field>
      </div>
      <Field label="Reason shown to the seller" error={errors.reason}>
        <Textarea id={`${idPrefix}-reason`} value={draft.reason} onChange={(e) => set('reason', e.target.value)} placeholder="The facts and the rule, e.g. 6 of the last 40 orders were dispatched late (target 95% on time)" />
      </Field>
      <div className="stack gap-2">
        <span className="label">What it stops</span>
        <div className="grid md2 gap-2">
          {ACTIVITIES.map((a) => (
            <Checkbox key={a.value} id={`${idPrefix}-act-${a.value}`} label={<span className="small">{a.label}</span>} checked={draft.affectedActivities.includes(a.value)} onChange={(e) => toggle(a.value, e.target.checked)} />
          ))}
        </div>
        {errors.affectedActivities && <span className="error-text">{errors.affectedActivities}</span>}
        <span className="xs muted">Applies to the whole account. Existing orders, returns, cases and messages keep working.</span>
      </div>
      <Field label="To resolve" error={errors.toResolve}>
        <Textarea id={`${idPrefix}-resolve`} value={draft.toResolve} onChange={(e) => set('toResolve', e.target.value)} placeholder="What the seller must do for the restriction to be lifted" />
      </Field>
      <Field label="Review date" error={errors.reviewDate}>
        <TextInput id={`${idPrefix}-date`} type="date" min={isoDay(0)} value={draft.reviewDate} error={!!errors.reviewDate} onChange={(e) => set('reviewDate', e.target.value)} />
      </Field>
    </>
  );
}

type Done = (title: string, body: string) => void;

/** Small dialog: one required text (reason or note) and a submit button. */
function TextDialog({
  title, intro, label, hint, placeholder, submitLabel, danger, required, pending, error, onClose, onSubmit, children,
}: {
  title: string; intro?: ReactNode; label: string; hint?: string; placeholder?: string; submitLabel: string; danger?: boolean; required: string;
  pending: boolean; error: unknown; onClose: () => void; onSubmit: (text: string) => void; children?: ReactNode;
}) {
  const [text, setText] = useState('');
  const [tried, setTried] = useState(false);
  const missing = tried && !text.trim() ? required : undefined;
  return (
    <Dialog
      open
      onClose={onClose}
      title={title}
      foot={
        <>
          <Button variant="ghost" onClick={onClose}>
            Cancel
          </Button>
          <Button variant={danger ? 'danger' : 'primary'} disabled={pending} onClick={() => (setTried(true), text.trim() && onSubmit(text.trim()))}>
            {submitLabel}
          </Button>
        </>
      }
    >
      {intro && <p className="small sub">{intro}</p>}
      {error ? (
        <Alert tone="danger" title="That didn’t work">
          {errorMessage(error)}
        </Alert>
      ) : null}
      {children}
      <Field label={label} hint={hint} error={missing}>
        <Textarea id="aa-sd-text" value={text} onChange={(e) => setText(e.target.value)} placeholder={placeholder} />
      </Field>
    </Dialog>
  );
}

/* ------------------------------------------------------------------ reinstate */

/** End a suspension. Active restrictions are kept unless unticked (the API lifts the unticked ones). */
export function ReinstateDialog({ sellerId, storeName, restrictions, onClose, onDone }: { sellerId: string; storeName: string; restrictions: Restriction[]; onClose: () => void; onDone: Done }) {
  const { api } = useApi();
  const active = restrictions.filter((r) => r.state === 'active');
  const [keep, setKeep] = useState<string[]>(active.map((r) => r.id));
  const reinstate = useMutation({
    mutationFn: (reason: string) => call(api.POST('/api/admin/sellers/sellers/{id}/reinstate', { params: { path: { id: sellerId } }, body: { reason, keepRestrictionIds: keep } })),
    onSuccess: (res) => {
      announce('Seller reinstated');
      onDone('Suspension ended', res.status === 'restricted' ? `${storeName} can sell again, with the restrictions you kept.` : `${storeName} can sell again.`);
      onClose();
    },
  });
  return (
    <TextDialog
      title={`Reinstate ${storeName}`}
      intro="The suspension ends now. Offers that are still eligible can be sold again. The seller sees your reason."
      label="Reason"
      hint="Recorded in the action history and shown to the seller."
      placeholder="e.g. Dispatch is back on target and the open cases are resolved"
      submitLabel="Reinstate seller"
      required="Say why the suspension ends."
      pending={reinstate.isPending}
      error={reinstate.error}
      onClose={onClose}
      onSubmit={(t) => reinstate.mutate(t)}
    >
      {active.length > 0 && (
        <div className="stack gap-2">
          <span className="label">Restrictions to keep</span>
          {active.map((r) => (
            <Checkbox key={r.id} id={`aa-rs-k-${r.id}`} label={<span className="small">{r.title}</span>} checked={keep.includes(r.id)} onChange={(e) => setKeep((k) => (e.target.checked ? [...k, r.id] : k.filter((x) => x !== r.id)))} />
          ))}
          <span className="xs muted">Unticked restrictions are lifted with the same reason.</span>
        </div>
      )}
    </TextDialog>
  );
}

/* ------------------------------------------------------------------ restrictions */

export function AddRestrictionDialog({ sellerId, storeName, onClose, onDone }: { sellerId: string; storeName: string; onClose: () => void; onDone: Done }) {
  const { api } = useApi();
  const [draft, setDraft] = useState<RestrictionDraft>(() => blankRestriction());
  const [tried, setTried] = useState(false);
  // Whether the caller's role can restrict directly or the backend will send it for a second reviewer.
  const authority = useQuery({
    queryKey: ['access', 'authority', 'sellers.sellers.restrict'],
    queryFn: () => call(api.POST('/api/admin/access/authority-checks', { body: { action: 'sellers.sellers.restrict' } })),
    retry: false,
  });
  const save = useMutation({
    mutationFn: () => call(api.POST('/api/admin/sellers/sellers/{id}/restrictions', { params: { path: { id: sellerId } }, body: restrictionBody(draft) })),
    onSuccess: (r) => {
      announce('Restriction saved');
      onDone(
        r.state === 'pending_approval' ? 'Restriction sent for approval' : 'Restriction added',
        r.state === 'pending_approval'
          ? `${r.title} waits for ${r.approval?.approvers.join(' or ') || 'a second reviewer'}. It takes effect once approved.`
          : `${r.title} is in force. ${storeName} sees the reason and how to resolve it.`,
      );
      onClose();
    },
  });
  const errors = tried ? restrictionErrors(draft) : {};
  const submit = () => {
    setTried(true);
    if (!Object.keys(restrictionErrors(draft)).length) save.mutate();
  };
  const a = authority.data;
  return (
    <Dialog
      open
      onClose={onClose}
      title={`Restrict ${storeName}`}
      size="lg"
      foot={
        <>
          <Button variant="ghost" onClick={onClose}>
            Cancel
          </Button>
          <Button variant="danger" disabled={save.isPending || a?.decision === 'denied'} onClick={submit}>
            {a?.decision === 'approval_required' ? 'Send for approval' : 'Add restriction'}
          </Button>
        </>
      }
    >
      {a?.decision === 'approval_required' && (
        <Alert tone="info" title="Needs a second reviewer">
          {`${a.reason}. ${a.eligibleApprovers.length ? `${a.eligibleApprovers.map((p) => p.name).join(', ')} can approve it.` : ''}`}
        </Alert>
      )}
      {a?.decision === 'denied' && (
        <Alert tone="warning" title="Your role cannot restrict sellers">
          {a.reason}
        </Alert>
      )}
      {save.isError && (
        <Alert tone="danger" title="We couldn’t save the restriction">
          {errorMessage(save.error)}
        </Alert>
      )}
      <RestrictionFields idPrefix="aa-rs" draft={draft} onChange={setDraft} errors={errors} />
    </Dialog>
  );
}

export function LiftRestrictionDialog({ r, onClose, onDone }: { r: Restriction; onClose: () => void; onDone: Done }) {
  const { api } = useApi();
  const lift = useMutation({
    mutationFn: (reason: string) => call(api.POST('/api/admin/sellers/restrictions/{id}/lift', { params: { path: { id: r.id } }, body: { reason } })),
    onSuccess: () => {
      announce('Restriction lifted');
      onDone('Restriction lifted', `${r.title} no longer applies. The seller sees your reason.`);
      onClose();
    },
  });
  return (
    <TextDialog
      title="Lift restriction"
      intro={`${r.title}. What it stopped works again as soon as it is lifted.`}
      label="Reason"
      hint="Recorded in the action history and shown to the seller."
      placeholder="e.g. Dispatch has been on target for 30 days"
      submitLabel="Lift restriction"
      required="Say why the restriction is lifted."
      pending={lift.isPending}
      error={lift.error}
      onClose={onClose}
      onSubmit={(t) => lift.mutate(t)}
    />
  );
}

/* ------------------------------------------------------------------ warnings */

const WARNING_KINDS: Array<{ value: SellerWarning['kind']; label: string }> = [
  { value: 'performance', label: 'Performance' },
  { value: 'listing', label: 'Listing' },
  { value: 'policy', label: 'Policy' },
  { value: 'conduct', label: 'Conduct' },
];

export function WarningDialog({ sellerId, storeName, onClose, onDone }: { sellerId: string; storeName: string; onClose: () => void; onDone: Done }) {
  const { api } = useApi();
  const [kind, setKind] = useState<SellerWarning['kind']>('performance');
  const [title, setTitle] = useState('');
  const [detail, setDetail] = useState('');
  const [tried, setTried] = useState(false);
  const send = useMutation({
    mutationFn: () => call(api.POST('/api/admin/sellers/sellers/{id}/warnings', { params: { path: { id: sellerId } }, body: { kind, title: title.trim(), detail: detail.trim() } })),
    onSuccess: (w) => {
      announce('Warning sent');
      onDone('Warning sent', `${storeName} sees “${w.title}” in Seller Center.`);
      onClose();
    },
  });
  const tErr = tried && !title.trim() ? 'Give the warning a title.' : undefined;
  const dErr = tried && !detail.trim() ? 'Explain the warning and what the seller should do.' : undefined;
  return (
    <Dialog
      open
      onClose={onClose}
      title={`Warn ${storeName}`}
      foot={
        <>
          <Button variant="ghost" onClick={onClose}>
            Cancel
          </Button>
          <Button disabled={send.isPending} onClick={() => (setTried(true), title.trim() && detail.trim() && send.mutate())}>
            Send warning
          </Button>
        </>
      }
    >
      <p className="small sub">A warning does not stop any activity. It is the step before a restriction and stays on the seller’s record.</p>
      {send.isError && (
        <Alert tone="danger" title="We couldn’t send the warning">
          {errorMessage(send.error)}
        </Alert>
      )}
      <Field label="Kind">
        <Select id="aa-wn-kind" options={WARNING_KINDS} value={kind} onChange={(e) => setKind(e.target.value as SellerWarning['kind'])} />
      </Field>
      <Field label="Title" error={tErr}>
        <TextInput id="aa-wn-title" value={title} error={!!tErr} onChange={(e) => setTitle(e.target.value)} placeholder="e.g. Late dispatch is near the limit" />
      </Field>
      <Field label="Details shown to the seller" error={dErr}>
        <Textarea id="aa-wn-detail" value={detail} onChange={(e) => setDetail(e.target.value)} />
      </Field>
    </Dialog>
  );
}

export function ResolveWarningDialog({ w, onClose, onDone }: { w: SellerWarning; onClose: () => void; onDone: Done }) {
  const { api } = useApi();
  const resolve = useMutation({
    mutationFn: (note: string) => call(api.POST('/api/admin/sellers/warnings/{id}/resolve', { params: { path: { id: w.id } }, body: { note } })),
    onSuccess: () => {
      announce('Warning resolved');
      onDone('Warning resolved', `${w.title} is marked resolved.`);
      onClose();
    },
  });
  return (
    <TextDialog
      title="Resolve warning"
      intro={w.title}
      label="Resolution note"
      hint="Shown to the seller."
      submitLabel="Mark resolved"
      required="Add a resolution note."
      pending={resolve.isPending}
      error={resolve.error}
      onClose={onClose}
      onSubmit={(t) => resolve.mutate(t)}
    />
  );
}

/* ------------------------------------------------------------------ launch readiness review */

/**
 * Pass the launch readiness review or ask for changes. Only a passed review lets the seller's offers go live
 * (offers wait for launchReady), so this is the last staff step before a new seller sells. The backend accepts it
 * only while the review is requested.
 */
export function LaunchReviewDialog({ sellerId, storeName, onClose, onDone }: { sellerId: string; storeName: string; onClose: () => void; onDone: Done }) {
  const { api } = useApi();
  const [outcome, setOutcome] = useState<'pass' | 'changes_needed'>('pass');
  const [issues, setIssues] = useState('');
  const [note, setNote] = useState('');
  const [tried, setTried] = useState(false);
  // One issue per line: the seller gets them as a checklist.
  const list = issues.split('\n').map((s) => s.trim()).filter(Boolean);
  const decide = useMutation({
    mutationFn: () =>
      call(
        api.POST('/api/admin/sellers/sellers/{id}/launch-review/decide', {
          params: { path: { id: sellerId } },
          body: { outcome, issues: outcome === 'changes_needed' ? list : null, note: note.trim() || null },
        }),
      ),
    onSuccess: () => {
      announce('Launch review decided');
      onDone(
        outcome === 'pass' ? 'Launch review passed' : 'Changes requested',
        outcome === 'pass' ? `${storeName}'s eligible offers can now go live.` : `${storeName} sees ${list.length} change${list.length === 1 ? '' : 's'} to make before asking again.`,
      );
      onClose();
    },
  });
  const issuesErr = tried && outcome === 'changes_needed' && !list.length ? 'List what the seller must change, one per line.' : undefined;
  return (
    <Dialog
      open
      onClose={onClose}
      title={`Launch review · ${storeName}`}
      foot={
        <>
          <Button variant="ghost" onClick={onClose}>
            Cancel
          </Button>
          <Button disabled={decide.isPending} onClick={() => (setTried(true), (outcome === 'pass' || list.length) && decide.mutate())}>
            {outcome === 'pass' ? 'Pass review' : 'Ask for changes'}
          </Button>
        </>
      }
    >
      {decide.isError && (
        <Alert tone="danger" title="We couldn’t record the decision">
          {errorMessage(decide.error)}
        </Alert>
      )}
      <div className="stack gap-2">
        <OptionCard id="aa-lr-pass" name="aa-lr" title={<span className="small strong">Pass</span>} body="Store setup is complete. Eligible offers (approved product, complete offer with stock) go live." checked={outcome === 'pass'} onChange={() => setOutcome('pass')} />
        <OptionCard id="aa-lr-chg" name="aa-lr" title={<span className="small strong">Changes needed</span>} body="The seller fixes the listed issues and asks for the review again." checked={outcome === 'changes_needed'} onChange={() => setOutcome('changes_needed')} />
      </div>
      {outcome === 'changes_needed' && (
        <Field label="What to change" hint="One per line. The seller sees each as a task." error={issuesErr}>
          <Textarea id="aa-lr-issues" value={issues} onChange={(e) => setIssues(e.target.value)} placeholder={'Add a return policy\nReplace the placeholder store logo'} />
        </Field>
      )}
      <Field label="Note" optional hint="Shown to the seller and recorded in the action history.">
        <Textarea id="aa-lr-note" value={note} onChange={(e) => setNote(e.target.value)} />
      </Field>
    </Dialog>
  );
}

/** LaunchReview.state -> the label staff see. */
export const LAUNCH_STATE: Record<LaunchReview['state'], string> = {
  not_started: 'Not requested yet',
  requested: 'Waiting for review',
  passed: 'Passed',
  changes_needed: 'Changes needed',
};

/* ------------------------------------------------------------------ appeals */

/** Assign an appeal to the signed-in reviewer (the backend refuses the original decider). */
export function useAssignAppeal(onDone?: Done) {
  const { api } = useApi();
  const refresh = useSellerRefresh();
  return useMutation({
    mutationFn: ({ appealId, reviewerId }: { appealId: string; reviewerId: string }) => call(api.POST('/api/admin/sellers/appeals/{id}/assign', { params: { path: { id: appealId } }, body: { reviewerId } })),
    onSuccess: (a) => {
      announce('Appeal assigned to you');
      onDone?.('Appeal assigned', `${a.ref} is assigned to you.`);
      refresh();
    },
  });
}

/**
 * Uphold or overturn an appeal. Overturning lifts the restriction, ends the suspension, reopens the application or
 * withdraws the warning. A restriction can also be partly overturned with a new review date.
 */
export function AppealDecideDialog({ appeal, onClose, onDone }: { appeal: Appeal; onClose: () => void; onDone: Done }) {
  const { api } = useApi();
  const [outcome, setOutcome] = useState<'uphold' | 'overturn' | 'partly_overturn'>('uphold');
  const [explanation, setExplanation] = useState('');
  const [reviewDate, setReviewDate] = useState(isoDay(14));
  const [tried, setTried] = useState(false);
  const partly = appeal.subject === 'restriction';
  const decide = useMutation({
    mutationFn: () =>
      call(
        api.POST('/api/admin/sellers/appeals/{id}/decide', {
          params: { path: { id: appeal.id } },
          body: { outcome, explanation: explanation.trim(), ...(outcome === 'partly_overturn' ? { changes: { reviewDate } } : {}) },
        }),
      ),
    onSuccess: (a) => {
      announce('Appeal decided');
      onDone(`Appeal ${cap(a.state).toLowerCase()}`, `${a.ref} for ${a.storeName}: the seller sees your explanation.`);
      onClose();
    },
  });
  const OVERTURN: Record<Appeal['subject'], string> = {
    restriction: 'The restriction is lifted.',
    suspension: 'The suspension ends and the seller is reinstated.',
    application_rejection: 'The application reopens for review.',
    warning: 'The warning is withdrawn.',
  };
  const err = tried && !explanation.trim() ? 'Explain the decision. The seller reads it.' : undefined;
  return (
    <Dialog
      open
      onClose={onClose}
      title={`Decide appeal ${appeal.ref}`}
      foot={
        <>
          <Button variant="ghost" onClick={onClose}>
            Cancel
          </Button>
          <Button disabled={decide.isPending} onClick={() => (setTried(true), explanation.trim() && decide.mutate())}>
            Record decision
          </Button>
        </>
      }
    >
      {decide.isError && (
        <Alert tone="danger" title="We couldn’t record the decision">
          {errorMessage(decide.error)}
        </Alert>
      )}
      <div className="panel stack gap-1">
        <span className="small strong">{`${appeal.storeName} · ${cap(appeal.subject)} ${appeal.subjectRef}${appeal.level > 1 ? ' · second appeal' : ''}`}</span>
        <span className="small sub">{appeal.argument}</span>
        <span className="xs muted">{`Original decision by ${appeal.originalDecider.name ?? 'staff'}. You cannot decide an appeal against your own decision.`}</span>
      </div>
      <div className="stack gap-2">
        <OptionCard id="aa-apl-up" name="aa-apl" title={<span className="small strong">Uphold</span>} body="The original decision stands." checked={outcome === 'uphold'} onChange={() => setOutcome('uphold')} />
        <OptionCard id="aa-apl-ov" name="aa-apl" title={<span className="small strong">Overturn</span>} body={OVERTURN[appeal.subject]} checked={outcome === 'overturn'} onChange={() => setOutcome('overturn')} />
        {partly && <OptionCard id="aa-apl-pt" name="aa-apl" title={<span className="small strong">Partly overturn</span>} body="The restriction stays, with an earlier review date." checked={outcome === 'partly_overturn'} onChange={() => setOutcome('partly_overturn')} />}
      </div>
      {outcome === 'partly_overturn' && (
        <Field label="New review date">
          <TextInput id="aa-apl-date" type="date" min={isoDay(0)} value={reviewDate} onChange={(e) => setReviewDate(e.target.value)} />
        </Field>
      )}
      <Field label="Explanation to the seller" error={err}>
        <Textarea id="aa-apl-x" value={explanation} onChange={(e) => setExplanation(e.target.value)} placeholder="What you checked and why the decision stands or changes" />
      </Field>
    </Dialog>
  );
}

/* ------------------------------------------------------------------ application checks and approval */

type VerificationCheck = S['sellers.VerificationCheck'];

/**
 * Record a check result by hand. Offline the automated provider is a development stub, so staff look at the uploaded
 * documents and record what they found. A "needs attention" result blocks approval unless it is accepted with the note.
 */
export function CheckResultDialog({ applicationId, check, title, onClose, onDone }: { applicationId: string; check: VerificationCheck; title: string; onClose: () => void; onDone: Done }) {
  const { api } = useApi();
  const [result, setResult] = useState<'passed' | 'needs_attention' | 'failed'>('passed');
  const [note, setNote] = useState('');
  const [accept, setAccept] = useState(false);
  const [tried, setTried] = useState(false);
  const save = useMutation({
    mutationFn: () =>
      call(
        api.POST('/api/admin/sellers/applications/{id}/checks/{checkId}/result', {
          params: { path: { id: applicationId, checkId: check.id } },
          body: { result, note: note.trim(), acceptForApproval: result === 'needs_attention' ? accept : null },
        }),
      ),
    onSuccess: () => {
      announce('Check result recorded');
      onDone('Check result recorded', `${title}: ${cap(result).toLowerCase()}${result === 'needs_attention' && accept ? ', accepted for approval' : ''}.`);
      onClose();
    },
  });
  const err = tried && !note.trim() ? 'Record what you checked, e.g. which document and what it shows.' : undefined;
  return (
    <Dialog
      open
      onClose={onClose}
      title={`Record result · ${title}`}
      foot={
        <>
          <Button variant="ghost" onClick={onClose}>
            Cancel
          </Button>
          <Button disabled={save.isPending} onClick={() => (setTried(true), note.trim() && save.mutate())}>
            Save result
          </Button>
        </>
      }
    >
      <p className="small sub">{`Current result: ${cap(check.result)}. ${check.summary}`}</p>
      {save.isError && (
        <Alert tone="danger" title="We couldn’t save the result">
          {errorMessage(save.error)}
        </Alert>
      )}
      <div className="stack gap-2">
        <OptionCard id="aa-ck-pass" name="aa-ck" title={<span className="small strong">Passed</span>} body="The documents confirm it." checked={result === 'passed'} onChange={() => setResult('passed')} />
        <OptionCard id="aa-ck-att" name="aa-ck" title={<span className="small strong">Needs attention</span>} body="Something does not match but may be acceptable." checked={result === 'needs_attention'} onChange={() => setResult('needs_attention')} />
        <OptionCard id="aa-ck-fail" name="aa-ck" title={<span className="small strong">Failed</span>} body="It cannot be confirmed. Approval stays blocked." checked={result === 'failed'} onChange={() => setResult('failed')} />
      </div>
      {result === 'needs_attention' && <Checkbox id="aa-ck-accept" label={<span className="small">Accept for approval with this note</span>} checked={accept} onChange={(e) => setAccept(e.target.checked)} />}
      <Field label="What you checked" hint="Shown as the check summary and recorded in the action history." error={err}>
        <Textarea id="aa-ck-note" value={note} onChange={(e) => setNote(e.target.value)} placeholder="e.g. Business registration certificate matches the legal name and registry number" />
      </Field>
    </Dialog>
  );
}

export function TrustReviewDialog({ applicationId, onClose, onDone }: { applicationId: string; onClose: () => void; onDone: Done }) {
  const { api } = useApi();
  const ask = useMutation({
    mutationFn: (question: string) => call(api.POST('/api/admin/sellers/applications/{id}/trust-review', { params: { path: { id: applicationId } }, body: { question } })),
    onSuccess: () => {
      announce('Sent to Trust and Risk');
      onDone('Sent to Trust and Risk', 'Their flags and recommendation appear on this application when the review is done.');
      onClose();
    },
  });
  return (
    <TextDialog
      title="Ask Trust and Risk"
      intro="Trust and Risk opens a review of this applicant. Use it when something looks like fraud, a linked account or an unsafe product plan."
      label="What should they look at?"
      submitLabel="Send to Trust and Risk"
      required="Say what Trust and Risk should look at."
      pending={ask.isPending}
      error={ask.error}
      onClose={onClose}
      onSubmit={(t) => ask.mutate(t)}
    />
  );
}

export interface ApproveBody {
  note: string | null;
  recommendedHoldDays: number | null;
  conditions: RestrictionInput[] | null;
}

/** Confirm an approval, with the API's options: a message to the seller, a payout hold and one condition (restriction). */
export function ApproveDialog({ storeName, pending, error, onClose, onConfirm }: { storeName: string; pending: boolean; error: unknown; onClose: () => void; onConfirm: (b: ApproveBody) => void }) {
  const [note, setNote] = useState('');
  const [hold, setHold] = useState('');
  const [withCondition, setWithCondition] = useState(false);
  const [cond, setCond] = useState<RestrictionDraft>(() => ({ ...blankRestriction('approval_condition'), title: 'Condition of approval' }));
  const [tried, setTried] = useState(false);
  const holdDays = hold.trim() ? Number(hold) : null;
  const holdBad = holdDays !== null && (!Number.isInteger(holdDays) || holdDays < 0 || holdDays > 90);
  const holdErr = tried && holdBad ? 'Enter whole days from 0 to 90, or leave it empty.' : undefined;
  const condErrors = tried && withCondition ? restrictionErrors(cond) : {};
  const submit = () => {
    setTried(true);
    if (holdBad || (withCondition && Object.keys(restrictionErrors(cond)).length)) return;
    onConfirm({ note: note.trim() || null, recommendedHoldDays: holdDays, conditions: withCondition ? [restrictionBody(cond)] : null });
  };
  return (
    <Dialog
      open
      onClose={onClose}
      title={`Approve ${storeName}?`}
      size={withCondition ? 'lg' : undefined}
      foot={
        <>
          <Button variant="ghost" onClick={onClose}>
            Cancel
          </Button>
          <Button icon="check" disabled={pending} onClick={submit}>
            Approve seller
          </Button>
        </>
      }
    >
      <p className="small sub">The seller can set up their store. Products still need review, and offers go live only after the launch readiness review.</p>
      {error ? (
        <Alert tone="danger" title="We couldn’t approve the application">
          {errorMessage(error)}
        </Alert>
      ) : null}
      <Field label="Message to the seller" optional hint="Shown with the decision. Leave empty for the standard approval text.">
        <Textarea id="aa-apv-note" value={note} onChange={(e) => setNote(e.target.value)} />
      </Field>
      <Field label="Recommended new-seller payout hold (days)" optional hint="Leave empty for the standard new-seller period." error={holdErr}>
        <TextInput id="aa-apv-hold" type="number" min={0} max={90} inputMode="numeric" value={hold} error={!!holdErr} onChange={(e) => setHold(e.target.value)} />
      </Field>
      <Checkbox id="aa-apv-cond" label={<span className="small">Approve with a condition (a restriction that starts at approval)</span>} checked={withCondition} onChange={(e) => setWithCondition(e.target.checked)} />
      {withCondition && <RestrictionFields idPrefix="aa-apv-c" draft={cond} onChange={setCond} errors={condErrors} />}
    </Dialog>
  );
}
