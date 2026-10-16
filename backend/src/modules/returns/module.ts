import { defineModule } from '../../kernel/module-system/index.js';
import { spec } from '../../spec/returns.js';
import { resolvers } from './graphql/resolvers.js';
import { storeRoutes } from './http/store.js';
import { sellerRoutes } from './http/seller.js';
import { adminRoutes } from './http/admin.js';
import { ReturnsRepository } from './repository.js';
import { seedBaselinePolicy } from './domain/seed.js';
import { ReturnsService } from './service.js';
import { schemas } from './schema.js';

/**
 * Returns: Return policies (platform baseline, seller terms, category exceptions, who pays return shipping), per-item eligibility, return requests and decisions, return shipments, receipt and inspection, remedies (refund, replacement, exchange) and the refund request that Finance approves before payments sends the money.
 *
 * Name, launch phase, dependencies, permissions, events, jobs, settings and endpoints come from
 * docs/api/spec/modules/returns.json through `spec`; the server refuses to start if they drift.
 */
export default defineModule({
  spec,
  version: '2.0.0',
  schemas,
  async register(ctx) {
    const repo = new ReturnsRepository(ctx.mongo);
    // seed data a fresh install starts with (baseline policy version 1.0)
    await seedBaselinePolicy(repo, ctx.clock.now());
    const service = new ReturnsService({ repo, ctx });
    ctx.provide(service);
    ctx.http.routes(storeRoutes(service), sellerRoutes(service), adminRoutes(service));
    ctx.graphql.resolvers(resolvers(service));
    // export datasets returns.admin.requests, returns.admin.inspections and returns.seller.requests (reports reads rows through exportRows)
    ctx.afterBoot(() => service.reads.registerDatasets());
    // the Returns baseline section of the Admin Center settings page (G76)
    ctx.afterBoot(() => service.registerSettingsSection());

    // Events this module reacts to (spec events.consumes)
    ctx.events.on("orders.item.delivered", (e) => service.onItemDeliveredFromOrders(e.payload));
    ctx.events.on("orders.item.cancelled", (e) => service.onItemCancelledFromOrders(e.payload));
    ctx.events.on("shipping.shipment.dispatched", (e) => service.onShipmentDispatchedFromShipping(e.payload));
    ctx.events.on("shipping.shipment.delivered", (e) => service.onShipmentDeliveredFromShipping(e.payload));
    ctx.events.on("shipping.shipment.exception", (e) => service.onShipmentExceptionFromShipping(e.payload));
    ctx.events.on("payments.refund.sent", (e) => service.onRefundSentFromPayments(e.payload));
    ctx.events.on("payments.refund.failed", (e) => service.onRefundFailedFromPayments(e.payload));
    ctx.events.on("access.approval.decided", (e) => service.onApprovalDecidedFromAccess(e.payload));
    ctx.events.on("sellers.seller.suspended", (e) => service.onSellerSuspendedFromSellers(e.payload));
    ctx.events.on("sellers.seller.approved", (e) => service.onSellerApprovedFromSellers(e.payload));
    ctx.events.on("shipping.shipment.status_changed", (e) => service.onShipmentStatusChangedFromShipping(e.payload));
    ctx.events.on("support.case.decided", (e) => service.onCaseDecidedFromSupport(e.payload));

    // Background jobs (spec jobs)
    ctx.jobs.handle("returns.response-deadlines", () => service.responseDeadlines());
    ctx.jobs.handle("returns.inspection-deadlines", () => service.inspectionDeadlines());
    ctx.jobs.handle("returns.info-expiry", () => service.infoExpiry());
    ctx.jobs.handle("returns.dropoff-expiry", () => service.dropoffExpiry());
    ctx.jobs.handle("returns.policy-activation", () => service.policyActivation());
  },
});
