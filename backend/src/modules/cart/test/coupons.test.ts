import { describe, expect, it } from 'vitest';
import { couponNotCovered } from '../domain/coupons.js';

const USD = (amount: number) => ({ amount, currency: 'USD' });
const priced = (lineId: string, regular: number, unit: number) => ({ lineId, regularUnitPrice: USD(regular), unitPrice: USD(unit), allocations: [], lineDiscount: USD(0), limitExceeded: false, discountedQuantity: 1 });

describe('coupon "not covered" reasons (shared by cart and checkout, G15c)', () => {
  const lines = [
    { lineId: 'a', title: 'Headphones' },
    { lineId: 'b', title: 'Speaker' },
    { lineId: 'c', title: 'Cable' },
  ];
  const evaluation = { lines: [priced('a', 6000, 6000), priced('b', 3000, 2500), priced('c', 900, 900)] };

  it('names the lines left out: on sale, or not included', () => {
    expect(couponNotCovered(['a'], lines, evaluation)).toEqual([
      { lineId: 'b', title: 'Speaker', reason: 'Already on sale' },
      { lineId: 'c', title: 'Cable', reason: 'Not included in this coupon' },
    ]);
  });

  it('leaves nothing out for a coupon that covers no line (shipping or order level)', () => {
    expect(couponNotCovered([], lines, evaluation)).toEqual([]);
  });
});
