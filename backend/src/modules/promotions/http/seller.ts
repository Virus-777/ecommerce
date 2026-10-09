import { routes } from '../../../kernel/http/index.js';
import { endpoints } from '../../../spec/promotions.js';
import type { PromotionsService } from '../service.js';

/**
 * Seller API: /api/seller/promotions/…  (docs/api/modules/promotions.md)
 * One handler per endpoint of this area in the spec; the compiler rejects missing or extra ones.
 * Every call acts for the session's seller: another seller's discount, offer or invitation is NOT_FOUND.
 */
export const sellerRoutes = (service: PromotionsService) => {
  const d = service.sellerDiscounts;
  const p = service.participation;
  return routes(endpoints, 'seller', {
    /** GET /discounts: Discounts this seller funds */
    listSellerDiscounts: async ({ sellerId, query, page }) => d.list(sellerId, query.status, page),
    /** POST /discounts/preview: What the customer sees and the seller earns per unit */
    previewSellerDiscount: async ({ sellerId, body }) => d.preview(sellerId, body),
    /** POST /discounts: Create a seller-funded discount draft */
    createSellerDiscount: async ({ sellerId, body, actor, requestId, principal }) => d.create(sellerId, body, { actor, requestId, principal }),
    /** GET /discounts/{id}: One own discount with usage */
    getSellerDiscount: async ({ sellerId, params }) => d.get(sellerId, params.id),
    /** PATCH /discounts/{id}: Edit a draft or scheduled discount */
    updateSellerDiscount: async ({ sellerId, params, body, actor, requestId, principal }) => d.update(sellerId, params.id, body, { actor, requestId, principal }),
    /** POST /discounts/{id}/schedule: Schedule a discount (goes live at its start time) */
    scheduleSellerDiscount: async ({ sellerId, params, actor, requestId, principal }) => d.schedule(sellerId, params.id, { actor, requestId, principal }),
    /** POST /discounts/{id}/pause: Pause an own discount */
    pauseSellerDiscount: async ({ sellerId, params, actor, requestId, principal }) => d.pause(sellerId, params.id, { actor, requestId, principal }),
    /** POST /discounts/{id}/resume: Resume an own discount */
    resumeSellerDiscount: async ({ sellerId, params, actor, requestId, principal }) => d.resume(sellerId, params.id, { actor, requestId, principal }),
    /** POST /discounts/{id}/end: End an own discount now (or cancel before start) */
    endSellerDiscount: async ({ sellerId, params, body, actor, requestId, principal }) => d.end(sellerId, params.id, body.reason, { actor, requestId, principal }),
    /** GET /invitations: Platform campaign invitations and past participation */
    listInvitations: async ({ sellerId, query, page }) => p.listInvitations(sellerId, query.state, page),
    /** GET /invitations/{id}: Invitation with eligibility per offer, funding split and expected earnings per unit */
    getInvitation: async ({ sellerId, params }) => p.getInvitation(sellerId, params.id),
    /** POST /invitations/{id}/accept: Consent to join with selected eligible offers */
    acceptInvitation: async ({ sellerId, params, body, actor, requestId, principal }) => p.accept(sellerId, params.id, body, { actor, requestId, principal }),
    /** POST /invitations/{id}/decline: Decline an invitation */
    declineInvitation: async ({ sellerId, params, body, actor, requestId, principal }) => p.decline(sellerId, params.id, body.reason, { actor, requestId, principal }),
    /** POST /invitations/{id}/withdraw: Leave a campaign */
    withdrawParticipation: async ({ sellerId, params, body, actor, requestId, principal }) => p.withdraw(sellerId, params.id, body.reason, { actor, requestId, principal }),
  });
};
