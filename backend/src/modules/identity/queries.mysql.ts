/**
 * The MySQL half of identity's queries port (queries.ts).
 *
 * `recentSecurityEvents` is §13.1's "latest N rows per key": `ROW_NUMBER() OVER (PARTITION BY account_id
 * ORDER BY at DESC, id DESC)` in a CTE, which the index `identity_security_events (account_id, at DESC)`
 * orders without a filesort. It is Kysely rather than a `Table` read because a window function is not a
 * condition, and the rows come back through `fromRow` so the row conversion stays written once.
 *
 * `revokeRanOut` is the update pipeline's `$min` as `LEAST(...)`: an ordinary `updateMany` whose patch holds
 * an expression, so the server computes each row's value from the row it is writing and no read is needed.
 */
import { sql } from 'kysely';
import type { ModuleStore } from '../../kernel/mysql/module-store.js';
import { expr, q } from '../../kernel/mysql/table.js';
import type { IdentityTables } from '../../spec/identity.js';
import type { SecurityEventRow, SessionRow } from './ports.js';
import type { IdentityQueries } from './queries.js';

/** row_number() over the newest events of each account; `at DESC, id DESC` is the order the list is read in */
const RANK = sql<number>`ROW_NUMBER() OVER (PARTITION BY ${sql.ref('account_id')} ORDER BY ${sql.ref('at')} DESC, ${sql.ref('id')} DESC)`;

export function mysqlIdentityQueries(store: ModuleStore<IdentityTables>): IdentityQueries {
  const securityEvents = store.table<SecurityEventRow>('security_events');
  const sessions = store.table<SessionRow>('sessions');

  return {
    async recentSecurityEvents({ accountIds, limit, since }): Promise<SecurityEventRow[]> {
      const rows = await store.db
        .with('ranked', (qb) => {
          const base = qb.selectFrom('identity_security_events').selectAll().select(RANK.as('rn')).where('account_id', 'in', [...accountIds]);
          return since ? base.where('at', '>=', since) : base;
        })
        .selectFrom('ranked')
        .selectAll()
        .where('rn', '<=', limit)
        .orderBy('at', 'desc')
        .orderBy('id', 'desc')
        .execute();
      // `rn` is the window's own column and no column of the table: it is dropped before the row is built
      return rows.map(({ rn: _rn, ...row }) => securityEvents.fromRow(row));
    },

    /** revoked when it ran out: least(expires_at, absolute_expires_at, now) */
    revokeRanOut(ids: readonly string[], now: Date): Promise<number> {
      return sessions.updateMany({ id: [...ids] }, {
        revoked_at: expr((t) => `LEAST(${t}.${q('expires_at')}, ${t}.${q('absolute_expires_at')}, ?)`, [now]),
        revoke_reason: 'expired',
      });
    },
  };
}
