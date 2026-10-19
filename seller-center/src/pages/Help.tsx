import { useEffect, useMemo, useRef, useState } from 'react';
import { Link, useSearchParams } from 'react-router';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { ApiError, call, errorMessage, fileSize, newIdempotencyKey, useApi, useUploads, type components } from '@marketly/web-shared/api';
import { SellerLayout } from '@marketly/web-shared/layouts';
import { useView } from '@marketly/web-shared/lib/hooks';
import { formatMoney } from '@marketly/web-shared/lib/format';
import { href } from '@marketly/web-shared/routes';
import { Alert, Button, Card, EmptyState, Field, FileDrop, Icon, IconButton, KeyValue, PageHeader, SearchInput, Select, StatusBadge, SummaryRow, Textarea, TextInput, type Tone } from '@marketly/web-shared/ui';
import { useSellerSession } from '@/app/session';
import { articleHref, getHelpArticle, getHelpHome, helpKeys, helpLinkTo, isContactLink, searchHelp, topicIcon, type HelpArticleSummary, type HelpCategory } from './data/help-articles';
import { RichText } from './data/help-html';
import { date, LoadError, SkeletonLines, time, weekdayDate } from './data/home';

// Design: pages/seller/seller-help.html · view "contact-seller-support" = the support request form (a page state, not a dialog).
// API: help home, search and articles from the content module (audience seller; data/help-articles.ts),
// seller support topics GET /api/seller/support/categories, my requests GET /api/seller/support/cases
// (scope support_requests), send POST /api/seller/support/requests (idempotent, attachments as case_evidence
// uploads), the example fee calculation GET /api/seller/finance/fee-schedule.
// The contact view reads ?topic=<support category>&article=<slug> (sent by an article's "Contact seller
// support") to preselect the topic and prefill the subject.

type CaseRow = components['schemas']['support.SellerCaseRow'];
type CaseCategory = components['schemas']['support.CaseCategory'];
type CaseView = components['schemas']['support.CaseView'];
type SupportOptions = components['schemas']['support.SellerSupportOptions'];

const ACCEPT = 'application/pdf,image/jpeg,image/png';
const ACCEPT_RE = /\.(pdf|jpe?g|png)$|^application\/pdf$|^image\/(jpeg|png)$/i;
const has = (s: string | null | undefined, q: string) => (s ?? '').toLowerCase().includes(q);

/** Case status → badge tone (statusLabel is the text). */
const CASE_TONE: Record<string, Tone> = {
  open: 'info',
  reopened: 'info',
  waiting_on_seller: 'warning',
  waiting_on_customer: '',
  escalated: 'danger',
  decision_made: 'info',
  appealed: 'warning',
  resolved: 'success',
  closed: '',
};
const isClosed = (s: string) => s === 'resolved' || s === 'closed';

const replyTime = (c?: Pick<CaseCategory, 'firstResponseBusinessHours'>) =>
  !c ? '' : c.firstResponseBusinessHours <= 8 ? 'Within 1 business day' : `Within ${Math.ceil(c.firstResponseBusinessHours / 8)} business days`;

interface Draft {
  topic: string;
  ref: string;
  subject: string;
  message: string;
  channel: 'seller_center_and_email' | 'seller_center_only';
}

type DraftErrors = Partial<Record<'topic' | 'ref' | 'subject' | 'message', string>>;

function validate(d: Draft): DraftErrors {
  const e: DraftErrors = {};
  const ref = d.ref.trim();
  if (!d.topic) e.topic = 'Choose a topic.';
  if (ref && (/\s/.test(ref) || ref.length < 4)) e.ref = 'Enter one reference like MK-261008-12077, or leave this blank.';
  if (!d.subject.trim()) e.subject = 'Enter a subject.';
  else if (d.subject.trim().length < 5) e.subject = 'Make the subject a little longer so support can route it.';
  if (!d.message.trim()) e.message = 'Describe what you need help with.';
  else if (d.message.trim().length < 20) e.message = 'Add a few more details (at least 20 characters).';
  else if (/\b(?:\d[ -]?){13,19}\b/.test(d.message)) e.message = 'Remove the card number. Don’t include customer personal details or card numbers.';
  return e;
}

/* ---------------- Data ---------------- */

function useSupportOptions() {
  const { api } = useApi();
  const { sellerId } = useSellerSession();
  return useQuery({ queryKey: ['support', 'categories', sellerId], queryFn: () => call(api.GET('/api/seller/support/categories')) as Promise<SupportOptions>, staleTime: 5 * 60_000 });
}

function useRequests() {
  const { api } = useApi();
  const { sellerId } = useSellerSession();
  return useQuery({
    queryKey: ['support', 'cases', sellerId, 'support_requests'],
    queryFn: () => call(api.GET('/api/seller/support/cases', { params: { query: { scope: 'support_requests', state: 'all', limit: 10 } } })),
  });
}

/* ---------------- Parts ---------------- */

function RequestList({ categories }: { categories: CaseCategory[] }) {
  const requests = useRequests();
  const items = requests.data?.items ?? [];
  const open = items.filter((r) => !isClosed(r.status)).length;
  const label = (key: string) => categories.find((c) => c.key === key)?.label ?? key.replace(/_/g, ' ');
  const meta = (r: CaseRow) => [label(r.category), r.nextAction?.label, `Updated ${date(r.updatedAt)}`].filter(Boolean).join(' · ');
  return (
    <Card title="Your support requests" sub={requests.data ? `${open} open` : undefined} titleAs="h3" flush>
      {requests.isPending ? (
        <div className="pad">
          <SkeletonLines rows={3} />
        </div>
      ) : requests.isError ? (
        <div className="pad">
          <LoadError error={requests.error} onRetry={() => void requests.refetch()} />
        </div>
      ) : items.length === 0 ? (
        <div className="card-body">
          <p className="small sub">No support requests yet. Requests you send appear here with their status.</p>
        </div>
      ) : (
        <ul className="list pad">
          {items.map((r) => (
            <li key={r.id}>
              <span className="grow stack gap-1">
                <span className="row between">
                  <span className="mono small">{r.ref}</span>
                  <StatusBadge status={r.statusLabel} tone={CASE_TONE[r.status] ?? ''} />
                </span>
                <span className="small strong">{r.subject}</span>
                <span className="xs muted">{meta(r)}</span>
              </span>
            </li>
          ))}
        </ul>
      )}
    </Card>
  );
}

function ContactForm({ initial, categories, onCancel, onSent }: { initial: Draft; categories: CaseCategory[]; onCancel: () => void; onSent: (c: CaseView) => void }) {
  const { api } = useApi();
  const { sellerId, can } = useSellerSession();
  const qc = useQueryClient();
  const allowed = can('support.requests.create');
  const [d, setD] = useState<Draft>(initial);
  const [tried, setTried] = useState(false);
  const files = useUploads('case_evidence', { max: 5, accept: ACCEPT_RE });
  const key = useRef(newIdempotencyKey());
  const security = useQuery({ queryKey: ['identity', 'security'], queryFn: () => call(api.GET('/api/store/identity/security')) });
  const email = security.data?.account.email;
  const errors = tried ? validate(d) : {};
  const n = Object.keys(errors).length;
  const set = <K extends keyof Draft>(k: K, v: Draft[K]) => setD((x) => ({ ...x, [k]: v }));

  const send = useMutation({
    mutationFn: () =>
      call(
        api.POST('/api/seller/support/requests', {
          body: { category: d.topic, reference: d.ref.trim() || null, subject: d.subject.trim(), message: d.message.trim(), mediaIds: files.assetIds.length ? files.assetIds : null, replyChannel: d.channel },
          params: { header: { 'Idempotency-Key': key.current } },
        }),
      ) as Promise<CaseView>,
    onSuccess: (c) => {
      key.current = newIdempotencyKey();
      void qc.invalidateQueries({ queryKey: ['support', 'cases', sellerId] });
      onSent(c);
    },
  });
  const serverErrors = send.error instanceof ApiError && send.error.code === 'VALIDATION_FAILED' ? send.error.fieldErrors : {};
  const fieldError = (k: keyof DraftErrors, apiKey: string = k) => errors[k] ?? serverErrors[apiKey];

  const submit = () => {
    setTried(true);
    if (Object.keys(validate(d)).length || files.uploading) return;
    send.mutate();
  };

  return (
    <Card
      title="New support request"
      foot={
        <>
          <Button variant="ghost" onClick={onCancel}>
            Cancel
          </Button>
          <Button icon="send" onClick={submit} disabled={!allowed || send.isPending || files.uploading}>
            {send.isPending ? 'Sending…' : 'Send request'}
          </Button>
        </>
      }
    >
      {!allowed && (
        <Alert tone="info" title="You can’t send support requests">
          Your role doesn’t include contacting seller support. Ask the store owner to send it or to give you access.
        </Alert>
      )}
      {n > 0 && (
        <Alert tone="danger" title={`Check ${n} field${n > 1 ? 's' : ''}`}>
          Fix the highlighted fields to send your request.
        </Alert>
      )}
      {send.isError && !Object.keys(serverErrors).length && (
        <Alert tone="danger" title="We couldn’t send your request">
          {errorMessage(send.error)}
        </Alert>
      )}
      <div className="sb-form-grid">
        <Field label="Topic" error={fieldError('topic', 'category')}>
          <Select id="hp-topic" options={categories.map((c) => ({ value: c.key, label: c.label }))} value={d.topic} onChange={(e) => set('topic', e.target.value)} />
        </Field>
        <Field label="Related order, product or reference" optional hint="Order MK-…, return RT-…, payout PO-…, restriction RS-… or a SKU" error={fieldError('ref', 'reference')}>
          <TextInput id="hp-ref" icon="hash" value={d.ref} placeholder="" error={!!fieldError('ref', 'reference')} onChange={(e) => set('ref', e.target.value)} />
        </Field>
        <div className="full">
          <Field label="Subject" error={fieldError('subject')}>
            <TextInput id="hp-subj" value={d.subject} placeholder="" error={!!fieldError('subject')} onChange={(e) => set('subject', e.target.value)} />
          </Field>
        </div>
        <div className="full">
          <Field label="Message" hint="Don’t include customer personal details or card numbers." error={fieldError('message')}>
            <Textarea id="hp-msg" placeholder="" className={fieldError('message') ? 'is-error' : undefined} value={d.message} onChange={(e) => set('message', e.target.value)} />
          </Field>
        </div>
      </div>
      <div className="stack gap-2">
        <span className="label">
          Attachments <span className="opt">(optional)</span>
        </span>
        <FileDrop title="Add files" hint="PDF, JPG or PNG, up to 10 MB each" accept={ACCEPT} onFiles={files.add} />
        {files.error && (
          <span className="error-text" role="alert">
            <Icon name="circle-alert" className="ic-sm" />
            {files.error}
          </span>
        )}
        {files.items.length > 0 && (
          <ul className="list">
            {files.items.map((f) => (
              <li key={f.key}>
                <Icon name={f.status === 'failed' ? 'circle-alert' : 'file-text'} className="ic-sm" />
                <span className="grow small">
                  {f.name}
                  {f.status === 'uploading' && <span className="xs muted"> · Uploading…</span>}
                  {f.status === 'failed' && <span className="xs t-danger-text"> · {f.error}</span>}
                </span>
                <span className="xs muted">{fileSize(f.size)}</span>
                <IconButton icon="x" label={`Remove ${f.name}`} onClick={() => files.remove(f.key)} />
              </li>
            ))}
          </ul>
        )}
      </div>
      <Field label="Reply by">
        <Select
          id="hp-chan"
          options={[
            { value: 'seller_center_and_email', label: email ? `In Seller Center and email to ${email}` : 'In Seller Center and by email' },
            { value: 'seller_center_only', label: 'In Seller Center only' },
          ]}
          value={d.channel}
          onChange={(e) => set('channel', e.target.value as Draft['channel'])}
        />
      </Field>
    </Card>
  );
}

/** "How fees work": the first example calculation with shipping from the seller's fee schedule. */
function FeesCard() {
  const { api } = useApi();
  const { sellerId } = useSellerSession();
  const fees = useQuery({ queryKey: ['finance', 'fee-schedule', sellerId], queryFn: () => call(api.GET('/api/seller/finance/fee-schedule')), staleTime: 5 * 60_000 });
  const ex = fees.data ? (fees.data.examples.find((e) => e.shippingCharged.amount > 0) ?? fees.data.examples[0]) : undefined;
  const rate = ex ? `${ex.rateBps / 100}%` : '';
  return (
    <Card title="How fees work" sub="Example calculation" titleAs="h3">
      {fees.isPending ? (
        <SkeletonLines rows={4} />
      ) : fees.isError ? (
        <LoadError error={fees.error} onRetry={() => void fees.refetch()} />
      ) : !ex ? (
        <p className="small sub">Your fee rules are in your seller agreement.</p>
      ) : (
        <>
          <div className="sb-recon">
            <SummaryRow k="Item price" v={formatMoney(ex.itemPrice)} />
            {ex.sellerDiscount.amount > 0 && <SummaryRow k="Your discount (seller-funded)" v={<span className="t-deal-text">−{formatMoney(ex.sellerDiscount)}</span>} />}
            <SummaryRow className="strong" k="Fee basis" v={formatMoney(ex.feeBasis)} />
            <SummaryRow k={`Marketplace fee, ${rate} of fee basis`} v={<span className="sb-neg">−{formatMoney(ex.fee)}</span>} />
            {ex.shippingCharged.amount > 0 && <SummaryRow k={`Shipping you charged${fees.data.current.includeShipping ? '' : ' (no fee)'}`} v={formatMoney(ex.shippingCharged)} />}
            <SummaryRow className="total" k="Your earnings" v={formatMoney(ex.sellerEarnings)} />
          </div>
          <p className="xs muted">
            {fees.data.illustration}.{fees.data.current.platformDiscountsReduceFee ? '' : ' Platform-funded discounts don’t reduce your earnings.'} Final fees are in your seller agreement.
          </p>
        </>
      )}
      <Link className="small strong" to={href('seller/finance')}>
        See it on a real statement <Icon name="arrow-right" className="ic-sm" />
      </Link>
    </Card>
  );
}

function ContactCard({ options }: { options?: SupportOptions }) {
  const first = options?.categories[0];
  return (
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
      {options ? (
        <KeyValue
          pairs={[
            ['Standard reply', replyTime(first)],
            ['Hours', options.hoursLabel],
            ['Now', options.openNow ? 'Open' : options.nextOpenAt ? `Closed · opens ${weekdayDate(options.nextOpenAt)}, ${time(options.nextOpenAt)}` : 'Closed'],
          ]}
        />
      ) : (
        <SkeletonLines rows={2} />
      )}
    </Card>
  );
}

/** Topic cards (help home), or search results grouped by topic. */
function TopicCards({ topics }: { topics: Array<{ key: string; icon: string | null | undefined; title: string; desc?: string | null; articles: HelpArticleSummary[] }> }) {
  return (
    <div className="sb-topics">
      {topics.map((t) => (
        <section key={t.key} className="sb-topic">
          <span className="ic">
            <Icon name={topicIcon(t.icon)} />
          </span>
          <h3 className="h4">{t.title}</h3>
          {t.desc && <p className="xs sub">{t.desc}</p>}
          <ul>
            {t.articles.map((a) => (
              <li key={a.slug}>
                <Link to={articleHref(a.slug)}>{a.title}</Link>
              </li>
            ))}
          </ul>
        </section>
      ))}
    </div>
  );
}

/* ---------------- Page ---------------- */

export default function Help() {
  const [view, setView] = useView<'contact-seller-support'>();
  const [q, setQ] = useState('');
  const [debounced, setDebounced] = useState('');
  const [sent, setSent] = useState<CaseView | null>(null);
  const [params] = useSearchParams();
  const { api } = useApi();
  const home = useQuery({ queryKey: helpKeys.home, queryFn: () => getHelpHome(api) });
  const options = useSupportOptions();
  const categories = useMemo(() => (options.data?.categories ?? []).filter((c) => c.active), [options.data]);

  useEffect(() => {
    const t = setTimeout(() => setDebounced(q.trim()), 250);
    return () => clearTimeout(t);
  }, [q]);
  const query = debounced;
  const search = useQuery({ queryKey: helpKeys.search(query), queryFn: () => searchHelp(api, query), enabled: !!query });

  // Sent from a help article: preselect its topic and prefill the subject.
  const articleSlug = params.get('article') ?? '';
  const fromArticle = useQuery({ queryKey: helpKeys.article(articleSlug), queryFn: () => getHelpArticle(api, articleSlug), enabled: view === 'contact-seller-support' && !!articleSlug });
  const topicParam = params.get('topic') ?? '';

  useEffect(() => {
    if (view !== 'contact-seller-support') setSent(null);
  }, [view]);

  if (view === 'contact-seller-support') {
    const formReady = options.isSuccess && (!articleSlug || !fromArticle.isPending);
    const initial: Draft = {
      topic: categories.some((c) => c.key === topicParam) ? topicParam : (categories[0]?.key ?? ''),
      ref: '',
      subject: fromArticle.data ? `Question about “${fromArticle.data.title}”` : '',
      message: '',
      channel: 'seller_center_and_email',
    };
    const suggestions = (home.data?.popular ?? []).slice(0, 3);
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
                {sent.expectedResponse ? `A Seller Manager team member will reply by ${weekdayDate(sent.expectedResponse.dueAt)}, ${time(sent.expectedResponse.dueAt)}, here and by email.` : 'A Seller Manager team member will reply here and by email.'}
              </Alert>
              <KeyValue
                pairs={[
                  ['Reference', <span key="r" className="mono">{sent.ref}</span>],
                  ['Subject', sent.subject],
                  ['Status', <StatusBadge key="s" status={sent.statusLabel} tone={CASE_TONE[sent.status] ?? ''} />],
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
          ) : options.isError ? (
            <LoadError error={options.error} onRetry={() => void options.refetch()} />
          ) : !formReady ? (
            <Card title="New support request">
              <SkeletonLines rows={5} />
            </Card>
          ) : (
            <ContactForm key={`${initial.topic}|${initial.subject}`} initial={initial} categories={categories} onCancel={() => setView('')} onSent={setSent} />
          )}
          <div className="stack gap-5">
            <ExpectedReply options={options.data} />
            {suggestions.length > 0 && (
              <Card title="These may answer it now" titleAs="h3">
                <ul className="stack gap-2 small">
                  {suggestions.map((a) => (
                    <li key={a.slug}>
                      <Link to={articleHref(a.slug)}>{a.title}</Link>
                    </li>
                  ))}
                </ul>
              </Card>
            )}
            <RequestList categories={categories} />
          </div>
        </div>
      </SellerLayout>
    );
  }

  const h = home.data;
  const lq = query.toLowerCase();
  const topicById = new Map<string, HelpCategory>((h?.topics ?? []).map((t) => [t.id, t]));
  const topics = query
    ? // Search results grouped by their topic, in the help home's topic order.
      Object.values(
        (search.data?.items ?? []).reduce<Record<string, { key: string; icon: string | null | undefined; title: string; desc?: string | null; articles: HelpArticleSummary[]; pos: number }>>((acc, a) => {
          const t = topicById.get(a.categoryId);
          (acc[a.categoryId] ??= { key: a.categoryId, icon: t?.icon, title: a.categoryName, desc: t?.description, articles: [], pos: t?.position ?? 999 }).articles.push(a);
          return acc;
        }, {}),
      ).sort((a, b) => a.pos - b.pos)
    : (h?.topics ?? []).map((t) => ({ key: t.id, icon: t.icon, title: t.name, desc: t.description, articles: t.topArticles ?? [] }));
  const nArticles = query ? (search.data?.items.length ?? 0) : 0;
  const featured = h?.featured;
  const featuredAction = featured?.actions.find((l) => !isContactLink(l) && helpLinkTo(l.url).to);
  const loadingTopics = home.isPending || (!!query && search.isPending);

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
        {(h?.popularSearches.length ?? 0) > 0 && (
          <div className="row gap-2 xs sub">
            <span>Popular:</span>
            <div className="hscroll gap-2">
              {h!.popularSearches.map((p) => {
                const to = helpLinkTo(p.url).to;
                return to ? (
                  <Link key={p.label} className="chip" to={to}>
                    {p.label}
                  </Link>
                ) : (
                  <a
                    key={p.label}
                    className={has(p.label, lq) && lq ? 'chip is-active' : 'chip'}
                    href="#"
                    onClick={(e) => {
                      e.preventDefault();
                      setQ(p.label);
                    }}
                  >
                    {p.label}
                  </a>
                );
              })}
            </div>
          </div>
        )}
      </div>
      <div className="sb-main">
        <div className="stack gap-5">
          {query && !search.isPending && !search.isError && (
            <p className="small sub" role="status">
              {nArticles ? `${nArticles} article${nArticles > 1 ? 's' : ''} match “${query}”.` : `No articles match “${query}”.`}{' '}
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
          {home.isError ? (
            <LoadError error={home.error} onRetry={() => void home.refetch()} title="We couldn’t load seller help" />
          ) : query && search.isError ? (
            <LoadError error={search.error} onRetry={() => void search.refetch()} title="We couldn’t search seller help" />
          ) : loadingTopics ? (
            <div className="sb-topics" aria-hidden="true">
              {[0, 1, 2, 3].map((i) => (
                <div key={i} className="sk sk-card" />
              ))}
            </div>
          ) : topics.length ? (
            <TopicCards topics={topics} />
          ) : (
            <section className="card pad">
              <EmptyState
                icon="search-x"
                title={query ? 'No help articles found' : 'No seller help articles yet'}
                action={
                  <Button variant="secondary" size="sm" icon="message-square" to={href('seller/help', 'contact-seller-support')}>
                    Contact seller support
                  </Button>
                }
              >
                {query ? 'Try other words, such as payout, dispatch or appeal, or ask seller support.' : 'Ask seller support while the help articles are being written.'}
              </EmptyState>
            </section>
          )}
          {featured && !query && (
            <Card
              title={<Link to={articleHref(featured.slug)}>{featured.title}</Link>}
              sub={`Featured guide · ${featured.readMinutes} min read`}
              titleAs="h3"
              foot={
                featuredAction ? (
                  <Button variant="secondary" size="sm" iconRight="arrow-right" to={helpLinkTo(featuredAction.url).to}>
                    {featuredAction.label}
                  </Button>
                ) : (
                  <Button variant="secondary" size="sm" iconRight="arrow-right" to={articleHref(featured.slug)}>
                    Read the guide
                  </Button>
                )
              }
            >
              <RichText html={featured.body} tableLabel={`${featured.title} table`} proseClassName="prose small" />
            </Card>
          )}
          <Card title="Restrictions, in short" titleAs="h3">
            <p className="small sub">A restriction always tells you the reason, which activity it affects and how to appeal. Existing orders, returns, customer messages and payouts keep working unless the notice says otherwise.</p>
            <Link className="small strong" to={href('seller/performance')}>
              View your account health <Icon name="arrow-right" className="ic-sm" />
            </Link>
          </Card>
        </div>
        <div className="stack gap-5">
          <FeesCard />
          <ContactCard options={options.data} />
          <RequestList categories={categories} />
        </div>
      </div>
    </SellerLayout>
  );
}

function ExpectedReply({ options }: { options?: SupportOptions }) {
  const cats = options?.categories.filter((c) => c.active) ?? [];
  const fastest = cats.reduce<CaseCategory | undefined>((m, c) => (!m || c.firstResponseBusinessHours < m.firstResponseBusinessHours ? c : m), undefined);
  const slowest = cats.reduce<CaseCategory | undefined>((m, c) => (!m || c.resolutionBusinessDays > m.resolutionBusinessDays ? c : m), undefined);
  return (
    <Card title="Expected reply time" titleAs="h3">
      {options ? (
        <KeyValue
          pairs={[
            ['First reply', replyTime(fastest)],
            ['Resolution', slowest ? `Within ${slowest.resolutionBusinessDays} business days` : ''],
            ['Hours', options.hoursLabel],
          ]}
        />
      ) : (
        <SkeletonLines rows={3} />
      )}
      <span className="xs muted">Service targets for seller support. Replies arrive here and by email.</span>
    </Card>
  );
}
