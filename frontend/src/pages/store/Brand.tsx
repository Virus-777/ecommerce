import { useState } from 'react';
import { Link } from 'react-router';
import { brands } from '@marketly/web-shared/data/fixtures';
import { StoreLayout } from '@/layouts';
import { num } from '@marketly/web-shared/lib/format';
import { href } from '@marketly/web-shared/routes';
import { Breadcrumbs, Chip, ChipRow, Icon, Img, LogoTile, Pager, ProductCard, type IconName } from '@marketly/web-shared/ui';
import { SORT_OPTIONS, items, sortItems, type SortKey } from './data/collection';

// Design: pages/store/store-brand.html (Halden). Chips filter the grid, Sort re-sorts it, the pager pages it.

const BRAND = brands.find((b) => b.name === 'Halden') ?? brands[0];
const PER_PAGE = 8;

const COLLECTIONS: Array<{ name: string; icon: IconName; tint: string; count: number }> = [
  { name: 'Aurora noise cancelling', icon: 'headphones', tint: '2', count: 6 },
  { name: 'Pocket speakers', icon: 'speaker', tint: '2', count: 9 },
  { name: 'Travel accessories', icon: 'briefcase', tint: '5', count: 8 },
];

/** Chip value = product `sub`; count = items in the whole brand catalogue. */
const CHIPS: Array<{ value: string; label: string; count: number }> = [
  { value: '', label: 'All', count: BRAND.products },
  { value: 'Headphones', label: 'Headphones', count: 21 },
  { value: 'Earbuds', label: 'Earbuds', count: 9 },
  { value: 'Speakers', label: 'Speakers', count: 14 },
  { value: 'Accessories', label: 'Accessories', count: 4 },
];

const PRODUCTS = items(['aurora', 'auroraBuds', 'aria', 'studio2', 'speaker', 'pocketMini', 'air', 'travelCase']);

export default function Brand() {
  const [chip, setChip] = useState('');
  const [sort, setSort] = useState<SortKey>('Recommended');
  const [page, setPage] = useState(1);

  const active = CHIPS.find((c) => c.value === chip) ?? CHIPS[0];
  const pages = Math.max(1, Math.ceil(active.count / PER_PAGE));
  const first = (page - 1) * PER_PAGE + 1;
  const last = Math.min(page * PER_PAGE, active.count);
  const list = sortItems(
    PRODUCTS.filter((p) => !chip || p.sub === chip),
    sort,
  );
  const pick = (v: string) => {
    setChip(v);
    setPage(1);
  };

  return (
    <StoreLayout nav="brands" appbar={{ title: BRAND.name }}>
      <div className="container page gap-6">
        <Breadcrumbs items={[{ label: 'Home', to: href('store/home') }, { label: 'Brands', to: href('store/brand') }, { label: BRAND.name }]} />
        <section className="shop-hero" aria-labelledby="br-h">
          <div className="ban tint-2" aria-hidden="true">
            <Icon name="headphones" />
            <Icon name="speaker" />
            <Icon name="ear" />
          </div>
          <div className="id">
            <LogoTile initials={BRAND.initials} tint={BRAND.tint} className="lg" />
            <div className="stack gap-1 grow">
              <h1 className="display d-lg" id="br-h">
                {BRAND.name}
              </h1>
              <span className="small sub">Brand collection · {num(BRAND.products)} products · Headphones, earbuds and speakers</span>
            </div>
          </div>
          <div className="stack gap-2 u-p-0-sp-5-sp-5">
            <p className="sub u-maxw-72ch">
              Halden makes noise-cancelling headphones and compact speakers for travel and small homes. Products here come from the Official Store and from approved sellers. Each card names the seller, and the product page compares all offers.
            </p>
          </div>
        </section>

        <section className="stack gap-3" aria-labelledby="br-col">
          <h2 className="h3" id="br-col">
            Collections
          </h2>
          <div className="shop-collections">
            {COLLECTIONS.map((c) => (
              <Link key={c.name} className="shop-coll" to={href('store/collection', 'best-sellers')}>
                <Img icon={c.icon} tint={c.tint} />
                <span className="stack gap-1">
                  <span className="strong">{c.name}</span>
                  <span className="xs muted">{c.count} products</span>
                </span>
              </Link>
            ))}
          </div>
        </section>

        <section className="stack gap-4" aria-labelledby="br-all">
          <h2 className="h3" id="br-all">
            All {BRAND.name} products
          </h2>
          <ChipRow>
            {CHIPS.map((c) => (
              <Chip key={c.value} active={chip === c.value} onClick={() => pick(c.value)}>
                {c.label} ({c.count})
              </Chip>
            ))}
          </ChipRow>
          <div className="shop-toolbar">
            <span className="small sub" aria-live="polite">
              Showing {first}–{last} of {active.count}
            </span>
            <span className="shop-sort">
              <label className="small sub nowrap" htmlFor="br-sort">
                Sort by
              </label>
              <select className="select" id="br-sort" value={sort} onChange={(e) => setSort(e.target.value as SortKey)}>
                {SORT_OPTIONS.map((o) => (
                  <option key={o}>{o}</option>
                ))}
              </select>
            </span>
          </div>
          <div className="grid-products">
            {list.map((p) => (
              <ProductCard key={p.id} p={p} from showSeller />
            ))}
          </div>
          <div className="row end">
            <Pager page={page} total={pages} onPage={setPage} grid end={page >= pages} />
          </div>
        </section>
      </div>
    </StoreLayout>
  );
}
