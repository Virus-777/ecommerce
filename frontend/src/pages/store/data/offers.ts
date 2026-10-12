// Sample data for the All offers page (design: pages/store/store-offers*.html).
// Base offers come from the shared fixtures (auroraOffers); this adds what the comparison shows.
import { auroraOffers, type Offer } from '@marketly/web-shared/data/fixtures';
import type { IconName } from '@marketly/web-shared/ui';

export type ConditionGroup = 'New' | 'Used' | 'Refurbished';

export interface OfferRow extends Offer {
  /** Condition filter bucket ("Used – Like new" -> Used). */
  group: ConditionGroup;
  /** Delivery window shown to the shopper. */
  window: string;
  /** Earliest arrival as an ISO date: the "Fastest delivery" sort key. */
  arrives: string;
  carrier: string;
  onTime: number;
  /** Accessory/completeness note under the condition. */
  kit?: { warn?: boolean; icon: IconName; text: string };
  /** Why the offer can't be the featured offer. */
  ineligible?: string;
}

const EXTRA: Record<string, Omit<OfferRow, keyof Offer | 'group'>> = {
  official: { window: 'Thu, Oct 15', arrives: '2026-10-15', carrier: 'UPS Ground', onTime: 99 },
  northwind: { window: 'Fri, Oct 16 – Mon, Oct 19', arrives: '2026-10-16', carrier: 'USPS Ground Advantage', onTime: 97 },
  pixelport: {
    window: 'Mon, Oct 19 – Tue, Oct 20',
    arrives: '2026-10-19',
    carrier: 'FedEx Ground',
    onTime: 95,
    kit: { icon: 'package-check', text: 'Complete: all accessories' },
  },
  gadgetgrove: {
    window: 'Tue, Oct 20 – Fri, Oct 23',
    arrives: '2026-10-20',
    carrier: 'USPS Ground Advantage',
    onTime: 81,
    kit: { warn: true, icon: 'package-x', text: 'Missing: carry case' },
    ineligible: 'Not eligible for featured offer: delivery performance under review',
  },
};

const group = (condition: string): ConditionGroup => (condition.startsWith('Used') ? 'Used' : condition.startsWith('Refurbished') ? 'Refurbished' : 'New');

export const offerRows: OfferRow[] = auroraOffers.map((o) => ({ ...o, group: group(o.condition), ...EXTRA[o.seller] }));

export const total = (o: Offer) => Math.round((o.price + o.ship) * 100) / 100;
