import { defineModule } from '../../kernel/module-system/index.js';
import { spec } from '../../spec/rewards.js';
import { storeRoutes } from './http/store.js';
import { adminRoutes } from './http/admin.js';
import { RewardsRepository } from './repository.js';
import { schemas } from './schema.js';
import { RewardsService } from './service.js';

/**
 * Daily rewards: The app's Daily rewards department: customers check in every day for points (a 7-day streak with a bonus on day 7), earn points for daily tasks, and swap points for coupons. Staff set the check-in schedule, the tasks and the reward catalogue in Admin › Departments › Daily rewards, and can adjust a customer's points. Each coupon is a single-use code of a promotions coupon campaign given to the customer.
 *
 * Name, launch phase, dependencies, permissions, events, jobs, settings and endpoints come from
 * docs/api/spec/modules/rewards.json through `spec`; the server refuses to start if they drift.
 */
export default defineModule({
  spec,
  version: '1.0.0',
  schemas,
  register(ctx) {
    const service = new RewardsService({ repo: new RewardsRepository(ctx.mongo), ctx });
    ctx.provide(service);
    ctx.http.routes(storeRoutes(service), adminRoutes(service));

    // Events this module reacts to (spec events.consumes): each counts once per review or order
    ctx.events.on("reviews.review.published", (e) => service.onReviewPublishedFromReviews(e.payload));
    ctx.events.on("orders.order.placed", (e) => service.onOrderPlacedFromOrders(e.payload));
  },
});
