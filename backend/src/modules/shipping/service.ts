import { notImplemented } from '../../kernel/errors/index.js';
import type { EventPayload } from '../../kernel/events/index.js';
import type { ModuleContext } from '../../kernel/module-system/index.js';
import type * as common from '../../spec/common.js';
import type * as identity from '../../spec/identity.js';
import type { ShippingPublicApi, Parcel, TransitRange, DispatchInput, Carrier, Coverage, Closure, CustomerNotice, DeliveryQuote, PackageQuoteInput, PackageQuote, CoverageCheck, OfferEstimate, Label, LabelQuote, LabelRequest, LabelResult, Shipment, ShipmentSummary, DeliveryException, ExceptionCounts, DispatchMetrics, SellerShippingSetup } from '../../spec/shipping.js';
import type { ShippingRepository } from './ports.js';

export interface ShippingServiceDeps {
  repo: ShippingRepository;
  ctx: ModuleContext<'shipping'>;
}

/**
 * Shipping use cases. Depends only on ports, the event bus, the clock and other modules' public APIs.
 * Each method maps to a publicApi function, a consumed event or a job in docs/api/spec/modules/shipping.json.
 */
export class ShippingService implements ShippingPublicApi {
  readonly #deps: ShippingServiceDeps;

  constructor(deps: ShippingServiceDeps) {
    this.#deps = deps;
  }

  protected get deps(): ShippingServiceDeps {
    return this.#deps;
  }

  /* ---------------- public API (in-process) */

  /** Delivery options for one offer at a location: ships-to check, price per method, arrival range, dispatch label, cutoff countdown and service notices */
  async quote(profileId: string, postalCode: string, parcel: Parcel, dispatch: DispatchInput): Promise<DeliveryQuote> {
    throw notImplemented('shipping.quote');
  }

  /** Options for a package of several items from one seller and ship-from location: methods common to every item's profile, combined weight, free-shipping threshold on the package subtotal, arrival per option */
  async quoteOptions(input: PackageQuoteInput): Promise<PackageQuote> {
    throw notImplemented('shipping.quoteOptions');
  }

  /** Per profile: ships to this address or why not (excluded area, PO box, outside seller coverage) */
  async checkCoverage(profileIds: string[], destination: common.Address): Promise<CoverageCheck[]> {
    throw notImplemented('shipping.checkCoverage');
  }

  /** Seller has an active profile with coverage and a dispatch schedule (setup checklist) */
  async hasCoverage(sellerId: string): Promise<boolean> {
    throw notImplemented('shipping.hasCoverage');
  }

  /** Dispatch deadline from acceptance time, handling days, same-day cutoff, business days and closures */
  async dispatchDeadline(ownerType: 'official'|'seller', sellerId: string | null, from: string, dispatch: DispatchInput): Promise<string> {
    throw notImplemented('shipping.dispatchDeadline');
  }

  /** Live service notices for a location */
  async activeNotices(postalCode?: string, carrierCodes?: string[], surface?: string): Promise<CustomerNotice[]> {
    throw notImplemented('shipping.activeNotices');
  }

  /** Carrier services that can carry this parcel to the destination, with cost, estimated arrival and keepsPromise against the customer's promised range (same rule createLabel enforces with keepPromise) */
  async quoteLabelOptions(input: LabelRequest): Promise<LabelQuote[]> {
    throw notImplemented('shipping.quoteLabelOptions');
  }

  /** Buy a carrier label and create the shipment (label_created). kind = return creates the return parcel for returns (labelMethod prepaid_qr adds a QR drop-off code; dropOffBy from the return); its tracking events carry kind = return and returnId. Same key returns the same label. */
  async createLabel(input: LabelRequest, idempotencyKey: string): Promise<LabelResult> {
    throw notImplemented('shipping.createLabel');
  }

  /** Void an unused label (before the first carrier scan) */
  async voidLabel(labelId: string, reason: string): Promise<Label> {
    throw notImplemented('shipping.voidLabel');
  }

  /** Package handed to the carrier (label_created → shipped). Publishes shipping.shipment.dispatched. */
  async handOver(shipmentId: string, at: string, actor: common.Actor): Promise<Shipment> {
    throw notImplemented('shipping.handOver');
  }

  /** Shipments of an order with status and contents */
  async getShipmentsForOrder(orderId: string): Promise<ShipmentSummary[]> {
    throw notImplemented('shipping.getShipmentsForOrder');
  }

  /** On-time dispatch, valid tracking and late counts */
  async dispatchMetrics(sellerId: string | null, range: common.DateRange): Promise<DispatchMetrics> {
    throw notImplemented('shipping.dispatchMetrics');
  }

  /** Customer-arranged return: create a kind = return shipment for a tracking number the customer entered (format-checked) so carrier events for it are tracked and published like a prepaid return label. */
  async registerReturnTracking(input: { returnId: string, orderId: string, groupId: string, carrierCode: string, trackingNumber: string, to: common.Address }): Promise<Shipment> {
    throw notImplemented('shipping.registerReturnTracking');
  }

  /** Carrier drop-off locations near a ZIP code for return labels. */
  async findDropOffPoints(carrierServiceId: string, postalCode: string, limit?: number): Promise<{ name: string, address: common.Address, hours: string, distanceMiles: number, acceptsQr: boolean }[]> {
    throw notImplemented('shipping.findDropOffPoints');
  }

  /** Shipments per seller group with contents, tracking events and failed-delivery options (batched per request). Default kinds: outbound and replacement. */
  async listShipmentsForGroups(groupIds: string[], kinds?: ('outbound'|'replacement'|'return')[]): Promise<Map<string, Shipment[]>> {
    throw notImplemented('shipping.listShipmentsForGroups');
  }

  /** One package with tracking view fields (headline, steps, estimate note, notices). Store: the customer's or guest's own order; seller: own shipments; staff: any (shipping.shipments.view). Otherwise null. */
  async getShipment(viewer: { customerId?: string, guestSessionId?: string, sellerId?: string, staff?: boolean }, shipmentId: string): Promise<Shipment | null> {
    throw notImplemented('shipping.getShipment');
  }

  /** Default delivery option per offer at a location (resolves offer → profile and dispatch through offers). Without a postal code uses the shopper's saved or cart location, else the market default; batched per request. */
  async estimateOffers(offerIds: string[], postalCode?: string, viewer?: { customerId?: string, guestSessionId?: string }): Promise<OfferEstimate[]> {
    throw notImplemented('shipping.estimateOffers');
  }

  /** Delivery exceptions on an order; with sellerId only that seller's groups */
  async listExceptionsForOrder(orderId: string, sellerId?: string): Promise<DeliveryException[]> {
    throw notImplemented('shipping.listExceptionsForOrder');
  }

  /** Dispatch and delivery exceptions for staff (same filters as admin GET /exceptions) */
  async listExceptions(filter: { kind?: string, status?: string, sellerType?: string, ownerStaffId?: string, customerNotNotified?: boolean, q?: string }, page: common.PageInput): Promise<common.Page<DeliveryException>> {
    throw notImplemented('shipping.listExceptions');
  }

  /** Open exceptions per kind and not-yet-notified customers (queue tiles) */
  async countOpenExceptions(): Promise<ExceptionCounts> {
    throw notImplemented('shipping.countOpenExceptions');
  }

  /** Storefront shipping section from the seller's active shipping settings and default profile (the REST storefront's shipping block): ships from, coverage and exclusions, dispatch time and same-day cutoff, carriers, methods with transit, free-shipping threshold, upcoming closures and live notices. Null when the seller has no active profile. */
  async getSellerShippingSummaries(sellerIds: string[]): Promise<Record<string, { shipsFrom: string | null, coverage: Coverage, coverageLabel: string, excluded: string[], handlingDays: number, sameDayCutoff: string | null, dispatchLabel: string, businessDays: string[], closures: Closure[], carriers: string[], methods: { name: string, transit: TransitRange, priceLabel: string }[], freeShippingThreshold: common.Money | null, freeShippingLabel: string | null, notices: CustomerNotice[] } | null>> {
    throw notImplemented('shipping.getSellerShippingSummaries');
  }

  /** The REPLACEMENT shipment sent for a return's replacement or exchange (shipments.kind = replacement, matched by return id) */
  async shipmentsForReplacements(replacements: { replacementId: string, returnId: string }[]): Promise<Record<string, Shipment | null>> {
    throw notImplemented('shipping.shipmentsForReplacements');
  }

  /** Carriers and services the seller can use, whether labels can be bought and the default package, for the record-shipment form */
  async getSellerShippingSetup(sellerId: string): Promise<SellerShippingSetup> {
    throw notImplemented('shipping.getSellerShippingSetup');
  }

  /** Export rows for reports dataset shipping.admin.exceptions (delivery exceptions) */
  async exportRows(dataset: string, filters: unknown, principal: identity.Principal, cursor?: string): Promise<{ rows: unknown[], nextCursor?: string }> {
    throw notImplemented('shipping.exportRows');
  }

  /* ---------------- events consumed */

  /** orders.order.accepted: Add each group to the dispatch watch; if acceptance came later than placement, recalculate the deadline and call orders.setDispatchDeadline */
  async onOrderAcceptedFromOrders(event: EventPayload<"orders.order.accepted">): Promise<void> {
    void event;
    throw notImplemented('shipping consumer of orders.order.accepted');
  }

  /** orders.dispatch_deadline.changed: Move the watched deadline (the original stays on record for performance) */
  async onDispatchDeadlineChangedFromOrders(event: EventPayload<"orders.dispatch_deadline.changed">): Promise<void> {
    void event;
    throw notImplemented('shipping consumer of orders.dispatch_deadline.changed');
  }

  /** orders.item.cancelled: Remove items from the watch; open (or update) a seller_cannot_fulfill exception when the seller cancelled; close dispatch exceptions when nothing is left to ship; void unused labels */
  async onItemCancelledFromOrders(event: EventPayload<"orders.item.cancelled">): Promise<void> {
    void event;
    throw notImplemented('shipping consumer of orders.item.cancelled');
  }

  /** warehouse.package.packed: Official Store package handed to the carrier pickup (handOver) */
  async onPackagePackedFromWarehouse(event: EventPayload<"warehouse.package.packed">): Promise<void> {
    void event;
    throw notImplemented('shipping consumer of warehouse.package.packed');
  }

  /** sellers.seller.restricted: Mark open exceptions of the seller for escalation to the Seller Manager */
  async onSellerRestrictedFromSellers(event: EventPayload<"sellers.seller.restricted">): Promise<void> {
    void event;
    throw notImplemented('shipping consumer of sellers.seller.restricted');
  }

  /** support.case.opened: Open a lost_or_damaged exception for missing or damaged package reports when none is open */
  async onCaseOpenedFromSupport(event: EventPayload<"support.case.opened">): Promise<void> {
    void event;
    throw notImplemented('shipping consumer of support.case.opened');
  }

  /** returns.replacement.created: Watch the replacement's dispatch like an original shipment */
  async onReplacementCreatedFromReturns(event: EventPayload<"returns.replacement.created">): Promise<void> {
    void event;
    throw notImplemented('shipping consumer of returns.replacement.created');
  }

  /** payments.refund.sent: Close seller_cannot_fulfill exceptions whose refund was sent */
  async onRefundSentFromPayments(event: EventPayload<"payments.refund.sent">): Promise<void> {
    void event;
    throw notImplemented('shipping consumer of payments.refund.sent');
  }

  /* ---------------- jobs */

  /** Job shipping.detect-late-dispatch (every 5 min): Groups past their dispatch deadline with unshipped items: open a late_dispatch exception, notify the seller and publish shipping.dispatch.overdue (once per group per deadline) */
  async detectLateDispatch(): Promise<void> {
    throw notImplemented('job shipping.detect-late-dispatch');
  }

  /** Job shipping.detect-missing-tracking (every 15 min): Shipments without tracking, with an invalid number, or a label without a carrier scan after labelScanGraceHours: open missing_tracking */
  async detectMissingTracking(): Promise<void> {
    throw notImplemented('job shipping.detect-missing-tracking');
  }

  /** Job shipping.detect-stalled (daily 07:00 PT): Shipments with no carrier scan for stalledNoScanDays: open lost_or_damaged for review */
  async detectStalled(): Promise<void> {
    throw notImplemented('job shipping.detect-stalled');
  }

  /** Job shipping.poll-tracking (every 30 min): Poll carriers in polling mode and unknown webhook numbers */
  async pollTracking(): Promise<void> {
    throw notImplemented('job shipping.poll-tracking');
  }

  /** Job shipping.failed-delivery-default (hourly): Failed deliveries past chooseBy without a choice follow the default (return to seller) and notify customer and seller */
  async failedDeliveryDefault(): Promise<void> {
    throw notImplemented('job shipping.failed-delivery-default');
  }

  /** Job shipping.activate-versions (every 5 min): Activate scheduled profile and settings versions; supersede the previous ones */
  async activateVersions(): Promise<void> {
    throw notImplemented('job shipping.activate-versions');
  }

  /** Job shipping.notice-schedule (every 5 min): Move notices scheduled → live at showFrom and live → ended after the to date */
  async noticeSchedule(): Promise<void> {
    throw notImplemented('job shipping.notice-schedule');
  }

  /** Job shipping.carrier-on-time (daily 04:00 PT): Compute 30-day on-time rates per carrier and the Official Store dispatch rate */
  async carrierOnTime(): Promise<void> {
    throw notImplemented('job shipping.carrier-on-time');
  }
}
