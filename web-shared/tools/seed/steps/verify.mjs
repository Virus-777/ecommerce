// Step 11: check the store side with a visitor token, the way the store app reads it: search (after the
// search.process-dirty job), the Aurora product page with its offers and reviews, the homepage, the Deals page,
// help, policies, a storefront and Jordan's orders. Prints the ids a frontend developer needs.
import { poll } from '../lib/http.mjs';

export async function verifyStep(ctx) {
  const { api, state, log } = ctx;
  const v = ctx.visitor;
  const problems = [];
  const check = (ok, good, bad) => {
    if (ok) log.info(`✓ ${good}`);
    else {
      problems.push(bad);
      log.warn(bad);
    }
  };
  const aurora = state.get('product.aurora')?.id;

  // search: products appear once search.process-dirty has run (every 30 s with JOBS_ENABLED=true)
  const hits = await poll('search results for "Halden"', async () => {
    const r = await api.get('/api/store/search/products?q=Halden&postalCode=97205&limit=24', v);
    const ids = (r.items ?? []).map((i) => i.product?.productId);
    return aurora && ids.includes(aurora) ? r : null;
  }, { timeoutMs: 90_000, intervalMs: 5000, quiet: true });
  check(hits, `search "Halden": ${hits?.items?.length} products, Aurora included`, 'search "Halden" does not return the Aurora headphones yet (search.process-dirty job)');
  const all = await api.get('/api/store/search/products?postalCode=97205&limit=100&sort=newest', v).catch(() => null);
  if (all) log.info(`  search without a query: ${all.total ?? all.items?.length} products`);

  if (aurora) {
    const p = await api.get(`/api/store/catalog/products/${aurora}`, v);
    check(p.variants?.length === 3, `product page: ${p.title}, ${p.variants?.length} variants, ${p.images?.length} photos`, 'Aurora product page incomplete');
    const offers = await api.get(`/api/store/offers/products/${aurora}/offers?postalCode=97205`, v);
    const list = offers.items ?? offers.offers ?? [];
    check(list.length >= 3, `offers page: ${list.length} offers on Aurora`, `only ${list.length} offers on Aurora`);
    const box = await api.get(`/api/store/offers/products/${aurora}/purchase-box?postalCode=97205`, v);
    check(box.selected?.price, `purchase box: ${box.selected?.seller?.name} $${(box.selected?.price?.amount / 100).toFixed(2)}${box.selected?.compareAt ? ` (was $${((box.selected.compareAt.amount?.amount ?? box.selected.compareAt.amount) / 100).toFixed(2)})` : ''}`, 'Aurora purchase box empty');
    const summary = await api.get(`/api/store/reviews/products/${aurora}/rating-summary`, v).catch(() => null);
    const reviews = await api.get(`/api/store/reviews/products/${aurora}/reviews?limit=20`, v).catch(() => ({ items: [] }));
    const questions = await api.get(`/api/store/reviews/products/${aurora}/questions?limit=20`, v).catch(() => ({ items: [] }));
    check((reviews.items ?? []).length > 0, `reviews: ${(reviews.items ?? []).length} on Aurora${summary?.average ? `, average ${summary.average}` : ''}; questions: ${(questions.items ?? []).length}`, 'no published reviews on Aurora');
  }

  const home = await poll('homepage sections', async () => {
    const h = await api.get('/api/store/content/home?postalCode=97205', v);
    return (h.sections ?? []).length >= 5 ? h : null;
  }, { timeoutMs: 60_000, intervalMs: 5000, quiet: true });
  check(home, `homepage: ${home?.sections?.map((s) => s.kind).join(', ')}`, 'homepage has fewer than 5 sections (content.cache-warm rebuilds it within 5 minutes)');

  const deals = await api.get('/api/store/promotions/deals', v);
  const flash = (deals.flashSales ?? [])[0];
  check(flash?.items?.length, `deals: flash sale "${flash?.name}" with ${flash?.items?.length} items (${flash?.state}); coupons tab ${deals.tabs?.find((t) => t.key === 'coupons')?.count ?? '?'}`, 'Deals page has no flash sale');

  const helpHome = await api.get('/api/store/content/help', v).catch(() => null);
  check(helpHome?.topics?.length, `help: ${helpHome?.topics?.length} topics, ${helpHome?.popular?.length} popular articles`, 'help home empty');
  const policies = await api.get('/api/store/content/policies', v).catch(() => []);
  check(policies.length >= 5, `policies: ${policies.map((p) => p.key).join(', ')}`, `only ${policies.length} current policies (content.policy-effective job)`);
  const about = await api.get('/api/store/content/pages/about', v).catch(() => null);
  check(about, 'About page published', 'About page not found');
  const nw = state.section('sellers').northwind?.slug;
  if (nw) {
    const store = await api.get(`/api/store/sellers/stores/${nw}`, v).catch(() => null);
    check(store, `storefront /shop/${nw}: ${store?.storeName ?? store?.store?.storeName ?? 'ok'}`, `storefront ${nw} not found`);
  }
  const jordan = state.section('customers').jordan;
  if (jordan?.accountId) {
    const mine = await api.get('/api/store/orders/orders?limit=20', ctx.customerToken('jordan'));
    check((mine.items ?? []).length >= 5, `Jordan's orders: ${(mine.items ?? []).map((o) => `${o.ref} ${o.status?.value ?? o.statusLabel ?? ''}`).join('; ')}`, `Jordan has ${(mine.items ?? []).length} orders`);
  }

  console.log('\nKey ids');
  const ids = {
    'Olivia Owner (Business Owner) account': state.section('owners').olivia?.accountId,
    'Morgan Hale (Business Owner) account': state.section('owners').morgan?.accountId,
    'Jordan Lee account': jordan?.accountId,
    'Aurora product': aurora,
    'Aurora Midnight black variant': state.get('product.aurora')?.variants?.black,
    'Aurora Official Store offer (Midnight black)': state.get('offer.aurora.black')?.id,
    'Brightline lamp product (no reviews)': state.get('product.lamp')?.id,
    ...Object.fromEntries(Object.entries(state.section('sellers')).map(([k, s]) => [`seller ${k} (slug ${s.slug})`, s.sellerId])),
    ...Object.fromEntries(Object.entries(state.section('orders')).map(([k, o]) => [`order ${k}`, `${o.ref} ${o.orderId}`])),
    'flash sale campaign': state.get('campaign.flash'),
  };
  for (const [k, val] of Object.entries(ids)) if (val) console.log(`  ${k}: ${val}`);
  if (problems.length) log.info(`${problems.length} check(s) not passing yet; jobs may still be catching up: run "npm run seed -- --only verify" in a minute`);
}
