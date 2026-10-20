/**
 * Seller unit costs per offer (doc 09 §3.1): set a cost, history order, the cost for a day (unitCostsAt),
 * validation, POST /costs with partial errors, the bulk file's unit_cost column, cost_changed events, record scope
 * and the offers.costs.manage permission.
 */
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { newId } from '../../../kernel/lib/ids.js';
import { marketDate } from '../../../testing/app.js';
import type { OffersService } from '../service.js';
import { addProduct, addSeller, asSeller, asStaff, call, DAY, eventsNamed, harness, sellerHeaders, sellerOffer, type Harness } from './helpers.js';

let h: Harness;
beforeAll(async () => {
  h = await harness();
});
afterAll(async () => {
  await h?.app.close();
});

const usd = (amount: number) => ({ amount, currency: 'USD' });
/** The market day `days` from now (negative: back) */
const day = (days = 0) => marketDate(h.clock.now(), days);
/** A time on the market day `days` from now */
const at = (days = 0) => new Date(h.clock.now().getTime() + days * DAY).toISOString();

async function ownOffer(sellerId = addSeller(h)) {
  const p = addProduct(h, { variants: 1 });
  const o = await sellerOffer(h, sellerId, p.id, p.variants[0]!);
  return { sellerId, productId: p.id, offerId: o.id, sku: o.body.offer.sellerSku as string };
}

const setCost = (sellerId: string, offerId: string, body: unknown) => asSeller(h, sellerId, 'PUT', `/offers/${offerId}/cost`, body);
const costEvents = (offerId: string) => eventsNamed(h, 'offers.offer.cost_changed').filter((e) => e.offerId === offerId);

describe('PUT /offers/{id}/cost', () => {
  it('saves a cost from today, publishes one event, audits without the amount and shows it on the seller views only', async () => {
    const o = await ownOffer();
    const res = await setCost(o.sellerId, o.offerId, { unitCost: usd(1250), note: ' new supplier ' });
    expect(res.statusCode, res.body).toBe(200);
    expect(res.json()).toMatchObject({ offerId: o.offerId, productId: o.productId, unitCost: usd(1250), effectiveFrom: day(), note: 'new supplier', setBy: { name: 'Avery Stone' } });
    expect(res.json().setBy.id).toEqual(expect.any(String));

    expect(costEvents(o.offerId)).toEqual([{ offerId: o.offerId, sellerId: o.sellerId, productId: o.productId, unitCost: usd(1250), effectiveFrom: day() }]);
    const entry = h.audits.find((a) => a.action === 'offers.offer.cost_set' && a.target.id === o.offerId)!;
    expect(entry).toMatchObject({ category: 'catalog', visibleToSeller: true, after: { effectiveFrom: day() } });
    expect(JSON.stringify(entry)).not.toContain('1250');

    const detail = (await asSeller(h, o.sellerId, 'GET', `/offers/${o.offerId}`)).json();
    expect(detail.offer).toMatchObject({ unitCost: usd(1250), unitCostFrom: day() });
    const list = (await asSeller(h, o.sellerId, 'GET', '/offers?limit=50')).json();
    expect(list.items.find((r: { offer: { id: string } }) => r.offer.id === o.offerId).unitCost).toEqual(usd(1250));

    // private to the seller: staff and the public API never see it
    const admin = (await asStaff(h, 'GET', `/offers/${o.offerId}`)).json();
    expect(admin.offer.unitCost ?? null).toBeNull();
    expect((await h.api.getOffer(o.offerId))?.unitCost ?? null).toBeNull();
  });

  it('an offer without a cost shows none', async () => {
    const o = await ownOffer();
    const detail = (await asSeller(h, o.sellerId, 'GET', `/offers/${o.offerId}`)).json();
    expect(detail.offer).toMatchObject({ unitCost: null, unitCostFrom: null });
  });

  it('refuses a negative cost, another currency, a day more than 400 days back or more than 1 day ahead', async () => {
    const o = await ownOffer();
    const refused = async (body: unknown, path: string) => {
      const res = await setCost(o.sellerId, o.offerId, body);
      expect(res.statusCode, res.body).toBe(400);
      expect(res.json().error.code).toBe('VALIDATION_FAILED');
      // the request schema may refuse it first (no issues of ours then); our own refusals name the field
      const issues = res.json().error.details?.issues;
      if (issues) expect(issues.map((i: { path: string }) => i.path)).toContain(path);
    };
    await refused({ unitCost: usd(-1) }, 'unitCost');
    await refused({ unitCost: { amount: 500, currency: 'EUR' } }, 'unitCost.currency');
    await refused({ unitCost: usd(500), effectiveFrom: day(-401) }, 'effectiveFrom');
    await refused({ unitCost: usd(500), effectiveFrom: day(2) }, 'effectiveFrom');
    expect(costEvents(o.offerId)).toEqual([]);

    // the edges are allowed, and zero is a cost
    expect((await setCost(o.sellerId, o.offerId, { unitCost: usd(0), effectiveFrom: day(-400) })).statusCode).toBe(200);
    expect((await setCost(o.sellerId, o.offerId, { unitCost: usd(700), effectiveFrom: day(1) })).statusCode).toBe(200);
    // a cost from tomorrow is not in force today
    const detail = (await asSeller(h, o.sellerId, 'GET', `/offers/${o.offerId}`)).json();
    expect(detail.offer).toMatchObject({ unitCost: usd(0), unitCostFrom: day(-400) });
  });

  it("another seller's offer is not found, and setting needs offers.costs.manage", async () => {
    const o = await ownOffer();
    await setCost(o.sellerId, o.offerId, { unitCost: usd(900) });
    const other = addSeller(h);
    expect((await setCost(other, o.offerId, { unitCost: usd(100) })).statusCode).toBe(404);
    expect((await asSeller(h, other, 'GET', `/offers/${o.offerId}/costs`)).statusCode).toBe(404);
    expect((await setCost(o.sellerId, newId(), { unitCost: usd(100) })).statusCode).toBe(404);

    const member = (permissions: string[]) => sellerHeaders({ sellerId: o.sellerId, permissions });
    const asMember = (permissions: string[], method: 'GET' | 'PUT', path: string, body?: unknown) => call(h, method, `/api/seller/offers${path}`, member(permissions), body);
    // prices alone do not let a member set costs; any member may read them
    expect((await asMember(['offers.prices.manage'], 'PUT', `/offers/${o.offerId}/cost`, { unitCost: usd(100) })).statusCode).toBe(403);
    const read = await asMember(['offers.offers.manage'], 'GET', `/offers/${o.offerId}/costs`);
    expect(read.statusCode, read.body).toBe(200);
    expect(read.json().items).toHaveLength(1);
    expect((await asMember(['offers.costs.manage'], 'PUT', `/offers/${o.offerId}/cost`, { unitCost: usd(950) })).statusCode).toBe(200);
  });
});

describe('cost history and the cost for a day', () => {
  it('lists newest first (later saved first on the same day) and pages', async () => {
    const o = await ownOffer();
    for (const [amount, from] of [
      [1000, day(-10)],
      [1100, day(-3)],
      [1200, day(-3)],
      [1300, day()],
      [900, day(-20)],
    ] as const) {
      expect((await setCost(o.sellerId, o.offerId, { unitCost: usd(amount), effectiveFrom: from })).statusCode).toBe(200);
    }
    const all = (await asSeller(h, o.sellerId, 'GET', `/offers/${o.offerId}/costs?limit=10`)).json();
    expect(all.items.map((c: { unitCost: { amount: number }; effectiveFrom: string }) => [c.unitCost.amount, c.effectiveFrom])).toEqual([
      [1300, day()],
      [1200, day(-3)],
      [1100, day(-3)],
      [1000, day(-10)],
      [900, day(-20)],
    ]);

    const first = (await asSeller(h, o.sellerId, 'GET', `/offers/${o.offerId}/costs?limit=2`)).json();
    expect(first.items.map((c: { unitCost: { amount: number } }) => c.unitCost.amount)).toEqual([1300, 1200]);
    expect(first.nextCursor).toEqual(expect.any(String));
    const second = (await asSeller(h, o.sellerId, 'GET', `/offers/${o.offerId}/costs?limit=2&cursor=${encodeURIComponent(first.nextCursor)}`)).json();
    expect(second.items.map((c: { unitCost: { amount: number } }) => c.unitCost.amount)).toEqual([1100, 1000]);
  });

  it('unitCostsAt: the latest effective_from on or before the day (ties: latest saved), in the order asked, null without a cost', async () => {
    const o = await ownOffer();
    const b = await ownOffer(o.sellerId);
    const none = await ownOffer(o.sellerId);
    for (const [amount, from] of [
      [1000, day(-10)],
      [1100, day(-3)],
      [1200, day(-3)],
      [1300, day(1)],
    ] as const) {
      await setCost(o.sellerId, o.offerId, { unitCost: usd(amount), effectiveFrom: from });
    }
    await setCost(b.sellerId, b.offerId, { unitCost: usd(500), effectiveFrom: day(-1) });

    const costs = await h.api.unitCostsAt([
      { offerId: o.offerId, at: at(-11) }, // before the first cost
      { offerId: o.offerId, at: at(-10) },
      { offerId: o.offerId, at: at(-4) },
      { offerId: o.offerId, at: at(-3) }, // two costs that day: the later saved
      { offerId: o.offerId, at: at() },
      { offerId: o.offerId, at: at(1) }, // tomorrow's cost
      { offerId: b.offerId, at: at() },
      { offerId: b.offerId, at: at(-2) },
      { offerId: none.offerId, at: at() },
      { offerId: newId(), at: at() },
      { offerId: o.offerId, at: 'not a time' },
      { offerId: o.offerId, at: at(-10) }, // the same item again
    ]);
    expect(costs).toEqual([null, usd(1000), usd(1000), usd(1200), usd(1200), usd(1300), usd(500), null, null, null, null, usd(1000)]);
    expect(await h.api.unitCostsAt([])).toEqual([]);
  });

  it('unitCostsAt reads the costs of every item with one query', async () => {
    const sellerId = addSeller(h);
    const offers: Awaited<ReturnType<typeof ownOffer>>[] = [];
    for (let i = 0; i < 4; i++) offers.push(await ownOffer(sellerId));
    for (const [i, o] of offers.entries()) await setCost(sellerId, o.offerId, { unitCost: usd(100 * (i + 1)), effectiveFrom: day(-5) });
    const repo = (h.api as unknown as OffersService).core.repo;
    const read = vi.spyOn(repo, 'costsUpTo');
    try {
      const items = Array.from({ length: 40 }, (_, i) => ({ offerId: offers[i % 4]!.offerId, at: at(-(i % 7)) }));
      const costs = await h.api.unitCostsAt(items);
      expect(read).toHaveBeenCalledTimes(1);
      expect(costs).toEqual(items.map((_, i) => (i % 7 > 5 ? null : usd(100 * ((i % 4) + 1)))));
    } finally {
      read.mockRestore();
    }
  });
});

describe('POST /costs', () => {
  it('saves the valid items and lists the refused ones; one event per saved row', async () => {
    const o = await ownOffer();
    const b = await ownOffer(o.sellerId);
    const c = await ownOffer(o.sellerId);
    const theirs = await ownOffer();
    const unknown = newId();
    const res = await asSeller(h, o.sellerId, 'POST', '/costs', {
      items: [
        { offerId: o.offerId, unitCost: usd(1500) },
        { offerId: b.offerId, unitCost: usd(800), effectiveFrom: day(-30), note: 'old stock' },
        { offerId: theirs.offerId, unitCost: usd(100) },
        { offerId: unknown, unitCost: usd(100) },
        { offerId: c.offerId, unitCost: usd(-5) },
        { offerId: o.offerId, unitCost: usd(1600) },
      ],
    });
    expect(res.statusCode, res.body).toBe(200);
    expect(res.json().saved).toBe(2);
    expect(res.json().errors.map((e: { offerId: string; code: string }) => [e.offerId, e.code])).toEqual([
      [theirs.offerId, 'NOT_FOUND'],
      [unknown, 'NOT_FOUND'],
      [c.offerId, 'VALIDATION_FAILED'],
      [o.offerId, 'VALIDATION_FAILED'],
    ]);
    expect(costEvents(o.offerId)).toEqual([expect.objectContaining({ unitCost: usd(1500), effectiveFrom: day() })]);
    expect(costEvents(b.offerId)).toEqual([expect.objectContaining({ unitCost: usd(800), effectiveFrom: day(-30), sellerId: o.sellerId, productId: b.productId })]);
    expect(costEvents(c.offerId)).toEqual([]);
    expect(costEvents(theirs.offerId)).toEqual([]);
    const entry = h.audits.find((a) => a.action === 'offers.offer.costs_set' && a.target.id === o.sellerId)!;
    expect(entry.relatedTargets?.map((t) => t.id).sort()).toEqual([o.offerId, b.offerId].sort());
    expect((await asSeller(h, theirs.sellerId, 'GET', `/offers/${theirs.offerId}/costs`)).json().items).toEqual([]);
  });

  it('takes 1 to 500 items', async () => {
    const o = await ownOffer();
    expect((await asSeller(h, o.sellerId, 'POST', '/costs', { items: [] })).statusCode).toBe(400);
    const many = Array.from({ length: 501 }, () => ({ offerId: o.offerId, unitCost: usd(1) }));
    expect((await asSeller(h, o.sellerId, 'POST', '/costs', { items: many })).statusCode).toBe(400);
    expect(costEvents(o.offerId)).toEqual([]);
  });
});

describe('bulk file unit_cost column', () => {
  const upload = (sellerId: string, text: string) => {
    const id = newId();
    h.files.set(id, { name: 'costs.csv', owner: { kind: 'seller', id: sellerId } as never, text });
    return id;
  };

  it('the template lists the cost in force; the file previews, needs the permission and saves costs from today', async () => {
    const a = await ownOffer();
    const b = await ownOffer(a.sellerId);
    const c = await ownOffer(a.sellerId);
    const d = await ownOffer(a.sellerId);
    await setCost(a.sellerId, a.offerId, { unitCost: usd(1250), effectiveFrom: day(-5) });
    await setCost(a.sellerId, b.offerId, { unitCost: usd(700) });

    const template = await asSeller(h, a.sellerId, 'GET', '/bulk-updates/template');
    expect(template.statusCode, template.body).toBe(200);
    const lines = [...h.files.values()].find((f) => f.name === template.json().fileName)!.text.trim().split(/\r?\n/);
    expect(lines[0]).toBe('seller_sku,price,quantity,unit_cost');
    expect(lines).toContain(`${a.sku},189.00,10,12.50`);
    expect(lines).toContain(`${c.sku},189.00,10,`);

    const csv = ['seller_sku,unit_cost', `${a.sku},13.00`, `${b.sku},7.00`, `${c.sku},-1`, `${d.sku},abc`, `${c.sku}`].join('\n') + '\n';
    const created = await asSeller(h, a.sellerId, 'POST', '/bulk-updates', { fileId: upload(a.sellerId, csv) });
    expect(created.statusCode, created.body).toBe(202);
    const job = created.json();
    expect(job.totals).toMatchObject({ rows: 5, ready: 1, unchanged: 1, errors: 3, costChanges: 1, priceChanges: 0, stockChanges: 0 });
    const rows = (await asSeller(h, a.sellerId, 'GET', `/bulk-updates/${job.id}/rows?limit=10`)).json().items;
    expect(rows.map((r: { row: number; result: string; error?: { code: string } | null }) => [r.row, r.result, r.error?.code ?? null])).toEqual([
      [2, 'ready', null],
      [3, 'unchanged', null],
      [4, 'error', 'unit_cost_invalid'],
      [5, 'error', 'not_a_number'],
      [6, 'error', 'duplicate_row'],
    ]);
    expect(rows[0]).toMatchObject({ offerId: a.offerId, unitCostFrom: usd(1250), unitCostTo: usd(1300), priceTo: null, quantityTo: null });
    expect(rows[1]).toMatchObject({ result: 'unchanged', unitCostFrom: usd(700), unitCostTo: usd(700) });

    // a member who may update files but not costs cannot apply a file that changes costs
    const member = sellerHeaders({ sellerId: a.sellerId, permissions: ['offers.bulk.update', 'offers.prices.manage'] });
    const refused = await call(h, 'POST', `/api/seller/offers/bulk-updates/${job.id}/apply`, member, {});
    expect(refused.statusCode, refused.body).toBe(403);
    expect(costEvents(a.offerId)).toHaveLength(1);

    const applied = await asSeller(h, a.sellerId, 'POST', `/bulk-updates/${job.id}/apply`, {});
    expect(applied.statusCode, applied.body).toBe(202);
    expect(applied.json()).toMatchObject({ state: 'applied', totals: { applied: 1, skipped: 3 } });
    expect(costEvents(a.offerId)).toEqual([expect.objectContaining({ unitCost: usd(1250) }), expect.objectContaining({ unitCost: usd(1300), effectiveFrom: day() })]);
    expect(costEvents(b.offerId)).toHaveLength(1);
    const history = (await asSeller(h, a.sellerId, 'GET', `/offers/${a.offerId}/costs`)).json().items;
    expect(history[0]).toMatchObject({ unitCost: usd(1300), effectiveFrom: day(), setBy: { name: 'Avery Stone' } });
    expect(await h.api.unitCostsAt([{ offerId: a.offerId, at: at() }, { offerId: a.offerId, at: at(-1) }])).toEqual([usd(1300), usd(1250)]);
  });

  it('a file of prices only still applies for a member without the cost permission', async () => {
    const a = await ownOffer();
    const job = (await asSeller(h, a.sellerId, 'POST', '/bulk-updates', { fileId: upload(a.sellerId, `seller_sku,price,quantity,unit_cost\n${a.sku},185.00,10,\n`) })).json();
    expect(job.totals).toMatchObject({ ready: 1, costChanges: 0, priceChanges: 1 });
    const member = sellerHeaders({ sellerId: a.sellerId, permissions: ['offers.bulk.update', 'offers.prices.manage'] });
    const applied = await call(h, 'POST', `/api/seller/offers/bulk-updates/${job.id}/apply`, member, {});
    expect(applied.statusCode, applied.body).toBe(202);
    expect(costEvents(a.offerId)).toEqual([]);
  });
});
