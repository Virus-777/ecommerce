import { useEffect, useMemo, useRef, useState, type FormEvent } from 'react';
import { Link, useNavigate, useSearchParams } from 'react-router';
import { useQueryClient } from '@tanstack/react-query';
import { useSession } from '@/app/session';
import { StoreLayout } from '@/layouts';
import { ApiError, errorMessage } from '@marketly/web-shared/api';
import { cx } from '@marketly/web-shared/lib/cx';
import { num } from '@marketly/web-shared/lib/format';
import { useIsPhone, useView } from '@marketly/web-shared/lib/hooks';
import { href } from '@marketly/web-shared/routes';
import { Alert, Badge, Breadcrumbs, Button, Chip, Dialog, EmptyState, Field, Icon, Pager, PhoneCollapse, SearchInput, Select, Stars5, Textarea, announce } from '@marketly/web-shared/ui';
import NotFound from './NotFound';
import { useOfferComparison } from './data/offers';
import { fmtDate, productHref, useProductParams, useSignInHref, type CatalogProduct } from './data/product';
import { QA_ROLES, QA_SORTS, roleOf, useAskQuestion, useDebounced, useQuestionFeed, useQuestionPage, type ApiAnswer, type ApiQuestion, type QaRole, type QaSort } from './data/questions';
import { useHelpfulVote, useReviewPage } from './data/reviews';
import {
  Highlight, ListSkeleton, LoadError, matchCount, matchesAll, Photo, ProductSummary, ReviewSource, subpageCrumbs, SummaryActionBar, tokens, useProductContext, type VoteState,
} from './data/review-parts';
import './Reviews.css';

// Questions and answers (no design file: designed in React from the design system, following
// reports/Best ecommerce site UX patterns.md, "Reviews and Q&A").
//   view ""         = all questions, with "Search questions and reviews" above "Ask a question"
//   view "ask"      = Ask a question dialog (who gets it, expected answer time; posts as "Awaiting answer")
//   view "no-match" = follows the data: a search no question matches shows matching reviews and "Ask this question"
// ?q=<words> starts with a search. Questions are searched on the server; reviews can't be (BACKEND-REQUESTS
// G6), so "From reviews" filters the first 100 reviews here. The API has no answered/awaiting filter: those
// chips filter the first 100 questions here.

type View = 'ask' | 'no-match';
type Filter = 'all' | 'answered' | 'awaiting';

const PAGE = 8;
const SHOW_ANSWERS = 2;
/** Questions loaded when the Answered / Awaiting answer chips filter here. */
const FILTER_LIMIT = 100;

/** Answers ranked by helpful votes only: a seller's answer doesn't go first because of its role. */
const byVotes = (a: ApiAnswer, b: ApiAnswer) => b.helpfulCount - a.helpfulCount;

export default function Questions() {
  const [view, setView] = useView<View>();
  const { slug, id } = useProductParams();
  const [params] = useSearchParams();
  const isPhone = useIsPhone();
  const navigate = useNavigate();
  const signIn = useSignInHref();
  const qc = useQueryClient();
  const { signedIn, customer } = useSession();
  const ctx = useProductContext(id);

  const [mine, setMine] = useState<ApiQuestion[]>([]);
  const [posted, setPosted] = useState<ApiQuestion | null>(null);
  const [query, setQueryState] = useState(() => params.get('q') ?? '');
  const [filter, setFilter] = useState<Filter>('all');
  const [sort, setSort] = useState<QaSort>('helpful');
  const [page, setPage] = useState(1);
  const [shown, setShown] = useState(PAGE);
  const [votes, setVotes] = useState<Record<string, VoteState>>({});
  const [expanded, setExpanded] = useState<Record<string, boolean>>({});
  const [askDraft, setAskDraft] = useState('');
  const listTop = useRef<HTMLHeadingElement>(null);
  const vote = useHelpfulVote();

  const reset = () => {
    setPage(1);
    setShown(PAGE);
  };
  const setQuery = (v: string) => {
    setQueryState(v);
    reset();
    // The no-match view is a state of the search: typing something else leaves it.
    if (view === 'no-match') setView('', { replace: true });
  };

  const search = useDebounced(query.trim());
  const searching = search.length > 0;
  const toks = useMemo(() => tokens(search), [search]);
  const clientFilter = filter !== 'all';

  const paged = useQuestionPage(id, search, sort, clientFilter ? 1 : page, clientFilter ? FILTER_LIMIT : PAGE, !isPhone || clientFilter);
  const feed = useQuestionFeed(id, search, sort, PAGE, isPhone && !clientFilter);
  const list = isPhone && !clientFilter ? feed : paged;
  const allCount = useQuestionPage(id, '', 'helpful', 1, 1).data?.total;
  const answered = ctx.summary?.answeredQuestions ?? 0;
  const awaiting = allCount != null ? Math.max(0, allCount - answered) : 0;

  const loaded = isPhone && !clientFilter ? (feed.data?.pages.flatMap((p) => p.items) ?? []) : (paged.data?.items ?? []);
  const mineIds = new Set(mine.map((q) => q.id));
  const inGroup = (q: ApiQuestion) => filter === 'all' || (filter === 'answered' ? q.answers.length > 0 : q.answers.length === 0);
  // Your own new questions stay on top of the first page; the rest follow the chosen order.
  const ownOnTop = !searching && page === 1 ? mine.filter(inGroup) : [];
  const server = loaded.filter((q) => !mineIds.has(q.id) && inGroup(q));

  let visible: ApiQuestion[];
  let pages = 1;
  let current = 1;
  let matchTotal: number | null = null;
  let hasMore = false;
  let loadMore = () => undefined as unknown;
  if (clientFilter) {
    matchTotal = server.length;
    pages = Math.max(1, Math.ceil(server.length / PAGE));
    current = Math.min(page, pages);
    visible = isPhone ? server.slice(0, shown) : server.slice((current - 1) * PAGE, current * PAGE);
    hasMore = isPhone && server.length > shown;
    loadMore = () => setShown((n) => n + PAGE);
  } else if (isPhone) {
    visible = server;
    hasMore = !!feed.hasNextPage;
    loadMore = () => feed.fetchNextPage();
  } else {
    visible = server;
    matchTotal = paged.data?.total ?? null;
    pages = Math.max(1, paged.data?.totalPages ?? 1);
    current = Math.min(page, pages);
  }
  const listed = [...ownOnTop, ...visible];

  // The same words across reviews (filtered here: the API can't search reviews).
  const reviewsQ = useReviewPage(id, { sort: 'helpful' }, 1, 100, searching && !!ctx.summary?.hasReviews);
  const reviewHits = searching ? (reviewsQ.data?.items ?? []).filter((r) => matchesAll(toks, r.headline, r.text)) : [];
  const noMatch = searching && !!list.data && listed.length === 0 && filter === 'all';

  // Who gets a question: the sellers with an offer on this item (other customers can answer too).
  const offers = useOfferComparison(id);
  const sellers = offers.data?.offers.map((o) => o.seller) ?? [];
  const official = sellers.some((s) => s.official);
  const others = [...new Set(sellers.filter((s) => !s.official).map((s) => s.name))];
  const expected = [...mine, ...loaded].find((q) => q.answerExpectation)?.answerExpectation ?? null;
  const routing = routingText(official, others.length);

  const goPage = (p: number) => {
    setPage(p);
    listTop.current?.scrollIntoView({ block: 'start', behavior: 'smooth' });
  };
  const voteOf = (a: ApiAnswer): VoteState => votes[a.id] ?? { voted: false, count: a.helpfulCount };
  const onVote = (a: ApiAnswer) => {
    if (!signedIn) {
      navigate(signIn());
      return;
    }
    const prev = voteOf(a);
    setVotes((m) => ({ ...m, [a.id]: { voted: true, count: prev.count + 1 } }));
    vote.mutate(
      { targetType: 'answer', targetId: a.id, helpful: true },
      {
        onSuccess: (res) => {
          setVotes((m) => ({ ...m, [a.id]: { voted: true, count: res.helpfulCount } }));
          announce(`Thanks. You marked ${a.by.displayName}’s answer as helpful.`);
        },
        onError: (e) => {
          setVotes((m) => ({ ...m, [a.id]: prev }));
          announce(errorMessage(e));
        },
      },
    );
  };
  const openAsk = (draft = '') => {
    setAskDraft(draft);
    setView('ask');
  };
  const onPosted = (q: ApiQuestion) => {
    setMine((m) => [q, ...m]);
    setPosted(q);
    setQueryState('');
    setFilter('all');
    reset();
    setView('');
    void qc.invalidateQueries({ queryKey: ['reviews', 'questions'] });
    void qc.invalidateQueries({ queryKey: ['reviews', 'questions-feed'] });
    announce(q.status === 'pending_review' ? 'Your question was sent. It shows once it passes our checks.' : 'Your question is posted. It shows as Awaiting answer until someone replies.');
  };

  if (ctx.notFound) return <NotFound />;

  const counts: Record<Filter, number | null> = { all: allCount ?? null, answered, awaiting };
  const FILTERS: Array<[Filter, string]> = [
    ['all', 'All questions'],
    ['answered', 'Answered'],
    ['awaiting', 'Awaiting answer'],
  ];
  const askedAs = customer ? `${customer.first} ${customer.last.slice(0, 1)}.` : '';

  return (
    <StoreLayout nav="categories" appbar={{ title: 'Questions and answers', back: productHref(slug, id) }} actionBar={<SummaryActionBar box={ctx.box} title={ctx.product?.title} />}>
      <div className="container page gap-5">
        <Breadcrumbs items={subpageCrumbs(ctx, slug, id, 'Questions and answers')} />
        {ctx.error ? (
          <LoadError error={ctx.error} onRetry={ctx.refetch} title="We couldn’t load this product" />
        ) : (
          <>
            <ProductSummary product={ctx.product} box={ctx.box} summary={ctx.summary} slug={slug} id={id} />

            <div className="shop-two rv-layout">
              <aside className="stack gap-4 rv-side" aria-labelledby="qa-h">
                <div className="stack gap-1">
                  <h1 className="h2" id="qa-h">
                    Questions and answers
                  </h1>
                  {allCount != null && ctx.summary && (
                    <span className="small sub">
                      {num(answered)} answered · {num(awaiting)} awaiting an answer
                    </span>
                  )}
                </div>
                <form className="stack gap-2" role="search" aria-label="Questions and reviews" onSubmit={(e: FormEvent) => e.preventDefault()}>
                  <div className="toolbar">
                    <SearchInput id="qa-q" label="Search questions and reviews" placeholder="Search questions and reviews" value={query} onChange={setQuery} />
                  </div>
                  <span className="xs muted">Search first: most questions about this item already have an answer.</span>
                </form>
                <section className="card pad stack gap-3" aria-labelledby="qa-ask-h">
                  <h2 className="h4" id="qa-ask-h">
                    Don’t see your question?
                  </h2>
                  <p className="small sub">It goes to {routing}. Other customers can answer too.</p>
                  {expected && (
                    <span className="shop-note">
                      <Icon name="clock" />
                      {expected}
                    </span>
                  )}
                  <Button block icon="message-circle-question" onClick={() => openAsk()}>
                    Ask a question
                  </Button>
                </section>
                <PhoneCollapse className="pdp-collapse" summaryClassName="pdp-sum" summary={<h2 className="h4">Who answers</h2>}>
                  <ul className="stack gap-2">
                    {(Object.keys(QA_ROLES) as QaRole[]).map((k) => {
                      const role = QA_ROLES[k];
                      return (
                        <li key={k} className="stack gap-1">
                          <span>
                            <Badge tone={role.tone} icon={role.icon}>
                              {role.label}
                            </Badge>
                          </span>
                          <span className="xs sub">{ROLE_NOTE[k]}</span>
                        </li>
                      );
                    })}
                  </ul>
                  <p className="xs muted">
                    Answers are ordered by helpful votes, so a seller’s answer doesn’t go first just because of who wrote it. Questions about your own order go to{' '}
                    <Link to={href('account/messages')} className="link-inline">
                      order messages
                    </Link>
                    .
                  </p>
                </PhoneCollapse>
              </aside>

              <div className="stack gap-4 rv-main">
                {posted && (
                  <Alert tone="success" title={posted.status === 'pending_review' ? 'Your question was sent' : 'Your question is posted'}>
                    “{posted.text}” {posted.status === 'pending_review' ? 'shows on this page once it passes our checks.' : 'shows as Awaiting answer.'}
                    {posted.answerExpectation ? ` ${posted.answerExpectation}` : ''}
                  </Alert>
                )}

                <section className="stack gap-3" aria-labelledby="qa-list-h">
                  <h2 className="h3 rv-anchor" id="qa-list-h" ref={listTop}>
                    {searching ? (
                      matchTotal != null ? (
                        <>
                          {matchTotal} question{matchTotal === 1 ? '' : 's'} match “{search}”
                        </>
                      ) : (
                        <>Questions matching “{search}”</>
                      )
                    ) : (
                      'All questions'
                    )}
                  </h2>
                  {!noMatch && (
                    <div className="shop-toolbar">
                      <div className="hscroll gap-2" role="group" aria-label="Show questions">
                        {FILTERS.map(([f, label]) => (
                          <Chip
                            key={f}
                            active={filter === f}
                            onClick={() => {
                              setFilter(f);
                              reset();
                            }}
                          >
                            {label}
                            {!searching && counts[f] != null && ` (${counts[f]})`}
                          </Chip>
                        ))}
                      </div>
                      <span className="shop-sort">
                        <label className="small sub nowrap" htmlFor="qa-sort">
                          Sort by
                        </label>
                        <Select
                          id="qa-sort"
                          options={QA_SORTS}
                          value={sort}
                          onChange={(e) => {
                            setSort(e.target.value as QaSort);
                            reset();
                          }}
                        />
                      </span>
                    </div>
                  )}

                  {list.error ? (
                    <LoadError error={list.error} onRetry={() => void list.refetch()} title="We couldn’t load the questions" />
                  ) : !list.data ? (
                    <div className="card pad">
                      <ListSkeleton rows={4} />
                    </div>
                  ) : noMatch ? (
                    <div className="card">
                      <EmptyState
                        icon="search-x"
                        title={`No questions match “${search}”`}
                        action={
                          <div className="row gap-2 rv-center">
                            <Button icon="message-circle-question" onClick={() => openAsk(search)}>
                              Ask this question
                            </Button>
                            <Button variant="secondary" onClick={() => setQuery('')}>
                              Clear search
                            </Button>
                          </div>
                        }
                      >
                        {reviewHits.length > 0 ? `${reviewHits.length} review${reviewHits.length === 1 ? '' : 's'} mention it (below). ` : 'Try fewer or different words. '}
                        Ask it, and we’ll send it to {routing}.{expected ? ` ${expected}` : ''}
                      </EmptyState>
                    </div>
                  ) : listed.length === 0 ? (
                    <p className="small sub">{filter === 'all' ? 'No questions yet. Ask the sellers and other customers.' : 'No questions in this group yet.'}</p>
                  ) : (
                    <div className="card pad stack gap-0">
                      {listed.map((q) => (
                        <QuestionItem
                          key={q.id}
                          q={q}
                          toks={toks}
                          isNew={mineIds.has(q.id)}
                          expanded={searching || !!expanded[q.id]}
                          onExpand={() => setExpanded((m) => ({ ...m, [q.id]: !m[q.id] }))}
                          voteOf={voteOf}
                          onVote={onVote}
                        />
                      ))}
                    </div>
                  )}

                  {!noMatch && !isPhone && pages > 1 && <Pager only="website" page={current} total={pages} onPage={goPage} />}
                  {!noMatch && isPhone && hasMore && (
                    <div className="only-phone">
                      <Button variant="secondary" block disabled={feed.isFetchingNextPage} onClick={() => void loadMore()}>
                        Load more questions
                      </Button>
                    </div>
                  )}
                </section>

                {/* The same search across reviews */}
                {searching && ctx.summary?.hasReviews && (
                  <section className="stack gap-3" aria-labelledby="qa-rev-h">
                    <div className="row between base">
                      <h2 className="h4" id="qa-rev-h">
                        From reviews ({reviewHits.length})
                      </h2>
                      {reviewHits.length > 0 && (
                        <Link className="small strong" to={href('store/reviews', '', { slug, id }, { q: search })}>
                          See in reviews <Icon name="arrow-right" className="ic-sm" />
                        </Link>
                      )}
                    </div>
                    {!reviewsQ.data ? (
                      <ListSkeleton rows={2} />
                    ) : reviewHits.length ? (
                      <div className="stack gap-2">
                        {reviewHits.slice(0, 3).map((r) => (
                          <article key={r.id} className="card pad stack gap-1">
                            <div className="row gap-2">
                              <Stars5 rating={r.rating} size="sm" />
                              <h3 className="small strong">
                                <Highlight text={r.headline} toks={toks} />
                              </h3>
                            </div>
                            <p className="small sub">
                              <Highlight text={r.text} toks={toks} />
                            </p>
                            <span className="row gap-2 xs muted">
                              {r.author.displayName} · {fmtDate(r.reviewedAt)} <ReviewSource r={r} />
                            </span>
                          </article>
                        ))}
                      </div>
                    ) : (
                      <p className="small sub">No reviews mention “{search}”.</p>
                    )}
                  </section>
                )}
              </div>
            </div>
          </>
        )}
      </div>

      <AskDialog
        key={view === 'ask' ? `ask-${askDraft}` : 'closed'}
        open={view === 'ask'}
        productId={id}
        product={ctx.product}
        initial={askDraft}
        signedIn={signedIn}
        signInHref={signIn(href('store/questions', 'ask', { slug, id }))}
        existing={[...mine, ...loaded]}
        official={official}
        sellers={others}
        expected={expected}
        onClose={() => setView('')}
        onPosted={onPosted}
        askedAs={askedAs}
      />
    </StoreLayout>
  );
}

/** "the Official Store and the 3 other sellers of this item" */
function routingText(official: boolean, others: number) {
  const sellers = `${others} ${official ? 'other ' : ''}seller${others === 1 ? '' : 's'} of this item`;
  if (official && others) return `the Official Store and the ${sellers}`;
  if (official) return 'the Official Store';
  if (others) return `the ${sellers}`;
  return 'the sellers of this item';
}

const ROLE_NOTE: Record<QaRole, string> = {
  official: 'Marketly selling this item itself, from our own stock.',
  seller: 'An outside seller with an offer for this item.',
  staff: 'Marketly product support, checked against the manufacturer’s information.',
  buyer: 'Someone who bought this item on Marketly.',
  customer: 'Another shopper on Marketly.',
};

/* ---------------- One question ---------------- */

function QuestionItem({
  q, toks, isNew, expanded, onExpand, voteOf, onVote,
}: {
  q: ApiQuestion;
  toks: string[];
  isNew: boolean;
  expanded: boolean;
  onExpand: () => void;
  voteOf: (a: ApiAnswer) => VoteState;
  onVote: (a: ApiAnswer) => void;
}) {
  const answers = [...q.answers].sort(byVotes);
  const shownAnswers = expanded ? answers : answers.slice(0, SHOW_ANSWERS);
  const more = answers.length - SHOW_ANSWERS;
  return (
    <article className={cx('shop-qa', isNew && 'rv-new')} id={`question-${q.id}`}>
      <div className="stack gap-1">
        <div className="row gap-2 top nowrap">
          <span className="strong small none" aria-hidden="true">
            Q:
          </span>
          <h3 className="strong small">
            <span className="sr-only">Question: </span>
            <Highlight text={q.text} toks={toks} />
          </h3>
        </div>
        <span className="xs muted">
          Asked by {q.askedBy} · {fmtDate(q.askedAt)}
          {q.answers.length > 0 && ` · ${q.answers.length} answer${q.answers.length === 1 ? '' : 's'}`}
        </span>
      </div>
      {q.answers.length === 0 && (
        <div className="a">
          <span>
            <Badge tone="warning" icon="hourglass">
              {q.status === 'pending_review' ? 'Being checked' : 'Awaiting answer'}
            </Badge>
          </span>
          {q.answerExpectation && <span className="xs muted">{q.answerExpectation}</span>}
        </div>
      )}
      {shownAnswers.map((a) => {
        const role = QA_ROLES[roleOf(a)];
        const v = voteOf(a);
        return (
          <div key={a.id} className="a">
            <div className="row gap-2">
              <Badge tone={role.tone} icon={role.icon}>
                {role.label}
              </Badge>
              <span className="xs muted">
                {a.by.displayName} · {fmtDate(a.answeredAt)}
              </span>
            </div>
            <span>
              <Highlight text={a.text} toks={toks} />
            </span>
            <div className="row gap-2">
              <Button variant="ghost" size="sm" icon={v.voted ? 'check' : 'thumbs-up'} aria-pressed={v.voted} onClick={v.voted ? undefined : () => onVote(a)} className={cx(v.voted && 'is-active')}>
                Helpful ({v.count})
              </Button>
              {v.voted && <span className="xs muted">Thanks for your feedback</span>}
            </div>
          </div>
        );
      })}
      {more > 0 && !toks.length && (
        <button type="button" className="btn btn-link small rv-more-answers" aria-expanded={expanded} onClick={onExpand}>
          {expanded ? 'Show fewer answers' : `See ${more} more answer${more === 1 ? '' : 's'}`}
        </button>
      )}
    </article>
  );
}

/* ---------------- Ask a question ---------------- */

const EMAIL = /[^\s@]+@[^\s@]+\.[^\s@]+/;
const ORDER_NO = /\b(MK|ORD)[-\s]?\d{4,}/i;

function AskDialog({
  open, productId, product, initial, signedIn, signInHref, existing, official, sellers, expected, onClose, onPosted, askedAs,
}: {
  open: boolean;
  productId: string;
  product?: CatalogProduct;
  initial: string;
  signedIn: boolean;
  signInHref: string;
  existing: ApiQuestion[];
  official: boolean;
  sellers: string[];
  expected: string | null;
  onClose: () => void;
  onPosted: (q: ApiQuestion) => void;
  askedAs: string;
}) {
  const ask = useAskQuestion(productId);
  const [text, setText] = useState(initial);
  const [error, setError] = useState('');
  const toks = tokens(text.trim());
  // Similar questions that already have answers: shown while typing to avoid duplicates.
  const similar = toks.length
    ? existing
        .filter((q) => q.answers.length > 0)
        .map((q) => ({ q, score: matchCount(toks, q.text) }))
        .filter((x) => x.score >= Math.min(2, toks.length))
        .sort((a, b) => b.score - a.score)
        .slice(0, 2)
        .map((x) => x.q)
    : [];

  useEffect(() => {
    if (open) ask.reset();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open]);

  const submit = () => {
    const t = text.trim();
    let e = '';
    if (!t) e = 'Enter your question.';
    else if (t.length < 10) e = 'Add a few more words so sellers and buyers can answer (at least 10 characters).';
    else if (EMAIL.test(t) || ORDER_NO.test(t)) e = 'Remove personal details such as email addresses or order numbers. Questions are public.';
    setError(e);
    if (e) return;
    ask.mutate(t, {
      onSuccess: onPosted,
      onError: (err) => setError(err instanceof ApiError && err.fieldErrors.text ? err.fieldErrors.text : errorMessage(err)),
    });
  };

  return (
    <Dialog
      open={open}
      onClose={onClose}
      title="Ask a question"
      foot={
        signedIn ? (
          <>
            <Button variant="secondary" onClick={onClose}>
              Cancel
            </Button>
            <Button icon="send" onClick={submit} disabled={ask.isPending}>
              Post question
            </Button>
          </>
        ) : (
          <Button to={signInHref}>Sign in to ask</Button>
        )
      }
    >
      <div className="row gap-3 nowrap">
        <Photo media={product?.images[0]} className="thumb" />
        <span className="small strong">{product?.title}</span>
      </div>
      {!signedIn && (
        <Alert tone="info" title="Sign in to ask">
          Questions show your first name and last initial, so we need you to be signed in.
        </Alert>
      )}
      <Field label="Your question" hint={`${text.length}/300. Ask about the product: features, fit, compatibility.`} error={error}>
        <Textarea
          id="qa-ask"
          rows={3}
          maxLength={300}
          placeholder="For example: Does it work with a PS5 controller?"
          value={text}
          onChange={(e) => {
            setText(e.target.value);
            setError('');
          }}
        />
      </Field>
      {similar.length > 0 && (
        <div className="stack gap-2 rv-similar" role="status">
          <span className="xs strong">Already answered</span>
          {similar.map((q) => {
            const top = [...q.answers].sort(byVotes)[0];
            const role = QA_ROLES[roleOf(top)];
            return (
              <div key={q.id} className="stack gap-1">
                <span className="small strong">{q.text}</span>
                <span className="small sub">
                  <Badge tone={role.tone} icon={role.icon}>
                    {role.label}
                  </Badge>{' '}
                  {top.text}
                </span>
              </div>
            );
          })}
        </div>
      )}
      <div className="stack gap-2 rv-route">
        <span className="xs strong">Who gets your question</span>
        <ul className="stack gap-2 small">
          {official && (
            <li className="row gap-2">
              <Badge tone={QA_ROLES.official.tone} icon={QA_ROLES.official.icon}>
                {QA_ROLES.official.label}
              </Badge>
              Marketly Official Store
            </li>
          )}
          {sellers.length > 0 && (
            <li className="row gap-2">
              <Badge tone={QA_ROLES.seller.tone} icon={QA_ROLES.seller.icon}>
                {QA_ROLES.seller.label}
              </Badge>
              {sellers.join(', ')}
            </li>
          )}
          <li className="row gap-2">
            <Badge tone={QA_ROLES.customer.tone} icon={QA_ROLES.customer.icon}>
              {QA_ROLES.customer.label}
            </Badge>
            Other customers can answer too
          </li>
        </ul>
        <span className="shop-note">
          <Icon name="clock" />
          {expected ? `${expected} ` : ''}It shows as Awaiting answer until then.
        </span>
      </div>
      <p className="xs muted">
        Your question is public{askedAs ? ` and shows as asked by ${askedAs}` : ''}. For a problem with your own order, use{' '}
        <Link to={href('account/messages')} className="link-inline">
          order messages
        </Link>
        .
      </p>
    </Dialog>
  );
}
