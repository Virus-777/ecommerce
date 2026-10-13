// Campaign lifecycle actions for the Admin Center ad screens: one runner for the REST transitions
// (POST /api/admin/advertising/campaigns/{id}/<action>) and a dialog for the ones that need a reason or dates.
import { useState } from 'react';
import { call, errorMessage, type Api } from '@marketly/web-shared/api';
import { Button, Dialog, Field, TextInput, Textarea } from '@marketly/web-shared/ui';
import { fromZonedInput, toPacificInput, type AdCampaign } from './ads';

export type CampaignAction = 'pause' | 'resume' | 'finish' | 'schedule' | 'activate' | 'archive' | 'renew' | 'submit' | 'approve' | 'request-changes' | 'reject';

/** Which staff permission each action needs (advertising.md, Admin API). */
export const ACTION_PERMISSION: Record<CampaignAction, string> = {
  pause: 'advertising.campaigns.publish',
  resume: 'advertising.campaigns.publish',
  finish: 'advertising.campaigns.publish',
  schedule: 'advertising.campaigns.publish',
  activate: 'advertising.campaigns.publish',
  archive: 'advertising.campaigns.manage',
  renew: 'advertising.campaigns.manage',
  submit: 'advertising.campaigns.manage',
  approve: 'advertising.campaigns.review',
  'request-changes': 'advertising.campaigns.review',
  reject: 'advertising.campaigns.review',
};

export const ACTION_LABEL: Record<CampaignAction, string> = {
  pause: 'Pause',
  resume: 'Resume',
  finish: 'Finish',
  schedule: 'Schedule',
  activate: 'Activate now',
  archive: 'Archive',
  renew: 'Renew',
  submit: 'Submit for approval',
  approve: 'Approve',
  'request-changes': 'Request changes',
  reject: 'Reject',
};

/** Actions that need input before they run. */
export const NEEDS_INPUT: Partial<Record<CampaignAction, 'reason' | 'dates'>> = { pause: 'reason', finish: 'reason', renew: 'dates', 'request-changes': 'reason', reject: 'reason' };

type Post = (path: string, init: { body?: unknown; params: { path: { id: string } } }) => Promise<{ data?: AdCampaign; error?: unknown; response: Response }>;

export function runCampaignAction(api: Api, id: string, action: CampaignAction, body?: Record<string, unknown>): Promise<AdCampaign> {
  const post = api.POST as unknown as Post;
  return call(post(`/api/admin/advertising/campaigns/{id}/${action}`, { params: { path: { id } }, body: body ?? {} }));
}

export interface PendingAction {
  id: string;
  name: string;
  action: CampaignAction;
  /** For renew: the campaign's current period, used to propose the next one. */
  startsAt?: string | null;
  endsAt?: string | null;
}

/** Reason (pause, finish, request changes, reject) or dates (renew) for a campaign action. */
export function CampaignActionDialog({ pending, busy, error, onClose, onConfirm }: { pending: PendingAction | null; busy: boolean; error: unknown; onClose: () => void; onConfirm: (body: Record<string, unknown>) => void }) {
  const kind = pending ? NEEDS_INPUT[pending.action] : undefined;
  const [reason, setReason] = useState('');
  const [start, setStart] = useState('');
  const [end, setEnd] = useState('');
  const [err, setErr] = useState('');
  const [key, setKey] = useState('');
  // Reset the form when another action opens.
  const k = pending ? `${pending.id}:${pending.action}` : '';
  if (k !== key) {
    setKey(k);
    setReason('');
    setErr('');
    if (pending?.action === 'renew') {
      const s = pending.endsAt ? new Date(Math.max(Date.now(), new Date(pending.endsAt).getTime()) + 60_000) : new Date(Date.now() + 86_400_000);
      const len = pending.startsAt && pending.endsAt ? new Date(pending.endsAt).getTime() - new Date(pending.startsAt).getTime() : 7 * 86_400_000;
      setStart(toPacificInput(s.toISOString()));
      setEnd(toPacificInput(new Date(s.getTime() + len).toISOString()));
    }
  }
  const submit = () => {
    if (kind === 'reason') {
      if (!reason.trim()) return setErr('Enter a reason. It is recorded in Action history.');
      onConfirm({ reason: reason.trim() });
    } else if (kind === 'dates') {
      const s = fromZonedInput(start);
      const e = fromZonedInput(end);
      if (!s || !e) return setErr('Enter a start and an end.');
      if (new Date(e) <= new Date(s)) return setErr('The end must be after the start.');
      onConfirm({ startsAt: s, endsAt: e });
    }
  };
  const label = pending ? ACTION_LABEL[pending.action] : '';
  return (
    <Dialog
      open={!!pending && !!kind}
      onClose={onClose}
      title={pending ? `${label}: ${pending.name}` : ''}
      foot={
        <>
          <Button variant="ghost" onClick={onClose}>
            Cancel
          </Button>
          <Button onClick={submit} disabled={busy}>
            {busy ? 'Working…' : label}
          </Button>
        </>
      }
    >
      {kind === 'reason' && (
        <Field label="Reason" error={err || (error ? errorMessage(error) : undefined)}>
          <Textarea id="ad-act-reason" value={reason} onChange={(e) => (setReason(e.target.value), setErr(''))} />
        </Field>
      )}
      {kind === 'dates' && (
        <>
          <span className="small sub">Renewing creates a new draft with the same settings. Pacific Time.</span>
          <Field label="Start">
            <TextInput id="ad-act-start" type="datetime-local" value={start} onChange={(e) => (setStart(e.target.value), setErr(''))} />
          </Field>
          <Field label="End" error={err || (error ? errorMessage(error) : undefined)}>
            <TextInput id="ad-act-end" type="datetime-local" value={end} onChange={(e) => (setEnd(e.target.value), setErr(''))} />
          </Field>
        </>
      )}
    </Dialog>
  );
}
