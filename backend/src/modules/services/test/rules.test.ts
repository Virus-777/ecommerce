import { describe, expect, it } from 'vitest';
import { fixedPriceOfRow, requestEstimate } from '../domain/rules.js';

const usd = (amount: number) => ({ amount, currency: 'USD' });

/**
 * What one request is worth by the provider's price list, for the statistics tab's estimate. Never what the
 * customer paid — these services are paid at the provider — so anything charged by the hour has no total.
 */
describe('the price of one request', () => {
  it('reads a fixed price out of a price-list row, and leaves a rate per hour alone', () => {
    expect(fixedPriceOfRow('$229', 'USD')).toEqual(usd(22_900));
    expect(fixedPriceOfRow('$45', 'USD')).toEqual(usd(4500));
    expect(fixedPriceOfRow('$1,250.50', 'USD')).toEqual(usd(125_050));
    expect(fixedPriceOfRow('Free', 'USD')).toEqual(usd(0));
    expect(fixedPriceOfRow('free', 'USD')).toEqual(usd(0));
    // a night or a visit is one occurrence of the service, so it is a price per request
    expect(fixedPriceOfRow('$190/night', 'USD')).toEqual(usd(19_000));
    expect(fixedPriceOfRow('$45 / visit', 'USD')).toEqual(usd(4500));
    // by the hour: the hours worked are not recorded anywhere, so there is no total
    expect(fixedPriceOfRow('$24/hr', 'USD')).toBeNull();
    expect(fixedPriceOfRow('$24 / hour', 'USD')).toBeNull();
    expect(fixedPriceOfRow('$24/h', 'USD')).toBeNull();
    // nothing to read
    expect(fixedPriceOfRow('Ask us', 'USD')).toBeNull();
    expect(fixedPriceOfRow('', 'USD')).toBeNull();
    expect(fixedPriceOfRow(null, 'USD')).toBeNull();
    // a range counts as its lower end
    expect(fixedPriceOfRow('$80–$120', 'USD')).toEqual(usd(8000));
  });

  it('prefers the row the customer chose over the service’s own price', () => {
    const service = {
      currency: 'USD',
      price_unit: 'hour',
      from_price: 2400,
      price_table: [
        { label: 'Weekly', price: '$24/hr' },
        { label: 'Overnight', price: '$190/night' },
        { label: 'Assessment', price: 'Free' },
      ],
    };
    expect(requestEstimate(service, 'Overnight')).toEqual(usd(19_000));
    expect(requestEstimate(service, 'Assessment')).toEqual(usd(0));
    expect(requestEstimate(service, 'Weekly')).toBeNull();
    // the label is matched whatever the case and spacing
    expect(requestEstimate(service, ' overnight ')).toEqual(usd(19_000));
    // a plan that is not in the list, or none at all, falls back to the service — hourly here, so nothing
    expect(requestEstimate(service, 'Fortnightly')).toBeNull();
    expect(requestEstimate(service, null)).toBeNull();
  });

  it('falls back to the service’s price by its unit', () => {
    const of = (price_unit: string, from_price: number | null) => requestEstimate({ currency: 'USD', price_unit, from_price }, null);
    expect(of('fixed', 8900)).toEqual(usd(8900));
    expect(of('visit', 4500)).toEqual(usd(4500));
    expect(of('night', 19_000)).toEqual(usd(19_000));
    expect(of('free', null)).toEqual(usd(0));
    expect(of('hour', 2400)).toBeNull();
    expect(of('fixed', null)).toBeNull();
  });
});
