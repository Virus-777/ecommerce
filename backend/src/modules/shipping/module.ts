import { hmacWebhookVerifier } from '../../kernel/http/webhooks.js';
import { defineModule } from '../../kernel/module-system/index.js';
import { spec } from '../../spec/shipping.js';
import { resolvers } from './graphql/resolvers.js';
import { storeRoutes } from './http/store.js';
import { sellerRoutes } from './http/seller.js';
import { adminRoutes } from './http/admin.js';
import { webhooksRoutes } from './http/webhooks.js';
import { devCarrierAdapter } from './providers/carriers.js';
import { ShippingRepository } from './repository.js';
import { ShippingService } from './service.js';
import { schemas } from './schema.js';

/**
 * Shipping: How things get delivered: carriers and services, destinations and excluded areas, shipping profiles with rates (Official Store and sellers), free-shipping rules, dispatch targets and cutoffs, the holiday and service-interruption calendar, delivery estimates for a location, shipments with contents and tracking, labels where supported, partial shipments, and delivery exceptions with their required responses and carrier claims.
 *
 * Name, launch phase, dependencies, permissions, events, jobs, settings and endpoints come from
 * docs/api/spec/modules/shipping.json through `spec`; the server refuses to start if they drift.
 */
export default defineModule({
  spec,
  version: '2.0.0',
  schemas,
  register(ctx) {
    // carriers sit behind a port; the deterministic dev adapter until real carrier accounts are connected
    const service = new ShippingService({ repo: new ShippingRepository(ctx.mongo), ctx, carriers: devCarrierAdapter() });
    ctx.provide(service);
    ctx.http.routes(storeRoutes(service), sellerRoutes(service), adminRoutes(service), webhooksRoutes(service));
    // carrier webhooks: HMAC per carrier ({carrier} in the URL names the secret)
    ctx.http.webhookVerifier(hmacWebhookVerifier(ctx.config, ctx.name));
    ctx.graphql.resolvers(resolvers(service));
    // carriers, methods, zones and the Official Store profile; the shipping.admin.exceptions export dataset
    ctx.afterBoot(() => service.boot());
    // the Shipping defaults section of the settings page (G76)
    ctx.afterBoot(() => service.registerSettingsSection());

    // Events this module reacts to (spec events.consumes)
    ctx.events.on("orders.order.accepted", (e) => service.onOrderAcceptedFromOrders(e.payload));
    ctx.events.on("orders.dispatch_deadline.changed", (e) => service.onDispatchDeadlineChangedFromOrders(e.payload));
    ctx.events.on("orders.item.cancelled", (e) => service.onItemCancelledFromOrders(e.payload));
    ctx.events.on("warehouse.package.packed", (e) => service.onPackagePackedFromWarehouse(e.payload));
    ctx.events.on("sellers.seller.restricted", (e) => service.onSellerRestrictedFromSellers(e.payload));
    ctx.events.on("support.case.opened", (e) => service.onCaseOpenedFromSupport(e.payload));
    ctx.events.on("returns.replacement.created", (e) => service.onReplacementCreatedFromReturns(e.payload));
    ctx.events.on("payments.refund.sent", (e) => service.onRefundSentFromPayments(e.payload));

    // Background jobs (spec jobs)
    ctx.jobs.handle("shipping.detect-late-dispatch", () => service.detectLateDispatch());
    ctx.jobs.handle("shipping.detect-missing-tracking", () => service.detectMissingTracking());
    ctx.jobs.handle("shipping.detect-stalled", () => service.detectStalled());
    ctx.jobs.handle("shipping.poll-tracking", () => service.pollTracking());
    ctx.jobs.handle("shipping.failed-delivery-default", () => service.failedDeliveryDefault());
    ctx.jobs.handle("shipping.activate-versions", () => service.activateVersions());
    ctx.jobs.handle("shipping.notice-schedule", () => service.noticeSchedule());
    ctx.jobs.handle("shipping.carrier-on-time", () => service.carrierOnTime());
  },
});
