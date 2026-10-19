import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useEffect, useMemo, useState } from 'react';
import { Link, useSearchParams } from 'react-router';
import { call, errorMessage, useApi } from '@marketly/web-shared/api';
import reviewQuery from '@marketly/web-shared/api/graphql/admin/AdminProductReview.graphql?raw';
import { AdminLayout } from '@marketly/web-shared/layouts';
import { cx } from '@marketly/web-shared/lib/cx';
import { num } from '@marketly/web-shared/lib/format';
import { useView } from '@marketly/web-shared/lib/hooks';
import { href } from '@marketly/web-shared/routes';
import {
  Alert, Badge, Button, Checkbox, Card, Deadline, Dialog, EmptyState, Field, Icon, IconButton, Img, KeyValue, LogoTile, OptionCard, PageHeader,
  SegmentedControl, Select, StatusBadge, TableWrap, Textarea, TextInput,
} from '@marketly/web-shared/ui';
import { useStaffSession } from '@/app/session';
import { dateTime, deadlineLabel, deadlineTone, LoadError, shortDate, SkeletonLines } from '@/app/parts';
import { flattenCategories, type CategoryNode } from './data/catalog';
import {
  checkView, COMMENT_FIELDS, DECISION_API, DECISION_FROM_API, initials, LOG_LABEL, REASONS, REVIEW_STATE_LABEL,
  type Decision, type QueueItem, type ReviewCheck, type ReviewProduct, type ReviewScreen, type SubmissionKind,
} from './data/product-review';

// Design: pages/admin/admin-product-review.html · view "merge-duplicate" = the merge dialog open.
// API: queue GET /api/admin/catalog/review-queue; open submission = AdminProductReview (?id=<productId>);
// decisions POST /products/{id}/approve|request-changes|reject; draft PUT /products/{id}/review-draft;
// duplicates POST /products/{id}/checks/duplicate/dismiss, POST /products/merge/preview and /products/merge;
// a dismissed check opens again with POST /products/{id}/checks/{kind}/restore ("Undo not a duplicate").

type Notice = { tone: 'success' | 'info' | 'danger'; title: string; body: string };
type FieldComment = { field: string; comment: string };
type HistoryEvent = { t: string; d: string; state: 'current' | 'warn' | 'done' };

const SEGMENTS: Array<{ value: SubmissionKind; label: string }> = [
  { value: 'new', label: 'New products' },
  { value: 'content_change', label: 'Shared content changes' },
  { value: 'resubmitted', label: 'Resubmitted' },
];

const DECISIONS: Array<{ value: Decision; title: string; body: string }> = [
  { value: 'approve', title: 'Approve', body: 'Publish as a new product' },
  { value: 'changes', title: 'Request changes', body: 'Seller fixes and resubmits' },
  { value: 'reject', title: 'Reject', body: 'Outside allowed assortment or unsafe' },
];

const plural = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;
const lc = (s?: string | null) => (s ?? '').toLowerCase();
const waitingFor = (iso: string) => {
  const h = Math.max(0, Math.round((Date.now() - new Date(iso).getTime()) / 3_600_000));
  return h < 24 ? `Waiting ${h} h` : `Waiting ${Math.floor(h / 24)} d${h % 24 ? ` ${h % 24} h` : ''}`;
};
const optionsText = (opts: Array<{ name: string; value: string }> = []) => opts.map((o) => `${o.name} ${o.value}`).join(', ');

function Differs() {
  return <span className="xs t-warning-text strong">Differs</span>;
}

function CheckBody({ body }: { body: string | string[] }) {
  return Array.isArray(body) ? (
    <ul className="ul small sub">
      {body.map((b) => (
        <li key={b}>{b}</li>
      ))}
    </ul>
  ) : (
    <p className="small sub">{body}</p>
  );
}

export default function ProductReview() {
  const { api, gql } = useApi();
  const qc = useQueryClient();
  const { can, name: me } = useStaffSession();
  const canReview = can('catalog.products.review');
  const [view, setView] = useView<'merge-duplicate'>();
  const [params, setParams] = useSearchParams();
  const [segment, setSegment] = useState<SubmissionKind>('new');
  const [cat, setCat] = useState('');
  const [notice, setNotice] = useState<Notice | null>(null);

  const cats = useQuery({ queryKey: ['catalog', 'categories', 'admin'], queryFn: () => call(api.GET('/api/admin/catalog/categories')), enabled: can('catalog.view') });
  const sellers = useQuery({ queryKey: ['sellers', 'options'], queryFn: () => call(api.GET('/api/admin/sellers/sellers', { params: { query: { limit: 100 } } })), enabled: can('sellers.accounts.view') });
  const sellerName = (id?: string | null) => (id ? sellers.data?.items.find((s) => s.id === id)?.storeName : undefined);

  const queueQ = useQuery({
    queryKey: ['catalog', 'review-queue', segment, cat],
    queryFn: () => call(api.GET('/api/admin/catalog/review-queue', { params: { query: { kind: segment, categoryId: cat || undefined, limit: 50 } } })),
    enabled: canReview,
  });
  const queue: QueueItem[] = queueQ.data?.items ?? [];
  const activeId = params.get('id') ?? queue[0]?.product.id ?? '';

  const detail = useQuery({
    queryKey: ['catalog', 'product-review', activeId],
    enabled: !!activeId,
    queryFn: async () => {
      const r = await gql<ReviewScreen>(reviewQuery, { productId: activeId, kind: segment.toUpperCase(), paging: { limit: 1 }, offerPaging: { limit: 5 } });
      if (!r.data?.productAdmin) throw new Error(r.errors?.[0]?.message ?? 'Product not found');
      return r.data;
    },
  });
  const sub: ReviewProduct | undefined = detail.data?.productAdmin ?? undefined;
  const subStatus = sub ? REVIEW_STATE_LABEL[lc(sub.reviewState)] ?? sub.reviewState : '';
  const open = lc(sub?.reviewState) === 'submitted';
  const seller = sub ? (lc(sub.owner?.type) === 'official' ? 'Marketly Official' : sub.ownerSeller?.storeName ?? sellerName(sub.owner?.sellerId) ?? 'Seller') : '';

  // Decision form for the open submission (starts from the saved draft).
  const [decision, setDecision] = useState<Decision>('changes');
  const [reason, setReason] = useState('');
  const [comments, setComments] = useState<FieldComment[]>([]);
  const [tried, setTried] = useState(false);
  const [adding, setAdding] = useState(false);
  const [newField, setNewField] = useState(COMMENT_FIELDS[0]);
  const [newComment, setNewComment] = useState('');
  const [commentTried, setCommentTried] = useState(false);
  const [actionError, setActionError] = useState('');
  useEffect(() => {
    if (!sub) return;
    const d = sub.reviewDraft;
    const failing = sub.checks.some((c) => lc(c.result) !== 'pass' && !c.dismissal);
    setDecision(d?.decision ? DECISION_FROM_API[lc(d.decision)] ?? 'changes' : failing ? 'changes' : 'approve');
    setReason(d?.reason ?? '');
    setComments((d?.fields ?? []).map((f) => ({ field: f.name, comment: f.value })));
    setTried(false);
    setAdding(false);
    setActionError('');
  }, [sub?.id, sub?.reviewDraft?.savedAt]);

  const select = (id: string) => {
    const next = new URLSearchParams(params);
    next.set('id', id);
    setParams(next);
    setNotice(null);
  };

  const checks = (sub?.checks ?? []).map((c) => ({ raw: c, ...checkView(c) }));
  const attention = checks.filter((c) => c.tone !== 'success').length;
  const blocking = checks.filter((c) => c.badge === 'Blocking');
  const dupCheck: ReviewCheck | undefined = sub?.checks.find((c) => lc(c.kind) === 'duplicate' && lc(c.result) !== 'pass' && !c.dismissal);
  const candidates = sub?.duplicateCandidates ?? [];
  const dup = dupCheck ? candidates[0] : undefined;
  const offer = detail.data?.offersAdmin?.items[0];

  const events: HistoryEvent[] = useMemo(() => {
    if (!sub) return [];
    const list: Array<HistoryEvent & { at: string }> = sub.reviewLog.map((e) => ({
      at: e.at,
      t: LOG_LABEL[e.action] ?? e.action,
      d: [dateTime(e.at), e.actor?.name ?? (lc(e.actor?.kind) === 'staff' ? 'Marketly staff' : lc(e.actor?.kind) === 'seller' ? seller : ''), e.reason].filter(Boolean).join(' · '),
      state: e.action === 'changes_requested' || e.action === 'rejected' ? 'warn' : 'done',
    }));
    const s = sub.submission;
    if (s?.lastSavedAt) list.push({ at: s.lastSavedAt, t: 'Draft saved', d: [dateTime(s.lastSavedAt), s.lastSavedBy?.name].filter(Boolean).join(' · '), state: 'done' });
    const ran = sub.checks[0]?.ranAt;
    if (ran) list.push({ at: ran, t: 'Automated checks finished', d: `${dateTime(ran)} · ${attention ? `${plural(attention, 'issue')}, ` : ''}${checks.length - attention} passed`, state: attention ? 'warn' : 'done' });
    list.sort((a, b) => b.at.localeCompare(a.at));
    const out: HistoryEvent[] = list.map(({ t, d, state }) => ({ t, d, state }));
    if (open) out.unshift(s?.assignee?.name ? { t: `Assigned to ${s.assignee.name}`, d: 'Waiting for a decision', state: 'current' } : { t: 'Waiting for a reviewer', d: 'Auto-assign by category', state: 'current' });
    else if (out[0]) out[0] = { ...out[0], state: 'current' };
    return out;
  }, [sub, seller, open]);

  const needsReason = decision !== 'approve';
  const reasonError = tried && needsReason && !reason ? `Choose a reason to ${decision === 'reject' ? 'reject this submission' : 'request changes'}. The seller sees it with your field comments.` : '';
  const blockError = tried && decision === 'approve' && blocking.length > 0 ? `Resolve ${plural(blocking.length, 'blocking check')} before approving: ${blocking.map((c) => c.title).join('; ')}.` : '';
  const fieldsMap = () => Object.fromEntries(comments.map((c) => [c.field, c.comment]));

  const refresh = () => {
    void qc.invalidateQueries({ queryKey: ['catalog'] });
    void qc.invalidateQueries({ queryKey: ['workqueues', 'queues'] });
  };

  const decide = useMutation({
    mutationFn: async () => {
      const id = sub!.id;
      if (decision === 'approve') return call(api.POST('/api/admin/catalog/products/{id}/approve', { params: { path: { id } }, body: {} }));
      if (decision === 'reject') return call(api.POST('/api/admin/catalog/products/{id}/reject', { params: { path: { id } }, body: { reason } }));
      return call(api.POST('/api/admin/catalog/products/{id}/request-changes', { params: { path: { id } }, body: { reason, fields: fieldsMap() } }));
    },
    onSuccess: () => {
      const n = comments.length;
      setNotice(
        decision === 'approve'
          ? { tone: 'success', title: `${sub!.title} is approved`, body: `It is now live${offer ? ` with ${seller}'s offer` : ''}. ${seller} has been notified.` }
          : decision === 'changes'
            ? { tone: 'success', title: `Change request sent to ${seller}`, body: `Reason: ${reason}${n ? ` · ${plural(n, 'field comment')}` : ''}. The submission comes back to the queue when the seller resubmits.` }
            : { tone: 'success', title: `${sub!.title} was rejected`, body: `Reason: ${reason}. ${seller} has been notified.` },
      );
      setTried(false);
      refresh();
    },
    onError: (e) => setActionError(errorMessage(e)),
  });
  const submit = () => {
    setTried(true);
    setActionError('');
    if ((needsReason && !reason) || (decision === 'approve' && blocking.length > 0)) return;
    decide.mutate();
  };

  const saveDraft = useMutation({
    mutationFn: () => call(api.PUT('/api/admin/catalog/products/{id}/review-draft', { params: { path: { id: sub!.id } }, body: { decision: DECISION_API[decision], reason: reason || null, fields: fieldsMap() } })),
    onSuccess: () => {
      setNotice({ tone: 'info', title: 'Draft saved', body: 'Your decision and field comments are saved. Only reviewers can see a draft.' });
      void qc.invalidateQueries({ queryKey: ['catalog', 'product-review', activeId] });
    },
    onError: (e) => setActionError(errorMessage(e)),
  });

  const dismissDup = useMutation({
    mutationFn: () =>
      call(api.POST('/api/admin/catalog/products/{id}/checks/{kind}/dismiss', { params: { path: { id: sub!.id, kind: 'duplicate' } }, body: { reason: 'Reviewed: a separate product, not a duplicate', matchedProductId: dup?.id ?? null } })),
    onSuccess: () => {
      setNotice({ tone: 'success', title: 'Marked not a duplicate', body: 'The duplicate check will not block approval.' });
      void qc.invalidateQueries({ queryKey: ['catalog', 'product-review', activeId] });
    },
    onError: (e) => setActionError(errorMessage(e)),
  });

  const restoreCheck = useMutation({
    mutationFn: (kind: string) => call(api.POST('/api/admin/catalog/products/{id}/checks/{kind}/restore', { params: { path: { id: sub!.id, kind: lc(kind) as 'duplicate' } }, body: {} })),
    onSuccess: (_r, kind) => {
      setNotice(
        lc(kind) === 'duplicate'
          ? { tone: 'info', title: 'Duplicate check open again', body: 'The product is back in Duplicates suspected until you merge it or mark it not a duplicate.' }
          : { tone: 'info', title: 'Check open again', body: 'The finding counts again before approval.' },
      );
      void qc.invalidateQueries({ queryKey: ['catalog', 'product-review', activeId] });
      void qc.invalidateQueries({ queryKey: ['catalog', 'products'] });
    },
    onError: (e) => setActionError(errorMessage(e)),
  });

  const nextInQueue = queue.find((s) => s.product.id !== sub?.id);

  const commentError = commentTried && !newComment.trim() ? 'Enter a comment for the seller.' : '';
  const addComment = () => {
    setCommentTried(true);
    if (!newComment.trim()) return;
    setComments((c) => [...c.filter((x) => x.field !== newField), { field: newField, comment: newComment.trim() }]);
    setNewComment('');
    setCommentTried(false);
    setAdding(false);
  };
  const removeComment = (field: string) => setComments((c) => c.filter((x) => x.field !== field));

  // Merge flow: keep one of the duplicate candidates; merge this submission (and the other candidates picked).
  const [keep, setKeep] = useState('');
  const [records, setRecords] = useState<string[]>([]);
  const [mergeReason, setMergeReason] = useState('');
  const [mergeTried, setMergeTried] = useState(false);
  const keepId = keep || candidates[0]?.id || '';
  const keepRef = candidates.find((c) => c.id === keepId)?.ref ?? 'the kept product';
  const mergeRecords = sub ? [{ id: sub.id, ref: sub.submission ? `Submission ${sub.submission.ref}` : sub.ref ?? sub.title, text: ` (${sub.title})` }, ...candidates.filter((c) => c.id !== keepId).map((c) => ({ id: c.id, ref: c.ref ?? c.title, text: ` (${c.title})` }))] : [];
  useEffect(() => {
    if (view === 'merge-duplicate' && sub) setRecords([sub.id]);
  }, [view, sub?.id, keepId]);
  const mergeBody = { keepProductId: keepId, merges: records.map((productId) => ({ productId })), reason: mergeReason.trim() || 'Duplicate of an existing product' };
  const preview = useQuery({
    queryKey: ['catalog', 'merge-preview', keepId, records],
    enabled: view === 'merge-duplicate' && !!keepId && records.length > 0 && canReview,
    queryFn: () => call(api.POST('/api/admin/catalog/products/merge/preview', { body: mergeBody })),
  });
  const p = preview.data;
  const effects = p
    ? [
        { what: 'Offers', how: `${plural(p.offersMoved, 'offer')} move to ${keepRef}. Paused offers stay paused.`, after: `${plural(p.offersAfter, 'offer')} · ${num(p.offersOnSaleAfter)} on sale` },
        { what: 'Reviews', how: `${plural(p.reviewsMoved, 'review')} move with their variation label, date and Verified Purchase status.`, after: `${plural(p.reviewsAfter, 'review')}${p.ratingAfter != null ? ` · ${p.ratingAfter.toFixed(1)}` : ''}` },
        { what: 'Past orders', how: p.pastOrders != null ? `${plural(p.pastOrders, 'order item')} keep their purchase snapshot.` : 'Orders keep their purchase snapshots.', after: 'No order changes' },
        ...(p.questionsMoved != null ? [{ what: 'Questions and answers', how: `${plural(p.questionsMoved, 'question')} move and show the variation they were asked about.`, after: `${plural(p.questionsAfter ?? 0, 'question')}` }] : []),
        { what: 'Links', how: `Old product URLs redirect to ${keepRef}.`, after: plural(p.redirects, 'redirect') },
      ]
    : [];
  const notified = p?.sellersNotified.map((s) => s.name).join(', ');

  const openMerge = () => {
    setKeep(candidates[0]?.id ?? '');
    setMergeReason('');
    setMergeTried(false);
    setActionError('');
    setView('merge-duplicate');
  };
  const closeMerge = () => setView('');
  const mergeReasonError = mergeTried && !mergeReason.trim() ? 'Enter a reason for the merge. The affected sellers see it.' : '';
  const recordsError = mergeTried && records.length === 0 ? 'Choose at least one record to merge.' : '';
  const merge = useMutation({
    mutationFn: () => call(api.POST('/api/admin/catalog/products/merge', { body: mergeBody })),
    onSuccess: (r) => {
      setNotice({ tone: 'success', title: `${plural(r.merged.length, 'record')} merged into ${keepRef}`, body: `${plural(r.movedOffers, 'offer')} and ${plural(r.movedReviews, 'review')} moved. ${notified ? `${notified} have been notified.` : ''}` });
      closeMerge();
      refresh();
      const next = new URLSearchParams(params);
      next.delete('view');
      next.set('id', r.keptProductId);
      setParams(next);
    },
    onError: (e) => setActionError(errorMessage(e)),
  });
  const doMerge = () => {
    setMergeTried(true);
    if (!mergeReason.trim() || records.length === 0) return;
    merge.mutate();
  };
  const toggleRecord = (id: string) => setRecords((r) => (r.includes(id) ? r.filter((x) => x !== id) : [...r, id]));

  const oldest = queue[0]?.submission?.submittedAt;
  const catOptions = flattenCategories((cats.data ?? []) as CategoryNode[]);
  const specs = sub?.specs ?? [];
  const gtins = (sub?.variants ?? []).map((v) => v.gtin).filter(Boolean);

  return (
    <AdminLayout active="review">
      <PageHeader
        crumbs={[{ label: 'Catalog' }, { label: 'Review queue' }]}
        title="Review queue"
        sub={queueQ.data ? `${num(queue.length)} waiting${oldest ? ` · oldest ${waitingFor(oldest).replace('Waiting ', '')}` : ''}` : canReview ? 'Loading…' : 'Product review'}
        actions={<SegmentedControl items={SEGMENTS} active={segment} onChange={setSegment} label="Submission type" />}
      />
      {!canReview && (
        <Alert tone="info" title="You can't review products">
          Reviewing submissions needs the Catalog review permission. Ask a Catalog Manager or request access in Staff and roles.
        </Alert>
      )}
      <div className="aa-rv">
        <section className="card">
          <div className="card-head">
            <span className="h4">Submissions</span>
            <span className="xs muted">Oldest first</span>
          </div>
          <div className="card-body u-pb-0">
            <div className="field aa-flt">
              <label className="label" htmlFor="aa-pr-cat">
                Category
              </label>
              <select className="select" id="aa-pr-cat" value={cat} onChange={(e) => setCat(e.target.value)}>
                <option value="">All categories</option>
                {catOptions.map((c) => (
                  <option key={c.id} value={c.id}>
                    {c.label}
                  </option>
                ))}
              </select>
            </div>
          </div>
          {queueQ.isPending && canReview && (
            <div className="card-body">
              <SkeletonLines rows={5} />
            </div>
          )}
          {queueQ.isError && (
            <div className="card-body">
              <LoadError error={queueQ.error} onRetry={() => void queueQ.refetch()} />
            </div>
          )}
          <nav className="aa-q u-mt-sp-3" aria-label="Submissions">
            {queue.map((s) => {
              const on = s.product.id === activeId;
              const dl = s.submission?.reviewDeadline;
              const flags = [
                ...(s.duplicateSuspected ? [{ tone: 'danger' as const, icon: 'circle-alert' as const, label: 'Possible duplicate' }] : []),
                ...(s.submission?.kind === 'resubmitted' ? [{ tone: 'info' as const, icon: 'info' as const, label: 'Resubmitted' }] : []),
                ...(s.checks.some((c) => c.kind === 'image_standard' && c.result !== 'pass') ? [{ tone: 'warning' as const, icon: 'triangle-alert' as const, label: 'Image issues' }] : []),
                ...(s.requestedBrand ? [{ tone: 'warning' as const, icon: 'triangle-alert' as const, label: 'New brand' }] : []),
              ];
              return (
                <Link
                  key={s.product.id}
                  to={href('admin/product-review', '', undefined, { id: s.product.id })}
                  className={cx(on && 'is-active')}
                  aria-current={on ? 'true' : undefined}
                  onClick={(e) => {
                    e.preventDefault();
                    select(s.product.id);
                  }}
                >
                  <span className="row nowrap top gap-3">
                    <Img icon="package" src={s.product.images?.[0]?.url} className="tiny" />
                    <span className="stack gap-0 grow">
                      <span className="small strong clamp-2">{s.product.title}</span>
                      <span className="xs muted">
                        {s.owner === 'official' ? 'Marketly Official' : sellerName(s.ownerSellerId) ?? 'Seller'} · {(s.product.categoryPath ?? []).join(' › ')}
                      </span>
                    </span>
                  </span>
                  <span className="row between">
                    {flags.length ? (
                      <span className="aa-flags">
                        {flags.map((f) => (
                          <Badge key={f.label} tone={f.tone} icon={f.icon}>
                            {f.label}
                          </Badge>
                        ))}
                      </span>
                    ) : (
                      <span />
                    )}
                    {s.submission && <Deadline tone={deadlineTone(dl?.state)}>{waitingFor(s.submission.submittedAt)}</Deadline>}
                  </span>
                </Link>
              );
            })}
          </nav>
          {queueQ.isSuccess && queue.length === 0 && (
            <div className="card-body">
              <EmptyState icon="inbox" title="Nothing waiting here">
                No submissions match this type and category.
              </EmptyState>
            </div>
          )}
          <div className="card-foot u-justify-center">
            <Link className="small strong" to={href('admin/catalog')}>
              All products
            </Link>
          </div>
        </section>

        <div className="stack gap-5">
          {notice && (
            <Alert tone={notice.tone} title={notice.title}>
              {notice.body}
            </Alert>
          )}
          {actionError && <Alert tone="danger" title={actionError} />}
          {!activeId && !queueQ.isPending && (
            <Card title="No submission open" titleAs="h3">
              <p className="small sub">Pick a submission from the queue. New submissions appear here when sellers or the Official Store submit products.</p>
            </Card>
          )}
          {activeId && detail.isPending && (
            <section className="card">
              <div className="card-body">
                <SkeletonLines rows={6} />
              </div>
            </section>
          )}
          {detail.isError && <LoadError error={detail.error} onRetry={() => void detail.refetch()} />}
          {sub && (
            <>
              <section className="card">
                <div className="card-head">
                  <div className="row nowrap top gap-3">
                    <Img icon="package" src={sub.images[0]?.url} className="thumb" />
                    <div className="stack gap-1">
                      <span className="eyebrow">
                        {lc(sub.submission?.kind) === 'content_change' ? 'Shared content change' : 'New product'} · {sub.submission?.ref ?? sub.ref}
                      </span>
                      <h2 className="h3">{sub.title}</h2>
                      <span className="xs muted">
                        <span className="row nowrap gap-2">
                          <LogoTile initials={initials(seller)} tint={lc(sub.owner?.type) === 'official' ? 'brand' : '2'} size="sm" />
                          <span className="stack gap-0">
                            <span className="small strong nowrap">{seller}</span>
                            {sub.submission && (
                              <span className="xs muted nowrap">
                                Submitted{sub.submission.submittedBy?.name ? ` by ${sub.submission.submittedBy.name}` : ''} · {dateTime(sub.submission.submittedAt)} PT
                              </span>
                            )}
                          </span>
                        </span>
                      </span>
                    </div>
                  </div>
                  <div className="row gap-2">
                    <StatusBadge status={subStatus} />
                    {open && sub.submission?.reviewDeadline && <Deadline tone={deadlineTone(sub.submission.reviewDeadline.state)}>{deadlineLabel(sub.submission.reviewDeadline.dueAt, 'Review by')}</Deadline>}
                  </div>
                </div>
                <div className="card-body">
                  <div className="aa-sec">
                    <span className="h4">Content</span>
                    <KeyValue
                      pairs={[
                        ['Brand', sub.brand?.name ?? '—'],
                        ['Category', checks.some((c) => c.kind === 'category_fit' && c.tone !== 'success') ? <>{(sub.categoryPath ?? []).join(' › ')} <Differs /></> : (sub.categoryPath ?? []).join(' › ') || '—'],
                        ['Model', <span className="mono">{sub.modelNumber ?? '—'}</span>],
                        ['UPC', <span className="mono">{gtins.join(', ') || 'None'}</span>],
                        ['Offer', offer ? [offer.price?.formatted, offer.conditionLabel, offer.stock?.quantities ? `${num(offer.stock.quantities.available)} in stock` : null, offer.dispatch?.label].filter(Boolean).join(' · ') : 'No offer yet'],
                      ]}
                    />
                    {sub.description && <p className="small sub">{sub.description}</p>}
                    {sub.submission?.note && <p className="xs muted">Note from the submitter: {sub.submission.note}</p>}
                  </div>
                  {sub.images.length > 0 && (
                    <div className="aa-sec">
                      <span className="h4">Images · {sub.images.length}</span>
                      <div className="aa-imgs">
                        {sub.images.map((im, i) => {
                          const small = !!im.width && im.width < 1000;
                          return (
                            <figure key={im.id} className={cx(small && 'is-bad')}>
                              <Img icon="image" src={im.url} alt={im.alt ?? ''} />
                              <figcaption>
                                {i + 1}
                                {i === 0 ? ' · Main' : ''}
                                {im.width ? ` · ${im.width} px${small ? ', too small' : ''}` : ''}
                              </figcaption>
                            </figure>
                          );
                        })}
                      </div>
                    </div>
                  )}
                  {(specs.length > 0 || (sub.missing ?? []).length > 0) && (
                    <div className="aa-sec">
                      <span className="h4">Attributes</span>
                      <TableWrap label={`${sub.title} table`}>
                        <table className="table">
                          <thead>
                            <tr>
                              <th scope="col">Attribute</th>
                              <th scope="col">Value</th>
                              <th scope="col">
                                <span className="sr-only">Actions</span>
                              </th>
                            </tr>
                          </thead>
                          <tbody>
                            {specs.map((a) => (
                              <tr key={a.name}>
                                <td>{a.name}</td>
                                <td>{a.value}</td>
                                <td />
                              </tr>
                            ))}
                            {(sub.missing ?? []).map((m) => (
                              <tr key={m} className="is-flagged">
                                <td>
                                  <span className="sr-only">Urgent: </span>
                                  {m}
                                  <span className="xs muted"> · required</span>
                                </td>
                                <td>
                                  <span className="t-danger-text strong small">Missing</span>
                                </td>
                                <td>
                                  <Badge tone="danger">Required</Badge>
                                </td>
                              </tr>
                            ))}
                          </tbody>
                        </table>
                      </TableWrap>
                    </div>
                  )}
                </div>
              </section>

              <Card title="Automated checks" titleAs="h3" sub={checks.length ? `Ran ${dateTime(sub.checks[0].ranAt)} · ${attention ? `${attention} need attention · ` : ''}${checks.length - attention} passed` : 'Checks run when the product is submitted'}>
                {checks.map((c) => (
                  <div key={c.kind} className={`aa-chk t-${c.tone}`}>
                    <Icon name={c.icon} />
                    <div className="stack gap-2">
                      <div className="row between">
                        <span className="small strong">{c.title}</span>
                        <Badge tone={c.badge === 'Not a duplicate' ? '' : c.tone}>{c.badge}</Badge>
                      </div>
                      <CheckBody body={c.body} />
                      {c.raw.dismissal && canReview && open && (
                        <div className="row gap-2">
                          <Button variant="ghost" size="sm" icon="undo-2" onClick={() => restoreCheck.mutate(c.raw.kind)} disabled={restoreCheck.isPending}>
                            {lc(c.raw.kind) === 'duplicate' ? 'Undo not a duplicate' : 'Restore check'}
                          </Button>
                        </div>
                      )}
                      {c.kind === 'duplicate' && dup && (
                        <>
                          <div className="aa-cmp">
                            {[
                              { head: 'This submission', name: sub.title, link: '', img: sub.images[0]?.url, foot: '', brand: sub.brand?.name, model: sub.modelNumber, cat: (sub.categoryPath ?? []).join(' › '), opts: optionsText(sub.variants[0]?.options) },
                              {
                                head: `Existing · ${dup.ref ?? ''}`,
                                name: dup.title,
                                link: dup.id,
                                img: dup.images?.[0]?.url,
                                foot: [dup.offerCount != null ? plural(dup.offerCount, 'offer') : '', dup.reviewSummary ? plural(dup.reviewSummary.ratingCount, 'review') : '', dup.updatedAt ? `updated ${shortDate(dup.updatedAt)}` : ''].filter(Boolean).join(' · '),
                                brand: dup.brand?.name,
                                model: dup.modelNumber,
                                cat: (dup.categoryPath ?? []).join(' › '),
                                opts: optionsText(dup.variants?.[0]?.options),
                              },
                            ].map((pp, i, all) => {
                              const other = all[1 - i];
                              const pairs: Array<[string, string, boolean]> = [
                                ['Brand', pp.brand ?? '—', false],
                                ['Model', pp.model ?? '—', pp.model !== other.model],
                                ['Variation', pp.opts || '—', pp.opts !== other.opts],
                                ['Category', pp.cat || '—', pp.cat !== other.cat],
                              ];
                              return (
                                <div key={pp.head} className="panel stack gap-2">
                                  <span className="row gap-2">
                                    <Img icon="package" src={pp.img} className="tiny" />
                                    <span className="stack gap-0">
                                      <span className="xs strong muted">{pp.head}</span>
                                      {pp.link ? (
                                        <Link className="small strong" to={href('admin/product-review', '', undefined, { id: pp.link })}>
                                          {pp.name}
                                        </Link>
                                      ) : (
                                        <span className="small strong">{pp.name}</span>
                                      )}
                                    </span>
                                  </span>
                                  <dl className="kv">
                                    {pairs.map(([k, v, diff]) => [
                                      <dt key={`${k}-t`}>{k}</dt>,
                                      <dd key={`${k}-d`} className={cx(diff && i === 0 && 'aa-diff')}>
                                        {v}
                                        {diff && i === 0 && (
                                          <>
                                            {' '}
                                            <Differs />
                                          </>
                                        )}
                                      </dd>,
                                    ])}
                                  </dl>
                                  {pp.foot && <span className="xs muted">{pp.foot}</span>}
                                </div>
                              );
                            })}
                          </div>
                          {canReview && open && (
                            <div className="row gap-2">
                              <Button size="sm" icon="merge" onClick={openMerge}>
                                Merge into {dup.ref ?? 'existing product'}
                              </Button>
                              <Button variant="ghost" size="sm" onClick={() => dismissDup.mutate()} disabled={dismissDup.isPending}>
                                Not a duplicate
                              </Button>
                            </div>
                          )}
                        </>
                      )}
                    </div>
                  </div>
                ))}
                {checks.length === 0 && <p className="small sub">No automated checks apply to this change.</p>}
              </Card>

              {open && canReview ? (
                <Card
                  title="Decision"
                  titleAs="h3"
                  sub={sub.reviewDraft ? `The seller sees your reason and each field comment · draft saved ${dateTime(sub.reviewDraft.savedAt)}${sub.reviewDraft.savedBy?.name && sub.reviewDraft.savedBy.name !== me ? ` by ${sub.reviewDraft.savedBy.name}` : ''}` : 'The seller sees your reason and each field comment'}
                  foot={
                    <>
                      <Button variant="ghost" onClick={() => saveDraft.mutate()} disabled={saveDraft.isPending}>
                        Save draft
                      </Button>
                      {decision === 'approve' ? (
                        <Button icon="check" onClick={submit} disabled={decide.isPending}>
                          Approve and publish
                        </Button>
                      ) : decision === 'reject' ? (
                        <Button variant="danger" icon="x" onClick={submit} disabled={decide.isPending}>
                          Reject submission
                        </Button>
                      ) : (
                        <Button icon="send" onClick={submit} disabled={decide.isPending}>
                          Send change request
                        </Button>
                      )}
                    </>
                  }
                >
                  <div className="grid md3 gap-2">
                    {DECISIONS.map((d, i) => (
                      <OptionCard
                        key={d.value}
                        id={`aa-pr-d${i + 1}`}
                        name="aa-pr-d"
                        title={<span className="small strong">{d.title}</span>}
                        body={d.body}
                        checked={decision === d.value}
                        onChange={() => {
                          setDecision(d.value);
                          setTried(false);
                        }}
                      />
                    ))}
                  </div>
                  <Field label="Reason" hint="Required for Request changes and Reject." error={reasonError}>
                    <Select
                      id="aa-pr-reason"
                      className={cx(reasonError && 'is-error')}
                      options={[{ value: '', label: 'Choose a reason' }, ...(reason && !REASONS.includes(reason) ? [reason] : []), ...REASONS]}
                      value={reason}
                      onChange={(e) => setReason(e.target.value)}
                    />
                  </Field>
                  <div className="stack gap-2">
                    <span className="label">Field comments · {comments.length}</span>
                    {comments.length > 0 && (
                      <TableWrap label="Decision table">
                        <table className="table">
                          <thead>
                            <tr>
                              <th scope="col">Field</th>
                              <th scope="col">Comment to seller</th>
                              <th scope="col">
                                <span className="sr-only">Actions</span>
                              </th>
                            </tr>
                          </thead>
                          <tbody>
                            {comments.map((c) => (
                              <tr key={c.field}>
                                <td>
                                  <span className="small strong">{c.field}</span>
                                </td>
                                <td>
                                  <span className="small">{c.comment}</span>
                                </td>
                                <td>
                                  <IconButton icon="trash-2" label="Remove comment" onClick={() => removeComment(c.field)} />
                                </td>
                              </tr>
                            ))}
                          </tbody>
                        </table>
                      </TableWrap>
                    )}
                    {adding ? (
                      <div className="panel stack gap-3">
                        <div className="grid md2 gap-3">
                          <Field label="Field">
                            <Select id="aa-pr-cf" options={COMMENT_FIELDS} value={newField} onChange={(e) => setNewField(e.target.value)} />
                          </Field>
                          <Field label="Comment to seller" error={commentError}>
                            <TextInput id="aa-pr-cc" value={newComment} error={!!commentError} onChange={(e) => setNewComment(e.target.value)} />
                          </Field>
                        </div>
                        <div className="row gap-2">
                          <Button size="sm" onClick={addComment}>
                            Add comment
                          </Button>
                          <Button
                            variant="ghost"
                            size="sm"
                            onClick={() => {
                              setAdding(false);
                              setCommentTried(false);
                            }}
                          >
                            Cancel
                          </Button>
                        </div>
                      </div>
                    ) : (
                      <Button variant="ghost" size="sm" icon="plus" onClick={() => setAdding(true)}>
                        Add field comment
                      </Button>
                    )}
                  </div>
                  {blockError && <Alert tone="danger" title="Can't approve yet">{blockError}</Alert>}
                  {dup && (
                    <Alert tone="info" title="Duplicate first">
                      If you merge this into {dup.ref ?? 'the existing product'}, the change request goes with the new variation and the seller fixes it there.
                    </Alert>
                  )}
                </Card>
              ) : (
                <Card title="Decision" titleAs="h3" sub={open ? 'Waiting for a reviewer' : 'Sent to the seller'}>
                  <div className="row between">
                    <span className="row gap-2">
                      <StatusBadge status={subStatus} />
                      <span className="small sub">
                        {(() => {
                          const last = [...sub.reviewLog].reverse().find((e) => e.action === 'approved' || e.action === 'changes_requested' || e.action === 'rejected');
                          return lc(sub.reviewState) === 'approved' ? 'Published to the catalog' : last?.reason ? `Reason: ${last.reason}` : open ? 'Reviewing needs the Catalog review permission.' : '';
                        })()}
                      </span>
                    </span>
                    {nextInQueue && (
                      <Button size="sm" iconRight="arrow-right" onClick={() => select(nextInQueue.product.id)}>
                        Next submission
                      </Button>
                    )}
                  </div>
                </Card>
              )}

              <Card title="History" titleAs="h3">
                <ol className="timeline">
                  {events.map((e, i) => (
                    <li key={`${e.t}-${i}`} className={`ev is-${e.state}`}>
                      {e.state === 'warn' && <span className="sr-only">At risk: </span>}
                      <span className="dot" aria-hidden="true" />
                      <div className="stack gap-1">
                        <span className="t">{e.t}</span>
                        <span className="d">{e.d}</span>
                      </div>
                    </li>
                  ))}
                </ol>
              </Card>
            </>
          )}
        </div>
      </div>

      <Dialog
        open={view === 'merge-duplicate' && !!sub}
        onClose={closeMerge}
        size="lg"
        title="Merge duplicate into existing product"
        foot={
          <>
            <Button variant="ghost" onClick={closeMerge}>
              Cancel
            </Button>
            <Button icon="merge" onClick={doMerge} disabled={merge.isPending || !keepId}>
              Merge {plural(records.length, 'record')} into {keepRef}
            </Button>
          </>
        }
      >
        <p className="small sub">Merging keeps one product page. Offers, reviews and past orders move to the product you keep, and the merged records redirect to it.</p>
        {candidates.length === 0 ? (
          <Alert tone="info" title="No duplicate candidates">
            The duplicate check found no existing product to merge into.
          </Alert>
        ) : (
          <>
            <div className="stack gap-2">
              <span className="label">Product to keep</span>
              {candidates.map((t, i) => (
                <OptionCard
                  key={t.id}
                  id={`aa-mg-t${i + 1}`}
                  name="aa-mg-t"
                  checked={keepId === t.id}
                  onChange={() => setKeep(t.id)}
                  title={
                    keepId === t.id ? (
                      <span className="row gap-2">
                        <span className="strong small">{t.title}</span>
                        <Badge tone="brand">Keep</Badge>
                      </span>
                    ) : (
                      <span className="strong small">{t.title}</span>
                    )
                  }
                  body={
                    <>
                      <span className="mono">{t.ref}</span> · {[(t.categoryPath ?? []).join(' › '), t.offerCount != null ? plural(t.offerCount, 'offer') : '', t.reviewSummary ? `${plural(t.reviewSummary.ratingCount, 'review')}${t.reviewSummary.average != null ? ` · rating ${t.reviewSummary.average.toFixed(1)}` : ''}` : ''].filter(Boolean).join(' · ')}
                    </>
                  }
                  right={<Img icon="package" src={t.images?.[0]?.url} className="tiny" />}
                />
              ))}
            </div>
            <div className="stack gap-2">
              <span className="label">Records merged into {keepRef}</span>
              {mergeRecords.map((r) => (
                <Checkbox
                  key={r.id}
                  id={`aa-mg-${r.id}`}
                  checked={records.includes(r.id)}
                  onChange={() => toggleRecord(r.id)}
                  label={
                    <span className="small">
                      <b>{r.ref}</b>
                      {r.text}
                    </span>
                  }
                />
              ))}
              {recordsError && (
                <span className="error-text">
                  <Icon name="circle-alert" className="ic-sm" />
                  {recordsError}
                </span>
              )}
            </div>
            {preview.isPending && records.length > 0 && <SkeletonLines rows={3} />}
            {preview.isError && <Alert tone="danger" title="We couldn't preview this merge">{errorMessage(preview.error)}</Alert>}
            {effects.length > 0 && (
              <TableWrap label="Merge duplicate into existing product table">
                <table className="table">
                  <thead>
                    <tr>
                      <th scope="col">What</th>
                      <th scope="col">How it carries over</th>
                      <th scope="col">After merge</th>
                    </tr>
                  </thead>
                  <tbody>
                    {effects.map((m) => (
                      <tr key={m.what}>
                        <td>
                          <span className="strong small">{m.what}</span>
                        </td>
                        <td>
                          <span className="small">{m.how}</span>
                        </td>
                        <td>
                          <span className="small num">{m.after}</span>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </TableWrap>
            )}
            {p && (
              <Alert tone="info" title="Sellers are notified">
                {notified ? `${notified} get a message explaining the merge and where their offers now appear.` : 'Sellers with offers on the merged records get a message explaining the merge.'} {p.notes.join(' ')}
              </Alert>
            )}
          </>
        )}
        {actionError && <Alert tone="danger" title={actionError} />}
        <Field label="Reason for merge" hint="Required. Shown to the affected sellers." error={mergeReasonError}>
          <Textarea id="aa-mg-reason" className={cx(mergeReasonError && 'is-error')} value={mergeReason} onChange={(e) => setMergeReason(e.target.value)} />
        </Field>
      </Dialog>
    </AdminLayout>
  );
}
