import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useRef, useState, type ReactNode } from 'react';
import { Link, useParams } from 'react-router';
import { ApiError, call, errorMessage, useApi, fileSize, useUploads } from '@marketly/web-shared/api';
import caseDetailQuery from '@marketly/web-shared/api/graphql/store/CaseDetail.graphql?raw';
import { AccountLayout } from '@/layouts';
import { href } from '@marketly/web-shared/routes';
import { Alert, Avatar, Breadcrumbs, Button, Dialog, EmptyState, Field, Icon, Img, KeyValue, Select, StatusBadge, Textarea, Timeline, Track, type TimelineEvent } from '@marketly/web-shared/ui';
import { isoInText } from '@marketly/web-shared/lib/format';
import { dateLong, dateShort, dayDate, dayDateTime, dateTime, humanize } from './data/format';
import { LoadError, Loading, SkLines } from './data/states';
import { UploadList } from './data/UploadList';

// Design: pages/store/help-case.html (open) · help-case--decision-made.html (decision card, appeal).
// The state follows the case data, not the URL view: GraphQL screen query CaseDetail(ref) (the route carries
// the CS- ref; the query returns the id for REST). Writes: reply POST /api/store/support/cases/{id}/messages
// { body, mediaIds }, appeal POST …/{id}/appeal { reason, mediaIds }, escalate POST …/{id}/escalate,
// respond to an offer POST …/{id}/offers/{offerId}/respond, reopen POST …/{id}/reopen; attachments upload
// with purpose case_evidence. After each write the screen query is read again.

interface Money {
  amount: number;
  currency: string;
  formatted: string;
}
interface MediaRef {
  id: string;
  url: string;
  alt?: string | null;
  bytes?: number | null;
  fileName?: string | null;
}
interface CaseData {
  id: string;
  ref: string;
  kind: string;
  subject: string;
  status: string;
  statusLabel: string;
  priority: string;
  openedAt: string;
  open: boolean;
  expectedReply: string;
  orderId: string | null;
  orderRef: string | null;
  returnRef: string | null;
  reopenUntil: string | null;
  reopenRules: string;
  category: { key: string; label: string } | null;
  handledBy: { kind: string; name: string; team: string | null; supportFollowing: boolean; staff: { kind: string; name: string | null } | null };
  nextAction: { label: string; whoMustAct: string; youNeedToAct: boolean; note: string | null; due: { dueAt: string; state: string } | null };
  items: Array<{ orderItemId: string; title: string; quantity: number; imageUrl: string | null; ownerType: string; sellerName: string; packageLabel: string | null; itemStatus: string; estimate: string | null; options: Array<{ name: string; value: string }>; price: Money }>;
  messages: Array<{ id: string; authorLabel: string; role: string; body: string; at: string; attachments: MediaRef[] }>;
  attachments: MediaRef[];
  offers: Array<{ id: string; from: string; kind: string; shipBy: string | null; note: string | null; status: string; respondBy: string | null; amount: Money | null }>;
  decision: { outcome: string; reason: string; decidedAt: string; appealDeadline: string | null; appealRoute: string; final: boolean; decidedBy: { kind: string; name: string | null } | null } | null;
  remedies: Array<{ id: string; kind: string; chargedTo: string | null; status: string; statusLabel: string; track: string[]; currentStep: number | null; dueAt: string | null; destination: string | null; note: string | null; amount: Money | null }>;
  appeal: { id: string; status: string; reason: string; submittedAt: string; decidedAt: string | null; outcome: string | null } | null;
  timeline: Array<{ at: string; label: string; detail: string | null }>;
  can: { reply: boolean; escalate: boolean; appeal: boolean; reopen: boolean; respondToOffer: boolean; addEvidence: boolean };
}

type Who = 'customer' | 'seller' | 'staff';
const ROLE: Record<Who, { badge: string; tone: 'brand' | 'warning' | 'info'; avatarClass?: string }> = {
  customer: { badge: 'You', tone: 'brand' },
  seller: { badge: 'Seller', tone: 'warning', avatarClass: 'sq' },
  staff: { badge: 'Marketly support', tone: 'info' },
};
const who = (role: string): Who => (role.toLowerCase() === 'customer' ? 'customer' : role.toLowerCase() === 'seller' ? 'seller' : 'staff');

const OUTCOME: Record<string, string> = { customer_favored: 'in your favour', seller_favored: 'in the seller’s favour', shared: 'shared between you and the seller', no_fault: 'no fault found', information_only: 'information only' };
const REMEDY: Record<string, string> = { refund: 'full refund', partial_refund: 'partial refund', replacement: 'replacement', return_label: 'return label', goodwill_credit: 'goodwill credit', ship_by_deadline: 'ship by a deadline', none: 'no remedy' };
const CHARGED: Record<string, string> = { seller: 'The seller, deducted from their earnings', platform: 'Marketly', shared: 'Shared by the seller and Marketly' };
const HANDLED: Record<string, string> = { seller: 'seller', official_store: 'Official Store', marketplace_support: 'Marketly support' };
const APPEAL_REASONS = ['Choose a reason', 'The refund amount is wrong', 'I want a replacement instead', 'The item arrived after all', 'Something else'];
const ESCALATE_REASONS: Array<{ value: string; label: string }> = [
  { value: 'seller_no_reply', label: 'The seller hasn’t replied' },
  { value: 'disagree_with_seller', label: 'I don’t agree with the seller' },
  { value: 'refund_late', label: 'A promised refund is late' },
  { value: 'other', label: 'Something else' },
];

const lc = (s: string | null | undefined) => (s ?? '').toLowerCase();

function Attachment({ m, i, size }: { m: MediaRef; i: number; size?: boolean }) {
  return (
    <a className="buy-attach" href={m.url} target="_blank" rel="noopener noreferrer">
      <Icon name="paperclip" className="ic-sm" />
      {m.fileName || m.alt || `Attachment ${i + 1}`}
      {size && m.bytes ? ` · ${fileSize(m.bytes)}` : ''}
    </a>
  );
}

function Thread({ messages }: { messages: CaseData['messages'] }) {
  return (
    <div className="buy-thread" aria-live="polite">
      {messages.map((m) => {
        const w = who(m.role);
        const r = ROLE[w];
        return (
          <div key={m.id} className={`buy-msg is-${w}`}>
            <Avatar name={m.authorLabel} className={r.avatarClass} />
            <div className="bubble">
              <div className="row between gap-2">
                <span className="row gap-2">
                  <span className="small strong">{m.authorLabel}</span>
                  <span className={`badge t-${r.tone}`}>{lc(m.role) === 'system' ? 'Marketly' : r.badge}</span>
                </span>
                <span className="xs muted">{dayDateTime(m.at)}</span>
              </div>
              <p>{m.body}</p>
              {m.attachments.length > 0 && (
                <span className="row gap-2">
                  {m.attachments.map((f, i) => (
                    <Attachment key={f.id} m={f} i={i} />
                  ))}
                </span>
              )}
            </div>
          </div>
        );
      })}
    </div>
  );
}

export default function Case() {
  const { api, gql } = useApi();
  const qc = useQueryClient();
  const { ref = '' } = useParams();

  const q = useQuery({
    queryKey: ['support', 'case', ref],
    queryFn: async () => {
      const r = await gql<{ case: CaseData | null }>(caseDetailQuery, { ref }, 'CaseDetail');
      if (!r.data?.case) {
        const e = r.errors[0];
        throw new ApiError(e?.extensions?.code === 'FORBIDDEN' ? 403 : 404, String(e?.extensions?.code ?? 'NOT_FOUND'), e?.message ?? 'Case not found');
      }
      return r.data.case;
    },
  });
  const c = q.data;
  const refresh = () => {
    void qc.invalidateQueries({ queryKey: ['support', 'case', ref] });
    void qc.invalidateQueries({ queryKey: ['support', 'cases'] });
  };

  // Reply
  const [reply, setReply] = useState('');
  const [replyError, setReplyError] = useState('');
  const [replyOpen, setReplyOpen] = useState(false);
  const replyFiles = useUploads('case_evidence', { max: 5, accept: /\.(jpe?g|png|pdf)$|^image\/(jpeg|png)$|^application\/pdf$/i });
  const fileInput = useRef<HTMLInputElement>(null);
  const sendReply = useMutation({
    mutationFn: () => call(api.POST('/api/store/support/cases/{id}/messages', { params: { path: { id: c!.id } }, body: { body: reply.trim(), mediaIds: replyFiles.assetIds.length ? replyFiles.assetIds : undefined } })),
    onSuccess: () => {
      setReply('');
      replyFiles.clear();
      setReplyOpen(false);
      refresh();
    },
  });
  const send = () => {
    if (!reply.trim()) return setReplyError('Write a message before sending.');
    if (replyFiles.uploading) return setReplyError('Wait for the photos to finish uploading.');
    if (replyFiles.failed) return setReplyError('Remove the photos that failed to upload, or add them again.');
    setReplyError('');
    sendReply.mutate();
  };

  // Appeal
  const [appealOpen, setAppealOpen] = useState(false);
  const [reason, setReason] = useState(APPEAL_REASONS[0]);
  const [appealText, setAppealText] = useState('');
  const [appealTried, setAppealTried] = useState(false);
  const appealErrors = appealTried
    ? { reason: reason === APPEAL_REASONS[0] ? 'Choose a reason for the appeal.' : undefined, text: appealText.trim().length < 20 ? 'Explain what you disagree with (at least 20 characters).' : undefined }
    : {};
  const appeal = useMutation({
    // The API takes the appeal reason as free text: the chosen reason leads the explanation.
    mutationFn: () => call(api.POST('/api/store/support/cases/{id}/appeal', { params: { path: { id: c!.id } }, body: { reason: `${reason}. ${appealText.trim()}` } })),
    onSuccess: () => {
      setAppealOpen(false);
      refresh();
    },
  });
  const submitAppeal = () => {
    setAppealTried(true);
    if (reason === APPEAL_REASONS[0] || appealText.trim().length < 20) return;
    appeal.mutate();
  };

  // Escalate, offers, reopen (shown only when the case allows them)
  const [escalateOpen, setEscalateOpen] = useState(false);
  const [escReason, setEscReason] = useState(ESCALATE_REASONS[0].value);
  const [escNote, setEscNote] = useState('');
  const escalate = useMutation({
    mutationFn: () =>
      call(api.POST('/api/store/support/cases/{id}/escalate', { params: { path: { id: c!.id } }, body: { reason: escReason as 'seller_no_reply', note: escNote.trim() || undefined } })),
    onSuccess: () => {
      setEscalateOpen(false);
      refresh();
    },
  });
  const respond = useMutation({
    mutationFn: (v: { offerId: string; accept: boolean }) => call(api.POST('/api/store/support/cases/{id}/offers/{offerId}/respond', { params: { path: { id: c!.id, offerId: v.offerId } }, body: { accept: v.accept } })),
    onSuccess: refresh,
  });
  const [reopenOpen, setReopenOpen] = useState(false);
  const [reopenText, setReopenText] = useState('');
  const [reopenTried, setReopenTried] = useState(false);
  const reopen = useMutation({
    mutationFn: () => call(api.POST('/api/store/support/cases/{id}/reopen', { params: { path: { id: c!.id } }, body: { reason: reopenText.trim() } })),
    onSuccess: () => {
      setReopenOpen(false);
      refresh();
    },
  });

  const notFound = q.error instanceof ApiError && (q.error.status === 404 || q.error.status === 403);
  if (notFound) {
    return (
      <AccountLayout active="cases" title="Support case" back={href('help/cases')}>
        <EmptyState icon="life-buoy" title="We couldn’t find that case" as="h1" action={<Button to={href('help/cases')}>See your cases</Button>}>
          Check the case number in the email we sent, or open it from your Support cases.
        </EmptyState>
      </AccountLayout>
    );
  }
  if (q.isError) {
    return (
      <AccountLayout active="cases" title={ref} back={href('help/cases')}>
        <LoadError error={q.error} retry={() => void q.refetch()} title="We couldn’t load this case" />
      </AccountLayout>
    );
  }
  if (!c) {
    return (
      <AccountLayout active="cases" title={ref} back={href('help/cases')}>
        <Loading label="Loading the case" />
        <Breadcrumbs items={[{ label: 'Support cases', to: href('help/cases') }, { label: ref }]} />
        <span className="sk sk-line h-30" aria-hidden="true" />
        <SkLines n={6} />
      </AccountLayout>
    );
  }

  const d = c.decision;
  const decided = Boolean(d);
  const firstRemedy = c.remedies[0];
  const appealed = Boolean(c.appeal);
  const handlerKind = HANDLED[lc(c.handledBy.kind)] ?? '';
  const handledLine = handlerKind && !c.handledBy.name.toLowerCase().includes(handlerKind.toLowerCase()) ? `${c.handledBy.name} (${handlerKind})` : c.handledBy.name;
  const openOffers = c.offers.filter((o) => lc(o.status) === 'open');
  const otherParty = c.items[0] && lc(c.items[0].ownerType) === 'seller' ? `${c.items[0].sellerName} and Marketly support` : 'Marketly support';
  const showReplyBox = c.can.reply && (!decided || replyOpen);

  const timeline: TimelineEvent[] = c.timeline.map((e, i) => ({ t: e.label, d: dateTime(e.at), body: e.detail ?? undefined, state: i === c.timeline.length - 1 && c.open ? 'current' : 'done' }));
  if (d?.appealDeadline && !appealed && c.can.appeal) timeline.push({ t: 'Appeal window ends', d: dateLong(d.appealDeadline) });

  const replyBox = (
    <section className="card">
      <div className="card-head">
        <div className="stack gap-0">
          <h3 className="h4">Reply</h3>
        </div>
      </div>
      <div className="card-body">
        <Field label="Your message" error={replyError || (sendReply.isError ? errorMessage(sendReply.error) : undefined)}>
          <Textarea
            id="cs-reply"
            placeholder={`Write to ${otherParty}`}
            value={reply}
            maxLength={5000}
            onChange={(e) => {
              setReply(e.target.value);
              setReplyError('');
            }}
          />
        </Field>
        <UploadList uploads={replyFiles} />
        <div className="row between">
          <input
            ref={fileInput}
            type="file"
            hidden
            accept="image/jpeg,image/png,application/pdf"
            multiple
            onChange={(e) => {
              replyFiles.add(Array.from(e.target.files ?? []));
              e.target.value = '';
            }}
          />
          {c.can.addEvidence ? (
            <Button variant="secondary" size="sm" icon="image-plus" onClick={() => fileInput.current?.click()}>
              Add photos
            </Button>
          ) : (
            <span />
          )}
          <Button icon="send" onClick={send} disabled={sendReply.isPending}>
            {sendReply.isPending ? 'Sending…' : 'Send reply'}
          </Button>
        </div>
      </div>
    </section>
  );

  return (
    <AccountLayout active="cases" title={c.ref} back={href('help/cases')}>
      <div className="stack gap-2">
        <Breadcrumbs items={[{ label: 'Support cases', to: href('help/cases') }, { label: c.ref }]} />
        <div className="row between">
          <div className="stack gap-1">
            <span className="row gap-2">
              <span className="mono strong small">{c.ref}</span>
              <StatusBadge status={c.statusLabel} />
            </span>
            <h1 className="h1">{c.subject}</h1>
            <span className="xs muted">
              Opened {dayDate(c.openedAt)}
              {c.category && <> · Category: {c.category.label}</>} · Priority: {humanize(lc(c.priority))}
            </span>
          </div>
        </div>
      </div>
      {decided && d ? (
        <div className="buy-owner">
          <div>
            <span className="xs muted">Decided by</span>
            <span className="small strong">{d.decidedBy?.name ? `${d.decidedBy.name}, Marketly support` : 'Marketly support'}</span>
            <span className="xs muted">{c.handledBy.team ?? 'Customer Support team'}</span>
          </div>
          <div>
            <span className="xs muted">Next action</span>
            <span className="small strong">{c.nextAction.label}</span>
            <span className="xs muted">{c.nextAction.youNeedToAct ? 'Your reply is needed' : 'Nothing needed from you'}</span>
          </div>
          <div>
            <span className="xs muted">Expected</span>
            <span className="small strong">{c.expectedReply}</span>
            <span className="xs muted">{isoInText(c.nextAction.note ?? (firstRemedy?.note || ''))}</span>
          </div>
        </div>
      ) : (
        <div className="buy-owner">
          <div>
            <span className="xs muted">Handled by</span>
            <span className="small strong">{handledLine}</span>
            <span className="xs muted">{c.handledBy.supportFollowing ? 'Marketly support is following' : (c.handledBy.team ?? '')}</span>
          </div>
          <div>
            <span className="xs muted">Next action · who must act</span>
            <span className="small strong">{c.nextAction.label}</span>
            <span className="xs muted">{c.nextAction.youNeedToAct ? 'You need to reply' : "You don't need to do anything"}</span>
          </div>
          <div>
            <span className="xs muted">Expected response</span>
            <span className="small strong">{c.expectedReply}</span>
            <span className="xs muted">{isoInText(c.nextAction.note)}</span>
          </div>
        </div>
      )}
      <div className="split">
        <div className="stack gap-4">
          {openOffers.map((o) => (
            <Alert key={o.id} tone="info" title={`${o.from.toLowerCase() === 'seller' ? 'The seller' : 'Marketly'} offers: ${humanize(lc(o.kind))}${o.amount ? ` of ${o.amount.formatted}` : ''}${o.shipBy ? ` by ${dateLong(o.shipBy)}` : ''}`}>
              <span className="stack gap-2">
                {o.note && <span>{isoInText(o.note)}</span>}
                {o.respondBy && <span className="xs">Respond by {dayDateTime(o.respondBy)}.</span>}
                {c.can.respondToOffer && (
                  <span className="row gap-2">
                    <Button size="sm" onClick={() => respond.mutate({ offerId: o.id, accept: true })} disabled={respond.isPending}>
                      Accept
                    </Button>
                    <Button variant="secondary" size="sm" onClick={() => respond.mutate({ offerId: o.id, accept: false })} disabled={respond.isPending}>
                      Decline
                    </Button>
                  </span>
                )}
                {respond.isError && <span className="error-text">{errorMessage(respond.error)}</span>}
              </span>
            </Alert>
          ))}
          {d && (
            <section className="card">
              <div className="card-head">
                <div className="row gap-2">
                  <Icon name="gavel" />
                  <h2 className="h3">
                    Decision: {firstRemedy ? `${REMEDY[lc(firstRemedy.kind)] ?? humanize(lc(firstRemedy.kind))}${firstRemedy.amount ? ` of ${firstRemedy.amount.formatted}` : ''}` : (OUTCOME[lc(d.outcome)] ?? humanize(lc(d.outcome)))}
                  </h2>
                </div>
                <StatusBadge status={c.statusLabel} />
              </div>
              <div className="card-body">
                <p className="small sub">
                  <b>Why:</b> {isoInText(d.reason)}
                </p>
                {c.remedies.map((r) => (
                  <div key={r.id} className="stack gap-3">
                    <KeyValue
                      pairs={[
                        ['Remedy', `${humanize(REMEDY[lc(r.kind)] ?? lc(r.kind))}${r.amount ? ` ${r.amount.formatted}` : ''} · ${r.statusLabel}`],
                        ...(r.destination ? ([['Refund to', r.destination]] as Array<[string, string]>) : []),
                        ...(r.chargedTo ? ([['Funded by', CHARGED[lc(r.chargedTo)] ?? humanize(lc(r.chargedTo))]] as Array<[string, string]>) : []),
                      ]}
                    />
                    {r.track.length > 0 && (
                      <div className="stack gap-2">
                        <span className="small strong">{lc(r.kind).includes('refund') ? 'Refund progress' : 'Progress'}</span>
                        <Track labels={r.track} done={Math.min(r.track.length, (r.currentStep ?? 0) + (lc(r.status) === 'completed' ? 1 : 0))} tone={lc(r.status) === 'failed' ? 'danger' : undefined} />
                        {r.note && <span className="xs muted">{isoInText(r.note)}</span>}
                      </div>
                    )}
                  </div>
                ))}
                {c.appeal ? (
                  <Alert tone="info" title={`Appeal ${lc(c.appeal.status) === 'submitted' || lc(c.appeal.status) === 'in_review' ? 'submitted' : humanize(lc(c.appeal.status))}`}>
                    {c.appeal.outcome ?? d.appealRoute}
                  </Alert>
                ) : c.can.appeal ? (
                  <div className="panel stack gap-2">
                    <span className="small strong">Don't agree? You can appeal{d.appealDeadline ? ` until ${dateShort(d.appealDeadline)}` : ''}</span>
                    <span className="xs sub">{d.appealRoute}</span>
                    <div>
                      <Button variant="secondary" size="sm" icon="scale" onClick={() => setAppealOpen(true)}>
                        Appeal this decision
                      </Button>
                    </div>
                  </div>
                ) : (
                  d.final && <span className="xs muted">This decision is final.</span>
                )}
                {c.reopenRules && (
                  <p className="xs muted">
                    <b>Reopen rules:</b> {c.reopenRules}
                  </p>
                )}
              </div>
            </section>
          )}
          <section className="card">
            <div className="card-head">
              <div className="stack gap-0">
                {decided ? <h3 className="h4">Conversation</h3> : <h2 className="h4">Conversation</h2>}
                <span className="xs muted">Messages from you, the seller and Marketly staff are labelled</span>
              </div>
            </div>
            <div className="card-body">
              <Thread messages={c.messages} />
            </div>
            {decided && c.can.reply && !replyOpen && (
              <div className="card-foot">
                <span className="xs muted grow">You can still add a message while the case is open.</span>
                <Button variant="secondary" size="sm" icon="message-square" onClick={() => setReplyOpen(true)}>
                  Reply
                </Button>
              </div>
            )}
            {(c.can.escalate || c.can.reopen) && (
              <div className="card-foot">
                <span className="xs muted grow">{c.can.escalate ? 'Not getting an answer, or don’t agree with the seller?' : `This case is closed.${c.reopenUntil ? ` You can reopen it until ${dateLong(c.reopenUntil)}.` : ''}`}</span>
                {c.can.escalate && (
                  <Button variant="secondary" size="sm" icon="life-buoy" onClick={() => setEscalateOpen(true)}>
                    Ask Marketly to help
                  </Button>
                )}
                {c.can.reopen && (
                  <Button variant="secondary" size="sm" icon="undo-2" onClick={() => setReopenOpen(true)}>
                    Reopen case
                  </Button>
                )}
              </div>
            )}
          </section>
          {showReplyBox && replyBox}
          {!c.open && !c.can.reopen && <p className="xs muted">This case is closed. {c.reopenRules}</p>}
        </div>
        <aside className="stack gap-4">
          {(c.items.length > 0 || c.orderRef) && (
            <section className="card">
              <div className="card-head">
                <div className="stack gap-0">
                  <h3 className="h4">{c.items.length > 1 ? 'Linked items' : 'Linked item'}</h3>
                </div>
              </div>
              <div className="card-body">
                {c.items.map((it) => (
                  <div key={it.orderItemId} className="buy-mini">
                    <Img icon="package" src={it.imageUrl ?? undefined} />
                    <div className="stack gap-0">
                      <span className="small strong">{it.title}</span>
                      <span className="xs muted">{[...it.options.map((o) => o.value), `Qty ${it.quantity}`, it.price.formatted].join(' · ')}</span>
                    </div>
                  </div>
                ))}
                <KeyValue
                  pairs={[
                    ...(c.orderRef
                      ? ([
                          [
                            'Order',
                            <Link className="mono" to={href('account/order', '', { ref: c.orderRef })}>
                              {c.orderRef}
                            </Link>,
                          ],
                        ] as Array<[string, ReactNode]>)
                      : []),
                    ...(c.items[0]?.packageLabel ? ([['Package', `${c.items[0].packageLabel} · ${c.items[0].sellerName}`]] as Array<[string, ReactNode]>) : []),
                    ...(c.items.length === 1 ? ([['Item status', <StatusBadge status={c.items[0].itemStatus} />]] as Array<[string, ReactNode]>) : []),
                    ...(c.items.length === 1 && c.items[0].estimate ? ([['Estimate', c.items[0].estimate]] as Array<[string, ReactNode]>) : []),
                    ...(c.returnRef
                      ? ([
                          [
                            'Return',
                            <Link className="mono" to={href('account/return', '', { ref: c.returnRef })}>
                              {c.returnRef}
                            </Link>,
                          ],
                        ] as Array<[string, ReactNode]>)
                      : []),
                  ]}
                />
              </div>
            </section>
          )}
          {c.attachments.length > 0 && (
            <section className="card">
              <div className="card-head">
                <div className="stack gap-0">
                  <h3 className="h4">Attachments</h3>
                </div>
              </div>
              <div className="card-body">
                {c.attachments.map((m, i) => (
                  <Attachment key={m.id} m={m} i={i} size />
                ))}
              </div>
            </section>
          )}
          <section className="card">
            <div className="card-head">
              <div className="stack gap-0">
                <h3 className="h4">Timeline</h3>
              </div>
            </div>
            <div className="card-body">
              <Timeline events={timeline} />
            </div>
          </section>
        </aside>
      </div>

      <Dialog
        open={appealOpen}
        onClose={() => setAppealOpen(false)}
        title="Appeal this decision"
        foot={
          <>
            <Button variant="ghost" onClick={() => setAppealOpen(false)}>
              Cancel
            </Button>
            <Button icon="scale" onClick={submitAppeal} disabled={appeal.isPending}>
              {appeal.isPending ? 'Submitting…' : 'Submit appeal'}
            </Button>
          </>
        }
      >
        <p className="small sub">
          {d?.appealRoute}
          {d?.appealDeadline ? ` You can appeal until ${dateShort(d.appealDeadline)}.` : ''}
        </p>
        <Field label="Reason" error={appealErrors.reason}>
          <Select id="cs-appeal-reason" options={APPEAL_REASONS} value={reason} onChange={(e) => setReason(e.target.value)} />
        </Field>
        <Field label="What do you disagree with?" hint="Add anything the first decision may have missed." error={appealErrors.text ?? (appeal.isError ? errorMessage(appeal.error) : undefined)}>
          <Textarea id="cs-appeal-text" value={appealText} maxLength={5000} onChange={(e) => setAppealText(e.target.value)} />
        </Field>
      </Dialog>

      <Dialog
        open={escalateOpen}
        onClose={() => setEscalateOpen(false)}
        title="Ask Marketly to help"
        foot={
          <>
            <Button variant="ghost" onClick={() => setEscalateOpen(false)}>
              Cancel
            </Button>
            <Button icon="life-buoy" onClick={() => escalate.mutate()} disabled={escalate.isPending}>
              {escalate.isPending ? 'Sending…' : 'Ask Marketly to help'}
            </Button>
          </>
        }
      >
        <p className="small sub">A Marketly support agent reviews the order, the messages and the purchase terms, then takes over the case.</p>
        <Field label="Why do you need our help?">
          <Select id="cs-esc-reason" options={ESCALATE_REASONS} value={escReason} onChange={(e) => setEscReason(e.target.value)} />
        </Field>
        <Field label="Anything else we should know?" optional error={escalate.isError ? errorMessage(escalate.error) : undefined}>
          <Textarea id="cs-esc-note" value={escNote} maxLength={2000} onChange={(e) => setEscNote(e.target.value)} />
        </Field>
      </Dialog>

      <Dialog
        open={reopenOpen}
        onClose={() => setReopenOpen(false)}
        title="Reopen this case"
        foot={
          <>
            <Button variant="ghost" onClick={() => setReopenOpen(false)}>
              Cancel
            </Button>
            <Button
              icon="undo-2"
              onClick={() => {
                setReopenTried(true);
                if (reopenText.trim().length >= 10) reopen.mutate();
              }}
              disabled={reopen.isPending}
            >
              {reopen.isPending ? 'Reopening…' : 'Reopen case'}
            </Button>
          </>
        }
      >
        <p className="small sub">{c.reopenRules}</p>
        <Field label="What went wrong?" error={reopenTried && reopenText.trim().length < 10 ? 'Tell us what didn’t happen (at least 10 characters).' : reopen.isError ? errorMessage(reopen.error) : undefined}>
          <Textarea id="cs-reopen" value={reopenText} maxLength={2000} onChange={(e) => setReopenText(e.target.value)} />
        </Field>
      </Dialog>
    </AccountLayout>
  );
}
