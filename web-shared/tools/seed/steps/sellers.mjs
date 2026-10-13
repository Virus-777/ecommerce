// Step 5: marketplace sellers. For each: the owner signs in to the store (dev Google sign-in), staff invite the
// business (code computed), the owner applies (business, verification + documents, payout, return address,
// agreements), staff review and approve, the owner confirms the payout test deposits (computed amounts), sets up
// shipping and the storefront, submits products, asks for the launch review (staff pass it), staff approve the
// products, and the seller publishes offers with stock. Then offers on other sellers' products.
import { ApiError, poll } from '../lib/http.mjs';
import { onePagePdf, productPng } from '../lib/files.mjs';
import { providerDestinationId, sellerInvitationCode, testDeposits } from '../lib/codes.mjs';
import { EXTRA_OFFERS, PRODUCTS, SELLERS, usd } from '../data.mjs';
import { uploadProductPhotos } from './media.mjs';
import { approveProduct, findProduct, productInput, variantIds } from './official.mjs';

const STORE = '/api/store/sellers';
const ADMIN = '/api/admin/sellers';
const ROUTING = '011000015';

/** The seller's record in the state file */
const rec = (ctx, key) => {
  const sellers = ctx.state.section('sellers');
  sellers[key] ??= {};
  return sellers[key];
};

async function ownerAccount(ctx, s) {
  const r = rec(ctx, s.key);
  if (!r.accountId) {
    r.accountId = await ctx.externalAccount(s.owner.email, s.owner.first, s.owner.last);
    ctx.state.save();
    ctx.log.created('seller owner account', `${s.owner.first} ${s.owner.last} <${s.owner.email}>`);
  }
  return r.accountId;
}

async function invitation(ctx, s) {
  const r = rec(ctx, s.key);
  if (r.invitationId) return sellerInvitationCode(r.invitationId);
  const list = await ctx.api.all(`${ADMIN}/seller-invitations`, ctx.staff);
  let inv = list.find((i) => i.email.toLowerCase() === s.owner.email && i.state === 'sent');
  if (!inv) {
    inv = await ctx.api.post(`${ADMIN}/seller-invitations`, ctx.staff, { email: s.owner.email, businessName: `${s.storeName} LLC`, message: 'We would love to have you on Marketly.' });
    ctx.log.created('seller invitation', `${s.storeName} (${s.owner.email})`);
  }
  r.invitationId = inv.id;
  ctx.state.save();
  return sellerInvitationCode(inv.id);
}

async function currentApplication(ctx, token) {
  try {
    return await ctx.api.get(`${STORE}/applications/current`, token);
  } catch (err) {
    if (err instanceof ApiError && err.status === 404) return null;
    throw err;
  }
}

async function apply(ctx, s) {
  const { api, log } = ctx;
  const r = rec(ctx, s.key);
  const t = ctx.tokens.customer(r.accountId);
  let app = await currentApplication(ctx, t);
  const contactName = `${s.owner.first} ${s.owner.last}`;
  if (!app || ['withdrawn', 'expired', 'rejected'].includes(app.state)) {
    const invitationCode = await invitation(ctx, s);
    app = await api.post(`${STORE}/applications`, t, { accountMode: 'existing_member', contactName, contactPhone: s.owner.phone, workEmail: s.owner.email, storeName: s.storeName, sellerType: 'business', market: 'US', invitationCode });
    log.created('seller application', `${s.storeName} (${app.ref})`);
  }
  r.applicationId = app.id;
  ctx.state.save();
  if (app.state !== 'draft') return app;
  const legalName = `${s.storeName} LLC`;
  const address = { name: legalName, ...s.address, country: 'US' };
  const patch = (body) => api.patch(`${STORE}/applications/${app.id}`, t, body);
  await patch({
    step: 'business',
    business: {
      kind: 'registered_business',
      legalName,
      storeName: s.storeName,
      businessType: 'llc',
      stateOfRegistration: s.state,
      registryNumber: `${s.state}-${s.taxId.replace(/\D/g, '').slice(-7)}`,
      address,
      phone: s.owner.phone,
      website: `https://${s.owner.email.split('@')[1]}`,
      categoryIds: s.categories.map((c) => ctx.state.get(`category.${c}`)),
      plannedProductCount: '21_100',
      plannedProducts: s.introduction,
      shippingPlan: `We ship from ${s.shipsFrom} with UPS, USPS and FedEx`,
      supportHours: 'Mon–Fri 9–5 local time',
    },
  });
  const v = await patch({ step: 'verification', verification: { owners: [{ name: contactName, ownershipPct: 100, isPrimary: true, idDocumentIds: [] }], taxIdType: 'ein', taxId: s.taxId, w9Method: 'online' } });
  const ownerId = v.verification?.owners?.[0]?.id;
  const have = new Set((v.documents ?? []).map((d) => d.kind));
  await Promise.all(
    [['owner_id', { ownerId }], ['business_registration', {}]]
      .filter(([kind]) => !have.has(kind))
      .map(async ([kind, extra]) => {
        const doc = await ctx.upload('store', t, { purpose: 'verification_document', fileName: `${kind}.pdf`, contentType: 'application/pdf', body: onePagePdf(`${s.storeName}: ${kind.replace('_', ' ')}`) }, `store:${s.key}:${kind}`);
        await api.post(`${STORE}/applications/${app.id}/documents`, t, { mediaId: doc.id, kind, ...extra });
      }),
  );
  await patch({ step: 'payout', payout: { accountHolderName: legalName, accountType: 'business_checking', routingNumber: ROUTING, accountNumber: s.account, confirmAccountNumber: s.account } });
  await patch({ step: 'return_address', returnAddress: { sameAsBusiness: true, contactName, phone: s.owner.phone } });
  const draft = await currentApplication(ctx, t);
  if (draft.missing && Object.keys(draft.missing).length) log.warn(`${s.storeName}: application still missing ${JSON.stringify(draft.missing).slice(0, 200)}`);
  const acceptances = draft.agreementsRequired.map((a) => ({ key: a.key, versionLabel: a.versionLabel }));
  const submitted = await api.post(`${STORE}/applications/${app.id}/submit`, t, { acceptances, signedName: contactName });
  log.info(`${s.storeName}: application submitted`);
  return submitted;
}

async function approve(ctx, s, app) {
  const { api, log } = ctx;
  const r = rec(ctx, s.key);
  if (app.state === 'submitted') await api.post(`${ADMIN}/applications/${app.id}/start-review`, ctx.staff, undefined);
  if (['submitted', 'under_review'].includes(app.state)) {
    const done = await api.post(`${ADMIN}/applications/${app.id}/approve`, ctx.approver, { note: 'Business, owner identity and bank account check out. Welcome to Marketly!' });
    app = done.application ?? done;
    log.info(`${s.storeName}: application approved`);
  }
  const sellerId = app.sellerId ?? (await currentApplication(ctx, ctx.tokens.customer(r.accountId)))?.sellerId;
  if (!sellerId) throw new Error(`${s.storeName}: application ${app.state} has no seller id`);
  r.sellerId = sellerId;
  ctx.state.save();
}

async function payout(ctx, s) {
  const r = rec(ctx, s.key);
  if (r.payoutVerified) return;
  const t = ctx.sellerToken(s.key);
  // finance creates the destination from the sellers event a moment after approval
  const dest = await poll(`${s.storeName}: payout destination`, async () => {
    const d = await ctx.api.get('/api/seller/finance/payout-destination', t);
    return ['verification_pending', 'verified'].includes(d.destination?.status) ? d : null;
  }, { timeoutMs: 30_000 });
  if (dest.destination.status === 'verification_pending') {
    const [a, b] = testDeposits(providerDestinationId(ROUTING, s.account));
    const res = await ctx.api.post('/api/seller/finance/payout-destination/confirm-deposits', t, { amounts: [usd(a), usd(b)] });
    if (res.destination?.status !== 'verified') ctx.log.warn(`${s.storeName}: payout destination is ${res.destination?.status} after the test deposits`);
    else ctx.log.info(`${s.storeName}: payout account verified (test deposits $0.${String(a).padStart(2, '0')} and $0.${String(b).padStart(2, '0')})`);
  }
  r.payoutVerified = true;
  ctx.state.save();
}

async function shipping(ctx, s) {
  const r = rec(ctx, s.key);
  if (r.shippingProfileId) return r.shippingProfileId;
  const t = ctx.sellerToken(s.key);
  await ctx.api.put('/api/seller/shipping/settings', t, {
    coverage: { area: 'contiguous_48_dc', zoneIds: [], excluded: ['po_box'] },
    dispatch: { handlingDays: s.shipping.handlingDays, sameDayCutoff: '12:00', businessDays: ['mon', 'tue', 'wed', 'thu', 'fri'] },
    buyLabelsInSellerCenter: true,
    shipsFrom: s.shipsFrom,
    effectiveFrom: null,
  });
  const name = 'Standard shipping';
  const profiles = await ctx.api.get('/api/seller/shipping/profiles', t);
  let profile = (profiles.items ?? profiles).find((p) => p.name === name);
  if (!profile) {
    const methods = await ctx.api.get('/api/seller/shipping/methods', t);
    const id = (code) => methods.find((m) => m.code === code)?.id;
    const created = await ctx.api.post('/api/seller/shipping/profiles', t, {
      name,
      isDefault: true,
      methods: [
        { methodId: id('standard'), enabled: true, rateType: 'by_weight', tiers: s.shipping.standard, maxWeightGrams: 20000 },
        { methodId: id('expedited'), enabled: true, rateType: 'flat_per_package', tiers: [{ price: usd(s.shipping.expedited) }] },
      ],
      freeShippingThreshold: s.shipping.freeOver ? usd(s.shipping.freeOver) : null,
      freeShippingMethodCode: s.shipping.freeOver ? 'standard' : null,
      effectiveFrom: null,
    });
    profile = created.profile ?? created;
    ctx.log.created('shipping profile', `${s.storeName}: standard $${(s.shipping.standard[0].price.amount / 100).toFixed(2)}${s.shipping.freeOver ? `, free over $${s.shipping.freeOver / 100}` : ''}, expedited`);
  }
  r.shippingProfileId = profile.id;
  ctx.state.save();
  return profile.id;
}

async function storefront(ctx, s) {
  const r = rec(ctx, s.key);
  if (r.storefront) return;
  const t = ctx.sellerToken(s.key);
  const initials = s.storeName.split(/\s+/).filter((w) => /^[A-Z]/.test(w)).map((w) => w[0]).join('');
  const [logo, banner] = await Promise.all([
    ctx.upload('seller', t, { purpose: 'store_logo', fileName: `${s.key}-logo.png`, contentType: 'image/png', body: productPng({ width: 512, height: 512, color: PRODUCTS.find((p) => p.seller === s.key)?.variants[0].color ?? '#4a6fa5', shape: 'circle' }), alt: `${s.storeName} logo (${initials})` }, `seller:${s.key}:logo`),
    ctx.upload('seller', t, { purpose: 'store_banner', fileName: `${s.key}-banner.png`, contentType: 'image/png', body: productPng({ width: 1600, height: 400, color: PRODUCTS.find((p) => p.seller === s.key)?.variants[0].color ?? '#4a6fa5', shape: 'bar' }), alt: `${s.storeName} banner` }, `seller:${s.key}:banner`),
  ]).catch((err) => {
    ctx.log.warn(`${s.storeName}: logo/banner not uploaded (${err.message})`);
    return [null, null];
  });
  const body = {
    introduction: s.introduction,
    location: s.shipsFrom,
    warranty: s.warranty,
    tagline: s.tagline,
    contactOptions: { orderMessages: true, productQuestions: true, showPhone: false, replyTarget: 'within_24h' },
    ...(logo ? { logoId: logo.id } : {}),
    ...(banner ? { bannerId: banner.id } : {}),
  };
  try {
    await ctx.api.patch('/api/seller/sellers/store-profile', t, body);
  } catch (err) {
    ctx.log.warn(`${s.storeName}: storefront with images refused (${err.message}); saving the text only`);
    const { logoId: _l, bannerId: _b, ...text } = body;
    await ctx.api.patch('/api/seller/sellers/store-profile', t, text);
  }
  // the tagline waits for staff review
  const pending = await ctx.api.all(`${ADMIN}/change-requests?state=pending`, ctx.staff).catch(() => []);
  for (const cr of pending.filter((c) => c.sellerId === r.sellerId || JSON.stringify(c).includes(r.sellerId))) {
    await ctx.api.post(`${ADMIN}/change-requests/${cr.id}/decide`, ctx.approver, { approve: true, reason: 'Accurate and within the storefront rules' }).catch((err) => ctx.log.warn(`${s.storeName}: change request ${cr.kind} not decided (${err.message})`));
  }
  const profile = await ctx.api.get('/api/seller/sellers/store-profile', t);
  r.slug = profile.slug;
  r.storefront = true;
  ctx.state.save();
  ctx.log.info(`${s.storeName}: storefront /shop/${profile.slug}`);
}

async function sellerProducts(ctx, s) {
  const { api, state, log } = ctx;
  const t = ctx.sellerToken(s.key);
  const r = rec(ctx, s.key);
  // photos of all new products at once (each upload waits for the media job)
  await Promise.all(
    PRODUCTS.filter((x) => x.seller === s.key && !state.get(`product.${x.key}`) && !state.get(`photos.${x.key}`)).map(async (p) => state.set(`photos.${p.key}`, await uploadProductPhotos(ctx, 'seller', t, p))),
  );
  for (const p of PRODUCTS.filter((x) => x.seller === s.key)) {
    let pr = state.get(`product.${p.key}`);
    if (!pr) {
      let product = await findProduct(ctx, p.title, r.sellerId);
      if (!product) {
        const photos = state.get(`photos.${p.key}`) ?? state.set(`photos.${p.key}`, await uploadProductPhotos(ctx, 'seller', t, p));
        const draft = await api.post('/api/seller/catalog/products', t, productInput(ctx, p, photos, { admin: false }));
        product = draft.product;
        if (draft.missing?.length) log.warn(`${p.title}: missing ${JSON.stringify(draft.missing).slice(0, 200)}`);
        log.created('product', `${p.title} (${s.storeName})`);
      }
      pr = state.set(`product.${p.key}`, { id: product.id, seller: s.key, variants: variantIds(p, product) });
    }
    if (!pr.submitted) {
      try {
        await api.post(`/api/seller/catalog/products/${pr.id}/submit`, t, { note: 'New listing' });
      } catch (err) {
        if (!(err instanceof ApiError) || err.status !== 409) throw err;
      }
      pr.submitted = true;
      state.set(`product.${p.key}`, pr);
    }
  }
}

async function launchReview(ctx, s) {
  const r = rec(ctx, s.key);
  if (r.launchPassed) return;
  const t = ctx.sellerToken(s.key);
  // the payout verification reaches sellers by event: retry while it is not there yet
  await poll(`${s.storeName}: launch review request`, async () => {
    try {
      const res = await ctx.api.post('/api/seller/sellers/setup/launch-review', t, { note: 'Our first products are submitted' });
      return res.state ?? true;
    } catch (err) {
      if (err instanceof ApiError && err.code === 'LAUNCH_REVIEW_NOT_READY') return null;
      if (err instanceof ApiError && err.status === 409) return 'requested';
      throw err;
    }
  }, { timeoutMs: 30_000 });
  try {
    await ctx.api.post(`${ADMIN}/sellers/${r.sellerId}/launch-review/decide`, ctx.approver, { outcome: 'pass', note: 'Products, shipping and payout account are ready' });
  } catch (err) {
    if (!(err instanceof ApiError) || err.status !== 409) throw err;
  }
  r.launchPassed = true;
  ctx.state.save();
  ctx.log.info(`${s.storeName}: launch review passed`);
}

async function findSellerOffer(ctx, token, sku) {
  const res = await ctx.api.get(`/api/seller/offers/offers?q=${encodeURIComponent(sku)}&limit=20`, token);
  return (res.items ?? []).map((i) => i.offer ?? i).find((o) => o.sellerSku === sku) ?? null;
}

/** One seller offer with its starting stock; was-price on the list price when the product has one */
async function sellerOffer(ctx, s, key, { productId, variantId, label, condition = 'new', conditionNotes, missingItems, price, was, stock, sku, warranty }) {
  const { api, state, log } = ctx;
  if (state.get(key)) return state.get(key);
  const t = ctx.sellerToken(s.key);
  const r = rec(ctx, s.key);
  let found = await findSellerOffer(ctx, t, sku);
  if (!found) {
    const body = {
      productId,
      variantId,
      condition,
      ...(conditionNotes ? { conditionNotes } : {}),
      ...(missingItems ? { missingItems } : {}),
      price: usd(price),
      ...(was ? { compareAt: { amount: usd(was), basis: 'list_price' } } : {}),
      purchaseLimit: 5,
      sellerSku: sku,
      quantity: stock,
      lowStockThreshold: 3,
      dispatchBusinessDays: s.shipping.handlingDays,
      shippingProfileId: r.shippingProfileId,
      returnTerms: condition === 'new' ? { kind: 'baseline' } : { kind: 'baseline' },
      warranty: warranty ?? { kind: 'manufacturer', months: 24 },
      publish: true,
    };
    let created;
    try {
      created = await api.post('/api/seller/offers/offers', t, body);
    } catch (err) {
      if (err instanceof ApiError && err.code === 'WAS_PRICE_NOT_VERIFIED') {
        log.warn(`${sku}: was-price refused (${err.message}); offer without it`);
        const { compareAt: _c, ...rest } = body;
        created = await api.post('/api/seller/offers/offers', t, rest);
      } else throw err;
    }
    found = created.offer;
    log.created('offer', `${label} · ${condition} · $${(price / 100).toFixed(2)} × ${stock} (${s.storeName})${found.status !== 'active' ? ` [${found.status}]` : ''}`);
  }
  return state.set(key, { id: found.id, seller: s.key, sellerId: r.sellerId, productId, price, stockItemId: found.stockItemId ?? null });
}

async function ownOffers(ctx, s) {
  for (const p of PRODUCTS.filter((x) => x.seller === s.key)) {
    const pr = ctx.state.get(`product.${p.key}`);
    if (!pr.approved) {
      await approveProduct(ctx, pr.id, 'Photos, details and GTINs checked');
      pr.approved = true;
      ctx.state.set(`product.${p.key}`, pr);
    }
    for (const v of p.variants) {
      await sellerOffer(ctx, s, `offer.${p.key}.${v.key}`, { productId: pr.id, variantId: pr.variants[v.key], label: `${p.title} · ${Object.values(v.options).join(' / ')}`, price: v.price, was: v.was, stock: v.stock, sku: v.sku });
    }
  }
}

export async function sellersStep(ctx) {
  for (const s of SELLERS) {
    ctx.log.info(`— ${s.storeName}`);
    await ownerAccount(ctx, s);
    const r = rec(ctx, s.key);
    if (!r.sellerId) {
      const app = await apply(ctx, s);
      await approve(ctx, s, app);
    }
    await payout(ctx, s);
    await shipping(ctx, s);
    await sellerProducts(ctx, s);
    await launchReview(ctx, s);
    await ownOffers(ctx, s);
    await storefront(ctx, s);
  }
  // offers on products created by the Official Store or another seller
  for (const x of EXTRA_OFFERS) {
    const s = SELLERS.find((y) => y.key === x.seller);
    const p = PRODUCTS.find((y) => y.key === x.product);
    const pr = ctx.state.get(`product.${p.key}`);
    if (!pr) {
      ctx.log.warn(`${x.key}: product ${p.key} not created; offer skipped`);
      continue;
    }
    await sellerOffer(ctx, s, `offer.${x.key}`, { productId: pr.id, variantId: pr.variants[x.variant], label: `${p.title} · ${Object.values(p.variants.find((v) => v.key === x.variant).options).join(' / ')}`, condition: x.condition, conditionNotes: x.conditionNotes, missingItems: x.missingItems, price: x.price, stock: x.stock, sku: x.sku, warranty: x.warranty });
  }
}
