/**
 * Fix round 2026-10-17 (Ops photo uploads). The Admin Center uploads every file as the platform's (ownerKind platform)
 * and the upload records the staff member who started it. Modules that expect a staff member's own file also take a
 * platform file that same staff member uploaded; never another staff member's, a generated file or a seller's.
 * Staff uploads need media.uploads.create only; editing and deleting platform files stay with media.assets.manage.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { newId } from '../../../kernel/lib/ids.js';
import { auth, callers, mediaApp, pdf, png, startUpload, uploadFile, type MediaTestApp } from './helpers.js';

let t: MediaTestApp;
beforeAll(async () => {
  t = await mediaApp();
});
afterAll(async () => {
  await t?.app.close();
});

const code = async (p: Promise<unknown>) => {
  try {
    await p;
    return 'ok';
  } catch (err) {
    return (err as { code?: string }).code ?? String(err);
  }
};
/** A staff member who may only upload, like a warehouse worker */
const uploader = (accountId: string) => callers.staff(['media.uploads.create'], { sub: accountId });
const usage = () => ({ module: 'returns', kind: 'inspection_photo' as const, refId: newId(), refLabel: 'Inspection of RT-1' });

describe('staff work files', () => {
  it('a platform file the staff member uploaded counts as theirs (attach, readFile); not for anyone else', async () => {
    const wes = newId();
    const ana = newId();
    const { asset } = await uploadFile(t, 'admin', uploader(wes), { purpose: 'inspection_photo', body: png(800, 600, { seed: 'damage' }) }, { ownerKind: 'platform' });
    expect(asset.owner).toMatchObject({ kind: 'platform', id: null });

    await t.media.attach(asset.id, usage(), { kind: 'staff', id: wes });
    expect((await t.media.readFile(asset.id, { kind: 'staff', id: wes })).sizeBytes).toBe(asset.sizeBytes);
    // still the platform's: modules expecting a platform file take it as before
    await t.media.attach(asset.id, { ...usage(), module: 'inventory' }, { kind: 'platform' });
    // another staff member can't use it as theirs
    expect(await code(t.media.attach(asset.id, usage(), { kind: 'staff', id: ana }))).toBe('ASSET_NOT_OWNED');
    expect(await code(t.media.readFile(asset.id, { kind: 'staff', id: ana }))).toBe('ASSET_NOT_OWNED');
    expect(await code(t.media.attach(asset.id, usage(), { kind: 'staff', id: null }))).toBe('ASSET_NOT_OWNED');
  });

  it("a staff member still can't attach another staff member's file, a generated file or a seller's file", async () => {
    const wes = newId();
    const ana = newId();
    const anas = await uploadFile(t, 'admin', uploader(ana), { purpose: 'inspection_photo', body: png(800, 600, { seed: 'ana-own' }) }, { ownerKind: 'staff' });
    expect(anas.asset.owner).toMatchObject({ kind: 'staff', id: ana });
    expect(await code(t.media.attach(anas.asset.id, usage(), { kind: 'staff', id: wes }))).toBe('ASSET_NOT_OWNED');
    await t.media.attach(anas.asset.id, usage(), { kind: 'staff', id: ana }); // her own file, as before

    const generated = await t.media.storeGeneratedFile({ owner: { kind: 'platform' }, fileName: 'export.csv', contentType: 'text/csv', body: new Blob(['a,b\n']).stream(), purpose: 'export' });
    expect(await code(t.media.readFile(generated.id, { kind: 'staff', id: wes }))).toBe('ASSET_NOT_OWNED');

    const sellerId = newId();
    const sellers = await uploadFile(t, 'seller', callers.seller({ sellerId }), { purpose: 'inspection_photo', body: png(800, 600, { seed: 'seller-photo' }) });
    expect(await code(t.media.attach(sellers.asset.id, usage(), { kind: 'staff', id: wes }))).toBe('ASSET_NOT_OWNED');
  });

  it('staff uploads need media.uploads.create; editing and deleting platform files still need media.assets.manage', async () => {
    const wes = newId();
    const doc = { purpose: 'other_document' as const, fileName: 'note.pdf', contentType: 'application/pdf', body: pdf(1) };
    const { asset } = await uploadFile(t, 'admin', uploader(wes), doc, { ownerKind: 'platform' });
    expect(asset.status).toBe('ready');

    const manageOnly = callers.staff(['media.assets.manage'], { sub: newId() });
    const refused = await startUpload(t, 'admin', manageOnly, { purpose: 'inspection_photo' }, { ownerKind: 'platform' });
    expect(refused.statusCode).toBe(403);

    const patch = await t.app.inject({ method: 'PATCH', url: `/api/admin/media/assets/${asset.id}`, headers: auth(uploader(wes)), payload: { title: 'Note' } });
    expect(patch.statusCode).toBe(403);
    const del = await t.app.inject({ method: 'DELETE', url: `/api/admin/media/assets/${asset.id}`, headers: auth(uploader(wes)) });
    expect(del.statusCode).toBe(403);
    const remove = await t.app.inject({ method: 'POST', url: `/api/admin/media/assets/${asset.id}/remove`, headers: auth(uploader(wes)), payload: { reason: 'x', category: 'policy' } });
    expect(remove.statusCode).toBe(403);
  });
});
