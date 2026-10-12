/** Back office: synonyms, reindex jobs, index status, zero-result queries, explain, quick lookups; logs pruning. */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { ADMIN, boot, callers, newId, SELLER, shop, STORE, type Kit } from './helpers.js';

let k: Kit;
let s: Awaited<ReturnType<typeof shop>>;
beforeAll(async () => {
  k = await boot();
  s = await shop(k);
});
afterAll(async () => {
  await k?.close();
});

describe('synonyms', () => {
  it('create, list, edit, deactivate and delete, with events', async () => {
    k.events.length = 0;
    const created = await k.call('POST', `${ADMIN}/synonyms`, k.staff, { terms: [' TV ', 'television', 'tv'], kind: 'equivalent', note: 'Common' });
    expect(created.status).toBe(201);
    expect(created.body).toMatchObject({ terms: ['tv', 'television'], kind: 'equivalent', from: null, active: true, note: 'Common', updatedBy: { kind: 'staff' } });
    const id = created.body.id;
    const list = await k.call('GET', `${ADMIN}/synonyms?q=telev`, k.staff);
    expect(list.body.items.map((x: any) => x.id)).toEqual([id]);
    expect((await k.call('GET', `${ADMIN}/synonyms?active=false`, k.staff)).body.items).toEqual([]);
    const edited = await k.call('PATCH', `${ADMIN}/synonyms/${id}`, k.staff, { terms: ['tv', 'television', 'telly'], kind: 'equivalent', active: false });
    expect(edited.body).toMatchObject({ terms: ['tv', 'television', 'telly'], active: false, note: 'Common' });
    expect((await k.call('DELETE', `${ADMIN}/synonyms/${id}`, k.staff)).status).toBe(204);
    expect((await k.call('DELETE', `${ADMIN}/synonyms/${id}`, k.staff)).status).toBe(404);
    expect((await k.call('PATCH', `${ADMIN}/synonyms/${newId()}`, k.staff, { terms: ['a', 'b'], kind: 'equivalent' })).status).toBe(404);
    expect(k.of('search.synonym.changed')).toEqual([
      { synonymId: id, action: 'created' },
      { synonymId: id, action: 'updated' },
      { synonymId: id, action: 'deleted' },
    ]);
  });

  it('a term in another active equivalent set conflicts; inactive sets do not', async () => {
    const a = await k.call('POST', `${ADMIN}/synonyms`, k.staff, { terms: ['sofa', 'couch'], kind: 'equivalent' });
    const clash = await k.call('POST', `${ADMIN}/synonyms`, k.staff, { terms: ['Couch', 'settee'], kind: 'equivalent' });
    expect(clash.status).toBe(409);
    expect(clash.body.error).toMatchObject({ code: 'SYNONYM_CONFLICT', details: { synonymId: a.body.id } });
    expect((await k.call('POST', `${ADMIN}/synonyms`, k.staff, { terms: ['couch', 'settee'], kind: 'equivalent', active: false })).status).toBe(201);
    // one-way sets may share terms
    expect((await k.call('POST', `${ADMIN}/synonyms`, k.staff, { terms: ['couch'], kind: 'one_way', from: 'loveseat' })).status).toBe(201);
  });

  it('validates the set', async () => {
    const one = await k.call('POST', `${ADMIN}/synonyms`, k.staff, { terms: ['only'], kind: 'equivalent' });
    expect(one.body.error).toMatchObject({ code: 'VALIDATION_FAILED', details: { issues: [{ path: 'terms' }] } });
    const noFrom = await k.call('POST', `${ADMIN}/synonyms`, k.staff, { terms: ['a'], kind: 'one_way' });
    expect(noFrom.body.error.details.issues[0].path).toBe('from');
    const self = await k.call('POST', `${ADMIN}/synonyms`, k.staff, { terms: ['x'], kind: 'one_way', from: 'X' });
    expect(self.status).toBe(400);
  });

  it('needs search.synonyms.manage', async () => {
    const r = await k.call('GET', `${ADMIN}/synonyms`, callers.staff(['search.index.manage']));
    expect(r.status).toBe(403);
  });
});

describe('reindex jobs and index status', () => {
  it('a full reindex: queued, one at a time, run by process-dirty, then completed with an event', async () => {
    k.events.length = 0;
    const started = await k.call('POST', `${ADMIN}/reindex-jobs`, k.staff, { scope: 'all', reason: 'Category tree changed' });
    expect(started.status).toBe(202);
    expect(started.body).toMatchObject({ scope: 'all', ids: [], state: 'queued', total: 0, processed: 0, reason: 'Category tree changed', requestedBy: { kind: 'staff' } });
    const again = await k.call('POST', `${ADMIN}/reindex-jobs`, k.staff, { scope: 'all', reason: 'Again' });
    expect(again.status).toBe(409);
    expect(again.body.error).toMatchObject({ code: 'REINDEX_ALREADY_RUNNING', details: { jobId: started.body.id } });
    const status = (await k.call('GET', `${ADMIN}/index`, k.staff)).body;
    expect(status.engine).toMatch(k.engine === 'mongo' ? /^mongo-text$/ : /^opensearch \((green|yellow), index [\w-]+-products-\d{17}\)$/);
    expect(status).toMatchObject({ documents: 4, offerRows: 6, runningJob: { id: started.body.id, state: 'queued' } });
    await k.job('search.process-dirty');
    const done = (await k.call('GET', `${ADMIN}/reindex-jobs/${started.body.id}`, k.staff)).body;
    expect(done).toMatchObject({ state: 'completed', total: 4, processed: 4 });
    expect(done.startedAt).toBeTruthy();
    expect(done.finishedAt).toBeTruthy();
    expect(k.of('search.index.rebuilt')).toEqual([{ jobId: started.body.id, scope: 'all', documents: 4 }]);
    const after = (await k.call('GET', `${ADMIN}/index`, k.staff)).body;
    expect(after).toMatchObject({ runningJob: null, staleDocuments: 0, lagSeconds: 0, lastFullReindexAt: done.finishedAt });
    expect((await k.call('GET', `${ADMIN}/reindex-jobs/${newId()}`, k.staff)).status).toBe(404);
  });

  it('scoped jobs only mark documents dirty', async () => {
    const r = await k.call('POST', `${ADMIN}/reindex-jobs`, k.staff, { scope: 'brand', ids: [s.halcyon.id], reason: 'Brand renamed' });
    expect(r.status).toBe(202);
    expect(r.body).toMatchObject({ scope: 'brand', ids: [s.halcyon.id], state: 'completed', total: 2, processed: 2 });
    expect((await k.call('GET', `${ADMIN}/index`, k.staff)).body.staleDocuments).toBe(2);
    await k.job('search.process-dirty');
    expect((await k.call('GET', `${ADMIN}/index`, k.staff)).body.staleDocuments).toBe(0);
    const seller = await k.call('POST', `${ADMIN}/reindex-jobs`, k.staff, { scope: 'seller', ids: [s.casa.id], reason: 'x' });
    expect(seller.body.total).toBe(3);
    const missing = await k.call('POST', `${ADMIN}/reindex-jobs`, k.staff, { scope: 'category', reason: 'x' });
    expect(missing.body.error).toMatchObject({ code: 'VALIDATION_FAILED', details: { issues: [{ path: 'ids' }] } });
    const noReason = await k.call('POST', `${ADMIN}/reindex-jobs`, k.staff, { scope: 'products', ids: [s.lamp.id], reason: ' ' });
    expect(noReason.status).toBe(400);
  });
});

describe('analytics', () => {
  it('zero-result queries, most frequent first, with the last filters and whether a correction was offered', async () => {
    for (let i = 0; i < 3; i++) await k.call('GET', `${STORE}/facets?q=hoverboard`);
    await k.call('GET', `${STORE}/facets?q=zeppelin&brand=halcyon`);
    await k.call('GET', `${STORE}/facets?q=speaker`);
    const day = (d: number) => new Date(Date.now() + d * 86_400_000).toISOString().slice(0, 10);
    const r = await k.call('GET', `${ADMIN}/zero-result-queries?from=${day(-1)}&to=${day(1)}`, k.staff);
    expect(r.status).toBe(200);
    expect(r.body.items.slice(0, 2)).toEqual([
      expect.objectContaining({ query: 'hoverboard', normalized: 'hoverboard', count: 3, lastFilters: null, correctionOffered: false }),
      expect.objectContaining({ query: 'zeppelin', count: 1, lastFilters: 'brand=halcyon' }),
    ]);
    expect(r.body.items.map((x: any) => x.normalized)).not.toContain('speaker');
    const old = await k.call('GET', `${ADMIN}/zero-result-queries?from=2020-01-01&to=2020-01-31`, k.staff);
    expect(old.body.items).toEqual([]);
  });

  it('explain: scores and factors per result', async () => {
    await k.call('POST', `${ADMIN}/synonyms`, k.staff, { terms: ['cans', 'headphones'], kind: 'equivalent' });
    const r = await k.call('GET', `${ADMIN}/explain?q=cans`, k.staff);
    expect(r.status).toBe(200);
    expect(r.body[0]).toMatchObject({ productId: s.wireless.id, position: 1, matchedTerms: ['headphones'], synonymsUsed: ['headphones'], correctedFrom: null });
    expect(r.body[0].score).toBeGreaterThan(r.body[1].score);
    expect(Object.keys(r.body[0].factors)).toEqual(expect.arrayContaining(['text_relevance', 'in_stock', 'featured_offer', 'delivery_speed', 'rating', 'conversion']));
    const typo = (await k.call('GET', `${ADMIN}/explain?q=bookshelf+speakr&limit=1`, k.staff)).body;
    expect(typo).toEqual([expect.objectContaining({ productId: s.speaker.id, correctedFrom: 'bookshelf speakr' })]);
  });
});

describe('quick lookups', () => {
  it('admin lookup: only groups the caller may see and whose module answers', async () => {
    const all = await k.call('GET', `${ADMIN}/lookup?q=MK-2610`, k.staff);
    expect(all.status).toBe(200);
    expect(all.body.groups.map((g: any) => g.kind)).toEqual(['orders']);
    expect(all.body.groups[0].items[0]).toMatchObject({ kind: 'order', ref: 'MK-261009-00001', title: 'MK-261009-00001 · Ana Ruiz', screen: 'admin/order' });
    const products = await k.call('GET', `${ADMIN}/lookup?q=halcyon`, k.staff);
    expect(products.body.groups.find((g: any) => g.kind === 'products').items.map((i: any) => i.id).sort()).toEqual([s.earphones.id, s.speaker.id].sort());
    const byGtin = (await k.call('GET', `${ADMIN}/lookup?q=${s.wireless.variants[0]!.gtin}`, k.staff)).body;
    expect(byGtin.groups.find((g: any) => g.kind === 'products').items[0].id).toBe(s.wireless.id);
    const customers = await k.call('GET', `${ADMIN}/lookup?q=ana`, callers.staff(['customers.accounts.view']));
    expect(customers.body.groups.map((g: any) => g.kind)).toEqual(['customers']);
    expect(customers.body.groups[0].items[0]).toMatchObject({ kind: 'customer', title: 'Ana Ruiz', subtitle: 'a***@example.com', screen: 'admin/customer' });
    const contact = await k.call('GET', `${ADMIN}/lookup?q=ana`, callers.staff(['customers.accounts.view', 'orders.customers.view-contact']));
    expect(contact.body.groups[0].items[0].subtitle).toBe('ana@example.com');
    const sellers = await k.call('GET', `${ADMIN}/lookup?q=casa`, callers.staff(['orders.orders.view']));
    expect(sellers.body.groups.map((g: any) => g.kind)).not.toContain('sellers');
    const short = await k.call('GET', `${ADMIN}/lookup?q=a`, k.staff);
    expect(short.body.error.code).toBe('VALIDATION_FAILED');
  });

  it('seller quick search: own orders, offers and returns, by role', async () => {
    const owner = callers.seller({ sellerId: s.grove.id });
    const r = await k.call('GET', `${SELLER}/quick?q=aurora`, owner);
    expect(r.status).toBe(200);
    expect(r.body.groups).toEqual([{ kind: 'offers', label: 'Offers and SKUs', more: false, items: [expect.objectContaining({ kind: 'offer', id: s.groveOffer.id, title: 'Aurora wireless headphones', screen: 'seller/offer' })] }]);
    const orders = await k.call('GET', `${SELLER}/quick?q=MK-2610`, owner);
    expect(orders.body.groups.map((g: any) => g.kind)).toEqual(['orders']);
    const staffLike = callers.seller({ sellerId: s.grove.id, permissions: ['offers.offers.manage'] });
    expect((await k.call('GET', `${SELLER}/quick?q=MK-2610`, staffLike)).body.groups).toEqual([]);
  });
});

describe('logs pruning', () => {
  it('deletes recent searches past retention and logs older than 13 months', async () => {
    const guest = callers.visitor();
    await k.call('GET', `${STORE}/facets?q=speaker`, guest);
    expect((await k.call('GET', `${STORE}/recent-searches`, guest)).body).toHaveLength(1);
    k.clock.advance(91 * 86_400_000);
    try {
      await k.job('search.prune-logs');
    } finally {
      k.clock.advance(-91 * 86_400_000);
    }
    expect((await k.call('GET', `${STORE}/recent-searches`, guest)).body).toEqual([]);
  });
});
