import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { newId } from '../../../kernel/lib/ids.js';
import { addProduct, addSeller, asSeller, asStaff, DAY, eventsNamed, harness, offerInput, profile, sellerOffer, sku, warehouse, type Harness } from './helpers.js';

let h: Harness;
beforeAll(async () => {
  h = await harness();
  await warehouse(h);
});
afterAll(async () => {
  await h?.app.close();
});

const upload = (owner: { kind: 'seller' | 'staff'; id: string | null }, text: string, name = 'prices.csv') => {
  const id = newId();
  h.files.set(id, { name, owner: owner as never, text });
  return id;
};

describe('seller bulk price and quantity files', () => {
  it('previews every row, applies only the ready ones and reports the rest', async () => {
    const sellerId = addSeller(h);
    const p = addProduct(h, { variants: 3 });
    const a = await sellerOffer(h, sellerId, p.id, p.variants[0]!, { sellerSku: 'BULK-A', quantity: 5 });
    const b = await sellerOffer(h, sellerId, p.id, p.variants[1]!, { sellerSku: 'BULK-B', quantity: 5 });
    const c = await sellerOffer(h, sellerId, p.id, p.variants[2]!, { sellerSku: 'BULK-C', quantity: 5 });
    await asSeller(h, sellerId, 'POST', `/offers/${c.id}/end`, {});

    const template = await asSeller(h, sellerId, 'GET', '/bulk-updates/template');
    expect(template.statusCode, template.body).toBe(200);
    const templateText = [...h.files.values()].find((f) => f.name === template.json().fileName)!.text;
    expect(templateText).toContain('BULK-A,189.00,5');

    const csv = ['seller_sku,price,quantity', 'BULK-A,179.00,8', 'BULK-B,,2', 'BULK-B,170,1', 'NOPE,10,1', 'BULK-C,100,1', 'BULK-A,abc,', ',,', 'BULK-D,1,-1'].join('\n') + '\n';
    const fileId = upload({ kind: 'seller', id: sellerId }, csv);
    const created = await asSeller(h, sellerId, 'POST', '/bulk-updates', { fileId });
    expect(created.statusCode, created.body).toBe(202);
    const job = created.json();
    expect(job).toMatchObject({ state: 'preview_ready', ownerType: 'seller', totals: { rows: 7, ready: 2, errors: 5, priceChanges: 1, stockChanges: 2 } }); // blank lines are skipped

    const rows = await asSeller(h, sellerId, 'GET', `/bulk-updates/${job.id}/rows?limit=20`);
    expect(rows.json().items.map((r: { row: number; result: string; error?: { code: string } | null }) => [r.row, r.result, r.error?.code ?? null])).toEqual([
      [2, 'ready', null],
      [3, 'ready', null],
      [4, 'error', 'duplicate_row'],
      [5, 'error', 'unknown_sku'],
      [6, 'error', 'offer_removed'],
      [7, 'error', 'duplicate_row'],
      [8, 'error', 'unknown_sku'],
    ]);
    expect(rows.json().items[0]).toMatchObject({ offerId: a.id, priceFrom: { amount: 18900 }, priceTo: { amount: 17900 }, quantityFrom: 5, quantityTo: 8, productLabel: 'Halden Aurora ANC Headphones · Black' });
    expect((await asSeller(h, addSeller(h), 'GET', `/bulk-updates/${job.id}`)).statusCode).toBe(404);

    const applied = await asSeller(h, sellerId, 'POST', `/bulk-updates/${job.id}/apply`, {});
    expect(applied.statusCode, applied.body).toBe(202);
    expect(applied.json()).toMatchObject({ state: 'applied', totals: { applied: 2, skipped: 5 } });
    expect(await h.api.getOffer(a.id)).toMatchObject({ price: { amount: 17900 } });
    const detail = (await asSeller(h, sellerId, 'GET', `/offers/${b.id}`)).json();
    expect(detail.stock.available).toBe(2);
    expect(eventsNamed(h, 'offers.bulk_update.applied').at(-1)).toMatchObject({ jobId: job.id, applied: 2, skipped: 5, pendingApproval: 0, sellerId });
    expect((await asSeller(h, sellerId, 'POST', `/bulk-updates/${job.id}/apply`, {})).statusCode).toBe(409);

    const report = await asSeller(h, sellerId, 'GET', `/bulk-updates/${job.id}/correction-report`);
    expect(report.statusCode, report.body).toBe(200);
    const reportText = [...h.files.values()].find((f) => f.name === report.json().fileName)!.text;
    expect(reportText.split('\n')[0]).toBe('row,seller_sku,error,what_to_fix');
    expect(reportText).toContain('5,NOPE,unknown_sku');

    const history = await asSeller(h, sellerId, 'GET', '/bulk-updates');
    expect(history.json().items.map((j: { id: string }) => j.id)).toEqual([job.id]);
  });

  it('needs confirmation for large changes, refuses unreadable files and expires old previews', async () => {
    const sellerId = addSeller(h);
    const p = addProduct(h);
    await sellerOffer(h, sellerId, p.id, p.variants[0]!, { sellerSku: 'BIG-A' });
    const job = (await asSeller(h, sellerId, 'POST', '/bulk-updates', { fileId: upload({ kind: 'seller', id: sellerId }, 'seller_sku,price\nBIG-A,20.00\n') })).json();
    const refused = await asSeller(h, sellerId, 'POST', `/bulk-updates/${job.id}/apply`, {});
    expect(refused.statusCode).toBe(409);
    expect(refused.json().error.code).toBe('LARGE_PRICE_CHANGE_UNCONFIRMED');
    expect((await asSeller(h, sellerId, 'POST', `/bulk-updates/${job.id}/apply`, { confirmLargeChanges: true })).json().state).toBe('applied');

    const bad = await asSeller(h, sellerId, 'POST', '/bulk-updates', { fileId: upload({ kind: 'seller', id: sellerId }, 'name,cost\nx,1\n') });
    expect(bad.statusCode).toBe(400);
    expect(bad.json().error.code).toBe('BULK_FILE_INVALID');
    expect((await asSeller(h, sellerId, 'POST', '/bulk-updates', { fileId: upload({ kind: 'seller', id: newId() }, 'seller_sku,price\n') })).json().error.code).toBe('BULK_FILE_INVALID');

    const old = (await asSeller(h, sellerId, 'POST', '/bulk-updates', { fileId: upload({ kind: 'seller', id: sellerId }, 'seller_sku,price\nBIG-A,21.00\n') })).json();
    h.clock.advance(25 * 3_600_000);
    expect((await asSeller(h, sellerId, 'POST', `/bulk-updates/${old.id}/apply`, {})).json().error.code).toBe('BULK_JOB_EXPIRED');
    expect((await asSeller(h, sellerId, 'GET', `/bulk-updates/${old.id}`)).json().state).toBe('expired');
    h.clock.set(new Date());
  });
});

describe('Official Store price files', () => {
  it('sends rows above the limit for approval and applies the rest', async () => {
    const p = addProduct(h);
    const skus = [sku('OFF'), sku('OFF')];
    const ids: string[] = [];
    for (const [i, s] of skus.entries()) {
      const res = await asStaff(h, 'POST', '/official/offers', { productId: p.id, variantId: p.variants[i]!, condition: 'new', price: { amount: 10000, currency: 'USD' }, sku: s, dispatchBusinessDays: 1, shippingProfileId: profile(h), returnTerms: { kind: 'baseline' }, warranty: { kind: 'none' } });
      expect(res.statusCode, res.body).toBe(201);
      ids.push(res.json().offer.id);
    }
    const quantities = await asStaff(h, 'POST', '/official/bulk-updates', { fileId: upload({ kind: 'staff', id: null }, `sku,price,quantity\n${skus[0]},95.00,3\n`), reason: 'Autumn prices' });
    expect(quantities.json().error.code).toBe('BULK_FILE_INVALID');
    const job = await asStaff(h, 'POST', '/official/bulk-updates', { fileId: upload({ kind: 'staff', id: null }, `sku,price\n${skus[0]},95.00\n${skus[1]},50.00\n`), reason: 'Autumn prices' });
    expect(job.statusCode, job.body).toBe(202);
    let n = 0;
    h.access.decision = 'allowed';
    const realDecision = () => (n++ === 0 ? 'allowed' : 'approval_required');
    Object.defineProperty(h.access, 'decision', { get: realDecision, configurable: true });
    const applied = await asStaff(h, 'POST', `/official/bulk-updates/${job.json().id}/apply`);
    Object.defineProperty(h.access, 'decision', { value: 'allowed', writable: true, configurable: true });
    expect(applied.statusCode, applied.body).toBe(202);
    expect(applied.json().totals).toMatchObject({ applied: 1, pendingApproval: 1 });
    expect((await h.api.getOffer(ids[0]!))?.price.amount).toBe(9500);
    expect((await h.api.getOffer(ids[1]!))?.price.amount).toBe(10000);
    const rows = (await asStaff(h, 'GET', `/official/bulk-updates/${job.json().id}/rows`)).json().items;
    expect(rows.map((r: { result: string }) => r.result)).toEqual(['applied', 'pending_approval']);
    expect(h.audits.filter((a) => a.action.startsWith('offers.official.bulk')).map((a) => a.action)).toEqual(['offers.official.bulk_upload', 'offers.official.bulk_apply']);
  });
});

describe('seller tools', () => {
  it('previews an offer before saving and exports the list', async () => {
    const sellerId = addSeller(h);
    const p = addProduct(h);
    await sellerOffer(h, addSeller(h), p.id, p.variants[0]!, { price: { amount: 15000, currency: 'USD' } });
    const preview = await asSeller(h, sellerId, 'POST', '/offers/preview', offerInput(p.id, p.variants[0]!, profile(h, 499, 2), { compareAt: { amount: { amount: 25000, currency: 'USD' }, basis: 'lowest_30_days' } }));
    expect(preview.statusCode, preview.body).toBe(200);
    expect(preview.json()).toMatchObject({ lowestNewPrice: { amount: 15000 }, returnBaseline: { windowDays: 30, kind: 'baseline' }, delivery: { shippingCost: { amount: 499 } }, compareAtCheck: { verified: false } });
    expect(preview.json().warnings.some((w: string) => w.includes('more than 20% above'))).toBe(true);

    const exp = await asSeller(h, sellerId, 'POST', '/offers/exports', { filters: { status: 'active' } });
    expect(exp.statusCode, exp.body).toBe(202);
    expect(h.exports.at(-1)).toMatchObject({ dataset: 'offers.seller.offers', sellerId, filters: { status: 'active' } });
    const own = await sellerOffer(h, sellerId, p.id, p.variants[1]!);
    const rows = await h.api.exportRows('offers.seller.offers', {}, { kind: 'seller', sellerId, accountId: newId() });
    expect(rows.rows).toEqual([expect.objectContaining({ sellerSku: own.body.offer.sellerSku, status: 'active', available: 10, price: 18900 })]);
    expect(await h.api.searchOwnOffers(sellerId, own.body.offer.sellerSku, 5)).toMatchObject({ items: [{ id: own.id }], more: false });
  });

  it('drops a was-price once the sale has ended (nightly check)', async () => {
    const sellerId = addSeller(h);
    const p = addProduct(h, { specs: { MSRP: '249' } });
    const o = await sellerOffer(h, sellerId, p.id, p.variants[0]!, { compareAt: { amount: { amount: 24900, currency: 'USD' }, basis: 'list_price' }, saleEndsAt: new Date(Date.now() + DAY).toISOString() });
    expect((await h.api.getOffer(o.id))?.compareAt?.verified).toBe(true);
    h.clock.advance(2 * DAY);
    await h.app.kernel.jobs.runNow('offers.verify-compare-at');
    await h.app.kernel.events.drain();
    expect(await h.api.getOffer(o.id)).toMatchObject({ compareAt: null, termsVersion: 2 });
    expect(eventsNamed(h, 'offers.offer.updated').find((e) => e.offerId === o.id)).toMatchObject({ fields: ['compareAt'] });
    h.clock.set(new Date());
  });
});
