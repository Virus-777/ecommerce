/**
 * Gap pass 4: campaigns.funding_note column (and the migration moving it out of deals), perOrder limited to 1,
 * automatic discounts on offer prices covering category scopes and minimum spends, and the was-price window
 * read from offers.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { m0003FundingNote } from '../infra/postgres/migrations/0003_funding_note.js';
import { ADMIN, boot, campaignInput, ELECTRONICS, HOME, KITCHEN, liveCampaign, SELLER_A, USD, type Kit } from './helpers.js';

let k: Kit;
beforeAll(async () => {
  k = await boot();
});
afterAll(() => k?.close());

describe('funding note', () => {
  it('is kept in its own column and shown on the campaign', async () => {
    const created = await k.call('POST', `${ADMIN}/campaigns`, k.staff, campaignInput(k.clock, { funding: { owner: 'platform', costCenter: 'MKT-01', note: 'Official Store items are a company cost' }, deals: { show: true, section: 'events' } }));
    expect(created.status, JSON.stringify(created.body)).toBe(201);
    expect(created.body.funding.note).toBe('Official Store items are a company cost');
    const row = await k.svc.core.repo.get('campaigns', created.body.id);
    expect(row).toMatchObject({ funding_note: 'Official Store items are a company cost', deals: { show: true, section: 'events' } });
  });
});

describe('limits', () => {
  it('perOrder above 1 is refused: a campaign applies once per order', async () => {
    const res = await k.call('POST', `${ADMIN}/campaigns`, k.staff, campaignInput(k.clock, { limits: { budget: USD(100000), perOrder: 2 } }));
    expect(res.body.error.code).toBe('VALIDATION_FAILED');
    expect(res.body.error.details.issues).toEqual([expect.objectContaining({ path: 'limits.perOrder' })]);
    const ok = await k.call('POST', `${ADMIN}/campaigns`, k.staff, campaignInput(k.clock, { limits: { budget: USD(100000), perOrder: 1 } }));
    expect(ok.status, JSON.stringify(ok.body)).toBe(201);
  });
});

describe('automatic discounts on offer prices', () => {
  it('covers category-scoped campaigns (catalog category chain) and minimum spends one unit reaches', async () => {
    const kitchen = k.offer({ sellerId: SELLER_A, categoryId: KITCHEN, price: USD(10000) });
    const tv = k.offer({ sellerId: SELLER_A, categoryId: ELECTRONICS, price: USD(10000) });
    await liveCampaign(k, campaignInput(k.clock, { name: 'Home 15% off', autoApply: true, scope: { mode: 'categories', include: [{ kind: 'category', id: HOME, label: 'Home' }], exclude: [] }, discount: { kind: 'percent_coupon', percentOffBps: 1500 } }));
    const [pk, pt] = await k.svc.priceOffers([kitchen.id, tv.id], {});
    expect(pk).toMatchObject({ offerId: kitchen.id, automaticDiscount: USD(1500) });
    expect(pk!.automaticDiscountLabel).toContain('Home 15% off');
    expect(pt).toMatchObject({ offerId: tv.id, automaticDiscount: null });

    const big = k.offer({ sellerId: SELLER_A, categoryId: ELECTRONICS, price: USD(8000) });
    const small = k.offer({ sellerId: SELLER_A, categoryId: ELECTRONICS, price: USD(3000) });
    await liveCampaign(k, campaignInput(k.clock, { name: '$10 off $50', autoApply: true, scope: { mode: 'offers', include: [{ kind: 'offer', id: big.id }, { kind: 'offer', id: small.id }], exclude: [] }, discount: { kind: 'fixed_coupon', amountOff: USD(1000), minSpend: USD(5000) } }));
    const [pb, ps] = await k.svc.priceOffers([big.id, small.id], {});
    expect(pb).toMatchObject({ offerId: big.id, automaticDiscount: USD(1000) });
    expect(ps).toMatchObject({ offerId: small.id, automaticDiscount: null });
  });

  it('reads the was-price window from offers (no promotions copy)', async () => {
    expect(await k.svc.core.lookbackDays()).toBe(30);
    expect(Object.keys((await import('../../../spec/promotions.js')).spec.settings)).not.toContain('referencePriceDays');
  });
});

describe('migration 0003', () => {
  it('moves the funding note out of deals into funding_note and leaves deals as the placement', async () => {
    const a = (await k.call('POST', `${ADMIN}/campaigns`, k.staff, campaignInput(k.clock, { name: 'Old A' }))).body.id as string;
    const b = (await k.call('POST', `${ADMIN}/campaigns`, k.staff, campaignInput(k.clock, { name: 'Old B' }))).body.id as string;
    await k.app.kernel.database.exec(`alter table promotions.campaigns drop column funding_note;
      update promotions.campaigns set deals = '{"placement": {"show": true, "section": "flash"}, "fundingNote": "Company cost"}' where id = '${a}';
      update promotions.campaigns set deals = '{"placement": null, "fundingNote": null}' where id = '${b}';`);
    await k.app.kernel.database.exec(m0003FundingNote.sql);
    expect(await k.svc.core.repo.get('campaigns', a)).toMatchObject({ funding_note: 'Company cost', deals: { show: true, section: 'flash' } });
    expect(await k.svc.core.repo.get('campaigns', b)).toMatchObject({ funding_note: null, deals: null });
  });
});
