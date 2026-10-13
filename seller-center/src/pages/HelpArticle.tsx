import { Fragment, useState, type FormEvent, type ReactNode } from 'react';
import { Link, useParams } from 'react-router';
import { SellerLayout } from '@marketly/web-shared/layouts';
import { useView } from '@marketly/web-shared/lib/hooks';
import { href } from '@marketly/web-shared/routes';
import { Alert, announce, Button, Card, EmptyState, Field, Icon, KeyValue, PageHeader, Radio, SearchInput, SummaryRow, TableWrap, Textarea } from '@marketly/web-shared/ui';
import { getArticle, getCategory, HELP_ARTICLES, readMinutes, searchArticles, type HelpArticle as Article, type HelpFacts, type HelpLink, type HelpSection } from './data/help-articles';
import './HelpArticle.css';

// Screen seller/help-article, added after the design (blueprint: reports/Best ecommerce site UX
// patterns.md, "Seller help article"). Route /help/articles/:slug. Views: '' = the article,
// 'not-helpful' = the "Was this helpful? No" feedback form open. Unknown slug = not-found state.
// Typography follows the store's help article (meta strip, .prose); blocks reuse Seller Center
// classes (sb-guide steps, sb-ticks, sb-recon, sb-main grid).

type Feedback = '' | 'yes' | 'sent';

const REASONS = ['Didn’t answer my question', 'Hard to follow', 'Out of date', 'Something else'];
/** Shown on the not-found state. */
const POPULAR = ['what-a-restriction-affects', 'dispatch-deadline-rules', 'how-the-fee-basis-works', 'responding-to-a-return-request'];

const fmtDate = (iso: string) => new Date(`${iso}T12:00:00Z`).toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric', timeZone: 'UTC' });

const articleHref = (slug: string) => href('seller/help-article', '', { slug });
/** Contact seller support, prefilled with the article's topic (read by the Help page's form). */
const contactHref = (a?: Article) => href('seller/help', 'contact-seller-support', undefined, a ? { topic: getCategory(a.category).supportTopic, article: a.slug } : undefined);
const linkTo = (l: HelpLink) => ('article' in l ? articleHref(l.article) : href(l.screen, l.view, l.params));

/** Renders **bold** spans in article text. */
function Rich({ text }: { text: string }) {
  const parts = text.split(/\*\*(.+?)\*\*/g);
  return <>{parts.map((p, i) => (i % 2 ? <b key={i}>{p}</b> : <Fragment key={i}>{p}</Fragment>))}</>;
}

/** Deep link into a Seller Center screen (arrow) or to another article (book icon). */
function LinkArrow({ link }: { link: HelpLink }) {
  return (
    <Link className="small strong" to={linkTo(link)}>
      {'article' in link && <Icon name="book-open" className="ic-sm" />} {link.label} <Icon name="arrow-right" className="ic-sm" />
    </Link>
  );
}

/* ---------------- Search ---------------- */

function HelpSearch({ q, setQ }: { q: string; setQ: (q: string) => void }) {
  const query = q.trim();
  const results = searchArticles(query);
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
                {results.length ? `${results.length} article${results.length > 1 ? 's' : ''} match “${query}”` : `No articles match “${query}”`}
              </span>
            </div>
            <Button variant="ghost" size="sm" onClick={() => setQ('')}>
              Clear search
            </Button>
          </div>
          {results.length ? (
            <ul className="list pad ha-results">
              {results.map((r) => (
                <li key={r.slug}>
                  <Link to={articleHref(r.slug)} onClick={() => setQ('')}>
                    <span className="small strong">{r.title}</span>
                    <span className="xs muted">{getCategory(r.category).label}</span>
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

/* ---------------- Article parts ---------------- */

function Facts({ facts }: { facts: HelpFacts }) {
  if (facts.kind === 'kv') {
    return (
      <Card title={facts.title}>
        <KeyValue pairs={facts.pairs} />
      </Card>
    );
  }
  return (
    <Card title={facts.title}>
      <div className="grid md2 gap-4">
        <div className="stack gap-2">
          <span className="small strong">{facts.noLabel}</span>
          <ul className="sb-ticks no">
            {facts.no.map((x) => (
              <li key={x}>
                <Icon name="circle-x" />
                <span>{x}</span>
              </li>
            ))}
          </ul>
        </div>
        <div className="stack gap-2">
          <span className="small strong">{facts.okLabel}</span>
          <ul className="sb-ticks ok">
            {facts.ok.map((x) => (
              <li key={x}>
                <Icon name="circle-check" />
                <span>{x}</span>
              </li>
            ))}
          </ul>
        </div>
      </div>
      {facts.note && <p className="xs muted">{facts.note}</p>}
    </Card>
  );
}

function Section({ s }: { s: HelpSection }) {
  return (
    <section className="stack gap-3" aria-labelledby={`ha-${s.id}`}>
      <div className="prose">
        <h2 id={`ha-${s.id}`}>{s.heading}</h2>
        {s.text?.map((t) => (
          <p key={t}>
            <Rich text={t} />
          </p>
        ))}
        {s.bullets && (
          <ul>
            {s.bullets.map((b) => (
              <li key={b}>
                <Rich text={b} />
              </li>
            ))}
          </ul>
        )}
      </div>
      {s.steps && (
        <ol className="sb-guide ha-steps">
          {s.steps.map((st) => (
            <li key={st.title}>
              <div className="stack gap-1">
                <span className="t">{st.title}</span>
                <span className="d">
                  <Rich text={st.text} />
                </span>
                {st.link && <LinkArrow link={st.link} />}
              </div>
            </li>
          ))}
        </ol>
      )}
      {s.table && (
        <>
          <TableWrap label={s.table.label}>
            <table className="table">
              <thead>
                <tr>
                  {s.table.head.map((h) => (
                    <th key={h} scope="col">
                      {h}
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {s.table.rows.map((r) => (
                  <tr key={r[0]}>
                    {r.map((c, i) =>
                      i === 0 ? (
                        <th key={i} scope="row" className="small strong">
                          {c}
                        </th>
                      ) : (
                        <td key={i}>{c}</td>
                      ),
                    )}
                  </tr>
                ))}
              </tbody>
            </table>
          </TableWrap>
          {s.table.note && <p className="xs muted">{s.table.note}</p>}
        </>
      )}
      {s.calc && (
        <div className="card pad stack gap-3">
          <div className="sb-recon">
            {s.calc.rows.map((r) => (
              <SummaryRow
                key={r.k}
                className={r.total ? 'total' : r.strong ? 'strong' : undefined}
                k={r.k}
                v={r.tone === 'neg' ? <span className="sb-neg">{r.v}</span> : r.tone === 'deal' ? <span className="t-deal-text">{r.v}</span> : r.v}
              />
            ))}
          </div>
          {s.calc.note && <p className="xs muted">{s.calc.note}</p>}
        </div>
      )}
      {s.links && (
        <div className="row gap-4">
          {s.links.map((l) => (
            <LinkArrow key={l.label} link={l} />
          ))}
        </div>
      )}
    </section>
  );
}

function Escalation({ a, title = 'Still need help?' }: { a: Article; title?: ReactNode }) {
  return (
    <div className="card pad row between ha-cta">
      <div className="stack gap-1">
        <span className="strong small">{title}</span>
        <span className="xs muted">Seller support replies within 1 business day, here and by email. The request starts with this article’s topic filled in.</span>
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

  const submit = (e: FormEvent) => {
    e.preventDefault();
    setTried(true);
    if (!reason) {
      document.getElementById('ha-r-0')?.focus();
      return;
    }
    setState('sent');
    setView('', { replace: true });
    announce('Feedback sent. Thank you.');
  };
  const cancel = () => {
    setTried(false);
    setView('');
  };

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
          <span className="row gap-2">
            <Button type="submit" size="sm">
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
          <Button
            variant="secondary"
            size="sm"
            icon="thumbs-up"
            onClick={() => {
              setState('yes');
              announce('Thanks for your feedback.');
            }}
          >
            Yes
          </Button>
          <Button variant="secondary" size="sm" icon="thumbs-down" onClick={() => setView('not-helpful')}>
            No
          </Button>
        </span>
      </div>
      <Escalation a={a} />
    </>
  );
}

/* ---------------- Page ---------------- */

function ArticleView({ a }: { a: Article }) {
  const [q, setQ] = useState('');
  const cat = getCategory(a.category);
  const related = a.related.map((s) => getArticle(s)).filter((x): x is Article => !!x);

  return (
    <SellerLayout active="help">
      <PageHeader crumbs={[{ label: 'Help and support', to: href('seller/help') }, { label: cat.label }]} title={a.title} />
      <HelpSearch q={q} setQ={setQ} />
      <div className="sb-main">
        <article className="stack gap-5">
          <div className="buy-meta-strip">
            <span>
              <Icon name="store" />
              Applies to: Sellers
            </span>
            <span>
              <Icon name="history" />
              Updated <time dateTime={a.updated}>{fmtDate(a.updated)}</time>
            </span>
            <span>
              <Icon name="clock" />
              {readMinutes(a)} min read
            </span>
          </div>
          <div className="ha-answer">
            <span className="eyebrow">Short answer</span>
            <p>{a.summary}</p>
          </div>
          {a.who && (
            <p className="xs sub row gap-2">
              <Icon name="users" className="ic-sm" />
              {a.who}
            </p>
          )}
          {a.change && (
            <Alert tone="info" title={`Rule change from ${a.change.date}`}>
              {a.change.text}
            </Alert>
          )}
          {a.facts && <Facts facts={a.facts} />}
          {a.sections.map((s) => (
            <Section key={s.id} s={s} />
          ))}
          <FeedbackAndEscalation a={a} />
        </article>
        <aside className="stack gap-5" aria-label="More help">
          {a.action && (
            <div className="card pad stack gap-2">
              <span className="strong small">{a.action.title}</span>
              <span className="xs muted">{a.action.text}</span>
              <Button variant="secondary" size="sm" iconRight="arrow-right" to={linkTo(a.action.link)}>
                {a.action.link.label}
              </Button>
            </div>
          )}
          {related.length > 0 && (
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
                {related.map((r) => (
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
  const popular = POPULAR.map((s) => getArticle(s)).filter((x): x is Article => !!x);
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
          The link you followed doesn’t match any of the {HELP_ARTICLES.length} seller help articles.
        </EmptyState>
      </section>
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
    </SellerLayout>
  );
}

export default function HelpArticle() {
  const { slug } = useParams();
  const a = getArticle(slug);
  // Keyed by slug so feedback and search reset when a related article opens.
  return a ? <ArticleView key={a.slug} a={a} /> : <NotFound />;
}
