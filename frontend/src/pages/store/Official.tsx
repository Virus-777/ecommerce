import { useState, type MouseEvent } from 'react';
import { Link } from 'react-router';
import { categories } from '@marketly/web-shared/data/fixtures';
import { StoreLayout } from '@/layouts';
import { href } from '@marketly/web-shared/routes';
import { Badge, Icon, Img, Pager, ProductCard, type IconName } from '@marketly/web-shared/ui';
import { SORT_OPTIONS, items, sortItems, type SortKey } from './data/collection';

// Design: pages/store/store-official.html. Sort re-sorts the grid and the pager pages it; the hero
// button jumps to the grid.

const PROMISES: Array<{ icon: IconName; title: string; sub: string }> = [
  { icon: 'truck', title: 'Free delivery over $35', sub: 'On Official Store items. $5.99 below that.' },
  { icon: 'undo-2', title: '30-day free returns', sub: 'Prepaid label or drop-off at any UPS store.' },
  { icon: 'shield-check', title: '2-year warranty on electronics', sub: 'We handle the claim with the brand.' },
  { icon: 'warehouse', title: 'Ships from Reno, NV', sub: 'Same or next business day dispatch.' },
];

const COLLECTIONS: Array<{ name: string; sub: string; icon: IconName; tint: string; to: string }> = [
  { name: 'Home Week picks', sub: 'Up to 30% off until Oct 19', icon: 'bed-double', tint: '1', to: href('store/collection', 'seasonal') },
  { name: 'Travel audio', sub: '14 products', icon: 'headphones', tint: '2', to: href('store/collection', 'best-sellers') },
  { name: 'Kitchen basics', sub: '22 products', icon: 'cooking-pot', tint: '3', to: href('store/collection') },
];

const TOTAL_ITEMS = '1,960';
const PAGES = 82;
const PRODUCTS = items(['aurora', 'skillet', 'sweater', 'pourover', 'lamp', 'serum', 'studio2', 'auroraBuds', 'kidsPhones', 'dutchOven']);

export default function Official() {
  const [sort, setSort] = useState<SortKey>('Recommended');
  const [page, setPage] = useState(1);
  const list = sortItems(PRODUCTS, sort);
  const toAll = (e: MouseEvent) => {
    e.preventDefault();
    document.getElementById('of-all')?.scrollIntoView({ behavior: 'smooth', block: 'start' });
  };

  return (
    <StoreLayout nav="official" appbar={{ title: 'Official Store' }}>
      <div className="container page gap-7">
        <section className="shop-off-hero" aria-labelledby="of-h">
          <div className="stack gap-3">
            <span className="row gap-2">
              <Badge tone="solid" icon="badge-check">
                Official Store
              </Badge>
            </span>
            <h1 className="display d-xl u-c-on-brand" id="of-h">
              Sold and shipped by Marketly
            </h1>
            <p style={{ maxWidth: '44ch' }} className="u-o-_9">
              Our own stock, bought from brands and their authorized distributors, packed in our Reno, NV warehouse. We handle delivery, returns and warranty claims ourselves.
            </p>
            <div className="row gap-2">
              <a className="btn btn-lg u-bg-on-brand u-c-brand-text-i" href="#of-all" onClick={toAll}>
                Shop all Official Store items
              </a>
            </div>
          </div>
          <div className="art" aria-hidden="true">
            <Img icon="headphones" tint="2" />
            <Img icon="cooking-pot" tint="3" />
            <Img icon="shirt" tint="4" />
          </div>
        </section>

        <section className="shop-promises" aria-label="Official Store promises">
          {PROMISES.map((p) => (
            <div key={p.title}>
              <Icon name={p.icon} />
              <span className="stack gap-1">
                <span className="small strong">{p.title}</span>
                <span className="xs muted">{p.sub}</span>
              </span>
            </div>
          ))}
        </section>

        <section className="stack gap-3" aria-labelledby="of-col">
          <h2 className="h2" id="of-col">
            Featured collections
          </h2>
          <div className="shop-collections">
            {COLLECTIONS.map((c) => (
              <Link key={c.name} className="shop-coll" to={c.to}>
                <Img icon={c.icon} tint={c.tint} />
                <span className="stack gap-1">
                  <span className="strong">{c.name}</span>
                  <span className="xs muted">{c.sub}</span>
                </span>
              </Link>
            ))}
          </div>
        </section>

        <section className="stack gap-4" aria-labelledby="of-cat">
          <h2 className="h2" id="of-cat">
            Shop the Official Store by category
          </h2>
          <div className="shop-shortcuts">
            {categories.map((c) => (
              <Link key={c.id} to={href('store/category')}>
                <Img icon={c.icon} tint={c.tint} />
                <span>{c.name}</span>
              </Link>
            ))}
          </div>
        </section>

        <section className="stack gap-4" id="of-all" aria-labelledby="of-grid">
          <h2 className="h2" id="of-grid">
            All Official Store items
          </h2>
          <div className="shop-toolbar">
            <span className="small sub">{TOTAL_ITEMS} items · prices shown are Official Store offers. Other sellers may list the same product.</span>
            <span className="shop-sort">
              <label className="small sub nowrap" htmlFor="of-sort">
                Sort by
              </label>
              <select className="select" id="of-sort" value={sort} onChange={(e) => setSort(e.target.value as SortKey)}>
                {SORT_OPTIONS.map((o) => (
                  <option key={o}>{o}</option>
                ))}
              </select>
            </span>
          </div>
          <div className="grid-products wide">
            {list.map((p) => (
              <ProductCard key={p.id} p={p} from />
            ))}
          </div>
          <div className="row end">
            <Pager page={page} total={PAGES} onPage={setPage} grid end={page >= PAGES} />
          </div>
        </section>
      </div>
    </StoreLayout>
  );
}
