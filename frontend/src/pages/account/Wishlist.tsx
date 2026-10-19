import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Link } from 'react-router';
import { AccountLayout } from '@/layouts';
import { call, errorMessage, useApi } from '@marketly/web-shared/api';
import { dollars } from '@marketly/web-shared/lib/format';
import { href } from '@marketly/web-shared/routes';
import { Alert, announce, Button, Card, EmptyState, Icon, Img, Price } from '@marketly/web-shared/ui';
import { slugify } from './data/when';

// Design: pages/store/account-wishlist.html (one view): saved items with price-drop and back-in-stock
// switches, the alerts table, and recently viewed.
// API: the wishlist module (saved items, alerts, sharing) is phase 3 and off at launch: its routes answer
// 404 and app-config reports features.wishlist = false. The page shows the design's empty state with a note
// and hides the wishlist actions; Recently viewed works (GET/DELETE /api/store/customers/recently-viewed).

export default function Wishlist() {
  const { api } = useApi();
  const qc = useQueryClient();
  const recent = useQuery({
    queryKey: ['customers', 'recently-viewed'],
    queryFn: () => call(api.GET('/api/store/customers/recently-viewed', { params: { query: { limit: 12 } } })),
  });
  const clear = useMutation({
    mutationFn: () => call(api.DELETE('/api/store/customers/recently-viewed')),
    onSuccess: () => {
      qc.setQueryData(['customers', 'recently-viewed'], []);
      announce('Browsing history cleared');
    },
  });
  const items = recent.data ?? [];

  return (
    <AccountLayout active="wishlist" title="Wishlist and alerts">
      <div className="acct-head">
        <div className="stack gap-1">
          <h1 className="h1 acct-h1">Wishlist and alerts</h1>
          <p className="small sub">Saved items and price alerts are coming soon.</p>
        </div>
      </div>
      <div className="card">
        <EmptyState icon="heart" as="h2" title="Wishlists aren't available yet" action={<Button to={href('store/home')}>Browse the store</Button>}>
          Saving items and price-drop or back-in-stock alerts will arrive in a later update. Until then, products you look at stay in Recently viewed below.
        </EmptyState>
      </div>
      <Card title="Your alerts" sub="Turn alerts off any time. These are separate from order updates." flush>
        <div className="card-body">
          <p className="small muted">No alerts on. Alerts arrive with wishlists in a later update.</p>
        </div>
      </Card>
      <section className="stack gap-3" aria-labelledby="wl-recent">
        <div className="row between base">
          <h2 className="h2">
            <span id="wl-recent">Recently viewed</span>
          </h2>
          {items.length > 0 && (
            <a
              className="small strong"
              href="#"
              onClick={(e) => {
                e.preventDefault();
                if (!clear.isPending) clear.mutate();
              }}
            >
              Clear history <Icon name="arrow-right" className="ic-sm" />
            </a>
          )}
        </div>
        {clear.isError && <Alert tone="danger" title="We couldn't clear your history">{errorMessage(clear.error)}</Alert>}
        {recent.isError ? (
          <Alert tone="danger" title="We couldn't load recently viewed products">
            {errorMessage(recent.error)}{' '}
            <Button variant="ghost" size="sm" onClick={() => void recent.refetch()}>
              Try again
            </Button>
          </Alert>
        ) : recent.isPending ? (
          <div className="hscroll acct-recent" aria-hidden="true">
            {[0, 1, 2, 3].map((i) => (
              <div key={i} className="sk-card">
                <span className="sk sk-img" />
                <span className="sk sk-line" />
                <span className="sk sk-line short" />
              </div>
            ))}
          </div>
        ) : items.length ? (
          <div className="hscroll acct-recent">
            {items.map((p) => (
              <Link key={p.productId} to={href('store/product', '', { slug: p.slug || slugify(p.title), id: p.productId })} className="stack gap-2 link-plain">
                <Img icon="image" tint="2" src={p.image?.url} alt={p.image?.alt ?? p.title} />
                <span className="xs clamp-2">{p.title}</span>
                {p.price && <Price amount={dollars(p.price)} was={p.wasPrice ? dollars(p.wasPrice) : undefined} noOff />}
              </Link>
            ))}
          </div>
        ) : (
          <p className="small muted">{clear.isSuccess ? 'History cleared. Products you view from now on show up here.' : 'Products you view show up here.'}</p>
        )}
      </section>
    </AccountLayout>
  );
}
