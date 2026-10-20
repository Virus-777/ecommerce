/**
 * Search speed by catalog size (npm run bench:search; docs/07-search-speed-plan.md). Builds catalogs of generated
 * products in a throwaway in-memory database, written through the search repository like the indexer does, and times
 * the store endpoints: the median of three warm runs, one user.
 *
 *   BENCH_SIZES=1000,20000,50000   catalog sizes (products; 2 offers each), cumulative
 *
 * MongoDB engine only: the generated products go into the search copy directly, not through an OpenSearch index.
 */
import { afterAll, beforeAll, it } from 'vitest';
import { newId } from '../../../kernel/lib/ids.js';
import { spec } from '../../../spec/search.js';
import type { DocRow, DocWrite, OfferRow } from '../ports.js';
import { SearchRepository } from '../repository.js';
import { schemas } from '../schema.js';
import { boot, shop, STORE, type Kit } from './helpers.js';

const SIZES = (process.env.BENCH_SIZES ?? '1000,20000,50000').split(',').map(Number).filter((n) => n > 0);

const NOUNS = 'headphones earbuds speaker soundbar microphone keyboard mouse monitor webcam router charger cable adapter powerbank tablet laptop stand dock hub drive ssd memory card case cover sleeve backpack lamp kettle toaster blender mixer grinder scale fan heater humidifier purifier vacuum mop iron dryer trimmer shaver brush watch tracker camera lens tripod drone projector remote controller gamepad console printer scanner shredder label phone holder mount'.split(' ');
const ADJ = 'wireless bluetooth portable compact smart premium ergonomic waterproof rechargeable foldable slim mini pro ultra quiet fast magnetic adjustable digital electric cordless noise-cancelling lightweight heavy-duty classic modern travel gaming studio outdoor kids'.split(' ');
const COLORS = ['Black', 'White', 'Silver', 'Blue', 'Red', 'Green', 'Grey', 'Pink'];
const DESC = 'durable battery hours charge usb type quality sound bass clear design comfortable fit premium material steel aluminium plastic grip easy setup app control warranty year gift home office kitchen travel sport running daily use power efficient led display touch button long lasting high performance'.split(' ');

/** Repeatable pseudo-random numbers, so every run builds the same catalog */
function generator(seed = 42) {
  let s = seed;
  const rnd = () => (s = (s * 1103515245 + 12345) % 2 ** 31) / 2 ** 31;
  return { rnd, int: (n: number) => Math.floor(rnd() * n), of: <T>(a: readonly T[]) => a[Math.floor(rnd() * a.length)]! };
}

const QUERIES: Array<[string, string]> = [
  ['Specific search ("brand7tek lamp")', `${STORE}/products?q=brand7tek%20lamp`],
  ['Two words ("wireless speaker")', `${STORE}/products?q=wireless%20speaker`],
  ['Broad word ("wireless")', `${STORE}/products?q=wireless`],
  ['Very common word ("battery")', `${STORE}/products?q=battery`],
  ['Broad word, price low to high', `${STORE}/products?q=wireless&sort=price_asc`],
  ['Typo ("wirelss")', `${STORE}/products?q=wirelss`],
  ['Category page: product list', `${STORE}/products?category=electronics`],
  ['Category page: filter counts', `${STORE}/facets?category=electronics`],
  ['Broad word: filter counts', `${STORE}/facets?q=wireless`],
  ['Category with a price filter, by price', `${STORE}/products?category=electronics&priceMin=5000&priceMax=20000&sort=price_asc`],
  ['Suggestions while typing ("wir")', `${STORE}/suggestions?q=wir`],
];

let k: Kit;
beforeAll(async () => {
  k = await boot();
  await shop(k);
});
afterAll(async () => {
  await k?.close();
});

it('times the store search endpoints by catalog size', async () => {
  const store = k.app.kernel.mongo.module('search', spec.collections, schemas);
  const repo = new SearchRepository(store);
  const templates = await store.table<DocRow>('search_documents').find();
  const sellerIds = [...new Set((await store.table<OfferRow>('search_offers').find()).map((o) => o.seller_id).filter((s): s is string => Boolean(s)))];
  const g = generator();
  const brands = Array.from({ length: 300 }, (_, i) => ({ id: newId(), name: `Brand${i}${['tek', 'sound', 'home', 'max', 'line'][i % 5]}` }));
  await store.table('suggestion_terms').insertMany(brands.map((b) => ({ id: newId(), term: b.name.toLowerCase(), kind: 'brand', target_id: b.id, weight: '1', updated_at: new Date() })));

  const product = (i: number): { doc: DocWrite; offers: OfferRow[] } => {
    const { terms: _t, version: _v, indexed_at: _i, ...t } = templates[i % templates.length]!;
    const brand = g.of(brands);
    const title = `${brand.name} ${g.of(ADJ)} ${g.of(NOUNS)} ${String.fromCharCode(65 + g.int(26))}${String.fromCharCode(65 + g.int(26))}-${100 + g.int(900)}`;
    const color = g.of(COLORS);
    const id = newId();
    const p1 = 1000 + g.int(50000);
    const p2 = p1 + g.int(3000);
    const featured = newId();
    const inStock = g.rnd() > 0.1;
    const offers: OfferRow[] = [
      { offer_id: featured, product_id: id, variant_id: newId(), seller_id: null, official: true, condition: 'new', price: p1, in_stock: inStock, free_delivery: g.rnd() > 0.5, dispatch_days: g.int(4), featured_eligible: true },
      { offer_id: newId(), product_id: id, variant_id: newId(), seller_id: sellerIds[i % Math.max(1, sellerIds.length)] ?? null, official: false, condition: g.rnd() > 0.8 ? 'used' : 'new', price: p2, in_stock: g.rnd() > 0.2, free_delivery: false, dispatch_days: g.int(5), featured_eligible: false },
    ];
    const doc = {
      ...t,
      product_id: id,
      title,
      title_norm: `${brand.name} ${title}`.toLowerCase(),
      slug: `bench-${i}`,
      brand_id: brand.id,
      brand_name: brand.name,
      attributes: { color: [color] },
      gtins: [],
      variant_gtins: {},
      featured_offer_id: featured,
      featured_price: p1,
      min_price: p1,
      max_price: p2,
      in_stock: inStock || offers[1]!.in_stock,
      rating: g.int(5) + 1,
      rating_count: g.int(40),
      sales_30d: g.int(30),
      popularity: String(g.int(100)),
      first_listed_at: new Date(Date.now() - g.int(300) * 86_400_000),
      texts: { title, brand: brand.name, category: 'Electronics Headphones', attributes: color, description: Array.from({ length: 12 }, () => g.of(DESC)).join(' ') },
    } as unknown as DocWrite;
    return { doc, offers };
  };

  let made = 0;
  const grow = async (n: number) => {
    while (made < n) {
      const batch = Array.from({ length: Math.min(200, n - made) }, (_, j) => product(made + j));
      await Promise.all(batch.map((p) => repo.upsertDocument(p.doc, p.offers, new Date())));
      made += batch.length;
    }
  };
  const time = async (url: string) => {
    const t0 = performance.now();
    const r = await k.call('GET', url);
    if (r.status !== 200) throw new Error(`${url} → ${r.status} ${JSON.stringify(r.body).slice(0, 300)}`);
    return performance.now() - t0;
  };

  const rows = new Map<string, string[]>(QUERIES.map(([label]) => [label, []]));
  for (const n of SIZES) {
    await grow(n);
    for (const [label, url] of QUERIES) {
      await time(url);
      const runs = [await time(url), await time(url), await time(url)].sort((a, b) => a - b);
      rows.get(label)!.push(`${Math.round(runs[1]!).toLocaleString()} ms`);
    }
  }
  const head = `| Request | ${SIZES.map((n) => `${n.toLocaleString()} products`).join(' | ')} |`;
  const line = `|---|${SIZES.map(() => '---').join('|')}|`;
  console.log(['', head, line, ...[...rows].map(([label, cells]) => `| ${label} | ${cells.join(' | ')} |`), ''].join('\n'));
});
