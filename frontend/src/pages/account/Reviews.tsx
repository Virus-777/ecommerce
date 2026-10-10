import { useState, type ReactNode } from 'react';
import { Link } from 'react-router';
import { P } from '@/data/fixtures';
import { AccountLayout } from '@/layouts';
import { cx } from '@/lib/cx';
import { useView } from '@/lib/hooks';
import { href } from '@/routes/href';
import { Alert, Badge, Button, Card, Dialog, Icon, Img, LogoTile, Stars5, StatusBadge, Tabs, type IconName, type Tone } from '@/ui';

// Design: pages/store/account-reviews.html · tabs as views: "" = product reviews,
// "seller-feedback", "reports-you-made".

type View = 'seller-feedback' | 'reports-you-made';

interface ProductReview {
  id: string;
  p: string;
  status: string;
  tone: Tone;
  rating: number;
  title: string;
  body: string;
  posted: string;
  footNote: string;
  extra?: 'hidden' | 'removed';
}

const REVIEWS: ProductReview[] = [
  { id: 'r1', p: 'bottle', status: 'Published', tone: 'success', rating: 5, title: 'Ice lasts all day on the trail', body: "Filled it with ice at 7 AM and still had ice at 5 PM on a hot hike. The lid seals well and fits my pack's side pocket.", posted: 'Posted Aug 25 · 14 people found this helpful', footNote: 'Shown on the product page for all sellers.' },
  { id: 'r2', p: 'sweater', status: 'Hidden: under review', tone: 'warning', rating: 2, title: 'Shrank after one wash', body: 'Followed the cold-wash label and it still shrank a full size. Soft and warm before that.', posted: 'Posted Oct 3', footNote: 'Not visible to shoppers right now.', extra: 'hidden' },
  { id: 'r3', p: 'serum', status: 'Removed', tone: 'danger', rating: 1, title: 'Broke me out, contact me for details', body: 'Caused redness after two days. Text me at the number in my profile if you want photos.', posted: 'Posted Sep 14', footNote: 'You can fix it and post it again.', extra: 'removed' },
];

const WAITING = [
  { p: 'aurora', note: 'Delivered Sep 17 · Marketly Official' },
  { p: 'skillet', note: 'Delivered Sep 2 · Marketly Official' },
];

interface Feedback {
  id: string;
  seller: string;
  initials: string;
  tint: string;
  order: string;
  posted: string;
  described: string;
  dispatch: number;
  comm: number | null;
  comment: string;
  reply?: string;
}

const FEEDBACK: Feedback[] = [
  { id: 'f1', seller: 'Trailhead Outfitters', initials: 'TO', tint: '5', order: 'MK-260806-02291', posted: 'Aug 26', described: 'Yes', dispatch: 5, comm: null, comment: 'Well packed and arrived a day early.' },
  {
    id: 'f2', seller: 'Pixel & Port', initials: 'PP', tint: '6', order: 'MK-260920-33018', posted: 'Oct 3', described: 'Yes', dispatch: 4, comm: 2,
    comment: 'Item was fine but it took 3 days to answer my return question.',
    reply: "Sorry for the slow reply, Jordan. We've added weekend support since then. Pixel & Port, Oct 4",
  },
];

const FEEDBACK_WAITING = [
  { seller: 'Marketly Official', initials: 'M', tint: 'brand', note: 'Package 1, delivered Sep 17', ready: true },
  { seller: 'Pixel & Port', initials: 'PP', tint: '6', note: 'Package 2 · available after delivery', ready: false },
];

const REPORTS: Array<{ icon: IconName; tone?: 'info'; title: string; status: string; tone2?: Tone; what: string; said: string; outcome: ReactNode }> = [
  {
    icon: 'message-square-warning', title: 'Report on a review', status: 'Removed', tone2: 'success',
    what: `Review of ${P.kestrel27.name} by "Sam R."`, said: 'You said: off-topic, about a different monitor · reported Sep 30',
    outcome: 'Removed for off-topic content on Oct 2. Thanks, the product page is more accurate now.',
  },
  {
    icon: 'circle-help', title: 'Report on an answer', status: 'Decision made',
    what: `Answer to "Does it fit a 16-inch laptop?" on ${P.backpack.name}`, said: 'You said: wrong information · reported Sep 12',
    outcome: 'No violation found. Trailhead Outfitters confirmed the sleeve fits 16-inch laptops and added the size to the product details.',
  },
  {
    icon: 'shield-alert', tone: 'info', title: 'Report on a listing', status: 'Under review',
    what: `${P.vacuum.name} from Gadget Grove`, said: 'You said: may be counterfeit · reported Oct 5',
    outcome: (
      <>
        Our trust team is checking the seller's proof of supply. Expected outcome by Oct 12. Case <span className="mono">CS-261005-3390</span>.
      </>
    ),
  },
];

export default function Reviews() {
  const [rawView, setView] = useView<View>();
  const view: View | '' = rawView === 'seller-feedback' || rawView === 'reports-you-made' ? rawView : '';
  const [reviews, setReviews] = useState(REVIEWS);
  const [feedback, setFeedback] = useState(FEEDBACK);
  const [confirm, setConfirm] = useState<{ kind: 'review' | 'feedback'; id: string; name: string } | null>(null);
  const [notice, setNotice] = useState('');

  const doDelete = () => {
    if (!confirm) return;
    if (confirm.kind === 'review') setReviews((rs) => rs.filter((r) => r.id !== confirm.id));
    else setFeedback((fs) => fs.filter((f) => f.id !== confirm.id));
    setNotice(confirm.kind === 'review' ? `Your review of ${confirm.name} was deleted.` : `Your feedback for ${confirm.name} was deleted.`);
    setConfirm(null);
  };
  const switchTab = (v: View | '') => {
    setNotice('');
    setView(v);
  };

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
          { value: '', label: 'Product reviews', count: reviews.length },
          { value: 'seller-feedback', label: 'Seller feedback', count: feedback.length },
          { value: 'reports-you-made', label: 'Reports you made', count: REPORTS.length },
        ]}
      />
      <div className="stack gap-4">
        {notice && <Alert tone="success" title={notice} />}

        {view === '' && (
          <>
            <Card title="Waiting for your review" sub="Delivered purchases you haven't reviewed yet" flush>
              {WAITING.map((w) => (
                <div key={w.p} className="acct-row">
                  <Img icon={P[w.p].icon} tint={P[w.p].tint} className="tiny" />
                  <span className="stack gap-0 grow">
                    <span className="small strong">{P[w.p].name}</span>
                    <span className="xs muted">{w.note}</span>
                  </span>
                  <Button variant="secondary" size="sm" icon="star" to={href('account/review')}>
                    Write a review
                  </Button>
                </div>
              ))}
            </Card>
            <h2 className="h3">Your reviews</h2>
            {reviews.map((r) => {
              const p = P[r.p];
              return (
                <article key={r.id} className="card">
                  <div className="card-body">
                    <div className="row gap-3 nowrap top">
                      <Link to={href('store/product')} aria-label={p.name}>
                        <Img icon={p.icon} tint={p.tint} className="thumb" />
                      </Link>
                      <div className="stack gap-1 grow">
                        <div className="row between gap-2 top">
                          <Link className="small strong link-plain" to={href('store/product')}>
                            {p.name}
                          </Link>
                          <Badge tone={r.tone}>{r.status}</Badge>
                        </div>
                        <span className="row gap-2">
                          <Stars5 rating={r.rating} size="md" />
                          <span className="small strong">{r.title}</span>
                        </span>
                        <p className="small sub">{r.body}</p>
                        <span className="row gap-2 xs muted">
                          <Badge tone="success" icon="badge-check">
                            Verified Purchase
                          </Badge>
                          <span>{r.posted}</span>
                        </span>
                      </div>
                    </div>
                    {r.extra === 'hidden' && (
                      <Alert tone="warning" title="Hidden while we check a report">
                        A shopper reported this review on Oct 6. We're checking it against the review rules and will decide by Sat, Oct 10. Negative reviews are not removed for being negative. You don't need to do anything.
                      </Alert>
                    )}
                    {r.extra === 'removed' && (
                      <div className="panel stack gap-2">
                        <span className="row gap-2 small strong">
                          <Icon name="circle-alert" className="ic-sm" /> Removed on Sep 18 by Marketly review moderation
                        </span>
                        <span className="xs sub">
                          <span className="strong">Reason:</span> it asks shoppers to contact you directly, which the review rules don't allow. Your rating and experience were not the reason.
                        </span>
                        <span className="row gap-3 xs">
                          <Link className="strong link-inline" to={href('help/case')}>
                            Appeal this decision
                          </Link>
                          <span className="muted">Appeal by Oct 18</span>
                          <Link to={href('help/article')} className="link-inline">
                            Review rules
                          </Link>
                        </span>
                      </div>
                    )}
                  </div>
                  <div className="card-foot between">
                    <span className="xs muted">{r.footNote}</span>
                    <div className="row gap-2">
                      <Button variant="secondary" size="sm" icon="pencil" to={href('account/review')}>
                        {r.extra === 'removed' ? 'Edit and resubmit' : 'Edit'}
                      </Button>
                      <Button variant="ghost" size="sm" icon="trash-2" onClick={() => setConfirm({ kind: 'review', id: r.id, name: p.name })}>
                        Delete
                      </Button>
                    </div>
                  </div>
                </article>
              );
            })}
          </>
        )}

        {view === 'seller-feedback' && (
          <>
            <Alert tone="info" title="Seller feedback is about the purchase, not the product">
              It shows on the seller's profile and covers accuracy, dispatch and communication. Product reviews are on the other tab.
            </Alert>
            <Card title="Waiting for your feedback" flush>
              {FEEDBACK_WAITING.map((w) => (
                <div key={w.seller} className="acct-row">
                  <LogoTile initials={w.initials} tint={w.tint} />
                  <span className="stack gap-0 grow">
                    <span className="small strong">{w.seller}</span>
                    <span className="xs muted">
                      Order <span className="mono">MK-260914-48213</span> · {w.note}
                    </span>
                  </span>
                  {w.ready ? (
                    <Button variant="secondary" size="sm" to={href('account/review')}>
                      Leave feedback
                    </Button>
                  ) : (
                    <Button variant="secondary" size="sm" disabled>
                      Leave feedback
                    </Button>
                  )}
                </div>
              ))}
            </Card>
            <h2 className="h3">Feedback you gave</h2>
            {feedback.map((f) => (
              <article key={f.id} className="card">
                <div className="card-body">
                  <div className="row between gap-2 top">
                    <div className="row gap-3 nowrap">
                      <LogoTile initials={f.initials} tint={f.tint} />
                      <div className="stack gap-0">
                        <span className="small strong">{f.seller}</span>
                        <span className="xs muted">
                          Order <span className="mono">{f.order}</span> · posted {f.posted}
                        </span>
                      </div>
                    </div>
                    <StatusBadge status="Published" />
                  </div>
                  <div className="grid md3 gap-3">
                    <div className="panel stack gap-1">
                      <span className="acct-k">As described</span>
                      <span className="small strong">{f.described}</span>
                    </div>
                    <div className="panel stack gap-1">
                      <span className="acct-k">Dispatch speed</span>
                      <Stars5 rating={f.dispatch} size="md" />
                    </div>
                    <div className="panel stack gap-1">
                      <span className="acct-k">Communication</span>
                      {f.comm ? <Stars5 rating={f.comm} size="md" /> : <span className="small sub">Didn't contact</span>}
                    </div>
                  </div>
                  <p className="small sub">{f.comment}</p>
                  {f.reply && (
                    <div className="panel stack gap-1">
                      <span className="acct-k">Public reply from the seller</span>
                      <span className="small sub">{f.reply}</span>
                    </div>
                  )}
                </div>
                <div className="card-foot between">
                  <span className="xs muted">Shown on the seller profile only.</span>
                  <div className="row gap-2">
                    <Button variant="secondary" size="sm" icon="pencil" to={href('account/review')}>
                      Edit
                    </Button>
                    <Button variant="ghost" size="sm" icon="trash-2" onClick={() => setConfirm({ kind: 'feedback', id: f.id, name: f.seller })}>
                      Delete
                    </Button>
                  </div>
                </div>
              </article>
            ))}
          </>
        )}

        {view === 'reports-you-made' && (
          <>
            <p className="small sub">Reports you sent about reviews, answers or listings from other people. The people you report never see your name.</p>
            <section className="card">
              {REPORTS.map((r) => (
                <div key={r.title} className="acct-row">
                  <span className={cx('acct-ic', r.tone && `t-${r.tone}`)}>
                    <Icon name={r.icon} className="ic-sm" />
                  </span>
                  <span className="stack gap-1 grow">
                    <span className="row between gap-2 top">
                      <span className="small strong">{r.title}</span>
                      <StatusBadge status={r.status} tone={r.tone2} />
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
            <Button variant="danger" icon="trash-2" onClick={doDelete}>
              Delete
            </Button>
          </>
        }
      >
        <p className="small sub">
          {confirm?.kind === 'feedback'
            ? `Your feedback for ${confirm?.name} is removed from their seller profile. You can't leave new feedback for the same order.`
            : `Your review of ${confirm?.name} is removed from the product page. You can write a new one later.`}
        </p>
      </Dialog>
    </AccountLayout>
  );
}
