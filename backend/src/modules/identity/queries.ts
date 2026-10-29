/**
 * The two pieces of identity's data access that are not the same sentence in both databases
 * (docs/10-mysql-migration.md §10.5e). Everything else lives in repository.ts, written once against
 * `ctx.store` in the neutral vocabulary.
 *
 * Why these two and nothing else: identity's three aggregations are otherwise plain "how many rows per key"
 * counts, which `table.countBy(['account_id'], where)` answers identically on either store. What is left is
 * a **window function** and a **patch computed from the row being written**, and the seam deliberately has
 * no shape for either (`decToZero` and a hand-written `expr` are SQL, and the MongoDB side refuses them by
 * name rather than guessing a pipeline's field names).
 *
 * `module.ts` picks one line — `ctx.mysql ? mysqlIdentityQueries(ctx.mysql) : mongoIdentityQueries(ctx.mongo)` —
 * and at the cutover `queries.mongo.ts` is deleted whole rather than edited (Y4).
 *
 * Both run outside a transaction, which is why neither takes one: the security list is a read for the admin
 * account list, and the expiry sweep selects its batch in one statement and revokes it in the next, exactly
 * as it did before.
 */
import type { SecurityEventRow } from './ports.js';

export interface IdentityQueries {
  /**
   * The newest `limit` security events of each of `accountIds` (optionally no older than `since`), newest
   * first across all of them — "row_number() over (partition by account_id order by at desc, id desc) <= limit".
   *
   * `accountIds` is never empty: the repository answers an empty ask without a query.
   */
  recentSecurityEvents(f: { accountIds: readonly string[]; limit: number; since: Date | undefined }): Promise<SecurityEventRow[]>;

  /**
   * Revokes the sessions named, each **at the moment it ran out** — `least(expires_at, absolute_expires_at,
   * now)` — with the reason `expired`. The value is computed per row by the server, which is one statement in
   * both databases and two different ones: an update pipeline (`$min`) on MongoDB, `LEAST(...)` on MySQL.
   * Returns how many rows were written.
   */
  revokeRanOut(ids: readonly string[], now: Date): Promise<number>;
}
