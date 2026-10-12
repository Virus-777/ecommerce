/**
 * Gap pass 4: label kind, return and QR code in columns (storage_key is the plain asset id), exception item ids and
 * owner role, free-shipping rules switched off and on with `active`, audit entries under the shipping category.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { newId } from '../../../kernel/lib/ids.js';
import { harness, sellerOrder, tokens, type Harness } from './helpers.js';

const ADMIN = '/api/admin/shipping';
let h: Harness;
beforeAll(async () => {
  h = await harness();
});
afterAll(async () => {
  await h?.app.close();
});

const to = { name: 'Casa Verde Returns', line1: '9 Dock Rd', city: 'Reno', region: 'NV', postalCode: '89502', country: 'US' };

describe('columns', () => {
  it('keeps the label kind, return and QR code in columns; the label reads them', async () => {
    const o = await sellerOrder(h);
    const returnId = newId();
    const r = await h.service.createLabel({ groupId: o.groupId, kind: 'return', items: [{ orderItemId: o.lamp.id, quantity: 1 }], parcel: { weightGrams: 1200 }, keepPromise: false, to, returnId, labelMethod: 'prepaid_qr', billedTo: 'customer' }, `ret-${returnId}`);
    const row = (await h.service.core.repo.get('labels', r.label.id))!;
    expect(row).toMatchObject({ kind: 'return', return_id: returnId, qr_code: expect.stringMatching(/^QR-/) });
    expect(row.storage_key ?? '').not.toMatch(/^\{/);
    expect(r.label.qrCodeUrl).toContain(encodeURIComponent(row.qr_code!));
    expect(r.label.carrierName).not.toBe('Carrier');
  });

  it('stores the exception items and the owner role apart from the name', async () => {
    const o = await sellerOrder(h);
    const staff = tokens.staff();
    const opened = await h.call('POST', `${ADMIN}/exceptions`, staff, { kind: 'lost_or_damaged', groupId: o.groupId, orderItemIds: [o.lamp.id], situation: 'Box crushed' });
    expect(opened.status, JSON.stringify(opened.body)).toBe(201);
    expect(opened.body.orderItemIds).toEqual([o.lamp.id]);
    const owner = newId();
    const assigned = await h.call('POST', `${ADMIN}/exceptions/${opened.body.id}/assign`, staff, { ownerStaffId: owner });
    expect(assigned.body.owner).toMatchObject({ staffId: owner, name: 'Theo Grant', role: 'Shipping Manager' });
    expect(await h.service.core.repo.get('exceptions', opened.body.id)).toMatchObject({ order_item_ids: [o.lamp.id], owner_name: 'Theo Grant', owner_role: 'Shipping Manager' });
    expect(h.audits.filter((a) => a.action.startsWith('shipping.exception.')).every((a) => a.category === 'shipping')).toBe(true);
  });

  it('switches a free-shipping rule off and on with active', async () => {
    const staff = tokens.staff();
    const body = { name: 'Weekend free shipping', scope: 'official_store', methodCode: 'standard', fundedBy: 'company', reason: 'Campaign' };
    const off = await h.call('POST', `${ADMIN}/free-shipping-rules`, staff, { ...body, active: false });
    expect(off.status, JSON.stringify(off.body)).toBe(201);
    expect(off.body.status).toBe('inactive');
    const kept = await h.call('PUT', `${ADMIN}/free-shipping-rules/${off.body.id}`, staff, { ...body, name: 'Weekend free shipping 2' });
    expect(kept.body.status).toBe('inactive');
    const on = await h.call('PUT', `${ADMIN}/free-shipping-rules/${off.body.id}`, staff, { ...body, active: true });
    expect(on.body.status).toBe('active');
    expect(h.audits.at(-1)).toMatchObject({ action: 'shipping.free_rule.update', actionLabel: 'Switched on a free-shipping rule', category: 'shipping' });
  });
});
