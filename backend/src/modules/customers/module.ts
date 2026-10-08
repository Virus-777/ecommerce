import { defineModule } from '../../kernel/module-system/index.js';
import { spec } from '../../spec/customers.js';
import { resolvers } from './graphql/resolvers.js';
import { typeDefs } from './graphql/schema.js';
import { storeRoutes } from './http/store.js';
import { adminRoutes } from './http/admin.js';
import { publicRoutes } from './http/public.js';
import { migrations } from './infra/postgres/migrations/index.js';
import { createPostgresCustomersRepository } from './infra/postgres/repository.js';
import { CustomersService } from './service.js';

/**
 * Customers: The customer side of an account: profile, saved addresses, marketing consent, recently viewed products, the Account tab overview, guest order access, data export and account closure, and the staff view of customer accounts with notes and recorded account actions. Credentials, sessions and verification belong to identity.
 *
 * Name, launch phase, dependencies, permissions, events, jobs, settings and endpoints come from
 * docs/api/spec/modules/customers.json through `spec`; the server refuses to start if they drift.
 */
export default defineModule({
  spec,
  version: '0.1.0',
  migrations,
  graphql: typeDefs,
  register(ctx) {
    const service = new CustomersService({ repo: createPostgresCustomersRepository(ctx.db), ctx });
    ctx.provide(service);
    ctx.http.routes(storeRoutes(service), adminRoutes(service), publicRoutes(service));
    ctx.graphql.resolvers(resolvers(service));

    // Events this module reacts to (spec events.consumes)
    ctx.events.on("orders.order.placed", (e) => service.onOrderPlacedFromOrders(e.payload));
    ctx.events.on("identity.user.registered", (e) => service.onUserRegisteredFromIdentity(e.payload));
    ctx.events.on("identity.user.verified", (e) => service.onUserVerifiedFromIdentity(e.payload));
    ctx.events.on("identity.guest_session.claimed", (e) => service.onGuestSessionClaimedFromIdentity(e.payload));
    ctx.events.on("identity.email.changed", (e) => service.onEmailChangedFromIdentity(e.payload));
    ctx.events.on("identity.account.closed", (e) => service.onAccountClosedFromIdentity(e.payload));
    ctx.events.on("trust.enforcement.recorded", (e) => service.onEnforcementRecordedFromTrust(e.payload));
    ctx.events.on("catalog.product.merged", (e) => service.onProductMergedFromCatalog(e.payload));

    // Background jobs (spec jobs)
    ctx.jobs.handle("customers.expire-restrictions", () => service.expireRestrictions());
    ctx.jobs.handle("customers.build-data-exports", () => service.buildDataExports());
    ctx.jobs.handle("customers.expire-export-links", () => service.expireExportLinks());
    ctx.jobs.handle("customers.complete-closures", () => service.completeClosures());
    ctx.jobs.handle("customers.prune-recently-viewed", () => service.pruneRecentlyViewed());
  },
});
