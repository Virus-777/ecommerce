import { useState, type MouseEvent } from 'react';
import { Link } from 'react-router';
import { sellers } from '@/data/fixtures';
import { StoreLayout } from '@/layouts';
import { num } from '@/lib/format';
import { href } from '@/routes/href';
import {
  Badge, Button, Chip, ChipRow, CopyButton, EmptyState, Icon, IconButton, KeyValue, LogoTile, Pager, ProductCard, SearchInput, SellerBadge, Stars, Stat, Tabs,
} from '@/ui';
import { SORT_OPTIONS, items, sortItems, type SortKey } from './data/collection';
import { FEEDBACK, FEEDBACK_STATS, POLICIES, STORE, STORE_CHIPS, STORE_PRODUCT_IDS, VERIFIED } from './data/seller';

// Design: pages/store/store-seller.html (Northwind Audio storefront). The tabs jump to their section
// (products, seller feedback, policies); chips, store search and Sort filter the product grid.

const SELLER = sellers.northwind;
const PRODUCTS = items(STORE_PRODUCT_IDS);
const FEATURED = items(STORE.featured.ids);

type Tab = 'products' | 'feedback' | 'about';
const TAB_TARGET: Record<Tab, string> = { products: 'sl-all', feedback: 'sl-fb', about: 'sl-pol' };

const jump = (id: string) => document.getElementById(id)?.scrollIntoView({ behavior: 'smooth', block: 'start' });

export default function Seller() {
  const [tab, setTab] = useState<Tab>('products');
  const [chip, setChip] = useState('');
  const [q, setQ] = useState('');
  const [sort, setSort] = useState<SortKey>('Recommended');
  const [page, setPage] = useState(1);

  const active = STORE_CHIPS.find((c) => c.value === chip) ?? STORE_CHIPS[0];
  const pages = q.trim() ? 1 : Math.max(1, Math.ceil(active.count / STORE.perPage));
  const needle = q.trim().toLowerCase();
  const list = sortItems(
    PRODUCTS.filter((p) => (!chip || p.sub === chip) && (!needle || p.name.toLowerCase().includes(needle))),
    sort,
  );

  const openTab = (t: Tab) => {
    setTab(t);
    jump(TAB_TARGET[t]);
  };
  const toAll = (e?: MouseEvent) => {
    e?.preventDefault();
    jump('sl-all');
  };

  return (
    <StoreLayout
      appbar={{
        title: SELLER.name,
        back: href('store/product'),
        actions: <IconButton icon="search" label="Search this store" onClick={() => document.getElementById('sl-q')?.focus()} />,
      }}
    >
      <div className="container page gap-6">
        <section className="shop-hero" aria-labelledby="sl-h">
          <div className="ban tint-2">
            <span className="shop-ban-t">{STORE.banner}</span>
            <span className="no-phone">
              <Icon name="headphones" />
              <Icon name="speaker" />
            </span>
          </div>
          <div className="id">
            <LogoTile initials={SELLER.initials} tint={SELLER.tint} className="lg" />
            <div className="stack gap-1 grow minw-200">
              <div className="row gap-2">
                <h1 className="h1" id="sl-h">
                  {SELLER.name}
                </h1>
                <SellerBadge seller={SELLER} />
              </div>
              <div className="row gap-3 small sub">
                <span>
                  <Stars rating={STORE.rating} /> <b>{SELLER.positive}% positive</b> ({num(SELLER.ratings)} ratings)
                </span>
                <span>
                  <Icon name="map-pin" className="ic-sm" /> {SELLER.location}
                </span>
                <span>
                  <Icon name="clock" className="ic-sm" /> Ships in {SELLER.dispatch}
                </span>
                <span>Selling on Marketly since {STORE.since}</span>
              </div>
            </div>
            <div className="row gap-2">
              <Button variant="secondary" icon="message-square" to={href('account/messages')}>
                Contact seller
              </Button>
              <CopyButton text={typeof window !== 'undefined' ? window.location.href : href('store/seller')} label="Share store" icon="share-2" />
            </div>
          </div>
          <p className="small sub measure-lg u-p-0-sp-5-sp-5">{STORE.about}</p>
        </section>

        <div className="split">
          <div className="stack gap-6">
            <Tabs<Tab>
              items={[
                { value: 'products', label: 'Products', count: STORE.productCount },
                { value: 'feedback', label: 'Feedback', count: num(SELLER.ratings) },
                { value: 'about', label: 'About and policies' },
              ]}
              active={tab}
              onChange={openTab}
            />
            <div className="shop-promo">
              <Icon name="ticket-percent" />
              <div className="stack gap-0 grow">
                <span className="strong">{STORE.promo.title}</span>
                <span className="xs sub">{STORE.promo.terms}</span>
              </div>
              <Button variant="secondary" size="sm" onClick={() => toAll()}>
                Shop eligible items
              </Button>
            </div>

            <section className="stack gap-4" aria-labelledby="sl-feat">
              <div className="row between base">
                <h2 className="h2">
                  <span id="sl-feat">{STORE.featured.title}</span>
                </h2>
                <a className="small strong" href="#sl-all" onClick={toAll}>
                  See {STORE.featured.count} items <Icon name="arrow-right" className="ic-sm" />
                </a>
              </div>
              <div className="grid-products">
                {FEATURED.map((p) => (
                  <ProductCard key={p.id} p={p} from />
                ))}
              </div>
            </section>

            <section className="stack gap-4" aria-labelledby="sl-all">
              <h2 className="h3" id="sl-all">
                All products ({STORE.productCount})
              </h2>
              <ChipRow>
                {STORE_CHIPS.map((c) => (
                  <Chip
                    key={c.value}
                    active={chip === c.value}
                    onClick={() => {
                      setChip(c.value);
                      setPage(1);
                    }}
                  >
                    {c.value ? `${c.label} (${c.count})` : c.label}
                  </Chip>
                ))}
              </ChipRow>
              <div className="shop-toolbar">
                <SearchInput
                  id="sl-q"
                  placeholder="Search this store"
                  value={q}
                  onChange={(v) => {
                    setQ(v);
                    setPage(1);
                  }}
                />
                <span className="shop-sort">
                  <label className="small sub nowrap" htmlFor="sl-sort">
                    Sort by
                  </label>
                  <select className="select" id="sl-sort" value={sort} onChange={(e) => setSort(e.target.value as SortKey)}>
                    {SORT_OPTIONS.map((o) => (
                      <option key={o}>{o}</option>
                    ))}
                  </select>
                </span>
              </div>
              {list.length > 0 ? (
                <div className="grid-products">
                  {list.map((p) => (
                    <ProductCard key={p.id} p={p} from />
                  ))}
                </div>
              ) : (
                <EmptyState icon="search-x" title="No products in this store match your search" action={<Button variant="secondary" size="sm" onClick={() => { setQ(''); setChip(''); }}>Clear search</Button>}>
                  Try a different word, or search all of Marketly from the search bar.
                </EmptyState>
              )}
              <div className="row end">
                <Pager page={page} total={pages} onPage={setPage} grid end={page >= pages} />
              </div>
            </section>

            <section className="card" aria-labelledby="sl-fb">
              <div className="card-head">
                <div className="stack gap-0">
                  <h2 className="h3" id="sl-fb">
                    Seller feedback
                  </h2>
                  <span className="xs muted">About shipping, packaging and communication. Product reviews are on each product page.</span>
                </div>
                <a className="small strong" href="#">
                  See all {num(SELLER.ratings)}
                </a>
              </div>
              <div className="card-body">
                <div className="grid md3 gap-4">
                  {FEEDBACK_STATS.map((s) => (
                    <Stat key={s.k} label={s.k} value={s.v} note={s.d} />
                  ))}
                </div>
                <ul className="list">
                  {FEEDBACK.map((f) => (
                    <li key={f.id} className="items-start">
                      <div className="stack gap-1 grow">
                        <div className="row gap-2">
                          {f.positive ? (
                            <Badge tone="success" icon="thumbs-up">
                              Positive
                            </Badge>
                          ) : (
                            <Badge tone="danger" icon="thumbs-down">
                              Negative
                            </Badge>
                          )}
                          <span className="xs muted">
                            {f.buyer} · {f.date} · Item: {f.item}
                          </span>
                        </div>
                        <p className="small">{f.text}</p>
                        {f.reply && (
                          <div className="shop-reply">
                            <span className="xs strong">{SELLER.name} replied</span>
                            <span>{f.reply}</span>
                          </div>
                        )}
                      </div>
                    </li>
                  ))}
                </ul>
              </div>
            </section>
          </div>

          <aside className="stack gap-4">
            <section className="card" aria-labelledby="sl-ver">
              <div className="card-head">
                <h2 className="h4 row gap-2" id="sl-ver">
                  <Icon name="shield-check" /> What we verified
                </h2>
              </div>
              <div className="card-body shop-verify">
                <p className="small sub">Verified seller means Marketly checked these details before approving the store:</p>
                <ul>
                  {VERIFIED.map((v) => (
                    <li key={v}>
                      <Icon name="circle-check" />
                      <span>{v}</span>
                    </li>
                  ))}
                  <li className="no">
                    <Icon name="circle-minus" />
                    <span>
                      <b>Not checked:</b> the authenticity of each product. If a listing looks wrong,{' '}
                      <Link to={href('help/contact')} className="link-inline">
                        report it
                      </Link>
                      .
                    </span>
                  </li>
                </ul>
                <span className="xs muted">Last checked Mar 12, 2026</span>
              </div>
            </section>
            <section className="card" aria-labelledby="sl-pol">
              <div className="card-head">
                <h2 className="h4" id="sl-pol">
                  Shipping and returns
                </h2>
              </div>
              <div className="card-body">
                <KeyValue pairs={POLICIES} />
                <a className="small strong" href="#">
                  Full store policies
                </a>
              </div>
            </section>
            <p className="xs muted">
              Marketly support steps in if a seller doesn’t resolve a problem.{' '}
              <Link to={href('help/center')} className="link-inline">
                How buyer protection works
              </Link>
            </p>
          </aside>
        </div>
      </div>
    </StoreLayout>
  );
}
