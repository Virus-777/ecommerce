/**
 * The MongoDB half of audit's queries port (queries.ts): the `$sort` + `$group $first` pipeline that was in the
 * repository before it became store-neutral. It is unchanged in meaning — the same stages, in the same order —
 * and this file is deleted with MongoDB at the cutover (docs/10 §23 Y4).
 */
import type { ModuleStore } from '../../kernel/mongo/index.js';
import type { AuditDb } from '../../spec/audit.js';
import type { ActorCount, AuditQueries } from './queries.js';

type EntryRow = AuditDb['entries'];

export function mongoAuditQueries(store: ModuleStore): AuditQueries {
  const entries = store.table<EntryRow>('entries');

  return {
    topActors({ from, to, limit }): Promise<ActorCount[]> {
      // one row per person (actor kind + id), named by their latest entry (a renamed person counts once)
      return entries.aggregate<ActorCount>([
        { $match: { at: { $gte: from, $lt: to }, actor_kind: 'staff' } },
        { $sort: { at: -1 } },
        { $group: { _id: { kind: '$actor_kind', id: '$actor_id' }, name: { $first: '$actor_name' }, n: { $sum: 1 } } },
        { $sort: { n: -1, '_id.id': 1 } },
        { $limit: limit },
        { $project: { _id: 0, id: '$_id.id', name: 1, n: 1 } },
      ]);
    },
  };
}
