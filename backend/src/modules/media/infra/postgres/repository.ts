import { sql, type ExpressionBuilder, type Kysely } from 'kysely';
import { paginate } from '../../../../kernel/lib/pagination.js';
import type { MediaDb } from '../../../../spec/media.js';
import type { AssetFilter, AssetPatch, AssetRow, MediaRepository, OwnerFilter } from '../../ports.js';

/** Storage objects of an asset whose files were erased (purge-deleted): storage_bucket is set to this */
export const ERASED_BUCKET = '';

const json = (v: unknown) => (v === undefined ? undefined : v === null ? null : JSON.stringify(v));

const ownerWhere = (owner: OwnerFilter) =>
  owner.id === null
    ? sql<boolean>`owner_kind = ${owner.kind} and owner_id is null`
    : sql<boolean>`owner_kind = ${owner.kind} and owner_id = ${owner.id}`;

const LIVE = ['pending_upload', 'processing', 'ready', 'removed'];

type AssetsEb = ExpressionBuilder<MediaDb, 'assets'>;
/** The asset has a usage (ever, or still active) */
const everUsed = (eb: AssetsEb) => eb.exists(eb.selectFrom('usages').select('usages.id').whereRef('usages.asset_id', '=', 'assets.id'));
const activeUse = (eb: AssetsEb) =>
  eb.exists(eb.selectFrom('usages').select('usages.id').whereRef('usages.asset_id', '=', 'assets.id').where('usages.detached_at', 'is', null));

/** Postgres adapter for MediaRepository. `db` is scoped to the `media` schema. */
export function createPostgresMediaRepository(db: Kysely<MediaDb>): MediaRepository {
  const repo: MediaRepository = {
    transaction: (fn) => (db.isTransaction ? fn(repo) : db.transaction().execute((trx) => fn(createPostgresMediaRepository(trx)))),

    /* ---------------------------------------------------------------- assets */

    async insertAsset(row) {
      return (await db
        .insertInto('assets')
        .values({ ...row, check_result: json(row.check_result ?? null) as never })
        .returningAll()
        .executeTakeFirstOrThrow()) as AssetRow;
    },

    async getAsset(id, opts = {}) {
      let q = db.selectFrom('assets').selectAll().where('id', '=', id);
      if (opts.owner) q = q.where(ownerWhere(opts.owner));
      if (opts.forUpdate) q = q.forUpdate();
      return ((await q.executeTakeFirst()) as AssetRow | undefined) ?? null;
    },

    async getAssets(ids) {
      if (!ids.length) return [];
      return (await db.selectFrom('assets').selectAll().where('id', 'in', [...ids]).execute()) as AssetRow[];
    },

    async updateAsset(id, patch: AssetPatch) {
      const { check_result, ...rest } = patch;
      const values = { ...rest, ...(check_result !== undefined ? { check_result: json(check_result) as never } : {}) };
      return (await db.updateTable('assets').set(values).where('id', '=', id).returningAll().executeTakeFirstOrThrow()) as AssetRow;
    },

    async listAssets(f: AssetFilter, page) {
      let q = db.selectFrom('assets').selectAll();
      if (f.owner) q = q.where(ownerWhere(f.owner));
      if (f.ownerKind) q = q.where('owner_kind', '=', f.ownerKind);
      if (f.ownerId) q = q.where('owner_id', '=', f.ownerId);
      if (f.purpose) q = q.where('purpose', '=', f.purpose);
      if (f.kind) q = q.where('kind', '=', f.kind);
      if (f.statuses?.length) q = q.where('status', 'in', f.statuses);
      if (f.inUse !== undefined) q = q.where((eb) => (f.inUse ? activeUse(eb) : eb.not(activeUse(eb))));
      if (f.failedChecks === true) q = q.where(sql<boolean>`(check_result->>'passed') = 'false'`);
      if (f.failedChecks === false) q = q.where(sql<boolean>`coalesce(check_result->>'passed', 'true') = 'true'`);
      if (f.q?.trim()) {
        const like = `%${f.q.trim().replace(/[\\%_]/g, (c) => `\\${c}`)}%`;
        q = q.where((eb) => eb.or([eb('file_name', 'ilike', like), eb('title', 'ilike', like), eb('alt', 'ilike', like)]));
      }
      return (await paginate(q, page, { column: 'created_at', direction: 'desc' })) as never;
    },

    async findAssetByStorageKey(bucket, key) {
      return ((await db.selectFrom('assets').selectAll().where('storage_bucket', '=', bucket).where('storage_key', '=', key).executeTakeFirst()) as AssetRow | undefined) ?? null;
    },

    async findDuplicate(owner, phash, asset) {
      const row = await db
        .selectFrom('assets')
        .select('id')
        .where(ownerWhere(owner))
        .where('phash', '=', phash)
        .where('id', '!=', asset.id)
        .where((eb) => eb.or([eb('created_at', '<', asset.createdAt), eb.and([eb('created_at', '=', asset.createdAt), eb('id', '<', asset.id)])]))
        .where('status', 'in', ['processing', 'ready', 'removed'])
        .orderBy('created_at')
        .executeTakeFirst();
      return row?.id ?? null;
    },

    async similarImages(phash, f) {
      // Hamming distance between the 64-bit perceptual hashes
      const distance = sql<number>`bit_count(cast(phash # ${phash}::bigint as bit(64)))::int`;
      let q = db
        .selectFrom('assets')
        .selectAll()
        .select(distance.as('distance'))
        .where('phash', 'is not', null)
        .where('id', '!=', f.excludeId)
        .where('status', '=', 'ready')
        .where('kind', '=', 'image')
        // private files (evidence, documents, originals of private purposes) are never offered
        .where('visibility', '=', 'public')
        .where(sql<boolean>`${distance} <= ${f.maxDistance}`);
      if (f.ownerKind) q = q.where('owner_kind', '=', f.ownerKind);
      if (f.ownerId) q = q.where('owner_id', '=', f.ownerId);
      if (f.usageKinds?.length) {
        const kinds = [...f.usageKinds];
        q = q.where((eb) =>
          eb.exists(eb.selectFrom('usages').select('usages.id').whereRef('usages.asset_id', '=', 'assets.id').where('usages.detached_at', 'is', null).where('usages.kind', 'in', kinds)),
        );
      }
      const rows = await q.orderBy(distance).orderBy('created_at').orderBy('id').limit(f.limit).execute();
      return rows.map((r) => {
        const { distance: d, ...asset } = r as typeof r & { distance: number };
        return { asset: asset as AssetRow, distance: Number(d) };
      });
    },

    async storedBytes(owner) {
      const row = await db
        .selectFrom('assets')
        .select(sql<number>`coalesce(sum(size_bytes), 0)::bigint`.as('n'))
        .where(ownerWhere(owner))
        .where('status', 'in', LIVE)
        .executeTakeFirst();
      return Number(row?.n ?? 0);
    },

    async assetsOfOwner(owner, statuses) {
      return (await db.selectFrom('assets').selectAll().where(ownerWhere(owner)).where('status', 'in', [...statuses]).orderBy('created_at').execute()) as AssetRow[];
    },

    /* ---------------------------------------------------------------- job selections */

    async pendingUploadsBefore(cutoff, limit) {
      return (await db.selectFrom('assets').selectAll().where('status', '=', 'pending_upload').where('created_at', '<', cutoff).orderBy('created_at').limit(limit).execute()) as AssetRow[];
    },

    async orphansToSweep(cutoff, now, excludePurposes, limit) {
      let q = db
        .selectFrom('assets')
        .selectAll()
        .where('status', 'in', ['ready', 'rejected'])
        .where((eb) => eb.or([eb('retain_until', 'is', null), eb('retain_until', '<=', now)]))
        .where((eb) =>
          eb.or([
            // never attached to anything after the grace period
            eb.and([eb('created_at', '<', cutoff), eb.not(everUsed(eb))]),
            // marked for deletion (seller or customer account closed) and no longer used
            eb.and([eb('expires_at', 'is not', null), eb('expires_at', '<=', now), eb.not(activeUse(eb))]),
          ]),
        );
      if (excludePurposes.length) q = q.where('purpose', 'not in', [...excludePurposes]);
      return (await q.orderBy('created_at').limit(limit).execute()) as AssetRow[];
    },

    async generatedExpired(now, purposes, limit) {
      return (await db
        .selectFrom('assets')
        .selectAll()
        .where('status', '=', 'ready')
        .where('purpose', 'in', [...purposes])
        .where('expires_at', '<=', now)
        .where((eb) => eb.or([eb('retain_until', 'is', null), eb('retain_until', '<=', now)]))
        .where((eb) => eb.not(activeUse(eb)))
        .orderBy('expires_at')
        .limit(limit)
        .execute()) as AssetRow[];
    },

    async deletedToErase(cutoff, limit) {
      return (await db
        .selectFrom('assets')
        .selectAll()
        .where('status', 'in', ['deleted', 'expired'])
        .where('storage_bucket', '!=', ERASED_BUCKET)
        .where((eb) => eb.or([eb('deleted_at', '<', cutoff), eb.and([eb('deleted_at', 'is', null), eb('created_at', '<', cutoff)])]))
        .orderBy('created_at')
        .limit(limit)
        .execute()) as AssetRow[];
    },

    async removedPastRetention(now, limit) {
      return (await db.selectFrom('assets').selectAll().where('status', '=', 'removed').where('retain_until', 'is not', null).where('retain_until', '<=', now).orderBy('retain_until').limit(limit).execute()) as AssetRow[];
    },

    async storageRefs(afterId, limit) {
      let q = db.selectFrom('assets').select(['id', 'status', 'storage_bucket as bucket', 'storage_key as key']).where('storage_bucket', '!=', ERASED_BUCKET);
      if (afterId) q = q.where('id', '>', afterId);
      return await q.orderBy('id').limit(limit).execute();
    },

    /* ---------------------------------------------------------------- renditions */

    async renditionsOf(assetIds) {
      if (!assetIds.length) return [];
      return await db.selectFrom('renditions').selectAll().where('asset_id', 'in', [...assetIds]).orderBy('width').orderBy('format').execute();
    },

    async saveRenditions(assetId, rows) {
      if (!rows.length) return;
      await db
        .insertInto('renditions')
        .values(rows.map((r) => ({ ...r, asset_id: assetId })))
        .onConflict((oc) =>
          oc.columns(['asset_id', 'size', 'format']).doUpdateSet((eb) => ({
            storage_key: eb.ref('excluded.storage_key'),
            url: eb.ref('excluded.url'),
            width: eb.ref('excluded.width'),
            height: eb.ref('excluded.height'),
            bytes: eb.ref('excluded.bytes'),
          })),
        )
        .execute();
    },

    async deleteRenditions(assetId) {
      await db.deleteFrom('renditions').where('asset_id', '=', assetId).execute();
    },

    /* ---------------------------------------------------------------- uploads */

    async insertUpload(row) {
      return await db.insertInto('uploads').values(row).returningAll().executeTakeFirstOrThrow();
    },

    async getUpload(id, opts = {}) {
      let q = db.selectFrom('uploads').selectAll().where('id', '=', id);
      if (opts.forUpdate) q = q.forUpdate();
      return (await q.executeTakeFirst()) ?? null;
    },

    async uploadOfAsset(assetId) {
      return (await db.selectFrom('uploads').selectAll().where('asset_id', '=', assetId).orderBy('url_expires_at', 'desc').executeTakeFirst()) ?? null;
    },

    async completeUpload(id, at) {
      await db.updateTable('uploads').set({ completed_at: at }).where('id', '=', id).where('completed_at', 'is', null).execute();
    },

    /* ---------------------------------------------------------------- usages */

    async usagesOf(assetIds, opts = {}) {
      if (!assetIds.length) return [];
      let q = db.selectFrom('usages').selectAll().where('asset_id', 'in', [...assetIds]);
      if (opts.activeOnly) q = q.where('detached_at', 'is', null);
      return await q.orderBy('attached_at').orderBy('id').execute();
    },

    async activeUsage(assetId, u) {
      return (
        (await db
          .selectFrom('usages')
          .selectAll()
          .where('asset_id', '=', assetId)
          .where('module', '=', u.module)
          .where('kind', '=', u.kind)
          .where('ref_id', '=', u.refId)
          .where('detached_at', 'is', null)
          .executeTakeFirst()) ?? null
      );
    },

    async insertUsage(row) {
      return await db.insertInto('usages').values(row).returningAll().executeTakeFirstOrThrow();
    },

    async updateUsage(id, patch) {
      await db.updateTable('usages').set(patch).where('id', '=', id).execute();
    },

    /* ---------------------------------------------------------------- processing */

    async insertProcessingJob(row) {
      await db.insertInto('processing_jobs').values(row).execute();
    },

    async claimProcessingJobs(now, leaseUntil, limit) {
      return await db
        .updateTable('processing_jobs')
        .set((eb) => ({ status: 'running', attempts: eb('attempts', '+', 1), next_attempt_at: leaseUntil }))
        .where(
          'id',
          'in',
          db
            .selectFrom('processing_jobs')
            .select('id')
            // queued and due, or running past its lease (the worker stopped mid-job)
            .where('status', 'in', ['queued', 'running'])
            .where((eb) => eb.or([eb('next_attempt_at', 'is', null), eb('next_attempt_at', '<=', now)]))
            .orderBy('created_at')
            .limit(limit)
            .forUpdate()
            .skipLocked(),
        )
        .returningAll()
        .execute();
    },

    async updateProcessingJob(id, patch) {
      await db.updateTable('processing_jobs').set(patch).where('id', '=', id).execute();
    },

    async processingJobByProviderRef(ref) {
      return (await db.selectFrom('processing_jobs').selectAll().where('provider_ref', '=', ref).orderBy('created_at', 'desc').executeTakeFirst()) ?? null;
    },

    async processingJobsOf(assetId) {
      return await db.selectFrom('processing_jobs').selectAll().where('asset_id', '=', assetId).orderBy('created_at').execute();
    },

    /* ---------------------------------------------------------------- counters */

    async uploadCount(owner, day) {
      const row = await db
        .selectFrom('upload_counters')
        .select('count')
        .where('owner_kind', '=', owner.kind)
        .where('owner_id', '=', owner.id ?? '')
        .where('day', '=', day)
        .executeTakeFirst();
      return row?.count ?? 0;
    },

    async bumpUploadCounter(owner, day, bytes) {
      await db
        .insertInto('upload_counters')
        .values({ owner_kind: owner.kind, owner_id: owner.id ?? '', day, count: 1, bytes })
        .onConflict((oc) =>
          oc.columns(['owner_kind', 'owner_id', 'day']).doUpdateSet({
            count: sql`upload_counters.count + 1`,
            bytes: sql`upload_counters.bytes + excluded.bytes`,
          }),
        )
        .execute();
    },
  };
  return repo;
}
