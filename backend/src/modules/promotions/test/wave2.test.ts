/**
 * Wave 2 (BACKEND-REQUESTS.md): seller slugs on deal cards (G18), the consent text on invitations (G57a), optional
 * reasons for leaving and pausing (G57b, G68) and separation of duties on funding confirmation (G65a).
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { callers } from '../../../testing/app.js';
import { ADMIN, boot, campaignInput, HOME, liveCampaign, SELLER, SELLER_A, STORE, USD, type Kit } from './helpers.js';

let k: Kit;
let sellerA: string;
beforeAll(async () => {
  k = await boot();
  sellerA = callers.seller({ sellerId: SELLER_A });
});
afterAll(() => k?.close());

describe('deal cards link to the seller storefront (G18)', () => {
  it('puts the seller slug on flash items and deal products; the Official Store has none', async () => {
    const mine = k.offer({ sellerId: SELLER_A, categoryId: HOME, price: USD(20000), stock: 100 });
    const official = k.offer({ sellerId: null, ownerType: 'official', categoryId: HOME, price: USD(20000), stock: 100 });
    const created = await k.call('POST', `${ADMIN}/campaigns`, k.staff, campaignInput(k.clock, { name: 'Lightning', discount: { kind: 'flash_sale' }, scope: { mode: 'offers', include: [{ kind: 'offer', id: mine.id }, { kind: 'offer', id: official.id }], exclude: [] } }));
    const put = await k.call('PUT', `${ADMIN}/campaigns/${created.body.id}/flash-items`, k.staff, { items: [mine, official].map((o) => ({ offerId: o.id, dealPrice: USD(12000), dealStock: 2, purchaseLimit: 1 })) });
    expect(put.status).toBe(200);
    expect(Object.fromEntries(put.body.map((f: any) => [f.offerId, f.sellerSlug]))).toEqual({ [mine.id]: 's', [official.id]: null });

    const o = k.offer({ sellerId: SELLER_A, categoryId: HOME, price: USD(10000) });
    const camp = await liveCampaign(k, campaignInput(k.clock, { name: 'Home coupon', deals: { show: true, section: 'coupons' } }));
    const products = await k.call('GET', `${STORE}/campaigns/${camp.id}/eligible-products`, callers.visitor());
    expect(products.status).toBe(200);
    expect(products.body.items.find((d: any) => d.offerId === o.id)).toMatchObject({ sellerName: 'Casa Verde Home', sellerSlug: 's' });
  });
});

describe('participation (G57a, G57b)', () => {
  it('shows the consent text and version before accepting and lets the seller leave without a reason', async () => {
    const good = k.offer({ sellerId: SELLER_A, categoryId: HOME, stock: 50 });
    const startsAt = new Date(k.clock.now().getTime() + 2 * 86_400_000).toISOString();
    const c = await k.call('POST', `${ADMIN}/campaigns`, k.staff, campaignInput(k.clock, { startsAt, discount: { kind: 'markdown', percentOffBps: 2000 }, funding: { owner: 'shared', platformShareBps: 5000 }, participation: { inviteSellers: true, rules: [] } }));
    const inv = await k.call('POST', `${ADMIN}/campaigns/${c.body.id}/invitations`, k.staff, { sellerIds: [SELLER_A], respondBy: new Date(k.clock.now().getTime() + 86_400_000).toISOString() });
    const pid = inv.body[0].id;
    const before = (await k.call('GET', `${SELLER}/invitations/${pid}`, sellerA)).body;
    expect(before.consentTextVersion).toBe('2026-10');
    expect(before.consentText).toMatch(/^I agree to join Fall Home Week .* My store funds 50% of each discount/);
    const ok = await k.call('POST', `${SELLER}/invitations/${pid}/accept`, sellerA, { offerIds: [good.id], consent: true, consentTextVersion: before.consentTextVersion });
    expect(ok.body.consentText).toBe(ok.body.participation.consentText);
    const left = await k.call('POST', `${SELLER}/invitations/${pid}/withdraw`, sellerA, {});
    expect(left.status).toBe(200);
    expect(left.body.participation).toMatchObject({ state: 'withdrawn', reason: 'Left the campaign' });
  });
});

describe('funding confirmation and pausing (G65a, G68)', () => {
  it("refuses the creator's or submitter's own confirmation (SAME_REVIEWER)", async () => {
    const created = await k.call('POST', `${ADMIN}/campaigns`, k.staff, campaignInput(k.clock));
    const id = created.body.id;
    const submitter = callers.staff();
    expect((await k.call('POST', `${ADMIN}/campaigns/${id}/submit`, submitter, {})).status).toBe(200);
    for (const who of [k.staff, submitter]) {
      const own = await k.call('POST', `${ADMIN}/campaigns/${id}/confirm-funding`, who, {});
      expect(own.status).toBe(409);
      expect(own.body.error.code).toBe('SAME_REVIEWER');
    }
    expect((await k.call('POST', `${ADMIN}/campaigns/${id}/confirm-funding`, k.finance, {})).body.status).toBe('approved');
  });

  it('pauses without a reason using the default text (still audited)', async () => {
    const camp = await liveCampaign(k, campaignInput(k.clock, { name: 'Pause me' }));
    const paused = await k.call('POST', `${ADMIN}/campaigns/${camp.id}/pause`, k.staff, {});
    expect(paused.status).toBe(200);
    expect(paused.body.status).toBe('paused');
    expect(k.audits.at(-1)).toMatchObject({ action: 'promotions.campaign.pause', reason: 'Paused by Marketing' });
    expect(k.of('promotions.campaign.paused').at(-1)).toMatchObject({ campaignId: camp.id, reason: 'Paused by Marketing' });
  });
});
