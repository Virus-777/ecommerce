import type { ModuleResolvers } from '../../../kernel/graphql/index.js';
import { AppError } from '../../../kernel/errors/index.js';
import type { SettingsService } from '../service.js';

/**
 * Resolvers for the GraphQL fields this module owns (`@source(module: "settings", …)` in graphql/schema.ts).
 * A field without a resolver answers NOT_IMPLEMENTED; fields of this module's own types without
 * @source resolve from the parent object.
 *
 * Fields resolved:
 *   Query.storeInfo → service.storeInfo
 *   Query.upcomingChanges → service.upcomingChangesForSellers
 */
export const resolvers = (service: SettingsService): ModuleResolvers => ({
  Query: {
    storeInfo: async () => {
      const info = await service.storeInfo();
      return {
        ...info,
        // GraphQL enums are upper case
        closures: info.closures.map((c) => ({ ...c, kind: c.kind.toUpperCase() })),
        maintenance: info.maintenance ? { ...info.maintenance, kind: info.maintenance.kind ? info.maintenance.kind.toUpperCase() : null } : null,
      };
    },
    upcomingChanges: async (_root, _args, ctx) => {
      if (!ctx.principal) throw new AppError('UNAUTHORIZED', 'Sign in to continue');
      return service.upcomingChangesForSellers(ctx.principal);
    },
  },
});
