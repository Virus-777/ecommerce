import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { callers } from '../../../testing/app.js';
import { address, boot, STORE, type Kit } from './helpers.js';

let kit: Kit;
beforeAll(async () => {
  kit = await boot();
});
afterAll(() => kit.app.close());

describe('customer record from identity', () => {
  it('creates the profile, default preferences and consent log on identity.user.registered (idempotent)', async () => {
    const c = await kit.customer({ firstName: 'Mia', lastName: 'Chen', marketingOptIn: true });
    expect(kit.of('customers.customer.created')).toContainEqual({ customerId: c.customerId, userId: c.accountId });
    const snap = await kit.service.getCustomerByUserId(c.accountId);
    expect(snap).toMatchObject({ id: c.customerId, userId: c.accountId, displayName: 'Mia Chen', email: c.email, accountStatus: 'active', canOrder: true, canMessage: true });
    expect(snap!.ref).toMatch(/^CU-\d{6}$/);
    const prefs = await kit.service.getMarketingConsent(c.customerId);
    expect(prefs).toMatchObject({ emailPromotions: true, smsPromotions: false, pushPromotions: false, essentialAlwaysOn: true });

    // the same event again changes nothing
    const before = kit.of('customers.customer.created').length;
    await kit.publish('identity', 'identity.user.registered', { accountId: c.accountId, email: c.email, firstName: 'X', lastName: 'Y', marketingOptIn: false, acceptedTermsVersion: '1', at: new Date().toISOString() });
    expect(kit.of('customers.customer.created').length).toBe(before);
    expect((await kit.service.getCustomer(c.customerId))!.displayName).toBe('Mia Chen');
  });

  it('marks email and phone verified and mirrors email changes', async () => {
    const c = await kit.customer();
    await kit.publish('identity', 'identity.user.verified', { accountId: c.accountId, channel: 'email', email: c.email, at: new Date().toISOString() });
    let p = (await kit.call('GET', `${STORE}/profile`, { token: c.token })).body;
    expect(p.emailVerified).toBe(true);
    await kit.publish('identity', 'identity.email.changed', { accountId: c.accountId, oldEmail: c.email, newEmail: 'New.Address@Example.com' });
    p = (await kit.call('GET', `${STORE}/profile`, { token: c.token })).body;
    expect(p).toMatchObject({ email: 'new.address@example.com', emailVerified: true });
    await kit.publish('identity', 'identity.user.verified', { accountId: c.accountId, channel: 'phone', email: 'new.address@example.com', phone: '+15035550100', at: new Date().toISOString() });
    p = (await kit.call('GET', `${STORE}/profile`, { token: c.token })).body;
    expect(p).toMatchObject({ phone: '+15035550100', phoneVerified: true });
  });

  it('a signed-in account without a customer profile (and unknown to identity) is not found', async () => {
    const res = await kit.call('GET', `${STORE}/profile`, { token: callers.customer() });
    expect(res.status).toBe(404);
  });
});

describe('profile', () => {
  it('changes names and phone; a new phone is unverified; publishes the changed fields', async () => {
    const c = await kit.customer();
    await kit.publish('identity', 'identity.user.verified', { accountId: c.accountId, channel: 'phone', email: c.email, phone: '+15035550100', at: new Date().toISOString() });
    const res = await kit.call('PATCH', `${STORE}/profile`, { token: c.token, body: { firstName: ' Ana  María ', phone: '(503) 555-0199' } });
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    expect(res.body).toMatchObject({ firstName: 'Ana María', displayName: 'Ana María Lopez', phone: '+15035550199', phoneVerified: false });
    expect(kit.of('customers.profile.updated').at(-1)).toEqual({ customerId: c.customerId, fields: ['firstName', 'phone'] });

    const same = kit.of('customers.profile.updated').length;
    await kit.call('PATCH', `${STORE}/profile`, { token: c.token, body: { firstName: 'Ana María' } });
    expect(kit.of('customers.profile.updated').length).toBe(same);
  });

  it('refuses blank names and malformed phones', async () => {
    const c = await kit.customer();
    let res = await kit.call('PATCH', `${STORE}/profile`, { token: c.token, body: { lastName: '  ' } });
    expect(res.status).toBe(400);
    expect(res.body.error.details.issues[0].path).toBe('lastName');
    res = await kit.call('PATCH', `${STORE}/profile`, { token: c.token, body: { phone: 'call me' } });
    expect(res.status).toBe(400);
  });
});

describe('addresses', () => {
  it('first address becomes default; makeDefault moves it; list is default first', async () => {
    const c = await kit.customer();
    const a = await kit.call('POST', `${STORE}/addresses`, { token: c.token, body: { label: 'Home', address: address() } });
    expect(a.status, JSON.stringify(a.body)).toBe(201);
    expect(a.body).toMatchObject({ label: 'Home', isDefault: true });
    expect(kit.of('customers.address.saved').at(-1)).toEqual({ customerId: c.customerId, addressId: a.body.id, isDefault: true });
    const b = await kit.call('POST', `${STORE}/addresses`, { token: c.token, body: { label: 'Work', address: address({ line1: '9 Oak Ave' }), makeDefault: true } });
    expect(b.body.isDefault).toBe(true);
    let list = (await kit.call('GET', `${STORE}/addresses`, { token: c.token })).body;
    expect(list.map((x: any) => [x.label, x.isDefault])).toEqual([['Work', true], ['Home', false]]);
    expect((await kit.call('GET', `${STORE}/profile`, { token: c.token })).body.defaultAddressId).toBe(b.body.id);

    list = (await kit.call('POST', `${STORE}/addresses/${a.body.id}/make-default`, { token: c.token })).body;
    expect(list[0]).toMatchObject({ id: a.body.id, isDefault: true });
  });

  it('validates format, region and PO boxes', async () => {
    const c = await kit.customer();
    let res = await kit.call('POST', `${STORE}/addresses`, { token: c.token, body: { address: address({ postalCode: '9720' }) } });
    expect(res.status).toBe(400);
    expect(res.body.error.details.issues[0]).toMatchObject({ path: 'address.postalCode', field: 'postalCode', code: 'invalid_format' });
    res = await kit.call('POST', `${STORE}/addresses`, { token: c.token, body: { address: address({ country: 'CA', region: 'BC', postalCode: 'V6B 1A1' }) } });
    expect(res.status).toBe(422);
    expect(res.body.error.code).toBe('ADDRESS_UNDELIVERABLE');
    res = await kit.call('POST', `${STORE}/addresses`, { token: c.token, body: { address: address({ line1: 'PO Box 123' }) } });
    expect(res.status).toBe(422);
    expect(res.body.error.details.issues[0].code).toBe('po_box_not_allowed');
  });

  it('POST /addresses/validate works for visitors and suggests a normalised address', async () => {
    const res = await kit.call('POST', `${STORE}/addresses/validate`, { token: callers.visitor(), body: address({ line1: '123 main street', region: 'or' }) });
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ valid: true, deliverable: true, poBox: false, issues: [] });
    expect(res.body.suggestion).toMatchObject({ line1: '123 Main St', region: 'OR' });
    const unknown = await kit.call('POST', `${STORE}/addresses/validate`, { token: callers.visitor(), body: address({ postalCode: '00000' }) });
    expect(unknown.body.issues.map((i: any) => i.code)).toContain('not_found');
  });

  it('enforces maxAddresses', async () => {
    const c = await kit.customer();
    for (let i = 0; i < 20; i++) {
      const r = await kit.call('POST', `${STORE}/addresses`, { token: c.token, body: { address: address({ line1: `${i + 1} Elm St` }) } });
      expect(r.status).toBe(201);
    }
    const res = await kit.call('POST', `${STORE}/addresses`, { token: c.token, body: { address: address({ line1: '99 Elm St' }) } });
    expect(res.status).toBe(409);
    expect(res.body.error.code).toBe('ADDRESS_LIMIT_REACHED');
  });

  it('edits never change the copy checkout took; deleting the default promotes the most recently used', async () => {
    const c = await kit.customer();
    const a = (await kit.call('POST', `${STORE}/addresses`, { token: c.token, body: { address: address() } })).body;
    const b = (await kit.call('POST', `${STORE}/addresses`, { token: c.token, body: { address: address({ line1: '2 Pine St' }) } })).body;
    const d = (await kit.call('POST', `${STORE}/addresses`, { token: c.token, body: { address: address({ line1: '3 Fir St' }) } })).body;
    const copy = await kit.service.getAddressForOrder(c.customerId, a.id);
    const upd = await kit.call('PATCH', `${STORE}/addresses/${a.id}`, { token: c.token, body: { address: address({ line1: '500 New Rd' }), deliveryInstructions: 'Leave at door' } });
    expect(upd.status).toBe(200);
    expect(upd.body).toMatchObject({ address: { line1: '500 New Rd' }, deliveryInstructions: 'Leave at door' });
    expect(copy.line1).toBe('123 Main Street');

    // an order delivered to b makes it the most recently used
    await kit.publish('orders', 'orders.order.placed', placed(c.customerId, b.id));
    expect((await kit.call('DELETE', `${STORE}/addresses/${a.id}`, { token: c.token })).status).toBe(204);
    const list = (await kit.call('GET', `${STORE}/addresses`, { token: c.token })).body;
    expect(list.map((x: any) => x.id).sort()).toEqual([b.id, d.id].sort());
    expect(list.filter((x: any) => x.isDefault)).toHaveLength(1);
    await expect(kit.service.getAddressForOrder(c.customerId, a.id)).rejects.toMatchObject({ code: 'NOT_FOUND' });
  });

  it("another customer's address is not found", async () => {
    const owner = await kit.customer();
    const other = await kit.customer();
    const a = (await kit.call('POST', `${STORE}/addresses`, { token: owner.token, body: { address: address() } })).body;
    for (const [method, url, body] of [
      ['PATCH', `${STORE}/addresses/${a.id}`, { address: address() }],
      ['DELETE', `${STORE}/addresses/${a.id}`, undefined],
      ['POST', `${STORE}/addresses/${a.id}/make-default`, undefined],
    ] as const) {
      const res = await kit.call(method, url, { token: other.token, body });
      expect(res.status, `${method} ${url}`).toBe(404);
    }
    await expect(kit.service.getAddressForOrder(other.customerId, a.id)).rejects.toMatchObject({ code: 'NOT_FOUND' });
  });

  it('rememberCheckoutAddress reuses an identical address', async () => {
    const c = await kit.customer();
    const first = await kit.service.rememberCheckoutAddress(c.customerId, address(), 'Home');
    const again = await kit.service.rememberCheckoutAddress(c.customerId, address({ line1: '123  MAIN street' }));
    expect(again.id).toBe(first.id);
    expect((await kit.service.listAddresses({ kind: 'customer', accountId: c.accountId, customerId: c.customerId })).length).toBe(1);
  });
});

function placed(customerId: string, deliveryAddressId: string | null = null) {
  return {
    attemptNo: 1,
    contactName: 'Ana Lopez',
    deliveryAddressId,
    orderId: crypto.randomUUID(),
    ref: 'MK-261009-00001',
    checkoutSessionId: crypto.randomUUID(),
    customerId,
    guestEmail: null,
    paymentIntentId: crypto.randomUUID(),
    paymentState: 'accepted',
    total: { amount: 5000, currency: 'USD' },
    couponCodes: [],
    groups: [],
    placedAt: new Date().toISOString(),
  };
}
