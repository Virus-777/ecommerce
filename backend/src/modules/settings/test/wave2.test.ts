/**
 * Wave 2 (web team requests): default delivery location (G21), company facts (G32c), seller-visible values (G52c),
 * the change reason asked at submit (G68) and raw values in the overview (G75).
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { auth, callers } from '../../../testing/app.js';
import { draft, harness, inDays, inMinutes, staff, submit, type Harness } from './helpers.js';

let h: Harness;
beforeAll(async () => {
  h = await harness();
});
afterAll(async () => {
  await h?.app.close();
});
beforeEach(() => {
  h.clock.set(new Date());
  h.access.decision = 'approval_required';
  h.events.length = 0;
  h.audits.length = 0;
});

describe('public market facts', () => {
  it('app-config gives the default delivery location and the company facts (G21, G32c)', async () => {
    const res = await h.app.inject({ method: 'GET', url: '/api/public/settings/app-config', headers: auth(callers.visitor()) });
    expect(res.statusCode).toBe(200);
    expect(res.json().market).toMatchObject({
      companyLine: 'Marketly, Inc. · Portland, OR',
      defaultDeliveryLocation: { postalCode: '97205', label: 'Portland, OR 97205' },
      company: { helpEmail: 'help@marketly.example', sellersEmail: 'sellers@marketly.example', pressEmail: 'press@marketly.example', headquarters: 'Portland, OR', foundedYear: 2026, postalAddress: expect.any(String) },
    });
    const info = await h.api.storeInfo();
    expect(info.market.defaultDeliveryLocation).toEqual({ postalCode: '97205', label: 'Portland, OR 97205' });
    const gql = await h.app.inject({
      method: 'POST',
      url: '/graphql/store',
      headers: auth(callers.visitor()),
      payload: { query: '{ storeInfo { market { defaultDeliveryLocation { postalCode label } company { helpEmail sellersEmail pressEmail headquarters foundedYear } } } }' },
    });
    expect(gql.json().errors).toBeUndefined();
    expect(gql.json().data.storeInfo.market).toMatchObject({ defaultDeliveryLocation: { postalCode: '97205' }, company: { pressEmail: 'press@marketly.example', headquarters: 'Portland, OR' } });
  });

  it('checks the delivery location and the emails', async () => {
    const bad = await draft(h, { items: [{ key: 'market.defaultDeliveryLocation', value: { postalCode: 'abc', label: 'Somewhere' } }], effectiveAt: inDays(h, 1) });
    expect([bad.statusCode, bad.json().error.code]).toEqual([400, 'VALIDATION_FAILED']);
    const email = await draft(h, { items: [{ key: 'market.pressEmail', value: 'not an email' }], effectiveAt: inDays(h, 1) });
    expect(email.statusCode).toBe(400);
  });
});

describe('seller-visible values (G52c)', () => {
  it('lists the value in force of every seller-visible setting', async () => {
    const res = await h.app.inject({ method: 'GET', url: '/api/seller/settings/current', headers: auth(callers.seller()) });
    expect(res.statusCode, res.body).toBe(200);
    const byKey = new Map((res.json() as any[]).map((v) => [v.key, v]));
    expect(byKey.get('catalog.minDescriptionLength')).toMatchObject({ module: 'catalog', value: 40, valueText: '40 characters', valueType: 'int' });
    expect(byKey.has('support.maxAttachments')).toBe(false);
  });
});

describe('change reason (G68)', () => {
  it('drafts and previews without a reason; submit asks for it', async () => {
    const created = await draft(h, { items: [{ key: 'support.maxAttachments', value: 7 }], effectiveAt: inMinutes(h, 5), reason: undefined as never });
    // the helper fills a reason: draft again without one
    const c = await h.app.inject({ method: 'POST', url: '/api/admin/settings/changes', headers: staff(), payload: { items: [{ key: 'support.autoCloseAfterDays', value: 9 }], effectiveAt: inMinutes(h, 5), applyScope: 'new_only' } });
    expect(c.statusCode, c.body).toBe(201);
    expect(c.json().reason).toBeNull();
    expect((await h.app.inject({ method: 'POST', url: `/api/admin/settings/changes/${c.json().id}/preview`, headers: staff() })).statusCode).toBe(200);
    const missing = await submit(h, c.json().id);
    expect([missing.statusCode, missing.json().error.details.issues[0].path]).toEqual([400, 'reason']);
    h.access.decision = 'allowed';
    const ok = await h.app.inject({ method: 'POST', url: `/api/admin/settings/changes/${c.json().id}/submit`, headers: staff(), payload: { reason: 'Customers asked for more time' } });
    expect(ok.statusCode, ok.body).toBe(200);
    expect(ok.json()).toMatchObject({ reason: 'Customers asked for more time', status: 'scheduled' });
    expect(h.audits.at(-1)).toMatchObject({ action: 'settings.change.submit', reason: 'Customers asked for more time' });
    // a draft with a reason still submits without a body
    await h.app.inject({ method: 'POST', url: `/api/admin/settings/changes/${created.json().id}/cancel`, headers: staff(), payload: { reason: 'Test done' } });
  });
});

describe('overview raw values (G75)', () => {
  it('gives the raw value and type next to the text', async () => {
    const res = await h.app.inject({ method: 'GET', url: '/api/admin/settings/overview', headers: staff() });
    const values = (res.json().sections as any[]).flatMap((s) => s.values);
    expect(values.find((v) => v.key === 'catalog.minDescriptionLength')).toMatchObject({ value: 40, valueType: 'int', valueText: '40 characters' });
    expect(values.find((v) => v.key === 'market.defaultDeliveryLocation')).toMatchObject({ value: { postalCode: '97205', label: 'Portland, OR 97205' }, valueType: 'json' });
  });
});
