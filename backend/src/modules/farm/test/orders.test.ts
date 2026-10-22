import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { ADDRESS, ADDRESS_ID, boot, CANBY, dealer, newId, PORTLAND, SALEM, tractor, usd, type Kit } from './helpers.js';

let k: Kit;
let canby: any;
let salem: any;
beforeAll(async () => {
  k = await boot();
  canby = await dealer(k);
  salem = await dealer(k, { name: 'Willamette Farm Supply', address: { line1: '3050 Silverton Rd NE', city: 'Salem', region: 'OR', postalCode: '97301' }, phone: '503-555-0190', messagePhone: null, messageEmail: 'orders@willamette.example', leadDays: 7 });
});
afterAll(async () => {
  await k?.app.close();
});

const RETURN = 'https://app.marketly.example/farm/return';
const cardOf = (token: string) => ({ kind: 'new_card', providerToken: token });
const farm = { address: { name: 'Hollow Creek Farm', line1: '4410 County Rd 12', city: 'Canby', region: 'OR', postalCode: '97013' } };

function shopper() {
  const accountId = newId();
  return { accountId, me: k.customer(accountId) };
}
const place = (me: Record<string, string>, body: Record<string, unknown>, key = newId()) => k.store('POST', '/orders', body, { ...me, 'idempotency-key': key });
const order = (t: ReturnType<typeof tractor>, over: Record<string, unknown> = {}) => ({
  productId: t.product.productId,
  attachmentIds: [t.loader.productId],
  deliveryDate: '2030-01-20',
  location: farm,
  contactName: 'Daniel Moore',
  contactPhone: '(555) 014-2280',
  paymentOption: 'pay_on_delivery',
  notes: 'Gate code 4410',
  expectedTotal: usd(2_210_000),
  method: cardOf('tok_visa'),
  returnUrl: RETURN,
  ...over,
});
const move = (id: string, action: string, over: Record<string, unknown> = {}) => k.admin('POST', `/orders/${id}/status`, { action, ...over });
const eventsOf = (id: string) => k.events.filter((e) => e.payload.orderId === id || e.payload.refId === id);

describe('quotes', () => {
  it('prices the machine and attachments with delivery included, the dealer and the payment options', async () => {
    const t = tractor(k);
    const q = (await k.store('POST', '/quotes', { productId: t.product.productId, attachmentIds: [t.loader.productId], location: farm })).body;
    expect(q).toMatchObject({
      machineLabel: '25 hp · 4WD · Greenfield Agri Equipment',
      machinePrice: usd(1_890_000),
      attachmentsTotal: usd(320_000),
      deliveryFee: usd(0),
      total: usd(2_210_000),
      summaryLabel: 'Machine + 1 attachment · delivery included',
      earliestDeliveryDate: '2030-01-12',
      latestDeliveryDate: '2030-04-09',
      canOrder: true,
      problems: [],
      dealer: { id: canby.id, name: 'Greenfield Agri Equipment', distanceLabel: '0.1 mi' },
    });
    expect(q.attachments.map((a: any) => [a.product.title, a.selected, a.priceLabel])).toEqual([
      ['Front loader LA344', true, '+$3,200'],
      ['Rotary tiller, 5 ft', false, '+$1,850'],
      ['Rear blade, 6 ft', false, '+$640'],
    ]);
    expect(q.paymentOptions.map((o: any) => o.subtitle)).toEqual(['Card now · charged when the dealer confirms', '12 months · $1,842/mo, subject to approval', '10% deposit now, the rest when it arrives']);
    expect(q.paymentOptions.map((o: any) => [o.needsCard, o.cardAmount.amount])).toEqual([[true, 2_210_000], [false, 0], [true, 221_000]]);
    expect(q).toMatchObject({ depositPercent: 10, deposit: usd(221_000), balance: usd(1_989_000), depositLabel: '$2,210.00 now', balanceLabel: '$19,890.00 when it arrives' });

    // a farm pinned near Salem goes to the Salem dealer, with its own lead time
    const s = (await k.store('POST', '/quotes', { productId: t.product.productId, location: { point: SALEM } })).body;
    expect(s).toMatchObject({ dealer: { id: salem.id, distanceLabel: '0.1 mi' }, earliestDeliveryDate: '2030-01-16', total: usd(1_890_000), summaryLabel: 'Machine · delivery included' });

    // no location: the signed-in customer's default address, else the market default
    const { accountId, me } = shopper();
    k.locations.set(accountId, PORTLAND);
    expect((await k.store('POST', '/quotes', { productId: t.product.productId }, me)).body.dealer).toMatchObject({ id: canby.id, distanceLabel: '17 mi' });
    expect((await k.store('POST', '/quotes', { productId: t.product.productId })).body.dealer).toMatchObject({ id: canby.id, distanceLabel: null });

    expect((await k.store('POST', '/quotes', { productId: newId() })).status).toBe(404);
    const out = tractor(k, { availability: 'out_of_stock' });
    expect((await k.store('POST', '/quotes', { productId: out.product.productId, attachmentIds: [newId()] })).body).toMatchObject({ canOrder: false, problems: ['This machine is out of stock', 'An attachment is no longer available'] });
  });
});

describe('placing an order', () => {
  it('places a pay-on-delivery order with a 10% card deposit at the nearest dealer, and the key answers the same order', async () => {
    const t = tractor(k);
    const { me } = shopper();
    const key = newId();
    const res = await place(me, order(t), key);
    expect(res.status, JSON.stringify(res.body)).toBe(201);
    const o = res.body;
    expect(o.ref).toMatch(/^FM-[2-9A-HJ-NP-Z]{5}$/);
    expect(o).toMatchObject({
      status: 'placed',
      statusLabel: 'Waiting for Greenfield Agri Equipment to confirm',
      paymentOption: 'pay_on_delivery',
      total: usd(2_210_000),
      cardAmount: usd(221_000),
      deposit: usd(221_000),
      balance: usd(1_989_000),
      depositLabel: '$2,210.00 now',
      balanceLabel: '$19,890.00 when it arrives',
      summaryLabel: 'Machine + 1 attachment · delivery included',
      machine: { productId: t.product.productId, title: 'Kubota L2502 compact tractor', highlights: ['25 hp', '4WD'], price: usd(1_890_000) },
      attachments: [{ productId: t.loader.productId, title: 'Front loader LA344', price: usd(320_000), priceLabel: '+$3,200' }],
      dealer: { id: canby.id, name: 'Greenfield Agri Equipment' },
      requestedDeliveryDate: '2030-01-20',
      deliveryDate: '2030-01-20',
      deliveryDateConfirmed: false,
      deliveryLabel: 'Requested for Sun, Jan 20',
      location: { name: 'Hollow Creek Farm', label: 'Hollow Creek Farm, 4410 County Rd 12, Canby', point: CANBY, pinned: false, country: 'US' },
      contactName: 'Daniel Moore',
      contactPhone: '(555) 014-2280',
      notes: 'Gate code 4410',
      payment: { state: 'accepted', module: 'farm', refId: o.id, amount: usd(221_000) },
      canCancel: true,
    });
    expect(o.paymentLabel).toMatch(/^Pay on delivery · 10% deposit · /);
    expect(o.history.map((h: any) => h.status)).toEqual(['payment_pending', 'placed']);
    expect(eventsOf(o.id).map((e) => e.name)).toEqual(['farm.order.placed']);
    expect(eventsOf(o.id)[0]!.payload).toMatchObject({ ref: o.ref, dealerId: canby.id, dealerName: 'Greenfield Agri Equipment', machineName: 'Kubota L2502 compact tractor', paymentOption: 'pay_on_delivery', total: usd(2_210_000), cardAmount: usd(221_000), deliveryDate: '2030-01-20' });
    expect((await place(me, order(t), key)).body.id).toBe(o.id);
    expect(eventsOf(o.id)).toHaveLength(1);
    expect((await k.store('GET', '/orders?state=open', undefined, me)).body.items.map((x: any) => x.id)).toEqual([o.id]);
    expect((await k.store('GET', `/orders/${o.id}`, undefined, k.customer(newId()))).status).toBe(404);
    // a dealer with orders can't be deleted
    expect((await k.admin('DELETE', `/dealers/${canby.id}`)).body.error.code).toBe('IN_USE');
    expect((await k.admin('GET', `/dealers/${canby.id}`)).body).toMatchObject({ openOrders: expect.any(Number), orderCount: expect.any(Number) });
  });

  it('uses a saved address and the pin the customer put on the map', async () => {
    const t = tractor(k);
    const { me } = shopper();
    const pin = { lat: 44.95, lng: -123.03 };
    const o = (await place(me, order(t, { location: { addressId: ADDRESS_ID, point: pin }, paymentOption: 'installments', deliveryDate: '2030-01-17' }))).body;
    expect(o).toMatchObject({ status: 'placed', dealer: { id: salem.id }, location: { line1: ADDRESS.line1, city: 'Canby', point: pin, pinned: true }, paymentLabel: 'Installments · 12 months, subject to approval' });
    expect((await place(me, order(t, { location: { addressId: newId() } }))).status).toBe(404);
  });

  it('refuses a changed total, a date too soon, missing fields and things that cannot be ordered', async () => {
    const t = tractor(k);
    const { me } = shopper();
    expect((await place(me, order(t, { expectedTotal: usd(1_890_000) }))).body.error).toMatchObject({ code: 'PRICE_CHANGED', details: { total: usd(2_210_000) } });
    expect((await place(me, order(t, { deliveryDate: '2030-01-11' }))).body.error).toMatchObject({ code: 'DELIVERY_DATE_UNAVAILABLE', details: { earliest: '2030-01-12', latest: '2030-04-09' } });
    expect((await place(me, order(t, { deliveryDate: '2030-06-01' }))).body.error.code).toBe('DELIVERY_DATE_UNAVAILABLE');
    expect((await place(me, order(t, { contactPhone: 'n/a' }))).body.error).toMatchObject({ code: 'VALIDATION_FAILED', details: { issues: [{ path: 'contactPhone' }] } });
    expect((await place(me, order(t, { location: { address: { line1: '', city: 'Canby', region: 'OR' } } }))).body.error).toMatchObject({ code: 'VALIDATION_FAILED', details: { issues: [{ path: 'location.address.line1' }] } });
    expect((await place(me, order(t, { paymentOption: 'pay_in_full', method: null }))).body.error).toMatchObject({ code: 'VALIDATION_FAILED', details: { issues: [{ path: 'method' }] } });
    expect((await place(me, order(t, { method: null }))).body.error).toMatchObject({ code: 'VALIDATION_FAILED', details: { issues: [{ path: 'method' }] } });
    expect((await place(me, order(t, { returnUrl: null }))).body.error).toMatchObject({ code: 'VALIDATION_FAILED', details: { issues: [{ path: 'returnUrl' }] } });
    expect((await place(me, order(t, { attachmentIds: [newId()] }))).body.error.code).toBe('ATTACHMENT_UNAVAILABLE');
    expect((await place(me, order(t, { productId: newId() }))).body.error.code).toBe('MACHINE_UNAVAILABLE');
    const out = tractor(k, { availability: 'out_of_stock' });
    expect((await place(me, order(out, { attachmentIds: [] , expectedTotal: usd(1_890_000) }))).body.error.code).toBe('MACHINE_UNAVAILABLE');
    expect((await k.store('POST', '/orders', order(t))).status).toBe(401);
    expect((await k.store('GET', '/orders', undefined, me)).body.items).toEqual([]);
  });
});

describe('paying in full', () => {
  it('authorizes the card, captures it when the dealer confirms, and goes out for delivery', async () => {
    const t = tractor(k);
    const { me } = shopper();
    const o = (await place(me, order(t, { paymentOption: 'pay_in_full', method: cardOf('tok_visa'), returnUrl: RETURN }))).body;
    expect(o).toMatchObject({ status: 'placed', payment: { state: 'accepted', module: 'farm', refId: o.id, amount: usd(2_210_000) } });
    expect(o.paymentLabel).toMatch(/^Pay in full · /);
    expect(o.history.map((h: any) => h.status)).toEqual(['payment_pending', 'placed']);
    expect(eventsOf(o.id).map((e) => e.name)).toEqual(['farm.order.placed']);

    const admin = (await k.admin('GET', `/orders/${o.id}`)).body;
    expect(admin).toMatchObject({ paymentState: 'accepted', actions: ['confirm', 'reject', 'cancel'], dealer: { id: canby.id, name: 'Greenfield Agri Equipment' } });
    expect((await move(o.id, 'confirm', { deliveryDate: '2030-01-08' })).body.error).toMatchObject({ code: 'VALIDATION_FAILED', details: { issues: [{ path: 'deliveryDate' }] } });
    expect((await move(o.id, 'confirm', {}, )).status).toBe(200);
    const confirmed = (await k.store('GET', `/orders/${o.id}`, undefined, me)).body;
    expect(confirmed).toMatchObject({ status: 'confirmed', statusLabel: 'Confirmed · delivery Sun, Jan 20', deliveryDateConfirmed: true, deliveryLabel: 'Delivery Sun, Jan 20', payment: { state: 'captured' }, canCancel: false });
    expect(eventsOf(o.id).map((e) => e.name)).toEqual(['farm.order.placed', 'payments.purchase.captured', 'farm.order.status_changed']);

    // the card was charged: staff can't cancel it in the app, and the customer can't either
    expect((await k.admin('GET', `/orders/${o.id}`)).body.actions).toEqual(['dispatch', 'reschedule']);
    expect((await move(o.id, 'cancel')).body.error.code).toBe('REFUND_NOT_AVAILABLE');
    expect((await k.store('POST', `/orders/${o.id}/cancel`, {}, me)).body.error.code).toBe('ILLEGAL_TRANSITION');

    const moved = (await move(o.id, 'reschedule', { deliveryDate: '2030-01-22', note: 'Our truck is booked on the 20th' })).body;
    expect(moved).toMatchObject({ status: 'confirmed', deliveryDate: '2030-01-22', requestedDeliveryDate: '2030-01-20', dealerNote: 'Our truck is booked on the 20th' });
    expect(moved.history.at(-1)).toMatchObject({ status: 'confirmed', by: 'Sam Staff', note: 'Delivery moved to Tue, Jan 22 · Our truck is booked on the 20th' });
    expect(eventsOf(o.id).at(-1)!.payload).toMatchObject({ status: 'confirmed', deliveryDate: '2030-01-22', rescheduled: true });
    expect((await move(o.id, 'reschedule', {})).body.error.code).toBe('VALIDATION_FAILED');

    expect((await move(o.id, 'deliver')).body.error.code).toBe('ILLEGAL_TRANSITION');
    expect((await move(o.id, 'dispatch')).body.status).toBe('out_for_delivery');
    const done = (await move(o.id, 'deliver')).body;
    expect(done).toMatchObject({ status: 'delivered', actions: [] });
    expect((await k.store('GET', `/orders/${o.id}`, undefined, me)).body).toMatchObject({ status: 'delivered', deliveryLabel: 'Delivered · Tue, Jan 22', deliveredAt: expect.any(String) });
    expect((await k.store('GET', '/orders?state=past', undefined, me)).body.items.map((x: any) => x.id)).toEqual([o.id]);
    expect(k.audits.filter((a) => a.target?.id === o.id).map((a) => a.action)).toEqual(['farm.order.confirm', 'farm.order.reschedule', 'farm.order.dispatch', 'farm.order.deliver']);
  });

  it('keeps a declined order for another try, and places it on a retry', async () => {
    const t = tractor(k);
    const { me } = shopper();
    const failed = (await place(me, order(t, { paymentOption: 'pay_in_full', method: cardOf('tok_declined'), returnUrl: RETURN }))).body;
    expect(failed).toMatchObject({ status: 'payment_failed', statusLabel: 'Payment failed', canCancel: true, payment: { state: 'failed' } });
    expect(eventsOf(failed.id).map((e) => e.payload.status)).toEqual(['payment_failed']);
    const retried = (await k.store('POST', `/orders/${failed.id}/retry`, { method: cardOf('tok_visa'), returnUrl: RETURN }, me)).body;
    expect(retried).toMatchObject({ status: 'placed', payment: { state: 'accepted' } });
    expect(retried.history.map((h: any) => h.status)).toEqual(['payment_pending', 'payment_failed', 'payment_pending', 'placed']);
    expect((await k.store('POST', `/orders/${failed.id}/retry`, { method: cardOf('tok_visa'), returnUrl: RETURN }, me)).body.error.code).toBe('ILLEGAL_TRANSITION');
  });

  it('finishes a bank challenge with complete-action', async () => {
    const t = tractor(k);
    const { me } = shopper();
    const waiting = (await place(me, order(t, { paymentOption: 'pay_in_full', method: cardOf('tok_3ds'), returnUrl: RETURN }))).body;
    expect(waiting).toMatchObject({ status: 'payment_pending', payment: { state: 'requires_action' } });
    const done = (await k.store('POST', `/orders/${waiting.id}/complete-action`, { resultToken: '3ds_ok' }, me)).body;
    expect(done).toMatchObject({ status: 'placed' });
    expect((await k.store('POST', `/orders/${waiting.id}/complete-action`, { resultToken: '3ds_ok' }, me)).body.error.code).toBe('ILLEGAL_TRANSITION');
  });

  it('releases the hold when the customer cancels or the dealer rejects, and leaves a failed capture placed', async () => {
    const t = tractor(k);
    const { me } = shopper();
    const a = (await place(me, order(t, { paymentOption: 'pay_in_full', method: cardOf('tok_visa'), returnUrl: RETURN }))).body;
    const cancelled = (await k.store('POST', `/orders/${a.id}/cancel`, { reason: 'Bought one locally' }, me)).body;
    expect(cancelled).toMatchObject({ status: 'cancelled', canCancel: false, payment: { state: 'voided' } });
    expect(eventsOf(a.id).map((e) => e.name)).toEqual(['farm.order.placed', 'payments.purchase.voided', 'farm.order.status_changed']);

    const b = (await place(me, order(t, { paymentOption: 'pay_in_full', method: cardOf('tok_visa'), returnUrl: RETURN }))).body;
    const rejected = (await move(b.id, 'reject', { note: 'Out of stock until spring' })).body;
    expect(rejected).toMatchObject({ status: 'rejected', dealerNote: 'Out of stock until spring', paymentState: 'voided' });
    expect((await k.store('GET', `/orders/${b.id}`, undefined, me)).body.statusLabel).toBe('Not accepted by Greenfield Agri Equipment');

    // a capture of an amount ending in 22 fails in the development processor
    const odd = tractor(k, { price: 1_889_822 });
    const c = (await place(me, order(odd, { paymentOption: 'pay_in_full', method: cardOf('tok_visa'), returnUrl: RETURN, expectedTotal: usd(2_209_822) }))).body;
    expect(c.status).toBe('placed');
    expect((await move(c.id, 'confirm')).body.error.code).toBe('PAYMENT_CAPTURE_FAILED');
    expect((await k.admin('GET', `/orders/${c.id}`)).body).toMatchObject({ status: 'placed', paymentState: 'accepted' });
  });
});

describe('paying on delivery', () => {
  it('charges the deposit when the dealer confirms, voids it on reject, and follows the depositPercent setting', async () => {
    const t = tractor(k);
    const { me } = shopper();
    const o = (await place(me, order(t))).body;
    expect((await k.admin('GET', `/orders/${o.id}`)).body).toMatchObject({ cardAmount: usd(221_000), deposit: usd(221_000), balance: usd(1_989_000), paymentState: 'accepted', actions: ['confirm', 'reject', 'cancel'] });
    expect((await move(o.id, 'confirm')).status).toBe(200);
    const confirmed = (await k.store('GET', `/orders/${o.id}`, undefined, me)).body;
    expect(confirmed).toMatchObject({ status: 'confirmed', payment: { state: 'captured', amount: usd(221_000) }, depositLabel: '$2,210.00 paid', balanceLabel: '$19,890.00 when it arrives' });
    expect(eventsOf(o.id).map((e) => e.name)).toEqual(['farm.order.placed', 'payments.purchase.captured', 'farm.order.status_changed']);
    expect(eventsOf(o.id).find((e) => e.name === 'payments.purchase.captured')!.payload.amount).toEqual(usd(221_000));
    expect(eventsOf(o.id).at(-1)!.payload).toMatchObject({ status: 'confirmed', paymentOption: 'pay_on_delivery', cardAmount: usd(221_000) });
    expect((await move(o.id, 'cancel')).body.error.code).toBe('REFUND_NOT_AVAILABLE');

    const r = (await place(me, order(t))).body;
    expect((await move(r.id, 'reject', { note: 'No trucks this month' })).body).toMatchObject({ status: 'rejected', paymentState: 'voided' });

    // a declined deposit waits for another try like pay in full
    const declined = (await place(me, order(t, { method: cardOf('tok_declined') }))).body;
    expect(declined).toMatchObject({ status: 'payment_failed', payment: { state: 'failed' } });
    expect((await k.store('POST', `/orders/${declined.id}/retry`, { method: cardOf('tok_visa'), returnUrl: RETURN }, me)).body).toMatchObject({ status: 'placed', payment: { state: 'accepted', amount: usd(221_000) } });

    // 25% of $22,100.01 is $5,525.0025: rounded to whole cents
    k.settingsValues['farm.depositPercent'] = 25;
    const odd = tractor(k, { price: 1_890_001 });
    const q = (await k.store('POST', '/quotes', { productId: odd.product.productId, attachmentIds: [odd.loader.productId], location: farm })).body;
    expect(q).toMatchObject({ depositPercent: 25, deposit: usd(552_500), balance: usd(1_657_501), depositLabel: '$5,525.00 now', balanceLabel: '$16,575.01 when it arrives' });
    expect(q.paymentOptions[2].subtitle).toBe('25% deposit now, the rest when it arrives');
    const quarter = (await place(me, order(odd, { expectedTotal: usd(2_210_001) }))).body;
    expect(quarter).toMatchObject({ status: 'placed', cardAmount: usd(552_500), payment: { amount: usd(552_500) } });
    expect(quarter.paymentLabel).toMatch(/^Pay on delivery · 25% deposit · /);
    delete k.settingsValues['farm.depositPercent'];
  });
});

describe('payment options', () => {
  it('prices the card amount server-side and explains the farm hold instead of the checkout note', async () => {
    const t = tractor(k);
    const { me } = shopper();
    const full = await k.store('GET', `/payment-options?option=pay_in_full&productId=${t.product.productId}&attachmentIds=${t.loader.productId},${t.blade.productId}`, undefined, me);
    expect(full.status, JSON.stringify(full.body)).toBe(200);
    expect(full.body).toMatchObject({ acceptedBrands: expect.any(Array), savedMethods: expect.any(Array), newCard: { clientSecret: expect.any(String) } });
    expect(full.body.chargeNote).toBe("We hold the full amount on your card when you order and charge it when the dealer confirms your delivery date. If the dealer can't take the order or you cancel before then, the hold is released.");
    const deposit = (await k.store('GET', `/payment-options?option=pay_on_delivery&productId=${t.product.productId}`, undefined, me)).body;
    expect(deposit.chargeNote).toBe("We hold the 10% deposit on your card when you order and charge it when the dealer confirms. You pay the rest to the dealer when the machine arrives. If the dealer can't take the order or you cancel before then, the hold is released.");
    k.settingsValues['farm.depositPercent'] = 20;
    expect((await k.store('GET', `/payment-options?option=pay_on_delivery&productId=${t.product.productId}`, undefined, me)).body.chargeNote).toMatch(/^We hold the 20% deposit on your card/);
    delete k.settingsValues['farm.depositPercent'];
    expect((await k.store('GET', `/payment-options?option=installments&productId=${t.product.productId}`, undefined, me)).body.error.code).toBe('VALIDATION_FAILED');
    expect((await k.store('GET', `/payment-options?option=pay_in_full&productId=${newId()}`, undefined, me)).status).toBe(404);
    expect((await k.store('GET', `/payment-options?option=pay_in_full&productId=${t.product.productId}`)).status).toBe(401);
  });
});

describe('expiry, staff lists and the data export', () => {
  it('cancels orders the dealer did not confirm in time and releases the hold', async () => {
    const t = tractor(k);
    const { me } = shopper();
    const o = (await place(me, order(t, { paymentOption: 'pay_in_full', method: cardOf('tok_visa'), returnUrl: RETURN }))).body;
    k.settingsValues['farm.confirmHours'] = 24;
    k.clock.advance(23 * 3_600_000);
    await k.app.kernel.jobs.runNow('farm.expire-unconfirmed');
    await k.app.kernel.events.drain();
    expect((await k.store('GET', `/orders/${o.id}`, undefined, me)).body.status).toBe('placed');
    k.clock.advance(2 * 3_600_000);
    await k.app.kernel.jobs.runNow('farm.expire-unconfirmed');
    await k.app.kernel.events.drain();
    const after = (await k.store('GET', `/orders/${o.id}`, undefined, me)).body;
    expect(after).toMatchObject({ status: 'cancelled', dealerNote: "The dealer didn't confirm the order in time", payment: { state: 'voided' } });
    expect(eventsOf(o.id).at(-1)!.payload).toMatchObject({ status: 'cancelled', note: "The dealer didn't confirm the order in time" });
    delete k.settingsValues['farm.confirmHours'];
  });

  it('lists orders for staff with filters, and exports a customer\'s orders', async () => {
    const t = tractor(k);
    const { accountId, me } = shopper();
    const o = (await place(me, order(t, { paymentOption: 'installments', deliveryDate: '2030-02-20' }))).body;
    const byRef = (await k.admin('GET', `/orders?q=${o.ref}`)).body.items;
    expect(byRef.map((x: any) => x.id)).toEqual([o.id]);
    expect((await k.admin('GET', '/orders?q=Daniel&paymentOption=installments')).body.items.map((x: any) => x.id)).toContain(o.id);
    expect((await k.admin('GET', `/orders?dealerId=${salem.id}&paymentOption=pay_on_delivery`)).body.items).toEqual([]);
    expect((await k.admin('GET', '/orders', undefined, k.staff(['farm.view']))).status).toBe(200);
    expect((await move(o.id, 'confirm', {}, )).status).toBe(200);
    expect((await k.call('POST', `/api/admin/farm/orders/${o.id}/status`, { action: 'dispatch' }, k.staff(['farm.view']))).status).toBe(403);

    const api = k.app.kernel.boot.apis.get('farm') as { exportCustomerData(i: { customerId: string; accountId: string }): Promise<any[]> };
    const sections = await api.exportCustomerData({ customerId: accountId, accountId });
    expect(sections).toHaveLength(1);
    expect(sections[0]).toMatchObject({ key: 'farm_orders', module: 'farm', records: [{ reference: o.ref, dealer: 'Greenfield Agri Equipment', machine: { name: 'Kubota L2502 compact tractor' }, payment: 'Installments · 12 months, subject to approval', deliveryDate: '2030-02-20', status: 'confirmed' }] });
    expect(await api.exportCustomerData({ customerId: newId(), accountId: newId() })).toEqual([]);
  });
});
