import { defineModule } from '../../kernel/module-system/index.js';
import { spec } from '../../spec/identity.js';
import { resolvers } from './graphql/resolvers.js';
import { storeRoutes } from './http/store.js';
import { sellerRoutes } from './http/seller.js';
import { adminRoutes } from './http/admin.js';
import { SESSION_COOKIE_ENDPOINTS } from './http/client.js';
import { publicRoutes } from './http/public.js';
import { devExternalIdentityVerifier } from './providers/external-id.js';
import { mongoMigrations } from './migrations.js';
import { mongoIdentityQueries } from './queries.mongo.js';
import { mysqlIdentityQueries } from './queries.mysql.js';
import { IdentityRepository } from './repository.js';
import { schemas } from './schema.js';
import { IdentityService } from './service.js';

/**
 * Identity: Who someone is and how they prove it: accounts for customers, seller members and staff, credentials, email verification, sessions and refresh tokens for the website and the Android app, password recovery, 2-step verification, signed-in devices, guest sessions and the security activity log.
 *
 * Name, launch phase, dependencies, permissions, events, jobs, settings and endpoints come from
 * docs/api/spec/modules/identity.json through `spec`; the server refuses to start if they drift.
 */
export default defineModule({
  spec,
  version: '2.2.0',
  schemas,
  mongoMigrations,
  register(ctx) {
    // Google / Apple ID tokens: the deterministic dev verifier in development and tests; no provider is wired for production yet
    const externalIds = ctx.config.devTokens ? devExternalIdentityVerifier : undefined;
    // the repository is store-neutral (ctx.store); the window function and the computed expiry are the
    // store's own (queries.ts), and `ctx.mysql` is there only while this module's data is in MySQL
    const queries = ctx.mysql ? mysqlIdentityQueries(ctx.mysql) : mongoIdentityQueries(ctx.mongo);
    const service = new IdentityService({ repo: new IdentityRepository(ctx.store, queries), ctx, externalIds });
    ctx.provide(service);
    ctx.http.routes(storeRoutes(service), sellerRoutes(service), adminRoutes(service), publicRoutes(service));
    // responses that set or clear the website's refresh cookie (http/client.ts send()): browsers call them with credentials
    ctx.http.sessionCookie(...SESSION_COOKIE_ENDPOINTS);
    ctx.graphql.resolvers(resolvers(service));

    // Events this module reacts to (spec events.consumes)
    ctx.events.on("customers.account.closed", (e) => service.onAccountClosedFromCustomers(e.payload));

    // Background jobs (spec jobs)
    ctx.jobs.handle("identity.purge-expired", () => service.purgeExpired());
    ctx.jobs.handle("identity.expire-invitations", () => service.expireInvitations());
    ctx.jobs.handle("identity.expire-sessions", () => service.expireSessions());
    ctx.jobs.handle("identity.prune-security-events", () => service.pruneSecurityEvents());
  },
});
