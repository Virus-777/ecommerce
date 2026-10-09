/** Pure checkout rules: tax, steps and blockers, change choices, derived order keys. */
import { describe, expect, it } from 'vitest';
import { isUuid } from '../../../kernel/lib/ids.js';
import { checkoutSessionMachine } from '../domain/state-machines.js';
import { choicesFor, missingSteps, stepsOf, taxFor, taxOf, type StepFacts } from '../domain/rules.js';
import { stableUuid } from '../service/placement.js';

const ready: StepFacts = { hasEmail: true, hasAddress: true, notShippable: 0, included: 2, packagesWithoutOption: [], rejectedCoupons: 0, hasPayment: true, changesPending: false };
const addr = (region: string) => ({ name: 'A', line1: '1 Main St', city: 'X', region, postalCode: '00000', country: 'US' });

describe('sales tax', () => {
  it('uses the destination state rate and says when a state has none', () => {
    expect(taxFor(null)).toBeNull();
    expect(taxFor(addr('ca'))).toMatchObject({ jurisdiction: 'CA', rate: 0.0725, label: 'Sales tax (CA 7.25%)' });
    expect(taxFor(addr('OR'))).toMatchObject({ rate: 0, label: 'Tax (Oregon has no sales tax)' });
    expect(taxOf(18900, 0.065)).toBe(1229);
    expect(taxOf(-5, 0.065)).toBe(0);
  });
});

describe('steps and blockers', () => {
  it('is ready only with every step done', () => {
    expect(stepsOf(ready).blockers).toEqual([]);
    expect(missingSteps(ready)).toEqual([]);
  });

  it('names what is missing', () => {
    const f: StepFacts = { ...ready, hasEmail: false, hasAddress: false, hasPayment: false };
    expect(stepsOf(f).blockers).toEqual(['Add your email address', 'Choose a delivery address', 'Choose a payment method']);
    expect(missingSteps(f)).toEqual(['account', 'address', 'payment']);
    expect(missingSteps({ ...ready, packagesWithoutOption: ['Package 1 of 2'] })).toEqual(['delivery']);
    expect(stepsOf({ ...ready, included: 0, notShippable: 2 }).blockers).toEqual(['None of your items can ship to this address']);
    expect(stepsOf({ ...ready, changesPending: true }).steps.at(-1)).toEqual({ key: 'review', status: 'needs_attention' });
  });
});

describe('change choices', () => {
  it('never switches a seller by default and offers alternatives only when there are some', () => {
    expect(choicesFor('out_of_stock', { alternatives: false, otherOptions: false })).toEqual({ choices: ['remove'], defaultChoice: 'remove' });
    expect(choicesFor('out_of_stock', { alternatives: true, otherOptions: false })).toEqual({ choices: ['remove', 'choose_offer'], defaultChoice: 'remove' });
    expect(choicesFor('price_increased', { alternatives: true, otherOptions: false }).defaultChoice).toBe('accept');
    expect(choicesFor('quantity_reduced', { alternatives: false, otherOptions: false }).defaultChoice).toBe('reduce_quantity');
    expect(choicesFor('delivery_option_unavailable', { alternatives: false, otherOptions: true }).defaultChoice).toBe('choose_other_option');
  });
});

describe('session flow', () => {
  it('follows the spec state machine', () => {
    expect(checkoutSessionMachine.next('open', 'place')).toBe('placing');
    expect(checkoutSessionMachine.next('payment_failed', 'retry_payment')).toBe('placing');
    expect(() => checkoutSessionMachine.next('completed', 'cancel')).toThrow(/not allowed/);
  });

  it('derives a stable order key for a new order after a cancelled one', () => {
    const a = stableUuid('s:order:1');
    expect(isUuid(a)).toBe(true);
    expect(stableUuid('s:order:1')).toBe(a);
    expect(stableUuid('s:order:2')).not.toBe(a);
  });
});
