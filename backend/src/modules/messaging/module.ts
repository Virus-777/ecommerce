import { defineModule } from '../../kernel/module-system/index.js';
import { spec } from '../../spec/messaging.js';
import { resolvers } from './graphql/resolvers.js';
import { typeDefs } from './graphql/schema.js';
import { storeRoutes } from './http/store.js';
import { sellerRoutes } from './http/seller.js';
import { adminRoutes } from './http/admin.js';
import { migrations } from './infra/postgres/migrations/index.js';
import { createPostgresMessagingRepository } from './infra/postgres/repository.js';
import { MessagingService } from './service.js';

/**
 * Messaging: Private service conversations linked to an order, item, return or case: customer with seller (or the Official Store), which Marketly support can join from a case, with attachments, read state, seller reply targets and overdue flags, and staff moderation. No promotional messages.
 *
 * Name, launch phase, dependencies, permissions, events, jobs, settings and endpoints come from
 * docs/api/spec/modules/messaging.json through `spec`; the server refuses to start if they drift.
 */
export default defineModule({
  spec,
  version: '1.0.0',
  migrations,
  graphql: typeDefs,
  register(ctx) {
    const service = new MessagingService({ repo: createPostgresMessagingRepository(ctx.db), ctx });
    ctx.provide(service);
    ctx.http.routes(storeRoutes(service), sellerRoutes(service), adminRoutes(service));
    ctx.graphql.resolvers(resolvers(service));

    // Events this module reacts to (spec events.consumes)
    ctx.events.on("support.case.opened", (e) => service.onCaseOpenedFromSupport(e.payload));
    ctx.events.on("orders.order.completed", (e) => service.onOrderCompletedFromOrders(e.payload));
    ctx.events.on("trust.enforcement.recorded", (e) => service.onEnforcementRecordedFromTrust(e.payload));

    // Background jobs (spec jobs)
    ctx.jobs.handle("messaging.reply-deadlines", () => service.replyDeadlines());
    ctx.jobs.handle("messaging.archive", () => service.archive());
    ctx.jobs.handle("messaging.response-stats", () => service.responseStats());
  },
});
