import type { ModuleResolvers } from '../../../kernel/graphql/index.js';
import type { AdCampaignSummary } from '../../../spec/advertising.js';
import type { AdvertisingService } from '../service.js';

/**
 * Resolvers for the GraphQL fields this module owns (`@source(module: "advertising", …)` in graphql/schema.ts).
 *   PromotionCampaign.adCampaigns → service.campaignsForPromotion
 *   Query.adDashboard → service.dashboardSummary (plus the live list the GraphQL tile shows)
 * Read-only: ad serving and tracking stay on REST.
 */
const summary = (s: AdCampaignSummary) => ({ ...s, status: s.status.toUpperCase(), advertiser: { ...s.advertiser, kind: s.advertiser.kind.toUpperCase() } });

export const resolvers = (service: AdvertisingService): ModuleResolvers => ({
  PromotionCampaign: {
    adCampaigns: async (root: { id: string }) => (await service.campaignsForPromotion(root.id)).map(summary),
  },
  Query: {
    adDashboard: async (_root, args: { listLimit?: number | null }) => {
      const d = await service.reports.dashboard({ listLimit: args.listLimit ?? 3 });
      return {
        liveNow: d.liveNow,
        startingIn7Days: d.startingIn7Days,
        nextStartAt: d.nextStartAt ?? null,
        endingSoon: d.endingSoon,
        waitingApproval: d.waitingApproval,
        oldestWaitingDays: d.oldestWaitingDays ?? null,
        spendThisMonth: d.spendThisMonth,
        attributedOrders: d.attributedOrders,
        attributedSales: d.attributedSales,
        attributionDays: d.attributionDays,
        live: d.liveList.map(summary),
        upcomingStarts: d.upcomingStarts.map(summary),
        endingSoonList: d.endingSoonList.map(summary),
        waitingList: d.waitingList.map(summary),
      };
    },
  },
});
