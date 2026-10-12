import { decodeCursor, encodeCursor, type PageRequest } from '../../../../kernel/lib/pagination.js';
import type { ModuleStore } from '../../../../kernel/mongo/index.js';
import type { Filter } from '../../../../kernel/mongo/table.js';
import type { Page } from '../../../../spec/common.js';
import type { MediaDb } from '../../../../spec/media.js';
import type { AssetFilter, AssetPatch, AssetRow, MediaRepository, OwnerFilter, ProcessingJobRow, RenditionRow, UploadRow, UsageRow } from '../../ports.js';

type CounterRow = MediaDb['upload_counters'];
type Doc = Record<string, unknown>;

/** Storage objects of an asset whose files were erased (purge-deleted): storage_bucket is set to this */
export const ERASED_BUCKET = '';

/** check_result as jsonb kept it (JSON.stringify) */
const json = (v: unknown) => (v === undefined ? undefined : v === null ? null : (JSON.parse(JSON.stringify(v)) as never));
const escapeRegExp = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

const ownerWhere = (owner: OwnerFilter): Filter => ({ owner_kind: owner.kind, owner_id: owner.id });

const LIVE = ['pending_upload', 'processing', 'ready', 'removed'];

/** Hamming distance between two 64-bit perceptual hashes (bit_count(cast(a # b as bit(64)))) */
function hamming(a: number, b: number): number {
  let x = BigInt.asUintN(64, BigInt(a) ^ BigInt(b));
  let n = 0;
  while (x) {
    x &= x - 1n;
    n++;
  }
  return n;
}

/**
 * Conditions on an asset's usages (exists / not exists in SQL): the usages of each asset are looked up by the
 * indexed asset_id ($lookup, both collections are this module's), only the fields the condition needs.
 */
const USAGES = 'media.usages';
const lookupUsages = (as: string, fields: Doc = { detached_at: 1 }): Doc => ({ $lookup: { from: USAGES, localField: '_id', foreignField: 'asset_id', pipeline: [{ $project: fields }], as } });
/** No usage with detached_at null */
const noActiveUse = (as: string): Doc => ({ [as]: { $not: { $elemMatch: { detached_at: null } } } });
const activeUse = (as: string): Doc => ({ [as]: { $elemMatch: { detached_at: null } } });

/** MongoDB adapter for MediaRepository (docs/04-mongodb-migration.md): one collection per spec table; the files stay in storage. */
export function createMongoMediaRepository(store: ModuleStore): MediaRepository {
  const t = {
    assets: store.table<AssetRow>('assets'),
    renditions: store.table<RenditionRow>('renditions'),
    uploads: store.table<UploadRow>('uploads'),
    usages: store.table<UsageRow>('usages'),
    jobs: store.table<ProcessingJobRow>('processing_jobs'),
    counters: store.table<CounterRow>('upload_counters'),
  };

  /** Assets matching `filter` (row fields) and a condition on their usages, in `sort` order (document fields) */
  async function assetsWithUsages(filter: Filter, usage: Doc, sort: Record<string, 1 | -1>, o: { skip?: number; limit?: number; fields?: Doc } = {}): Promise<AssetRow[]> {
    const docs = await t.assets.aggregate<Doc>([
      { $match: t.assets.filter(filter) },
      { $sort: sort },
      lookupUsages('_u', o.fields),
      { $match: usage },
      ...(o.skip ? [{ $skip: o.skip }] : []),
      ...(o.limit !== undefined ? [{ $limit: o.limit }] : []),
      { $project: { _u: 0 } },
    ]);
    return docs.map((d) => t.assets.fromDoc(d));
  }

  /** Table.page for a filter that also needs the usages (created_at desc, id desc) */
  async function pageWithUsages(filter: Filter, usage: Doc, req: PageRequest): Promise<Page<AssetRow>> {
    const sort = { created_at: -1, _id: -1 } as const;
    const cursorOf = (r: AssetRow) => encodeCursor([r.created_at.toISOString(), r.id]);
    if (req.mode === 'page') {
      const [counted] = await t.assets.aggregate<{ n: number }>([{ $match: t.assets.filter(filter) }, lookupUsages('_u'), { $match: usage }, { $count: 'n' }]);
      const total = counted?.n ?? 0;
      const items = await assetsWithUsages(filter, usage, sort, { skip: (req.page - 1) * req.limit, limit: req.limit });
      const totalPages = Math.max(1, Math.ceil(total / req.limit));
      const last = items.at(-1);
      return { items, nextCursor: req.page < totalPages && last ? cursorOf(last) : null, page: req.page, totalPages, total };
    }
    let f = filter;
    if (req.cursor) {
      const [at, id] = decodeCursor(req.cursor);
      const v = new Date(at as string);
      f = { $and: [filter, { $or: [{ created_at: { $lt: v } }, { created_at: v, id: { $lt: id } }] }] };
    }
    const rows = await assetsWithUsages(f, usage, sort, { limit: req.limit + 1 });
    const items = rows.slice(0, req.limit);
    return { items, nextCursor: rows.length > req.limit ? cursorOf(items.at(-1)!) : null };
  }

  const repo: MediaRepository = {
    transaction: (fn) => store.transaction((tx) => fn(createMongoMediaRepository(tx))),

    /* ---------------------------------------------------------------- assets */

    insertAsset: (row) => t.assets.insert({ ...row, check_result: json(row.check_result ?? null) }),

    async getAsset(id, opts = {}) {
      return (await t.assets.findOne({ id, ...(opts.owner ? ownerWhere(opts.owner) : {}) }, { forUpdate: opts.forUpdate })) ?? null;
    },

    getAssets: (ids) => t.assets.getMany(ids),

    async updateAsset(id, patch: AssetPatch) {
      const { check_result, ...rest } = patch;
      const r = await t.assets.update(id, { ...rest, ...(check_result !== undefined ? { check_result: json(check_result) } : {}) });
      if (!r) throw new Error(`media: asset ${id} not found`);
      return r;
    },

    listAssets(f: AssetFilter, page) {
      const and: Filter[] = [];
      if (f.owner) and.push(ownerWhere(f.owner));
      if (f.ownerKind) and.push({ owner_kind: f.ownerKind });
      if (f.ownerId) and.push({ owner_id: f.ownerId });
      if (f.purpose) and.push({ purpose: f.purpose });
      if (f.kind) and.push({ kind: f.kind });
      if (f.statuses?.length) and.push({ status: { $in: f.statuses } });
      // (check_result->>'passed') = 'false'; coalesce(…, 'true') = 'true': passed, or no result
      if (f.failedChecks === true) and.push({ 'check_result.passed': false });
      if (f.failedChecks === false) and.push({ $or: [{ 'check_result.passed': true }, { 'check_result.passed': null }] });
      if (f.q?.trim()) {
        const term = { $regex: escapeRegExp(f.q.trim()), $options: 'i' };
        and.push({ $or: [{ file_name: term }, { title: term }, { alt: term }] });
      }
      const filter = and.length ? { $and: and } : {};
      if (f.inUse === undefined) return t.assets.page(filter, page, { column: 'created_at', direction: 'desc' });
      return pageWithUsages(filter, f.inUse ? activeUse('_u') : noActiveUse('_u'), page);
    },

    async findAssetByStorageKey(bucket, key) {
      return (await t.assets.findOne({ storage_bucket: bucket, storage_key: key })) ?? null;
    },

    async findDuplicate(owner, phash, asset) {
      const row = await t.assets.findOne(
        {
          ...ownerWhere(owner),
          phash,
          id: { $ne: asset.id },
          status: { $in: ['processing', 'ready', 'removed'] },
          $or: [{ created_at: { $lt: asset.createdAt } }, { created_at: asset.createdAt, id: { $lt: asset.id } }],
        },
        { sort: { created_at: 1 } },
      );
      return row?.id ?? null;
    },

    async similarImages(phash, f) {
      // MongoDB 6.0 has no bitwise XOR in queries: the candidates' hashes are read and the distance computed here
      const filter: Filter = {
        phash: { $ne: null },
        id: { $ne: f.excludeId },
        status: 'ready',
        kind: 'image',
        // private files (evidence, documents, originals of private purposes) are never offered
        visibility: 'public',
        ...(f.ownerKind ? { owner_kind: f.ownerKind } : {}),
        ...(f.ownerId ? { owner_id: f.ownerId } : {}),
      };
      const kinds = f.usageKinds?.length ? [...f.usageKinds] : null;
      const candidates = await t.assets.aggregate<{ _id: string; phash: number; created_at: Date }>([
        { $match: t.assets.filter(filter) },
        ...(kinds ? [lookupUsages('_u', { detached_at: 1, kind: 1 }), { $match: { _u: { $elemMatch: { detached_at: null, kind: { $in: kinds } } } } }] : []),
        { $project: { phash: 1, created_at: 1 } },
      ]);
      const near = candidates
        .map((c) => ({ id: c._id, created_at: c.created_at, distance: hamming(phash, Number(c.phash)) }))
        .filter((c) => c.distance <= f.maxDistance)
        .sort((a, b) => a.distance - b.distance || a.created_at.getTime() - b.created_at.getTime() || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0))
        .slice(0, f.limit);
      const rows = new Map((await t.assets.getMany(near.map((c) => c.id))).map((r) => [r.id, r]));
      return near.flatMap((c) => (rows.has(c.id) ? [{ asset: rows.get(c.id)!, distance: c.distance }] : []));
    },

    async storedBytes(owner) {
      const [r] = await t.assets.aggregate<{ n: number }>([{ $match: { ...ownerWhere(owner), status: { $in: LIVE } } }, { $group: { _id: null, n: { $sum: '$size_bytes' } } }]);
      return Number(r?.n ?? 0);
    },

    assetsOfOwner: (owner, statuses) => t.assets.find({ ...ownerWhere(owner), status: { $in: [...statuses] } }, { sort: { created_at: 1 } }),

    /* ---------------------------------------------------------------- job selections */

    pendingUploadsBefore: (cutoff, limit) => t.assets.find({ status: 'pending_upload', created_at: { $lt: cutoff } }, { sort: { created_at: 1 }, limit }),

    orphansToSweep(cutoff, now, excludePurposes, limit) {
      return assetsWithUsages(
        {
          status: { $in: ['ready', 'rejected'] },
          $or: [{ retain_until: null }, { retain_until: { $lte: now } }],
          ...(excludePurposes.length ? { purpose: { $nin: [...excludePurposes] } } : {}),
        },
        {
          $or: [
            // never attached to anything after the grace period
            { created_at: { $lt: cutoff }, _u: { $size: 0 } },
            // marked for deletion (seller or customer account closed) and no longer used
            { expires_at: { $ne: null, $lte: now }, ...noActiveUse('_u') },
          ],
        },
        { created_at: 1 },
        { limit },
      );
    },

    generatedExpired(now, purposes, limit) {
      return assetsWithUsages(
        { status: 'ready', purpose: { $in: [...purposes] }, expires_at: { $lte: now }, $or: [{ retain_until: null }, { retain_until: { $lte: now } }] },
        noActiveUse('_u'),
        { expires_at: 1 },
        { limit },
      );
    },

    deletedToErase: (cutoff, limit) =>
      t.assets.find(
        {
          status: { $in: ['deleted', 'expired'] },
          storage_bucket: { $ne: ERASED_BUCKET },
          $or: [{ deleted_at: { $lt: cutoff } }, { deleted_at: null, created_at: { $lt: cutoff } }],
        },
        { sort: { created_at: 1 }, limit },
      ),

    removedPastRetention: (now, limit) => t.assets.find({ status: 'removed', retain_until: { $ne: null, $lte: now } }, { sort: { retain_until: 1 }, limit }),

    async storageRefs(afterId, limit) {
      const rows = await t.assets.find({ storage_bucket: { $ne: ERASED_BUCKET }, ...(afterId ? { id: { $gt: afterId } } : {}) }, { sort: { id: 1 }, limit });
      return rows.map((r) => ({ id: r.id, status: r.status, bucket: r.storage_bucket, key: r.storage_key }));
    },

    /* ---------------------------------------------------------------- renditions */

    renditionsOf: (assetIds) => (assetIds.length ? t.renditions.find({ asset_id: { $in: [...assetIds] } }, { sort: { width: 1, format: 1 } }) : Promise.resolve([])),

    async saveRenditions(assetId, rows) {
      if (!rows.length) return;
      await t.renditions.upsertMany(
        rows.map((r) => ({ ...r, asset_id: assetId })),
        { key: ['asset_id', 'size', 'format'], update: (r) => ({ storage_key: r.storage_key, url: r.url, width: r.width, height: r.height, bytes: r.bytes }) },
      );
    },

    async deleteRenditions(assetId) {
      await t.renditions.deleteMany({ asset_id: assetId });
    },

    /* ---------------------------------------------------------------- uploads */

    insertUpload: (row) => t.uploads.insert(row),

    async getUpload(id, opts = {}) {
      return (await t.uploads.get(id, { forUpdate: opts.forUpdate })) ?? null;
    },

    async uploadOfAsset(assetId) {
      return (await t.uploads.findOne({ asset_id: assetId }, { sort: { url_expires_at: -1 } })) ?? null;
    },

    async completeUpload(id, at) {
      await t.uploads.updateMany({ id, completed_at: null }, { completed_at: at });
    },

    /* ---------------------------------------------------------------- usages */

    usagesOf: (assetIds, opts = {}) =>
      assetIds.length ? t.usages.find({ asset_id: { $in: [...assetIds] }, ...(opts.activeOnly ? { detached_at: null } : {}) }, { sort: { attached_at: 1, id: 1 } }) : Promise.resolve([]),

    async activeUsage(assetId, u) {
      return (await t.usages.findOne({ asset_id: assetId, module: u.module, kind: u.kind, ref_id: u.refId, detached_at: null })) ?? null;
    },

    insertUsage: (row) => t.usages.insert(row),

    async updateUsage(id, patch) {
      await t.usages.update(id, patch);
    },

    /* ---------------------------------------------------------------- processing */

    async insertProcessingJob(row) {
      await t.jobs.insert(row);
    },

    async claimProcessingJobs(now, leaseUntil, limit) {
      // each claim is one atomic update of the oldest due job, so concurrent workers never
      // claim the same job (a claimed job's next_attempt_at is its lease, past now)
      const claimed: ProcessingJobRow[] = [];
      while (claimed.length < limit) {
        const job = await t.jobs.updateOne(
          { status: { $in: ['queued', 'running'] }, $or: [{ next_attempt_at: null }, { next_attempt_at: { $lte: now } }] },
          { $set: { status: 'running', next_attempt_at: leaseUntil }, $inc: { attempts: 1 } },
          { sort: { created_at: 1 } },
        );
        if (!job) break;
        claimed.push(job);
      }
      return claimed;
    },

    async updateProcessingJob(id, patch) {
      await t.jobs.update(id, patch);
    },

    async processingJobByProviderRef(ref) {
      return (await t.jobs.findOne({ provider_ref: ref }, { sort: { created_at: -1 } })) ?? null;
    },

    processingJobsOf: (assetId) => t.jobs.find({ asset_id: assetId }, { sort: { created_at: 1 } }),

    /* ---------------------------------------------------------------- counters */

    async uploadCount(owner, day) {
      return (await t.counters.findOne({ owner_kind: owner.kind, owner_id: owner.id ?? '', day }))?.count ?? 0;
    },

    async bumpUploadCounter(owner, day, bytes) {
      // on conflict do update count + 1, bytes + excluded.bytes: one atomic upsert
      await t.counters.model.updateOne(
        { owner_kind: owner.kind, owner_id: owner.id ?? '', day },
        { $inc: { count: 1, bytes } },
        { upsert: true, session: t.counters.session },
      );
    },
  };
  return repo;
}
