/**
 * Feeds an engine that keeps its own index (OpenSearch) from the read model: wraps the repository so every
 * write to a document or its offer rows is passed on to the engine once it is committed. The indexer keeps
 * writing to the repository only; nothing in the service knows about the engine's index.
 *
 * - Writes inside repo.transaction() are collected and passed on after the commit (never for a rolled-back one).
 * - What is passed on is read back from the repository after the commit, so the engine gets the committed state.
 * - A rebuilt document (upsertDocument) carries its searchable texts and replaces the engine's document; any other
 *   change replaces every field but the texts (the read model does not keep them).
 * - Products the engine could not take (unreachable, rejected after retries, a partial update of a document the
 *   engine does not have) are marked dirty: search.process-dirty rebuilds them, which writes them again in full.
 */
import type { FastifyBaseLogger } from 'fastify';
import type { DocTexts, IndexedDocument, SearchIndexFeed, SearchRepository } from './ports.js';

const BATCH = 500;

type Change = { op: 'delete' } | { op: 'upsert'; texts?: DocTexts };

class Pending {
  readonly changes = new Map<string, Change>();
  /** sumSales / rankBestSellers touched every document */
  all = false;

  upsert(productId: string, texts?: DocTexts) {
    const before = this.changes.get(productId);
    // a full write stays full when the same transaction patches the document afterwards
    const keep = !texts && before?.op === 'upsert' ? before.texts : undefined;
    this.changes.set(productId, { op: 'upsert', ...((texts ?? keep) ? { texts: texts ?? keep } : {}) });
  }
  remove(productId: string) {
    this.changes.set(productId, { op: 'delete' });
  }
}

export interface IndexFeedOptions {
  log: FastifyBaseLogger;
  now: () => Date;
}

export function withIndexFeed(base: SearchRepository, feed: SearchIndexFeed, opts: IndexFeedOptions): SearchRepository {
  /** Reads the committed state of the products and passes it on; failures are queued for process-dirty */
  async function flush(p: Pending): Promise<void> {
    if (p.all) await syncAll();
    if (!p.changes.size) return;
    const deletes: string[] = [];
    const upserts = new Map<string, DocTexts | undefined>();
    for (const [id, c] of p.changes) {
      if (c.op === 'delete') deletes.push(id);
      else upserts.set(id, c.texts);
    }
    await send([...upserts.keys()], upserts, deletes);
  }

  async function send(ids: string[], texts: Map<string, DocTexts | undefined>, deletes: string[]): Promise<void> {
    const all = [...ids, ...deletes];
    try {
      const [docs, offers] = await Promise.all([base.getDocuments(ids), base.offerRows(ids)]);
      const byProduct = new Map<string, IndexedDocument['offers']>();
      for (const o of offers) byProduct.set(o.product_id, [...(byProduct.get(o.product_id) ?? []), o]);
      const found = new Set(docs.map((d) => d.product_id));
      const upserts: IndexedDocument[] = docs.map((doc) => {
        const t = texts.get(doc.product_id);
        return { doc, offers: byProduct.get(doc.product_id) ?? [], ...(t ? { texts: t } : {}) };
      });
      // a document gone from the read model by now is gone from the engine too
      const removed = [...deletes, ...ids.filter((id) => !found.has(id))];
      const { failed } = await feed.write(upserts, removed);
      if (failed.length) await requeue(failed, 'the search engine did not take the documents');
    } catch (err) {
      opts.log.warn({ err, products: all.length }, 'search: the search engine could not be updated; products queued for process-dirty');
      await requeue(all, 'the search engine is unreachable');
    }
  }

  async function requeue(ids: string[], why: string) {
    if (!ids.length) return;
    opts.log.warn({ products: ids.slice(0, 20), count: ids.length }, `search: ${why}; queued for process-dirty`);
    try {
      await base.markDirty(ids, 'search_engine_sync', opts.now());
    } catch (err) {
      opts.log.error({ err }, 'search: could not queue products for the search engine');
    }
  }

  /** Every document's fields (nightly sales counts and best-seller ranks change them all) */
  async function syncAll(): Promise<void> {
    const ids = await base.documentIds({});
    for (let i = 0; i < ids.length; i += BATCH) await send(ids.slice(i, i + BATCH), new Map(), []);
  }

  const wrap = (repo: SearchRepository, pending: Pending | null): SearchRepository => {
    /** Runs a write; outside a transaction its changes are passed on right away */
    const write = async <T>(fn: () => Promise<T>, record: (p: Pending) => void | Promise<void>): Promise<T> => {
      if (pending) {
        const out = await fn();
        await record(pending);
        return out;
      }
      const p = new Pending();
      const out = await fn();
      await record(p);
      await flush(p);
      return out;
    };
    const productOfOffer = async (offerId: string) => (await repo.offerRow(offerId))?.product_id;

    return {
      ...repo,
      transaction: (fn) => {
        if (pending) return repo.transaction((tx) => fn(wrap(tx, pending)));
        const p = new Pending();
        return repo.transaction((tx) => fn(wrap(tx, p))).then(async (out) => {
          await flush(p);
          return out;
        });
      },
      upsertDocument: (doc, offers, at) => write(() => repo.upsertDocument(doc, offers, at), (p) => p.upsert(doc.product_id, doc.texts)),
      deleteDocument: (id) => write(() => repo.deleteDocument(id), (p) => p.remove(id)),
      updateDocument: (id, patch, at) => write(() => repo.updateDocument(id, patch, at), (p) => p.upsert(id)),
      upsertOfferRow: (row) => write(() => repo.upsertOfferRow(row), (p) => p.upsert(row.product_id)),
      updateOfferRow: async (offerId, patch) => {
        const productId = await productOfOffer(offerId);
        return write(() => repo.updateOfferRow(offerId, patch), (p) => (productId ? p.upsert(productId) : undefined));
      },
      deleteOfferRow: async (offerId) => {
        const productId = await productOfOffer(offerId);
        return write(() => repo.deleteOfferRow(offerId), (p) => (productId ? p.upsert(productId) : undefined));
      },
      recordSales: (day, units, sign, at) => write(() => repo.recordSales(day, units, sign, at), (p) => units.forEach((u) => p.upsert(u.productId))),
      sumSales: (from) =>
        write(
          () => repo.sumSales(from),
          (p) => {
            p.all = true;
          },
        ),
      rankBestSellers: (top, enabled) =>
        write(
          () => repo.rankBestSellers(top, enabled),
          (p) => {
            p.all = true;
          },
        ),
    };
  };

  return wrap(base, null);
}
