import { defineModule } from '../../kernel/module-system/index.js';
import { spec } from '../../spec/audit.js';
import { resolvers } from './graphql/resolvers.js';
import { sellerRoutes } from './http/seller.js';
import { adminRoutes } from './http/admin.js';
import { mongoAuditQueries } from './queries.mongo.js';
import { mysqlAuditQueries } from './queries.mysql.js';
import { AuditRepository } from './repository.js';
import { schemas } from './schema.js';
import { AuditService } from './service.js';

/**
 * Action history: The tamper-evident action history: who did what, in which role, to which record, why, what changed (before and after), which approvals applied and the request id. Every module writes to it through record(); staff read it with filters and authorized exports; retention is a governed setting.
 *
 * Name, launch phase, dependencies, permissions, events, jobs, settings and endpoints come from
 * docs/api/spec/modules/audit.json through `spec`; the server refuses to start if they drift.
 */
export default defineModule({
  spec,
  version: '2.0.0',
  schemas,
  register(ctx) {
    // the repository is store-neutral (ctx.store); the one read that is not the same question in both
    // databases — the summary's actors, named by their newest entry — is the store's own (queries.ts)
    const queries = ctx.mysql ? mysqlAuditQueries(ctx.mysql) : mongoAuditQueries(ctx.mongo);
    const service = new AuditService({ repo: new AuditRepository(ctx.store, queries), ctx });
    ctx.provide(service);
    ctx.http.routes(sellerRoutes(service), adminRoutes(service));
    ctx.graphql.resolvers(resolvers(service));
    ctx.afterBoot(() => service.registerExportDataset().catch((err) => ctx.log.warn({ err }, 'audit: export dataset not registered; retried on first export')));

    // Events this module reacts to (spec events.consumes); the envelope time dates the approval steps
    ctx.events.on("access.approval.requested", (e) => service.onApprovalRequestedFromAccess(e.payload, { at: e.at }));
    ctx.events.on("access.approval.partially_approved", (e) => service.onApprovalPartiallyApprovedFromAccess(e.payload, { at: e.at }));
    ctx.events.on("access.approval.returned", (e) => service.onApprovalReturnedFromAccess(e.payload, { at: e.at }));
    ctx.events.on("access.approval.decided", (e) => service.onApprovalDecidedFromAccess(e.payload, { at: e.at }));

    // Background jobs (spec jobs)
    ctx.jobs.handle("audit.verify-chain", () => service.verifyChain());
    ctx.jobs.handle("audit.purge-expired", () => service.purgeExpired());
    ctx.jobs.handle("audit.prepare-partitions", () => service.preparePartitions());
  },
});
