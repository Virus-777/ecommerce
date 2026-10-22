import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { devicesFromLabel, devicesLabel, makeLicenceKey, normaliseLicenceKey, LICENCE_KEY_PATTERN } from '../domain/rules.js';
import { licenceKeys } from '../migrations.js';
import { boot, newId, usd, type Kit } from './helpers.js';

let k: Kit;
beforeAll(async () => {
  k = await boot();
});
afterAll(async () => {
  await k?.app.close();
});
beforeEach(() => {
  k.events.length = 0;
  k.audits.length = 0;
});

const KEY = /^[23456789ABCDEFGHJKLMNPQRSTUVWXYZ]{5}(-[23456789ABCDEFGHJKLMNPQRSTUVWXYZ]{5}){3}$/;
const card = { kind: 'new_card', providerToken: 'tok_visa' };
const RETURN = 'https://store.example/software/return';
const buyer = () => {
  const id = newId();
  return { id, token: k.customer(id) };
};
const buy = (who: { token: Record<string, string> }, body: Record<string, unknown>) => k.store('POST', '/purchases', { method: card, returnUrl: RETURN, ...body }, who.token);
const db = () => (k.app.kernel as any).mongo.db;

describe('licence key rules', () => {
  it('draws XXXXX-XXXXX-XXXXX-XXXXX keys from the unambiguous alphabet and reads typed ones back', () => {
    const keys = new Set(Array.from({ length: 500 }, () => makeLicenceKey((n) => new Uint8Array(n).map(() => Math.floor(Math.random() * 256)))));
    expect(keys.size).toBe(500);
    for (const key of keys) expect(key).toMatch(KEY);
    expect(makeLicenceKey((n) => new Uint8Array(n))).toBe('22222-22222-22222-22222');
    expect(makeLicenceKey((n) => new Uint8Array(n).fill(255))).toBe('ZZZZZ-ZZZZZ-ZZZZZ-ZZZZZ');
    expect(normaliseLicenceKey('abcde fghjk-mnpqr  stuvw')).toBe('ABCDE-FGHJK-MNPQR-STUVW');
    expect(normaliseLicenceKey('ABCDE-FGHJK-MNPQR-STUV0')).toBeNull(); // 0 is not in the alphabet
    expect(normaliseLicenceKey('SW-4K7Q2')).toBeNull();
    expect(LICENCE_KEY_PATTERN.test('ABCDE-FGHJK-MNPQR-STUVW')).toBe(true);
    expect([devicesFromLabel('One-time purchase · 2 devices'), devicesFromLabel('1 device'), devicesFromLabel('Lifetime licence'), devicesFromLabel(null)]).toEqual([2, 1, null, null]);
    expect([devicesLabel(2), devicesLabel(1), devicesLabel(null)]).toEqual(['Use on up to 2 devices', 'Use on 1 device', 'Use on any number of devices']);
  });
});

describe('licence keys of paid apps', () => {
  it('issues a key when a purchase is paid and shows it to the owner only (app page and My apps)', async () => {
    const a = await k.makeApp({ title: 'PixelCraft Studio', free: false, price: usd(2499), licenceLabel: 'One-time purchase · 2 devices', licenceDevices: 2 });
    expect(a.licenceDevices).toBe(2);
    const c = buyer();
    const paid = await buy(c, { appId: a.id, expectedAmount: usd(2499) });
    expect(paid.body.status).toBe('paid');
    const page = (await k.store('GET', `/apps/${a.slug}`, undefined, c.token)).body;
    expect(page).toMatchObject({ owned: true, licenceDevices: 2, licence: { devices: 2, devicesLabel: 'Use on up to 2 devices' } });
    expect(page.licence.key).toMatch(KEY);
    expect(page.licence.issuedAt).toBe(paid.body.paidAt);
    const lib = (await k.store('GET', '/library', undefined, c.token)).body.items;
    expect(lib).toEqual([expect.objectContaining({ source: 'purchase', licence: page.licence })]);
    // the same key on every visit; nobody else sees it
    expect((await k.store('GET', `/apps/${a.slug}`, undefined, c.token)).body.licence.key).toBe(page.licence.key);
    expect((await k.store('GET', `/apps/${a.slug}`, undefined, buyer().token)).body.licence).toBeNull();
    expect((await k.store('GET', `/apps/${a.slug}`)).body.licence).toBeNull();
  });

  it('gives each app of a pack its own key, a staff grant of a paid app a key, and free apps none', async () => {
    const apps = [await k.makeApp({ free: false, price: usd(2999) }), await k.makeApp({ free: false, price: usd(3499) })];
    const pack = (await k.admin('POST', '/packs', { name: `Pack ${newId().slice(0, 6)}`, appIds: apps.map((a) => a.id), price: usd(4999) })).body;
    const c = buyer();
    expect((await buy(c, { packId: pack.id, expectedAmount: usd(4999) })).body.status).toBe('paid');
    const lib = (await k.store('GET', '/library', undefined, c.token)).body.items;
    const keys = lib.map((x: any) => x.licence.key);
    expect(keys).toHaveLength(2);
    expect(new Set(keys).size).toBe(2);
    expect(lib[0].licence.devicesLabel).toBe('Use on any number of devices');

    const free = await k.makeApp();
    const got = await k.store('POST', `/apps/${free.slug}/get`, undefined, c.token);
    expect(got.body.licenceKey).toBeNull();
    expect((await k.store('GET', `/apps/${free.slug}`, undefined, c.token)).body).toMatchObject({ owned: true, licence: null, licenceDevices: null });

    const paidApp = await k.makeApp({ free: false, price: usd(999) });
    const granted = await k.admin('POST', '/entitlements', { customerId: c.id, appId: paidApp.id, reason: 'Goodwill after a failed install' });
    expect(granted.status).toBe(201);
    expect(granted.body).toMatchObject({ source: 'staff', licenceKey: expect.stringMatching(KEY) });
    expect(k.audits.find((x) => x.action === 'software.entitlement.grant')?.after).toMatchObject({ licenceKey: `…${granted.body.licenceKey.slice(-5)}` });
  });

  it('lets staff find owners by app, key, reference or email and reissue a key (audited, customer told)', async () => {
    const a = await k.makeApp({ title: 'VaultGuard VPN', free: false, price: usd(499), licenceDevices: 5 });
    const c = buyer();
    k.names.set(c.id, 'Dana Ross');
    const p = (await buy(c, { appId: a.id, expectedAmount: usd(499) })).body;
    const key = (await k.store('GET', `/apps/${a.slug}`, undefined, c.token)).body.licence.key as string;

    const byApp = await k.admin('GET', `/entitlements?appId=${a.id}`);
    expect(byApp.status, JSON.stringify(byApp.body)).toBe(200);
    expect(byApp.body.items).toEqual([
      expect.objectContaining({ app: expect.objectContaining({ id: a.id, title: 'VaultGuard VPN' }), free: false, customer: { id: c.id, name: 'Dana Ross', email: `${c.id.slice(0, 8)}@example.com` }, source: 'purchase', purchaseId: p.id, purchaseRef: p.ref, licenceKey: key, licenceReissues: 0 }),
    ]);
    const typed = key.toLowerCase().replace(/-/g, ' ');
    expect((await k.admin('GET', `/entitlements?q=${encodeURIComponent(typed)}`)).body.items.map((e: any) => e.id)).toEqual([byApp.body.items[0].id]);
    expect((await k.admin('GET', `/entitlements?q=${p.ref}`)).body.items.map((e: any) => e.licenceKey)).toEqual([key]);
    expect((await k.admin('GET', `/entitlements?q=${c.id.slice(0, 8)}@example.com`)).body.items.map((e: any) => e.licenceKey)).toEqual([key]);
    expect((await k.admin('GET', `/entitlements?customerId=${c.id}`)).body.items).toHaveLength(1);
    expect((await k.admin('GET', `/entitlements?q=nobody@example.com`)).body.items).toEqual([]);

    const id = byApp.body.items[0].id;
    expect((await k.admin('POST', `/entitlements/${id}/reissue-licence`, { reason: 'Key leaked' }, k.staff(['software.view']))).status).toBe(403);
    expect((await k.admin('POST', `/entitlements/${id}/reissue-licence`, { reason: ' ' })).body.error.code).toBe('VALIDATION_FAILED');
    const re = await k.admin('POST', `/entitlements/${id}/reissue-licence`, { reason: 'Key leaked on a forum' });
    expect(re.status, JSON.stringify(re.body)).toBe(200);
    expect(re.body).toMatchObject({ id, licenceReissues: 1 });
    expect(re.body.licenceKey).toMatch(KEY);
    expect(re.body.licenceKey).not.toBe(key);
    expect((await k.store('GET', `/apps/${a.slug}`, undefined, c.token)).body.licence).toMatchObject({ key: re.body.licenceKey, devicesLabel: 'Use on up to 5 devices' });
    expect(k.audits.find((x) => x.action === 'software.licence.reissue')).toMatchObject({ reason: 'Key leaked on a forum', before: { licenceKey: `…${key.slice(-5)}` }, after: { licenceKey: `…${re.body.licenceKey.slice(-5)}`, reissues: 1 } });
    expect(k.named('software.licence.reissued')).toEqual([{ entitlementId: id, customerId: c.id, appId: a.id, slug: a.slug, title: 'VaultGuard VPN' }]);
    expect((await k.admin('POST', `/entitlements/${newId()}/reissue-licence`, { reason: 'x' })).status).toBe(404);

    const free = await k.makeApp();
    await k.store('POST', `/apps/${free.slug}/get`, undefined, c.token);
    const freeRow = (await k.admin('GET', `/entitlements?appId=${free.id}`)).body.items[0];
    expect(freeRow).toMatchObject({ free: true, licenceKey: null });
    expect((await k.admin('POST', `/entitlements/${freeRow.id}/reissue-licence`, { reason: 'Asked' })).body.error.code).toBe('NO_LICENCE');
  });

  it('gives a key to entitlements made before keys existed: the migration, or the owner opening the app', async () => {
    const a = await k.makeApp({ free: false, price: usd(1999), licenceLabel: 'One-time purchase · 3 devices' });
    const c1 = buyer();
    const c2 = buyer();
    await buy(c1, { appId: a.id, expectedAmount: usd(1999) });
    await buy(c2, { appId: a.id, expectedAmount: usd(1999) });
    // as stored before 2026-10-22: no key, no licence_devices
    await db().collection('software.entitlements').updateMany({ app_id: a.id }, { $set: { licence_key: null, licence_issued_at: null } });
    await db().collection('software.apps').updateOne({ _id: a.id }, { $unset: { licence_devices: '' } });

    // the owner opening the app gets one at once
    const opened = (await k.store('GET', `/apps/${a.slug}`, undefined, c1.token)).body.licence;
    expect(opened.key).toMatch(KEY);

    await licenceKeys.up(db());
    await licenceKeys.up(db()); // safe to run again
    const rows = await db().collection('software.entitlements').find({ app_id: a.id }).toArray();
    expect(rows.every((r: any) => KEY.test(r.licence_key))).toBe(true);
    expect(rows.find((r: any) => r.customer_id === c1.id).licence_key).toBe(opened.key); // kept
    expect((await db().collection('software.apps').findOne({ _id: a.id })).licence_devices).toBe(3);
    const page = (await k.store('GET', `/apps/${a.slug}`, undefined, c2.token)).body;
    expect(page.licence).toMatchObject({ key: rows.find((r: any) => r.customer_id === c2.id).licence_key, devices: 3 });
  });

  it('validates the devices count', async () => {
    const bad = await k.admin('POST', '/apps', { title: 'Bad', company: { name: 'X' }, categoryId: (await k.category()).id, brief: 'b', description: 'd', free: false, price: usd(100), licenceDevices: 0, platforms: ['windows'] });
    expect(bad.body.error.details.issues[0].path).toBe('licenceDevices');
    const free = await k.makeApp({ licenceDevices: 4 });
    expect(free.licenceDevices).toBeNull();
  });
});
