import { defineModule } from '../../kernel/module-system/index.js';
import { spec } from '../../spec/messaging.js';
import { resolvers } from './graphql/resolvers.js';
import { typeDefs } from './graphql/schema.js';
import { storeRoutes } from './http/store.js';
import { sellerRoutes } from './http/seller.js';
import { adminRoutes } from './http/admin.js';
import { MessagingRepository } from './repository.js';
import { MessagingService } from './service.js';
import { schemas } from './schema.js';

/**
 * Messaging: Private service conversations linked to an order, item, return or case: customer with seller (or the Official Store), which Marketly support can join from a case, with attachments, read state, seller reply targets and overdue flags, and staff moderation. No promotional messages.
 *
 * Name, launch phase, dependencies, permissions, events, jobs, settings and endpoints come from
 * docs/api/spec/modules/messaging.json through `spec`; the server refuses to start if they drift.
 */
export default defineModule({
  spec,
  version: '2.0.0',
  schemas,
  graphql: typeDefs,
  register(ctx) {
    const service = new MessagingService({ repo: new MessagingRepository(ctx.mongo), ctx });
    ctx.provide(service);
    ctx.http.routes(storeRoutes(service), sellerRoutes(service), adminRoutes(service));
    ctx.graphql.resolvers(resolvers(service));

    // Events this module reacts to (spec events.consumes)
    ctx.events.on("support.case.opened", (e) => service.onCaseOpenedFromSupport(e.payload));
    ctx.events.on("orders.order.completed", (e) => service.onOrderCompletedFromOrders(e.payload));
    ctx.events.on("trust.enforcement.recorded", (e) => service.onEnforcementRecordedFromTrust(e.payload));
    ctx.events.on("trust.enforcement.reversed", (e) => service.onEnforcementReversedFromTrust(e.payload));
    ctx.events.on("notifications.email_reply.received", (e) => service.onEmailReplyReceivedFromNotifications(e.payload, e.id));
    ctx.events.on("customers.account.closed", (e) => service.onAccountClosedFromCustomers(e.payload));

    // Background jobs (spec jobs)
    ctx.jobs.handle("messaging.reply-deadlines", () => service.replyDeadlines());
    ctx.jobs.handle("messaging.archive", () => service.archive());
    ctx.jobs.handle("messaging.response-stats", () => service.responseStats());
  },
});
