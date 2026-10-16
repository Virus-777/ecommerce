/**
 * The MongoDB engine's reads that were reshaped for speed (optimization pass 2026-10-16): best-selling availability
 * from the top sellers only, product suggestions ranked on a projection, and brand lookups from documents.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { spec } from '../../../spec/search.js';
import { createMongoSearchEngine } from '../mongo-engine.js';
import { SearchRepository } from '../repository.js';
import { schemas } from '../schema.js';
import { createMongoTermLookup } from '../terms.js';
import { boot, shop, type Kit } from './helpers.js';

let k: Kit;
let s: Awaited<ReturnType<typeof shop>>;
const store = () => k.app.kernel.mongo.module('search', spec.collections, schemas);
const engine = () => createMongoSearchEngine(store(), createMongoTermLookup(store()));
const setSales = async (sales: Record<string, number>) => {
  const docs = store().table<{ product_id: string; sales_30d: number }>('search_documents');
  await docs.updateMany({}, { sales_30d: 0 });
  for (const [id, n] of Object.entries(sales)) await docs.update(id, { sales_30d: n });
};

beforeAll(async () => {
  k = await boot();
  s = await shop(k);
});
afterAll(async () => {
  await k?.close();
});

describe('bestSellingAvailable', () => {
  it('compares the total units of the last 30 days with the threshold, many small sellers or a few large ones', async () => {
    const ids = [s.earphones.id, s.wireless.id];
    await setSales({ [ids[0]!]: 3, [ids[1]!]: 1 });
    expect(await engine().bestSellingAvailable(4)).toBe(true);
    expect(await engine().bestSellingAvailable(5)).toBe(false);
    expect(await engine().bestSellingAvailable(0)).toBe(true);
    expect(await engine().bestSellingAvailable(Number.NaN)).toBe(false);
    // more products with sales than the threshold: the top ones already reach it
    const all = (await store().table<{ product_id: string }>('search_documents').find()).map((d) => d.product_id);
    expect(all.length).toBeGreaterThanOrEqual(3);
    await setSales(Object.fromEntries(all.map((id) => [id, 1])));
    expect(await engine().bestSellingAvailable(all.length)).toBe(true);
    expect(await engine().bestSellingAvailable(all.length - 1)).toBe(true);
    expect(await engine().bestSellingAvailable(all.length + 1)).toBe(false);
    await setSales({});
  });
});

describe('suggestProducts', () => {
  it('answers whole documents (without search terms) in rank order', async () => {
    const docs = await engine().suggestProducts('head', 0.3, 5);
    expect(docs.length).toBeGreaterThan(0);
    for (const d of docs) {
      expect(d.terms).toBeNull();
      expect(d.title).toBeTruthy();
      expect(d.offer_count).toBeGreaterThan(0);
    }
    // the same documents as a full read of each
    const full = await new SearchRepository(store()).getDocuments(docs.map((d) => d.product_id));
    for (const d of docs) expect(d.slug).toBe(full.find((f) => f.product_id === d.product_id)!.slug);
  });
});

describe('brandNamesOfDocuments', () => {
  it('names the brands that have documents and leaves out the others', async () => {
    const docs = await store().table<{ product_id: string; brand_id: string | null; brand_name: string | null }>('search_documents').find({ brand_id: { $ne: null } });
    const withDocs = [...new Set(docs.map((d) => d.brand_id!))];
    expect(withDocs.length).toBeGreaterThan(0);
    const unknown = '00000000-0000-4000-8000-000000000000';
    const names = await new SearchRepository(store()).brandNamesOfDocuments([...withDocs, unknown]);
    expect([...names.keys()].sort()).toEqual([...withDocs].sort());
    for (const id of withDocs) expect(names.get(id)).toBe(docs.filter((d) => d.brand_id === id).sort((a, b) => (a.product_id < b.product_id ? -1 : 1))[0]!.brand_name);
  });
});
