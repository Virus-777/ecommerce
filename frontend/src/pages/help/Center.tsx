import { useQuery } from '@tanstack/react-query';
import { useEffect, useState } from 'react';
import { Link, useNavigate, useSearchParams } from 'react-router';
import { call, useApi } from '@marketly/web-shared/api';
import { useSession } from '@/app/session';
import { StoreLayout } from '@/layouts';
import { href } from '@marketly/web-shared/routes';
import { Button, Icon, Img, StatusBadge, type IconName } from '@marketly/web-shared/ui';
import { dateLong } from './data/format';
import { ApiLink, appHref } from './data/links';
import { iconFor, LoadError, SkLines, SkRows } from './data/states';

// Design: pages/store/help-center.html
// Data: GET /api/store/content/help (topics, popular articles and searches, seller-first note); contact cards
// GET /api/store/support/contact-options (channels: label, detail, hours, action); search
// GET /api/store/content/help/articles?q|category; signed in: GET /api/store/orders/orders?limit=3,
// GET /api/store/support/cases?state=open. A topic card filters the article list (?topic=<slug>, also the
// target of the API's topic breadcrumbs): there is no topic page.

const CONTACT_ICON: Record<'email' | 'phone' | 'messages', IconName> = { email: 'mail', phone: 'phone', messages: 'message-circle' };

const useDebounced =(v: string, ms = 300) => {
  const [d, setD] = useState(v);
  useEffect(() => {
    const t = setTimeout(() => setD(v), ms);
    return () => clearTimeout(t);
  }, [v, ms]);
  return d;
};

export default function Center() {
  const { api } = useApi();
  const { customer, signedIn } = useSession();
  const navigate = useNavigate();
  const [params, setParams] = useSearchParams();
  const topic = params.get('topic') ?? '';
  const [q, setQ] = useState(params.get('q') ?? '');
  const query = useDebounced(q.trim());

  const home = useQuery({ queryKey: ['content', 'help'], queryFn: () => call(api.GET('/api/store/content/help')) });
  const options = useQuery({ queryKey: ['support', 'contact-options'], queryFn: () => call(api.GET('/api/store/support/contact-options')), staleTime: 300_000 });
  const search = useQuery({
    queryKey: ['content', 'help-search', query, topic],
    queryFn: () => call(api.GET('/api/store/content/help/articles', { params: { query: { q: query || undefined, category: topic || undefined, audience: 'customer', limit: 20 } } })),
    enabled: Boolean(query || topic),
  });
  const orders = useQuery({
    queryKey: ['orders', 'list', { limit: 3 }],
    queryFn: () => call(api.GET('/api/store/orders/orders', { params: { query: { limit: 3, page: 1 } } })),
    enabled: signedIn,
  });
  const cases = useQuery({
    queryKey: ['support', 'cases', { state: 'open', page: 1, limit: 1 }],
    queryFn: () => call(api.GET('/api/store/support/cases', { params: { query: { state: 'open', page: 1, limit: 1 } } })),
    enabled: signedIn,
  });

  const h = home.data;
  const topicName = h?.topics.find((t) => t.slug === topic)?.name ?? topic;
  const filtering = Boolean(query || topic);
  const articles = filtering ? (search.data?.items ?? []) : (h?.popular ?? []);
  const listLoading = filtering ? search.isPending : home.isPending;
  const heading = query ? `Articles matching “${q.trim()}”` : topic ? `${topicName} articles` : 'Popular articles';
  const setTopic = (slug: string) =>
    setParams(
      (p) => {
        const n = new URLSearchParams(p);
        if (slug) n.set('topic', slug);
        else n.delete('topic');
        return n;
      },
      { preventScrollReset: true },
    );
  const contact = options.data?.channels ?? [];
  const openCases = cases.data?.total ?? cases.data?.items.length ?? 0;
  const firstCase = cases.data?.items[0];

  return (
    <StoreLayout tab="account" appbar={{ title: 'Help', back: href('store/home') }}>
      <div className="container page">
        <section className="buy-help-hero">
          <h1 className="display d-lg">{customer ? `How can we help, ${customer.first}?` : 'How can we help?'}</h1>
          <label className="search-in" htmlFor="hc-q">
            <Icon name="search" className="ic-sm" />
            <input
              id="hc-q"
              type="search"
              placeholder='Search help, for example "return shipping"'
              value={q}
              onChange={(e) => setQ(e.target.value)}
              onKeyDown={(e) => {
                const first = search.data?.items[0];
                if (e.key === 'Enter' && q.trim() && first && query === q.trim()) navigate(href('help/article', '', { slug: first.slug }));
              }}
            />
          </label>
          {h && h.popularSearches.length > 0 && (
            <div className="row gap-2 xs u-justify-center">
              <span className="muted">Popular:</span>
              {h.popularSearches.map((s) =>
                s.url ? (
                  <ApiLink key={s.label} url={s.url} className="link-inline">
                    {s.label}
                  </ApiLink>
                ) : (
                  <a key={s.label} href="#" className="link-inline" onClick={(e) => (e.preventDefault(), setQ(s.label))}>
                    {s.label}
                  </a>
                ),
              )}
            </div>
          )}
        </section>
        {home.isError && <LoadError error={home.error} retry={() => void home.refetch()} title="We couldn’t load the Help Center" />}
        <div className="split">
          <div className="stack gap-6">
            <section className="stack gap-3">
              <h2 className="h2">Browse by topic</h2>
              {home.isPending ? (
                <SkLines n={4} />
              ) : (
                <div className="buy-topics">
                  {(h?.topics ?? []).map((t) => (
                    <Link
                      key={t.slug}
                      className="buy-topic"
                      to={href('help/center', '', undefined, { topic: t.slug })}
                      aria-current={t.slug === topic ? 'true' : undefined}
                      preventScrollReset
                      onClick={(e) => {
                        e.preventDefault();
                        setQ('');
                        setTopic(t.slug === topic ? '' : t.slug);
                      }}
                    >
                      <Icon name={iconFor(t.icon)} />
                      <span className="strong small">{t.name}</span>
                      <span className="xs muted">{t.description}</span>
                    </Link>
                  ))}
                </div>
              )}
            </section>
            <section className="stack gap-3" aria-live="polite">
              <div className="row between">
                <h2 className="h2">{heading}</h2>
                {topic && !query && (
                  <Button variant="ghost" size="sm" icon="x" onClick={() => setTopic('')}>
                    All topics
                  </Button>
                )}
              </div>
              {search.isError && filtering ? (
                <LoadError error={search.error} retry={() => void search.refetch()} />
              ) : listLoading ? (
                <div className="card">
                  <SkRows n={4} />
                </div>
              ) : articles.length ? (
                <ul className="card list pad">
                  {articles.map((a) => (
                    <li key={a.id}>
                      <Link className="row gap-3 grow link-plain" to={href('help/article', '', { slug: a.slug })}>
                        <Icon name="file-text" className="ic-sm" />
                        <span className="small grow">{a.title}</span>
                        <Icon name="chevron-right" className="ic-sm" />
                      </Link>
                    </li>
                  ))}
                </ul>
              ) : (
                <div className="card pad small sub">{filtering ? 'No articles match that search. Try other words, or contact us below.' : 'No articles yet. Contact us below.'}</div>
              )}
            </section>
            {(options.isPending || options.isError || contact.length > 0) && (
              <section className="stack gap-3">
                <h2 className="h2">Contact us</h2>
                {options.isPending ? (
                  <SkLines n={3} />
                ) : options.isError ? (
                  <LoadError error={options.error} retry={() => void options.refetch()} title="We couldn’t load the ways to reach us" />
                ) : (
                  <div className="buy-contact">
                    {contact.map((c) => {
                      const to = c.action?.kind === 'help' ? appHref(c.action.url) : null;
                      return (
                        <div key={c.kind} className="card pad stack gap-2">
                          <Icon name={CONTACT_ICON[c.kind]} />
                          <span className="strong">{c.kind === 'phone' && c.detail ? `${c.label}: ${c.detail}` : c.label}</span>
                          <span className="xs muted">{[c.hours, c.kind === 'phone' ? null : c.detail].filter(Boolean).join(' · ')}</span>
                          {c.action &&
                            (to !== null ? (
                              <Button variant="secondary" size="sm" to={to}>
                                {c.action.label}
                              </Button>
                            ) : (
                              <a className="btn btn-secondary btn-sm" href={c.action.url}>
                                <span>{c.action.label}</span>
                              </a>
                            ))}
                        </div>
                      );
                    })}
                  </div>
                )}
                {h?.sellerFirstNote && <p className="xs muted">{h.sellerFirstNote}</p>}
              </section>
            )}
          </div>
          <aside className="stack gap-4">
            {signedIn && (
              <section className="card">
                <div className="card-head">
                  <div className="stack gap-0">
                    <h3 className="h4">Get help with a recent order</h3>
                    <span className="xs muted">Pick the order. The items are filled in for you.</span>
                  </div>
                </div>
                <div>
                  {orders.isPending ? (
                    <SkRows n={3} />
                  ) : orders.isError ? (
                    <div className="card-body">
                      <LoadError error={orders.error} retry={() => void orders.refetch()} />
                    </div>
                  ) : orders.data.items.length === 0 ? (
                    <div className="card-body">
                      <span className="small sub">You haven’t placed any orders yet.</span>
                    </div>
                  ) : (
                    orders.data.items.map((o) => (
                      <Link key={o.id} className="buy-order-pick" to={href('help/order-problem', '', undefined, { order: o.ref })}>
                        <span className="buy-thumbs">
                          {o.thumbnails.slice(0, 3).map((t, i) => (
                            <Img key={t.id ?? i} icon="package" src={t.url} alt={t.alt ?? ''} />
                          ))}
                        </span>
                        <span className="stack gap-0 grow">
                          <span className="small strong mono">{o.ref}</span>
                          <span className="xs muted">
                            {dateLong(o.placedAt)} · {o.itemCount} item{o.itemCount === 1 ? '' : 's'} · {o.sellerCount} seller{o.sellerCount === 1 ? '' : 's'}
                          </span>
                        </span>
                        <StatusBadge status={o.statusLabel} />
                      </Link>
                    ))
                  )}
                </div>
                <div className="card-foot">
                  <Link className="small strong" to={href('account/orders')}>
                    See all orders
                  </Link>
                </div>
              </section>
            )}
            {signedIn && (
              <div className="card pad stack gap-2">
                <span className="row gap-2">
                  <span className="strong small">Your support cases</span>
                  {cases.isSuccess && <span className="badge t-info">{openCases} open</span>}
                </span>
                <span className="xs muted">
                  {cases.isPending ? 'Loading your cases…' : cases.isError ? 'Your cases couldn’t be loaded right now.' : firstCase ? `${firstCase.ref}: ${firstCase.statusLabel}. ${firstCase.expectedReply}` : 'You have no open cases.'}
                </span>
                <Link className="small strong" to={href('help/cases')}>
                  View cases
                </Link>
              </div>
            )}
            {!signedIn && (
              <div className="card pad stack gap-2">
                <span className="strong small">Not signed in?</span>
                <span className="xs muted">Guests can look up an order with the reference and email.</span>
                <Link className="small strong" to={href('auth/guest-orders')}>
                  Guest order lookup
                </Link>
              </div>
            )}
          </aside>
        </div>
      </div>
    </StoreLayout>
  );
}
