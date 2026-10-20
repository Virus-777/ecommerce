import { defineModule } from '../../kernel/module-system/index.js';
import { spec } from '../../spec/access.js';
import { resolvers } from './graphql/resolvers.js';
import { adminRoutes } from './http/admin.js';
import { mongoMigrations } from './migrations.js';
import { AccessRepository } from './repository.js';
import { schemas } from './schema.js';
import { AccessService } from './service.js';

/**
 * Access and approvals: What staff may do and how much they may approve: staff roles, the permission registry, role assignments, leads and backups per work area, approval limits per role, approval requests with a second reviewer, and cover while someone is away. Granting access never grants financial authority.
 *
 * Name, launch phase, dependencies, permissions, events, jobs, settings and endpoints come from
 * docs/api/spec/modules/access.json through `spec`; the server refuses to start if they drift.
 */
export default defineModule({
  spec,
  version: '2.0.1',
  schemas,
  mongoMigrations,
  register(ctx) {
    const service = new AccessService({ repo: new AccessRepository(ctx.mongo), ctx });
    ctx.provide(service);
    ctx.http.routes(adminRoutes(service));
    ctx.graphql.resolvers(resolvers(service));

    // Events this module reacts to (spec events.consumes)
    ctx.events.on("identity.invitation.accepted", (e) => service.onInvitationAcceptedFromIdentity(e.payload));
    ctx.events.on("identity.invitation.revoked", (e) => service.onInvitationRevokedFromIdentity(e.payload));
    ctx.events.on("identity.account.disabled", (e) => service.onAccountDisabledFromIdentity(e.payload));
    ctx.events.on("identity.account.locked", (e) => service.onAccountLockedFromIdentity(e.payload));
    ctx.events.on("identity.account.unlocked", (e) => service.onAccountUnlockedFromIdentity(e.payload));

    // Background jobs (spec jobs)
    ctx.jobs.handle("access.sync-registry", () => service.syncRegistry());
    ctx.jobs.handle("access.apply-limit-changes", () => service.applyLimitChanges());
    ctx.jobs.handle("access.run-away-periods", () => service.runAwayPeriods());
    ctx.jobs.handle("access.expire-approval-requests", () => service.expireApprovalRequests());
    ctx.jobs.handle("access.remind-approvals", () => service.remindApprovals());
    ctx.jobs.handle("access.expire-assignments", () => service.expireAssignments());
  },
});
