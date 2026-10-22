import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type * as catalog from '../../../spec/catalog.js';
import { phoneAdImages } from '../migrations.js';
import { boot, newId, type Kit } from './helpers.js';

let k: Kit;
beforeAll(async () => {
  k = await boot();
});
afterAll(async () => {
  await k?.app.close();
});

const usd = (amount: number) => ({ amount, currency: 'USD' });
/** Active usages of a file */
const usagesOf = async (assetId: string) => ((await k.call('GET', `/api/admin/media/assets/${assetId}`)).body.usages as { refId: string; kind: string; detachedAt?: string | null }[]).filter((u) => !u.detachedAt);

const galaxy = (photos: { id: string }[], over: Record<string, unknown> = {}) => ({
  brand: 'Samsung',
  name: 'Samsung Galaxy S26 Ultra 5G',
  overview: 'The Galaxy S26 Ultra puts a 200 MP camera and a built-in S Pen in a titanium frame.',
  storage: [
    { size: '256 GB', price: usd(109999), was: usd(129999) },
    { size: '512 GB', price: usd(121999), was: usd(141999) },
    { size: '1 TB', price: usd(145999) },
  ],
  colors: [
    { name: 'Titanium Gray', short: 'Gray', hex: '#8c918f' },
    { name: 'Titanium Black', short: 'Black', hex: '#222826' },
  ],
  photos: photos.map((p, i) => ({ id: p.id, alt: i === 0 ? 'Front and back' : null })),
  specGroups: [
    { name: 'Display', rows: [{ name: 'Size', value: '6.9 in' }, { name: 'Refresh rate', value: '1–120 Hz' }, { name: '', value: 'dropped' }] },
    { name: 'Empty', rows: [{ name: 'Only a name', value: ' ' }] },
  ],
  ...over,
});

describe('phones', () => {
  let s26: any;
  let pixel: any;
  let photoA: { id: string };
  let photoB: { id: string };

  it('adds a phone with its photos, storage, colors and spec sheet', async () => {
    photoA = await k.uploadImage({ width: 1440, height: 1920 });
    photoB = await k.uploadImage({ width: 2048, height: 1152 });
    const res = await k.admin('POST', '/phones', galaxy([photoA, photoB]));
    expect(res.status, JSON.stringify(res.body)).toBe(201);
    s26 = res.body;
    expect(s26).toMatchObject({ slug: 'samsung-galaxy-s26-ultra-5g', brand: 'Samsung', status: 'published', showServices: true, position: 1, searchTerm: null, updatedBy: { kind: 'staff' } });
    expect(s26.colors[0]).toEqual({ name: 'Titanium Gray', short: 'Gray', hex: '#8C918F' });
    expect(s26.storage[2]).toMatchObject({ size: '1 TB', price: usd(145999), was: null });
    expect(s26.specGroups).toEqual([{ name: 'Display', rows: [{ name: 'Size', value: '6.9 in' }, { name: 'Refresh rate', value: '1–120 Hz' }] }]);
    expect(s26.photos.map((p: any) => p.id)).toEqual([photoA.id, photoB.id]);
    expect(s26.photos[0]).toMatchObject({ alt: 'Front and back', url: expect.any(String), zoomUrl: expect.any(String) });
    expect(await usagesOf(photoA.id)).toEqual([expect.objectContaining({ kind: 'content_block', refId: s26.id })]);
    expect(k.audits.some((e) => e.action === 'departments.phones.create' && e.target?.id === s26.id)).toBe(true);
  });

  it('checks every field and names the one to fix', async () => {
    const photo = await k.uploadImage({ width: 1200, height: 1600 });
    const issue = async (over: Record<string, unknown>) => {
      const res = await k.admin('POST', '/phones', galaxy([photo], { name: `Phone ${newId().slice(0, 6)}`, ...over }));
      expect(res.status).toBe(400);
      return res.body.error.details.issues[0].path;
    };
    expect(await issue({ brand: ' ' })).toBe('brand');
    expect(await issue({ brand: 'x'.repeat(41) })).toBe('brand');
    expect(await issue({ name: 'x'.repeat(81) })).toBe('name');
    expect(await issue({ overview: 'x'.repeat(1001) })).toBe('overview');
    expect(await issue({ storage: [] })).toBe('storage');
    expect(await issue({ storage: Array.from({ length: 9 }, (_, i) => ({ size: `${i} GB`, price: usd(100) })) })).toBe('storage');
    expect(await issue({ storage: [{ size: '128 GB', price: usd(100) }, { size: '256 GB', price: usd(0) }] })).toBe('storage[1].price');
    expect(await issue({ storage: [{ size: '128 GB', price: usd(100), was: usd(100) }] })).toBe('storage[0].was');
    expect(await issue({ storage: [{ size: '128 GB', price: { amount: 100, currency: 'EUR' } }] })).toBe('storage[0].price.currency');
    expect(await issue({ storage: [{ size: 'x'.repeat(21), price: usd(100) }] })).toBe('storage[0].size');
    expect(await issue({ colors: [{ name: 'Gray', hex: 'gray' }] })).toBe('colors[0].hex');
    expect(await issue({ colors: Array.from({ length: 13 }, (_, i) => ({ name: `C${i}`, hex: '#000000' })) })).toBe('colors');
    expect(await issue({ photos: [] })).toBe('photos');
    expect(await issue({ photos: [{ id: photo.id }, { id: photo.id }] })).toBe('photos[1]');
    expect(await issue({ photos: [{ id: photo.id, alt: 'x'.repeat(201) }] })).toBe('photos[0].alt');
    expect(await issue({ photos: [{ id: newId() }] })).toBe('photos[0]');
    expect(await issue({ specGroups: [{ name: '', rows: [{ name: 'Size', value: '6 in' }] }] })).toBe('specGroups[0].name');
    expect(await issue({ specGroups: [{ name: 'Display', rows: [{ name: 'Size', value: 'x'.repeat(201) }] }] })).toBe('specGroups[0].rows[0].value');
    expect(await issue({ specGroups: Array.from({ length: 21 }, (_, i) => ({ name: `G${i}`, rows: [{ name: 'a', value: 'b' }] })) })).toBe('specGroups');
    expect(await issue({ searchTerm: 'x'.repeat(81) })).toBe('searchTerm');
    // nothing was attached by the refused saves
    expect(await usagesOf(photo.id)).toEqual([]);
  });

  it('refuses photos narrower than 1,080 px and releases the ones it attached', async () => {
    const wide = await k.uploadImage({ width: 1440, height: 1920 });
    const narrow = await k.uploadImage({ width: 800, height: 1000 });
    const res = await k.admin('POST', '/phones', galaxy([wide, narrow], { name: 'Too Small' }));
    expect(res.status).toBe(400);
    expect(res.body.error.details.issues[0]).toMatchObject({ path: 'photos[1]', message: expect.stringContaining('1,080 px wide') });
    expect(await usagesOf(wide.id)).toEqual([]);
  });

  it('refuses a slug another phone has', async () => {
    const photo = await k.uploadImage();
    const res = await k.admin('POST', '/phones', galaxy([photo], { name: 'Another', slug: 'samsung-galaxy-s26-ultra-5g' }));
    expect(res.status).toBe(409);
    expect(res.body.error.code).toBe('SLUG_TAKEN');
  });

  it('shows the store published phones as cards, hidden ones nowhere', async () => {
    const p = await k.uploadImage({ width: 1080, height: 1350 });
    pixel = (await k.admin('POST', '/phones', { brand: 'Google', name: 'Google Pixel 11 Pro', storage: [{ size: '128 GB', price: usd(99900), was: usd(99999) }], photos: [{ id: p.id }] })).body;
    const hidden = (await k.admin('POST', '/phones', { brand: 'Samsung', name: 'Samsung Galaxy A57 5G', status: 'hidden', storage: [{ size: '128 GB', price: usd(44999) }], photos: [{ id: p.id }] })).body;
    expect(hidden.position).toBe(3);
    const page = (await k.store('GET', '/phones')).body;
    expect(page.brands).toEqual(['Samsung', 'Google']);
    expect(page.phones).toHaveLength(2);
    expect(page.phones[0]).toMatchObject({ slug: 'samsung-galaxy-s26-ultra-5g', meta: '256 GB · Titanium Gray', price: usd(109999), was: usd(129999), dealPercent: 15, image: { id: photoA.id, alt: 'Front and back' } });
    // under 1% off: the was price shows, no badge
    expect(page.phones[1]).toMatchObject({ meta: '128 GB', was: usd(99999), dealPercent: null });

    const detail = (await k.store('GET', '/phones/samsung-galaxy-s26-ultra-5g')).body;
    expect(detail).toMatchObject({ name: 'Samsung Galaxy S26 Ultra 5G', searchTerm: 'Samsung Galaxy S26 Ultra 5G', showServices: true });
    expect(detail.photos).toHaveLength(2);
    expect(detail.photos[0]).toMatchObject({ id: photoA.id, url: expect.any(String), zoomUrl: expect.any(String) });
    expect(detail).not.toHaveProperty('status');
    expect((await k.store('GET', '/phones/samsung-galaxy-a57-5g')).status).toBe(404);
    expect((await k.store('GET', '/phones/no-such-phone')).status).toBe(404);
    expect((await k.admin('GET', `/phones/${hidden.id}`)).body.status).toBe('hidden');
    expect((await k.admin('GET', '/phones')).body.items.map((x: any) => x.name)).toEqual(['Samsung Galaxy S26 Ultra 5G', 'Google Pixel 11 Pro', 'Samsung Galaxy A57 5G']);
  });

  it('replaces the whole phone on edit and releases photos it no longer shows', async () => {
    const photoC = await k.uploadImage({ width: 1920, height: 1440 });
    const res = await k.admin('PATCH', `/phones/${s26.id}`, galaxy([photoB, photoC], { searchTerm: 'galaxy s26', showServices: false, colors: [], specGroups: [] }));
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    expect(res.body).toMatchObject({ slug: 'samsung-galaxy-s26-ultra-5g', searchTerm: 'galaxy s26', showServices: false, colors: [], specGroups: [] });
    expect(res.body.photos.map((p: any) => p.id)).toEqual([photoB.id, photoC.id]);
    expect(await usagesOf(photoA.id)).toEqual([]);
    expect(await usagesOf(photoC.id)).toHaveLength(1);
    expect((await k.store('GET', '/phones')).body.phones[0].meta).toBe('256 GB');

    const hide = await k.admin('PATCH', `/phones/${s26.id}`, galaxy([photoB, photoC], { status: 'hidden' }));
    expect(hide.body.status).toBe('hidden');
    expect(k.audits.find((e) => e.action === 'departments.phones.update' && e.actionLabel === 'Hid a phone')).toBeTruthy();
    expect((await k.store('GET', `/phones/${s26.slug}`)).status).toBe(404);
    await k.admin('PATCH', `/phones/${s26.id}`, galaxy([photoB, photoC], { status: 'published' }));
    expect((await k.admin('PATCH', `/phones/${newId()}`, galaxy([photoB]))).status).toBe(404);
  });

  it('reorders the list with every phone id, once each', async () => {
    const ids = (await k.admin('GET', '/phones')).body.items.map((x: any) => x.id);
    expect((await k.admin('PUT', '/phones/order', { ids: ids.slice(1) })).status).toBe(400);
    expect((await k.admin('PUT', '/phones/order', { ids: [ids[0], ids[0], ids[1]] })).status).toBe(400);
    expect((await k.admin('PUT', '/phones/order', { ids: [ids[0], ids[1], newId()] })).status).toBe(400);
    const res = await k.admin('PUT', '/phones/order', { ids: [ids[1], ids[2], ids[0]] });
    expect(res.status).toBe(200);
    expect(res.body.items.map((x: any) => [x.id, x.position])).toEqual([
      [ids[1], 1],
      [ids[2], 2],
      [ids[0], 3],
    ]);
    expect((await k.store('GET', '/phones')).body.phones.map((x: any) => x.slug)).toEqual(['google-pixel-11-pro', 'samsung-galaxy-s26-ultra-5g']);
    expect(k.audits.some((e) => e.action === 'departments.phones.reorder')).toBe(true);
    // a new phone placed first moves the others down
    const p = await k.uploadImage();
    const first = (await k.admin('POST', '/phones', { brand: 'Xiaomi', name: 'Xiaomi 16T Pro', position: 1, storage: [{ size: '256 GB', price: usd(64900) }], photos: [{ id: p.id }] })).body;
    expect(first.position).toBe(1);
    expect((await k.admin('GET', '/phones')).body.items.map((x: any) => x.position)).toEqual([1, 2, 3, 4]);
  });

  it('deletes a phone and releases its photos', async () => {
    expect((await k.admin('DELETE', `/phones/${s26.id}`)).status).toBe(204);
    expect(await usagesOf(photoB.id)).toEqual([]);
    expect((await k.admin('GET', `/phones/${s26.id}`)).status).toBe(404);
    expect((await k.admin('GET', '/phones')).body.items.map((x: any) => x.position)).toEqual([1, 2, 3]);
    expect(k.audits.some((e) => e.action === 'departments.phones.delete' && e.target?.id === s26.id)).toBe(true);
    expect(pixel.id).toBeTruthy();
  });

  it('needs departments.phones.manage to change phones', async () => {
    const viewer = k.staff(['departments.view']);
    expect((await k.admin('GET', '/phones', undefined, viewer)).status).toBe(200);
    expect((await k.admin('POST', '/phones', galaxy([]), viewer)).status).toBe(403);
    expect((await k.admin('PUT', '/phones/order', { ids: [] }, viewer)).status).toBe(403);
    expect((await k.admin('DELETE', `/phones/${pixel.id}`, undefined, viewer)).status).toBe(403);
  });
});

describe('import of the old phone picks (departments.import-phone-picks)', () => {
  const product = (over: Partial<catalog.Product>): catalog.Product =>
    ({ id: newId(), ref: 'PRD-1', title: 'Phone', slug: 'phone', brand: null, categoryId: null, categoryPath: [], description: '', keyFeatures: [], specs: {}, includedItems: [], images: [], noGtin: false, variants: [], updatedAt: '2026-10-01T00:00:00.000Z', ...over }) as catalog.Product;

  it('turns the picks into phones in order once, then empties them', async () => {
    const image = await k.uploadImage({ width: 1000, height: 1000 });
    const nova = product({
      title: 'Nova X2 Phone',
      brand: { id: newId(), name: 'Nova' } as never,
      description: '<p>Fast and light.</p><p>All-day battery.</p>',
      specs: { Display: '6.5 in OLED', Battery: '5000 mAh' },
      images: [{ id: image.id, url: 'https://cdn.example.com/x.png', alt: 'Nova front' }],
      variants: [
        { id: newId(), options: { Storage: '128 GB', Color: 'Midnight Black' }, images: [] },
        { id: newId(), options: { Storage: '256 GB', Color: 'Ocean' }, images: [] },
        { id: newId(), options: { Storage: '128 GB', Color: 'Ocean' }, images: [] },
      ],
    });
    const plain = product({ title: 'Basic Phone 3', variants: [{ id: newId(), options: {}, images: [] }] });
    const unpriced = product({ title: 'Gone Phone' });
    for (const p of [nova, plain, unpriced]) k.products.set(p.id, p);
    const card = (p: catalog.Product, price: number, was: number | null) => k.card({ productId: p.id, title: p.title, brandName: 'Basic', price: usd(price), wasPrice: was ? usd(was) : null });
    k.cards.set(nova.id, card(nova, 39900, 49900)).set(plain.id, card(plain, 9900, null));
    const missing = newId();
    await k.repo().savePicks([plain.id, missing, nova.id, unpriced.id], 'staff:x', new Date());
    const before = (await k.admin('GET', '/phones')).body.items.length;

    await k.app.kernel.jobs.runNow('departments.import-phone-picks');
    const items = (await k.admin('GET', '/phones')).body.items;
    expect(items).toHaveLength(before + 2);
    const [basic, imported] = items.slice(before);
    expect(basic).toMatchObject({ name: 'Basic Phone 3', brand: 'Basic', storage: [{ size: 'Standard', price: usd(9900), was: null }], colors: [], photos: [], specGroups: [], status: 'published', updatedBy: { kind: 'system' } });
    expect(imported).toMatchObject({
      slug: 'nova-x2-phone',
      brand: 'Nova',
      overview: 'Fast and light.\n\nAll-day battery.',
      storage: [
        { size: '128 GB', price: usd(39900), was: usd(49900) },
        { size: '256 GB', price: usd(39900), was: usd(49900) },
      ],
      colors: [
        { name: 'Midnight Black', hex: '#222222' },
        { name: 'Ocean', hex: '#9E9E9E' },
      ],
      specGroups: [{ name: 'Specifications', rows: [{ name: 'Display', value: '6.5 in OLED' }, { name: 'Battery', value: '5000 mAh' }] }],
      photos: [{ id: image.id, alt: 'Nova front' }],
    });
    expect(await usagesOf(image.id)).toEqual([expect.objectContaining({ kind: 'content_block', refId: imported.id })]);
    expect((await k.repo().getPicks())!.product_ids).toEqual([]);

    // a second start finds nothing to do
    await k.app.kernel.jobs.runNow('departments.import-phone-picks');
    expect((await k.admin('GET', '/phones')).body.items).toHaveLength(before + 2);
  });

  it('counts a phone with the same slug as imported (another process got there first)', async () => {
    const twin = product({ title: 'Nova X2 Phone' });
    k.products.set(twin.id, twin);
    k.cards.set(twin.id, k.card({ productId: twin.id, price: usd(100) }));
    await k.repo().savePicks([twin.id], 'staff:x', new Date());
    const before = (await k.admin('GET', '/phones')).body.items.length;
    await k.app.kernel.jobs.runNow('departments.import-phone-picks');
    expect((await k.admin('GET', '/phones')).body.items).toHaveLength(before);
    expect((await k.repo().getPicks())!.product_ids).toEqual([]);
  });
});

describe('advertisement images', () => {
  let phone: any;
  let cover: { id: string };
  let adA: { id: string };
  let adB: { id: string };
  const base = (over: Record<string, unknown> = {}) => ({ brand: 'Oppo', name: 'Oppo Find X9', storage: [{ size: '256 GB', price: usd(89900) }], photos: [{ id: cover.id }], ...over });

  it('keeps its own images, apart from the preview photos, and shows them in the store', async () => {
    cover = await k.uploadImage({ width: 1440, height: 1920 });
    adA = await k.uploadImage({ width: 1080, height: 1920 });
    adB = await k.uploadImage({ width: 1920, height: 1440 });
    const res = await k.admin('POST', '/phones', base({ adImages: [{ id: adA.id, alt: 'Find X9 · Two days of battery' }, { id: adB.id }] }));
    expect(res.status, JSON.stringify(res.body)).toBe(201);
    phone = res.body;
    expect(phone.photos.map((p: any) => p.id)).toEqual([cover.id]);
    expect(phone.adImages.map((p: any) => p.id)).toEqual([adA.id, adB.id]);
    expect(phone.adImages[0]).toMatchObject({ alt: 'Find X9 · Two days of battery', url: expect.any(String), zoomUrl: expect.any(String) });
    expect(await usagesOf(adA.id)).toEqual([expect.objectContaining({ kind: 'content_block', refId: phone.id })]);
    const detail = (await k.store('GET', `/phones/${phone.slug}`)).body;
    expect(detail.adImages.map((p: any) => p.id)).toEqual([adA.id, adB.id]);
    expect(detail.photos.map((p: any) => p.id)).toEqual([cover.id]);
    // the card's cover is the first preview photo
    expect((await k.store('GET', '/phones')).body.phones.find((p: any) => p.id === phone.id).image.id).toBe(cover.id);
    const audit = k.audits.find((e) => e.action === 'departments.phones.create' && e.target?.id === phone.id)!;
    expect((audit.after as any).ad_images).toEqual([{ id: adA.id, alt: 'Find X9 · Two days of battery' }, { id: adB.id, alt: null }]);
  });

  it('checks the ad images like photos and refuses one that is also a preview photo', async () => {
    const issue = async (adImages: unknown) => {
      const res = await k.admin('PATCH', `/phones/${phone.id}`, base({ adImages }));
      expect(res.status).toBe(400);
      return res.body.error.details.issues[0];
    };
    expect((await issue([{ id: cover.id }])).path).toBe('adImages[0]');
    expect((await issue([{ id: adA.id }, { id: adA.id }])).path).toBe('adImages[1]');
    expect((await issue([{ id: adA.id, alt: 'x'.repeat(201) }])).path).toBe('adImages[0].alt');
    expect((await issue(Array.from({ length: 21 }, () => ({ id: newId() })))).path).toBe('adImages');
    const narrow = await k.uploadImage({ width: 1000, height: 1250 });
    expect(await issue([{ id: adA.id }, { id: narrow.id }])).toMatchObject({ path: 'adImages[1]', message: expect.stringContaining('1,080 px wide') });
    expect(await usagesOf(narrow.id)).toEqual([]);
    expect((await k.admin('GET', `/phones/${phone.id}`)).body.adImages.map((p: any) => p.id)).toEqual([adA.id, adB.id]);
  });

  it('releases ad images taken off the phone, and the rest when it is deleted', async () => {
    const res = await k.admin('PATCH', `/phones/${phone.id}`, base({ adImages: [{ id: adB.id }] }));
    expect(res.status).toBe(200);
    expect(res.body.adImages.map((p: any) => p.id)).toEqual([adB.id]);
    expect(await usagesOf(adA.id)).toEqual([]);
    // leaving adImages out of the body empties them (the body is the whole phone)
    expect((await k.admin('PATCH', `/phones/${phone.id}`, base())).body.adImages).toEqual([]);
    expect(await usagesOf(adB.id)).toEqual([]);
    await k.admin('PATCH', `/phones/${phone.id}`, base({ adImages: [{ id: adA.id }] }));
    expect(await usagesOf(adA.id)).toHaveLength(1);
    expect((await k.admin('DELETE', `/phones/${phone.id}`)).status).toBe(204);
    expect(await usagesOf(adA.id)).toEqual([]);
    expect(await usagesOf(cover.id)).toEqual([]);
  });

  it('gives phones saved before ad images an empty list (migration)', async () => {
    // rows written before the column existed (the collection validator now requires it)
    const db = k.app.kernel.mongo.db;
    const id = newId();
    const now = new Date();
    await db.collection('departments.phones').insertOne({ _id: id as never, slug: `old-phone-${id.slice(0, 6)}`, brand: 'Nokia', name: 'Old Phone', overview: null, storage: [{ size: '64 GB', price: usd(19900), was: null }], colors: [], photos: [], spec_groups: [], show_services: true, search_term: null, status: 'hidden', position: 99, created_at: now, updated_at: now, updated_by: null }, { bypassDocumentValidation: true });
    await phoneAdImages.up(db);
    await phoneAdImages.up(db); // safe to run again
    expect((await db.collection('departments.phones').findOne({ _id: id as never }))!.ad_images).toEqual([]);
    expect((await k.admin('GET', `/phones/${id}`)).body.adImages).toEqual([]);
  });
});
