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
 * `topActors` is outside a transaction, which is why it takes none: the summary is a report.
 *
 * The retention purge's delete is *not* here, though it is also a different sentence per store: deleting from
 * an append-only table is `table.purgeMany(where)`, which the kernel owns because five tables in three
 * modules have those triggers and only one of them has a purge (§6.3).
 */

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
}
