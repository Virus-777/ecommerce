/**
 * Gap pass 4: return terms keep returns' policy version (text) and the category exception text on the offer
 * (columns, migration backfill, job backfill for older rows), and Official Store ships-from follows the inventory
 * default location through the hourly job.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { newId } from '../../../kernel/lib/ids.js';
import { m0003ReturnTermsColumns } from '../infra/postgres/migrations/0003_return_terms_columns.js';
import type { OffersService } from '../service.js';
import { ADDRESS, addProduct, addSeller, asStaff, harness, profile, sellerOffer, sku, warehouse, type Harness } from './helpers.js';

let h: Harness;
let svc: OffersService;
beforeAll(async () => {
  h = await harness();
  svc = h.app.kernel.boot.apis.get('offers') as OffersService;
  await warehouse(h);
});
afterAll(async () => {
  await h?.app.close();
});

const row = (id: string) => svc.core.repo.get('offers', id);

describe('return terms on the offer', () => {
  it('stores the policy version and the category exception text returns gave at save', async () => {
    const categoryId = newId();
    h.returnExceptions.set(categoryId, 'Earbuds: 15-day returns, unopened only');
    const sellerId = addSeller(h);
    const p = addProduct(h, { categoryId });
    const { id, body } = await sellerOffer(h, sellerId, p.id, p.variants[0]!);
    expect(body.offer.returnTerms).toMatchObject({ policyVersion: 'v1', categoryException: 'Earbuds: 15-day returns, unopened only' });
    expect(await row(id)).toMatchObject({ return_policy_version: 'v1', return_category_exception: 'Earbuds: 15-day returns, unopened only' });

    // a plain category: no exception text
    const q = addProduct(h);
    const plain = await sellerOffer(h, sellerId, q.id, q.variants[0]!);
    expect(plain.body.offer.returnTerms).toMatchObject({ policyVersion: 'v1', categoryException: null });
  });

  it('the hourly job fills offers saved before the columns existed, walking every row', async () => {
    const categoryId = newId();
    h.returnExceptions.set(categoryId, 'Final sale: no change-of-mind returns');
    const sellerId = addSeller(h);
    const p = addProduct(h, { categoryId, variants: 3 });
    const a = await sellerOffer(h, sellerId, p.id, p.variants[0]!);
    const b = await sellerOffer(h, sellerId, p.id, p.variants[1]!);
    for (const id of [a.id, b.id]) await svc.core.repo.update('offers', id, { return_policy_version: null, return_category_exception: null });

    await h.app.kernel.jobs.runNow('offers.reevaluate-eligibility');
    for (const id of [a.id, b.id]) expect(await row(id)).toMatchObject({ return_policy_version: 'v1', return_category_exception: 'Final sale: no change-of-mind returns' });
    expect((await svc.getOfferAdmin(a.id))!.returnTerms).toMatchObject({ policyVersion: 'v1', categoryException: 'Final sale: no change-of-mind returns' });
    // nothing left to fill: the next run changes nothing
    expect(await svc.featured.backfillReturnTerms()).toBe(0);
  });
});

describe('Official Store ships-from', () => {
  it('follows the inventory default location on the hourly job (no location event)', async () => {
    const p = addProduct(h);
    const res = await asStaff(h, 'POST', '/official/offers', {
      productId: p.id,
      variantId: p.variants[0],
      condition: 'new',
      price: { amount: 19900, currency: 'USD' },
      sku: sku('SHIP'),
      dispatchBusinessDays: 0,
      shippingProfileId: profile(h, 0, 2, null),
      returnTerms: { kind: 'baseline' },
      warranty: { kind: 'none' },
    });
    expect(res.statusCode, res.body).toBe(201);
    const id = res.json().offer.id as string;
    expect(res.json().offer.dispatch.shipsFrom).toBe('Reno, NV');
    const terms = (await row(id))!.terms_version;

    const inventory = h.app.kernel.boot.apis.get('inventory') as Record<string, unknown>;
    const before = inventory.getDefaultLocation;
    inventory.getDefaultLocation = async () => ({ id: newId(), code: 'SLC1', name: 'Salt Lake warehouse', kind: 'warehouse', ownerType: 'official', sellerId: null, address: { ...ADDRESS, city: 'Salt Lake City', region: 'UT' }, timeZone: 'America/Denver', sellable: true, active: true, isDefault: true });
    try {
      await h.app.kernel.jobs.runNow('offers.reevaluate-eligibility');
      expect((await svc.getOfferAdmin(id))!.dispatch.shipsFrom).toBe('Salt Lake City, UT');
      expect((await row(id))!.terms_version).toBe(terms); // not a terms change
      expect(await svc.featured.refreshOfficialShipsFrom()).toBe(0);
    } finally {
      inventory.getDefaultLocation = before;
      await svc.featured.refreshOfficialShipsFrom();
    }
  });
});

describe('migration 0003', () => {
  it('turns return_policy_id into return_policy_version text and adds return_category_exception', async () => {
    const sellerId = addSeller(h);
    const p = addProduct(h);
    const { id } = await sellerOffer(h, sellerId, p.id, p.variants[0]!);
    const { id: other } = await sellerOffer(h, sellerId, p.id, p.variants[1]!);
    const old = newId();
    // the state before 0003: a uuid return_policy_id, no version or exception columns
    await h.app.kernel.database.exec(`alter table offers.offers drop column return_policy_version, drop column return_category_exception;
      alter table offers.offers add column return_policy_id uuid;
      update offers.offers set return_policy_id = '${old}' where id = '${id}';`);
    await h.app.kernel.database.exec(m0003ReturnTermsColumns.sql);
    expect(await row(id)).toMatchObject({ return_policy_version: old, return_category_exception: null });
    expect(await row(other)).toMatchObject({ return_policy_version: null, return_category_exception: null });
    expect(await row(id)).not.toHaveProperty('return_policy_id');
  });
});
