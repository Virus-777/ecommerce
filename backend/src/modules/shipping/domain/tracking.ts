/**
 * Carriers, tracking numbers and the one status model every carrier event is normalized to.
 * Missing tracking never implies delivery: until a carrier scan the customer reads 'Shipped, tracking pending'.
 */
import { shipmentMachine } from './state-machines.js';

export interface ServiceDef {
  code: string;
  name: string;
  transit: { min: number; max: number };
  labelSupported: boolean;
  trackingPattern: string | null;
  /** Speed class used by the dev rate table */
  speed: 'ground' | 'two_day' | 'overnight' | 'freight';
}

export interface CarrierDef {
  code: string;
  name: string;
  trackingUrl: string | null;
  services: ServiceDef[];
}

const UPS = '^1Z[0-9A-Z]{16}$';
const USPS = '^(9[1-5]\\d{20}|9[1-5]\\d{24}|[A-Z]{2}\\d{9}US)$';
const FEDEX = '^(\\d{12}|\\d{15}|\\d{20})$';
const ONTRAC = '^[CD]\\d{14}$';

/** Services each carrier offers (carriers added by staff get their code's services) */
export const CARRIER_CATALOG: Record<string, CarrierDef> = {
  ups: {
    code: 'ups',
    name: 'UPS',
    trackingUrl: 'https://www.ups.com/track?tracknum={n}',
    services: [
      { code: 'ground', name: 'UPS Ground', transit: { min: 1, max: 5 }, labelSupported: true, trackingPattern: UPS, speed: 'ground' },
      { code: '2nd_day_air', name: 'UPS 2nd Day Air', transit: { min: 2, max: 2 }, labelSupported: true, trackingPattern: UPS, speed: 'two_day' },
      { code: 'next_day_air', name: 'UPS Next Day Air', transit: { min: 1, max: 1 }, labelSupported: true, trackingPattern: UPS, speed: 'overnight' },
    ],
  },
  usps: {
    code: 'usps',
    name: 'USPS',
    trackingUrl: 'https://tools.usps.com/go/TrackConfirmAction?tLabels={n}',
    services: [
      { code: 'ground_advantage', name: 'USPS Ground Advantage', transit: { min: 2, max: 5 }, labelSupported: true, trackingPattern: USPS, speed: 'ground' },
      { code: 'priority', name: 'USPS Priority Mail', transit: { min: 1, max: 3 }, labelSupported: true, trackingPattern: USPS, speed: 'two_day' },
      { code: 'priority_express', name: 'USPS Priority Mail Express', transit: { min: 1, max: 2 }, labelSupported: true, trackingPattern: USPS, speed: 'overnight' },
    ],
  },
  fedex: {
    code: 'fedex',
    name: 'FedEx',
    trackingUrl: 'https://www.fedex.com/fedextrack/?trknbr={n}',
    services: [
      { code: 'ground', name: 'FedEx Ground', transit: { min: 1, max: 5 }, labelSupported: true, trackingPattern: FEDEX, speed: 'ground' },
      { code: '2day', name: 'FedEx 2Day', transit: { min: 2, max: 2 }, labelSupported: true, trackingPattern: FEDEX, speed: 'two_day' },
      { code: 'standard_overnight', name: 'FedEx Standard Overnight', transit: { min: 1, max: 1 }, labelSupported: true, trackingPattern: FEDEX, speed: 'overnight' },
      { code: 'freight', name: 'FedEx Freight', transit: { min: 3, max: 7 }, labelSupported: false, trackingPattern: null, speed: 'freight' },
    ],
  },
  ontrac: {
    code: 'ontrac',
    name: 'OnTrac',
    trackingUrl: 'https://www.ontrac.com/tracking/?number={n}',
    services: [{ code: 'ground', name: 'OnTrac Ground', transit: { min: 1, max: 3 }, labelSupported: false, trackingPattern: ONTRAC, speed: 'ground' }],
  },
  other: { code: 'other', name: 'Other carrier', trackingUrl: null, services: [{ code: 'standard', name: 'Other carrier', transit: { min: 2, max: 7 }, labelSupported: false, trackingPattern: null, speed: 'ground' }] },
};

/** Carriers every install has (decision G40a); seeded at start, so existing installs get new ones too */
export const DEFAULT_CARRIERS = ['ups', 'usps', 'fedex', 'ontrac', 'other'];

export const normalizeTracking = (s: string | null | undefined) => (s ?? '').replace(/[\s-]/g, '').toUpperCase();

export function trackingUrlOf(carrierCode: string | null | undefined, trackingNumber: string | null | undefined): string | null {
  const tpl = carrierCode ? CARRIER_CATALOG[carrierCode]?.trackingUrl : null;
  return tpl && trackingNumber ? tpl.replace('{n}', encodeURIComponent(trackingNumber)) : null;
}

/** Matches one of the patterns (none known: any non-empty number passes) */
export function formatOk(trackingNumber: string, patterns: readonly (string | null)[]): boolean {
  const known = patterns.filter((p): p is string => Boolean(p));
  if (!known.length) return trackingNumber.length >= 6;
  return known.some((p) => {
    try {
      return new RegExp(p).test(trackingNumber);
    } catch {
      return true;
    }
  });
}

/* ---------------------------------------------------------------- events and statuses */

export type TrackingCode = 'label_created' | 'accepted' | 'in_transit' | 'out_for_delivery' | 'delivered' | 'attempt_failed' | 'held_for_pickup' | 'returning' | 'returned' | 'exception' | 'info';
export type ShipmentStatus = 'label_created' | 'shipped' | 'in_transit' | 'out_for_delivery' | 'delivered' | 'delivery_failed' | 'held_for_pickup' | 'returning' | 'returned_to_sender' | 'lost' | 'cancelled';

export const TRACKING_CODES: TrackingCode[] = ['label_created', 'accepted', 'in_transit', 'out_for_delivery', 'delivered', 'attempt_failed', 'held_for_pickup', 'returning', 'returned', 'exception', 'info'];

/** Carrier wording → our codes (aggregators send many variants) */
export function normalizeCode(raw: unknown): TrackingCode {
  const s = String(raw ?? '').toLowerCase().replace(/[\s-]+/g, '_');
  if ((TRACKING_CODES as string[]).includes(s)) return s as TrackingCode;
  if (/^(pre_?transit|label|manifest)/.test(s)) return 'label_created';
  if (/(accept|picked_?up|origin_scan|acceptance)/.test(s)) return 'accepted';
  if (/out_for_delivery/.test(s)) return 'out_for_delivery';
  if (/^delivered|delivered$/.test(s)) return 'delivered';
  if (/(attempt|failed|undeliverable|no_access)/.test(s)) return 'attempt_failed';
  if (/(held|pickup_available|available_for_pickup)/.test(s)) return 'held_for_pickup';
  if (/(return_to_sender|returning)/.test(s)) return 'returning';
  if (/returned/.test(s)) return 'returned';
  if (/(transit|arrived|departed|processed)/.test(s)) return 'in_transit';
  if (/exception|damage|delay/.test(s)) return 'exception';
  return 'info';
}

export const EVENT_LABELS: Record<TrackingCode, string> = {
  label_created: 'Label created',
  accepted: 'Picked up by the carrier',
  in_transit: 'In transit',
  out_for_delivery: 'Out for delivery',
  delivered: 'Delivered',
  attempt_failed: 'Delivery attempt failed',
  held_for_pickup: 'Held for pickup',
  returning: 'Returning to sender',
  returned: 'Returned to sender',
  exception: 'Carrier exception',
  info: 'Update',
};

/** Machine events that take a shipment from its status to where a carrier code puts it (empty: nothing to change) */
const TARGET: Partial<Record<TrackingCode, ShipmentStatus>> = {
  accepted: 'shipped',
  in_transit: 'in_transit',
  out_for_delivery: 'out_for_delivery',
  delivered: 'delivered',
  attempt_failed: 'delivery_failed',
  held_for_pickup: 'held_for_pickup',
  returning: 'returning',
  returned: 'returned_to_sender',
};

/** Shortest list of machine events from a status to the status a code means (null: not reachable, keep the status) */
export function pathFor(from: ShipmentStatus, code: TrackingCode): { events: string[]; to: ShipmentStatus } | null {
  const target = TARGET[code];
  if (!target) return null;
  if (from === target) return { events: [], to: from };
  const seen = new Set<string>([from]);
  let frontier: { s: string; path: { event: string; to: string }[] }[] = [{ s: from, path: [] }];
  for (let depth = 0; depth < 4 && frontier.length; depth++) {
    const next: typeof frontier = [];
    for (const f of frontier) {
      for (const e of shipmentMachine.eventsFrom(f.s as never)) {
        // carriers never declare a package lost, and a staff void is not a carrier event
        if (e === 'declare_lost' || e === 'void_label') continue;
        for (const to of shipmentMachine.targets(f.s as never, e)) {
          const path = [...f.path, { event: e as string, to: to as string }];
          if (to === target) return { events: path.map((p) => p.event), to: target };
          if (!seen.has(to)) {
            seen.add(to);
            next.push({ s: to, path });
          }
        }
      }
    }
    frontier = next;
  }
  return null;
}

/** What the customer reads; never 'Delivered' without a carrier (or proven staff) delivery event */
export function statusLabel(status: string, trackingState: string, kind: string): string {
  switch (status) {
    case 'label_created':
      return kind === 'return' ? 'Return label created' : 'Label created, not shipped yet';
    case 'shipped':
      return trackingState === 'valid' ? 'Shipped' : 'Shipped, tracking pending';
    case 'in_transit':
      return 'In transit';
    case 'out_for_delivery':
      return 'Out for delivery';
    case 'delivered':
      return 'Delivered';
    case 'delivery_failed':
      return 'Delivery attempt failed';
    case 'held_for_pickup':
      return 'Held for pickup';
    case 'returning':
      return 'Returning to sender';
    case 'returned_to_sender':
      return 'Returned to sender';
    case 'lost':
      return 'Lost in transit';
    case 'cancelled':
      return 'Cancelled';
    default:
      return status;
  }
}

export const STEPS = ['Shipped', 'In transit', 'Out for delivery', 'Delivered'];

export function stepOf(status: string): number {
  switch (status) {
    case 'label_created':
    case 'shipped':
    case 'cancelled':
      return 0;
    case 'in_transit':
    case 'lost':
    case 'returning':
    case 'returned_to_sender':
      return 1;
    case 'out_for_delivery':
    case 'delivery_failed':
    case 'held_for_pickup':
      return 2;
    case 'delivered':
      return 3;
    default:
      return 0;
  }
}

/** Statuses where the package is with the carrier (stalled detection, lost declaration) */
export const MOVING: ShipmentStatus[] = ['shipped', 'in_transit', 'out_for_delivery'];
