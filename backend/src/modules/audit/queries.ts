/**
 * The reads and the one write of this module that are not the same question in both databases
 * (docs/10-mysql-migration.md §10.5e).
 *
 * Everything else lives in repository.ts, written once against `ctx.store`. What is here needs **the name from
 * the newest row per key**: the summary's top ten staff actors are counted per person (actor kind and id) but
 * named by their *latest* entry, so a renamed person counts once and appears under the name they have now.
 * MongoDB asks that with `$sort` + `$group` + `$first`; SQL asks it with `ROW_NUMBER() … = 1` (§13.1, "latest
 * row per key"). The same question, not the same sentence, so each store gets its own implementation of this
 * small interface and the service never learns which one it has.
 *
 * The counts per category beside it are *not* here: "how many rows per key" is `table.countBy(['category'], …)`,
 * which both stores answer identically and the seam therefore carries (§10.5e).
 *
 * `topActors` is outside a transaction, which is why it takes none: the summary is a report. `purgeRows` is
 * inside the purge's transaction, and is handed the store that transaction is bound to.
 */

import type { Store, WhereWithOr } from '../../kernel/store/index.js';

/** The append-only tables of this module (docs/10 §6.3), the only ones the retention purge deletes from */
export type AppendOnlyTable = 'entries' | 'entry_targets';

/** One person in the summary's byActor list: their id, the name on their latest entry, and how many entries */
export interface ActorCount {
  /** null for an actor with no id (a system or anonymous staff entry) */
  id: string | null;
  name: string | null;
  n: number;
}

export interface AuditQueries {
  /**
   * The busiest staff actors between `from` (inclusive) and `to` (exclusive), most entries first and then by id,
   * at most `limit` of them. One row per person (actor kind and id), named by their newest entry in the range.
   */
  topActors(f: { from: Date; to: Date; limit: number }): Promise<ActorCount[]>;

  /**
   * Deletes the rows of one append-only table that the retention purge removes, and says how many: the one write
   * that is not the same sentence in both databases.
   *
   * `audit_entries`, `audit_entry_targets` and `audit_checkpoints` are append-only, and on MySQL that is two
   * triggers per table rather than a convention of this repository: the delete trigger refuses every DELETE
   * unless the **session** says `@marketly_purge` is that table, which only the retention purge may say (§6.3).
   * So "delete these rows, as the purge" is one statement on MongoDB and three on MySQL, and the session is the
   * transaction's own connection — which is why this takes the store the repository is bound to. The filter and
   * the row conversion stay where they are written once: both implementations delete through `store.table`.
   */
  purgeRows<R extends object>(store: Store, table: AppendOnlyTable, where: WhereWithOr<R>): Promise<number>;
}
