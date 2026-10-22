import { describe, expect, it } from 'vitest';
import { balanceLabel, cardAmountOf, dayLabel, depositLabel, depositOf, dealerMeta, deliveryLabel, deliveryWindow, inWindow, isPhone, locationLabel, makeRef, messageOf, moneyLabel, monthlyAmount, paymentLabel, paymentOptionsFor, statusLabel, summaryLabel } from '../domain/rules.js';

const usd = (amount: number) => ({ amount, currency: 'USD' });

describe('farm rules', () => {
  it('labels money, days, summaries and statuses like the artboards', () => {
    expect(moneyLabel(usd(1_890_000))).toBe('$18,900');
    expect(moneyLabel(usd(1_890_050))).toBe('$18,900.50');
    expect(dayLabel('2026-11-03')).toBe('Tue, Nov 3');
    expect(summaryLabel(0)).toBe('Machine · delivery included');
    expect(summaryLabel(1)).toBe('Machine + 1 attachment · delivery included');
    expect(summaryLabel(2)).toBe('Machine + 2 attachments · delivery included');
    expect(statusLabel('placed', 'Greenfield Agri Equipment', '2026-11-03')).toBe('Waiting for Greenfield Agri Equipment to confirm');
    expect(statusLabel('confirmed', 'Greenfield', '2026-11-03')).toBe('Confirmed · delivery Tue, Nov 3');
    expect(deliveryLabel('2026-11-03', false, 'placed')).toBe('Requested for Tue, Nov 3');
    expect(deliveryLabel('2026-11-03', true, 'confirmed')).toBe('Delivery Tue, Nov 3');
  });

  it('works out the Installments line: $22,100 over 12 months is $1,842/mo', () => {
    expect(monthlyAmount(2_210_000, 12)).toBe(184_200);
    const options = paymentOptionsFor(usd(2_210_000), 12, 10);
    expect(options.map((o) => o.option)).toEqual(['pay_in_full', 'installments', 'pay_on_delivery']);
    expect(options[1]).toMatchObject({ title: 'Installments', subtitle: '12 months · $1,842/mo, subject to approval', needsCard: false });
    expect(options[0]).toMatchObject({ needsCard: true, cardAmount: usd(2_210_000) });
    expect(options[2]).toMatchObject({ title: 'Pay on delivery', subtitle: '10% deposit now, the rest when it arrives', needsCard: true, cardAmount: usd(221_000) });
    expect(depositOf(2_210_001, 25)).toBe(552_500);
    expect([cardAmountOf('pay_in_full', 2_210_000, 10), cardAmountOf('pay_on_delivery', 2_210_000, 10), cardAmountOf('installments', 2_210_000, 10)]).toEqual([2_210_000, 221_000, 0]);
    expect(depositLabel(usd(221_000))).toBe('$2,210.00 now');
    expect(depositLabel(usd(221_000), true)).toBe('$2,210.00 paid');
    expect(balanceLabel(usd(1_989_000))).toBe('$19,890.00 when it arrives');
    expect(paymentLabel('pay_on_delivery', 'Visa •••• 4242', 12, 10)).toBe('Pay on delivery · 10% deposit · Visa •••• 4242');
    expect(paymentLabel('pay_in_full', 'Visa •••• 4242', 12)).toBe('Pay in full · Visa •••• 4242');
    expect(paymentLabel('installments', null, 12)).toBe('Installments · 12 months, subject to approval');
  });

  it('keeps delivery dates inside the window', () => {
    const w = deliveryWindow('2030-01-09', 3, 90);
    expect(w).toEqual({ earliest: '2030-01-12', latest: '2030-04-09' });
    expect(inWindow('2030-01-11', w)).toBe(false);
    expect(inWindow('2030-01-12', w)).toBe(true);
    expect(inWindow('2030-04-10', w)).toBe(false);
    expect(inWindow('soon', w)).toBe(false);
  });

  it('labels places, dealers and contacts', () => {
    expect(locationLabel({ name: 'Hollow Creek Farm', line1: '4410 County Rd 12', city: 'Millbrook' })).toBe('Hollow Creek Farm, 4410 County Rd 12, Millbrook');
    expect(locationLabel({ name: null, line1: '4410 County Rd 12', city: 'Millbrook' })).toBe('4410 County Rd 12, Millbrook');
    expect(dealerMeta('Route 9, Millbrook', '12 mi')).toBe('Route 9, Millbrook · 12 mi away');
    expect(dealerMeta('Route 9, Millbrook', null)).toBe('Route 9, Millbrook');
    expect(messageOf({ message_phone: null, message_email: 'sales@example.com' })).toEqual({ kind: 'email', to: 'sales@example.com' });
    expect(messageOf({ message_phone: '503-555-0100', message_email: 'x@y.z' })).toEqual({ kind: 'sms', to: '503-555-0100' });
    expect(messageOf({ message_phone: null, message_email: null })).toBeNull();
    expect(isPhone('(555) 014-2280')).toBe(true);
    expect(isPhone('call me')).toBe(false);
    expect(makeRef(() => 0)).toBe('FM-22222');
    expect(makeRef()).toMatch(/^FM-[2-9A-HJ-NP-Z]{5}$/);
  });
});
