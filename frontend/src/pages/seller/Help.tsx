import { useEffect, useState } from 'react';
import { Link } from 'react-router';
import { SellerLayout } from '@/layouts';
import { useView } from '@/lib/hooks';
import { money } from '@/lib/format';
import { href } from '@/routes/href';
import { Alert, Button, Card, EmptyState, Field, FileDrop, Icon, IconButton, KeyValue, PageHeader, SearchInput, Select, StatusBadge, SummaryRow, Textarea, TextInput, type IconName } from '@/ui';

// Design: pages/seller/seller-help.html · view "contact-seller-support" = the support request form (a page state, not a dialog).

interface Topic {
  icon: IconName;
  title: string;
  desc: string;
  articles: string[];
}

interface SupportRequest {
  ref: string;
  status: string;
  subject: string;
  meta: string;
}

interface Attachment {
  name: string;
  size: number;
}

const TOPICS: Topic[] = [
  { icon: 'wallet', title: 'Fees and payouts', desc: 'How commission is calculated, when earnings become available, holds and statements.', articles: ['How the fee basis works', 'Payout schedule and cutoffs', 'Refunds after payout and negative balances'] },
  { icon: 'file-check', title: 'Listing rules and rejected submissions', desc: 'What reviewers check and how to fix a submission.', articles: ['Photo and title rules', 'Brand claims and proof documents', 'Fix a rejected or changes-requested product'] },
  { icon: 'truck', title: 'Shipping and dispatch targets', desc: 'Dispatch deadlines, valid tracking and late shipments.', articles: ['Dispatch deadline rules', 'Uploading valid tracking', 'When you can’t fulfill an order'] },
  { icon: 'undo-2', title: 'Returns and disputes', desc: 'Response targets, who pays return shipping and how disputes are decided.', articles: ['Responding to a return request', 'Partial refunds and reasons', 'Disputes, evidence and appeals'] },
  { icon: 'gauge', title: 'Account health and restrictions', desc: 'Targets, warnings, restrictions and how to appeal.', articles: ['What each metric measures', 'What a restriction affects', 'How to appeal a decision'] },
  { icon: 'megaphone', title: 'Advertising', desc: 'Sponsored products and stores, billing and review.', articles: ['Requesting a sponsored campaign', 'How ad charges are billed', 'Why an ad was not approved'] },
];

/** Popular searches: the chip sets the search text. */
const POPULAR: Array<{ label: string; q: string }> = [
  { label: 'Payout schedule', q: 'payout' },
  { label: 'Changes requested', q: 'changes-requested' },
  { label: 'Dispatch deadlines', q: 'dispatch' },
  { label: 'Appeal a restriction', q: 'appeal' },
];

const GUIDE: Array<[string, string]> = [
  ['Find the submission', 'In Products and offers, filter by Changes requested or Rejected. Each one shows the reviewer and the date.'],
  ['Read each reviewer note', 'Notes are attached to the field that needs work, such as a photo, the title or a specification. Common reasons: watermarked or borrowed photos, missing required attributes, brand claims without proof, a duplicate of an existing product.'],
  ['Fix the flagged fields', 'Only flagged fields need changes. For a duplicate, add your offer to the existing product instead.'],
  ['Resubmit', 'The status goes back to Submitted. Review usually takes up to 2 business days (example).'],
  ['If it was rejected', 'The rejection explains the rule that applies. You can submit a corrected version or ask support to review the decision.'],
];

/** Example fee calculation: 10% marketplace fee on the fee basis (price minus seller-funded discount). */
const FEE = { price: 100, discount: 10, rate: 0.1, shipping: 6.99 };

const REQUESTS: SupportRequest[] = [
  { ref: 'CS-261007-1251', status: 'Open', subject: 'Documents for the Cameras restriction', meta: 'Account health · Reply expected by Oct 9, 10:00 AM' },
  { ref: 'CS-261005-1219', status: 'Waiting on seller', subject: 'Hold on MK-261003-07712', meta: 'Fees and payouts · Support asked for proof of delivery · Oct 6' },
  { ref: 'CS-260928-1107', status: 'Resolved', subject: 'Shipping label billed twice', meta: 'Fees and payouts · Adjustment ADJ-260930-0112 added Sep 30' },
];

const SUPPORT_TOPICS = ['Account health and restrictions', 'Fees and payouts', 'Listing rules and rejected submissions', 'Shipping and dispatch', 'Returns and disputes', 'Advertising', 'Something else'];
const REPLY_CHANNELS = ['In Seller Center and email to avery@northwindaudio.com', 'In Seller Center only'];
const ACCEPT = 'application/pdf,image/jpeg,image/png';
const MAX_BYTES = 10 * 1024 * 1024;

interface Draft {
  topic: string;
  ref: string;
  subject: string;
  message: string;
  channel: string;
  files: Attachment[];
}

const DESIGN_DRAFT: Draft = {
  topic: 'Account health and restrictions',
  ref: 'RS-261002-0019',
  subject: 'Which documents prove we can sell Vantor cameras?',
  message: 'We buy Vantor cameras from Westline Distribution, an authorized US distributor. Is a recent invoice from them enough, or do you need a letter from Vantor? Invoice attached.',
  channel: REPLY_CHANNELS[0],
  files: [{ name: 'westline-invoice-2026-08.pdf', size: 412 * 1024 }],
};
const BLANK_DRAFT: Draft = { topic: SUPPORT_TOPICS[0], ref: '', subject: '', message: '', channel: REPLY_CHANNELS[0], files: [] };

type DraftErrors = Partial<Record<'ref' | 'subject' | 'message' | 'files', string>>;

function validate(d: Draft): DraftErrors {
  const e: DraftErrors = {};
  const ref = d.ref.trim();
  if (ref && (/\s/.test(ref) || ref.length < 4)) e.ref = 'Enter one reference like MK-261008-12077, or leave this blank.';
  if (!d.subject.trim()) e.subject = 'Enter a subject.';
  else if (d.subject.trim().length < 5) e.subject = 'Make the subject a little longer so support can route it.';
  if (!d.message.trim()) e.message = 'Describe what you need help with.';
  else if (d.message.trim().length < 20) e.message = 'Add a few more details (at least 20 characters).';
  else if (/\b(?:\d[ -]?){13,19}\b/.test(d.message)) e.message = 'Remove the card number. Don’t include customer personal details or card numbers.';
  return e;
}

const kb = (bytes: number) => (bytes >= 1024 * 1024 ? `${(bytes / 1024 / 1024).toFixed(1)} MB` : `${Math.max(1, Math.round(bytes / 1024))} KB`);
const has = (s: string, q: string) => s.toLowerCase().includes(q);

function RequestList({ items }: { items: SupportRequest[] }) {
  const open = items.filter((r) => r.status !== 'Resolved').length;
  return (
    <Card title="Your support requests" sub={`${open} open`} titleAs="h3" flush>
      <ul className="list pad">
        {items.map((r) => (
          <li key={r.ref}>
            <span className="grow stack gap-1">
              <span className="row between">
                <a className="mono small" href="#">
                  {r.ref}
                </a>
                <StatusBadge status={r.status} />
              </span>
              <span className="small strong">{r.subject}</span>
              <span className="xs muted">{r.meta}</span>
            </span>
          </li>
        ))}
      </ul>
    </Card>
  );
}

function ContactForm({ initial, onCancel, onSent }: { initial: Draft; onCancel: () => void; onSent: (r: SupportRequest) => void }) {
  const [d, setD] = useState<Draft>(initial);
  const [tried, setTried] = useState(false);
  const [fileErr, setFileErr] = useState('');
  const errors = tried ? validate(d) : {};
  const n = Object.keys(errors).length;
  const set = <K extends keyof Draft>(k: K, v: Draft[K]) => setD((x) => ({ ...x, [k]: v }));

  const addFiles = (files: File[]) => {
    const ok = files.filter((f) => ACCEPT.split(',').includes(f.type) && f.size <= MAX_BYTES);
    setFileErr(ok.length < files.length ? 'Some files were skipped. Use PDF, JPG or PNG files up to 10 MB each.' : '');
    setD((x) => ({ ...x, files: [...x.files, ...ok.filter((f) => !x.files.some((a) => a.name === f.name)).map((f) => ({ name: f.name, size: f.size }))] }));
  };
  const send = () => {
    setTried(true);
    if (Object.keys(validate(d)).length) return;
    const ref = `CS-261008-${1252 + Math.floor(Math.random() * 40)}`;
    onSent({ ref, status: 'Open', subject: d.subject.trim(), meta: `${d.topic} · Reply expected within 1 business day` });
  };

  return (
    <Card
      title="New support request"
      foot={
        <>
          <Button variant="ghost" onClick={onCancel}>
            Cancel
          </Button>
          <Button icon="send" onClick={send}>
            Send request
          </Button>
        </>
      }
    >
      {n > 0 && (
        <Alert tone="danger" title={`Check ${n} field${n > 1 ? 's' : ''}`}>
          Fix the highlighted fields to send your request.
        </Alert>
      )}
      <div className="sb-form-grid">
        <Field label="Topic">
          <Select id="hp-topic" options={SUPPORT_TOPICS} value={d.topic} onChange={(e) => set('topic', e.target.value)} />
        </Field>
        <Field label="Related order, product or reference" optional hint="Order MK-…, return RT-…, payout PO-… or a SKU" error={errors.ref}>
          <TextInput id="hp-ref" icon="hash" value={d.ref} placeholder="" error={!!errors.ref} onChange={(e) => set('ref', e.target.value)} />
        </Field>
        <div className="full">
          <Field label="Subject" error={errors.subject}>
            <TextInput id="hp-subj" value={d.subject} placeholder="" error={!!errors.subject} onChange={(e) => set('subject', e.target.value)} />
          </Field>
        </div>
        <div className="full">
          <Field label="Message" hint="Don’t include customer personal details or card numbers." error={errors.message}>
            <Textarea id="hp-msg" placeholder="" className={errors.message ? 'is-error' : undefined} value={d.message} onChange={(e) => set('message', e.target.value)} />
          </Field>
        </div>
      </div>
      <div className="stack gap-2">
        <span className="label">
          Attachments <span className="opt">(optional)</span>
        </span>
        <FileDrop title="Add files" hint="PDF, JPG or PNG, up to 10 MB each" accept={ACCEPT} onFiles={addFiles} />
        {fileErr && (
          <span className="error-text" role="alert">
            <Icon name="circle-alert" className="ic-sm" />
            {fileErr}
          </span>
        )}
        {d.files.length > 0 && (
          <ul className="list">
            {d.files.map((f) => (
              <li key={f.name}>
                <Icon name="file-text" className="ic-sm" />
                <span className="grow small">{f.name}</span>
                <span className="xs muted">{kb(f.size)}</span>
                <IconButton icon="x" label={`Remove ${f.name}`} onClick={() => set('files', d.files.filter((a) => a.name !== f.name))} />
              </li>
            ))}
          </ul>
        )}
      </div>
      <Field label="Reply by">
        <Select id="hp-chan" options={REPLY_CHANNELS} value={d.channel} onChange={(e) => set('channel', e.target.value)} />
      </Field>
    </Card>
  );
}

export default function Help() {
  const [view, setView] = useView<'contact-seller-support'>();
  const [requests, setRequests] = useState(REQUESTS);
  const [q, setQ] = useState('');
  // Opening the view's URL directly shows the design's filled-in request; later visits start blank.
  const [prefill, setPrefill] = useState(view === 'contact-seller-support');
  const [sent, setSent] = useState<SupportRequest | null>(null);
  useEffect(() => {
    if (view !== 'contact-seller-support') setSent(null);
  }, [view]);

  const query = q.trim().toLowerCase();
  const topics = TOPICS.map((t) => {
    if (!query || has(t.title, query) || has(t.desc, query)) return t;
    return { ...t, articles: t.articles.filter((a) => has(a, query)) };
  }).filter((t) => !query || t.articles.length || has(t.title, query) || has(t.desc, query));
  const nArticles = topics.reduce((s, t) => s + t.articles.length, 0);

  const basis = FEE.price - FEE.discount;
  const fee = basis * FEE.rate;

  if (view === 'contact-seller-support') {
    return (
      <SellerLayout active="help">
        <PageHeader
          crumbs={[{ label: 'Help and support', to: href('seller/help') }, { label: 'Contact seller support' }]}
          title="Contact seller support"
          sub="For questions the help articles don’t answer. A Marketly Seller Manager team member handles your request."
        />
        <div className="sb-main">
          {sent ? (
            <Card title="Request sent">
              <Alert tone="success" title={`We received ${sent.ref}`}>
                A Seller Manager team member will reply within 1 business day, here and by email.
              </Alert>
              <KeyValue
                pairs={[
                  ['Reference', <span key="r" className="mono">{sent.ref}</span>],
                  ['Subject', sent.subject],
                  ['Status', <StatusBadge key="s" status={sent.status} />],
                ]}
              />
              <div className="row gap-2">
                <Button variant="secondary" size="sm" to={href('seller/help')} onClick={() => setSent(null)}>
                  Back to Help and support
                </Button>
                <Button variant="ghost" size="sm" onClick={() => setSent(null)}>
                  Send another request
                </Button>
              </div>
            </Card>
          ) : (
            <ContactForm
              initial={prefill ? DESIGN_DRAFT : BLANK_DRAFT}
              onCancel={() => {
                setPrefill(false);
                setView('');
              }}
              onSent={(r) => {
                setRequests((l) => [r, ...l]);
                setSent(r);
                setPrefill(false);
              }}
            />
          )}
          <div className="stack gap-5">
            <Card title="Expected reply time" titleAs="h3">
              <KeyValue
                pairs={[
                  ['Standard', 'Within 1 business day'],
                  ['Restrictions and failed payouts', 'Within 4 hours'],
                  ['Hours', 'Mon–Sat, 8 AM–8 PM PT'],
                ]}
              />
              <span className="xs muted">Example service targets. Replies arrive here and by email.</span>
            </Card>
            <Card title="These may answer it now" titleAs="h3">
              <ul className="stack gap-2 small">
                <li>
                  <a href="#">Brand claims and proof documents</a>
                </li>
                <li>
                  <Link to={href('seller/performance')}>How to appeal a decision</Link>
                </li>
                <li>
                  <a href="#">What a restriction affects</a>
                </li>
              </ul>
            </Card>
            <RequestList items={requests} />
          </div>
        </div>
      </SellerLayout>
    );
  }

  return (
    <SellerLayout active="help">
      <PageHeader
        title="Help and support"
        sub="Guides for selling on Marketly, and a direct line to seller support."
        actions={
          <Button size="sm" icon="message-square" to={href('seller/help', 'contact-seller-support')}>
            Contact seller support
          </Button>
        }
      />
      <div className="sb-hsearch">
        <h2 className="h3">How can we help?</h2>
        <SearchInput id="hp-q" placeholder="Search seller help, e.g. why was my product rejected" label="Search seller help" value={q} onChange={setQ} />
        <div className="row gap-2 xs sub">
          <span>Popular:</span>
          <div className="hscroll gap-2">
            {POPULAR.map((p) => (
              <a
                key={p.label}
                className={query === p.q ? 'chip is-active' : 'chip'}
                href="#"
                aria-current={query === p.q ? 'true' : undefined}
                onClick={(e) => {
                  e.preventDefault();
                  setQ(query === p.q ? '' : p.q);
                }}
              >
                {p.label}
              </a>
            ))}
          </div>
        </div>
      </div>
      <div className="sb-main">
        <div className="stack gap-5">
          {query && (
            <p className="small sub" role="status">
              {nArticles ? `${nArticles} article${nArticles > 1 ? 's' : ''} match “${q.trim()}”.` : `No articles match “${q.trim()}”.`}{' '}
              <a
                href="#"
                onClick={(e) => {
                  e.preventDefault();
                  setQ('');
                }}
              >
                Clear search
              </a>
            </p>
          )}
          {topics.length ? (
            <div className="sb-topics">
              {topics.map((t) => (
                <section key={t.title} className="sb-topic">
                  <span className="ic">
                    <Icon name={t.icon} />
                  </span>
                  <h3 className="h4">{t.title}</h3>
                  <p className="xs sub">{t.desc}</p>
                  <ul>
                    {t.articles.map((a) => (
                      <li key={a}>
                        <a href="#">{a}</a>
                      </li>
                    ))}
                  </ul>
                </section>
              ))}
            </div>
          ) : (
            <section className="card pad">
              <EmptyState
                icon="search-x"
                title="No help articles found"
                action={
                  <Button variant="secondary" size="sm" icon="message-square" to={href('seller/help', 'contact-seller-support')}>
                    Contact seller support
                  </Button>
                }
              >
                Try other words, such as payout, dispatch or appeal, or ask seller support.
              </EmptyState>
            </section>
          )}
          <Card
            title="Fix a rejected or changes-requested product"
            sub="Featured guide · 4 min read"
            titleAs="h3"
            foot={
              <Button variant="secondary" size="sm" iconRight="arrow-right" to={href('seller/product-new', 'changes-requested')}>
                Open a product with changes requested
              </Button>
            }
          >
            <ol className="sb-guide">
              {GUIDE.map(([t, d]) => (
                <li key={t}>
                  <div className="stack gap-1">
                    <span className="small strong">{t}</span>
                    <span className="xs sub">{d}</span>
                  </div>
                </li>
              ))}
            </ol>
          </Card>
          <Card title="Restrictions, in short" titleAs="h3">
            <p className="small sub">A restriction always tells you the reason, which activity it affects and how to appeal. Existing orders, returns, customer messages and payouts keep working unless the notice says otherwise.</p>
            <Link className="small strong" to={href('seller/performance')}>
              View your account health <Icon name="arrow-right" className="ic-sm" />
            </Link>
          </Card>
        </div>
        <div className="stack gap-5">
          <Card title="How fees work" sub="Example calculation" titleAs="h3">
            <div className="sb-recon">
              <SummaryRow k="Item price" v={money(FEE.price)} />
              <SummaryRow k="Your discount (seller-funded)" v={<span className="t-deal-text">−{money(FEE.discount)}</span>} />
              <SummaryRow className="strong" k="Fee basis" v={money(basis)} />
              <SummaryRow k={`Marketplace fee, ${FEE.rate * 100}% of fee basis`} v={<span className="sb-neg">−{money(fee)}</span>} />
              <SummaryRow k="Shipping you charged (no fee)" v={money(FEE.shipping)} />
              <SummaryRow className="total" k="Your earnings" v={money(basis - fee + FEE.shipping)} />
            </div>
            <p className="xs muted">Example rate. Without a discount, a $100.00 sale with a 10% fee gives $10.00 in fees and $90.00 to you. Platform-funded discounts don't reduce your earnings. Final fees are in your seller agreement.</p>
            <Link className="small strong" to={href('seller/statement')}>
              See it on a real statement <Icon name="arrow-right" className="ic-sm" />
            </Link>
          </Card>
          <Card
            title="Contact seller support"
            titleAs="h3"
            foot={
              <Button size="sm" icon="message-square" to={href('seller/help', 'contact-seller-support')}>
                Contact seller support
              </Button>
            }
          >
            <p className="small sub">Owners and staff with access can send a request. Replies come to this page and by email.</p>
            <KeyValue
              pairs={[
                ['Standard reply', 'Within 1 business day'],
                ['Urgent', 'Within 4 hours (example)'],
              ]}
            />
          </Card>
          <RequestList items={requests} />
        </div>
      </div>
    </SellerLayout>
  );
}
