/**
 * The products index's lifecycle and writes.
 *
 * Names: queries and writes go through the alias <prefix>-products, which points at one versioned index
 * <prefix>-products-<UTC timestamp>. A full reindex (blue/green) builds a new versioned index; while it builds,
 * the alias <prefix>-products-building points at it and every server writes each change to both. When the
 * rebuild is done the live alias moves to the new index in one atomic _aliases call; the previous index is kept
 * for a manual rollback and older ones are deleted.
 *
 * Writes are bulk updates with a versioned script (scripts.ts VERSIONED_WRITE): a document only replaces an
 * older one, so concurrent servers cannot put an older state back. Rejected (429) and failed (5xx) items are
 * retried with backoff; what still fails is answered to the caller (queued for search.process-dirty).
 */
import type { FastifyBaseLogger } from 'fastify';
import type { OpenSearchConfig } from '../config.js';
import type { IndexedDocument } from '../../ports.js';
import { OpenSearchError, type OsApi } from './client.js';
import { fieldsOf, sourceOf } from './document.js';
import { MAPPING_VERSION, productIndexBody } from './mapping.js';
import { VERSIONED_WRITE } from './scripts.js';

type Target = 'live' | 'building';
interface Op {
  productId: string;
  target: Target;
  lines: object[];
  partial: boolean;
}

export interface ProductIndexOptions {
  cfg: OpenSearchConfig;
  log: FastifyBaseLogger;
  now?: () => Date;
  /** Waits between bulk attempts (tests pass a no-op) */
  sleep?: (ms: number) => Promise<void>;
}

const stamp = (d: Date) => d.toISOString().replace(/[-:TZ.]/g, '').slice(0, 17);

export class ProductIndex {
  readonly alias: string;
  readonly buildingAlias: string;
  private live: Promise<string> | null = null;
  private building: { name: string | null; at: number } | null = null;
  private mappingVersion: number | null = null;

  constructor(
    private readonly os: OsApi,
    private readonly o: ProductIndexOptions,
  ) {
    this.alias = `${o.cfg.indexPrefix}-products`;
    this.buildingAlias = `${o.cfg.indexPrefix}-products-building`;
  }

  private get now() {
    return this.o.now ?? (() => new Date());
  }
  private sleep(ms: number) {
    return this.o.sleep ? this.o.sleep(ms) : new Promise<void>((r) => setTimeout(r, ms));
  }

  /* ---------------------------------------------------------------- lifecycle */

  /** The live index behind the alias; creates the first one (with the alias) when there is none */
  ensure(): Promise<string> {
    this.live ??= this.ensureOnce().catch((err) => {
      this.live = null;
      throw err;
    });
    return this.live;
  }

  private async ensureOnce(): Promise<string> {
    const found = await this.aliasTarget(this.alias);
    if (found) {
      await this.checkMapping(found);
      return found;
    }
    const name = this.newName();
    const r = await this.os.request('PUT', `/${name}`, { ...productIndexBody(this.o.cfg), aliases: { [this.alias]: {} } }, { ignore: [400] });
    if (r.status === 400) {
      // another server created it first
      const again = await this.aliasTarget(this.alias);
      if (again) return again;
      throw new OpenSearchError(400, r.body, `Could not create the search index ${name}`);
    }
    this.mappingVersion = MAPPING_VERSION;
    this.o.log.info({ index: name, alias: this.alias }, 'search: created the OpenSearch products index');
    return name;
  }

  private async checkMapping(index: string) {
    const r = await this.os.request<Record<string, { mappings?: { _meta?: { mappingVersion?: number } } }>>('GET', `/${index}/_mapping`, undefined, { ignore: [404] });
    this.mappingVersion = Number(r.body?.[index]?.mappings?._meta?.mappingVersion ?? 0);
    if (this.mappingVersion < MAPPING_VERSION) {
      this.o.log.warn({ index, built: this.mappingVersion, current: MAPPING_VERSION }, 'search: the OpenSearch index was built with an older mapping; run a full reindex (search.full-reindex)');
    }
  }

  private newName() {
    return `${this.alias}-${stamp(this.now())}`;
  }

  async aliasTarget(alias: string): Promise<string | null> {
    const r = await this.os.request<Record<string, unknown>>('GET', `/_alias/${alias}`, undefined, { ignore: [404] });
    if (r.status === 404) return null;
    return Object.keys(r.body ?? {}).sort().at(-1) ?? null;
  }

  /** The index a running full reindex builds (cached for OPENSEARCH_ALIAS_CACHE_MS) */
  private async buildingIndex(): Promise<string | null> {
    const ttl = this.o.cfg.aliasCacheMs;
    if (this.building && Date.now() - this.building.at < ttl) return this.building.name;
    const name = await this.aliasTarget(this.buildingAlias);
    this.building = { name, at: Date.now() };
    return name;
  }

  async beginRebuild(): Promise<void> {
    await this.ensure();
    // a reindex that died half-way leaves its index behind: drop it
    const stale = await this.aliasTarget(this.buildingAlias);
    if (stale) await this.os.request('DELETE', `/${stale}`, undefined, { ignore: [404] });
    const name = this.newName();
    await this.os.request('PUT', `/${name}`, { ...productIndexBody(this.o.cfg), aliases: { [this.buildingAlias]: {} } });
    this.building = { name, at: Date.now() };
    this.o.log.info({ index: name }, 'search: full reindex into a new OpenSearch index');
    // every server must know about the new index before any product is rebuilt into it
    const ttl = this.o.cfg.aliasCacheMs;
    if (ttl > 0) await this.sleep(ttl + 1000);
  }

  async finishRebuild(ok: boolean, carryOver: string[]): Promise<void> {
    const name = await this.aliasTarget(this.buildingAlias);
    if (!name) return;
    if (!ok) {
      await this.os.request('DELETE', `/${name}`, undefined, { ignore: [404] });
      this.building = null;
      this.o.log.warn({ index: name }, 'search: full reindex failed; the new OpenSearch index was dropped and the live one keeps serving');
      return;
    }
    const old = await this.aliasTarget(this.alias);
    if (old && carryOver.length) await this.copy(old, name, carryOver);
    await this.os.request('POST', `/${name}/_refresh`);
    await this.os.request('POST', '/_aliases', {
      actions: [...(old ? [{ remove: { index: old, alias: this.alias } }] : []), { add: { index: name, alias: this.alias } }, { remove: { index: name, alias: this.buildingAlias } }],
    });
    this.building = null;
    this.live = Promise.resolve(name);
    this.mappingVersion = MAPPING_VERSION;
    this.o.log.info({ index: name, previous: old }, 'search: the new OpenSearch index is live');
    // keep the previous index for a rollback; older ones go
    const all = await this.os.request<{ index: string }[]>('GET', `/_cat/indices/${this.alias}-*`, undefined, { querystring: { format: 'json', h: 'index' }, ignore: [404] });
    const prefix = `${this.alias}-`;
    for (const i of Array.isArray(all.body) ? all.body : []) {
      if (i.index !== name && i.index !== old && i.index.startsWith(prefix) && /^\d{17}$/.test(i.index.slice(prefix.length))) {
        await this.os.request('DELETE', `/${i.index}`, undefined, { ignore: [404] });
      }
    }
  }

  /** Copies documents (texts included) from one index to another, never over a newer version */
  private async copy(from: string, to: string, ids: string[]) {
    for (let i = 0; i < ids.length; i += 500) {
      const chunk = ids.slice(i, i + 500);
      const r = await this.os.request<{ docs: { _id: string; found: boolean; _source?: Record<string, unknown> }[] }>('POST', `/${from}/_mget`, { ids: chunk });
      const lines: object[] = [];
      for (const d of r.body.docs ?? []) {
        if (!d.found || !d._source) continue;
        lines.push({ update: { _index: to, _id: d._id, retry_on_conflict: 3 } }, { script: { source: VERSIONED_WRITE, lang: 'painless', params: { doc: d._source, full: true } }, scripted_upsert: true, upsert: {} });
      }
      if (lines.length) await this.os.ndjson('/_bulk', lines);
    }
  }

  async describe(): Promise<string> {
    try {
      const index = await this.ensure();
      const health = await this.os.request<{ status?: string }>('GET', `/_cluster/health/${index}`, undefined, { ignore: [404, 408] });
      const building = await this.aliasTarget(this.buildingAlias);
      const parts = [health.body?.status ?? 'unknown', `index ${index}`];
      if ((this.mappingVersion ?? MAPPING_VERSION) < MAPPING_VERSION) parts.push(`mapping v${this.mappingVersion} < v${MAPPING_VERSION}: full reindex needed`);
      if (building) parts.push(`rebuilding into ${building}`);
      return `opensearch (${parts.join(', ')})`;
    } catch (err) {
      return `opensearch (unreachable: ${err instanceof Error ? err.message.slice(0, 120) : 'error'})`;
    }
  }

  /* ---------------------------------------------------------------- writes */

  /** Writes documents to the live index (and a building one); answers the products that could not be written */
  async write(upserts: IndexedDocument[], deletes: string[]): Promise<{ failed: string[] }> {
    if (!upserts.length && !deletes.length) return { failed: [] };
    await this.ensure();
    const targets: Target[] = (await this.buildingIndex()) ? ['live', 'building'] : ['live'];
    const ops: Op[] = [];
    for (const target of targets) {
      const index = target === 'live' ? this.alias : this.buildingAlias;
      for (const d of upserts) {
        const full = Boolean(d.texts);
        const doc = full ? sourceOf(d) : fieldsOf(d.doc, d.offers);
        ops.push({
          productId: d.doc.product_id,
          target,
          partial: !full,
          lines: [
            { update: { _index: index, _id: d.doc.product_id, retry_on_conflict: 3 } },
            { script: { source: VERSIONED_WRITE, lang: 'painless', params: { doc, full } }, ...(full ? { scripted_upsert: true, upsert: {} } : {}) },
          ],
        });
      }
      for (const id of deletes) ops.push({ productId: id, target, partial: false, lines: [{ delete: { _index: index, _id: id } }] });
    }
    const failed = new Set<string>();
    let pending = ops;
    for (let attempt = 1; pending.length; attempt++) {
      const last = attempt >= this.o.cfg.bulkAttempts;
      let items: Record<string, { status: number; error?: { type?: string; reason?: string } }>[];
      try {
        const r = await this.os.ndjson<{ errors: boolean; items: typeof items }>(
          '/_bulk',
          pending.flatMap((o) => o.lines),
          { require_alias: true, ...(this.o.cfg.refresh !== 'false' ? { refresh: this.o.cfg.refresh } : {}) },
        );
        items = r.body.items ?? [];
      } catch (err) {
        if (last) throw err;
        await this.sleep(100 * 2 ** attempt);
        continue;
      }
      const retry: Op[] = [];
      pending.forEach((op, i) => {
        const item = Object.values(items[i] ?? {})[0];
        const status = item?.status ?? 500;
        const type = item?.error?.type;
        if (status < 300) return;
        if (status === 404 && !type) return; // delete of a document that is not there
        if (op.target === 'building' && (type === 'document_missing_exception' || type === 'index_not_found_exception')) {
          // not rebuilt yet (the rebuild writes it), or the rebuild just ended
          if (type === 'index_not_found_exception') this.building = null;
          return;
        }
        if (type === 'document_missing_exception') {
          // a change to a document this index does not have: it needs a full rebuild
          failed.add(op.productId);
          return;
        }
        if (status === 429 || status >= 500 || type === 'version_conflict_engine_exception') {
          if (last) failed.add(op.productId);
          else retry.push(op);
          return;
        }
        this.o.log.error({ productId: op.productId, status, error: item?.error }, 'search: OpenSearch rejected a document');
        failed.add(op.productId);
      });
      pending = retry;
      if (pending.length) await this.sleep(100 * 2 ** attempt);
    }
    return { failed: [...failed] };
  }
}
