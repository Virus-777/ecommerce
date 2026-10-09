import { describe, expect, it } from 'vitest';
import { newId } from '../../../kernel/lib/ids.js';
import { evaluate, type CouponCandidate, type EvalInput, type EvalLine } from '../domain/evaluate.js';
import { allocateByValue, discountLabel, earningsImpact, fundingLabel, periodDisplay, splitFunding, type CampaignModel } from '../domain/rules.js';

const now = new Date('2026-10-09T18:00:00Z');
const HOME = newId();

function campaign(over: Partial<CampaignModel> = {}): CampaignModel {
  return {
    id: newId(),
    ref: 'PRM-261009-0001',
    name: 'Fall Home Week',
    description: null,
    ownerKind: 'platform',
    sellerId: null,
    kind: 'percent_coupon',
    discount: { kind: 'percent_coupon', percentOffBps: 2000 },
    code: null,
    autoApply: true,
    startsAt: new Date(now.getTime() - 3_600_000),
    endsAt: new Date(now.getTime() + 86_400_000),
    timeZone: 'America/Los_Angeles',
    scope: { mode: 'sitewide', include: [], exclude: [] },
    eligibility: { audience: 'everyone' },
    limits: {},
    funding: { owner: 'platform' },
    stacking: { withSellerMarkdowns: true, withOtherCoupons: true, withFreeShipping: true, withFlashSalePrices: false },
    participation: null,
    deals: null,
    terms: null,
    status: 'live',
    budgetUsed: 0,
    usageCount: 0,
    currency: 'USD',
    ...over,
  };
}

const sellerA = newId();
const sellerB = newId();
function cartLine(price: number, qty: number, o: { seller?: string; official?: boolean; pkg?: string; category?: string } = {}): EvalLine {
  const offerId = newId();
  const sellerId = o.seller ?? sellerA;
  return {
    lineId: `L${offerId.slice(-4)}`,
    offerId,
    productId: newId(),
    variantId: newId(),
    sellerId,
    officialStore: o.official ?? false,
    categoryId: o.category ?? HOME,
    quantity: qty,
    unitPrice: { amount: price, currency: 'USD' },
    packageId: o.pkg ?? `P-${sellerId}`,
    attrs: { offerId, productId: newId(), sellerId, official: o.official ?? false, categoryIds: [o.category ?? HOME], brandId: null },
  };
}

function input(lines: EvalLine[], coupons: CouponCandidate[], over: Partial<EvalInput> = {}): EvalInput {
  return { at: now, currency: 'USD', customerId: newId(), signedIn: true, isNewCustomer: null, region: 'CA', couponsPerPackage: 1, lines, shipping: null, priceOptions: new Map(), coupons, rejected: [], usage: new Map(), consents: new Map(), ...over };
}

const code = (c: CampaignModel, text: string): CouponCandidate => ({ campaign: c, source: 'code', code: text, codeInfo: { id: newId(), code: text, kind: 'shared', maxRedemptions: null, redemptions: 0, active: true, assignedCustomerId: null } });

describe('money allocation', () => {
  it('splits an amount exactly across lines by value, never above a line', () => {
    for (let run = 0; run < 500; run++) {
      const values = Array.from({ length: 1 + (run % 7) }, (_, i) => ((run * 7919 + i * 104729) % 50000) + 1);
      const total = values.reduce((a, b) => a + b, 0);
      const amount = (run * 31337) % (total + 1);
      const parts = allocateByValue(amount, values);
      expect(parts.reduce((a, b) => a + b, 0)).toBe(amount);
      parts.forEach((p, i) => {
        expect(p).toBeGreaterThanOrEqual(0);
        expect(p).toBeLessThanOrEqual(values[i]!);
        expect(Number.isInteger(p)).toBe(true);
      });
    }
  });

  it('gives remainders deterministically (largest fraction, then line order)', () => {
    expect(allocateByValue(10, [10, 10, 10])).toEqual([4, 3, 3]);
    expect(allocateByValue(100, [1, 1, 1])).toEqual([1, 1, 1]);
    expect(allocateByValue(100, [1, 1, 1])).toEqual(allocateByValue(100, [1, 1, 1]));
    expect(allocateByValue(1, [3333, 3333, 3334])).toEqual([0, 0, 1]);
    expect(allocateByValue(500, [100, 200])).toEqual([100, 200]);
  });

  it('splits funding: platform, seller, shared and Official Store items', () => {
    const shared = campaign({ funding: { owner: 'shared', platformShareBps: 5000 } });
    expect(splitFunding(1001, shared, { official: false })).toEqual({ platform: 501, seller: 500 });
    expect(splitFunding(1000, shared, { official: true })).toEqual({ platform: 1000, seller: 0 });
    expect(splitFunding(1000, campaign({ ownerKind: 'seller', funding: { owner: 'seller' } }), { official: false })).toEqual({ platform: 0, seller: 1000 });
    expect(splitFunding(1000, shared, { official: false }, 2500)).toEqual({ platform: 250, seller: 750 });
    expect(fundingLabel({ owner: 'shared', platformShareBps: 5000 })).toBe('Shared 50/50');
  });

  it('explains earnings: the fee is on the price after the seller-funded part', () => {
    const e = earningsImpact({ basePrice: 10000, discount: 2000, sellerShareBps: 5000, feeRateBps: 1000, currency: 'USD', isExample: true, fundingWords: 'shared funding' });
    expect(e.customerPays.amount).toBe(8000);
    expect(e.sellerFunds.amount).toBe(1000);
    expect(e.platformFunds.amount).toBe(1000);
    expect(e.feeBasis.amount).toBe(9000);
    expect(e.fee.amount).toBe(900);
    expect(e.sellerEarns.amount).toBe(8100);
    expect(e.regularSellerEarns.amount).toBe(9000);
    expect(e.explanation).toContain('the customer pays $80.00');
  });

  it('labels discounts and periods in words', () => {
    expect(discountLabel({ kind: 'min_spend', percentOffBps: 1000, minSpend: { amount: 10000, currency: 'USD' } })).toBe('10% off orders over $100');
    expect(discountLabel({ kind: 'free_shipping', minSpend: { amount: 7500, currency: 'USD' } })).toBe('Free shipping over $75');
    expect(periodDisplay(new Date('2026-10-16T07:00:00Z'), new Date('2026-10-26T07:00:00Z'), 'America/Los_Angeles')).toBe('Oct 16 – Oct 25, 2026 PT');
  });
});

describe('cart evaluation', () => {
  it('splits a coupon across lines by value; the parts sum to the discount and never make a line negative', () => {
    const c = campaign({ discount: { kind: 'percent_coupon', percentOffBps: 3333 } });
    const lines = [cartLine(999, 3), cartLine(1, 1), cartLine(12345, 1)];
    const out = evaluate(input(lines, [code(c, 'SAVE')]));
    const total = Math.round(((999 * 3 + 1 + 12345) * 3333) / 10000);
    expect(out.applied[0]!.amount.amount).toBe(total);
    const parts = out.lines.map((l) => l.allocations.reduce((a, x) => a + x.amount.amount, 0));
    expect(parts.reduce((a, b) => a + b, 0)).toBe(total);
    out.lines.forEach((l, i) => expect(parts[i]!).toBeLessThanOrEqual(lines[i]!.unitPrice.amount * lines[i]!.quantity));
    expect(out.totals.total.amount).toBe(total);
    expect(out.totals.platform.amount).toBe(total);
  });

  it('caps a fixed coupon at the eligible value and a percentage at maxDiscountPerOrder', () => {
    const fixed = evaluate(input([cartLine(500, 1)], [code(campaign({ kind: 'fixed_coupon', discount: { kind: 'fixed_coupon', amountOff: { amount: 1000, currency: 'USD' } } }), 'TEN')]));
    expect(fixed.totals.total.amount).toBe(500);
    expect(fixed.lines[0]!.lineDiscount.amount).toBe(500);
    const capped = evaluate(input([cartLine(100000, 1)], [code(campaign({ discount: { kind: 'percent_coupon', percentOffBps: 2000, maxDiscountPerOrder: { amount: 5000, currency: 'USD' } } }), 'CAP')]));
    expect(capped.totals.total.amount).toBe(5000);
  });

  it('explains why a code does not apply', () => {
    const minSpend = campaign({ kind: 'min_spend', discount: { kind: 'min_spend', amountOff: { amount: 1000, currency: 'USD' }, minSpend: { amount: 10000, currency: 'USD' } } });
    const kitchenOnly = campaign({ scope: { mode: 'categories', include: [{ kind: 'category', id: newId(), label: 'Home & Kitchen' }], exclude: [] } });
    const ended = campaign({ status: 'ended' });
    const newOnly = campaign({ eligibility: { audience: 'new_customers' } });
    const out = evaluate(input([cartLine(5000, 1)], [code(minSpend, 'MIN'), code(kitchenOnly, 'KITCHEN'), code(ended, 'OLD')]));
    const why = Object.fromEntries(out.rejected.map((r) => [r.code, r]));
    expect(why.MIN!.reason).toBe('min_spend_not_met');
    expect(why.MIN!.message).toContain('$50 more');
    expect(why.KITCHEN!.reason).toBe('no_eligible_items');
    expect(why.KITCHEN!.message).toContain('Home & Kitchen');
    expect(why.OLD!.reason).toBe('expired');
    const guest = evaluate(input([cartLine(5000, 1)], [code(newOnly, 'NEW')], { customerId: null, signedIn: false }));
    expect(guest.rejected[0]!.reason).toBe('sign_in_required');
    const returning = evaluate(input([cartLine(5000, 1)], [code(newOnly, 'NEW')], { isNewCustomer: false }));
    expect(returning.rejected[0]!.reason).toBe('customer_not_eligible');
    const used = evaluate(input([cartLine(5000, 1)], [code(campaign({ limits: { perCustomer: 1 } }), 'ONCE')], { usage: new Map() }));
    expect(used.rejected).toEqual([]);
  });

  it('applies one coupon per seller package (best first) and rejects the other with per_order_limit', () => {
    const big = campaign({ discount: { kind: 'percent_coupon', percentOffBps: 3000 } });
    const small = campaign({ discount: { kind: 'percent_coupon', percentOffBps: 1000 } });
    const out = evaluate(input([cartLine(10000, 1)], [code(small, 'SMALL'), code(big, 'BIG')]));
    expect(out.applied.map((a) => a.code)).toEqual(['BIG']);
    expect(out.rejected).toEqual([expect.objectContaining({ code: 'SMALL', reason: 'per_order_limit' })]);
  });

  it('keeps coupons in the same exclusive group apart and honours withOtherCoupons', () => {
    const a = campaign({ stacking: { withSellerMarkdowns: true, withOtherCoupons: true, withFreeShipping: true, withFlashSalePrices: false, exclusiveGroup: 'fall' } });
    const b = campaign({ stacking: { withSellerMarkdowns: true, withOtherCoupons: true, withFreeShipping: true, withFlashSalePrices: false, exclusiveGroup: 'fall' } });
    const out = evaluate(input([cartLine(10000, 1, { pkg: 'P1' }), cartLine(10000, 1, { pkg: 'P2', seller: sellerB })], [code(a, 'A1'), code(b, 'B1')], { couponsPerPackage: 2 }));
    expect(out.applied).toHaveLength(1);
    expect(out.rejected[0]!.reason).toBe('not_combinable');
  });

  it('sets the unit price from a markdown, then applies coupons on the reduced price, then free shipping', () => {
    const md = campaign({ kind: 'markdown', discount: { kind: 'markdown', percentOffBps: 1000 }, ownerKind: 'seller', sellerId: sellerA, funding: { owner: 'seller' } });
    const coupon = campaign({ discount: { kind: 'percent_coupon', percentOffBps: 1000 } });
    const ship = campaign({ kind: 'free_shipping', discount: { kind: 'free_shipping', minSpend: { amount: 5000, currency: 'USD' } }, funding: { owner: 'shared', platformShareBps: 5000 } });
    const l = cartLine(10000, 2);
    const out = evaluate(
      input([l], [code(coupon, 'TEN'), { campaign: ship, source: 'automatic', code: null, codeInfo: null }], {
        priceOptions: new Map([[l.lineId, [{ campaign: md }]]]),
        shipping: { [l.packageId]: 899 },
        consents: new Map([[ship.id, new Map([[sellerA, { platformBps: 5000, offerIds: new Set([l.offerId]) }]])]]),
      }),
    );
    const ld = out.lines[0]!;
    expect(ld.unitPrice.amount).toBe(9000);
    expect(ld.allocations[0]).toMatchObject({ campaignId: md.id, amount: { amount: 2000 }, sellerPart: { amount: 2000 }, platformPart: { amount: 0 } });
    expect(ld.allocations[1]).toMatchObject({ campaignId: coupon.id, amount: { amount: 1800 }, platformPart: { amount: 1800 } });
    expect(out.packages[0]).toMatchObject({ freeShipping: true, shippingDiscount: { amount: 899 }, allocation: { platformPart: { amount: 450 }, sellerPart: { amount: 449 } } });
    expect(out.totals.total.amount).toBe(2000 + 1800 + 899);
    expect(out.totals.platform.amount + out.totals.seller.amount).toBe(out.totals.total.amount);
  });

  it("doesn't combine coupons with flash prices unless the coupon says so", () => {
    const flash = campaign({ kind: 'flash_sale', discount: { kind: 'flash_sale' } });
    const l = cartLine(10000, 1);
    const opts = new Map([[l.lineId, [{ campaign: flash, flash: { dealPrice: 6000, dealStock: 10, claimed: 0, reserved: 0, purchaseLimit: 2, state: 'active' } }]]]);
    const out = evaluate(input([l], [code(campaign(), 'TWENTY')], { priceOptions: opts }));
    expect(out.lines[0]!.unitPrice.amount).toBe(6000);
    expect(out.lines[0]!.purchaseLimit).toBe(2);
    expect(out.rejected[0]).toMatchObject({ code: 'TWENTY', reason: 'not_combinable' });
    const over = evaluate(input([cartLine(10000, 3)], [], { priceOptions: new Map() }));
    expect(over.lines[0]!.limitExceeded).toBe(false);
    const l3 = cartLine(10000, 3);
    const limited = evaluate(input([l3], [], { priceOptions: new Map([[l3.lineId, opts.get(l.lineId)!]]) }));
    expect(limited.lines[0]).toMatchObject({ unitPrice: { amount: 10000 }, limitExceeded: true, purchaseLimit: 2 });
  });

  it('holds only what the budget allows and rejects a coupon over the remaining budget', () => {
    const c = campaign({ limits: { budget: { amount: 1000, currency: 'USD' } }, budgetUsed: 500 });
    const out = evaluate(input([cartLine(10000, 1)], [code(c, 'BUDGET')]));
    expect(out.rejected[0]).toMatchObject({ reason: 'budget_exhausted' });
    expect(out.holds).toEqual([]);
  });
});
