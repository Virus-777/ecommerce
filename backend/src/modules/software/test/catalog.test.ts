import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { boot, newId, usd, type Kit } from './helpers.js';

let k: Kit;
beforeAll(async () => {
  k = await boot();
});
afterAll(async () => {
  await k?.app.close();
});

const DAY = 86_400_000;

describe('categories', () => {
  it('keeps slugs unique, counts published apps in the department and refuses to delete one in use', async () => {
    const c = await k.category('Developer tools');
    expect(c).toMatchObject({ slug: 'developer-tools', icon: 'wrench', visible: true, appCount: 0 });
    expect((await k.admin('POST', '/categories', { name: 'Developer Tools' })).body.error.code).toBe('SLUG_TAKEN');
    expect((await k.admin('POST', '/categories', { name: 'Bad icon', icon: 'Not An Icon' })).body.error.details.issues[0].path).toBe('icon');
    await k.makeApp({ categoryId: c.id });
    await k.makeApp({ categoryId: c.id, showInDepartment: false });
    await k.makeApp({ categoryId: c.id, status: 'draft', iconId: null, packageId: null });
    const listed = (await k.store('GET', '/categories')).body.find((x: any) => x.id === c.id);
    expect(listed.appCount).toBe(1);
    expect((await k.admin('DELETE', `/categories/${c.id}`)).body.error.code).toBe('IN_USE');
    const empty = await k.category();
    expect((await k.admin('DELETE', `/categories/${empty.id}`)).status).toBe(204);
    expect(k.audits.map((a) => a.action)).toContain('software.category.delete');
  });
});

describe('apps', () => {
  it('needs an icon, the package and a price to publish, with every missing field in details.issues', async () => {
    const c = await k.category();
    const base = { title: 'Ledger Lite', company: { name: 'Ledgerly Ltd' }, categoryId: c.id, brief: 'Invoices for small shops', description: 'Invoices.', free: false, platforms: ['web'] };
    const refused = await k.admin('POST', '/apps', { ...base, status: 'published' });
    expect(refused.status).toBe(400);
    expect(refused.body.error.code).toBe('VALIDATION_FAILED');
    expect(refused.body.error.details.issues.map((i: any) => i.path)).toEqual(['iconId', 'packageId', 'price']);
    const draft = await k.admin('POST', '/apps', base);
    expect(draft.status, JSON.stringify(draft.body)).toBe(201);
    expect(draft.body).toMatchObject({ slug: 'ledger-lite', status: 'draft', price: { free: false, amount: null, current: null, label: 'No price yet' }, files: { package: null, databases: [] }, sizeBytes: 0 });
    expect((await k.admin('POST', '/apps', base)).body.error.code).toBe('SLUG_TAKEN');
    // a picture is not a package
    const icon = await k.icon();
    const wrong = await k.admin('PATCH', `/apps/${draft.body.id}`, { ...base, packageId: icon });
    expect(wrong.status).toBe(409);
    expect(wrong.body.error).toMatchObject({ code: 'FILE_NOT_READY', details: { path: 'packageId' } });
    const pkg = await k.pkg('Ledger-Lite-1.0.zip');
    const db = await k.pkg('ledger-templates.zip');
    const published = await k.admin('PATCH', `/apps/${draft.body.id}`, { ...base, iconId: icon, packageId: pkg, databaseIds: [db], price: usd(999), status: 'published' });
    expect(published.status, JSON.stringify(published.body)).toBe(200);
    const { package: p, databases } = published.body.files;
    expect(p).toMatchObject({ id: pkg, kind: 'package', name: 'Ledger-Lite-1.0.zip' });
    expect(databases).toEqual([expect.objectContaining({ id: db, kind: 'database', name: 'ledger-templates.zip' })]);
    expect(published.body.sizeBytes).toBe(p.sizeBytes + databases[0].sizeBytes);
    expect(published.body.sizeLabel).toMatch(/^\d+ KB$/);
    expect(published.body.icon).toMatchObject({ id: icon });

    // replacing the package detaches the old file; PATCH without file fields keeps the others
    const next = await k.pkg('Ledger-Lite-1.1.zip');
    const replaced = await k.admin('PATCH', `/apps/${draft.body.id}`, { ...base, packageId: next, price: usd(999) });
    expect(replaced.body.files.package.id).toBe(next);
    expect(replaced.body.files.databases).toHaveLength(1);
    expect(replaced.body.icon.id).toBe(icon);
    expect((await k.call('GET', `/api/admin/media/assets/${pkg}`)).body.asset.inUse).toBe(false);
    expect((await k.call('GET', `/api/admin/media/assets/${next}`)).body.asset.inUse).toBe(true);
  });

  it('shows the store published apps: lists, search, platforms, sorting and prices with a running sale', async () => {
    const c = await k.category('Multimedia');
    const ends = new Date(k.clock.now().getTime() + 3 * DAY).toISOString();
    const pixel = await k.makeApp({ title: 'PixelCraft Studio', categoryId: c.id, free: false, price: usd(2499), salePrice: usd(1249), saleEndsAt: ends, platforms: ['windows', 'macos'], subcategory: 'Photo editing' });
    const cut = await k.makeApp({ title: 'CutPro Video', categoryId: c.id, free: false, price: usd(4999), platforms: ['windows'] });
    await k.makeApp({ title: 'Hidden Tool', categoryId: c.id, status: 'hidden' });
    const byLink = await k.makeApp({ title: 'Link Only', categoryId: c.id, showInDepartment: false });

    const list = (await k.store('GET', `/apps?category=${c.slug}&sort=price_low`)).body.items;
    expect(list.map((a: any) => a.title)).toEqual(['PixelCraft Studio', 'CutPro Video']);
    expect(list[0]).toMatchObject({ category: { slug: 'multimedia', name: 'Multimedia' }, company: { name: 'Northlight Labs' }, owned: false, rating: null, ratingCount: 0, price: { free: false, amount: usd(2499), saleAmount: usd(1249), current: usd(1249), label: '$12.49', wasLabel: '$24.99', offPercent: 50 } });
    expect((await k.store('GET', '/apps?q=photo')).body.items.map((a: any) => a.id)).toEqual([pixel.id]);
    expect((await k.store('GET', `/apps?category=${c.slug}&platform=macos`)).body.items.map((a: any) => a.id)).toEqual([pixel.id]);
    expect((await k.store('GET', `/apps/${byLink.slug}`)).status).toBe(200);
    expect((await k.store('GET', '/apps/hidden-tool')).status).toBe(404);

    // the sale ends: the regular price again
    k.clock.advance(4 * DAY);
    const after = (await k.store('GET', `/apps/${pixel.slug}`)).body.price;
    expect(after).toMatchObject({ current: usd(2499), label: '$24.99', wasLabel: null, offPercent: null, saleAmount: null });
    // staff still see the sale that was set
    expect((await k.admin('GET', `/apps/${pixel.id}`)).body.price).toMatchObject({ saleAmount: usd(1249), current: usd(2499) });
    expect(cut.price.label).toBe('$49.99');
  });

  it('counts a view once per visitor per app per day', async () => {
    const a = await k.makeApp();
    const account = newId();
    const visitor = k.customer(account);
    expect((await k.store('GET', `/apps/${a.slug}`, undefined, visitor)).body.views).toBe(1);
    expect((await k.store('GET', `/apps/${a.slug}`, undefined, visitor)).body.views).toBe(1);
    expect((await k.store('GET', `/apps/${a.slug}`)).body.views).toBe(2); // another visitor
    k.clock.advance(DAY);
    expect((await k.store('GET', `/apps/${a.slug}`, undefined, k.customer(account))).body.views).toBe(3);
  });

  it('deletes an app nobody owns; an owned one only hides (IN_USE)', async () => {
    const a = await k.makeApp();
    const b = await k.makeApp();
    const customer = k.customer(newId());
    expect((await k.store('POST', `/apps/${b.slug}/get`, undefined, customer)).status).toBe(200);
    expect((await k.admin('DELETE', `/apps/${b.id}`)).body.error.code).toBe('IN_USE');
    expect((await k.admin('DELETE', `/apps/${a.id}`)).status).toBe(204);
    expect((await k.admin('GET', `/apps/${a.id}`)).status).toBe(404);
  });
});

describe('packs, rails, home and deals', () => {
  it('prices packs against their apps, fills the home rails and lists deals biggest discount first', async () => {
    const office = await k.category('Productivity');
    const games = await k.category('Games');
    const ends = new Date(k.clock.now().getTime() + 5 * DAY);
    const writer = await k.makeApp({ title: 'Writer Pro', categoryId: office.id, free: false, price: usd(2999), releasedAt: '2026-06-20' });
    const sheets = await k.makeApp({ title: 'Sheets Pro', categoryId: office.id, free: false, price: usd(3499), salePrice: usd(2449), saleEndsAt: ends.toISOString() });
    const slides = await k.makeApp({ title: 'Slides Pro', categoryId: office.id, free: false, price: usd(3499) });
    await k.makeApp({ title: 'Kingdom Tactics', categoryId: games.id, free: false, price: usd(699), salePrice: usd(349), saleEndsAt: new Date(ends.getTime() + DAY).toISOString(), releasedAt: '2026-10-20' });
    const free = await k.makeApp({ title: 'Puzzle Harbor', categoryId: games.id, releasedAt: '2026-04-15' });

    expect((await k.admin('POST', '/packs', { name: 'Two', appIds: [writer.id], price: usd(100) })).body.error.details.issues[0].path).toBe('appIds');
    expect((await k.admin('POST', '/packs', { name: 'Free in it', appIds: [writer.id, free.id], price: usd(100) })).body.error.details.issues[0].path).toBe('appIds[1]');
    const pack = await k.admin('POST', '/packs', { name: 'Office Pro pack', appIds: [writer.id, sheets.id, slides.id], price: usd(5999), licenceLabel: 'Lifetime licence', summary: 'Writer, Sheets and Slides Pro — 3 apps for $59.99' });
    expect(pack.status, JSON.stringify(pack.body)).toBe(201);
    expect(pack.body).toMatchObject({ slug: 'office-pro-pack', totalLabel: '$99.97', savePercent: 40, sold: 0, visible: true });

    const home = (await k.store('GET', '/home')).body;
    expect(home.featuredPack).toMatchObject({ name: 'Office Pro pack', count: 3, priceLabel: '$59.99', totalLabel: '$99.97', savePercent: 40, owned: false });
    expect(home.rails.map((r: any) => r.key)).toEqual(expect.arrayContaining(['new-apps', 'games', 'pc-apps']));
    expect(home.rails.find((r: any) => r.key === 'recommended')).toBeUndefined(); // no apps picked: left out
    const gamesRail = home.rails.find((r: any) => r.key === 'games');
    expect(gamesRail).toMatchObject({ style: 'carousel', seeAll: 'category=games' });
    expect(gamesRail.apps.map((a: any) => a.title)).toEqual(['Kingdom Tactics', 'Puzzle Harbor']);
    expect(home.rails.find((r: any) => r.key === 'new-apps')).toMatchObject({ style: 'list', seeAll: 'sort=newest' });
    expect((await k.store('GET', `/apps?category=${games.slug}&sort=newest`)).body.items.map((a: any) => a.title)).toEqual(['Kingdom Tactics', 'Puzzle Harbor']);

    const deals = (await k.store('GET', '/deals')).body;
    expect(deals.packs.map((p: any) => p.name)).toContain('Office Pro pack');
    expect(deals.discounts.map((a: any) => [a.title, a.price.offPercent])).toEqual([
      ['Kingdom Tactics', 50],
      ['Sheets Pro', 30],
    ]);
    expect(deals.discountsUntilLabel).toMatch(/^Prices valid until [A-Z][a-z]{2} \d{1,2}$/);

    // staff pick the Recommended rail; a duplicate key is refused with its index
    const rails = (await k.admin('GET', '/rails')).body;
    expect(rails.map((r: any) => r.key)).toEqual(['recommended', 'new-apps', 'games', 'browsers', 'pc-apps']);
    const dup = await k.admin('PUT', '/rails', { rails: [rails[0], { ...rails[1], key: 'recommended' }] });
    expect(dup.body.error.details.issues[0].path).toBe('rails[1].key');
    const set = await k.admin('PUT', '/rails', { rails: [{ ...rails[0], appIds: [sheets.id, writer.id] }, { key: 'staff-favourites', title: 'Staff favourites', source: 'top_rated', style: 'list', appIds: [], limit: 5, visible: true }, rails[2]] });
    expect(set.status, JSON.stringify(set.body)).toBe(200);
    expect(set.body.map((r: any) => r.key)).toEqual(['recommended', 'staff-favourites', 'games']);
    const again = (await k.store('GET', '/home')).body.rails;
    expect(again.map((r: any) => r.key)).toEqual(['recommended', 'games']);
    expect(again[0].apps.map((a: any) => a.title)).toEqual(['Sheets Pro', 'Writer Pro']);
    expect((await k.store('GET', '/apps?rail=recommended')).body.items.map((a: any) => a.id)).toEqual([sheets.id, writer.id]);
    // removed rails stay removed
    expect((await k.admin('GET', '/rails')).body).toHaveLength(3);
  });
});

describe('reviews', () => {
  it('lets owners rate once (POST changes the rating), counts visible reviews only and signs with first name and last initial', async () => {
    const a = await k.makeApp();
    const dana = newId();
    k.names.set(dana, 'Dana Ross');
    const owner = k.customer(dana);
    expect((await k.store('POST', `/apps/${a.slug}/reviews`, { stars: 5 }, owner)).body.error.code).toBe('NOT_OWNED');
    await k.store('POST', `/apps/${a.slug}/get`, undefined, owner);
    expect((await k.store('GET', `/apps/${a.slug}`, undefined, owner)).body).toMatchObject({ owned: true, canReview: true, myReview: null });
    const r = await k.store('POST', `/apps/${a.slug}/reviews`, { stars: 5, text: 'RAW import is quick.' }, owner);
    expect(r.status, JSON.stringify(r.body)).toBe(200);
    expect(r.body).toMatchObject({ name: 'Dana R.', stars: 5, mine: true });
    expect((await k.store('POST', `/apps/${a.slug}/reviews`, { stars: 3, text: 'Changed my mind.' }, owner)).body).toMatchObject({ id: r.body.id, stars: 3 });
    const other = newId();
    await k.store('POST', `/apps/${a.slug}/get`, undefined, k.customer(other));
    await k.store('POST', `/apps/${a.slug}/reviews`, { stars: 5 }, k.customer(other));
    let detail = (await k.store('GET', `/apps/${a.slug}`, undefined, owner)).body;
    expect(detail.ratings).toEqual({ average: 4, count: 2, stars: [1, 0, 1, 0, 0] });
    expect(detail).toMatchObject({ canReview: false, myReview: { stars: 3, mine: true } });
    expect(detail.reviews).toHaveLength(2);

    const listed = (await k.admin('GET', `/reviews?appId=${a.id}`)).body.items;
    const theirs = listed.find((x: any) => x.customerId === other);
    const hidden = await k.admin('POST', `/reviews/${theirs.id}/moderate`, { hidden: true, reason: 'Spam' });
    expect(hidden.body).toMatchObject({ hidden: true, app: { id: a.id } });
    detail = (await k.store('GET', `/apps/${a.slug}`)).body;
    expect(detail.ratings).toEqual({ average: 3, count: 1, stars: [0, 0, 1, 0, 0] });
    expect((await k.store('GET', `/apps/${a.slug}/reviews`)).body.items).toHaveLength(1);
    await k.admin('POST', `/reviews/${theirs.id}/moderate`, { hidden: false });
    expect((await k.store('GET', `/apps/${a.slug}`)).body.ratings.count).toBe(2);
    expect(k.audits.filter((x) => x.action === 'software.review.hide')).toHaveLength(1);

    const off = await k.makeApp({ allowReviews: false });
    await k.store('POST', `/apps/${off.slug}/get`, undefined, owner);
    expect((await k.store('POST', `/apps/${off.slug}/reviews`, { stars: 4 }, owner)).body.error.code).toBe('REVIEWS_OFF');
  });
});
