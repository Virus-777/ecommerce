import { notImplemented } from '../../kernel/errors/index.js';
import type { EventPayload } from '../../kernel/events/index.js';
import type { ModuleContext } from '../../kernel/module-system/index.js';
import type * as common from '../../spec/common.js';
import type * as identity from '../../spec/identity.js';
import type { MediaPublicApi, MediaOwner, MediaAsset, UsageInput, ImageRules, ImageCheckResult, DownloadLink } from '../../spec/media.js';
import type { MediaRepository } from './ports.js';

export interface MediaServiceDeps {
  repo: MediaRepository;
  ctx: ModuleContext<'media'>;
}

/**
 * Media use cases. Depends only on ports, the event bus, the clock and other modules' public APIs.
 * Each method maps to a publicApi function, a consumed event or a job in docs/api/spec/modules/media.json.
 */
export class MediaService implements MediaPublicApi {
  readonly #deps: MediaServiceDeps;

  constructor(deps: MediaServiceDeps) {
    this.#deps = deps;
  }

  protected get deps(): MediaServiceDeps {
    return this.#deps;
  }

  /* ---------------- public API (in-process) */

  /** Asset with renditions and status */
  async getAsset(assetId: string): Promise<MediaAsset | null> {
    throw notImplemented('media.getAsset');
  }

  /** common.MediaRef (id, url, alt, width, height) for embedding in responses; removed files return the placeholder */
  async refs(assetIds: string[], size?: 'thumb' | 'small' | 'medium' | 'large' | 'zoom'): Promise<common.MediaRef[]> {
    throw notImplemented('media.refs');
  }

  /** Record that a record uses a file. Fails if the asset is not ready, belongs to another owner (ASSET_NOT_OWNED) or the purpose does not fit the usage. Evidence usages extend retainUntil. */
  async attach(assetId: string, usage: UsageInput, expectedOwner: MediaOwner): Promise<void> {
    throw notImplemented('media.attach');
  }

  /** Record that a record no longer uses a file (image replaced, draft deleted) */
  async detach(assetId: string, usage: { module: string, kind: string, refId: string }): Promise<void> {
    throw notImplemented('media.detach');
  }

  /** Evaluate an image against category or placement rules; the result is stored on the asset */
  async checkImage(assetId: string, rules: ImageRules): Promise<ImageCheckResult> {
    throw notImplemented('media.checkImage');
  }

  /** Store a file produced by the platform (private) */
  async storeGeneratedFile(input: { owner: MediaOwner, fileName: string, contentType: string, body: ReadableStream, ttlHours?: number, purpose: 'export' | 'statement' | 'report' | 'correction_report' | 'data_export' | 'label' }): Promise<MediaAsset> {
    throw notImplemented('media.storeGeneratedFile');
  }

  /** Signed link for a private file after the caller's module checked access; recorded for sensitive purposes */
  async signedDownload(assetId: string, principal: identity.Principal, reason?: string): Promise<DownloadLink> {
    throw notImplemented('media.signedDownload');
  }

  /** Takedown on behalf of a moderation decision (trust, reviews, catalog) */
  async remove(assetId: string, input: { reason: string, by: common.Actor }): Promise<void> {
    throw notImplemented('media.remove');
  }

  /* ---------------- events consumed */

  /** sellers.seller.closed: Mark the seller's never-used files for deletion after orphanGraceDays; evidence and files used by past orders' snapshots are kept until retainUntil */
  async onSellerClosedFromSellers(event: EventPayload<"sellers.seller.closed">): Promise<void> {
    void event;
    throw notImplemented('media consumer of sellers.seller.closed');
  }

  /** customers.account.closed: Delete the customer's unused uploads; evidence attached to returns and cases is kept until retainUntil, then purged */
  async onAccountClosedFromCustomers(event: EventPayload<"customers.account.closed">): Promise<void> {
    void event;
    throw notImplemented('media consumer of customers.account.closed');
  }

  /* ---------------- jobs */

  /** Job media.process (queue worker): Scan, probe, strip metadata, build renditions, run baseline image checks, start video transcodes; retry with backoff; publish media.asset.ready or media.asset.rejected */
  async process(): Promise<void> {
    throw notImplemented('job media.process');
  }

  /** Job media.expire-uploads (hourly): Expire pending uploads past pendingUploadExpiryHours and delete partial objects */
  async expireUploads(): Promise<void> {
    throw notImplemented('job media.expire-uploads');
  }

  /** Job media.sweep-orphans (daily): Delete ready files never attached to anything after orphanGraceDays (except generated files, which follow their own expiry) */
  async sweepOrphans(): Promise<void> {
    throw notImplemented('job media.sweep-orphans');
  }

  /** Job media.expire-generated (hourly): Delete generated files (exports, reports) past expires_at */
  async expireGenerated(): Promise<void> {
    throw notImplemented('job media.expire-generated');
  }

  /** Job media.purge-deleted (daily): Erase storage objects of deleted assets after deletedGraceDays and of removed evidence after retainUntil */
  async purgeDeleted(): Promise<void> {
    throw notImplemented('job media.purge-deleted');
  }

  /** Job media.reconcile-storage (weekly): Compare storage listing with assets; report orphaned objects and missing files */
  async reconcileStorage(): Promise<void> {
    throw notImplemented('job media.reconcile-storage');
  }
}
