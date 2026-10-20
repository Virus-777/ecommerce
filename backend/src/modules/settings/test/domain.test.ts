import { describe, expect, it } from 'vitest';
import { allSpecs } from '../../../kernel/module-system/loader.js';
import { createCalendar } from '../domain/calendar.js';
import { buildCatalogue, humanize, inferUnit, inferValueType, strictest } from '../domain/catalogue.js';
import { bucketOf, evaluateFlag } from '../domain/flags.js';
import { closedLabel, hoursLabel, validateValue, valueText } from '../domain/values.js';

const catalogue = buildCatalogue(allSpecs, new Set(Object.keys(allSpecs).filter((m) => m !== 'wallet')), { defaultMinLeadDays: 0, sellerVisibleMinLeadDays: 14 });
const def = (key: string) => catalogue.get(key)!;

describe('catalogue', () => {
  it('infers types, units and labels from a module spec setting', () => {
    expect(inferValueType(true)).toBe('bool');
    expect(inferValueType(12)).toBe('int');
    expect(inferValueType(2.5)).toBe('number');
    expect(inferValueType('14:00')).toBe('time');
    expect(inferValueType({ amount: 799, currency: 'USD' })).toBe('money');
    expect(inferValueType([1, 2])).toBe('json');
    expect(humanize('maxImagesPerProduct')).toBe('Max images per product');
    expect(inferUnit('firstResponseBusinessHours')).toBe('business hours');
    expect(inferUnit('stockHoldMinutes')).toBe('minutes');
    expect(def('wallet.goodwillMaxPerCustomer30Days').available).toBe(false);
  });

  it('uses what a module declares for a setting over inference', () => {
    expect(def('returns.changeOfMindReturnFee')).toMatchObject({ valueType: 'money', min: 0, approval: 'business_owner', sellerVisible: true, minLeadDays: 14 });
    expect(def('finance.payoutSchedule')).toMatchObject({ valueType: 'string', approval: 'business_owner', sellerVisible: true, minLeadDays: 30, editable: true });
    expect(def('finance.statementPeriod')).toMatchObject({ valueType: 'enum', enumValues: ['weekly', 'monthly'], approval: 'second_reviewer' });
    expect(def('support.maxAttachments')).toMatchObject({ valueType: 'int', min: 0, max: 20 });
    expect(def('support.appealWindowDays')).toMatchObject({ valueType: 'duration', unit: 'days', min: 1, approval: 'business_owner' });
    expect(def('messaging.maxAttachmentMb')).toMatchObject({ unit: 'MB', min: 1 });
    // a seller-visible setting with a declared lead shorter than the seller notice gets the seller notice
    expect(def('fulfillment-service.discrepancyResponseDays')).toMatchObject({ sellerVisible: true, minLeadDays: 14 });
    // declared not seller-visible in a seller-facing module
    expect(def('orders.orderRefPrefix')).toMatchObject({ editable: false, sellerVisible: false, minLeadDays: 0 });
    expect(def('settings.defaultMinLeadDays')).toMatchObject({ approval: 'business_owner', unit: 'days' });
  });

  it('every declared default is a valid value for its own definition', () => {
    const bad = [...catalogue.values()].filter((d) => !d.builtIn).map((d) => ({ key: d.key, issues: validateValue(d, d.default) })).filter((x) => x.issues.length);
    expect(bad).toEqual([]);
  });

  it('keeps settings-owned rules over the module declaration of the same key', () => {
    expect(def('checkout.guestCheckoutEnabled')).toMatchObject({ module: 'checkout', section: 'checkout', approval: 'business_owner', builtIn: true });
    expect(def('checkout.sessionTtlMinutes')).toMatchObject({ section: 'checkout', builtIn: false });
    expect(strictest(['none', 'business_owner', 'second_reviewer'])).toBe('business_owner');
  });
});

describe('values', () => {
  it('validates by type and by key', () => {
    expect(validateValue(def('support.maxAttachments'), 3)).toEqual([]);
    expect(validateValue(def('support.maxAttachments'), 3.5)[0]!.message).toBe('Must be a whole number');
    expect(validateValue(def('apps.android.updateMessage'), null)).toEqual([]);
    expect(validateValue(def('support.phone'), null)).toHaveLength(1);
    expect(validateValue(def('support.closures'), [{ date: '2026-12-24', label: 'Christmas Eve', kind: 'reduced_hours', opens: '08:00', closes: '14:00' }])).toEqual([]);
    expect(validateValue(def('support.closures'), [{ date: '2026-12-24', label: 'Christmas Eve', kind: 'reduced_hours' }])).toHaveLength(1);
    expect(validateValue(def('apps.maintenance'), { active: true, kind: 'maintenance', message: null })).toHaveLength(1);
    expect(validateValue(def('market.locale'), 'en-US')).toEqual([]);
    expect(validateValue(def('notifications.retryBackoffMinutes'), { a: 1 })).toHaveLength(1);
  });

  it('writes values for people', () => {
    const hours = (['mon', 'tue', 'wed', 'thu', 'fri'] as const).map((weekday) => ({ weekday, opens: '09:00', closes: '17:30' }));
    expect(hoursLabel([...hours, { weekday: 'sat', opens: '10:00', closes: '14:00' }], 'America/Los_Angeles')).toBe('Mon–Fri, 9:00 AM – 5:30 PM; Sat, 10:00 AM – 2:00 PM PT');
    expect(closedLabel(hours, [], 'US')).toBe('Closed Saturdays and Sundays');
    expect(valueText(def('returns.changeOfMindReturnFee'), { amount: 799, currency: 'USD' })).toBe('$7.99');
    expect(valueText(def('checkout.guestCheckoutEnabled'), false)).toBe('Off');
    expect(valueText(def('shipping.officialCutoff'), '14:00')).toBe('2:00 PM');
  });

  it('writes json values as words, never JSON', () => {
    const json = (key: string) => ({ key, valueType: 'json' as const, unit: null });
    expect(valueText(json('market.defaultDeliveryLocation'), { postalCode: '97205', label: 'Portland, OR 97205' })).toBe('Portland, OR 97205');
    expect(valueText(json('market.defaultDeliveryLocation'), { postalCode: '97205', label: 'Portland' })).toBe('Portland (97205)');
    expect(valueText(json('sellers.riskReviewCategories'), ['e-bike batteries', 'high-value electronics'])).toBe('e-bike batteries, high-value electronics');
    expect(valueText(json('content.reviewRequired'), { page: false, article: true })).toBe('Page: Off · Article: On');
    expect(valueText(json('media.limitsByPurpose'), { product_image: { maxMB: 20, types: ['jpeg', 'png'] } })).toBe('Product image (Max MB: 20, Types: jpeg, png)');
    expect(valueText(json('search.pricePresets'), [2500, 5000])).toBe('$25.00, $50.00');
    expect(valueText(json('shipping.sellerHandlingRange'), [0, 3])).toBe('0 to 3 business days');
    expect(valueText(json('offers.minimumPriceByCategory'), {})).toBe('None');
    expect(valueText(json('reports.exportDatasets'), [{ key: 'a.b', owner: 'a' }])).toBe('1 item: a.b');
  });
});

describe('calendar and flags', () => {
  it('uses reduced hours on a closure day and crosses closed days', () => {
    const cal = createCalendar([{ weekday: 'thu', opens: '08:00', closes: '20:00' }], [{ date: '2026-12-24', label: 'Christmas Eve', kind: 'reduced_hours', opens: '08:00', closes: '12:00' }], 'America/Los_Angeles');
    expect(cal.day('2026-12-24')).toMatchObject({ open: true, closesAt: '2026-12-24T20:00:00.000Z', label: 'Christmas Eve' });
    expect(cal.addBusinessMinutes(new Date('2026-12-24T19:00:00.000Z'), 120)!.toISOString()).toBe('2026-12-31T17:00:00.000Z');
    expect(createCalendar([], [], 'UTC').nextOpen(new Date())).toBeNull();
  });

  it('evaluates rollouts', () => {
    const on = { enabled: true, rollout: 'everyone' as const, percentage: null };
    expect(evaluateFlag('f', on, true)).toBe(true);
    expect(evaluateFlag('f', on, false)).toBe(false);
    expect(evaluateFlag('f', { ...on, rollout: 'staff_only' }, true, { realm: 'store' })).toBe(false);
    expect(bucketOf('f', 'a')).toBe(bucketOf('f', 'a'));
  });
});
