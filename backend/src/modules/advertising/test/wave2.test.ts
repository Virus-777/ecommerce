/**
 * Wave 2 (BACKEND-REQUESTS.md): campaigns by AD- ref (G69c), optional pause and finish reasons (G68) and the
 * campaign list export rows (G72).
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { newId } from '../../../kernel/lib/ids.js';
import { ADMIN, boot, campaignInput, liveCampaign, type Kit } from './helpers.js';

let k: Kit;
beforeAll(async () => {
  k = await boot();
});
afterAll(async () => {
  await k?.close();
});

describe('ad campaigns by ref (G69c)', () => {
  it('opens a campaign by its AD- ref as well as its id', async () => {
    const created = await k.call('POST', `${ADMIN}/campaigns`, k.staff, campaignInput(k, { name: 'By ref' }));
    expect(created.status, JSON.stringify(created.body)).toBe(201);
    const byRef = await k.call('GET', `${ADMIN}/campaigns/${created.body.ref}`, k.staff);
    expect(byRef.status, JSON.stringify(byRef.body)).toBe(200);
    expect(byRef.body).toMatchObject({ id: created.body.id, ref: created.body.ref });
    expect((await k.call('GET', `${ADMIN}/campaigns/AD-000000-0000`, k.staff)).status).toBe(404);
    expect((await k.call('GET', `${ADMIN}/campaigns/${newId()}`, k.staff)).status).toBe(404);
  });
});

describe('pause and finish without a reason (G68)', () => {
  it('uses the default wording, still audited', async () => {
    const live = await liveCampaign(k, { name: 'No reason' });
    const paused = await k.call('POST', `${ADMIN}/campaigns/${live.id}/pause`, k.staff, {});
    expect(paused.status, JSON.stringify(paused.body)).toBe(200);
    expect(paused.body.status).toBe('paused');
    expect(k.audits.filter((a) => a.target.id === live.id).at(-1)).toMatchObject({ reason: 'Paused by the Advertising team' });
    const finished = await k.call('POST', `${ADMIN}/campaigns/${live.id}/finish`, k.staff, {});
    expect(finished.status, JSON.stringify(finished.body)).toBe(200);
    expect(finished.body.status).toBe('finished');
    expect(k.audits.filter((a) => a.target.id === live.id).at(-1)).toMatchObject({ reason: 'Finished early by the Advertising team' });
  });
});

describe('campaign list export (G72)', () => {
  it('answers the admin list as rows with its filters; staff only', async () => {
    const created = await k.call('POST', `${ADMIN}/campaigns`, k.staff, campaignInput(k, { name: 'Exported campaign' }));
    const { rows } = await k.svc.exportRows('advertising.admin.campaigns', { q: 'Exported campaign' }, { kind: 'staff', accountId: newId() } as never);
    expect(rows).toEqual([expect.objectContaining({ ref: created.body.ref, name: 'Exported campaign', advertiser: 'Marketly', status: 'draft' })]);
    await expect(k.svc.exportRows('advertising.admin.campaigns', {}, { kind: 'seller', sellerId: newId(), accountId: newId() } as never)).rejects.toMatchObject({ code: 'FORBIDDEN' });
    await expect(k.svc.exportRows('advertising.other', {}, { kind: 'staff', accountId: newId() } as never)).rejects.toMatchObject({ code: 'NOT_FOUND' });
  });
});
