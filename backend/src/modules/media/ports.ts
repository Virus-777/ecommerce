/**
 * What the media service needs from the outside world, database-agnostic.
 * The Postgres adapter lives in infra/postgres/; providers (storage, malware scanning, image and
 * video processing) have deterministic dev adapters in infra/<provider>/dev.ts.
 */
import type { Selectable } from 'kysely';
import type { Page } from '../../spec/common.js';
import type { ImageMeasurements, MediaDb } from '../../spec/media.js';
import type { PageRequest } from '../../kernel/lib/pagination.js';

/* ------------------------------------------------------------------ persistence */

export type AssetRow = Selectable<MediaDb['assets']>;
export type RenditionRow = Selectable<MediaDb['renditions']>;
export type UploadRow = Selectable<MediaDb['uploads']>;
export type UsageRow = Selectable<MediaDb['usages']>;
export type ProcessingJobRow = Selectable<MediaDb['processing_jobs']>;

export type AssetPatch = Partial<Omit<AssetRow, 'id' | 'check_result'>> & { check_result?: unknown };

/** Owner condition for record scope: another owner's asset is simply not found */
export interface OwnerFilter {
  kind: string;
  id: string | null;
}

export interface AssetFilter {
  owner?: OwnerFilter;
  ownerKind?: string;
  ownerId?: string;
  purpose?: string;
  kind?: string;
  /** one status, or the statuses a list shows by default */
  statuses?: string[];
  inUse?: boolean;
  failedChecks?: boolean;
  q?: string;
}

/** Persistence for this module's own tables: media.assets, media.renditions, media.uploads, media.usages, media.processing_jobs, media.upload_counters. */
export interface MediaRepository {
  /** Runs fn with a repository bound to one transaction */
  transaction<T>(fn: (tx: MediaRepository) => Promise<T>): Promise<T>;

  /* assets */
  insertAsset(row: Omit<AssetRow, 'check_result'> & { check_result?: unknown }): Promise<AssetRow>;
  getAsset(id: string, opts?: { owner?: OwnerFilter; forUpdate?: boolean }): Promise<AssetRow | null>;
  getAssets(ids: readonly string[]): Promise<AssetRow[]>;
  updateAsset(id: string, patch: AssetPatch): Promise<AssetRow>;
  listAssets(filter: AssetFilter, page: PageRequest): Promise<Page<AssetRow>>;
  findAssetByStorageKey(bucket: string, key: string): Promise<AssetRow | null>;
  /** An earlier live asset of the same owner with this perceptual hash */
  findDuplicate(owner: OwnerFilter, phash: number, asset: { id: string; createdAt: Date }): Promise<string | null>;
  /** Bytes an owner stores (live files), for the storage quota */
  storedBytes(owner: OwnerFilter): Promise<number>;
  /** Assets of one owner in the given statuses (account and seller closure) */
  assetsOfOwner(owner: OwnerFilter, statuses: readonly string[]): Promise<AssetRow[]>;

  /* job selections, oldest first, bounded */
  pendingUploadsBefore(cutoff: Date, limit: number): Promise<AssetRow[]>;
  /** Ready or rejected, never attached to anything, older than cutoff; or marked for deletion (expires_at passed) and no longer used */
  orphansToSweep(cutoff: Date, now: Date, excludePurposes: readonly string[], limit: number): Promise<AssetRow[]>;
  generatedExpired(now: Date, purposes: readonly string[], limit: number): Promise<AssetRow[]>;
  /** Deleted before cutoff whose storage objects still exist */
  deletedToErase(cutoff: Date, limit: number): Promise<AssetRow[]>;
  /** Removed evidence whose retention has passed */
  removedPastRetention(now: Date, limit: number): Promise<AssetRow[]>;
  /** Storage objects the assets know about, in pages (keyset on id) */
  storageRefs(afterId: string | null, limit: number): Promise<{ id: string; status: string; bucket: string; key: string }[]>;

  /* renditions */
  renditionsOf(assetIds: readonly string[]): Promise<RenditionRow[]>;
  saveRenditions(assetId: string, rows: readonly RenditionRow[]): Promise<void>;
  deleteRenditions(assetId: string): Promise<void>;

  /* uploads */
  insertUpload(row: UploadRow): Promise<UploadRow>;
  getUpload(id: string, opts?: { forUpdate?: boolean }): Promise<UploadRow | null>;
  uploadOfAsset(assetId: string): Promise<UploadRow | null>;
  completeUpload(id: string, at: Date): Promise<void>;

  /* usages */
  usagesOf(assetIds: readonly string[], opts?: { activeOnly?: boolean }): Promise<UsageRow[]>;
  activeUsage(assetId: string, usage: { module: string; kind: string; refId: string }): Promise<UsageRow | null>;
  insertUsage(row: UsageRow): Promise<UsageRow>;
  updateUsage(id: string, patch: Partial<Pick<UsageRow, 'ref_label' | 'detached_at'>>): Promise<void>;

  /* processing */
  insertProcessingJob(row: ProcessingJobRow): Promise<void>;
  /**
   * Claims due jobs (queued and due, or running past their lease): marks them running until
   * leaseUntil and counts the attempt
   */
  claimProcessingJobs(now: Date, leaseUntil: Date, limit: number): Promise<ProcessingJobRow[]>;
  updateProcessingJob(id: string, patch: Partial<Omit<ProcessingJobRow, 'id' | 'asset_id'>>): Promise<void>;
  processingJobByProviderRef(ref: string): Promise<ProcessingJobRow | null>;
  processingJobsOf(assetId: string): Promise<ProcessingJobRow[]>;

  /* counters */
  uploadCount(owner: OwnerFilter, day: string): Promise<number>;
  bumpUploadCounter(owner: OwnerFilter, day: string, bytes: number): Promise<void>;
}

/* ------------------------------------------------------------------ storage */

export interface StoredObject {
  sizeBytes: number;
  etag: string;
  /** hex sha256 of the bytes, when the store computes it (S3 checksums; the dev store always) */
  sha256?: string | null;
  versionId?: string | null;
  contentType?: string | null;
}

export interface PresignedUpload {
  method: 'PUT' | 'POST';
  url: string;
  headers: Record<string, string>;
  fields: Record<string, string>;
}

/**
 * Object storage: two buckets (public renditions behind the CDN, private originals, documents,
 * evidence and generated files). Clients upload straight to presigned URLs; the API never carries bytes.
 */
export interface StorageProvider {
  readonly buckets: { public: string; private: string };
  presignUpload(input: { bucket: string; key: string; contentType: string; maxBytes: number; expiresAt: Date }): Promise<PresignedUpload>;
  presignDownload(input: { bucket: string; key: string; expiresAt: Date; fileName: string; contentType: string; inline?: boolean }): Promise<string>;
  /** CDN URL of a public object (immutable) */
  publicUrl(key: string): string;
  /** Location of a private object (not usable without a signature) */
  objectUrl(bucket: string, key: string): string;
  head(bucket: string, key: string): Promise<StoredObject | null>;
  get(bucket: string, key: string): Promise<Uint8Array | null>;
  put(bucket: string, key: string, body: Uint8Array, contentType: string): Promise<StoredObject>;
  copy(from: { bucket: string; key: string }, to: { bucket: string; key: string }): Promise<boolean>;
  delete(bucket: string, key: string): Promise<void>;
  /** Keys in a bucket, in pages */
  list(bucket: string, opts?: { prefix?: string; after?: string; limit?: number }): Promise<string[]>;
}

/* ------------------------------------------------------------------ scanning */

export interface ScanResult {
  clean: boolean;
  /** Signature name when infected */
  threat?: string;
}

export interface MalwareScanner {
  scan(input: { fileName: string; contentType: string; body: Uint8Array }): Promise<ScanResult>;
}

/* ------------------------------------------------------------------ processing */

export interface ProbeResult {
  /** Detected from the bytes (type sniffing), e.g. jpeg, png, mp4, pdf */
  format: string;
  kind: 'image' | 'video' | 'document' | 'spreadsheet';
  width?: number | null;
  height?: number | null;
  hasAlpha?: boolean;
  durationSeconds?: number | null;
  pageCount?: number | null;
}

export interface RenditionOutput {
  size: 'thumb' | 'small' | 'medium' | 'large' | 'zoom';
  width: number;
  height: number;
  format: 'webp' | 'jpeg';
  body: Uint8Array;
}

export interface MediaProcessor {
  /** Reads the real type and dimensions from the bytes; null when the file is unreadable or corrupt */
  probe(body: Uint8Array, hint: { contentType: string; fileName: string }): Promise<ProbeResult | null>;
  /** Auto-orients and strips EXIF, GPS and other metadata from an image */
  strip(body: Uint8Array, format: string): Promise<Uint8Array>;
  /** Image renditions for the given widths (never upscaled) */
  renditions(body: Uint8Array, probe: ProbeResult, widths: Record<string, number>): Promise<RenditionOutput[]>;
  /** Background, sharpness, watermark and text estimates plus a perceptual hash (48-bit integer) */
  measure(body: Uint8Array, probe: ProbeResult, hint: { fileName: string }): Promise<Omit<ImageMeasurements, 'duplicateOf'> & { phash: number }>;
  /** Starts a video transcode (720p, 1080p and a poster frame); the result arrives at POST /webhooks/media/processing-results */
  startTranscode(input: { assetId: string; bucket: string; key: string }): Promise<{ providerJobId: string }>;
}

export interface MediaProviders {
  storage: StorageProvider;
  scanner: MalwareScanner;
  processor: MediaProcessor;
}
