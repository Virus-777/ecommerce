/** The in-process API other modules call: attach/detach, refs, getAsset, storeGeneratedFile. */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { newId } from '../../../kernel/lib/ids.js';
import { callers, jpeg, mediaApp, pdf, png, uploadFile, type MediaTestApp } from './helpers.js';

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

describe('attach and detach', () => {
  it('records usages idempotently; only the owner can attach (ASSET_NOT_OWNED); the purpose must fit', async () => {
    const sellerId = newId();
    const owner = { kind: 'seller' as const, id: sellerId };
    const { asset } = await uploadFile(t, 'seller', callers.seller({ sellerId }), { purpose: 'product_image', body: png(1000, 1000, { seed: 'attach' }) });
    const usage = { module: 'catalog', kind: 'product_image' as const, refId: 'p1', refLabel: 'Shoe' };
    await t.media.attach(asset.id, usage, owner);
    await t.media.attach(asset.id, { ...usage, refLabel: 'Trail shoe' }, owner);
    expect(await t.media.getAsset(asset.id)).toMatchObject({ inUse: true, usageCount: 1 });
    // a seller cannot reuse another seller's images
    expect(await code(t.media.attach(asset.id, usage, { kind: 'seller', id: newId() }))).toBe('ASSET_NOT_OWNED');
    expect(await code(t.media.attach(asset.id, { module: 'sellers', kind: 'store_logo', refId: 's1' }, owner))).toBe('VALIDATION_FAILED');
    expect(await code(t.media.attach(newId(), usage, owner))).toBe('NOT_FOUND');
    await t.media.detach(asset.id, usage);
    await t.media.detach(asset.id, usage); // twice is fine
    await t.media.detach(newId(), usage); // unknown file is fine
    expect(await t.media.getAsset(asset.id)).toMatchObject({ inUse: false, usageCount: 0, retainUntil: null });
  });

  it('evidence usages extend retainUntil', async () => {
    const accountId = newId();
    const owner = { kind: 'customer' as const, id: accountId };
    const { asset } = await uploadFile(t, 'store', callers.customer({ accountId }), { purpose: 'case_evidence', body: png(800, 800, { seed: 'case' }) });
    await t.media.attach(asset.id, { module: 'support', kind: 'case_evidence', refId: 'CS-1' }, owner);
    expect(new Date((await t.media.getAsset(asset.id))!.retainUntil!).getTime()).toBe(t.clock.now().getTime() + 730 * 86_400_000);
  });

  it('refuses rejected or removed files (ILLEGAL_TRANSITION) and waits for files still processing', async () => {
    const sellerId = newId();
    const seller = callers.seller({ sellerId });
    const owner = { kind: 'seller' as const, id: sellerId };
    const bad = await uploadFile(t, 'seller', seller, { purpose: 'product_image', body: Buffer.from('junk') });
    expect(await code(t.media.attach(bad.asset.id, { module: 'catalog', kind: 'product_image', refId: 'p' }, owner))).toBe('ILLEGAL_TRANSITION');

    const pending = await uploadFile(t, 'seller', seller, { purpose: 'product_image', body: png(1000, 1000, { seed: 'wait' }) }, { process: false });
    expect(pending.asset.status).toBe('processing');
    const attaching = t.media.attach(pending.asset.id, { module: 'catalog', kind: 'product_image', refId: 'p2' }, owner);
    await new Promise((r) => setTimeout(r, 50));
    await t.app.kernel.jobs.runNow('media.process');
    await attaching;
    expect(await t.media.getAsset(pending.asset.id)).toMatchObject({ status: 'ready', usageCount: 1 });
  });
});

describe('refs', () => {
  it('returns embeddable refs in the requested size, in order; removed files return the placeholder', async () => {
    const sellerId = newId();
    const seller = callers.seller({ sellerId });
    const a = await uploadFile(t, 'seller', seller, { purpose: 'product_image', body: jpeg(2400, 1600), alt: 'Front' });
    const b = await uploadFile(t, 'seller', seller, { purpose: 'product_image', body: png(300, 300, { seed: 'small' }) });
    const busy = await uploadFile(t, 'seller', seller, { purpose: 'product_image', body: png(900, 900, { seed: 'not-yet' }) }, { process: false });
    let refs = await t.media.refs([b.asset.id, a.asset.id, busy.asset.id, newId()], 'thumb');
    expect(refs.map((r) => r.id)).toEqual([b.asset.id, a.asset.id]);
    expect(refs[1]).toMatchObject({ alt: 'Front', width: 160, height: 107, url: expect.stringMatching(/\/files\/marketly-public\/renditions\/.+\/thumb\.webp\?sig=/) });
    // a 300 px image has no medium rendition: the largest smaller one is used
    refs = await t.media.refs([b.asset.id]);
    expect(refs[0]).toMatchObject({ width: 300, url: expect.stringMatching(/\/small\.webp\?sig=/) });
    await t.media.remove(a.asset.id, { reason: 'Counterfeit', by: { kind: 'staff', id: newId() } });
    refs = await t.media.refs([a.asset.id]);
    expect(refs[0]).toMatchObject({ id: a.asset.id, url: expect.stringMatching(/\/files\/marketly-public\/placeholders\/removed\.png\?sig=/), width: null });
  });

  it('private files get short-lived signed URLs', async () => {
    const { asset } = await uploadFile(t, 'store', callers.customer(), { purpose: 'return_evidence', body: png(800, 800, { seed: 'private-ref' }) });
    const [ref] = await t.media.refs([asset.id]);
    expect(ref!.url).toMatch(/\/files\/marketly-private\/.+[?&]exp=.+&sig=/);
    expect((await t.storage.fetch(ref!.url))?.disposition).toMatch(/^inline/);
  });
});

describe('storeGeneratedFile', () => {
  it('stores a private, ready file from a stream, with an expiry', async () => {
    const body = pdf(4);
    const stream = new ReadableStream<Uint8Array>({
      start(c) {
        c.enqueue(body.subarray(0, 10));
        c.enqueue(body.subarray(10));
        c.close();
      },
    });
    const sellerId = newId();
    const asset = await t.media.storeGeneratedFile({ owner: { kind: 'seller', id: sellerId }, fileName: 'statement-2026-09.pdf', contentType: 'application/pdf', body: stream, ttlHours: 48, purpose: 'statement' });
    expect(asset).toMatchObject({ status: 'ready', visibility: 'private', kind: 'document', pageCount: 4, sizeBytes: body.length, purpose: 'statement', url: null });
    const link = await t.media.signedDownload(asset.id, { kind: 'seller', accountId: newId(), sellerId });
    expect(Buffer.from((await t.storage.fetch(link.url))!.body).equals(body)).toBe(true);
    await expect(t.media.storeGeneratedFile({ owner: { kind: 'platform' }, fileName: 'x.csv', contentType: 'text/csv', body: stream, purpose: 'product_image' as never })).rejects.toMatchObject({ code: 'VALIDATION_FAILED' });
  });

  it('getAsset returns null for unknown ids', async () => {
    expect(await t.media.getAsset(newId())).toBeNull();
  });
});
