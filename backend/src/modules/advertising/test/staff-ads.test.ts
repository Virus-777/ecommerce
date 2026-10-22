/**
 * The simple staff Advertisements page (2026-10-23): drafts, the two reviews, pending changes of running ads, end
 * date and carousel order at once, picked destinations resolved to store paths, and the deals_top carousel.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { newId } from '../../../kernel/lib/ids.js';
import { callers } from '../../../testing/app.js';
import { ADMIN, boot, campaignInput, serve, type Kit } from './helpers.js';

let k: Kit;
const PRODUCT = newId();
const CATEGORY = newId();
const BRAND = newId();
const STORE = newId();
let DEAL = '';
const GONE = newId();

beforeAll(async () => {
  k = await boot();
  DEAL = k.promotion({ name: 'Fall Home Week' }).id;
  k.targets.set('product', [
    { id: PRODUCT, label: 'Halden Aurora ANC Wireless Headphones', meta: 'Product · Halden', path: `/p/halden-aurora/${PRODUCT}`, available: true },
    { id: GONE, label: 'Retired speaker', meta: 'Product', path: `/p/retired/${GONE}`, available: false },
  ]);
  k.targets.set('category', [{ id: CATEGORY, label: 'Headphones', meta: 'Category · Audio', path: '/c/headphones', available: true }]);
  k.targets.set('brand', [{ id: BRAND, label: 'Halden', meta: 'Brand', path: '/brand/halden', available: true }]);
  k.targets.set('seller_store', [{ id: STORE, label: 'Northwind Audio', meta: 'Store · SL-1', path: '/shop/northwind-audio', available: true }]);
  k.targets.set('deal', [{ id: DEAL, label: 'Fall Home Week', meta: 'Deal · ends Oct 31', path: `/deals?campaign=${DEAL}`, available: true }]);
});
afterAll(async () => {
  await k?.close();
});

/** A staff token for an account with the given access roles (default Business Owner: both steps) */
const staffWith = (roles: string[], permissions?: string[]) => {
  const id = newId();
  k.roles.set(id, roles);
  return callers.staff(permissions, { sub: id } as never);
};
const days = (n: number) => new Date(k.clock.now().getTime() + n * 86_400_000).toISOString();
const img = (w: number, h: number) => k.asset(w, h).id;

async function draft(over: Record<string, unknown> = {}, token = k.staff) {
  const res = await k.call('POST', `${ADMIN}/ads`, token, {
    name: 'Halden headphones',
    placementKey: 'home_banner',
    imageId: img(750, 400),
    alt: 'Halden Aurora headphones on a desk',
    destination: { kind: 'product', targetId: PRODUCT },
    endsAt: days(14),
    ...over,
  });
  expect(res.status, JSON.stringify(res.body)).toBe(201);
  return res.body;
}

/** Submit, then two other people approve: live (or scheduled for a later start) */
async function live(over: Record<string, unknown> = {}) {
  const ad = await draft(over);
  const sub = await k.call('POST', `${ADMIN}/ads/${ad.id}/submit`, k.staff);
  expect(sub.status, JSON.stringify(sub.body)).toBe(200);
  for (const step of ['advertising', 'content']) {
    const r = await k.call('POST', `${ADMIN}/ads/${ad.id}/review`, staffWith([`${step}_manager`]), { decision: 'approve' });
    expect(r.status, JSON.stringify(r.body)).toBe(200);
  }
  return (await k.call('GET', `${ADMIN}/ads/${ad.id}`, k.staff)).body;
}

describe('drafts', () => {
  it('creates a draft with a resolved destination, an image and the next carousel position', async () => {
    const a = await draft();
    expect(a).toMatchObject({ status: 'draft', placementKey: 'home_banner', alt: 'Halden Aurora headphones on a desk', startsAt: null, stopWithDeal: false });
    expect(a.ref).toMatch(/^AD-\d{6}-\d{4}$/);
    expect(a.destination).toEqual({ kind: 'product', targetId: PRODUCT, label: 'Halden Aurora ANC Wireless Headphones', meta: 'Product · Halden', path: `/p/halden-aurora/${PRODUCT}`, available: true });
    expect(a.image).toMatchObject({ width: 750, height: 400 });
    expect(a.allowedActions).toEqual(expect.arrayContaining(['edit', 'submit', 'delete', 'duplicate']));
    const b = await draft({ name: 'Second' });
    expect(b.position).toBe(a.position + 1);
    // by ref too
    expect((await k.call('GET', `${ADMIN}/ads/${a.ref}`, k.staff)).body.id).toBe(a.id);
  });

  it('accepts an incomplete draft and refuses an image of the wrong size', async () => {
    const res = await k.call('POST', `${ADMIN}/ads`, k.staff, { name: 'Just a name', placementKey: 'deals_top' });
    expect(res.status).toBe(201);
    expect(res.body).toMatchObject({ image: null, destination: null, endsAt: null });
    const wrong = await k.call('POST', `${ADMIN}/ads`, k.staff, { name: 'Tall', placementKey: 'deals_top', imageId: img(750, 400) });
    expect(wrong.status).toBe(422);
    expect(wrong.body.error.code).toBe('CREATIVE_FORMAT_INVALID');
    expect(wrong.body.error.details.issues[0].path).toBe('imageId');
    const sponsored = await k.call('POST', `${ADMIN}/ads`, k.staff, { name: 'No', placementKey: 'sponsored_product' });
    expect(sponsored.status).toBe(400);
  });

  it('edits a draft: fields left out stay, null clears, a stale version is a conflict', async () => {
    const a = await draft();
    const res = await k.call('PATCH', `${ADMIN}/ads/${a.id}`, k.staff, { name: 'Renamed', destination: { kind: 'category', targetId: CATEGORY }, dealId: DEAL, stopWithDeal: true, version: a.version });
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    expect(res.body).toMatchObject({ name: 'Renamed', alt: a.alt, dealId: DEAL, stopWithDeal: true, destination: { kind: 'category', path: '/c/headphones', label: 'Headphones' } });
    expect(res.body.image.id).toBe(a.image.id);
    const cleared = await k.call('PATCH', `${ADMIN}/ads/${a.id}`, k.staff, { dealId: null, alt: null, version: res.body.version });
    expect(cleared.body).toMatchObject({ dealId: null, stopWithDeal: false, alt: null });
    const stale = await k.call('PATCH', `${ADMIN}/ads/${a.id}`, k.staff, { name: 'Old', version: a.version });
    expect(stale.status).toBe(409);
  });

  it('duplicates and deletes drafts', async () => {
    const a = await draft();
    const copy = await k.call('POST', `${ADMIN}/ads/${a.id}/duplicate`, k.staff);
    expect(copy.status).toBe(201);
    expect(copy.body).toMatchObject({ status: 'draft', name: 'Halden headphones (copy)', endsAt: null, alt: a.alt, destination: { kind: 'product', targetId: PRODUCT } });
    expect(copy.body.image.id).toBe(a.image.id);
    expect((await k.call('DELETE', `${ADMIN}/ads/${copy.body.id}`, k.staff)).status).toBe(204);
    expect((await k.call('GET', `${ADMIN}/ads/${copy.body.id}`, k.staff)).status).toBe(404);
  });
});

describe('submit and the two reviews', () => {
  it('lists what blocks the submit', async () => {
    const res = await k.call('POST', `${ADMIN}/ads`, k.staff, { name: 'Bare', placementKey: 'home_banner', destination: { kind: 'product', targetId: GONE }, endsAt: days(120) });
    const sub = await k.call('POST', `${ADMIN}/ads/${res.body.id}/submit`, k.staff);
    expect(sub.status).toBe(422);
    expect(sub.body.error.code).toBe('CHECKS_FAILED');
    expect(sub.body.error.details.checks.map((c: any) => c.label)).toEqual(['Image', 'Description', 'Destination', 'End date']);
    expect(sub.body.error.details.checks[3].detail).toBe('An ad runs at most 90 days');
  });

  it('needs two other people, one per step; the creator reviews neither', async () => {
    const creator = staffWith(['advertising_manager']);
    const a = await draft({}, creator);
    expect((await k.call('POST', `${ADMIN}/ads/${a.id}/submit`, creator)).body.status).toBe('in_review');
    const own = await k.call('POST', `${ADMIN}/ads/${a.id}/review`, creator, { decision: 'approve' });
    expect(own.body.error.code).toBe('SAME_REVIEWER');
    const owner = staffWith(['business_owner']);
    // a reviewer with both roles takes the next open step without choosing one
    const first = await k.call('POST', `${ADMIN}/ads/${a.id}/review`, owner, { decision: 'approve' });
    expect(first.status, JSON.stringify(first.body)).toBe(200);
    expect(first.body.review.steps).toMatchObject([{ step: 'advertising', state: 'approved' }, { step: 'content', state: 'waiting' }]);
    expect(first.body.statusNote).toBe('Needs Content review');
    const again = await k.call('POST', `${ADMIN}/ads/${a.id}/review`, owner, { decision: 'approve' });
    expect(again.body.error.code).toBe('SAME_REVIEWER');
    const content = staffWith(['content_manager'], ['advertising.campaigns.review']);
    const page = await k.call('GET', `${ADMIN}/ads?placement=home_banner`, content);
    expect(page.status).toBe(200);
    expect(page.body.waitingForMeAds).toContainEqual({ id: a.id, name: a.name, placementKey: 'home_banner', isChange: false });
    const last = await k.call('POST', `${ADMIN}/ads/${a.id}/review`, content, { decision: 'approve' });
    // no start date: live as soon as approved
    expect(last.body).toMatchObject({ status: 'live' });
    expect(Math.abs(new Date(last.body.startsAt).getTime() - k.clock.now().getTime())).toBeLessThan(5_000);
  });

  it('requests changes with a note, and schedules an ad with a later start', async () => {
    const a = await draft({ startsAt: days(2) });
    await k.call('POST', `${ADMIN}/ads/${a.id}/submit`, k.staff);
    const noNote = await k.call('POST', `${ADMIN}/ads/${a.id}/review`, staffWith(['content_manager']), { decision: 'request_changes' });
    expect(noNote.status).toBe(400);
    const back = await k.call('POST', `${ADMIN}/ads/${a.id}/review`, staffWith(['content_manager']), { decision: 'request_changes', note: 'Brighter image' });
    expect(back.body).toMatchObject({ status: 'changes_requested', statusNote: 'Changes requested: Brighter image' });
    await k.call('PATCH', `${ADMIN}/ads/${a.id}`, k.staff, { imageId: img(1500, 800), version: back.body.version });
    expect((await k.call('POST', `${ADMIN}/ads/${a.id}/submit`, k.staff)).body.status).toBe('in_review');
    await k.call('POST', `${ADMIN}/ads/${a.id}/review`, staffWith(['advertising_manager']), { decision: 'approve' });
    const done = await k.call('POST', `${ADMIN}/ads/${a.id}/review`, staffWith(['content_manager']), { decision: 'approve' });
    expect(done.body.status).toBe('scheduled');
  });
});

describe('a running ad', () => {
  it('keeps the live version until the change is approved, then switches over', async () => {
    const a = await live({ placementKey: 'deals_top', imageId: img(750, 150) });
    expect(a.status).toBe('live');
    const oldImage = (await serve(k, { page: 'deals', slots: ['deals_top'], device: 'phone' })).slots.deals_top.find((x: any) => x.campaignId === a.id).image.id;
    const newImage = img(1500, 300);
    const edit = await k.call('PATCH', `${ADMIN}/ads/${a.id}`, k.staff, { name: 'Halden, new photo', imageId: newImage, destination: { kind: 'brand', targetId: BRAND }, version: a.version });
    expect(edit.status, JSON.stringify(edit.body)).toBe(200);
    expect(edit.body).toMatchObject({ status: 'live', name: a.name, pendingChange: { state: 'draft', name: 'Halden, new photo', changedFields: ['name', 'image', 'destination'], destination: { kind: 'brand', path: '/brand/halden' } } });
    expect(edit.body.allowedActions).toContain('submit');
    await k.call('POST', `${ADMIN}/ads/${a.id}/submit`, k.staff);
    const inReview = (await k.call('GET', `${ADMIN}/ads/${a.id}`, k.staff)).body;
    expect(inReview.pendingChange.state).toBe('in_review');
    // the first review stays as it was; the change has its own steps
    expect(inReview.review.steps.every((s: any) => s.state === 'approved')).toBe(true);
    expect((await k.call('PATCH', `${ADMIN}/ads/${a.id}`, k.staff, { name: 'x', version: inReview.version })).status).toBe(409);
    await k.call('POST', `${ADMIN}/ads/${a.id}/review`, staffWith(['advertising_manager']), { decision: 'approve' });
    k.svc.serving.invalidate();
    let d = await serve(k, { page: 'deals', slots: ['deals_top'], device: 'phone' });
    expect(d.slots.deals_top.find((x: any) => x.campaignId === a.id).image.id).toBe(oldImage);
    const done = await k.call('POST', `${ADMIN}/ads/${a.id}/review`, staffWith(['content_manager']), { decision: 'approve' });
    expect(done.body).toMatchObject({ status: 'live', name: 'Halden, new photo', pendingChange: null, destination: { kind: 'brand' } });
    expect(done.body.image.id).toBe(newImage);
    d = await serve(k, { page: 'deals', slots: ['deals_top'], device: 'phone' });
    const imp = d.slots.deals_top.find((x: any) => x.campaignId === a.id);
    expect(imp).toMatchObject({ image: { id: newImage, alt: a.alt }, destination: '/brand/halden' });
  });

  it('a rejected change is dropped and the live version keeps running', async () => {
    const a = await live();
    const edit = await k.call('PATCH', `${ADMIN}/ads/${a.id}`, k.staff, { destination: { kind: 'url', url: 'https://example.com/fall' }, version: a.version });
    await k.call('POST', `${ADMIN}/ads/${a.id}/submit`, k.staff);
    const rej = await k.call('POST', `${ADMIN}/ads/${a.id}/review`, staffWith(['content_manager']), { decision: 'reject', note: 'Off-site links need legal review' });
    expect(rej.status, JSON.stringify(rej.body)).toBe(200);
    expect(rej.body).toMatchObject({ status: 'live', pendingChange: null, destination: { kind: 'product', targetId: PRODUCT } });
    expect(edit.body.pendingChange.changedFields).toEqual(['destination']);
  });

  it('applies an end-date change at once, without review', async () => {
    const a = await live();
    const endsAt = days(30);
    const res = await k.call('PATCH', `${ADMIN}/ads/${a.id}`, k.staff, { endsAt, version: a.version });
    expect(res.body).toMatchObject({ status: 'live', pendingChange: null });
    expect(Math.abs(new Date(res.body.endsAt).getTime() - new Date(endsAt).getTime())).toBeLessThan(5_000);
    const past = await k.call('PATCH', `${ADMIN}/ads/${a.id}`, k.staff, { endsAt: days(-1), version: res.body.version });
    expect(past.status).toBe(400);
    const start = await k.call('PATCH', `${ADMIN}/ads/${a.id}`, k.staff, { startsAt: days(3), version: res.body.version });
    expect(start.status).toBe(400);
  });

  it('pauses, resumes and ends (dropping a pending change)', async () => {
    const a = await live();
    expect((await k.call('POST', `${ADMIN}/ads/${a.id}/pause`, k.staff, {})).body.status).toBe('paused');
    expect((await k.call('POST', `${ADMIN}/ads/${a.id}/resume`, k.staff, {})).body.status).toBe('live');
    const cur = (await k.call('GET', `${ADMIN}/ads/${a.id}`, k.staff)).body;
    await k.call('PATCH', `${ADMIN}/ads/${a.id}`, k.staff, { name: 'Changed', version: cur.version });
    const ended = await k.call('POST', `${ADMIN}/ads/${a.id}/end`, k.staff, { reason: 'Sold out' });
    expect(ended.body).toMatchObject({ status: 'ended', pendingChange: null, allowedActions: ['duplicate'] });
  });
});

describe('deals_top and the carousel order', () => {
  it('serves deals_top ads by position; reordering applies at once', async () => {
    const a = await live({ name: 'Deals A', placementKey: 'deals_top', imageId: img(750, 150) });
    const b = await live({ name: 'Deals B', placementKey: 'deals_top', imageId: img(750, 150) });
    const order = async () => (await serve(k, { page: 'deals', slots: ['deals_top'], device: 'phone' })).slots.deals_top.map((x: any) => x.campaignId).filter((id: string) => id === a.id || id === b.id);
    expect(await order()).toEqual([a.id, b.id]);
    const page = (await k.call('GET', `${ADMIN}/ads?placement=deals_top`, k.staff)).body;
    const running = page.items.filter((x: any) => x.status === 'live' || x.status === 'scheduled').map((x: any) => x.id);
    const bad = await k.call('PUT', `${ADMIN}/ads/order`, k.staff, { placementKey: 'deals_top', ids: [b.id, a.id] });
    expect(bad.status).toBe(running.length === 2 ? 200 : 400);
    const ids = [b.id, ...running.filter((id: string) => id !== b.id)];
    const res = await k.call('PUT', `${ADMIN}/ads/order`, k.staff, { placementKey: 'deals_top', ids });
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    expect(res.body.items.filter((x: any) => x.status === 'live').map((x: any) => x.id)).toEqual(ids);
    expect(res.body.items[0].position).toBe(1);
    expect(await order()).toEqual([b.id, a.id]);
    // counts cover every slot
    expect(Object.keys(res.body.counts)).toEqual(expect.arrayContaining(['opening_fullscreen', 'home_banner', 'deals_top', 'food_top', 'popup', 'category_banner']));
  });
});

describe('destinations', () => {
  it('resolves every kind to the path the app opens', async () => {
    const cases: [Record<string, unknown>, string, string][] = [
      [{ kind: 'product', targetId: PRODUCT }, `/p/halden-aurora/${PRODUCT}`, 'Halden Aurora ANC Wireless Headphones'],
      [{ kind: 'category', targetId: CATEGORY }, '/c/headphones', 'Headphones'],
      [{ kind: 'brand', targetId: BRAND }, '/brand/halden', 'Halden'],
      [{ kind: 'seller_store', targetId: STORE }, '/shop/northwind-audio', 'Northwind Audio'],
      [{ kind: 'deal', targetId: DEAL }, `/deals?campaign=${DEAL}`, 'Fall Home Week'],
      [{ kind: 'department', targetId: 'farm' }, '/farm-machines', 'Farm machines'],
      [{ kind: 'url', url: 'https://example.com/fall' }, 'https://example.com/fall', 'https://example.com/fall'],
    ];
    for (const [destination, path, label] of cases) {
      const a = await draft({ destination });
      expect(a.destination, JSON.stringify(destination)).toMatchObject({ kind: destination.kind, path, label, available: true });
    }
    const bad = await k.call('POST', `${ADMIN}/ads`, k.staff, { name: 'x', placementKey: 'home_banner', destination: { kind: 'url', url: 'http://plain.example.com' } });
    expect(bad.status).toBe(400);
    const missing = await k.call('POST', `${ADMIN}/ads`, k.staff, { name: 'x', placementKey: 'home_banner', destination: { kind: 'product', targetId: newId() } });
    expect(missing.body.error.details.issues[0]).toMatchObject({ path: 'destination.targetId', message: 'Product not found' });
    // food is not running in this app: its restaurants can't be linked
    const off = await k.call('POST', `${ADMIN}/ads`, k.staff, { name: 'x', placementKey: 'home_banner', destination: { kind: 'restaurant', targetId: newId() } });
    expect(off.status).toBe(400);
  });

  it('shows a target that left the store as unavailable', async () => {
    const a = await draft();
    k.targets.set('product', k.targets.get('product')!.map((t) => (t.id === PRODUCT ? { ...t, available: false } : t)));
    try {
      expect((await k.call('GET', `${ADMIN}/ads/${a.id}`, k.staff)).body.destination.available).toBe(false);
      const sub = await k.call('POST', `${ADMIN}/ads/${a.id}/submit`, k.staff);
      expect(sub.body.error.details.checks.map((c: any) => c.label)).toEqual(['Destination']);
    } finally {
      k.targets.set('product', k.targets.get('product')!.map((t) => (t.id === PRODUCT ? { ...t, available: true } : t)));
    }
  });

  it('searches every picker kind', async () => {
    const products = await k.call('GET', `${ADMIN}/ads/destinations?kind=product&q=halden`, k.staff);
    expect(products.body.items).toEqual([{ kind: 'product', targetId: PRODUCT, label: 'Halden Aurora ANC Wireless Headphones', meta: 'Product · Halden', image: null, path: `/p/halden-aurora/${PRODUCT}` }]);
    const departments = await k.call('GET', `${ADMIN}/ads/destinations?kind=department`, k.staff);
    expect(departments.body.items).toHaveLength(10);
    expect(departments.body.items.map((x: any) => x.path)).toContain('/rewards');
    expect((await k.call('GET', `${ADMIN}/ads/destinations?kind=department&q=play`, k.staff)).body.items.map((x: any) => x.targetId)).toEqual(['play']);
    expect((await k.call('GET', `${ADMIN}/ads/destinations?kind=url`, k.staff)).body.items).toEqual([]);
    expect((await k.call('GET', `${ADMIN}/ads/destinations?kind=restaurant`, k.staff)).body.items).toEqual([]);
    const denied = await k.call('GET', `${ADMIN}/ads/destinations?kind=product`, callers.staff(['orders.orders.view']));
    expect(denied.status).toBe(403);
  });
});

describe('the wizard endpoints still work on staff ads', () => {
  it('reads a staff ad as a campaign', async () => {
    const a = await live();
    const c = await k.call('GET', `${ADMIN}/campaigns/${a.id}`, k.staff);
    expect(c.status).toBe(200);
    expect(c.body).toMatchObject({ status: 'live', destination: { kind: 'product', url: `/p/halden-aurora/${PRODUCT}` } });
  });

  it('reads links saved before the pickers as the target their store path names', async () => {
    const legacy = async (url: string) => {
      const created = await k.call('POST', `${ADMIN}/campaigns`, k.staff, campaignInput(k, { name: `Legacy ${url}`, placementKey: 'home_banner', pages: ['home'], destination: { kind: 'url', url } }));
      expect(created.status, JSON.stringify(created.body)).toBe(201);
      return (await k.call('GET', `${ADMIN}/ads/${created.body.id}`, k.staff)).body.destination;
    };
    expect(await legacy('/c/headphones')).toEqual({ kind: 'category', targetId: CATEGORY, label: 'Headphones', meta: 'Category · Audio', path: '/c/headphones', available: true });
    expect(await legacy('/c/cookware')).toMatchObject({ kind: 'category', targetId: null, path: '/c/cookware', available: false });
    expect(await legacy(`/p/x/${PRODUCT}?offer=${GONE}`)).toMatchObject({ kind: 'product', targetId: PRODUCT, label: 'Halden Aurora ANC Wireless Headphones', path: `/p/x/${PRODUCT}?offer=${GONE}`, available: true });
    expect(await legacy('/brand/halden')).toMatchObject({ kind: 'brand', targetId: BRAND, path: '/brand/halden', available: true });
    expect(await legacy('/shop/northwind-audio')).toMatchObject({ kind: 'seller_store', targetId: STORE, available: true });
    expect(await legacy('/official')).toMatchObject({ kind: 'seller_store', label: 'Marketly Official Store', path: '/official', available: true });
    expect(await legacy('/softwares')).toMatchObject({ kind: 'department', targetId: 'software', label: 'Softwares', path: '/software', available: true });
    expect(await legacy('/deals')).toEqual({ kind: 'deal', targetId: 'tab', label: 'Deals tab', meta: 'Deals', path: '/deals', available: true });
    expect(await legacy(`/deals?campaign=${DEAL}`)).toMatchObject({ kind: 'deal', targetId: DEAL, label: 'Fall Home Week', available: true });
    // food is not running in this app: a restaurant link can't be opened
    expect(await legacy('/food/restaurants/luigis')).toMatchObject({ kind: 'restaurant', path: '/food/restaurants/luigis', available: false });
    expect(await legacy('/news')).toEqual({ kind: 'url', targetId: null, label: 'Store page /news', meta: 'Store page', path: '/news', available: true });
    expect(await legacy('https://example.com/fall')).toEqual({ kind: 'url', targetId: null, label: 'https://example.com/fall', meta: 'Web address', path: 'https://example.com/fall', available: true });
  });

  it('saves a typed store path as the target it names; the Deals tab and the Official Store are pickable', async () => {
    const a = await draft({ destination: { kind: 'url', url: '/brand/halden' } });
    expect(a.destination).toMatchObject({ kind: 'brand', targetId: BRAND, path: '/brand/halden' });
    const unknown = await draft({ destination: { kind: 'url', url: '/brand/nobody' } });
    expect(unknown.destination).toMatchObject({ kind: 'brand', targetId: null, path: '/brand/nobody', available: false });
    const tab = await draft({ destination: { kind: 'deal' } });
    expect(tab.destination).toMatchObject({ kind: 'deal', targetId: 'tab', path: '/deals', available: true });
    const deals = (await k.call('GET', `${ADMIN}/ads/destinations?kind=deal`, k.staff)).body.items;
    expect(deals[0]).toMatchObject({ targetId: 'tab', label: 'Deals tab', path: '/deals' });
    expect(deals.map((x: any) => x.targetId)).toContain(DEAL);
    const stores = (await k.call('GET', `${ADMIN}/ads/destinations?kind=seller_store&q=official`, k.staff)).body.items;
    expect(stores).toEqual([expect.objectContaining({ label: 'Marketly Official Store', path: '/official' })]);
  });
});
