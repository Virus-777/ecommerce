/**
 * The MySQL half of media's queries port (queries.ts). The `$lookup`s of the MongoDB side are `EXISTS`
 * subqueries on `media_usages`, which is the shape §13.1 gives a lookup used as a filter, and the index
 * `media_usages (asset_id, detached_at)` answers them.
 *
 * Two of the four are a `Table` read with one extra condition, so the paging, the keyset cursor and the row
 * conversion stay where they are written once (`ReadOptions.and`, §10.5). The candidate scan is Kysely,
 * because it wants three columns of possibly many thousands of rows and `Table` reads whole rows.
 */
import { raw, type Sql } from '../../kernel/mysql/where.js';
import type { ModuleStore } from '../../kernel/mysql/module-store.js';
import type { PageRequest } from '../../kernel/lib/pagination.js';
import type { Page } from '../../spec/common.js';
import type { MediaTables } from '../../spec/media.js';
import type { AssetRow } from './ports.js';
import type { MediaQueries, PhashCandidate, UsageState } from './queries.js';

/** `media_assets` is not aliased in a `Table` read, so the correlation names the table itself */
const usagesOfRow = (and = ''): string => `SELECT 1 FROM \`media_usages\` u WHERE u.\`asset_id\` = \`media_assets\`.\`id\`${and}`;
const ACTIVE_USAGE: Sql = raw(`EXISTS (${usagesOfRow(' AND u.`detached_at` IS NULL')})`);
const NO_ACTIVE_USAGE: Sql = raw(`NOT EXISTS (${usagesOfRow(' AND u.`detached_at` IS NULL')})`);
const NEVER_ATTACHED: Sql = raw(`NOT EXISTS (${usagesOfRow()})`);

export function mysqlMediaQueries(store: ModuleStore<MediaTables>): MediaQueries {
  const assets = store.table<AssetRow>('assets');

  return {
    pageByUsage(where, state: UsageState, req: PageRequest): Promise<Page<AssetRow>> {
      return assets.page(where, req, { column: 'created_at', direction: 'desc' }, { and: state === 'active' ? ACTIVE_USAGE : NO_ACTIVE_USAGE });
    },

    orphans({ cutoff, now, excludePurposes, limit }) {
      return assets.find(
        {
          status: ['ready', 'rejected'],
          // an empty `not in` leaves the column unfiltered, which is what "exclude none of them" means
          purpose: { op: 'not in', value: [...excludePurposes] },
          or: [{ retain_until: null }, { retain_until: { op: '<=', value: now } }],
        },
        {
          // never attached after the grace period, or marked for deletion and no longer in use. The two
          // halves each mix an asset column with a usage condition, which is why this is one fragment
          and: raw(`((\`media_assets\`.\`created_at\` < ? AND ${NEVER_ATTACHED.sql}) OR (\`media_assets\`.\`expires_at\` IS NOT NULL AND \`media_assets\`.\`expires_at\` <= ? AND ${NO_ACTIVE_USAGE.sql}))`, [cutoff, now]),
          sort: { created_at: 1 },
          limit,
        },
      );
    },

    expiredGenerated({ now, purposes, limit }) {
      return assets.find(
        {
          status: 'ready',
          purpose: [...purposes],
          expires_at: { op: '<=', value: now },
          or: [{ retain_until: null }, { retain_until: { op: '<=', value: now } }],
        },
        { and: NO_ACTIVE_USAGE, sort: { expires_at: 1 }, limit },
      );
    },

    async phashCandidates(f): Promise<PhashCandidate[]> {
      const kinds = f.usageKinds?.length ? [...f.usageKinds] : null;
      let q = store.db
        .selectFrom('media_assets')
        .select(['id', 'phash', 'created_at'])
        .where('phash', 'is not', null)
        .where('id', '<>', f.excludeId)
        .where('status', '=', 'ready')
        .where('kind', '=', 'image')
        // private files (evidence, documents, originals of private purposes) are never offered
        .where('visibility', '=', 'public');
      if (f.ownerKind) q = q.where('owner_kind', '=', f.ownerKind);
      if (f.ownerId) q = q.where('owner_id', '=', f.ownerId);
      if (kinds)
        q = q.where(({ exists, selectFrom }) =>
          exists(
            selectFrom('media_usages')
              .select('media_usages.id')
              .whereRef('media_usages.asset_id', '=', 'media_assets.id')
              .where('media_usages.detached_at', 'is', null)
              .where('media_usages.kind', 'in', kinds),
          ),
        );
      const rows = await q.execute();
      return rows.map((r) => ({ id: r.id, phash: Number(r.phash), created_at: r.created_at }));
    },
  };
}
