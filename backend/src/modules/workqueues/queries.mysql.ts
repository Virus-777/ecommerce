/**
 * The MySQL half of workqueues' queries port (queries.ts). Each of the three is the shape §13.1 gives the
 * pipeline it replaces:
 *
 *  - the `$cond` sums are `SUM(<condition>)` over one `GROUP BY queue_key` — a `GROUP BY` with more than a count,
 *    which `countBy` cannot carry;
 *  - the `$sort` + `$group $first` is `ROW_NUMBER() OVER (PARTITION BY queue_key ORDER BY opened_at, id) = 1`
 *    ("latest row per key", read the other way round: oldest first);
 *  - the `$addFields` sort key is computed in the `SELECT` list and paged with `Table.pageQuery`, which is the
 *    kernel's counterpart of `pageAggregate`: it wraps the statement as a derived table so the computed key is
 *    ordered and paged on without being computed twice, and it keeps the row conversion and the keyset cursor
 *    written once.
 *
 * Both grouped reads are over the active items, which `ix_workqueues_items_2 (queue_key, state, due_at)` narrows;
 * the dashboard reads them once per screen, not per row. If Y5 measures either as hot, §9.3's answer is a
 * per-queue summary table, not an index on this statement.
 *
 * Nothing here is bound to a transaction (queries.ts says why), so each takes its table and its `db` from the
 * module store as it is.
 */
import { sql } from 'kysely';
import type { PageRequest } from '../../kernel/lib/pagination.js';
import type { ModuleStore } from '../../kernel/mysql/module-store.js';
import { q, raw, whereSql, type WhereOptions } from '../../kernel/mysql/where.js';
import type { WhereWithOr } from '../../kernel/store/index.js';
import type { Page } from '../../spec/common.js';
import type { WorkqueuesTables } from '../../spec/workqueues.js';
import type { ItemRow, OldestRow, QueueCountRow } from './ports.js';
import type { ComputedSort, WorkqueuesQueries } from './queries.js';

/**
 * The computed sort key as SQL. `priority` mirrors `domain/catalog.priorityRank` word for word rather than using
 * `FIELD()`, which answers 0 for a word that is not in the list and would then rank it *below* `low` instead of
 * with it; `amount` is the `$ifNull` of the pipeline, and -1 is below every real value because `amount_minor`
 * counts minor units and is never negative.
 */
const COMPUTED: Record<ComputedSort, string> = {
  priority: "CASE `priority` WHEN 'urgent' THEN 3 WHEN 'high' THEN 2 WHEN 'normal' THEN 1 ELSE 0 END",
  amount: 'COALESCE(`amount_minor`, -1)',
};

/** A count as mysql2 hands it over: `COUNT()` is BIGINT and `SUM()` is DECIMAL, either of which may be a string */
type Counted = number | string;

export function mysqlWorkqueuesQueries(store: ModuleStore<WorkqueuesTables>): WorkqueuesQueries {
  const items = store.table<ItemRow>('items');
  // the same reading of a filter the table itself uses: `related_subjects` is a JSON column, and a JSON column
  // that cannot be null holds `null` as a document rather than as SQL NULL (kernel/mysql/table.ts)
  const itemWhere: WhereOptions = { json: new Set(items.def.json), jsonNotNull: new Set(items.def.json.filter((c) => !items.def.nullable.includes(c))) };
  const states = (values: readonly string[]) => sql.join(values.map((v) => sql.val(v)));

  return {
    async queueCounts({ states: wanted, now, soon }): Promise<QueueCountRow[]> {
      if (!wanted.length) return [];
      const { rows } = await sql<{ queue_key: string; open: Counted; overdue: Counted; due_soon: Counted }>`
        SELECT \`queue_key\` AS \`queue_key\`,
               COUNT(*) AS \`open\`,
               SUM(\`due_at\` <= ${now}) AS \`overdue\`,
               SUM(\`due_at\` > ${now} AND \`due_at\` <= ${soon}) AS \`due_soon\`
          FROM \`workqueues_items\`
         WHERE \`state\` IN (${states(wanted)})
         GROUP BY \`queue_key\``.execute(store.db);
      return rows.map((r) => ({ queue_key: r.queue_key, open: Number(r.open), overdue: Number(r.overdue), due_soon: Number(r.due_soon) }));
    },

    async oldestOpen({ states: wanted }): Promise<OldestRow[]> {
      if (!wanted.length) return [];
      const { rows } = await sql<{ queue_key: string; id: string; ref: string; subject_ref: string | null; opened_at: Date }>`
        SELECT \`queue_key\`, \`id\`, \`ref\`, \`subject_ref\`, \`opened_at\`
          FROM (SELECT \`queue_key\`, \`id\`, \`ref\`, \`subject_ref\`, \`opened_at\`,
                       ROW_NUMBER() OVER (PARTITION BY \`queue_key\` ORDER BY \`opened_at\` ASC, \`id\` ASC) AS \`rn\`
                  FROM \`workqueues_items\`
                 WHERE \`state\` IN (${states(wanted)})) AS \`per\`
         WHERE \`rn\` = 1
         ORDER BY \`queue_key\` ASC`.execute(store.db);
      return rows.map((r): OldestRow => ({ queue_key: r.queue_key, id: r.id, ref: r.ref, subject_ref: r.subject_ref, opened_at: r.opened_at }));
    },

    pageByComputed(where: WhereWithOr<ItemRow>, by: ComputedSort, req: PageRequest): Promise<Page<ItemRow>> {
      const w = whereSql(where, itemWhere);
      // `*` and not a column list: pageQuery reads the row back with the table's own conversion and drops the
      // computed key, so the statement must produce every column of the table and `_sort` beside them
      return items.pageQuery(raw(`SELECT ${q(items.name)}.*, ${COMPUTED[by]} AS ${q('_sort')} FROM ${q(items.name)} WHERE (${w.sql})`, w.params), req, { key: '_sort', direction: 'desc' });
    },
  };
}
