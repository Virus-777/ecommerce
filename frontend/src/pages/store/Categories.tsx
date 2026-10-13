import { useState, type MouseEvent } from 'react';
import { Link } from 'react-router';
import { useQuery } from '@tanstack/react-query';
import { StoreLayout } from '@/layouts';
import { call, useApi } from '@marketly/web-shared/api';
import { dollars, num } from '@marketly/web-shared/lib/format';
import { href } from '@marketly/web-shared/routes';
import { Badge, Breadcrumbs, Icon, Price } from '@marketly/web-shared/ui';
import { categoryArt, initialsOf, tintOf, useCategoryTree, type Category } from '@/api/catalog';
import { LoadError, LogoPic, Pic, SkLines } from '@/api/cards';
import { productHref } from '@/api/search';

// Design: pages/store/store-categories.html (phone: category rail + pane; website: category card grid).
// Data: GET /api/store/catalog/categories (tree with in-stock counts); the phone pane adds the
// category's popular brands (GET /api/store/catalog/brands?categorySlug&sort=popular) and one deal
// (GET /api/store/search/products?category&onSale=true&limit=1).

const catHref = (slug: string) => href('store/category', '', { slug });

function PhonePane({ cat }: { cat: Category }) {
  const { api } = useApi();
  const art = categoryArt(cat.slug);
  const brands = useQuery({
    queryKey: ['catalog', 'brands', { categorySlug: cat.slug, sort: 'popular', limit: 3 }],
    queryFn: () => call(api.GET('/api/store/catalog/brands', { params: { query: { categorySlug: cat.slug, sort: 'popular', limit: 3 } } })),
  });
  const deal = useQuery({
    queryKey: ['search', 'products', { category: cat.slug, onSale: true }, { page: 1, limit: 1 }],
    queryFn: () => call(api.GET('/api/store/search/products', { params: { query: { category: cat.slug, onSale: true, page: 1, limit: 1 } } })),
    select: (r) => r.items[0]?.product,
  });
  const subs = cat.children ?? [];
  const soonSub = subs.find((s) => s.comingSoon);
  const d = deal.data;
  return (
    <div className="pane">
      <div className="row between base">
        <h2 className="h3">{cat.name}</h2>
        <Link className="small strong" to={catHref(cat.slug)}>
          Shop all ({num(cat.productCount)})
        </Link>
      </div>
      <div className="shop-tiles">
        {subs.map((s) => {
          const a = categoryArt(s.slug, cat.slug);
          return s.comingSoon ? (
            <span key={s.id} className="shop-tile is-soon">
              <Pic image={s.image} icon={a.icon} tint="surface-3" />
              <span>{s.name}</span>
              <span className="n">Coming soon</span>
            </span>
          ) : (
            <Link key={s.id} className="shop-tile" to={catHref(s.slug)}>
              <Pic image={s.image} icon={a.icon} tint={art.tint} />
              <span>{s.name}</span>
              <span className="n">{num(s.productCount)} items</span>
            </Link>
          );
        })}
      </div>
      {soonSub && (
        <p className="xs muted">
          <Icon name="info" className="ic-sm" /> {soonSub.name} has no sellers with stock yet, so it can't be opened. We list it so you know it's planned.
        </p>
      )}
      {(brands.data?.items.length ?? 0) > 0 && (
        <div className="stack gap-3">
          <h2 className="h4">Popular brands</h2>
          <div className="shop-tiles">
            {brands.data!.items.map((b) => (
              <Link key={b.id} className="shop-tile" to={href('store/brand', '', { slug: b.slug })}>
                <LogoPic logo={b.logo} initials={initialsOf(b.name)} tint={tintOf(b.name)} />
                <span>{b.name}</span>
              </Link>
            ))}
          </div>
        </div>
      )}
      {d && (
        <div className="stack gap-3">
          <h2 className="h4">{cat.name} deals</h2>
          <Link className="row gap-3 nowrap card pad link-plain" to={productHref({ id: d.productId, slug: d.slug })}>
            <Pic image={d.image} className="tiny" />
            <span className="stack gap-0">
              <span className="small strong truncate">{d.title}</span>
              <Price amount={dollars(d.price)} was={d.wasPrice ? dollars(d.wasPrice) : null} />
            </span>
          </Link>
        </div>
      )}
    </div>
  );
}

export default function Categories() {
  const tree = useCategoryTree();
  const roots = tree.data ?? [];
  const open = roots.filter((c) => !c.comingSoon);
  const [activeId, setActiveId] = useState<string | null>(null);
  const active = open.find((c) => c.id === activeId) ?? open[0];
  const total = roots.reduce((n, c) => n + c.productCount, 0);

  const pick = (e: MouseEvent, c: Category) => {
    e.preventDefault();
    if (!c.comingSoon) setActiveId(c.id);
  };

  return (
    <StoreLayout tab="categories">
      {active && (
        <div className="only-phone">
          <div className="shop-rail">
            <nav aria-label="Top categories">
              {roots.map((c) => (
                <a
                  key={c.id}
                  href="#"
                  className={c.comingSoon ? 'is-soon' : c.id === active.id ? 'is-active' : ''}
                  aria-current={!c.comingSoon && c.id === active.id ? 'true' : undefined}
                  aria-disabled={c.comingSoon || undefined}
                  onClick={(e) => pick(e, c)}
                >
                  <Icon name={categoryArt(c.slug).icon} />
                  <span>{c.name}</span>
                  {c.comingSoon && <span className="soon">Coming soon</span>}
                </a>
              ))}
            </nav>
            <PhonePane cat={active} />
          </div>
        </div>
      )}
      <div className="container page cat-page">
        <div className="stack gap-2">
          <Breadcrumbs className="no-phone" items={[{ label: 'Home', to: href('store/home') }, { label: 'All categories' }]} />
          <h1 className="h1 acct-h1">All categories</h1>
          {tree.isSuccess && <p className="sub no-phone">{num(total)} products from the Official Store and approved sellers. Counts show items in stock now.</p>}
        </div>
        {tree.isError && <LoadError error={tree.error} onRetry={() => void tree.refetch()} title="We couldn’t load the categories" />}
        {tree.isPending && (
          <div className="shop-catgrid" aria-busy="true">
            {Array.from({ length: 6 }, (_, i) => (
              <section key={i} className="card shop-catcard" aria-hidden="true">
                <span className="sk sk-img" />
                <SkLines n={4} />
              </section>
            ))}
          </div>
        )}
        <div className="shop-catgrid no-phone">
          {roots.map((c) => {
            const art = categoryArt(c.slug);
            return c.comingSoon ? (
              <section key={c.id} className="card shop-catcard is-soon" aria-label={`${c.name}, coming soon`}>
                <Pic image={c.image} icon={art.icon} tint={art.tint} />
                <div className="row between base">
                  <h2 className="h3">{c.name}</h2>
                  <Badge>Coming soon</Badge>
                </div>
                <p className="small sub">Opens when approved sellers have stock here. We hide empty categories so you never land on an empty page.</p>
              </section>
            ) : (
              <section key={c.id} className="card shop-catcard" aria-labelledby={`cat-${c.id}`}>
                <Link to={catHref(c.slug)} aria-hidden="true" tabIndex={-1}>
                  <Pic image={c.image} icon={art.icon} tint={art.tint} />
                </Link>
                <div className="row between base">
                  <h2 className="h3" id={`cat-${c.id}`}>
                    <Link to={catHref(c.slug)} className="link-plain">
                      {c.name}
                    </Link>
                  </h2>
                  <span className="xs muted">{num(c.productCount)}</span>
                </div>
                <ul>
                  {(c.children ?? []).map((s) => (
                    <li key={s.id}>
                      {s.comingSoon ? (
                        <span>
                          <span className="muted">{s.name}</span>
                          <Badge>Coming soon</Badge>
                        </span>
                      ) : (
                        <Link to={catHref(s.slug)}>
                          <span>{s.name}</span>
                          <span className="n">{num(s.productCount)}</span>
                        </Link>
                      )}
                    </li>
                  ))}
                </ul>
                <Link className="small strong" to={catHref(c.slug)}>
                  Shop all {c.name} <Icon name="arrow-right" className="ic-sm" />
                </Link>
              </section>
            );
          })}
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
