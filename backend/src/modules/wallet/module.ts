import { defineModule } from '../../kernel/module-system/index.js';
import { spec } from '../../spec/wallet.js';
import { resolvers } from './graphql/resolvers.js';
import { storeRoutes } from './http/store.js';
import { adminRoutes } from './http/admin.js';
import { WalletRepository } from './repository.js';
import { WalletService } from './service.js';
import { schemas } from './schema.js';

/**
 * Wallet: Customer store credit with an auditable ledger (refunds to credit, goodwill credit within approval limits, price adjustments, use at checkout, expiry), gift cards, and a placeholder for loyalty rewards. Checkout and payments use the balance through the in-process public API.
 *
 * Name, launch phase, dependencies, permissions, events, jobs, settings and endpoints come from
 * docs/api/spec/modules/wallet.json through `spec`; the server refuses to start if they drift.
 */
export default defineModule({
  spec,
  version: '2.0.1',
  schemas,
  register(ctx) {
    const service = new WalletService({ repo: new WalletRepository(ctx.mongo), ctx });
    ctx.provide(service);
    ctx.http.routes(storeRoutes(service), adminRoutes(service));
    ctx.graphql.resolvers(resolvers(service));

    // Events this module reacts to (spec events.consumes)
    ctx.events.on("orders.order.placed", (e) => service.onOrderPlacedFromOrders(e.payload));
    ctx.events.on("payments.payment.failed", (e) => service.onPaymentFailedFromPayments(e.payload));
    ctx.events.on("access.approval.decided", (e) => service.onApprovalDecidedFromAccess(e.payload));
    ctx.events.on("identity.user.registered", (e) => service.onUserRegisteredFromIdentity(e.payload));

    // Background jobs (spec jobs)
    ctx.jobs.handle("wallet.expire-lots", () => service.expireLots());
    ctx.jobs.handle("wallet.release-stale-holds", () => service.releaseStaleHolds());
    ctx.jobs.handle("wallet.balance-check", () => service.balanceCheck());
  },
});
