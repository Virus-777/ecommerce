import { notImplemented, routes } from '../../../kernel/http/index.js';
import { endpoints } from '../../../spec/shipping.js';
import type { ShippingService } from '../service.js';

/**
 * Admin API: /api/admin/shipping/…  (docs/api/modules/shipping.md)
 * One handler per endpoint of this area in the spec; the compiler rejects missing or extra ones.
 */
export const adminRoutes = (service: ShippingService) => {
  void service;
  return routes(endpoints, 'admin', {
    /** GET /summary: Live notices, exception counts, overdue dispatch and Official Store on-time rate */
    getShippingSummary: notImplemented,
    /** GET /carriers: Carriers with services, tracking connection and on-time rate */
    listCarriers: notImplemented,
    /** POST /carriers: Add a carrier account */
    createCarrier: notImplemented,
    /** PATCH /carriers/{id}: Activate, deactivate or rename a carrier, or update its contacts */
    updateCarrier: notImplemented,
    /** PATCH /carriers/{id}/services/{serviceId}: Enable or disable a carrier service, set transit days */
    updateCarrierService: notImplemented,
    /** GET /methods: Platform shipping methods and their carrier services */
    listMethods: notImplemented,
    /** PUT /methods/{id}: Change a method's name, customer label, transit or services */
    updateMethod: notImplemented,
    /** GET /zones: Served zones and excluded areas */
    listZones: notImplemented,
    /** POST /zones: Add a zone or excluded area */
    createZone: notImplemented,
    /** PUT /zones/{id}: Change a zone, enable or disable it */
    updateZone: notImplemented,
    /** GET /profiles: Official Store and seller shipping profiles */
    listProfilesAdmin: notImplemented,
    /** POST /profiles: Create an Official Store shipping profile */
    createOfficialProfile: notImplemented,
    /** PUT /profiles/{id}: Change Official Store rates (new version with an effective date) */
    updateOfficialProfile: notImplemented,
    /** GET /dispatch-targets: Official Store cutoff and default seller targets */
    getDispatchTargets: notImplemented,
    /** PUT /dispatch-targets: Change dispatch targets from an effective date */
    updateDispatchTargets: notImplemented,
    /** GET /notices: Holiday calendar and service notices */
    listNotices: notImplemented,
    /** POST /notices: Draft a holiday or service-interruption notice */
    createNotice: notImplemented,
    /** POST /notices/preview: Preview a draft notice at checkout for a postal code: customer message and adjusted arrival estimates */
    previewNotice: notImplemented,
    /** PATCH /notices/{id}: Edit a draft, scheduled or live notice */
    updateNotice: notImplemented,
    /** POST /notices/{id}/publish: Publish now or schedule a notice */
    publishNotice: notImplemented,
    /** POST /notices/{id}/withdraw: Withdraw a notice */
    withdrawNotice: notImplemented,
    /** GET /free-shipping-rules: Free-shipping rules with who funds them */
    listFreeShippingRules: notImplemented,
    /** POST /free-shipping-rules: Add a free-shipping rule */
    createFreeShippingRule: notImplemented,
    /** PUT /free-shipping-rules/{id}: Change or end a free-shipping rule */
    updateFreeShippingRule: notImplemented,
    /** GET /shipments: All shipments */
    listShipmentsAdmin: notImplemented,
    /** GET /shipments/{id}: Shipment history: events, corrections, label and exceptions */
    getShipmentAdmin: notImplemented,
    /** POST /shipments/{id}/correct-tracking: Correct carrier or tracking as staff */
    correctTrackingAdmin: notImplemented,
    /** POST /shipments/{id}/events: Record a carrier status the integration missed (with evidence) */
    recordTrackingEventAdmin: notImplemented,
    /** GET /exceptions: Dispatch and delivery exceptions by kind, with owner, deadline and whether the customer was notified */
    listExceptions: notImplemented,
    /** GET /exceptions/counts: Open exceptions per kind (queue tiles) */
    getExceptionCounts: notImplemented,
    /** GET /exceptions/{id}: One exception with history */
    getException: notImplemented,
    /** POST /exceptions: Open an exception manually (e.g. lost or damaged reported by phone) */
    openException: notImplemented,
    /** POST /exceptions/{id}/assign: Set the owner */
    assignException: notImplemented,
    /** POST /exceptions/{id}/notify-seller: Remind the seller (late dispatch, missing tracking, failed delivery) */
    notifySeller: notImplemented,
    /** POST /exceptions/{id}/notify-customer: Send the customer an update with the new estimate, options and escalation route */
    notifyCustomer: notImplemented,
    /** POST /exceptions/{id}/request-tracking: Ask the seller for valid tracking details by a deadline */
    requestTracking: notImplemented,
    /** POST /exceptions/{id}/escalate: Escalate to the Seller Manager, Support, Finance or Returns */
    escalateException: notImplemented,
    /** POST /exceptions/{id}/resolve: Record the resolution */
    resolveException: notImplemented,
    /** POST /exceptions/bulk: Remind sellers, assign an owner or escalate several exceptions */
    bulkExceptionAction: notImplemented,
    /** GET /claims: Carrier claims */
    listClaims: notImplemented,
    /** POST /claims: Open a carrier claim for a lost or damaged package */
    openClaim: notImplemented,
    /** POST /claims/{id}/status: Submit, record the carrier's decision or withdraw a claim */
    updateClaimStatus: notImplemented,
  });
};
