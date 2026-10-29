import { defineModule } from '../../kernel/module-system/index.js';
import { spec } from '../../spec/customers.js';
import { resolvers } from './graphql/resolvers.js';
import { storeRoutes } from './http/store.js';
import { adminRoutes } from './http/admin.js';
import { publicRoutes } from './http/public.js';
import { devAddressProvider } from './providers/address.js';
import { devGeocoder, unconfiguredGeocoder } from './providers/geocoder.js';
import { mongoCustomersQueries } from './queries.mongo.js';
import { mysqlCustomersQueries } from './queries.mysql.js';
import { CustomersRepository } from './repository.js';
import { CustomersService } from './service.js';
import { schemas } from './schema.js';

/**
 * Customers: The customer side of an account: profile, saved addresses, marketing consent, recently viewed products, the Account tab overview, guest order access, data export and account closure, and the staff view of customer accounts with notes and recorded account actions. Credentials, sessions and verification belong to identity.
 *
 * Name, launch phase, dependencies, permissions, events, jobs, settings and endpoints come from
 * docs/api/spec/modules/customers.json through `spec`; the server refuses to start if they drift.
 */
export default defineModule({
  spec,
  version: '2.1.0',
  schemas,
  register(ctx) {
    // Address validation provider: the deterministic dev adapter in development and tests; none is wired for production yet (format rules only)
    const addressProvider = ctx.config.devTokens ? devAddressProvider : undefined;
    // Geocoder: built-in ZIP and city centroids in development and tests; production has no provider yet (not configured, no points)
    const geocoder = ctx.config.devTokens ? devGeocoder : unconfiguredGeocoder;
    // the repository is store-neutral (ctx.store); the staff search box is the store's own read (queries.ts)
    const queries = ctx.mysql ? mysqlCustomersQueries(ctx.mysql) : mongoCustomersQueries(ctx.mongo);
    const service = new CustomersService({ repo: new CustomersRepository(ctx.store, queries), ctx, addressProvider, geocoder });
    ctx.provide(service);
    ctx.http.routes(storeRoutes(service), adminRoutes(service), publicRoutes(service));
    ctx.graphql.resolvers(resolvers(service));
    // the customer list export dataset (reports reads rows through exportRows)
    ctx.afterBoot(() => service.admin.registerDataset());

    // Events this module reacts to (spec events.consumes)
    ctx.events.on("access.approval.decided", (e) => service.onApprovalDecidedFromAccess(e.payload, e.id));
    ctx.events.on("orders.order.placed", (e) => service.onOrderPlacedFromOrders(e.payload, e.id));
    ctx.events.on("identity.user.registered", (e) => service.onUserRegisteredFromIdentity(e.payload));
    ctx.events.on("identity.user.verified", (e) => service.onUserVerifiedFromIdentity(e.payload));
    ctx.events.on("identity.guest_session.claimed", (e) => service.onGuestSessionClaimedFromIdentity(e.payload));
    ctx.events.on("identity.email.changed", (e) => service.onEmailChangedFromIdentity(e.payload));
    ctx.events.on("identity.account.closed", (e) => service.onAccountClosedFromIdentity(e.payload));
    ctx.events.on("trust.enforcement.recorded", (e) => service.onEnforcementRecordedFromTrust(e.payload, e.actor));
    ctx.events.on("trust.enforcement.reversed", (e) => service.onEnforcementReversedFromTrust(e.payload, e.id));
    ctx.events.on("catalog.product.merged", (e) => service.onProductMergedFromCatalog(e.payload));

    // Background jobs (spec jobs)
    ctx.jobs.handle("customers.expire-restrictions", () => service.expireRestrictions());
    ctx.jobs.handle("customers.build-data-exports", () => service.buildDataExports());
    ctx.jobs.handle("customers.expire-export-links", () => service.expireExportLinks());
    ctx.jobs.handle("customers.complete-closures", () => service.completeClosures());
    ctx.jobs.handle("customers.prune-recently-viewed", () => service.pruneRecentlyViewed());
    ctx.jobs.handle("customers.geocode-addresses", () => service.geocodeAddresses());
  },
});
