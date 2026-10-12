import { useRef, useState, type FormEvent } from 'react';
import { Link } from 'react-router';
import { SellerLayout } from '@marketly/web-shared/layouts';
import { useView } from '@marketly/web-shared/lib/hooks';
import { money } from '@marketly/web-shared/lib/format';
import { href } from '@marketly/web-shared/routes';
import { Badge, Button, Card, Chip, EmptyState, Icon, Img, PageHeader, Steps, type IconName, type Tone } from '@marketly/web-shared/ui';

// Design: pages/seller/seller-catalog-match.html · view "no-match" = a search with no catalog result
// (empty state + close matches). Searching the catalog switches between the two.

type View = 'no-match';
type Mode = 'name' | 'model' | 'gtin' | 'brand';

interface CatalogProduct {
  id: string;
  name: string;
  brand: string;
  model: string;
  gtin: string;
  path: string;
  icon: IconName;
  tint: string;
  variations: string[];
  inBox: string;
  offers: number;
  from: number;
  added: string;
  /** How the catalog compares it with the searched model. */
  match: { label: string; tone: Tone; icon: IconName };
  /** The seller's own offers on this product. */
  yours?: string;
}

const CATALOG: CatalogProduct[] = [
  { id: 'ha-anc700', name: 'Halden Aurora ANC Wireless Headphones', brand: 'Halden', model: 'HA-ANC700', gtin: '0 84067 31207 4', path: 'Electronics › Headphones › Over-ear', icon: 'headphones', tint: '2', variations: ['Midnight black', 'Silver', 'Sand'], inBox: 'Headphones, hard carry case, USB-C cable (1.2 m), 3.5 mm audio cable, airplane adapter', offers: 4, from: 129, added: '2026-03-02', match: { label: 'Exact model match', tone: 'success', icon: 'circle-check' }, yours: 'You sell Midnight black (New, Used – Good) and Silver (New).' },
  { id: 'ha-anc700-tb', name: 'Halden Aurora ANC Wireless Headphones, Travel Bundle', brand: 'Halden', model: 'HA-ANC700-TB', gtin: '0 84067 31288 3', path: 'Electronics › Headphones › Over-ear', icon: 'headphones', tint: '2', variations: ['Midnight black'], inBox: 'Everything in HA-ANC700, plus a wireless charging stand and spare ear cushions', offers: 1, from: 239, added: '2026-06-18', match: { label: 'Same model, different bundle', tone: 'warning', icon: 'info' } },
  { id: 'ha-on300', name: 'Halden Aurora Lite On-Ear Headphones', brand: 'Halden', model: 'HA-ON300', gtin: '0 84067 30951 7', path: 'Electronics › Headphones › On-ear', icon: 'headphones', tint: '1', variations: ['Black', 'White', 'Coral'], inBox: 'Headphones, soft pouch, USB-C cable', offers: 2, from: 79, added: '2026-01-20', match: { label: 'Different model', tone: '', icon: 'info' } },
  { id: 'ha-pkt', name: 'Halden Pocket Bluetooth Speaker', brand: 'Halden', model: 'HP-SPK10', gtin: '0 84067 29875 0', path: 'Electronics › Speakers › Portable', icon: 'speaker', tint: '6', variations: ['Teal', 'Charcoal'], inBox: 'Speaker, USB-C cable, lanyard', offers: 3, from: 54, added: '2026-02-11', match: { label: 'Exact model match', tone: 'success', icon: 'circle-check' }, yours: 'You sell Teal (New) and Charcoal (New).' },
  { id: 'lumen-b5', name: 'Lumen B5 Bookshelf Speakers (pair)', brand: 'Lumen', model: 'LB5-WAL', gtin: '0 71249 55120 6', path: 'Electronics › Speakers › Bookshelf', icon: 'speaker', tint: '3', variations: ['Walnut', 'Black'], inBox: 'Two speakers, speaker wire (2 × 3 m), grilles', offers: 2, from: 239, added: '2026-07-04', match: { label: 'Exact model match', tone: 'success', icon: 'circle-check' } },
];

const MODES: Array<{ value: Mode; label: string }> = [
  { value: 'name', label: 'Name' },
  { value: 'model', label: 'Model number' },
  { value: 'gtin', label: 'GTIN / UPC' },
  { value: 'brand', label: 'Brand' },
];

const norm = (s: string) => s.toLowerCase().replace(/\s+/g, ' ').trim();
const digits = (s: string) => s.replace(/\D/g, '');

function search(q: string, mode: Mode): CatalogProduct[] {
  const n = norm(q);
  if (!n) return [];
  return CATALOG.filter((p) => {
    if (mode === 'gtin') return digits(q).length > 0 && digits(p.gtin).includes(digits(q));
    if (mode === 'model') return norm(p.model).includes(n);
    if (mode === 'brand') return norm(p.brand) === n;
    // Name: every word must appear in the name or model number.
    const hay = norm(`${p.name} ${p.model}`);
    return n.split(' ').every((w) => hay.includes(w));
  });
}

/** When nothing matches, the products sharing the most words (never offered as the same model). */
function closeMatches(q: string): CatalogProduct[] {
  const words = norm(q).split(' ').filter(Boolean);
  return CATALOG.map((p) => ({ p, score: words.filter((w) => norm(`${p.name} ${p.model}`).includes(w)).length }))
    .filter((x) => x.score > 0)
    .sort((a, b) => b.score - a.score)
    .slice(0, 2)
    .map((x) => x.p);
}

const SORTS: Record<string, (a: CatalogProduct, b: CatalogProduct) => number> = {
  'Best match': () => 0,
  'Most offers': (a, b) => b.offers - a.offers,
  Newest: (a, b) => b.added.localeCompare(a.added),
};

export default function CatalogMatch() {
  const [view, setView] = useView<View>();
  const initial = view === 'no-match' ? 'Halden Aurora Studio HA-ANC900' : 'Halden Aurora';
  const [input, setInput] = useState(initial);
  const [query, setQuery] = useState(initial);
  const [mode, setMode] = useState<Mode>('name');
  const [sort, setSort] = useState('Best match');
  const inputRef = useRef<HTMLInputElement>(null);

  const results = [...search(query, mode)].sort(SORTS[sort]);
  const noMatch = query.trim() !== '' && results.length === 0;
  const close = noMatch ? closeMatches(query) : [];

  const run = (q: string, m: Mode = mode) => {
    setQuery(q);
    setView(search(q, m).length === 0 && q.trim() ? 'no-match' : '', { replace: true });
  };
  const submit = (e: FormEvent) => {
    e.preventDefault();
    run(input);
  };
  const pickMode = (m: Mode) => {
    setMode(m);
    run(input, m);
  };
  const byGtin = () => {
    setMode('gtin');
    setInput('');
    inputRef.current?.focus();
  };

  return (
    <SellerLayout active="products">
      <PageHeader
        crumbs={[{ label: 'Products and offers', to: href('seller/products') }, { label: 'Add product' }]}
        title="Find the product in the catalog"
        sub="If the product already exists, add your offer to it so customers compare sellers on one page."
      />
      <Steps items={[<><span className="sr-only">Step 1 of 3: </span>Find the product</>, 'Create your offer', 'Publish']} current={0} />
      <div className="sa-split">
        <div className="stack gap-4">
          <div className="card pad stack gap-3">
            <form className="toolbar" onSubmit={submit} role="search">
              <label className="search-in" htmlFor="cm-q">
                <Icon name="search" className="ic-sm" />
                <input
                  ref={inputRef}
                  id="cm-q"
                  type="search"
                  value={input}
                  aria-label="Search the catalog"
                  placeholder={mode === 'gtin' ? '12 or 13 digits from the barcode' : undefined}
                  inputMode={mode === 'gtin' ? 'numeric' : undefined}
                  onChange={(e) => setInput(e.target.value)}
                />
              </label>
              <Button type="submit">Search</Button>
            </form>
            <div className="row gap-2">
              <span className="xs muted">Search by</span>
              <div className="hscroll gap-2">
                {MODES.map((m) => (
                  <Chip key={m.value} active={mode === m.value} onClick={() => pickMode(m.value)}>
                    {m.label}
                  </Chip>
                ))}
              </div>
            </div>
          </div>
          {noMatch ? (
            <>
              <section className="card">
                <div className="card-body">
                  <EmptyState
                    icon="search-x"
                    as="h2"
                    title={`No catalog product matches "${query}"`}
                    action={
                      <div className="row gap-2 u-justify-center">
                        <Button icon="plus" to={href('seller/product-new')}>
                          Create a new product
                        </Button>
                        <Button variant="secondary" onClick={byGtin}>
                          Search by GTIN
                        </Button>
                      </div>
                    }
                  >
                    Before creating a new product, try the GTIN/UPC from the box, the model number alone, or remove color words from the search.
                  </EmptyState>
                </div>
              </section>
              {close.length > 0 && (
                <Card title="Close matches that are not the same model" titleAs="h3" sub="Do not add your offer to these if your model number is different" flush>
                  <ul className="list pad">
                    {close.map((p) => (
                      <li key={p.id}>
                        <Img icon={p.icon} tint={p.tint} className="tiny" />
                        <span className="grow stack gap-0">
                          <span className="small strong">{p.name}</span>
                          <span className="xs muted">
                            Model <span className="mono">{p.model}</span> · {p.offers} offers
                          </span>
                        </span>
                        <Badge tone="warning">Different model</Badge>
                      </li>
                    ))}
                  </ul>
                </Card>
              )}
            </>
          ) : results.length > 0 ? (
            <>
              <div className="row between">
                <span className="small sub">
                  {results.length} result{results.length === 1 ? '' : 's'} for <b>"{query}"</b> in Electronics
                </span>
                <label className="sr-only" htmlFor="cm-sort">
                  Sort
                </label>
                <select className="select" id="cm-sort" value={sort} onChange={(e) => setSort(e.target.value)}>
                  {Object.keys(SORTS).map((s) => (
                    <option key={s}>{s}</option>
                  ))}
                </select>
              </div>
              <section className="card">
                {results.map((p, i) => {
                  const H = i === 0 ? 'h2' : 'h3';
                  return (
                    <article className="sa-result" key={p.id}>
                      <Img icon={p.icon} tint={p.tint} />
                      <div className="stack gap-2">
                        <div className="row gap-2">
                          <Badge tone={p.match.tone} icon={p.match.icon}>
                            {p.match.label}
                          </Badge>
                          <span className="xs muted">{p.path}</span>
                        </div>
                        <H className="h4">{p.name}</H>
                        <span className="xs muted">
                          Brand {p.brand} · Model <span className="mono">{p.model}</span> · GTIN <span className="mono">{p.gtin}</span>
                        </span>
                        <div className="stack gap-1">
                          <span className="xs strong">Variations</span>
                          <div className="sa-pills">
                            {p.variations.map((v) => (
                              <Badge key={v} tone="outline">
                                {v}
                              </Badge>
                            ))}
                          </div>
                        </div>
                        <div className="stack gap-1">
                          <span className="xs strong">In the box</span>
                          <span className="small sub">{p.inBox}</span>
                        </div>
                        {p.yours && (
                          <span className="xs t-info-text strong row gap-1">
                            <Icon name="info" className="ic-sm" />
                            {p.yours}
                          </span>
                        )}
                      </div>
                      <div className="sa-go">
                        <span className="small">
                          <b>
                            {p.offers} offer{p.offers === 1 ? '' : 's'}
                          </b>{' '}
                          <span className="muted">from {money(p.from)}</span>
                        </span>
                        <Button variant={i === 0 ? 'primary' : 'secondary'} size="sm" to={href('seller/offer')}>
                          Sell this product
                        </Button>
                        <Link className="xs" to={href('store/product')}>
                          View product page
                        </Link>
                      </div>
                    </article>
                  );
                })}
              </section>
            </>
          ) : null}
        </div>
        <div className="stack gap-5">
          <Card title="Match precisely" titleAs="h3">
            <ul className="sa-checklist">
              <li className="ok">
                <span className="sr-only">Done: </span>
                <Icon name="circle-check" />
                <span>
                  <b>Model number</b> must be identical. HA-ANC700 and HA-ANC700-TB are different products.
                </span>
              </li>
              <li className="ok">
                <span className="sr-only">Done: </span>
                <Icon name="circle-check" />
                <span>
                  <b>Variation</b> must match: color, size or capacity.
                </span>
              </li>
              <li className="ok">
                <span className="sr-only">Done: </span>
                <Icon name="circle-check" />
                <span>
                  <b>Bundle contents</b> must match what is in your box. Extra or fewer items mean a different product.
                </span>
              </li>
              <li className="warn">
                <span className="sr-only">Incomplete: </span>
                <Icon name="triangle-alert" />
                <span>
                  <b>Used items</b> with missing accessories can join the product, but you must list what is missing in the condition notes.
                </span>
              </li>
            </ul>
            <p className="xs muted row gap-1 nowrap top">
              <Icon name="info" className="ic-sm" />
              <span className="wrap">Offers on the wrong product are removed by the Catalog team and count as a listing violation.</span>
            </p>
          </Card>
          <Card title="Can't find it?" titleAs="h3">
            <p className="small sub">Create a new product with full details. The Catalog team checks it for duplicates, accurate claims, image quality and the right category before it can go live.</p>
            <Button variant={noMatch ? 'primary' : 'secondary'} block icon="plus" to={href('seller/product-new')}>
              Create a new product
            </Button>
            <p className="xs muted row gap-1 nowrap top">
              <Icon name="info" className="ic-sm" />
              <span className="wrap">If the Catalog team finds a duplicate, it merges your submission into the existing product. Your offer, reviews and past orders stay linked.</span>
            </p>
          </Card>
        </div>
      </div>
    </SellerLayout>
  );
}
