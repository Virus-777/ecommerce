/** Jobs (expiry, orphan sweep, purge, reconcile) and the consumers of seller and customer closure. */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { devClaims } from '../../../kernel/auth/dev.js';
import { newId } from '../../../kernel/lib/ids.js';
import { token } from '../../../testing/app.js';
import { mediaApp, pdf, png, startUpload, uploadFile, type MediaTestApp } from './helpers.js';

let t: MediaTestApp;
beforeEach(async () => {
  t = await mediaApp();
});
afterEach(async () => {
  await t?.app.close();
});

const DAY = 86_400_000;
/** Tokens that outlive the clock jumps of these tests */
const seller = (sellerId = newId()) => token({ ...devClaims('seller', { sellerId }) }, 10 ** 8);
const customer = (accountId = newId()) => token({ ...devClaims('customer', { accountId }) }, 10 ** 8);
const run = async (job: Parameters<MediaTestApp['app']['kernel']['jobs']['runNow']>[0]) => {
  await t.app.kernel.jobs.runNow(job);
  await t.app.kernel.events.drain();
};
const status = async (id: string) => (await t.media.getAsset(id))?.status;
const deletedIds = () => t.eventsNamed('media.asset.deleted').map((e) => (e.payload as { assetId: string }).assetId);

describe('media.expire-uploads', () => {
  it('expires pending uploads after pendingUploadExpiryHours and deletes partial objects', async () => {
    const res = await startUpload(t, 'seller', seller(), { purpose: 'product_image', sizeBytes: 1000 });
    const ticket = res.json();
    const { bucket, key } = await t.storage.acceptSignedPut(ticket.url, Buffer.alloc(10), 'image/png'); // partial
    t.clock.advance(23 * 3_600_000);
    await run('media.expire-uploads');
    expect(await status(ticket.assetId)).toBe('pending_upload');
    t.clock.advance(2 * 3_600_000);
    await run('media.expire-uploads');
    expect(await status(ticket.assetId)).toBe('expired');
    expect(await t.storage.head(bucket, key)).toBeNull();
  });
});

describe('media.sweep-orphans', () => {
  it('deletes ready files never attached after orphanGraceDays; keeps used and generated files', async () => {
    const sellerId = newId();
    const s = seller(sellerId);
    const unused = await uploadFile(t, 'seller', s, { purpose: 'product_image', body: png(1000, 1000, { seed: 'orphan' }) });
    const used = await uploadFile(t, 'seller', s, { purpose: 'product_image', body: png(1000, 1000, { seed: 'used' }) });
    const formerlyUsed = await uploadFile(t, 'seller', s, { purpose: 'product_image', body: png(1000, 1000, { seed: 'former' }) });
    await t.media.attach(used.asset.id, { module: 'catalog', kind: 'product_image', refId: 'p1' }, { kind: 'seller', id: sellerId });
    await t.media.attach(formerlyUsed.asset.id, { module: 'catalog', kind: 'product_image', refId: 'p2' }, { kind: 'seller', id: sellerId });
    await t.media.detach(formerlyUsed.asset.id, { module: 'catalog', kind: 'product_image', refId: 'p2' });
    const generated = await t.media.storeGeneratedFile({ owner: { kind: 'seller', id: sellerId }, fileName: 's.pdf', contentType: 'application/pdf', body: new Blob([new Uint8Array(pdf(1))]).stream(), purpose: 'statement' });
    t.clock.advance(29 * DAY);
    await run('media.sweep-orphans');
    expect(await status(unused.asset.id)).toBe('ready');
    t.clock.advance(2 * DAY);
    await run('media.sweep-orphans');
    expect(await status(unused.asset.id)).toBe('deleted');
    expect(await status(used.asset.id)).toBe('ready');
    expect(await status(formerlyUsed.asset.id)).toBe('ready');
    expect(await status(generated.id)).toBe('ready');
    expect(deletedIds()).toEqual([unused.asset.id]);
  });
});

describe('media.expire-generated', () => {
  it('deletes generated files past their expiry', async () => {
    const a = await t.media.storeGeneratedFile({ owner: { kind: 'platform' }, fileName: 'export.csv', contentType: 'text/csv', body: new Blob(['a,b\n1,2\n']).stream(), ttlHours: 24, purpose: 'export' });
    const keep = await t.media.storeGeneratedFile({ owner: { kind: 'platform' }, fileName: 'label.pdf', contentType: 'application/pdf', body: new Blob([new Uint8Array(pdf(1))]).stream(), purpose: 'label' });
    t.clock.advance(25 * 3_600_000);
    await run('media.expire-generated');
    expect(await status(a.id)).toBe('deleted');
    expect(await status(keep.id)).toBe('ready');
  });
});

describe('media.purge-deleted', () => {
  it('erases storage objects of deleted files after deletedGraceDays', async () => {
    const s = seller();
    const { asset } = await uploadFile(t, 'seller', s, { purpose: 'product_image', body: png(1000, 1000, { seed: 'purge' }) });
    const before = t.storage.size();
    const del = await t.app.inject({ method: 'DELETE', url: `/api/seller/media/assets/${asset.id}`, headers: { authorization: `Bearer ${s}` } });
    expect(del.statusCode).toBe(204);
    t.clock.advance(6 * DAY);
    await run('media.purge-deleted');
    expect(t.storage.size()).toBe(before);
    t.clock.advance(2 * DAY);
    await run('media.purge-deleted');
    expect(before).toBe(10); // original, processed copy, 4 sizes × WebP and JPEG
    expect(t.storage.size()).toBe(0);
    expect(await t.storage.fetch(asset.url!)).toBeNull();
    expect((await t.media.getAsset(asset.id))?.renditions).toEqual([]);
    await run('media.purge-deleted'); // nothing left to do
  });

  it('purges removed evidence after its retention', async () => {
    const accountId = newId();
    const { asset } = await uploadFile(t, 'store', customer(accountId), { purpose: 'return_evidence', body: png(800, 800, { seed: 'removed-evidence' }) });
    const usage = { module: 'returns', kind: 'return_evidence' as const, refId: 'RT-9' };
    await t.media.attach(asset.id, usage, { kind: 'customer', id: accountId });
    await t.media.detach(asset.id, usage);
    await t.media.remove(asset.id, { reason: 'Contains personal data', by: { kind: 'staff', id: newId() } });
    t.clock.advance(700 * DAY);
    await run('media.purge-deleted');
    expect(await status(asset.id)).toBe('removed');
    t.clock.advance(31 * DAY);
    await run('media.purge-deleted');
    expect(await status(asset.id)).toBe('deleted');
    expect(deletedIds()).toContain(asset.id);
  });
});

describe('media.reconcile-storage', () => {
  it('reports orphaned objects and missing files', async () => {
    const { asset } = await uploadFile(t, 'seller', seller(), { purpose: 'product_image', body: png(1000, 1000, { seed: 'reconcile' }) });
    await t.storage.put(t.storage.buckets.private, 'originals/stray.png', Buffer.from('x'), 'image/png');
    let report = await t.media.reconcileStorage();
    expect(report).toMatchObject({ orphaned: [`${t.storage.buckets.private}/originals/stray.png`], missing: [] });
    const row = await t.app.kernel.database.kysely.withSchema('media').selectFrom('assets').select(['storage_bucket', 'storage_key']).where('id', '=', asset.id).executeTakeFirstOrThrow();
    await t.storage.delete(row.storage_bucket, row.storage_key);
    report = await t.media.reconcileStorage();
    expect(report.missing).toEqual([asset.id]);
    await run('media.reconcile-storage');
  });
});

describe('consumers', () => {
  it('sellers.seller.closed: never-used files are deleted after orphanGraceDays, used and evidence files are kept', async () => {
    const sellerId = newId();
    const s = seller(sellerId);
    const owner = { kind: 'seller' as const, id: sellerId };
    const never = await uploadFile(t, 'seller', s, { purpose: 'product_image', body: png(1000, 1000, { seed: 'closed-never' }) });
    const snapshot = await uploadFile(t, 'seller', s, { purpose: 'product_image', body: png(1000, 1000, { seed: 'closed-order' }) });
    await t.media.attach(snapshot.asset.id, { module: 'orders', kind: 'order_evidence', refId: 'MK-1' }, owner);
    const pending = (await startUpload(t, 'seller', s, { purpose: 'product_image' })).json();
    const event = { sellerId, reasonCode: 'seller_request', closedBy: { kind: 'staff' as const, id: newId() } };
    t.app.kernel.events.publish('sellers', 'sellers.seller.closed', event);
    t.app.kernel.events.publish('sellers', 'sellers.seller.closed', event); // twice: same result
    await t.app.kernel.events.drain();
    expect(await status(pending.assetId)).toBe('expired');
    expect(await status(never.asset.id)).toBe('ready');
    t.clock.advance(31 * DAY);
    await run('media.sweep-orphans');
    expect(await status(never.asset.id)).toBe('deleted');
    expect(await status(snapshot.asset.id)).toBe('ready');
    // the order snapshot is evidence: kept for evidenceRetentionDays after the order lets go of it
    await t.media.detach(snapshot.asset.id, { module: 'orders', kind: 'order_evidence', refId: 'MK-1' });
    await run('media.sweep-orphans');
    expect(await status(snapshot.asset.id)).toBe('ready');
    t.clock.advance(731 * DAY);
    await run('media.sweep-orphans');
    expect(await status(snapshot.asset.id)).toBe('deleted');
  });

  it('customers.account.closed: unused uploads are deleted now; evidence is kept until retainUntil, then deleted', async () => {
    const accountId = newId();
    const c = customer(accountId);
    const owner = { kind: 'customer' as const, id: accountId };
    const unused = await uploadFile(t, 'store', c, { purpose: 'review_photo', body: png(900, 900, { seed: 'cust-unused' }) });
    const evidence = await uploadFile(t, 'store', c, { purpose: 'return_evidence', body: png(900, 900, { seed: 'cust-evidence' }) });
    await t.media.attach(evidence.asset.id, { module: 'returns', kind: 'return_evidence', refId: 'RT-2' }, owner);
    t.app.kernel.events.publish('customers', 'customers.account.closed', { customerId: newId(), userId: accountId });
    await t.app.kernel.events.drain();
    expect(await status(unused.asset.id)).toBe('deleted');
    expect(await status(evidence.asset.id)).toBe('ready');
    await t.media.detach(evidence.asset.id, { module: 'returns', kind: 'return_evidence', refId: 'RT-2' });
    t.clock.advance(729 * DAY);
    await run('media.sweep-orphans');
    expect(await status(evidence.asset.id)).toBe('ready');
    t.clock.advance(2 * DAY);
    await run('media.sweep-orphans');
    expect(await status(evidence.asset.id)).toBe('deleted');
    // unknown customers are ignored
    t.app.kernel.events.publish('customers', 'customers.account.closed', { customerId: newId(), userId: newId() });
    await t.app.kernel.events.drain();
  });
});
