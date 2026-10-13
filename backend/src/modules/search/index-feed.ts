/**
 * Feeds an engine that keeps its own index (OpenSearch) from the read model: a SearchRepository whose every
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
import type { ModuleStore } from '../../kernel/mongo/index.js';
import type { DocTexts, DocWrite, IndexedDocument, OfferRow, SearchIndexFeed } from './ports.js';
import { SearchRepository } from './repository.js';

const BATCH = 500;

type Change = { op: 'delete' } | { op: 'upsert'; texts?: DocTexts };

/** The products a write (or a transaction's writes) changed, until they are passed on */
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

/** Passes committed changes on to the engine, reading them back through a repository outside any transaction */
class IndexSync {
  constructor(
    private readonly base: SearchRepository,
    private readonly feed: SearchIndexFeed,
    private readonly opts: IndexFeedOptions,
  ) {}

  /** Reads the committed state of the products and passes it on; failures are queued for process-dirty */
  async flush(p: Pending): Promise<void> {
    if (p.all) await this.#syncAll();
    if (!p.changes.size) return;
    const deletes: string[] = [];
    const upserts = new Map<string, DocTexts | undefined>();
    for (const [id, c] of p.changes) {
      if (c.op === 'delete') deletes.push(id);
      else upserts.set(id, c.texts);
    }
    await this.#send([...upserts.keys()], upserts, deletes);
  }

  async #send(ids: string[], texts: Map<string, DocTexts | undefined>, deletes: string[]): Promise<void> {
    const all = [...ids, ...deletes];
    try {
      const [docs, offers] = await Promise.all([this.base.getDocuments(ids), this.base.offerRows(ids)]);
      const byProduct = new Map<string, IndexedDocument['offers']>();
      for (const o of offers) byProduct.set(o.product_id, [...(byProduct.get(o.product_id) ?? []), o]);
      const found = new Set(docs.map((d) => d.product_id));
      const upserts: IndexedDocument[] = docs.map((doc) => {
        const t = texts.get(doc.product_id);
        return { doc, offers: byProduct.get(doc.product_id) ?? [], ...(t ? { texts: t } : {}) };
      });
      // a document gone from the read model by now is gone from the engine too
      const removed = [...deletes, ...ids.filter((id) => !found.has(id))];
      const { failed } = await this.feed.write(upserts, removed);
      if (failed.length) await this.#requeue(failed, 'the search engine did not take the documents');
    } catch (err) {
      this.opts.log.warn({ err, products: all.length }, 'search: the search engine could not be updated; products queued for process-dirty');
      await this.#requeue(all, 'the search engine is unreachable');
    }
  }

  async #requeue(ids: string[], why: string) {
    if (!ids.length) return;
    this.opts.log.warn({ products: ids.slice(0, 20), count: ids.length }, `search: ${why}; queued for process-dirty`);
    try {
      await this.base.markDirty(ids, 'search_engine_sync', this.opts.now());
    } catch (err) {
      this.opts.log.error({ err }, 'search: could not queue products for the search engine');
    }
  }

  /** Every document's fields (nightly sales counts and best-seller ranks change them all) */
  async #syncAll(): Promise<void> {
    const ids = await this.base.documentIds({});
    for (let i = 0; i < ids.length; i += BATCH) await this.#send(ids.slice(i, i + BATCH), new Map(), []);
  }
}

/**
 * The repository with OpenSearch: the same reads and writes, and the document writes passed on to the engine.
 * Inside a transaction the changes are collected in `pending` and passed on by the outermost transaction() after
 * the commit; outside one, each write passes its changes on right away.
 */
class IndexFedSearchRepository extends SearchRepository {
  readonly #sync: IndexSync;
  readonly #pending: Pending | null;

  constructor(store: ModuleStore, sync: IndexSync, pending: Pending | null) {
    super(store);
    this.#sync = sync;
    this.#pending = pending;
  }

  override transaction<T>(fn: (tx: SearchRepository) => Promise<T>): Promise<T> {
    const pending = this.#pending;
    if (pending) return this.store.transaction((tx) => fn(new IndexFedSearchRepository(tx, this.#sync, pending)));
    const p = new Pending();
    return this.store.transaction((tx) => fn(new IndexFedSearchRepository(tx, this.#sync, p))).then(async (out) => {
      await this.#sync.flush(p);
      return out;
    });
  }

  /** Runs a write and records what it changed; outside a transaction the change is passed on right away */
  async #write<T>(fn: () => Promise<T>, record: (p: Pending) => void): Promise<T> {
    if (this.#pending) {
      const out = await fn();
      record(this.#pending);
      return out;
    }
    const p = new Pending();
    const out = await fn();
    record(p);
    await this.#sync.flush(p);
    return out;
  }

  async #productOfOffer(offerId: string): Promise<string | undefined> {
    return (await this.offerRow(offerId))?.product_id;
  }

  override upsertDocument(doc: DocWrite, offers: OfferRow[] | null, at: Date): Promise<void> {
    return this.#write(() => super.upsertDocument(doc, offers, at), (p) => p.upsert(doc.product_id, doc.texts));
  }

  override deleteDocument(productId: string): Promise<void> {
    return this.#write(() => super.deleteDocument(productId), (p) => p.remove(productId));
  }

  override updateDocument(productId: string, patch: Parameters<SearchRepository['updateDocument']>[1], at: Date): Promise<void> {
    return this.#write(() => super.updateDocument(productId, patch, at), (p) => p.upsert(productId));
  }

  override upsertOfferRow(row: OfferRow): Promise<void> {
    return this.#write(() => super.upsertOfferRow(row), (p) => p.upsert(row.product_id));
  }

  override async updateOfferRow(offerId: string, patch: Parameters<SearchRepository['updateOfferRow']>[1]): Promise<void> {
    const productId = await this.#productOfOffer(offerId);
    return this.#write(() => super.updateOfferRow(offerId, patch), (p) => (productId ? p.upsert(productId) : undefined));
  }

  override async deleteOfferRow(offerId: string): Promise<void> {
    const productId = await this.#productOfOffer(offerId);
    return this.#write(() => super.deleteOfferRow(offerId), (p) => (productId ? p.upsert(productId) : undefined));
  }

  override recordSales(day: string, units: { productId: string; units: number }[], sign: 1 | -1, at: Date): Promise<void> {
    return this.#write(() => super.recordSales(day, units, sign, at), (p) => units.forEach((u) => p.upsert(u.productId)));
  }

  override sumSales(from: string): Promise<void> {
    return this.#write(() => super.sumSales(from), (p) => (p.all = true));
  }

  override rankBestSellers(top: number, enabled: boolean): Promise<void> {
    return this.#write(() => super.rankBestSellers(top, enabled), (p) => (p.all = true));
  }
}

/** The search repository on `store`, feeding the engine's index (the repository outside any transaction reads back what was committed) */
export function withIndexFeed(store: ModuleStore, feed: SearchIndexFeed, opts: IndexFeedOptions): SearchRepository {
  return new IndexFedSearchRepository(store, new IndexSync(new SearchRepository(store), feed, opts), null);
}