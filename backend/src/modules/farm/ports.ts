import type { GeoPoint } from '../../kernel/lib/geo.js';
import type * as common from '../../spec/common.js';
import type { FarmDb } from '../../spec/farm.js';

/** Rows of the farm collections (spec tables) */
export type DealerRow = FarmDb['dealers'];
export type OrderRow = FarmDb['orders'];

/** The dealer as it was when the order was placed (orders.dealer) */
export interface DealerSnapshot {
  name: string;
  line1: string;
  city: string;
  point: GeoPoint | null;
  hours: string;
  phone: string;
  messagePhone: string | null;
  messageEmail: string | null;
}

/** The machine as ordered (orders.machine) */
export interface StoredMachine {
  productId: string;
  slug: string | null;
  title: string;
  image: common.MediaRef | null;
  highlights: string[];
  price: number;
}

/** An attachment as ordered (orders.attachments) */
export interface StoredAttachment {
  productId: string;
  title: string;
  image: common.MediaRef | null;
  price: number;
}

/** The farm location as ordered (orders.location) */
export interface StoredLocation {
  name: string | null;
  line1: string;
  line2: string | null;
  city: string;
  region: string;
  postalCode: string | null;
  country: string;
  point: GeoPoint | null;
  pinned: boolean;
}

/** A history entry as stored (orders.history); `by` is shown to staff only */
export interface StoredChange {
  status: string;
  at: string;
  by: string | null;
  note: string | null;
}
