/**
 * One-off rescue of the real product catalogue out of the MongoDB development database and into the repository
 * (docs/10-mysql-migration.md §18.1). D10 starts the MySQL system empty, and these products exist nowhere else:
 * their import tool (DummyJSON, Open Food Facts) was removed on 2026-10-17 and only their image files survive,
 * under MEDIA_STORAGE_DIR, which is not in the repository either.
 *
 *   npx tsx tools/export-catalog-seed.ts [mongodb://127.0.0.1:27017/marketly?replicaSet=rs0]
 *
 * It writes src/modules/catalog/seed/real-products.json and src/modules/catalog/seed/images/*, which
 * `npm run seed` loads through the Admin Center and Seller Center APIs.
 *
 * Which products: everything in catalog.products that the simulator does not seed (tools/simulate/data.ts
 * STORES and OFFICIAL_PRODUCTS, matched on the exact title or the title plus a run suffix), less the `sample`
 * rows and the leftovers of old audit runs. That is 130 products, and the `Photo source` spec says what each
 * one is: 82 from DummyJSON, 15 from Open Food Facts and 10 from Open Beauty Facts (107 imported, the figure
 * the project has always quoted), plus 23 with no such spec — the curated web seed whose own seeder was
 * removed on 2026-10-17. All 130 are unreproducible, so all 130 are kept.
 *
 * Attribution: the Open Food Facts and Open Beauty Facts products carry CC BY-SA 3.0 text in their specs, and
 * `sources` in the written file counts them, so the storefront credit can be checked against the data.
 *
 * This reads MongoDB directly rather than through the API because it is a rescue, run once, against a database
 * that is about to stop being the source of truth. Nothing else in tools/ may do that.
 */
import { MongoClient } from 'mongodb';
import { mkdirSync, copyFileSync, writeFileSync, existsSync } from 'node:fs';
import path from 'node:path';
import { OFFICIAL_PRODUCTS, STORES } from './simulate/data.js';

const uri = process.argv[2] ?? process.env.MONGODB_URI ?? 'mongodb://127.0.0.1:27017/marketly?replicaSet=rs0';
const mediaDir = process.env.MEDIA_STORAGE_DIR ?? '.data/media';
const outDir = 'src/modules/catalog/seed';
const imageDir = path.join(outDir, 'images');

/** Titles the simulator creates; its official-store products carry a per-run suffix */
const simulated = [...STORES.flatMap((s) => s.products.map((p) => p.title)), ...OFFICIAL_PRODUCTS.map((p) => p.title)];
const isSimulated = (title: string) => simulated.some((t) => title === t || title.startsWith(`${t} `));
const isLeftover = (title: string) => title === 'sample' || /^(Audit |qdqdq|sasd)/.test(title);

interface SeedImage {
  file: string;
  contentType: string;
  alt: string | null;
  title: string | null;
}
interface SeedVariant {
  options: Record<string, string>;
  gtin: string | null;
  weightGrams: number | null;
  lengthCm: number | null;
  widthCm: number | null;
  heightCm: number | null;
  listPrice: { amount: number; currency: string } | null;
  images: string[];
}
interface SeedOffer {
  ownerType: string;
  condition: string;
  conditionNotes: string | null;
  sellerSku: string | null;
  price: { amount: number; currency: string };
  variantOptions: Record<string, string>;
}
interface SeedProduct {
  title: string;
  slug: string;
  ownerType: string;
  brand: string;
  categoryPath: string[];
  modelNumber: string | null;
  mpn: string | null;
  noGtin: boolean;
  description: string;
  keyFeatures: string[];
  specs: Record<string, unknown>;
  includedItems: string[];
  images: string[];
  variants: SeedVariant[];
  offers: SeedOffer[];
}

const client = new MongoClient(uri);
await client.connect();
const db = client.db();
const col = (name: string) => db.collection<any>(name) as any;

const products = (await col('catalog.products').find({}).toArray()).filter(
  (p: any) => !isSimulated(p.title ?? '') && !isLeftover(p.title ?? ''),
);
const productIds = products.map((p: any) => p._id);

const brands = new Map<string, any>((await col('catalog.brands').find({}).toArray()).map((b: any) => [b._id, b]));
const categories = new Map<string, any>((await col('catalog.categories').find({}).toArray()).map((c: any) => [c._id, c]));
const variants = await col('catalog.variants').find({ product_id: { $in: productIds } }).toArray();
const variantsByProduct = new Map<string, any[]>();
for (const v of variants) {
  const list = variantsByProduct.get(v.product_id) ?? [];
  list.push(v);
  variantsByProduct.set(v.product_id, list);
}
const variantById = new Map<string, any>(variants.map((v: any) => [v._id, v]));
const offers = await col('offers.offers').find({ variant_id: { $in: variants.map((v: any) => v._id) } }).toArray();
const offersByVariant = new Map<string, any[]>();
for (const o of offers) {
  const list = offersByVariant.get(o.variant_id) ?? [];
  list.push(o);
  offersByVariant.set(o.variant_id, list);
}

const referenced = new Set<string>();
for (const p of products) for (const id of p.media_ids ?? []) referenced.add(id);
for (const v of variants) for (const id of v.media_ids ?? []) referenced.add(id);
const assets = new Map<string, any>(
  (await col('media.assets').find({ _id: { $in: [...referenced] } }).toArray()).map((a: any) => [a._id, a]),
);

/** Category names from the root down; a path is what the seeder creates or matches on */
function pathOf(id: string | null): string[] {
  const out: string[] = [];
  let node = id ? categories.get(id) : null;
  while (node) {
    out.unshift(node.name);
    node = node.parent_id ? categories.get(node.parent_id) : null;
  }
  return out;
}

const EXT: Record<string, string> = { 'image/jpeg': '.jpeg', 'image/png': '.png', 'image/webp': '.webp', 'image/avif': '.avif' };

mkdirSync(imageDir, { recursive: true });
const images = new Map<string, SeedImage>();
const problems: string[] = [];

/** Copies an asset's original next to the seed and answers the file name the seed refers to */
function imageOf(id: string): string | null {
  const asset = assets.get(id);
  if (!asset) {
    problems.push(`asset ${id} is referenced but missing from media.assets`);
    return null;
  }
  const ext = EXT[asset.content_type] ?? path.extname(asset.storage_key) ?? '.bin';
  const file = `${id}${ext}`;
  if (!images.has(file)) {
    const from = path.join(mediaDir, asset.storage_bucket, asset.storage_key);
    if (!existsSync(from)) {
      problems.push(`file for asset ${id} not on disk: ${from}`);
      return null;
    }
    copyFileSync(from, path.join(imageDir, file));
    images.set(file, { file, contentType: asset.content_type, alt: asset.alt ?? null, title: asset.title ?? null });
  }
  return file;
}

const seeded: SeedProduct[] = [];
for (const p of products) {
  const brand = p.brand_id ? brands.get(p.brand_id) : null;
  if (!brand) problems.push(`${p.title}: no brand`);
  const categoryPath = pathOf(p.category_id ?? null);
  if (!categoryPath.length) problems.push(`${p.title}: no category`);
  const vs = variantsByProduct.get(p._id) ?? [];
  if (!vs.length) problems.push(`${p.title}: no variants`);
  seeded.push({
    title: p.title,
    slug: p.slug,
    ownerType: p.owner_type,
    brand: brand?.name ?? '',
    categoryPath,
    modelNumber: p.model_number ?? null,
    mpn: p.mpn ?? null,
    noGtin: Boolean(p.no_gtin),
    description: p.description ?? '',
    keyFeatures: p.key_features ?? [],
    specs: p.specs ?? {},
    includedItems: p.included_items ?? [],
    images: (p.media_ids ?? []).map(imageOf).filter((f: string | null): f is string => Boolean(f)),
    variants: vs
      .sort((a: any, b: any) => (a.position ?? 0) - (b.position ?? 0))
      .map((v: any) => ({
        options: v.options ?? {},
        gtin: v.gtin ?? null,
        weightGrams: v.weight_grams ?? null,
        lengthCm: v.length_cm ?? null,
        widthCm: v.width_cm ?? null,
        heightCm: v.height_cm ?? null,
        listPrice: v.list_price_amount != null ? { amount: v.list_price_amount, currency: v.list_price_currency ?? 'USD' } : null,
        images: (v.media_ids ?? []).map(imageOf).filter((f: string | null): f is string => Boolean(f)),
      })),
    offers: vs.flatMap((v: any) =>
      (offersByVariant.get(v._id) ?? [])
        .filter((o: any) => o.status !== 'removed')
        .map((o: any) => ({
          ownerType: o.owner_type,
          condition: o.condition,
          conditionNotes: o.condition_notes ?? null,
          sellerSku: o.seller_sku ?? null,
          price: { amount: o.price_amount, currency: o.currency ?? 'USD' },
          variantOptions: variantById.get(o.variant_id)?.options ?? {},
        })),
    ),
  });
}

seeded.sort((a, b) => a.brand.localeCompare(b.brand) || a.title.localeCompare(b.title));

const brandList = [...new Set(seeded.map((p) => p.brand))].filter(Boolean).sort();
const categoryPaths = [...new Set(seeded.map((p) => p.categoryPath.join(' > ')))].filter(Boolean).sort().map((s) => s.split(' > '));

/** What each product says about where its information and photo came from; `curated` has no such spec */
const sources: Record<string, number> = {};
for (const p of seeded) {
  const key = (p.specs as Record<string, unknown>)['Photo source'];
  sources[typeof key === 'string' ? key : 'curated (no photo source; the web seed removed on 2026-10-17)'] =
    (sources[typeof key === 'string' ? key : 'curated (no photo source; the web seed removed on 2026-10-17)'] ?? 0) + 1;
}

const seed = {
  note:
    'Real product catalogue rescued from the MongoDB development database on 2026-10-23 (docs/10 §18.1). ' +
    'The Open Food Facts and Open Beauty Facts products are used under CC BY-SA 3.0 and are credited in the ' +
    'storefront; `sources` below counts them. Generated by tools/export-catalog-seed.ts; edit that tool, not this file.',
  exportedAt: new Date().toISOString(),
  counts: { products: seeded.length, brands: brandList.length, categories: categoryPaths.length, images: images.size },
  sources,
  brands: brandList,
  categories: categoryPaths,
  images: [...images.values()].sort((a, b) => a.file.localeCompare(b.file)),
  products: seeded,
};

writeFileSync(path.join(outDir, 'real-products.json'), `${JSON.stringify(seed, null, 2)}\n`);

console.log(`products   ${seeded.length}`);
console.log(`brands     ${brandList.length}`);
console.log(`categories ${categoryPaths.length}`);
console.log(`images     ${images.size} copied to ${imageDir}`);
console.log(`offers     ${seeded.reduce((n, p) => n + p.offers.length, 0)}`);
if (problems.length) {
  console.log(`\n${problems.length} problem(s):`);
  for (const p of problems.slice(0, 40)) console.log(`  ${p}`);
  process.exitCode = 1;
} else {
  console.log('\nno problems: every product has a brand, a category, variants and its images');
}

await client.close();
