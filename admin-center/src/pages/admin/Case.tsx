import { useState, type ReactNode } from 'react';
import { Link } from 'react-router';
import { AdminLayout } from '@marketly/web-shared/layouts';
import { cx } from '@marketly/web-shared/lib/cx';
import { money } from '@marketly/web-shared/lib/format';
import { useView } from '@marketly/web-shared/lib/hooks';
import { href } from '@marketly/web-shared/routes';
import {
  Alert, Avatar, Badge, Button, Card, Checkbox, Deadline, Field, Icon, Img, KeyValue, LogoTile, OptionCard, PageHeader, Price, SegmentedControl, Select, StatusBadge, Textarea, TextInput, announce,
  type IconName, type Tone,
} from '@marketly/web-shared/ui';

// Design: pages/admin/admin-case.html (investigating) · view "decision-recorded" = after "Record decision and send to Finance".

const OWNER = 'Isabel Cruz';
const MAX_REFUND = 114.54;
const ITEM_PRICE = 119;
const COUPON_SHARE = 4.46;
// Split of a full item refund (seller earnings reversed, marketplace fee returned); scaled for smaller refunds.
const SELLER_SHARE = 104.72;
const FEE_SHARE = 14.28;

/* ---------------- Evidence ---------------- */

interface Ev {
  t: string;
  d: string;
  state: 'done' | 'current' | 'warn' | 'danger';
  body?: string;
}

const SHIPMENT: Ev[] = [
  { t: 'Order accepted', d: 'Sep 14, 7:42 PM', state: 'done' },
  { t: 'Dispatch deadline missed', d: 'Sep 16, 5:00 PM', state: 'danger', body: 'No shipment recorded. Seller reminder sent automatically.' },
  { t: 'Seller set new ship date: Oct 5', d: 'Sep 24, 10:02 AM', state: 'warn', body: 'Reason given: backordered from the mill.' },
  { t: 'Label created', d: 'Oct 5, 4:48 PM', state: 'warn', body: 'USPS Ground Advantage 9400 1118 9922 3456 7821 04 · no carrier scan' },
];

const HISTORY: Ev[] = [
  { t: 'Problem reported on the order', d: 'Sep 23 · by customer', state: 'done' },
  { t: 'Escalated to dispute', d: 'Oct 6, 7:41 AM · by customer', state: 'done' },
  { t: 'Assigned to Isabel Cruz', d: 'Oct 6, 8:05 AM · by Mateo Ruiz', state: 'done' },
  { t: 'Seller hold placed: $1,240.00', d: 'Oct 6 · Finance · review Oct 15', state: 'done' },
];

const PHOTOS: Array<{ icon: IconName; tint: string; caption: string }> = [
  { icon: 'package', tint: '3', caption: 'Seller: packed parcel, Oct 5' },
  { icon: 'receipt', tint: '5', caption: 'Seller: label printout, Oct 5' },
  { icon: 'smartphone', tint: '2', caption: 'Customer: order page showing Sep 22 estimate' },
];

/** Timeline with the design's "At risk:" prefix on warning events (the shared Timeline has none). */
function EvTimeline({ events }: { events: Ev[] }) {
  return (
    <ol className="timeline">
      {events.map((e, i) => (
        <li key={i} className={`ev is-${e.state}`}>
          {e.state === 'warn' && <span className="sr-only">At risk: </span>}
          <span className="dot" aria-hidden="true" />
          <div className="stack gap-1">
            <span className="t">{e.t}</span>
            <span className="d">{e.d}</span>
            {e.body && <div className="small sub">{e.body}</div>}
          </div>
        </li>
      ))}
    </ol>
  );
}

/* ---------------- Conversation ---------------- */

type MsgKind = 'customer' | 'seller' | 'staff' | 'note';
interface Msg {
  kind: MsgKind;
  who: string;
  badge: string;
  tone: Tone;
  when: string;
  text: string;
}

const MESSAGES: Msg[] = [
  { kind: 'customer', who: 'Jordan Lee', badge: 'Customer', tone: '', when: 'Sep 23, 8:14 PM', text: 'My duvet cover was due Sep 22 and the order still says Preparing. When will it ship?' },
  { kind: 'seller', who: 'Marta Reyes, Casa Verde Home', badge: 'Seller', tone: 'info', when: 'Sep 24, 10:02 AM', text: 'Sorry for the wait. The sage queen is backordered from our mill. We expect to ship on Oct 5 and will send tracking.' },
  { kind: 'customer', who: 'Jordan Lee', badge: 'Customer', tone: '', when: 'Oct 6, 7:40 AM', text: 'It is Oct 6 and there is still no tracking. I would like a refund instead.' },
  { kind: 'seller', who: 'Marta Reyes, Casa Verde Home', badge: 'Seller', tone: 'info', when: 'Oct 6, 9:15 AM', text: 'We printed the label on Oct 5 and the carrier picks up on Oct 8. We would prefer to ship the order.' },
  { kind: 'staff', who: OWNER, badge: 'Marketly staff', tone: 'brand', when: 'Oct 6, 11:30 AM · to both parties', text: 'I am reviewing this dispute. Casa Verde Home, please share proof of carrier pickup by Oct 8, 12:00 PM PT. Jordan, you will have a decision from us by Oct 9.' },
  { kind: 'note', who: OWNER, badge: 'Internal note', tone: 'warning', when: 'Oct 7, 4:05 PM', text: 'Seller missed two dispatch promises. Leaning toward a refund unless a carrier scan appears before noon on Oct 8.' },
  { kind: 'note', who: 'Grace Kim', badge: 'Internal note · Seller Manager', tone: 'warning', when: 'Oct 7, 5:20 PM', text: 'Casa Verde on-time dispatch is down to 91% this month. Performance review opened. No restriction for now.' },
];

type Audience = 'both' | 'customer' | 'seller' | 'note';
const AUDIENCES: Array<{ value: Audience; label: string }> = [
  { value: 'both', label: 'Reply to both' },
  { value: 'customer', label: 'Customer only' },
  { value: 'seller', label: 'Seller only' },
  { value: 'note', label: 'Internal note' },
];
const AUDIENCE_TO: Record<Exclude<Audience, 'note'>, string> = { both: 'to both parties', customer: 'to customer', seller: 'to seller' };

/* ---------------- Decision ---------------- */

type Remedy = 'refund' | 'replace' | 'partial';
const REMEDIES: Array<{ value: Remedy; title: string; body: string; summary: string }> = [
  { value: 'refund', title: 'Refund the item', body: 'Customer keeps the order if it arrives and may return it free', summary: 'full item refund' },
  { value: 'replace', title: 'Replacement by a deadline', body: 'Seller ships with tracking by Oct 12; refund if no carrier scan', summary: 'replacement by Oct 12' },
  { value: 'partial', title: 'Partial refund', body: 'For a delay the customer accepts', summary: 'partial refund' },
];
const DECISIONS = ['Customer favored', 'Seller favored', 'Shared outcome', 'Request more information'];
const CHARGED = ['Seller: late dispatch', 'Platform: goodwill', 'Shared'];
const CHARGED_TEXT: Record<string, string> = { 'Seller: late dispatch': 'the seller for late dispatch', 'Platform: goodwill': 'Marketly as goodwill', Shared: 'the seller and Marketly' };

interface Draft {
  decision: string;
  remedy: Remedy;
  amount: string;
  charged: string;
  reason: string;
  appeal: string;
  notify: boolean;
}

const DEFAULT_REASON = 'Casa Verde Home missed the Sep 16 dispatch deadline and the Oct 5 ship date. The label was created on Oct 5 but has no carrier scan. Under the purchase terms, a late item can be refunded.';
const DEFAULT_DRAFT: Draft = { decision: 'Customer favored', remedy: 'refund', amount: '114.54', charged: CHARGED[0], reason: DEFAULT_REASON, appeal: 'Oct 15, 2026, 11:59 PM PT', notify: true };

const refundOf = (d: Draft) => (d.remedy === 'replace' ? 0 : Number(d.amount.replace(/[$,\s]/g, '')) || 0);
const ratio = (d: Draft) => refundOf(d) / MAX_REFUND;

function validate(d: Draft) {
  const e: Partial<Record<keyof Draft, string>> = {};
  if (d.remedy !== 'replace') {
    const n = Number(d.amount.replace(/[$,\s]/g, ''));
    if (!d.amount.trim() || Number.isNaN(n) || n <= 0) e.amount = 'Enter the refund amount.';
    else if (n > MAX_REFUND) e.amount = `The most you can refund for this item is ${money(MAX_REFUND)}.`;
  }
  if (!d.reason.trim()) e.reason = 'Enter the reason. Both parties see it with the decision.';
  if (!d.appeal.trim()) e.appeal = 'Enter the appeal deadline.';
  return e;
}

function decisionMessage(d: Draft): Msg {
  const amt = money(refundOf(d));
  const what =
    d.remedy === 'replace'
      ? 'Casa Verde Home ships a replacement with tracking by Oct 12, or Jordan Lee gets a full refund.'
      : `${d.remedy === 'refund' ? 'full' : 'partial'} refund of ${amt} to Jordan Lee, charged to ${CHARGED_TEXT[d.charged]}. The refund is being processed and usually arrives in 3–5 business days.`;
  return { kind: 'staff', who: OWNER, badge: 'Marketly staff', tone: 'brand', when: 'Oct 8, 10:33 AM · to both parties', text: `Decision: ${what} Either party can appeal until ${d.appeal}.` };
}

function SumList({ rows }: { rows: Array<[string, ReactNode]> }) {
  return (
    <div className="ab-sumlist">
      {rows.map(([k, v]) => (
        <div key={k}>
          <span>{k}</span>
          <span>{v}</span>
        </div>
      ))}
    </div>
  );
}

export default function Case() {
  const [view, setView] = useView<'decision-recorded'>();
  const decided = view === 'decision-recorded';
  const [draft, setDraft] = useState<Draft>(DEFAULT_DRAFT);
  const [recorded, setRecorded] = useState<Draft | null>(null);
  const [attempted, setAttempted] = useState(false);
  const [msgs, setMsgs] = useState<Msg[]>(MESSAGES);
  const [audience, setAudience] = useState<Audience>('both');
  const [reply, setReply] = useState('');
  const [replyErr, setReplyErr] = useState('');

  const shown = recorded ?? DEFAULT_DRAFT;
  const errors = attempted ? validate(draft) : {};
  const set = <K extends keyof Draft>(k: K, v: Draft[K]) => setDraft((d) => ({ ...d, [k]: v }));
  const r = ratio(draft);

  const record = () => {
    setAttempted(true);
    if (Object.keys(validate(draft)).length) return;
    setRecorded(draft);
    setView('decision-recorded');
    announce('Decision recorded and sent to Finance');
  };

  const send = () => {
    if (!reply.trim()) {
      setReplyErr('Write a message before sending.');
      return;
    }
    setMsgs((m) => [
      ...m,
      audience === 'note'
        ? { kind: 'note', who: OWNER, badge: 'Internal note', tone: 'warning', when: 'Just now', text: reply.trim() }
        : { kind: 'staff', who: OWNER, badge: 'Marketly staff', tone: 'brand', when: `Just now · ${AUDIENCE_TO[audience]}`, text: reply.trim() },
    ]);
    setReply('');
    setReplyErr('');
  };

  const conversation = decided && shown.notify ? [...msgs, decisionMessage(shown)] : msgs;
  const shownRefund = refundOf(shown);
  const shownSeller = SELLER_SHARE * ratio(shown);
  const remedy = REMEDIES.find((x) => x.value === shown.remedy)!;

  return (
    <AdminLayout active="cases">
      <PageHeader
        crumbs={[{ label: 'Cases and disputes', to: href('admin/cases') }, { label: 'CS-104882' }]}
        eyebrow="Dispute · delayed item"
        title="Dispute CS-104882"
        sub={
          <>
            Order{' '}
            <Link className="mono nowrap" to={href('admin/order')}>
              MK-260914-48213
            </Link>{' '}
            · Mosswood Washed Linen Duvet Cover, Queen · opened Sep 23 · escalated to dispute Oct 6
          </>
        }
        actions={
          <>
            <StatusBadge status={decided ? 'Decision made' : 'Waiting on seller'} />
            <Badge tone="danger" icon="arrow-up">
              High
            </Badge>
            <Button variant="secondary" size="sm" icon="user-round">
              Reassign
            </Button>
            <Button variant="secondary" size="sm" icon="arrow-up-right">
              Escalate
            </Button>
          </>
        }
      />
      <div className="card pad">
        <div className="row between gap-4">
          {decided ? (
            <>
              <span className="row gap-2">
                <Icon name="circle-check" />
                <span className="stack gap-0">
                  <b className="small">Decision published Oct 8, 10:33 AM</b>
                  <span className="xs muted">Next: confirm refund Sent · appeal window open until Oct 15</span>
                </span>
              </span>
              <Deadline>Appeal window: 7 days</Deadline>
            </>
          ) : (
            <>
              <span className="row gap-4">
                <Deadline tone="warning">Seller evidence due 12:00 PM · 2 h 20 m</Deadline>
                <Deadline>Reply promised to customer: Oct 9, 9:00 AM</Deadline>
                <Deadline>Decision target: Oct 13</Deadline>
              </span>
              <span className="xs muted">Owner Isabel Cruz · Finance reviewer Priya Nair</span>
            </>
          )}
        </div>
      </div>
      <div className="ab-main wide">
        <div className="stack gap-5">
          <div className="grid md2 gap-4">
            <Card title="Customer">
              <div className="row gap-3">
                <Avatar name="Jordan Lee" />
                <span className="ab-cell">
                  <span className="strong">
                    <Link to={href('admin/customers', 'customer-detail')}>Jordan Lee</Link>
                  </span>
                  <span className="xs muted">Portland, OR · 5 orders · 1 open case</span>
                </span>
              </div>
              <KeyValue pairs={[['Asks for', 'Full refund'], ['Contact', 'jordan.lee@example.com']]} />
            </Card>
            <Card title="Seller" titleAs="h3">
              <div className="row gap-3">
                <LogoTile initials="CV" tint="1" />
                <span className="ab-cell">
                  <span className="strong">
                    <Link to={href('admin/seller')}>Casa Verde Home</Link>
                  </span>
                  <span className="xs muted">Sacramento, CA · Verified seller</span>
                </span>
              </div>
              <KeyValue pairs={[['Offers', 'Ship the order on Oct 8'], ['On-time dispatch', <span className="t-warning-text">91% this month</span>]]} />
            </Card>
          </div>
          <Card title="Purchase terms at time of order" titleAs="h3" sub="Snapshot taken Sep 14, 2026, 7:42 PM · purchase terms v3.2">
            <div className="row top gap-4">
              <Img icon="bed-double" tint="1" className="thumb" />
              <div className="grow">
                <KeyValue
                  pairs={[
                    ['Item', 'Mosswood Washed Linen Duvet Cover, Queen · Sage · SKU MSW-LIN-Q-SAGE'],
                    [
                      'Price paid',
                      <>
                        <Price amount={ITEM_PRICE} was={149} /> <span className="xs muted">seller markdown, plus {money(COUPON_SHARE)} share of WELCOME20</span>
                      </>,
                    ],
                    ['Promised delivery', 'Mon, Sep 22 · dispatch within 2 business days (by Sep 16)'],
                    ['Shipping', 'Free · ships from seller, Sacramento, CA'],
                    ['Returns', '30-day returns · seller pays return shipping for late, damaged or incorrect items'],
                    ['Payment', 'Visa •••• 4417 · Accepted Sep 14'],
                  ]}
                />
              </div>
            </div>
          </Card>
          <Card title="Shipment evidence" titleAs="h3">
            <EvTimeline events={[...SHIPMENT, decided ? { t: 'Still no carrier scan at decision time', d: 'Checked Oct 8, 9:00 AM', state: 'current' } : { t: 'No carrier scan yet', d: 'Checked Oct 8, 9:00 AM', state: 'current' }]} />
          </Card>
          <Card title="Photos and files" titleAs="h3" sub="3 files · uploaded by parties">
            <div className="ab-photos">
              {PHOTOS.map((p) => (
                <figure key={p.caption}>
                  <Img icon={p.icon} tint={p.tint} className="r43" />
                  <figcaption>{p.caption}</figcaption>
                </figure>
              ))}
            </div>
          </Card>
          <Card title="Conversation" titleAs="h3" sub="Customer, seller and staff messages in one place. Internal notes are never shown to the parties.">
            <div className="ab-conv">
              {conversation.map((m, i) => (
                <div key={i} className={`ab-msg is-${m.kind}`}>
                  <span className="who">
                    <b>{m.who}</b>
                    <Badge tone={m.tone}>{m.badge}</Badge>
                    <span>{m.when}</span>
                  </span>
                  <p>{m.text}</p>
                </div>
              ))}
            </div>
            <div className="stack gap-2">
              <SegmentedControl items={AUDIENCES} active={audience} onChange={setAudience} />
              <Field label="Message" error={replyErr || undefined}>
                <Textarea
                  id="cd-reply"
                  placeholder={audience === 'note' ? 'Write an internal note' : 'Write a reply'}
                  value={reply}
                  onChange={(e) => {
                    setReply(e.target.value);
                    if (replyErr) setReplyErr('');
                  }}
                />
              </Field>
              <div className="row between">
                <Button variant="ghost" size="sm" icon="paperclip">
                  Attach file
                </Button>
                <Button size="sm" icon="send" onClick={send}>
                  Send
                </Button>
              </div>
            </div>
          </Card>
        </div>
        <div className="stack gap-5">
          {decided ? (
            <Card
              title="Decision"
              titleAs="h3"
              sub={`Recorded Oct 8, 10:12 AM by ${OWNER}`}
              foot={
                <>
                  <Button variant="secondary" size="sm" onClick={() => document.getElementById('cd-reply')?.focus()}>
                    Add update
                  </Button>
                  <Button size="sm" disabled>
                    Resolve case
                  </Button>
                </>
              }
            >
              <Alert tone="success" title={`${shown.decision}: ${remedy.summary}`}>
                {shown.reason === DEFAULT_REASON ? 'Seller missed the dispatch deadline and two later promises. No carrier scan as of Oct 8, 9:00 AM.' : shown.reason}
              </Alert>
              <SumList
                rows={[
                  ['Refund to customer', <b>{money(shownRefund)}</b>],
                  ['Item price paid', money(ITEM_PRICE)],
                  ['Coupon share (platform funded)', `−${money(COUPON_SHARE)}`],
                  ['Charged to seller earnings', `−${money(shownSeller)}`],
                  ['Marketplace fee returned', money(FEE_SHARE * ratio(shown))],
                ]}
              />
              <div className="divider" />
              <ul className="ab-approvals">
                <li>
                  <span className="n is-done">
                    <Icon name="check" className="ic-sm" />
                  </span>
                  <span className="ab-cell">
                    <span className="strong">Isabel Cruz · Support</span>
                    <span className="xs muted">Decision recorded 10:12 AM</span>
                  </span>
                  <StatusBadge status="Decision made" />
                </li>
                <li>
                  <span className="n is-done">
                    <Icon name="check" className="ic-sm" />
                  </span>
                  <span className="ab-cell">
                    <span className="strong">Priya Nair · Finance</span>
                    <span className="xs muted">Remedy approved 10:31 AM · limit $2,000</span>
                  </span>
                  <StatusBadge status="Approved" />
                </li>
                <li>
                  <span className="n">
                    <Icon name="loader" className="ic-sm" />
                  </span>
                  <span className="ab-cell">
                    <span className="strong">Refund RF-261008-0447</span>
                    <span className="xs muted">Visa •••• 4417 · 3–5 business days</span>
                  </span>
                  <StatusBadge status="Processing" />
                </li>
              </ul>
              <Alert tone="info" title="Refund approved, not yet received">
                The customer sees Processing until the card network confirms. The case stays open until the refund shows Sent.
              </Alert>
              <KeyValue
                pairs={[
                  ['Appeal deadline', <b>{shown.appeal}</b>],
                  ['Published to', shown.notify ? 'Jordan Lee and Casa Verde Home · Oct 8, 10:33 AM' : 'Not sent yet: use Add update to notify the parties'],
                  ['Seller statement', `Deduction −${money(shownSeller)} on the Oct 16 statement`],
                  ['Appeal reviewer', 'Grace Kim (not the original decider)'],
                ]}
              />
            </Card>
          ) : (
            <Card
              title="Decision"
              titleAs="h3"
              sub="Decision target: Oct 13 · 5 business days from escalation"
              foot={
                <>
                  <Button variant="ghost" size="sm" onClick={() => announce('Draft saved')}>
                    Save draft
                  </Button>
                  <Button size="sm" onClick={record}>
                    Record decision and send to Finance
                  </Button>
                </>
              }
            >
              <Field label="Decision">
                <Select id="cd-dec" options={DECISIONS} value={draft.decision} onChange={(e) => set('decision', e.target.value)} />
              </Field>
              <fieldset className="stack gap-2 fieldset-reset">
                <legend className="label">Remedy</legend>
                {REMEDIES.map((m, i) => (
                  <OptionCard
                    key={m.value}
                    id={`cd-rem-${i + 1}`}
                    name="cd-rem"
                    title={<span className="small strong">{m.title}</span>}
                    body={m.body}
                    checked={draft.remedy === m.value}
                    onChange={() => set('remedy', m.value)}
                  />
                ))}
              </fieldset>
              <Field
                label="Refund amount"
                hint={`Maximum refundable for this item: ${money(MAX_REFUND)} (price ${money(ITEM_PRICE)} less ${money(COUPON_SHARE)} coupon share). Shipping was free.`}
                error={errors.amount}
              >
                <TextInput id="cd-amt" prefix="$" value={draft.amount} error={!!errors.amount} inputMode="decimal" disabled={draft.remedy === 'replace'} onChange={(e) => set('amount', e.target.value)} />
              </Field>
              <Field label="Charged to">
                <Select id="cd-who" options={CHARGED} value={draft.charged} onChange={(e) => set('charged', e.target.value)} />
              </Field>
              <div className="panel stack gap-1 small">
                <div className="sum-row">
                  <span>Seller earnings</span>
                  <span>−{money(SELLER_SHARE * r)}</span>
                </div>
                <div className="sum-row">
                  <span>Marketplace fee returned</span>
                  <span>{money(FEE_SHARE * r)}</span>
                </div>
                <div className="sum-row">
                  <span>Platform coupon recovered</span>
                  <span>{money(COUPON_SHARE * r)}</span>
                </div>
              </div>
              {refundOf(draft) > 50 && (
                <Alert tone="warning" title="Finance approval needed">
                  Your goodwill limit is $50.00. This remedy goes to Priya Nair, Finance Manager (limit $2,000), before the refund is sent.
                </Alert>
              )}
              <Field label="Reason shared with both parties" error={errors.reason}>
                <Textarea id="cd-why" placeholder="" className={cx(errors.reason && 'is-error')} value={draft.reason} onChange={(e) => set('reason', e.target.value)} />
              </Field>
              <Field label="Appeal deadline" hint="7 days from the decision. Published to the customer and the seller." error={errors.appeal}>
                <TextInput id="cd-appeal" icon="calendar" value={draft.appeal} error={!!errors.appeal} onChange={(e) => set('appeal', e.target.value)} />
              </Field>
              <Checkbox id="cd-notify" label="Notify Jordan Lee and Casa Verde Home with the decision and appeal route" checked={draft.notify} onChange={(e) => set('notify', e.target.checked)} />
            </Card>
          )}
          <Card title="Case history" titleAs="h3">
            <EvTimeline
              events={[
                ...HISTORY,
                decided ? { t: 'Decision recorded and approved', d: 'Oct 8, 10:31 AM', state: 'current' } : { t: 'Waiting for seller evidence', d: 'Due Oct 8, 12:00 PM', state: 'current' },
              ]}
            />
          </Card>
        </div>
      </div>
    </AdminLayout>
  );
}
