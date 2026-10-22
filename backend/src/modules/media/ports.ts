/**
 * Row types of the media collections (repository.ts), and the providers the service uses: storage, malware
 * scanning, image and video processing (implementations in providers/).
 */
import type { Readable } from 'node:stream';
import type { ImageMeasurements, MediaDb } from '../../spec/media.js';
import type { RenditionSize, RenditionTarget } from './domain/image-spec.js';

/* ------------------------------------------------------------------ persistence */

export type AssetRow = MediaDb['assets'];
export type RenditionRow = MediaDb['renditions'];
export type UploadRow = MediaDb['uploads'];
export type UsageRow = MediaDb['usages'];
export type ProcessingJobRow = MediaDb['processing_jobs'];

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

/** An object opened for reading (downloads over GET /files/{bucket}/{key}) */
export interface OpenedObject extends StoredObject {
  lastModified: Date;
  /** The bytes from start to end (inclusive), or all of them; the object is closed when the stream ends */
  stream(range?: { start: number; end: number }): Readable;
  /** Releases the object without reading it (HEAD, 304, 416) */
  close(): Promise<void>;
}

/** putStream refused the bytes: more than maxBytes arrived. Nothing was stored. */
export class ObjectTooLargeError extends Error {
  constructor(
    readonly maxBytes: number,
    /** bytes read before the write stopped (at least maxBytes + 1) */
    readonly receivedBytes: number,
  ) {
    super(`EntityTooLarge: more than ${maxBytes} bytes`);
    this.name = 'ObjectTooLargeError';
  }
}

/** A bucket or key that isn't safe to store under (empty, '..', path separators, control characters …) */
export class InvalidObjectKeyError extends Error {
  constructor(readonly bucket: string, readonly key: string) {
    super(`Invalid storage key: ${JSON.stringify(bucket)}/${JSON.stringify(key)}`);
    this.name = 'InvalidObjectKeyError';
  }
}

/**
 * Object storage: two buckets (public renditions, private originals, documents, evidence and generated
 * files). Keys are '/'-separated paths of safe segments (providers/storage/keys.ts); every adapter refuses
 * others with InvalidObjectKeyError. Writes are atomic: a reader sees the old object or the new one.
 *
 * viaApi: the bytes travel through this API (memory and local-disk storage): clients PUT uploads to
 * PUT /api/{area}/media/uploads/{id}/content and download from GET /files/{bucket}/{key}, whose signed
 * link is verified by the auth middleware. Otherwise (an S3-compatible store) clients use the store's
 * own presigned URLs and the API never carries the bytes.
 */
export interface StorageProvider {
  readonly buckets: { public: string; private: string };
  readonly viaApi: boolean;
  /** Direct-upload stores only: the presigned URL a client PUTs (or POSTs) the bytes to */
  presignUpload?(input: { bucket: string; key: string; contentType: string; maxBytes: number; expiresAt: Date }): Promise<PresignedUpload>;
  /** A link that downloads one object until expiresAt, served with this content type and disposition */
  presignDownload(input: { bucket: string; key: string; expiresAt: Date; fileName: string; contentType: string; inline?: boolean }): Promise<string>;
  /** Permanent URL of a public object (embedded in pages: <img src>) */
  publicUrl(key: string): string;
  /** Location of a private object (not usable without a signature) */
  objectUrl(bucket: string, key: string): string;
  head(bucket: string, key: string): Promise<StoredObject | null>;
  get(bucket: string, key: string): Promise<Uint8Array | null>;
  put(bucket: string, key: string, body: Uint8Array, contentType: string): Promise<StoredObject>;
  /** Writes a stream without holding it in memory; above maxBytes it stops reading, stores nothing and throws ObjectTooLargeError */
  putStream(bucket: string, key: string, body: AsyncIterable<Uint8Array> | Iterable<Uint8Array>, contentType: string, opts?: { maxBytes?: number }): Promise<StoredObject>;
  /** Opens an object for streaming; null when it doesn't exist */
  open(bucket: string, key: string): Promise<OpenedObject | null>;
  copy(from: { bucket: string; key: string }, to: { bucket: string; key: string }): Promise<boolean>;
  delete(bucket: string, key: string): Promise<void>;
  /** Keys in a bucket in ascending order, in pages (after: the last key of the previous page) */
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
  /** Scans a file read as a stream, never held in memory (software packages up to 4 GB) */
  scanStream(input: { fileName: string; contentType: string; body: AsyncIterable<Uint8Array> }): Promise<ScanResult>;
}

/* ------------------------------------------------------------------ processing */

export interface ProbeResult {
  /** Detected from the bytes (type sniffing), e.g. jpeg, png, mp4, pdf */
  format: string;
  kind: 'image' | 'video' | 'document' | 'spreadsheet' | 'software';
  width?: number | null;
  height?: number | null;
  hasAlpha?: boolean;
  durationSeconds?: number | null;
  pageCount?: number | null;
}

export interface RenditionOutput {
  size: RenditionSize;
  width: number;
  height: number;
  format: 'webp' | 'jpeg';
  body: Uint8Array;
}

export interface MediaProcessor {
  /** Reads the real type and dimensions (auto-oriented) from the bytes; null when the file is unreadable or corrupt */
  probe(body: Uint8Array, hint: { contentType: string; fileName: string }): Promise<ProbeResult | null>;
  /** Auto-orients and strips EXIF, GPS and other metadata from an image */
  strip(body: Uint8Array, format: string): Promise<Uint8Array>;
  /**
   * Image renditions, each in WebP and JPEG at quality (default 80), sized by fitSize (domain/image-spec.ts): cover
   * fit, centred, when a target has a height, else the target width; never larger than the image
   */
  renditions(body: Uint8Array, probe: ProbeResult, targets: RenditionTarget[], opts?: { quality?: number }): Promise<RenditionOutput[]>;
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
