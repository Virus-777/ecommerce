import { hmacWebhookVerifier } from '../../kernel/http/webhooks.js';
import { defineModule } from '../../kernel/module-system/index.js';
import { spec } from '../../spec/payments.js';
import { resolvers } from './graphql/resolvers.js';
import { typeDefs } from './graphql/schema.js';
import { storeRoutes } from './http/store.js';
import { adminRoutes } from './http/admin.js';
import { webhooksRoutes } from './http/webhooks.js';
import { createDevCardProcessor } from './providers/card-processor.js';
import { createMongoPaymentsRepository } from './repository.js';
import { PaymentsService } from './service.js';
import { schemas } from './schema.js';

/**
 * Payments: Charging customers through provider adapters (card, digital wallet): payment intents per checkout attempt, authorization and capture per order and seller group, declines with retry, uncertain results resolved by a status-check job, refund execution (Requested → Processing → Sent / Failed) capped at the remaining refundable amount, chargebacks and payment disputes, saved payment methods and provider webhooks.
 *
 * Name, launch phase, dependencies, permissions, events, jobs, settings and endpoints come from
 * docs/api/spec/modules/payments.json through `spec`; the server refuses to start if they drift.
 * The card processor is the deterministic dev adapter until a real one is wired behind the same port.
 */
export default defineModule({
  spec,
  version: '2.0.0',
  schemas,
  graphql: typeDefs,
  register(ctx) {
    const service = new PaymentsService({ repo: createMongoPaymentsRepository(ctx.mongo), ctx, provider: createDevCardProcessor() });
    ctx.provide(service);
    ctx.http.routes(storeRoutes(service), adminRoutes(service), webhooksRoutes(service));
    ctx.http.webhookVerifier(hmacWebhookVerifier(ctx.config, ctx.name));
    ctx.graphql.resolvers(resolvers(service));

    // Events this module reacts to (spec events.consumes)
    ctx.events.on("orders.order.placed", (e) => service.onOrderPlacedFromOrders(e.payload));
    ctx.events.on("orders.order.accepted", (e) => service.onOrderAcceptedFromOrders(e.payload));
    ctx.events.on("shipping.shipment.dispatched", (e) => service.onShipmentDispatchedFromShipping(e.payload));
    ctx.events.on("orders.order.cancelled", (e) => service.onOrderCancelledFromOrders(e.payload));
    ctx.events.on("orders.item.cancelled", (e) => service.onItemCancelledFromOrders(e.payload));
    ctx.events.on("access.approval.decided", (e) => service.onApprovalDecidedFromAccess(e.payload));

    // Background jobs (spec jobs)
    ctx.jobs.handle("payments.check-uncertain", () => service.checkUncertain());
    ctx.jobs.handle("payments.process-refunds", () => service.processRefunds());
    ctx.jobs.handle("payments.detect-orphans", () => service.detectOrphans());
    ctx.jobs.handle("payments.expire-authorizations", () => service.expireAuthorizations());
    ctx.jobs.handle("payments.dispute-deadlines", () => service.disputeDeadlines());
    ctx.jobs.handle("payments.card-expiry", () => service.cardExpiry());
  },
});
