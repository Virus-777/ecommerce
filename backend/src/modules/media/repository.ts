import { decodeCursor, encodeCursor, type PageRequest } from '../../kernel/lib/pagination.js';
import { contains, type ModuleStore } from '../../kernel/mongo/index.js';
import type { Filter } from '../../kernel/mongo/table.js';
import type { Page } from '../../spec/common.js';
import type { MediaDb } from '../../spec/media.js';
import type { AssetFilter, AssetPatch, AssetRow, OwnerFilter, ProcessingJobRow, RenditionRow, UploadRow, UsageRow } from './ports.js';

type CounterRow = MediaDb['upload_counters'];
type Doc = Record<string, unknown>;

/** Storage objects of an asset whose files were erased (purge-deleted): storage_bucket is set to this */
export const ERASED_BUCKET = '';

/** check_result stored as plain JSON (dates inside become strings, the way the service reads them back) */
const json = (v: unknown) => (v === undefined ? undefined : v === null ? null : (JSON.parse(JSON.stringify(v)) as never));

const ownerWhere = (owner: OwnerFilter): Filter => ({ owner_kind: owner.kind, owner_id: owner.id });

const LIVE = ['pending_upload', 'processing', 'ready', 'removed'];

/** Hamming distance between two 64-bit perceptual hashes (the number of differing bits) */
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
 * Conditions on an asset's usages (has / has no active usage): the usages of each asset are looked up by the
 * indexed asset_id ($lookup, both collections are this module's), only the fields the condition needs.
 */
const USAGES = 'media.usages';
const lookupUsages = (as: string, fields: Doc = { detached_at: 1 }): Doc => ({ $lookup: { from: USAGES, localField: '_id', foreignField: 'asset_id', pipeline: [{ $project: fields }], as } });
/** No usage with detached_at null */
const noActiveUse = (as: string): Doc => ({ [as]: { $not: { $elemMatch: { detached_at: null } } } });
const activeUse = (as: string): Doc => ({ [as]: { $elemMatch: { detached_at: null } } });

/** media.assets, renditions, uploads, usages, processing_jobs, upload_counters (the files themselves stay in storage) */
export class MediaRepository {
  readonly #t;

  constructor(private readonly store: ModuleStore) {
    this.#t = {
      assets: store.table<AssetRow>('assets'),
      renditions: store.table<RenditionRow>('renditions'),
      uploads: store.table<UploadRow>('uploads'),
      usages: store.table<UsageRow>('usages'),
      jobs: store.table<ProcessingJobRow>('processing_jobs'),
      counters: store.table<CounterRow>('upload_counters'),
    };
  }

  /** Runs fn with a repository bound to one transaction */
  transaction<T>(fn: (tx: MediaRepository) => Promise<T>): Promise<T> {
    return this.store.transaction((tx) => fn(new MediaRepository(tx)));
  }

  /** Assets matching `filter` (row fields) and a condition on their usages, in `sort` order (document fields) */
  async #assetsWithUsages(filter: Filter, usage: Doc, sort: Record<string, 1 | -1>, o: { skip?: number; limit?: number; fields?: Doc } = {}): Promise<AssetRow[]> {
    const assets = this.#t.assets;
    const docs = await assets.aggregate<Doc>([
      { $match: assets.filter(filter) },
      { $sort: sort },
      lookupUsages('_u', o.fields),
      { $match: usage },
      ...(o.skip ? [{ $skip: o.skip }] : []),
      ...(o.limit !== undefined ? [{ $limit: o.limit }] : []),
      { $project: { _u: 0 } },
    ]);
    return docs.map((d) => assets.fromDoc(d));
  }

  /** Table.page for a filter that also needs the usages (created_at desc, id desc) */
  async #pageWithUsages(filter: Filter, usage: Doc, req: PageRequest): Promise<Page<AssetRow>> {
    const sort = { created_at: -1, _id: -1 } as const;
    const cursorOf = (r: AssetRow) => encodeCursor([r.created_at.toISOString(), r.id]);
    if (req.mode === 'page') {
      const [counted] = await this.#t.assets.aggregate<{ n: number }>([{ $match: this.#t.assets.filter(filter) }, lookupUsages('_u'), { $match: usage }, { $count: 'n' }]);
      const total = counted?.n ?? 0;
      const items = await this.#assetsWithUsages(filter, usage, sort, { skip: (req.page - 1) * req.limit, limit: req.limit });
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
    const rows = await this.#assetsWithUsages(f, usage, sort, { limit: req.limit + 1 });
    const items = rows.slice(0, req.limit);
    return { items, nextCursor: rows.length > req.limit ? cursorOf(items.at(-1)!) : null };
  }

  /* ---------------------------------------------------------------- assets */

  insertAsset(row: Omit<AssetRow, 'check_result'> & { check_result?: unknown }): Promise<AssetRow> {
    return this.#t.assets.insert({ ...row, check_result: json(row.check_result ?? null) });
  }

  async getAsset(id: string, opts: { owner?: OwnerFilter; forUpdate?: boolean } = {}): Promise<AssetRow | null> {
    return (await this.#t.assets.findOne({ id, ...(opts.owner ? ownerWhere(opts.owner) : {}) }, { forUpdate: opts.forUpdate })) ?? null;
  }

  getAssets(ids: readonly string[]): Promise<AssetRow[]> {
    return this.#t.assets.getMany(ids);
  }

  async updateAsset(id: string, patch: AssetPatch): Promise<AssetRow> {
    const { check_result, ...rest } = patch;
    const r = await this.#t.assets.update(id, { ...rest, ...(check_result !== undefined ? { check_result: json(check_result) } : {}) });
    if (!r) throw new Error(`media: asset ${id} not found`);
    return r;
  }

  listAssets(f: AssetFilter, page: PageRequest): Promise<Page<AssetRow>> {
    const and: Filter[] = [];
    if (f.owner) and.push(ownerWhere(f.owner));
    if (f.ownerKind) and.push({ owner_kind: f.ownerKind });
    if (f.ownerId) and.push({ owner_id: f.ownerId });
    if (f.purpose) and.push({ purpose: f.purpose });
    if (f.kind) and.push({ kind: f.kind });
    if (f.statuses?.length) and.push({ status: { $in: f.statuses } });
    // failed: the check result says passed false; not failed: passed, or no result yet
    if (f.failedChecks === true) and.push({ 'check_result.passed': false });
    if (f.failedChecks === false) and.push({ $or: [{ 'check_result.passed': true }, { 'check_result.passed': null }] });
    if (f.q?.trim()) {
      const term = contains(f.q);
      and.push({ $or: [{ file_name: term }, { title: term }, { alt: term }] });
    }
    const filter = and.length ? { $and: and } : {};
    if (f.inUse === undefined) return this.#t.assets.page(filter, page, { column: 'created_at', direction: 'desc' });
    return this.#pageWithUsages(filter, f.inUse ? activeUse('_u') : noActiveUse('_u'), page);
  }

  async findAssetByStorageKey(bucket: string, key: string): Promise<AssetRow | null> {
    return (await this.#t.assets.findOne({ storage_bucket: bucket, storage_key: key })) ?? null;
  }

  /** An earlier live asset of the same owner with this perceptual hash */
  async findDuplicate(owner: OwnerFilter, phash: number, asset: { id: string; createdAt: Date }): Promise<string | null> {
    const row = await this.#t.assets.findOne(
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
  }

  /**
   * Ready public images whose perceptual hash is within maxDistance (Hamming) of phash, closest first. Private
   * files are never returned. usageKinds: only images with an active usage of one of these kinds.
   */
  async similarImages(
    phash: number,
    f: { excludeId: string; maxDistance: number; limit: number; ownerKind?: string; ownerId?: string; usageKinds?: readonly string[] },
  ): Promise<{ asset: AssetRow; distance: number }[]> {
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
    const candidates = await this.#t.assets.aggregate<{ _id: string; phash: number; created_at: Date }>([
      { $match: this.#t.assets.filter(filter) },
      ...(kinds ? [lookupUsages('_u', { detached_at: 1, kind: 1 }), { $match: { _u: { $elemMatch: { detached_at: null, kind: { $in: kinds } } } } }] : []),
      { $project: { phash: 1, created_at: 1 } },
    ]);
    const near = candidates
      .map((c) => ({ id: c._id, created_at: c.created_at, distance: hamming(phash, Number(c.phash)) }))
      .filter((c) => c.distance <= f.maxDistance)
      .sort((a, b) => a.distance - b.distance || a.created_at.getTime() - b.created_at.getTime() || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0))
      .slice(0, f.limit);
    const rows = new Map((await this.#t.assets.getMany(near.map((c) => c.id))).map((r) => [r.id, r]));
    return near.flatMap((c) => (rows.has(c.id) ? [{ asset: rows.get(c.id)!, distance: c.distance }] : []));
  }

  /** Bytes an owner stores (live files), for the storage quota */
  async storedBytes(owner: OwnerFilter): Promise<number> {
    const [r] = await this.#t.assets.aggregate<{ n: number }>([{ $match: { ...ownerWhere(owner), status: { $in: LIVE } } }, { $group: { _id: null, n: { $sum: '$size_bytes' } } }]);
    return Number(r?.n ?? 0);
  }

  /** Assets of one owner in the given statuses (account and seller closure) */
  assetsOfOwner(owner: OwnerFilter, statuses: readonly string[]): Promise<AssetRow[]> {
    return this.#t.assets.find({ ...ownerWhere(owner), status: { $in: [...statuses] } }, { sort: { created_at: 1 } });
  }

  /* ---------------------------------------------------------------- job selections, oldest first, bounded */

  pendingUploadsBefore(cutoff: Date, limit: number): Promise<AssetRow[]> {
    return this.#t.assets.find({ status: 'pending_upload', created_at: { $lt: cutoff } }, { sort: { created_at: 1 }, limit });
  }

  /** Ready or rejected, never attached to anything, older than cutoff; or marked for deletion (expires_at passed) and no longer used */
  orphansToSweep(cutoff: Date, now: Date, excludePurposes: readonly string[], limit: number): Promise<AssetRow[]> {
    return this.#assetsWithUsages(
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
  }

  generatedExpired(now: Date, purposes: readonly string[], limit: number): Promise<AssetRow[]> {
    return this.#assetsWithUsages(
      { status: 'ready', purpose: { $in: [...purposes] }, expires_at: { $lte: now }, $or: [{ retain_until: null }, { retain_until: { $lte: now } }] },
      noActiveUse('_u'),
      { expires_at: 1 },
      { limit },
    );
  }

  /** Deleted before cutoff whose storage objects still exist */
  deletedToErase(cutoff: Date, limit: number): Promise<AssetRow[]> {
    return this.#t.assets.find(
      {
        status: { $in: ['deleted', 'expired'] },
        storage_bucket: { $ne: ERASED_BUCKET },
        $or: [{ deleted_at: { $lt: cutoff } }, { deleted_at: null, created_at: { $lt: cutoff } }],
      },
      { sort: { created_at: 1 }, limit },
    );
  }

  /** Removed evidence whose retention has passed */
  removedPastRetention(now: Date, limit: number): Promise<AssetRow[]> {
    return this.#t.assets.find({ status: 'removed', retain_until: { $ne: null, $lte: now } }, { sort: { retain_until: 1 }, limit });
  }

  /** Storage objects the assets know about, in pages (keyset on id) */
  async storageRefs(afterId: string | null, limit: number): Promise<{ id: string; status: string; bucket: string; key: string }[]> {
    const rows = await this.#t.assets.find({ storage_bucket: { $ne: ERASED_BUCKET }, ...(afterId ? { id: { $gt: afterId } } : {}) }, { sort: { id: 1 }, limit });
    return rows.map((r) => ({ id: r.id, status: r.status, bucket: r.storage_bucket, key: r.storage_key }));
  }

  /* ---------------------------------------------------------------- renditions */

  async renditionsOf(assetIds: readonly string[]): Promise<RenditionRow[]> {
    if (!assetIds.length) return [];
    return this.#t.renditions.find({ asset_id: { $in: [...assetIds] } }, { sort: { width: 1, format: 1 } });
  }

  async saveRenditions(assetId: string, rows: readonly RenditionRow[]): Promise<void> {
    if (!rows.length) return;
    await this.#t.renditions.upsertMany(
      rows.map((r) => ({ ...r, asset_id: assetId })),
      { key: ['asset_id', 'size', 'format'], update: (r) => ({ storage_key: r.storage_key, url: r.url, width: r.width, height: r.height, bytes: r.bytes }) },
    );
  }

  async deleteRenditions(assetId: string): Promise<void> {
    await this.#t.renditions.deleteMany({ asset_id: assetId });
  }

  /* ---------------------------------------------------------------- uploads */

  insertUpload(row: UploadRow): Promise<UploadRow> {
    return this.#t.uploads.insert(row);
  }

  async getUpload(id: string, opts: { forUpdate?: boolean } = {}): Promise<UploadRow | null> {
    return (await this.#t.uploads.get(id, { forUpdate: opts.forUpdate })) ?? null;
  }

  async uploadOfAsset(assetId: string): Promise<UploadRow | null> {
    return (await this.#t.uploads.findOne({ asset_id: assetId }, { sort: { url_expires_at: -1 } })) ?? null;
  }

  async completeUpload(id: string, at: Date): Promise<void> {
    await this.#t.uploads.updateMany({ id, completed_at: null }, { completed_at: at });
  }

  /* ---------------------------------------------------------------- usages */

  async usagesOf(assetIds: readonly string[], opts: { activeOnly?: boolean } = {}): Promise<UsageRow[]> {
    if (!assetIds.length) return [];
    return this.#t.usages.find({ asset_id: { $in: [...assetIds] }, ...(opts.activeOnly ? { detached_at: null } : {}) }, { sort: { attached_at: 1, id: 1 } });
  }

  async activeUsage(assetId: string, u: { module: string; kind: string; refId: string }): Promise<UsageRow | null> {
    return (await this.#t.usages.findOne({ asset_id: assetId, module: u.module, kind: u.kind, ref_id: u.refId, detached_at: null })) ?? null;
  }

  insertUsage(row: UsageRow): Promise<UsageRow> {
    return this.#t.usages.insert(row);
  }

  async updateUsage(id: string, patch: Partial<Pick<UsageRow, 'ref_label' | 'detached_at'>>): Promise<void> {
    await this.#t.usages.update(id, patch);
  }

  /* ---------------------------------------------------------------- processing */

  async insertProcessingJob(row: ProcessingJobRow): Promise<void> {
    await this.#t.jobs.insert(row);
  }

  /**
   * Claims due jobs (queued and due, or running past their lease): marks them running until
   * leaseUntil and counts the attempt
   */
  async claimProcessingJobs(now: Date, leaseUntil: Date, limit: number): Promise<ProcessingJobRow[]> {
    // each claim is one atomic update of the oldest due job, so concurrent workers never
    // claim the same job (a claimed job's next_attempt_at is its lease, past now)
    const claimed: ProcessingJobRow[] = [];
    while (claimed.length < limit) {
      const job = await this.#t.jobs.updateOne(
        { status: { $in: ['queued', 'running'] }, $or: [{ next_attempt_at: null }, { next_attempt_at: { $lte: now } }] },
        { $set: { status: 'running', next_attempt_at: leaseUntil }, $inc: { attempts: 1 } },
        { sort: { created_at: 1 } },
      );
      if (!job) break;
      claimed.push(job);
    }
    return claimed;
  }

  async updateProcessingJob(id: string, patch: Partial<Omit<ProcessingJobRow, 'id' | 'asset_id'>>): Promise<void> {
    await this.#t.jobs.update(id, patch);
  }

  async processingJobByProviderRef(ref: string): Promise<ProcessingJobRow | null> {
    return (await this.#t.jobs.findOne({ provider_ref: ref }, { sort: { created_at: -1 } })) ?? null;
  }

  processingJobsOf(assetId: string): Promise<ProcessingJobRow[]> {
    return this.#t.jobs.find({ asset_id: assetId }, { sort: { created_at: 1 } });
  }

  /* ---------------------------------------------------------------- counters */

  async uploadCount(owner: OwnerFilter, day: string): Promise<number> {
    return (await this.#t.counters.findOne({ owner_kind: owner.kind, owner_id: owner.id ?? '', day }))?.count ?? 0;
  }

  /** One more upload of `bytes` for the owner's day (one atomic upsert) */
  async bumpUploadCounter(owner: OwnerFilter, day: string, bytes: number): Promise<void> {
    await this.#t.counters.increment({ owner_kind: owner.kind, owner_id: owner.id ?? '', day }, { count: 1, bytes });
  }
}
