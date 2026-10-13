/**
 * Flow 3, catalog and stock:
 *   - the Catalog Manager keeps the brands; sellers draft products with variants and photos and submit them;
 *   - after its first submission each seller passes the launch review (Seller Manager);
 *   - the Catalog Manager approves the products; sellers publish offers with price and stock;
 *   - the Official Store: its warehouse, bins and box types (reused across runs), company products, stock items,
 *     a purchase order received through purchasing and confirmed by inventory, put away in bins, and Official
 *     Store offers on that stock;
 *   - search: the index job runs, then a shopper searches, filters and sorts, and finds the new products.
 */
import { BRAND_NOTES, OFFICIAL_PRODUCTS, OFFICIAL_WAREHOUSE, STORES, type ProductSeed } from '../data.js';
import type { Session } from '../http.js';
import type { OfferWorld, SellerWorld, Sim } from '../sim.js';

const usd = (amount: number) => ({ amount, currency: 'USD' });

/** Colours for the product photo stand-ins */
const COLOURS: Record<string, [number, number, number]> = {
  Black: [30, 30, 34], Sand: [214, 196, 160], Teal: [40, 140, 140], Charcoal: [60, 64, 70], Coral: [240, 128, 110], Walnut: [110, 74, 48],
  'Matte black': [25, 25, 25], 'Brushed steel': [180, 184, 190], White: [240, 240, 240], Clear: [220, 235, 240], Moss: [96, 120, 70], Rust: [170, 80, 40],
  Glacier: [200, 225, 240], Basalt: [70, 72, 78], Fir: [40, 90, 60], Graphite: [80, 80, 86], Silver: [192, 192, 196], Orange: [240, 140, 40],
};
const colour = (v: string): [number, number, number] => COLOURS[v] ?? [120, 140, 160];

/** Brands: reused when they exist, created by the Catalog Manager when missing */
async function ensureBrand(sim: Sim, name: string): Promise<string> {
  const { api, world: w } = sim;
  const known = w.brands.get(name);
  if (known) return known;
  const cm = w.staff.catalog!.session;
  const found = await api.call(cm, 'GET', `/api/admin/catalog/brands?q=${encodeURIComponent(name)}&limit=20`);
  let id = (found.items as { brand: { id: string; name: string }; status: string }[]).find((b) => b.brand.name === name && b.status === 'active')?.brand.id;
  if (!id) id = (await api.call(cm, 'POST', '/api/admin/catalog/brands', { name, description: BRAND_NOTES[name] ?? null, sellingPolicy: 'open' })).brand.id;
  w.brands.set(name, id!);
  return id!;
}

/** The product form: one variant per option value, each with its GTIN, weight and size */
function productInput(sim: Sim, p: ProductSeed, brandId: string, imageIds: string[]) {
  return {
    title: p.title,
    brandId,
    categoryId: sim.world.categories.get(p.category),
    description: p.description,
    keyFeatures: p.features,
    specs: p.specs,
    includedItems: p.included,
    imageIds,
    modelNumber: p.model,
    variants: p.option.values.map((v) => ({ options: { [p.option.name]: v }, gtin: sim.gtin(), weightGrams: p.weightGrams, lengthCm: 30, widthCm: 22, heightCm: 12 })),
  };
}

interface Draft {
  seed: ProductSeed;
  productId: string;
  variants: { id: string; value: string }[];
}

async function sellerDrafts(sim: Sim, s: SellerWorld, storeIndex: number): Promise<Draft[]> {
  const { api } = sim;
  const store = STORES[storeIndex % STORES.length]!;
  const drafts: Draft[] = [];
  for (const p of store.products) {
    const brandId = await ensureBrand(sim, p.brand);
    const imageId = await sim.upload(s.session, 'seller', { purpose: 'product_image', fileName: `${p.model.toLowerCase()}-front.png`, contentType: 'image/png', body: sim.png(1200, 1200, colour(p.option.values[0]!)) });
    const draft = await api.call(s.session, 'POST', '/api/seller/catalog/products', productInput(sim, p, brandId, [imageId]));
    const productId = draft.product.id as string;
    sim.run.check(`${p.title}: nothing missing`, (draft.missing ?? []).length === 0, draft.missing);
    await api.call(s.session, 'POST', `/api/seller/catalog/products/${productId}/submit`, { note: 'New listing from our Portland shop' });
    const variants = (draft.product.variants as { id: string; options: Record<string, string> }[]).map((v) => ({ id: v.id, value: Object.values(v.options)[0]! }));
    drafts.push({ seed: p, productId, variants });
  }
  return drafts;
}

export async function catalogFlow(sim: Sim): Promise<void> {
  const { api, world: w, run } = sim;
  const cm = w.staff.catalog!.session;
  const sm = w.staff.seller!.session;

  for (const [i, s] of w.sellers.entries()) {
    await run.attempt(`products of ${s.name}`, async () => {
      const drafts = await sellerDrafts(sim, s, i);
      // the first submission opens the launch review; the Seller Manager passes it so the seller may sell
      await api.call(s.session, 'POST', '/api/seller/sellers/setup/launch-review', { note: 'Our first products are submitted' });
      await api.call(sm, 'POST', `/api/admin/sellers/sellers/${s.sellerId}/launch-review/decide`, { outcome: 'pass', note: 'Ready to sell' });
      // the Catalog Manager reviews them from the queue
      const queue = await api.call(cm, 'GET', '/api/admin/catalog/review-queue?limit=100');
      for (const d of drafts) {
        run.check(`${d.seed.title} waits in the review queue`, JSON.stringify(queue.items).includes(d.productId), undefined);
        await api.call(cm, 'POST', `/api/admin/catalog/products/${d.productId}/approve`, { note: 'Photos and details are fine' });
      }
      // offers: one per variant, with price and stock
      for (const d of drafts) {
        for (const v of d.variants) {
          const sku = `${s.code}-${sim.runId}-${d.seed.model}-${v.value}`.toUpperCase().replace(/[^A-Z0-9-]+/g, '');
          const created = await api.call(s.session, 'POST', '/api/seller/offers/offers', {
            productId: d.productId,
            variantId: v.id,
            condition: 'new',
            price: usd(d.seed.price),
            sellerSku: sku,
            quantity: sim.int(15, 40),
            lowStockThreshold: 3,
            dispatchBusinessDays: 1,
            shippingProfileId: s.shippingProfileId,
            returnTerms: { kind: 'baseline' },
            warranty: { kind: 'manufacturer', months: 12 },
            publish: true,
          });
          run.check(`${sku} is on sale`, created.offer?.status === 'active', created.offer);
          s.offers.push({ offerId: created.offer.id, productId: d.productId, variantId: v.id, title: `${d.seed.title} (${v.value})`, price: d.seed.price, sellerId: s.sellerId, sellerName: s.name, stockItemId: created.offer.stockItemId ?? undefined, sku });
        }
      }
    });
  }
  run.check('every seller has offers on sale', w.sellers.every((s) => s.offers.length > 0), w.sellers.map((s) => [s.name, s.offers.length]));
}

/* ---------------------------------------------------------------- the Official Store */

export async function officialStoreFlow(sim: Sim): Promise<void> {
  const { api, world: w, run } = sim;
  const ops = w.staff.operations!.session; // inventory, warehouse, purchasing and Official Store manager
  const cm = w.staff.catalog!.session;

  // the company warehouse, its bins and box types: set up once, reused by later runs
  const locations = (await api.call(ops, 'GET', '/api/admin/inventory/locations')) as { id: string; code: string }[];
  let location = locations.find((l) => l.code === OFFICIAL_WAREHOUSE.code);
  if (!location) location = await api.call(ops, 'POST', '/api/admin/inventory/locations', { code: OFFICIAL_WAREHOUSE.code, name: OFFICIAL_WAREHOUSE.name, address: OFFICIAL_WAREHOUSE.address, timeZone: OFFICIAL_WAREHOUSE.timeZone, sellable: true, active: true });
  w.locationId = location!.id;
  const bins = await api.call(ops, 'GET', `/api/admin/warehouse/bins?locationId=${w.locationId}&limit=100`);
  const have = new Set((bins.items as { code: string }[]).map((b) => b.code));
  const missing = OFFICIAL_WAREHOUSE.pickBins.filter((c) => !have.has(c));
  if (missing.length) await api.call(ops, 'POST', '/api/admin/warehouse/bins', { locationId: w.locationId, codes: missing, kind: 'pick' });
  const allBins = (await api.call(ops, 'GET', `/api/admin/warehouse/bins?locationId=${w.locationId}&kind=pick&limit=100`)).items as { id: string; code: string }[];
  const boxes = (await api.call(ops, 'GET', '/api/admin/warehouse/box-types')) as { id: string; name: string }[];
  if (!boxes.some((b) => b.name === 'M box')) {
    // PUT replaces the list: keep what is there and add ours
    await api.call(ops, 'PUT', '/api/admin/warehouse/box-types', { boxTypes: [...boxes, { id: crypto.randomUUID(), name: 'M box', kind: 'box', dimensions: { length: 12, width: 10, height: 6, unit: 'in' }, maxWeight: { value: 20, unit: 'lb' }, active: true }] });
  }
  // the Shipping Manager looks up the Official Store's shipping profile (operations staff have no shipping access)
  const officialProfiles = await api.call(w.staff.orders!.session, 'GET', '/api/admin/shipping/profiles?ownerType=official');
  const profileId = (officialProfiles.items ?? officialProfiles)[0]?.id as string | undefined;
  run.check('the Official Store has a shipping profile', Boolean(profileId), officialProfiles);

  // company products: images by the Catalog Manager, drafts by the Official Store Manager, approved in review
  const products: { seed: ProductSeed; productId: string; variants: { id: string; value: string }[] }[] = [];
  for (const p of OFFICIAL_PRODUCTS) {
    const brandId = await ensureBrand(sim, p.brand);
    const imageId = await sim.upload(cm, 'admin', { purpose: 'product_image', fileName: `${p.model.toLowerCase()}.png`, contentType: 'image/png', body: sim.png(1200, 1200, colour(p.option.values[0]!)) });
    const input = productInput(sim, p, brandId, [imageId]);
    const draft = await api.call(ops, 'POST', '/api/admin/catalog/products', { ...input, title: `${p.title} ${sim.runId.toUpperCase()}`, variants: input.variants.map((v) => ({ ...v, listPrice: usd(p.price) })) });
    await api.call(ops, 'POST', `/api/admin/catalog/products/${draft.product.id}/submit`);
    await api.call(cm, 'POST', `/api/admin/catalog/products/${draft.product.id}/approve`, { note: 'Official Store product' });
    products.push({ seed: p, productId: draft.product.id, variants: (draft.product.variants as { id: string; options: Record<string, string> }[]).map((v) => ({ id: v.id, value: Object.values(v.options)[0]! })) });
  }

  // stock items at the warehouse, each with a primary pick bin
  const lines: { stockItemId: string; quantity: number; unitCost: { amount: number; currency: string }; offer: Omit<OfferWorld, 'offerId'> }[] = [];
  for (const [i, p] of products.entries()) {
    const v = p.variants[0]!;
    const sku = `MB-${sim.runId}-${p.seed.model}`.toUpperCase();
    const item = await api.call(ops, 'POST', '/api/admin/inventory/stock-items', { sku, productId: p.productId, variantId: v.id, condition: 'new', locationId: w.locationId, lowStockThreshold: 5, reorderQuantity: 50 });
    const bin = allBins[i % allBins.length]!;
    await api.call(ops, 'PUT', `/api/admin/warehouse/stock-items/${item.id}/bins`, { bins: [{ binId: bin.id, primary: true }] });
    lines.push({ stockItemId: item.id, quantity: 40, unitCost: usd(Math.round(p.seed.price * 0.45)), offer: { productId: p.productId, variantId: v.id, title: p.seed.title, price: p.seed.price, sellerId: null, sellerName: 'Marketly', stockItemId: item.id, sku } });
  }

  // purchasing: a supplier, a purchase order, the delivery arrives and is counted in
  const supplier = await api.call(ops, 'POST', '/api/admin/purchasing/suppliers', { name: `Cascade Wholesale ${sim.runId.toUpperCase()}`, contactName: 'Jordan Pike', email: `orders.${sim.runId}@cascade-wholesale.example.com`, phone: sim.phone(), paymentTerms: 'Net 30', leadTimeDays: 5 });
  const day = (n: number) => new Date(Date.now() + n * 86_400_000).toISOString().slice(0, 10);
  const po = await api.call(ops, 'POST', '/api/admin/purchasing/purchase-orders', { supplierId: supplier.id, shipToLocationId: w.locationId, lines: lines.map(({ stockItemId, quantity, unitCost }) => ({ stockItemId, quantity, unitCost })), freight: usd(4500), expectedDate: day(1) });
  await api.call(ops, 'POST', `/api/admin/purchasing/purchase-orders/${po.id}/send`, { emailSupplier: true, message: 'Please deliver to dock 2.' });
  const delivery = await api.call(ops, 'POST', `/api/admin/purchasing/purchase-orders/${po.id}/deliveries`, { carrier: 'Freight · 1 pallet', trackingRef: `BOL ${sim.int(10000, 99999)}`, windowFrom: new Date(Date.now() - 3_600_000).toISOString(), windowTo: new Date(Date.now() + 3_600_000).toISOString() });
  await api.call(ops, 'POST', `/api/admin/purchasing/deliveries/${delivery.id}/arrive`, { dock: '2', note: 'One pallet, wrap intact' });
  const receipt = await api.call(ops, 'POST', `/api/admin/purchasing/deliveries/${delivery.id}/receipts`);
  await api.call(ops, 'PATCH', `/api/admin/purchasing/receipts/${receipt.id}`, { lines: (receipt.lines as { purchaseOrderLineId: string; expected?: number; ordered?: number }[]).map((l, i) => ({ purchaseOrderLineId: l.purchaseOrderLineId, received: lines[i]!.quantity, damaged: 0 })) });
  await api.call(ops, 'POST', `/api/admin/purchasing/receipts/${receipt.id}/submit`, { raiseClaims: false });

  // inventory: the Inventory Manager confirms the receipt, then the units are put away
  const waiting = await api.call(ops, 'GET', '/api/admin/inventory/inbound?state=awaiting_confirmation&limit=100');
  const inbound = (waiting.items as { id: string; purchaseOrderId?: string | null }[]).find((r) => r.purchaseOrderId === po.id);
  run.check('the receipt waits for confirmation in inventory', Boolean(inbound), waiting.items);
  await api.call(ops, 'POST', `/api/admin/inventory/inbound/${inbound!.id}/confirm`, { lines: lines.map((l) => ({ stockItemId: l.stockItemId, sellable: l.quantity, damaged: 0 })), checked: true, note: 'Counted and checked' });
  const tasks = await api.call(ops, 'GET', '/api/admin/warehouse/putaway-tasks?status=open&limit=100');
  for (const t of tasks.items as { id: string; stockItemId: string; suggestedBinCode?: string | null; quantity: number }[]) {
    if (!lines.some((l) => l.stockItemId === t.stockItemId)) continue;
    await api.call(ops, 'POST', `/api/admin/warehouse/putaway-tasks/${t.id}/complete`, { binCode: t.suggestedBinCode ?? allBins[0]!.code, quantity: t.quantity });
  }

  // Official Store offers on that stock
  for (const l of lines) {
    const created = await api.call(ops, 'POST', '/api/admin/offers/official/offers', {
      productId: l.offer.productId,
      variantId: l.offer.variantId,
      condition: 'new',
      price: usd(l.offer.price),
      sku: l.offer.sku,
      stockItemId: l.stockItemId,
      dispatchBusinessDays: 1,
      shippingProfileId: profileId,
      returnTerms: { kind: 'baseline' },
      warranty: { kind: 'manufacturer', months: 12 },
      publish: true,
    });
    run.check(`${l.offer.sku} is on sale`, created.offer?.status === 'active', created.offer);
    const stock = await api.call(ops, 'GET', `/api/admin/inventory/stock-items/${l.stockItemId}`);
    run.check(`${l.offer.sku}: 40 units available`, JSON.stringify(stock).includes('"available":40'), stock);
    w.official.push({ ...l.offer, offerId: created.offer.id });
  }
}

/* ---------------------------------------------------------------- search */

export async function searchFlow(sim: Sim): Promise<void> {
  const { api, people, world: w, run } = sim;
  // the index catches up on its schedule; run it now (development servers run no jobs)
  await sim.job('search.process-dirty');
  const shopper: Session = await people.visitor('store', 'android', 'shopper (search)');
  const all = [...w.sellers.flatMap((s) => s.offers), ...w.official];
  const titles = [...new Set(all.map((o) => o.title.replace(/ \(.*\)$/, '')))];
  let found = 0;
  for (const title of titles.slice(0, 6)) {
    const q = title.split(' ').slice(0, 3).join(' ');
    const res = await api.call(shopper, 'GET', `/api/store/search/products?q=${encodeURIComponent(q)}&postalCode=97205&limit=24`);
    const ids = (res.items as { product: { productId: string } }[]).map((h) => h.product.productId);
    if (all.some((o) => o.title.startsWith(title) && ids.includes(o.productId))) found++;
    else run.check(`search "${q}" finds ${title}`, false, (res.items as { product: { title: string } }[]).map((h) => h.product.title));
  }
  run.pass();
  // a category listing, filtered by price and sorted
  const slug = (await api.call(shopper, 'GET', '/api/store/catalog/categories')) as { slug: string; name: string }[];
  const coffee = slug.find((c) => c.name === 'Coffee & Tea');
  if (coffee) {
    const res = await api.call(shopper, 'GET', `/api/store/search/products?category=${coffee.slug}&priceMax=20000&sort=price_asc&limit=24`);
    const prices = (res.items as { product: { price?: { amount: number } | null } }[]).map((h) => h.product.price?.amount ?? 0);
    run.check('price ascending', prices.every((p, i) => i === 0 || p >= prices[i - 1]!), prices);
    run.check('price filter', prices.every((p) => p <= 20000), prices);
  }
  const suggestions = await api.call(shopper, 'GET', '/api/store/search/suggestions?q=bri');
  run.check('suggestions answer', suggestions !== null, suggestions);
  run.check('search found the new products', found >= Math.min(3, titles.length), { found, titles });
}
