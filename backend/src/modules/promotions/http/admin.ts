import { routes } from '../../../kernel/http/index.js';
import { endpoints } from '../../../spec/promotions.js';
import type { PromotionsService } from '../service.js';

/**
 * Admin API: /api/admin/promotions/…  (docs/api/modules/promotions.md)
 * One handler per endpoint of this area in the spec; the compiler rejects missing or extra ones.
 */
export const adminRoutes = (service: PromotionsService) => {
  const c = service.campaigns;
  const p = service.participation;
  return routes(endpoints, 'admin', {
    /** GET /dashboard: KPIs, tab counts, daily discount cost and campaign results */
    promotionsDashboard: async ({ query }) => c.dashboard(query),
    /** GET /campaigns: All campaigns and seller discounts */
    listCampaigns: async ({ query, page }) => c.list(query, page),
    /** POST /campaigns: Create a campaign draft */
    createCampaign: async ({ body, actor, requestId, principal }) => c.createCampaign(body, { actor, requestId, principal }),
    /** GET /campaigns/{id}: Campaign with eligible count, funding review, readiness and participation summary */
    getCampaign: async ({ params }) => c.view(params.id),
    /** PATCH /campaigns/{id}: Edit a campaign */
    updateCampaign: async ({ params, body, actor, requestId, principal }) => c.update(params.id, body, { actor, requestId, principal }),
    /** GET /campaigns/{id}/eligible-offers: Offers the scope resolves to, with exclusion and ineligibility reasons */
    listEligibleOffers: async ({ params, query, page }) => c.listEligibleOffers(params.id, query, page),
    /** POST /campaigns/{id}/price-preview: Product card, cart and checkout preview for a sample offer */
    previewCampaignPrice: async ({ params, body }) => c.previewPrice(params.id, body.offerId),
    /** POST /campaigns/{id}/invitations: Invite sellers to join (consent required before their offers are included) */
    inviteSellers: async ({ params, body, actor, requestId, principal }) => p.invite(params.id, body, { actor, requestId, principal }),
    /** GET /campaigns/{id}/participations: Sellers invited, with consent state and earnings per $100 sale */
    listParticipations: async ({ params, query, page }) => p.listForCampaign(params.id, query.state, page),
    /** POST /participations/{id}/decide-withdrawal: Approve or reject a seller's request to leave a live campaign */
    decideWithdrawal: async ({ params, body, actor, requestId, principal }) => p.decideWithdrawal(params.id, body, { actor, requestId, principal }),
    /** POST /participations/{id}/remove: Remove a seller or some of its offers from a campaign */
    removeParticipation: async ({ params, body, actor, requestId, principal }) => p.remove(params.id, body, { actor, requestId, principal }),
    /** PUT /campaigns/{id}/flash-items: Set flash sale offers, deal prices, deal stock and purchase limits */
    putFlashItems: async ({ params, body, actor, requestId, principal }) => c.putFlashItems(params.id, body.items, body.reason, { actor, requestId, principal }),
    /** GET /campaigns/{id}/flash-items: Flash items with claimed and sold-out state */
    listFlashItems: async ({ params }) => c.flashItems((await service.core.campaign(params.id)).model),
    /** POST /campaigns/{id}/submit: Send to Finance for funding confirmation */
    submitCampaign: async ({ params, body, actor, requestId, principal }) => c.submit(params.id, body.note, { actor, requestId, principal }),
    /** POST /campaigns/{id}/withdraw: Take a campaign back from Finance review to draft */
    withdrawCampaign: async ({ params, actor, requestId, principal }) => c.withdraw(params.id, { actor, requestId, principal }),
    /** POST /campaigns/{id}/confirm-funding: Finance confirms funding */
    confirmFunding: async ({ params, body, actor, requestId, principal }) => c.confirmFunding(params.id, body, { actor, requestId, principal }),
    /** POST /campaigns/{id}/request-changes: Finance sends the campaign back with a reason */
    requestCampaignChanges: async ({ params, body, actor, requestId, principal }) => c.requestChanges(params.id, body.reason, { actor, requestId, principal }),
    /** POST /campaigns/{id}/schedule: Schedule an approved campaign */
    scheduleCampaign: async ({ params, actor, requestId, principal }) => c.schedule(params.id, { actor, requestId, principal }),
    /** POST /campaigns/{id}/pause: Pause a scheduled or live campaign */
    pauseCampaign: async ({ params, body, actor, requestId, principal }) => {
      const by = { actor, requestId, principal };
      // the reason is optional (G68): a default keeps the history and the audit entry readable
      const reason = body.reason?.trim() || 'Paused by Marketing';
      await c.pause(params.id, reason, by);
      return c.audited(params.id, 'promotions.campaign.pause', 'Paused campaign', by, reason);
    },
    /** POST /campaigns/{id}/resume: Resume a paused campaign */
    resumeCampaign: async ({ params, body, actor, requestId, principal }) => {
      const by = { actor, requestId, principal };
      await c.resume(params.id, body.reason ?? null, by);
      return c.audited(params.id, 'promotions.campaign.resume', 'Resumed campaign', by, body.reason);
    },
    /** POST /campaigns/{id}/end: End a live or paused campaign early */
    endCampaign: async ({ params, body, actor, requestId, principal }) => {
      const by = { actor, requestId, principal };
      await c.end(params.id, 'ended_early', by, body.reason);
      return c.audited(params.id, 'promotions.campaign.end', 'Ended campaign early', by, body.reason);
    },
    /** POST /campaigns/{id}/cancel: Cancel a campaign that has not started */
    cancelCampaign: async ({ params, body, actor, requestId, principal }) => {
      const by = { actor, requestId, principal };
      await c.cancel(params.id, body.reason, by);
      return c.audited(params.id, 'promotions.campaign.cancel', 'Cancelled campaign', by, body.reason);
    },
    /** POST /campaigns/{id}/codes: Generate unique single-use codes (e.g. for support or partners) */
    generateCodes: async ({ params, body, actor, requestId, principal }) => c.generateCodes(params.id, body, { actor, requestId, principal }),
    /** GET /campaigns/{id}/codes: Codes with redemptions */
    listCodes: async ({ params, query, page }) => c.listCodes(params.id, query, page),
    /** POST /codes/{id}/deactivate: Deactivate a leaked or misused code */
    deactivateCode: async ({ params, body, actor, requestId, principal }) => c.deactivateCode(params.id, body.reason, { actor, requestId, principal }),
    /** GET /campaigns/{id}/redemptions: Redemptions with funding split and reversals */
    listRedemptions: async ({ params, query, page }) => c.listRedemptions(params.id, query.state, page),
    /** GET /campaigns/{id}/results: Sales, discount cost by funder, margin impact, redemptions, returns and seller participation */
    getCampaignResults: async ({ params }) => c.results(params.id),
    /** GET /campaigns/{id}/history: Submission, decisions, status changes and edits with reasons */
    getCampaignHistory: async ({ params, page }) => c.history(params.id, page),
  });
};
