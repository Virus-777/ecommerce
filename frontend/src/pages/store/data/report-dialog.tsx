// "Report" for listings, sellers and messages (no design: built from the review report dialog in
// store/Reviews.tsx, same layout and copy style).
//   product, offer, seller → Trust and Risk: POST /api/store/trust/reports
//     { type, subject: { type, id }, reason, details?, evidenceIds? } → MyReport (shown in Account ›
//     Reports and appeals). `type` is the op's enum; `reason` is the form's own reason code (the API
//     stores it as text and shows it humanised, e.g. may_be_counterfeit → "May be counterfeit").
//     The same customer reporting the same thing again within 24 hours adds to the earlier report.
//     Photos upload as case_evidence (the media purposes trust evidence accepts).
//   message → messaging moderation: POST /api/store/messaging/messages/{id}/report { reason, note? }
//     (reason is that op's enum; no photos). Reporting the same message again returns the open report.
// Both ops need a signed-in customer: a visitor sees "Sign in to report" and goes to sign-in.
import { useEffect, useState } from 'react';
import { Link, useNavigate } from 'react-router';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { useSession } from '@/app/session';
import { ApiError, call, errorMessage, useApi, useUploads, type components, type paths } from '@marketly/web-shared/api';
import { href } from '@marketly/web-shared/routes';
import { Alert, Button, Dialog, EmptyState, Field, FileDrop, Icon, Radio, Select, Textarea, announce } from '@marketly/web-shared/ui';
import { UploadList } from '../../help/data/UploadList';
import { useSignInHref } from './product';

type TrustType = components['schemas']['trust.StoreReportInput']['type'];
type MessageReason = NonNullable<paths['/api/store/messaging/messages/{id}/report']['post']['requestBody']>['content']['application/json']['reason'];

export type ReportKind = 'product' | 'offer' | 'seller' | 'message';

/** One thing the customer can report from where the dialog opens. */
export interface ReportTarget {
  kind: ReportKind;
  /** Product, offer, seller or message id. */
  id: string;
  /** Shown in the dialog and in the "what are you reporting" picker, e.g. "This offer from Gadget Grove". */
  label: string;
}

interface Reason {
  code: string;
  label: string;
  /** Trust report type for this reason (listing and seller reports). */
  type?: TrustType;
}

// Reasons per thing reported. Codes are stored with the report and shown humanised to Trust and Risk.
const REASONS: Record<ReportKind, Reason[]> = {
  product: [
    { code: 'may_be_counterfeit', label: 'It may be counterfeit or fake', type: 'counterfeit' },
    { code: 'misleading_description', label: 'The photos or description are wrong or misleading', type: 'misleading_listing' },
    { code: 'unsafe_or_prohibited', label: 'It’s unsafe, recalled or not allowed on Marketly', type: 'prohibited_item' },
    { code: 'other', label: 'Something else', type: 'other' },
  ],
  offer: [
    { code: 'may_be_counterfeit', label: 'This seller’s item may be counterfeit', type: 'counterfeit' },
    { code: 'condition_misrepresented', label: 'The condition or what’s included is misrepresented', type: 'misleading_listing' },
    { code: 'price_or_delivery_misleading', label: 'The price, shipping or delivery promise is misleading', type: 'misleading_listing' },
    { code: 'unsafe_or_prohibited', label: 'It’s unsafe, recalled or not allowed on Marketly', type: 'prohibited_item' },
    { code: 'other', label: 'Something else', type: 'other' },
  ],
  seller: [
    { code: 'sells_counterfeits', label: 'The seller sells counterfeit goods', type: 'counterfeit' },
    { code: 'off_platform_payment', label: 'The seller asked me to pay or talk outside Marketly', type: 'abuse' },
    { code: 'abusive_behaviour', label: 'The seller was abusive or threatening', type: 'abuse' },
    { code: 'misleading_store_details', label: 'The store’s details or claims are misleading', type: 'misleading_listing' },
    { code: 'other', label: 'Something else', type: 'other' },
  ],
  message: [
    { code: 'abusive', label: 'Abusive or threatening' },
    { code: 'spam_or_promotion', label: 'Spam or advertising' },
    { code: 'off_platform_contact', label: 'Asks to pay or talk outside Marketly' },
    { code: 'fraud', label: 'Looks like a scam or fraud' },
    { code: 'other', label: 'Something else' },
  ] satisfies Array<{ code: MessageReason; label: string }>,
};

const TITLE: Record<ReportKind, string> = { product: 'Report this product', offer: 'Report this offer', seller: 'Report this seller', message: 'Report this message' };
const DETAILS_MAX = 1000;

interface Props {
  open: boolean;
  onClose: () => void;
  /** What can be reported from here; more than one shows a picker (e.g. the offer or its seller). */
  targets: ReportTarget[];
  /** Called after a report is sent (e.g. to mark a message as reported). */
  onReported?: (target: ReportTarget) => void;
}

type Done = { kind: 'trust'; report: components['schemas']['trust.MyReport'] } | { kind: 'message' };

export function ReportDialog({ open, onClose, targets, onReported }: Props) {
  const { api } = useApi();
  const qc = useQueryClient();
  const navigate = useNavigate();
  const signIn = useSignInHref();
  const { signedIn } = useSession();
  const [targetKey, setTargetKey] = useState('');
  const [reason, setReason] = useState('');
  const [details, setDetails] = useState('');
  const [errors, setErrors] = useState<{ reason?: string; details?: string; form?: string }>({});
  const [done, setDone] = useState<Done | null>(null);
  const photos = useUploads('case_evidence', { max: 5, accept: /\.(jpe?g|png|pdf)$|^image\/(jpeg|png)$|^application\/pdf$/i });

  const target = targets.find((t) => `${t.kind}:${t.id}` === targetKey) ?? targets[0];
  const reasons = target ? REASONS[target.kind] : [];
  const isMessage = target?.kind === 'message';

  // Fresh form each time the dialog opens.
  useEffect(() => {
    if (!open) return;
    setTargetKey(targets[0] ? `${targets[0].kind}:${targets[0].id}` : '');
    setReason('');
    setDetails('');
    setErrors({});
    setDone(null);
    photos.clear();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open]);

  const send = useMutation({
    mutationFn: async (t: ReportTarget): Promise<Done> => {
      const note = details.trim() || undefined;
      if (t.kind === 'message') {
        await call(api.POST('/api/store/messaging/messages/{id}/report', { params: { path: { id: t.id } }, body: { reason: reason as MessageReason, note: note ?? null } }));
        return { kind: 'message' };
      }
      const r = REASONS[t.kind].find((x) => x.code === reason)!;
      const report = await call(
        api.POST('/api/store/trust/reports', {
          body: { type: r.type!, subject: { type: t.kind, id: t.id }, reason: r.code, details: note ?? null, evidenceIds: photos.assetIds.length ? photos.assetIds : null },
        }),
      );
      return { kind: 'trust', report };
    },
    onSuccess: (d, t) => {
      setDone(d);
      onReported?.(t);
      if (d.kind === 'trust') void qc.invalidateQueries({ queryKey: ['trust', 'reports'] });
      announce(d.kind === 'trust' ? `Report ${d.report.ref} sent. Thanks for telling us.` : 'Message reported. Thanks for telling us.');
    },
    onError: (err) => {
      if (err instanceof ApiError && (err.status === 401 || err.details.reason === 'sign_in_required')) return navigate(signIn());
      if (err instanceof ApiError && (err.status === 429 || err.code === 'RATE_LIMITED')) return setErrors({ form: err.message || 'You’ve sent a lot of reports today. Please try again tomorrow.' });
      if (err instanceof ApiError && err.code === 'VALIDATION_FAILED') {
        const f = err.fieldErrors;
        if (f.details || f.note) return setErrors({ details: f.details ?? f.note });
        if (f.reason) return setErrors({ reason: f.reason });
      }
      setErrors({ form: errorMessage(err) });
    },
  });

  const submit = () => {
    if (!signedIn) return navigate(signIn());
    if (!target) return;
    const e: typeof errors = {};
    if (!reason) e.reason = 'Choose what’s wrong.';
    if (reason === 'other' && !details.trim()) e.details = 'Tell us what’s wrong.';
    if (!isMessage && photos.uploading) e.form = 'Wait for the photos to finish uploading.';
    else if (!isMessage && photos.failed) e.form = 'Remove the files that couldn’t be uploaded, or try them again.';
    setErrors(e);
    if (e.reason || e.details || e.form) return;
    send.mutate(target);
  };

  if (!target) return null;

  return (
    <Dialog
      open={open}
      onClose={onClose}
      title={done ? 'Report sent' : targets.length > 1 ? 'Report a problem' : TITLE[target.kind]}
      foot={
        done ? (
          <Button onClick={onClose}>Done</Button>
        ) : (
          <>
            <Button variant="secondary" onClick={onClose}>
              Cancel
            </Button>
            <Button icon="flag" onClick={submit} disabled={send.isPending}>
              {!signedIn ? 'Sign in to report' : send.isPending ? 'Sending…' : 'Send report'}
            </Button>
          </>
        )
      }
    >
      {done?.kind === 'trust' ? (
        <EmptyState icon="circle-check" title={`Thanks, we’ve received your report ${done.report.ref}`}>
          Our Trust and Risk team checks it{done.report.expectedBy ? ` and expects to finish by ${new Date(`${done.report.expectedBy}T12:00:00Z`).toLocaleDateString('en-US', { month: 'short', day: 'numeric', timeZone: 'UTC' })}` : ''}. The seller won’t see who reported it. Follow it, or add photos and details later, in{' '}
          <Link to={href('account/reports')} className="link-inline" onClick={onClose}>
            Reports and appeals
          </Link>
          .
        </EmptyState>
      ) : done ? (
        <EmptyState icon="circle-check" title="Thanks, we’ve received your report">
          Our team reviews reported messages. The seller won’t see who reported it. If you feel unsafe or were asked to pay outside Marketly, don’t reply and don’t send money.
        </EmptyState>
      ) : (
        <>
          {errors.form && <Alert tone="danger">{errors.form}</Alert>}
          {targets.length > 1 ? (
            <Field label="What are you reporting?">
              <Select
                id="rp-target"
                value={`${target.kind}:${target.id}`}
                options={targets.map((t) => ({ value: `${t.kind}:${t.id}`, label: t.label }))}
                onChange={(e) => {
                  setTargetKey(e.target.value);
                  setReason('');
                  setErrors({});
                }}
              />
            </Field>
          ) : (
            <p className="small strong">{target.label}</p>
          )}
          <fieldset className="fieldset-reset stack gap-2" aria-describedby={errors.reason ? 'rp-reason-err' : undefined}>
            <legend className="label u-mb-sp-2">What’s wrong?</legend>
            {reasons.map((o) => (
              <Radio
                key={o.code}
                id={`rp-${o.code}`}
                name="rp-reason"
                label={o.label}
                checked={reason === o.code}
                onChange={() => {
                  setReason(o.code);
                  setErrors((x) => ({ ...x, reason: undefined }));
                }}
              />
            ))}
            {errors.reason && (
              <span className="error-text" id="rp-reason-err">
                <Icon name="circle-alert" className="ic-sm" />
                {errors.reason}
              </span>
            )}
          </fieldset>
          <Field label="Details" optional={reason !== 'other'} hint={`${details.length}/${DETAILS_MAX}. What did you see, and where? Don’t include card numbers or passwords.`} error={errors.details}>
            <Textarea
              id="rp-details"
              rows={3}
              maxLength={DETAILS_MAX}
              value={details}
              onChange={(e) => {
                setDetails(e.target.value);
                setErrors((x) => ({ ...x, details: undefined }));
              }}
            />
          </Field>
          {!isMessage && (
            <div className="stack gap-2">
              <span className="label">
                Photos or documents <span className="muted">(optional)</span>
              </span>
              <FileDrop title="Add photos or screenshots" hint="JPG, PNG or PDF, up to 10 MB each, 5 files max" accept="image/jpeg,image/png,application/pdf" onFiles={photos.add} />
              <UploadList uploads={photos} />
            </div>
          )}
          <p className="xs muted">
            {isMessage
              ? 'Marketly checks reported messages against the messaging rules and can hide them or close the conversation.'
              : 'Reports go to Marketly’s Trust and Risk team, not the seller. For a problem with an order you placed, use '}
            {!isMessage && (
              <>
                <Link to={href('help/order-problem')} className="link-inline" onClick={onClose}>
                  Report an order problem
                </Link>
                .
              </>
            )}
          </p>
        </>
      )}
    </Dialog>
  );
}
