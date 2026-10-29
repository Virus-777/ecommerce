import { type PageRequest } from '../../kernel/lib/pagination.js';
import { inc, type Store, type WhereWithOr } from '../../kernel/store/index.js';
import type { Page } from '../../spec/common.js';
import type { MediaDb } from '../../spec/media.js';
import type { AssetFilter, AssetPatch, AssetRow, OwnerFilter, ProcessingJobRow, RenditionRow, UploadRow, UsageRow } from './ports.js';
import type { MediaQueries } from './queries.js';

type CounterRow = MediaDb['upload_counters'];
type AssetWhere = WhereWithOr<AssetRow>;

/** Storage objects of an asset whose files were erased (purge-deleted): storage_bucket is set to this */
export const ERASED_BUCKET = '';

/** check_result stored as plain JSON (dates inside become strings, the way the service reads them back) */
const json = (v: unknown) => (v === undefined ? undefined : v === null ? null : (JSON.parse(JSON.stringify(v)) as never));

const ownerWhere = (owner: OwnerFilter): AssetWhere => ({ owner_kind: owner.kind, owner_id: owner.id });

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
 * media.assets, renditions, uploads, usages, processing_jobs, upload_counters (the files themselves stay in
 * storage). Written against `ctx.store`, so the module's data runs in either database (docs/10 §10.5); the
 * four reads that need a join to media.usages are in `queries.ts`, one implementation per store.
 */
export class MediaRepository {
  readonly #t;

  constructor(
    private readonly store: Store,
    private readonly queries: MediaQueries,
  ) {
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
    return this.store.transaction((tx) => fn(new MediaRepository(tx, this.queries)));
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
    // `and` rather than one object: `owner` and `ownerKind` are both conditions on owner_kind, and one
    // object cannot hold two of a name
    const and: AssetWhere[] = [];
    if (f.owner) and.push(ownerWhere(f.owner));
    if (f.ownerKind) and.push({ owner_kind: f.ownerKind });
    if (f.ownerId) and.push({ owner_id: f.ownerId });
    if (f.purpose) and.push({ purpose: f.purpose });
    if (f.kind) and.push({ kind: f.kind });
    if (f.statuses?.length) and.push({ status: f.statuses });
    // failed: the check result says passed false; not failed: passed, or no result yet. A path into the
    // document, which is `check_result.passed` on MongoDB and `check_result->'$.passed'` in SQL (§10.5f)
    if (f.failedChecks === true) and.push({ 'check_result.passed': false });
    if (f.failedChecks === false) and.push({ or: [{ 'check_result.passed': true }, { 'check_result.passed': null }] });
    if (f.q?.trim()) {
      const term = { op: 'contains' as const, value: f.q };
      and.push({ or: [{ file_name: term }, { title: term }, { alt: term }] });
    }
    const where: AssetWhere = { and };
    if (f.inUse === undefined) return this.#t.assets.page(where, page, { column: 'created_at', direction: 'desc' });
    return this.queries.pageByUsage(where, f.inUse ? 'active' : 'none', page);
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
        id: { op: '<>', value: asset.id },
        status: ['processing', 'ready', 'removed'],
        or: [{ created_at: { op: '<', value: asset.createdAt } }, { created_at: asset.createdAt, id: { op: '<', value: asset.id } }],
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
    // neither database measures a Hamming distance in a query, so the candidates' hashes are read through
    // the queries port and compared here
    const candidates = await this.queries.phashCandidates(f);
    const near = candidates
      .map((c) => ({ id: c.id, created_at: c.created_at, distance: hamming(phash, c.phash) }))
      .filter((c) => c.distance <= f.maxDistance)
      .sort((a, b) => a.distance - b.distance || a.created_at.getTime() - b.created_at.getTime() || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0))
      .slice(0, f.limit);
    const rows = new Map((await this.#t.assets.getMany(near.map((c) => c.id))).map((r) => [r.id, r]));
    return near.flatMap((c) => (rows.has(c.id) ? [{ asset: rows.get(c.id)!, distance: c.distance }] : []));
  }

  /** Bytes an owner stores (live files), for the storage quota */
  storedBytes(owner: OwnerFilter): Promise<number> {
    return this.#t.assets.sum('size_bytes', { ...ownerWhere(owner), status: LIVE });
  }

  /** Assets of one owner in the given statuses (account and seller closure) */
  assetsOfOwner(owner: OwnerFilter, statuses: readonly string[]): Promise<AssetRow[]> {
    return this.#t.assets.find({ ...ownerWhere(owner), status: [...statuses] }, { sort: { created_at: 1 } });
  }

  /* ---------------------------------------------------------------- job selections, oldest first, bounded */

  pendingUploadsBefore(cutoff: Date, limit: number): Promise<AssetRow[]> {
    return this.#t.assets.find({ status: 'pending_upload', created_at: { op: '<', value: cutoff } }, { sort: { created_at: 1 }, limit });
  }

  /** Ready or rejected, never attached to anything, older than cutoff; or marked for deletion (expires_at passed) and no longer used */
  orphansToSweep(cutoff: Date, now: Date, excludePurposes: readonly string[], limit: number): Promise<AssetRow[]> {
    return this.queries.orphans({ cutoff, now, excludePurposes, limit });
  }

  generatedExpired(now: Date, purposes: readonly string[], limit: number): Promise<AssetRow[]> {
    return this.queries.expiredGenerated({ now, purposes, limit });
  }

  /** Deleted before cutoff whose storage objects still exist */
  deletedToErase(cutoff: Date, limit: number): Promise<AssetRow[]> {
    return this.#t.assets.find(
      {
        status: ['deleted', 'expired'],
        storage_bucket: { op: '<>', value: ERASED_BUCKET },
        or: [{ deleted_at: { op: '<', value: cutoff } }, { deleted_at: null, created_at: { op: '<', value: cutoff } }],
      },
      { sort: { created_at: 1 }, limit },
    );
  }

  /**
   * Removed evidence whose retention has passed. The purge job checks the same two things again inside the
   * row's lock before it acts, which is what actually enforces them — so breaking either condition here
   * changes no outcome and no test can see it; it is the selection being honest about what it is for.
   */
  removedPastRetention(now: Date, limit: number): Promise<AssetRow[]> {
    // two conditions on retain_until, which one object cannot hold: MongoDB's `$lte` on a date also matches
    // a null (null sorts before every date), so "it has one, and it has passed" has to say both
    return this.#t.assets.find(
      { status: 'removed', and: [{ retain_until: { op: 'is not', value: null } }, { retain_until: { op: '<=', value: now } }] },
      { sort: { retain_until: 1 }, limit },
    );
  }

  /**
   * Ready product images whose renditions were built with another product image spec, or before the spec existed
   * (no processing_spec), oldest first
   */
  async productImagesToRebuild(spec: { aspectRatio: string; detailWidth: number; thumbnailWidth: number; quality: number }, limit: number): Promise<AssetRow[]> {
    // `is not` on each path rather than `<>`: a document without that field counts as different, which is
    // what MongoDB's own `$ne` said here and what "built with another spec" means
    return this.#t.assets.find(
      {
        purpose: 'product_image',
        kind: 'image',
        status: 'ready',
        or: [
          { processing_spec: null },
          { 'processing_spec.aspectRatio': { op: 'is not', value: spec.aspectRatio } },
          { 'processing_spec.detailWidth': { op: 'is not', value: spec.detailWidth } },
          { 'processing_spec.thumbnailWidth': { op: 'is not', value: spec.thumbnailWidth } },
          { 'processing_spec.quality': { op: 'is not', value: spec.quality } },
        ],
      },
      { sort: { created_at: 1 }, limit },
    );
  }

  /** Storage objects the assets know about, in pages (keyset on id) */
  async storageRefs(afterId: string | null, limit: number): Promise<{ id: string; status: string; bucket: string; key: string }[]> {
    const rows = await this.#t.assets.find(
      { storage_bucket: { op: '<>', value: ERASED_BUCKET }, ...(afterId ? { id: { op: '>' as const, value: afterId } } : {}) },
      { sort: { id: 1 }, limit },
    );
    return rows.map((r) => ({ id: r.id, status: r.status, bucket: r.storage_bucket, key: r.storage_key }));
  }

  /* ---------------------------------------------------------------- renditions */

  async renditionsOf(assetIds: readonly string[]): Promise<RenditionRow[]> {
    if (!assetIds.length) return [];
    return this.#t.renditions.find({ asset_id: [...assetIds] }, { sort: { width: 1, format: 1 } });
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
    return this.#t.usages.find({ asset_id: [...assetIds], ...(opts.activeOnly ? { detached_at: null } : {}) }, { sort: { attached_at: 1, id: 1 } });
  }

  /**
   * The usage of this asset by that record, while it lasts. `forUpdate` locks the row, which attach and
   * detach both need: each reads this row and then writes it, and the read-modify-write detector of §11.2
   * rule 1 is right to insist even though the asset's own row is already locked above it — that lock
   * serialises the two callers today and says nothing about the next caller.
   */
  async activeUsage(assetId: string, u: { module: string; kind: string; refId: string }, opts: { forUpdate?: boolean } = {}): Promise<UsageRow | null> {
    return (await this.#t.usages.findOne({ asset_id: assetId, module: u.module, kind: u.kind, ref_id: u.refId, detached_at: null }, { forUpdate: opts.forUpdate })) ?? null;
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
        { status: ['queued', 'running'], or: [{ next_attempt_at: null }, { next_attempt_at: { op: '<=', value: now } }] },
        { status: 'running', next_attempt_at: leaseUntil, attempts: inc('attempts', 1) },
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
