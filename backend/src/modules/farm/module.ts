import { defineModule } from '../../kernel/module-system/index.js';
import { spec } from '../../spec/farm.js';
import { storeRoutes } from './http/store.js';
import { adminRoutes } from './http/admin.js';
import { FarmRepository } from './repository.js';
import { schemas } from './schema.js';
import { FarmService } from './service.js';

/**
 * Farm orders: Farm machine orders from the app's Farm machines department: the dealers staff keep in Admin (address, map point, hours, phone), the customer's nearest dealer, and farm orders of a picked machine with its attachments delivered to the customer's farm, paid in full by card (payments purchase intents, captured when the dealer confirms), by installments the dealer arranges, or on delivery. Staff confirm, schedule, send out and deliver each order on the dealer's behalf.
 *
 * Name, launch phase, dependencies, permissions, events, jobs, settings and endpoints come from
 * docs/api/spec/modules/farm.json through `spec`; the server refuses to start if they drift.
 */
export default defineModule({
  spec,
  version: '1.0.0',
  schemas,
  register(ctx) {
    const service = new FarmService({ repo: new FarmRepository(ctx.mongo), ctx });
    ctx.provide(service);
    ctx.http.routes(storeRoutes(service), adminRoutes(service));

    // Events this module reacts to (spec events.consumes)
    ctx.events.on("payments.purchase.authorized", (e) => service.onPurchaseAuthorizedFromPayments(e.payload, e.id));
    ctx.events.on("payments.purchase.failed", (e) => service.onPurchaseFailedFromPayments(e.payload, e.id));

    // Background jobs (spec jobs)
    ctx.jobs.handle("farm.expire-unconfirmed", () => service.expireUnconfirmed());
  },
});
