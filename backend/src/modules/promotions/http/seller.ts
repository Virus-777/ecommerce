import { notImplemented, routes } from '../../../kernel/http/index.js';
import { endpoints } from '../../../spec/promotions.js';
import type { PromotionsService } from '../service.js';

/**
 * Seller API: /api/seller/promotions/…  (docs/api/modules/promotions.md)
 * One handler per endpoint of this area in the spec; the compiler rejects missing or extra ones.
 */
export const sellerRoutes = (service: PromotionsService) => {
  void service;
  return routes(endpoints, 'seller', {
    /** GET /discounts: Discounts this seller funds */
    listSellerDiscounts: notImplemented,
    /** POST /discounts/preview: What the customer sees and the seller earns per unit */
    previewSellerDiscount: notImplemented,
    /** POST /discounts: Create a seller-funded discount draft */
    createSellerDiscount: notImplemented,
    /** GET /discounts/{id}: One own discount with usage */
    getSellerDiscount: notImplemented,
    /** PATCH /discounts/{id}: Edit a draft or scheduled discount */
    updateSellerDiscount: notImplemented,
    /** POST /discounts/{id}/schedule: Schedule a discount (goes live at its start time) */
    scheduleSellerDiscount: notImplemented,
    /** POST /discounts/{id}/pause: Pause an own discount */
    pauseSellerDiscount: notImplemented,
    /** POST /discounts/{id}/resume: Resume an own discount */
    resumeSellerDiscount: notImplemented,
    /** POST /discounts/{id}/end: End an own discount now (or cancel before start) */
    endSellerDiscount: notImplemented,
    /** GET /invitations: Platform campaign invitations and past participation */
    listInvitations: notImplemented,
    /** GET /invitations/{id}: Invitation with eligibility per offer, funding split and expected earnings per unit */
    getInvitation: notImplemented,
    /** POST /invitations/{id}/accept: Consent to join with selected eligible offers */
    acceptInvitation: notImplemented,
    /** POST /invitations/{id}/decline: Decline an invitation */
    declineInvitation: notImplemented,
    /** POST /invitations/{id}/withdraw: Leave a campaign */
    withdrawParticipation: notImplemented,
  });
};
