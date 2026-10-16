/**
 * Product images (BACKEND-PRODUCT-IMAGES.md): the spec endpoint, real processing with sharp (detail and thumb,
 * WebP and JPEG), the spec checks at upload and attach, refs sizes and aliases, and the rebuild job after a change
 * of media.productImage (new sizes rebuild, a new ratio flags). Images are real, made by sharp itself.
 */
import sharp from 'sharp';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { newId } from '../../../kernel/lib/ids.js';
import type { MediaAsset, RecropItem } from '../../../spec/media.js';
import { DEFAULT_PRODUCT_IMAGE, fitSize, productImageSettingIssues, resolveSpec, widthTargets } from '../domain/image-spec.js';
import { auth, callers, mediaApp, mediaTable, png, startUpload, uploadFile, type MediaTestApp } from './helpers.js';

const settings: Record<string, unknown> = {};
let t: MediaTestApp;
beforeAll(async () => {
  t = await mediaApp({ processor: 'sharp', settings });
});
afterAll(async () => {
  await t?.app.close();
});

/** A real image of one colour (sharp encodes it), PNG unless asked otherwise */
async function photo(width: number, height: number, opts: { format?: 'png' | 'jpeg'; colour?: { r: number; g: number; b: number } } = {}): Promise<Buffer> {
  const img = sharp({ create: { width, height, channels: 3, background: opts.colour ?? { r: 200, g: 60, b: 40 } } });
  return opts.format === 'jpeg' ? img.jpeg({ quality: 90 }).toBuffer() : img.png().toBuffer();
}

/** The stored bytes behind a rendition, decoded: real format and size */
async function decoded(url: string): Promise<{ format: string | undefined; width: number | undefined; height: number | undefined }> {
  const file = await t.storage.fetch(url);
  const meta = await sharp(Buffer.from(file!.body)).metadata();
  return { format: meta.format, width: meta.width, height: meta.height };
}

const sellerUpload = async (sellerId: string, body: Buffer, opts: { fileName?: string; contentType?: string } = {}) =>
  (await uploadFile(t, 'seller', callers.seller({ sellerId }), { purpose: 'product_image', fileName: opts.fileName ?? 'front.png', contentType: opts.contentType ?? 'image/png', body })).asset;

/** Runs media.rebuild-product-renditions and delivers its events */
async function rebuild() {
  const counts = await t.media.rebuildProductRenditions();
  await t.app.kernel.events.drain();
  return counts;
}

const rendition = (asset: MediaAsset, size: string, format = 'webp') => asset.renditions.find((r) => r.size === size && r.format === format);

describe('the spec (pure)', () => {
  it('validates the setting like the Admin Center', () => {
    const ok = { aspectRatio: '4:5', detailWidth: 800, thumbnailWidth: 320, quality: 80 };
    expect(productImageSettingIssues(ok)).toEqual([]);
    const fields = (v: object) => productImageSettingIssues({ ...ok, ...v }).map((i) => i.path);
    expect(fields({ aspectRatio: '3:1' })).toEqual(['aspectRatio']); // wider than 2:1
    expect(fields({ aspectRatio: '1:3' })).toEqual(['aspectRatio']);
    expect(fields({ aspectRatio: '0:1' })).toEqual(['aspectRatio']);
    expect(fields({ aspectRatio: '33:32' })).toEqual(['aspectRatio']);
    expect(fields({ aspectRatio: '4/5' })).toEqual(['aspectRatio']);
    expect(fields({ detailWidth: 479 })).toEqual(['detailWidth']);
    expect(fields({ detailWidth: 2049 })).toEqual(['detailWidth']);
    expect(fields({ detailWidth: 800.5 })).toEqual(['detailWidth']);
    expect(fields({ thumbnailWidth: 119 })).toEqual(['thumbnailWidth']);
    expect(fields({ thumbnailWidth: 641 })).toEqual(['thumbnailWidth']);
    expect(fields({ detailWidth: 600, thumbnailWidth: 600 })).toEqual(['thumbnailWidth']); // thumbnail ≥ detail
    expect(fields({ quality: 49 })).toEqual(['quality']);
    expect(fields({ quality: 96 })).toEqual(['quality']);
    expect(productImageSettingIssues('1:1')).toHaveLength(1);
  });

  it('works out the sizes from the ratio, and fits renditions without enlarging', () => {
    expect(resolveSpec({ aspectRatio: '4:5', detailWidth: 800, thumbnailWidth: 320, quality: 80 })).toMatchObject({ ratio: { width: 4, height: 5 }, detail: { width: 800, height: 1000 }, thumbnail: { width: 320, height: 400 } });
    expect(resolveSpec(DEFAULT_PRODUCT_IMAGE)).toMatchObject({ aspectRatio: '1:1', detail: { width: 800, height: 800 }, thumbnail: { width: 320, height: 320 } });
    expect(fitSize(1200, 1200, { width: 800, height: 800 })).toMatchObject({ width: 800, height: 800, cover: true });
    // cover, centred: a 4:3 image is cropped to the square
    expect(fitSize(1600, 1200, { width: 800, height: 800 })).toMatchObject({ width: 800, height: 800 });
    // never enlarged: the crop is kept at its own size
    expect(fitSize(600, 600, { width: 800, height: 800 })).toMatchObject({ width: 600, height: 600 });
    expect(fitSize(1600, 800, { width: 800, height: null })).toMatchObject({ width: 800, height: 400, cover: false });
    expect(widthTargets({ thumb: 160, small: 320, medium: 640 }, 300).map((x) => [x.size, x.width])).toEqual([['thumb', 160], ['small', 300]]);
  });
});

describe('GET /media/image-specs', () => {
  it('gives visitors, customers, sellers and staff the same answer; no token is refused', async () => {
    const urls: [string, string][] = [
      ['/api/store/media/image-specs', callers.visitor()],
      ['/api/store/media/image-specs', callers.customer()],
      ['/api/seller/media/image-specs', callers.seller()],
      ['/api/admin/media/image-specs', callers.staff([])],
    ];
    const bodies = [];
    for (const [url, token] of urls) {
      const res = await t.app.inject({ method: 'GET', url, headers: auth(token) });
      expect(res.statusCode, `${url} ${res.body}`).toBe(200);
      bodies.push(res.json());
    }
    expect(bodies[0]).toEqual({
      productImage: { aspectRatio: '1:1', detailWidth: 800, thumbnailWidth: 320, quality: 80, ratio: { width: 1, height: 1 }, detail: { width: 800, height: 800 }, thumbnail: { width: 320, height: 320 } },
    });
    for (const b of bodies) expect(b).toEqual(bodies[0]);
    expect((await t.app.inject({ method: 'GET', url: '/api/store/media/image-specs' })).statusCode).toBe(401);
  });

  it('follows the setting in force', async () => {
    settings['media.productImage'] = { aspectRatio: '4:5', detailWidth: 800, thumbnailWidth: 320, quality: 80 };
    try {
      const res = await t.app.inject({ method: 'GET', url: '/api/seller/media/image-specs', headers: auth(callers.seller()) });
      expect(res.json().productImage).toMatchObject({ aspectRatio: '4:5', detail: { width: 800, height: 1000 }, thumbnail: { width: 320, height: 400 } });
    } finally {
      delete settings['media.productImage'];
    }
  });
});

describe('processing a product image', () => {
  it('an 800 × 800 upload gets detail 800 × 800 and thumb 320 × 320, each in WebP and JPEG, and records the spec', async () => {
    const asset = await sellerUpload(newId(), await photo(800, 800), { fileName: 'kettle.png' });
    expect(asset).toMatchObject({ status: 'ready', width: 800, height: 800 });
    expect([...new Set(asset.renditions.map((r) => r.size))].sort()).toEqual(['detail', 'thumb']);
    expect(asset.renditions).toHaveLength(4);
    expect(await decoded(rendition(asset, 'detail')!.url)).toEqual({ format: 'webp', width: 800, height: 800 });
    expect(await decoded(rendition(asset, 'detail', 'jpeg')!.url)).toEqual({ format: 'jpeg', width: 800, height: 800 });
    expect(await decoded(rendition(asset, 'thumb')!.url)).toEqual({ format: 'webp', width: 320, height: 320 });
    expect(await decoded(rendition(asset, 'thumb', 'jpeg')!.url)).toEqual({ format: 'jpeg', width: 320, height: 320 });
    expect(asset.url).toBe(rendition(asset, 'detail')!.url);
    expect(asset.check).toMatchObject({ passed: true });
    const row = await mediaTable(t.app, 'assets').get(asset.id);
    expect(row?.processing_spec).toMatchObject({ aspectRatio: '1:1', detailWidth: 800, thumbnailWidth: 320, quality: 80 });
  });

  it('a larger JPEG is resized down (cover fit) and loses its metadata', async () => {
    const big = await sharp({ create: { width: 1600, height: 1600, channels: 3, background: '#3366cc' } })
      .jpeg()
      .withExif({ IFD0: { Copyright: 'secret-location' } })
      .toBuffer();
    const asset = await sellerUpload(newId(), big, { fileName: 'big.jpg', contentType: 'image/jpeg' });
    expect(asset.status).toBe('ready');
    expect(await decoded(rendition(asset, 'detail')!.url)).toEqual({ format: 'webp', width: 800, height: 800 });
    const meta = await sharp(Buffer.from((await t.storage.fetch(rendition(asset, 'detail', 'jpeg')!.url))!.body)).metadata();
    expect(meta.exif).toBeUndefined();
  });

  it('a 4:3 upload under a 1:1 spec is rejected with wrong_aspect; a 600 × 600 one with too_small', async () => {
    const wide = await sellerUpload(newId(), await photo(1600, 1200));
    expect(wide).toMatchObject({ status: 'rejected', rejectionReason: 'Crop the image to 1:1. The Seller Center crops it for you when you upload.' });
    const small = await sellerUpload(newId(), await photo(600, 600));
    expect(small).toMatchObject({ status: 'rejected', rejectionReason: 'The image must be at least 800 × 800.' });
    // within 1%: accepted
    expect((await sellerUpload(newId(), await photo(805, 800))).status).toBe('ready');
    expect(t.eventsNamed('media.asset.rejected').map((e) => e.payload)).toContainEqual(expect.objectContaining({ assetId: wide.id, reason: expect.stringMatching(/^Crop the image to 1:1/) }));
  });

  it('follows a 4:5 spec: the message names the ratio and the detail size', async () => {
    settings['media.productImage'] = { aspectRatio: '4:5', detailWidth: 800, thumbnailWidth: 320, quality: 80 };
    try {
      expect(await sellerUpload(newId(), await photo(1000, 1000))).toMatchObject({ status: 'rejected', rejectionReason: 'Crop the image to 4:5. The Seller Center crops it for you when you upload.' });
      expect(await sellerUpload(newId(), await photo(400, 500))).toMatchObject({ status: 'rejected', rejectionReason: 'The image must be at least 800 × 1000.' });
      const ok = await sellerUpload(newId(), await photo(800, 1000));
      expect(await decoded(rendition(ok, 'thumb')!.url)).toMatchObject({ width: 320, height: 400 });
    } finally {
      delete settings['media.productImage'];
    }
  });

  it('refuses HEIC for product images at upload; real decoding refuses fake image bytes', async () => {
    const res = await startUpload(t, 'seller', callers.seller(), { purpose: 'product_image', fileName: 'IMG_0001.HEIC', contentType: 'image/heic', sizeBytes: 2000 });
    expect(res.statusCode).toBe(415);
    expect(res.json().error).toMatchObject({ code: 'FILE_TYPE_NOT_ALLOWED', message: expect.stringMatching(/^HEIC photos aren't accepted for product images/), details: { allowed: ['jpeg', 'png', 'webp'] } });
    // a PNG header with no real pixels (what the development processor accepts)
    const fake = await sellerUpload(newId(), png(1000, 1000, { seed: 'fake' }));
    expect(fake).toMatchObject({ status: 'rejected', rejectionReason: 'The file is unsupported or corrupt.' });
  });

  it('staff uploads are not rejected (the purpose also serves category images), but only spec images attach to products', async () => {
    const staff = callers.staff();
    const { asset } = await uploadFile(t, 'admin', staff, { purpose: 'product_image', fileName: 'banner.png', body: await photo(1600, 800) });
    expect(asset.status).toBe('ready');
    // off the ratio: its own ratio at the spec widths
    expect(await decoded(rendition(asset, 'detail')!.url)).toMatchObject({ width: 800, height: 400 });
    expect(await decoded(rendition(asset, 'thumb')!.url)).toMatchObject({ width: 320, height: 160 });
    const platform = { kind: 'platform' as const, id: null };
    await expect(t.media.attach(asset.id, { module: 'catalog', kind: 'product_image', refId: newId() }, platform)).rejects.toMatchObject({
      code: 'VALIDATION_FAILED',
      message: 'Crop the image to 1:1. The Seller Center crops it for you when you upload.',
    });
    await expect(t.media.attach(asset.id, { module: 'offers', kind: 'offer_photo', refId: newId() }, platform)).rejects.toMatchObject({ code: 'VALIDATION_FAILED' });
    await t.media.attach(asset.id, { module: 'catalog', kind: 'category_image', refId: newId() }, platform);
    const square = await uploadFile(t, 'admin', staff, { purpose: 'product_image', body: await photo(1000, 1000) });
    await t.media.attach(square.asset.id, { module: 'catalog', kind: 'variant_image', refId: newId() }, platform);
  });

  it('other images keep thumb to zoom, really resized', async () => {
    const { asset } = await uploadFile(t, 'seller', callers.seller(), { purpose: 'store_banner', body: await photo(1600, 400) });
    expect([...new Set(asset.renditions.map((r) => r.size))]).toEqual(['thumb', 'small', 'medium', 'large', 'zoom']);
    expect(await decoded(rendition(asset, 'thumb')!.url)).toEqual({ format: 'webp', width: 160, height: 40 });
    expect(await decoded(rendition(asset, 'zoom')!.url)).toMatchObject({ width: 1600, height: 400 }); // never enlarged
  });
});

describe('refs', () => {
  it('product images: detail and thumb, the aliases, thumbUrl and detailUrl; other files only fileName', async () => {
    const asset = await sellerUpload(newId(), await photo(900, 900), { fileName: 'front-view.png' });
    const detail = rendition(asset, 'detail')!.url;
    const thumb = rendition(asset, 'thumb')!.url;
    const [byDefault] = await t.media.refs([asset.id]);
    expect(byDefault).toMatchObject({ url: detail, width: 800, height: 800, thumbUrl: thumb, detailUrl: detail, fileName: 'front-view.png' });
    for (const size of ['small', 'thumb'] as const) expect((await t.media.refs([asset.id], size))[0]).toMatchObject({ url: thumb, width: 320, height: 320 });
    for (const size of ['medium', 'large', 'zoom', 'detail'] as const) expect((await t.media.refs([asset.id], size))[0]).toMatchObject({ url: detail, width: 800 });

    const { asset: banner } = await uploadFile(t, 'seller', callers.seller(), { purpose: 'store_banner', fileName: 'banner.png', body: await photo(1600, 400) });
    const [b] = await t.media.refs([banner.id], 'detail');
    expect(b).toMatchObject({ url: rendition(banner, 'medium')!.url, thumbUrl: null, detailUrl: null, fileName: 'banner.png' });
  });

  it('images processed before the spec answer from their old sizes until they are rebuilt', async () => {
    const asset = await sellerUpload(newId(), await photo(1000, 1000));
    // as an image processed before the spec: no processing_spec, renditions small to large
    const renditions = mediaTable(t.app, 'renditions');
    await renditions.deleteMany({ asset_id: asset.id });
    const legacy = (size: string, width: number) => ({ asset_id: asset.id, size, storage_key: `renditions/${asset.id}/${size}.webp`, url: '', width, height: width, format: 'webp', bytes: 1 });
    for (const [size, width] of [['thumb', 160], ['small', 320], ['medium', 640], ['large', 1000]] as const) await renditions.insert(legacy(size, width));
    await mediaTable(t.app, 'assets').update(asset.id, { processing_spec: null });
    let [ref] = await t.media.refs([asset.id], 'thumb');
    expect(ref).toMatchObject({ width: 320, url: expect.stringMatching(/\/small\.webp/), thumbUrl: expect.stringMatching(/\/small\.webp/), detailUrl: expect.stringMatching(/\/large\.webp/) });

    await rebuild();
    [ref] = await t.media.refs([asset.id], 'thumb');
    expect(ref).toMatchObject({ width: 320, url: expect.stringMatching(/\/thumb\.webp/), detailUrl: expect.stringMatching(/\/detail\.webp/) });
    // the old files stay (order snapshots and the search index hold their links)
    expect((await renditions.find({ asset_id: asset.id })).map((r) => r.size).sort()).toEqual(['detail', 'detail', 'large', 'medium', 'small', 'thumb', 'thumb']);
  });
});

describe('media.rebuild-product-renditions', () => {
  it('new sizes rebuild both renditions under the same keys, never enlarged, once (idempotent)', async () => {
    // other tests' images are rebuilt too: count this one by its renditions
    const asset = await sellerUpload(newId(), await photo(800, 800));
    const keys = asset.renditions.map((r) => r.url).sort();
    await rebuild(); // nothing left from earlier tests
    const audits = t.audits.length;

    settings['media.productImage'] = { aspectRatio: '1:1', detailWidth: 1200, thumbnailWidth: 240, quality: 70 };
    try {
      const counts = await rebuild();
      expect(counts.rebuilt).toBeGreaterThanOrEqual(1);
      expect(counts.failed).toBe(0);
      const after = (await t.media.getAsset(asset.id))!;
      expect(after.renditions.map((r) => r.url).sort()).toEqual(keys);
      // the original is 800 px: detail stays 800 (never enlarged); thumb is the new 240
      expect(await decoded(rendition(after, 'detail')!.url)).toMatchObject({ width: 800, height: 800 });
      expect(await decoded(rendition(after, 'thumb')!.url)).toMatchObject({ width: 240, height: 240 });
      expect((await mediaTable(t.app, 'assets').get(asset.id))?.processing_spec).toMatchObject({ detailWidth: 1200, thumbnailWidth: 240, quality: 70 });
      expect(t.eventsNamed('media.product_images.rebuilt').at(-1)?.payload).toMatchObject({ aspectRatio: '1:1', rebuilt: counts.rebuilt });
      expect(t.audits.slice(audits)).toContainEqual(expect.objectContaining({ action: 'media.product_images.rebuild', target: expect.objectContaining({ type: 'setting', id: 'media.productImage' }) }));
      // idempotent: nothing to do the second time
      expect(await rebuild()).toEqual({ rebuilt: 0, flagged: 0, cleared: 0, failed: 0 });
    } finally {
      delete settings['media.productImage'];
      await rebuild();
    }
  });

  it('a new ratio flags the images that no longer match (wrong_aspect warning); the product keeps them; back again clears it', async () => {
    const sellerId = newId();
    const asset = await sellerUpload(sellerId, await photo(800, 800));
    const productId = newId();
    await t.media.attach(asset.id, { module: 'catalog', kind: 'product_image', refId: productId, refLabel: 'Kettle' }, { kind: 'seller', id: sellerId });
    await rebuild();
    const itemFor = (recrop: boolean) =>
      t
        .eventsNamed('media.product_images.recrop_changed')
        .flatMap((e) => (e.payload as { items: RecropItem[] }).items)
        .filter((i) => i.assetId === asset.id && i.recrop === recrop);

    settings['media.productImage'] = { aspectRatio: '4:5', detailWidth: 800, thumbnailWidth: 320, quality: 80 };
    try {
      const counts = await rebuild();
      expect(counts.flagged).toBeGreaterThanOrEqual(1);
      expect(itemFor(true)).toEqual([expect.objectContaining({ owner: { kind: 'seller', id: sellerId, label: null }, usages: [expect.objectContaining({ module: 'catalog', kind: 'product_image', refId: productId })] })]);
      const flagged = (await t.media.getAsset(asset.id))!;
      expect(flagged.status).toBe('ready');
      expect(flagged.check?.issues).toContainEqual({ code: 'wrong_aspect', severity: 'warning', message: 'Crop the image to 4:5. The Seller Center crops it for you when you upload.' });
      expect(flagged.check?.passed).toBe(true); // not blocking
      // still served at its own ratio, and still attached
      expect((await t.media.refs([asset.id]))[0]).toMatchObject({ width: 800, height: 800 });
    } finally {
      delete settings['media.productImage'];
    }
    const counts = await rebuild();
    expect(counts.cleared).toBeGreaterThanOrEqual(1);
    expect(itemFor(false)).toHaveLength(1);
    expect((await t.media.getAsset(asset.id))!.check?.issues.some((i) => i.code === 'wrong_aspect')).toBe(false);
  });

  it('starts at once when media.productImage changes (settings.setting.changed)', async () => {
    const before = t.eventsNamed('media.product_images.rebuilt').length;
    await t.media.onSettingChangedFromSettings({ key: 'catalog.minDescriptionLength', module: 'catalog', version: 3, from: 50, to: 80, effectiveFrom: new Date().toISOString(), applyScope: 'new_only', changeId: null });
    await t.media.onSettingChangedFromSettings({ key: 'media.productImage', module: 'media', version: 2, from: null, to: {}, effectiveFrom: new Date().toISOString(), applyScope: 'new_only', changeId: null });
    // jobs don't run on their own in tests: the job records the version it builds with
    settings['media.productImage'] = { aspectRatio: '1:1', detailWidth: 800, thumbnailWidth: 300, quality: 80 };
    try {
      const asset = await sellerUpload(newId(), await photo(800, 800));
      expect((await mediaTable(t.app, 'assets').get(asset.id))?.processing_spec).toMatchObject({ thumbnailWidth: 300, settingsVersion: 2 });
      await rebuild();
      expect(t.eventsNamed('media.product_images.rebuilt').length).toBeGreaterThan(before);
    } finally {
      delete settings['media.productImage'];
      await rebuild();
    }
  });
});
