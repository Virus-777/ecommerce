import { Fragment, useEffect, useRef, useState, type ReactNode } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Link, useParams } from 'react-router';
import { ApiError, call, errorMessage, newIdempotencyKey, useApi, useUploads } from '@marketly/web-shared/api';
import { SellerLayout } from '@marketly/web-shared/layouts';
import { cx } from '@marketly/web-shared/lib/cx';
import { useScrollRegion } from '@marketly/web-shared/lib/hooks';
import { href } from '@marketly/web-shared/routes';
import { Alert, Avatar, Badge, Breadcrumbs, Button, Card, Checkbox, Deadline, EmptyState, Field, Icon, Img, KeyValue, OptionCard, Select, StatusBadge, SummaryRow, TextInput, Textarea, announce, type IconName } from '@marketly/web-shared/ui';
import { useSellerSession } from '@/app/session';
import {
  CONDITIONS,
  GRADES,
  LABEL_METHOD,
  NO_RETURN_REASONS,
  PAID_BY,
  REJECT_REASONS,
  REMEDY_OFFERED,
  REMEDY_WANTED,
  STOCK,
  deadlineTone,
  evidenceKind,
  fmtDate,
  fmtDateTime,
  fmtDay,
  fmtDue,
  fmtFull,
  human,
  money,
  negMoney,
  timeLeft,
  toMinor,
  useSellerReturn,
  type Condition,
  type GEvent,
  type GImage,
  type Grade,
  type NoReturnCode,
  type RejectCode,
  type SellerReturn,
  type StockOutcome,
} from './data/returns';

// Design: pages/seller/seller-return.html · view "inspect-and-refund". The layout follows the return's data
// (GraphQL SellerReturnDetail): a request waiting for a response shows the Respond cards; once the item is on its
// way back (or received) the Inspect-and-refund cards. Actions: REST /api/seller/returns/requests/{id}/approve,
// request-info, reject, approve-without-return (idempotent), receive, inspection, inspection-draft, remedy
// (idempotent). Messages: the return's conversation (messaging; a new one starts with the returnId) or, once a
// dispute exists, the support case. Evidence: before a case, return_evidence uploads to POST …/{id}/evidence; with a
// case, case_evidence to the support case. A partial refund's earnings come from POST …/{id}/remedy/preview; the
// label charge estimate before approval (labelChargeEstimated) from REST GET …/requests/{id}.

type Decision = 'approve' | 'info' | 'reject';
type LabelMethod = 'prepaid_qr' | 'prepaid_label' | 'customer_arranged';

interface Ev {
  t: ReactNode;
  d: ReactNode;
  state: 'done' | 'current' | 'warn';
}
interface FileItem {
  key: string;
  name: string;
  meta: string;
  url?: string | null;
}

/** Progress steps from the return's track, with the design's "Step n of m" note on the current step. */
function ReturnSteps({ track }: { track: SellerReturn['track'] }) {
  const ref = useScrollRegion<HTMLOListElement>();
  return (
    <ol className="steps" aria-label="Progress" ref={ref} data-scroll-region="">
      {track.map((s, i) => {
        const done = s.state === 'DONE';
        const cur = s.state === 'CURRENT';
        return (
          <Fragment key={s.key}>
            {i > 0 && <li className="bar" aria-hidden="true" />}
            <li className={cx('step', done && 'is-done', cur && 'is-current')} aria-current={cur ? 'step' : undefined}>
              {done && <span className="sr-only">Completed: </span>}
              <span className="n">{done ? <Icon name="check" className="ic-sm" /> : i + 1}</span>
              {cur && <span className="sr-only">{`Step ${i + 1} of ${track.length}: `}</span>}
              {s.label}
            </li>
          </Fragment>
        );
      })}
    </ol>
  );
}

/** Timeline with the design's "At risk:" note on warning events. */
function Events({ events }: { events: Ev[] }) {
  if (!events.length) return <p className="xs muted">No events yet.</p>;
  return (
    <ol className="timeline">
      {events.map((e, i) => (
        <li key={i} className={cx('ev', `is-${e.state}`)}>
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

const who = (a?: { kind: string; name: string | null } | null) => (a ? (a.name ?? (a.kind === 'SELLER' ? 'You' : a.kind === 'CUSTOMER' ? 'Customer' : a.kind === 'STAFF' ? 'Marketly support' : 'Marketly')) : '');
const toEvents = (list: GEvent[]): Ev[] =>
  [...list].sort((a, b) => b.at.localeCompare(a.at)).map((e) => ({ t: e.label, d: [fmtDateTime(e.at), e.detail, e.actor && e.actor.kind !== 'SYSTEM' ? who(e.actor) : ''].filter(Boolean).join(' · '), state: 'done' as const }));

/** Design dropzone (title in .u-c-text) with a working file picker. */
function Drop({ title, hint, accept, onFiles, disabled }: { title: string; hint: string; accept: string; onFiles: (f: File[]) => void; disabled?: boolean }) {
  const input = useRef<HTMLInputElement>(null);
  return (
    <div
      className="dropzone"
      onDragOver={(e) => e.preventDefault()}
      onDrop={(e) => {
        e.preventDefault();
        if (!disabled) onFiles(Array.from(e.dataTransfer.files));
      }}
    >
      <Icon name="image-plus" className="ic-lg" />
      <span className="small strong u-c-text">{title}</span>
      <span className="xs">{hint}</span>
      <input ref={input} type="file" hidden multiple accept={accept} onChange={(e) => (onFiles(Array.from(e.target.files ?? [])), (e.target.value = ''))} />
      <Button variant="secondary" size="sm" onClick={() => input.current?.click()} disabled={disabled}>
        Browse files
      </Button>
    </div>
  );
}

function FileList({ files }: { files: FileItem[] }) {
  if (!files.length) return null;
  return (
    <ul className="list">
      {files.map((f) => (
        <li key={f.key}>
          <Icon name="file-text" className="ic-sm" />
          <span className="grow small">
            {f.url ? (
              <a href={f.url} target="_blank" rel="noreferrer">
                {f.name}
              </a>
            ) : (
              f.name
            )}
          </span>
          <span className="xs muted">{f.meta}</span>
        </li>
      ))}
    </ul>
  );
}

const uploadItems = (u: ReturnType<typeof useUploads>): FileItem[] =>
  u.items.map((i) => ({ key: i.key, name: i.name, url: i.url, meta: i.status === 'uploading' ? 'Uploading…' : i.status === 'failed' ? (i.error ?? 'Upload failed') : `${(i.size / 1048576).toFixed(1)} MB · you · just now` }));
const mediaName = (m: GImage, fallback: string) => m.alt || fallback;

const sk = <span className="sk sk-line" aria-hidden="true" />;

export default function Return() {
  const { ref = '' } = useParams();
  const q = useSellerReturn(ref);
  const crumbs = <Breadcrumbs items={[{ label: 'Returns and cases', to: href('seller/returns') }, { label: ref }]} />;
  if (q.isPending || q.isError || !q.data) {
    return (
      <SellerLayout active="returns">
        <div className="page-head">
          <div className="t">
            {crumbs}
            <h1 className="h1">
              Return <span className="mono">{ref}</span>
            </h1>
          </div>
        </div>
        {q.isPending ? (
          <div className="sb-main" aria-busy="true">
            <div className="stack gap-5">
              <div className="sk sk-card" />
              <div className="sk sk-card" />
            </div>
            <div className="stack gap-5">
              <div className="sk sk-card" />
            </div>
          </div>
        ) : q.isError ? (
          <Alert tone="danger" title="We couldn’t load this return">
            {errorMessage(q.error)}{' '}
            <Button variant="secondary" size="sm" onClick={() => void q.refetch()}>
              Try again
            </Button>
          </Alert>
        ) : (
          <section className="card">
            <div className="card-body">
              <EmptyState icon="search-x" title={`We couldn’t find return ${ref}`} action={<Button to={href('seller/returns')}>Back to returns</Button>}>
                Check the return number. You can only open returns of your own store.
              </EmptyState>
            </div>
          </section>
        )}
      </SellerLayout>
    );
  }
  return <ReturnCase r={q.data} crumbs={crumbs} />;
}

function ReturnCase({ r, crumbs }: { r: SellerReturn; crumbs: ReactNode }) {
  const { api } = useApi();
  const qc = useQueryClient();
  const { sellerId, can } = useSellerSession();
  const allowed = (a: string) => r.allowedActions.includes(a);
  const canRespond = can('returns.requests.respond');
  const canIssue = can('returns.refunds.issue');
  const status = r.status.toUpperCase();
  const inspect = !!r.shipment || !!r.inspection || status === 'RECEIVED';
  const p = r.payment;
  const currency = p?.itemPaid.currency ?? r.items[0]?.unitPrice.currency ?? 'USD';
  const maxRefundable = p?.maxRefundable ?? { amount: 0, currency };
  const fault = (r.shippingPaidBy ?? '').toUpperCase() === 'SELLER';
  const customerFee = r.terms.responsibilities.find((x) => x.reasonGroup === 'CHANGE_OF_MIND')?.customerFee;
  const [flash, setFlash] = useState<{ tone: 'success' | 'warning'; title: string; body: ReactNode } | null>(null);

  const refresh = async () => {
    await Promise.all([
      qc.invalidateQueries({ queryKey: ['returns', 'detail', r.ref] }),
      qc.invalidateQueries({ queryKey: ['returns', 'counts', sellerId] }),
      qc.invalidateQueries({ queryKey: ['returns', 'list', sellerId] }),
      qc.invalidateQueries({ queryKey: ['messaging'] }),
    ]);
  };
  const path = { params: { path: { id: r.id } } };

  /* ---------------------------------------------------------------- respond */
  const [decision, setDecision] = useState<Decision>('approve');
  const [method, setMethod] = useState<LabelMethod>('prepaid_qr');
  const [noReturn, setNoReturn] = useState(false);
  const [noReturnCode, setNoReturnCode] = useState<'' | NoReturnCode>('');
  const [noReturnText, setNoReturnText] = useState('');
  const [infoQ, setInfoQ] = useState('');
  const [rejReason, setRejReason] = useState<'' | RejectCode>('');
  const [rejText, setRejText] = useState('');
  const [respTried, setRespTried] = useState(false);
  const noReturnKey = useRef(newIdempotencyKey());

  const respErrors = {
    infoQ: respTried && decision === 'info' && !infoQ.trim() ? 'Write the question for the customer.' : '',
    rejReason: respTried && decision === 'reject' && !rejReason ? 'Choose a reason for rejecting.' : '',
    rejText: respTried && decision === 'reject' && !rejText.trim() ? 'Explain which term applies so the customer knows what to do next.' : '',
    noReturnCode: respTried && decision === 'approve' && noReturn && !noReturnCode ? 'Choose why the item doesn’t need to come back.' : '',
    noReturnText: respTried && decision === 'approve' && noReturn && !noReturnText.trim() ? 'Add the details we record with this exception.' : '',
  };

  const respond = useMutation({
    mutationFn: async (d: Decision) => {
      if (d === 'info') return call(api.POST('/api/seller/returns/requests/{id}/request-info', { ...path, body: { question: infoQ.trim() } }));
      if (d === 'reject') return call(api.POST('/api/seller/returns/requests/{id}/reject', { ...path, body: { reasonCode: rejReason as RejectCode, explanation: rejText.trim() } }));
      if (noReturn)
        return call(
          api.POST('/api/seller/returns/requests/{id}/approve-without-return', {
            params: { path: { id: r.id }, header: { 'Idempotency-Key': noReturnKey.current } },
            body: { reasonCode: noReturnCode as NoReturnCode, details: noReturnText.trim(), remedy: { kind: 'full_refund' } },
          }),
        );
      return call(api.POST('/api/seller/returns/requests/{id}/approve', { ...path, body: { labelMethod: method } }));
    },
    onSuccess: async (_, d) => {
      if (d === 'approve' && noReturn) noReturnKey.current = newIdempotencyKey();
      setFlash(
        d === 'info'
          ? { tone: 'success', title: 'Question sent to the customer', body: 'The respond-by clock is paused until the customer replies.' }
          : d === 'reject'
            ? { tone: 'warning', title: 'Return rejected', body: 'The customer can ask Marketly to review your decision.' }
            : noReturn
              ? { tone: 'success', title: 'Refund approved without a return', body: `The refund goes back to ${p?.methodLabel ?? 'the original payment'}.` }
              : { tone: 'success', title: method === 'customer_arranged' ? 'Return approved' : 'Return approved and label sent', body: 'When the parcel arrives, mark it as received, then record the inspection and refund.' },
      );
      announce(d === 'approve' ? 'Return approved' : d === 'info' ? 'Question sent to the customer' : 'Return rejected');
      await refresh();
    },
  });
  const submitResponse = (d: Decision) => {
    setDecision(d);
    setRespTried(true);
    if (d === 'info' && !infoQ.trim()) return;
    if (d === 'reject' && (!rejReason || !rejText.trim())) return;
    if (d === 'approve' && noReturn && (!noReturnCode || !noReturnText.trim())) return;
    respond.mutate(d);
  };
  const respondErr = respond.error instanceof ApiError && respond.error.code === 'RESPONSE_DEADLINE_PASSED' ? 'The respond-by time passed and Marketly support is handling this return now.' : respond.error ? errorMessage(respond.error) : '';
  const respondable = allowed('approve') || allowed('request-info') || allowed('reject');
  const busy = respond.isPending;

  /* ---------------------------------------------------------------- receive, inspect, refund */
  const draft = (r.inspectionDraft?.inspection ?? {}) as Partial<{ conditionOutcome: Condition; grade: Grade; notes: string; proposedStockOutcome: StockOutcome; missingParts: string[]; regradeCondition: string; checks: Array<{ key?: string; label: string; passed: boolean }> }>;
  const draftRemedy = (r.inspectionDraft?.remedy ?? {}) as Partial<{ kind: string; amount: { amount: number }; explanation: string }>;
  const [cond, setCond] = useState<Condition>(draft.conditionOutcome ?? 'as_described');
  const [grade, setGrade] = useState<'' | Grade>(draft.grade ?? '');
  const [notes, setNotes] = useState(draft.notes ?? '');
  const [stock, setStock] = useState<StockOutcome>(draft.proposedStockOutcome ?? 'restock');
  const [regrade, setRegrade] = useState(draft.regradeCondition ?? '');
  const [missing, setMissing] = useState((draft.missingParts ?? []).join(', '));
  const [checks, setChecks] = useState<Record<string, boolean>>(() => Object.fromEntries((draft.checks ?? []).map((c) => [c.key ?? c.label, c.passed])));
  const photos = useUploads('inspection_photo', { accept: /\.(jpe?g|png)$/i, maxBytes: 10 * 1024 * 1024 });
  const [refundKind, setRefundKind] = useState<'full' | 'part'>(draftRemedy.kind === 'partial_refund' ? 'part' : 'full');
  const [partAmt, setPartAmt] = useState(draftRemedy.amount ? (draftRemedy.amount.amount / 100).toFixed(2) : '');
  const [partWhy, setPartWhy] = useState(draftRemedy.explanation ?? '');
  const [refTried, setRefTried] = useState(false);
  const remedyKey = useRef(newIdempotencyKey());

  const fullAmount = r.earningsImpact?.refundToCustomer ?? maxRefundable;
  const amt = toMinor(partAmt);
  const amtErr = refundKind === 'part' && refTried ? (Number.isNaN(amt) || amt <= 0 ? 'Enter the partial amount, like 53.00.' : amt > maxRefundable.amount ? `Enter ${money(maxRefundable)} or less. You can't refund more than the customer paid.` : '') : '';
  const whyErr = refundKind === 'part' && refTried && !partWhy.trim() ? 'Explain the deduction to the customer.' : '';
  const gradeErr = refTried && !r.inspection && !grade ? 'Choose the grade of the returned item.' : '';
  const missingErr = refTried && !r.inspection && cond === 'missing_parts' && !missing.trim() ? 'List the missing parts.' : '';
  const partValid = !Number.isNaN(amt) && amt > 0 && amt <= maxRefundable.amount;
  const refundAmount = refundKind === 'full' ? fullAmount : { amount: partValid ? amt : 0, currency };

  const inspectionInput = () => ({
    conditionOutcome: cond,
    grade: (grade || undefined) as Grade,
    proposedStockOutcome: stock,
    notes: notes.trim() || undefined,
    missingParts: cond === 'missing_parts' ? missing.split(',').map((s) => s.trim()).filter(Boolean) : undefined,
    regradeCondition: stock === 'different_condition' && regrade.trim() ? regrade.trim() : undefined,
    checks: r.inspectionChecklist?.items.map((c) => ({ key: c.key, label: c.label, passed: !!checks[c.key] })),
    mediaIds: photos.assetIds.length ? photos.assetIds : undefined,
  });
  const remedyInput = () =>
    refundKind === 'full'
      ? { kind: 'full_refund' as const, explanation: partWhy.trim() || undefined }
      : {
          kind: 'partial_refund' as const,
          amount: { amount: amt, currency },
          explanation: partWhy.trim(),
          deductions: [{ label: 'Deduction', amount: { amount: maxRefundable.amount - amt, currency }, reason: partWhy.trim() }],
        };

  const receive = useMutation({
    mutationFn: () => call(api.POST('/api/seller/returns/requests/{id}/receive', { ...path, body: {} })),
    onSuccess: async () => {
      setFlash({ tone: 'success', title: 'Return marked as received', body: 'Record the inspection and your refund decision next.' });
      announce('Return marked as received');
      await refresh();
    },
  });
  const saveDraft = useMutation({
    mutationFn: () => call(api.PUT('/api/seller/returns/requests/{id}/inspection-draft', { ...path, body: { inspection: inspectionInput(), remedy: remedyInput() } })),
    onSuccess: async () => {
      announce('Inspection draft saved');
      await qc.invalidateQueries({ queryKey: ['returns', 'detail', r.ref] });
    },
  });
  const confirm = useMutation({
    mutationFn: async () => {
      if (status === 'RECEIVED') await call(api.POST('/api/seller/returns/requests/{id}/inspection', { ...path, body: { ...inspectionInput(), grade: grade as Grade } }));
      return call(api.POST('/api/seller/returns/requests/{id}/remedy', { params: { path: { id: r.id }, header: { 'Idempotency-Key': remedyKey.current } }, body: remedyInput() }));
    },
    onSuccess: async () => {
      remedyKey.current = newIdempotencyKey();
      photos.clear();
      announce(`Refund of ${money(refundAmount)} started`);
      await refresh();
    },
    onError: () => void qc.invalidateQueries({ queryKey: ['returns', 'detail', r.ref] }),
  });
  const confirmRefund = () => {
    setRefTried(true);
    if (refundKind === 'part' && (!partValid || !partWhy.trim())) return;
    if (status === 'RECEIVED' && (!grade || (cond === 'missing_parts' && !missing.trim()))) return;
    confirm.mutate();
  };
  const canInspect = allowed('inspection') && canIssue;
  const canRemedy = (allowed('remedy') || allowed('inspection')) && canIssue;
  const refundErr = confirm.error instanceof ApiError && confirm.error.code === 'REFUND_EXCEEDS_REFUNDABLE' ? `Enter ${money(maxRefundable)} or less.` : confirm.error ? errorMessage(confirm.error) : '';

  /* ---------------------------------------------------------------- messages and evidence */
  // The return's own conversation; the first message starts it with the returnId (SellerStartInput.returnId).
  const conv = r.conversation;
  const theCase = r.case;
  const [reply, setReply] = useState('');
  const [replyErr, setReplyErr] = useState('');
  const attachments = useUploads('message_attachment', { accept: /\.(jpe?g|png|webp|pdf)$/i });
  const attachRef = useRef<HTMLInputElement>(null);
  const canMessage = theCase ? can('support.cases.respond') : can('messaging.conversations.reply') && (conv ? conv.canSend : r.open);
  const send = useMutation({
    mutationFn: async () => {
      const body = reply.trim();
      const mediaIds = attachments.assetIds.length ? attachments.assetIds : undefined;
      if (theCase) return call(api.POST('/api/seller/support/cases/{id}/messages', { params: { path: { id: theCase.id } }, body: { body, mediaIds } }));
      if (conv) return call(api.POST('/api/seller/messaging/conversations/{id}/messages', { params: { path: { id: conv.id } }, body: { body, mediaIds, clientMessageId: newIdempotencyKey() } }));
      if (!r.order) throw new Error('This return has no order to message about.');
      return call(api.POST('/api/seller/messaging/conversations', { body: { orderId: r.order.id, returnId: r.id, body, mediaIds, clientMessageId: newIdempotencyKey() } }));
    },
    onSuccess: async () => {
      setReply('');
      attachments.clear();
      announce('Message sent');
      await refresh();
    },
  });
  const sendMsg = () => {
    if (!reply.trim()) return setReplyErr('Write a message first.');
    if (attachments.uploading) return setReplyErr('Wait for the attachments to finish uploading.');
    setReplyErr('');
    send.mutate();
  };
  // Evidence: before a dispute case, return_evidence uploads go on the return (POST returns/requests/{id}/evidence);
  // once a case is open, case_evidence uploads go to the support case.
  const [evidenceErr, setEvidenceErr] = useState('');
  const canAddEvidence = theCase ? can('support.cases.respond') : allowed('evidence') && canRespond;
  const evidence = useUploads(theCase ? 'case_evidence' : 'return_evidence', {
    accept: /\.(jpe?g|png|webp|pdf|mp4)$/i,
    maxBytes: 25 * 1024 * 1024,
    onReady: (item) => {
      if (!item.assetId) return;
      const body = { kind: evidenceKind(item), mediaIds: [item.assetId] };
      (theCase
        ? call(api.POST('/api/seller/support/cases/{id}/evidence', { params: { path: { id: theCase.id } }, body }))
        : call(api.POST('/api/seller/returns/requests/{id}/evidence', { ...path, body }))
      ).then(
        () => {
          announce(`${item.name} added to ${theCase ? 'the case' : 'the return'}`);
          void qc.invalidateQueries({ queryKey: ['returns', 'detail', r.ref] });
        },
        (e) => setEvidenceErr(errorMessage(e)),
      );
    },
  });
  const onRecord: FileItem[] = [
    ...r.evidence.flatMap((e) => e.media.map((m) => ({ key: m.id, name: mediaName(m, human(e.kind)), url: m.url, meta: `${e.party === 'seller' ? 'you' : 'Marketly'} · ${fmtDate(e.addedAt)}` }))),
    ...(theCase?.evidence ?? []).filter((e) => !r.evidence.some((x) => x.caseId && x.media.some((m) => e.media.some((n) => n.id === m.id)))).flatMap((e) => e.media.map((m) => ({ key: `${e.id}${m.id}`, name: mediaName(m, human(e.kind)), url: m.url, meta: `${e.party.toLowerCase() === 'seller' ? 'you' : e.party.toLowerCase() === 'customer' ? 'customer' : 'Marketly'} · ${fmtDate(e.at)}` }))),
    ...(r.inspection?.media ?? []).map((m) => ({ key: `i${m.id}`, name: mediaName(m, 'Inspection photo'), url: m.url, meta: `you · ${fmtDate(r.inspection!.inspectedAt)}` })),
  ];

  type Msg = { id: string; kind: 'customer' | 'me' | 'staff' | 'note'; who?: string; when?: string; text: ReactNode; icon?: IconName; files?: GImage[] };
  const respondBy = r.deadlines?.respondBy;
  const msgs: Msg[] = [
    ...[...(conv?.messages.items ?? [])]
      .sort((a, b) => a.at.localeCompare(b.at))
      .map((m): Msg =>
        m.kind === 'system' || m.kind === 'SYSTEM'
          ? { id: m.id, kind: 'note', icon: 'info', text: m.body }
          : {
              id: m.id,
              kind: m.fromMe ? 'me' : (m.author?.kind ?? '').toUpperCase() === 'STAFF' ? 'staff' : 'customer',
              who: m.authorLabel ?? undefined,
              when: fmtDateTime(m.at),
              text: m.hidden ? <i>This message was hidden by Marketly.</i> : m.body,
              files: m.attachments,
            },
      ),
    ...(r.infoRequest
      ? [
          { id: 'info-q', kind: 'note' as const, icon: 'pause' as IconName, text: `You asked: “${r.infoRequest.question}” · ${fmtDateTime(r.infoRequest.askedAt)}. The customer replies by ${fmtDue(r.infoRequest.replyDueAt)}.` },
          ...(r.infoRequest.reply ? [{ id: 'info-a', kind: 'customer' as const, who: `${r.customer?.displayName ?? 'Customer'} (customer)`, when: fmtDateTime(r.infoRequest.repliedAt), text: r.infoRequest.reply }] : []),
        ]
      : []),
    ...(respondBy && respondable ? [{ id: 'due', kind: 'note' as const, icon: 'clock' as IconName, text: `Respond by ${fmtDue(respondBy.dueAt)}. After that, Marketly support may decide this return.` }] : []),
  ];

  /* ---------------------------------------------------------------- earnings, deadlines, activity */
  // Before approval the label charge is an estimate (labelChargeEstimated, REST only; the screen query doesn't select it).
  const restReturn = useQuery({
    queryKey: ['returns', 'rest', r.id],
    queryFn: () => call(api.GET('/api/seller/returns/requests/{id}', path)),
    enabled: !!r.earningsImpact?.labelCharge && !r.shipment,
  });
  const labelEstimate = restReturn.data?.earningsImpact?.labelChargeEstimated ? restReturn.data.earningsImpact.labelCharge : null;
  // A partial refund being entered: the earnings card follows it (POST …/remedy/preview).
  const [previewAmt, setPreviewAmt] = useState<number | null>(null);
  const previewable = refundKind === 'part' && partValid && canRemedy && !r.refundRequest;
  useEffect(() => {
    const t = setTimeout(() => setPreviewAmt(previewable ? amt : null), 300);
    return () => clearTimeout(t);
  }, [previewable, amt]);
  const remedyPreview = useQuery({
    queryKey: ['returns', 'remedy-preview', r.id, previewAmt],
    queryFn: () =>
      call(
        api.POST('/api/seller/returns/requests/{id}/remedy/preview', {
          ...path,
          body: { kind: 'partial_refund', amount: { amount: previewAmt!, currency }, deductions: [{ label: 'Deduction', amount: { amount: maxRefundable.amount - previewAmt!, currency }, reason: partWhy.trim() || 'Deduction' }] },
        }),
      ),
    enabled: previewAmt !== null && previewable,
    retry: false,
  });
  const ei = (previewable && previewAmt === amt ? remedyPreview.data?.earningsImpact : null) ?? r.earningsImpact;
  const inspectDue = r.deadlines?.refundBy ?? r.deadlines?.inspectBy;
  const deadlineEvent: Ev[] = r.open && r.nextDeadline ? [{ t: r.nextStep, d: `Due ${fmtDue(r.nextDeadline.dueAt)}`, state: deadlineTone(r.nextDeadline) === 'ok' ? 'current' : 'warn' }] : [];
  const activity: Ev[] = [...deadlineEvent, ...toEvents(r.activity)];

  /* ---------------------------------------------------------------- cards */
  const firstItem = r.items[0];
  const orderItem = r.order?.groups.flatMap((g) => g.items).find((i) => i.id === firstItem?.orderItemId);
  const reasonIcon: IconName = /defect|damag|not working/i.test(r.reason) ? 'zap-off' : 'package-open';

  const decisionSummary = r.decision ? (
    <Alert tone={r.decision.kind === 'REJECTED' ? 'warning' : 'success'} title={r.decision.kind === 'REJECTED' ? 'Return rejected' : r.decision.kind === 'APPROVED_WITHOUT_RETURN' ? 'Refund approved without a return' : r.decision.kind === 'OVERTURNED' ? 'Decision overturned by Marketly' : 'Return approved'}>
      {r.decision.explanation ?? ''} {`Decided ${fmtDateTime(r.decision.decidedAt)}${r.decision.platformDecision ? ' by Marketly support' : ''}.`}
    </Alert>
  ) : status === 'INFO_REQUESTED' ? (
    <Alert tone="success" title="Question sent to the customer">
      The respond-by clock is paused until the customer replies{r.infoRequest ? ` (by ${fmtDue(r.infoRequest.replyDueAt)})` : ''}.
    </Alert>
  ) : status === 'CANCELLED' ? (
    <Alert tone="info" title="Return cancelled">
      The customer withdrew the request or it expired.
    </Alert>
  ) : null;

  const decisionCard = (
    <section className="card">
      <div className="card-head">
        <div className="stack gap-0">
          <h3 className="h4">Your response</h3>
          <span className="xs muted">The customer sees your decision and any explanation</span>
        </div>
      </div>
      <div className="card-body">
        {decisionSummary}
        {r.refund && (
          <Alert tone={r.refund.status === 'FAILED' || r.refund.status === 'DECLINED' ? 'danger' : 'info'} title={`Refund ${r.refund.ref} is ${r.refund.statusLabel}`}>
            {r.refund.explanation}
          </Alert>
        )}
        {respondErr && <Alert tone="danger">{respondErr}</Alert>}
        {respondable && !canRespond && <Alert tone="info">Your role can’t respond to returns. Ask the store owner for the “Respond to returns” permission.</Alert>}
        {respondable && (
          <>
            <OptionCard id="rt-dec-approve" name="rt-dec" title={<span className="strong">Approve return</span>} body="Send a prepaid label. Refund after you receive and inspect the item." checked={decision === 'approve'} onChange={() => setDecision('approve')} disabled={!allowed('approve')} />
            <div className={cx('sb-subform', decision === 'approve' && 'is-on')}>
              <span className="small strong">Return shipping</span>
              <OptionCard
                id="rt-ship-qr"
                name="rt-ship"
                title={<span className="strong small">{fault ? 'You pay: prepaid QR drop-off code' : 'Prepaid QR drop-off code, customer pays'}</span>}
                body={fault ? `Deducted from your earnings at the carrier’s rate${labelEstimate ? ` (about ${money(labelEstimate)})` : ''}. The customer shows the code at a drop-off point.` : `${customerFee ? money(customerFee) : 'Return shipping'} is deducted from the customer’s refund.`}
                checked={method === 'prepaid_qr'}
                onChange={() => setMethod('prepaid_qr')}
                disabled={noReturn}
              />
              <OptionCard
                id="rt-ship-label"
                name="rt-ship"
                title={<span className="strong small">{fault ? 'You pay: printable prepaid label' : 'Printable prepaid label, customer pays'}</span>}
                body={fault ? `Deducted from your earnings at the carrier’s rate${labelEstimate ? ` (about ${money(labelEstimate)})` : ''}.` : `${customerFee ? money(customerFee) : 'Return shipping'} is deducted from the customer’s refund.`}
                checked={method === 'prepaid_label'}
                onChange={() => setMethod('prepaid_label')}
                disabled={noReturn}
              />
              <OptionCard
                id="rt-ship-cust"
                name="rt-ship"
                title={<span className="strong small">Customer pays and arranges shipping</span>}
                body={fault ? 'Not allowed for defective, damaged or wrong items under platform rules.' : 'The customer sends it back and adds the tracking number.'}
                disabled={fault || noReturn}
                checked={method === 'customer_arranged'}
                onChange={() => setMethod('customer_arranged')}
              />
              {allowed('approve-without-return') && canIssue && (
                <>
                  <label className="check" htmlFor="rt-noreturn">
                    <input type="checkbox" id="rt-noreturn" checked={noReturn} onChange={(e) => setNoReturn(e.target.checked)} />
                    <span>Refund without asking for the item back (records a reason; use for low-value or unsafe items)</span>
                  </label>
                  {noReturn && (
                    <>
                      <Field label="Reason (required)" error={respErrors.noReturnCode}>
                        <Select id="rt-noreturn-reason" options={NO_RETURN_REASONS} value={noReturnCode} onChange={(e) => setNoReturnCode(e.target.value as NoReturnCode)} />
                      </Field>
                      <Field label="Details we record with the exception (required)" error={respErrors.noReturnText}>
                        <Textarea id="rt-noreturn-text" placeholder="Example: Return label would cost more than the item." value={noReturnText} onChange={(e) => setNoReturnText(e.target.value)} />
                      </Field>
                      <span className="xs muted">
                        Full refund of {money(fullAmount)} to {p?.methodLabel ?? 'the original payment'}.
                      </span>
                    </>
                  )}
                </>
              )}
            </div>
            <OptionCard id="rt-dec-info" name="rt-dec" title={<span className="strong">Request more information</span>} body="Pauses the respond-by clock until the customer replies." checked={decision === 'info'} onChange={() => setDecision('info')} disabled={!allowed('request-info')} />
            <div className={cx('sb-subform', decision === 'info' && 'is-on')}>
              <Field label="Question for the customer" error={respErrors.infoQ}>
                <Textarea id="rt-info-q" placeholder="Example: Does it stop when connected by cable as well?" value={infoQ} onChange={(e) => setInfoQ(e.target.value)} onFocus={() => setDecision('info')} />
              </Field>
            </div>
            <OptionCard id="rt-dec-reject" name="rt-dec" title={<span className="strong">Reject return</span>} body="Only when the request breaks your published terms. The customer can ask Marketly to review." checked={decision === 'reject'} onChange={() => setDecision('reject')} disabled={!allowed('reject')} />
            <div className={cx('sb-subform', decision === 'reject' && 'is-on')}>
              <Field label="Reason for rejecting (required)" error={respErrors.rejReason}>
                <Select id="rt-rej-reason" options={REJECT_REASONS} value={rejReason} onChange={(e) => setRejReason(e.target.value as RejectCode)} onFocus={() => setDecision('reject')} />
              </Field>
              <Field label="Explanation shown to the customer (required)" error={respErrors.rejText}>
                <Textarea id="rt-rej-text" placeholder="Explain which term applies and what the customer can do next." value={rejText} onChange={(e) => setRejText(e.target.value)} onFocus={() => setDecision('reject')} />
              </Field>
            </div>
          </>
        )}
      </div>
      {respondable && (
        <div className="card-foot">
          <Button variant="secondary" onClick={() => submitResponse('info')} disabled={busy || !canRespond || !allowed('request-info')}>
            Request information
          </Button>
          {decision === 'reject' ? (
            <Button variant="danger" icon="x" onClick={() => submitResponse('reject')} disabled={busy || !canRespond}>
              Reject return
            </Button>
          ) : (
            <Button icon="check" onClick={() => submitResponse('approve')} disabled={busy || !canRespond || (noReturn ? !canIssue : !allowed('approve'))}>
              {noReturn ? 'Approve refund without return' : method === 'customer_arranged' ? 'Approve return' : 'Approve and send label'}
            </Button>
          )}
        </div>
      )}
    </section>
  );

  const requestCard = (H: 'h2' | 'h3') => (
    <Card title="Customer’s request" titleAs={H} sub="Submitted with the return form">
      <div className="row gap-2">
        <Badge tone="warning" icon={reasonIcon}>
          {r.reason}
        </Badge>
        <Badge tone="outline">Wants: {REMEDY_WANTED[r.remedy.toUpperCase()] ?? human(r.remedy)}</Badge>
      </div>
      {r.details && <p className="sb-quote">“{r.details}”</p>}
      {r.media.length > 0 && (
        <div className="sb-photos">
          {r.media.map((m, i) => (
            <figure key={m.id}>
              <Img icon="image" tint="2" className="r43" src={m.url ?? undefined} alt={m.alt ?? ''} />
              <figcaption>{m.alt || `Photo ${i + 1}`}</figcaption>
            </figure>
          ))}
        </div>
      )}
      <span className="xs muted">
        {r.media.length ? `${r.media.length} photo${r.media.length > 1 ? 's' : ''}` : 'No photos'} · requested {fmtDateTime(r.requestedAt)}
      </span>
    </Card>
  );

  const shipment = r.shipment;
  const inspection = r.inspection;
  const stockLabel = (v: string) => STOCK.find((s) => s.value === v.toLowerCase())?.label ?? human(v);
  const inspectCards = (
    <>
      {shipment && (
        <Card
          title="Return shipment"
          sub="Tracked separately from the original delivery"
          actions={
            allowed('receive') && canIssue ? (
              <Button size="sm" icon="package-check" onClick={() => receive.mutate()} disabled={receive.isPending}>
                Mark as received
              </Button>
            ) : (
              <StatusBadge status={human(shipment.status)} />
            )
          }
        >
          {receive.isError && <Alert tone="danger">{errorMessage(receive.error)}</Alert>}
          <KeyValue
            pairs={[
              ['Carrier', [[shipment.carrier, shipment.service].filter(Boolean).join(' '), LABEL_METHOD[shipment.method.toUpperCase()]].filter(Boolean).join(', ')],
              [
                'Tracking',
                shipment.trackingNumber ? (
                  shipment.trackingUrl ? (
                    <a className="mono" href={shipment.trackingUrl} target="_blank" rel="noreferrer">
                      {shipment.trackingNumber}
                    </a>
                  ) : (
                    <span className="mono">{shipment.trackingNumber}</span>
                  )
                ) : (
                  'Not scanned yet'
                ),
              ],
              ['Label cost', `${shipment.cost ? `${money(shipment.cost)} ` : ''}(${(PAID_BY[shipment.paidBy.toUpperCase()] ?? human(shipment.paidBy)).toLowerCase()})`],
              ['Delivered to', shipment.to ? [shipment.to.name, shipment.to.city, [shipment.to.region, shipment.to.postalCode].filter(Boolean).join(' ')].filter(Boolean).join(', ') : '—'],
            ]}
          />
          <Events events={toEvents(shipment.events)} />
        </Card>
      )}
      <Card title="Inspection outcome" titleAs="h3" sub={inspection ? `Recorded ${fmtDateTime(inspection.inspectedAt)} by ${who(inspection.inspectedBy)}` : 'Record what arrived before you decide the refund'}>
        {inspection ? (
          <KeyValue
            pairs={[
              ['Condition on arrival', CONDITIONS.find((c) => c.value === inspection.conditionOutcome.toLowerCase())?.title ?? human(inspection.conditionOutcome)],
              ['Grade', GRADES.find((g) => g.value === inspection.grade.toLowerCase())?.label ?? human(inspection.grade)],
              ['Stock outcome', stockLabel(inspection.proposedStockOutcome)],
              ...(inspection.missingParts.length ? [['Missing parts', inspection.missingParts.join(', ')] as [string, string]] : []),
              ...(inspection.notes ? [['Notes', inspection.notes] as [string, string]] : []),
            ]}
          />
        ) : (
          <fieldset className="stack gap-3 fieldset-reset" disabled={!canInspect}>
            {!canInspect && <p className="xs muted">{status === 'RECEIVED' ? 'Your role can’t record inspections.' : 'Mark the return as received when the parcel arrives, then record the inspection.'}</p>}
            <fieldset className="stack gap-2 fieldset-reset">
              <legend className="label" style={{ marginBottom: 6 }}>
                Condition on arrival
              </legend>
              {CONDITIONS.map((c) => (
                <OptionCard key={c.value} id={`rt-cond-${c.value}`} name="rt-cond" title={<span className="strong small">{c.title}</span>} body={c.body} checked={cond === c.value} onChange={() => (setCond(c.value), c.partial && setRefundKind('part'))} />
              ))}
            </fieldset>
            {cond === 'missing_parts' && (
              <Field label="What is missing" hint="Separate parts with commas" error={missingErr}>
                <TextInput id="rt-missing" value={missing} onChange={(e) => setMissing(e.target.value)} placeholder="Example: USB-C cable, carry pouch" />
              </Field>
            )}
            {r.inspectionChecklist && r.inspectionChecklist.items.length > 0 && (
              <fieldset className="stack gap-2 fieldset-reset">
                <legend className="label" style={{ marginBottom: 6 }}>
                  Checks
                </legend>
                {r.inspectionChecklist.items.map((c) => (
                  <Checkbox key={c.key} id={`rt-check-${c.key}`} label={`${c.label}${c.required ? '' : ' (optional)'}`} checked={!!checks[c.key]} onChange={(e) => setChecks((s) => ({ ...s, [c.key]: e.target.checked }))} />
                ))}
              </fieldset>
            )}
            <div className="sb-form-grid">
              <Field label="Inspection notes" optional>
                <Textarea id="rt-insp-notes" placeholder="What you tested and what you found" value={notes} onChange={(e) => setNotes(e.target.value)} />
              </Field>
              <div className="stack gap-3">
                <Field label="Grade" error={gradeErr}>
                  <Select id="rt-grade" options={[{ value: '', label: 'Choose a grade' }, ...GRADES]} value={grade} onChange={(e) => setGrade(e.target.value as Grade)} />
                </Field>
                <Field label="Stock outcome" hint={STOCK.find((s) => s.value === stock)?.hint}>
                  <Select id="rt-stock" options={STOCK} value={stock} onChange={(e) => setStock(e.target.value as StockOutcome)} />
                </Field>
                {stock === 'different_condition' && (
                  <Field label="Resell as" optional>
                    <TextInput id="rt-regrade" value={regrade} onChange={(e) => setRegrade(e.target.value)} placeholder="Example: Used – Like new" />
                  </Field>
                )}
              </div>
            </div>
            <Drop title="Add inspection photos" hint="Optional, JPG or PNG up to 10 MB. Kept with the case if the customer disputes it." accept="image/jpeg,image/png" onFiles={photos.add} disabled={!canInspect} />
            {photos.error && <span className="xs muted">{photos.error}</span>}
            <FileList files={uploadItems(photos)} />
          </fieldset>
        )}
      </Card>
      <section className="card">
        <div className="card-head">
          <div className="stack gap-0">
            <h3 className="h4">Refund decision</h3>
            <span className="xs muted">
              Refundable now: {money(maxRefundable)}
              {p ? ` of ${money(p.itemPaid)}` : ''}
            </span>
          </div>
        </div>
        <div className="card-body">
          {r.refund ? (
            <Alert tone={r.refund.status === 'FAILED' || r.refund.status === 'DECLINED' ? 'danger' : 'success'} title={`Refund ${r.refund.ref} is ${r.refund.statusLabel}`}>
              {r.refund.explanation}
              {inspection ? ` Stock outcome recorded: ${stockLabel(inspection.proposedStockOutcome)}.` : ''}
            </Alert>
          ) : (
            <>
              {refundErr && <Alert tone="danger">{refundErr}</Alert>}
              {saveDraft.isError && <Alert tone="danger">{errorMessage(saveDraft.error)}</Alert>}
              {r.inspectionDraft && (
                <p className="xs muted">
                  Draft saved {fmtDateTime(r.inspectionDraft.savedAt)} by {who(r.inspectionDraft.savedBy)}.
                </p>
              )}
              <OptionCard
                id="rt-ref-full"
                name="rt-ref"
                title={
                  <span className="row between">
                    <span className="strong small">Full refund</span>
                    <span className="num strong">{money(fullAmount)}</span>
                  </span>
                }
                body={p && p.shippingPaid.amount > 0 ? `Item value and ${money(p.shippingPaid)} original shipping, as the terms allow.` : 'Item value. Original shipping was free.'}
                checked={refundKind === 'full'}
                onChange={() => setRefundKind('full')}
                disabled={!canRemedy}
              />
              <OptionCard id="rt-ref-part" name="rt-ref" title={<span className="strong small">Partial refund</span>} body="Only with a recorded reason, for example missing parts or damage caused after delivery." checked={refundKind === 'part'} onChange={() => setRefundKind('part')} disabled={!canRemedy} />
              <div className="sb-form-grid">
                <div className="field">
                  <label className="label" htmlFor="rt-ref-amt">
                    Partial amount
                  </label>
                  <span className="input-group">
                    <span className="affix">$</span>
                    <input
                      className={cx('input', amtErr && 'is-error')}
                      id="rt-ref-amt"
                      type="text"
                      inputMode="decimal"
                      value={partAmt}
                      placeholder="0.00"
                      disabled={!canRemedy}
                      aria-invalid={amtErr ? true : undefined}
                      aria-describedby={amtErr ? 'rt-ref-amt-err' : 'rt-ref-amt-hint'}
                      onChange={(e) => setPartAmt(e.target.value)}
                      onFocus={() => setRefundKind('part')}
                    />
                  </span>
                  {amtErr ? (
                    <span className="error-text" id="rt-ref-amt-err">
                      <Icon name="circle-alert" className="ic-sm" />
                      {amtErr}
                    </span>
                  ) : (
                    <span className="hint" id="rt-ref-amt-hint">
                      Up to {money(maxRefundable)}. You can't refund more than the customer paid.
                    </span>
                  )}
                </div>
                <Field label="Explanation for the customer (required for partial)" error={whyErr}>
                  <Textarea id="rt-ref-why" placeholder="Example: Charging cable was not returned. Deducted $6.00, the replacement cost." value={partWhy} onChange={(e) => setPartWhy(e.target.value)} disabled={!canRemedy} />
                </Field>
              </div>
              <Alert tone="info" title="What the customer sees">
                After you confirm, the refund shows as Processing until the card network confirms it, then Sent. We tell the customer it can take 3–5 business days to appear. We never show it as received before that.
              </Alert>
            </>
          )}
        </div>
        {!r.refund && (
          <div className="card-foot">
            {allowed('inspection-draft') && canIssue && (
              <Button variant="ghost" onClick={() => saveDraft.mutate()} disabled={saveDraft.isPending || confirm.isPending}>
                {saveDraft.isPending ? 'Saving…' : 'Save draft'}
              </Button>
            )}
            <Button icon="check" onClick={confirmRefund} disabled={!canRemedy || confirm.isPending || photos.uploading}>
              {status === 'RECEIVED' ? `Confirm inspection and refund ${money(refundAmount)}` : `Confirm refund ${money(refundAmount)}`}
            </Button>
          </div>
        )}
      </section>
    </>
  );

  const respondCards = (
    <>
      {requestCard('h2')}
      <div className="grid lg2 gap-5">
        <Card title="Order item" titleAs="h3">
          {r.items.map((it) => (
            <div key={it.orderItemId} className="row top gap-3">
              <Img icon="package" tint="2" className="thumb" src={it.imageUrl ?? undefined} alt="" />
              <div className="stack gap-1 grow">
                <span className="small strong">{it.title}</span>
                <span className="xs sub">
                  {[...it.options.map((o) => o.value)].join(' · ')}
                  {it.options.length ? ' · ' : ''}
                  {it.sku && <span className="mono">{it.sku}</span>}
                  {it.sku ? ' · ' : ''}Qty {it.quantity}
                </span>
                {it.orderItemId === firstItem?.orderItemId && orderItem?.deliveredAt && (
                  <span className="xs sub">
                    Delivered {fmtDate(orderItem.deliveredAt)}
                    {orderItem.returnWindowEndsAt ? ` · return window ends ${fmtDate(orderItem.returnWindowEndsAt)}` : ''}
                  </span>
                )}
              </div>
              <span className="num strong">{money({ amount: it.unitPrice.amount * it.quantity, currency: it.unitPrice.currency })}</span>
            </div>
          ))}
          {p && (
            <KeyValue
              pairs={[
                ['Paid by customer', `${money(p.itemPaid)} item · ${money(p.shippingPaid)} shipping · ${p.discountShare.amount ? `${money(p.discountShare)} discount` : 'no discount'}`],
                ['Max refundable', `${money(p.maxRefundable)} (${p.refundedSoFar.amount ? `${money(p.refundedSoFar)} refunded so far` : 'nothing refunded yet'})`],
                ['Payment', `${p.methodLabel}, refund goes back to this card`],
              ]}
            />
          )}
        </Card>
        <Card title="Policy that applies" titleAs="h3" sub={r.order ? `Terms accepted at purchase, ${fmtDay(r.order.placedAt)}` : 'Terms accepted at purchase'}>
          <KeyValue
            pairs={[
              [r.terms.source === 'SELLER_TERMS' ? 'Your return terms' : 'Return terms', `${r.terms.windowDays} days after delivery${r.terms.condition ? ` · ${r.terms.condition}` : ''}`],
              ['Reason category', r.reason],
              [
                'Return shipping',
                <>
                  <b>{PAID_BY[(r.shippingPaidBy ?? '').toUpperCase()] ?? 'Per the terms'}</b>
                  {fault ? ' (platform rule for defective, damaged or wrong items)' : customerFee ? ` (${money(customerFee)} deducted from the refund unless you offer free returns)` : ''}
                </>,
              ],
              ['Remedy offered', r.terms.remedies.map((x, i) => (i ? REMEDY_OFFERED[x] ?? human(x) : human(REMEDY_OFFERED[x] ?? x))).join(' or ')],
              ...(respondBy ? [['Respond by', `${fmtDue(respondBy.dueAt)} (${r.terms.responseTargetBusinessDays} business days)`] as [string, string]] : []),
            ]}
          />
          <p className="xs muted">
            {r.terms.summary}. Platform baseline {r.terms.policyVersion}: you may offer more generous terms, not shorter ones.
          </p>
        </Card>
      </div>
      {decisionCard}
    </>
  );

  const msgNode = (m: Msg): ReactNode =>
    m.kind === 'note' ? (
      <span key={m.id} className="sb-sysnote">
        <Icon name={m.icon ?? 'clock'} className="ic-sm" />
        {m.text}
      </span>
    ) : (
      <div key={m.id} className={cx('sb-msg', m.kind === 'me' && 'me', m.kind === 'staff' && 'staff')}>
        <span className="who">
          {m.who}
          {m.kind === 'staff' && (
            <Badge tone="info" icon="shield">
              Marketly
            </Badge>
          )}
          <span className="when">{m.when}</span>
        </span>
        <span>{m.text}</span>
        {m.files && m.files.length > 0 && (
          <span className="row gap-2">
            {m.files.map((f, i) => (
              <a key={f.id} className="xs" href={f.url ?? '#'} target="_blank" rel="noreferrer">
                <Icon name="paperclip" className="ic-sm" /> {f.alt || `Attachment ${i + 1}`}
              </a>
            ))}
          </span>
        )}
      </div>
    );

  const custName = r.customer?.displayName ?? 'Customer';

  return (
    <SellerLayout active="returns">
      <div className="page-head">
        <div className="t">
          {crumbs}
          <h1 className="h1">
            Return <span className="mono">{r.ref}</span>
          </h1>
          <p className="sub small">
            Order{' '}
            <Link className="mono" to={href('seller/order', '', { ref: r.orderRef })}>
              {r.orderRef}
            </Link>{' '}
            · requested {fmtFull(r.requestedAt)} by {custName} · reason: {r.reason}
          </p>
        </div>
        <div className="actions">
          {r.flags.map((f) => (
            <Badge key={f.kind} tone="danger" icon="shield">
              {f.label}
            </Badge>
          ))}
          <StatusBadge status={r.statusLabel} />
        </div>
      </div>
      <div className="sb-main">
        <div className="stack gap-5">
          {flash && (
            <Alert tone={flash.tone} title={flash.title}>
              {flash.body}
            </Alert>
          )}
          <ReturnSteps track={r.track} />
          {inspect ? inspectCards : respondCards}
          {inspect && requestCard('h3')}
          <section className="card">
            <div className="card-head">
              <div className="stack gap-0">
                <h3 className="h4">Messages and evidence</h3>
                <span className="xs muted">{theCase || r.platformInvolved ? 'Customer, you and Marketly support · kept with this case' : 'Customer and you · Marketly support joins if the case is escalated'}</span>
              </div>
            </div>
            <div className="card-body">
              <div className="sb-thread" aria-live="polite">
                {msgs.length ? msgs.map(msgNode) : <span className="xs muted">No messages yet.</span>}
              </div>
              {send.isError && <Alert tone="danger">{errorMessage(send.error)}</Alert>}
              <Field label="Reply" hint={replyErr ? undefined : (conv?.rulesNote ?? 'Messages stay private to this order. Don’t share personal contact details or links outside Marketly.')} error={replyErr}>
                <Textarea id="rt-reply" placeholder={theCase ? 'Reply to the customer and Marketly support' : 'Write to the customer'} value={reply} onChange={(e) => (setReply(e.target.value), setReplyErr(''))} disabled={!canMessage} />
              </Field>
              {!canMessage && <span className="xs muted">{r.open ? 'Your role can’t send messages here, or Marketly closed this conversation.' : 'This return is closed. Messages are kept with the order.'}</span>}
              <FileList files={uploadItems(attachments)} />
              {attachments.error && <span className="xs muted">{attachments.error}</span>}
              <div className="stack gap-2">
                <span className="label">Dispute evidence</span>
                <span className="xs muted">If the customer disputes your decision, support reviews purchase terms, shipment records, photos and these messages. Add files now so they are on record.</span>
                {canAddEvidence && <Drop title="Upload evidence" hint="Photos, test videos, invoices or carrier records · PDF, JPG, PNG, MP4 up to 25 MB" accept="application/pdf,image/jpeg,image/png,video/mp4" onFiles={evidence.add} />}
                {(evidenceErr || evidence.error) && <span className="xs muted">{evidenceErr || evidence.error}</span>}
                <FileList files={[...onRecord, ...uploadItems(evidence).filter((_, i) => evidence.items[i].status !== 'ready')]} />
              </div>
            </div>
            <div className="card-foot">
              <input ref={attachRef} type="file" hidden multiple accept="image/jpeg,image/png,image/webp,application/pdf" onChange={(e) => (attachments.add(Array.from(e.target.files ?? [])), (e.target.value = ''))} />
              <Button variant="ghost" icon="paperclip" onClick={() => attachRef.current?.click()} disabled={!canMessage}>
                Attach file
              </Button>
              <Button variant="secondary" icon="send" onClick={sendMsg} disabled={!canMessage || send.isPending}>
                Send message
              </Button>
            </div>
          </section>
        </div>
        <div className="stack gap-5">
          {theCase && (
            <Alert tone={theCase.nextAction?.youNeedToAct ? 'warning' : 'info'} title={`Marketly support case ${theCase.ref} · ${theCase.statusLabel}`}>
              {theCase.nextAction ? `${theCase.nextAction.label}${theCase.nextAction.due ? ` by ${fmtDue(theCase.nextAction.due.dueAt)}` : ''}.` : 'Marketly support is reviewing this return.'}
            </Alert>
          )}
          {inspect
            ? inspectDue &&
              r.open && (
                <Alert tone={deadlineTone(inspectDue) === 'ok' ? 'info' : 'warning'} title={`Inspect and refund by ${fmtDue(inspectDue.dueAt)}`}>
                  <Deadline tone={deadlineTone(inspectDue)}>{timeLeft(inspectDue.dueAt)}</Deadline>
                  <br />
                  Marketly support may step in if this passes.
                </Alert>
              )
            : respondBy &&
              respondable && (
                <Alert tone={deadlineTone(respondBy) === 'ok' ? 'info' : 'warning'} title={`Respond by ${fmtDue(respondBy.dueAt)}`}>
                  <Deadline tone={deadlineTone(respondBy)}>{timeLeft(respondBy.dueAt)}</Deadline>
                  <br />
                  If you miss the deadline, Marketly support may decide the return for you, and it counts as an unresolved case in Account health.
                </Alert>
              )}
          {!respondable && !inspectDue && r.open && !theCase && (
            <Alert tone="info" title="Next step">
              {r.nextStep}
            </Alert>
          )}
          {ei && (
            <section className="card">
              <div className="card-body">
                <div className="sb-impact">
                  <div className="row between">
                    <span className="small strong">Effect on your earnings</span>
                    {!r.refundRequest && <Badge tone="outline">Estimate</Badge>}
                  </div>
                  <div className="flow">
                    <div>
                      <span className="xs muted">Refund to customer</span>
                      <b>{money(ei.refundToCustomer)}</b>
                    </div>
                    <div>
                      <span className="xs muted">Your earnings</span>
                      <b className="sb-neg">{negMoney(ei.sellerEarningsChange)}</b>
                    </div>
                    <div>
                      <span className="xs muted">Marketplace fee refunded to you</span>
                      <b>{money(ei.feeReturned)}</b>
                    </div>
                  </div>
                  {ei.labelCharge && ei.labelCharge.amount !== 0 && <SummaryRow k={`Prepaid return label (${fault ? 'you pay' : 'customer pays'}${labelEstimate ? ', estimated' : ''})`} v={<span className="sb-neg">{negMoney(ei.labelCharge)}</span>} />}
                  <SummaryRow className="strong" k="Total change to your balance" v={<b className={cx(ei.totalBalanceChange.amount < 0 && 'sb-neg')}>{ei.totalBalanceChange.amount < 0 ? negMoney(ei.totalBalanceChange) : money(ei.totalBalanceChange)}</b>} />
                  <span className="xs muted">
                    {ei.note}. {ei.afterPayout ? 'This order was already paid out, so the amount is deducted from your next payout.' : 'If this order is paid out before the refund, the amount is deducted from your next payout.'}
                  </span>
                </div>
              </div>
            </section>
          )}
          <Card title="Customer" titleAs="h3">
            <div className="row gap-3">
              <Avatar name={custName} />
              <div className="stack gap-0">
                <span className="small strong">{custName}</span>
                <span className="xs muted">{[r.customer?.city, r.customer ? `${r.customer.ordersWithSeller} order${r.customer.ordersWithSeller === 1 ? '' : 's'} with you` : ''].filter(Boolean).join(' · ') || sk}</span>
              </div>
            </div>
            <p className="xs muted">{conv?.privacyNote ?? 'Contact details stay private. Use the case messages.'}</p>
          </Card>
          <Card title="Activity" titleAs="h3">
            <Events events={activity} />
          </Card>
        </div>
      </div>
    </SellerLayout>
  );
}
