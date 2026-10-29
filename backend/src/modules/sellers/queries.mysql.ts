/**
 * The MySQL half of the sellers queries port (queries.ts).
 *
 * Two shapes carry the five reads left here:
 *
 *   - **`ReadOptions.and`** — one extra condition on an ordinary `Table` read, which keeps the paging and
 *     the row conversion written once (§10.5e). It is only ever the part the vocabulary cannot say: here,
 *     `MEMBER OF` an array nested *inside* a JSON document (`business->'$.categoryIds'`), which the `[]`
 *     path cannot reach because its column is `business` and not `business.categoryIds`.
 *   - **`ROW_NUMBER() OVER (PARTITION BY seller_id ORDER BY computed_at DESC)`** in a derived table, which
 *     is §13.1's "latest rows per key".
 *
 * It was four reads longer: the two search boxes and the duplicate-application check went back into the
 * repository once the vocabulary could say `contains` and `equals ignoring case` of a path into a document,
 * and the type guard a JSON comparison needs became part of the vocabulary too. What is left here is the
 * window function and the nested array, which neither store spells the same way.
 *
 * One reading worth keeping, because it is a decision and not SQL's default: **a JSON null sorts below every
 * number.** MySQL compares JSON values by type first, and null is the lowest of them, so
 * `metrics->'$….value' < 90` is *true* for a metric set to null, where MongoDB's type-bracketed `$lt` never
 * matched one. `JSON_TYPE(…) IN (…)` is what `$type: 'number'` said on the other side — and the collation on
 * its left side is not decoration: `JSON_TYPE` answers a string of its own collation, which a session running
 * `utf8mb4_0900_bin` refuses to compare with a literal ("Illegal mix of collations", every time).
 */
import { sql } from 'kysely';
import type { ModuleStore } from '../../kernel/mysql/module-store.js';
import { q, raw } from '../../kernel/mysql/where.js';
import type { SellersTables } from '../../spec/sellers.js';
import type { ApplicationRec, PerfEventRec, PerformanceFacts, SnapshotRec } from './ports.js';
import type { SellersQueries } from './queries.js';

/** `JSON_TYPE` of the values that are a number (`$type: 'number'` on the other side) */
const NUMERIC_JSON = ['INTEGER', 'DOUBLE', 'DECIMAL'];

export function mysqlSellersQueries(store: ModuleStore<SellersTables>): SellersQueries {
  const applications = store.table<ApplicationRec>('applications');
  const events = store.table<PerfEventRec>('performance_events');
  const snapshots = store.table<SnapshotRec>('performance_snapshots');


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
      // Which snapshots come back is asserted (`performance.test.ts`: a seller with an older below-target
      // snapshot and a newer good one). The **order among them** is not: the only caller that asks for more
      // than one is `autoWarningsFor`, which takes the first two and wants the newest two — and its test
      // gives a seller three snapshots that all miss, so reversing this `DESC` changes none of its answers.
      // `_rn` is the window's own column and no column of the table: it is dropped before the row is built.
      return rows.map(({ _rn, ...row }) => snapshots.fromRow(row));
    },
  };
}
