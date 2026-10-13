/**
 * Gap pass 4: submissions.paused_at (paused submissions keep their deadline), per-candidate duplicate dismissals in
 * check_dismissals, the review queue kind content_change, review dates on the settings business calendar.
 */
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { spec } from '../../../spec/catalog.js';
import { schemas } from '../schema.js';
import { api, brand, category, catalogApp, newId, productInput, sellerProduct, uploadImage, type CatalogTestApp } from './helpers.js';

const DAY = 86_400_000;
let t: CatalogTestApp;
let a: ReturnType<typeof api>;
let cat: { id: string; slug: string };
let brandId: string;

beforeAll(async () => {
  // settings on, with a recognisable calendar: every business day lasts three calendar days
  t = await catalogApp({ only: ['settings'] });
  const settings = t.app.kernel.boot.apis.get('settings') as { businessCalendar: () => Promise<unknown> };
  vi.spyOn(settings, 'businessCalendar').mockImplementation(async () => ({
    isOpen: () => true,
    isBusinessDay: () => true,
    addBusinessMinutes: (from: string) => from,
    addBusinessDays: (from: string, days: number) => new Date(new Date(from).getTime() + days * 3 * DAY).toISOString(),
    nextOpen: (after: string) => after,
  }));
  a = api(t);
  cat = await category(t, 'Speakers');
  brandId = (await brand(t, 'Orvel')).id;
});
afterAll(async () => {
  await t?.app.close();
});

const queueIds = async () => (await a.admin('GET', '/review-queue?limit=100')).json().items.map((p: { product: { id: string } }) => p.product.id);

describe('review dates', () => {
  it('count business days on the settings business calendar', async () => {
    const before = t.clock.now().getTime();
    const p = await sellerProduct(t, newId(), { brandId, categoryId: cat.id });
    const sub = (await a.admin('GET', `/products/${p.id}`)).json().submission;
    const due = new Date(sub.reviewDeadline.dueAt).getTime();
    // reviewTargetBusinessDays 1 → three calendar days; the expected date one business day later → six
    expect(due - before).toBeGreaterThanOrEqual(3 * DAY);
    expect(due - before).toBeLessThan(3 * DAY + 60_000);
    expect(new Date(sub.expectedReviewBy).getTime() - due).toBe(3 * DAY);
  });
});

describe('paused submissions', () => {
  it('a suspension sets pausedAt and leaves the queue; reinstatement clears it and keeps the deadline', async () => {
    const sellerId = newId();
    const p = await sellerProduct(t, sellerId, { brandId, categoryId: cat.id });
    const before = (await a.admin('GET', `/products/${p.id}`)).json().submission;
    expect(before.pausedAt).toBeNull();
    expect(await queueIds()).toContain(p.id);

    t.app.kernel.events.publish('sellers', 'sellers.seller.suspended', { sellerId, suspensionId: newId(), reasonCode: 'fraud', reason: 'Investigation', reviewDate: '2026-11-01', openOrders: 'seller_keeps_fulfilling', appealDeadline: new Date().toISOString() });
    await t.app.kernel.events.drain();
    const paused = (await a.admin('GET', `/products/${p.id}`)).json().submission;
    expect(paused.pausedAt).toEqual(expect.any(String));
    expect(paused.reviewDeadline.dueAt).toBe(before.reviewDeadline.dueAt);
    expect(await queueIds()).not.toContain(p.id);
    expect((await t.catalog.countProductsForSellers([sellerId]))[sellerId]!.pausedSubmissions).toBe(1);

    t.clock.advance(5 * 60_000);
    t.app.kernel.events.publish('sellers', 'sellers.seller.reinstated', { sellerId, from: 'suspended', to: 'approved', endedSuspensionId: newId(), remainingRestrictionIds: [] });
    await t.app.kernel.events.drain();
    const resumed = (await a.admin('GET', `/products/${p.id}`)).json().submission;
    expect(resumed.pausedAt).toBeNull();
    expect(resumed.reviewDeadline.dueAt).toBe(before.reviewDeadline.dueAt);
    expect(await queueIds()).toContain(p.id);
  });
});

describe('review queue kind', () => {
  it('filters by content_change; the old name correction is refused', async () => {
    const image = await uploadImage(t, 'staff');
    const created = await a.admin('POST', '/products', productInput({ brandId, categoryId: cat.id, imageIds: [image] }));
    const id = created.json().product.id;
    expect((await a.admin('POST', `/products/${id}/submit`, {})).statusCode).toBe(200);
    expect((await a.admin('POST', `/products/${id}/approve`, {})).statusCode).toBe(200);
    expect((await a.admin('PATCH', `/products/${id}`, { title: 'Orvel Arc speaker, second edition' })).statusCode).toBe(200);
    const changed = (await a.admin('GET', '/review-queue?kind=content_change&limit=100')).json().items;
    expect(changed.map((p: { product: { id: string } }) => p.product.id)).toContain(id);
    expect(changed.every((p: { submission: { kind: string } }) => p.submission.kind === 'content_change')).toBe(true);
    expect((await a.admin('GET', '/review-queue?kind=correction')).statusCode).toBe(400);
  });
});

describe('duplicate dismissals', () => {
  it('are kept per candidate in check_dismissals and shown on the evidence', async () => {
    const first = await sellerProduct(t, newId(), { brandId, categoryId: cat.id, model: 'OV-500', approve: true });
    const second = await sellerProduct(t, newId(), { brandId, categoryId: cat.id, model: 'OV-500', approve: true });
    const p = await sellerProduct(t, newId(), { brandId, categoryId: cat.id, model: 'ov 500' });
    const dup = (r: { checks: { kind: string }[] }) => r.checks.find((c) => c.kind === 'duplicate') as unknown as { evidence: { matchedProductId: string | null; dismissedAt: string | null }[] };
    const candidates = dup((await a.admin('GET', `/products/${p.id}`)).json()).evidence.map((e) => e.matchedProductId);
    expect(candidates).toEqual(expect.arrayContaining([first.id, second.id]));

    const one = (await a.admin('POST', `/products/${p.id}/checks/duplicate/dismiss`, { reason: 'Different model year', matchedProductId: first.id })).json();
    const ev = dup(one).evidence;
    expect(ev.find((e) => e.matchedProductId === first.id)!.dismissedAt).toEqual(expect.any(String));
    expect(ev.find((e) => e.matchedProductId === second.id)!.dismissedAt).toBeNull();
    expect(one.duplicateCandidates.map((d: { id: string }) => d.id)).toContain(second.id);

    const all = (await a.admin('POST', `/products/${p.id}/checks/duplicate/dismiss`, { reason: 'Not a duplicate' })).json();
    expect(dup(all).evidence.filter((e) => e.matchedProductId).every((e) => e.dismissedAt)).toBe(true);
    expect(all).toMatchObject({ duplicateSuspected: false, duplicateCandidates: [] });
    const rows = await t.app.kernel.mongo.module('catalog', spec.collections, schemas).table<{ matched_product_id: string }>('check_dismissals').find();
    const mine = rows.filter((r: { matched_product_id: string }) => [first.id, second.id].includes(r.matched_product_id));
    expect(mine.find((r: { matched_product_id: string }) => r.matched_product_id === first.id)).toMatchObject({ reason: 'Different model year', dismissed_by: { kind: 'staff' } });
    expect(mine.find((r: { matched_product_id: string }) => r.matched_product_id === second.id)).toMatchObject({ reason: 'Not a duplicate' });
  });
});
