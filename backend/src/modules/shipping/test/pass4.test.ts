/**
 * Gap pass 4: label kind, return and QR code in columns (storage_key is the plain asset id), exception item ids and
 * owner role, free-shipping rules switched off and on with `active`, audit entries under the shipping category,
 * and the 0003 backfill.
 */
import { sql } from 'kysely';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { newId } from '../../../kernel/lib/ids.js';
import { m0003Pass4 } from '../infra/postgres/migrations/0003_pass4.js';
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

describe('migration 0003', () => {
  it('backfills label columns from the storage_key JSON and exception items and roles', async () => {
    const o = await sellerOrder(h);
    const returnId = newId();
    const r = await h.service.createLabel({ groupId: o.groupId, kind: 'return', items: [{ orderItemId: o.lamp.id, quantity: 1 }], parcel: { weightGrams: 1200 }, keepPromise: false, to, returnId, labelMethod: 'prepaid_qr', billedTo: 'customer' }, `ret-${returnId}`);
    const label = (await h.service.core.repo.get('labels', r.label.id))!;
    const outbound = await h.service.createLabel({ groupId: o.groupId, kind: 'outbound', items: [{ orderItemId: o.speaker.id, quantity: 1 }], parcel: { weightGrams: 900 }, keepPromise: true }, `out-${newId()}`);
    const staff = tokens.staff();
    const ex = await h.call('POST', `${ADMIN}/exceptions`, staff, { kind: 'missing_tracking', groupId: o.groupId, shipmentId: outbound.shipment.id, situation: 'No scans' });
    expect(ex.status, JSON.stringify(ex.body)).toBe(201);
    const owner = newId();
    await h.call('POST', `${ADMIN}/exceptions/${ex.body.id}/assign`, staff, { ownerStaffId: owner });
    const db = h.app.kernel.database;

    // the state before 0003: the extras as JSON in storage_key, "Name, Role" in owner_name, no item ids
    const meta = { asset: label.storage_key, qr: label.qr_code, dropOffBy: null, billedTo: 'customer', kind: 'return', returnId, serviceName: 'Ground', carrierName: 'UPS', carrierCode: 'ups' };
    await db.exec(`update shipping.labels set storage_key = coalesce(storage_key, ''); alter table shipping.labels drop column kind, drop column return_id, drop column qr_code; alter table shipping.labels alter column storage_key set not null;
      alter table shipping.exceptions drop column order_item_ids; update shipping.exceptions set owner_name = owner_name || ', ' || owner_role where owner_role is not null; alter table shipping.exceptions drop column owner_role`);
    await sql`update shipping.labels set storage_key = ${JSON.stringify(meta)} where id = ${label.id}`.execute(db.kysely);

    await db.exec(m0003Pass4.sql);

    expect(await h.service.core.repo.get('labels', label.id)).toMatchObject({ kind: 'return', return_id: returnId, qr_code: label.qr_code, storage_key: label.storage_key });
    expect(await h.service.core.repo.get('labels', outbound.label.id)).toMatchObject({ kind: 'outbound', return_id: null, qr_code: null });
    expect(await h.service.core.repo.get('exceptions', ex.body.id)).toMatchObject({ order_item_ids: [o.speaker.id], owner_name: 'Theo Grant', owner_role: 'Shipping Manager' });
  });
});
