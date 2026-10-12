/**
 * Gap pass 3: new usage kinds (evidence kinds keep files past the orphan sweep), readFile, storeInboundFile,
 * findSimilar, gift card code files, and staff uploads completed only by the staff member who started them.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { newId } from '../../../kernel/lib/ids.js';
import { auth, callers, mediaApp, mediaTable, pdf, png, putContent, startUpload, uploadFile, type MediaTestApp } from './helpers.js';

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
const DAY = 86_400_000;
const staffToken = (accountId = newId()) => callers.staff(undefined, { sub: accountId });

describe('usage kinds', () => {
  it('attaches the new kinds; evidence kinds extend retainUntil and survive the orphan sweep', async () => {
    const staff = staffToken();
    const platform = { kind: 'platform' as const, id: null };
    const banner = await uploadFile(t, 'admin', staff, { purpose: 'content_image', body: png(1600, 600, { seed: 'brand-banner' }) }, { ownerKind: 'platform' });
    await t.media.attach(banner.asset.id, { module: 'catalog', kind: 'brand_banner', refId: newId() }, platform);
    const category = await uploadFile(t, 'admin', staff, { purpose: 'content_image', body: png(1200, 1200, { seed: 'category' }) }, { ownerKind: 'platform' });
    await t.media.attach(category.asset.id, { module: 'catalog', kind: 'category_image', refId: newId() }, platform);
    expect(await t.media.getAsset(banner.asset.id)).toMatchObject({ inUse: true, retainUntil: null });

    // a purchase order attachment (supplier_document) and a payment dispute file (dispute_evidence): evidence
    const po = await uploadFile(t, 'admin', staff, { purpose: 'other_document', fileName: 'invoice.pdf', contentType: 'application/pdf', body: pdf(1) }, { ownerKind: 'platform' });
    await t.media.attach(po.asset.id, { module: 'purchasing', kind: 'supplier_document', refId: 'PO-1' }, platform);
    const dispute = await uploadFile(t, 'admin', staff, { purpose: 'other_document', fileName: 'proof.pdf', contentType: 'application/pdf', body: pdf(2) }, { ownerKind: 'platform' });
    await t.media.attach(dispute.asset.id, { module: 'payments', kind: 'dispute_evidence', refId: 'DP-1' }, platform);
    for (const id of [po.asset.id, dispute.asset.id]) {
      expect(new Date((await t.media.getAsset(id))!.retainUntil!).getTime()).toBe(t.clock.now().getTime() + 730 * DAY);
    }
    // the purpose must fit: a product image is not a supplier document
    expect(await code(t.media.attach(banner.asset.id, { module: 'purchasing', kind: 'supplier_document', refId: 'PO-2' }, platform))).toBe('VALIDATION_FAILED');

    // past orphanGraceDays: attached files stay, a never-attached one goes
    const orphan = await uploadFile(t, 'admin', staff, { purpose: 'other_document', fileName: 'loose.pdf', contentType: 'application/pdf', body: pdf(3) }, { ownerKind: 'platform' });
    const start = t.clock.now();
    t.clock.advance(31 * DAY);
    try {
      await t.app.kernel.jobs.runNow('media.sweep-orphans');
    } finally {
      t.clock.set(start); // dev tokens of later tests are issued at real time
    }
    expect((await t.media.getAsset(po.asset.id))!.status).toBe('ready');
    expect((await t.media.getAsset(dispute.asset.id))!.status).toBe('ready');
    expect((await t.media.getAsset(orphan.asset.id))!.status).toBe('deleted');
  });

  it('describes the new kinds in plain words when a file cannot be deleted', async () => {
    const staff = staffToken();
    const { asset } = await uploadFile(t, 'admin', staff, { purpose: 'content_image', body: png(1600, 600, { seed: 'brand-banner-2' }) }, { ownerKind: 'platform' });
    await t.media.attach(asset.id, { module: 'catalog', kind: 'brand_banner', refId: newId() }, { kind: 'platform', id: null });
    const res = await t.app.inject({ method: 'GET', url: `/api/admin/media/assets/${asset.id}`, headers: auth(staff) });
    expect(res.statusCode, res.body).toBe(200);
    expect(JSON.stringify(res.json())).toContain('Used by 1 brand');
  });
});

describe('readFile', () => {
  it('returns the bytes of a ready file to its owner, within maxBytes', async () => {
    const sellerId = newId();
    const owner = { kind: 'seller' as const, id: sellerId };
    const csv = Buffer.from('sku,price\nA-1,12.50\n');
    const { asset } = await uploadFile(t, 'seller', callers.seller({ sellerId }), { purpose: 'bulk_file', fileName: 'prices.csv', contentType: 'text/csv', body: csv });
    expect(asset.status).toBe('ready');
    const file = await t.media.readFile(asset.id, owner);
    expect(file).toMatchObject({ fileName: 'prices.csv', contentType: 'text/csv', sizeBytes: csv.length });
    expect(Buffer.from(file.body).toString()).toBe(csv.toString());
    expect(await code(t.media.readFile(asset.id, { kind: 'seller', id: newId() }))).toBe('ASSET_NOT_OWNED');
    expect(await code(t.media.readFile(asset.id, owner, { maxBytes: 5 }))).toBe('FILE_TOO_LARGE');
    expect(await code(t.media.readFile(newId()))).toBe('NOT_FOUND');
    const pending = await uploadFile(t, 'seller', callers.seller({ sellerId }), { purpose: 'bulk_file', fileName: 'later.csv', contentType: 'text/csv', body: csv }, { process: false });
    expect(await code(t.media.readFile(pending.asset.id, owner))).toBe('ILLEGAL_TRANSITION');
  });
});

describe('storeInboundFile', () => {
  it('stores an inbound email attachment, processes it like an upload and keeps the source on its history', async () => {
    const owner = { kind: 'customer' as const, id: newId() };
    const asset = await t.media.storeInboundFile({ owner, purpose: 'message_attachment', fileName: 'receipt.pdf', contentType: 'application/pdf', body: pdf(1), source: 'inbound-email:evt_123' });
    expect(asset).toMatchObject({ status: 'processing', purpose: 'message_attachment', owner: { kind: 'customer', id: owner.id }, visibility: 'private' });
    await t.app.kernel.jobs.runNow('media.process');
    await t.app.kernel.events.drain();
    expect((await t.media.getAsset(asset.id))!.status).toBe('ready');
    expect(t.eventsNamed('media.asset.ready').some((e) => (e.payload as { assetId: string }).assetId === asset.id)).toBe(true);
    // the receiving module attaches it like any upload
    await t.media.attach(asset.id, { module: 'messaging', kind: 'message_attachment', refId: 'M-1' }, owner);
    const detail = await t.app.inject({ method: 'GET', url: `/api/admin/media/assets/${asset.id}`, headers: auth(staffToken()) });
    expect(detail.json().history).toEqual(expect.arrayContaining([expect.objectContaining({ label: 'Received', detail: 'inbound-email:evt_123' })]));
  });

  it('refuses types and sizes the purpose does not accept, so the sender can be told', async () => {
    const owner = { kind: 'customer' as const, id: newId() };
    const base = { owner, purpose: 'message_attachment' as const, source: 'inbound-email:evt_9' };
    expect(await code(t.media.storeInboundFile({ ...base, fileName: 'run.exe', contentType: 'application/x-msdownload', body: new Uint8Array([1, 2, 3]) }))).toBe('FILE_TYPE_NOT_ALLOWED');
    expect(await code(t.media.storeInboundFile({ ...base, fileName: 'huge.pdf', contentType: 'application/pdf', body: new Uint8Array(26 * 1024 * 1024) }))).toBe('FILE_TOO_LARGE');
    expect(await code(t.media.storeInboundFile({ ...base, purpose: 'product_image' as never, fileName: 'a.png', contentType: 'image/png', body: png(10, 10) }))).toBe('VALIDATION_FAILED');
  });
});

describe('findSimilar', () => {
  it('finds ready public images within the Hamming distance, closest first, never private evidence', async () => {
    const sellerA = newId();
    const sellerB = newId();
    const up = async (sellerId: string, seed: string, purpose: 'product_image' | 'inspection_photo' = 'product_image') =>
      (await uploadFile(t, 'seller', callers.seller({ sellerId }), { purpose, body: png(1000, 1000, { seed }) })).asset.id;
    const subject = await up(sellerA, 'sim-subject');
    const near = await up(sellerB, 'sim-near');
    const nearer = await up(sellerA, 'sim-nearer');
    const far = await up(sellerB, 'sim-far');
    const evidence = await up(sellerB, 'sim-evidence', 'inspection_photo');
    const setHash = (id: string, phash: number) => mediaTable(t.app, 'assets').update(id, { phash });
    await setHash(subject, 0b1111_0000);
    await setHash(nearer, 0b1111_0001); // distance 1
    await setHash(near, 0b1100_0000); // distance 2
    await setHash(far, 0b0000_1111); // distance 8
    await setHash(evidence, 0b1111_0000); // identical, but private evidence
    await t.media.attach(near, { module: 'catalog', kind: 'product_image', refId: 'P-near', refLabel: 'Near' }, { kind: 'seller', id: sellerB });

    const hits = await t.media.findSimilar(subject, {});
    expect(hits.map((h) => [h.assetId, h.distance])).toEqual([
      [nearer, 1],
      [near, 2],
    ]);
    expect(hits[1]).toMatchObject({ owner: { kind: 'seller', id: sellerB }, usages: [{ module: 'catalog', kind: 'product_image', refId: 'P-near' }] });
    expect((await t.media.findSimilar(subject, { maxDistance: 8 })).map((h) => h.assetId)).toEqual([nearer, near, far]);
    expect((await t.media.findSimilar(subject, { ownerKind: 'seller', ownerId: sellerB })).map((h) => h.assetId)).toEqual([near]);
    expect((await t.media.findSimilar(subject, { usageKinds: ['product_image'] })).map((h) => h.assetId)).toEqual([near]);
    expect((await t.media.findSimilar(subject, { limit: 1 })).map((h) => h.assetId)).toEqual([nearer]);
    expect(await code(t.media.findSimilar(newId(), {}))).toBe('NOT_FOUND');
  });
});

describe('gift card code files', () => {
  it('are generated files whose links need a reason and are recorded; the media admin download refuses them', async () => {
    const asset = await t.media.storeGeneratedFile({
      owner: { kind: 'platform', id: null },
      fileName: 'gift-cards-GB-0001.csv',
      contentType: 'text/csv',
      body: new Blob(['code\nGC-1111-2222\n']).stream() as ReadableStream,
      ttlHours: 24,
      purpose: 'gift_card_codes',
    });
    expect(asset).toMatchObject({ status: 'ready', purpose: 'gift_card_codes', visibility: 'private' });
    const principal = { kind: 'staff' as const, accountId: newId(), sessionId: newId() };
    expect(await code(t.media.signedDownload(asset.id, principal as never))).toBe('VALIDATION_FAILED');
    const before = t.audits.length;
    const link = await t.media.signedDownload(asset.id, principal as never, 'Send the batch to the partner');
    expect(link.fileName).toBe('gift-cards-GB-0001.csv');
    expect(t.audits.slice(before)).toEqual([expect.objectContaining({ action: 'media.asset.download', category: 'financial', reason: 'Send the batch to the partner' })]);
    const res = await t.app.inject({ method: 'GET', url: `/api/admin/media/assets/${asset.id}/download?reason=look`, headers: auth(staffToken()) });
    expect(res.statusCode).toBe(404);
  });
});

describe('staff uploads', () => {
  it('only the staff member who started an upload may send its bytes or complete it (NOT_FOUND otherwise)', async () => {
    const alice = staffToken();
    const bob = staffToken();
    const body = png(900, 900, { seed: 'staff-only' });
    const started = await startUpload(t, 'admin', alice, { purpose: 'case_evidence', sizeBytes: body.length });
    expect(started.statusCode, started.body).toBe(201);
    const ticket = started.json();
    expect((await putContent(t, ticket, bob, body)).statusCode).toBe(404);
    expect((await putContent(t, ticket, alice, body)).statusCode).toBe(204);
    const stolen = await t.app.inject({ method: 'POST', url: `/api/admin/media/uploads/${ticket.uploadId}/complete`, headers: auth(bob) });
    expect(stolen.statusCode).toBe(404);
    expect(stolen.json().error.code).toBe('NOT_FOUND');
    const done = await t.app.inject({ method: 'POST', url: `/api/admin/media/uploads/${ticket.uploadId}/complete`, headers: auth(alice) });
    expect(done.statusCode, done.body).toBe(202);
  });
});
