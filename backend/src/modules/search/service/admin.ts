/**
 * Back office and small store endpoints: synonyms, reindex jobs, index status, zero-result analytics,
 * explain, the ranking policy, federated quick lookups, click logging, barcodes, similar products and
 * recent searches.
 */
import type { Principal, SellerMemberAccess } from '../../../kernel/auth/index.js';
import { maskValue } from '../../../kernel/auth/masking.js';
import { AppError } from '../../../kernel/errors/index.js';
import { zonedTimeToUtc } from '../../../kernel/lib/clock.js';
import { newId } from '../../../kernel/lib/ids.js';
import { pageOf, type PageRequest } from '../../../kernel/lib/pagination.js';
import type * as common from '../../../spec/common.js';
import type { BarcodeMatch, IndexStatus, LookupGroup, LookupHit, LookupResult, ProductCard, RankingFactor, RankingPolicy, RankingPolicyInput, ReindexJob, SearchExplain, Synonym, SynonymInput, ZeroResultQuery } from '../../../spec/search.js';
import { toQueryString } from '../domain/query.js';
import { DEFAULT_FACTORS, DEFAULT_POLICY_TEXT, RANKING_FACTOR_KEYS } from '../domain/ranking.js';
import { reindexJobMachine } from '../domain/state-machines.js';
import { normalizeGtin, normalizeQuery, queryGtin, synonymTerms } from '../domain/text.js';
import type { PolicyRow, ReindexJobRow, SynonymRow } from '../ports.js';
import { invalid, type By } from './base.js';
import { SearchQueries } from './queries.js';

export const actorText = (a: common.Actor): string => JSON.stringify({ kind: a.kind, id: a.id ?? null, ...(a.name ? { name: a.name } : {}) });
export function actorOf(s: string | null | undefined): common.Actor {
  if (!s) return { kind: 'system', id: null };
  try {
    const a = JSON.parse(s);
    if (a && typeof a === 'object' && typeof a.kind === 'string') return { kind: a.kind, id: a.id ?? null, ...(a.name ? { name: a.name } : {}) };
  } catch {
    /* plain id */
  }
  return { kind: 'system', id: s };
}

const iso = (d: Date | string | null | undefined) => (d ? new Date(d).toISOString() : null);

export class SearchAdmin extends SearchQueries {
  /* ---------------------------------------------------------------- synonyms */

  protected synonymOut = (r: SynonymRow): Synonym => ({
    id: r.id,
    terms: r.terms,
    kind: r.kind === 'one_way' ? 'one_way' : 'equivalent',
    from: r.from_term,
    active: r.active,
    note: r.note,
    updatedBy: actorOf(r.updated_by),
    updatedAt: new Date(r.updated_at).toISOString(),
  });

  async listSynonyms(filter: { q?: string; active?: boolean }, page: PageRequest): Promise<common.Page<Synonym>> {
    return pageOf((await this.repo.listSynonyms(filter)).map(this.synonymOut), page);
  }

  /** Checks a synonym set: normalized terms, the one-way source, and no term in another active equivalent set */
  protected async checkSynonym(input: SynonymInput, selfId: string | null): Promise<{ terms: string[]; from: string | null; active: boolean }> {
    const terms = synonymTerms(input.terms ?? []);
    const from = input.from?.trim() ? normalizeQuery(input.from) : null;
    const active = input.active ?? true;
    if (input.kind === 'equivalent') {
      if (terms.length < 2) throw invalid('terms', 'An equivalent set needs at least two different terms');
      if (from) throw invalid('from', 'Only one-way sets have a source term');
    } else {
      if (!from) throw invalid('from', 'A one-way set needs the term that expands');
      if (!terms.length) throw invalid('terms', 'A one-way set needs at least one term');
      if (terms.includes(from)) throw invalid('terms', 'The source term cannot expand to itself');
    }
    if (active && input.kind === 'equivalent') {
      for (const other of await this.repo.activeSynonyms()) {
        if (other.id === selfId || other.kind !== 'equivalent') continue;
        const clash = synonymTerms(other.terms).find((t) => terms.includes(t));
        if (clash) throw this.ctx.error('SYNONYM_CONFLICT', `'${clash}' is already in another active synonym set`, { synonymId: other.id, term: clash });
      }
    }
    return { terms, from, active };
  }

  async createSynonym(input: SynonymInput, by: By): Promise<Synonym> {
    const v = await this.checkSynonym(input, null);
    const row = await this.repo.insertSynonym({ id: newId(), terms: v.terms, kind: input.kind, from_term: v.from, active: v.active, note: input.note?.trim() || null, updated_by: actorText(by.actor), updated_at: this.now() });
    const out = this.synonymOut(row);
    this.ctx.events.publish('search.synonym.changed', { synonymId: row.id, action: 'created' }, { actor: by.actor, requestId: by.requestId });
    await this.audit({ action: 'search.synonym.create', actionLabel: 'Added search synonyms', category: 'settings', target: { type: 'synonym', id: row.id, label: v.terms.join(', ') }, after: out }, by);
    return out;
  }

  async updateSynonym(id: string, input: SynonymInput, by: By): Promise<Synonym> {
    const before = await this.repo.getSynonym(id);
    if (!before) throw new AppError('NOT_FOUND', 'Synonym set not found');
    const v = await this.checkSynonym(input, id);
    const row = await this.repo.updateSynonym(id, {
      terms: v.terms,
      kind: input.kind,
      from_term: v.from,
      active: input.active ?? before.active,
      note: input.note === undefined ? before.note : input.note?.trim() || null,
      updated_by: actorText(by.actor),
      updated_at: this.now(),
    });
    const out = this.synonymOut(row);
    this.ctx.events.publish('search.synonym.changed', { synonymId: id, action: 'updated' }, { actor: by.actor, requestId: by.requestId });
    await this.audit({ action: 'search.synonym.update', actionLabel: row.active ? 'Edited search synonyms' : 'Deactivated search synonyms', category: 'settings', target: { type: 'synonym', id, label: v.terms.join(', ') }, before: this.synonymOut(before), after: out }, by);
    return out;
  }

  async deleteSynonym(id: string, by: By): Promise<void> {
    const before = await this.repo.getSynonym(id);
    if (!before) throw new AppError('NOT_FOUND', 'Synonym set not found');
    await this.repo.deleteSynonym(id);
    this.ctx.events.publish('search.synonym.changed', { synonymId: id, action: 'deleted' }, { actor: by.actor, requestId: by.requestId });
    await this.audit({ action: 'search.synonym.delete', actionLabel: 'Deleted search synonyms', category: 'settings', target: { type: 'synonym', id, label: before.terms.join(', ') }, before: this.synonymOut(before) }, by);
  }

  /* ---------------------------------------------------------------- index and reindex jobs */

  protected jobOut = (r: ReindexJobRow): ReindexJob => ({
    id: r.id,
    scope: r.scope as ReindexJob['scope'],
    ids: r.ids ?? [],
    state: r.state as ReindexJob['state'],
    total: r.total,
    processed: r.processed,
    requestedBy: actorOf(r.requested_by),
    reason: r.reason,
    startedAt: iso(r.started_at),
    finishedAt: iso(r.finished_at),
    error: r.error,
  });

  async startReindex(input: { scope: ReindexJob['scope']; ids?: string[] | null; reason: string }, by: By): Promise<ReindexJob> {
    const reason = input.reason?.trim();
    if (!reason) throw invalid('reason', 'A reason is required');
    const ids = [...new Set(input.ids ?? [])];
    if (input.scope !== 'all' && !ids.length) throw invalid('ids', `Choose the ${input.scope === 'products' ? 'products' : input.scope === 'category' ? 'categories' : `${input.scope}s`} to reindex`);
    const base = { id: newId(), scope: input.scope, ids: input.scope === 'all' ? [] : ids, total: 0, processed: 0, requested_by: actorText(by.actor), reason, started_at: null, finished_at: null, error: null };
    let row: ReindexJobRow;
    if (input.scope === 'all') {
      const running = await this.repo.activeFullJob();
      if (running) throw this.ctx.error('REINDEX_ALREADY_RUNNING', 'A full reindex is already running', { jobId: running.id });
      // search.process-dirty starts it; the live index keeps serving meanwhile
      row = await this.repo.insertJob({ ...base, state: reindexJobMachine.initial });
    } else {
      // scoped jobs only mark documents dirty
      const productIds =
        input.scope === 'products'
          ? ids
          : await this.repo.documentIds(input.scope === 'category' ? { categoryIds: ids } : input.scope === 'brand' ? { brandIds: ids } : { sellerIds: ids });
      await this.markDirty(productIds, `reindex:${input.scope}`);
      const now = this.now();
      row = await this.repo.insertJob({ ...base, state: reindexJobMachine.initial, total: productIds.length });
      row = await this.repo.updateJob(row.id, { state: reindexJobMachine.next(row.state as ReindexJob['state'], 'start'), started_at: now });
      row = await this.repo.updateJob(row.id, { state: reindexJobMachine.next(row.state as ReindexJob['state'], 'complete'), processed: productIds.length, finished_at: now });
      this.ctx.events.publish('search.index.rebuilt', { jobId: row.id, scope: row.scope, documents: productIds.length }, { actor: by.actor, requestId: by.requestId });
    }
    const out = this.jobOut(row);
    await this.audit({ action: 'search.reindex.start', actionLabel: input.scope === 'all' ? 'Started a full search reindex' : `Reindexed search (${input.scope})`, category: 'settings', target: { type: 'reindex_job', id: row.id, label: input.scope }, after: out, reason }, by);
    return out;
  }

  async getReindexJob(id: string): Promise<ReindexJob> {
    const row = await this.repo.getJob(id);
    if (!row) throw new AppError('NOT_FOUND', 'Reindex job not found');
    return this.jobOut(row);
  }

  async indexStatus(): Promise<IndexStatus> {
    const [stats, dirty, last, running, engine] = await Promise.all([
      this.repo.documentStats(),
      this.repo.dirtyStats(),
      this.repo.lastCompletedFullJob(),
      this.repo.activeFullJob(),
      this.engine.describe ? this.engine.describe() : this.engine.name,
    ]);
    const now = this.now();
    return {
      engine,
      documents: stats.documents,
      offerRows: stats.offerRows,
      staleDocuments: dirty.count,
      lagSeconds: dirty.oldest ? Math.max(0, Math.round((now.getTime() - dirty.oldest.getTime()) / 1000)) : 0,
      lastEventAt: iso(stats.lastIndexedAt),
      lastFullReindexAt: iso(last?.finished_at),
      runningJob: running ? this.jobOut(running) : null,
    };
  }

  /* ---------------------------------------------------------------- analytics */

  /** Market dates (inclusive) → UTC instants */
  protected range(from: string, to: string): { start: Date; end: Date } {
    const tz = this.ctx.config.market.timeZone;
    if (to < from) throw invalid('to', 'The end date is before the start date');
    const next = new Date(`${to}T12:00:00Z`);
    next.setUTCDate(next.getUTCDate() + 1);
    return { start: zonedTimeToUtc(from, '00:00', tz), end: zonedTimeToUtc(next.toISOString().slice(0, 10), '00:00', tz) };
  }

  async zeroResultQueries(from: string, to: string): Promise<ZeroResultQuery[]> {
    const { start, end } = this.range(from, to);
    const rows = await this.repo.zeroResults(start, end);
    return rows.map((r) => {
      const f = (r.lastFilters ?? {}) as Record<string, unknown>;
      const qs = toQueryString({
        brand: (f.brand as string[]) ?? [],
        seller: (f.seller as string[]) ?? [],
        condition: (f.condition as string[]) ?? [],
        delivery: (f.delivery as string[]) ?? [],
        attrs: (f.attrs as { key: string; values: string[] }[]) ?? [],
        ...(f.category ? { category: f.category as string } : {}),
        ...(typeof f.priceMin === 'number' ? { priceMin: f.priceMin } : {}),
        ...(typeof f.priceMax === 'number' ? { priceMax: f.priceMax } : {}),
        ...(typeof f.rating === 'number' ? { rating: f.rating } : {}),
        ...(f.availability ? { availability: f.availability as 'include_out_of_stock' } : {}),
        ...(f.arrivesBy ? { arrivesBy: f.arrivesBy as string } : {}),
        ...(typeof f.listedWithinDays === 'number' ? { listedWithinDays: f.listedWithinDays } : {}),
        ...(f.onSale ? { onSale: true } : {}),
      });
      return { query: r.query, normalized: r.normalized, count: r.count, lastAt: r.lastAt.toISOString(), lastFilters: qs || null, correctionOffered: r.correctionOffered };
    });
  }

  async explain(input: { q: string; category?: string; limit?: number }): Promise<SearchExplain[]> {
    const limit = Math.min(Math.max(input.limit ?? 20, 1), 100);
    const p = await this.prepare({ q: input.q, filters: input.category ? { categorySlug: input.category } : {} }, { kind: 'search' }, { strictSort: false });
    if (!p.engineQuery.text) return [];
    const { hits } = await this.engine.search(p.engineQuery, 'recommended', await this.weights(), { offset: 0, limit });
    const groups = p.engineQuery.text.groups;
    return hits.map((h, i) => {
      const haystack = normalizeQuery([h.doc.title, h.doc.brand_name, JSON.stringify(h.doc.attributes)].filter(Boolean).join(' '));
      const stemOf = (w: string) => (w.length > 3 ? w.replace(/(es|s)$/, '') : w);
      const words = new Set(haystack.split(/[^\p{L}\p{N}]+/u).filter(Boolean).map(stemOf));
      const found = (term: string) => term.split(' ').every((w) => words.has(stemOf(w)));
      const matched = groups.flatMap((g) => g.filter(found));
      const gtinHit = Boolean(p.engineQuery.text?.gtin && h.doc.gtins.includes(p.engineQuery.text.gtin));
      return {
        productId: h.doc.product_id,
        title: h.doc.title,
        position: i + 1,
        score: Math.round(h.score * 10_000) / 10_000,
        factors: Object.fromEntries(Object.entries(h.factors).map(([k, v]) => [k, Math.round(v * 10_000) / 10_000])),
        matchedTerms: gtinHit ? [p.engineQuery.text!.gtin!, ...matched] : matched,
        synonymsUsed: p.text.synonymsUsed.filter((s) => matched.includes(s)),
        correctedFrom: p.text.correctionApplied ? p.text.raw : null,
      };
    });
  }

  /* ---------------------------------------------------------------- ranking policy */

  protected policyOut = (r: PolicyRow): RankingPolicy => ({
    version: r.version,
    text: r.text,
    factors: (Array.isArray(r.factors) ? r.factors : []) as unknown as RankingFactor[],
    effectiveFrom: new Date(r.effective_from).toISOString(),
    publishedBy: actorOf(r.published_by),
  });

  async rankingPolicy(): Promise<RankingPolicy> {
    const row = await this.repo.currentPolicy(this.now());
    if (row) return this.policyOut(row);
    // published ranking policy v1 (spec notes), in force until staff publish another version
    return { version: 1, text: DEFAULT_POLICY_TEXT, factors: DEFAULT_FACTORS, effectiveFrom: '2026-01-01T00:00:00.000Z', publishedBy: { kind: 'system', id: null } };
  }

  async publishRankingPolicy(input: RankingPolicyInput, by: By): Promise<RankingPolicy> {
    const text = input.text?.trim();
    if (!text) throw invalid('text', 'The policy wording is required');
    const reason = input.reason?.trim();
    if (!reason) throw invalid('reason', 'A reason is required');
    if (!input.factors?.length) throw invalid('factors', 'At least one ranking factor is required');
    const seen = new Set<string>();
    input.factors.forEach((f, i) => {
      if (!(RANKING_FACTOR_KEYS as readonly string[]).includes(f.key)) throw invalid(`factors.${i}.key`, `Unknown ranking factor '${f.key}' (${RANKING_FACTOR_KEYS.join(', ')})`);
      if (seen.has(f.key)) throw invalid(`factors.${i}.key`, `'${f.key}' is listed twice`);
      seen.add(f.key);
      if (!Number.isFinite(f.weight) || f.weight < 0) throw invalid(`factors.${i}.weight`, 'Weights are zero or more');
      if (!f.label?.trim()) throw invalid(`factors.${i}.label`, 'Each factor needs a label');
    });
    const effectiveFrom = new Date(input.effectiveFrom);
    const version = Math.max(await this.repo.latestPolicyVersion(), 1) + 1;
    const row = await this.repo.insertPolicy({
      version,
      text,
      factors: input.factors.map((f) => ({ key: f.key, label: f.label.trim(), weight: f.weight })) as never,
      effective_from: effectiveFrom,
      reason,
      published_by: actorText(by.actor),
      published_at: this.now(),
    });
    const out = this.policyOut(row);
    this.ctx.events.publish('search.ranking_policy.published', { version, effectiveFrom: out.effectiveFrom }, { actor: by.actor, requestId: by.requestId });
    await this.audit({ action: 'search.ranking_policy.publish', actionLabel: `Published ranking policy v${version}`, category: 'settings', target: { type: 'ranking_policy', id: String(version), label: `v${version}` }, after: out, reason }, by);
    return out;
  }

  /* ---------------------------------------------------------------- quick lookups (federated, not indexed) */

  protected lookupInput(q: string, limit: number | undefined): { q: string; limit: number } {
    const text = q?.trim() ?? '';
    if (text.length < 2) throw invalid('q', 'Type at least 2 characters');
    if (limit !== undefined && (limit < 1 || limit > 10)) throw invalid('limit', 'limit is 1 to 10');
    return { q: text, limit: limit ?? 5 };
  }

  /** One group per module: left out when the module is off, cannot answer or finds nothing */
  protected async group(kind: LookupGroup['kind'], label: string, fetch: () => Promise<{ items: LookupHit[]; more: boolean } | undefined>): Promise<LookupGroup | null> {
    const r = await fetch();
    return r && r.items.length ? { kind, label, items: r.items, more: r.more } : null;
  }

  async sellerQuick(sellerId: string, access: SellerMemberAccess | undefined, input: { q: string; limit?: number }): Promise<LookupResult> {
    const { q, limit } = this.lookupInput(input.q, input.limit);
    const may = (prefix: string, perms: string[]) => Boolean(access?.isOwner || access?.permissions.includes('*') || access?.permissions.some((p) => perms.includes(p) || p.startsWith(prefix)));
    const groups = await Promise.all([
      may('orders.fulfillment.', ['orders.fulfillment.view'])
        ? this.group('orders', 'Orders', () =>
            this.optional('orders', 'seller orders', async (o) => {
              const page = await o.listOrdersForSeller(sellerId, { q }, { limit });
              return {
                items: page.items.slice(0, limit).map(({ order, groups }) => ({ kind: 'order' as const, id: order.id, ref: order.ref, title: `${order.ref} · ${groups[0]?.buyerName ?? order.contact.name}`, subtitle: groups[0]?.statusLabel ?? order.statusLabel, statusLabel: groups[0]?.statusLabel ?? order.statusLabel, screen: 'seller/order' })),
                more: Boolean(page.nextCursor),
              };
            }),
          )
        : null,
      may('offers.', ['offers.offers.manage', 'offers.prices.manage', 'offers.bulk.update', 'offers.offers.export'])
        ? this.group('offers', 'Offers and SKUs', () =>
            this.optional('offers', 'own offers', async (o) => {
              const r = await o.searchOwnOffers(sellerId, q, limit);
              return {
                items: r.items.slice(0, limit).map((x) => ({ kind: 'offer' as const, id: x.id, ref: x.sellerSku, title: x.productTitle, subtitle: [x.variantLabel, `SKU ${x.sellerSku}`].filter(Boolean).join(' · '), statusLabel: x.status, screen: 'seller/offer' })),
                more: r.more,
              };
            }),
          )
        : null,
      may('returns.', ['returns.requests.respond', 'returns.refunds.issue', 'returns.requests.export'])
        ? this.group('returns', 'Returns', () =>
            this.optional('returns', 'seller returns', async (r) => {
              const page = await r.listForSeller(sellerId, { state: 'all', q }, { limit });
              return {
                items: page.items.slice(0, limit).map((x) => ({ kind: 'return' as const, id: x.id, ref: x.ref, title: `${x.ref} · ${x.item.title}`, subtitle: `Order ${x.orderRef}`, statusLabel: x.status, screen: 'seller/return' })),
                more: Boolean(page.nextCursor),
              };
            }),
          )
        : null,
    ]);
    return { query: q, groups: groups.filter((g): g is LookupGroup => Boolean(g)) };
  }

  async adminLookup(input: { q: string; limit?: number }, can: (permission: string) => Promise<boolean>): Promise<LookupResult> {
    const { q, limit } = this.lookupInput(input.q, input.limit);
    const [orders, sellers, customers, offers, contact] = await Promise.all([can('orders.orders.view'), can('sellers.accounts.view'), can('customers.accounts.view'), can('offers.offers.view'), can('orders.customers.view-contact')]);
    const gtin = queryGtin(q) ?? normalizeGtin(q);
    const groups = await Promise.all([
      orders
        ? this.group('orders', 'Orders', () =>
            this.optional('orders', 'orders', async (o) => {
              const page = await o.listOrdersAdmin({ q }, { limit });
              return {
                items: page.items.slice(0, limit).map((a) => ({ kind: 'order' as const, id: a.order.id, ref: a.order.ref, title: `${a.order.ref} · ${a.customer.name}`, subtitle: a.order.statusLabel, statusLabel: a.order.statusLabel, screen: 'admin/order' })),
                more: Boolean(page.nextCursor),
              };
            }),
          )
        : null,
      sellers
        ? this.group('sellers', 'Sellers', () =>
            this.optional('sellers', 'sellers', async (s) => {
              const page = await s.searchSellers({ search: q }, { limit });
              return {
                items: page.items.slice(0, limit).map((x) => ({ kind: 'seller' as const, id: x.id, ref: x.ref, title: x.storeName, subtitle: x.slug, statusLabel: x.status, screen: 'admin/seller' })),
                more: Boolean(page.nextCursor),
              };
            }),
          )
        : null,
      // listed products from the index (also by GTIN)
      this.group('products', 'Products', async () => {
        const docs = await this.engine.lookupProducts(q, gtin, limit + 1);
        return {
          items: docs.slice(0, limit).map((d) => ({ kind: 'product' as const, id: d.product_id, ref: null, title: d.title, subtitle: [d.brand_name, d.offer_count ? `${d.offer_count} ${d.offer_count === 1 ? 'offer' : 'offers'}` : null].filter(Boolean).join(' · ') || null, statusLabel: d.in_stock ? 'In stock' : 'Out of stock', screen: 'admin/product-review' })),
          more: docs.length > limit,
        };
      }),
      offers
        ? this.group('offers', 'Offers and SKUs', () =>
            this.optional('offers', 'offers', async (o) => {
              const page = await o.listOffersAdmin({ q }, { limit });
              return {
                items: page.items.slice(0, limit).map((x) => ({ kind: 'offer' as const, id: x.id, ref: x.sellerSku, title: `${x.sellerName} · ${x.sellerSku}`, subtitle: x.condition, statusLabel: x.status, screen: 'admin/offer' })),
                more: Boolean(page.nextCursor),
              };
            }),
          )
        : null,
      customers
        ? this.group('customers', 'Customers', () =>
            this.optional('customers', 'customers', async (c) => {
              const page = await c.searchCustomers({ search: q }, { limit });
              return {
                items: page.items.slice(0, limit).map((x) => ({ kind: 'customer' as const, id: x.id, ref: x.ref, title: x.displayName, subtitle: contact ? x.email : (maskValue(x.email, 'email') as string), statusLabel: x.accountStatus, screen: 'admin/customer' })),
                more: Boolean(page.nextCursor),
              };
            }),
          )
        : null,
    ]);
    return { query: q, groups: groups.filter((g): g is LookupGroup => Boolean(g)) };
  }

  /* ---------------------------------------------------------------- store: clicks, barcodes, similar, recent */

  async recordClick(searchId: string, body: { productId: string; position: number; sponsored: boolean }): Promise<void> {
    if (body.position < 1) throw invalid('position', 'Positions start at 1');
    await this.repo.logClick({ search_id: searchId, product_id: body.productId, position: body.position, sponsored: body.sponsored, at: this.now() });
  }

  async barcode(code: string, session: { sessionKey?: string }): Promise<BarcodeMatch> {
    const digits = code.trim().replace(/[\s-]/g, '');
    // a numeric code of GTIN length must carry a valid check digit (a misread scan); any other code simply matches nothing
    if (/^\d+$/.test(digits) && [8, 12, 13, 14].includes(digits.length) && !normalizeGtin(digits)) throw invalid('code', 'This barcode has a wrong check digit; scan it again');
    if (/^\d+$/.test(digits) && (digits.length < 8 || digits.length > 14)) throw invalid('code', 'A product barcode has 8 to 14 digits');
    const gtin = normalizeGtin(digits);
    const docs = gtin ? (await this.repo.productIdsByGtin(gtin)).filter((d) => d.offer_count > 0) : [];
    const doc = docs.sort((a, b) => Number(b.in_stock) - Number(a.in_stock) || Number(b.popularity) - Number(a.popularity))[0];
    if (!doc || !gtin) {
      // codes that match nothing are recorded as unavailable searches
      await this.repo.logQuery({ id: newId(), search_id: newId(), raw: digits, normalized: normalizeQuery(digits), filters: {} as never, sort: 'recommended', results: 0, corrected_to: null, session_key: session.sessionKey ?? null, at: this.now() });
      return { code: gtin ?? digits, match: false, productId: null, variantId: null, slug: null, title: null, card: null, fallbackQuery: digits };
    }
    const variantId = ((doc.variant_gtins ?? {}) as Record<string, string>)[gtin] ?? null;
    const [card] = await this.cardsFor([doc.product_id]);
    return { code: gtin, match: true, productId: doc.product_id, variantId, slug: doc.slug, title: doc.title, card: card ? { ...card, variantId: variantId ?? card.variantId } : null, fallbackQuery: null };
  }

  async similarCards(productId: string, limit: number | undefined): Promise<ProductCard[]> {
    const n = Math.min(Math.max(limit ?? 10, 1), 24);
    return this.cardsFor(await this.engine.similar(productId, n), { inStockOnly: true });
  }

  /** Recent-search owner from the endpoint's record scope (own-customer) */
  protected sessionOfScope(scope: { kind: string; customerId?: string | null; visitorSessionId?: string }) {
    if (scope.kind === 'customer') return scope.customerId ? { customerId: scope.customerId } : {};
    if (scope.kind === 'visitor' && scope.visitorSessionId) return { guestSessionId: scope.visitorSessionId };
    return {};
  }

  async recentForScope(scope: { kind: string; customerId?: string | null; visitorSessionId?: string }) {
    return this.listRecent(this.sessionOfScope(scope));
  }

  async deleteRecent(scope: { kind: string; customerId?: string | null; visitorSessionId?: string }, id: string): Promise<void> {
    const s = this.sessionOfScope(scope);
    const owner = s.customerId ? { kind: 'customer' as const, id: s.customerId } : s.guestSessionId ? { kind: 'guest' as const, id: s.guestSessionId } : null;
    if (!owner || !(await this.repo.deleteRecentSearch(owner, id))) throw new AppError('NOT_FOUND', 'Recent search not found');
  }

  async clearRecent(scope: { kind: string; customerId?: string | null; visitorSessionId?: string }): Promise<void> {
    const s = this.sessionOfScope(scope);
    const owner = s.customerId ? { kind: 'customer' as const, id: s.customerId } : s.guestSessionId ? { kind: 'guest' as const, id: s.guestSessionId } : null;
    if (owner) await this.repo.clearRecentSearches(owner);
  }

  /** The caller's search session (store endpoints) */
  async sessionFor(principal: Principal | null | undefined) {
    return this.sessionOf(principal);
  }
}
