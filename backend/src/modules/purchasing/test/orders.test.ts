/** Suppliers, price lists and purchase orders: create, edit, send (with approval), cancel. */
import type { FastifyInstance } from 'fastify';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { newId } from '../../../kernel/lib/ids.js';
import { api, auditActions, ken, LOCATION, makeStubs, purchasingApp, recordEvents, staffAuth, usd } from './helpers.js';

const stubs = makeStubs();
let app: FastifyInstance;
let call: ReturnType<typeof api>;
let events: Record<string, any[]>;
const headphones = stubs.addStock({ sku: 'HAL-AUR-BLK', label: 'Halden Aurora ANC Headphones, Black' });
const speaker = stubs.addStock({ sku: 'HAL-PKT-TEAL', label: 'Pocket Bluetooth Speaker, Teal' });
const sellerItem = stubs.addStock({ sku: 'CV-MUG', label: 'Casa Verde mug', ownerType: 'seller' });

beforeAll(async () => {
  ({ app } = await purchasingApp(stubs));
  call = api(app);
  events = recordEvents(app, ['purchasing.purchase_order.sent', 'purchasing.purchase_order.status_changed', 'purchasing.delivery.rescheduled']);
});
afterAll(async () => {
  await app?.close();
});
beforeEach(() => {
  stubs.inventory.expectIncoming.mockClear();
  stubs.inventory.cancelIncoming.mockClear();
  stubs.audit.record.mockClear();
});

const supplierInput = (over: object = {}) => ({
  name: 'Halden Audio Distribution',
  contactName: 'Lena Ortiz',
  email: 'orders@halden.example',
  address: { name: 'Halden Audio', line1: '1 Main St', city: 'Los Angeles', region: 'CA', postalCode: '90001', country: 'US' },
  paymentTerms: 'Net 30 from invoice',
  leadTimeDays: 7,
  ...over,
});

async function supplier(over: object = {}) {
  const res = await call('POST', '/suppliers', supplierInput(over));
  expect(res.statusCode, res.body).toBe(201);
  return res.json();
}

async function draft(supplierId: string, lines: object[] = [{ stockItemId: headphones, quantity: 100, unitCost: usd(9500) }], over: object = {}) {
  const res = await call('POST', '/purchase-orders', { supplierId, shipToLocationId: LOCATION, lines, freight: usd(32000), expectedDate: '2026-10-16', ...over });
  expect(res.statusCode, res.body).toBe(201);
  return res.json();
}

describe('suppliers', () => {
  it('adds, lists, edits and deactivates suppliers (audited)', async () => {
    const s = await supplier();
    expect(s).toMatchObject({ name: 'Halden Audio Distribution', location: 'Los Angeles, CA', paymentTerms: 'Net 30 from invoice', leadTimeDays: 7, active: true, openPurchaseOrders: 0 });
    expect(auditActions(stubs)).toEqual(['purchasing.supplier.create']);

    const list = await call('GET', '/suppliers?q=halden');
    expect(list.statusCode).toBe(200);
    expect(list.json().items.map((x: { id: string }) => x.id)).toContain(s.id);

    const off = await call('PATCH', `/suppliers/${s.id}`, { name: s.name, active: false });
    expect(off.statusCode, off.body).toBe(200);
    expect(off.json()).toMatchObject({ active: false, email: 'orders@halden.example' });
    expect(auditActions(stubs)).toContain('purchasing.supplier.deactivate');
    expect((await call('GET', '/suppliers?active=false')).json().items.some((x: { id: string }) => x.id === s.id)).toBe(true);

    expect((await call('PATCH', `/suppliers/${newId()}`, { name: 'x' })).statusCode).toBe(404);
    expect((await call('POST', '/suppliers', { name: '  ' })).json().error.code).toBe('VALIDATION_FAILED');
  });

  it('replaces the price list with company stock only; one preferred supplier per SKU', async () => {
    const a = await supplier({ name: 'Supplier A' });
    const b = await supplier({ name: 'Supplier B' });
    const bad = await call('PUT', `/suppliers/${a.id}/items`, { items: [{ stockItemId: sellerItem, unitCost: usd(100) }] });
    expect(bad.statusCode).toBe(400);
    expect(bad.json().error).toMatchObject({ code: 'STOCK_ITEM_NOT_COMPANY', details: { stockItemIds: [sellerItem] } });

    const res = await call('PUT', `/suppliers/${a.id}/items`, { items: [{ stockItemId: headphones, supplierSku: 'H-1', unitCost: usd(9500), minOrderQuantity: 20, preferred: true }] });
    expect(res.statusCode, res.body).toBe(200);
    expect(res.json()).toEqual([expect.objectContaining({ stockItemId: headphones, sku: 'HAL-AUR-BLK', label: 'Halden Aurora ANC Headphones, Black', unitCost: usd(9500), preferred: true })]);
    expect(auditActions(stubs)).toContain('purchasing.supplier.price_list_replace');

    await call('PUT', `/suppliers/${b.id}/items`, { items: [{ stockItemId: headphones, unitCost: usd(9900), preferred: true }] });
    const detailA = (await call('GET', `/suppliers/${a.id}`)).json();
    expect(detailA.items[0].preferred).toBe(false);
    expect(detailA.performance).toMatchObject({ windowDays: 90, deliveries: 0, onTimePct: null });

    const pref = await (app.kernel.boot.apis.get('purchasing') as any).getPreferredSupplier(headphones);
    expect(pref).toEqual({ supplierId: b.id, name: 'Supplier B', supplierSku: null, unitCost: usd(9900), returnAuthorizationRequired: false });
  });
});

describe('purchase orders', () => {
  it('creates a draft with lines, freight and a PUR-YYMM-NNNN reference', async () => {
    const s = await supplier();
    const po = await draft(s.id, [
      { stockItemId: headphones, quantity: 100, unitCost: usd(9500) },
      { stockItemId: speaker, quantity: 120, unitCost: usd(3850), expectedDate: '2026-10-20' },
    ]);
    expect(po.ref).toMatch(/^PUR-2610-\d{4}$/);
    expect(po).toMatchObject({
      status: 'draft',
      supplier: { id: s.id, name: s.name, location: 'Los Angeles, CA' },
      linesSubtotal: usd(950000 + 462000),
      freight: usd(32000),
      total: usd(1444000),
      paymentTerms: 'Net 30 from invoice',
      approval: null,
      createdBy: { kind: 'staff', id: ken.id, name: 'Ken Watanabe' },
    });
    expect(po.lines[1]).toMatchObject({ sku: 'HAL-PKT-TEAL', quantityOrdered: 120, quantityOpen: 120, lineTotal: usd(462000), expectedDate: '2026-10-20' });
    expect(po.timeline[0]).toMatchObject({ label: 'Draft created', actor: { id: ken.id } });
    expect(auditActions(stubs).at(-1)).toBe('purchasing.purchase_order.create');

    const rows = (await call('GET', `/purchase-orders?supplierId=${s.id}`)).json().items;
    expect(rows).toEqual([expect.objectContaining({ ref: po.ref, lineCount: 2, units: 220, total: usd(1444000), expectedLabel: 'Oct 16', status: 'draft', lateOrShort: false })]);
    expect((await call('GET', `/purchase-orders?q=HAL-PKT`)).json().items.some((r: { id: string }) => r.id === po.id)).toBe(true);
  });

  it('refuses inactive suppliers, seller stock and bad lines', async () => {
    const s = await supplier();
    await call('PATCH', `/suppliers/${s.id}`, { name: s.name, active: false });
    const inactive = await call('POST', '/purchase-orders', { supplierId: s.id, shipToLocationId: LOCATION, lines: [{ stockItemId: headphones, quantity: 1, unitCost: usd(1) }] });
    expect(inactive.statusCode).toBe(409);
    expect(inactive.json().error.code).toBe('SUPPLIER_INACTIVE');

    const ok = await supplier();
    const seller = await call('POST', '/purchase-orders', { supplierId: ok.id, shipToLocationId: LOCATION, lines: [{ stockItemId: sellerItem, quantity: 1, unitCost: usd(1) }] });
    expect(seller.json().error.code).toBe('STOCK_ITEM_NOT_COMPANY');
    const unknown = await call('POST', '/purchase-orders', { supplierId: ok.id, shipToLocationId: LOCATION, lines: [{ stockItemId: newId(), quantity: 1, unitCost: usd(1) }] });
    expect(unknown.json().error.code).toBe('STOCK_ITEM_NOT_COMPANY');
    const zero = await call('POST', '/purchase-orders', { supplierId: ok.id, shipToLocationId: LOCATION, lines: [{ stockItemId: headphones, quantity: 0, unitCost: usd(1) }] });
    expect(zero.json().error).toMatchObject({ code: 'VALIDATION_FAILED', details: { issues: [{ path: 'lines.0.quantity' }] } });
  });

  it('edits a draft (lines replaced, total recomputed)', async () => {
    const s = await supplier();
    const po = await draft(s.id);
    const res = await call('PATCH', `/purchase-orders/${po.id}`, { lines: [{ stockItemId: speaker, quantity: 10, unitCost: usd(4000) }], freight: usd(0), notes: 'Small trial order' });
    expect(res.statusCode, res.body).toBe(200);
    expect(res.json()).toMatchObject({ total: usd(40000), notes: 'Small trial order', lines: [expect.objectContaining({ sku: 'HAL-PKT-TEAL' })] });
    expect(auditActions(stubs).at(-1)).toBe('purchasing.purchase_order.update');
  });

  it('sends within the limit: Sent, Incoming in inventory, supplier emailed, events and audit', async () => {
    const s = await supplier();
    const po = await draft(s.id);
    const res = await call('POST', `/purchase-orders/${po.id}/send`, { emailSupplier: true });
    expect(res.statusCode, res.body).toBe(200);
    expect(res.json()).toMatchObject({ status: 'sent', sentAt: expect.any(String), approval: null });
    expect(stubs.access.check).toHaveBeenLastCalledWith(expect.objectContaining({ kind: 'staff', accountId: ken.id }), 'purchasing.orders.send', { money: usd(982000) });
    expect(stubs.inventory.expectIncoming).toHaveBeenCalledWith(po.id, po.ref, LOCATION, [{ stockItemId: headphones, quantity: 100, expectedDate: '2026-10-16' }]);
    // the supplier email is sent by notifications from the event, not called directly
    expect(stubs.notifications.notify).not.toHaveBeenCalled();
    await app.kernel.events.drain();
    expect(events['purchasing.purchase_order.sent']!.at(-1)).toMatchObject({ purchaseOrderId: po.id, supplierId: s.id, supplierName: s.name, supplierEmail: 'orders@halden.example', emailSupplier: true, message: null, locationId: LOCATION, total: usd(982000) });
    expect(events['purchasing.purchase_order.status_changed']!.at(-1)).toMatchObject({ purchaseOrderId: po.id, from: 'draft', to: 'sent' });
    expect(auditActions(stubs).at(-1)).toBe('purchasing.purchase_order.send');
    const timeline = (await call('GET', `/purchase-orders/${po.id}`)).json().timeline.map((t: { label: string }) => t.label);
    expect(timeline).toEqual(expect.arrayContaining(['Sent to supplier', 'Emailed to orders@halden.example']));

    // after sending only dates and notes change
    const lines = await call('PATCH', `/purchase-orders/${po.id}`, { freight: usd(1) });
    expect(lines.statusCode).toBe(409);
    expect(lines.json().error.code).toBe('ILLEGAL_TRANSITION');
    const lineId = res.json().lines[0].id;
    const dates = await call('PATCH', `/purchase-orders/${po.id}`, { lineExpectedDates: { [lineId]: '2026-10-21' } });
    expect(dates.statusCode, dates.body).toBe(200);
    expect(dates.json().lines[0].expectedDate).toBe('2026-10-21');
    expect(stubs.inventory.expectIncoming).toHaveBeenLastCalledWith(po.id, po.ref, LOCATION, [{ stockItemId: headphones, quantity: 100, expectedDate: '2026-10-21' }]);
    await app.kernel.events.drain();
    expect(events['purchasing.delivery.rescheduled']!.at(-1)).toMatchObject({ deliveryId: null, purchaseOrderId: po.id, reason: expect.stringContaining('Oct 21') });

    // sending twice is an illegal move
    const again = await call('POST', `/purchase-orders/${po.id}/send`, {});
    expect(again.statusCode).toBe(409);
    expect(again.json().error.code).toBe('ILLEGAL_TRANSITION');
  });

  it('sends without emailing the supplier when the buyer did not ask (the event says so for notifications)', async () => {
    const s = await supplier();
    const po = await draft(s.id);
    const res = await call('POST', `/purchase-orders/${po.id}/send`, { message: 'Call me when it ships' });
    expect(res.statusCode, res.body).toBe(200);
    await app.kernel.events.drain();
    expect(events['purchasing.purchase_order.sent']!.filter((e) => e.purchaseOrderId === po.id)).toEqual([
      expect.objectContaining({ supplierName: s.name, supplierEmail: 'orders@halden.example', emailSupplier: false, message: 'Call me when it ships' }),
    ]);
    const timeline = (await call('GET', `/purchase-orders/${po.id}`)).json().timeline.map((t: { label: string }) => t.label);
    expect(timeline.filter((l: string) => /email/i.test(l))).toEqual([]);
    expect(stubs.notifications.notify).not.toHaveBeenCalled();
  });

  it('above the limit: stays Draft with approval, sent automatically when approved', async () => {
    const s = await supplier();
    const po = await draft(s.id, [{ stockItemId: headphones, quantity: 300, unitCost: usd(9500) }]); // $28,820.00 with freight
    const res = await call('POST', `/purchase-orders/${po.id}/send`, { message: 'Need these before the sale' });
    expect(res.statusCode, res.body).toBe(200);
    const requestId = res.json().approval.approvalRequestId;
    expect(res.json()).toMatchObject({ status: 'draft', approval: { required: true, approvers: ['Morgan Hale'] } });
    expect(stubs.access.requestApproval).toHaveBeenCalledWith(expect.objectContaining({ action: 'purchasing.orders.send', amount: usd(2882000), target: expect.objectContaining({ type: 'purchase_order', id: po.id, ref: po.ref }) }));
    expect(stubs.inventory.expectIncoming).not.toHaveBeenCalled();
    expect(auditActions(stubs).at(-1)).toBe('purchasing.purchase_order.approval_requested');
    const rows = (await call('GET', '/purchase-orders?awaitingApproval=true')).json().items;
    expect(rows).toEqual([expect.objectContaining({ id: po.id, approvalNote: 'Over $25,000: needs Morgan Hale' })]);

    const decide = (outcome: 'approved' | 'rejected', id = requestId) =>
      app.kernel.events.publish('access', 'access.approval.decided', {
        requestId: id, ref: 'AP-261009-0001', actionKey: 'purchasing.orders.send', module: 'purchasing', target: { type: 'purchase_order', id: po.id }, outcome,
        decidedBy: { kind: 'staff', id: newId(), name: 'Morgan Hale' }, approverIds: [], requestedById: ken.id,
      });
    decide('approved', newId()); // someone else's request
    await app.kernel.events.drain();
    expect((await call('GET', `/purchase-orders/${po.id}`)).json().status).toBe('draft');

    decide('approved');
    await app.kernel.events.drain();
    const sent = (await call('GET', `/purchase-orders/${po.id}`)).json();
    expect(sent).toMatchObject({ status: 'sent', approval: { approvalRequestId: requestId } });
    expect(stubs.inventory.expectIncoming).toHaveBeenCalledTimes(1);
    // emailSupplier and the message come from the approval request details
    expect(events['purchasing.purchase_order.sent']!.at(-1)).toMatchObject({ purchaseOrderId: po.id, emailSupplier: true, message: 'Please confirm', supplierName: s.name });
    expect(stubs.notifications.notify).not.toHaveBeenCalled();
    decide('approved'); // delivered twice: same result
    await app.kernel.events.drain();
    expect(stubs.inventory.expectIncoming).toHaveBeenCalledTimes(1);
  });

  it('records a rejected approval on the timeline and keeps the draft', async () => {
    const s = await supplier();
    const po = await draft(s.id, [{ stockItemId: headphones, quantity: 400, unitCost: usd(9500) }]);
    const requestId = (await call('POST', `/purchase-orders/${po.id}/send`, {})).json().approval.approvalRequestId;
    app.kernel.events.publish('access', 'access.approval.decided', {
      requestId, ref: 'AP-1', actionKey: 'purchasing.orders.send', module: 'purchasing', target: { type: 'purchase_order', id: po.id }, outcome: 'rejected',
      decidedBy: { kind: 'staff', id: newId(), name: 'Morgan Hale' }, reason: 'Too much stock', approverIds: [], requestedById: ken.id,
    });
    await app.kernel.events.drain();
    const after = (await call('GET', `/purchase-orders/${po.id}`)).json();
    expect(after.status).toBe('draft');
    expect(after.timeline[0]).toMatchObject({ label: 'Approval rejected', detail: 'Too much stock' });
  });

  it('a denied caller cannot send', async () => {
    const s = await supplier();
    const po = await draft(s.id);
    stubs.access.check.mockResolvedValueOnce({ decision: 'denied', action: 'purchasing.orders.send', reason: 'Your role can recommend only', requiresSecondReviewer: false, approvalsNeeded: 0, eligibleApproverRoles: [], eligibleApprovers: [] });
    const res = await call('POST', `/purchase-orders/${po.id}/send`, {}, staffAuth({ id: newId(), name: 'Intern' }));
    expect(res.statusCode).toBe(403);
    expect(res.json().error.code).toBe('FORBIDDEN');
  });

  it('cancels a draft, and a sent order only while nothing was received', async () => {
    const s = await supplier();
    const d = await draft(s.id);
    const c1 = await call('POST', `/purchase-orders/${d.id}/cancel`, { reason: 'Duplicate' });
    expect(c1.statusCode, c1.body).toBe(200);
    expect(c1.json()).toMatchObject({ status: 'cancelled', closedAt: expect.any(String) });
    expect(stubs.inventory.cancelIncoming).not.toHaveBeenCalled();
    expect((await call('POST', `/purchase-orders/${d.id}/cancel`, { reason: 'again' })).json().error.code).toBe('ILLEGAL_TRANSITION');

    const sent = await draft(s.id);
    await call('POST', `/purchase-orders/${sent.id}/send`, {});
    const c2 = await call('POST', `/purchase-orders/${sent.id}/cancel`, { reason: 'Supplier out of stock' });
    expect(c2.statusCode, c2.body).toBe(200);
    expect(stubs.inventory.cancelIncoming).toHaveBeenCalledWith(sent.id);
    expect(auditActions(stubs)).toContain('purchasing.purchase_order.cancel');
    await app.kernel.events.drain();
    expect(events['purchasing.purchase_order.status_changed']!.at(-1)).toMatchObject({ purchaseOrderId: sent.id, from: 'sent', to: 'cancelled', reason: 'Supplier out of stock' });

    expect((await call('POST', `/purchase-orders/${sent.id}/close`, { reason: 'x' })).json().error.code).toBe('ILLEGAL_TRANSITION');
    expect((await call('GET', `/purchase-orders/${newId()}`)).statusCode).toBe(404);
  });

  it('summary counts open orders, committed cost and incoming units', async () => {
    const res = await call('GET', '/summary');
    expect(res.statusCode, res.body).toBe(200);
    const s = res.json();
    expect(s.openPurchaseOrders).toBeGreaterThan(0);
    expect(s.committed.amount).toBeGreaterThan(0);
    expect(s).toMatchObject({ incomingUnits: expect.any(Number), lowStockItems: 3 });
  });
});

/**
 * Assertions added with the MySQL conversion (docs/10 §10.5e), for the readings the suite could not tell
 * apart: the two list filters read the negative way round, and a search term in the middle of a name.
 */
describe('conversions the suite could not see', () => {
  it('the negative list filters keep what has no approval and nothing late, and the search matches mid-name', async () => {
    const s = await supplier({ name: 'Westbridge Pacific Imports' });
    const plain = await draft(s.id, [{ stockItemId: headphones, quantity: 2, unitCost: usd(9500) }]);
    const pending = await draft(s.id, [{ stockItemId: headphones, quantity: 300, unitCost: usd(9500) }]); // over $25,000
    expect((await call('POST', `/purchase-orders/${pending.id}/send`, {})).json()).toMatchObject({ status: 'draft', approval: { required: true } });
    const late = await draft(s.id, [{ stockItemId: speaker, quantity: 5, unitCost: usd(4000) }], { expectedDate: '2026-10-01' });
    expect((await call('POST', `/purchase-orders/${late.id}/send`, {})).json()).toMatchObject({ status: 'sent' });

    const ids = async (qs: string) => ((await call('GET', `/purchase-orders?supplierId=${s.id}&${qs}`)).json().items as { id: string }[]).map((r) => r.id);

    // approval_state is null on an order that never needed approval, and "not awaiting approval" has to keep
    // it: `is not 'pending'` does, SQL's `<>` would drop every one of them
    expect(await ids('awaitingApproval=true')).toEqual([pending.id]);
    const noApproval = await ids('awaitingApproval=false');
    expect(noApproval).toEqual(expect.arrayContaining([plain.id, late.id]));
    expect(noApproval).not.toContain(pending.id);

    // the same the other way round for "late or short", which is an id list and its complement
    expect(await ids('lateOrShort=true')).toEqual([late.id]);
    const onTime = await ids('lateOrShort=false');
    expect(onTime).toEqual(expect.arrayContaining([plain.id, pending.id]));
    expect(onTime).not.toContain(late.id);

    // the supplier's name is searched for the term anywhere in it, not only at the front
    expect(await ids('q=pacific')).toEqual(expect.arrayContaining([plain.id, pending.id, late.id]));
    expect(((await call('GET', '/suppliers?q=pacific')).json().items as { id: string }[]).map((x) => x.id)).toEqual([s.id]);
  });
});
