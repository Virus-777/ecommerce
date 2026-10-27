import { routes } from '../../../kernel/http/index.js';
import { endpoints } from '../../../spec/shipping.js';
import type { ShippingService } from '../service.js';

/**
 * Seller API: /api/seller/shipping/…  (docs/api/modules/shipping.md)
 * One handler per endpoint of this area in the spec; the compiler rejects missing or extra ones.
 * Every handler acts for the caller's seller only (input.sellerId): other sellers' records are NOT_FOUND.
 */
export const sellerRoutes = (service: ShippingService) => {
  const owner = (sellerId: string) => ({ ownerType: 'seller' as const, sellerId });
  return routes(endpoints, 'seller', {
    /** GET /settings: Coverage, profiles with methods and rates, dispatch schedule, closures, labels and customer preview */
    getSellerSettings: async ({ sellerId }) => service.profiles.getSellerSettings(sellerId),
    /** PUT /settings: Change coverage, dispatch schedule or label preference (now or from a date) */
    updateSellerSettings: async ({ sellerId, body, actor, requestId, principal }) => service.profiles.updateSellerSettings(sellerId, body, { actor, requestId, principal }),
    /** POST /closures: Add a holiday closure (estimates skip closed days) */
    addSellerClosure: async ({ sellerId, body, actor, requestId, principal }) => service.profiles.addClosure(sellerId, body, { actor, requestId, principal }),
    /** DELETE /closures/{id}: Remove a closure */
    removeSellerClosure: async ({ sellerId, params, actor, requestId, principal }) => {
      await service.profiles.removeClosure(sellerId, params.id, { actor, requestId, principal });
    },
    /** GET /carriers: The seller's own carriers */
    listSellerCarriers: async ({ sellerId }) => service.ownCarriers.list(sellerId),
    /** POST /carriers: Add a carrier the seller ships with itself */
    addSellerCarrier: async ({ sellerId, body }) => service.ownCarriers.add(sellerId, body),
    /** PATCH /carriers/{id}: Rename a carrier or change its tracking link */
    updateSellerCarrier: async ({ sellerId, params, body }) => service.ownCarriers.update(sellerId, params.id, body),
    /** DELETE /carriers/{id}: Remove a carrier from the list */
    removeSellerCarrier: async ({ sellerId, params }) => {
      await service.ownCarriers.remove(sellerId, params.id);
    },
    /** GET /profiles: The seller's shipping profiles (chosen on each offer) */
    listSellerProfiles: async ({ sellerId }) => service.profiles.listProfiles(owner(sellerId)),
    /** POST /profiles: Create a shipping profile (e.g. Large items) */
    createSellerProfile: async ({ sellerId, body, actor, requestId, principal }) => service.profiles.createProfile(owner(sellerId), body, { actor, requestId, principal }),
    /** PUT /profiles/{id}: Change methods, rates or the free-shipping threshold (new version, now or from a date) */
    updateSellerProfile: async ({ sellerId, params, body, actor, requestId, principal }) => service.profiles.updateProfile(params.id, owner(sellerId), body, { actor, requestId, principal }),
    /** POST /profiles/{id}/archive: Archive a profile no offer uses */
    archiveSellerProfile: async ({ sellerId, params, actor, requestId, principal }) => service.profiles.archiveProfile(params.id, owner(sellerId), { actor, requestId, principal }),
    /** GET /preview: What customers see for an offer or profile at a location */
    previewSellerShipping: async ({ sellerId, query }) => service.profiles.preview(owner(sellerId), { postalCode: query.postalCode, offerId: query.offerId ?? null, profileId: query.profileId ?? null, useDraft: query.useDraft ?? null }),
    /** GET /methods: Platform shipping methods a seller can add to a profile, with their carrier services and transit */
    listMethodsForSeller: async () => service.setup.listMethods(true),
    /** GET /carrier-services: Carriers and services sellers can use, with label support and tracking formats */
    listCarrierServicesForSeller: async ({ sellerId }) => {
      const [platform, own] = await Promise.all([service.setup.listCarriers({ staff: false, sellerFacing: true }), service.ownCarriers.carriers(sellerId)]);
      return [...platform, ...own];
    },
    /** POST /shipments: Record a shipment for some or all items of one of the seller's orders */
    recordShipment: async ({ sellerId, body, actor, requestId, principal }) => service.shipments.record(owner(sellerId), body, { actor, requestId, principal }),
    /** GET /shipments: The seller's shipment records */
    listSellerShipments: async ({ sellerId, query, page }) => service.shipments.listSeller(sellerId, query, page),
    /** GET /shipments/{id}: One shipment with tracking events and correction history */
    getSellerShipment: async ({ sellerId, params, principal }) => service.shipments.view(await service.shipments.own(params.id, sellerId), principal),
    /** POST /shipments/{id}/correct-tracking: Correct the carrier or tracking number with a reason */
    correctTrackingSeller: async ({ sellerId, params, body, actor, requestId, principal }) =>
      service.shipments.correct(params.id, { carrierCode: body.carrierCode ?? null, trackingNumber: body.trackingNumber, reason: body.reason }, { actor, requestId, principal }, { sellerId }),
    /** POST /labels/quotes: Label prices for a package, marked when they keep the promised arrival */
    quoteLabels: async ({ sellerId, body }) => service.shipments.quoteLabels(sellerId, body),
    /** POST /labels: Buy a carrier label (cost is deducted from earnings) */
    buyLabel: async ({ sellerId, body, idempotencyKey, actor, requestId, principal }) => service.shipments.buyLabel(sellerId, body, idempotencyKey, { actor, requestId, principal }),
    /** POST /shipments/{id}/hand-over: Mark a labelled package as handed to the carrier */
    markLabelHandedOver: async ({ sellerId, params, body, actor, requestId, principal }) =>
      service.shipments.handOverSeller(sellerId, params.id, body?.at ?? service.core.now().toISOString(), { actor, requestId, principal }),
    /** POST /labels/{id}/void: Void an unused label (refunded to earnings) */
    voidLabelSeller: async ({ sellerId, params, body, actor, requestId, principal }) => service.shipments.voidLabel(params.id, body.reason, { actor, requestId, principal }, sellerId),
    /** GET /exceptions: Delivery exceptions on the seller's orders that need the seller's response */
    listSellerExceptions: async ({ sellerId, query, page }) => service.exceptions.listAdmin({ kind: query.kind ?? null, status: query.status ?? null, sellerId }, page),
    /** POST /exceptions/{id}/respond: Respond: provide tracking, promise a ship-by date, report you cannot fulfill, or confirm a replacement */
    respondToException: async ({ sellerId, params, body, actor, requestId, principal }) => service.exceptions.respond(sellerId, params.id, body, { actor, requestId, principal }),
    /** GET /claims: Carrier claims on the seller's shipments */
    listSellerClaims: async ({ sellerId, page }) => service.exceptions.listClaims({ sellerId }, page),
    /** POST /claims: Record a claim the seller filed with its own carrier account */
    recordSellerClaim: async ({ sellerId, body, actor, requestId, principal }) => service.exceptions.recordSellerClaim(sellerId, body, { actor, requestId, principal }),
    /** GET /shipping-setup: Carriers, services, label purchase and the default package for recording a shipment */
    getShippingSetup: async ({ sellerId }) => service.profiles.setup(sellerId),
  });
};
