import { useState, type MouseEvent } from 'react';
import { Link } from 'react-router';
import { StoreLayout } from '@/layouts';
import { num } from '@/lib/format';
import { brands, products } from '@/data/fixtures';
import { href } from '@/routes/href';
import { Badge, Breadcrumbs, Icon, Img, LogoTile, Price } from '@/ui';
import { CATEGORY_TREE, TOTAL_PRODUCTS, type TopCategory } from './data/categories';

// Design: pages/store/store-categories.html (phone: category rail + pane; website: category card grid).

const slugify = (s: string) => s.toLowerCase().replace(/&/g, 'and').replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
const catHref = (slug: string) => href('store/category', '', { slug });

/** Brands for the phone pane: the category's own brands first, topped up to three. */
function paneBrands(cat: TopCategory) {
  const own = new Set(products.filter((p) => p.cat === cat.id).map((p) => p.brand));
  return [...brands.filter((b) => own.has(b.name)), ...brands.filter((b) => !own.has(b.name))].slice(0, 3);
}

function PhonePane({ cat }: { cat: TopCategory }) {
  const soonSub = cat.subs.find((s) => s.soon);
  const deal = products.find((p) => p.cat === cat.id && p.was);
  return (
    <div className="pane">
      <div className="row between base">
        <h2 className="h3">{cat.name}</h2>
        <Link className="small strong" to={catHref(cat.id)}>
          Shop all ({num(cat.count)})
        </Link>
      </div>
      <div className="shop-tiles">
        {cat.subs.map((s) =>
          s.soon ? (
            <span key={s.name} className="shop-tile is-soon">
              <Img icon={s.icon} tint="surface-3" />
              <span>{s.name}</span>
              <span className="n">Coming soon</span>
            </span>
          ) : (
            <Link key={s.name} className="shop-tile" to={catHref(slugify(s.name))}>
              <Img icon={s.icon} tint={cat.tint} />
              <span>{s.name}</span>
              <span className="n">{s.count} items</span>
            </Link>
          ),
        )}
      </div>
      {soonSub && (
        <p className="xs muted">
          <Icon name="info" className="ic-sm" /> {soonSub.name} has no sellers with stock yet, so it can't be opened. We list it so you know it's planned.
        </p>
      )}
      <div className="stack gap-3">
        <h2 className="h4">Popular brands</h2>
        <div className="shop-tiles">
          {paneBrands(cat).map((b) => (
            <Link key={b.name} className="shop-tile" to={href('store/brand', '', { slug: slugify(b.name) })}>
              <LogoTile initials={b.initials} tint={b.tint} />
              <span>{b.name}</span>
            </Link>
          ))}
        </div>
      </div>
      {deal && (
        <div className="stack gap-3">
          <h2 className="h4">{cat.name} deals</h2>
          <Link className="row gap-3 nowrap card pad link-plain" to={href('store/product')}>
            <Img icon={deal.icon} tint={deal.tint} className="tiny" />
            <span className="stack gap-0">
              <span className="small strong truncate">{deal.name}</span>
              <Price amount={deal.price} was={deal.was} />
            </span>
          </Link>
        </div>
      )}
    </div>
  );
}

export default function Categories() {
  const open = CATEGORY_TREE.filter((c) => !c.soon);
  const [activeId, setActiveId] = useState(open[0].id);
  const active = open.find((c) => c.id === activeId) ?? open[0];

  const pick = (e: MouseEvent, c: TopCategory) => {
    e.preventDefault();
    if (!c.soon) setActiveId(c.id);
  };

  return (
    <StoreLayout tab="categories">
      <div className="only-phone">
        <div className="shop-rail">
          <nav aria-label="Top categories">
            {CATEGORY_TREE.map((c) => (
              <a
                key={c.id}
                href="#"
                className={c.soon ? 'is-soon' : c.id === active.id ? 'is-active' : ''}
                aria-current={!c.soon && c.id === active.id ? 'true' : undefined}
                aria-disabled={c.soon || undefined}
                onClick={(e) => pick(e, c)}
              >
                <Icon name={c.icon} />
                <span>{c.name}</span>
                {c.soon && <span className="soon">Coming soon</span>}
              </a>
            ))}
          </nav>
          <PhonePane cat={active} />
        </div>
      </div>
      <div className="container page cat-page">
        <div className="stack gap-2">
          <Breadcrumbs className="no-phone" items={[{ label: 'Home', to: href('store/home') }, { label: 'All categories' }]} />
          <h1 className="h1 acct-h1">All categories</h1>
          <p className="sub no-phone">{num(TOTAL_PRODUCTS)} products from the Official Store and approved sellers. Counts show items in stock now.</p>
        </div>
        <div className="shop-catgrid no-phone">
          {CATEGORY_TREE.map((c) =>
            c.soon ? (
              <section key={c.id} className="card shop-catcard is-soon" aria-label={`${c.name}, coming soon`}>
                <Img icon={c.icon} tint={c.tint} />
                <div className="row between base">
                  <h2 className="h3">{c.name}</h2>
                  <Badge>Coming soon</Badge>
                </div>
                <p className="small sub">Opens when approved sellers have stock here. We hide empty categories so you never land on an empty page.</p>
              </section>
            ) : (
              <section key={c.id} className="card shop-catcard" aria-labelledby={`cat-${c.id}`}>
                <Link to={catHref(c.id)} aria-hidden="true" tabIndex={-1}>
                  <Img icon={c.icon} tint={c.tint} />
                </Link>
                <div className="row between base">
                  <h2 className="h3" id={`cat-${c.id}`}>
                    <Link to={catHref(c.id)} className="link-plain">
                      {c.name}
                    </Link>
                  </h2>
                  <span className="xs muted">{num(c.count)}</span>
                </div>
                <ul>
                  {c.subs.map((s) => (
                    <li key={s.name}>
                      {s.soon ? (
                        <span>
                          <span className="muted">{s.name}</span>
                          <Badge>Coming soon</Badge>
                        </span>
                      ) : (
                        <Link to={catHref(slugify(s.name))}>
                          <span>{s.name}</span>
                          <span className="n">{s.count}</span>
                        </Link>
                      )}
                    </li>
                  ))}
                </ul>
                <Link className="small strong" to={catHref(c.id)}>
                  Shop all {c.name} <Icon name="arrow-right" className="ic-sm" />
                </Link>
              </section>
            ),
          )}
        </div>
        <div className="row gap-3 small sub no-phone">
          <Icon name="store" />
          <span>
            Want to sell in a category that isn't open yet?{' '}
            <Link to={href('sell/landing')} className="link-inline">
              Apply to sell on Marketly
            </Link>
            .
          </span>
        </div>
      </div>
    </StoreLayout>
  );
}
