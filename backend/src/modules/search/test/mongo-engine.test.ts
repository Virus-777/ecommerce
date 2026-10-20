/**
 * The MongoDB engine's reads that were reshaped for speed (optimization pass 2026-10-16): best-selling availability
 * from the top sellers only, product suggestions ranked on a projection, and brand lookups from documents. Since
 * docs/07-search-speed-plan.md: product suggestions ranked in the database, with the similarity fallback only when
 * prefix matches don't fill the list.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { newId } from '../../../kernel/lib/ids.js';
import { escapeRegExp } from '../../../kernel/lib/text.js';
import { spec } from '../../../spec/search.js';
import { createMongoSearchEngine, wordSimilarity } from '../mongo-engine.js';
import type { DocRow, DocWrite } from '../ports.js';
import { SearchRepository } from '../repository.js';
import { schemas } from '../schema.js';
import { createMongoTermLookup } from '../terms.js';
import { stems } from '../text.js';
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

describe('suggestProducts against the earlier ranking', () => {
  it('gives the earlier answer when prefix matches do not fill the list, and the best prefix matches when they do', async () => {
    const docs = store().table<DocRow>('search_documents');
    const { terms: _t, version: _v, indexed_at: _i, offers: _o, ...rest } = (await docs.find())[0]!;
    const words = ['wireless', 'wired', 'wirecutter', 'speaker', 'spectra', 'bluetooth', 'blue', 'lamp', 'lantern', 'rewired'];
    let s = 11;
    const rnd = () => (s = (s * 1103515245 + 12345) % 2 ** 31) / 2 ** 31;
    const pick = <T>(a: readonly T[]) => a[Math.floor(rnd() * a.length)]!;
    for (let i = 0; i < 80; i++) {
      const title = `${pick(words)} ${pick(words)} model ${i}`;
      const write = { ...rest, product_id: newId(), slug: `sg-${i}`, title, title_norm: title, offer_count: 1, in_stock: rnd() > 0.3, popularity: String(Math.floor(rnd() * 5)), rating_count: Math.floor(rnd() * 3), texts: { title, brand: '', category: '', attributes: '', description: '' } } as unknown as DocWrite;
      await new SearchRepository(store()).upsertDocument(write, [], new Date());
    }
    const threshold = 0.3;
    const limit = 5;
    // the earlier algorithm: every candidate read into the server, filtered and ranked there
    const earlier = async (prefix: string) => {
      const p = prefix.toLowerCase();
      const ps = stems(prefix).slice(0, 8);
      const first = p.charAt(0);
      const or = [...(ps.length ? [{ $and: ps.map((st) => ({ 'terms.t': { $regex: `^${escapeRegExp(st)}` } })) }] : []), { title_norm: { $regex: `(^| )${escapeRegExp(first)}` } }];
      const found = await docs.aggregate<any>([{ $match: { offer_count: { $gt: 0 }, $or: or } }, { $project: { title: 1, title_norm: 1, in_stock: 1, popularity: 1, rating_count: 1, 'terms.t': 1 } }]);
      const starts = (d: any) => ps.length > 0 && ps.every((st) => ((d.terms ?? []) as { t: string }[]).some((x) => x.t.startsWith(st)));
      const rank = (a: any, b: any) =>
        Number(b.title_norm.includes(p)) - Number(a.title_norm.includes(p)) || Number(b.in_stock) - Number(a.in_stock) || Number(b.popularity) - Number(a.popularity) || b.rating_count - a.rating_count || (a.title < b.title ? -1 : a.title > b.title ? 1 : 0) || (a._id < b._id ? -1 : 1);
      const prefixCount = found.filter(starts).length;
      const all = found.filter((d) => starts(d) || wordSimilarity(p, d.title_norm) >= threshold).sort(rank);
      const prefixOnly = found.filter(starts).sort(rank);
      return { prefixCount, all: all.slice(0, limit).map((d) => d._id), prefixOnly: prefixOnly.slice(0, limit).map((d) => d._id) };
    };
    let fallbacks = 0;
    let filled = 0;
    for (const prefix of ['wir', 'wirel', 'wireless', 'spe', 'spectr', 'blu', 'lan', 'wirless', 'specter', 'rew', 'wireless spe', 'bluetoth']) {
      const got = (await engine().suggestProducts(prefix, threshold, limit)).map((d) => d.product_id);
      const e = await earlier(prefix);
      if (e.prefixCount < limit) {
        fallbacks++;
        expect(got, prefix).toEqual(e.all);
      } else {
        filled++;
        expect(got, prefix).toEqual(e.prefixOnly);
      }
    }
    expect(fallbacks).toBeGreaterThan(0);
    expect(filled).toBeGreaterThan(0);
  });
});
