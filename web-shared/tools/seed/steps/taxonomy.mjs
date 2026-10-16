// Step 2: the category tree (8 top-level categories with subcategories) with tile images, and brands. Names are
// looked up first: category names are not unique (a second create gets a suffixed slug) and brand names are.
import { ApiError } from '../lib/http.mjs';
import { productPng } from '../lib/files.mjs';
import { BRANDS, CATEGORIES } from '../data.mjs';

const flat = (nodes) => nodes.flatMap((n) => [n, ...flat(n.children ?? [])]);
const slug = (s) => s.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
const SHAPES = ['circle', 'square', 'ring', 'diamond', 'bar'];

/**
 * Category tile images (G24, `Category.image`): a PNG per category in the category's colour, uploaded as a
 * content image (admin, platform-owned) and set with the admin category `imageId`. Categories that already have
 * an image are left alone.
 */
async function categoryImages(ctx, nodes) {
  const todo = nodes.filter((n) => !n.category.image?.id);
  if (!todo.length) return;
  // all uploads at once: each waits for the media.process job, which handles them in batches
  await Promise.all(
    todo.map(async (n) => {
      const body = productPng({ width: 800, height: 800, color: n.color, shape: n.shape, variant: n.variant });
      const ref = await ctx.upload('admin', ctx.staff, { purpose: 'content_image', fileName: `category-${slug(n.label)}.png`, contentType: 'image/png', body, alt: n.category.name }, `admin:category:${n.stateKey}`);
      await ctx.api.patch(`/api/admin/catalog/categories/${n.category.id}`, ctx.staff, { imageId: ref.id });
      ctx.log.created('category image', n.label);
    }),
  );
}

export async function taxonomyStep(ctx) {
  const { api, state, log } = ctx;
  const t = ctx.staff;
  const existing = flat(await api.get('/api/admin/catalog/categories', t));
  const nodes = [];
  for (const [i, top] of CATEGORIES.entries()) {
    let parent = existing.find((c) => c.name === top.name && !c.parentId);
    if (!parent) {
      parent = await api.post('/api/admin/catalog/categories', t, { name: top.name, parentId: null, position: i + 1, visible: true });
      log.created('category', top.name);
    }
    state.set(`category.${top.key}`, parent.id);
    nodes.push({ category: parent, stateKey: top.key, label: top.name, color: top.color, shape: top.shape, variant: 0 });
    for (const [j, sub] of top.subs.entries()) {
      let child = existing.find((c) => c.name === sub && c.parentId === parent.id);
      if (!child) {
        child = await api.post('/api/admin/catalog/categories', t, { name: sub, parentId: parent.id, position: j + 1, visible: true });
        log.created('subcategory', `${top.name} › ${sub}`);
      }
      state.set(`category.${top.key}.${sub}`, child.id);
      nodes.push({ category: child, stateKey: `${top.key}.${sub}`, label: `${top.name} › ${sub}`, color: top.color, shape: SHAPES[(SHAPES.indexOf(top.shape) + j + 1) % SHAPES.length], variant: j + 1 });
    }
  }
  await categoryImages(ctx, nodes);
  for (const name of BRANDS) {
    if (state.get(`brand.${name}`)) continue;
    const found = await api.get(`/api/admin/catalog/brands?q=${encodeURIComponent(name)}&limit=20`, t);
    let id = (found.items ?? []).find((b) => b.brand.name === name)?.brand.id;
    if (!id) {
      try {
        id = (await api.post('/api/admin/catalog/brands', t, { name, sellingPolicy: 'open' })).brand.id;
        log.created('brand', name);
      } catch (err) {
        if (err instanceof ApiError && err.details?.brandId) id = err.details.brandId;
        else throw err;
      }
    }
    state.set(`brand.${name}`, id);
  }
  log.info(`${CATEGORIES.length} categories, ${CATEGORIES.reduce((n, c) => n + c.subs.length, 0)} subcategories (with images), ${BRANDS.length} brands`);
}
