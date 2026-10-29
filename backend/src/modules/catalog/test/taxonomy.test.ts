/** Categories, attributes, image standards and brands. */
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { api, brand, catalogApp, catalogTable, category, newId, uploadImage, type CatalogTestApp } from './helpers.js';

let t: CatalogTestApp;
let a: ReturnType<typeof api>;
beforeAll(async () => {
  t = await catalogApp();
  a = api(t);
});
afterAll(async () => {
  await t?.app.close();
});
beforeEach(() => {
  t.events.length = 0;
  t.stubs.audit.record.mockClear();
});

describe('categories', () => {
  it('creates a tree with unique slugs, publishes category.changed and audits', async () => {
    const audio = await category(t, 'Audio & Sound');
    expect(audio.slug).toBe('audio-and-sound');
    const head = await category(t, 'Headphones', { parentId: audio.id });
    const again = await category(t, 'Headphones');
    expect(again.slug).toBe('headphones-2');
    expect(t.eventsNamed('catalog.category.changed').map((e) => e.payload)).toContainEqual({ categoryId: head.id, change: 'created' });
    expect(t.stubs.audit.record).toHaveBeenCalledWith(expect.objectContaining({ action: 'catalog.category.create', module: 'catalog', category: 'catalog' }));

    const tree = (await a.admin('GET', '/categories')).json();
    const node = tree.find((c: { id: string }) => c.id === audio.id);
    expect(node.children.map((c: { name: string }) => c.name)).toEqual(['Headphones']);
    expect(node.offerCount).toBe(0);
  });

  it('refuses unknown parents and moves under a descendant', async () => {
    expect((await a.admin('POST', '/categories', { name: 'X', parentId: newId() })).statusCode).toBe(400);
    const root = await category(t, 'Cameras');
    const child = await category(t, 'Lenses', { parentId: root.id });
    const res = await a.admin('PATCH', `/categories/${root.id}`, { parentId: child.id });
    expect(res.statusCode).toBe(400);
    expect(res.json().error.details.issues[0].path).toBe('parentId');
    expect((await a.admin('PATCH', `/categories/${newId()}`, { name: 'Y' })).statusCode).toBe(404);
  });

  it('hidden and empty categories (and their subcategories) leave the store tree; coming soon stays with count 0', async () => {
    const root = await category(t, 'Garden');
    await category(t, 'Tools', { parentId: root.id });
    const soon = await category(t, 'Pets', { comingSoon: true });
    let store = (await a.store('/categories')).json();
    expect(store.map((c: { id: string }) => c.id)).not.toContain(root.id); // visible, but no eligible stock yet
    expect((await a.store('/categories/garden')).statusCode).toBe(200); // the page itself still opens
    expect(store.find((c: { id: string }) => c.id === soon.id)).toMatchObject({ comingSoon: true, productCount: 0, offerCount: null });

    const hidden = await a.admin('PATCH', `/categories/${root.id}`, { visible: false, name: 'Garden & Outdoor' });
    expect(hidden.statusCode, hidden.body).toBe(200);
    expect(hidden.json()).toMatchObject({ visible: false, name: 'Garden & Outdoor', slug: 'garden-and-outdoor' });
    store = (await a.store('/categories')).json();
    expect(store.map((c: { id: string }) => c.id)).not.toContain(root.id);
    expect((await a.store('/categories/garden-and-outdoor')).statusCode).toBe(404);
    expect((await a.store('/categories/tools')).statusCode).toBe(404); // under a hidden parent
    expect(t.eventsNamed('catalog.category.changed').map((e) => e.payload)).toContainEqual({ categoryId: root.id, change: 'updated' });
  });

  it('category page: breadcrumb, subcategories and filterable attributes (inherited too)', async () => {
    const tv = await category(t, 'TV & Video');
    const oled = await category(t, 'OLED TVs', { parentId: tv.id });
    await a.admin('PUT', `/categories/${tv.id}/attributes`, {
      attributes: [{ id: newId(), categoryId: tv.id, name: 'Screen size', kind: 'number', unit: 'in', options: [], required: true, filterable: true, variantDefining: true }],
      imageRules: [],
    });
    await a.admin('PUT', `/categories/${oled.id}/attributes`, {
      attributes: [
        { id: newId(), categoryId: oled.id, name: 'Refresh rate', kind: 'enum', options: ['60 Hz', '120 Hz'], required: false, filterable: true, variantDefining: false },
        { id: newId(), categoryId: oled.id, name: 'Panel maker', kind: 'text', options: [], required: false, filterable: false, variantDefining: false },
      ],
      imageRules: [],
    });
    const res = await a.store(`/categories/${oled.slug}`);
    expect(res.statusCode, res.body).toBe(200);
    const body = res.json();
    expect(body.breadcrumb.map((c: { name: string }) => c.name)).toEqual(['TV & Video', 'OLED TVs']);
    expect(body.filters.map((f: { name: string }) => f.name)).toEqual(['Screen size', 'Refresh rate']);
    expect(body.category.id).toBe(oled.id);
  });
});

describe('attributes and image standards', () => {
  it('replaces own attributes, keeps inherited ones read-only and validates', async () => {
    const parent = await category(t, 'Computers');
    const child = await category(t, 'Laptops', { parentId: parent.id });
    const warranty = { id: newId(), categoryId: parent.id, name: 'Warranty', kind: 'text', options: [], required: true, filterable: false, variantDefining: false };
    const put = await a.admin('PUT', `/categories/${parent.id}/attributes`, {
      attributes: [warranty],
      imageRules: [{ text: 'Minimum 1000 × 1000 px', severity: 'blocking', check: { minWidth: 1000, minHeight: 1000, minCount: 2 } }],
    });
    expect(put.statusCode, put.body).toBe(200);
    expect(put.json()).toEqual([expect.objectContaining({ name: 'Warranty', required: true })]);
    expect(t.eventsNamed('catalog.category.changed').map((e) => e.payload)).toContainEqual({ categoryId: parent.id, change: 'attributes' });

    // inherited: listed with its origin, cannot be redefined below
    const clash = await a.admin('PUT', `/categories/${child.id}/attributes`, { attributes: [{ ...warranty, id: newId(), categoryId: child.id }], imageRules: [] });
    expect(clash.statusCode).toBe(400);
    expect((await a.admin('PUT', `/categories/${child.id}/attributes`, { attributes: [{ ...warranty, name: 'Color', kind: 'enum', options: [] }], imageRules: [] })).statusCode).toBe(400);
    await a.admin('PUT', `/categories/${child.id}/attributes`, {
      attributes: [{ id: newId(), categoryId: child.id, name: 'RAM', kind: 'enum', options: ['8 GB', '16 GB'], required: true, filterable: true, variantDefining: true }],
      imageRules: [],
    });
    const seller = await a.seller(newId(), 'GET', `/categories/${child.id}/attributes`);
    expect(seller.statusCode).toBe(200);
    expect(seller.json().attributes.map((x: { name: string }) => x.name)).toEqual(['Warranty', 'RAM']);
    expect(seller.json().imageRules).toEqual([expect.objectContaining({ severity: 'blocking', text: 'Minimum 1000 × 1000 px' })]); // nearest standard: the parent's

    const admin = (await a.admin('GET', `/categories/${child.id}/attributes`)).json();
    expect(admin.attributes[0]).toMatchObject({ attribute: { name: 'Warranty' }, inheritedFrom: { categoryId: parent.id, name: 'Computers' }, filledCount: 0, productCount: 0 });
    expect(admin.attributes[1]).toMatchObject({ attribute: { name: 'RAM' }, inheritedFrom: null });
    expect((await a.admin('GET', `/categories/${newId()}/attributes`)).statusCode).toBe(404);
  });

  it('takes new attributes without an id or category id and keeps the id of an existing one (G67d)', async () => {
    const cat = await category(t, 'Monitors');
    const first = await a.admin('PUT', `/categories/${cat.id}/attributes`, { attributes: [{ name: 'Panel', kind: 'text', required: false, filterable: false, variantDefining: false }], imageRules: [] });
    expect(first.statusCode, first.body).toBe(200);
    const panel = first.json()[0];
    expect(panel).toMatchObject({ id: expect.any(String), categoryId: cat.id, name: 'Panel', options: [] });
    const second = await a.admin('PUT', `/categories/${cat.id}/attributes`, {
      attributes: [
        { id: panel.id, name: 'Panel type', kind: 'text', required: true, filterable: false, variantDefining: false },
        { name: 'Size', kind: 'number', unit: 'in', required: true, filterable: true, variantDefining: true },
      ],
      imageRules: [],
    });
    expect(second.statusCode, second.body).toBe(200);
    expect(second.json().map((x: { id: string; name: string }) => [x.id === panel.id, x.name])).toEqual([
      [true, 'Panel type'],
      [false, 'Size'],
    ]);
  });
});

describe('brands', () => {
  it('creates brands with a logo (media usage), refuses duplicate names and lists them', async () => {
    const logo = await uploadImage(t, 'staff', { purpose: 'brand_logo' });
    const res = await a.admin('POST', '/brands', { name: 'Northwind Audio', logoId: logo, description: 'Headphones since 1998', sellingPolicy: 'authorized_list', authorizedSellerIds: [newId()] });
    expect(res.statusCode, res.body).toBe(201);
    const b = res.json();
    expect(b).toMatchObject({ status: 'active', sellingPolicy: 'authorized_list', brand: { name: 'Northwind Audio', slug: 'northwind-audio', logo: { id: logo } } });
    expect(b.authorizedSellerIds).toHaveLength(1);
    const media = t.app.kernel.boot.apis.get('media') as unknown as { getAsset(id: string): Promise<{ inUse: boolean }> };
    expect((await media.getAsset(logo)).inUse).toBe(true);
    expect(t.eventsNamed('catalog.brand.changed').map((e) => e.payload)).toContainEqual({ brandId: b.brand.id, change: 'created', status: 'active', sellingPolicy: 'authorized_list' });

    expect((await a.admin('POST', '/brands', { name: 'northwind audio' })).statusCode).toBe(400);
    expect((await a.store('/brands/northwind-audio')).json()).toMatchObject({ name: 'Northwind Audio', productCount: 0 });
    const list = (await a.admin('GET', '/brands?q=northwind')).json();
    expect(list.items.map((x: { brand: { id: string } }) => x.brand.id)).toEqual([b.brand.id]);
  });

  it('edits who can sell (claim entries stay), audits with the reason', async () => {
    const b = await brand(t, 'Kestrel');
    const sellers = [newId(), newId()];
    const res = await a.admin('PATCH', `/brands/${b.id}`, { sellingPolicy: 'authorized_list', authorizedSellerIds: sellers, reason: 'Distributor agreement' });
    expect(res.statusCode, res.body).toBe(200);
    expect(res.json().authorizedSellerIds.sort()).toEqual([...sellers].sort());
    expect(t.stubs.audit.record).toHaveBeenCalledWith(expect.objectContaining({ action: 'catalog.brand.update', reason: 'Distributor agreement' }));
    expect(t.eventsNamed('catalog.brand.changed').at(-1)!.payload).toMatchObject({ change: 'updated', sellingPolicy: 'authorized_list' });
  });

  it('status flow: flag, block, activate with reasons; illegal moves are 409; blocked brands leave the store', async () => {
    const b = await brand(t, 'Shady Co');
    expect((await a.admin('POST', `/brands/${b.id}/status`, { status: 'under_review', reason: '' })).statusCode).toBe(400);
    const flagged = await a.admin('POST', `/brands/${b.id}/status`, { status: 'under_review', reason: 'Counterfeit reports', trustReportId: newId() });
    expect(flagged.json()).toMatchObject({ status: 'under_review', statusReason: 'Counterfeit reports', flagNote: expect.stringContaining('Trust and Risk report') });
    expect((await a.admin('POST', `/brands/${b.id}/status`, { status: 'under_review', reason: 'again' })).statusCode).toBe(409);
    expect((await a.admin('POST', `/brands/${b.id}/status`, { status: 'blocked', reason: 'Confirmed counterfeit' })).json().status).toBe('blocked');
    expect((await a.store(`/brands/${b.slug}`)).statusCode).toBe(404);
    expect((await a.admin('POST', `/brands/${b.id}/status`, { status: 'active', reason: 'Cleared' })).json()).toMatchObject({ status: 'active', flagNote: null });
    expect(t.eventsNamed('catalog.brand.changed').filter((e) => (e.payload as { change: string }).change === 'status')).toHaveLength(3);
  });

  it('an approved brand_request change request adds an active brand once (idempotent)', async () => {
    const sellerId = newId();
    const changeRequestId = newId();
    const payload = { changeRequestId, sellerId, kind: 'brand_request', approved: true, brandRequest: { brandName: 'Lumen Labs', relationship: 'reseller', categoryIds: [] } };
    t.app.kernel.events.publish('sellers', 'sellers.change_request.decided', payload);
    t.app.kernel.events.publish('sellers', 'sellers.change_request.decided', payload);
    t.app.kernel.events.publish('sellers', 'sellers.change_request.decided', { ...payload, changeRequestId: newId(), approved: false, brandRequest: { brandName: 'Nope' } });
    await t.app.kernel.events.drain();
    const list = (await a.admin('GET', '/brands?requested=true&q=lumen')).json();
    // names and ids, because this one failed once in a full run and "expected 1, got 2" says nothing about which brand the second one is
    expect(list.items.map((b: { id: string; name: string }) => `${b.name} (${b.id})`)).toHaveLength(1);
    expect(list.items[0]).toMatchObject({ status: 'active', sellingPolicy: 'open', authorizedSellerIds: [], requestedBy: { sellerId, changeRequestId } });
    expect((await a.admin('GET', '/brands?q=nope')).json().items).toHaveLength(0);
  });

  it('an approved brand_request activates a brand already under review under the same name, any case and spacing', async () => {
    const sellerId = newId();
    const waiting = await brand(t, 'Orvel Audio');
    // what a seller's own request leaves behind, and an older row whose name kept the spaces around it
    await catalogTable(t.app, 'brands').update(waiting.id, { name: '  orvel audio ', status: 'under_review', requested_by_seller_id: sellerId });
    const changeRequestId = newId();
    t.app.kernel.events.publish('sellers', 'sellers.change_request.decided', { changeRequestId, sellerId, kind: 'brand_request', approved: true, brandRequest: { brandName: 'Orvel Audio', relationship: 'reseller', categoryIds: [] } });
    await t.app.kernel.events.drain();
    const list = (await a.admin('GET', '/brands?requested=true&q=orvel')).json();
    expect(list.items.map((b: { id: string; name: string }) => `${b.name} (${b.id})`)).toHaveLength(1);
    expect(list.items[0]).toMatchObject({ brand: { id: waiting.id }, status: 'active', requestedBy: { sellerId, changeRequestId } });
  });
});
