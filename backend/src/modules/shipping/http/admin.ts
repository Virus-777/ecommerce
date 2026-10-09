import { AppError } from '../../../kernel/errors/index.js';
import { routes } from '../../../kernel/http/index.js';
import { endpoints } from '../../../spec/shipping.js';
import type { ShippingService } from '../service.js';

const OFFICIAL = { ownerType: 'official' as const, sellerId: null };

/**
 * Admin API: /api/admin/shipping/…  (docs/api/modules/shipping.md)
 * One handler per endpoint of this area in the spec; the compiler rejects missing or extra ones.
 */
export const adminRoutes = (service: ShippingService) =>
  routes(endpoints, 'admin', {
    /** GET /summary: Live notices, exception counts, overdue dispatch and Official Store on-time rate */
    getShippingSummary: async () => service.setup.summary(() => service.exceptions.counts()),
    /** GET /carriers: Carriers with services, tracking connection and on-time rate */
    listCarriers: async () => service.setup.listCarriers({ staff: true }),
    /** POST /carriers: Add a carrier account */
    createCarrier: async ({ body, actor, requestId, principal }) => service.setup.createCarrier(body, { actor, requestId, principal }),
    /** PATCH /carriers/{id}: Activate, deactivate or rename a carrier, or update its contacts */
    updateCarrier: async ({ params, body, actor, requestId, principal }) => service.setup.updateCarrier(params.id, body, { actor, requestId, principal }),
    /** PATCH /carriers/{id}/services/{serviceId}: Enable or disable a carrier service, set transit days */
    updateCarrierService: async ({ params, body, actor, requestId, principal }) => service.setup.updateCarrierService(params.id, params.serviceId, body, { actor, requestId, principal }),
    /** GET /methods: Platform shipping methods and their carrier services */
    listMethods: async () => service.setup.listMethods(false),
    /** PUT /methods/{id}: Change a method's name, customer label, transit or services */
    updateMethod: async ({ params, body, actor, requestId, principal }) => service.setup.updateMethod(params.id, body, { actor, requestId, principal }),
    /** GET /zones: Served zones and excluded areas */
    listZones: async () => service.setup.listZones(),
    /** POST /zones: Add a zone or excluded area */
    createZone: async ({ body, actor, requestId, principal }) => service.setup.createZone(body, { actor, requestId, principal }),
    /** PUT /zones/{id}: Change a zone, enable or disable it */
    updateZone: async ({ params, body, actor, requestId, principal }) => service.setup.updateZone(params.id, body, { actor, requestId, principal }),
    /** GET /profiles: Official Store and seller shipping profiles */
    listProfilesAdmin: async ({ query, page }) => service.profiles.listProfilesAdmin(query, page),
    /** POST /profiles: Create an Official Store shipping profile */
    createOfficialProfile: async ({ body, actor, requestId, principal }) => service.profiles.createProfile(OFFICIAL, body, { actor, requestId, principal }),
    /** PUT /profiles/{id}: Change Official Store rates (new version with an effective date) */
    updateOfficialProfile: async ({ params, body, actor, requestId, principal }) => {
      const versions = await service.profiles.owned(params.id, 'any');
      if (versions[0]!.owner_type !== 'official') throw new AppError('FORBIDDEN', 'Seller profiles are changed by the seller in Seller Center');
      if (!body.reason?.trim()) throw new AppError('VALIDATION_FAILED', 'Say why the rates change', { issues: [{ path: 'reason', message: 'Reason is required' }] });
      return service.profiles.updateProfile(params.id, OFFICIAL, body.profile, { actor, requestId, principal }, body.reason.trim());
    },
    /** GET /dispatch-targets: Official Store cutoff and default seller targets */
    getDispatchTargets: async () => service.setup.getTargets(),
    /** PUT /dispatch-targets: Change dispatch targets from an effective date */
    updateDispatchTargets: async ({ body, actor, requestId, principal }) => service.setup.updateTargets(body, { actor, requestId, principal }),
    /** GET /notices: Holiday calendar and service notices */
    listNotices: async ({ query, page }) => service.setup.listNotices(query, page),
    /** POST /notices: Draft a holiday or service-interruption notice */
    createNotice: async ({ body, actor, requestId, principal }) => service.setup.createNotice(body, { actor, requestId, principal }),
    /** POST /notices/preview: Preview a draft notice at checkout for a postal code: customer message and adjusted arrival estimates */
    previewNotice: async ({ body }) => service.setup.previewNotice(body),
    /** PATCH /notices/{id}: Edit a draft, scheduled or live notice */
    updateNotice: async ({ params, body, actor, requestId, principal }) => service.setup.updateNotice(params.id, body, { actor, requestId, principal }),
    /** POST /notices/{id}/publish: Publish now or schedule a notice */
    publishNotice: async ({ params, body, actor, requestId, principal }) => service.setup.publishNotice(params.id, body.mode, { actor, requestId, principal }),
    /** POST /notices/{id}/withdraw: Withdraw a notice */
    withdrawNotice: async ({ params, body, actor, requestId, principal }) => service.setup.withdrawNotice(params.id, body.reason, { actor, requestId, principal }),
    /** GET /free-shipping-rules: Free-shipping rules with who funds them */
    listFreeShippingRules: async () => service.setup.listRules(),
    /** POST /free-shipping-rules: Add a free-shipping rule */
    createFreeShippingRule: async ({ body, actor, requestId, principal }) => service.setup.createRule(body, { actor, requestId, principal }),
    /** PUT /free-shipping-rules/{id}: Change or end a free-shipping rule */
    updateFreeShippingRule: async ({ params, body, actor, requestId, principal }) => service.setup.updateRule(params.id, body, { actor, requestId, principal }),
    /** GET /shipments: All shipments */
    listShipmentsAdmin: async ({ query, page }) => service.shipments.listAdmin(query, page),
    /** GET /shipments/{id}: Shipment history: events, corrections, label and exceptions */
    getShipmentAdmin: async ({ params, principal }) => service.shipments.view(await service.shipments.load(params.id), principal),
    /** POST /shipments/{id}/correct-tracking: Correct carrier or tracking as staff */
    correctTrackingAdmin: async ({ params, body, actor, requestId, principal }) =>
      service.shipments.correct(params.id, { carrierCode: body.carrierCode ?? null, trackingNumber: body.trackingNumber, reason: body.reason, notifyCustomer: body.notifyCustomer }, { actor, requestId, principal }, { staff: true }),
    /** POST /shipments/{id}/events: Record a carrier status the integration missed (with evidence) */
    recordTrackingEventAdmin: async ({ params, body, actor, requestId, principal }) => service.shipments.recordEventAdmin(params.id, body, { actor, requestId, principal }),
    /** GET /exceptions: Dispatch and delivery exceptions by kind, with owner, deadline and whether the customer was notified */
    listExceptions: async ({ query, page }) => service.exceptions.listAdmin(query, page),
    /** GET /exceptions/counts: Open exceptions per kind (queue tiles) */
    getExceptionCounts: async () => service.exceptions.counts(),
    /** GET /exceptions/{id}: One exception with history */
    getException: async ({ params }) => service.exceptions.view(params.id),
    /** POST /exceptions: Open an exception manually (e.g. lost or damaged reported by phone) */
    openException: async ({ body, actor, requestId, principal }) => service.exceptions.openManual(body, { actor, requestId, principal }),
    /** POST /exceptions/{id}/assign: Set the owner */
    assignException: async ({ params, body, actor, requestId, principal }) => service.exceptions.assign(params.id, body.ownerStaffId, { actor, requestId, principal }),
    /** POST /exceptions/{id}/notify-seller: Remind the seller (late dispatch, missing tracking, failed delivery) */
    notifySeller: async ({ params, body, actor, requestId, principal }) => service.exceptions.notifySeller(params.id, body?.message ?? null, { actor, requestId, principal }),
    /** POST /exceptions/{id}/notify-customer: Send the customer an update with the new estimate, options and escalation route */
    notifyCustomer: async ({ params, body, actor, requestId, principal }) => service.exceptions.notifyCustomer(params.id, body?.message ?? null, { actor, requestId, principal }),
    /** POST /exceptions/{id}/request-tracking: Ask the seller for valid tracking details by a deadline */
    requestTracking: async ({ params, body, actor, requestId, principal }) => service.exceptions.requestTracking(params.id, body.dueAt, { actor, requestId, principal }),
    /** POST /exceptions/{id}/escalate: Escalate to the Seller Manager, Support, Finance or Returns */
    escalateException: async ({ params, body, actor, requestId, principal }) => service.exceptions.escalate(params.id, body.to, body.reason, { actor, requestId, principal }),
    /** POST /exceptions/{id}/resolve: Record the resolution */
    resolveException: async ({ params, body, actor, requestId, principal }) => service.exceptions.resolve(params.id, body, { actor, requestId, principal }),
    /** POST /exceptions/bulk: Remind sellers, assign an owner or escalate several exceptions */
    bulkExceptionAction: async ({ body, actor, requestId, principal }) => service.exceptions.bulk(body, { actor, requestId, principal }),
    /** GET /claims: Carrier claims */
    listClaims: async ({ query, page }) => service.exceptions.listClaims(query, page),
    /** POST /claims: Open a carrier claim for a lost or damaged package */
    openClaim: async ({ body, actor, requestId, principal }) => service.exceptions.openClaim(body, { actor, requestId, principal }),
    /** POST /claims/{id}/status: Submit, record the carrier's decision or withdraw a claim */
    updateClaimStatus: async ({ params, body, actor, requestId, principal }) => service.exceptions.claimStatus(params.id, body, { actor, requestId, principal }),
  });
