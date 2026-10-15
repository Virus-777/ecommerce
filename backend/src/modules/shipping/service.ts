import type { EventPayload } from '../../kernel/events/index.js';
import { isUuid } from '../../kernel/lib/ids.js';
import type * as common from '../../spec/common.js';
import type * as identity from '../../spec/identity.js';
import type {
  Closure,
  Coverage,
  CustomerNotice,
  DeliveryException,
  DeliveryQuote,
  DispatchInput,
  DispatchMetrics,
  ExceptionCounts,
  Label,
  LabelQuote,
  LabelRequest,
  LabelResult,
  OfferEstimate,
  PackageQuote,
  PackageQuoteInput,
  Parcel,
  SellerShippingSetup,
  Shipment,
  ShipmentSummary,
  ShippingPublicApi,
  TransitRange,
  CoverageCheck,
} from '../../spec/shipping.js';
import { OPEN_STATUSES } from './domain/exceptions.js';
import { Core, type ShippingServiceDeps } from './service/core.js';
import { Estimates } from './service/estimates.js';
import { Exceptions } from './service/exceptions.js';
import { Profiles } from './service/profiles.js';
import { Setup } from './service/setup.js';
import { Shipments } from './service/shipments.js';
import { Views } from './service/views.js';

export type { ShippingServiceDeps };

const toPage = (p: common.PageInput | undefined) => {
  const limit = Math.min(Math.max(p?.limit ?? 24, 1), 100);
  return p?.page ? ({ mode: 'page', page: p.page, limit } as const) : ({ mode: 'cursor', cursor: p?.cursor ?? null, limit } as const);
};

/**
 * Shipping use cases. Depends on its repository, the carrier port, the event bus, the clock and other modules' public APIs.
 * The work is split by area (service/*.ts); this class is the module's public API, its event consumers and jobs.
 */
export class ShippingService implements ShippingPublicApi {
  readonly core: Core;
  readonly views: Views;
  readonly estimates: Estimates;
  readonly setup: Setup;
  readonly profiles: Profiles;
  readonly shipments: Shipments;
  readonly exceptions: Exceptions;

  constructor(deps: ShippingServiceDeps) {
    this.core = new Core(deps);
    this.views = new Views(this.core);
    this.estimates = new Estimates(this.core);
    this.setup = new Setup(this.core, this.views, this.estimates);
    this.profiles = new Profiles(this.core, this.views, this.estimates);
    this.shipments = new Shipments(this.core, this.views, this.estimates, this.profiles);
    this.exceptions = new Exceptions(this.core, this.views, this.estimates);
    this.shipments.exceptions = this.exceptions;
    this.exceptions.shipments = this.shipments;
  }

  /* ---------------------------------------------------------------- public API (in-process) */

  quote(profileId: string, postalCode: string, parcel: Parcel, dispatch: DispatchInput, orderValue?: common.Money | null): Promise<DeliveryQuote> {
    return this.estimates.quote(profileId, postalCode, parcel, dispatch, orderValue);
  }

  quoteOptions(input: PackageQuoteInput): Promise<PackageQuote> {
    return this.estimates.quoteOptions(input);
  }

  checkCoverage(profileIds: string[], destination: common.Address): Promise<CoverageCheck[]> {
    return this.estimates.checkCoverage(profileIds, destination);
  }

  hasCoverage(sellerId: string): Promise<boolean> {
    return this.profiles.hasCoverage(sellerId);
  }

  dispatchDeadline(ownerType: 'official' | 'seller', sellerId: string | null, from: string, dispatch: DispatchInput): Promise<string> {
    return this.estimates.dispatchDeadline(ownerType, sellerId, from, dispatch);
  }

  activeNotices(postalCode?: string, carrierCodes?: string[], surface?: string): Promise<CustomerNotice[]> {
    return this.estimates.activeNotices(postalCode, carrierCodes, surface);
  }

  estimateLabelCost(input: LabelRequest): Promise<common.Money | null> {
    return this.shipments.estimateLabelCost(input);
  }

  quoteLabelOptions(input: LabelRequest): Promise<LabelQuote[]> {
    return this.shipments.quoteLabelOptions(input);
  }

  createLabel(input: LabelRequest, idempotencyKey: string): Promise<LabelResult> {
    return this.shipments.createLabel(input, idempotencyKey);
  }

  voidLabel(labelId: string, reason: string): Promise<Label> {
    return this.shipments.voidLabel(labelId, reason);
  }

  handOver(shipmentId: string, at: string, actor: common.Actor): Promise<Shipment> {
    return this.shipments.handOver(shipmentId, at, actor);
  }

  getShipmentsForOrder(orderId: string): Promise<ShipmentSummary[]> {
    return this.shipments.forOrder(orderId);
  }

  dispatchMetrics(sellerId: string | null, range: common.DateRange): Promise<DispatchMetrics> {
    return this.shipments.dispatchMetrics(sellerId, range);
  }

  registerReturnTracking(input: { returnId: string; orderId: string; groupId: string; carrierCode: string; trackingNumber: string; to: common.Address }): Promise<Shipment> {
    return this.shipments.registerReturnTracking(input);
  }

  findDropOffPoints(carrierServiceId: string, postalCode: string, limit?: number): Promise<{ name: string; address: common.Address; hours: string; distanceMiles: number; acceptsQr: boolean }[]> {
    return this.shipments.findDropOffPoints(carrierServiceId, postalCode, limit);
  }

  listShipmentsForGroups(groupIds: string[], kinds?: ('outbound' | 'replacement' | 'return')[]): Promise<Map<string, Shipment[]>> {
    return this.shipments.forGroups(groupIds, kinds?.length ? kinds : undefined);
  }

  getShipment(viewer: { customerId?: string; guestSessionId?: string; sellerId?: string; staff?: boolean }, shipmentId: string): Promise<Shipment | null> {
    return this.shipments.getForViewer(viewer, shipmentId);
  }

  /**
   * Default option per offer, resolved through offers' effective Offer.shipping (a Fulfilled by Marketly offer is quoted
   * with the service profile and dispatch, and that Official profile brings the Official schedule); without a postal
   * code the market default location
   */
  async estimateOffers(offerIds: string[], postalCode?: string, _viewer?: { customerId?: string; guestSessionId?: string }): Promise<OfferEstimate[]> {
    const ids = [...new Set(offerIds)].filter(isUuid).slice(0, 50);
    if (!ids.length) return [];
    const w = await this.estimates.world();
    const zip = postalCode?.trim() || w.cfg.marketDefaultPostalCode;
    const out: OfferEstimate[] = [];
    for (const offerId of ids) {
      const offer = await this.core.soft('offers', 'getOffer', (o) => o.getOffer(offerId));
      if (!offer || offer.status === 'removed') {
        out.push({ offerId, shipsToLocation: false, reason: 'This offer is not available', option: null, otherOptions: 0 });
        continue;
      }
      // offers that predate Offer.shipping carry only their own profile and dispatch
      const shipping = (offer as Partial<typeof offer>).shipping;
      const profileId = shipping?.profileId ?? offer.shippingProfileId;
      const dispatch = shipping?.dispatch ?? offer.dispatch;
      try {
        const q = await this.estimates.quote(profileId, zip, { weightGrams: 1000 }, { businessDays: dispatch.businessDays, sameDayCutoff: dispatch.sameDayCutoff ?? null, shipsFrom: dispatch.shipsFrom }, offer.price, w);
        out.push({ offerId, shipsToLocation: q.shipsToLocation, reason: q.reason ?? null, option: q.default ?? null, otherOptions: Math.max(0, q.options.length - 1) });
      } catch {
        out.push({ offerId, shipsToLocation: false, reason: 'Delivery options are not available for this offer', option: null, otherOptions: 0 });
      }
    }
    return out;
  }

  /** Open exception ids per order, oldest due first (orders' admin rows, G73) */
  async openExceptionIdsForOrders(orderIds: string[]): Promise<Record<string, string[]>> {
    const ids = [...new Set(orderIds.filter(isUuid))];
    const out: Record<string, string[]> = Object.fromEntries(orderIds.map((id) => [id, [] as string[]]));
    if (!ids.length) return out;
    const rows = await this.core.repo.find('exceptions', { order_id: ids, status: OPEN_STATUSES }, { orderBy: [['due_at', 'asc']] });
    for (const r of rows) out[r.order_id]!.push(r.id);
    return out;
  }

  listExceptionsForOrder(orderId: string, sellerId?: string): Promise<DeliveryException[]> {
    return this.exceptions.forOrder(orderId, sellerId);
  }

  listExceptions(filter: { kind?: string; status?: string; sellerType?: string; ownerStaffId?: string; customerNotNotified?: boolean; q?: string }, page: common.PageInput): Promise<common.Page<DeliveryException>> {
    return this.exceptions.listAdmin(filter, toPage(page));
  }

  countOpenExceptions(): Promise<ExceptionCounts> {
    return this.exceptions.counts();
  }

  getSellerShippingSummaries(sellerIds: string[]): Promise<
    Record<
      string,
      {
        shipsFrom: string | null;
        coverage: Coverage;
        coverageLabel: string;
        excluded: string[];
        handlingDays: number;
        sameDayCutoff: string | null;
        dispatchLabel: string;
        businessDays: string[];
        closures: Closure[];
        carriers: string[];
        methods: { name: string; transit: TransitRange; priceLabel: string }[];
        freeShippingThreshold: common.Money | null;
        freeShippingLabel: string | null;
        notices: CustomerNotice[];
      } | null
    >
  > {
    return this.profiles.summaries(sellerIds);
  }

  shipmentsForReplacements(replacements: { replacementId: string; returnId: string | null; orderItemIds?: string[] }[]): Promise<Record<string, Shipment | null>> {
    return this.shipments.forReplacements(replacements);
  }

  /** Owner of each shipping profile (lineage or version id); null when unknown. offers checks profile ownership with it */
  getProfileOwners(profileIds: string[]): Promise<Record<string, { ownerType: 'official' | 'seller'; sellerId: string | null; status: string } | null>> {
    return this.profiles.profileOwners(profileIds);
  }

  /** The Official Store's free-shipping threshold in force now (content's service strip warns when its text disagrees) */
  getOfficialFreeShipping(): Promise<{ threshold: common.Money | null; methodCode: string | null; active: boolean; label: string | null }> {
    return this.profiles.officialFreeShipping();
  }

  /** The Official Store's default active profile with the Official handling days and cutoff (fulfillment-service quotes service offers with it) */
  getOfficialDefaultProfile(): Promise<{ profileId: string; handlingDays: number; sameDayCutoff: string | null } | null> {
    return this.profiles.officialDefaultProfile();
  }

  getSellerShippingSetup(sellerId: string): Promise<SellerShippingSetup> {
    return this.profiles.setup(sellerId);
  }

  exportRows(dataset: string, filters: unknown, principal: identity.Principal, cursor?: string): Promise<{ rows: unknown[]; nextCursor?: string }> {
    return this.exceptions.exportRows(dataset, filters, principal, cursor);
  }

  /* ---------------------------------------------------------------- events consumed */

  onOrderAcceptedFromOrders(event: EventPayload<'orders.order.accepted'>): Promise<void> {
    return this.exceptions.onOrderAccepted(event);
  }

  onDispatchDeadlineChangedFromOrders(event: EventPayload<'orders.dispatch_deadline.changed'>): Promise<void> {
    return this.exceptions.onDeadlineChanged(event);
  }

  onItemCancelledFromOrders(event: EventPayload<'orders.item.cancelled'>): Promise<void> {
    return this.exceptions.onItemCancelled(event);
  }

  onPackagePackedFromWarehouse(event: EventPayload<'warehouse.package.packed'>): Promise<void> {
    return this.shipments.onPackagePacked(event);
  }

  onSellerRestrictedFromSellers(event: EventPayload<'sellers.seller.restricted'>): Promise<void> {
    return this.exceptions.onSellerRestricted(event);
  }

  onCaseOpenedFromSupport(event: EventPayload<'support.case.opened'>): Promise<void> {
    return this.exceptions.onCaseOpened(event);
  }

  onReplacementCreatedFromReturns(event: EventPayload<'returns.replacement.created'>): Promise<void> {
    return this.exceptions.onReplacementCreated(event);
  }

  onRefundSentFromPayments(event: EventPayload<'payments.refund.sent'>): Promise<void> {
    return this.exceptions.onRefundSent(event);
  }

  /* ---------------------------------------------------------------- jobs */

  detectLateDispatch(): Promise<void> {
    return this.exceptions.detectLateDispatch();
  }

  detectMissingTracking(): Promise<void> {
    return this.exceptions.detectMissingTracking();
  }

  detectStalled(): Promise<void> {
    return this.exceptions.detectStalled();
  }

  pollTracking(): Promise<void> {
    return this.shipments.pollTracking();
  }

  failedDeliveryDefault(): Promise<void> {
    return this.shipments.failedDeliveryDefault();
  }

  activateVersions(): Promise<void> {
    return this.profiles.activateVersions();
  }

  noticeSchedule(): Promise<void> {
    return this.setup.noticeSchedule();
  }

  carrierOnTime(): Promise<void> {
    return this.shipments.carrierOnTime();
  }

  /** Startup: reference data and the export dataset */
  async boot(): Promise<void> {
    await this.core.ensureSeeded().catch((err) => this.core.ctx.log.warn({ err }, 'shipping: reference data not seeded at boot'));
    await this.exceptions.registerDataset();
  }
}
