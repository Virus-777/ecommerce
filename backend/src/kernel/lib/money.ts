/**
 * Money is integer minor units plus an ISO 4217 currency: { amount: 18900, currency: 'USD' } = $189.00.
 * Never floats (architecture §5, common.json Money).
 */
import type { Money } from '../../spec/common.js';
import { AppError } from '../errors/index.js';

export type { Money };

export function money(amount: number, currency = 'USD'): Money {
  if (!Number.isSafeInteger(amount)) throw new AppError('VALIDATION_FAILED', `Money amounts are integer minor units, got ${amount}`);
  return { amount, currency };
}

function assertSameCurrency(a: Money, b: Money) {
  if (a.currency !== b.currency) throw new AppError('VALIDATION_FAILED', `Currency mismatch: ${a.currency} vs ${b.currency}`);
}

export function add(a: Money, b: Money): Money {
  assertSameCurrency(a, b);
  return money(a.amount + b.amount, a.currency);
}

export function subtract(a: Money, b: Money): Money {
  assertSameCurrency(a, b);
  return money(a.amount - b.amount, a.currency);
}

export function compare(a: Money, b: Money): number {
  assertSameCurrency(a, b);
  return Math.sign(a.amount - b.amount);
}

export const sum = (items: Money[], currency = 'USD'): Money => items.reduce(add, money(0, currency));
export const isZero = (m: Money) => m.amount === 0;

/** Multiply by a rate (e.g. a 12.5% fee) and round half away from zero to a whole minor unit. */
export function multiply(m: Money, factor: number): Money {
  const exact = m.amount * factor;
  return money(Math.sign(exact) * Math.round(Math.abs(exact)), m.currency);
}

/** Split an amount into parts proportional to weights without losing a cent (largest remainder). */
export function allocate(m: Money, weights: number[]): Money[] {
  const total = weights.reduce((a, b) => a + b, 0);
  if (total <= 0) return weights.map(() => money(0, m.currency));
  const raw = weights.map((w) => (m.amount * w) / total);
  const parts = raw.map(Math.floor);
  let rest = m.amount - parts.reduce((a, b) => a + b, 0);
  const byRemainder = raw.map((r, i) => ({ i, frac: r - Math.floor(r) })).sort((a, b) => b.frac - a.frac);
  for (const { i } of byRemainder) {
    if (rest-- <= 0) break;
    parts[i]! += 1;
  }
  return parts.map((p) => money(p, m.currency));
}

/** Display in the market locale (en-US at launch), e.g. $189.00 */
export const format = (m: Money, locale = 'en-US') =>
  new Intl.NumberFormat(locale, { style: 'currency', currency: m.currency }).format(m.amount / 100);
