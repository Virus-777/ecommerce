// Step 3: real PNG photos for the Official Store products (admin uploads, owned by the platform) and the
// homepage banner (content_image). Seller photos are uploaded by each seller in the sellers step (sellers can
// only use their own uploads). Each upload waits for the media.process job.
import { bannerPng, productPng } from '../lib/files.mjs';
import { PRODUCTS } from '../data.mjs';

const slug = (s) => s.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');

/** Photos of one variant: a main photo and, for the first variant, two alternates */
export function variantPhotos(p, v, index) {
  const count = index === 0 ? 3 : 1;
  return Array.from({ length: count }, (_, n) => ({
    fileName: `${slug(p.title)}-${slug(Object.values(v.options).join('-'))}-${n + 1}.png`,
    body: productPng({ color: v.color, shape: p.shape, variant: n }),
    alt: `${p.title}, ${Object.values(v.options).join(', ')}${n ? ` (photo ${n + 1})` : ''}`,
  }));
}

/** Uploads a product's photos with `area`/`token`; returns { productImageIds, variantImageIds: {variantKey: [ids]} } */
export async function uploadProductPhotos(ctx, area, token, p) {
  // all uploads at once: each one waits for the media.process job, which handles them in batches
  const jobs = p.variants.flatMap((v, i) => variantPhotos(p, v, i).map((photo) => ({ v, photo })));
  const refs = await Promise.all(jobs.map(({ photo }) => ctx.upload(area, token, { purpose: 'product_image', fileName: photo.fileName, contentType: 'image/png', body: photo.body, alt: photo.alt }, `${area}:product:${p.key}:${photo.fileName}`)));
  const variantImageIds = Object.fromEntries(p.variants.map((v) => [v.key, []]));
  jobs.forEach(({ v }, i) => variantImageIds[v.key].push(refs[i].id));
  return { productImageIds: refs.map((r) => r.id).slice(0, 12), variantImageIds };
}

export async function mediaStep(ctx) {
  const t = ctx.staff;
  await Promise.all(
    PRODUCTS.filter((x) => x.seller === 'official').map(async (p) => {
      const r = await uploadProductPhotos(ctx, 'admin', t, p);
      ctx.state.set(`photos.${p.key}`, r);
      ctx.log.info(`${p.title}: ${r.productImageIds.length} photos ready`);
    }),
  );
  const banners = [
    { key: 'homeWeek', fileName: 'home-week-banner.png', body: bannerPng({ from: '#3f5d4a', to: '#c9a66b' }), alt: 'Home Week: linen bedding, cookware and lighting' },
    { key: 'about', fileName: 'about-banner.png', body: bannerPng({ from: '#1f3b5c', to: '#4a7fb0' }), alt: 'Marketly' },
  ];
  for (const b of banners) {
    if (ctx.state.get(`banner.${b.key}`)?.id) continue;
    const ref = await ctx.upload('admin', t, { purpose: 'content_image', fileName: b.fileName, contentType: 'image/png', body: b.body, alt: b.alt }, `admin:banner:${b.key}`);
    ctx.state.set(`banner.${b.key}`, { id: ref.id, url: ref.url, width: ref.width, height: ref.height, alt: b.alt });
    ctx.log.created('banner image', b.fileName);
  }
}
