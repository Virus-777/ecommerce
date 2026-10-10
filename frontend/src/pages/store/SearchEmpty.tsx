import { useState, type FormEvent } from 'react';
import { Link, useNavigate, useSearchParams } from 'react-router';
import { StoreLayout } from '@/layouts';
import { useView } from '@/lib/hooks';
import { auroraOffers, customer, sellers, type Offer } from '@/data/fixtures';
import { href } from '@/routes/href';
import { Alert, Badge, Breadcrumbs, Button, Field, Icon, Price, ProductCard, SellerBadge, ShipLine, Stars, TextInput, type IconName } from '@/ui';
import { HEADPHONES } from './data/category';

// Design: pages/store/store-search-empty.html (no results) · view "product-unavailable" = an
// out-of-stock product variant with other sellers' offers. The query comes from ?q=.

const DESIGN_QUERY = 'halden aurora pink';
const byId = (id: string) => HEADPHONES.find((h) => h.id === id)!;
const POPULAR = ['aurora', 'aurora-buds', 'wave', 'aria', 'studio2'].map(byId);
const SIMILAR = ['wave-pro', 'lumen-q3', 'studio2', 'wave', 'aurora-buds'].map(byId);

/** Filters the design query was searched with, and the results left when each is removed. */
const DESIGN_FILTERS = [
  { label: 'Color: Pink', results: 9 },
  { label: 'Condition: Used', results: 4 },
  { label: 'Price: under $100', results: 3 },
];

const NEARBY: Array<{ label: string; icon: IconName; slug: string }> = [
  { label: 'Headphones', icon: 'headphones', slug: 'headphones' },
  { label: 'Earbuds', icon: 'ear', slug: 'in-ear-and-earbuds' },
  { label: 'Speakers', icon: 'speaker', slug: 'speakers' },
  { label: 'Headphone accessories', icon: 'cable', slug: 'headphone-accessories' },
];

const COLORS = [
  { name: 'Midnight black', note: 'in stock' },
  { name: 'Stone', note: 'from other sellers' },
  { name: 'Sage', note: 'in stock' },
];
const OTHER_OFFERS: Offer[] = auroraOffers.filter((o) => o.seller === 'northwind' || o.seller === 'pixelport');

const searchHref = (q: string) => href('store/search', '', undefined, { q });

function NoResults({ q }: { q: string }) {
  const navigate = useNavigate();
  const designQuery = q.trim().toLowerCase() === DESIGN_QUERY;
  const filters = designQuery ? DESIGN_FILTERS : [];
  const nAll = 12;

  return (
    <StoreLayout tab="home" q={q}>
      <div className="container page gap-6">
        <div className="stack gap-2">
          <h1 className="h2">No results for “{q}”</h1>
          {filters.length > 0 && <p className="small sub">with {filters.length} filters applied</p>}
        </div>
        <div className="card pad stack gap-4">
          {filters.length > 0 ? (
            <div className="empty">
              <span className="ring">
                <Icon name="search-x" />
              </span>
              <h2 className="h3">Nothing matches all your filters</h2>
              <p className="small muted measure-md">Aurora headphones come in Midnight black, Stone and Sage. Try removing a filter. Each button shows how many results you will get.</p>
            </div>
          ) : (
            <div className="empty">
              <span className="ring">
                <Icon name="search-x" />
              </span>
              <h2 className="h3">Nothing matches your search</h2>
              <p className="small muted measure-md">Check the spelling or try fewer words. You can also browse a category below.</p>
            </div>
          )}
          {filters.length > 0 && (
            <div className="row gap-2 u-justify-center">
              {filters.map((f) => (
                <a
                  key={f.label}
                  className="chip"
                  href="#"
                  onClick={(e) => {
                    e.preventDefault();
                    navigate(searchHref('halden aurora'));
                  }}
                >
                  <Icon name="x" className="ic-sm" />
                  Remove {f.label} <span className="muted">({f.results} results)</span>
                </a>
              ))}
            </div>
          )}
          <div className="row gap-3 u-justify-center">
            {filters.length > 0 ? (
              <Button variant="secondary" to={searchHref('halden aurora')}>
                Clear all filters ({nAll} results)
              </Button>
            ) : (
              <Button variant="secondary" to={href('store/categories')}>
                Browse all categories
              </Button>
            )}
            <Button variant="ghost" to={href('store/category')}>
              Search all Headphones
            </Button>
          </div>
        </div>
        <section className="stack gap-3" aria-labelledby="nr-cats">
          <h2 className="h3" id="nr-cats">
            Nearby categories
          </h2>
          <div className="hscroll gap-2">
            {NEARBY.map((c) => (
              <Link key={c.slug} className="chip" to={href('store/category', '', { slug: c.slug })}>
                <Icon name={c.icon} />
                {c.label}
              </Link>
            ))}
          </div>
        </section>
        <section className="stack gap-3" aria-labelledby="nr-tips">
          <h2 className="h3" id="nr-tips">
            Search tips
          </h2>
          <ul className="ul small sub stack gap-1">
            <li>Check the spelling or use fewer words, for example “halden aurora”.</li>
            <li>Search by brand, product type or seller name.</li>
            <li>Colors are listed as the brand names them. Aurora's light color is “Stone”.</li>
          </ul>
        </section>
        <section className="stack gap-4" aria-labelledby="nr-pop">
          <div className="row between base">
            <h2 className="h2">
              <span id="nr-pop">Popular in Headphones</span>
            </h2>
            <Link className="small strong" to={href('store/category')}>
              See all <Icon name="arrow-right" className="ic-sm" />
            </Link>
          </div>
          <div className="grid-products wide">
            {POPULAR.map((p) => (
              <ProductCard key={p.id} p={p} showSeller from />
            ))}
          </div>
        </section>
      </div>
    </StoreLayout>
  );
}

function BackInStock() {
  const [email, setEmail] = useState(customer.email);
  const [error, setError] = useState('');
  const [done, setDone] = useState(false);
  const submit = (e: FormEvent) => {
    e.preventDefault();
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email.trim())) {
      setError('Enter an email address, like name@example.com.');
      return;
    }
    setError('');
    setDone(true);
  };
  if (done) {
    return (
      <Alert tone="success" title="We'll email you when it's back">
        One email to <b>{email.trim()}</b> when the Official Store has Stone in stock.{' '}
        <a href="#" className="link-inline" onClick={(e) => (e.preventDefault(), setDone(false))}>
          Change email
        </a>
      </Alert>
    );
  }
  return (
    <form className="well stack gap-3" onSubmit={submit} noValidate>
      <span className="strong">
        <Icon name="bell-ring" className="ic-sm" /> Email me when it's back
      </span>
      <Field label="Email" hint={error ? undefined : 'We send one email when the Official Store has Stone in stock. No marketing.'} error={error || undefined}>
        <TextInput id="pu-email" type="email" value={email} error={!!error} onChange={(e) => setEmail(e.target.value)} placeholder="" />
      </Field>
      <Button type="submit" icon="bell">
        Email me when it’s back
      </Button>
    </form>
  );
}

function Unavailable() {
  return (
    <StoreLayout appbar={{ title: 'Product', back: href('store/category') }}>
      <div className="container page gap-6">
        <Breadcrumbs
          items={[
            { label: 'Home', to: href('store/home') },
            { label: 'Electronics', to: href('store/categories') },
            { label: 'Headphones', to: href('store/category') },
            { label: 'Halden Aurora' },
          ]}
        />
        <div className="shop-pdp" style={{ gridTemplateColumns: 'minmax(0,1fr)' }}>
          <div className="split">
            <div className="grid md2 gap-6 u-items-start">
              <div className="pcard-media">
                <div className="imgph tint-5">
                  <Icon name="headphones" />
                </div>
                <span style={{ position: 'absolute', top: '12px', left: '12px' }}>
                  <Badge tone="danger">Out of stock</Badge>
                </span>
              </div>
              <div className="stack gap-3">
                <Link className="small strong" to={href('store/brand')}>
                  Halden
                </Link>
                <h1 className="h2">Halden Aurora ANC Wireless Headphones, Stone</h1>
                <Stars rating={4.6} count={1284} />
                <Alert tone="warning" title="Out of stock at the Official Store">
                  Marketly Official expects more Stone units around Oct 26. Dates from suppliers can change. Other sellers still have this color below.
                </Alert>
                <div className="stack gap-2">
                  <span className="small strong">Color: Stone</span>
                  <div className="row gap-2">
                    <div className="hscroll gap-2">
                      {COLORS.map((c) =>
                        c.name === 'Stone' ? (
                          <a key={c.name} className="chip is-active" href="#" aria-current="true">
                            {c.name} · {c.note}
                          </a>
                        ) : (
                          <Link key={c.name} className="chip" to={href('store/product')}>
                            {c.name} · {c.note}
                          </Link>
                        ),
                      )}
                    </div>
                  </div>
                </div>
                <BackInStock />
              </div>
            </div>
            <section className="card" aria-labelledby="pu-alt">
              <div className="card-head">
                <div className="stack gap-0">
                  <h2 className="h4" id="pu-alt">
                    Available from other sellers
                  </h2>
                  <span className="xs muted">Same product and color. Seller, condition and terms differ.</span>
                </div>
              </div>
              <ul className="list pad">
                {OTHER_OFFERS.map((o) => {
                  const s = sellers[o.seller];
                  return (
                    <li key={o.seller} className="items-start">
                      <div className="stack gap-2 grow">
                        <div className="row between">
                          <span className="row gap-2">
                            <b className="small">{s.name}</b>
                            <SellerBadge seller={s} compact />
                          </span>
                          <Badge tone="outline">{o.condition}</Badge>
                        </div>
                        <div className="row gap-2 base">
                          <Price amount={o.price} />
                          <span className="xs muted">{o.ship ? `+ $${o.ship.toFixed(2)} shipping` : 'Free shipping'}</span>
                        </div>
                        <ShipLine>
                          Arrives {o.delivery} · {o.returns}
                        </ShipLine>
                        {o.note && (
                          <span className="shop-note">
                            <Icon name="info" />
                            {o.note}
                          </span>
                        )}
                        <Button variant="secondary" size="sm" to={href('store/product', 'seller-offer-selected')}>
                          Choose this offer
                        </Button>
                      </div>
                    </li>
                  );
                })}
              </ul>
              <div className="card-foot">
                <Link className="small strong" to={href('store/offers')}>
                  Compare all offers <Icon name="arrow-right" className="ic-sm" />
                </Link>
              </div>
            </section>
          </div>
        </div>
        <section className="card pad row gap-4 nowrap" aria-labelledby="pu-old">
          <div className="imgph thumb tint-surface-3">
            <Icon name="headphones" />
          </div>
          <div className="stack gap-1 grow">
            <span className="row gap-2">
              <h2 className="h4" id="pu-old">
                Halden Aurora (2025 model)
              </h2>
              <Badge>No longer available</Badge>
            </span>
            <span className="small sub">From your recently viewed. Halden stopped making this model and replaced it with the 2026 Aurora above. Your past orders and reviews for it stay in your account.</span>
          </div>
        </section>
        <section className="stack gap-4" aria-labelledby="pu-sim">
          <div className="row between base">
            <h2 className="h2">
              <span id="pu-sim">Similar headphones in stock</span>
            </h2>
            <Link className="small strong" to={href('store/category')}>
              See all <Icon name="arrow-right" className="ic-sm" />
            </Link>
          </div>
          <div className="grid-products wide">
            {SIMILAR.map((p) => (
              <ProductCard key={p.id} p={p} showSeller from />
            ))}
          </div>
        </section>
      </div>
    </StoreLayout>
  );
}

export default function SearchEmpty() {
  const [view] = useView<'product-unavailable'>();
  const [params] = useSearchParams();
  const q = params.get('q')?.trim() || DESIGN_QUERY;
  return view === 'product-unavailable' ? <Unavailable /> : <NoResults key={q} q={q} />;
}
