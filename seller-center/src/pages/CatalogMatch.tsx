import { useEffect, useRef, useState, type FormEvent } from 'react';
import { keepPreviousData, useQuery } from '@tanstack/react-query';
import { Link } from 'react-router';
import { call, useApi, type components } from '@marketly/web-shared/api';
import { SellerLayout } from '@marketly/web-shared/layouts';
import { useView } from '@marketly/web-shared/lib/hooks';
import { formatMoney } from '@marketly/web-shared/lib/format';
import { href } from '@marketly/web-shared/routes';
import { Badge, Button, Card, Chip, EmptyState, Icon, Img, PageHeader, Steps, type IconName, type Tone } from '@marketly/web-shared/ui';
import { useSellerSession } from '@/app/session';
import { LoadError, SkeletonRows, conditionLabel, iconFor, optionsLabel } from './data/catalog-parts';
import { newOfferHref } from './data/products';

// Design: pages/seller/seller-catalog-match.html · view "no-match" = a search with no catalog result
// (empty state + close matches). Data: GET catalog/match (q, gtin, sort). "Sell this product" opens the
// offer form for the product; "View product page" links to the store product page.

type View = 'no-match';
type Mode = 'name' | 'model' | 'gtin' | 'brand';
type Sort = 'best_match' | 'most_offers' | 'newest';
type Match = components['schemas']['catalog.CatalogMatch'];

const MODES: Array<{ value: Mode; label: string }> = [
  { value: 'name', label: 'Name' },
  { value: 'model', label: 'Model number' },
  { value: 'gtin', label: 'GTIN / UPC' },
  { value: 'brand', label: 'Brand' },
];
const SORTS: Array<{ value: Sort; label: string }> = [
  { value: 'best_match', label: 'Best match' },
  { value: 'most_offers', label: 'Most offers' },
  { value: 'newest', label: 'Newest' },
];

const QUALITY: Record<Match['matchQuality'], { label: string; tone: Tone; icon: IconName }> = {
  exact: { label: 'Exact model match', tone: 'success', icon: 'circle-check' },
  same_model_different_bundle: { label: 'Same model, different bundle', tone: 'warning', icon: 'info' },
  different_model: { label: 'Different model', tone: '', icon: 'info' },
  title_only: { label: 'Name match', tone: '', icon: 'info' },
};

const digits = (s: string) => s.replace(/\D/g, '');
/** "0 84067 31207 4" style grouping for a 12/13-digit GTIN. */
const gtinLabel = (g?: string | null) => (g && /^\d{12,13}$/.test(g) ? (g.length === 12 ? `${g[0]} ${g.slice(1, 6)} ${g.slice(6, 11)} ${g[11]}` : `${g[0]} ${g.slice(1, 7)} ${g.slice(7, 12)} ${g[12]}`) : (g ?? ''));

/** "You sell Midnight black (New, Used – Good) and Silver (New)." */
function yoursLine(m: Match): string | null {
  if (!m.myOffers.length) return null;
  const by = new Map<string, string[]>();
  m.myOffers.forEach((o) => by.set(o.variantLabel, [...(by.get(o.variantLabel) ?? []), conditionLabel(o.condition)]));
  const parts = [...by].map(([v, cs]) => `${v} (${cs.join(', ')})`);
  return `You sell ${parts.length > 1 ? `${parts.slice(0, -1).join(', ')} and ${parts[parts.length - 1]}` : parts[0]}.`;
}

export default function CatalogMatch() {
  const { api } = useApi();
  const { can } = useSellerSession();
  const [view, setView] = useView<View>();
  const initial = view === 'no-match' ? 'Halden Aurora Studio HA-ANC900' : '';
  const [input, setInput] = useState(initial);
  const [query, setQuery] = useState(initial);
  const [mode, setMode] = useState<Mode>('name');
  const [sort, setSort] = useState<Sort>('best_match');
  const inputRef = useRef<HTMLInputElement>(null);

  const term = mode === 'gtin' ? digits(query) : query.trim();
  const results = useQuery({
    queryKey: ['catalog', 'match', mode, term, sort],
    queryFn: () => call(api.GET('/api/seller/catalog/match', { params: { query: { q: term, ...(mode === 'gtin' ? { gtin: term } : {}), sort, limit: 24 } } })),
    enabled: term !== '',
    placeholderData: keepPreviousData,
  });

  const items = term ? (results.data?.items ?? []) : [];
  const strict = mode === 'model' || mode === 'gtin';
  const sameModel = items.filter((m) => m.matchQuality === 'exact' || m.matchQuality === 'same_model_different_bundle');
  const done = !!results.data && !results.isPlaceholderData;
  // A model or GTIN search with only other models is a no-match: those are listed as close matches.
  const noMatch = term !== '' && done && (items.length === 0 || (strict && sameModel.length === 0));
  const close = noMatch ? items.filter((m) => m.matchQuality === 'different_model' || m.matchQuality === 'title_only').slice(0, 2) : [];
  const shown = noMatch ? [] : items;
  const total = results.data?.total ?? shown.length;
  const top = new Set(shown.map((m) => m.categoryPath[0]).filter(Boolean));

  useEffect(() => {
    if (!done || !term) return;
    if (noMatch !== (view === 'no-match')) setView(noMatch ? 'no-match' : '', { replace: true });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [done, noMatch, term]);

  const run = (q: string) => setQuery(q);
  const submit = (e: FormEvent) => {
    e.preventDefault();
    run(input);
  };
  const pickMode = (m: Mode) => {
    setMode(m);
    run(input);
  };
  const byGtin = () => {
    setMode('gtin');
    setInput('');
    setQuery('');
    inputRef.current?.focus();
  };
  const canSell = can('offers.offers.manage');

  return (
    <SellerLayout active="products">
      <PageHeader
        crumbs={[{ label: 'Products and offers', to: href('seller/products') }, { label: 'Add product' }]}
        title="Find the product in the catalog"
        sub="If the product already exists, add your offer to it so customers compare sellers on one page."
      />
      <Steps items={['Find the product', 'Create your offer', 'Publish']} current={0} />
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
                  placeholder={mode === 'gtin' ? '12 or 13 digits from the barcode' : mode === 'model' ? 'e.g. HA-AUR26' : mode === 'brand' ? 'e.g. Halden' : 'Product name, model or GTIN'}
                  inputMode={mode === 'gtin' ? 'numeric' : undefined}
                  onChange={(e) => setInput(e.target.value)}
                />
              </label>
              <Button type="submit" disabled={results.isFetching && !!term}>
                Search
              </Button>
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
          {results.isError && term ? (
            <LoadError error={results.error} onRetry={() => void results.refetch()} />
          ) : term && !done ? (
            <section className="card">
              <SkeletonRows rows={3} />
            </section>
          ) : noMatch ? (
            <>
              <section className="card">
                <div className="card-body">
                  <EmptyState
                    icon="search-x"
                    as="h2"
                    title={`No catalog product matches "${query.trim()}"`}
                    action={
                      <div className="row gap-2 u-justify-center">
                        {can('catalog.products.submit') && (
                          <Button icon="plus" to={href('seller/product-new')}>
                            Create a new product
                          </Button>
                        )}
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
                    {close.map((m) => (
                      <li key={m.product.id}>
                        <Img icon={iconFor(m.product.title, ...m.categoryPath)} tint="2" src={m.product.image?.url ?? undefined} className="tiny" />
                        <span className="grow stack gap-0">
                          <span className="small strong">{m.product.title}</span>
                          <span className="xs muted">
                            {m.modelNumber ? (
                              <>
                                Model <span className="mono">{m.modelNumber}</span> ·{' '}
                              </>
                            ) : null}
                            {m.offerCount} offer{m.offerCount === 1 ? '' : 's'}
                          </span>
                        </span>
                        <Badge tone="warning">Different model</Badge>
                      </li>
                    ))}
                  </ul>
                </Card>
              )}
            </>
          ) : shown.length > 0 ? (
            <>
              <div className="row between">
                <span className="small sub">
                  {total} result{total === 1 ? '' : 's'} for <b>"{query.trim()}"</b>
                  {top.size === 1 ? ` in ${[...top][0]}` : ''}
                </span>
                <label className="sr-only" htmlFor="cm-sort">
                  Sort
                </label>
                <select className="select" id="cm-sort" value={sort} onChange={(e) => setSort(e.target.value as Sort)}>
                  {SORTS.map((s) => (
                    <option key={s.value} value={s.value}>
                      {s.label}
                    </option>
                  ))}
                </select>
              </div>
              <section className="card">
                {shown.map((m, i) => {
                  const H = i === 0 ? 'h2' : 'h3';
                  const q = QUALITY[m.matchQuality];
                  const yours = yoursLine(m);
                  const gtin = m.variants.find((v) => v.gtin)?.gtin;
                  return (
                    <article className="sa-result" key={m.product.id}>
                      <Img icon={iconFor(m.product.title, ...m.categoryPath)} tint="2" src={m.product.image?.url ?? undefined} alt={m.product.image?.alt ?? ''} />
                      <div className="stack gap-2">
                        <div className="row gap-2">
                          <Badge tone={q.tone} icon={q.icon}>
                            {q.label}
                          </Badge>
                          <span className="xs muted">{m.categoryPath.join(' › ')}</span>
                        </div>
                        <H className="h4">{m.product.title}</H>
                        <span className="xs muted">
                          {[
                            m.product.brand ? `Brand ${m.product.brand.name}` : null,
                            m.modelNumber ? (
                              <span key="m">
                                Model <span className="mono">{m.modelNumber}</span>
                              </span>
                            ) : null,
                            gtin ? (
                              <span key="g">
                                GTIN <span className="mono">{gtinLabel(gtin)}</span>
                              </span>
                            ) : null,
                          ]
                            .filter(Boolean)
                            .flatMap((x, j) => (j ? [' · ', x] : [x]))}
                        </span>
                        {m.variants.length > 0 && (
                          <div className="stack gap-1">
                            <span className="xs strong">Variations</span>
                            <div className="sa-pills">
                              {m.variants.map((v) => (
                                <Badge key={v.id} tone="outline">
                                  {optionsLabel(v.options) || 'Standard'}
                                </Badge>
                              ))}
                            </div>
                          </div>
                        )}
                        {m.includedItems.length > 0 && (
                          <div className="stack gap-1">
                            <span className="xs strong">In the box</span>
                            <span className="small sub">{m.includedItems.join(', ')}</span>
                          </div>
                        )}
                        {yours && (
                          <span className="xs t-info-text strong row gap-1">
                            <Icon name="info" className="ic-sm" />
                            {yours}
                          </span>
                        )}
                      </div>
                      <div className="sa-go">
                        <span className="small">
                          <b>
                            {m.offerCount} offer{m.offerCount === 1 ? '' : 's'}
                          </b>
                          {m.lowestPrice ? <span className="muted"> from {formatMoney(m.lowestPrice)}</span> : null}
                        </span>
                        {canSell && (
                          <Button variant={i === 0 ? 'primary' : 'secondary'} size="sm" to={newOfferHref(m.product.id, m.variants.length === 1 ? m.variants[0].id : undefined)}>
                            Sell this product
                          </Button>
                        )}
                        <Link className="xs" to={href('store/product', '', { slug: m.product.slug, id: m.product.id })}>
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
          {can('catalog.products.submit') && (
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
          )}
        </div>
      </div>
    </SellerLayout>
  );
}
