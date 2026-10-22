import { defineModule } from '../../kernel/module-system/index.js';
import { spec } from '../../spec/software.js';
import { mongoMigrations } from './migrations.js';
import { storeRoutes } from './http/store.js';
import { adminRoutes } from './http/admin.js';
import { SoftwareRepository } from './repository.js';
import { schemas } from './schema.js';
import { SoftwareService } from './service.js';

/**
 * Softwares: The app's Softwares department: apps for phones and PCs that customers download. Staff keep the categories, apps, files, packs and the home rails in Admin › Departments › Softwares. Free apps are owned on Get; paid apps and packs are bought with a card in their own payment flow (payments purchase intents, not cart and checkout), and owners download the files through signed links.
 *
 * Name, launch phase, dependencies, permissions, events, jobs, settings and endpoints come from
 * docs/api/spec/modules/software.json through `spec`; the server refuses to start if they drift.
 */
export default defineModule({
  spec,
  version: '1.1.0',
  schemas,
  // 2026-10-22: licence keys for entitlements of paid apps made before keys existed, licence_devices from the labels
  mongoMigrations,
  register(ctx) {
    const service = new SoftwareService({ repo: new SoftwareRepository(ctx.mongo), ctx });
    ctx.provide(service);
    ctx.http.routes(storeRoutes(service), adminRoutes(service));

    // Events this module reacts to (spec events.consumes)
    ctx.events.on("payments.purchase.authorized", (e) => service.onPurchaseAuthorizedFromPayments(e.payload));
    ctx.events.on("payments.purchase.failed", (e) => service.onPurchaseFailedFromPayments(e.payload));

    // Background jobs (spec jobs)
    ctx.jobs.handle("software.abandon-stale", () => service.abandonStale());
  },
});
