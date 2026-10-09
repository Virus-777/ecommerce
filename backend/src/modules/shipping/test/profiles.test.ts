import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { newId } from '../../../kernel/lib/ids.js';
import { harness, offer, tokens, USD, type Harness } from './helpers.js';

let h: Harness;
beforeAll(async () => {
  h = await harness();
});
afterAll(async () => {
  await h.app.close();
});

const SELLER = '/api/seller/shipping';
const ADMIN = '/api/admin/shipping';
const STORE = '/api/store/shipping';

async function methodIds() {
  const list = (await h.call('GET', `${SELLER}/methods`, tokens.seller(newId()))).body as { id: string; code: string }[];
  return Object.fromEntries(list.map((m) => [m.code, m.id])) as Record<string, string>;
}

const settingsInput = (o: { handlingDays?: number; cutoff?: string; effectiveFrom?: string | null; area?: string; excluded?: string[] } = {}) => ({
  coverage: { area: o.area ?? 'contiguous_48_dc', zoneIds: [], excluded: o.excluded ?? ['po_box'] },
  dispatch: { handlingDays: o.handlingDays ?? 1, sameDayCutoff: o.cutoff ?? '12:00', businessDays: ['mon', 'tue', 'wed', 'thu', 'fri'] },
  buyLabelsInSellerCenter: true,
  effectiveFrom: o.effectiveFrom ?? null,
});

async function profileInput(o: { name?: string; standard?: number; threshold?: number | null; effectiveFrom?: string | null } = {}) {
  const ids = await methodIds();
  return {
    name: o.name ?? 'Default',
    methods: [
      { methodId: ids.standard, enabled: true, rateType: 'by_weight', tiers: [{ upToGrams: 2000, price: USD(o.standard ?? 599) }, { upToGrams: 20000, price: USD(1299) }], maxWeightGrams: 20000 },
      { methodId: ids.expedited, enabled: true, rateType: 'flat_per_package', tiers: [{ price: USD(1499) }] },
    ],
    freeShippingThreshold: o.threshold === null ? null : USD(o.threshold ?? 4900),
    freeShippingMethodCode: 'standard',
    effectiveFrom: o.effectiveFrom ?? null,
  };
}

/** A seller with saved settings and a default profile */
async function seller(o: { area?: string; excluded?: string[] } = {}) {
  const sellerId = newId();
  const token = tokens.seller(sellerId);
  expect((await h.call('PUT', `${SELLER}/settings`, token, settingsInput(o))).status).toBe(200);
  const p = await h.call('POST', `${SELLER}/profiles`, token, await profileInput());
  expect(p.status, JSON.stringify(p.body)).toBe(201);
  return { sellerId, token, profileId: p.body.id as string };
}

describe('seller shipping settings', () => {
  it('shows defaults, validates handling time and saves now or from a date', async () => {
    const sellerId = newId();
    const token = tokens.seller(sellerId);
    const fresh = await h.call('GET', `${SELLER}/settings`, token);
    expect(fresh.status).toBe(200);
    expect(fresh.body).toMatchObject({ coverage: { area: 'contiguous_48_dc' }, dispatch: { handlingDays: 2, businessDays: ['mon', 'tue', 'wed', 'thu', 'fri'] }, profiles: [], pendingChange: null, applyNote: expect.stringContaining('Existing orders keep') });
    expect(await h.service.hasCoverage(sellerId)).toBe(false);

    const out = await h.call('PUT', `${SELLER}/settings`, token, settingsInput({ handlingDays: 9 }));
    expect(out.status).toBe(422);
    expect(out.body.error).toMatchObject({ code: 'HANDLING_OUT_OF_RANGE', details: { min: 1, max: 3 } });
    expect((await h.call('PUT', `${SELLER}/settings`, token, settingsInput({ cutoff: '9am' }))).status).toBe(400);
    const saved = await h.call('PUT', `${SELLER}/settings`, token, settingsInput({ handlingDays: 1 }));
    expect(saved.body.dispatch).toMatchObject({ handlingDays: 1, sameDayCutoff: '12:00' });
    expect(h.named('shipping.profile.changed').at(-1)).toMatchObject({ profileId: null, sellerId });
    expect(h.audits.at(-1)).toMatchObject({ action: 'shipping.seller_settings.update' });

    const later = new Date(h.clock.now().getTime() + 3 * 86_400_000).toISOString();
    const scheduled = await h.call('PUT', `${SELLER}/settings`, token, settingsInput({ handlingDays: 3, effectiveFrom: later }));
    expect(scheduled.body.dispatch.handlingDays).toBe(1);
    expect(scheduled.body.pendingChange).toMatchObject({ effectiveFrom: later });
    h.clock.advance(3 * 86_400_000 + 60_000);
    await h.runJob('shipping.activate-versions');
    expect((await h.call('GET', `${SELLER}/settings`, token)).body.dispatch.handlingDays).toBe(3);

    const closure = await h.call('POST', `${SELLER}/closures`, token, { name: 'Inventory day', from: '2026-12-01', to: '2026-12-02' });
    expect(closure.status).toBe(201);
    expect((await h.call('POST', `${SELLER}/closures`, token, { name: 'x', from: '2026-12-05', to: '2026-12-01' })).status).toBe(400);
    expect((await h.call('DELETE', `${SELLER}/closures/${closure.body.id}`, tokens.seller(newId()))).status).toBe(404);
    expect((await h.call('DELETE', `${SELLER}/closures/${closure.body.id}`, token)).status).toBe(204);
  });
});

describe('shipping profiles', () => {
  it('creates, versions, schedules and archives profiles; other sellers get 404', async () => {
    const s = await seller();
    const list = (await h.call('GET', `${SELLER}/profiles`, s.token)).body;
    expect(list).toEqual([expect.objectContaining({ id: s.profileId, isDefault: true, version: 1, status: 'active', freeShippingThreshold: USD(4900), offersUsing: 0 })]);
    expect(list[0].methods.map((m: any) => m.methodCode)).toEqual(['standard', 'expedited']);
    expect(await h.service.hasCoverage(s.sellerId)).toBe(true);

    const bad = await h.call('POST', `${SELLER}/profiles`, s.token, { name: '', methods: [{ methodId: newId(), enabled: true, rateType: 'flat_per_package', tiers: [] }] });
    expect(bad.status).toBe(400);
    expect(bad.body.error.details.issues.map((i: any) => i.path)).toEqual(expect.arrayContaining(['name', 'methods.0.methodId']));

    const v2 = await h.call('PUT', `${SELLER}/profiles/${s.profileId}`, s.token, await profileInput({ standard: 699 }));
    expect(v2.body).toMatchObject({ id: s.profileId, version: 2, status: 'active' });
    const rows = await h.service.core.repo.find('profiles', { lineage_id: s.profileId });
    expect(rows.map((r) => r.status).sort()).toEqual(['active', 'superseded']);
    const q = await h.service.quote(s.profileId, '97205', { weightGrams: 1000 }, { businessDays: 1, shipsFrom: 'Reno, NV' });
    expect(q.default).toMatchObject({ methodCode: 'standard', price: USD(699) });

    const later = new Date(h.clock.now().getTime() + 2 * 86_400_000).toISOString();
    const v3 = await h.call('PUT', `${SELLER}/profiles/${s.profileId}`, s.token, await profileInput({ standard: 799, effectiveFrom: later }));
    expect(v3.body).toMatchObject({ version: 3, status: 'scheduled' });
    expect((await h.service.quote(s.profileId, '97205', { weightGrams: 1000 }, { businessDays: 1, shipsFrom: 'Reno, NV' })).default!.price).toEqual(USD(699));
    h.clock.advance(2 * 86_400_000 + 60_000);
    await h.runJob('shipping.activate-versions');
    expect((await h.service.quote(s.profileId, '97205', { weightGrams: 1000 }, { businessDays: 1, shipsFrom: 'Reno, NV' })).default!.price).toEqual(USD(799));

    const other = tokens.seller(newId());
    expect((await h.call('PUT', `${SELLER}/profiles/${s.profileId}`, other, await profileInput())).status).toBe(404);
    expect((await h.call('POST', `${SELLER}/profiles/${s.profileId}/archive`, other)).status).toBe(404);
    expect((await h.call('PUT', `${ADMIN}/profiles/${s.profileId}`, tokens.staff(), { profile: await profileInput(), reason: 'x' })).status).toBe(403);

    const used = offer(h, { profileId: s.profileId, sellerId: s.sellerId });
    const inUse = await h.call('POST', `${SELLER}/profiles/${s.profileId}/archive`, s.token);
    expect(inUse.status).toBe(409);
    expect(inUse.body.error).toMatchObject({ code: 'PROFILE_IN_USE', details: { offerCount: 1 } });
    h.offers.set(used.id, { ...used, status: 'removed' });
    const archived = await h.call('POST', `${SELLER}/profiles/${s.profileId}/archive`, s.token);
    expect(archived.body.status).toBe('archived');
    expect((await h.call('POST', `${SELLER}/profiles/${s.profileId}/archive`, s.token)).status).toBe(409);
    expect((await h.call('PUT', `${SELLER}/profiles/${s.profileId}`, s.token, await profileInput())).status).toBe(409);
    await expect(h.service.quote(s.profileId, '97205', { weightGrams: 1000 }, { businessDays: 1, shipsFrom: 'Reno, NV' })).rejects.toMatchObject({ code: 'NOT_FOUND' });
  });

  it('lets staff manage Official Store profiles', async () => {
    const staff = tokens.staff();
    const all = (await h.call('GET', `${ADMIN}/profiles?ownerType=official`, staff)).body;
    expect(all.items.length).toBeGreaterThan(0);
    const created = await h.call('POST', `${ADMIN}/profiles`, staff, { ...(await profileInput({ name: 'Large items' })), isDefault: false });
    expect(created.body).toMatchObject({ ownerType: 'official', sellerId: null, name: 'Large items' });
    expect((await h.call('PUT', `${ADMIN}/profiles/${created.body.id}`, staff, { profile: await profileInput({ name: 'Large items', standard: 999 }), reason: '' })).status).toBe(400);
    const v2 = await h.call('PUT', `${ADMIN}/profiles/${created.body.id}`, staff, { profile: await profileInput({ name: 'Large items', standard: 999 }), reason: 'Carrier rates up' });
    expect(v2.body.version).toBe(2);
    expect(h.audits.at(-1)).toMatchObject({ action: 'shipping.profile.update', reason: 'Carrier rates up' });
  });
});

describe('estimates and quotes', () => {
  it('quotes prices, free shipping, coverage and size limits', async () => {
    const s = await seller();
    const q = await h.service.quote(s.profileId, '97205', { weightGrams: 2500 }, { businessDays: 1, shipsFrom: 'Reno, NV' });
    expect(q.shipsToLocation).toBe(true);
    expect(q.options.map((o) => [o.methodCode, o.price.amount])).toEqual([
      ['standard', 1299],
      ['expedited', 1499],
    ]);
    expect(q.default).toMatchObject({ methodCode: 'standard', isDefault: true, fundedBy: 'customer', carrierService: 'UPS Ground or USPS Ground Advantage or FedEx Ground', arrivalLabel: expect.stringMatching(/^Arrives /), dispatchLabel: expect.stringContaining('from Reno, NV') });
    const ak = await h.service.quote(s.profileId, '99501', { weightGrams: 1000 }, { businessDays: 1, shipsFrom: 'Reno, NV' });
    expect(ak).toMatchObject({ shipsToLocation: false, reason: 'This seller ships to the contiguous US and DC only.', options: [] });
    const heavy = await h.service.quote(s.profileId, '97205', { weightGrams: 50_000 }, { businessDays: 1, shipsFrom: 'Reno, NV' });
    // Standard stops at 20 kg; the flat Expedited rate carries it
    expect(heavy.options.map((x) => x.methodCode)).toEqual(['expedited']);
    const ids = await methodIds();
    const small = (await h.call('POST', `${SELLER}/profiles`, s.token, { name: 'Small parcels', methods: [{ methodId: ids.standard, enabled: true, rateType: 'flat_per_package', tiers: [{ price: USD(399) }], maxWeightGrams: 2000 }] })).body;
    const tooBig = await h.service.quote(small.id, '97205', { weightGrams: 5000 }, { businessDays: 1, shipsFrom: 'Reno, NV' });
    expect(tooBig).toMatchObject({ shipsToLocation: false, reason: expect.stringContaining('too large') });
    await expect(h.service.quote(newId(), '97205', { weightGrams: 1 }, { businessDays: 1, shipsFrom: '' })).rejects.toMatchObject({ code: 'NOT_FOUND' });

    // packages: combined weight, the threshold on the package subtotal, items that cannot come
    const other = await seller({ area: 'all_50' });
    const pkg = await h.service.quoteOptions({
      ownerType: 'seller',
      sellerId: s.sellerId,
      shipsFrom: 'Reno, NV',
      destination: { postalCode: '97205', country: 'US' },
      items: [
        { lineId: 'a', profileId: s.profileId, parcel: { weightGrams: 1000 }, quantity: 2, value: USD(3000), dispatch: { businessDays: 1, shipsFrom: 'Reno, NV' } },
        { lineId: 'b', profileId: s.profileId, parcel: { weightGrams: 1000 }, quantity: 1, value: USD(2500), dispatch: { businessDays: 2, shipsFrom: 'Reno, NV' } },
        { lineId: 'c', profileId: other.profileId, parcel: { weightGrams: 1000 }, quantity: 1, value: USD(100), dispatch: { businessDays: 1, shipsFrom: 'Reno, NV' } },
      ],
    });
    expect(pkg.shipsToLocation).toBe(true);
    expect(pkg.default).toMatchObject({ methodCode: 'standard', free: true, fundedBy: 'seller', freeReason: 'Free over $49', price: USD(0) });
    expect(pkg.options.find((o) => o.methodCode === 'expedited')).toMatchObject({ free: false, price: USD(1499) });
    const unshippable = await h.service.quoteOptions({ ownerType: 'seller', sellerId: s.sellerId, shipsFrom: 'Reno, NV', destination: { postalCode: '99501', country: 'US' }, items: [{ lineId: 'x', profileId: s.profileId, parcel: { weightGrams: 0 }, quantity: 1, value: USD(1000), dispatch: { businessDays: 1, shipsFrom: 'Reno, NV' } }] });
    expect(unshippable).toMatchObject({ shipsToLocation: false, notShippableLineIds: ['x'] });

    const checks = await h.service.checkCoverage([s.profileId, other.profileId], { name: 'J', line1: 'PO Box 12', city: 'Portland', region: 'OR', postalCode: '97205', country: 'US' });
    expect(checks).toEqual([expect.objectContaining({ profileId: s.profileId, shippable: false, reason: 'po_box' }), expect.objectContaining({ profileId: other.profileId, shippable: false, reason: 'po_box' })]);
    const military = await h.service.checkCoverage([s.profileId], { name: 'J', line1: 'Unit 1', city: 'APO', region: 'AE', postalCode: '09001', country: 'US' });
    expect(military[0]).toMatchObject({ shippable: false, reason: 'military' });
  });

  it('computes dispatch deadlines from cutoffs, business days and closures', async () => {
    const s = await seller();
    // Friday 2026-10-09 13:00 PT
    const fri = '2026-10-09T20:00:00.000Z';
    expect(await h.service.dispatchDeadline('seller', s.sellerId, fri, { businessDays: 1, sameDayCutoff: '14:00', shipsFrom: '' })).toBe('2026-10-13T00:00:00.000Z');
    expect(await h.service.dispatchDeadline('seller', s.sellerId, fri, { businessDays: 1, sameDayCutoff: '12:00', shipsFrom: '' })).toBe('2026-10-14T00:00:00.000Z');
    expect(await h.service.dispatchDeadline('seller', s.sellerId, fri, { businessDays: 0, sameDayCutoff: '14:00', shipsFrom: '' })).toBe('2026-10-10T00:00:00.000Z');
    await h.call('POST', `${SELLER}/closures`, s.token, { name: 'Columbus Day', from: '2026-10-12', to: '2026-10-12' });
    expect(await h.service.dispatchDeadline('seller', s.sellerId, fri, { businessDays: 1, sameDayCutoff: '14:00', shipsFrom: '' })).toBe('2026-10-14T00:00:00.000Z');
  });

  it('answers storefront estimates, previews and summaries', async () => {
    const s = await seller();
    const o = offer(h, { profileId: s.profileId, sellerId: s.sellerId });
    const est = await h.call('GET', `${STORE}/estimates?offerIds=${o.id},${newId()}&postalCode=97205`, tokens.visitor());
    expect(est.status).toBe(200);
    expect(est.body[0]).toMatchObject({ offerId: o.id, shipsToLocation: true, otherOptions: 1, option: { methodCode: 'standard' } });
    expect(est.body[1]).toMatchObject({ shipsToLocation: false, option: null });

    const preview = await h.call('GET', `${SELLER}/preview?postalCode=97205&offerId=${o.id}`, s.token);
    expect(preview.body).toMatchObject({ example: 'Your offer SKU-1 to OR 97205', price: USD(599), arrivesLabel: expect.stringMatching(/^Arrives/) });
    expect((await h.call('GET', `${SELLER}/preview?postalCode=97205&offerId=${o.id}`, tokens.seller(newId()))).status).toBe(404);

    const summaries = await h.service.getSellerShippingSummaries([s.sellerId, newId()]);
    expect(summaries[s.sellerId]).toMatchObject({ coverageLabel: 'Ships to the contiguous US and DC', excluded: ['PO boxes'], handlingDays: 1, sameDayCutoff: '12:00', freeShippingThreshold: USD(4900), carriers: ['FedEx', 'UPS', 'USPS'] });
    expect(summaries[s.sellerId]!.methods[0]).toMatchObject({ name: 'Standard', priceLabel: 'From $5.99 or free over $49' });
    expect(Object.values(summaries).filter((x) => x === null)).toHaveLength(1);

    const setup = await h.call('GET', `${SELLER}/shipping-setup`, s.token);
    expect(setup.body).toMatchObject({ labelPurchaseAvailable: true, labelUnavailableReason: null, dispatchLabel: expect.stringContaining('Ships in 1 business day') });
    expect(setup.body.carriers.every((c: any) => c.contacts.length === 0)).toBe(true);
  });
});
