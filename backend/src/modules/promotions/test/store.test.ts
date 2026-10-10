import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { newId } from '../../../kernel/lib/ids.js';
import { auth, callers } from '../../../testing/app.js';
import { ADMIN, boot, campaignInput, HOME, KITCHEN, liveCampaign, SELLER, SELLER_A, SELLER_B, STORE, USD, type Kit } from './helpers.js';

let k: Kit;
const accountId = newId();
let customer: string;
beforeAll(async () => {
  k = await boot();
  customer = callers.customer({ accountId });
});
afterAll(() => k?.close());

describe('deals page and coupons', () => {
  it('shows clippable coupons, clips them (applied at checkout) and lists them under My coupons', async () => {
    const o = k.offer({ sellerId: SELLER_A, categoryId: KITCHEN, price: USD(12000) });
    const camp = await liveCampaign(k, campaignInput(k.clock, { name: 'Kitchen $10', description: '$10 off kitchen', discount: { kind: 'fixed_coupon', amountOff: USD(1000), minSpend: USD(10000) }, limits: { perCustomer: 1 }, deals: { show: true, section: 'coupons' }, terms: 'One use per customer' }));
    const deals = await k.call('GET', `${STORE}/deals`, customer);
    expect(deals.status).toBe(200);
    const card = deals.body.coupons.find((c: any) => c.campaignId === camp.id);
    expect(card).toMatchObject({ state: 'available', amountLabel: '$10', unitLabel: 'off', fundedBy: 'Marketly', conditions: 'Home · minimum spend $100 · one use per customer' });
    expect(deals.body.tabs[0].key).toBe('all');
    expect(Date.parse(deals.body.serverTime)).toBeGreaterThan(0);

    const clipped = await k.call('POST', `${STORE}/coupons/${camp.id}/clip`, customer);
    expect(clipped.body.state).toBe('clipped');
    const twice = await k.call('POST', `${STORE}/coupons/${camp.id}/clip`, customer);
    expect(twice.status).toBe(409);
    // clipped coupons apply without a code
    const ev = await k.svc.evaluateCart({ customerId: accountId, lines: [{ lineId: 'a', offerId: o.id, productId: o.productId, variantId: o.variantId, sellerId: SELLER_A, officialStore: false, categoryId: KITCHEN, quantity: 1, unitPrice: USD(12000), packageId: 'p1' }], codes: [] });
    expect(ev.applied).toEqual([expect.objectContaining({ campaignId: camp.id, source: 'clipped', amount: USD(1000) })]);

    const mine = await k.call('GET', `${STORE}/coupons`, customer);
    expect(mine.body.available.find((c: any) => c.campaignId === camp.id).state).toBe('clipped');
    expect(mine.body.rules).toContain('One coupon per seller per order.');
    expect((await k.call('DELETE', `${STORE}/coupons/${camp.id}/clip`, customer)).status).toBe(204);
    expect((await k.call('GET', `${STORE}/coupons`, customer)).body.available.find((c: any) => c.campaignId === camp.id).state).toBe('available');
    const visitor = await k.call('GET', `${STORE}/coupons`, callers.visitor());
    expect(visitor.status).toBe(401);

    const forProduct = await k.call('GET', `${STORE}/products/${o.productId}`, customer);
    expect(forProduct.body.coupons.map((c: any) => c.campaignId)).toContain(camp.id);
    expect(forProduct.body.offers[0]).toMatchObject({ offerId: o.id, price: USD(12000) });
    const eligible = await k.call('GET', `${STORE}/campaigns/${camp.id}/eligible-products`, callers.visitor());
    expect(eligible.body.items.map((p: any) => p.offerId)).toContain(o.id);
  });

  it('refuses clipping coupons that ended, have not started or are not for this customer', async () => {
    const future = await k.call('POST', `${ADMIN}/campaigns`, k.staff, campaignInput(k.clock, { deals: { show: true, section: 'coupons' }, startsAt: new Date(Date.now() + 86_400_000).toISOString() }));
    for (const s of ['submit', 'confirm-funding', 'schedule']) await k.call('POST', `${ADMIN}/campaigns/${future.body.id}/${s}`, k.staff, {});
    const early = await k.call('POST', `${STORE}/coupons/${future.body.id}/clip`, customer);
    expect(early.status).toBe(422);
    expect(early.body.error).toMatchObject({ code: 'COUPON_NOT_ELIGIBLE', details: { reason: 'not_started' } });
    const draft = await k.call('POST', `${ADMIN}/campaigns`, k.staff, campaignInput(k.clock, { deals: { show: true, section: 'coupons' } }));
    expect((await k.call('POST', `${STORE}/coupons/${draft.body.id}/clip`, customer)).status).toBe(404);
  });

  it('checks a code without applying it, and rate-limits look-ups per session', async () => {
    await liveCampaign(k, campaignInput(k.clock, { code: 'LOOKUP15', discount: { kind: 'percent_coupon', percentOffBps: 1500 } }));
    const token = callers.customer({ accountId: newId() });
    const ok = await k.call('POST', `${STORE}/codes/check`, token, { code: 'lookup15' });
    expect(ok.body).toMatchObject({ code: 'lookup15', valid: true, coupon: { code: 'LOOKUP15', amountLabel: '15%' } });
    const nope = await k.call('POST', `${STORE}/codes/check`, token, { code: 'NOTREAL' });
    expect(nope.body).toMatchObject({ valid: false, coupon: null });
    let last = 0;
    for (let i = 0; i < 10; i++) last = (await k.call('POST', `${STORE}/codes/check`, token, { code: 'X' })).status;
    expect(last).toBe(429);
  });

  it('sets and removes event reminders on upcoming events', async () => {
    const ev = await k.call('POST', `${ADMIN}/campaigns`, k.staff, campaignInput(k.clock, { name: 'Holiday Kickoff', deals: { show: true, section: 'events' }, startsAt: new Date(Date.now() + 3 * 86_400_000).toISOString() }));
    for (const s of ['submit', 'confirm-funding', 'schedule']) await k.call('POST', `${ADMIN}/campaigns/${ev.body.id}/${s}`, k.staff, {});
    const set = await k.call('POST', `${STORE}/events/${ev.body.id}/reminder`, customer);
    expect(set.status).toBe(201);
    expect(set.body).toMatchObject({ campaignId: ev.body.id, reminderSet: true, name: 'Holiday Kickoff' });
    const deals = await k.call('GET', `${STORE}/deals?tab=events`, customer);
    expect(deals.body.upcomingEvents.find((e: any) => e.campaignId === ev.body.id).reminderSet).toBe(true);
    expect(deals.body.coupons).toEqual([]);
    expect((await k.call('DELETE', `${STORE}/events/${ev.body.id}/reminder`, customer)).status).toBe(204);
    expect((await k.call('POST', `${STORE}/events/${newId()}/reminder`, customer)).status).toBe(404);
  });

  it('prices offers with an honest was price from offers.lowestPrice', async () => {
    const o = k.offer({ sellerId: SELLER_A, categoryId: HOME, price: USD(10000), lowest: USD(9500).amount });
    const cheap = k.offer({ sellerId: SELLER_A, categoryId: HOME, price: USD(10000), lowest: USD(7000).amount });
    const camp = await liveCampaign(k, campaignInput(k.clock, { name: 'Home Week', discount: { kind: 'markdown', percentOffBps: 2000 }, scope: { mode: 'offers', include: [{ kind: 'offer', id: o.id }, { kind: 'offer', id: cheap.id }], exclude: [] }, deals: { show: true, section: 'clearance' } }));
    const r = await k.call('GET', `${STORE}/offer-prices?offerIds=${o.id},${cheap.id}`, callers.visitor());
    const byId = Object.fromEntries(r.body.map((p: any) => [p.offerId, p]));
    expect(byId[o.id]).toMatchObject({ price: USD(8000), regularPrice: USD(10000), wasPrice: USD(9500), campaignId: camp.id });
    expect(byId[o.id].wasPriceRule).toMatch(/^Lowest price from this seller in the 30 days before/);
    expect(byId[o.id].badges).toEqual(expect.arrayContaining([{ label: '−20%', kind: 'deal' }, { label: 'Clearance', kind: 'clearance' }, { label: 'Home Week', kind: 'campaign' }]));
    // never a was price below the deal price
    expect(byId[cheap.id].wasPrice).toBeNull();
    const bad = await k.call('GET', `${STORE}/offer-prices?offerIds=nope`, callers.visitor());
    expect(bad.status).toBe(400);
    const clearance = await k.call('GET', `${STORE}/deals/clearance?limit=50`, callers.visitor());
    expect(clearance.body.items.map((d: any) => d.offerId)).toEqual(expect.arrayContaining([o.id, cheap.id]));
    expect(await k.svc.isCampaignActive(camp.id)).toEqual({ active: true });
    expect(await k.svc.getPublicCampaign(camp.id)).toMatchObject({ id: camp.id, name: 'Home Week', status: 'live' });
    expect(await k.svc.referencePrice(o.id)).toEqual(USD(9500));
  });

  it('shows live seller promotions for the storefront banner', async () => {
    const o = k.offer({ sellerId: SELLER_B });
    const d = await k.call('POST', `${SELLER}/discounts`, callers.seller({ sellerId: SELLER_B }), { name: 'Northwind 10', kind: 'min_spend', discount: { kind: 'min_spend', percentOffBps: 1000, minSpend: USD(10000) }, offerIds: [o.id], startsAt: new Date(Date.now() - 60_000).toISOString(), endsAt: new Date(Date.now() + 86_400_000).toISOString(), combinesWithPlatformCoupons: false });
    await k.call('POST', `${SELLER}/discounts/${d.body.campaign.id}/schedule`, callers.seller({ sellerId: SELLER_B }));
    const banners = await k.svc.activeSellerPromotions([SELLER_B, SELLER_A], {});
    expect(banners[SELLER_B]).toEqual([expect.objectContaining({ campaignId: d.body.campaign.id, title: '10% off orders over $100', autoApply: true, detail: 'Applied automatically at checkout' })]);
    expect((await k.svc.priceOffers([o.id], {}))[0]!.sellerPromos.map((b) => b.campaignId)).toEqual([d.body.campaign.id]);
  });

  it('answers the Deals page over GraphQL', async () => {
    const res = await k.app.inject({ method: 'POST', url: '/graphql/store', headers: auth(customer), payload: { query: '{ deals { serverTime tabs { key count } coupons { id state amountLabel campaign { name status } } clearance(paging: { limit: 5 }) { items { price { amount } } } } flashSales { id } }' } });
    const body = res.json();
    expect(body.errors).toBeUndefined();
    expect(body.data.deals.tabs[0].key).toBe('all');
    expect(body.data.deals.coupons[0].state).toMatch(/AVAILABLE|CLIPPED|USED/);
  });
});

describe('reactions to other modules', () => {
  it('ends flash items of a deactivated offer and caps deal stock at available stock', async () => {
    const a = k.offer({ ownerType: 'official', sellerId: null, categoryId: HOME, price: USD(5000), stock: 30 });
    const b = k.offer({ ownerType: 'official', sellerId: null, categoryId: HOME, price: USD(5000), stock: 30 });
    const c = await k.call('POST', `${ADMIN}/campaigns`, k.staff, campaignInput(k.clock, { name: 'Flash', discount: { kind: 'flash_sale' }, scope: { mode: 'offers', include: [{ kind: 'offer', id: a.id }, { kind: 'offer', id: b.id }], exclude: [] } }));
    await k.call('PUT', `${ADMIN}/campaigns/${c.body.id}/flash-items`, k.staff, { items: [{ offerId: a.id, dealPrice: USD(3000), dealStock: 20, purchaseLimit: 2 }, { offerId: b.id, dealPrice: USD(3000), dealStock: 20, purchaseLimit: 2 }] });
    await k.emit('offers.offer.status_changed', { offerId: a.id, productId: a.productId, variantId: a.variantId, sellerId: null, ownerType: 'official', from: 'active', to: 'paused', reasonCode: null, reason: null, stockItemId: a.stockItemId });
    await k.emit('inventory.stock.changed', { stockItemId: b.stockItemId, offerId: b.id, ownerType: 'official', sellerId: null, productId: b.productId, variantId: b.variantId, available: 5, reserved: 0, previousAvailable: 30, state: 'in_stock', archived: false, cause: 'sale' });
    const items = await k.call('GET', `${ADMIN}/campaigns/${c.body.id}/flash-items`, k.staff);
    const byOffer = Object.fromEntries(items.body.map((f: any) => [f.offerId, f]));
    expect(byOffer[a.id].state).toBe('ended');
    expect(byOffer[b.id]).toMatchObject({ state: 'active', dealStock: 5 });
  });

  it('removes a suspended seller from campaigns and pauses its own discounts', async () => {
    const SUS = newId();
    const o = k.offer({ sellerId: SUS, categoryId: HOME });
    const own = await k.call('POST', `${SELLER}/discounts`, callers.seller({ sellerId: SUS }), { name: 'Mine', kind: 'markdown', discount: { kind: 'markdown', percentOffBps: 500 }, offerIds: [o.id], startsAt: new Date(Date.now() - 60_000).toISOString(), endsAt: new Date(Date.now() + 86_400_000).toISOString(), combinesWithPlatformCoupons: true });
    await k.call('POST', `${SELLER}/discounts/${own.body.campaign.id}/schedule`, callers.seller({ sellerId: SUS }));
    const camp = await k.call('POST', `${ADMIN}/campaigns`, k.staff, campaignInput(k.clock, { discount: { kind: 'markdown', percentOffBps: 1000 }, participation: { inviteSellers: true, rules: [] } }));
    const inv = await k.call('POST', `${ADMIN}/campaigns/${camp.body.id}/invitations`, k.staff, { sellerIds: [SUS], respondBy: new Date(Date.now() + 86_400_000).toISOString() });
    await k.emit('sellers.seller.suspended', { sellerId: SUS, suspensionId: newId(), reasonCode: 'fraud', reason: 'Counterfeit reports', reviewDate: '2026-11-01', openOrders: 'seller_keeps_fulfilling', appealDeadline: '2026-10-30T00:00:00Z' });
    expect((await k.call('GET', `${SELLER}/discounts/${own.body.campaign.id}`, callers.seller({ sellerId: SUS }))).body.campaign.status).toBe('paused');
    const p = await k.call('GET', `${ADMIN}/campaigns/${camp.body.id}/participations`, k.staff);
    expect(p.body.items.find((x: any) => x.id === inv.body[0].id)).toMatchObject({ state: 'removed', reason: 'Seller suspended: Counterfeit reports' });
    expect(k.of('promotions.participation.decided').at(-1)).toMatchObject({ sellerId: SUS, state: 'removed' });
  });

  it('retargets campaign products after a catalog merge and flags price increases during a campaign', async () => {
    const dup = newId();
    const kept = newId();
    const c = await k.call('POST', `${ADMIN}/campaigns`, k.staff, campaignInput(k.clock, { scope: { mode: 'products', include: [{ kind: 'product', id: dup, label: 'Lamp' }], exclude: [] } }));
    await k.emit('catalog.product.merged', { keptProductId: kept, duplicateProductId: dup, newVariantId: null, intoVariantId: null, reason: 'Duplicate listing' });
    expect((await k.call('GET', `${ADMIN}/campaigns/${c.body.id}`, k.staff)).body.scope.include[0].id).toBe(kept);
    await k.emit('catalog.product.merged', { keptProductId: kept, duplicateProductId: dup, newVariantId: null, intoVariantId: null, reason: 'Duplicate listing' });

    const o = k.offer({ sellerId: SELLER_A, categoryId: HOME });
    const camp = await k.call('POST', `${ADMIN}/campaigns`, k.staff, campaignInput(k.clock, { discount: { kind: 'markdown', percentOffBps: 1000 }, participation: { inviteSellers: true, rules: [] } }));
    const inv = await k.call('POST', `${ADMIN}/campaigns/${camp.body.id}/invitations`, k.staff, { sellerIds: [SELLER_A], respondBy: new Date(Date.now() + 86_400_000).toISOString() });
    await k.call('POST', `${SELLER}/invitations/${inv.body[0].id}/accept`, callers.seller({ sellerId: SELLER_A }), { offerIds: [o.id], consent: true, consentTextVersion: 'v' });
    for (const s of ['submit', 'confirm-funding', 'schedule']) await k.call('POST', `${ADMIN}/campaigns/${camp.body.id}/${s}`, k.staff, {});
    await k.emit('offers.offer.price_changed', { offerId: o.id, productId: o.productId, variantId: o.variantId, sellerId: SELLER_A, ownerType: 'seller', from: USD(10000), to: USD(12000), compareAt: null, priceChangeId: newId(), termsVersion: 2 });
    const p = await k.call('GET', `${ADMIN}/campaigns/${camp.body.id}/participations`, k.staff);
    expect(p.body.items[0].reason).toBe('Price raised from $100.00 to $120.00 during the campaign');
  });
});
