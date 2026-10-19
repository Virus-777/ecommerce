/** Product tiles are cards: their image is the thumbnail, also when content builds them from catalog products. */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { harness, newId, type Harness } from './helpers.js';
import type { ResolvedProduct } from '../service/tiles.js';

let h: Harness;
beforeAll(async () => {
  h = await harness();
});
afterAll(async () => {
  await h?.app.close();
});

const u32 = (n: number) => {
  const b = Buffer.alloc(4);
  b.writeUInt32BE(n);
  return b;
};
const chunk = (type: string, data: Buffer) => Buffer.concat([u32(data.length), Buffer.from(type, 'latin1'), data, Buffer.alloc(4)]);
/** A square PNG header (the development image processor reads headers only) */
const png = (seed: string) =>
  Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), chunk('IHDR', Buffer.concat([u32(1000), u32(1000), Buffer.from([8, 2, 0, 0, 0])])), chunk('IDAT', Buffer.from(seed, 'latin1')), chunk('IEND', Buffer.alloc(0))]);

async function productImage(): Promise<string> {
  const body = png(newId());
  const res = await h.call('POST', '/api/admin/media/uploads', { upload: { purpose: 'product_image', fileName: 'kettle.png', contentType: 'image/png', sizeBytes: body.length } });
  const ticket = res.json() as { uploadId: string; assetId: string; url: string; headers: Record<string, string> };
  const media = h.app.kernel.boot.apis.get('media') as unknown as { providers: { storage: { acceptSignedPut(url: string, body: Uint8Array, type?: string): Promise<unknown> } } };
  await media.providers.storage.acceptSignedPut(ticket.url, body, ticket.headers['content-type']);
  await h.call('POST', `/api/admin/media/uploads/${ticket.uploadId}/complete`);
  await h.app.kernel.jobs.runNow('media.process');
  return ticket.assetId;
}

describe('product tiles from catalog', () => {
  it('use the thumbnail of the product image', async () => {
    const cat = (await h.call('POST', '/api/admin/catalog/categories', { name: `Kettles ${newId().slice(-6)}` })).json();
    const brand = (await h.call('POST', '/api/admin/catalog/brands', { name: `Steamline ${newId().slice(-6)}` })).json().brand;
    const image = await productImage();
    const created = await h.call('POST', '/api/admin/catalog/products', {
      title: 'Steamline glass kettle',
      brandId: brand.id,
      categoryId: cat.id,
      description: 'A 1.7 litre glass kettle with a blue light, auto shut-off and a cordless base for easy pouring.',
      keyFeatures: ['1.7 l', 'Auto shut-off', 'Cordless'],
      includedItems: ['Kettle', 'Base'],
      imageIds: [image],
      modelNumber: 'SL-K17',
      noGtin: true,
      variants: [{ options: { Color: 'Clear' }, gtin: null }],
    });
    expect(created.statusCode, created.body).toBe(201);
    const id = created.json().product.id as string;
    expect((await h.call('POST', `/api/admin/catalog/products/${id}/submit`)).statusCode).toBe(200);
    expect((await h.call('POST', `/api/admin/catalog/products/${id}/approve`, {}, h.staff(newId()))).statusCode).toBe(200); // a second person approves

    // search can't answer: content builds the tile from the catalog product
    const search = h.app.kernel.boot.apis.get('search') as unknown as { getProductCards: (ids: string[]) => Promise<unknown> };
    const cards = search.getProductCards;
    search.getProductCards = async () => {
      throw new Error('search is down');
    };
    try {
      const [tile] = (await (h.service as unknown as { resolveIds(ids: string[]): Promise<ResolvedProduct[]> }).resolveIds([id])).map((r) => r.tile);
      expect(tile).toMatchObject({ productId: id, image: { id: image, url: expect.stringMatching(/\/thumb\.webp/), width: 320, height: 320, detailUrl: expect.stringMatching(/\/detail\.webp/) } });
    } finally {
      search.getProductCards = cards;
    }
  });
});
