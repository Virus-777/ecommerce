import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useEffect, useRef, useState, type CSSProperties } from 'react';
import { Link } from 'react-router';
import { call, errorMessage, useApi } from '@marketly/web-shared/api';
import { AdminLayout } from '@marketly/web-shared/layouts';
import { cx } from '@marketly/web-shared/lib/cx';
import { useView } from '@marketly/web-shared/lib/hooks';
import { href } from '@marketly/web-shared/routes';
import { Alert, Badge, Button, Dialog, EmptyState, Field, Img, OptionCard, PageHeader, Select, StatusBadge, TableWrap, Tabs, Textarea, type Tone } from '@marketly/web-shared/ui';
import { useStaffSession } from '@/app/session';
import { date, dateTime, LoadError, SkeletonLines } from '@/app/parts';
import {
  AUTHOR_BADGE, isQa, isReported, isResponse, KIND_LABEL, LEGIT, NOUN, OUTCOME_LABEL, reasonLabel, reasonTone, rowActions, rowEdge,
  type AppealRow, type ContentType, type Edge, type ModerationDetail, type ModerationItem, type ModerationReason, type ReasonCode, type RowAction,
} from './data/reviews';

// Design: pages/admin/admin-reviews.html (reported content: queue + decision) ·
// view "q-a-and-seller-responses" = the Q&A answers and seller responses tables.
// API: GET /api/admin/reviews/moderation-items (status open / decided; decided items carry `decision`: outcome, reason,
// moderator), /moderation-items/{id}, /moderation-reasons;
// POST /moderation-items/{id}/decide and /refer; staff answers POST /reviews/questions/{id}/answers.
// Appeals tab: GET /appeals?status=submitted, POST /appeals/{id}/decide { overturn, reason } (an item under appeal
// refuses Keep/Remove; the appeal is decided by a moderator other than the original one, SAME_MODERATOR otherwise).

type View = 'q-a-and-seller-responses';
type TabKey = 'reported' | 'appeals' | 'qa' | 'seller' | 'decided';
type Decision = 'keep' | 'remove' | 'edit';

const KIND_FILTERS: Array<{ value: '' | ContentType; label: string }> = [
  { value: '', label: 'All types' },
  { value: 'product_review', label: 'Product reviews' },
  { value: 'seller_feedback', label: 'Seller feedback' },
  { value: 'answer', label: 'Q&A answers' },
];

const DECISIONS: Array<{ value: Decision; title: string; body: string }> = [
  { value: 'keep', title: 'Keep', body: 'Content follows the policy' },
  { value: 'remove', title: 'Remove for policy', body: 'Pick the rule it breaks' },
  { value: 'edit', title: 'Request edit', body: 'Ask the reviewer to change one part' },
];
const DECISION_API = { keep: 'keep', remove: 'remove', edit: 'request_edit' } as const;

const template = (d: Decision, noun: string) =>
  d === 'keep'
    ? `We reviewed this report. The ${noun} describes the buyer's own experience with a verified purchase and follows our review policy, so it stays published. You can respond publicly under the ${noun}.`
    : d === 'remove'
      ? `We reviewed this report and removed the ${noun} because it breaks our review policy. Thank you for reporting it.`
      : `Please edit your ${noun} to remove the part that breaks our review policy. The rest of your ${noun} can stay as written.`;

function decisionErrors(decision: Decision, reason: string, msg: string) {
  const e: { reason?: string; msg?: string } = {};
  if (decision === 'keep' && reason !== LEGIT) e.reason = 'Keeping means there is no policy breach. Choose the legitimate experience reason, or pick Remove for policy.';
  if (decision !== 'keep' && (!reason || reason === LEGIT)) e.reason = 'Pick the rule it breaks. "Harms sales" is not a removal reason.';
  if (decision === 'edit' && !msg.trim()) e.msg = 'Tell the reviewer which part to change.';
  return e;
}

const ACTIONS: Record<RowAction, { label: string; variant: 'ghost' | 'secondary' | 'danger-soft' | 'primary'; outcome: string; tone: Tone }> = {
  keep: { label: 'Keep', variant: 'ghost', outcome: 'Kept', tone: 'success' },
  staff: { label: 'Add staff answer', variant: 'secondary', outcome: 'Staff answer added', tone: 'brand' },
  edit: { label: 'Request edit', variant: 'secondary', outcome: 'Edit requested', tone: 'warning' },
  remove: { label: 'Remove', variant: 'danger-soft', outcome: 'Removed', tone: 'danger' },
  publish: { label: 'Publish', variant: 'primary', outcome: 'Published', tone: 'success' },
  reject: { label: 'Reject response', variant: 'danger-soft', outcome: 'Rejected', tone: 'danger' },
  trust: { label: 'Send to Trust and Risk', variant: 'ghost', outcome: 'With Trust and Risk', tone: 'warning' },
};
const NEEDS_DIALOG: RowAction[] = ['staff', 'edit', 'remove', 'reject', 'trust'];

const ROW_NOTICE: Record<RowAction, (name: string) => string> = {
  keep: (n) => `Answer on ${n} kept`,
  staff: (n) => `Staff answer for ${n} sent for a second check`,
  edit: (n) => `Edit requested on ${n}`,
  remove: (n) => `Answer on ${n} removed`,
  publish: (n) => `Published on ${n}`,
  reject: (n) => `Response from ${n} rejected`,
  trust: (n) => `Response from ${n} sent to Trust and Risk`,
};

const EDGE_SR: Record<Exclude<Edge, ''>, string> = { warn: 'At risk: ', flagged: 'Urgent: ' };
const EDGE_CLASS: Record<Edge, string> = { '': '', warn: 'is-warn', flagged: 'is-flagged' };

function EdgeLegend({ warn = true }: { warn?: boolean }) {
  return (
    <p className="status-legend status-legend--edge">
      <span className="sr-only">Legend: </span>
      <span className="sl sl-danger">
        <i aria-hidden="true" />
        Red edge = urgent: payment, medical or fake-review signals
      </span>
      {warn && (
        <span className="sl sl-warning">
          <i aria-hidden="true" />
          Amber edge = at risk: failed an automatic rule check
        </span>
      )}
    </p>
  );
}

function StarsBar({ rating, cls }: { rating: number; cls: string }) {
  return (
    <span className={cx('stars5', cls)} style={{ '--r': `${(rating / 5) * 100}%` } as CSSProperties} role="img" aria-label={`${rating} out of 5 stars`}>
      ★★★★★
    </span>
  );
}

function KvRow({ k, v, mono }: { k: string; v: string; mono?: string }) {
  return (
    <>
      <dt>{k}</dt>
      <dd>
        {mono && (
          <>
            <span className="mono">{mono}</span>
            {' · '}
          </>
        )}
        {v}
      </dd>
    </>
  );
}

interface RowDialog {
  item: ModerationItem;
  action: RowAction;
  name: string;
}

/** The content body of a moderation detail: headline, text, author line, media. */
function contentOf(d: ModerationDetail) {
  if (d.review) return { headline: d.review.headline ?? '', body: d.review.text ?? '', at: d.review.reviewedAt, media: d.review.media ?? [], response: d.review.response, variant: d.review.variantLabel };
  if (d.feedback) return { headline: '', body: (d.feedback as { text?: string | null }).text ?? d.item.excerpt, at: (d.feedback as { createdAt?: string }).createdAt, media: [], response: null, variant: null };
  if (d.answer) return { headline: d.question ? `"${d.question.text}"` : '', body: `"${d.answer.text}"`, at: d.answer.answeredAt, media: [], response: null, variant: null };
  if (d.question) return { headline: '', body: `"${d.question.text}"`, at: d.question.askedAt, media: [], response: null, variant: null };
  if (d.response) return { headline: d.respondingTo ?? '', body: `"${d.response.text}"`, at: d.response.publishedAt ?? undefined, media: [], response: null, variant: null };
  return { headline: '', body: d.item.excerpt, at: undefined, media: [], response: null, variant: null };
}

export default function Reviews() {
  const { api } = useApi();
  const qc = useQueryClient();
  const { can, accountId } = useStaffSession();
  const canDecide = can('reviews.moderation.decide');
  const canDecideAppeal = can('reviews.appeals.decide');
  const canStaffAnswer = can('reviews.answers.staff');
  const [view, setView] = useView<View>();
  const [sub, setSub] = useState<'' | 'seller' | 'decided' | 'appeals'>('');
  const [notice, setNotice] = useState<{ title: string; body: string } | null>(null);
  const [actionError, setActionError] = useState('');

  const reasonsQ = useQuery({ queryKey: ['reviews', 'moderation-reasons'], queryFn: () => call(api.GET('/api/admin/reviews/moderation-reasons')) as Promise<ModerationReason[]>, staleTime: 600_000 });
  const reasons = reasonsQ.data ?? [];
  const openQ = useQuery({ queryKey: ['reviews', 'moderation', 'open'], queryFn: () => call(api.GET('/api/admin/reviews/moderation-items', { params: { query: { status: 'open', limit: 100 } } })) });
  const all = openQ.data?.items ?? [];

  /* ----- Reported content: queue + decision ----- */
  const [kind, setKind] = useState<'' | ContentType>('');
  const pending = all.filter(isReported);
  const queue = pending.filter((r) => !kind || r.contentType === kind);
  const [activeId, setActiveId] = useState('');
  const active: ModerationItem | undefined = queue.find((r) => r.id === activeId) ?? queue[0];
  const noun = active ? NOUN[active.contentType] : 'review';
  const detailQ = useQuery({ queryKey: ['reviews', 'moderation', 'item', active?.id], enabled: !!active, queryFn: () => call(api.GET('/api/admin/reviews/moderation-items/{id}', { params: { path: { id: active!.id } } })) });
  const detail = detailQ.data;

  const [decision, setDecision] = useState<Decision>('keep');
  const [reason, setReason] = useState(LEGIT);
  const [msg, setMsg] = useState(() => template('keep', 'review'));
  const [attempted, setAttempted] = useState(false);
  const errors = attempted ? decisionErrors(decision, reason, msg) : {};

  const resetDecision = (n: string) => {
    setDecision('keep');
    setReason(LEGIT);
    setMsg(template('keep', n));
    setAttempted(false);
    setActionError('');
  };
  useEffect(() => resetDecision(noun), [active?.id]);
  const select = (item: ModerationItem) => setActiveId(item.id);
  const changeDecision = (d: Decision) => {
    setDecision(d);
    setReason(d === 'keep' ? LEGIT : '');
    setMsg(template(d, noun));
    setAttempted(false);
  };
  const goNext = (afterId: string) => {
    const idx = queue.findIndex((r) => r.id === afterId);
    const rest = queue.filter((r) => r.id !== afterId);
    const next = rest[idx] ?? rest[0];
    setActiveId(next?.id ?? '');
  };

  const refresh = () => {
    void qc.invalidateQueries({ queryKey: ['reviews', 'moderation'] });
    void qc.invalidateQueries({ queryKey: ['reviews', 'appeals'] });
    void qc.invalidateQueries({ queryKey: ['workqueues', 'queues'] });
  };

  const decideM = useMutation({
    mutationFn: (v: { id: string; decision: 'keep' | 'remove' | 'request_edit' | 'publish' | 'reject_response'; reasonCode: string; messageToReporter?: string | null; messageToAuthor?: string | null; editRequest?: string | null }) =>
      call(api.POST('/api/admin/reviews/moderation-items/{id}/decide', { params: { path: { id: v.id } }, body: { decision: v.decision, reasonCode: v.reasonCode as ReasonCode, messageToReporter: v.messageToReporter ?? null, messageToAuthor: v.messageToAuthor ?? null, editRequest: v.editRequest ?? null } })),
  });

  const submitDecision = () => {
    if (!active) return;
    setAttempted(true);
    if (Object.keys(decisionErrors(decision, reason, msg)).length) return;
    const cap = noun[0].toUpperCase() + noun.slice(1);
    const id = active.id;
    decideM.mutate(
      { id, decision: DECISION_API[decision], reasonCode: reason, messageToReporter: decision === 'edit' ? null : msg.trim() || null, messageToAuthor: decision === 'edit' ? msg.trim() : null, editRequest: decision === 'edit' ? msg.trim() : null },
      {
        onSuccess: () => {
          setNotice({
            title: decision === 'keep' ? `${cap} kept` : decision === 'remove' ? `${cap} removed for ${reasonLabel(reason, reasons).toLowerCase()}` : `Edit requested from ${active.author.displayName}`,
            body: `${active.reportersLabel} and ${active.author.displayName} can see the outcome. Recorded in Action history.`,
          });
          goNext(id);
          refresh();
        },
        onError: (e) => setActionError(errorMessage(e)),
      },
    );
  };

  /* ----- Appeals: an author asks to change a moderation decision ----- */
  const appealsQ = useQuery({
    queryKey: ['reviews', 'appeals', 'submitted'],
    queryFn: () => call(api.GET('/api/admin/reviews/appeals', { params: { query: { status: 'submitted', limit: 100 } } })),
  });
  const appeals: AppealRow[] = appealsQ.data?.items ?? [];
  const [appealId, setAppealId] = useState('');
  const activeAppeal = appeals.find((a) => a.id === appealId) ?? appeals[0];
  const [overturn, setOverturn] = useState(false);
  const [appealReason, setAppealReason] = useState('');
  const [appealTried, setAppealTried] = useState(false);
  useEffect(() => {
    setOverturn(false);
    setAppealReason('');
    setAppealTried(false);
  }, [activeAppeal?.id]);
  // The original moderator can't decide the appeal (backend SAME_MODERATOR).
  const ownAppealDecision = !!activeAppeal && activeAppeal.originalModerator.kind === 'staff' && activeAppeal.originalModerator.id === accountId;
  const appealM = useMutation({
    mutationFn: (v: { id: string; overturn: boolean; reason: string }) => call(api.POST('/api/admin/reviews/appeals/{id}/decide', { params: { path: { id: v.id } }, body: { overturn: v.overturn, reason: v.reason } })),
    onSuccess: (_r, v) => {
      const a = appeals.find((x) => x.id === v.id);
      const n = a ? (NOUN[a.contentType as ContentType] ?? 'content') : 'content';
      setNotice({
        title: v.overturn ? `Appeal upheld: the ${n} is restored` : 'Appeal reviewed: the decision stands',
        body: `${a?.author.displayName ?? 'The author'} is told the outcome. Recorded in Action history.`,
      });
      const rest = appeals.filter((x) => x.id !== v.id);
      setAppealId(rest[0]?.id ?? '');
      refresh();
    },
    onError: (e) => setActionError(errorMessage(e)),
  });
  const submitAppeal = () => {
    if (!activeAppeal) return;
    setAppealTried(true);
    if (!appealReason.trim()) return;
    setActionError('');
    appealM.mutate({ id: activeAppeal.id, overturn, reason: appealReason.trim() });
  };

  /* ----- Decided ----- */
  const decidedQ = useQuery({ queryKey: ['reviews', 'moderation', 'decided'], enabled: sub === 'decided', queryFn: () => call(api.GET('/api/admin/reviews/moderation-items', { params: { query: { status: 'decided', limit: 50 } } })) });

  /* ----- Q&A answers and seller responses ----- */
  const qaRows = all.filter(isQa);
  const srRows = all.filter(isResponse);
  const [dlg, setDlg] = useState<RowDialog | null>(null);
  const [dlgReason, setDlgReason] = useState('');
  const [dlgText, setDlgText] = useState('');
  const [dlgTried, setDlgTried] = useState(false);
  const [dlgError, setDlgError] = useState('');

  const rowM = useMutation({
    mutationFn: async ({ item, action, reasonCode, text }: { item: ModerationItem; action: RowAction; reasonCode: string; text: string }) => {
      if (action === 'trust') return call(api.POST('/api/admin/reviews/moderation-items/{id}/refer', { params: { path: { id: item.id } }, body: { note: text || reasonLabel(reasonCode, reasons) } }));
      if (action === 'staff') {
        const d = await call(api.GET('/api/admin/reviews/moderation-items/{id}', { params: { path: { id: item.id } } }));
        const questionId = d.question?.id ?? d.answer?.questionId;
        if (!questionId) throw new Error('This item is not linked to a question.');
        return call(api.POST('/api/admin/reviews/questions/{id}/answers', { params: { path: { id: questionId } }, body: { text, secondCheck: true } }));
      }
      const dec = action === 'keep' ? 'keep' : action === 'publish' ? 'publish' : action === 'reject' ? 'reject_response' : action === 'edit' ? 'request_edit' : 'remove';
      return decideM.mutateAsync({ id: item.id, decision: dec, reasonCode: reasonCode || LEGIT, messageToAuthor: text || null, editRequest: action === 'edit' ? text : null });
    },
    onSuccess: (_r, { action, item }) => {
      const name = item.contentType === 'seller_response' ? item.author.displayName : item.title;
      setNotice({ title: ROW_NOTICE[action](name), body: action === 'trust' ? 'Trust and Risk has the case. The response stays hidden.' : 'The author is notified. Recorded in Action history.' });
      setDlg(null);
      refresh();
    },
    onError: (e) => (dlg ? setDlgError(errorMessage(e)) : setActionError(errorMessage(e))),
  });

  const rowClick = (item: ModerationItem, action: RowAction, name: string) => {
    setActionError('');
    if (!NEEDS_DIALOG.includes(action)) return rowM.mutate({ item, action, reasonCode: LEGIT, text: '' });
    setDlg({ item, action, name });
    setDlgReason('');
    setDlgText('');
    setDlgTried(false);
    setDlgError('');
  };
  const rowDialogErrors = (d: RowDialog) => {
    const e: { reason?: string; text?: string } = {};
    if (d.action === 'staff') {
      if (!dlgText.trim()) e.text = 'Write the staff answer. It is labelled "Marketly staff" on the product page.';
    } else if (d.action === 'trust') {
      if (!dlgText.trim()) e.text = 'Tell Trust and Risk what you saw.';
    } else {
      if (!dlgReason) e.reason = 'Choose a reason. The author sees it and it is recorded in Action history.';
      if (d.action === 'edit' && !dlgText.trim()) e.text = 'Tell the author what to change.';
    }
    return e;
  };
  const dlgErrors = dlg && dlgTried ? rowDialogErrors(dlg) : {};
  const submitDlg = () => {
    if (!dlg) return;
    setDlgTried(true);
    if (Object.keys(rowDialogErrors(dlg)).length) return;
    rowM.mutate({ item: dlg.item, action: dlg.action, reasonCode: dlgReason, text: dlgText.trim() });
  };

  /* ----- Tabs ----- */
  const sellerRef = useRef<HTMLElement>(null);
  const isQaView = view === 'q-a-and-seller-responses';
  const tab: TabKey = isQaView ? (sub === 'seller' ? 'seller' : 'qa') : sub === 'decided' ? 'decided' : sub === 'appeals' ? 'appeals' : 'reported';
  useEffect(() => {
    if (tab === 'seller') sellerRef.current?.scrollIntoView({ behavior: 'smooth', block: 'start' });
  }, [tab]);
  const onTab = (t: TabKey) => {
    setNotice(null);
    setSub(t === 'seller' ? 'seller' : t === 'decided' ? 'decided' : t === 'appeals' ? 'appeals' : '');
    setView(t === 'qa' || t === 'seller' ? 'q-a-and-seller-responses' : '');
  };

  const renderActions = (row: ModerationItem, name: string, wrap: boolean) => {
    if (!canDecide) return <span className="xs muted">Needs the moderation permission</span>;
    const btns = rowActions(row)
      .filter((a) => a !== 'staff' || canStaffAnswer)
      .map((a) => (
        <Button key={a} variant={ACTIONS[a].variant} size="sm" onClick={() => rowClick(row, a, name)} disabled={rowM.isPending}>
          {ACTIONS[a].label}
          <span className="sr-only"> {name}</span>
        </Button>
      ));
    return wrap ? <span className="row nowrap gap-1">{btns}</span> : btns;
  };

  const policyAlert = (
    <Alert tone="warning" icon="scale" title="Don't remove legitimate negative reviews">
      Unfavorable is not a policy reason. Remove only for personal information, hate or harassment, spam or links, off-topic content, conflict of interest or proven fake reviews. Product reviews and seller feedback are judged separately.
    </Alert>
  );

  const submitLabel = decision === 'keep' ? `Keep ${noun} and notify` : decision === 'remove' ? `Remove ${noun} and notify` : 'Request edit and notify';
  const content = detail ? contentOf(detail) : null;
  const productLink = detail?.review ? href('store/product', '', { slug: 'product', id: detail.review.productId }) : detail?.question ? href('store/product', '', { slug: 'product', id: detail.question.productId }) : undefined;
  const firstReport = detail?.reports[0];
  const kv = detail
    ? [
        { k: 'Reporter', v: detail.reports.map((r) => `${r.reporter.name ?? r.reporterLabel} (${r.reporterLabel.toLowerCase()})`).join(', ') || active?.reportersLabel || '—' },
        { k: 'Report reason', v: firstReport ? `${reasonLabel(firstReport.reason, reasons)}${firstReport.note ? ` · "${firstReport.note}"` : ''}` : active?.reasons.map((r) => reasonLabel(r, reasons)).join(', ') ?? '—' },
        detail.purchase ? { k: 'Purchase', mono: detail.purchase.orderRef ?? undefined, v: detail.purchase.deliveredAt ? `delivered ${date(detail.purchase.deliveredAt)}` : detail.purchase.verified ? 'verified' : 'not delivered' } : { k: 'Purchase', v: 'No matching order' },
        { k: 'Other reports', v: detail.otherReportsOnAuthor ? `${detail.otherReportsOnAuthor} on this author's other content` : 'None' },
        { k: 'Helpful votes', v: String(detail.helpfulVotes) },
      ]
    : [];

  return (
    <AdminLayout active="reviews">
      <PageHeader
        crumbs={[{ label: 'Catalog' }, { label: 'Reviews and Q&A' }]}
        title="Reviews and Q&A"
        sub="Fake review patterns go to Trust and Risk"
        actions={
          <Button variant="secondary" size="sm" icon="book-open" to={href('admin/help-content')}>
            Moderation policy
          </Button>
        }
      />
      <Tabs<TabKey>
        items={[
          { value: 'reported', label: 'Reported content', count: openQ.data ? pending.length : undefined },
          { value: 'appeals', label: 'Appeals', count: appealsQ.data ? appeals.length : undefined },
          { value: 'qa', label: 'Q&A answers', count: openQ.data ? qaRows.length : undefined },
          { value: 'seller', label: 'Seller responses', count: openQ.data ? srRows.length : undefined },
          { value: 'decided', label: 'Decided' },
        ]}
        active={tab}
        onChange={onTab}
      />

      {notice && (
        <Alert tone="success" title={notice.title}>
          {notice.body}
        </Alert>
      )}
      {actionError && <Alert tone="danger" title={actionError} />}
      {openQ.isError && <LoadError error={openQ.error} onRetry={() => void openQ.refetch()} />}

      {tab === 'reported' && (
        <div className="aa-rv">
          <section className="card">
            <div className="card-head">
              <span className="h4">Reported</span>
              <select className="select" id="aa-rv-kind" aria-label="Content type" value={kind} onChange={(e) => setKind(e.target.value as '' | ContentType)}>
                {KIND_FILTERS.map((k) => (
                  <option key={k.label} value={k.value}>
                    {k.label}
                  </option>
                ))}
              </select>
            </div>
            {openQ.isPending ? (
              <div className="card-body">
                <SkeletonLines rows={4} />
              </div>
            ) : queue.length ? (
              <nav className="aa-q" aria-label="Reported items">
                {queue.map((r) => (
                  <a
                    key={r.id}
                    href="#"
                    className={cx(r.id === active?.id && 'is-active')}
                    aria-current={r.id === active?.id ? 'true' : undefined}
                    onClick={(e) => {
                      e.preventDefault();
                      select(r);
                    }}
                  >
                    <span className="row between">
                      <span className="xs strong muted">{KIND_LABEL[r.contentType]}</span>
                      <span className="xs muted">{r.age}</span>
                    </span>
                    <span className="small strong">{r.title}</span>
                    <span className="row gap-2">
                      {r.rating != null && <StarsBar rating={r.rating} cls="xs" />}
                      {r.reasons.slice(0, 2).map((code) => (
                        <Badge key={code} tone={reasonTone(code)}>
                          {reasonLabel(code, reasons)}
                        </Badge>
                      ))}
                    </span>
                    <span className="xs muted">{r.queue === 'auto_held' ? 'Held by an automatic check' : `Reported by ${r.reportersLabel}`}</span>
                  </a>
                ))}
              </nav>
            ) : (
              <div className="card-body">
                <EmptyState icon="circle-check" title={pending.length ? 'Nothing of this type' : 'Queue clear'}>
                  {pending.length ? 'Choose All types to see the other reported items.' : 'Every reported item has a decision. New reports appear here.'}
                </EmptyState>
              </div>
            )}
          </section>

          <div className="stack gap-5">
            {policyAlert}
            {active && detailQ.isPending && (
              <section className="card">
                <div className="card-body">
                  <SkeletonLines rows={5} />
                </div>
              </section>
            )}
            {active && detailQ.isError && <LoadError error={detailQ.error} onRetry={() => void detailQ.refetch()} />}
            {active && detail && content && (
              <>
                <section className="card">
                  <div className="card-head">
                    <div className="row nowrap gap-3">
                      <Img icon={active.contentType === 'seller_feedback' ? 'store' : 'package'} src={active.subjectImage?.url ?? undefined} className="tiny" />
                      <div className="stack gap-0">
                        <span className="eyebrow">{KIND_LABEL[active.contentType]}</span>
                        {productLink ? (
                          <Link className="small strong" to={productLink}>
                            {active.title}
                          </Link>
                        ) : (
                          <span className="small strong">{active.title}</span>
                        )}
                      </div>
                    </div>
                    {active.reasons[0] && <Badge tone={reasonTone(active.reasons[0])}>Reported · {reasonLabel(active.reasons[0], reasons)}</Badge>}
                  </div>
                  <div className="card-body">
                    <div className="row gap-2">
                      {active.rating != null && <StarsBar rating={active.rating} cls="u-fs-16" />}
                      {content.headline && <span className="strong">{content.headline}</span>}
                    </div>
                    <span className="row gap-2 xs muted">
                      By {active.author.displayName}
                      {content.at && ` · ${date(content.at)}`}
                      {active.author.verifiedPurchase && (
                        <>
                          {' · '}
                          <Badge tone="success" icon="badge-check">
                            Verified Purchase
                          </Badge>
                        </>
                      )}
                      {detail.purchase?.soldBy && ` · sold by ${detail.purchase.soldBy}`}
                      {detail.purchase?.condition && ` · ${detail.purchase.condition}`}
                    </span>
                    <p className="small">{content.body}</p>
                    {content.media.length > 0 && (
                      <div className="row gap-2">
                        {content.media.map((m, i) => (
                          <Img key={m.id ?? i} icon="image" src={m.url ?? undefined} alt={m.alt ?? ''} className="thumb" />
                        ))}
                      </div>
                    )}
                    {content.response && (
                      <div className="panel stack gap-1">
                        <span className="xs strong muted">
                          {content.response.fromKind === 'official_store' ? 'Official Store' : 'Seller'} response{content.response.publishedAt ? ` · published ${date(content.response.publishedAt)}` : ` · ${content.response.status}`}
                        </span>
                        <span className="small">"{content.response.text}"</span>
                      </div>
                    )}
                    <dl className="kv">
                      {kv.map((p) => (
                        <KvRow key={p.k} k={p.k} v={p.v} mono={'mono' in p ? p.mono : undefined} />
                      ))}
                    </dl>
                    {(detail.separationNote || detail.previousDecision) && (
                      <div className="aa-note">
                        <span className="xs strong">{detail.separationNote ? 'Note on separation' : 'Previous decision'}</span>
                        <span>{detail.separationNote ?? `${detail.previousDecision!.decision.replace(/_/g, ' ')}: ${detail.previousDecision!.reasonText}`}</span>
                      </div>
                    )}
                  </div>
                </section>

                {canDecide ? (
                  <section className="card">
                    <div className="card-head">
                      <div className="stack gap-0">
                        <h2 className="h4">Decision</h2>
                        <span className="xs muted">The reviewer and the reporter both see the outcome</span>
                      </div>
                    </div>
                    <div className="card-body">
                      <div className="grid md3 gap-2">
                        {DECISIONS.map((d, i) => (
                          <OptionCard
                            key={d.value}
                            id={`aa-rv-d${i + 1}`}
                            name="aa-rv-d"
                            title={<span className="small strong">{d.title}</span>}
                            body={d.body}
                            checked={decision === d.value}
                            onChange={() => changeDecision(d.value)}
                          />
                        ))}
                      </div>
                      <Field label="Reason" hint={'Required. "Harms sales" is not a removal reason.'} error={errors.reason}>
                        <select className={cx('select', errors.reason && 'is-error')} id="aa-rv-reason" value={reason} onChange={(e) => setReason(e.target.value)}>
                          {decision !== 'keep' && <option value="">Pick the rule it breaks</option>}
                          {(reasons.length ? reasons : [{ code: LEGIT, label: 'Legitimate experience, no policy breach', removes: false }]).map((r) => (
                            <option key={r.code} value={r.code}>
                              {reasonLabel(r.code, reasons)}
                            </option>
                          ))}
                        </select>
                      </Field>
                      <Field label={decision === 'edit' ? 'Message to reviewer' : 'Message to reporter'} optional={decision !== 'edit'} error={errors.msg}>
                        <Textarea id="aa-rv-msg" placeholder="" value={msg} className={cx(errors.msg && 'is-error')} onChange={(e) => setMsg(e.target.value)} />
                      </Field>
                    </div>
                    <div className="card-foot">
                      <Button variant="ghost" onClick={() => goNext(active.id)}>
                        Skip
                      </Button>
                      <Button variant={decision === 'remove' ? 'danger' : 'primary'} icon={decision === 'keep' ? 'check' : decision === 'remove' ? 'trash-2' : 'pencil'} onClick={submitDecision} disabled={decideM.isPending}>
                        {submitLabel}
                      </Button>
                    </div>
                  </section>
                ) : (
                  <Alert tone="info" title="View only">
                    Deciding reported content needs the moderation permission.
                  </Alert>
                )}
              </>
            )}
          </div>
        </div>
      )}

      {tab === 'appeals' && (
        <div className="aa-rv">
          <section className="card">
            <div className="card-head">
              <span className="h4">Appeals</span>
            </div>
            {appealsQ.isError ? (
              <div className="card-body">
                <LoadError error={appealsQ.error} onRetry={() => void appealsQ.refetch()} />
              </div>
            ) : appealsQ.isPending ? (
              <div className="card-body">
                <SkeletonLines rows={4} />
              </div>
            ) : appeals.length ? (
              <nav className="aa-q" aria-label="Appeals">
                {appeals.map((a) => (
                  <a
                    key={a.id}
                    href="#"
                    className={cx(a.id === activeAppeal?.id && 'is-active')}
                    aria-current={a.id === activeAppeal?.id ? 'true' : undefined}
                    onClick={(e) => {
                      e.preventDefault();
                      setAppealId(a.id);
                    }}
                  >
                    <span className="row between">
                      <span className="xs strong muted">{KIND_LABEL[a.contentType as ContentType] ?? a.contentType}</span>
                      <span className="xs muted">{date(a.submittedAt)}</span>
                    </span>
                    <span className="small strong">{a.author.displayName}</span>
                    <span className="row gap-2">
                      <Badge tone="warning">{OUTCOME_LABEL[a.originalDecision.decision] ?? a.originalDecision.decision}</Badge>
                    </span>
                    <span className="xs muted">"{a.excerpt}"</span>
                  </a>
                ))}
              </nav>
            ) : (
              <div className="card-body">
                <EmptyState icon="circle-check" title="No appeals waiting">
                  When an author appeals a moderation decision, it appears here.
                </EmptyState>
              </div>
            )}
          </section>

          {activeAppeal && (
            <div className="stack gap-5">
              <section className="card">
                <div className="card-head">
                  <div className="stack gap-0">
                    <span className="eyebrow">{KIND_LABEL[activeAppeal.contentType as ContentType] ?? activeAppeal.contentType}</span>
                    <span className="small strong">By {activeAppeal.author.displayName}</span>
                  </div>
                  <Badge tone="warning">Appealed {date(activeAppeal.submittedAt)}</Badge>
                </div>
                <div className="card-body">
                  <p className="small">"{activeAppeal.excerpt}"</p>
                  <dl className="kv">
                    <KvRow k="Original decision" v={`${OUTCOME_LABEL[activeAppeal.originalDecision.decision] ?? activeAppeal.originalDecision.decision}: ${activeAppeal.originalDecision.reasonText}`} />
                    <KvRow
                      k="Decided by"
                      v={`${activeAppeal.originalModerator.name ?? (activeAppeal.originalModerator.kind === 'system' ? 'Automatic check' : 'Marketly staff')}${activeAppeal.originalDecision.decidedAt ? ` · ${dateTime(activeAppeal.originalDecision.decidedAt)}` : ''}`}
                    />
                  </dl>
                  <div className="aa-note">
                    <span className="xs strong">Why the author appeals</span>
                    <span>{activeAppeal.reason}</span>
                  </div>
                </div>
              </section>

              {!canDecideAppeal ? (
                <Alert tone="info" title="View only">
                  Deciding appeals needs the appeal permission.
                </Alert>
              ) : ownAppealDecision ? (
                <Alert tone="info" title="Another moderator decides this appeal">
                  You made the original decision, so a different moderator reviews the appeal.
                </Alert>
              ) : (
                <section className="card">
                  <div className="card-head">
                    <div className="stack gap-0">
                      <h2 className="h4">Appeal decision</h2>
                      <span className="xs muted">The author sees the outcome and your reason</span>
                    </div>
                  </div>
                  <div className="card-body">
                    <div className="grid md2 gap-2">
                      <OptionCard id="aa-rv-ap1" name="aa-rv-ap" title={<span className="small strong">Decision stands</span>} body="The original decision was right" checked={!overturn} onChange={() => setOverturn(false)} />
                      <OptionCard id="aa-rv-ap2" name="aa-rv-ap" title={<span className="small strong">Overturn</span>} body="Restore the content and publish it again" checked={overturn} onChange={() => setOverturn(true)} />
                    </div>
                    <Field label="Reason for the author" error={appealTried && !appealReason.trim() ? 'Explain the outcome to the author.' : undefined}>
                      <Textarea id="aa-rv-ap-why" value={appealReason} className={cx(appealTried && !appealReason.trim() && 'is-error')} onChange={(e) => setAppealReason(e.target.value)} />
                    </Field>
                  </div>
                  <div className="card-foot">
                    <Button variant="primary" icon={overturn ? 'undo-2' : 'check'} onClick={submitAppeal} disabled={appealM.isPending}>
                      {overturn ? 'Overturn and restore' : 'Keep the decision'}
                    </Button>
                  </div>
                </section>
              )}
            </div>
          )}
        </div>
      )}

      {tab === 'decided' && (
        <section className="card">
          <div className="card-head">
            <div className="stack gap-0">
              <h2 className="h4">Decided</h2>
              <span className="xs muted">The reviewer and the reporter were told each outcome</span>
            </div>
          </div>
          {decidedQ.isError ? (
            <div className="card-body">
              <LoadError error={decidedQ.error} onRetry={() => void decidedQ.refetch()} />
            </div>
          ) : (
            <TableWrap label="Decided content table">
              <table className="table">
                <thead>
                  <tr>
                    <th scope="col">Content</th>
                    <th scope="col">Decision</th>
                    <th scope="col">Reason</th>
                    <th scope="col">Decided by</th>
                  </tr>
                </thead>
                <tbody>
                  {decidedQ.isPending && (
                    <tr>
                      <td colSpan={4}>
                        <SkeletonLines rows={3} />
                      </td>
                    </tr>
                  )}
                  {(decidedQ.data?.items ?? []).map((d) => {
                    // The recorded decision (outcome, reason, moderator); older items fall back to visibility and reports.
                    const dec = d.decision;
                    const removed = dec ? dec.outcome === 'remove' || dec.outcome === 'reject_response' : d.visibility === 'hidden';
                    const who = dec ? (dec.by.name ?? (dec.by.kind === 'system' ? 'Trust and Risk enforcement' : 'Marketly staff')) : null;
                    return (
                      <tr key={d.id}>
                        <td>
                          <span className="stack gap-0">
                            <span className="small strong">{d.title}</span>
                            <span className="xs muted">{KIND_LABEL[d.contentType]}</span>
                          </span>
                        </td>
                        <td>
                          <StatusBadge status={dec?.outcomeLabel ?? (removed ? 'Removed' : 'Kept')} tone={removed ? 'danger' : dec?.outcome === 'request_edit' ? 'warning' : 'success'} />
                        </td>
                        <td>
                          <span className="small">{dec ? dec.reason : d.reasons.map((r) => reasonLabel(r, reasons)).join(', ')}</span>
                        </td>
                        <td>
                          {dec ? (
                            <span className="stack gap-0">
                              <span className="small">{who}</span>
                              <span className="xs muted">{dateTime(dec.at)}</span>
                            </span>
                          ) : (
                            <span className="small">Reported {dateTime(d.firstReportedAt)}</span>
                          )}
                        </td>
                      </tr>
                    );
                  })}
                  {decidedQ.isSuccess && decidedQ.data.items.length === 0 && (
                    <tr>
                      <td colSpan={4}>
                        <EmptyState icon="inbox" title="No decisions yet">
                          Decided reports appear here.
                        </EmptyState>
                      </td>
                    </tr>
                  )}
                </tbody>
              </table>
            </TableWrap>
          )}
        </section>
      )}

      {isQaView && (
        <>
          {policyAlert}
          <section className="card">
            <div className="card-head">
              <div className="stack gap-0">
                <h2 className="h4">Q&amp;A answers needing review</h2>
                <span className="xs muted">Answers are labelled by who wrote them: seller, Marketly staff or customer</span>
              </div>
            </div>
            <TableWrap label="Q&A answers needing review table">
              <table className="table">
                <thead>
                  <tr>
                    <th scope="col">Product and question</th>
                    <th scope="col">Answer</th>
                    <th scope="col">Answered by</th>
                    <th scope="col">Why held</th>
                    <th scope="col">
                      <span className="sr-only">Actions</span>
                    </th>
                  </tr>
                </thead>
                <tbody>
                  {openQ.isPending && (
                    <tr>
                      <td colSpan={5}>
                        <SkeletonLines rows={3} />
                      </td>
                    </tr>
                  )}
                  {qaRows.map((r) => {
                    const edge = rowEdge(r);
                    const by = AUTHOR_BADGE(r);
                    return (
                      <tr key={r.id} className={EDGE_CLASS[edge]}>
                        <td>
                          {edge && <span className="sr-only">{EDGE_SR[edge]}</span>}
                          <span className="stack gap-0">
                            <span className="small strong">{r.title}</span>
                            {r.contextText && <span className="xs sub">"{r.contextText}"</span>}
                          </span>
                        </td>
                        <td>
                          <span className="small">"{r.excerpt}"</span>
                        </td>
                        <td>
                          <Badge tone={by.tone}>{by.label}</Badge>
                        </td>
                        <td>
                          <span className="small">{r.ruleCheck && !r.ruleCheck.passed ? r.ruleCheck.failures.join('; ') : r.author.kind === 'staff' ? 'New staff answer, second check' : r.reasons.map((x) => reasonLabel(x, reasons)).join(', ') || 'Held for review'}</span>
                        </td>
                        <td>{renderActions(r, r.title, true)}</td>
                      </tr>
                    );
                  })}
                  {openQ.isSuccess && qaRows.length === 0 && (
                    <tr>
                      <td colSpan={5}>
                        <EmptyState icon="circle-check" title="No answers waiting">
                          Held answers and new staff answers appear here.
                        </EmptyState>
                      </td>
                    </tr>
                  )}
                </tbody>
              </table>
            </TableWrap>
            {qaRows.some((r) => rowEdge(r)) && <EdgeLegend />}
          </section>
          <section className="card" ref={sellerRef}>
            <div className="card-head">
              <div className="stack gap-0">
                <h3 className="h4">Seller responses waiting</h3>
                <span className="xs muted">Sellers can respond publicly once per review · held when a rule check fails</span>
              </div>
            </div>
            <TableWrap label="Seller responses waiting table">
              <table className="table">
                <thead>
                  <tr>
                    <th scope="col">Review</th>
                    <th scope="col">Seller response</th>
                    <th scope="col">Rule check</th>
                    <th scope="col">
                      <span className="sr-only">Actions</span>
                    </th>
                  </tr>
                </thead>
                <tbody>
                  {srRows.map((r) => {
                    const edge = rowEdge(r);
                    const passed = !r.ruleCheck || r.ruleCheck.passed;
                    return (
                      <tr key={r.id} className={EDGE_CLASS[edge]}>
                        <td>
                          {edge && <span className="sr-only">{EDGE_SR[edge]}</span>}
                          <span className="stack gap-1">
                            {r.respondingTo?.rating != null && <StarsBar rating={r.respondingTo.rating} cls="sm" />}
                            <span className="small">"{r.respondingTo?.excerpt ?? r.contextText ?? ''}"</span>
                            <span className="xs muted">
                              {r.respondingTo ? `${KIND_LABEL[r.respondingTo.contentType]} · ${r.respondingTo.title}` : r.title}
                            </span>
                          </span>
                        </td>
                        <td>
                          <span className="stack gap-0">
                            <span className="xs strong muted">{r.author.displayName}</span>
                            <span className="small">"{r.excerpt}"</span>
                          </span>
                        </td>
                        <td>
                          <Badge tone={passed ? 'success' : 'danger'}>{passed ? 'Passed' : r.ruleCheck!.failures.join('; ') || 'Failed'}</Badge>
                        </td>
                        <td>{renderActions(r, r.author.displayName, rowActions(r).length > 1)}</td>
                      </tr>
                    );
                  })}
                  {openQ.isSuccess && srRows.length === 0 && (
                    <tr>
                      <td colSpan={4}>
                        <EmptyState icon="circle-check" title="No seller responses waiting">
                          Responses held by the rule check appear here.
                        </EmptyState>
                      </td>
                    </tr>
                  )}
                </tbody>
              </table>
            </TableWrap>
            {srRows.some((r) => rowEdge(r)) && <EdgeLegend warn={false} />}
          </section>
        </>
      )}

      <Dialog
        open={!!dlg}
        onClose={() => setDlg(null)}
        title={dlg ? `${ACTIONS[dlg.action].label} · ${dlg.name}` : ''}
        foot={
          dlg && (
            <>
              <Button variant="ghost" onClick={() => setDlg(null)}>
                Cancel
              </Button>
              <Button variant={dlg.action === 'remove' || dlg.action === 'reject' ? 'danger' : 'primary'} icon={dlg.action === 'staff' ? 'send' : 'check'} onClick={submitDlg} disabled={rowM.isPending}>
                {dlg.action === 'staff' ? 'Send for second check' : dlg.action === 'trust' ? 'Send to Trust and Risk' : `${ACTIONS[dlg.action].label} and notify`}
              </Button>
            </>
          )
        }
      >
        {dlgError && <Alert tone="danger" title={dlgError} />}
        {dlg && dlg.action !== 'staff' && dlg.action !== 'trust' && (
          <Field label="Reason" hint="Required. Shown to the author." error={dlgErrors.reason}>
            <Select
              id="aa-rv-row-reason"
              className={cx(dlgErrors.reason && 'is-error')}
              options={[{ value: '', label: 'Choose a reason' }, ...reasons.filter((r) => r.code !== LEGIT).map((r) => ({ value: r.code, label: reasonLabel(r.code, reasons) }))]}
              value={dlgReason}
              onChange={(e) => setDlgReason(e.target.value)}
            />
          </Field>
        )}
        {dlg && (
          <Field
            label={dlg.action === 'staff' ? 'Staff answer' : dlg.action === 'trust' ? 'Note to Trust and Risk' : 'Message to author'}
            optional={dlg.action !== 'staff' && dlg.action !== 'edit' && dlg.action !== 'trust'}
            hint={dlg.action === 'staff' ? 'Labelled "Marketly staff". A second moderator checks it before it is published.' : undefined}
            error={dlgErrors.text}
          >
            <Textarea id="aa-rv-row-text" className={cx(dlgErrors.text && 'is-error')} value={dlgText} onChange={(e) => setDlgText(e.target.value)} />
          </Field>
        )}
      </Dialog>
    </AdminLayout>
  );
}
