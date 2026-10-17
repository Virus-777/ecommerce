// What a customer can do on a return, driven by ReturnDetail.actions (the backend's customerActions):
// REPLY_INFO answers the seller's or Marketly's question (POST returns/requests/{id}/info), ADD_TRACKING
// adds the carrier and tracking number of a return the customer ships themselves (POST …/shipment),
// WITHDRAW cancels the return before the item is sent back (POST …/withdraw), ESCALATE asks Marketly
// to step in after a rejection, a missed deadline or a late refund (POST …/escalate, opens a support
// case). None of these ops takes an Idempotency-Key. GET_LABEL (drop-off code, label, email) and
// REPORT_PROBLEM (a support case from help/order-problem) are wired on the return page itself.
import { useState } from 'react';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { ApiError, call, errorMessage, useApi, useUploads } from '@marketly/web-shared/api';
import { Alert, announce, Button, Card, Dialog, Field, FileDrop, Select, Textarea, TextInput, type ButtonVariant } from '@marketly/web-shared/ui';
import { UploadList } from '../../help/data/UploadList';
import { fmtDateTime, type ReturnDetail } from './orders';

/** How a caller places an action button (its look; the label and click stay here). */
type BtnLook = { variant?: ButtonVariant; size?: 'sm' | 'lg'; block?: boolean; className?: string };

export type ReturnAction ='WITHDRAW' | 'REPLY_INFO' | 'GET_LABEL' | 'ADD_TRACKING' | 'ESCALATE' | 'REPORT_PROBLEM';

/** Whether the backend allows this action on the return now (enum values, any case). */
export const canDo = (r: ReturnDetail, a: ReturnAction) => r.actions.some((x) => x.toUpperCase() === a);

/** Specific copy for the return error codes (returns.md), else the server's message. */
export function returnActionError(e: unknown): string {
  if (e instanceof ApiError) {
    if (e.code === 'ILLEGAL_TRANSITION') return `${e.message}. Reload the page to see where the return is now.`;
    if (e.code === 'ESCALATION_NOT_AVAILABLE') {
      const from = typeof e.details.availableFrom === 'string' ? e.details.availableFrom : null;
      return from ? `You can ask Marketly to step in from ${fmtDateTime(from)} PT, once the deadline passes.` : e.message;
    }
    if (e.code === 'RESPONSE_DEADLINE_PASSED') return 'The deadline passed and Marketly is now handling this return.';
    if (e.code === 'VALIDATION_FAILED') return Object.values(e.fieldErrors)[0] ?? e.message;
  }
  return errorMessage(e);
}

/** After any change: the return page (GraphQL + REST), the returns list, the order and the account overview. */
function useRefreshReturn() {
  const qc = useQueryClient();
  return () => {
    void qc.invalidateQueries({ queryKey: ['returns'] });
    void qc.invalidateQueries({ queryKey: ['orders'] });
    void qc.invalidateQueries({ queryKey: ['customers', 'overview'] });
  };
}

/* ---------------- REPLY_INFO ---------------- */

const MAX_PHOTOS = 6; // the backend's maxPhotosPerReturn default

/**
 * The open question with its reply-by time, a reply box and optional photos (purpose return_evidence).
 * The nightly returns.info-expiry job cancels the return when the reply-by time passes, so the deadline
 * leads the card.
 */
export function InfoReplyCard({ r }: { r: ReturnDetail }) {
  const { api } = useApi();
  const refresh = useRefreshReturn();
  const info = r.infoRequest;
  const [reply, setReply] = useState('');
  const [error, setError] = useState('');
  const photos = useUploads('return_evidence', { max: MAX_PHOTOS, maxBytes: 15 * 1024 * 1024 });
  const send = useMutation({
    mutationFn: () =>
      call(api.POST('/api/store/returns/requests/{id}/info', { params: { path: { id: r.id } }, body: { reply: reply.trim(), mediaIds: photos.assetIds.length ? photos.assetIds : undefined } })),
    onSuccess: () => {
      setReply('');
      photos.clear();
      announce('Answer sent');
      refresh();
    },
  });
  const submit = () => {
    if (!reply.trim()) return setError('Write your answer before sending.');
    if (photos.uploading) return setError('Wait for the photos to finish uploading.');
    if (photos.failed) return setError('Remove the photos that failed to upload, or add them again.');
    setError('');
    send.mutate();
  };
  const asker = info?.askedBy.name || (info?.askedBy.kind.toUpperCase() === 'SELLER' ? r.sellerName : 'Marketly');

  return (
    <>
      <Alert tone="warning" title={info ? `Answer by ${fmtDateTime(info.replyDueAt)} PT` : 'We need more information'}>
        {asker} needs more information before deciding. If there's no answer by then, the return is cancelled.
      </Alert>
      <Card title={`${asker} asked`} sub={info ? `Asked ${fmtDateTime(info.askedAt)} PT` : undefined}>
        {info && <p className="small">{info.question}</p>}
        <Field label="Your answer" error={error || (send.isError ? returnActionError(send.error) : undefined)}>
          <Textarea
            id="rt-info-reply"
            value={reply}
            maxLength={5000}
            onChange={(e) => {
              setReply(e.target.value);
              setError('');
            }}
          />
        </Field>
        <FileDrop title="Add photos or a short video (optional)" hint={`JPG, PNG, WebP, HEIC or MP4, up to 15 MB each, ${MAX_PHOTOS} at most`} accept="image/jpeg,image/png,image/webp,image/heic,video/mp4" onFiles={photos.add} />
        <UploadList uploads={photos} icon="image" />
        <div className="row gap-2">
          <Button icon="send" onClick={submit} disabled={send.isPending}>
            {send.isPending ? 'Sending…' : 'Send answer'}
          </Button>
        </div>
      </Card>
    </>
  );
}

/* ---------------- ADD_TRACKING ---------------- */

// The store API has no carrier list: these are the shipping module's carrier codes (shipping/domain/tracking.ts).
// The backend checks the code and the tracking number format.
const CARRIERS = [
  { value: '', label: 'Choose the carrier' },
  { value: 'usps', label: 'USPS' },
  { value: 'ups', label: 'UPS' },
  { value: 'fedex', label: 'FedEx' },
  { value: 'other', label: 'Other carrier' },
];

/** Carrier and tracking number for a return the customer ships themselves (customer-arranged). */
export function AddTrackingForm({ r }: { r: ReturnDetail }) {
  const { api } = useApi();
  const refresh = useRefreshReturn();
  const [carrier, setCarrier] = useState('');
  const [tracking, setTracking] = useState('');
  const [tried, setTried] = useState(false);
  const save = useMutation({
    mutationFn: () => call(api.POST('/api/store/returns/requests/{id}/shipment', { params: { path: { id: r.id } }, body: { carrier, trackingNumber: tracking.trim() } })),
    onSuccess: () => {
      announce('Tracking added');
      refresh();
    },
  });
  const server = save.error instanceof ApiError ? save.error.fieldErrors : {};
  const errors = {
    carrier: tried && !carrier ? 'Choose the carrier.' : (server.carrier ?? server.carrierCode),
    tracking: tried && !tracking.trim() ? 'Enter the tracking number.' : server.trackingNumber,
  };
  const submit = () => {
    setTried(true);
    if (!carrier || !tracking.trim()) return;
    save.mutate();
  };
  const otherError = save.isError && !errors.carrier && !errors.tracking ? returnActionError(save.error) : '';
  return (
    <div className="stack gap-3">
      <span className="small strong">Sent it? Add the tracking number</span>
      <div className="grid md2 gap-3">
        <Field label="Carrier" error={errors.carrier}>
          <Select id="rt-carrier" options={CARRIERS} value={carrier} onChange={(e) => setCarrier(e.target.value)} />
        </Field>
        <Field label="Tracking number" error={errors.tracking}>
          <TextInput id="rt-tracking" value={tracking} autoComplete="off" spellCheck={false} maxLength={64} onChange={(e) => setTracking(e.target.value)} error={!!errors.tracking} />
        </Field>
      </div>
      {otherError && <span className="xs t-danger-text">{otherError}</span>}
      <div className="row gap-2">
        <Button icon="truck" onClick={submit} disabled={save.isPending}>
          {save.isPending ? 'Saving…' : 'Add tracking'}
        </Button>
      </div>
    </div>
  );
}

/* ---------------- WITHDRAW ---------------- */

/** "Withdraw return" with a confirmation dialog and an optional reason. */
export function WithdrawReturnButton({ r, ...btn }: { r: ReturnDetail } & BtnLook) {
  const { api } = useApi();
  const refresh = useRefreshReturn();
  const [open, setOpen] = useState(false);
  const [reason, setReason] = useState('');
  const withdraw = useMutation({
    mutationFn: () => call(api.POST('/api/store/returns/requests/{id}/withdraw', { params: { path: { id: r.id } }, body: { reason: reason.trim() || null } })),
    onSuccess: () => {
      setOpen(false);
      announce(`Return ${r.ref} withdrawn`);
      refresh();
    },
  });
  return (
    <>
      <Button variant="ghost" icon="x" {...btn} onClick={() => setOpen(true)}>
        Withdraw return
      </Button>
      <Dialog
        open={open}
        onClose={() => setOpen(false)}
        title="Withdraw this return?"
        foot={
          <>
            <Button variant="ghost" onClick={() => setOpen(false)}>
              Keep the return
            </Button>
            <Button variant="danger" icon="x" onClick={() => withdraw.mutate()} disabled={withdraw.isPending}>
              {withdraw.isPending ? 'Withdrawing…' : 'Withdraw return'}
            </Button>
          </>
        }
      >
        <p className="small sub">You keep the item and no refund is made{r.shipment ? '. The return label stops working' : ''}. You can start a new return while the return window is open.</p>
        <Field label="Why are you withdrawing it?" optional error={withdraw.isError ? returnActionError(withdraw.error) : undefined}>
          <Textarea id="rt-withdraw-reason" value={reason} maxLength={1000} onChange={(e) => setReason(e.target.value)} />
        </Field>
      </Dialog>
    </>
  );
}

/* ---------------- ESCALATE ---------------- */

type EscalateReason = 'seller_no_response' | 'customer_disagrees' | 'refund_late' | 'other';
const ESCALATE_REASONS: Array<{ value: EscalateReason; label: string }> = [
  { value: 'customer_disagrees', label: "I don't agree with the decision" },
  { value: 'seller_no_response', label: "The seller hasn't answered in time" },
  { value: 'refund_late', label: 'My refund is late' },
  { value: 'other', label: 'Something else' },
];

/** The reason that matches why escalation is open (backend escalation rules: rejected, missed deadline, failed or late refund). */
function defaultReason(r: ReturnDetail): EscalateReason {
  const s = r.status.toUpperCase();
  if (s === 'REJECTED') return 'customer_disagrees';
  if (s === 'REQUESTED') return 'seller_no_response';
  if (s === 'RECEIVED' || s === 'AWAITING_REMEDY' || r.refund?.status.toUpperCase() === 'FAILED') return 'refund_late';
  return 'other';
}

/** "Ask Marketly to step in": opens (or links) a support case for the return. */
export function EscalateReturnButton({ r, label = 'Ask Marketly to step in', ...btn }: { r: ReturnDetail; label?: string } & BtnLook) {
  const { api } = useApi();
  const refresh = useRefreshReturn();
  const [open, setOpen] = useState(false);
  const [reason, setReason] = useState<EscalateReason>(() => defaultReason(r));
  const [note, setNote] = useState('');
  const escalate = useMutation({
    mutationFn: () => call(api.POST('/api/store/returns/requests/{id}/escalate', { params: { path: { id: r.id } }, body: { reason, note: note.trim() || null } })),
    onSuccess: (res) => {
      setOpen(false);
      announce(res.escalation?.caseRef ? `Marketly opened case ${res.escalation.caseRef}` : 'Marketly will take a look');
      refresh();
    },
  });
  return (
    <>
      <Button variant="secondary" icon="life-buoy" {...btn} onClick={() => setOpen(true)}>
        {label}
      </Button>
      <Dialog
        open={open}
        onClose={() => setOpen(false)}
        title="Ask Marketly to step in"
        foot={
          <>
            <Button variant="ghost" onClick={() => setOpen(false)}>
              Cancel
            </Button>
            <Button icon="life-buoy" onClick={() => escalate.mutate()} disabled={escalate.isPending}>
              {escalate.isPending ? 'Sending…' : 'Ask Marketly'}
            </Button>
          </>
        }
      >
        <p className="small sub">A Marketly support agent reviews the return, the messages and the terms you bought under, then decides. We open a support case so you can follow it.</p>
        <Field label="Why do you need our help?">
          <Select id="rt-esc-reason" options={ESCALATE_REASONS} value={reason} onChange={(e) => setReason(e.target.value as EscalateReason)} />
        </Field>
        <Field label="Anything else we should know?" optional error={escalate.isError ? returnActionError(escalate.error) : undefined}>
          <Textarea id="rt-esc-note" value={note} maxLength={2000} onChange={(e) => setNote(e.target.value)} />
        </Field>
      </Dialog>
    </>
  );
}
