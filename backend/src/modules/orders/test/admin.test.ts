import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { newId } from '../../../kernel/lib/ids.js';
import { auth } from '../../../testing/app.js';
import { checkout, group, harness, idem, line, product, tokens, type Harness } from './helpers.js';

let h: Harness;
beforeAll(async () => {
  h = await harness();
});
afterAll(async () => {
  await h.app.close();
});

async function order() {
  const customerId = newId();
  const sellerA = newId();
  const sellerB = newId();
  const pa = product(h, { title: 'Speaker', price: 5000, sellerId: sellerA, sellerName: 'Pixel & Port' });
  const pb = product(h, { title: 'Throw', price: 4000, sellerId: sellerB });
  const o = await h.service.createOrder(checkout([group(h, [line(pa, 2, { discount: 800, code: 'WELCOME20' })], { sellerId: sellerA }), group(h, [line(pb, 1)], { sellerId: sellerB })], { customerId }));
  await h.app.kernel.events.drain();
  return { o, customerId, sellerA, sellerB };
}

describe('admin orders', () => {
  it('lists with filters and shows the order 360 with contact masked unless permitted', async () => {
    const { o, sellerA } = await order();
    const all = tokens.staff();
    const list = await h.call('GET', `/api/admin/orders/orders?sellerId=${sellerA}`, all);
    expect(list.status).toBe(200);
    expect(list.body.items.map((r: any) => r.id)).toEqual([o.id]);
    expect(list.body.items[0]).toMatchObject({ ref: o.ref, guest: false, itemCount: 3, paymentState: 'authorized', customerCity: 'Portland' });
    expect((await h.call('GET', `/api/admin/orders/orders?q=${o.ref}&fulfillmentStatus=new&sellerType=marketplace`, all)).body.items).toHaveLength(1);
    expect((await h.call('GET', `/api/admin/orders/orders?q=${o.ref}&fulfillmentStatus=delivered`, all)).body.items).toHaveLength(0);

    const full = await h.call('GET', `/api/admin/orders/orders/${o.id}`, all);
    expect(full.status).toBe(200);
    expect(full.body.customer.email).toBe('sam@example.com');
    expect(full.body.moneyBySeller.map((m: any) => m.platformFunded.amount)).toEqual([800, 0]);
    expect(full.body.couponFundingNote).toMatch(/WELCOME20 is platform-funded/);
    expect(full.body.allowedActions).toEqual(expect.arrayContaining(['cancel_items', 'add_note', 'extend_deadline', 'resend_confirmation']));

    const viewer = tokens.staff(['orders.orders.view']);
    const masked = await h.call('GET', `/api/admin/orders/orders/${o.id}`, viewer);
    expect(masked.body.customer.email).toBe('s***@example.com');
    expect(masked.body.order.contact.email).toBe('s---@example.com');
    expect(masked.body.customer.phone).toBe('***42');
    expect((await h.call('GET', `/api/admin/orders/orders/${newId()}`, all)).status).toBe(404);

    const viaApi = await h.service.getOrderAdmin(o.ref);
    expect(viaApi!.customer.email).toBe('s***@example.com');
    expect((await h.service.listOrdersAdmin({ sellerId: sellerA }, {})).items.map((x) => x.order.id)).toEqual([o.id]);
    expect((await h.service.countOrdersForSellers([sellerA]))[sellerA]).toMatchObject({ open: 1, overdueDispatch: 0, cancellationRequests: 0 });
  });

  it('adds internal notes (audited, never shown to customers) and resends the confirmation', async () => {
    const { o, customerId } = await order();
    const staff = tokens.staff();
    const note = await h.call('POST', `/api/admin/orders/orders/${o.id}/notes`, staff, { text: 'Called the customer about the address' });
    expect(note.status).toBe(201);
    expect(h.audits.at(-1)).toMatchObject({ action: 'orders.note.add', module: 'orders', category: 'orders', target: { type: 'order', id: o.id } });
    const detail = await h.call('GET', `/api/admin/orders/orders/${o.id}`, staff);
    expect(detail.body.notes[0].text).toBe('Called the customer about the address');
    const store = await h.call('GET', `/api/store/orders/orders/${o.id}`, tokens.customer(customerId));
    expect(JSON.stringify(store.body)).not.toContain('Called the customer');

    const resend = await h.call('POST', `/api/admin/orders/orders/${o.id}/resend-confirmation`, staff, { email: 'new@example.com' });
    expect(resend.status).toBe(202);
    expect(h.named('orders.confirmation.requested').at(-1)).toEqual({ orderId: o.id, email: 'new@example.com' });
    const history = await h.call('GET', `/api/admin/orders/orders/${o.id}/history?visibility=staff`, staff);
    expect(history.body.items.map((e: any) => e.label)).toContain('Confirmation resent');
  });

  it('cancels items as staff with a reason and carries the trust report id', async () => {
    const { o } = await order();
    const staff = tokens.staff();
    const trustReportId = newId();
    const item = o.groups[1]!.items[0]!;
    const res = await h.call('POST', `/api/admin/orders/orders/${o.id}/cancel-items`, staff, { items: [{ itemId: item.id, quantity: 1 }], reasonCode: 'seller_cannot_fulfill', reason: 'Seller confirmed no stock', notifyCustomer: true, trustReportId }, idem());
    expect(res.status).toBe(201);
    expect(res.body.requests[0]).toMatchObject({ status: 'accepted', initiatedBy: 'staff' });
    expect(h.named('orders.item.cancelled').find((e) => e.itemId === item.id)).toMatchObject({ initiatedBy: 'staff', countsAgainstSeller: true, trustReportId });
    expect(h.audits.at(-1)).toMatchObject({ action: 'orders.items.cancel', reason: 'Seller confirmed no stock' });
  });

  it('decides a customer request for the seller and overrides a decline', async () => {
    const { o, customerId, sellerA } = await order();
    const staff = tokens.staff(['orders.orders.view', 'orders.cancellations.decide']);
    const me = tokens.customer(customerId);
    const item = o.groups[0]!.items[0]!;
    const req = (await h.call('POST', `/api/store/orders/orders/${o.id}/cancellations`, me, { items: [{ itemId: item.id, quantity: 2 }], reasonCode: 'changed_mind' }, idem())).body.requests[0];
    const declined = await h.call('POST', `/api/seller/orders/orders/${o.groups[0]!.id}/cancellation-requests/${req.id}/decline`, tokens.seller(sellerA), { reason: 'other', note: 'Engraved already' });
    expect(declined.body.status).toBe('declined');
    expect((await h.service.getOrder(o.id))!.groups[0]!.items[0]!.state).toBe('confirmed');
    const override = await h.call('POST', `/api/admin/orders/orders/${o.id}/cancellation-requests/${req.id}/decide`, staff, { accept: true, reason: 'Not engraved per photos' }, idem());
    expect(override.status).toBe(200);
    expect(override.body.status).toBe('accepted');
    expect(h.audits.at(-1)).toMatchObject({ action: 'orders.cancellation.override' });
    expect(h.named('orders.item.cancelled').find((e) => e.cancellationId === req.id)).toBeTruthy();
    const twice = await h.call('POST', `/api/admin/orders/orders/${o.id}/cancellation-requests/${req.id}/decide`, staff, { accept: false, reason: 'oops' }, idem());
    expect(twice.status).toBe(409);
  });

  it('keeps saved filters per staff member; shared ones are deleted by their owner or a manager', async () => {
    const owner = newId();
    const other = newId();
    const mine = tokens.staff(['orders.orders.view'], { sub: owner });
    const theirs = tokens.staff(['orders.orders.view'], { sub: other });
    const manager = tokens.staff(['orders.orders.view', 'orders.orders.manage'], { sub: newId() });
    const priv = (await h.call('POST', '/api/admin/orders/saved-filters', mine, { name: 'Mine', query: { paymentState: 'pending_check' } })).body;
    const shared = (await h.call('POST', '/api/admin/orders/saved-filters', mine, { name: 'Team', query: { flag: 'case_open' }, shared: true })).body;
    expect(priv).toMatchObject({ name: 'Mine', shared: false, owner: { kind: 'staff', id: owner } });
    const seen = (await h.call('GET', '/api/admin/orders/saved-filters', theirs)).body.map((f: any) => f.id);
    expect(seen).toContain(shared.id);
    expect(seen).not.toContain(priv.id);
    expect((await h.call('DELETE', `/api/admin/orders/saved-filters/${priv.id}`, theirs)).status).toBe(404);
    expect((await h.call('DELETE', `/api/admin/orders/saved-filters/${shared.id}`, theirs)).status).toBe(403);
    expect((await h.call('DELETE', `/api/admin/orders/saved-filters/${shared.id}`, manager)).status).toBe(204);
    expect((await h.call('DELETE', `/api/admin/orders/saved-filters/${priv.id}`, mine)).status).toBe(204);
    expect((await h.call('POST', '/api/admin/orders/saved-filters', mine, { name: ' ', query: [] })).status).toBe(400);
  });

  it('exports through reports, logged, with contact masked unless permitted', async () => {
    const { o } = await order();
    const staff = tokens.staff(['orders.orders.view', 'orders.orders.export']);
    const res = await h.call('POST', '/api/admin/orders/exports', staff, { filters: { q: o.ref, __ordersContactVisible: true }, format: 'csv' });
    expect(res.status).toBe(202);
    const req = h.exports.requested.at(-1);
    expect(req).toMatchObject({ dataset: 'orders.admin.orders', format: 'csv' });
    // a flag in the filters is never trusted (and not stored)
    expect(req.filters).not.toHaveProperty('__ordersContactVisible');
    expect(h.audits.at(-1)).toMatchObject({ action: 'orders.export' });
    expect(h.exports.registered).toEqual(expect.arrayContaining(['orders.admin.orders', 'orders.seller.orders']));
    const got = await h.call('GET', `/api/admin/orders/exports/${res.body.id}`, staff);
    expect(got.body.downloadUrl).toMatch(/^https:/);
    // rows are masked unless the requester holds orders.customers.view-contact (the answer their request got)
    const rows = await h.service.exportRows('orders.admin.orders', { ...req.filters, __ordersContactVisible: true }, req.principal);
    expect(rows.rows).toEqual([expect.objectContaining({ ref: o.ref, customerEmail: 's***@example.com', customerPhone: '***42' })]);
    const stranger = { kind: 'staff', sessionId: newId(), accountId: newId() } as never;
    expect((await h.service.exportRows('orders.admin.orders', req.filters, stranger)).rows[0]).toMatchObject({ customerEmail: 's***@example.com' });

    const contactStaff = tokens.staff(['orders.orders.view', 'orders.orders.export', 'orders.customers.view-contact']);
    expect((await h.call('POST', '/api/admin/orders/exports', contactStaff, { filters: { q: o.ref }, format: 'csv' })).status).toBe(202);
    const req2 = h.exports.requested.at(-1);
    const open = await h.service.exportRows('orders.admin.orders', req2.filters, req2.principal);
    expect(open.rows[0]).toMatchObject({ customerEmail: 'sam@example.com', customerPhone: '+15035550142' });
  });

  it('unmasks the in-process admin read only for a principal allowed to see contact details', async () => {
    const { o } = await order();
    expect((await h.service.getOrderAdmin(o.ref))!.customer.email).toBe('s***@example.com');
    const contactStaff = tokens.staff(['orders.orders.view', 'orders.orders.export', 'orders.customers.view-contact']);
    expect((await h.call('POST', '/api/admin/orders/exports', contactStaff, { filters: {}, format: 'csv' })).status).toBe(202);
    expect((await h.service.getOrderAdmin(o.ref, h.exports.requested.at(-1).principal))!.customer.email).toBe('sam@example.com');
    const plainStaff = tokens.staff(['orders.orders.view', 'orders.orders.export']);
    expect((await h.call('POST', '/api/admin/orders/exports', plainStaff, { filters: {}, format: 'csv' })).status).toBe(202);
    expect((await h.service.getOrderAdmin(o.ref, h.exports.requested.at(-1).principal))!.customer.email).toBe('s***@example.com');
  });
});

describe('GraphQL read layer', () => {
  const gql = (area: string, token: string, query: string, variables: Record<string, unknown> = {}) =>
    h.app.inject({ method: 'POST', url: `/graphql/${area}`, headers: { ...auth(token), 'content-type': 'application/json' }, payload: { query, variables } }).then((r) => JSON.parse(r.body));

  it('store: the customer’s own order by reference; another customer gets null', async () => {
    const { o, customerId } = await order();
    const q = `query($ref: String!) { order(ref: $ref) { id ref status statusFlags lifecycle summaryLine totals { total { amount formatted } } groups { id status seller { name official } items { id title state offerTerms { condition } actions } } progress { payment { state } delivery { state } } } }`;
    const mine = await gql('store', tokens.customer(customerId), q, { ref: o.ref });
    expect(mine.errors).toBeUndefined();
    expect(mine.data.order).toMatchObject({ id: o.id, status: 'CONFIRMED', lifecycle: 'OPEN', progress: { payment: { state: 'ACCEPTED' } } });
    expect(mine.data.order.groups[0].items[0]).toMatchObject({ state: 'CONFIRMED', offerTerms: { condition: 'NEW' } });
    expect(mine.data.order.totals.total.formatted).toMatch(/^\$/);
    const other = await gql('store', tokens.customer(newId()), q, { ref: o.ref });
    expect(other.data.order).toBeNull();
    const list = await gql('store', tokens.customer(customerId), `{ orders(filter: { tab: IN_PROGRESS }) { items { ref } total } }`);
    expect(list.data.orders.items.map((x: any) => x.ref)).toEqual([o.ref]);
  });

  it('seller: only the caller’s own groups; admin: the whole order', async () => {
    const { o, sellerA } = await order();
    const q = `query($ref: String!) { sellerOrder(ref: $ref) { id buyerName mixedOrderNote groups { id items { title shippedQuantity } nextAction allowedActions deadlineLabel money { itemSubtotal { amount } } } } }`;
    const res = await gql('seller', tokens.seller(sellerA), q, { ref: o.ref });
    expect(res.errors).toBeUndefined();
    expect(res.data.sellerOrder.groups.map((g: any) => g.id)).toEqual([o.groups[0]!.id]);
    expect(res.data.sellerOrder).toMatchObject({ buyerName: 'Sam R.', groups: [{ nextAction: 'PREPARE', items: [{ title: 'Speaker', shippedQuantity: 0 }] }] });
    expect((await gql('seller', tokens.seller(newId()), q, { ref: o.ref })).data.sellerOrder).toBeNull();
    const counts = await gql('seller', tokens.seller(sellerA), `{ sellerOrderCounts { new preparing overdue } }`);
    expect(counts.data.sellerOrderCounts.new).toBe(1);
    const admin = await gql('admin', tokens.staff(), `query($ref: String!) { orderAdmin(ref: $ref) { id channel groups { id } moneyBySeller { companySale } flags { kind } customer { email } } }`, { ref: o.ref });
    expect(admin.errors).toBeUndefined();
    expect(admin.data.orderAdmin.groups).toHaveLength(2);
    expect(admin.data.orderAdmin.channel).toBe('WEB');
  });
});
