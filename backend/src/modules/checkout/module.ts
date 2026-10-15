import { defineModule } from '../../kernel/module-system/index.js';
import { spec } from '../../spec/checkout.js';
import { resolvers } from './graphql/resolvers.js';
import { storeRoutes } from './http/store.js';
import { adminRoutes } from './http/admin.js';
import { CheckoutRepository } from './repository.js';
import { createDevTaxProvider } from './providers/tax.js';
import { CheckoutService } from './service.js';
import { schemas } from './schema.js';

/**
 * Checkout: Turns a cart (or a Buy now offer) into an accepted order: identify the customer or guest, choose an address with a per-item shippability check, pick delivery options per package, apply coupons or credit with reasons and item coverage, choose payment, review sellers, return terms and totals, revalidate into a change set the customer must accept, and place the order idempotently with clear payment results.
 *
 * Name, launch phase, dependencies, permissions, events, jobs, settings and endpoints come from
 * docs/api/spec/modules/checkout.json through `spec`; the server refuses to start if they drift.
 */
export default defineModule({
  spec,
  version: '2.0.0',
  schemas,
  register(ctx) {
    // sales tax: the launch rate table behind the TaxProvider port; a tax service adapter plugs in here later
    const service = new CheckoutService({ repo: new CheckoutRepository(ctx.mongo), ctx, tax: createDevTaxProvider() });
    ctx.provide(service);
    ctx.http.routes(storeRoutes(service), adminRoutes(service));
    ctx.graphql.resolvers(resolvers(service));

    // Development only (registered while DEV_TOKENS is on, hidden from OpenAPI): test tooling, never a feature
    ctx.http.devRoutes({
      method: 'POST',
      path: '/sessions/:id/changes',
      summary: "Make the next check of an open checkout find a price change (or with stock: true, a stock shortage) and return the change set",
      handler: ({ params, body, actor, requestId }) =>
        service.devForceChanges(
          params.id!,
          { lineId: typeof body.lineId === 'string' ? body.lineId : undefined, unitPrice: typeof body.unitPrice === 'number' ? body.unitPrice : undefined, stock: body.stock === true },
          { actor, requestId },
        ),
    });

    // Events this module reacts to (spec events.consumes)
    ctx.events.on("payments.payment.authorized", (e) => service.onPaymentAuthorizedFromPayments(e.payload));
    ctx.events.on("payments.payment.failed", (e) => service.onPaymentFailedFromPayments(e.payload));
    ctx.events.on("orders.order.cancelled", (e) => service.onOrderCancelledFromOrders(e.payload));
    ctx.events.on("identity.guest_session.claimed", (e) => service.onGuestSessionClaimedFromIdentity(e.payload));

    // Background jobs (spec jobs)
    ctx.jobs.handle("checkout.expire-sessions", () => service.expireSessions());
    ctx.jobs.handle("checkout.extend-pending-holds", () => service.extendPendingHolds());
    ctx.jobs.handle("checkout.purge-idempotency", () => service.purgeIdempotency());
  },
});
