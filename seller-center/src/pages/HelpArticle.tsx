import { useDebounced } from '@marketly/web-shared/lib/hooks';
import { Fragment, useState, type FormEvent, type ReactNode } from 'react';
import { Link, useParams } from 'react-router';
import { useMutation, useQuery } from '@tanstack/react-query';
import { errorMessage, useApi } from '@marketly/web-shared/api';
import { SellerLayout } from '@marketly/web-shared/layouts';
import { useView } from '@marketly/web-shared/lib/hooks';
import { href } from '@marketly/web-shared/routes';
import { Alert, announce, Button, Card, EmptyState, Field, Icon, PageHeader, Radio, SearchInput, Textarea } from '@marketly/web-shared/ui';
import { articleHref, contactHref, getHelpArticle, getHelpHome, helpKeys, helpLinkTo, isContactLink, rateHelpArticle, searchHelp, type HelpArticle as Article } from './data/help-articles';
import { DataTable, HelpLink, RichText } from './data/help-html';
import { date, LoadError, SkeletonLines } from './data/home';
import './HelpArticle.css';

// Screen seller/help-article, added after the design (blueprint: reports/Best ecommerce site UX
// patterns.md, "Seller help article"). Route /help/articles/:slug. Views: '' = the article,
// 'not-helpful' = the "Was this helpful? No" feedback form open. Unknown slug = not-found state.
// Typography follows the store's help article (meta strip, .prose); blocks reuse Seller Center classes.
// API (content help, audience seller): GET …/help/articles/{slug}, search GET …/help/articles?q=,
// POST …/help/articles/{id}/feedback, and the help home for the not-found state's popular articles
// (data/help-articles.ts: seller-area routes GET /api/seller/content/help…, with the seller session).

type Feedback = '' | 'yes' | 'sent';

const REASONS = ['Didn’t answer my question', 'Hard to follow', 'Out of date', 'Something else'];

/* ---------------- Search ---------------- */

function HelpSearch({ q, setQ }: { q: string; setQ: (q: string) => void }) {
  const query = useDebounced(q.trim());
  const { api } = useApi();
  const search = useQuery({ queryKey: helpKeys.search(query), queryFn: () => searchHelp(api, query), enabled: !!query });
  const results = search.data?.items ?? [];
  return (
    <>
      <div className="toolbar ha-search" role="search">
        <SearchInput id="ha-q" placeholder="Search seller help, e.g. payout, dispatch or appeal" label="Search seller help" value={q} onChange={setQ} />
      </div>
      {query && (
        <section className="card" aria-labelledby="ha-results-h">
          <div className="card-head">
            <div className="stack gap-0">
              <h2 className="h4" id="ha-results-h">
                Search results
              </h2>
              <span className="xs muted" role="status">
                {search.isPending ? 'Searching…' : search.isError ? 'Search failed' : results.length ? `${results.length} article${results.length > 1 ? 's' : ''} match “${query}”` : `No articles match “${query}”`}
              </span>
            </div>
            <Button variant="ghost" size="sm" onClick={() => setQ('')}>
              Clear search
            </Button>
          </div>
          {search.isPending ? (
            <div className="card-body">
              <SkeletonLines rows={2} />
            </div>
          ) : search.isError ? (
            <div className="card-body">
              <LoadError error={search.error} onRetry={() => void search.refetch()} title="We couldn’t search seller help" />
            </div>
          ) : results.length ? (
            <ul className="list pad ha-results">
              {results.map((r) => (
                <li key={r.slug}>
                  <Link to={articleHref(r.slug)} onClick={() => setQ('')}>
                    <span className="small strong">{r.title}</span>
                    <span className="xs muted">{r.categoryName}</span>
                  </Link>
                </li>
              ))}
            </ul>
          ) : (
            <div className="card-body">
              <p className="small sub">
                Try other words, such as payout, dispatch or appeal, browse <Link to={href('seller/help')}>Help and support</Link>, or <Link to={contactHref()}>contact seller support</Link>.
              </p>
            </div>
          )}
        </section>
      )}
    </>
  );
}

/* ---------------- Feedback ---------------- */

function Escalation({ a, title = 'Still need help?' }: { a: Article; title?: ReactNode }) {
  return (
    <div className="card pad row between ha-cta">
      <div className="stack gap-1">
        <span className="strong small">{title}</span>
        <span className="xs muted">Seller support replies here and by email. The request starts with this article’s topic filled in.</span>
      </div>
      <Button variant="secondary" size="sm" icon="message-square" to={contactHref(a)}>
        Contact seller support
      </Button>
    </div>
  );
}

/** "Was this helpful?", then escalation to seller support. The No form is the 'not-helpful' view. */
function FeedbackAndEscalation({ a }: { a: Article }) {
  const [view, setView] = useView<'not-helpful'>();
  const [state, setState] = useState<Feedback>('');
  const [reason, setReason] = useState('');
  const [comment, setComment] = useState('');
  const [tried, setTried] = useState(false);
  const reasonErr = tried && !reason ? 'Choose what went wrong.' : '';
  const { api } = useApi();
  const send = useMutation({ mutationFn: (v: { helpful: boolean; comment?: string }) => rateHelpArticle(api, a.id, v.helpful, v.comment) });

  const yes = () =>
    send.mutate(
      { helpful: true },
      {
        onSuccess: () => {
          setState('yes');
          announce('Thanks for your feedback.');
        },
      },
    );
  const submit = (e: FormEvent) => {
    e.preventDefault();
    setTried(true);
    if (!reason) {
      document.getElementById('ha-r-0')?.focus();
      return;
    }
    send.mutate(
      { helpful: false, comment: [reason, comment.trim()].filter(Boolean).join(': ') },
      {
        onSuccess: () => {
          setState('sent');
          setView('', { replace: true });
          announce('Feedback sent. Thank you.');
        },
      },
    );
  };
  const cancel = () => {
    setTried(false);
    send.reset();
    setView('');
  };
  const sendError = send.isError && (
    <span className="error-text" role="alert">
      <Icon name="circle-alert" className="ic-sm" />
      {errorMessage(send.error)}
    </span>
  );

  if (state === 'yes') {
    return (
      <>
        <div className="card pad row gap-2">
          <Icon name="circle-check" className="ic-sm" />
          <span className="strong small">Thanks for your feedback.</span>
        </div>
        <Escalation a={a} />
      </>
    );
  }
  if (state === 'sent') {
    return (
      <>
        <div className="card pad row gap-2">
          <Icon name="circle-check" className="ic-sm" />
          <span className="strong small">Thanks. We use your feedback to improve this article.</span>
        </div>
        <Escalation a={a} title="Still stuck? Ask seller support directly." />
      </>
    );
  }
  if (view === 'not-helpful') {
    return (
      <>
        <form className="card pad stack gap-4" onSubmit={submit} noValidate aria-labelledby="ha-fb-h">
          <h2 className="h4" id="ha-fb-h">
            Sorry this didn’t help
          </h2>
          <fieldset className="stack gap-2 fieldset-reset" aria-describedby={reasonErr ? 'ha-r-err' : undefined}>
            <legend className="label u-mb-sp-2">What went wrong?</legend>
            {REASONS.map((r, i) => (
              <Radio
                key={r}
                id={`ha-r-${i}`}
                name="ha-reason"
                label={r}
                checked={reason === r}
                aria-invalid={!!reasonErr || undefined}
                onChange={() => {
                  setReason(r);
                  setTried(false);
                }}
              />
            ))}
            {reasonErr && (
              <span className="error-text" id="ha-r-err">
                <Icon name="circle-alert" className="ic-sm" />
                {reasonErr}
              </span>
            )}
          </fieldset>
          <Field label="Anything to add?" optional hint="We read every comment but can’t reply here. Don’t include customer details.">
            <Textarea id="ha-fb-comment" value={comment} maxLength={1000} onChange={(e) => setComment(e.target.value)} />
          </Field>
          {sendError}
          <span className="row gap-2">
            <Button type="submit" size="sm" disabled={send.isPending}>
              Send feedback
            </Button>
            <Button variant="ghost" size="sm" onClick={cancel}>
              Cancel
            </Button>
          </span>
        </form>
        <Escalation a={a} />
      </>
    );
  }
  return (
    <>
      <div className="card pad row between ha-cta">
        <span className="strong small" id="ha-helpful">
          Was this helpful?
        </span>
        <span className="row gap-2" role="group" aria-labelledby="ha-helpful">
          <Button variant="secondary" size="sm" icon="thumbs-up" onClick={yes} disabled={send.isPending}>
            Yes
          </Button>
          <Button
            variant="secondary"
            size="sm"
            icon="thumbs-down"
            disabled={send.isPending}
            onClick={() => {
              send.reset();
              setView('not-helpful');
            }}
          >
            No
          </Button>
        </span>
        {sendError}
      </div>
      <Escalation a={a} />
    </>
  );
}

/* ---------------- Page ---------------- */

function ArticleView({ a }: { a: Article }) {
  const [q, setQ] = useState('');
  // Screen links from the article ("Go to …"); its "Contact seller support" action is the escalation card.
  const actions = a.actions.filter((l) => !isContactLink(l) && helpLinkTo(l.url).to);
  const upcoming = a.effectiveAt && new Date(a.effectiveAt).getTime() > Date.now() ? a.effectiveAt : null;

  return (
    <SellerLayout active="help">
      <PageHeader crumbs={[{ label: 'Help and support', to: href('seller/help') }, { label: a.category.name }]} title={a.title} />
      <HelpSearch q={q} setQ={setQ} />
      <div className="sb-main">
        <article className="stack gap-5">
          <div className="buy-meta-strip">
            <span>
              <Icon name="store" />
              Applies to: Sellers
            </span>
            {a.effectiveAt && (
              <span>
                <Icon name="calendar" />
                Effective <time dateTime={a.effectiveAt}>{date(a.effectiveAt)}</time>
              </span>
            )}
            <span>
              <Icon name="history" />
              Updated <time dateTime={a.updatedAt}>{date(a.updatedAt)}</time>
            </span>
            <span>
              <Icon name="clock" />
              {a.readMinutes} min read
            </span>
          </div>
          {upcoming && (
            <Alert tone="info" title={`Rule change from ${date(upcoming)}`}>
              This article describes rules that apply from {date(upcoming)}.
            </Alert>
          )}
          <RichText html={a.body} tableLabel={`${a.title} table`} />
          {(a.tables ?? []).map((t, i) => (
            <DataTable key={i} table={t} label={`${a.title} table ${i + 1}`} />
          ))}
          {a.policyLinks.length > 0 && (
            <p className="xs muted">
              See the{' '}
              {a.policyLinks.map((p, i) => (
                <Fragment key={p.url}>
                  {i > 0 && (i === a.policyLinks.length - 1 ? ' and ' : ', ')}
                  <HelpLink url={p.url} className="link-inline">
                    {p.label}
                  </HelpLink>
                </Fragment>
              ))}
              .
            </p>
          )}
          <FeedbackAndEscalation a={a} />
        </article>
        <aside className="stack gap-5" aria-label="More help">
          {actions.map((l) => (
            <div key={l.url} className="card pad stack gap-2">
              <span className="strong small">{l.label}</span>
              <span className="xs muted">Open the Seller Center screen this article is about.</span>
              <Button variant="secondary" size="sm" iconRight="arrow-right" to={helpLinkTo(l.url).to}>
                {l.label}
              </Button>
            </div>
          ))}
          {a.related.length > 0 && (
            <Card
              title="Related articles"
              flush
              foot={
                <Link className="small strong" to={href('seller/help')}>
                  All seller help <Icon name="arrow-right" className="ic-sm" />
                </Link>
              }
            >
              <ul className="list pad">
                {a.related.map((r) => (
                  <li key={r.slug}>
                    <Link className="small" to={articleHref(r.slug)}>
                      {r.title}
                    </Link>
                  </li>
                ))}
              </ul>
            </Card>
          )}
        </aside>
      </div>
    </SellerLayout>
  );
}

function NotFound() {
  const [q, setQ] = useState('');
  const { api } = useApi();
  const home = useQuery({ queryKey: helpKeys.home, queryFn: () => getHelpHome(api) });
  const popular = home.data?.popular ?? [];
  const count = home.data?.topics.reduce((s, t) => s + t.articleCount, 0);
  return (
    <SellerLayout active="help">
      <PageHeader crumbs={[{ label: 'Help and support', to: href('seller/help') }, { label: 'Article not found' }]} title="We couldn’t find that help article" sub="It may have been renamed or removed. Search seller help or browse by topic." />
      <HelpSearch q={q} setQ={setQ} />
      <section className="card pad">
        <EmptyState
          icon="search-x"
          title="Article not found"
          as="h2"
          action={
            <span className="row gap-2">
              <Button variant="secondary" size="sm" icon="life-buoy" to={href('seller/help')}>
                Back to Help and support
              </Button>
              <Button variant="ghost" size="sm" icon="message-square" to={contactHref()}>
                Contact seller support
              </Button>
            </span>
          }
        >
          {count !== undefined ? `The link you followed doesn’t match any of the ${count} seller help articles.` : 'The link you followed doesn’t match a seller help article.'}
        </EmptyState>
      </section>
      {popular.length > 0 && (
        <Card title="Popular articles" flush>
          <ul className="list pad">
            {popular.map((r) => (
              <li key={r.slug}>
                <Link className="small" to={articleHref(r.slug)}>
                  {r.title}
                </Link>
              </li>
            ))}
          </ul>
        </Card>
      )}
    </SellerLayout>
  );
}

function Loading() {
  return (
    <SellerLayout active="help">
      <PageHeader crumbs={[{ label: 'Help and support', to: href('seller/help') }, { label: '…' }]} title={<span className="sk sk-line" aria-hidden="true" />} />
      <div className="sb-main" role="status" aria-label="Loading the article">
        <article className="stack gap-5">
          <span className="sk sk-line short" aria-hidden="true" />
          <SkeletonLines rows={6} />
        </article>
        <aside className="stack gap-5">
          <div className="sk sk-card" aria-hidden="true" />
        </aside>
      </div>
    </SellerLayout>
  );
}

export default function HelpArticle() {
  const { slug = '' } = useParams();
  const { api } = useApi();
  const article = useQuery({ queryKey: helpKeys.article(slug), queryFn: () => getHelpArticle(api, slug), enabled: !!slug });
  if (slug && article.isPending) return <Loading />;
  if (article.isError) {
    return (
      <SellerLayout active="help">
        <PageHeader crumbs={[{ label: 'Help and support', to: href('seller/help') }]} title="Seller help article" />
        <LoadError error={article.error} onRetry={() => void article.refetch()} title="We couldn’t load this article" />
      </SellerLayout>
    );
  }
  const a = article.data;
  // Keyed by slug so feedback and search reset when a related article opens.
  return a ? <ArticleView key={a.slug} a={a} /> : <NotFound />;
}
