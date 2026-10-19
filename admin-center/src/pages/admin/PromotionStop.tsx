import { useState } from 'react';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { call, errorMessage, useApi } from '@marketly/web-shared/api';
import { Alert, Button, Dialog, Field, Textarea, announce } from '@marketly/web-shared/ui';
import { useStaffSession } from '@/app/session';
import type { Campaign } from './data/promotions';

// Stopping a campaign for good (review §2a #7, B18), on admin/promotions rows and the admin/promotion-new header.
// Pause only stops it for a while; these are final:
// - End: POST /api/admin/promotions/campaigns/{id}/end {reason} for a live or paused campaign
//   (promotions.campaigns.publish). Codes stop working and flash items end at once.
// - Cancel: POST …/{id}/cancel {reason} for a campaign that has not started: draft, approved or scheduled
//   (promotions.campaigns.manage). A campaign waiting for Finance is taken back to draft first.
// Both answer with the Campaign and are written to Action history with the reason.

type Kind = 'end' | 'cancel';

export const canEndStatus = (s: string) => s === 'live' || s === 'paused';
export const canCancelStatus = (s: string) => s === 'draft' || s === 'approved' || s === 'scheduled';

const COPY: Record<Kind, { button: string; title: string; submit: string; what: string; done: string }> = {
  end: {
    button: 'End',
    title: 'End campaign now',
    submit: 'End campaign',
    what: 'The campaign ends now and can’t be restarted. Coupon codes stop working and flash-sale prices end. Orders already placed keep their discount.',
    done: 'ended',
  },
  cancel: {
    button: 'Cancel',
    title: 'Cancel campaign',
    submit: 'Cancel campaign',
    what: 'The campaign never starts and can’t be scheduled again. Coupon codes are turned off and a budget approval that is still waiting is withdrawn.',
    done: 'cancelled',
  },
};

/** The End or Cancel button that applies to the campaign's status and the viewer's role (nothing otherwise). */
export function StopCampaign({ c, size = 'sm', onDone }: { c: { id: string; name: string; status: string }; size?: 'sm'; onDone?: (saved: Campaign, kind: Kind) => void }) {
  const { api } = useApi();
  const qc = useQueryClient();
  const { can } = useStaffSession();
  const [open, setOpen] = useState(false);
  const [reason, setReason] = useState('');
  const [tried, setTried] = useState(false);
  const kind: Kind | null = canEndStatus(c.status) && can('promotions.campaigns.publish') ? 'end' : canCancelStatus(c.status) && can('promotions.campaigns.manage') ? 'cancel' : null;

  const stop = useMutation({
    mutationFn: (k: Kind) =>
      k === 'end'
        ? call(api.POST('/api/admin/promotions/campaigns/{id}/end', { params: { path: { id: c.id } }, body: { reason: reason.trim() } }))
        : call(api.POST('/api/admin/promotions/campaigns/{id}/cancel', { params: { path: { id: c.id } }, body: { reason: reason.trim() } })),
    onSuccess: (saved, k) => {
      setOpen(false);
      qc.setQueryData(['promotions', 'campaign', saved.id], saved);
      void qc.invalidateQueries({ queryKey: ['promotions'] });
      void qc.invalidateQueries({ queryKey: ['workqueues', 'queues'] });
      announce(`${c.name} ${COPY[k].done}`);
      onDone?.(saved, k);
    },
  });

  if (!kind) return null;
  const t = COPY[kind];
  return (
    <>
      <Button
        variant="ghost"
        size={size}
        onClick={() => {
          setOpen(true);
          setReason('');
          setTried(false);
          stop.reset();
        }}
        srLabel={c.name}
      >
        {t.button}
      </Button>
      <Dialog
        open={open}
        onClose={() => setOpen(false)}
        title={t.title}
        size="sm"
        foot={
          <>
            <Button variant="ghost" onClick={() => setOpen(false)}>
              Keep it
            </Button>
            <Button
              variant="danger"
              onClick={() => {
                setTried(true);
                if (reason.trim()) stop.mutate(kind);
              }}
              disabled={stop.isPending}
            >
              {t.submit}
            </Button>
          </>
        }
      >
        <p className="small strong">{c.name}</p>
        <p className="small sub">{t.what}</p>
        {stop.isError && (
          <Alert tone="danger" title="The campaign wasn’t changed">
            {errorMessage(stop.error)}
          </Alert>
        )}
        <Field label="Reason" hint="Written to Action history and the campaign’s history" error={tried && !reason.trim() ? 'Say why.' : undefined}>
          <Textarea id={`stop-${c.id}`} value={reason} onChange={(e) => setReason(e.target.value)} />
        </Field>
      </Dialog>
    </>
  );
}
