/**
 * The MySQL half of audit's queries port (queries.ts).
 *
 * "The name from the newest row per key" is `ROW_NUMBER() OVER (PARTITION BY … ORDER BY at DESC) = 1`, which is
 * what §13.1 gives a `$sort` + `$group $first`, with the count taken by a second window over the same partition
 * so the range is read once. `Where` has no shape for a window, which is why this read is here and not in the
 * repository (§10.5e).
 *
 * The window runs over the entries in the range, which `ix_audit_entries_1 (at DESC, id)` narrows first; the
 * summary is a report over a month of history, not a hot path. If Y5 measures it as one, §9.3's answer is a
 * per-day actor summary table, not an index on this statement.
 */
import { sql } from 'kysely';
import type { ModuleStore } from '../../kernel/mysql/module-store.js';
import type { Store, WhereWithOr } from '../../kernel/store/index.js';
import type { AuditTables } from '../../spec/audit.js';
import type { ActorCount, AppendOnlyTable, AuditQueries } from './queries.js';

export function mysqlAuditQueries(store: ModuleStore<AuditTables>): AuditQueries {
  return {
    async topActors({ from, to, limit }): Promise<ActorCount[]> {
      // one row per person (actor kind + id), named by their latest entry (a renamed person counts once).
      // actor_kind is in the partition although the filter pins it, so the key is the one the chain row has.
      const read = await sql<{ id: string | null; name: string | null; n: number | string }>`
        SELECT \`id\`, \`name\`, \`n\`
          FROM (SELECT \`actor_id\` AS \`id\`,
                       \`actor_name\` AS \`name\`,
                       COUNT(*) OVER (PARTITION BY \`actor_kind\`, \`actor_id\`) AS \`n\`,
                       ROW_NUMBER() OVER (PARTITION BY \`actor_kind\`, \`actor_id\` ORDER BY \`at\` DESC) AS \`rn\`
                  FROM \`audit_entries\`
                 WHERE \`at\` >= ${from} AND \`at\` < ${to} AND \`actor_kind\` = ${'staff'}) AS \`per\`
         WHERE \`rn\` = 1
         ORDER BY \`n\` DESC, \`id\` ASC
         LIMIT ${limit}
      `.execute(store.db);
      // COUNT() is BIGINT, which mysql2 may hand back as a string
      return read.rows.map((r) => ({ id: r.id, name: r.name, n: Number(r.n) }));
    },

    /**
     * The retention purge's delete, between the two statements that let it through the append-only trigger
     * (§6.3). `@marketly_purge` is a session variable, so it is set on the connection the DELETE runs on —
     * the transaction's, which is the store the repository is bound to and the reason that store is passed in.
     * It is cleared again straight away, so nothing else on that connection inherits the permission.
     */
    async purgeRows<R extends object>(store: Store, table: AppendOnlyTable, where: WhereWithOr<R>): Promise<number> {
      const db = (store as ModuleStore<AuditTables>).db;
      await sql`SET @marketly_purge = ${`audit_${table}`}`.execute(db);
      try {
        return await store.table<R>(table).deleteMany(where);
      } finally {
        await sql`SET @marketly_purge = NULL`.execute(db);
      }
    },
  };
}
