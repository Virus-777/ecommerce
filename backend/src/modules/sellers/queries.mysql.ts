/**
 * The MySQL half of the sellers queries port (queries.ts).
 *
 * Three shapes carry all nine reads:
 *
 *   - **`ReadOptions.and`** — one extra condition on an ordinary `Table` read, which keeps the paging, the
 *     keyset cursor and the row conversion written once (§10.5e). The two admin lists and the duplicate
 *     check are a neutral `Where` plus one fragment, and the fragment is only ever the part the vocabulary
 *     cannot say: a search box over a path inside a JSON document, and `MEMBER OF` an array inside one.
 *   - **`whereSql`** — the neutral vocabulary, used *inside* a hand-built `OR` so the portable branches of
 *     `applicationsMatching` (payout tokens, a postal code, a tax id hash) stay written the way the
 *     repository would write them, with the table's own reading of its JSON columns.
 *   - **`ROW_NUMBER() OVER (PARTITION BY seller_id ORDER BY computed_at DESC)`** in a derived table, which is
 *     §13.1's "latest rows per key". The index `sellers_performance_snapshots (seller_id, computed_at DESC)`
 *     orders both of them without a filesort.
 *
 * Two readings worth having in mind, both of them decisions and neither of them SQL's default:
 *
 *   - **A search box ignores case, and `JSON_UNQUOTE` does not.** It answers `utf8mb4_bin`, which a session
 *     running `utf8mb4_0900_bin` refuses to compare with anything else — "Illegal mix of collations", every
 *     time (§10.5b) — so the left side is collated to `as_ci` explicitly, exactly as the kernel's own `like`
 *     on a JSON path collates it to `bin`. `as_ci` ignores case and not accents, which is the rule MongoDB's
 *     strength-2 collation applied (§5.2), so `LIKE` here and a case-insensitive regex there agree.
 *   - **A JSON null sorts below every number.** MySQL compares JSON values by type first and NULL is the
 *     lowest of them, so `metrics->'$….value' < 90` is *true* for a metric that is set to null — where
 *     MongoDB's type-bracketed `$lt` never matched one. That is what `$type: 'number'` said on the other
 *     side and what `JSON_TYPE(…) IN (…)` says here. A field that is simply absent reads as SQL NULL and
 *     matches neither.
 */
import { sql } from 'kysely';
import { escapeLike } from '../../kernel/lib/text.js';
import type { KeysetOrder, PageRequest } from '../../kernel/lib/pagination.js';
import type { ModuleStore } from '../../kernel/mysql/module-store.js';
import { q, raw, whereSql, type Sql, type WhereOptions } from '../../kernel/mysql/where.js';
import type * as common from '../../spec/common.js';
import type { SellersTables } from '../../spec/sellers.js';
import type { ApplicationRec, PerfEventRec, PerformanceFacts, SellerRec, SnapshotRec } from './ports.js';
import type { ApplicationSignals, SellersQueries } from './queries.js';

/** Ignores case, not accents: the rule MongoDB's strength-2 collation applied (§5.2) */
const CI = 'COLLATE utf8mb4_0900_as_ci';

/** A search box's term as a LIKE pattern: a typed `%` is a per-cent sign, never "anything" */
const term = (text: string) => `%${escapeLike(text.trim())}%`;

/** `JSON_TYPE` of the values that are a number (`$type: 'number'` on the other side) */
const NUMERIC_JSON = ['INTEGER', 'DOUBLE', 'DECIMAL'];

/** Every one of these holds */
const allOf = (parts: readonly Sql[]): Sql => ({ sql: parts.map((p) => `(${p.sql})`).join(' AND '), params: parts.flatMap((p) => p.params) });
/** Any one of these holds */
const anyOf = (parts: readonly Sql[]): Sql => ({ sql: `(${parts.map((p) => `(${p.sql})`).join(' OR ')})`, params: parts.flatMap((p) => p.params) });

export function mysqlSellersQueries(store: ModuleStore<SellersTables>): SellersQueries {
  const sellers = store.table<SellerRec>('sellers');
  const applications = store.table<ApplicationRec>('applications');
  const events = store.table<PerfEventRec>('performance_events');
  const snapshots = store.table<SnapshotRec>('performance_snapshots');

  /** The same reading of a filter the table itself uses, for a `whereSql` written beside a hand-built OR */
  const appWhere: WhereOptions = {
    json: new Set(applications.def.json),
    // a JSON column that cannot be null holds `null` as a document rather than as SQL NULL
    jsonNotNull: new Set(applications.def.json.filter((c) => !applications.def.nullable.includes(c))),
  };

  /** `<table>.<column> LIKE '%term%'`, ignoring case */
  const columnHas = (table: string, column: string, text: string): Sql => ({ sql: `${q(table)}.${q(column)} LIKE ? ${CI}`, params: [term(text)] });

  /** The same on a path inside a JSON document; the text is unquoted out of the document and then collated */
  const pathHas = (table: string, column: string, path: string, text: string): Sql => ({
    sql: `JSON_UNQUOTE(${q(table)}.${q(column)}->'$.${path}') ${CI} LIKE ?`,
    params: [term(text)],
  });

  /** `lower(<path>) = lower(?)`, as the `as_ci` collation reads it */
  const pathIs = (table: string, column: string, path: string, value: string): Sql => ({
    sql: `JSON_UNQUOTE(${q(table)}.${q(column)}->'$.${path}') ${CI} = ?`,
    params: [value],
  });

  /** The search box over a seller's names, contact email and reference */
  const sellerTerm = (text: string): Sql =>
    anyOf([columnHas(sellers.name, 'store_name', text), columnHas(sellers.name, 'legal_name', text), pathHas(sellers.name, 'contact', 'email', text), columnHas(sellers.name, 'ref', text)]);

  /**
   * The ids of the sellers whose **newest** snapshot meets `condition` — `ROW_NUMBER() … = 1`, which is
   * §13.1's "latest row per key" and the `$sort` + `$group $first` of the pipeline it replaces. Only
   * `seller_id` and `metrics` come out of the derived table: the condition is about the metrics document and
   * the caller wants ids.
   */
  const latestSnapshotIds = async (condition: ReturnType<typeof sql>): Promise<string[]> => {
    const { rows } = await sql<{ seller_id: string }>`
      SELECT \`seller_id\`
        FROM (SELECT \`seller_id\`, \`metrics\`,
                     ROW_NUMBER() OVER (PARTITION BY \`seller_id\` ORDER BY \`computed_at\` DESC) AS \`_rn\`
                FROM ${sql.table(snapshots.name)}) AS \`latest\`
       WHERE \`_rn\` = 1 AND ${condition}`.execute(store.db);
    return rows.map((r) => r.seller_id);
  };

  /** A path into the dispatch reliability metric of a `latest` row */
  const metricPath = (field: 'value' | 'status') => sql.raw(`\`metrics\`->'$.dispatch_reliability.${field}'`);

  return {
    pageSellersMatching(where, text: string, req: PageRequest, order: KeysetOrder): Promise<common.Page<SellerRec>> {
      return sellers.page(where, req, order, { and: sellerTerm(text) });
    },

    findSellersMatching(where, text: string, limit: number): Promise<SellerRec[]> {
      return sellers.find(where, { and: sellerTerm(text), sort: { created_at: -1 }, limit });
    },

    /** the seller's application lists the category: `categoryId` is one of the ids in the business document */
    applicationIdsInCategory(categoryId: string): Promise<string[]> {
      return applications.distinct<string>('id', {}, { and: raw(`? MEMBER OF (${q(applications.name)}.${q('business')}->'$.categoryIds')`, [categoryId]) });
    },

    /** the latest snapshot's dispatch reliability value is below the figure (no value, or not a number: not below) */
    sellerIdsWithDispatchValueBelow(value: number): Promise<string[]> {
      const path = metricPath('value');
      // `JSON_TYPE` answers a string of its own collation, which a session running `utf8mb4_0900_bin`
      // refuses to compare with the literals' ("Illegal mix of collations for operation ' IN '"), so the
      // left side is collated here exactly as a JSON path's text is
      return latestSnapshotIds(sql`JSON_TYPE(${path}) COLLATE utf8mb4_0900_bin IN (${sql.join(NUMERIC_JSON.map((t) => sql.val(t)))}) AND ${path} < CAST(${JSON.stringify(value)} AS JSON)`);
    },

    sellerIdsWithDispatchStatusIn(statuses: readonly string[]): Promise<string[]> {
      if (!statuses.length) return Promise.resolve([]); // "any of none", as an empty `IN` is
      return latestSnapshotIds(sql`${metricPath('status')} IN (${sql.join(statuses.map((s) => sql`CAST(${JSON.stringify(s)} AS JSON)`))})`);
    },

    pageApplicationsMatching(where, text: string, req: PageRequest): Promise<common.Page<ApplicationRec>> {
      const t = applications.name;
      const matching = anyOf([columnHas(t, 'ref', text), pathHas(t, 'account', 'storeName', text), pathHas(t, 'business', 'legalName', text), pathHas(t, 'account', 'contactName', text)]);
      return applications.page(where, req, { column: 'decision_target_at', direction: 'asc' }, { and: matching });
    },

    applicationsMatching(s: ApplicationSignals, excludeId: string): Promise<ApplicationRec[]> {
      const t = applications.name;
      const parts: Sql[] = [];
      if (s.emails.length) parts.push({ sql: `JSON_UNQUOTE(${q(t)}.${q('account')}->'$.workEmail') ${CI} IN (${s.emails.map(() => '?').join(', ')})`, params: [...s.emails] });
      // the payout tokens and the tax id hashes are plain conditions: the vocabulary says them, so it says them here
      if (s.tokens.length) parts.push(whereSql({ 'payout.current.providerDestinationId': [...s.tokens] }, appWhere), whereSql({ 'payout.pendingChange.providerDestinationId': [...s.tokens] }, appWhere));
      for (const a of s.addresses) {
        const postalCode = a.postalCode.trim();
        const line1 = a.line1.trim();
        parts.push(allOf([whereSql({ 'business.address.postalCode': postalCode }, appWhere), pathIs(t, 'business', 'address.line1', line1)]));
        parts.push(allOf([whereSql({ 'return_address.address.postalCode': postalCode }, appWhere), pathIs(t, 'return_address', 'address.line1', line1)]));
      }
      if (s.taxIdHashes?.length) parts.push(whereSql({ tax_id_hash: [...s.taxIdHashes] }, appWhere));
      return applications.find({ id: { op: '<>', value: excludeId } }, { and: anyOf(parts), limit: 20 });
    },

    async performanceFactsByKind(sellerId: string, since: Date, kinds?: readonly string[]): Promise<PerformanceFacts[]> {
      if (kinds && !kinds.length) return [];
      const ofKind = kinds ? sql`AND \`kind\` IN (${sql.join(kinds.map((k) => sql.val(k)))})` : sql``;
      // SUM() of a DECIMAL column answers a DECIMAL, which mysql2 hands over as a string (and as NULL when
      // every value was null, which `$sum` reports as 0)
      const { rows } = await sql<{ kind: string; n: number | string; total: string | null }>`
        SELECT \`kind\`, COUNT(*) AS \`n\`, SUM(\`value\`) AS \`total\`
          FROM ${sql.table(events.name)}
         WHERE \`seller_id\` = ${sellerId} AND \`occurred_at\` >= ${since} ${ofKind}
         GROUP BY \`kind\``.execute(store.db);
      return rows.map((r) => ({ kind: r.kind, n: Number(r.n), total: Number(r.total ?? 0) }));
    },

    async latestSnapshots(sellerIds: readonly string[], perSeller: number): Promise<SnapshotRec[]> {
      const { rows } = await sql<Record<string, unknown>>`
        SELECT * FROM (
          SELECT s.*, ROW_NUMBER() OVER (PARTITION BY s.\`seller_id\` ORDER BY s.\`computed_at\` DESC) AS \`_rn\`
            FROM ${sql.table(snapshots.name)} AS s
           WHERE s.\`seller_id\` IN (${sql.join([...new Set(sellerIds)])})) AS r
         WHERE r.\`_rn\` <= ${perSeller}
         ORDER BY r.\`seller_id\` ASC, r.\`computed_at\` DESC`.execute(store.db);
      // `_rn` is the window's own column and no column of the table: it is dropped before the row is built
      return rows.map(({ _rn, ...row }) => snapshots.fromRow(row));
    },
  };
}
