import { useState } from 'react';
import { Link } from 'react-router';
import { SellerLayout } from '@marketly/web-shared/layouts';
import { cx } from '@marketly/web-shared/lib/cx';
import { href } from '@marketly/web-shared/routes';
import { Alert, Avatar, Badge, Button, Card, Icon, Meter, StatusBadge, announce, type IconName, type Tone } from '@marketly/web-shared/ui';

// Design: pages/seller/seller-setup.html (no views). The checklist progress is computed from the steps.

type StepState = 'done' | 'warn' | 'lock';

interface SetupStep {
  id: string;
  title: string;
  state: StepState;
  status: string;
  tone: Tone;
  body: string;
  cta: { label: string; to?: string; variant: 'ghost' | 'primary' | 'secondary' };
}

const STEPS: SetupStep[] = [
  { id: 'profile', title: 'Store profile', state: 'done', status: 'Done', tone: 'success', body: 'Name, logo, introduction and customer contact details are complete.', cta: { label: 'Edit profile', to: href('seller/store'), variant: 'ghost' } },
  { id: 'shipping', title: 'Shipping coverage and rates', state: 'done', status: 'Done', tone: 'success', body: '48 contiguous states and DC · Standard and Expedited · 1 business day handling.', cta: { label: 'Review shipping', to: href('seller/shipping'), variant: 'ghost' } },
  { id: 'returns', title: 'Return address', state: 'done', status: 'Done', tone: 'success', body: 'Northwind Audio Returns, 1450 NW Raleigh St, Unit 3, Portland, OR 97209.', cta: { label: 'Edit address', to: href('seller/shipping'), variant: 'ghost' } },
  { id: 'payout', title: 'Payout verification', state: 'warn', status: 'Verification pending', tone: 'warning', body: 'We sent two small deposits to your account ending 6620 on Oct 6. Enter the amounts to confirm the account. Deposits usually arrive in 1–2 business days.', cta: { label: 'Confirm deposits', to: href('seller/finance'), variant: 'primary' } },
  { id: 'product', title: 'First product or offer submitted', state: 'done', status: 'Done', tone: 'success', body: '5 submitted: 2 approved, 2 in review, 1 needs changes.', cta: { label: 'Fix 1 product', to: href('seller/product-new', 'changes-requested'), variant: 'secondary' } },
  { id: 'launch', title: 'Launch readiness review', state: 'lock', status: 'Not started', tone: '', body: 'Unlocks after payout verification. Your Seller Manager checks stock, shipping and service settings, then activates eligible offers. Usually 1 business day.', cta: { label: 'Request review', variant: 'secondary' } },
];

const DOT_ICON: Record<StepState, IconName> = { done: 'check', warn: 'clock', lock: 'lock' };

const GO_LIVE = [
  { name: 'Halden Pocket Bluetooth Speaker, Teal', note: 'Will go live', status: 'Approved' },
  { name: 'Halden Aurora ANC Headphones, Midnight black', note: 'Will go live', status: 'Approved' },
  { name: 'Northwind Studio Cable Kit', note: 'Waits for approval', status: 'Submitted' },
  { name: 'Lumen B5 Bookshelf Speakers', note: 'Waits for approval', status: 'Submitted' },
  { name: 'Ferro HD-60 Studio Monitor Headphones', note: 'Stays unpublished', status: 'Changes requested' },
];

/** Help articles (seller/help-article slugs). */
const HELP: Array<{ icon: IconName; label: string; slug: string }> = [
  { icon: 'book-open', label: 'Fees and payout timing', slug: 'payout-schedule-and-cutoffs' },
  { icon: 'image', label: 'Product image standards', slug: 'photo-and-title-rules' },
  { icon: 'truck', label: 'Dispatch deadlines and late shipments', slug: 'dispatch-deadline-rules' },
  { icon: 'file-pen', label: 'Fixing a rejected or returned submission', slug: 'fix-a-rejected-or-changes-requested-product' },
];

export default function Setup() {
  const [steps, setSteps] = useState(STEPS);
  const [requested, setRequested] = useState(false);
  const done = steps.filter((s) => s.state === 'done').length;
  const pct = Math.round((done / steps.length) * 100);
  const approved = GO_LIVE.filter((p) => p.status === 'Approved').length;
  const approvedPct = Math.round((approved / GO_LIVE.length) * 100);
  const inReview = GO_LIVE.filter((p) => p.status === 'Submitted').length;
  const changes = GO_LIVE.filter((p) => p.status === 'Changes requested').length;
  // The launch review unlocks once every other step is done.
  const launchReady = steps.every((s) => s.id === 'launch' || s.state === 'done');

  const requestReview = () => {
    setRequested(true);
    setSteps((list) => list.map((s) => (s.id === 'launch' ? { ...s, state: 'warn', status: 'In review', tone: 'info', body: 'Your Seller Manager is checking stock, shipping and service settings. Usually 1 business day.' } : s)));
    announce('Launch readiness review requested');
  };

  return (
    <SellerLayout active="setup">
      <div className="page-head">
        <div className="t">
          <h1 className="h1">Set up Northwind Audio</h1>
          <p className="sub small">Your seller account was approved on Oct 5, 2026. Finish these steps so your approved offers can go live.</p>
        </div>
        <div className="actions">
          <Button variant="secondary" size="sm" icon="life-buoy" to={href('seller/help', 'contact-seller-support')}>
            Contact seller support
          </Button>
        </div>
      </div>
      <div className="sa-ind">
        <div className="card pad">
          <span className="xs muted strong">Account status</span>
          <div className="row gap-2">
            <Badge tone="success">Approved</Badge>
            <span className="xs muted">since Oct 5</span>
          </div>
          <p className="small sub">You can manage your store, products and settings.</p>
        </div>
        <div className="card pad">
          <span className="xs muted strong">Product approval</span>
          <div className="row between base">
            <span className="h3 num">
              {approved} of {GO_LIVE.length} approved
            </span>
            <span className="xs muted">{approvedPct}%</span>
          </div>
          <Meter pct={approvedPct} label={`${approved} of ${GO_LIVE.length} approved ${approvedPct}%`} />
          <p className="xs muted">
            {inReview} in review · {changes} changes requested
          </p>
        </div>
        <div className="card pad">
          <span className="xs muted strong">Payout readiness</span>
          <div className="row gap-2">
            <Badge tone="warning">Verification pending</Badge>
          </div>
          <p className="small sub">Payouts start after you confirm the test deposits. Sales before then are held as pending earnings.</p>
        </div>
      </div>
      <Alert tone="info" title="Approval does not publish your products">
        Customers only see an offer when its product is approved, the offer is complete with stock, and your launch readiness review is passed. Incomplete or unapproved products stay unpublished.
      </Alert>
      <div className="sa-split">
        <Card
          title="Setup checklist"
          sub={`${done} of ${steps.length} complete`}
          actions={
            <span style={{ width: 140 }}>
              <Meter pct={pct} label="Setup checklist" />
            </span>
          }
          flush
        >
          <ol className="sa-steplist">
            {steps.map((s) => (
              <li key={s.id}>
                <span className={cx('sa-dot', `is-${s.state}`)} aria-hidden="true">
                  {s.state === 'warn' && <span className="sr-only">At risk: </span>}
                  <Icon name={DOT_ICON[s.state]} className="ic-sm" />
                </span>
                <div className="stack gap-1">
                  <div className="row gap-2">
                    <h3 className="h4">{s.title}</h3>
                    <Badge tone={s.tone}>{s.status}</Badge>
                  </div>
                  <p className="small sub">{s.body}</p>
                </div>
                <div className="sa-cta">
                  {s.cta.to ? (
                    <Button variant={s.cta.variant} size="sm" to={s.cta.to}>
                      {s.cta.label}
                    </Button>
                  ) : (
                    <Button variant={s.cta.variant} size="sm" disabled={!launchReady || requested} onClick={requestReview}>
                      {requested ? 'Review requested' : s.cta.label}
                    </Button>
                  )}
                </div>
              </li>
            ))}
          </ol>
        </Card>
        <div className="stack gap-5">
          <Card title="What goes live after review" titleAs="h3" sub="Only approved products with a complete offer" flush>
            <ul className="list pad">
              {GO_LIVE.map((p) => (
                <li key={p.name}>
                  <span className="grow stack gap-0">
                    <span className="small strong">{p.name}</span>
                    <span className="xs muted">{p.note}</span>
                  </span>
                  <StatusBadge status={p.status} />
                </li>
              ))}
            </ul>
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
            <div className="divider" />
            <div className="row gap-3">
              <Avatar name="Grace Kim" />
              <div className="stack gap-0">
                <span className="small strong">Grace Kim</span>
                <span className="xs muted">Your Seller Manager · replies within 1 business day</span>
              </div>
            </div>
          </Card>
        </div>
      </div>
    </SellerLayout>
  );
}
