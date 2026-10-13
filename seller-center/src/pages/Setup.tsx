import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Link } from 'react-router';
import { call, errorMessage, useApi, type components } from '@marketly/web-shared/api';
import { SellerLayout } from '@marketly/web-shared/layouts';
import { cx } from '@marketly/web-shared/lib/cx';
import { href } from '@marketly/web-shared/routes';
import { Alert, Avatar, Badge, Button, Card, Icon, Meter, StatusBadge, announce, type IconName, type Tone } from '@marketly/web-shared/ui';
import { useSellerSession } from '@/app/session';
import { date, LoadError, screenHref, shortDate, SkeletonLines } from './data/home';

// Design: pages/seller/seller-setup.html (no views).
// API: GET /api/seller/sellers/setup (account status, product approval, payout readiness, the checklist steps,
// the launch readiness review and what goes live), POST /api/seller/sellers/setup/launch-review
// (sellers.account.manage). An approved seller with every step done and the review passed sees the finished
// checklist and a "store is live" alert instead of the "approval does not publish" note.
// Gaps: goLivePreview titles are SKUs, not product names; accountManager is null for seeded sellers (hidden).

type Checklist = components['schemas']['sellers.SetupChecklist'];
type Step = components['schemas']['sellers.SetupStep'];
type Payout = components['schemas']['sellers.PayoutReadiness'];

/** SetupChecklist json fields (typed `unknown` in the API spec; shapes from sellers.md). */
interface StepCta {
  label: string;
  screen: string;
}
interface GoLiveItem {
  productId: string;
  title: string;
  reviewState: string;
  outcome: 'will_go_live' | 'waits_for_approval' | 'stays_unpublished';
}
interface AccountManager {
  name: string;
  replyTarget?: string | null;
}

type Dot = 'done' | 'warn' | 'lock' | 'todo';
const DOT: Record<Step['state'], Dot> = { done: 'done', action_needed: 'warn', pending: 'warn', locked: 'lock', not_started: 'todo' };
const DOT_ICON: Record<Exclude<Dot, 'todo'>, IconName> = { done: 'check', warn: 'clock', lock: 'lock' };

function stepBadge(s: Step): { label: string; tone: Tone } {
  switch (s.state) {
    case 'done':
      return { label: 'Done', tone: 'success' };
    case 'action_needed':
      return { label: s.key === 'launch_review' ? 'Changes needed' : 'Action needed', tone: 'warning' };
    case 'pending':
      return s.key === 'launch_review' ? { label: 'In review', tone: 'info' } : s.key === 'payout_verification' ? { label: 'Verification pending', tone: 'warning' } : { label: 'Pending', tone: 'info' };
    case 'locked':
      return { label: 'Locked', tone: '' };
    default:
      return { label: 'Not started', tone: '' };
  }
}

const ACCOUNT_STATUS: Record<string, { tone: Tone; body: string }> = {
  approved: { tone: 'success', body: 'You can manage your store, products and settings.' },
  restricted: { tone: 'warning', body: 'Some activity is paused. Account health shows what is affected and how to resolve it.' },
  suspended: { tone: 'danger', body: 'Selling is paused. Existing orders, returns and messages still work.' },
  under_review: { tone: 'info', body: 'Your application is being reviewed.' },
  information_required: { tone: 'warning', body: 'We need more information to finish reviewing your application.' },
  applied: { tone: 'info', body: 'Your application is waiting for review.' },
  closed: { tone: '', body: 'This seller account is closed.' },
};

const PAYOUT: Record<Payout['state'], { label: string; tone: Tone }> = {
  not_added: { label: 'Not added', tone: 'warning' },
  verification_pending: { label: 'Verification pending', tone: 'warning' },
  verified: { label: 'Verified', tone: 'success' },
  change_under_review: { label: 'Change under review', tone: 'info' },
  blocked: { label: 'Blocked', tone: 'danger' },
};

const REVIEW_STATE: Record<string, string> = { approved: 'Approved', in_review: 'Submitted', submitted: 'Submitted', changes_requested: 'Changes requested', rejected: 'Rejected', draft: 'Draft' };
const OUTCOME: Record<GoLiveItem['outcome'], string> = { will_go_live: 'Will go live', waits_for_approval: 'Waits for approval', stays_unpublished: 'Stays unpublished' };

/** Help articles (seller/help-article slugs). Static: the seeded seller help has only these two of the design's four
 *  (image standards and dispatch deadlines have no article yet). */
const HELP: Array<{ icon: IconName; label: string; slug: string }> = [
  { icon: 'book-open', label: 'Payout schedule and holds', slug: 'seller-payout-schedule' },
  { icon: 'file-pen', label: 'Fixing a rejected or returned submission', slug: 'seller-launch-review' },
];

const ctaOf = (s: Step): StepCta | null => {
  const c = s.cta as Partial<StepCta> | null | undefined;
  return c?.label && c.screen ? { label: c.label, screen: c.screen } : null;
};

export default function Setup() {
  const { api } = useApi();
  const qc = useQueryClient();
  const { sellerId, storeName, status, can } = useSellerSession();
  const setup = useQuery({ queryKey: ['sellers', 'setup', sellerId], queryFn: () => call(api.GET('/api/seller/sellers/setup')) as Promise<Checklist> });
  const request = useMutation({
    mutationFn: () => call(api.POST('/api/seller/sellers/setup/launch-review', { body: {} })),
    onSuccess: () => {
      announce('Launch readiness review requested');
      void qc.invalidateQueries({ queryKey: ['sellers'] });
    },
  });

  const d = setup.data;
  const steps = d?.steps ?? [];
  const pct = d && d.total ? Math.round((d.completed / d.total) * 100) : 0;
  const review = d?.launchReview;
  const finished = !!d && d.completed === d.total && review?.state === 'passed';
  const pa = d?.productApproval;
  const submitted = pa ? pa.approved + pa.inReview + pa.changesRequested + pa.rejected : 0;
  const approvedPct = pa && submitted ? Math.round((pa.approved / submitted) * 100) : 0;
  const goLive = (d?.goLivePreview ?? []) as GoLiveItem[];
  const manager = (d?.accountManager ?? null) as AccountManager | null;
  const acct = ACCOUNT_STATUS[status] ?? { tone: '' as Tone, body: '' };
  const payout = d ? PAYOUT[d.payoutReadiness.state] : undefined;
  const mayRequest = can('sellers.account.manage');

  return (
    <SellerLayout active="setup">
      <div className="page-head">
        <div className="t">
          <h1 className="h1">{storeName ? `Set up ${storeName}` : 'Set up your store'}</h1>
          <p className="sub small">
            {finished
              ? `Setup is complete${review?.decidedAt ? ` and your launch readiness review passed on ${date(review.decidedAt)}` : ''}. Approved products with a complete offer are live.`
              : d?.approvedAt
                ? `Your seller account was approved on ${date(d.approvedAt)}. Finish these steps so your approved offers can go live.`
                : 'Finish these steps so your approved offers can go live.'}
          </p>
        </div>
        <div className="actions">
          <Button variant="secondary" size="sm" icon="life-buoy" to={href('seller/help', 'contact-seller-support')}>
            Contact seller support
          </Button>
        </div>
      </div>
      {setup.isError && <LoadError error={setup.error} onRetry={() => void setup.refetch()} title="We couldn’t load your setup checklist" />}
      <div className="sa-ind">
        {!d ? (
          Array.from({ length: 3 }, (_, i) => <div key={i} className="card pad sk sk-card" aria-hidden="true" style={{ minHeight: 120 }} />)
        ) : (
          <>
            <div className="card pad">
              <span className="xs muted strong">Account status</span>
              <div className="row gap-2">
                <Badge tone={acct.tone}>{d.accountStatus}</Badge>
                {d.approvedAt && <span className="xs muted">since {shortDate(d.approvedAt)}</span>}
              </div>
              <p className="small sub">{acct.body}</p>
            </div>
            <div className="card pad">
              <span className="xs muted strong">Product approval</span>
              {pa ? (
                <>
                  <div className="row between base">
                    <span className="h3 num">
                      {pa.approved} of {submitted} approved
                    </span>
                    <span className="xs muted">{approvedPct}%</span>
                  </div>
                  <Meter pct={approvedPct} label={`${pa.approved} of ${submitted} approved ${approvedPct}%`} />
                  <p className="xs muted">
                    {pa.inReview} in review · {pa.changesRequested} changes requested
                    {pa.rejected > 0 && ` · ${pa.rejected} rejected`}
                  </p>
                </>
              ) : (
                <p className="small sub">Product approval isn’t available right now.</p>
              )}
            </div>
            <div className="card pad">
              <span className="xs muted strong">Payout readiness</span>
              <div className="row gap-2">
                {payout && <Badge tone={payout.tone}>{payout.label}</Badge>}
                {d.payoutReadiness.destinationLabel && <span className="xs muted">{d.payoutReadiness.destinationLabel}</span>}
              </div>
              <p className="small sub">
                {d.payoutReadiness.note}
                {d.payoutReadiness.blockedReasons.length > 0 && ` ${d.payoutReadiness.blockedReasons.join(' ')}`}
              </p>
            </div>
          </>
        )}
      </div>
      {finished ? (
        <Alert tone="success" title="Your store is live">
          Customers see your offers whose product is approved and whose offer is complete with stock. New products go live as soon as they are approved.
        </Alert>
      ) : (
        <Alert tone="info" title="Approval does not publish your products">
          Customers only see an offer when its product is approved, the offer is complete with stock, and your launch readiness review is passed. Incomplete or unapproved products stay unpublished.
        </Alert>
      )}
      <div className="sa-split">
        <Card
          title="Setup checklist"
          sub={d ? `${d.completed} of ${d.total} complete` : 'Loading…'}
          actions={
            <span style={{ width: 140 }}>
              <Meter pct={pct} label="Setup checklist" />
            </span>
          }
          flush
        >
          {!d ? (
            <SkeletonLines rows={6} />
          ) : (
            <ol className="sa-steplist">
              {steps.map((s, i) => {
                const dot = DOT[s.state];
                const badge = stepBadge(s);
                const cta = ctaOf(s);
                const to = cta ? screenHref(cta.screen) : undefined;
                const isLaunch = s.key === 'launch_review';
                const canRequest = isLaunch && (review?.state === 'not_started' || review?.state === 'changes_needed') && s.state !== 'locked';
                return (
                  <li key={s.key}>
                    <span className={cx('sa-dot', dot !== 'todo' && `is-${dot}`)} aria-hidden="true">
                      {dot === 'warn' && <span className="sr-only">At risk: </span>}
                      {dot === 'todo' ? i + 1 : <Icon name={DOT_ICON[dot]} className="ic-sm" />}
                    </span>
                    <div className="stack gap-1">
                      <div className="row gap-2">
                        <h3 className="h4">{s.title}</h3>
                        <Badge tone={badge.tone}>{badge.label}</Badge>
                      </div>
                      <p className="small sub">{isLaunch && review?.state === 'passed' && review.note ? review.note : s.detail}</p>
                      {isLaunch && review?.state === 'changes_needed' && review.issues.length > 0 && (
                        <ul className="small stack gap-1">
                          {review.issues.map((x) => (
                            <li key={x}>{x}</li>
                          ))}
                        </ul>
                      )}
                      {isLaunch && request.isError && <span className="error-text">{errorMessage(request.error)}</span>}
                    </div>
                    <div className="sa-cta">
                      {cta && to ? (
                        <Button variant={s.state === 'done' ? 'ghost' : s.state === 'action_needed' ? 'primary' : 'secondary'} size="sm" to={to}>
                          {cta.label}
                        </Button>
                      ) : isLaunch && review?.state !== 'passed' ? (
                        mayRequest ? (
                          <Button variant="secondary" size="sm" disabled={!canRequest || request.isPending} onClick={() => request.mutate()}>
                            {review?.state === 'requested' ? 'Review requested' : 'Request review'}
                          </Button>
                        ) : (
                          <span className="xs muted">The owner or a manager requests the review</span>
                        )
                      ) : null}
                    </div>
                  </li>
                );
              })}
            </ol>
          )}
        </Card>
        <div className="stack gap-5">
          <Card title="What goes live after review" titleAs="h3" sub="Only approved products with a complete offer" flush>
            {!d ? (
              <SkeletonLines rows={3} />
            ) : goLive.length ? (
              <ul className="list pad">
                {goLive.map((p, i) => (
                  <li key={`${p.productId}-${p.title}-${i}`}>
                    <span className="grow stack gap-0">
                      <span className="small strong">{p.title}</span>
                      <span className="xs muted">{finished && p.outcome === 'will_go_live' ? 'Live' : OUTCOME[p.outcome] ?? p.outcome}</span>
                    </span>
                    <StatusBadge status={REVIEW_STATE[p.reviewState] ?? p.reviewState} />
                  </li>
                ))}
              </ul>
            ) : (
              <p className="small sub pad">
                Nothing submitted yet. <Link to={href('seller/products')}>Add a product</Link>
              </p>
            )}
          </Card>
          <Card title="Help while you set up" titleAs="h3">
            <ul className="stack gap-2 small">
              {HELP.map((h) => (
                <li key={h.label}>
                  <Link to={href('seller/help-article', '', { slug: h.slug })}>
                    <Icon name={h.icon} className="ic-sm" /> {h.label}
                  </Link>
                </li>
              ))}
            </ul>
            {manager?.name && (
              <>
                <div className="divider" />
                <div className="row gap-3">
                  <Avatar name={manager.name} />
                  <div className="stack gap-0">
                    <span className="small strong">{manager.name}</span>
                    <span className="xs muted">Your Seller Manager{manager.replyTarget ? ` · ${manager.replyTarget}` : ''}</span>
                  </div>
                </div>
              </>
            )}
          </Card>
        </div>
      </div>
    </SellerLayout>
  );
}
