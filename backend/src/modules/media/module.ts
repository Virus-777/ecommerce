import { fileLinkSecret } from '../../kernel/auth/file-links.js';
import { hmacWebhookVerifier } from '../../kernel/http/webhooks.js';
import { secretFor } from '../../kernel/lib/secrets.js';
import { defineModule } from '../../kernel/module-system/index.js';
import { spec } from '../../spec/media.js';
import { storeRoutes } from './http/store.js';
import { sellerRoutes } from './http/seller.js';
import { adminRoutes } from './http/admin.js';
import { webhooksRoutes } from './http/webhooks.js';
import { fileServer } from './http/files.js';
import { MediaRepository } from './repository.js';
import { createDevProcessor } from './providers/processing/dev.js';
import { createSharpProcessor } from './providers/processing/sharp.js';
import { createDevScanner } from './providers/scanner.js';
import { createLocalStorage } from './providers/storage/local.js';
import { createMemoryStorage } from './providers/storage/memory.js';
import { MediaService } from './service.js';
import { schemas } from './schema.js';

/**
 * Media: Every uploaded or generated file: images, video and documents. Uploads and signed download links, scanning and processing, renditions, alt text, ownership (seller, staff, customer, platform), image standard checks, where each file is used, and the rules for deleting, removing and retaining files (files in use or kept as evidence cannot be deleted).
 *
 * Name, launch phase, dependencies, permissions, events, jobs, settings and endpoints come from
 * docs/api/spec/modules/media.json through `spec`; the server refuses to start if they drift.
 */
export default defineModule({
  spec,
  version: '2.1.0',
  schemas,
  register(ctx) {
    // Storage (MEDIA_STORAGE): the server's disk (local, production) or memory (tests). Both take uploads
    // through PUT /uploads/{id}/content and serve downloads at GET /files/{bucket}/{key}, signed with
    // media's file-link key and verified by the auth middleware. Scanning and processing use deterministic
    // dev providers (no network); ClamAV and an image / transcoding service can replace them (ports.ts).
    const links = { secret: fileLinkSecret(ctx.config, ctx.name), baseUrl: ctx.config.apiUrl };
    const storage =
      ctx.config.media.storage === 'local'
        ? createLocalStorage({ dir: ctx.config.media.dir, links })
        : // acceptSignedPut (tests and tools) follows an upload ticket's API URL to a signed upload URL
          createMemoryStorage({ clock: ctx.clock, links, uploadSecret: secretFor(ctx.config, 'media.storage'), resolveUploadUrl: (url) => service.signedStorageUrlFor(url) });
    // images: sharp decodes and resizes them (MEDIA_IMAGE_PROCESSOR=sharp, the default); dev reads headers only (tests)
    const processor = ctx.config.media.imageProcessor === 'dev' ? createDevProcessor() : createSharpProcessor();
    const providers = { storage, scanner: createDevScanner(), processor };
    const service = new MediaService({ repo: new MediaRepository(ctx.mongo), ctx, providers });
    ctx.provide(service);
    ctx.http.routes(storeRoutes(service), sellerRoutes(service), adminRoutes(service), webhooksRoutes(service));
    // GET /files/{bucket}/{key}: the middleware verifies the signed link (auth kind file-link) before this streams the file
    if (storage.viaApi) ctx.http.files(fileServer(service, ctx.clock));
    // storage notifications and transcoding results are signed with HMAC (WEBHOOK_SECRETS.media)
    ctx.http.webhookVerifier(hmacWebhookVerifier(ctx.config, ctx.name));

    // Events this module reacts to (spec events.consumes)
    ctx.events.on("sellers.seller.closed", (e) => service.onSellerClosedFromSellers(e.payload));
    ctx.events.on("customers.account.closed", (e) => service.onAccountClosedFromCustomers(e.payload));
    ctx.events.on("settings.setting.changed", (e) => service.onSettingChangedFromSettings(e.payload));

    // Background jobs (spec jobs)
    ctx.jobs.handle("media.process", () => service.process());
    ctx.jobs.handle("media.rebuild-product-renditions", () => service.rebuildProductRenditions());
    ctx.jobs.handle("media.expire-uploads", () => service.expireUploads());
    ctx.jobs.handle("media.sweep-orphans", () => service.sweepOrphans());
    ctx.jobs.handle("media.expire-generated", () => service.expireGenerated());
    ctx.jobs.handle("media.purge-deleted", () => service.purgeDeleted());
    ctx.jobs.handle("media.reconcile-storage", () => service.reconcileStorage());
  },
});
