import { defineModule } from '../../kernel/module-system/index.js';
import { spec } from '../../spec/settings.js';
import { resolvers } from './graphql/resolvers.js';
import { typeDefs } from './graphql/schema.js';
import { sellerRoutes } from './http/seller.js';
import { adminRoutes } from './http/admin.js';
import { publicRoutes } from './http/public.js';
import { SettingsRepository } from './repository.js';
import { schemas } from './schema.js';
import { SettingsService } from './service.js';

/**
 * Settings: Market-level platform settings: country and service region, currency, time zone, business hours, support contacts, guest checkout, Android app versions and feature flags, plus the effective-dated change process (impact preview, approval, schedule, apply) for every runtime setting a module declares. It also assembles the Admin Center settings page from sections owned by other modules.
 *
 * Name, launch phase, dependencies, permissions, events, jobs, settings and endpoints come from
 * docs/api/spec/modules/settings.json through `spec`; the server refuses to start if they drift.
 */
export default defineModule({
  spec,
  version: '2.0.0',
  schemas,
  graphql: typeDefs,
  async register(ctx) {
    const service = new SettingsService({
      repo: new SettingsRepository(ctx.mongo),
      ctx,
      // the kernel does not tell a module which modules run; this mirrors app.ts (spec gap, see report)
      enabledModules: ctx.modules,
    });
    ctx.provide(service);
    await service.warmUp();
    ctx.http.routes(sellerRoutes(service), adminRoutes(service), publicRoutes(service));
    ctx.graphql.resolvers(resolvers(service));

    // Events this module reacts to (spec events.consumes)
    ctx.events.on("access.approval.decided", (e) => service.onApprovalDecidedFromAccess(e.payload));
    ctx.events.on("access.approval.returned", (e) => service.onApprovalReturnedFromAccess(e.payload));

    // Background jobs (spec jobs)
    ctx.jobs.handle("settings.sync-definitions", () => service.syncDefinitions());
    ctx.jobs.handle("settings.apply-due-changes", () => service.applyDueChanges());
    ctx.jobs.handle("settings.refresh-impact", () => service.refreshImpact());
  },
});
