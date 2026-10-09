import { defineModule } from '../../kernel/module-system/index.js';
import { spec } from '../../spec/support.js';
import { resolvers } from './graphql/resolvers.js';
import { typeDefs } from './graphql/schema.js';
import { storeRoutes } from './http/store.js';
import { sellerRoutes } from './http/seller.js';
import { adminRoutes } from './http/admin.js';
import { migrations } from './infra/postgres/migrations/index.js';
import { createPostgresSupportRepository } from './infra/postgres/repository.js';
import { SupportService } from './service.js';

/**
 * Support: Help cases and disputes: customer help and order-problem cases opened from the order with items pre-identified, seller support requests to Marketly, disputes between customer and seller with evidence, decision, remedy and appeal, plus categories, priority, owner, SLA deadlines, assignment, escalation and resolve/reopen rules.
 *
 * Name, launch phase, dependencies, permissions, events, jobs, settings and endpoints come from
 * docs/api/spec/modules/support.json through `spec`; the server refuses to start if they drift.
 */
export default defineModule({
  spec,
  version: '1.0.0',
  migrations,
  graphql: typeDefs,
  async register(ctx) {
    const service = new SupportService({ repo: createPostgresSupportRepository(ctx.db), ctx });
    ctx.provide(service);
    ctx.http.routes(storeRoutes(service), sellerRoutes(service), adminRoutes(service));
    ctx.graphql.resolvers(resolvers(service));
    // default case categories (staff changes are kept) and the support.admin.cases export dataset
    await service.core.seedCategories().catch((err) => ctx.log.warn({ err }, 'support: seeding categories failed; retrying on first use'));
    ctx.afterBoot(() => service.reads.registerDatasets());

    // Events this module reacts to (spec events.consumes)
    ctx.events.on("returns.return.escalated", (e) => service.onReturnEscalatedFromReturns(e.payload));
    ctx.events.on("returns.refund.approved", (e) => service.onRefundApprovedFromReturns(e.payload));
    ctx.events.on("payments.refund.sent", (e) => service.onRefundSentFromPayments(e.payload));
    ctx.events.on("payments.refund.failed", (e) => service.onRefundFailedFromPayments(e.payload));
    ctx.events.on("returns.replacement.created", (e) => service.onReplacementCreatedFromReturns(e.payload));
    ctx.events.on("shipping.shipment.delivered", (e) => service.onShipmentDeliveredFromShipping(e.payload));
    ctx.events.on("shipping.dispatch.overdue", (e) => service.onDispatchOverdueFromShipping(e.payload));
    ctx.events.on("shipping.shipment.exception", (e) => service.onShipmentExceptionFromShipping(e.payload));
    ctx.events.on("orders.item.cancelled", (e) => service.onItemCancelledFromOrders(e.payload));
    ctx.events.on("sellers.seller.restricted", (e) => service.onSellerRestrictedFromSellers(e.payload));
    ctx.events.on("access.approval.decided", (e) => service.onApprovalDecidedFromAccess(e.payload));

    // Background jobs (spec jobs)
    ctx.jobs.handle("support.sla-timers", () => service.slaTimers());
    ctx.jobs.handle("support.seller-deadline", () => service.sellerDeadline());
    ctx.jobs.handle("support.offer-expiry", () => service.offerExpiry());
    ctx.jobs.handle("support.auto-close", () => service.autoClose());
  },
});
