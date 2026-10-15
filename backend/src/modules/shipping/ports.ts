/**
 * Row types of the shipping collections (typed json fields; the repository is repository.ts) and the carrier
 * interface, CarrierPort (the dev carrier is providers/carriers.ts).
 */
import type * as common from '../../spec/common.js';
import type {
  CarrierContact,
  Coverage,
  ExceptionResolution,
  FailedDeliveryInfo,
  NoticeEffect,
  OfficialDispatchTarget,
  Parcel,
  ProfileMethod,
  SellerDispatchTarget,
  SellerResponse,
  ShippingDb,
  TransitRange,
} from '../../spec/shipping.js';

type Db = ShippingDb;

export interface CarrierRec extends Omit<Db['carriers'], 'contacts'> {
  contacts: CarrierContact[];
}
export type ServiceRec = Db['carrier_services'];
export interface MethodRec extends Omit<Db['methods'], 'carrier_service_ids'> {
  carrier_service_ids: string[];
}
export interface ZoneRec extends Omit<Db['zones'], 'regions' | 'postal_prefixes' | 'address_kinds' | 'transit_by_method'> {
  regions: string[];
  postal_prefixes: string[];
  address_kinds: string[];
  transit_by_method: Record<string, TransitRange>;
}
export interface ProfileRec extends Omit<Db['profiles'], 'methods' | 'updated_by'> {
  methods: ProfileMethod[];
  updated_by: common.Actor;
}
export interface SettingsRec extends Omit<Db['seller_settings'], 'coverage' | 'business_days' | 'updated_by' | 'default_parcel'> {
  coverage: Coverage;
  business_days: string[];
  updated_by: common.Actor;
  default_parcel: Parcel | null;
}
export type ClosureRec = Db['closures'];
export interface TargetsRec extends Omit<Db['dispatch_targets'], 'official' | 'seller_default' | 'set_by'> {
  official: OfficialDispatchTarget;
  seller_default: SellerDispatchTarget;
  set_by: common.Actor;
}
export interface NoticeRec extends Omit<Db['notices'], 'carrier_codes' | 'regions' | 'effect' | 'surfaces' | 'created_by'> {
  carrier_codes: string[];
  regions: string[];
  effect: NoticeEffect;
  surfaces: string[];
  created_by: common.Actor;
}
export type RuleRec = Db['free_shipping_rules'];
export interface ShipmentRec extends Omit<Db['shipments'], 'to_address' | 'estimated_arrival' | 'failed_delivery' | 'recorded_by'> {
  to_address: Partial<common.Address>;
  estimated_arrival: common.DateRange | null;
  failed_delivery: FailedDeliveryInfo | null;
  recorded_by: common.Actor;
}
export type LineRec = Db['shipment_lines'];
export type EventRec = Db['tracking_events'];
export interface CorrectionRec extends Omit<Db['tracking_corrections'], 'by'> {
  by: common.Actor;
}
export interface LabelRec extends Omit<Db['labels'], 'purchased_by'> {
  purchased_by: common.Actor;
}
export interface QuoteRec extends Omit<Db['label_quotes'], 'parcel' | 'estimated_arrival'> {
  parcel: Parcel;
  estimated_arrival: common.DateRange;
}
export interface WatchRec extends Omit<Db['dispatch_watch'], 'open_item_ids'> {
  open_item_ids: string[];
}
export interface ExceptionRec extends Omit<Db['exceptions'], 'seller_response' | 'resolution' | 'opened_by'> {
  seller_response: SellerResponse | null;
  resolution: ExceptionResolution | null;
  opened_by: common.Actor;
}
export interface ExceptionLogRec extends Omit<Db['exception_log'], 'actor'> {
  actor: common.Actor;
}
export interface ClaimRec extends Omit<Db['claims'], 'evidence_ids'> {
  evidence_ids: string[];
}
export interface WebhookRec extends Omit<Db['webhook_events'], 'payload'> {
  payload: unknown;
}

export interface Recs {
  carriers: CarrierRec;
  carrier_services: ServiceRec;
  methods: MethodRec;
  zones: ZoneRec;
  profiles: ProfileRec;
  seller_settings: SettingsRec;
  closures: ClosureRec;
  dispatch_targets: TargetsRec;
  notices: NoticeRec;
  free_shipping_rules: RuleRec;
  shipments: ShipmentRec;
  shipment_lines: LineRec;
  tracking_events: EventRec;
  tracking_corrections: CorrectionRec;
  labels: LabelRec;
  label_quotes: QuoteRec;
  dispatch_watch: WatchRec;
  exceptions: ExceptionRec;
  exception_log: ExceptionLogRec;
  claims: ClaimRec;
  webhook_events: WebhookRec;
}
/** The shipping collections (spec tables) */
export type TableName = keyof Recs;

/* ---------------------------------------------------------------- carriers */

export interface CarrierScan {
  /** Carrier's event id (deduplication) */
  id: string;
  trackingNumber: string;
  code: string;
  at: string;
  description?: string | null;
  location?: string | null;
}

/** The carrier answered and refused (e.g. over its weight limit): LABEL_FAILED 422 */
export class CarrierRefused extends Error {
  constructor(readonly carrierMessage: string) {
    super(carrierMessage);
  }
}

/** The carrier could not be reached or did not answer: LABEL_FAILED 502 (decision G42) */
export class CarrierUnreachable extends Error {
  constructor(readonly carrierMessage: string) {
    super(carrierMessage);
  }
}

/**
 * A carrier or multi-carrier aggregator. Production adapters call UPS, USPS and FedEx (or an aggregator);
 * the dev adapter answers deterministically without a network.
 */
export interface CarrierPort {
  /** Label price for a parcel (minor units); throws CarrierRefused when the carrier will not carry it */
  rate(input: { carrierCode: string; serviceCode: string; speed: string; parcel: Parcel; fromPostalCode: string | null; toPostalCode: string; currency: string }): Promise<common.Money>;
  /** Buys a label; throws CarrierRefused when the carrier refuses, CarrierUnreachable when it does not answer (nothing charged) */
  buyLabel(input: {
    carrierCode: string;
    carrierName: string;
    serviceCode: string;
    serviceName: string;
    parcel: Parcel;
    from: Partial<common.Address> | null;
    to: Partial<common.Address>;
    reference: string;
    qr: boolean;
    /** Label file format (default pdf; warehouse thermal printers ask for zpl) */
    format?: 'pdf' | 'zpl';
  }): Promise<{ trackingNumber: string; pdf: Uint8Array; qrCode: string | null }>;
  /** Voids an unused label (the carrier refunds it) */
  voidLabel(input: { carrierCode: string; trackingNumber: string }): Promise<{ refunded: boolean }>;
  /** Polls a tracking number (polling-mode carriers and webhook numbers not matched yet) */
  track(input: { carrierCode: string; trackingNumber: string; shippedAt: Date | null; now: Date }): Promise<CarrierScan[]>;
  /** Drop-off locations near a ZIP code */
  dropOffPoints(input: { carrierCode: string; carrierName: string; postalCode: string; limit: number; qr: boolean }): Promise<{ name: string; address: common.Address; hours: string; distanceMiles: number; acceptsQr: boolean }[]>;
  /** Webhook body → scans (aggregator format: { events: [...] } or one event) */
  parseWebhook(carrierCode: string, body: unknown, headerEventId?: string): CarrierScan[];
}
