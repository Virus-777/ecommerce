import { actorOfPrincipal } from '../../kernel/auth/index.js';
import { isIP } from 'node:net';
import { createHash } from 'node:crypto';
import type { Readable } from 'node:stream';
import { setTimeout as sleep } from 'node:timers/promises';
import { SYSTEM_ACTOR } from '../../kernel/auth/index.js';
import { AppError, isAppError, isNotImplemented } from '../../kernel/errors/index.js';
import type { EventPayload } from '../../kernel/events/index.js';
import { dateInZone } from '../../kernel/lib/clock.js';
import { isUuid, newId } from '../../kernel/lib/ids.js';
import type { PageRequest } from '../../kernel/lib/pagination.js';
import type { ModuleContext } from '../../kernel/module-system/index.js';
import type * as audit from '../../spec/audit.js';
import type * as common from '../../spec/common.js';
import type * as identity from '../../spec/identity.js';
import type {
  AssetUpdate,
  DownloadLink,
  ImageCheckResult,
  ImageIssue,
  ImageMeasurements,
  ImageRules,
  ImageSpecs,
  MediaAsset,
  MediaAssetDetail,
  MediaOwner,
  MediaPublicApi,
  ProductImageSpec,
  RecropItem,
  Rendition,
  StorageEvent,
  UploadRequest,
  UploadTicket,
  Usage,
  UsageInput,
} from '../../spec/media.js';
import { evaluateImage, passed, type BaselineRules } from './domain/image-check.js';
import {
  hasRatio,
  productImageIssues,
  productTargets,
  recropMessage,
  resolveSpec,
  toSetting,
  widthTargets,
  type ProcessingSpec,
  type ProductImageSetting,
  type RenditionSize,
} from './domain/image-spec.js';
import {
  GENERATED_PURPOSES,
  MAX_IMAGE_PIXELS,
  MAX_IMAGE_SIDE,
  MIME_OF,
  SENSITIVE_GENERATED,
  allowedPurposes,
  deleteCheck,
  extendRetention,
  fileTypeOf,
  isEvidenceKind,
  isGeneratedPurpose,
  kindOf,
  limitFor,
  purposeFitsUsage,
  purposesForUsage,
  sameOwner,
  visibilityOf,
  type FileType,
  type PurposeLimit,
  type Uploader,
} from './domain/rules.js';
import { assetMachine } from './domain/state-machines.js';
import { ERASED_BUCKET, type MediaRepository } from './repository.js';
import { checkOf, ownerOf, toAsset, toRendition, toUsage } from './mappers.js';
import { ObjectTooLargeError, type AssetFilter, type AssetPatch, type AssetRow, type MediaProviders, type OwnerFilter, type ProcessingJobRow, type RenditionRow, type UploadRow, type UsageRow } from './ports.js';

export interface MediaServiceDeps {
  repo: MediaRepository;
  ctx: ModuleContext<'media'>;
  providers: MediaProviders;
  /** How long attach() waits for a file that is still processing (default 10 s) */
  attachWaitMs?: number;
}

/** Who acts, for events, audit entries and timelines */
export interface By {
  actor: common.Actor;
  requestId?: string;
}

/** The API area an upload was started in, and the address the caller reached the API at (the ticket URL when uploads go through the API) */
export type UploadArea = 'store' | 'seller' | 'admin';
export interface UploadTarget {
  area: UploadArea;
  /** e.g. https://api.marketly.test (no trailing slash) */
  origin: string;
}

/** Upload target when storage takes uploads through the API: PUT /api/{area}/media/uploads/{id}/content */
const CONTENT_PATH = /^\/api\/(store|seller|admin)\/media\/uploads\/([^/]+)\/content$/;
const contentUrl = (target: UploadTarget, uploadId: string) => `${target.origin}/api/${target.area}/media/uploads/${uploadId}/content`;

type Status = (typeof assetMachine.states)[number];
type AssetEvent = (typeof assetMachine.events)[number];
type ProcessingOutcome = { result: 'ready'; patch: AssetPatch; renditions: RenditionRow[] } | { result: 'rejected'; reason: string; eraseOriginal?: boolean } | { result: 'waiting' };

const ALT_MAX = 300;
const TITLE_MAX = 200;
const MAX_PROCESSING_ATTEMPTS = 5;
const PROCESSING_LEASE_MS = 15 * 60_000;
const BATCH = 100;
/** Image rendition sizes, smallest first (detail: product images, between medium and large) */
const IMAGE_SIZES = ['thumb', 'small', 'medium', 'detail', 'large', 'zoom'] as const;
/** Usages that show a product photo: a product_image file must meet the product image spec to be attached */
const PRODUCT_PHOTO_USAGES = ['product_image', 'variant_image', 'offer_photo'];
/** media.rebuild-product-renditions: images per batch, and the pause between batches (rate limit) */
const REBUILD_BATCH = 50;
const REBUILD_PAUSE_MS = 250;
const TRANSCODED_PURPOSES = ['product_video', 'ad_video'];
/** Downloads of these are recorded in the action history even when another module checked access */
const SENSITIVE_PURPOSES = ['verification_document', 'return_evidence', 'case_evidence', 'inspection_photo', 'data_export', ...SENSITIVE_GENERATED];
/** readFile reads at most this much unless the caller says otherwise */
const READ_MAX_BYTES = 25 * 1024 * 1024;
/** storeInboundFile: purposes an inbound file may have, and the uploader kind its upload record carries */
const INBOUND_PURPOSES: readonly string[] = ['message_attachment', 'case_evidence', 'other_document'];
const INBOUND_UPLOADER = 'inbound';
const SIMILAR_MAX_DISTANCE = 6;
const SIMILAR_LIMIT = 20;
/** Statuses an owner no longer sees */
const GONE = ['deleted'];
const PLACEHOLDER_KEY = 'placeholders/removed.png';
/** 1×1 neutral grey PNG served in place of removed files */
const PLACEHOLDER_PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=', 'base64');

const notFound = () => new AppError('NOT_FOUND', 'File not found');
/** The upload was started by this caller (no caller given: no check) */
const startedBy = (upload: { created_by_kind: string; created_by_id: string | null }, by?: { kind: string; id: string | null }) =>
  !by || (Boolean(by.id) && upload.created_by_kind === by.kind && upload.created_by_id === by.id);
const invalid = (path: string, message: string) => new AppError('VALIDATION_FAILED', message, { issues: [{ path, message }] });
const label = (s: string) => s.replace(/_/g, ' ');
const mb = (bytes: number) => `${Math.round((bytes / (1024 * 1024)) * 10) / 10} MB`;
const ownerFilter = (o: { kind: string; id?: string | null }): OwnerFilter => ({ kind: o.kind, id: o.id ?? null });
const processedKey = (assetId: string) => `processed/${assetId}`;
const renditionKey = (assetId: string, size: string, format: string) => `renditions/${assetId}/${size}.${format}`;
const quarantineKey = (key: string) => `removed/${key}`;

/**
 * Media use cases. Depends only on ports, the event bus, the clock and other modules' public APIs.
 * Each method maps to a publicApi function, an endpoint, a consumed event or a job in docs/api/spec/modules/media.json.
 */
export class MediaService implements MediaPublicApi {
  readonly providers: MediaProviders;
  /** Version of media.productImage last announced by settings.setting.changed (null until one arrives) */
  private productImageVersion: number | null = null;

  constructor(protected readonly deps: MediaServiceDeps) {
    this.providers = deps.providers;
  }

  private get repo() {
    return this.deps.repo;
  }
  private get ctx() {
    return this.deps.ctx;
  }
  private get storage() {
    return this.deps.providers.storage;
  }
  private now() {
    return this.ctx.clock.now();
  }
  private get timeZone() {
    return this.ctx.config.market.timeZone;
  }
  private next(status: string, event: AssetEvent): Status {
    return assetMachine.next(status as Status, event);
  }

  /* ================================================================ public API (in-process) */

  /** Asset with renditions and status */
  async getAsset(assetId: string): Promise<MediaAsset | null> {
    const row = await this.repo.getAsset(assetId);
    return row ? this.view(row, { signPrivate: true }) : null;
  }

  /**
   * common.MediaRef (id, url, alt, width, height, fileName) for embedding in responses; removed files return the
   * placeholder. Product images answer with detail or thumb (sizeFor) and carry thumbUrl and detailUrl.
   */
  async refs(assetIds: string[], size: 'thumb' | 'small' | 'medium' | 'large' | 'zoom' | 'detail' = 'medium'): Promise<common.MediaRef[]> {
    const unique = [...new Set(assetIds)];
    const rows = new Map((await this.repo.getAssets(unique)).map((r) => [r.id, r]));
    const renditions = groupBy(await this.repo.renditionsOf([...rows.keys()]), (r) => r.asset_id);
    const ttl = await this.ctx.settings.get('downloadUrlTtlMinutes');
    const out: common.MediaRef[] = [];
    for (const id of assetIds) {
      const row = rows.get(id);
      if (!row) continue;
      if (row.status === 'removed') {
        // taken down without a placeholder: the public URLs stop serving, so there is nothing to embed
        if (row.show_placeholder !== false) out.push({ id, url: this.storage.publicUrl(PLACEHOLDER_KEY), alt: null, width: null, height: null, bytes: null, fileName: null, thumbUrl: null, detailUrl: null });
        continue;
      }
      if (row.status !== 'ready') continue;
      const rs = renditions.get(id) ?? [];
      const r = pickRendition(rs, sizeFor(row, size));
      let url: string;
      if (r && row.visibility === 'public') url = this.storage.publicUrl(r.storage_key);
      else if (r) url = await this.sign(this.storage.buckets.private, r.storage_key, row, ttl, true);
      else url = await this.sign(row.storage_bucket, row.storage_key, row, ttl, false);
      // product images (always public): both sizes, so a response can offer the other one too
      const both = isProductImage(row) && row.visibility === 'public';
      const thumb = both ? pickRendition(rs, sizeFor(row, 'thumb')) : undefined;
      const detail = both ? pickRendition(rs, sizeFor(row, 'detail')) : undefined;
      out.push({
        id,
        url,
        alt: row.alt,
        width: r?.width ?? row.width,
        height: r?.height ?? row.height,
        bytes: Number(row.size_bytes),
        fileName: row.file_name,
        thumbUrl: thumb ? this.storage.publicUrl(thumb.storage_key) : null,
        detailUrl: detail ? this.storage.publicUrl(detail.storage_key) : null,
      });
    }
    return out;
  }

  /** GET /image-specs (store, seller, admin): the product image spec in force */
  async imageSpecs(): Promise<ImageSpecs> {
    return { productImage: await this.productImageSpec() };
  }

  /** The setting media.productImage in force, with the ratio and sizes worked out */
  async productImageSpec(): Promise<ProductImageSpec> {
    return resolveSpec(await this.productImageSetting());
  }

  private async productImageSetting(): Promise<ProductImageSetting> {
    return toSetting(await this.ctx.settings.get('productImage'));
  }

  /** Record that a record uses a file. Fails if the asset is not ready, belongs to another owner (ASSET_NOT_OWNED) or the purpose does not fit the usage. Evidence usages extend retainUntil. */
  async attach(assetId: string, usage: UsageInput, expectedOwner: MediaOwner): Promise<void> {
    if (!usage.module?.trim()) throw invalid('usage.module', 'The using module is required');
    if (!usage.refId?.trim()) throw invalid('usage.refId', 'The record id is required');
    let asset = await this.repo.getAsset(assetId);
    if (!asset) throw notFound();
    if (!(await this.ownedBy(asset, expectedOwner))) throw new AppError('ASSET_NOT_OWNED', 'This file belongs to another owner and cannot be attached here.', { assetId });
    if (!purposeFitsUsage(asset.purpose, usage.kind)) {
      throw new AppError('VALIDATION_FAILED', `A ${label(asset.purpose)} file can't be used as ${label(usage.kind)}.`, {
        issues: [{ path: 'usage.kind', message: `Allowed file purposes: ${purposesForUsage(usage.kind).join(', ')}` }],
      });
    }
    if (asset.status === 'pending_upload' || asset.status === 'processing') asset = await this.waitForReady(asset);
    if (asset.status !== 'ready') throw notUsable(asset);

    const now = this.now();
    const evidence = isEvidenceKind(usage.kind);
    const days = evidence ? await this.ctx.settings.get('evidenceRetentionDays') : 0;
    // a product photo must meet the product image spec (seller uploads were checked at upload; staff uploads here)
    const spec = isProductImage(asset) && PRODUCT_PHOTO_USAGES.includes(usage.kind) ? await this.productImageSpec() : null;
    await this.repo.transaction(async (tx) => {
      const locked = await tx.getAsset(assetId, { forUpdate: true });
      if (!locked) throw notFound();
      if (locked.status !== 'ready') throw notUsable(locked);
      const existing = await tx.activeUsage(assetId, usage);
      if (existing) {
        if ((usage.refLabel ?? null) !== existing.ref_label && usage.refLabel !== undefined) await tx.updateUsage(existing.id, { ref_label: usage.refLabel ?? null });
      } else {
        const issues = spec ? productImageIssues({ width: locked.width ?? 0, height: locked.height ?? 0 }, spec) : [];
        if (issues.length) {
          const message = issues.map((i) => i.message).join(' ');
          throw new AppError('VALIDATION_FAILED', message, { issues: [{ path: 'assetId', message }], assetId, codes: issues.map((i) => i.code) });
        }
        await tx.insertUsage({
          id: newId(),
          asset_id: assetId,
          module: usage.module,
          kind: usage.kind,
          ref_id: usage.refId,
          ref_label: usage.refLabel ?? null,
          evidence,
          attached_at: now,
          detached_at: null,
        });
      }
      if (evidence) await tx.updateAsset(assetId, { retain_until: extendRetention(locked.retain_until, now, days) });
    });
  }

  /** Record that a record no longer uses a file (image replaced, draft deleted) */
  async detach(assetId: string, usage: { module: string; kind: string; refId: string }): Promise<void> {
    const now = this.now();
    const days = await this.ctx.settings.get('evidenceRetentionDays');
    await this.repo.transaction(async (tx) => {
      const asset = await tx.getAsset(assetId, { forUpdate: true });
      if (!asset) return; // unknown file: nothing to detach
      const active = await tx.activeUsage(assetId, usage);
      if (!active) return; // already detached
      await tx.updateUsage(active.id, { detached_at: now });
      // evidence is kept evidenceRetentionDays after its last use
      if (active.evidence) await tx.updateAsset(assetId, { retain_until: extendRetention(asset.retain_until, now, days) });
    });
  }

  /** Evaluate an image against category or placement rules; the result is stored on the asset */
  async checkImage(assetId: string, rules: ImageRules): Promise<ImageCheckResult> {
    return this.runImageCheck(assetId, rules, { rulesSource: null });
  }

  /** Store a file produced by the platform (private) */
  async storeGeneratedFile(input: {
    owner: MediaOwner;
    fileName: string;
    contentType: string;
    body: ReadableStream;
    ttlHours?: number;
    purpose: 'export' | 'statement' | 'report' | 'correction_report' | 'data_export' | 'label' | 'gift_card_codes';
  }): Promise<MediaAsset> {
    if (!isGeneratedPurpose(input.purpose)) throw invalid('purpose', `Generated files are ${GENERATED_PURPOSES.join(', ')}`);
    if (!input.fileName?.trim()) throw invalid('fileName', 'A file name is required');
    if (input.ttlHours != null && !(input.ttlHours > 0)) throw invalid('ttlHours', 'ttlHours must be positive');
    const body = await readBody(input.body);
    const now = this.now();
    const id = newId();
    const type = fileTypeOf(input.contentType, input.fileName);
    const probe = await this.providers.processor.probe(body, { contentType: input.contentType, fileName: input.fileName });
    const key = `generated/${id}.${type ?? 'bin'}`;
    await this.storage.put(this.storage.buckets.private, key, body, input.contentType);
    // produced by the platform itself: stored ready, never scanned or offered for upload
    const row = await this.repo.insertAsset({
      id,
      kind: probe?.kind ?? (type ? kindOf(type) : 'document'),
      purpose: input.purpose,
      status: 'ready',
      file_name: input.fileName.trim(),
      content_type: input.contentType,
      size_bytes: body.byteLength,
      sha256: sha256(body),
      phash: null,
      width: probe?.width ?? null,
      height: probe?.height ?? null,
      duration_seconds: probe?.durationSeconds == null ? null : String(probe.durationSeconds),
      page_count: probe?.pageCount ?? null,
      alt: null,
      title: null,
      owner_kind: input.owner.kind,
      owner_id: input.owner.id ?? null,
      owner_label: input.owner.label ?? null,
      visibility: 'private',
      storage_bucket: this.storage.buckets.private,
      storage_key: key,
      check_result: null,
      rejection_reason: null,
      removed_reason: null,
      removed_by: null,
      removed_at: null,
      show_placeholder: null,
      retain_until: null,
      expires_at: input.ttlHours ? new Date(now.getTime() + input.ttlHours * 3_600_000) : null,
      created_at: now,
      ready_at: now,
      deleted_at: null,
      processing_spec: null,
    });
    this.ctx.events.publish('media.asset.ready', { assetId: id, kind: row.kind, purpose: row.purpose, owner: ownerOf(row) }, { actor: SYSTEM_ACTOR });
    return this.view(row, { signPrivate: true });
  }

  /** Signed link for a private file after the caller's module checked access; recorded for sensitive purposes */
  async signedDownload(assetId: string, principal: identity.Principal, reason?: string): Promise<DownloadLink> {
    const row = await this.repo.getAsset(assetId);
    if (!row || GONE.includes(row.status) || row.status === 'expired') throw notFound();
    if (row.status !== 'ready' && row.status !== 'removed') throw notUsable(row);
    // gift card codes: the owning module checked access; the link is always recorded with why it was opened
    if (SENSITIVE_GENERATED.includes(row.purpose) && !reason?.trim()) throw invalid('reason', 'Say why this file is opened');
    const link = await this.downloadLink(row);
    if (SENSITIVE_PURPOSES.includes(row.purpose)) {
      await this.audit(
        { action: 'media.asset.download', actionLabel: 'Opened a private file', category: categoryOf(row), target: this.target(row), reason: reason ?? null },
        { actor: actorOfPrincipal(principal) },
      );
    }
    return link;
  }

  /** Takedown on behalf of a moderation decision (trust, reviews, catalog) */
  async remove(assetId: string, input: { reason: string; by: common.Actor }): Promise<void> {
    await this.removeAsset(assetId, { reason: input.reason, showPlaceholder: true }, { actor: input.by });
  }

  /**
   * The stored bytes of a ready file, for modules that parse uploads in-process (offers bulk files, purchasing
   * supplier files). ASSET_NOT_OWNED when expectedOwner differs, ILLEGAL_TRANSITION when not ready, FILE_TOO_LARGE
   * above maxBytes (default 25 MB). Works with every storage adapter: callers never fetch signed URLs themselves.
   */
  async readFile(
    assetId: string,
    expectedOwner?: MediaOwner,
    opts?: { maxBytes?: number },
  ): Promise<{ fileName: string; contentType: string; sizeBytes: number; body: Uint8Array }> {
    const row = isUuid(assetId) ? await this.repo.getAsset(assetId) : null;
    if (!row || GONE.includes(row.status)) throw notFound();
    if (expectedOwner && !(await this.ownedBy(row, expectedOwner))) throw new AppError('ASSET_NOT_OWNED', 'This file belongs to another owner.', { assetId });
    if (row.status !== 'ready') throw new AppError('ILLEGAL_TRANSITION', `This file is ${label(row.status)}, not ready to read.`, { from: row.status, event: 'read' });
    const maxBytes = opts?.maxBytes ?? READ_MAX_BYTES;
    if (Number(row.size_bytes) > maxBytes) throw new AppError('FILE_TOO_LARGE', `The file is ${mb(Number(row.size_bytes))}; at most ${mb(maxBytes)} can be read.`, { maxBytes });
    const body = row.storage_bucket === ERASED_BUCKET ? null : await this.storage.get(row.storage_bucket, row.storage_key);
    if (!body) throw new AppError('NOT_FOUND', 'The stored file is missing');
    if (body.byteLength > maxBytes) throw new AppError('FILE_TOO_LARGE', `The file is ${mb(body.byteLength)}; at most ${mb(maxBytes)} can be read.`, { maxBytes });
    return { fileName: row.file_name, contentType: row.content_type, sizeBytes: body.byteLength, body };
  }

  /**
   * A file that arrived outside an upload session (inbound email attachments), under the purpose's type and size
   * limits. Processed like an upload (scan, strip, renditions): it starts in processing and the receiving module
   * attaches it like any upload. source (e.g. inbound-email:<providerEventId>) goes on the asset history.
   */
  async storeInboundFile(input: {
    owner: MediaOwner;
    purpose: 'message_attachment' | 'case_evidence' | 'other_document';
    fileName: string;
    contentType: string;
    body: Uint8Array;
    source: string;
  }): Promise<MediaAsset> {
    if (!INBOUND_PURPOSES.includes(input.purpose)) throw invalid('purpose', `Inbound files are ${INBOUND_PURPOSES.join(', ')}`);
    const fileName = input.fileName?.trim() ?? '';
    if (!fileName) throw invalid('fileName', 'A file name is required');
    if (fileName.length > 255) throw invalid('fileName', 'File name is too long (255 characters at most)');
    if (!input.source?.trim()) throw invalid('source', 'The source is required');
    const body = input.body instanceof Uint8Array ? input.body : new Uint8Array(0);
    if (!body.byteLength) throw invalid('body', 'The file is empty');
    const limits = limitFor(input.purpose, (await this.ctx.settings.get('limitsByPurpose')) as unknown as Record<string, PurposeLimit>);
    const type = fileTypeOf(input.contentType, fileName);
    if (!type || !limits.types.includes(type)) {
      throw new AppError('FILE_TYPE_NOT_ALLOWED', `This type of file isn't accepted for a ${label(input.purpose)}. Use ${limits.types.map((t) => t.toUpperCase()).join(', ')}.`, {
        allowed: limits.types,
        contentType: input.contentType,
      });
    }
    if (body.byteLength > limits.maxBytes) {
      throw new AppError('FILE_TOO_LARGE', `The file is ${mb(body.byteLength)}; the limit for a ${label(input.purpose)} is ${mb(limits.maxBytes)}.`, { maxBytes: limits.maxBytes });
    }
    const now = this.now();
    const assetId = newId();
    const key = `originals/${assetId}.${type}`;
    const ownerLabel = input.owner.label ?? (await this.ownerLabel(input.owner));
    await this.storage.put(this.storage.buckets.private, key, body, input.contentType);
    const row = await this.repo.transaction(async (tx) => {
      const inserted = await tx.insertAsset({
        id: assetId,
        kind: kindOf(type),
        purpose: input.purpose,
        // received in full: it starts where a completed upload does
        status: this.next(assetMachine.initial, 'complete'),
        file_name: fileName,
        content_type: input.contentType,
        size_bytes: body.byteLength,
        sha256: sha256(body),
        phash: null,
        width: null,
        height: null,
        duration_seconds: null,
        page_count: null,
        alt: null,
        title: null,
        owner_kind: input.owner.kind,
        owner_id: input.owner.id ?? null,
        owner_label: ownerLabel,
        visibility: visibilityOf(input.purpose),
        storage_bucket: this.storage.buckets.private,
        storage_key: key,
        check_result: null,
        rejection_reason: null,
        removed_reason: null,
        removed_by: null,
        removed_at: null,
        show_placeholder: null,
        retain_until: null,
        expires_at: null,
        created_at: now,
        ready_at: null,
        deleted_at: null,
        processing_spec: null,
      });
      // the upload record keeps where the file came from (shown on the asset history)
      await tx.insertUpload({
        id: newId(),
        asset_id: assetId,
        expected_bytes: body.byteLength,
        expected_sha256: null,
        url_expires_at: now,
        completed_at: now,
        client_ip: null,
        created_by_kind: INBOUND_UPLOADER,
        created_by_id: input.source.trim().slice(0, 200),
      });
      await tx.insertProcessingJob({ id: newId(), asset_id: assetId, step: 'scan', status: 'queued', attempts: 0, provider_ref: null, error: null, next_attempt_at: now, created_at: now, finished_at: null });
      return inserted;
    });
    this.kickProcessing();
    return this.view(row, { signPrivate: true });
  }

  /**
   * Ready images whose perceptual hash is within maxDistance (Hamming, default 6) of this image, closest first
   * (default limit 20), for duplicate-product checks. Never returns private evidence files.
   */
  async findSimilar(
    assetId: string,
    scope: { ownerKind?: 'seller' | 'platform'; ownerId?: string; usageKinds?: string[]; maxDistance?: number; limit?: number },
  ): Promise<{ assetId: string; distance: number; owner: MediaOwner; usages: Usage[] }[]> {
    const row = isUuid(assetId) ? await this.repo.getAsset(assetId) : null;
    if (!row || GONE.includes(row.status)) throw notFound();
    if (row.phash == null) return []; // not an image, or not processed yet
    const maxDistance = Math.min(64, Math.max(0, Math.trunc(scope?.maxDistance ?? SIMILAR_MAX_DISTANCE)));
    const limit = Math.min(100, Math.max(1, Math.trunc(scope?.limit ?? SIMILAR_LIMIT)));
    const hits = await this.repo.similarImages(Number(row.phash), {
      excludeId: row.id,
      maxDistance,
      limit,
      ownerKind: scope?.ownerKind,
      ownerId: scope?.ownerId,
      usageKinds: scope?.usageKinds,
    });
    const usages = groupBy(await this.repo.usagesOf(hits.map((h) => h.asset.id), { activeOnly: true }), (u) => u.asset_id);
    return hits.map((h) => ({ assetId: h.asset.id, distance: h.distance, owner: ownerOf(h.asset), usages: (usages.get(h.asset.id) ?? []).map(toUsage) }));
  }

  /* ================================================================ uploads */

  /**
   * POST /uploads (store, seller, admin): checks purpose, type, size and quotas, then issues a signed storage URL.
   * When storage takes uploads through the API (local disk, memory) the ticket URL is this API's PUT /uploads/{id}/content in the area of `target`.
   */
  async createUpload(input: {
    uploader: Uploader;
    owner: MediaOwner;
    request: UploadRequest;
    createdBy: { kind: string; id: string | null };
    clientIp?: string | null;
    target?: UploadTarget;
    by: By;
  }): Promise<UploadTicket> {
    const req = input.request;
    const allowed = allowedPurposes(input.uploader);
    if (!allowed.includes(req.purpose)) {
      throw new AppError('PURPOSE_NOT_ALLOWED', `You can't upload a ${label(req.purpose)} here.`, { purpose: req.purpose, allowed });
    }
    const fileName = req.fileName.trim();
    const issues: { path: string; message: string }[] = [];
    if (!fileName) issues.push({ path: 'fileName', message: 'File name is required' });
    if (fileName.length > 255) issues.push({ path: 'fileName', message: 'File name is too long (255 characters at most)' });
    if (req.sizeBytes <= 0) issues.push({ path: 'sizeBytes', message: 'The file is empty' });
    if (req.sha256 && !/^[0-9a-f]{64}$/i.test(req.sha256)) issues.push({ path: 'sha256', message: 'sha256 must be 64 hex characters' });
    if (req.alt && req.alt.length > ALT_MAX) issues.push({ path: 'alt', message: `Alt text is too long (${ALT_MAX} characters at most)` });
    if (issues.length) throw new AppError('VALIDATION_FAILED', issues[0]!.message, { issues });

    const limits = limitFor(req.purpose, (await this.ctx.settings.get('limitsByPurpose')) as unknown as Record<string, PurposeLimit>);
    const type = fileTypeOf(req.contentType, fileName);
    if (type === 'heic' && req.purpose === 'product_image') {
      // product images are resized on the server, which can't decode HEIC (whatever limitsByPurpose lists)
      const allowed = limits.types.filter((t) => t !== 'heic');
      throw new AppError('FILE_TYPE_NOT_ALLOWED', "HEIC photos aren't accepted for product images. Use JPEG, PNG or WebP (the Seller Center converts the photo when it crops it).", { allowed, contentType: req.contentType });
    }
    if (!type || !limits.types.includes(type)) {
      throw new AppError('FILE_TYPE_NOT_ALLOWED', `This type of file isn't accepted for a ${label(req.purpose)}. Use ${limits.types.map((t) => t.toUpperCase()).join(', ')}.`, {
        allowed: limits.types,
        contentType: req.contentType,
      });
    }
    if (req.sizeBytes > limits.maxBytes) {
      throw new AppError('FILE_TOO_LARGE', `The file is ${mb(req.sizeBytes)}; the limit for a ${label(req.purpose)} is ${mb(limits.maxBytes)}.`, { maxBytes: limits.maxBytes });
    }

    const now = this.now();
    const day = dateInZone(now, this.timeZone);
    const owner = ownerFilter(input.owner);
    if (owner.kind === 'customer' || owner.kind === 'guest') {
      const perDay = await this.ctx.settings.get('customerUploadsPerDay');
      if ((await this.repo.uploadCount(owner, day)) >= perDay) {
        throw new AppError('QUOTA_EXCEEDED', `You can upload up to ${perDay} files a day. Try again tomorrow.`, { limit: perDay, period: 'day' });
      }
    }
    if (owner.kind === 'seller') {
      const quotaBytes = (await this.ctx.settings.get('sellerStorageQuotaGB')) * 1024 ** 3;
      const usedBytes = await this.repo.storedBytes(owner);
      if (usedBytes + req.sizeBytes > quotaBytes) {
        throw new AppError('QUOTA_EXCEEDED', 'Your store has used all its file storage. Delete files you no longer use.', { quotaBytes, usedBytes });
      }
    }

    const assetId = newId();
    const uploadId = newId();
    const key = `originals/${assetId}.${type}`;
    const expiresAt = new Date(now.getTime() + (await this.ctx.settings.get('uploadUrlTtlMinutes')) * 60_000);
    const ownerLabel = input.owner.label ?? (await this.ownerLabel(input.owner));
    await this.repo.transaction(async (tx) => {
      await tx.insertAsset({
        id: assetId,
        kind: kindOf(type),
        purpose: req.purpose,
        status: assetMachine.initial,
        file_name: fileName,
        content_type: req.contentType,
        size_bytes: req.sizeBytes,
        sha256: req.sha256?.toLowerCase() ?? null,
        phash: null,
        width: null,
        height: null,
        duration_seconds: null,
        page_count: null,
        alt: req.alt?.trim() || null,
        title: null,
        owner_kind: owner.kind,
        owner_id: owner.id,
        owner_label: ownerLabel,
        visibility: visibilityOf(req.purpose),
        storage_bucket: this.storage.buckets.private,
        storage_key: key,
        check_result: null,
        rejection_reason: null,
        removed_reason: null,
        removed_by: null,
        removed_at: null,
        show_placeholder: null,
        retain_until: null,
        expires_at: null,
        created_at: now,
        ready_at: null,
        deleted_at: null,
        processing_spec: null,
      });
      await tx.insertUpload({
        id: uploadId,
        asset_id: assetId,
        expected_bytes: req.sizeBytes,
        expected_sha256: req.sha256?.toLowerCase() ?? null,
        url_expires_at: expiresAt,
        completed_at: null,
        client_ip: input.clientIp && isIP(input.clientIp) ? input.clientIp : null,
        created_by_kind: input.createdBy.kind,
        created_by_id: input.createdBy.id,
      });
      await tx.bumpUploadCounter(owner, day, req.sizeBytes);
    });
    const ticket = { uploadId, assetId, maxBytes: req.sizeBytes, expiresAt: expiresAt.toISOString() };
    // storage the API serves itself (local disk, memory) takes the bytes through PUT /uploads/{id}/content
    if (this.storage.viaApi) {
      const area = input.target?.area ?? (input.uploader === 'staff' ? 'admin' : input.uploader === 'seller' ? 'seller' : 'store');
      const url = input.target ? contentUrl(input.target, uploadId) : `${this.ctx.config.apiUrl}/api/${area}/media/uploads/${uploadId}/content`;
      return { ...ticket, method: 'PUT', url, headers: { 'content-type': req.contentType }, fields: {} };
    }
    if (!this.storage.presignUpload) throw new Error('This storage adapter takes neither API nor direct uploads');
    const signed = await this.storage.presignUpload({ bucket: this.storage.buckets.private, key, contentType: req.contentType, maxBytes: req.sizeBytes, expiresAt });
    return { ...ticket, ...signed };
  }

  /**
   * PUT /uploads/{id}/content, when storage takes uploads through the API (local disk, memory). Streams the
   * bytes of a pending upload the caller reaches into storage, with the checks a signed upload URL makes: not
   * expired, at most the ticket's maxBytes, counted while streaming (a declared Content-Length above it is
   * refused before reading; nothing is stored when the limit is passed). Stored atomically under the declared
   * content type; a retry replaces an earlier attempt. The client then completes the upload. Store and Seller
   * Center reach their own uploads (owner); Admin Center only the uploads the calling staff member started.
   */
  async receiveUploadContent(
    uploadId: string,
    body: Readable | Uint8Array | undefined,
    opts: { area: UploadArea; owner?: OwnerFilter; startedBy?: { kind: string; id: string | null }; declaredBytes?: number },
  ): Promise<void> {
    if (!this.storage.viaApi) throw this.ctx.error('DIRECT_UPLOAD_ONLY', 'Upload the file to the storage URL in the upload ticket.');
    const upload = await this.repo.getUpload(uploadId);
    const inArea = upload && (opts.area !== 'admin' || upload.created_by_kind === 'staff') && startedBy(upload, opts.startedBy);
    const asset = inArea ? await this.repo.getAsset(upload.asset_id, { owner: opts.owner }) : null;
    if (!upload || !asset) throw new AppError('NOT_FOUND', 'Upload not found');
    if (asset.status === 'expired' || this.now() > upload.url_expires_at) throw new AppError('UPLOAD_EXPIRED', 'The upload link expired; start a new upload.');
    if (asset.status !== 'pending_upload' || upload.completed_at) throw new AppError('ILLEGAL_TRANSITION', 'This upload is already complete.', { status: asset.status });
    const maxBytes = Number(upload.expected_bytes);
    const tooLarge = (receivedBytes: number) =>
      new AppError('FILE_TOO_LARGE', `The file is larger than this upload was started for (at most ${mb(maxBytes)}).`, { maxBytes, receivedBytes });
    if (opts.declaredBytes !== undefined && opts.declaredBytes > maxBytes) throw tooLarge(opts.declaredBytes);
    try {
      await this.storage.putStream(asset.storage_bucket, asset.storage_key, chunksOf(body), asset.content_type, { maxBytes });
    } catch (err) {
      if (err instanceof ObjectTooLargeError) throw tooLarge(err.receivedBytes);
      throw err;
    }
  }

  /**
   * Memory storage (tests and tools): the signed upload URL behind an upload ticket's API URL (…/uploads/{id}/content), so
   * tools and tests that "upload" through MemoryStorage.acceptSignedPut keep working with the ticket URL. Null when
   * the URL isn't one, or the upload is unknown. No record scope: it only re-signs what the ticket already granted.
   */
  async signedStorageUrlFor(url: string): Promise<string | null> {
    let path: string;
    try {
      path = new URL(url, 'http://localhost').pathname;
    } catch {
      return null;
    }
    const id = CONTENT_PATH.exec(path)?.[2];
    if (!isUuid(id)) return null;
    const upload = await this.repo.getUpload(id);
    const asset = upload && (await this.repo.getAsset(upload.asset_id));
    if (!upload || !asset || !this.storage.presignUpload) return null;
    const signed = await this.storage.presignUpload({
      bucket: asset.storage_bucket,
      key: asset.storage_key,
      contentType: asset.content_type,
      maxBytes: Number(upload.expected_bytes),
      expiresAt: upload.url_expires_at,
    });
    return signed.url;
  }

  /**
   * POST /uploads/{id}/complete: verifies the stored object (size, sha256) and queues processing (202). Owners reach
   * their own uploads (owner); staff only the uploads they started (startedBy): the response carries the asset, so
   * completing someone else's upload would leak a private file.
   */
  async completeUpload(uploadId: string, opts: { owner?: OwnerFilter; startedBy?: { kind: string; id: string | null }; by: By }): Promise<MediaAsset> {
    const upload = await this.repo.getUpload(uploadId);
    if (!upload || !startedBy(upload, opts.startedBy)) throw new AppError('NOT_FOUND', 'Upload not found');
    const asset = await this.repo.getAsset(upload.asset_id, { owner: opts.owner });
    if (!asset) throw new AppError('NOT_FOUND', 'Upload not found');
    const row = await this.completeAsset(asset, upload, { strict: true, by: opts.by });
    return this.view(row, { signPrivate: true });
  }

  /**
   * complete: by the client (strict: problems are answered) or by the storage notification
   * (problems are ignored, or the file is rejected), whichever comes first.
   */
  private async completeAsset(asset: AssetRow, upload: UploadRow, opts: { strict: boolean; by: By }): Promise<AssetRow> {
    if (asset.status === 'expired') throw new AppError('UPLOAD_EXPIRED', 'The upload link expired; start a new upload.');
    if (asset.status !== 'pending_upload') return asset; // already completed (the other path came first)
    const now = this.now();
    const object = await this.storage.head(asset.storage_bucket, asset.storage_key);
    const expected = Number(upload.expected_bytes);
    if (!object) {
      if (now > upload.url_expires_at) throw new AppError('UPLOAD_EXPIRED', 'The upload link expired; start a new upload.');
      throw new AppError('UPLOAD_INCOMPLETE', "The file hasn't finished uploading.", { expectedBytes: expected, receivedBytes: 0 });
    }
    if (object.sizeBytes < expected) throw new AppError('UPLOAD_INCOMPLETE', "The file hasn't finished uploading.", { expectedBytes: expected, receivedBytes: object.sizeBytes });
    const shaMismatch = Boolean(upload.expected_sha256 && object.sha256 && object.sha256.toLowerCase() !== upload.expected_sha256);
    if (shaMismatch && opts.strict) throw new AppError('CHECKSUM_MISMATCH', "The uploaded file doesn't match its checksum. Upload it again.", { expected: upload.expected_sha256, actual: object.sha256 });
    const mismatch = shaMismatch ? "The uploaded bytes don't match the declared checksum" : object.sizeBytes > expected ? 'The uploaded file is larger than declared' : null;

    const row = await this.repo.transaction(async (tx) => {
      const locked = await tx.getAsset(asset.id, { forUpdate: true });
      if (!locked || locked.status !== 'pending_upload') return locked ?? asset;
      let status = this.next(locked.status, 'complete');
      const patch: Partial<AssetRow> = { status, sha256: object.sha256?.toLowerCase() ?? locked.sha256 };
      if (mismatch) {
        status = this.next(status, 'fail');
        Object.assign(patch, { status, rejection_reason: mismatch });
      } else {
        await tx.insertProcessingJob({ id: newId(), asset_id: asset.id, step: 'scan', status: 'queued', attempts: 0, provider_ref: null, error: null, next_attempt_at: now, created_at: now, finished_at: null });
      }
      await tx.completeUpload(upload.id, now);
      return tx.updateAsset(asset.id, patch);
    });
    if (row.status === 'rejected' && mismatch) this.publishRejected(row, mismatch, opts.by);
    if (row.status === 'processing') this.kickProcessing();
    return row;
  }

  /** POST /webhooks/media/storage-events: completes uploads whose client never called complete. Idempotent per object key and version. */
  async handleStorageEvents(events: StorageEvent[]): Promise<void> {
    const by: By = { actor: { kind: 'provider', name: 'storage' } };
    for (const e of events) {
      const asset = await this.repo.findAssetByStorageKey(e.bucket, e.key);
      if (!asset || asset.status !== 'pending_upload') continue; // unknown object, or already completed
      const upload = await this.repo.uploadOfAsset(asset.id);
      if (!upload) continue;
      try {
        await this.completeAsset(asset, upload, { strict: false, by });
      } catch (err) {
        if (isAppError(err) && (err.code === 'UPLOAD_INCOMPLETE' || err.code === 'UPLOAD_EXPIRED')) {
          this.ctx.log.debug({ key: e.key, code: err.code }, 'storage event for an upload that is not complete');
          continue;
        }
        throw err;
      }
    }
  }

  /* ================================================================ reads */

  /** One asset in an area: owners reach only their own files (another owner's file is 404) */
  async assetFor(id: string, opts: { owner?: OwnerFilter; signPrivate: boolean }): Promise<MediaAsset> {
    return this.view(await this.findAsset(id, opts.owner), { signPrivate: opts.signPrivate });
  }

  async listAssets(filter: AssetFilter, page: PageRequest, opts: { signPrivate: boolean }): Promise<common.Page<MediaAsset>> {
    const result = await this.repo.listAssets(filter, page);
    return { ...result, items: await this.views(result.items, opts) };
  }

  /** File detail: where it is used, whether it can be deleted, and its history */
  async assetDetail(id: string, opts: { owner?: OwnerFilter; signPrivate: boolean; area: 'seller' | 'admin' }): Promise<MediaAssetDetail> {
    const row = await this.findAsset(id, opts.owner);
    return this.detailOf(row, opts);
  }

  private async detailOf(row: AssetRow, opts: { signPrivate: boolean; area: 'seller' | 'admin' }): Promise<MediaAssetDetail> {
    const usages = await this.repo.usagesOf([row.id]);
    const active = usages.filter((u) => !u.detached_at);
    const check = deleteCheck({ retainUntil: row.retain_until }, active, evidenceKinds(usages), this.now(), this.timeZone);
    const statusBlock = assetMachine.can(row.status as Status, 'delete') ? null : STATUS_BLOCK[row.status] ?? `Can't be deleted while ${label(row.status)}`;
    const reasons = [check.reason, statusBlock].filter(Boolean);
    return {
      asset: await this.view(row, { signPrivate: opts.signPrivate }, active.length),
      usages: usages.map(toUsage),
      deletable: check.deletable && !statusBlock,
      deleteBlockedReason: reasons.length ? reasons.join(' · ') : null,
      history: await this.historyOf(row, usages, opts.area),
    };
  }

  /* ================================================================ edits */

  /** PATCH /assets/{id}: alt text and title */
  async updateAsset(id: string, update: AssetUpdate, opts: { owner?: OwnerFilter; platformOnly?: boolean; by: By }): Promise<MediaAsset> {
    if (update.alt && update.alt.length > ALT_MAX) throw invalid('alt', `Alt text is too long (${ALT_MAX} characters at most)`);
    if (update.title && update.title.length > TITLE_MAX) throw invalid('title', `The title is too long (${TITLE_MAX} characters at most)`);
    const row = await this.findAsset(id, opts.owner);
    if (opts.platformOnly) assertPlatformFile(row, 'edited');
    if (row.status === 'deleted' || row.status === 'expired') throw new AppError('ILLEGAL_TRANSITION', `This file is ${row.status}; it can't be edited.`, { status: row.status });
    const patch: Partial<AssetRow> = {};
    if (update.alt !== undefined) patch.alt = update.alt?.trim() || null;
    if (update.title !== undefined) patch.title = update.title?.trim() || null;
    const after = Object.keys(patch).length ? await this.repo.updateAsset(id, patch) : row;
    return this.view(after, { signPrivate: true });
  }

  /** DELETE /assets/{id}: refused while in use (ASSET_IN_USE) or kept as evidence (ASSET_RETAINED) */
  async deleteAsset(id: string, opts: { owner?: OwnerFilter; platformOnly?: boolean; audited?: boolean; by: By }): Promise<void> {
    const row = await this.findAsset(id, opts.owner);
    if (opts.platformOnly) assertPlatformFile(row, 'deleted');
    const before = await this.deleteInternal(row.id, opts.by, { strict: true });
    if (opts.audited && before) {
      await this.audit({ action: 'media.asset.delete', actionLabel: 'Deleted file', category: categoryOf(before), target: this.target(before), before: snapshot(before), after: { status: 'deleted' } }, opts.by);
    }
  }

  /**
   * Deletes when the rules allow it. strict: refusals are thrown (endpoints); otherwise the file is
   * skipped (jobs and consumers). Returns the asset as it was, or null when skipped.
   */
  private async deleteInternal(id: string, by: By, opts: { strict: boolean }): Promise<AssetRow | null> {
    const now = this.now();
    const result = await this.repo.transaction(async (tx) => {
      const row = await tx.getAsset(id, { forUpdate: true });
      if (!row) throw notFound();
      if (!assetMachine.can(row.status as Status, 'delete')) {
        if (!opts.strict) return null;
        this.next(row.status, 'delete'); // throws ILLEGAL_TRANSITION
      }
      const usages = await tx.usagesOf([id]);
      const active = usages.filter((u) => !u.detached_at);
      const check = deleteCheck({ retainUntil: row.retain_until }, active, evidenceKinds(usages), now, this.timeZone);
      if (!check.deletable) {
        if (!opts.strict) return null;
        if (check.code === 'ASSET_IN_USE') throw new AppError('ASSET_IN_USE', `${check.reason}; remove it there first.`, { usages: active.map(toUsage) });
        throw new AppError('ASSET_RETAINED', `${check.reason}.`, { retainUntil: row.retain_until!.toISOString() });
      }
      await tx.updateAsset(id, { status: this.next(row.status, 'delete'), deleted_at: now });
      return row;
    });
    if (result) this.ctx.events.publish('media.asset.deleted', { assetId: id, owner: ownerOf(result) }, { actor: by.actor, requestId: by.requestId });
    return result;
  }

  /* ================================================================ image checks */

  async runImageCheck(id: string, rules: ImageRules, opts: { owner?: OwnerFilter; rulesSource?: string | null }): Promise<ImageCheckResult> {
    const row = await this.findAsset(id, opts.owner);
    if (row.kind !== 'image') throw invalid('assetId', 'Only images can be checked against image rules');
    if (row.status !== 'ready') {
      throw new AppError('ILLEGAL_TRANSITION', row.status === 'processing' || row.status === 'pending_upload' ? 'The image is still being processed; check it once it is ready.' : `This image is ${label(row.status)}; it can't be checked.`, {
        status: row.status,
      });
    }
    const base = checkOf(row)?.measured ?? (await this.measureStored(row));
    const duplicateOf = row.phash != null ? await this.repo.findDuplicate(ownerFilter(ownerOf(row)), row.phash, { id: row.id, createdAt: row.created_at }) : null;
    const measured: ImageMeasurements = { ...base, duplicateOf };
    const issues = evaluateImage({ format: formatOfRow(row), sizeBytes: Number(row.size_bytes), measured }, rules, await this.baseline());
    const result: ImageCheckResult = { assetId: id, passed: passed(issues), rulesSource: opts.rulesSource ?? null, measured, issues, checkedAt: this.now().toISOString() };
    await this.repo.updateAsset(id, { check_result: result });
    return result;
  }

  private async baseline(): Promise<BaselineRules> {
    return (await this.ctx.settings.get('baselineImageRules')) as unknown as BaselineRules;
  }

  /** Measurements of a ready image that has none stored (e.g. a generated image) */
  private async measureStored(row: AssetRow): Promise<ImageMeasurements> {
    const body = (await this.storage.get(this.storage.buckets.private, processedKey(row.id))) ?? (await this.storage.get(row.storage_bucket, row.storage_key));
    const probe = body && (await this.providers.processor.probe(body, { contentType: row.content_type, fileName: row.file_name }));
    if (!body || !probe) return { width: row.width ?? 0, height: row.height ?? 0, aspect: row.width && row.height ? row.width / row.height : 0, hasAlpha: false };
    const { phash: _p, ...m } = await this.providers.processor.measure(body, probe, { fileName: row.file_name });
    return m;
  }

  /* ================================================================ downloads */

  /** Signed download of a file the caller owns (store, seller) */
  async ownDownload(id: string, owner: OwnerFilter): Promise<DownloadLink> {
    const row = await this.findAsset(id, owner);
    if (row.status === 'removed') throw new AppError('ILLEGAL_TRANSITION', 'This file was taken down and can no longer be downloaded.', { status: row.status });
    if (row.status !== 'ready') throw notUsable(row);
    return this.downloadLink(row);
  }

  /** GET /api/admin/media/assets/{id}/download: every link is recorded with the reason */
  async staffDownload(id: string, reason: string, by: By): Promise<DownloadLink> {
    if (!reason.trim()) throw invalid('reason', 'Say why you need this file');
    const row = await this.findAsset(id);
    // gift card code files open only through their owning module (wallet), which checks access first
    if (SENSITIVE_GENERATED.includes(row.purpose)) throw notFound();
    if (!['ready', 'removed', 'rejected'].includes(row.status) || row.storage_bucket === ERASED_BUCKET) throw notUsable(row);
    if (!(await this.storage.head(row.storage_bucket, row.storage_key))) throw new AppError('NOT_FOUND', 'The stored file is missing');
    const link = await this.downloadLink(row);
    await this.audit({ action: 'media.asset.download', actionLabel: 'Downloaded private file', category: categoryOf(row), target: this.target(row), reason: reason.trim() }, by);
    return link;
  }

  private async downloadLink(row: AssetRow): Promise<DownloadLink> {
    const ttl = await this.ctx.settings.get('downloadUrlTtlMinutes');
    const expiresAt = new Date(this.now().getTime() + ttl * 60_000);
    // documents and spreadsheets are never served inline
    const url = await this.storage.presignDownload({ bucket: row.storage_bucket, key: row.storage_key, expiresAt, fileName: row.file_name, contentType: row.content_type, inline: false });
    return { url, expiresAt: expiresAt.toISOString(), fileName: row.file_name, contentType: row.content_type, sizeBytes: Number(row.size_bytes) };
  }

  /* ================================================================ takedown */

  /** Staff takedown: works even when in use; public URLs serve a placeholder (or nothing), the original stays private */
  async removeAsset(id: string, input: { reason: string; showPlaceholder: boolean }, by: By): Promise<MediaAssetDetail> {
    const reason = input.reason?.trim();
    if (!reason) throw invalid('reason', 'A reason is required');
    const { before, after, usages } = await this.repo.transaction(async (tx) => {
      const before = await tx.getAsset(id, { forUpdate: true });
      if (!before) throw notFound();
      const status = this.next(before.status, 'remove');
      const after = await tx.updateAsset(id, { status, removed_reason: reason, removed_by: by.actor.id ?? by.actor.name ?? by.actor.kind, removed_at: this.now(), show_placeholder: input.showPlaceholder });
      return { before, after, usages: await tx.usagesOf([id], { activeOnly: true }) };
    });
    await this.safely('take down public files', () => this.takeDownPublic(after, input.showPlaceholder));
    this.ctx.events.publish('media.asset.removed', { assetId: id, reason, usages: usages.map(toUsage), by: by.actor }, { actor: by.actor, requestId: by.requestId });
    await this.audit(
      {
        action: 'media.asset.remove',
        actionLabel: 'Took down file',
        category: categoryOf(after),
        target: this.target(after),
        reason,
        before: snapshot(before),
        after: snapshot(after),
        visibleToSeller: after.owner_kind === 'seller',
      },
      by,
    );
    return this.detailOf(after, { signPrivate: true, area: 'admin' });
  }

  async restoreAsset(id: string, reason: string, by: By): Promise<MediaAssetDetail> {
    if (!reason?.trim()) throw invalid('reason', 'A reason is required');
    const { before, after, usages } = await this.repo.transaction(async (tx) => {
      const before = await tx.getAsset(id, { forUpdate: true });
      if (!before) throw notFound();
      const status = this.next(before.status, 'restore');
      const after = await tx.updateAsset(id, { status, removed_reason: null, removed_by: null, removed_at: null, show_placeholder: null });
      return { before, after, usages: await tx.usagesOf([id], { activeOnly: true }) };
    });
    await this.safely('restore public files', () => this.restorePublic(after));
    this.ctx.events.publish('media.asset.restored', { assetId: id, usages: usages.map(toUsage), by: by.actor }, { actor: by.actor, requestId: by.requestId });
    await this.audit(
      { action: 'media.asset.restore', actionLabel: 'Restored file', category: categoryOf(after), target: this.target(after), reason: reason.trim(), before: snapshot(before), after: snapshot(after), visibleToSeller: after.owner_kind === 'seller' },
      by,
    );
    return this.detailOf(after, { signPrivate: true, area: 'admin' });
  }

  /** Public renditions move to a private quarantine copy; the public key serves the placeholder or nothing */
  private async takeDownPublic(row: AssetRow, showPlaceholder: boolean) {
    if (row.visibility !== 'public') return;
    const pub = this.storage.buckets.public;
    const priv = this.storage.buckets.private;
    const placeholder = showPlaceholder ? await this.placeholder() : null;
    for (const r of await this.repo.renditionsOf([row.id])) {
      if (!(await this.storage.head(priv, quarantineKey(r.storage_key)))) await this.storage.copy({ bucket: pub, key: r.storage_key }, { bucket: priv, key: quarantineKey(r.storage_key) });
      if (placeholder) await this.storage.put(pub, r.storage_key, placeholder, 'image/png');
      else await this.storage.delete(pub, r.storage_key);
    }
  }

  private async restorePublic(row: AssetRow) {
    if (row.visibility !== 'public') return;
    const pub = this.storage.buckets.public;
    const priv = this.storage.buckets.private;
    for (const r of await this.repo.renditionsOf([row.id])) {
      if (await this.storage.copy({ bucket: priv, key: quarantineKey(r.storage_key) }, { bucket: pub, key: r.storage_key })) await this.storage.delete(priv, quarantineKey(r.storage_key));
    }
  }

  private async placeholder(): Promise<Uint8Array> {
    if (!(await this.storage.head(this.storage.buckets.public, PLACEHOLDER_KEY))) await this.storage.put(this.storage.buckets.public, PLACEHOLDER_KEY, PLACEHOLDER_PNG, 'image/png');
    return PLACEHOLDER_PNG;
  }

  /* ================================================================ events consumed */

  /** sellers.seller.closed: Mark the seller's never-used files for deletion after orphanGraceDays; evidence and files used by past orders' snapshots are kept until retainUntil */
  async onSellerClosedFromSellers(event: EventPayload<'sellers.seller.closed'>): Promise<void> {
    const owner: OwnerFilter = { kind: 'seller', id: event.sellerId };
    const now = this.now();
    const mark = new Date(now.getTime() + (await this.ctx.settings.get('orphanGraceDays')) * 86_400_000);
    await this.expirePending(await this.repo.assetsOfOwner(owner, ['pending_upload']));
    // sweep-orphans deletes marked files once nothing uses them and their retention has passed
    for (const row of await this.repo.assetsOfOwner(owner, ['processing', 'ready', 'rejected'])) {
      if (isGeneratedPurpose(row.purpose)) continue; // statements and exports follow their own expiry
      if (!row.expires_at || row.expires_at > mark) await this.repo.updateAsset(row.id, { expires_at: mark });
    }
  }

  /** customers.account.closed: Delete the customer's unused uploads; evidence attached to returns and cases is kept until retainUntil, then purged */
  async onAccountClosedFromCustomers(event: EventPayload<'customers.account.closed'>): Promise<void> {
    const owner: OwnerFilter = { kind: 'customer', id: event.userId };
    const now = this.now();
    const by: By = { actor: SYSTEM_ACTOR };
    await this.expirePending(await this.repo.assetsOfOwner(owner, ['pending_upload']));
    for (const row of await this.repo.assetsOfOwner(owner, ['processing', 'ready', 'rejected'])) {
      if (isGeneratedPurpose(row.purpose)) continue;
      const deleted = await this.deleteInternal(row.id, by, { strict: false });
      // in use or retained: deleted by sweep-orphans as soon as the rules allow
      if (!deleted && (!row.expires_at || row.expires_at > now)) await this.repo.updateAsset(row.id, { expires_at: now });
    }
  }

  /* ================================================================ jobs */

  /** Job media.process (every minute, and started at once when an upload completes): Scan, probe, strip metadata, build renditions, run baseline image checks, start video transcodes; retry with backoff; publish media.asset.ready or media.asset.rejected */
  async process(): Promise<{ processed: number }> {
    let processed = 0;
    for (let round = 0; round < 100; round++) {
      const now = this.now();
      const jobs = await this.repo.claimProcessingJobs(now, new Date(now.getTime() + PROCESSING_LEASE_MS), 10);
      if (!jobs.length) break;
      for (const job of jobs) {
        await this.runProcessingJob(job);
        processed++;
      }
    }
    return { processed };
  }

  private async runProcessingJob(job: ProcessingJobRow) {
    const asset = await this.repo.getAsset(job.asset_id);
    if (!asset || asset.status !== 'processing') {
      await this.repo.updateProcessingJob(job.id, { status: 'cancelled', finished_at: this.now(), next_attempt_at: null });
      return;
    }
    let outcome: ProcessingOutcome;
    try {
      outcome = await this.pipeline(asset, job);
    } catch (err) {
      // provider trouble: retry with backoff, then give up
      const message = (err as Error).message ?? String(err);
      if (job.attempts < MAX_PROCESSING_ATTEMPTS) {
        const delay = 60_000 * 2 ** (job.attempts - 1);
        await this.repo.updateProcessingJob(job.id, { status: 'queued', error: message, next_attempt_at: new Date(this.now().getTime() + delay) });
        this.ctx.log.warn({ err, assetId: asset.id, attempt: job.attempts }, 'media processing failed; will retry');
        return;
      }
      outcome = { result: 'rejected', reason: 'The file could not be processed. Try uploading it again.' };
    }
    await this.finishProcessing(asset.id, job, outcome);
  }

  private async finishProcessing(assetId: string, job: ProcessingJobRow, outcome: ProcessingOutcome) {
    const now = this.now();
    if (outcome.result === 'waiting') return;
    const row = await this.repo.transaction(async (tx) => {
      const locked = await tx.getAsset(assetId, { forUpdate: true });
      if (!locked || locked.status !== 'processing') return null;
      await tx.updateProcessingJob(job.id, { status: outcome.result === 'ready' ? 'succeeded' : 'failed', finished_at: now, next_attempt_at: null, error: outcome.result === 'rejected' ? outcome.reason : null });
      if (outcome.result === 'ready') {
        if (outcome.renditions.length) await tx.saveRenditions(assetId, outcome.renditions);
        return tx.updateAsset(assetId, { ...outcome.patch, status: this.next(locked.status, 'succeed'), ready_at: now });
      }
      return tx.updateAsset(assetId, { status: this.next(locked.status, 'fail'), rejection_reason: outcome.reason });
    });
    if (!row) return;
    if (outcome.result === 'rejected' && outcome.eraseOriginal) await this.safely('delete an infected upload', () => this.storage.delete(row.storage_bucket, row.storage_key));
    if (row.status === 'ready') this.ctx.events.publish('media.asset.ready', { assetId, kind: row.kind, purpose: row.purpose, owner: ownerOf(row) }, { actor: SYSTEM_ACTOR });
    else this.publishRejected(row, outcome.result === 'rejected' ? outcome.reason : 'Rejected', { actor: SYSTEM_ACTOR });
  }

  /** scan → probe → strip → renditions → check, or → transcode for videos */
  private async pipeline(asset: AssetRow, job: ProcessingJobRow): Promise<ProcessingOutcome> {
    const { processor, scanner } = this.providers;
    const step = (s: ProcessingJobRow['step']) => this.repo.updateProcessingJob(job.id, { step: s });

    await step('scan');
    const body = await this.storage.get(asset.storage_bucket, asset.storage_key);
    if (!body) return { result: 'rejected', reason: 'The uploaded file is missing. Upload it again.' };
    const scan = await scanner.scan({ fileName: asset.file_name, contentType: asset.content_type, body });
    if (!scan.clean) return { result: 'rejected', reason: `Malware found in the file${scan.threat ? ` (${scan.threat})` : ''}`, eraseOriginal: true };

    await step('probe');
    const probe = await processor.probe(body, { contentType: asset.content_type, fileName: asset.file_name });
    if (!probe) return { result: 'rejected', reason: 'The file is unsupported or corrupt.' };
    const limits = limitFor(asset.purpose as UploadRequest['purpose'], (await this.ctx.settings.get('limitsByPurpose')) as unknown as Record<string, PurposeLimit>);
    const product = isProductImage(asset);
    if (!limits.types.includes(probe.format) || (product && probe.format === 'heic')) {
      return { result: 'rejected', reason: `The file is really a ${probe.format.toUpperCase()}, which isn't accepted for a ${label(asset.purpose)}.` };
    }
    if (probe.kind === 'image' && (!probe.width || !probe.height || Math.max(probe.width, probe.height) > MAX_IMAGE_SIDE || probe.width * probe.height > MAX_IMAGE_PIXELS)) {
      return { result: 'rejected', reason: 'The image dimensions are outside the limits.' };
    }
    const patch: AssetPatch = {
      kind: probe.kind,
      content_type: MIME_OF[probe.format as FileType] ?? asset.content_type,
      width: probe.width ?? null,
      height: probe.height ?? null,
      duration_seconds: probe.durationSeconds == null ? null : String(probe.durationSeconds),
      page_count: probe.pageCount ?? null,
    };

    if (probe.kind === 'video' && TRANSCODED_PURPOSES.includes(asset.purpose)) {
      await step('transcode');
      const { providerJobId } = await processor.startTranscode({ assetId: asset.id, bucket: asset.storage_bucket, key: asset.storage_key });
      await this.repo.updateAsset(asset.id, patch);
      await this.repo.updateProcessingJob(job.id, { status: 'waiting', provider_ref: providerJobId, next_attempt_at: null });
      return { result: 'waiting' };
    }
    if (probe.kind !== 'image') return { result: 'ready', patch, renditions: [] };

    // product images: the spec in force. Seller uploads (the Seller Center uploads only product photos with this
    // purpose) that are off the ratio or smaller than the detail size are refused; staff uploads are checked when
    // they are attached to a product (the purpose also serves category and content images).
    const setting = product ? await this.productImageSetting() : null;
    const spec = setting ? resolveSpec(setting) : null;
    if (spec && asset.owner_kind === 'seller') {
      const issues = productImageIssues({ width: probe.width ?? 0, height: probe.height ?? 0 }, spec);
      if (issues.length) return { result: 'rejected', reason: issues.map((i) => i.message).join(' ') };
    }

    // privacy: EXIF and GPS are stripped before any rendition exists
    await step('strip');
    const stripped = await processor.strip(body, probe.format);
    await this.storage.put(this.storage.buckets.private, processedKey(asset.id), stripped, MIME_OF[probe.format as FileType] ?? asset.content_type);

    await step('renditions');
    const bucket = asset.visibility === 'public' ? this.storage.buckets.public : this.storage.buckets.private;
    const targets = spec
      ? productTargets(probe.width ?? 0, probe.height ?? 0, spec)
      : widthTargets((await this.ctx.settings.get('renditionWidths')) as unknown as Record<string, number>, probe.width ?? 0);
    const renditions = await this.storeRenditions(asset, bucket, await processor.renditions(stripped, probe, targets, { quality: spec?.quality }));
    if (setting) patch.processing_spec = { ...setting, settingsVersion: this.productImageVersion } satisfies ProcessingSpec;

    await step('check');
    const { phash, ...measured } = await processor.measure(stripped, probe, { fileName: asset.file_name });
    const duplicateOf = await this.repo.findDuplicate(ownerFilter(ownerOf(asset)), phash, { id: asset.id, createdAt: asset.created_at });
    const m: ImageMeasurements = { ...measured, duplicateOf };
    // a product image the spec accepts needs no other minimum size (the spec's detail size replaces minShortSide)
    const specOk = spec && !productImageIssues({ width: m.width, height: m.height }, spec).length;
    const issues = evaluateImage({ format: probe.format, sizeBytes: Number(asset.size_bytes), measured: m }, { aspectRatios: [], formats: [], ...(specOk ? { minShortSide: 0 } : {}) }, await this.baseline());
    patch.phash = phash;
    patch.check_result = { assetId: asset.id, passed: passed(issues), rulesSource: 'Platform baseline', measured: m, issues, checkedAt: this.now().toISOString() } satisfies ImageCheckResult;
    return { result: 'ready', patch, renditions };
  }

  /** Writes rendition files (product image keys stay the same across rebuilds, so their links keep working) */
  private async storeRenditions(asset: AssetRow, bucket: string, outputs: { size: string; width: number; height: number; format: string; body: Uint8Array }[]): Promise<RenditionRow[]> {
    // the files are independent: written at once
    return Promise.all(
      outputs.map(async (out) => {
        const key = renditionKey(asset.id, out.size, out.format);
        await this.storage.put(bucket, key, out.body, MIME_OF[out.format as FileType] ?? 'image/webp');
        return {
          asset_id: asset.id,
          size: out.size,
          storage_key: key,
          url: asset.visibility === 'public' ? this.storage.publicUrl(key) : this.storage.objectUrl(bucket, key),
          width: out.width,
          height: out.height,
          format: out.format,
          bytes: out.body.byteLength,
        };
      }),
    );
  }

  /** POST /webhooks/media/processing-results: video transcoding results, matched by provider job reference. Idempotent. */
  async handleProcessingResult(body: { providerJobId: string; status: 'succeeded' | 'failed'; outputs: Rendition[]; durationSeconds?: number | null; error?: string | null }): Promise<void> {
    const job = await this.repo.processingJobByProviderRef(body.providerJobId);
    if (!job || job.step !== 'transcode') {
      this.ctx.log.debug({ providerJobId: body.providerJobId }, 'processing result for an unknown job');
      return;
    }
    if (job.status === 'succeeded' || job.status === 'failed' || job.status === 'cancelled') return; // already handled
    const asset = await this.repo.getAsset(job.asset_id);
    if (!asset) return;
    if (body.status === 'failed') {
      await this.finishProcessing(asset.id, job, { result: 'rejected', reason: body.error?.trim() || 'The video could not be processed.' });
      return;
    }
    const renditions: RenditionRow[] = body.outputs.map((o) => ({
      asset_id: asset.id,
      size: o.size,
      storage_key: keyOfUrl(o.url) ?? renditionKey(asset.id, o.size, o.format),
      url: o.url,
      width: o.width,
      height: o.height,
      format: o.format,
      bytes: o.bytes,
    }));
    const largest = body.outputs.filter((o) => o.size.startsWith('video_')).sort((a, b) => b.width - a.width)[0] ?? body.outputs[0];
    await this.finishProcessing(asset.id, job, {
      result: 'ready',
      renditions,
      patch: {
        width: largest?.width ?? asset.width,
        height: largest?.height ?? asset.height,
        duration_seconds: body.durationSeconds == null ? asset.duration_seconds : String(body.durationSeconds),
      },
    });
  }

  /** settings.setting.changed: a new media.productImage starts media.rebuild-product-renditions at once */
  async onSettingChangedFromSettings(event: EventPayload<'settings.setting.changed'>): Promise<void> {
    if (event.key !== 'media.productImage') return;
    this.productImageVersion = event.version;
    this.ctx.log.info({ version: event.version, from: event.from, to: event.to }, 'media: the product image spec changed; rebuilding product images');
    if (this.ctx.config.jobsEnabled) setImmediate(() => void this.ctx.jobs.runNow('media.rebuild-product-renditions'));
  }

  /**
   * Job media.rebuild-product-renditions (hourly, and at once when media.productImage changes): ready product
   * images whose renditions were built with another spec (or before the spec existed) get detail and thumb rebuilt
   * from the stored original at the spec in force, under the same keys (links keep working; never enlarged; older
   * small to zoom files stay for order snapshots and old links), and their wrong_aspect flag set or cleared. At most
   * rebuildBatchLimit images per run, in batches with a pause between them. Idempotent: a rebuilt image records
   * the spec (processing_spec) and is skipped until the spec changes again.
   */
  async rebuildProductRenditions(): Promise<{ rebuilt: number; flagged: number; cleared: number; failed: number }> {
    const setting = await this.productImageSetting();
    const spec = resolveSpec(setting);
    const limit = await this.ctx.settings.get('rebuildBatchLimit');
    const counts = { rebuilt: 0, flagged: 0, cleared: 0, failed: 0 };
    while (counts.rebuilt + counts.failed < limit) {
      const rows = await this.repo.productImagesToRebuild(setting, Math.min(REBUILD_BATCH, limit - counts.rebuilt - counts.failed));
      if (!rows.length) break;
      const changed: { row: AssetRow; recrop: boolean }[] = [];
      for (const row of rows) {
        try {
          const recrop = await this.rebuildProductImage(row, setting, spec);
          counts.rebuilt++;
          if (recrop === null) continue;
          if (recrop) counts.flagged++;
          else counts.cleared++;
          changed.push({ row, recrop });
        } catch (err) {
          // recorded as built with this spec, so a file that can't be read isn't retried every run
          counts.failed++;
          this.ctx.log.warn({ err, assetId: row.id }, 'media: could not rebuild a product image');
          await this.repo.updateAsset(row.id, { processing_spec: { ...setting, settingsVersion: this.productImageVersion, failed: true } });
        }
      }
      if (changed.length) {
        // the usages of every changed image in one read
        const usages = groupBy(await this.repo.usagesOf(changed.map((c) => c.row.id), { activeOnly: true }), (u) => u.asset_id);
        const items: RecropItem[] = changed.map(({ row, recrop }) => ({ assetId: row.id, owner: ownerOf(row), recrop, usages: (usages.get(row.id) ?? []).map(toUsage) }));
        this.ctx.events.publish('media.product_images.recrop_changed', { aspectRatio: spec.aspectRatio, items }, { actor: SYSTEM_ACTOR });
      }
      if (rows.length === REBUILD_BATCH) await sleep(REBUILD_PAUSE_MS);
    }
    if (counts.rebuilt || counts.failed) {
      this.ctx.log.info({ ...counts, spec: setting }, 'media: product images rebuilt at the product image spec');
      await this.audit(
        {
          action: 'media.product_images.rebuild',
          actionLabel: 'Rebuilt product images at the product image spec',
          category: 'catalog',
          target: { type: 'setting', id: 'media.productImage', label: 'Product images', sellerId: null, screen: 'admin/settings' },
          reason: `${counts.rebuilt} rebuilt, ${counts.flagged} to re-crop, ${counts.cleared} no longer to re-crop, ${counts.failed} failed`,
          after: { spec: setting, ...counts },
        },
        { actor: SYSTEM_ACTOR },
      );
      this.ctx.events.publish('media.product_images.rebuilt', { aspectRatio: spec.aspectRatio, settingsVersion: this.productImageVersion, ...counts }, { actor: SYSTEM_ACTOR });
    }
    return counts;
  }

  /** Rebuilds one product image; returns its new re-crop flag when it changed (true: off the ratio), else null */
  private async rebuildProductImage(row: AssetRow, setting: ProductImageSetting, spec: ProductImageSpec): Promise<boolean | null> {
    const { processor } = this.providers;
    const stored = await this.storage.get(this.storage.buckets.private, processedKey(row.id));
    const original = stored ?? (await this.storage.get(row.storage_bucket, row.storage_key));
    if (!original) throw new Error('The stored file is missing');
    const probe = await processor.probe(original, { contentType: row.content_type, fileName: row.file_name });
    if (!probe || probe.kind !== 'image' || !probe.width || !probe.height) throw new Error('The stored file is not a readable image');
    // the stripped copy is the source of every rendition; an image without one is stripped now
    const source = stored ?? (await processor.strip(original, probe.format));
    if (!stored) await this.storage.put(this.storage.buckets.private, processedKey(row.id), source, MIME_OF[probe.format as FileType] ?? row.content_type);
    const bucket = row.visibility === 'public' ? this.storage.buckets.public : this.storage.buckets.private;
    const renditions = await this.storeRenditions(row, bucket, await processor.renditions(source, probe, productTargets(probe.width, probe.height, spec), { quality: spec.quality }));

    // the wrong_aspect warning: set while the image is off the ratio (not blocking: the product stays live)
    const check: ImageCheckResult = checkOf(row) ?? {
      assetId: row.id,
      passed: true,
      rulesSource: 'Platform baseline',
      measured: { width: probe.width, height: probe.height, aspect: Math.round((probe.width / probe.height) * 10_000) / 10_000, hasAlpha: Boolean(probe.hasAlpha) },
      issues: [],
      checkedAt: this.now().toISOString(),
    };
    const isFlag = (i: ImageIssue) => i.code === 'wrong_aspect' && i.severity === 'warning';
    const flaggedBefore = check.issues.some(isFlag);
    const flagged = !hasRatio(probe.width, probe.height, spec);
    const patch: AssetPatch = { processing_spec: { ...setting, settingsVersion: this.productImageVersion } satisfies ProcessingSpec };
    if (flagged || flaggedBefore) {
      const issues: ImageIssue[] = [...check.issues.filter((i) => !isFlag(i)), ...(flagged ? [{ code: 'wrong_aspect' as const, severity: 'warning' as const, message: recropMessage(spec) }] : [])];
      patch.check_result = { ...check, issues, passed: passed(issues), checkedAt: this.now().toISOString() } satisfies ImageCheckResult;
    }
    await this.repo.transaction(async (tx) => {
      await tx.saveRenditions(row.id, renditions);
      await tx.updateAsset(row.id, patch);
    });
    return flagged === flaggedBefore ? null : flagged;
  }

  /** Job media.expire-uploads (hourly): Expire pending uploads past pendingUploadExpiryHours and delete partial objects */
  async expireUploads(): Promise<{ expired: number }> {
    const cutoff = new Date(this.now().getTime() - (await this.ctx.settings.get('pendingUploadExpiryHours')) * 3_600_000);
    let expired = 0;
    for (;;) {
      const rows = await this.repo.pendingUploadsBefore(cutoff, BATCH);
      expired += await this.expirePending(rows);
      if (rows.length < BATCH) return { expired };
    }
  }

  private async expirePending(rows: AssetRow[]): Promise<number> {
    let n = 0;
    for (const row of rows) {
      const done = await this.repo.transaction(async (tx) => {
        const locked = await tx.getAsset(row.id, { forUpdate: true });
        if (!locked || locked.status !== 'pending_upload') return false;
        await tx.updateAsset(row.id, { status: this.next(locked.status, 'expire') });
        return true;
      });
      if (done) {
        n++;
        await this.safely('delete a partial upload', () => this.storage.delete(row.storage_bucket, row.storage_key));
      }
    }
    return n;
  }

  /** Job media.sweep-orphans (daily): Delete ready files never attached to anything after orphanGraceDays (except generated files, which follow their own expiry) */
  async sweepOrphans(): Promise<{ deleted: number }> {
    const now = this.now();
    const cutoff = new Date(now.getTime() - (await this.ctx.settings.get('orphanGraceDays')) * 86_400_000);
    return { deleted: await this.deleteAll(() => this.repo.orphansToSweep(cutoff, now, GENERATED_PURPOSES, BATCH)) };
  }

  /** Job media.expire-generated (hourly): Delete generated files (exports, reports) past expires_at */
  async expireGenerated(): Promise<{ deleted: number }> {
    return { deleted: await this.deleteAll(() => this.repo.generatedExpired(this.now(), GENERATED_PURPOSES, BATCH)) };
  }

  /** Deletes candidates in bounded batches until none are left (or none of a batch could be deleted) */
  private async deleteAll(next: () => Promise<AssetRow[]>): Promise<number> {
    let deleted = 0;
    const skipped = new Set<string>();
    for (;;) {
      const rows = (await next()).filter((r) => !skipped.has(r.id));
      if (!rows.length) return deleted;
      for (const row of rows) {
        if (await this.deleteInternal(row.id, { actor: SYSTEM_ACTOR }, { strict: false })) deleted++;
        else skipped.add(row.id);
      }
    }
  }

  /** Job media.purge-deleted (daily): Erase storage objects of deleted assets after deletedGraceDays and of removed evidence after retainUntil */
  async purgeDeleted(): Promise<{ purged: number; erased: number }> {
    const now = this.now();
    let purged = 0;
    let erased = 0;
    const skipped = new Set<string>();
    // removed evidence past its retention: purge → deleted, erased now
    for (;;) {
      const rows = (await this.repo.removedPastRetention(now, BATCH)).filter((r) => !skipped.has(r.id));
      if (!rows.length) break;
      for (const row of rows) {
        const before = await this.repo.transaction(async (tx) => {
          const locked = await tx.getAsset(row.id, { forUpdate: true });
          if (!locked || locked.status !== 'removed' || !locked.retain_until || locked.retain_until > now) return null;
          if ((await tx.usagesOf([row.id], { activeOnly: true })).length) return null; // still attached to an open record
          await tx.updateAsset(row.id, { status: this.next(locked.status, 'purge'), deleted_at: now });
          return locked;
        });
        if (!before) {
          skipped.add(row.id);
          continue;
        }
        purged++;
        this.ctx.events.publish('media.asset.deleted', { assetId: row.id, owner: ownerOf(before) }, { actor: SYSTEM_ACTOR });
        await this.erase(before);
        erased++;
      }
    }
    // deleted files past the grace period
    const cutoff = new Date(now.getTime() - (await this.ctx.settings.get('deletedGraceDays')) * 86_400_000);
    for (;;) {
      const rows = await this.repo.deletedToErase(cutoff, BATCH);
      for (const row of rows) {
        await this.erase(row);
        erased++;
      }
      if (rows.length < BATCH) break;
    }
    return { purged, erased };
  }

  /** Erases every storage object of an asset (original, processed copy, renditions, quarantine copies) */
  private async erase(row: AssetRow) {
    const { buckets } = this.storage;
    await this.storage.delete(row.storage_bucket, row.storage_key);
    await this.storage.delete(buckets.private, processedKey(row.id));
    for (const r of await this.repo.renditionsOf([row.id])) {
      await this.storage.delete(buckets.public, r.storage_key);
      await this.storage.delete(buckets.private, r.storage_key);
      await this.storage.delete(buckets.private, quarantineKey(r.storage_key));
    }
    await this.repo.transaction(async (tx) => {
      await tx.deleteRenditions(row.id);
      await tx.updateAsset(row.id, { storage_bucket: ERASED_BUCKET });
    });
  }

  /** Job media.reconcile-storage (weekly): Compare storage listing with assets; report orphaned objects and missing files */
  async reconcileStorage(): Promise<{ objects: number; orphaned: string[]; missing: string[] }> {
    const { buckets } = this.storage;
    const known = new Set<string>();
    const k = (bucket: string, key: string) => `${bucket}\u0000${key}`;
    const missing: string[] = [];
    let after: string | null = null;
    for (;;) {
      const refs = await this.repo.storageRefs(after, 500);
      if (!refs.length) break;
      after = refs.at(-1)!.id;
      for (const r of refs) {
        known.add(k(r.bucket, r.key));
        known.add(k(buckets.private, processedKey(r.id)));
        if (['processing', 'ready', 'removed'].includes(r.status) && !(await this.storage.head(r.bucket, r.key))) missing.push(r.id);
      }
      for (const r of await this.repo.renditionsOf(refs.map((x) => x.id))) {
        known.add(k(buckets.public, r.storage_key));
        known.add(k(buckets.private, r.storage_key));
        known.add(k(buckets.private, quarantineKey(r.storage_key)));
      }
    }
    const orphaned: string[] = [];
    let objects = 0;
    for (const bucket of [buckets.public, buckets.private]) {
      let cursor: string | undefined;
      for (;;) {
        const keys = await this.storage.list(bucket, { after: cursor, limit: 1000 });
        if (!keys.length) break;
        cursor = keys.at(-1);
        for (const key of keys) {
          objects++;
          if (key.startsWith('placeholders/')) continue;
          if (!known.has(k(bucket, key))) orphaned.push(`${bucket}/${key}`);
        }
      }
    }
    if (orphaned.length || missing.length) {
      this.ctx.log.warn({ orphaned: orphaned.length, missing: missing.length, orphanedSample: orphaned.slice(0, 20), missingSample: missing.slice(0, 20) }, 'media storage does not match the assets');
    } else {
      this.ctx.log.info({ objects }, 'media storage matches the assets');
    }
    return { objects, orphaned, missing };
  }

  /* ================================================================ helpers */

  private async findAsset(id: string, owner?: OwnerFilter): Promise<AssetRow> {
    const row = await this.repo.getAsset(id, { owner });
    if (!row || (owner && GONE.includes(row.status))) throw notFound();
    return row;
  }

  private async view(row: AssetRow, opts: { signPrivate: boolean }, usageCount?: number): Promise<MediaAsset> {
    return (await this.views([row], opts, usageCount === undefined ? undefined : new Map([[row.id, usageCount]])))[0]!;
  }

  private async views(rows: AssetRow[], opts: { signPrivate: boolean }, counts?: Map<string, number>): Promise<MediaAsset[]> {
    if (!rows.length) return [];
    const ids = rows.map((r) => r.id);
    const [renditions, usages] = await Promise.all([this.repo.renditionsOf(ids), counts ? Promise.resolve([] as UsageRow[]) : this.repo.usagesOf(ids, { activeOnly: true })]);
    const byAsset = groupBy(renditions, (r) => r.asset_id);
    const usageCounts = counts ?? new Map<string, number>();
    if (!counts) for (const u of usages) usageCounts.set(u.asset_id, (usageCounts.get(u.asset_id) ?? 0) + 1);
    const ttl = await this.ctx.settings.get('downloadUrlTtlMinutes');
    return Promise.all(
      rows.map(async (row) => {
        const rs = byAsset.get(row.id) ?? [];
        let list: Rendition[] = [];
        let url: string | null = null;
        if (row.visibility === 'public') {
          if (row.status === 'ready') {
            // built from the key on every read (stored URLs keep working, and follow a new signing key)
            list = rs.map((r) => toRendition(r, this.storage.publicUrl(r.storage_key)));
            const main = pickRendition(rs, sizeFor(row, 'medium'));
            url = main ? this.storage.publicUrl(main.storage_key) : null;
          } else if (row.status === 'removed' && row.show_placeholder !== false) {
            url = this.storage.publicUrl(PLACEHOLDER_KEY);
          }
        } else if (opts.signPrivate && (row.status === 'ready' || row.status === 'removed')) {
          list = await Promise.all(rs.map(async (r) => toRendition(r, await this.sign(this.storage.buckets.private, r.storage_key, row, ttl, true))));
        }
        return toAsset(row, { url, renditions: list, usageCount: usageCounts.get(row.id) ?? 0 });
      }),
    );
  }

  private async sign(bucket: string, key: string, row: AssetRow, ttlMinutes: number, inline: boolean) {
    const expiresAt = new Date(this.now().getTime() + ttlMinutes * 60_000);
    const contentType = inline ? (key.endsWith('.webp') ? 'image/webp' : key.endsWith('.jpeg') ? 'image/jpeg' : row.content_type) : row.content_type;
    return this.storage.presignDownload({ bucket, key, expiresAt, fileName: row.file_name, contentType, inline });
  }

  /** Timeline of a file: upload, processing, checks, usages, deletion, plus staff actions from the audit history */
  private async historyOf(row: AssetRow, usages: UsageRow[], area: 'seller' | 'admin'): Promise<common.TimelineEvent[]> {
    const events: common.TimelineEvent[] = [];
    const at = (d: Date) => d.toISOString();
    events.push({ at: at(row.created_at), label: 'Upload started', detail: row.file_name });
    const upload = await this.repo.uploadOfAsset(row.id);
    if (upload?.completed_at) events.push(upload.created_by_kind === INBOUND_UPLOADER ? { at: at(upload.completed_at), label: 'Received', detail: upload.created_by_id } : { at: at(upload.completed_at), label: 'Uploaded' });
    if (row.ready_at) events.push({ at: at(row.ready_at), label: 'Ready to use' });
    if (row.status === 'rejected') {
      const failed = (await this.repo.processingJobsOf(row.id)).filter((j) => j.status === 'failed' && j.finished_at).at(-1);
      events.push({ at: at(failed?.finished_at ?? upload?.completed_at ?? row.created_at), label: 'Rejected', detail: row.rejection_reason });
    }
    const check = checkOf(row);
    if (check && check.rulesSource !== 'Platform baseline') {
      const blocking = check.issues.filter((i) => i.severity === 'blocking').length;
      events.push({ at: check.checkedAt, label: check.passed ? 'Image check passed' : 'Image check failed', detail: [check.rulesSource, blocking ? `${blocking} issue${blocking > 1 ? 's' : ''} to fix` : null].filter(Boolean).join(' · ') || null });
    }
    for (const u of usages) {
      const what = `${u.module} ${label(u.kind)} ${u.ref_label ?? u.ref_id}`;
      events.push({ at: at(u.attached_at), label: 'Attached', detail: what });
      if (u.detached_at) events.push({ at: at(u.detached_at), label: 'Detached', detail: what });
    }
    if (row.deleted_at) events.push({ at: at(row.deleted_at), label: 'Deleted' });
    for (const e of await this.auditHistory(row.id)) {
      if (area === 'seller' && !['media.asset.remove', 'media.asset.restore'].includes(e.action)) continue;
      events.push({ at: e.at, label: e.actionLabel, detail: e.reason ?? null, actor: area === 'admin' ? e.actor : { kind: e.actor.kind } });
    }
    return events.sort((a, b) => a.at.localeCompare(b.at));
  }

  private async auditHistory(assetId: string): Promise<audit.AuditEntry[]> {
    const a = this.ctx.tryUse('audit');
    if (!a) return [];
    try {
      return await a.historyOf('media_asset', assetId, 50);
    } catch (err) {
      if (isNotImplemented(err)) return [];
      throw err;
    }
  }

  protected async audit(entry: Omit<audit.RecordInput, 'actor' | 'module' | 'requestId'>, by: By) {
    try {
      await this.ctx.tryUse('audit')?.record({ ...entry, actor: by.actor, module: this.ctx.name, requestId: by.requestId });
    } catch (err) {
      // the change is committed; a missing audit entry is logged, never turned into a failed request
      this.ctx.log[isNotImplemented(err) ? 'debug' : 'error']({ err, action: entry.action }, 'audit entry not recorded');
    }
  }

  private target(row: AssetRow): audit.AuditTarget {
    return { type: 'media_asset', id: row.id, label: row.file_name, sellerId: row.owner_kind === 'seller' ? row.owner_id : null, screen: 'admin/ad-assets' };
  }

  /** Display name of a customer or staff owner (identity, when it runs); guests and the platform have fixed labels */
  /**
   * Whether a file belongs to the owner a using module expects (attach, readFile). Staff work files (media spec notes,
   * Ownership): the Admin Center uploads every file as the platform's (ownerKind platform) and the upload records the
   * staff member who started it, so a module expecting a staff member's own file (return inspection, warehouse damage
   * reports and return parcels, case, trust and message evidence) also takes a platform file that same staff member
   * uploaded. Never one another staff member uploaded, and never a generated platform file (it has no upload record):
   * staff still can't attach each other's private files.
   */
  private async ownedBy(asset: AssetRow, expected: MediaOwner): Promise<boolean> {
    if (sameOwner(expected, ownerOf(asset))) return true;
    if (expected.kind !== 'staff' || !expected.id || asset.owner_kind !== 'platform') return false;
    const upload = await this.repo.uploadOfAsset(asset.id);
    return upload?.created_by_kind === 'staff' && upload.created_by_id === expected.id;
  }

  private async ownerLabel(owner: MediaOwner): Promise<string | null> {
    if (owner.kind === 'guest') return 'Guest';
    if (owner.kind === 'platform') return 'Marketly';
    if ((owner.kind !== 'customer' && owner.kind !== 'staff') || !owner.id) return null;
    const id = this.ctx.tryUse('identity');
    if (!id) return null;
    try {
      return (await id.getAccount(owner.id))?.displayName ?? null;
    } catch (err) {
      if (isNotImplemented(err)) return null;
      throw err;
    }
  }

  private async waitForReady(asset: AssetRow): Promise<AssetRow> {
    const deadline = Date.now() + (this.deps.attachWaitMs ?? 10_000);
    this.kickProcessing();
    let row = asset;
    while ((row.status === 'pending_upload' || row.status === 'processing') && Date.now() < deadline) {
      await sleep(200);
      row = (await this.repo.getAsset(asset.id)) ?? row;
    }
    return row;
  }

  /** The queue worker runs in this process when jobs are enabled: start it now instead of waiting */
  private kickProcessing() {
    if (this.ctx.config.jobsEnabled) setImmediate(() => void this.ctx.jobs.runNow('media.process'));
  }

  private publishRejected(row: AssetRow, reason: string, by: By) {
    this.ctx.events.publish('media.asset.rejected', { assetId: row.id, purpose: row.purpose, owner: ownerOf(row), reason }, { actor: by.actor, requestId: by.requestId });
  }

  /** Storage housekeeping after a committed change: logged, never undoes the change */
  private async safely(what: string, fn: () => Promise<unknown>) {
    try {
      await fn();
    } catch (err) {
      this.ctx.log.error({ err }, `media: could not ${what}; reconcile-storage will report it`);
    }
  }
}

/* ------------------------------------------------------------------ module-private helpers */

const STATUS_BLOCK: Record<string, string> = {
  pending_upload: 'Still uploading',
  processing: 'Still processing',
  removed: 'Taken down by Marketly',
  deleted: 'Already deleted',
  expired: 'Upload expired',
};

function notUsable(row: AssetRow) {
  const why: Record<string, string> = {
    pending_upload: "The file hasn't been uploaded yet.",
    processing: 'The file is still being processed; try again shortly.',
    rejected: `The file was rejected${row.rejection_reason ? `: ${row.rejection_reason}` : '.'}`,
    removed: 'The file was taken down.',
    deleted: 'The file was deleted.',
    expired: 'The upload expired.',
  };
  return new AppError('ILLEGAL_TRANSITION', why[row.status] ?? `The file is ${row.status}.`, { status: row.status });
}

function assertPlatformFile(row: AssetRow, verb: string) {
  if (row.owner_kind !== 'platform' && row.owner_kind !== 'staff') {
    throw new AppError('FORBIDDEN', `Only platform and staff files can be ${verb} here; this one belongs to a ${row.owner_kind}.`, { ownerKind: row.owner_kind });
  }
}

const evidenceKinds = (usages: readonly UsageRow[]) => usages.filter((u) => u.evidence).map((u) => u.kind);

function categoryOf(row: AssetRow): audit.RecordInput['category'] {
  if (row.purpose.startsWith('ad_')) return 'advertising';
  if (SENSITIVE_GENERATED.includes(row.purpose)) return 'financial';
  if (['product_image', 'product_video', 'offer_photo', 'brand_logo'].includes(row.purpose)) return 'catalog';
  if (['return_evidence', 'inspection_photo'].includes(row.purpose)) return 'returns';
  if (row.owner_kind === 'customer' || row.owner_kind === 'guest') return 'customers';
  return 'content';
}

const snapshot = (r: AssetRow) => ({ status: r.status, purpose: r.purpose, owner: { kind: r.owner_kind, id: r.owner_id }, removedReason: r.removed_reason, showPlaceholder: r.show_placeholder });


function formatOfRow(row: AssetRow): string {
  return fileTypeOf(row.content_type, row.file_name) ?? row.content_type.split('/')[1] ?? 'unknown';
}

const isProductImage = (row: Pick<AssetRow, 'purpose' | 'kind'>) => row.purpose === 'product_image' && row.kind === 'image';

/**
 * The stored rendition size that answers a requested size. Videos: the poster. Product images keep two sizes:
 * small and thumb answer thumb, medium, large, zoom and detail answer detail (product images processed before the
 * spec, which have no processing_spec yet: small and large). Other images keep thumb to zoom; detail answers medium.
 */
function sizeFor(row: Pick<AssetRow, 'purpose' | 'kind' | 'processing_spec'>, size: RenditionSize | 'poster'): string {
  if (row.kind === 'video') return 'poster';
  const small = size === 'thumb' || size === 'small';
  if (isProductImage(row)) return row.processing_spec ? (small ? 'thumb' : 'detail') : small ? 'small' : 'large';
  return size === 'detail' ? 'medium' : size;
}

/** The rendition for a size: exact (WebP first), else the largest smaller one, else the smallest */
function pickRendition(rows: readonly RenditionRow[], size: string): RenditionRow | undefined {
  const fmt = (r: RenditionRow) => (r.format === 'webp' ? 0 : r.format === 'jpeg' ? 1 : 2);
  const exact = rows.filter((r) => r.size === size).sort((a, b) => fmt(a) - fmt(b))[0];
  if (exact) return exact;
  const order = IMAGE_SIZES as readonly string[];
  const target = order.indexOf(size);
  if (target < 0) return undefined;
  const images = rows.filter((r) => order.includes(r.size)).sort((a, b) => order.indexOf(a.size) - order.indexOf(b.size) || fmt(a) - fmt(b));
  const smaller = images.filter((r) => order.indexOf(r.size) <= target);
  if (smaller.length) {
    const best = order.indexOf(smaller.at(-1)!.size);
    return smaller.filter((r) => order.indexOf(r.size) === best).sort((a, b) => fmt(a) - fmt(b))[0];
  }
  return images[0];
}

function groupBy<T>(items: readonly T[], key: (t: T) => string): Map<string, T[]> {
  const m = new Map<string, T[]>();
  for (const i of items) m.set(key(i), [...(m.get(key(i)) ?? []), i]);
  return m;
}

const sha256 = (b: Uint8Array) => createHash('sha256').update(b).digest('hex');

/** The object key in a storage or CDN URL */
function keyOfUrl(url: string): string | null {
  try {
    // a link the API serves (/files/{bucket}/{key}) or a CDN URL (/{key})
    return decodeURIComponent(new URL(url).pathname.replace(/^\/files\/[^/]+\//, '/').replace(/^\//, '')) || null;
  } catch {
    return null;
  }
}

/**
 * The chunks of an upload body. A request stream is read without destroying it when the reader stops early
 * (too large): the server can still answer 413 on the same connection.
 */
function chunksOf(body: Readable | Uint8Array | undefined): AsyncIterable<Uint8Array> | Iterable<Uint8Array> {
  if (!body) return [];
  if (body instanceof Uint8Array) return [body];
  return { [Symbol.asyncIterator]: () => body.iterator({ destroyOnReturn: false }) as AsyncIterator<Uint8Array> };
}

async function readBody(body: unknown): Promise<Uint8Array> {
  if (body instanceof Uint8Array) return body;
  if (typeof body === 'string') return Buffer.from(body);
  if (body instanceof ArrayBuffer) return new Uint8Array(body);
  if (body && typeof (body as ReadableStream).getReader === 'function') return new Uint8Array(await new Response(body as ReadableStream).arrayBuffer());
  if (body && typeof (body as AsyncIterable<Uint8Array>)[Symbol.asyncIterator] === 'function') {
    const chunks: Uint8Array[] = [];
    for await (const c of body as AsyncIterable<Uint8Array | string>) chunks.push(typeof c === 'string' ? Buffer.from(c) : c);
    return Buffer.concat(chunks);
  }
  throw invalid('body', 'The file body must be a stream or bytes');
}

