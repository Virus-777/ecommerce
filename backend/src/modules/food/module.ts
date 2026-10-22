import { defineModule } from '../../kernel/module-system/index.js';
import { spec } from '../../spec/food.js';
import { storeRoutes } from './http/store.js';
import { adminRoutes } from './http/admin.js';
import { FoodRepository } from './repository.js';
import { schemas } from './schema.js';
import { FoodService } from './service.js';

/**
 * Food delivery: The app's Food delivery department: restaurants staff keep in Admin › Departments › Food delivery, their menus with sizes and extras, a basket that holds one restaurant's food, and food orders paid by card in their own payment flow (payments purchase intents, not cart and checkout). Staff move each order through accepted, preparing, on the way and delivered on the restaurant's behalf; the card is charged on delivery.
 *
 * Name, launch phase, dependencies, permissions, events, jobs, settings and endpoints come from
 * docs/api/spec/modules/food.json through `spec`; the server refuses to start if they drift.
 */
export default defineModule({
  spec,
  version: '1.0.0',
  schemas,
  register(ctx) {
    const service = new FoodService({ repo: new FoodRepository(ctx.mongo), ctx });
    ctx.provide(service);
    ctx.http.routes(storeRoutes(service), adminRoutes(service));

    // Events this module reacts to (spec events.consumes)
    ctx.events.on("payments.purchase.authorized", (e) => service.onPurchaseAuthorizedFromPayments(e.payload, e.id));
    ctx.events.on("payments.purchase.failed", (e) => service.onPurchaseFailedFromPayments(e.payload, e.id));

    // Background jobs (spec jobs)
    ctx.jobs.handle("food.expire-unaccepted", () => service.expireUnaccepted());
  },
});
