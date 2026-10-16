/** Recently viewed items are cards: their image is asked from media in the thumbnail size. */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { newId } from '../../../kernel/lib/ids.js';
import { boot, STORE, type Kit } from './helpers.js';

const productId = newId();
const imageId = newId();
const sizes: string[] = [];
let kit: Kit;
beforeAll(async () => {
  kit = await boot({
    apiStubs: {
      catalog: {
        getProduct: async (id: string) => (id === productId ? ({ id, slug: 'glass-kettle', title: 'Glass kettle', images: [{ id: imageId, url: 'https://files.example/detail.webp' }], variants: [] } as never) : null),
      },
      media: {
        refs: async (ids: string[], size?: string) => {
          sizes.push(size ?? 'medium');
          return ids.map((id) => ({ id, url: `https://files.example/${size}.webp`, alt: null, width: 320, height: 320 }));
        },
      },
    },
  });
});
afterAll(() => kit.app.close());

describe('recently viewed images', () => {
  it('uses the thumbnail of the product image', async () => {
    const v = kit.visitor();
    expect((await kit.call('POST', `${STORE}/recently-viewed`, { token: v.token, body: { productId } })).status).toBe(204);
    const [item] = (await kit.call('GET', `${STORE}/recently-viewed`, { token: v.token })).body;
    expect(item).toMatchObject({ productId, title: 'Glass kettle', image: { id: imageId, url: 'https://files.example/thumb.webp' } });
    expect(sizes).toEqual(['thumb']);
  });
});
