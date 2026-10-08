import { notImplemented, routes } from '../../../kernel/http/index.js';
import { endpoints } from '../../../spec/promotions.js';
import type { PromotionsService } from '../service.js';

/**
 * Admin API: /api/admin/promotions/…  (docs/api/modules/promotions.md)
 * One handler per endpoint of this area in the spec; the compiler rejects missing or extra ones.
 */
export const adminRoutes = (service: PromotionsService) => {
  void service;
  return routes(endpoints, 'admin', {
    /** GET /dashboard: KPIs, tab counts, daily discount cost and campaign results */
    promotionsDashboard: notImplemented,
    /** GET /campaigns: All campaigns and seller discounts */
    listCampaigns: notImplemented,
    /** POST /campaigns: Create a campaign draft */
    createCampaign: notImplemented,
    /** GET /campaigns/{id}: Campaign with eligible count, funding review, readiness and participation summary */
    getCampaign: notImplemented,
    /** PATCH /campaigns/{id}: Edit a campaign */
    updateCampaign: notImplemented,
    /** GET /campaigns/{id}/eligible-offers: Offers the scope resolves to, with exclusion and ineligibility reasons */
    listEligibleOffers: notImplemented,
    /** POST /campaigns/{id}/price-preview: Product card, cart and checkout preview for a sample offer */
    previewCampaignPrice: notImplemented,
    /** POST /campaigns/{id}/invitations: Invite sellers to join (consent required before their offers are included) */
    inviteSellers: notImplemented,
    /** GET /campaigns/{id}/participations: Sellers invited, with consent state and earnings per $100 sale */
    listParticipations: notImplemented,
    /** POST /participations/{id}/decide-withdrawal: Approve or reject a seller's request to leave a live campaign */
    decideWithdrawal: notImplemented,
    /** POST /participations/{id}/remove: Remove a seller or some of its offers from a campaign */
    removeParticipation: notImplemented,
    /** PUT /campaigns/{id}/flash-items: Set flash sale offers, deal prices, deal stock and purchase limits */
    putFlashItems: notImplemented,
    /** GET /campaigns/{id}/flash-items: Flash items with claimed and sold-out state */
    listFlashItems: notImplemented,
    /** POST /campaigns/{id}/submit: Send to Finance for funding confirmation */
    submitCampaign: notImplemented,
    /** POST /campaigns/{id}/withdraw: Take a campaign back from Finance review to draft */
    withdrawCampaign: notImplemented,
    /** POST /campaigns/{id}/confirm-funding: Finance confirms funding */
    confirmFunding: notImplemented,
    /** POST /campaigns/{id}/request-changes: Finance sends the campaign back with a reason */
    requestCampaignChanges: notImplemented,
    /** POST /campaigns/{id}/schedule: Schedule an approved campaign */
    scheduleCampaign: notImplemented,
    /** POST /campaigns/{id}/pause: Pause a scheduled or live campaign */
    pauseCampaign: notImplemented,
    /** POST /campaigns/{id}/resume: Resume a paused campaign */
    resumeCampaign: notImplemented,
    /** POST /campaigns/{id}/end: End a live or paused campaign early */
    endCampaign: notImplemented,
    /** POST /campaigns/{id}/cancel: Cancel a campaign that has not started */
    cancelCampaign: notImplemented,
    /** POST /campaigns/{id}/codes: Generate unique single-use codes (e.g. for support or partners) */
    generateCodes: notImplemented,
    /** GET /campaigns/{id}/codes: Codes with redemptions */
    listCodes: notImplemented,
    /** POST /codes/{id}/deactivate: Deactivate a leaked or misused code */
    deactivateCode: notImplemented,
    /** GET /campaigns/{id}/redemptions: Redemptions with funding split and reversals */
    listRedemptions: notImplemented,
    /** GET /campaigns/{id}/results: Sales, discount cost by funder, margin impact, redemptions, returns and seller participation */
    getCampaignResults: notImplemented,
    /** GET /campaigns/{id}/history: Submission, decisions, status changes and edits with reasons */
    getCampaignHistory: notImplemented,
  });
};
