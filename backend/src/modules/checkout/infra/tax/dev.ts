/**
 * Development and launch tax adapter: the state base sales-tax rate table (domain/rules.ts), applied to each
 * line's item amount after discounts, rounded half away from zero to a cent. No network, deterministic.
 * A tax service adapter replaces it behind the same TaxProvider port.
 */
import { taxFor, taxOf } from '../../domain/rules.js';
import type { TaxProvider } from '../../ports.js';

export function createDevTaxProvider(): TaxProvider {
  return {
    async calculate({ destination, lines }) {
      const tax = taxFor(destination);
      if (!tax) return null;
      return {
        ...tax,
        lines: lines.map((l) => ({ lineId: l.lineId, amount: taxOf(l.amount, tax.rate), rate: tax.rate, jurisdiction: tax.jurisdiction })),
      };
    },
  };
}
