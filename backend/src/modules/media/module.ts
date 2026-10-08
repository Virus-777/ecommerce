import { hmacWebhookVerifier } from '../../kernel/http/webhooks.js';
import { secretFor } from '../../kernel/lib/secrets.js';
import { defineModule } from '../../kernel/module-system/index.js';
import { spec } from '../../spec/media.js';
import { storeRoutes } from './http/store.js';
import { sellerRoutes } from './http/seller.js';
import { adminRoutes } from './http/admin.js';
import { webhooksRoutes } from './http/webhooks.js';
import { migrations } from './infra/postgres/migrations/index.js';
import { createPostgresMediaRepository } from './infra/postgres/repository.js';
import { createDevProcessor } from './infra/processing/dev.js';
import { createDevScanner } from './infra/scanner/dev.js';
import { createDevStorage } from './infra/storage/dev.js';
import { MediaService } from './service.js';

/**
 * Media: Every uploaded or generated file: images, video and documents. Signed direct uploads, scanning and processing, renditions, alt text, ownership (seller, staff, customer, platform), image standard checks, where each file is used, and the rules for deleting, removing and retaining files (files in use or kept as evidence cannot be deleted).
 *
 * Name, launch phase, dependencies, permissions, events, jobs, settings and endpoints come from
 * docs/api/spec/modules/media.json through `spec`; the server refuses to start if they drift.
 */
export default defineModule({
  spec,
  version: '1.0.0',
  migrations,
  register(ctx) {
    // Providers: deterministic dev adapters (no network). S3-compatible storage, ClamAV and an image /
    // transcoding service replace them behind the same ports (ports.ts).
    const providers = {
      storage: createDevStorage({ secret: secretFor(ctx.config, 'media.storage'), clock: ctx.clock }),
      scanner: createDevScanner(),
      processor: createDevProcessor(),
    };
    const service = new MediaService({ repo: createPostgresMediaRepository(ctx.db), ctx, providers });
    ctx.provide(service);
    ctx.http.routes(storeRoutes(service), sellerRoutes(service), adminRoutes(service), webhooksRoutes(service));
    // storage notifications and transcoding results are signed with HMAC (WEBHOOK_SECRETS.media)
    ctx.http.webhookVerifier(hmacWebhookVerifier(ctx.config, ctx.name));

    // Events this module reacts to (spec events.consumes)
    ctx.events.on("sellers.seller.closed", (e) => service.onSellerClosedFromSellers(e.payload));
    ctx.events.on("customers.account.closed", (e) => service.onAccountClosedFromCustomers(e.payload));

    // Background jobs (spec jobs)
    ctx.jobs.handle("media.process", () => service.process());
    ctx.jobs.handle("media.expire-uploads", () => service.expireUploads());
    ctx.jobs.handle("media.sweep-orphans", () => service.sweepOrphans());
    ctx.jobs.handle("media.expire-generated", () => service.expireGenerated());
    ctx.jobs.handle("media.purge-deleted", () => service.purgeDeleted());
    ctx.jobs.handle("media.reconcile-storage", () => service.reconcileStorage());
  },
});
