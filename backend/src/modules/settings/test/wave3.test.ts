/**
 * Wave 3 (G76): sections other modules report. A value whose key is a runtime setting gets its type, its
 * scheduled change and the section's last change from settings; a section of runtime settings only may be
 * edited here (ownedHere); a provider may load asynchronously.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { draft, harness, inDays, staff, submit, type Harness } from './helpers.js';

let h: Harness;
beforeAll(async () => {
  h = await harness();
});
afterAll(async () => {
  await h?.app.close();
});
beforeEach(() => {
  h.clock.set(new Date());
  h.access.decision = 'allowed';
});

describe('module sections (G76)', () => {
  it('adds type, scheduled change and last change to runtime-setting values; ownedHere only for those', async () => {
    await h.api.registerSection({
      key: 'support_sla',
      order: 160,
      load: async () => ({
        key: 'support_sla',
        title: 'Support targets',
        ownerModule: 'support',
        ownedHere: true,
        values: [{ key: 'support.maxAttachments', label: 'Attachments per message', valueText: '5', value: 5, exampleValue: false }],
        lastChange: null,
        scheduled: [],
        link: null,
        available: true,
      }),
    });
    await h.api.registerSection({
      key: 'fees',
      order: 110,
      load: () => ({
        key: 'fees',
        title: 'Commission and fees',
        ownerModule: 'finance',
        ownedHere: true, // not honoured: its values are not runtime settings
        values: [{ key: null, label: 'Electronics', valueText: '8%', exampleValue: true }],
        lastChange: null,
        scheduled: [],
        link: { module: 'finance', area: 'admin', path: '/api/admin/finance/fee-rules' },
        available: true,
      }),
    });
    const c = (await draft(h, { items: [{ key: 'support.maxAttachments', value: 8 }], effectiveAt: inDays(h, 3) })).json();
    expect((await submit(h, c.id)).statusCode).toBe(200);

    const res = await h.app.inject({ method: 'GET', url: '/api/admin/settings/overview', headers: staff() });
    expect(res.statusCode, res.body).toBe(200);
    const sla = (res.json().sections as any[]).find((s) => s.key === 'support_sla');
    expect(sla).toMatchObject({ ownedHere: true, available: true });
    expect(sla.values[0]).toMatchObject({ key: 'support.maxAttachments', valueType: 'int', value: 5 });
    expect(sla.values[0].hint).toMatch(/^Changes to 8 on /);
    expect(sla.scheduled).toEqual([expect.objectContaining({ source: 'settings', ref: c.ref, status: 'scheduled' })]);
    const fees = (res.json().sections as any[]).find((s) => s.key === 'fees');
    expect(fees).toMatchObject({ ownedHere: false, link: { path: '/api/admin/finance/fee-rules' }, scheduled: [] });
    expect(fees.subtitle).not.toBe('Not reported by its module yet');
  });
});
