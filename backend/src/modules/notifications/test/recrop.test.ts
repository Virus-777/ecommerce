/** catalog.images.recrop_needed: sellers are told to re-crop product images after the product image ratio changed. */
import type { FastifyInstance } from 'fastify';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { as, bootWorld, newId, publish, type World } from './harness.js';

let app: FastifyInstance;
let world: World;

beforeAll(async () => {
  ({ app, world } = await bootWorld());
});
afterAll(async () => {
  await app?.close();
});

const inbox = async (headers: Record<string, string>) => {
  const res = await app.inject({ method: 'GET', url: '/api/seller/notifications/inbox', headers });
  expect(res.statusCode, res.body).toBe(200);
  return res.json().items as any[];
};

describe('product images to re-crop', () => {
  it('tells the members who manage products, once per batch, linking the product or the product list', async () => {
    const sellerId = newId();
    const owner = world.member(sellerId, { isOwner: true });
    const packer = world.member(sellerId, { permissions: ['orders.fulfillment.view'] });
    const productIds = [newId(), newId(), newId()];
    const event = { sellerId, productIds, imageCount: 4, aspectRatio: '4:5' };
    await publish(app, 'catalog.images.recrop_needed', event);
    await publish(app, 'catalog.images.recrop_needed', event); // the same batch again: no second notice
    const notices = await inbox(as.seller(owner));
    expect(notices).toHaveLength(1);
    expect(notices[0]).toMatchObject({ topicKey: 'seller.product.recrop_needed', group: 'products', actionRequired: true, title: 'Re-crop images on 3 products', link: { screen: 'seller/products' } });
    expect(notices[0].body).toContain('Product images are now 4:5. 4 of your images have the old shape');
    expect(await inbox(as.seller(packer))).toHaveLength(0);

    const single = newId();
    await publish(app, 'catalog.images.recrop_needed', { sellerId, productIds: [single], imageCount: 1, aspectRatio: '4:5' });
    expect((await inbox(as.seller(owner)))[0]).toMatchObject({ link: { kind: 'product', id: single, screen: 'seller/product-new' } });
  });
});
