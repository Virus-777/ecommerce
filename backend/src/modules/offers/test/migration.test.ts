/**
 * Migration 0002 resolves duplicates that the old indexes let through (Official Store rows have seller_id null)
 * before it creates the new unique indexes. Run against a copy of the situation: the 0002 objects are dropped,
 * duplicate rows inserted, and the migration's SQL applied again.
 */

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { newId } from '../../../kernel/lib/ids.js';
import { m0002TitlesAndUniqueness } from '../infra/postgres/migrations/0002_titles_and_uniqueness.js';
import type { OffersService } from '../service.js';
import { addProduct, asStaff, harness, profile, sku, warehouse, type Harness } from './helpers.js';

let h: Harness;
beforeAll(async () => {
  h = await harness();
  await warehouse(h);
});
afterAll(async () => {
  await h?.app.close();
});

describe('migration 0002', () => {
  it('removes duplicate live offers (stock item, New variant), renames duplicate SKUs, then enforces the unique indexes', async () => {
    const db = h.app.kernel.database.kysely;
    const svc = h.app.kernel.boot.apis.get('offers') as OffersService;
    const p = addProduct(h, { variants: 3 });
    const res = await asStaff(h, 'POST', '/official/offers', {
      productId: p.id,
      variantId: p.variants[0],
      condition: 'new',
      price: { amount: 19900, currency: 'USD' },
      sku: sku('MIG'),
      dispatchBusinessDays: 0,
      shippingProfileId: profile(h, 0, 2, null),
      returnTerms: { kind: 'baseline' },
      warranty: { kind: 'none' },
      publish: true,
    });
    expect(res.statusCode, res.body).toBe(201);
    const a = (await svc.core.repo.get('offers', res.json().offer.id))!;

    // the state before 0002: no title columns, the old (NULLS DISTINCT) indexes only
    await h.app.kernel.database.exec(`drop index offers.offers_owner_seller_sku_key; drop index offers.offers_live_new_variant_key; drop index offers.offers_live_stock_item_key; drop index offers.offers_title_trgm; drop index offers.offers_shipping_profile_id_status_idx;
              alter table offers.offers drop column title, drop column missing_items_stale`);
    const { title: _t, missing_items_stale: _m, ...base } = a as typeof a & Record<string, unknown>;
    const at = (ms: number) => new Date(new Date(a.created_at).getTime() + ms);
    const b = { ...base, id: newId(), variant_id: p.variants[1], stock_item_id: newId(), created_at: at(1000) }; // same SKU
    const c = { ...base, id: newId(), seller_sku: sku('MIG'), stock_item_id: newId(), created_at: at(2000) }; // same New variant
    const d = { ...base, id: newId(), seller_sku: sku('MIG'), variant_id: p.variants[2], status: 'draft', created_at: at(3000) }; // same stock item
    for (const row of [b, c, d]) await db.withSchema('offers').insertInto('offers' as never).values({ ...row, included_items: JSON.stringify(row.included_items), missing_items: JSON.stringify(row.missing_items), status_reason: null, ineligible_source: null } as never).execute();

    await h.app.kernel.database.exec(m0002TitlesAndUniqueness.sql);

    const get = (id: string) => svc.core.repo.get('offers', id);
    expect(await get(a.id)).toMatchObject({ status: a.status, seller_sku: a.seller_sku });
    expect(await get(b.id)).toMatchObject({ status: a.status, seller_sku: `${a.seller_sku}-dup-${b.id.slice(0, 8)}` });
    expect(await get(c.id)).toMatchObject({ status: 'removed', status_reason: expect.objectContaining({ code: 'removed_by_staff' }) });
    expect(await get(d.id)).toMatchObject({ status: 'removed' });
    expect(await svc.core.repo.find('offer_status_log', { offer_id: [c.id, d.id], reason_code: 'duplicate_resolved' })).toHaveLength(2);
    // and from now on the database refuses them
    await expect(svc.core.unique(() => svc.core.repo.update('offers', c.id, { status: 'active' }))).rejects.toMatchObject({ code: 'DUPLICATE_OFFER' });
  });
});
