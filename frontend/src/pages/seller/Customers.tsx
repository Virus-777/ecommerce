import { useRef, useState } from 'react';
import { Link } from 'react-router';
import { SellerLayout } from '@/layouts';
import { cx } from '@/lib/cx';
import { useView } from '@/lib/hooks';
import { href } from '@/routes/href';
import { Alert, Avatar, Badge, Button, Card, Deadline, Field, Icon, Img, Meter, PageHeader, SearchInput, Stars5, StatusBadge, Tabs, Textarea, announce, type IconName } from '@/ui';

// Design: pages/seller/seller-customers.html (order messages) · views: product-questions, feedback (tabs).

type Tab = '' | 'product-questions' | 'feedback';

interface Msg {
  kind: 'buyer' | 'me' | 'note';
  who?: string;
  when?: string;
  text: string;
  icon?: IconName;
}
interface Conv {
  id: string;
  buyer: string;
  order: string;
  item: string;
  orderStatus: string;
  time: string;
  preview: string;
  due: { text: string; tone?: 'warning' | 'danger' };
  replied: boolean;
  thread: Msg[];
  draft: string;
}
interface Question {
  id: string;
  product: string;
  icon: IconName;
  q: string;
  asked: string;
  status: 'Open' | 'Published' | 'Skipped';
  answer: string;
  meta?: string;
}
interface Feedback {
  id: string;
  buyer: string;
  rating: number;
  date: string;
  order: string;
  text: string;
  response: string;
  posted: boolean;
  reported?: boolean;
}

const PRIVATE_NOTE: Msg = { kind: 'note', icon: 'lock', text: 'Private conversation linked to this order. Only you, the buyer and Marketly support can see it.' };

const CONVS: Conv[] = [
  {
    id: 'c1', buyer: 'Alex M.', order: 'MK-261007-10433', item: 'Halden Pocket Speaker × 1', orderStatus: 'Preparing', time: 'Oct 7, 7:40 PM', preview: 'Has my speaker shipped yet? I need it by Saturday.', due: { text: 'Overdue 2 h', tone: 'danger' }, replied: false,
    thread: [PRIVATE_NOTE, { kind: 'buyer', who: 'Alex M.', when: 'Oct 7, 7:40 PM', text: 'Hi, has my speaker shipped yet? I need it by Saturday for a trip.' }, { kind: 'note', icon: 'triangle-alert', text: 'Dispatch deadline for this order was Oct 8, 12:00 PM. It is now overdue.' }],
    draft: 'Sorry for the delay. Your speaker ships today by 5 PM with USPS Priority and should arrive Friday, Oct 9. I’ll add tracking to your order as soon as it is scanned.',
  },
  {
    id: 'c2', buyer: 'Priya K.', order: 'MK-261008-11902', item: 'Halden Aurora ANC Headphones × 1', orderStatus: 'New', time: 'Oct 8, 8:15 AM', preview: 'Can you ship to my work address instead?', due: { text: 'Reply by Oct 9, 8:15 AM', tone: 'warning' }, replied: false,
    thread: [PRIVATE_NOTE, { kind: 'buyer', who: 'Priya K.', when: 'Oct 8, 8:15 AM', text: 'Hi! Can you ship to my work address instead? It’s 815 SW 2nd Ave, Portland.' }, { kind: 'note', icon: 'info', text: 'Address changes before dispatch must be confirmed by the buyer on the order page.' }],
    draft: '',
  },
  {
    id: 'c3', buyer: 'Sam R.', order: 'MK-261008-12077', item: 'Halden Pocket Bluetooth Speaker × 2', orderStatus: 'New', time: 'Oct 8, 9:20 AM', preview: 'Is the teal one the same as in the photos?', due: { text: 'Reply by Oct 9, 9:20 AM' }, replied: false,
    thread: [PRIVATE_NOTE, { kind: 'buyer', who: 'Sam R.', when: 'Oct 8, 9:20 AM', text: 'Is the teal one the same as in the photos? It looks a bit greener on my screen.' }],
    draft: '',
  },
  {
    id: 'c4', buyer: 'Chris T.', order: 'MK-261007-09811', item: 'Halden Aurora ANC Headphones × 1', orderStatus: 'Shipped', time: 'Oct 8, 8:05 AM', preview: 'You: Shipped this morning, tracking is on your order.', due: { text: 'Replied in 1 h' }, replied: true,
    thread: [PRIVATE_NOTE, { kind: 'buyer', who: 'Chris T.', when: 'Oct 8, 7:02 AM', text: 'Any update on shipping?' }, { kind: 'me', who: 'You · Avery Stone', when: 'Oct 8, 8:05 AM', text: 'Shipped this morning, tracking is on your order.' }],
    draft: '',
  },
  {
    id: 'c5', buyer: 'Dana W.', order: 'MK-260926-31840', item: 'Halden Pocket Bluetooth Speaker × 1', orderStatus: 'Return requested', time: 'Oct 5, 6:15 PM', preview: 'You: I approved the return and sent a label.', due: { text: 'Replied in 2 h' }, replied: true,
    thread: [PRIVATE_NOTE, { kind: 'buyer', who: 'Dana W.', when: 'Oct 5, 4:12 PM', text: 'The speaker cuts out after a few minutes. I opened a return.' }, { kind: 'me', who: 'You · Avery Stone', when: 'Oct 5, 6:15 PM', text: 'I approved the return and sent a label.' }],
    draft: '',
  },
];

const TEMPLATES = [
  { label: 'Ship date', text: 'Thanks for your message. Your order ships by 5 PM today and tracking appears on your order as soon as it is scanned.' },
  { label: 'Address change', text: 'We can only ship to the address on the order. Please update it from your order page before we dispatch, and we’ll use the new one.' },
  { label: 'Product detail', text: 'Good question. The color in the photos is accurate under daylight; screens can show it slightly differently.' },
];

const QUESTIONS: Question[] = [
  { id: 'q0', product: 'Halden Pocket Bluetooth Speaker', icon: 'speaker', q: 'Can two of these pair together for stereo?', asked: 'Asked by a shopper · Oct 7', status: 'Open', answer: 'Yes. Press the link button on both speakers within 10 seconds to pair them as a stereo set (left and right).' },
  { id: 'q1', product: 'Halden Aurora ANC Wireless Headphones', icon: 'headphones', q: 'Does the case fit in a laptop bag sleeve?', asked: 'Asked by Marcus J. · Oct 6', status: 'Open', answer: '' },
  { id: 'q2', product: 'Studio Cable Kit', icon: 'cable', q: 'Is the 3.5 mm to 6.35 mm adapter gold plated?', asked: 'Asked by a shopper · Sep 30', status: 'Published', answer: 'Yes. Both ends of the adapter are gold plated, and the kit includes a 2 m braided cable.', meta: 'Northwind Audio · Oct 1 · 14 found this helpful' },
];

const FEEDBACK: Feedback[] = [
  { id: 'f0', buyer: 'Alex M.', rating: 2, date: 'Oct 8', order: 'MK-260921-30418', text: 'Item is fine but it shipped a day late and nobody answered my message.', response: 'Sorry, Alex. Your order shipped a day late and we missed your message. We have added a second person to answer messages so this doesn’t happen again.', posted: false },
  { id: 'f1', buyer: 'Priya K.', rating: 5, date: 'Oct 4', order: 'MK-260929-11406', text: 'Fast shipping, well packed, seller answered within the hour.', response: 'Thank you, Priya. Enjoy the headphones.', posted: true },
  { id: 'f2', buyer: 'Morgan F.', rating: 4, date: 'Sep 30', order: 'MK-260925-28877', text: 'Good communication. Box was a bit crushed but the speaker was fine.', response: '', posted: false },
];

const SHARES = [
  { label: 'Positive (4–5)', pct: 98, tone: 'success' as const },
  { label: 'Neutral (3)', pct: 1, tone: undefined },
  { label: 'Negative (1–2)', pct: 1, tone: 'danger' as const, note: 'Below target' },
];

/** Public text must not carry contact details or outside links (design rules). */
function publicTextError(t: string, empty: string) {
  if (!t.trim()) return empty;
  if (/https?:\/\/|www\.|\.(com|net|org)\b/i.test(t)) return 'Remove the link. Public answers can’t contain outside links.';
  if (/[^\s@]+@[^\s@]+\.[a-z]{2,}/i.test(t) || /\(?\d{3}\)?[\s.-]?\d{3}[\s.-]?\d{4}/.test(t)) return 'Remove the contact details. Keep the conversation on Marketly.';
  return '';
}

export default function Customers() {
  const [view, setView] = useView<Exclude<Tab, ''>>();
  const tab: Tab = view === 'product-questions' || view === 'feedback' ? view : '';

  // Order messages
  const [convs, setConvs] = useState(CONVS);
  const [activeId, setActiveId] = useState('c1');
  const [q, setQ] = useState('');
  const [replyErr, setReplyErr] = useState('');
  const [attached, setAttached] = useState<string[]>([]);
  const [showTemplates, setShowTemplates] = useState(false);
  const fileRef = useRef<HTMLInputElement>(null);
  const active = convs.find((c) => c.id === activeId) ?? convs[0];
  const needle = q.trim().toLowerCase();
  const shown = convs.filter((c) => !needle || c.buyer.toLowerCase().includes(needle) || c.order.toLowerCase().includes(needle));
  const unreplied = convs.filter((c) => !c.replied).length;
  const overdue = convs.filter((c) => !c.replied && c.due.tone === 'danger').length;
  const setDraft = (text: string) => setConvs((l) => l.map((c) => (c.id === active.id ? { ...c, draft: text } : c)));
  const sendReply = () => {
    const err = publicTextError(active.draft, 'Write a reply first.').replace('Public answers', 'Order messages');
    if (err) {
      setReplyErr(err);
      return;
    }
    const text = active.draft.trim() + (attached.length ? ` (attached: ${attached.join(', ')})` : '');
    setConvs((l) => l.map((c) => (c.id === active.id ? { ...c, replied: true, draft: '', preview: `You: ${active.draft.trim()}`, due: { text: 'Replied just now' }, thread: [...c.thread, { kind: 'me', who: 'You · Avery Stone', when: 'Just now', text }] } : c)));
    setAttached([]);
    setReplyErr('');
    announce(`Reply sent to ${active.buyer}`);
  };
  const pick = (id: string) => {
    setActiveId(id);
    setReplyErr('');
    setAttached([]);
    setShowTemplates(false);
  };

  // Product questions
  const [questions, setQuestions] = useState(QUESTIONS);
  const [qErr, setQErr] = useState<Record<string, string>>({});
  const openQs = questions.filter((x) => x.status === 'Open').length;
  const setQuestion = (id: string, patch: Partial<Question>) => setQuestions((l) => l.map((x) => (x.id === id ? { ...x, ...patch } : x)));
  const publish = (x: Question) => {
    const err = publicTextError(x.answer, 'Write an answer before publishing.');
    setQErr((e) => ({ ...e, [x.id]: err }));
    if (err) return;
    setQuestion(x.id, { status: 'Published', answer: x.answer.trim(), meta: 'Northwind Audio · just now' });
    announce('Answer published');
  };

  // Feedback
  const [feedback, setFeedback] = useState(FEEDBACK);
  const [fErr, setFErr] = useState<Record<string, string>>({});
  const needsResponse = feedback.filter((f) => f.rating <= 2 && !f.posted).length;
  const setFb = (id: string, patch: Partial<Feedback>) => setFeedback((l) => l.map((x) => (x.id === id ? { ...x, ...patch } : x)));
  const post = (f: Feedback) => {
    const err = publicTextError(f.response, 'Write a response before posting.');
    setFErr((e) => ({ ...e, [f.id]: err }));
    if (err) return;
    setFb(f.id, { posted: true, response: f.response.trim() });
    announce('Response posted');
  };

  const tabs = [
    { value: '' as Tab, label: 'Order messages', count: unreplied },
    { value: 'product-questions' as Tab, label: 'Product questions', count: openQs },
    { value: 'feedback' as Tab, label: 'Feedback', count: needsResponse },
  ];

  return (
    <SellerLayout active="customers">
      <PageHeader title="Store customers" sub="Order messages are private to each order. Questions and feedback responses are public." />
      <div className="u-mb-calc--1-x-sp-2">
        <Tabs items={tabs} active={tab} onChange={(v) => setView(v as Exclude<Tab, ''>)} />
      </div>

      {tab === '' && (
        <>
          <div className="row gap-3">
            <Badge tone="brand" icon="clock">
              Reply within 24 hours
            </Badge>
            <span className="xs sub">
              Your average this month: 9 h 30 min · {overdue ? `${overdue} conversation overdue` : 'nothing overdue'}
            </span>
          </div>
          <section className="card">
            <div className="sb-inbox">
              <div className="sb-inbox-list">
                <div className="u-p-sp-3-sp-4 u-bb-1px-solid-border">
                  <SearchInput id="cu-q" placeholder="Search buyer or order" value={q} onChange={setQ} />
                </div>
                {shown.map((c) => {
                  const late = !c.replied && c.due.tone === 'danger';
                  return (
                    <a
                      key={c.id}
                      className={cx('sb-conv', c.id === active.id && 'is-active', late && 'is-overdue')}
                      href="#"
                      aria-current={c.id === active.id ? 'true' : undefined}
                      onClick={(e) => {
                        e.preventDefault();
                        pick(c.id);
                      }}
                    >
                      {late && <span className="sr-only">Overdue: </span>}
                      <span className="row between nowrap">
                        <span className="row gap-2 nowrap">
                          <Avatar name={c.buyer} />
                          <span className="stack gap-0">
                            <span className={cx('small', c.replied ? 'strong' : 'bold')}>{c.buyer}</span>
                            <span className="xs muted mono">{c.order}</span>
                          </span>
                        </span>
                        <span className="xs muted nowrap">{c.time}</span>
                      </span>
                      <span className="xs sub truncate">{c.preview}</span>
                      <span>{!c.replied && c.due.tone ? <Deadline tone={c.due.tone}>{c.due.text}</Deadline> : <span className="xs muted">{c.due.text}</span>}</span>
                    </a>
                  );
                })}
                {!shown.length && <p className="small sub u-p-sp-4">No conversations match “{q}”.</p>}
              </div>
              <div className="sb-conv-pane no-phone">
                <div className="hd">
                  <Avatar name={active.buyer} />
                  <div className="stack gap-0 grow">
                    <span className="strong">{active.buyer}</span>
                    <span className="xs sub">
                      Order{' '}
                      <Link className="mono" to={href('seller/order')}>
                        {active.order}
                      </Link>{' '}
                      · {active.item} · <StatusBadge status={active.orderStatus} />
                    </span>
                  </div>
                  {!active.replied && active.due.tone && <Deadline tone={active.due.tone}>{active.due.text}</Deadline>}
                </div>
                <div className="bd sb-thread" aria-live="polite">
                  {active.thread.map((m, i) =>
                    m.kind === 'note' ? (
                      <span key={i} className="sb-sysnote">
                        <Icon name={m.icon ?? 'info'} className="ic-sm" />
                        {m.text}
                      </span>
                    ) : (
                      <div key={i} className={cx('sb-msg', m.kind === 'me' && 'me')}>
                        <span className="who">
                          {m.who}
                          <span className="when">{m.when}</span>
                        </span>
                        <span>{m.text}</span>
                      </div>
                    ),
                  )}
                </div>
                <div className="ft">
                  {!active.replied && active.due.tone === 'danger' && (
                    <Alert tone="danger" title="Reply target missed">
                      You aim to reply within 24 hours, and this buyer also has an overdue dispatch. Reply with a real ship date.
                    </Alert>
                  )}
                  <Field label={`Reply to ${active.buyer}`} error={replyErr}>
                    <Textarea id="cu-reply" placeholder="" value={active.draft} onChange={(e) => (setDraft(e.target.value), setReplyErr(''))} />
                  </Field>
                  {attached.length > 0 && (
                    <div className="row gap-2">
                      {attached.map((n) => (
                        <button key={n} type="button" className="chip" onClick={() => setAttached((a) => a.filter((x) => x !== n))} aria-label={`Remove ${n}`}>
                          <Icon name="paperclip" />
                          {n}
                          <Icon name="x" className="ic-sm" />
                        </button>
                      ))}
                    </div>
                  )}
                  {showTemplates && (
                    <div className="row gap-2" role="group" aria-label="Reply templates">
                      {TEMPLATES.map((t) => (
                        <button key={t.label} type="button" className="chip" onClick={() => (setDraft(t.text), setShowTemplates(false), setReplyErr(''))}>
                          {t.label}
                        </button>
                      ))}
                    </div>
                  )}
                  <div className="row between">
                    <div className="row gap-2">
                      <input ref={fileRef} type="file" hidden multiple onChange={(e) => setAttached((a) => [...a, ...Array.from(e.target.files ?? []).map((f) => f.name)])} />
                      <Button variant="ghost" size="sm" icon="paperclip" onClick={() => fileRef.current?.click()}>
                        Attach
                      </Button>
                      <Button variant="ghost" size="sm" icon="file-text" aria-expanded={showTemplates} onClick={() => setShowTemplates((v) => !v)}>
                        Templates
                      </Button>
                    </div>
                    <Button icon="send" onClick={sendReply}>
                      Send reply
                    </Button>
                  </div>
                  <span className="xs muted">Keep service messages about the order. Promotional messages are not allowed here.</span>
                </div>
              </div>
            </div>
          </section>
        </>
      )}

      {tab === 'product-questions' && (
        <div className="sb-main">
          <div className="stack gap-4">
            {questions.map((x) => (
              <section key={x.id} className="card">
                <div className="card-body">
                  <div className="row top gap-3">
                    <Img icon={x.icon} tint="2" className="tiny" />
                    <div className="stack gap-1 grow">
                      <span className="xs muted">{x.product}</span>
                      <span className="strong">{x.q}</span>
                      <span className="xs muted">{x.asked}</span>
                    </div>
                    <StatusBadge status={x.status} tone={x.status === 'Open' ? 'info' : x.status === 'Published' ? 'success' : ''} />
                  </div>
                  {x.status === 'Open' && (
                    <>
                      <Field label="Your public answer" hint={qErr[x.id] ? undefined : 'Shown on the product page as “Answer from the seller · Northwind Audio”.'} error={qErr[x.id]}>
                        <Textarea id={`cu-ans-${x.id.slice(1)}`} placeholder="Answer the question for every shopper" value={x.answer} onChange={(e) => (setQuestion(x.id, { answer: e.target.value }), setQErr((er) => ({ ...er, [x.id]: '' })))} />
                      </Field>
                      <div className="row end gap-2">
                        <Button variant="ghost" size="sm" onClick={() => (setQuestion(x.id, { status: 'Skipped' }), announce('Question skipped'))}>
                          Skip
                        </Button>
                        <Button size="sm" onClick={() => publish(x)}>
                          Publish answer
                        </Button>
                      </div>
                    </>
                  )}
                  {x.status === 'Published' && (
                    <div className="panel stack gap-1">
                      <span className="row gap-2">
                        <Badge tone="info" icon="store">
                          Answer from the seller
                        </Badge>
                        <span className="xs muted">{x.meta}</span>
                      </span>
                      <span className="small">{x.answer}</span>
                    </div>
                  )}
                  {x.status === 'Skipped' && (
                    <div className="row between">
                      <span className="xs muted">Skipped. Marketly staff or other customers may still answer it.</span>
                      <Button variant="ghost" size="sm" onClick={() => setQuestion(x.id, { status: 'Open' })}>
                        Answer anyway
                      </Button>
                    </div>
                  )}
                </div>
              </section>
            ))}
          </div>
          <Card title="Answering questions">
            <ul className="ul small sub stack gap-1">
              <li>Answers are public and labeled as from Northwind Audio.</li>
              <li>Stick to facts in the product listing. Marketly staff and customers can answer too, each with their own label.</li>
              <li>No personal contact details, outside links or discount codes.</li>
              <li>Order-specific questions belong in order messages.</li>
            </ul>
          </Card>
        </div>
      )}

      {tab === 'feedback' && (
        <div className="sb-main">
          <div className="stack gap-4">
            <section className="card">
              <div className="card-body">
                <div className="row gap-6">
                  <div className="stack gap-0">
                    <span className="h1 num">98%</span>
                    <span className="xs muted">positive · 4,812 ratings · last 12 months</span>
                  </div>
                  <div className="stack gap-1 grow minw-200">
                    {SHARES.map((s) => (
                      <div key={s.label} className="row gap-3 nowrap">
                        <span className="xs u-w-110px">{s.label}</span>
                        <div className="grow">
                          <Meter pct={s.pct} tone={s.tone} label={s.label} />
                          {s.note && <span className="xs strong meter-note t-danger-text">{s.note}</span>}
                        </div>
                        <span className="xs num">{s.pct}%</span>
                      </div>
                    ))}
                  </div>
                </div>
                <span className="xs muted">Seller feedback rates buying from you: dispatch, packing and communication. Product reviews describe the item and are shown separately on product pages.</span>
              </div>
            </section>
            {feedback.map((f) => (
              <section key={f.id} className="card">
                <div className="card-body">
                  <div className="row top gap-3">
                    <Avatar name={f.buyer} />
                    <div className="stack gap-1 grow">
                      <span className="row gap-2">
                        <Stars5 rating={f.rating} size="md" />
                        <span className="small strong">{f.buyer}</span>
                        <span className="xs muted">
                          {f.date} · <span className="mono">{f.order}</span>
                        </span>
                        {f.reported && <Badge tone="warning" icon="flag">Reported to Marketly</Badge>}
                      </span>
                      <span className="small">{f.text}</span>
                    </div>
                  </div>
                  {f.posted ? (
                    <div className="panel stack gap-1">
                      <span>
                        <Badge tone="info" icon="store">
                          Response from the seller
                        </Badge>
                      </span>
                      <span className="small">{f.response}</span>
                    </div>
                  ) : (
                    <>
                      <Field label="Public response" optional hint={fErr[f.id] ? undefined : 'Shown under the feedback as “Response from the seller”. You can edit it for 7 days.'} error={fErr[f.id]}>
                        <Textarea id={`cu-fb-${f.id.slice(1)}`} placeholder="Write a public response" value={f.response} onChange={(e) => (setFb(f.id, { response: e.target.value }), setFErr((er) => ({ ...er, [f.id]: '' })))} />
                      </Field>
                      <div className="row end gap-2">
                        <Button variant="ghost" size="sm" icon="flag" disabled={f.reported} onClick={() => (setFb(f.id, { reported: true }), announce('Feedback reported to Marketly for review'))}>
                          {f.reported ? 'Reported' : 'Report feedback'}
                        </Button>
                        <Button size="sm" onClick={() => post(f)}>
                          Post response
                        </Button>
                      </div>
                    </>
                  )}
                </div>
              </section>
            ))}
          </div>
          <Card title="Rules for public responses">
            <span className="small strong">Responses may</span>
            <ul className="sb-ticks ok">
              {['Thank the customer or apologize', 'Explain what happened and what you changed', 'Invite the customer to continue in order messages'].map((t) => (
                <li key={t}>
                  <Icon name="circle-check" />
                  <span>{t}</span>
                </li>
              ))}
            </ul>
            <span className="small strong">Responses may not</span>
            <ul className="sb-ticks no">
              {['Include the customer’s name beyond what they show, address or order details', 'Offer refunds or gifts in exchange for changing feedback', 'Contain outside links, contact details or insults'].map((t) => (
                <li key={t}>
                  <Icon name="circle-x" />
                  <span>{t}</span>
                </li>
              ))}
            </ul>
            <p className="xs muted">Marketly does not remove legitimate negative feedback because it is unfavorable. Report feedback only if it breaks the feedback rules, for example if it is about the product instead of your service.</p>
          </Card>
        </div>
      )}
    </SellerLayout>
  );
}
