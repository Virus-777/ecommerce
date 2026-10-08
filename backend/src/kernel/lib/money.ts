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

const same = (a: Money, b: Money) => {
  if (a.currency !== b.currency) throw new AppError('VALIDATION_FAILED', `Currency mismatch: ${a.currency} vs ${b.currency}`);
};

export const add = (a: Money, b: Money): Money => (same(a, b), money(a.amount + b.amount, a.currency));
export const subtract = (a: Money, b: Money): Money => (same(a, b), money(a.amount - b.amount, a.currency));
export const sum = (items: Money[], currency = 'USD'): Money => items.reduce((acc, m) => add(acc, m), money(0, currency));
export const isZero = (m: Money) => m.amount === 0;
export const compare = (a: Money, b: Money) => (same(a, b), Math.sign(a.amount - b.amount));

/** Multiply by a rate (e.g. a 12.5% fee) and round half away from zero to a whole minor unit. */
export const multiply = (m: Money, factor: number): Money => money(Math.sign(m.amount * factor) * Math.round(Math.abs(m.amount * factor)), m.currency);

/** Split an amount into parts proportional to weights without losing a cent (largest remainder). */
export function allocate(m: Money, weights: number[]): Money[] {
  const total = weights.reduce((a, b) => a + b, 0);
  if (total <= 0) return weights.map(() => money(0, m.currency));
  const raw = weights.map((w) => (m.amount * w) / total);
  const parts = raw.map(Math.floor);
  let rest = m.amount - parts.reduce((a, b) => a + b, 0);
  const order = raw.map((r, i) => [r - Math.floor(r), i] as const).sort((a, b) => b[0] - a[0]);
  for (const [, i] of order) {
    if (rest <= 0) break;
    parts[i]! += 1;
    rest -= 1;
  }
  return parts.map((p) => money(p, m.currency));
}

/** Display in the market locale (en-US at launch), e.g. $189.00 */
export const format = (m: Money, locale = 'en-US') =>
  new Intl.NumberFormat(locale, { style: 'currency', currency: m.currency }).format(m.amount / 100);
