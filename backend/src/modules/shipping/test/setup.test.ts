import { marketDate } from '../../../testing/app.js';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { newId } from '../../../kernel/lib/ids.js';
import { harness, tokens, type Harness } from './helpers.js';

let h: Harness;
beforeAll(async () => {
  h = await harness();
});
afterAll(async () => {
  await h.app.close();
});

const ADMIN = '/api/admin/shipping';
const SELLER = '/api/seller/shipping';
const STORE = '/api/store/shipping';
const day = (d: number) => marketDate(h.clock.now(), d);

describe('carriers, methods and zones', () => {
  it('starts with the market reference data and keeps carrier contacts from sellers', async () => {
    const staff = tokens.staff();
    const carriers = (await h.call('GET', `${ADMIN}/carriers`, staff)).body;
    // G40a: OnTrac and Other carrier are seeded too (Other has no tracking feed)
    expect(carriers.map((c: any) => c.code).sort()).toEqual(['fedex', 'ontrac', 'other', 'ups', 'usps']);
    expect(carriers.find((c: any) => c.code === 'other')).toMatchObject({ trackingMode: 'manual', trackingConnected: false });
    const ups = carriers.find((c: any) => c.code === 'ups');
    expect(ups.services.map((s: any) => s.name)).toContain('UPS Ground');
    expect(ups.services[0].trackingPattern).toBeTruthy();
    const methods = (await h.call('GET', `${ADMIN}/methods`, staff)).body;
    expect(methods.map((m: any) => m.code)).toEqual(['standard', 'expedited', 'express', 'large_items']);
    const zones = (await h.call('GET', `${ADMIN}/zones`, staff)).body;
    expect(zones.filter((z: any) => z.kind === 'excluded').map((z: any) => z.name)).toEqual(expect.arrayContaining(['US territories', 'Military addresses (APO/FPO/DPO)']));

    const contacts = [{ role: 'claims', name: 'Dana Ruiz', email: 'claims@ups.example', phone: '+1 800 555 0100', hours: 'Mon–Fri 8 AM–6 PM PT' }];
    const updated = await h.call('PATCH', `${ADMIN}/carriers/${ups.id}`, staff, { contacts, reason: 'New claims contact' });
    expect(updated.body.contacts).toEqual([expect.objectContaining({ name: 'Dana Ruiz' })]);
    expect(h.audits.at(-1)).toMatchObject({ action: 'shipping.carrier.update', reason: 'New claims contact' });
    expect((await h.call('PATCH', `${ADMIN}/carriers/${ups.id}`, staff, { name: 'UPS', reason: '' })).status).toBe(400);
    const sellerView = (await h.call('GET', `${SELLER}/carrier-services`, tokens.seller(newId()))).body;
    expect(sellerView.find((c: any) => c.code === 'ups').contacts).toEqual([]);
    expect(sellerView.find((c: any) => c.code === 'ups').accountLabel ?? null).toBeNull();
  });

  it('adds carriers with their services and changes services, methods and zones', async () => {
    const staff = tokens.staff();
    const created = await h.call('POST', `${ADMIN}/carriers`, staff, { code: 'lasership', name: 'LaserShip', trackingMode: 'polling' });
    expect(created.status).toBe(201);
    expect(created.body.services).toEqual([expect.objectContaining({ name: 'LaserShip Standard', labelSupported: false })]);
    expect((await h.call('POST', `${ADMIN}/carriers`, staff, { code: 'lasership', name: 'Again', trackingMode: 'webhook' })).status).toBe(409);
    const svc = created.body.services[0];
    const changed = await h.call('PATCH', `${ADMIN}/carriers/${created.body.id}/services/${svc.id}`, staff, { transit: { min: 1, max: 2 }, enabled: false });
    expect(changed.body).toMatchObject({ enabled: false, transit: { min: 1, max: 2 } });
    expect((await h.call('PATCH', `${ADMIN}/carriers/${newId()}/services/${svc.id}`, staff, { enabled: true })).status).toBe(404);
    expect((await h.call('PATCH', `${ADMIN}/carriers/${created.body.id}/services/${svc.id}`, staff, { transit: { min: 3, max: 1 } })).status).toBe(400);

    const methods = (await h.call('GET', `${ADMIN}/methods`, staff)).body;
    const express = methods.find((m: any) => m.code === 'express');
    const m = await h.call('PUT', `${ADMIN}/methods/${express.id}`, staff, { code: 'express', name: 'Express', customerLabel: '1–2 business days', transit: { min: 1, max: 2 }, carrierServiceIds: express.carrierServiceIds, active: false });
    expect(m.body.active).toBe(false);
    expect((await h.call('GET', `${SELLER}/methods`, tokens.seller(newId()))).body.map((x: any) => x.code)).not.toContain('express');
    await h.call('PUT', `${ADMIN}/methods/${express.id}`, staff, { ...express, active: true });

    const zone = await h.call('POST', `${ADMIN}/zones`, staff, { name: 'Wildfire area', kind: 'excluded', regions: [], postalPrefixes: ['956'], status: 'active', customerMessage: 'Deliveries are paused', reason: 'Fires' });
    expect(zone.status).toBe(201);
    expect(h.named('shipping.coverage.changed').at(-1)).toEqual({ zoneId: zone.body.id, status: 'active' });
    expect((await h.call('POST', `${ADMIN}/zones`, staff, { name: 'Nothing', kind: 'served', regions: [], status: 'active', reason: 'x' })).status).toBe(400);
    const off = await h.call('PUT', `${ADMIN}/zones/${zone.body.id}`, staff, { name: 'Wildfire area', kind: 'excluded', regions: [], postalPrefixes: ['956'], status: 'disabled', reason: 'Reopened' });
    expect(off.body.status).toBe('disabled');
    expect(h.audits.at(-1)).toMatchObject({ action: 'shipping.zone.update', actionLabel: 'Disabled a zone' });
  });

  it('sets dispatch targets and free-shipping rules', async () => {
    const staff = tokens.staff();
    const t = (await h.call('GET', `${ADMIN}/dispatch-targets`, staff)).body;
    expect(t).toMatchObject({ official: { cutoff: '14:00' }, sellerDefault: { dispatchWithinBusinessDays: 2, allowedMinDays: 0, allowedMaxDays: 3 }, note: expect.stringContaining('Example targets') });
    const bad = await h.call('PUT', `${ADMIN}/dispatch-targets`, staff, { official: { ...t.official, cutoff: '25:00' }, sellerDefault: t.sellerDefault, effectiveFrom: h.clock.now().toISOString(), reason: 'x' });
    expect(bad.status).toBe(400);
    const seller = { dispatchWithinBusinessDays: 3, validTrackingWithinHours: t.sellerDefault.validTrackingWithinHours, onTimeTargetPct: t.sellerDefault.onTimeTargetPct };
    // the allowed range comes only from the sellerHandlingRange setting ([0, 3]): a default outside it is refused
    const outside = await h.call('PUT', `${ADMIN}/dispatch-targets`, staff, { official: t.official, sellerDefault: { ...seller, dispatchWithinBusinessDays: 4 }, effectiveFrom: h.clock.now().toISOString(), reason: 'Longer' });
    expect(outside.status).toBe(400);
    expect(outside.body.error.details.issues).toEqual([expect.objectContaining({ path: 'sellerDefault.dispatchWithinBusinessDays' })]);
    const put = await h.call('PUT', `${ADMIN}/dispatch-targets`, staff, { official: { ...t.official, cutoff: '13:00' }, sellerDefault: seller, effectiveFrom: h.clock.now().toISOString(), reason: 'Holiday season' });
    expect(put.status, JSON.stringify(put.body)).toBe(200);
    expect(put.body.official.cutoff).toBe('13:00');
    expect((await h.call('GET', `${ADMIN}/dispatch-targets`, staff)).body.sellerDefault).toEqual({ dispatchWithinBusinessDays: 3, allowedMinDays: 0, allowedMaxDays: 3, validTrackingWithinHours: seller.validTrackingWithinHours, onTimeTargetPct: seller.onTimeTargetPct });
    expect(h.audits.at(-1)).toMatchObject({ action: 'shipping.dispatch_targets.update', reason: 'Holiday season' });

    const later = await h.call('POST', `${ADMIN}/free-shipping-rules`, staff, { name: 'Holiday free shipping', scope: 'official_store', minOrderValue: { amount: 2500, currency: 'USD' }, methodCode: 'standard', fundedBy: 'company', window: { from: day(10), to: day(20) }, reason: 'Campaign' });
    expect(later.body.status).toBe('scheduled');
    const ended = await h.call('PUT', `${ADMIN}/free-shipping-rules/${later.body.id}`, staff, { name: 'Holiday free shipping', scope: 'official_store', methodCode: 'standard', fundedBy: 'company', window: { from: day(-20), to: day(-1) }, reason: 'Ended early' });
    expect(ended.body.status).toBe('ended');
    expect((await h.call('POST', `${ADMIN}/free-shipping-rules`, staff, { name: 'x', scope: 'official_store', methodCode: 'standard', fundedBy: 'seller', reason: 'x' })).status).toBe(400);
    expect((await h.call('GET', `${ADMIN}/free-shipping-rules`, staff)).body.map((r: any) => r.id)).toContain(later.body.id);
  });
});

describe('holiday and service notices', () => {
  const input = () => ({
    title: 'Snowstorm in Oregon',
    kind: 'weather',
    from: day(0),
    to: day(10),
    regions: ['OR'],
    effect: { extraTransitDays: { min: 2, max: 3 }, noPickup: false, noDelivery: false, noDispatch: false },
    customerMessage: 'Deliveries to Oregon may take 2–3 extra days.',
    surfaces: ['product', 'checkout', 'tracking'],
  });

  it('drafts, previews, publishes and withdraws a notice', async () => {
    const staff = tokens.staff();
    const draft = await h.call('POST', `${ADMIN}/notices`, staff, input());
    expect(draft.status).toBe(201);
    expect(draft.body).toMatchObject({ status: 'draft', sellerScope: 'all' });
    expect((await h.call('GET', `${STORE}/notices?postalCode=97205`, tokens.visitor())).body.map((n: any) => n.id)).not.toContain(draft.body.id);

    const preview = await h.call('POST', `${ADMIN}/notices/preview`, staff, { notice: input(), postalCode: '97205' });
    expect(preview.status, JSON.stringify(preview.body)).toBe(200);
    expect(preview.body).toMatchObject({ applies: true, surface: 'checkout', message: 'Deliveries to Oregon may take 2–3 extra days.', dispatchChanges: false });
    expect(preview.body.estimates.length).toBeGreaterThan(0);
    expect(preview.body.estimates.every((e: any) => e.changed), JSON.stringify(preview.body.estimates)).toBe(true);
    const elsewhere = await h.call('POST', `${ADMIN}/notices/preview`, staff, { notice: input(), postalCode: '10001' });
    expect(elsewhere.body).toMatchObject({ applies: false, message: null });
    expect(elsewhere.body.estimates.every((e: any) => !e.changed)).toBe(true);

    const live = await h.call('POST', `${ADMIN}/notices/${draft.body.id}/publish`, staff, { mode: 'now' });
    expect(live.body.status).toBe('live');
    expect(h.named('shipping.notice.published').at(-1)).toMatchObject({ noticeId: draft.body.id, status: 'live' });
    const shown = (await h.call('GET', `${STORE}/notices?postalCode=97205&surface=checkout`, tokens.visitor())).body;
    expect(shown.map((n: any) => n.id)).toContain(draft.body.id);
    expect((await h.call('GET', `${STORE}/notices?postalCode=10001`, tokens.visitor())).body.map((n: any) => n.id)).not.toContain(draft.body.id);
    expect((await h.service.activeNotices('97205', ['ups'], 'tracking')).map((n) => n.id)).toContain(draft.body.id);
    const edited = await h.call('PATCH', `${ADMIN}/notices/${draft.body.id}`, staff, { ...input(), customerMessage: 'Expect 2–3 extra days.' });
    expect(edited.body).toMatchObject({ status: 'live', customerMessage: 'Expect 2–3 extra days.' });
    const out = await h.call('POST', `${ADMIN}/notices/${draft.body.id}/withdraw`, staff, { reason: 'Storm passed' });
    expect(out.body.status).toBe('withdrawn');
    expect((await h.call('POST', `${ADMIN}/notices/${draft.body.id}/withdraw`, staff, { reason: 'again' })).status).toBe(409);
    expect((await h.call('PATCH', `${ADMIN}/notices/${draft.body.id}`, staff, input())).status).toBe(409);
    expect(h.audits.at(-1)).toMatchObject({ action: 'shipping.notice.withdraw', reason: 'Storm passed' });
    // G73: a withdrawn notice cannot be deleted, a draft can
    expect((await h.call('DELETE', `${ADMIN}/notices/${draft.body.id}`, staff)).status).toBe(409);
    const scrap = await h.call('POST', `${ADMIN}/notices`, staff, { ...input(), title: 'Scrap draft' });
    const gone = await h.call('DELETE', `${ADMIN}/notices/${scrap.body.id}`, staff);
    expect(gone.status, JSON.stringify(gone.body)).toBe(204);
    expect(h.audits.at(-1)).toMatchObject({ action: 'shipping.notice.delete', target: { id: scrap.body.id } });
    expect((await h.call('GET', `${ADMIN}/notices`, staff)).body.items.map((x: any) => x.id)).not.toContain(scrap.body.id);
    expect((await h.call('DELETE', `${ADMIN}/notices/${scrap.body.id}`, staff)).status).toBe(404);
  });

  it('schedules notices: live at showFrom, ended after the to date', async () => {
    const staff = tokens.staff();
    const n = (await h.call('POST', `${ADMIN}/notices`, staff, { ...input(), title: 'Thanksgiving', kind: 'holiday', regions: [], from: day(5), to: day(6), showFrom: new Date(h.clock.now().getTime() + 86_400_000).toISOString(), effect: { noPickup: true, noDelivery: true, noDispatch: true }, customerMessage: 'Closed for Thanksgiving' })).body;
    const scheduled = await h.call('POST', `${ADMIN}/notices/${n.id}/publish`, staff, { mode: 'scheduled' });
    expect(scheduled.body.status).toBe('scheduled');
    h.clock.advance(2 * 86_400_000);
    await h.runJob('shipping.notice-schedule');
    expect((await h.call('GET', `${ADMIN}/notices?status=live`, staff)).body.items.map((x: any) => x.id)).toContain(n.id);
    h.clock.advance(6 * 86_400_000);
    await h.runJob('shipping.notice-schedule');
    expect((await h.call('GET', `${ADMIN}/notices?status=ended`, staff)).body.items.map((x: any) => x.id)).toContain(n.id);
  });

  it('summarizes the shipping desk', async () => {
    const s = await h.call('GET', `${ADMIN}/summary`, tokens.staff());
    expect(s.status).toBe(200);
    expect(s.body).toMatchObject({ carriersActive: expect.any(Number), owner: 'Theo Grant, Shipping Manager', exceptionCounts: { lateDispatch: expect.any(Number) } });
  });
});
