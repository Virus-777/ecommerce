import { useRef, useState } from 'react';
import { Link } from 'react-router';
import { P } from '@marketly/web-shared/data/fixtures';
import { AccountLayout } from '@/layouts';
import { money } from '@marketly/web-shared/lib/format';
import { useView } from '@marketly/web-shared/lib/hooks';
import { href } from '@marketly/web-shared/routes';
import { Alert, Avatar, Breadcrumbs, Button, Dialog, Field, Icon, Img, KeyValue, Select, StatusBadge, Textarea, Timeline, Track, type TimelineEvent } from '@marketly/web-shared/ui';

// Design: pages/store/help-case.html (open, waiting on seller) · view "decision-made" = help-case--decision-made.html.
// The decision is made by Marketly staff (admin/case); here the shopper replies, and appeals once decided.

type Who = 'customer' | 'seller' | 'staff';

interface Message {
  who: Who;
  name: string;
  at: string;
  text: string;
  files?: string[];
}

const ROLE: Record<Who, { badge: string; tone: 'brand' | 'warning' | 'info'; avatarClass?: string }> = {
  customer: { badge: 'You', tone: 'brand' },
  seller: { badge: 'Seller', tone: 'warning', avatarClass: 'sq' },
  staff: { badge: 'Marketly support', tone: 'info' },
};

const THREAD: Message[] = [
  { who: 'customer', name: 'Jordan Lee', at: 'Tue, Oct 6, 4:10 PM', text: "My duvet cover was due Sep 22 and still hasn't shipped. There's no tracking number on the order. Can you tell me when it will arrive?" },
  { who: 'seller', name: 'Casa Verde Home', at: 'Wed, Oct 7, 9:32 AM', text: "Sorry for the wait, Jordan. Our sage linen restock arrives Oct 9. We'll ship on Oct 10 and expect delivery by Oct 12. We'll add tracking as soon as it leaves." },
  { who: 'staff', name: 'Isabel Cruz', at: 'Wed, Oct 7, 11:05 AM', text: "I'm following this case. If the duvet hasn't shipped by Oct 10, you can choose a full refund and we'll make sure it happens. You don't need to do anything right now." },
  { who: 'customer', name: 'Jordan Lee', at: 'Wed, Oct 7, 11:40 AM', text: 'Thanks. Attaching the original confirmation showing the Sep 22 date.', files: ['order-confirmation.png'] },
];

const DECISION_THREAD: Message[] = [
  ...THREAD,
  { who: 'seller', name: 'Casa Verde Home', at: 'Thu, Oct 8, 8:15 AM', text: "Our supplier has delayed the restock again and we can't give a firm ship date. We're sorry." },
  { who: 'staff', name: 'Isabel Cruz', at: 'Thu, Oct 8, 10:20 AM', text: "We've made a decision on this case: a full refund of $119.00 for the duvet cover. Details are at the top of this page. The rest of your order isn't affected." },
];

const OPEN_TIMELINE: TimelineEvent[] = [
  { t: 'Case opened', d: 'Oct 6, 4:10 PM', state: 'done' },
  { t: 'Sent to Casa Verde Home', d: 'Oct 6, 4:10 PM', state: 'done' },
  { t: 'Seller replied', d: 'Oct 7, 9:32 AM', state: 'done', body: 'New ship date Oct 10' },
  { t: 'Marketly support joined', d: 'Oct 7, 11:05 AM', state: 'done' },
  { t: 'Waiting on seller: tracking or refund', d: 'Due Oct 9, 5:00 PM PT', state: 'current' },
  { t: 'Marketly steps in if no reply', d: 'From Oct 9, 5:00 PM PT' },
];

const DECISION_TIMELINE: TimelineEvent[] = [
  { t: 'Case opened', d: 'Oct 6, 4:10 PM', state: 'done' },
  { t: 'Sent to Casa Verde Home', d: 'Oct 6, 4:10 PM', state: 'done' },
  { t: 'Seller replied', d: 'Oct 7, 9:32 AM', state: 'done' },
  { t: 'Marketly support joined', d: 'Oct 7, 11:05 AM', state: 'done' },
  {
    t: (
      <>
        <span className="sr-only">At risk: </span>Seller missed new ship date
      </>
    ),
    d: 'Oct 8, 8:15 AM',
    state: 'warn',
  },
  { t: 'Decision made: full refund', d: 'Oct 8, 10:20 AM', state: 'done' },
  { t: 'Refund processing', d: 'Sent by Oct 9', state: 'current' },
  { t: 'Appeal window ends', d: 'Oct 22' },
];

const APPEAL_REASONS = ['Choose a reason', 'The refund amount is wrong', 'I want a replacement instead', 'The item arrived after all', 'Something else'];

function Thread({ messages }: { messages: Message[] }) {
  return (
    <div className="buy-thread" aria-live="polite">
      {messages.map((m, i) => {
        const r = ROLE[m.who];
        return (
          <div key={i} className={`buy-msg is-${m.who}`}>
            <Avatar name={m.name} className={r.avatarClass} />
            <div className="bubble">
              <div className="row between gap-2">
                <span className="row gap-2">
                  <span className="small strong">{m.name}</span>
                  <span className={`badge t-${r.tone}`}>{r.badge}</span>
                </span>
                <span className="xs muted">{m.at}</span>
              </div>
              <p>{m.text}</p>
              {m.files && m.files.length > 0 && (
                <span className="row gap-2">
                  {m.files.map((f) => (
                    <span key={f} className="buy-attach">
                      <Icon name="paperclip" className="ic-sm" />
                      {f}
                    </span>
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
  const [view] = useView<'decision-made'>();
  const decided = view === 'decision-made';
  const duvet = P.duvet;

  const [extra, setExtra] = useState<Message[]>([]);
  const [reply, setReply] = useState('');
  const [files, setFiles] = useState<string[]>([]);
  const [replyError, setReplyError] = useState('');
  const [replyOpen, setReplyOpen] = useState(false);
  const fileInput = useRef<HTMLInputElement>(null);

  const [appealOpen, setAppealOpen] = useState(false);
  const [appealed, setAppealed] = useState(false);
  const [reason, setReason] = useState(APPEAL_REASONS[0]);
  const [appealText, setAppealText] = useState('');
  const [appealTried, setAppealTried] = useState(false);
  const appealErrors = appealTried
    ? { reason: reason === APPEAL_REASONS[0] ? 'Choose a reason for the appeal.' : undefined, text: appealText.trim().length < 20 ? 'Explain what you disagree with (at least 20 characters).' : undefined }
    : {};

  const messages = [...(decided ? DECISION_THREAD : THREAD), ...extra];

  const send = () => {
    if (!reply.trim()) {
      setReplyError('Write a message before sending.');
      return;
    }
    setExtra((l) => [...l, { who: 'customer', name: 'Jordan Lee', at: 'Just now', text: reply.trim(), files }]);
    setReply('');
    setFiles([]);
    setReplyError('');
    setReplyOpen(false);
  };

  const submitAppeal = () => {
    setAppealTried(true);
    if (reason === APPEAL_REASONS[0] || appealText.trim().length < 20) return;
    setAppealed(true);
    setAppealOpen(false);
    setExtra((l) => [...l, { who: 'customer', name: 'Jordan Lee', at: 'Just now', text: `Appeal: ${reason}. ${appealText.trim()}` }]);
  };

  const status = decided ? (appealed ? 'Appealed' : 'Decision made') : 'Waiting on seller';

  const replyBox = (
    <section className="card">
      <div className="card-head">
        <div className="stack gap-0">
          <h3 className="h4">Reply</h3>
        </div>
      </div>
      <div className="card-body">
        <Field label="Your message" error={replyError}>
          <Textarea
            id="cs-reply"
            placeholder="Write to Casa Verde Home and Marketly support"
            value={reply}
            onChange={(e) => {
              setReply(e.target.value);
              setReplyError('');
            }}
          />
        </Field>
        {files.length > 0 && (
          <span className="row gap-2">
            {files.map((f, i) => (
              <span key={`${f}${i}`} className="buy-attach">
                <Icon name="paperclip" className="ic-sm" />
                {f}
                <button type="button" className="btn-bare" aria-label={`Remove ${f}`} onClick={() => setFiles((l) => l.filter((_, j) => j !== i))}>
                  <Icon name="x" className="ic-sm" />
                </button>
              </span>
            ))}
          </span>
        )}
        <div className="row between">
          <input ref={fileInput} type="file" hidden accept="image/jpeg,image/png" multiple onChange={(e) => setFiles((l) => [...l, ...Array.from(e.target.files ?? []).map((f) => f.name)])} />
          <Button variant="secondary" size="sm" icon="image-plus" onClick={() => fileInput.current?.click()}>
            Add photos
          </Button>
          <Button icon="send" onClick={send}>
            Send reply
          </Button>
        </div>
      </div>
    </section>
  );

  return (
    <AccountLayout active="cases" title="CS-104882" back={href('help/cases')}>
      <div className="stack gap-2">
        <Breadcrumbs items={[{ label: 'Support cases', to: href('help/cases') }, { label: 'CS-104882' }]} />
        <div className="row between">
          <div className="stack gap-1">
            <span className="row gap-2">
              <span className="mono strong small">CS-104882</span>
              <StatusBadge status={status} />
            </span>
            <h1 className="h1">Linen duvet cover hasn't arrived</h1>
            <span className="xs muted">Opened Tue, Oct 6 · Category: Delivery, late item · Priority: Normal</span>
          </div>
        </div>
      </div>
      {decided ? (
        <div className="buy-owner">
          <div>
            <span className="xs muted">Decided by</span>
            <span className="small strong">Isabel Cruz, Marketly support</span>
            <span className="xs muted">Customer Support team</span>
          </div>
          <div>
            <span className="xs muted">Next action</span>
            <span className="small strong">{appealed ? 'A different team member reviews your appeal' : 'Marketly sends your refund'}</span>
            <span className="xs muted">Nothing needed from you</span>
          </div>
          <div>
            <span className="xs muted">Expected</span>
            <span className="small strong">{appealed ? 'Appeal reply within 3 business days' : 'Refund sent by Fri, Oct 9'}</span>
            <span className="xs muted">{appealed ? 'The refund keeps processing meanwhile' : 'Then 3–5 business days at your bank'}</span>
          </div>
        </div>
      ) : (
        <div className="buy-owner">
          <div>
            <span className="xs muted">Handled by</span>
            <span className="small strong">Casa Verde Home (seller)</span>
            <span className="xs muted">Marketly support is following</span>
          </div>
          <div>
            <span className="xs muted">Next action · who must act</span>
            <span className="small strong">Casa Verde Home confirms tracking or offers a refund</span>
            <span className="xs muted">You don't need to do anything</span>
          </div>
          <div>
            <span className="xs muted">Expected response</span>
            <span className="small strong">By Fri, Oct 9, 5:00 PM PT</span>
            <span className="xs muted">If they miss it, Marketly steps in</span>
          </div>
        </div>
      )}
      <div className="split">
        <div className="stack gap-4">
          {decided && (
            <section className="card">
              <div className="card-head">
                <div className="row gap-2">
                  <Icon name="gavel" />
                  <h2 className="h3">Decision: full refund of {money(duvet.price)}</h2>
                </div>
                <StatusBadge status="Decision made" />
              </div>
              <div className="card-body">
                <p className="small sub">
                  <b>Why:</b> Casa Verde Home couldn't give a ship date for an item already 16 days past its delivery estimate. Under the{' '}
                  <Link to={href('info/policy', 'purchase-terms')} className="link-inline">
                    Purchase terms
                  </Link>{' '}
                  you accepted on Sep 14, items that don't ship within 14 days of the estimate qualify for a full refund. The duvet cover is cancelled; the rest of order MK-260914-48213 continues as normal.
                </p>
                <KeyValue
                  pairs={[
                    ['Remedy', 'Refund $119.00 (item price, shipping was free)'],
                    ['Refund to', 'Visa •••• 4417'],
                    ['Funded by', 'Casa Verde Home, deducted from their earnings'],
                  ]}
                />
                <div className="stack gap-2">
                  <span className="small strong">Refund progress</span>
                  <Track labels={['Requested', 'Approved', 'Processing', 'Sent']} done={3} />
                  <span className="xs muted">Approved means we've agreed to refund you. It isn't money in your account yet. After it's sent, your bank usually takes 3–5 business days.</span>
                </div>
                {appealed ? (
                  <Alert tone="info" title="Appeal submitted">
                    A different Marketly team member is reviewing the case and replies within 3 business days. Your refund keeps processing meanwhile.
                  </Alert>
                ) : (
                  <div className="panel stack gap-2">
                    <span className="small strong">Don't agree? You can appeal until Oct 22</span>
                    <span className="xs sub">A different Marketly team member reviews the case, the order terms and all messages, and replies within 3 business days.</span>
                    <div>
                      <Button variant="secondary" size="sm" icon="scale" onClick={() => setAppealOpen(true)}>
                        Appeal this decision
                      </Button>
                    </div>
                  </div>
                )}
                <p className="xs muted">
                  <b>Reopen rules:</b> this case stays open until the refund is sent. After it closes, you can reopen it within 30 days if the refund doesn't reach you within 5 business days of being sent, or if the duvet arrives anyway and you need help returning it.
                </p>
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
              <Thread messages={messages} />
            </div>
            {decided && !replyOpen && (
              <div className="card-foot">
                <span className="xs muted grow">You can still add a message while the refund is processing.</span>
                <Button variant="secondary" size="sm" icon="message-square" onClick={() => setReplyOpen(true)}>
                  Reply
                </Button>
              </div>
            )}
          </section>
          {(!decided || replyOpen) && replyBox}
        </div>
        <aside className="stack gap-4">
          <section className="card">
            <div className="card-head">
              <div className="stack gap-0">
                <h3 className="h4">Linked item</h3>
              </div>
            </div>
            <div className="card-body">
              <div className="buy-mini">
                <Img icon={duvet.icon} tint={duvet.tint} />
                <div className="stack gap-0">
                  <span className="small strong">{duvet.name}</span>
                  <span className="xs muted">Queen · Sage · Qty 1 · {money(duvet.price)}</span>
                </div>
              </div>
              <KeyValue
                pairs={[
                  [
                    'Order',
                    <Link className="mono" to={href('account/order')}>
                      MK-260914-48213
                    </Link>,
                  ],
                  ['Package', '3 of 3 · Casa Verde Home'],
                  ['Item status', <StatusBadge status={decided ? 'Cancelled' : 'Delayed'} />],
                  ['Estimate', decided ? 'Cancelled Oct 8' : 'Was Sep 22 · now Oct 12'],
                ]}
              />
            </div>
          </section>
          <section className="card">
            <div className="card-head">
              <div className="stack gap-0">
                <h3 className="h4">Attachments</h3>
              </div>
            </div>
            <div className="card-body">
              <span className="buy-attach">
                <Icon name="paperclip" className="ic-sm" />
                order-confirmation.png · 212 KB
              </span>
              {extra.flatMap((m) => m.files ?? []).map((f, i) => (
                <span key={`${f}${i}`} className="buy-attach">
                  <Icon name="paperclip" className="ic-sm" />
                  {f}
                </span>
              ))}
            </div>
          </section>
          <section className="card">
            <div className="card-head">
              <div className="stack gap-0">
                <h3 className="h4">Timeline</h3>
              </div>
            </div>
            <div className="card-body">
              <Timeline events={decided ? (appealed ? [...DECISION_TIMELINE.slice(0, -1), { t: 'Appeal submitted', d: 'Just now', state: 'current' }] : DECISION_TIMELINE) : OPEN_TIMELINE} />
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
            <Button icon="scale" onClick={submitAppeal}>
              Submit appeal
            </Button>
          </>
        }
      >
        <p className="small sub">A different Marketly team member reviews the case, the order terms and all messages, and replies within 3 business days. You can appeal until Oct 22.</p>
        <Field label="Reason" error={appealErrors.reason}>
          <Select id="cs-appeal-reason" options={APPEAL_REASONS} value={reason} onChange={(e) => setReason(e.target.value)} />
        </Field>
        <Field label="What do you disagree with?" hint="Add anything the first decision may have missed." error={appealErrors.text}>
          <Textarea id="cs-appeal-text" value={appealText} onChange={(e) => setAppealText(e.target.value)} />
        </Field>
      </Dialog>
    </AccountLayout>
  );
}
