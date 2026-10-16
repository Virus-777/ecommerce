// Step 4: the Official Store ("Marketly Official Store"): its company location in Reno, NV (bins and box types
// for the warehouse), company products (create → submit → approve), offers with verified was-prices (list price
// basis) and stock added by adjustment. Olivia's token is a Business Owner: no adjustment limit.
import { randomUUID } from 'node:crypto';
import { ApiError } from '../lib/http.mjs';
import { gtinFor } from '../lib/codes.mjs';
import { OFFICIAL_LOCATION, PRODUCTS, usd } from '../data.mjs';
import { uploadProductPhotos } from './media.mjs';

/**
 * The catalog product input of a seed product (seller and admin share it). The was-price check reads the variant's
 * `listPrice` (G10): admin inputs carry it; sellers can't send it, so staff set it after approval (ensureListPrices).
 */
export function productInput(ctx, p, photos, { admin }) {
  return {
    title: p.title,
    brandId: ctx.state.get(`brand.${p.brand}`),
    categoryId: ctx.state.get(`category.${p.cat}.${p.sub}`),
    description: p.description,
    keyFeatures: p.features,
    specs: { Brand: p.brand, ...p.specs },
    includedItems: p.included,
    imageIds: photos.productImageIds,
    modelNumber: p.model,
    variants: p.variants.map((v) => ({
      options: v.options,
      gtin: gtinFor(`${p.key}:${v.key}`),
      imageIds: photos.variantImageIds[v.key] ?? [],
      weightGrams: p.weightGrams,
      lengthCm: 30,
      widthCm: 24,
      heightCm: 12,
      ...(admin && v.was ? { listPrice: usd(v.was) } : {}),
    })),
  };
}

/**
 * Staff set each variant's manufacturer list price (`listPrice`, which the was-price check reads; G10) where it is
 * missing: PATCH /api/admin/catalog/products/{id}/variants/{variantId}, allowed on approved products without a new
 * review. Needed for seller products (sellers can't send listPrice) and products created before G10.
 */
export async function ensureListPrices(ctx, p, rec) {
  if (rec.listPrices || !p.variants.some((v) => v.was)) return;
  const r = await ctx.api.get(`/api/admin/catalog/products/${rec.id}`, ctx.staff);
  const product = r.product ?? r;
  for (const v of p.variants.filter((x) => x.was)) {
    const variantId = rec.variants?.[v.key];
    if (!variantId || product.variants.find((x) => x.id === variantId)?.listPrice?.amount === v.was) continue;
    await ctx.api.patch(`/api/admin/catalog/products/${rec.id}/variants/${variantId}`, ctx.staff, { listPrice: usd(v.was), reason: 'Manufacturer list price (MSRP) checked' });
    ctx.log.info(`${p.title} · ${Object.values(v.options).join(' / ')}: list price $${(v.was / 100).toFixed(2)}`);
  }
  rec.listPrices = true;
  ctx.state.set(`product.${p.key}`, rec);
}

/** Variant id by our variant key, matching on the option values */
export function variantIds(p, product) {
  const out = {};
  for (const v of p.variants) {
    const want = JSON.stringify(Object.entries(v.options).sort());
    const got = product.variants.find((x) => JSON.stringify(Object.entries(x.options).sort()) === want);
    if (got) out[v.key] = got.id;
  }
  return out;
}

/** Review state of a product record, whatever the response calls it */
export const reviewStateOf = (product) => product?.reviewState ?? product?.review?.state ?? product?.status ?? null;

async function ensureLocation(ctx) {
  const { api, state, log } = ctx;
  const t = ctx.staff;
  const locations = await api.get('/api/admin/inventory/locations', t);
  let loc = locations.find((l) => l.code === OFFICIAL_LOCATION.code);
  if (!loc) {
    try {
      loc = await api.post('/api/admin/inventory/locations', t, { code: OFFICIAL_LOCATION.code, name: OFFICIAL_LOCATION.name, address: OFFICIAL_LOCATION.address, timeZone: OFFICIAL_LOCATION.timeZone, sellable: true, active: true });
      log.created('location', `${OFFICIAL_LOCATION.name} (${OFFICIAL_LOCATION.address.city}, ${OFFICIAL_LOCATION.address.region})`);
    } catch (err) {
      loc = locations.find((l) => l.isDefault && l.ownerType === 'official');
      if (!loc) throw err;
      log.warn(`could not add ${OFFICIAL_LOCATION.code} (${err.message}); using the default location ${loc.code}`);
    }
  }
  state.set('official.locationId', loc.id);
  // warehouse: pick bins and box types (picking and packing need both)
  try {
    const bins = await api.get(`/api/admin/warehouse/bins?locationId=${loc.id}&limit=100`, t);
    const have = new Set((bins.items ?? bins).map((b) => b.code));
    const missing = OFFICIAL_LOCATION.pickBins.filter((c) => !have.has(c));
    if (missing.length) {
      await api.post('/api/admin/warehouse/bins', t, { locationId: loc.id, codes: missing, kind: 'pick' });
      log.created('bins', missing.join(', '));
    }
    const all = await api.get(`/api/admin/warehouse/bins?locationId=${loc.id}&kind=pick&limit=100`, t);
    state.set('official.bins', (all.items ?? all).map((b) => ({ id: b.id, code: b.code })));
    const boxes = await api.get('/api/admin/warehouse/box-types', t);
    const list = Array.isArray(boxes) ? boxes : (boxes.items ?? []);
    if (!list.some((b) => b.name === 'M box')) {
      await api.put('/api/admin/warehouse/box-types', t, {
        boxTypes: [
          ...list,
          { id: randomUUID(), name: 'S mailer', kind: 'mailer', dimensions: { length: 12, width: 9, height: 3, unit: 'in' }, maxWeight: { value: 5, unit: 'lb' }, active: true },
          { id: randomUUID(), name: 'M box', kind: 'box', dimensions: { length: 14, width: 12, height: 8, unit: 'in' }, maxWeight: { value: 25, unit: 'lb' }, active: true },
        ],
      });
      log.created('box types', 'S mailer, M box');
    }
  } catch (err) {
    log.warn(`warehouse bins/box types not set up (${err.message}); Official Store orders may not ship`);
  }
  return loc.id;
}

async function officialProfile(ctx) {
  const r = await ctx.api.get('/api/admin/shipping/profiles?ownerType=official', ctx.staff);
  const id = (r.items ?? r)[0]?.id;
  if (!id) throw new Error('no Official Store shipping profile (shipping seeds one on boot)');
  ctx.state.set('official.shippingProfileId', id);
  return id;
}

/** Finds an existing product by exact title (admin list), or null */
export async function findProduct(ctx, title, sellerId) {
  const r = await ctx.api.get(`/api/admin/catalog/products?q=${encodeURIComponent(title)}&limit=20${sellerId ? `&sellerId=${sellerId}` : ''}`, ctx.staff);
  return (r.items ?? []).map((i) => i.product ?? i).find((p) => p.title === title) ?? null;
}

/** Staff approval of a submitted product (Morgan reviews); tolerant of "already approved" */
export async function approveProduct(ctx, productId, note) {
  try {
    await ctx.api.post(`/api/admin/catalog/products/${productId}/approve`, ctx.approver, { note });
  } catch (err) {
    if (!(err instanceof ApiError) || err.status !== 409) throw err;
  }
}

async function ensureProduct(ctx, p) {
  const { api, state, log } = ctx;
  const t = ctx.staff;
  let rec = state.get(`product.${p.key}`);
  if (rec?.approved) {
    await ensureListPrices(ctx, p, rec);
    return rec;
  }
  let product = rec?.id ? (await api.get(`/api/admin/catalog/products/${rec.id}`, t)).product : await findProduct(ctx, p.title);
  if (!product) {
    const photos = state.get(`photos.${p.key}`) ?? (await uploadProductPhotos(ctx, 'admin', t, p));
    product = (await api.post('/api/admin/catalog/products', t, productInput(ctx, p, photos, { admin: true }))).product;
    log.created('product', `${p.title} (Official Store)`);
  }
  rec = state.set(`product.${p.key}`, { id: product.id, seller: 'official', variants: variantIds(p, product) });
  try {
    await api.post(`/api/admin/catalog/products/${product.id}/submit`, t, undefined);
  } catch (err) {
    if (!(err instanceof ApiError) || err.status !== 409) throw err;
  }
  await approveProduct(ctx, product.id, 'Official Store product: photos, details and GTINs checked');
  rec.approved = true;
  state.set(`product.${p.key}`, rec);
  await ensureListPrices(ctx, p, rec);
  return rec;
}

async function findOfficialOffer(ctx, sku) {
  const r = await ctx.api.get(`/api/admin/offers/official/offers?q=${encodeURIComponent(sku)}&limit=20`, ctx.staff);
  return (r.items ?? []).map((i) => i.offer ?? i).find((o) => o.sellerSku === sku) ?? null;
}

async function ensureOffer(ctx, p, v, rec, profileId, locationId, binIndex) {
  const { api, state, log } = ctx;
  const t = ctx.staff;
  const key = `offer.${p.key}.${v.key}`;
  let offer = state.get(key);
  if (!offer) {
    const found = await findOfficialOffer(ctx, v.sku);
    if (found) offer = { id: found.id, stockItemId: found.stockItemId ?? null, seller: 'official', price: v.price, productId: rec.id };
  }
  if (!offer) {
    const body = {
      productId: rec.id,
      variantId: rec.variants[v.key],
      condition: 'new',
      price: usd(v.price),
      ...(v.was ? { compareAt: { amount: usd(v.was), basis: 'list_price' } } : {}),
      purchaseLimit: 3,
      sku: v.sku,
      dispatchBusinessDays: 0,
      shippingProfileId: profileId,
      returnTerms: { kind: 'baseline', freeReturnShipping: true },
      warranty: { kind: 'manufacturer', months: 24 },
      publish: true,
    };
    let created;
    try {
      created = await api.post('/api/admin/offers/official/offers', t, body);
    } catch (err) {
      if (err instanceof ApiError && err.code === 'WAS_PRICE_NOT_VERIFIED') {
        log.info(`${v.sku}: was-price not accepted yet (${err.code}); offer created without it`);
        const { compareAt: _c, ...rest } = body;
        created = await api.post('/api/admin/offers/official/offers', t, rest);
      } else throw err;
    }
    offer = { id: created.offer.id, stockItemId: created.offer.stockItemId, seller: 'official', price: v.price, productId: rec.id, compareAt: Boolean(created.offer.compareAt) };
    log.created('offer', `${p.title} · ${Object.values(v.options).join(' / ')} · $${(v.price / 100).toFixed(2)} (Official Store)`);
  }
  state.set(key, offer);
  if (v.was && !offer.compareAt) {
    try {
      await api.patch(`/api/admin/offers/official/offers/${offer.id}`, t, { compareAt: { amount: usd(v.was), basis: 'list_price' } });
      offer.compareAt = true;
      state.set(key, offer);
      log.info(`${v.sku}: was-price $${(v.was / 100).toFixed(2)} (list price)`);
    } catch (err) {
      log.warn(`${v.sku}: was-price not set (${err.message})`);
    }
  }
  if (!offer.stocked) {
    if (!offer.stockItemId) {
      const items = await api.get(`/api/admin/inventory/stock-items?q=${encodeURIComponent(v.sku)}&ownerType=official&limit=20`, t);
      offer.stockItemId = (items.items ?? []).find((i) => i.sku === v.sku || i.offerId === offer.id)?.id;
    }
    if (!offer.stockItemId) throw new Error(`${v.sku}: no stock item for the offer`);
    const item = await api.get(`/api/admin/inventory/stock-items/${offer.stockItemId}`, t);
    const available = item.quantities?.available ?? item.stockItem?.quantities?.available ?? item.item?.quantities?.available ?? 0;
    if (available < v.stock) {
      const adj = await api.post('/api/admin/inventory/adjustments', t, { stockItemId: offer.stockItemId, locationId, fromGroup: 'outside', toGroup: 'available', quantity: v.stock - available, reasonCode: 'found_stock', note: 'Opening stock count' });
      if (adj.state !== 'applied') log.warn(`${v.sku}: stock adjustment is ${adj.state} (limit check?)`);
      else log.info(`${v.sku}: +${v.stock - available} units available`);
    }
    // a primary pick bin, so the warehouse can pick Official Store orders
    const bins = state.get('official.bins') ?? [];
    if (bins.length) {
      try {
        const bin = bins[binIndex % bins.length];
        await api.put(`/api/admin/warehouse/stock-items/${offer.stockItemId}/bins`, t, { bins: [{ binId: bin.id, primary: true }] });
        offer.binCode = bin.code;
      } catch (err) {
        log.warn(`${v.sku}: no bin assigned (${err.message})`);
      }
    }
    offer.stocked = true;
    state.set(key, offer);
  }
}

export async function officialStep(ctx) {
  const locationId = await ensureLocation(ctx);
  const profileId = await officialProfile(ctx);
  let bin = 0;
  for (const p of PRODUCTS.filter((x) => x.seller === 'official')) {
    const rec = await ensureProduct(ctx, p);
    for (const v of p.variants) await ensureOffer(ctx, p, v, rec, profileId, locationId, bin++);
  }
}
