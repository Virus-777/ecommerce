// Step 2: the category tree (8 top-level categories with subcategories) and brands. Names are looked up first:
// category names are not unique (a second create gets a suffixed slug) and brand names are.
import { ApiError } from '../lib/http.mjs';
import { BRANDS, CATEGORIES } from '../data.mjs';

const flat = (nodes) => nodes.flatMap((n) => [n, ...flat(n.children ?? [])]);

export async function taxonomyStep(ctx) {
  const { api, state, log } = ctx;
  const t = ctx.staff;
  const existing = flat(await api.get('/api/admin/catalog/categories', t));
  for (const [i, top] of CATEGORIES.entries()) {
    let parent = existing.find((c) => c.name === top.name && !c.parentId);
    if (!parent) {
      parent = await api.post('/api/admin/catalog/categories', t, { name: top.name, parentId: null, position: i + 1, visible: true });
      log.created('category', top.name);
    }
    state.set(`category.${top.key}`, parent.id);
    for (const [j, sub] of top.subs.entries()) {
      let child = existing.find((c) => c.name === sub && c.parentId === parent.id);
      if (!child) {
        child = await api.post('/api/admin/catalog/categories', t, { name: sub, parentId: parent.id, position: j + 1, visible: true });
        log.created('subcategory', `${top.name} › ${sub}`);
      }
      state.set(`category.${top.key}.${sub}`, child.id);
    }
  }
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
  log.info(`${CATEGORIES.length} categories, ${CATEGORIES.reduce((n, c) => n + c.subs.length, 0)} subcategories, ${BRANDS.length} brands`);
}
