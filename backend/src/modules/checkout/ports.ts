/** The sales tax provider, the row types of the checkout collections and the shapes the repository (repository.ts) and the service share. */
import type { CheckoutDb } from '../../spec/checkout.js';
import type * as common from '../../spec/common.js';

/* ================================================================ sales tax provider */

/** One taxable line: the item amount after discounts, in minor units */
export interface TaxLineInput {
  lineId: string;
  /** Item amount after discounts (shipping is not taxed at launch) */
  amount: number;
  quantity: number;
  offerId: string;
  /** Product category, for providers with category rules */
  categoryId?: string | null;
}

/** Tax of one line with the rate and jurisdiction that produced it */
export interface TaxLineAmount {
  lineId: string;
  amount: number;
  rate: number;
  jurisdiction: string;
}

/** The tax shown at checkout for a destination: one summary line plus the amount per line */
export interface TaxCalculation {
  jurisdiction: string;
  label: string;
  rate: number;
  lines: TaxLineAmount[];
}

/**
 * Sales tax per line for a destination (spec integration "Sales tax rates": a rate table at launch, a tax
 * service later). null when there is no destination yet (the quote then shows "calculated once you enter a
 * delivery address"). Deterministic development provider: providers/tax.ts.
 */
export interface TaxProvider {
  calculate(input: { destination: common.Address | null; currency: string; lines: TaxLineInput[] }): Promise<TaxCalculation | null>;
}

export type SessionRow = CheckoutDb['sessions'];
export type LineRow = CheckoutDb['session_lines'];
export type PackageRow = CheckoutDb['session_packages'];
export type ChangeSetRow = CheckoutDb['change_sets'];
export type PlaceRequestRow = CheckoutDb['place_requests'];
export type LogRow = CheckoutDb['session_log'];

/** Whose checkout: a customer (customers' id) or a visitor (guest) session */
export type Owner = { customerId: string; guestSessionId?: undefined } | { guestSessionId: string; customerId?: undefined };

export interface Lock {
  forUpdate?: boolean;
}

export interface AdminSessionFilter {
  statuses?: string[];
  q?: string;
  from?: Date;
  to?: Date;
}
