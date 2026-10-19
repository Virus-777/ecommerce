import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useState, type ReactNode } from 'react';
import { Link } from 'react-router';
import { AccountLayout } from '@/layouts';
import { call, errorMessage, useApi, type components } from '@marketly/web-shared/api';
import { cx } from '@marketly/web-shared/lib/cx';
import { useView } from '@marketly/web-shared/lib/hooks';
import { href } from '@marketly/web-shared/routes';
import { Alert, Badge, Button, Card, Dialog, Field, Icon, Img, LogoTile, Pager, Stars5, StatusBadge, Tabs, Textarea, type IconName, type Tone } from '@marketly/web-shared/ui';
import { sellerTile } from './data/messages';
import { MyAnswers, useMyAnswers } from './data/my-answers';
import { date, slugify } from './data/when';

// Design: pages/store/account-reviews.html · tabs as views: "" = product reviews,
// "seller-feedback", "reports-you-made", plus "answers" (no design: answers to other shoppers' questions).
// API: reviews (GET /api/store/reviews/me/pending, …/me/reviews, …/me/feedback, …/me/reports, DELETE, appeals)
// and trust (GET /api/store/trust/reports): "Reports you made" merges both.

type View = 'seller-feedback' | 'reports-you-made' | 'answers';
type MyReview = components['schemas']['reviews.MyReview'];
type MyFeedback = components['schemas']['reviews.MyFeedback'];
type ReviewReport = components['schemas']['reviews.MyReport'];
type TrustReport = components['schemas']['trust.MyReport'];

const REVIEW_TONE: Record<string, Tone> = { published: 'success', pending: 'info', held: 'warning', edit_requested: 'warning', removed: 'danger', draft: '', deleted: '' };
const LIMIT = 20;
/** The Official Store's seller id (docs/api/README.md "Constants"; not yet in web-shared/src/config.ts). */
import { OFFICIAL_STORE_ID } from '@marketly/web-shared/config';

interface ReportRow {
  key: string;
  icon: IconName;
  tone?: 'info';
  title: string;
  status: string;
  statusTone?: Tone;
  what: string;
  said: string;
  outcome: ReactNode;
  at: string;
}

const TARGET: Record<string, { label: string; icon: IconName }> = {
  product_review: { label: 'a review', icon: 'message-square-warning' },
  review: { label: 'a review', icon: 'message-square-warning' },
  seller_feedback: { label: 'seller feedback', icon: 'message-square-warning' },
  question: { label: 'a question', icon: 'circle-help' },
  answer: { label: 'an answer', icon: 'circle-help' },
  seller_response: { label: 'a seller reply', icon: 'message-square-warning' },
};
const TRUST_STATUS: Record<string, { label: string; tone?: Tone }> = {
  received: { label: 'Received' },
  under_review: { label: 'Under review' },
  decision_made: { label: 'Decision made' },
  action_taken: { label: 'Action taken', tone: 'success' },
  no_violation: { label: 'No violation' },
};
const sentence = (s: string) => (s ? s.charAt(0).toUpperCase() + s.slice(1).replace(/_/g, ' ') : s);

function reviewRow(r: ReviewReport): ReportRow {
  const t = TARGET[r.targetType] ?? { label: r.targetType.replace(/_/g, ' '), icon: 'flag' as IconName };
  return {
    key: `r-${r.id}`,
    icon: t.icon,
    title: `Report on ${t.label}`,
    status: r.statusLabel,
    statusTone: r.status === 'decided' ? 'success' : undefined,
    what: r.targetSummary,
    said: `You said: ${sentence(r.reason).toLowerCase()}${r.note ? `, ${r.note}` : ''} · reported ${date(r.reportedAt)}`,
    outcome: r.outcome ?? 'We’re checking it against the rules. You’ll get a notification when we decide.',
    at: r.reportedAt,
  };
}
function trustRow(r: TrustReport): ReportRow {
  const s = TRUST_STATUS[r.statusLabel] ?? { label: sentence(r.statusLabel) };
  return {
    key: `t-${r.id}`,
    icon: 'shield-alert',
    tone: 'info',
    title: `Report on ${r.what.toLowerCase().startsWith('a ') || r.what.toLowerCase().startsWith('an ') ? r.what.toLowerCase() : `a ${r.what.toLowerCase()}`}`,
    status: s.label,
    statusTone: s.tone,
    what: r.about,
    said: `You said: ${r.youSaid} · reported ${date(r.reportedAt)}`,
    outcome: (
      <>
        {r.outcome ?? `Our trust team is checking it.${r.expectedBy ? ` Expected outcome by ${date(r.expectedBy)}.` : ''}`}
        {r.caseRef && (
          <>
            {' '}Case <span className="mono">{r.caseRef}</span>.
          </>
        )}
      </>
    ),
    at: r.reportedAt,
  };
}

function ListError({ error, retry, what }: { error: unknown; retry: () => void; what: string }) {
  return (
    <Alert tone="danger" title={`We couldn't load ${what}`}>
      {errorMessage(error)}{' '}
      <Button variant="ghost" size="sm" onClick={retry}>
        Try again
      </Button>
    </Alert>
  );
}

const cardSkeleton = (
  <div className="card pad stack gap-2" aria-hidden="true">
    <span className="sk sk-line short" />
    <span className="sk sk-line" />
    <span className="sk sk-line" />
  </div>
);

export default function Reviews() {
  const { api } = useApi();
  const qc = useQueryClient();
  const [rawView, setView] = useView<View>();
  const view: View | '' = rawView === 'seller-feedback' || rawView === 'reports-you-made' || rawView === 'answers' ? rawView : '';
  const [page, setPage] = useState({ reviews: 1, feedback: 1 });
  const [confirm, setConfirm] = useState<{ kind: 'review' | 'feedback'; id: string; name: string } | null>(null);
  const [appeal, setAppeal] = useState<MyReview | null>(null);
  const [appealText, setAppealText] = useState('');
  const [notice, setNotice] = useState('');

  const pending = useQuery({ queryKey: ['reviews', 'me', 'pending'], queryFn: () => call(api.GET('/api/store/reviews/me/pending')) });
  const reviews = useQuery({
    queryKey: ['reviews', 'me', 'reviews', page.reviews],
    queryFn: () => call(api.GET('/api/store/reviews/me/reviews', { params: { query: { page: page.reviews, limit: LIMIT } } })),
  });
  const feedback = useQuery({
    queryKey: ['reviews', 'me', 'feedback', page.feedback],
    queryFn: () => call(api.GET('/api/store/reviews/me/feedback', { params: { query: { page: page.feedback, limit: LIMIT } } })),
  });
  const reports = useQuery({ queryKey: ['reviews', 'me', 'reports'], queryFn: () => call(api.GET('/api/store/reviews/me/reports', { params: { query: { page: 1, limit: 50 } } })) });
  const answers = useMyAnswers(1);
  const trustReports = useQuery({ queryKey: ['trust', 'reports'], queryFn: () => call(api.GET('/api/store/trust/reports', { params: { query: { page: 1, limit: 50 } } })) });

  const doDelete = useMutation({
    mutationFn: (c: NonNullable<typeof confirm>) =>
      c.kind === 'review'
        ? call(api.DELETE('/api/store/reviews/me/reviews/{id}', { params: { path: { id: c.id } } }))
        : call(api.DELETE('/api/store/reviews/me/feedback/{id}', { params: { path: { id: c.id } } })),
    onSuccess: (_, c) => {
      setNotice(c.kind === 'review' ? `Your review of ${c.name} was deleted.` : `Your feedback for ${c.name} was deleted.`);
      setConfirm(null);
      void qc.invalidateQueries({ queryKey: ['reviews'] });
    },
  });
  const sendAppeal = useMutation({
    mutationFn: (r: MyReview) => call(api.POST('/api/store/reviews/me/appeals', { body: { targetType: 'product_review', targetId: r.review.id, reason: appealText.trim() } })),
    onSuccess: () => {
      setAppeal(null);
      setAppealText('');
      setNotice('Appeal sent. We’ll tell you the outcome by notification and email.');
      void qc.invalidateQueries({ queryKey: ['reviews', 'me', 'reviews'] });
    },
  });

  const switchTab = (v: View | '') => {
    setNotice('');
    setView(v);
  };
  const reportRows = [...(reports.data?.items ?? []).map(reviewRow), ...(trustReports.data?.items ?? []).map(trustRow)].sort((a, b) => b.at.localeCompare(a.at));
  const reportCount = reports.data && trustReports.data ? (reports.data.total ?? reports.data.items.length) + (trustReports.data.total ?? trustReports.data.items.length) : undefined;
  const waiting = pending.data?.products ?? [];
  const feedbackWaiting = pending.data?.sellerFeedback ?? [];

  return (
    <AccountLayout active="reviews" title="Reviews and feedback">
      <div className="acct-head">
        <div className="stack gap-1">
          <h1 className="h1 acct-h1">Reviews and feedback</h1>
          <p className="small sub">Product reviews describe the item. Seller feedback describes buying from a seller. You can edit either one later.</p>
        </div>
      </div>
      <Tabs<View | ''>
        active={view}
        onChange={switchTab}
        items={[
          { value: '', label: 'Product reviews', count: reviews.data ? (reviews.data.total ?? reviews.data.items.length) : undefined },
          { value: 'seller-feedback', label: 'Seller feedback', count: feedback.data ? (feedback.data.total ?? feedback.data.items.length) : undefined },
          { value: 'answers', label: 'Your answers', count: answers.data ? (answers.data.total ?? answers.data.items.length) : undefined },
          { value: 'reports-you-made', label: 'Reports you made', count: reportCount },
        ]}
      />
      <div className="stack gap-4">
        {notice && <Alert tone="success" title={notice} />}

        {view === '' && (
          <>
            {pending.isError && <ListError error={pending.error} retry={() => void pending.refetch()} what="purchases waiting for a review" />}
            {waiting.length > 0 && (
              <Card title="Waiting for your review" sub="Delivered purchases you haven't reviewed yet" flush>
                {waiting.map((w) => (
                  <div key={w.orderItemId} className="acct-row">
                    <Img icon="package" tint="2" className="tiny" src={w.imageUrl ?? undefined} alt="" />
                    <span className="stack gap-0 grow">
                      <span className="small strong">{w.title}</span>
                      <span className="xs muted">
                        Delivered {date(w.deliveredAt)} · {w.sellerName}
                      </span>
                    </span>
                    <Button variant="secondary" size="sm" icon="star" to={href('account/review', '', undefined, { item: w.orderItemId })}>
                      Write a review
                    </Button>
                  </div>
                ))}
              </Card>
            )}
            <h2 className="h3">Your reviews</h2>
            {reviews.isError && <ListError error={reviews.error} retry={() => void reviews.refetch()} what="your reviews" />}
            {reviews.isPending && cardSkeleton}
            {reviews.data && !reviews.data.items.length && <p className="small muted">You haven't written any reviews yet.</p>}
            {reviews.data?.items.map((r) => {
              const productTo = href('store/product', '', { slug: slugify(r.productTitle), id: r.review.productId });
              const removed = r.status === 'removed' || r.status === 'edit_requested';
              const hidden = r.status === 'held' || r.moderation?.decision === 'hidden_pending_review';
              const m = r.moderation;
              return (
                <article key={r.review.id} className="card">
                  <div className="card-body">
                    <div className="row gap-3 nowrap top">
                      <Link to={productTo} aria-label={r.productTitle}>
                        <Img icon="package" tint="2" className="thumb" src={r.productImageUrl ?? undefined} alt="" />
                      </Link>
                      <div className="stack gap-1 grow">
                        <div className="row between gap-2 top">
                          <Link className="small strong link-plain" to={productTo}>
                            {r.productTitle}
                          </Link>
                          <Badge tone={REVIEW_TONE[r.status] ?? ''}>{r.statusLabel}</Badge>
                        </div>
                        <span className="row gap-2">
                          <Stars5 rating={r.review.rating} size="md" />
                          <span className="small strong">{r.review.headline}</span>
                        </span>
                        <p className="small sub">{r.review.text}</p>
                        <span className="row gap-2 xs muted">
                          {r.review.author.verifiedPurchase && (
                            <Badge tone="success" icon="badge-check">
                              Verified Purchase
                            </Badge>
                          )}
                          <span>
                            {r.status === 'draft' ? `Draft saved ${date(r.review.editedAt ?? r.review.reviewedAt)}` : `Posted ${date(r.review.reviewedAt)}`}
                            {r.review.helpfulCount > 0 && ` · ${r.review.helpfulCount} ${r.review.helpfulCount === 1 ? 'person' : 'people'} found this helpful`}
                          </span>
                        </span>
                      </div>
                    </div>
                    {hidden && (
                      <Alert tone="warning" title="Hidden while we check a report">
                        {m?.reasonText || 'A shopper reported this review. We’re checking it against the review rules.'}
                        {m?.expectedBy && ` We'll decide by ${date(m.expectedBy)}.`} Negative reviews are not removed for being negative. You don't need to do anything.
                      </Alert>
                    )}
                    {removed && m && (
                      <div className="panel stack gap-2">
                        <span className="row gap-2 small strong">
                          <Icon name="circle-alert" className="ic-sm" /> {r.status === 'edit_requested' ? 'Changes requested' : 'Removed'}
                          {m.decidedAt && ` on ${date(m.decidedAt)}`} by Marketly review moderation
                        </span>
                        <span className="xs sub">
                          <span className="strong">Reason:</span> {m.reasonText}
                        </span>
                        <span className="row gap-3 xs">
                          {r.appeal ? (
                            <span className="muted">
                              Appeal {r.appeal.status === 'submitted' ? `sent ${date(r.appeal.submittedAt)}` : r.appeal.status === 'overturned' ? 'accepted' : 'decided: the decision stands'}
                              {r.appeal.outcome && `. ${r.appeal.outcome}`}
                            </span>
                          ) : (
                            r.canAppeal && (
                              <a
                                className="strong link-inline"
                                href="#"
                                onClick={(e) => {
                                  e.preventDefault();
                                  sendAppeal.reset();
                                  setAppeal(r);
                                }}
                              >
                                Appeal this decision
                              </a>
                            )
                          )}
                          {m.appealBy && !r.appeal && r.canAppeal && <span className="muted">Appeal by {date(m.appealBy)}</span>}
                          <Link to={href('help/article', '', { slug: 'how-reviews-work' })} className="link-inline">
                            Review rules
                          </Link>
                        </span>
                      </div>
                    )}
                  </div>
                  <div className="card-foot between">
                    <span className="xs muted">
                      {r.visibleToShoppers
                        ? 'Shown on the product page for all sellers.'
                        : r.status === 'draft'
                          ? "Drafts aren't public."
                          : removed
                            ? 'You can fix it and post it again.'
                            : r.status === 'pending'
                              ? 'Shown once it passes the review checks.'
                              : 'Not visible to shoppers right now.'}
                    </span>
                    <div className="row gap-2">
                      {r.canEdit && (
                        <Button variant="secondary" size="sm" icon="pencil" to={href('account/review', '', undefined, { item: r.orderItemId })}>
                          {removed ? 'Edit and resubmit' : r.status === 'draft' ? 'Finish review' : 'Edit'}
                        </Button>
                      )}
                      {r.canDelete && (
                        <Button variant="ghost" size="sm" icon="trash-2" onClick={() => (doDelete.reset(), setConfirm({ kind: 'review', id: r.review.id, name: r.productTitle }))}>
                          Delete
                        </Button>
                      )}
                    </div>
                  </div>
                </article>
              );
            })}
            {(reviews.data?.totalPages ?? 1) > 1 && <Pager page={page.reviews} total={reviews.data!.totalPages!} onPage={(n) => setPage((x) => ({ ...x, reviews: n }))} only="website" />}
          </>
        )}

        {view === 'seller-feedback' && (
          <>
            <Alert tone="info" title="Seller feedback is about the purchase, not the product">
              It shows on the seller's profile and covers accuracy, dispatch and communication. Product reviews are on the other tab.
            </Alert>
            {pending.isError && <ListError error={pending.error} retry={() => void pending.refetch()} what="packages waiting for feedback" />}
            {feedbackWaiting.length > 0 && (
              <Card title="Waiting for your feedback" flush>
                {feedbackWaiting.map((w) => {
                  const tile = sellerTile(w.sellerName, w.ownerType === 'official');
                  return (
                    <div key={`${w.orderId}-${w.sellerId}`} className="acct-row">
                      <LogoTile initials={tile.initials} tint={tile.tint} />
                      <span className="stack gap-0 grow">
                        <span className="small strong">{w.sellerName}</span>
                        <span className="xs muted">
                          Order <span className="mono">{w.orderRef}</span> · {w.packageLabel}
                          {w.eligible ? (w.deliveredAt ? `, delivered ${date(w.deliveredAt)}` : '') : ` · ${w.availableNote ?? 'available after delivery'}`}
                        </span>
                      </span>
                      {w.eligible ? (
                        <Button variant="secondary" size="sm" to={href('account/review', '', undefined, { order: w.orderId, seller: w.sellerId })}>
                          Leave feedback
                        </Button>
                      ) : (
                        <Button variant="secondary" size="sm" disabled>
                          Leave feedback
                        </Button>
                      )}
                    </div>
                  );
                })}
              </Card>
            )}
            <h2 className="h3">Feedback you gave</h2>
            {feedback.isError && <ListError error={feedback.error} retry={() => void feedback.refetch()} what="your feedback" />}
            {feedback.isPending && cardSkeleton}
            {feedback.data && !feedback.data.items.length && <p className="small muted">You haven't left seller feedback yet.</p>}
            {feedback.data?.items.map((f: MyFeedback) => {
              const fb = f.feedback;
              const tile = sellerTile(fb.sellerName, fb.sellerId === OFFICIAL_STORE_ID);
              const reply = fb.response?.status === 'published' ? fb.response : null;
              return (
                <article key={fb.id} className="card">
                  <div className="card-body">
                    <div className="row between gap-2 top">
                      <div className="row gap-3 nowrap">
                        <LogoTile initials={tile.initials} tint={tile.tint} />
                        <div className="stack gap-0">
                          <span className="small strong">{fb.sellerName}</span>
                          <span className="xs muted">
                            {fb.orderRef && (
                              <>
                                Order <span className="mono">{fb.orderRef}</span> ·{' '}
                              </>
                            )}
                            {f.status === 'draft' ? 'draft' : `posted ${date(fb.postedAt)}`}
                          </span>
                        </div>
                      </div>
                      <StatusBadge status={f.statusLabel} />
                    </div>
                    <div className="grid md3 gap-3">
                      <div className="panel stack gap-1">
                        <span className="acct-k">As described</span>
                        <span className="small strong">{fb.dimensions.asDescribed ? 'Yes' : 'No'}</span>
                      </div>
                      <div className="panel stack gap-1">
                        <span className="acct-k">Dispatch speed</span>
                        <Stars5 rating={fb.dimensions.dispatchRating} size="md" />
                      </div>
                      <div className="panel stack gap-1">
                        <span className="acct-k">Communication</span>
                        {fb.dimensions.communicationRating ? <Stars5 rating={fb.dimensions.communicationRating} size="md" /> : <span className="small sub">Didn't contact</span>}
                      </div>
                    </div>
                    {fb.comment && <p className="small sub">{fb.comment}</p>}
                    {f.moderation && f.status === 'removed' && (
                      <Alert tone="warning" title="Removed by Marketly moderation">
                        {f.moderation.reasonText}
                      </Alert>
                    )}
                    {reply && (
                      <div className="panel stack gap-1">
                        <span className="acct-k">Public reply from the seller</span>
                        <span className="small sub">
                          {reply.text} {reply.fromName}
                          {reply.publishedAt && `, ${date(reply.publishedAt)}`}
                        </span>
                      </div>
                    )}
                  </div>
                  <div className="card-foot between">
                    <span className="xs muted">Shown on the seller profile only.</span>
                    <div className="row gap-2">
                      {f.canEdit && (
                        <Button variant="secondary" size="sm" icon="pencil" to={href('account/review', '', undefined, { order: fb.orderId, seller: fb.sellerId })}>
                          Edit
                        </Button>
                      )}
                      {f.canDelete && (
                        <Button variant="ghost" size="sm" icon="trash-2" onClick={() => (doDelete.reset(), setConfirm({ kind: 'feedback', id: fb.id, name: fb.sellerName }))}>
                          Delete
                        </Button>
                      )}
                    </div>
                  </div>
                </article>
              );
            })}
            {(feedback.data?.totalPages ?? 1) > 1 && <Pager page={page.feedback} total={feedback.data!.totalPages!} onPage={(n) => setPage((x) => ({ ...x, feedback: n }))} only="website" />}
          </>
        )}

        {view === 'answers' && <MyAnswers />}

        {view === 'reports-you-made' && (
          <>
            <p className="small sub">
              Reports you sent about reviews, answers or listings from other people. The people you report never see your name. Requests for information and actions on your
              account are in <Link to={href('account/reports')}>Reports and appeals</Link>.
            </p>
            {reports.isError && <ListError error={reports.error} retry={() => void reports.refetch()} what="your review reports" />}
            {trustReports.isError && <ListError error={trustReports.error} retry={() => void trustReports.refetch()} what="your listing reports" />}
            {(reports.isPending || trustReports.isPending) && cardSkeleton}
            {reports.isSuccess && trustReports.isSuccess && !reportRows.length && <p className="small muted">You haven't reported anything.</p>}
            {reportRows.length > 0 && (
              <section className="card">
                {reportRows.map((r) => (
                  <div key={r.key} className="acct-row">
                    <span className={cx('acct-ic', r.tone && `t-${r.tone}`)}>
                      <Icon name={r.icon} className="ic-sm" />
                    </span>
                    <span className="stack gap-1 grow">
                      <span className="row between gap-2 top">
                        <span className="small strong">{r.title}</span>
                        <StatusBadge status={r.status} tone={r.statusTone} />
                      </span>
                      <span className="xs sub">{r.what}</span>
                      <span className="xs muted">{r.said}</span>
                      <span className="xs">
                        <span className="strong">Outcome:</span> <span className="sub">{r.outcome}</span>
                      </span>
                    </span>
                  </div>
                ))}
              </section>
            )}
            <span className="xs muted">To report something new, use the Report link on the review, answer or listing.</span>
          </>
        )}
      </div>

      <Dialog
        open={!!confirm}
        onClose={() => setConfirm(null)}
        title={confirm?.kind === 'feedback' ? 'Delete this feedback?' : 'Delete this review?'}
        size="sm"
        foot={
          <>
            <Button variant="ghost" onClick={() => setConfirm(null)}>
              Keep it
            </Button>
            <Button variant="danger" icon="trash-2" onClick={() => confirm && doDelete.mutate(confirm)} disabled={doDelete.isPending}>
              Delete
            </Button>
          </>
        }
      >
        {doDelete.isError && <Alert tone="danger" title="We couldn't delete it">{errorMessage(doDelete.error)}</Alert>}
        <p className="small sub">
          {confirm?.kind === 'feedback'
            ? `Your feedback for ${confirm?.name} is removed from their seller profile. You can't leave new feedback for the same order.`
            : `Your review of ${confirm?.name} is removed from the product page. You can write a new one later.`}
        </p>
      </Dialog>

      <Dialog
        open={!!appeal}
        onClose={() => setAppeal(null)}
        title="Appeal this decision"
        size="sm"
        foot={
          <>
            <Button variant="ghost" onClick={() => setAppeal(null)}>
              Cancel
            </Button>
            <Button onClick={() => appeal && sendAppeal.mutate(appeal)} disabled={appealText.trim().length < 10 || sendAppeal.isPending}>
              Send appeal
            </Button>
          </>
        }
      >
        <p className="small sub">Tell us why your review of {appeal?.productTitle} follows the review rules. A different moderator decides.</p>
        {sendAppeal.isError && <Alert tone="danger" title="We couldn't send the appeal">{errorMessage(sendAppeal.error)}</Alert>}
        <Field label="Why should we look again?" hint="At least 10 characters.">
          <Textarea id="rv-appeal" value={appealText} onChange={(e) => setAppealText(e.target.value)} />
        </Field>
      </Dialog>
    </AccountLayout>
  );
}
