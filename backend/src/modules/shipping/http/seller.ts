import { notImplemented, routes } from '../../../kernel/http/index.js';
import { endpoints } from '../../../spec/shipping.js';
import type { ShippingService } from '../service.js';

/**
 * Seller API: /api/seller/shipping/…  (docs/api/modules/shipping.md)
 * One handler per endpoint of this area in the spec; the compiler rejects missing or extra ones.
 */
export const sellerRoutes = (service: ShippingService) => {
  void service;
  return routes(endpoints, 'seller', {
    /** GET /settings: Coverage, profiles with methods and rates, dispatch schedule, closures, labels and customer preview */
    getSellerSettings: notImplemented,
    /** PUT /settings: Change coverage, dispatch schedule or label preference (now or from a date) */
    updateSellerSettings: notImplemented,
    /** POST /closures: Add a holiday closure (estimates skip closed days) */
    addSellerClosure: notImplemented,
    /** DELETE /closures/{id}: Remove a closure */
    removeSellerClosure: notImplemented,
    /** GET /profiles: The seller's shipping profiles (chosen on each offer) */
    listSellerProfiles: notImplemented,
    /** POST /profiles: Create a shipping profile (e.g. Large items) */
    createSellerProfile: notImplemented,
    /** PUT /profiles/{id}: Change methods, rates or the free-shipping threshold (new version, now or from a date) */
    updateSellerProfile: notImplemented,
    /** POST /profiles/{id}/archive: Archive a profile no offer uses */
    archiveSellerProfile: notImplemented,
    /** GET /preview: What customers see for an offer or profile at a location */
    previewSellerShipping: notImplemented,
    /** GET /methods: Platform shipping methods a seller can add to a profile, with their carrier services and transit */
    listMethodsForSeller: notImplemented,
    /** GET /carrier-services: Carriers and services sellers can use, with label support and tracking formats */
    listCarrierServicesForSeller: notImplemented,
    /** POST /shipments: Record a shipment for some or all items of one of the seller's orders */
    recordShipment: notImplemented,
    /** GET /shipments: The seller's shipment records */
    listSellerShipments: notImplemented,
    /** GET /shipments/{id}: One shipment with tracking events and correction history */
    getSellerShipment: notImplemented,
    /** POST /shipments/{id}/correct-tracking: Correct the carrier or tracking number with a reason */
    correctTrackingSeller: notImplemented,
    /** POST /labels/quotes: Label prices for a package, marked when they keep the promised arrival */
    quoteLabels: notImplemented,
    /** POST /labels: Buy a carrier label (cost is deducted from earnings) */
    buyLabel: notImplemented,
    /** POST /shipments/{id}/hand-over: Mark a labelled package as handed to the carrier */
    markLabelHandedOver: notImplemented,
    /** POST /labels/{id}/void: Void an unused label (refunded to earnings) */
    voidLabelSeller: notImplemented,
    /** GET /exceptions: Delivery exceptions on the seller's orders that need the seller's response */
    listSellerExceptions: notImplemented,
    /** POST /exceptions/{id}/respond: Respond: provide tracking, promise a ship-by date, report you cannot fulfill, or confirm a replacement */
    respondToException: notImplemented,
    /** GET /claims: Carrier claims on the seller's shipments */
    listSellerClaims: notImplemented,
    /** POST /claims: Record a claim the seller filed with its own carrier account */
    recordSellerClaim: notImplemented,
    /** GET /shipping-setup: Carriers, services, label purchase and the default package for recording a shipment */
    getShippingSetup: notImplemented,
  });
};
