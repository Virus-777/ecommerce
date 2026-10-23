import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
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
});

const card = (token = 'tok_visa') => ({ kind: 'new_card', providerToken: token });
const RETURN = 'https://store.example/software/return';
const buyer = () => {
  const id = newId();
  return { id, token: k.customer(id) };
};
const buy = (who: { token: Record<string, string> }, body: Record<string, unknown>, headers: Record<string, string> = {}) => k.store('POST', '/purchases', { method: card(), returnUrl: RETURN, ...body }, { ...who.token, ...headers });

describe('free apps', () => {
  it('owns a free app on Get, answers the same when owned and refuses paid apps', async () => {
    const free = await k.makeApp({ title: 'NoteFlow' });
    const paid = await k.makeApp({ free: false, price: usd(999) });
    const c = buyer();
    const got = await k.store('POST', `/apps/${free.slug}/entitlements`, undefined, c.token);
    expect(got.status, JSON.stringify(got.body)).toBe(200);
    expect(got.body).toMatchObject({ appId: free.id, slug: free.slug, title: 'NoteFlow', source: 'free' });
    expect((await k.store('POST', `/apps/${free.slug}/entitlements`, undefined, c.token)).body).toEqual(got.body);
    expect((await k.admin('GET', `/apps/${free.id}`)).body.owners).toBe(1);
    expect((await k.store('POST', `/apps/${paid.slug}/entitlements`, undefined, c.token)).body.error.code).toBe('NOT_FREE');
    expect((await k.store('GET', '/library', undefined, c.token)).body.items).toEqual([expect.objectContaining({ source: 'free', app: expect.objectContaining({ id: free.id, owned: true }) })]);
  });
});

describe('buying', () => {
  it('captures at once, owns the app, publishes software.purchase.paid and answers the same key with the same purchase', async () => {
    const a = await k.makeApp({ title: 'PixelCraft Studio', free: false, price: usd(2499), salePrice: usd(1249), saleEndsAt: new Date(k.clock.now().getTime() + 86_400_000).toISOString() });
    const c = buyer();
    expect((await k.store('GET', `/payment-options?appId=${a.id}`, undefined, c.token)).status).toBe(200);
    // the price the customer saw must be the current one
    const changed = await buy(c, { appId: a.id, expectedAmount: usd(2499) });
    expect(changed.status).toBe(409);
    expect(changed.body.error).toMatchObject({ code: 'PRICE_CHANGED', details: { amount: usd(1249) } });
    expect((await buy(c, { appId: a.id, packId: newId(), expectedAmount: usd(1249) })).body.error.code).toBe('VALIDATION_FAILED');

    const key = { 'idempotency-key': newId() };
    const res = await buy(c, { appId: a.id, expectedAmount: usd(1249) }, key);
    expect(res.status, JSON.stringify(res.body)).toBe(201);
    expect(res.body).toMatchObject({ status: 'paid', statusLabel: 'Paid', title: 'PixelCraft Studio', amount: usd(1249), packId: null, items: [{ appId: a.id, slug: a.slug }], payment: { state: 'captured', module: 'software', methodLabel: 'Visa •••• 4242' } });
    expect(res.body.ref).toMatch(/^SW-[23456789ABCDEFGHJKLMNPQRSTUVWXYZ]{5}$/);
    expect(res.body.paidAt).toBeTruthy();
    expect(k.named('software.purchase.paid')).toEqual([{ purchaseId: res.body.id, ref: res.body.ref, customerId: c.id, title: 'PixelCraft Studio', amount: usd(1249), appIds: [a.id] }]);
    expect(k.named('payments.purchase.captured')).toEqual([expect.objectContaining({ module: 'software', refId: res.body.id, amount: usd(1249) })]);
    expect((await buy(c, { appId: a.id, expectedAmount: usd(1249) }, key)).body.id).toBe(res.body.id);
    expect((await buy(c, { appId: a.id, expectedAmount: usd(1249) })).body.error.code).toBe('ALREADY_OWNED');
    expect((await k.store('GET', `/apps/${a.slug}`, undefined, c.token)).body).toMatchObject({ owned: true, canReview: true });
    expect((await k.admin('GET', `/apps/${a.id}`)).body.owners).toBe(1);
    // another customer's purchase is not found
    expect((await k.store('GET', `/purchases/${res.body.id}`, undefined, k.customer(newId()))).status).toBe(404);
    expect((await k.store('GET', '/purchases', undefined, c.token)).body.items.map((p: any) => p.id)).toEqual([res.body.id]);
  });

  it('refuses what is not for sale', async () => {
    const c = buyer();
    const free = await k.makeApp();
    const draft = await k.makeApp({ status: 'draft', free: false, price: usd(500) });
    expect((await buy(c, { appId: free.id, expectedAmount: usd(0) })).body.error.code).toBe('NOT_FOR_SALE');
    expect((await buy(c, { appId: draft.id, expectedAmount: usd(500) })).body.error.code).toBe('NOT_FOR_SALE');
    expect((await buy(c, { appId: newId(), expectedAmount: usd(500) })).status).toBe(404);
  });

  it('keeps a declined purchase failed with the decline, and retries it with another card', async () => {
    const a = await k.makeApp({ free: false, price: usd(699) });
    const c = buyer();
    const failed = await buy(c, { appId: a.id, expectedAmount: usd(699), method: card('tok_declined') });
    expect(failed.status).toBe(201);
    expect(failed.body).toMatchObject({ status: 'failed', payment: { state: 'failed', retryAllowed: true, decline: { code: '05', category: 'card_declined' } } });
    expect(k.named('software.purchase.failed')).toEqual([expect.objectContaining({ purchaseId: failed.body.id, customerId: c.id })]);
    const retried = await k.store('POST', `/purchases/${failed.body.id}/retry`, { method: card('tok_mastercard'), returnUrl: RETURN }, c.token);
    expect(retried.status, JSON.stringify(retried.body)).toBe(200);
    expect(retried.body).toMatchObject({ status: 'paid', payment: { state: 'captured', methodLabel: 'Mastercard •••• 4444' } });
    expect((await k.store('POST', `/purchases/${failed.body.id}/retry`, { method: card(), returnUrl: RETURN }, c.token)).body.error.code).toBe('ILLEGAL_TRANSITION');
    const admin = (await k.admin('GET', `/purchases?q=${failed.body.ref}`)).body.items;
    expect(admin).toEqual([expect.objectContaining({ id: failed.body.id, status: 'paid', methodLabel: 'Mastercard •••• 4444', customer: expect.objectContaining({ id: c.id }) })]);
  });

  it('finishes a bank challenge with complete-action, and abandons one left for 30 minutes', async () => {
    const a = await k.makeApp({ free: false, price: usd(1499) });
    const c = buyer();
    const pending = await buy(c, { appId: a.id, expectedAmount: usd(1499), method: card('tok_3ds') });
    expect(pending.body).toMatchObject({ status: 'requires_action', payment: { state: 'requires_action', nextAction: { kind: 'three_ds_challenge' } } });
    const done = await k.store('POST', `/purchases/${pending.body.id}/complete-action`, { resultToken: '3ds_ok' }, c.token);
    expect(done.status, JSON.stringify(done.body)).toBe(200);
    expect(done.body).toMatchObject({ status: 'paid', payment: { state: 'captured' } });
    expect(k.named('software.purchase.paid')).toHaveLength(1);
    expect((await k.store('POST', `/purchases/${pending.body.id}/complete-action`, { resultToken: '3ds_ok' }, c.token)).body.error.code).toBe('ILLEGAL_TRANSITION');

    const b = await k.makeApp({ free: false, price: usd(1999) });
    const left = await buy(c, { appId: b.id, expectedAmount: usd(1999), method: card('tok_3ds') });
    expect(left.body.status).toBe('requires_action');
    k.clock.advance(31 * 60_000);
    await k.run('software.abandon-stale');
    const after = (await k.store('GET', `/purchases/${left.body.id}`, undefined, k.customer(c.id))).body;
    expect(after).toMatchObject({ status: 'cancelled', payment: { state: 'failed' } });
  });

  it('waits on a payment the bank is checking and settles it from payments.purchase.authorized', async () => {
    const a = await k.makeApp({ free: false, price: usd(999) });
    const c = buyer();
    const res = await buy(c, { appId: a.id, expectedAmount: usd(999), method: card('tok_pending') });
    expect(res.body).toMatchObject({ status: 'pending_payment', payment: { state: 'pending' } });
    expect((await k.store('GET', `/purchases/${res.body.id}?refresh=true`, undefined, c.token)).body.status).toBe('pending_payment');
    const intentId = res.body.payment.intentId;
    const settled = await k.call('POST', `/api/dev/payments/intents/${intentId}/settle`, { outcome: 'authorized' });
    expect(settled.status, JSON.stringify(settled.body)).toBe(200);
    await k.app.kernel.events.drain();
    const after = (await k.store('GET', `/purchases/${res.body.id}`, undefined, c.token)).body;
    expect(after).toMatchObject({ status: 'paid', payment: { state: 'captured' } });
    expect(k.named('software.purchase.paid')).toHaveLength(1);

    // a declined check fails the purchase
    const b = await k.makeApp({ free: false, price: usd(999) });
    const second = await buy(c, { appId: b.id, expectedAmount: usd(999), method: card('tok_pending') });
    await k.call('POST', `/api/dev/payments/intents/${second.body.payment.intentId}/settle`, { outcome: 'declined' });
    await k.app.kernel.events.drain();
    expect((await k.store('GET', `/purchases/${second.body.id}`, undefined, c.token)).body.status).toBe('failed');
  });

  it('sells a pack at its price and grants only the apps the customer does not own yet', async () => {
    const apps = [await k.makeApp({ free: false, price: usd(2999) }), await k.makeApp({ free: false, price: usd(3499) }), await k.makeApp({ free: false, price: usd(3499) })];
    const pack = (await k.admin('POST', '/packs', { name: `Office pack ${newId().slice(0, 4)}`, appIds: apps.map((a) => a.id), price: usd(5999) })).body;
    const c = buyer();
    await k.admin('POST', '/entitlements', { customerId: c.id, appId: apps[0].id, reason: 'Goodwill after an outage' });
    expect((await k.admin('POST', '/entitlements', { customerId: c.id, appId: apps[0].id, reason: 'Again' })).body.error.code).toBe('ALREADY_OWNED');
    expect(k.audits.map((x) => x.action)).toContain('software.entitlement.grant');
    const res = await buy(c, { packId: pack.id, expectedAmount: usd(5999) });
    expect(res.body).toMatchObject({ status: 'paid', title: pack.name, packId: pack.id, amount: usd(5999) });
    expect(res.body.items).toHaveLength(3);
    const lib = (await k.store('GET', '/library', undefined, c.token)).body.items;
    expect(lib.map((x: any) => x.source).sort()).toEqual(['pack', 'pack', 'staff']);
    expect((await k.admin('GET', '/packs')).body.find((p: any) => p.id === pack.id).sold).toBe(1);
    expect((await buy(c, { packId: pack.id, expectedAmount: usd(5999) })).body.error.code).toBe('ALREADY_OWNED');
    expect((await k.admin('DELETE', `/packs/${pack.id}`)).body.error.code).toBe('IN_USE');
    expect((await k.store('GET', '/deals', undefined, c.token)).body.packs.find((p: any) => p.id === pack.id).owned).toBe(true);
  });
});

describe('downloads', () => {
  it('gives any signed-in customer a signed link to the package (counted) or a database, owner or not', async () => {
    const db = await k.pkg('presets.zip');
    const a = await k.makeApp({ databaseIds: [db], databasesNote: 'Presets for offline use', free: false, price: usd(2499) });
    const c = buyer();
    // a visitor signs in first; the page says so
    expect((await k.store('POST', `/apps/${a.slug}/downloads`, {})).status).toBe(401);
    expect((await k.store('GET', `/apps/${a.slug}`)).body).toMatchObject({ canDownload: false, owned: false, licence: null });
    expect((await k.store('GET', `/apps/${a.slug}`, undefined, c.token)).body).toMatchObject({ canDownload: true, owned: false, licence: null });
    // no purchase needed: the paid app is unlocked by its licence key, not by the download
    const link = await k.store('POST', `/apps/${a.slug}/downloads`, {}, c.token);
    expect(link.status, JSON.stringify(link.body)).toBe(200);
    expect(link.body).toMatchObject({ fileName: a.files.package.name, contentType: 'application/zip' });
    expect(new URL(link.body.url).searchParams.get('cd')).toMatch(/^attachment/);
    const file = await k.app.inject({ method: 'GET', url: new URL(link.body.url).pathname + new URL(link.body.url).search });
    expect(file.statusCode).toBe(200);
    expect(file.rawPayload.subarray(0, 2).toString('latin1')).toBe('PK');
    expect((await k.store('POST', `/apps/${a.slug}/downloads`, { fileId: db }, c.token)).body.fileName).toBe('presets.zip');
    expect((await k.store('POST', `/apps/${a.slug}/downloads`, { fileId: newId() }, c.token)).body.error.code).toBe('FILE_MISSING');
    const detail = (await k.store('GET', `/apps/${a.slug}`)).body;
    expect(detail.downloads).toBe(1);
    expect(detail.files).toMatchObject({ databasesNote: 'Presets for offline use', databases: [expect.objectContaining({ id: db, kind: 'database' })] });
    // the sizes on the Download buttons
    expect(detail.files.databasesSizeBytes).toBe(detail.files.databases[0].sizeBytes);
    expect(detail.files.databasesSizeLabel).toBe(detail.files.databases[0].sizeLabel);
    expect(detail.files.package.sizeLabel).toMatch(/ (B|KB)$/);
    expect((await k.store('GET', `/apps/${(await k.makeApp()).slug}`)).body.files).toMatchObject({ databases: [], databasesSizeBytes: 0, databasesSizeLabel: null });
  });

  it('keeps a hidden app downloadable by its owners only', async () => {
    const a = await k.makeApp();
    const owner = buyer();
    await k.store('POST', `/apps/${a.slug}/entitlements`, undefined, owner.token);
    expect((await k.admin('PATCH', `/apps/${a.id}`, { title: a.title, company: a.company, categoryId: a.categoryId, brief: a.brief, description: a.description, free: true, platforms: a.platforms, status: 'hidden' })).status).toBe(200);
    expect((await k.store('POST', `/apps/${a.slug}/downloads`, {}, owner.token)).status).toBe(200);
    expect((await k.store('POST', `/apps/${a.slug}/downloads`, {}, buyer().token)).status).toBe(404);
  });
});

describe('data export', () => {
  it('exports the purchases, owned apps and reviews of a customer', async () => {
    const a = await k.makeApp({ free: false, price: usd(499) });
    const c = buyer();
    const p = (await buy(c, { appId: a.id, expectedAmount: usd(499) })).body;
    await k.store('POST', `/apps/${a.slug}/reviews`, { stars: 4, text: 'Good' }, c.token);
    const service = k.app.kernel.boot.apis.get('software') as { exportCustomerData(i: { customerId: string; accountId: string }): Promise<any[]> };
    const sections = await service.exportCustomerData({ customerId: c.id, accountId: c.id });
    expect(sections.map((s) => s.key)).toEqual(['software_purchases', 'software_apps', 'software_reviews']);
    expect(sections[0].records).toEqual([expect.objectContaining({ ref: p.ref, status: 'paid', amount: usd(499) })]);
    expect(sections[1].records).toEqual([expect.objectContaining({ app: a.title, source: 'purchase', licenceKey: expect.stringMatching(/^[A-Z2-9]{5}(-[A-Z2-9]{5}){3}$/) })]);
    expect(sections[2].records).toEqual([expect.objectContaining({ stars: 4, text: 'Good' })]);
  });
});
