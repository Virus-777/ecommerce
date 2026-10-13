import { useState, type FormEvent } from 'react';
import { Link, useNavigate, useSearchParams } from 'react-router';
import { useQuery } from '@tanstack/react-query';
import { call, useApi } from '@marketly/web-shared/api';
import { categoryArt, useCategoryTree } from '@/api/catalog';
import { StoreLayout } from '@/layouts';
import { useView } from '@marketly/web-shared/lib/hooks';
import { href } from '@marketly/web-shared/routes';
import { Alert, Button, Icon, type IconName } from '@marketly/web-shared/ui';

// Design: pages/store/store-not-found.html · view "something-went-wrong" = the server error page.
// Also the catch-all 404 route. Popular categories come from GET /api/store/catalog/categories; the error
// view shows the service status from GET /api/public/settings/app-config (maintenance) and the failed
// request's reference when the link carries it (?ref=<X-Request-Id>).

const HELPFUL: Array<{ label: string; icon: IconName; to: string }> = [
  { label: 'Home', icon: 'house', to: href('store/home') },
  { label: 'Deals', icon: 'tag', to: href('store/deals') },
  { label: 'Track an order', icon: 'package', to: href('account/orders') },
  { label: 'Help Center', icon: 'life-buoy', to: href('help/center') },
];

function StoreSearch() {
  const navigate = useNavigate();
  const [q, setQ] = useState('');
  const submit = (e: FormEvent) => {
    e.preventDefault();
    navigate(href('store/search', '', undefined, q.trim() ? { q: q.trim() } : undefined));
  };
  return (
    <form className="stack gap-2" role="search" onSubmit={submit}>
      <div className="field">
        <label className="label" htmlFor="nf-q">
          Search the store
        </label>
        <div className="row nowrap gap-2">
          <span className="input-group">
            <Icon name="search" className="ic-sm" />
            <input className="input" id="nf-q" type="text" value={q} onChange={(e) => setQ(e.target.value)} placeholder="Products, brands and sellers" />
          </span>
          <Button type="submit">Search</Button>
        </div>
      </div>
    </form>
  );
}

export default function NotFound() {
  const [view] = useView<'something-went-wrong'>();
  const error = view === 'something-went-wrong';
  const [retrying, setRetrying] = useState(false);
  const [params] = useSearchParams();
  const ref = params.get('ref');
  const { api } = useApi();
  const tree = useCategoryTree();
  const config = useQuery({
    queryKey: ['settings', 'app-config'],
    queryFn: () => call(api.GET('/api/public/settings/app-config')),
    enabled: error,
    staleTime: 60_000,
  });
  const maintenance = config.data?.maintenance;
  const popular = (tree.data ?? []).filter((c) => !c.comingSoon && c.productCount > 0).slice(0, 6);

  const retry = () => {
    setRetrying(true);
    window.location.reload();
  };

  return (
    <StoreLayout tab="home">
      <div className="container page gap-7">
        {error ? (
          <>
            <div className="shop-err">
              <div className="stack gap-4">
                <span className="eyebrow">Temporary problem</span>
                <h1 className="h1">Something went wrong on our side</h1>
                <p className="sub">We couldn’t load this page. It’s not something you did. Your cart, orders and payments are safe.</p>
                <div className="row gap-2">
                  <Button icon="refresh-cw" onClick={retry} disabled={retrying}>
                    {retrying ? 'Trying again…' : 'Try again'}
                  </Button>
                  <Button variant="secondary" to={href('store/home')}>
                    Go to home page
                  </Button>
                </div>
                {maintenance?.active && (
                  <Alert tone="warning" title={maintenance.kind === 'maintenance' ? 'Service status: scheduled maintenance' : 'Service status: we are fixing a problem'}>
                    {maintenance.message}
                    {maintenance.updatedAt ? ` Updated ${new Date(maintenance.updatedAt).toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit', timeZone: 'America/Los_Angeles' })} PT.` : ''}
                  </Alert>
                )}
                {ref && (
                  <span className="xs muted">
                    Error reference <span className="mono">{ref}</span>. Quote it if you contact support.
                  </span>
                )}
              </div>
              <div className="art" aria-hidden="true">
                <Icon name="server-crash" />
              </div>
            </div>
            <StoreSearch />
          </>
        ) : (
          <div className="shop-err">
            <div className="stack gap-4">
              <span className="big" aria-hidden="true">
                404
              </span>
              <h1 className="h1">We can’t find that page</h1>
              <p className="sub">The link may be out of date, or the page was moved. If you followed a link to a product, it may no longer be sold here.</p>
              <StoreSearch />
            </div>
            <div className="art" aria-hidden="true">
              <Icon name="map" />
            </div>
          </div>
        )}
        <section className="stack gap-3" aria-labelledby="nf-links">
          <h2 className="h3" id="nf-links">
            Helpful links
          </h2>
          <div className="shop-links">
            {HELPFUL.map((l) => (
              <Link key={l.label} to={l.to}>
                <Icon name={l.icon} />
                {l.label}
              </Link>
            ))}
          </div>
        </section>
        {popular.length > 0 && (
        <section className="stack gap-3" aria-labelledby="nf-cats">
          <h2 className="h3" id="nf-cats">
            Popular categories
          </h2>
          <div className="hscroll gap-2">
            {popular.map((c) => (
              <Link key={c.id} className="chip" to={href('store/category', '', { slug: c.slug })}>
                <Icon name={categoryArt(c.slug).icon} />
                {c.name}
              </Link>
            ))}
          </div>
        </section>
        )}
      </div>
    </StoreLayout>
  );
}
