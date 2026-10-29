/**
 * The MongoDB half of identity's queries port (queries.ts): the pipeline and the update pipeline that were in
 * the repository before it became store-neutral. They are unchanged in meaning — the same stages, the same
 * order — and this file is deleted with MongoDB at the cutover (docs/10 §23 Y4).
 */
import type { ModuleStore } from '../../kernel/mongo/index.js';
import type { SecurityEventRow, SessionRow } from './ports.js';
import type { IdentityQueries } from './queries.js';

export function mongoIdentityQueries(store: ModuleStore): IdentityQueries {
  const securityEvents = store.table<SecurityEventRow>('security_events');
  const sessions = store.table<SessionRow>('sessions');

  return {
    async recentSecurityEvents({ accountIds, limit, since }): Promise<SecurityEventRow[]> {
      // the top `limit` per account ($documentNumber needs a single sort field on 6.0, the order here has two)
      const docs = await securityEvents.aggregate<Record<string, unknown>>([
        { $match: { account_id: { $in: [...accountIds] }, ...(since ? { at: { $gte: since } } : {}) } },
        { $group: { _id: '$account_id', top: { $topN: { n: limit, sortBy: { at: -1, _id: -1 }, output: '$$ROOT' } } } },
        { $unwind: '$top' },
        { $replaceRoot: { newRoot: '$top' } },
        { $sort: { at: -1, _id: -1 } },
      ]);
      return docs.map((d) => securityEvents.fromDoc(d));
    },

    /** revoked when it ran out: least(expires_at, absolute_expires_at, now) */
    revokeRanOut(ids: readonly string[], now: Date): Promise<number> {
      return sessions.updateMany({ id: { $in: [...ids] } }, [{ $set: { revoked_at: { $min: ['$expires_at', '$absolute_expires_at', now] }, revoke_reason: 'expired' } }]);
    },
  };
}
