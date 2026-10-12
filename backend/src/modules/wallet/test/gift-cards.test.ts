/**
 * Gift cards: batches within approval limits, codes stored only as hashes on the cards and sealed on the batch
 * for one download, check and redemption into store credit (rate-limited), void and expiry; and the loyalty
 * placeholder.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { newId } from '../../../kernel/lib/ids.js';
import { callers } from '../../../testing/app.js';
import { DAY, harness, idem, USD, walletTable, type Harness } from './helpers.js';

let h: Harness;
beforeAll(async () => {
  // gift card attempts counted in kernel.rate_limits (MongoDB), as in production
  h = await harness({ config: { rateLimitStore: 'mongo' } });
  h.settings['wallet.giftCardsEnabled'] = true;
});
afterAll(async () => {
  await h?.app.close();
});
beforeEach(() => {
  h.authority = {};
});

const ADMIN = '/api/admin/wallet';
const STORE = '/api/store/wallet';
/** One issuer: only the staff member who issued a batch may download its codes */
const ISSUER = newId();
const manager = (accountId = ISSUER) => h.staff(['wallet.gift_cards.manage'], accountId);
const table = (name: Parameters<typeof walletTable>[1]) => walletTable(h.app, name);
const pick = (row: Record<string, unknown> | undefined, cols: string[]) => (row ? Object.fromEntries(cols.map((c) => [c, row[c]])) : undefined);

/** The batch's codes through GET /gift-cards/batches/{id}/codes */
async function download(batchId: string, token = manager()) {
  return h.call('GET', `${ADMIN}/gift-cards/batches/${batchId}/codes`, token);
}

async function batch(count: number, amount: number, extra: Record<string, unknown> = {}) {
  const res = await h.call('POST', `${ADMIN}/gift-cards`, manager(), { count, amount: USD(amount), purpose: 'promotional', reason: 'Launch giveaway', costCenter: 'MKT-01', ...extra }, idem());
  expect(res.status, JSON.stringify(res.body)).toBe(201);
  const file = await download(res.body.batchId);
  expect(file.status, JSON.stringify(file.body)).toBe(200);
  return { ...res.body, codes: file.body.codes } as { batchId: string; count: number; total: { amount: number }; codes: string[] };
}

describe('issuing', () => {
  it('issues a batch: codes downloadable once, stored only as hashes (cards) and sealed (batch), listed by last 4 and batch', async () => {
    const key = idem();
    const res = await h.call('POST', `${ADMIN}/gift-cards`, manager(), { count: 3, amount: USD(2500), purpose: 'customer_service', reason: 'Service recovery', costCenter: null }, key);
    expect(res.status, JSON.stringify(res.body)).toBe(201);
    const until = new Date(h.clock.now().getTime() + 24 * 3_600_000);
    // media is enabled here (stubbed): the codes are also a private gift_card_codes document
    const doc = h.mediaFiles.at(-1)!;
    expect(res.body).toEqual({ batchId: expect.any(String), count: 3, total: USD(7500), status: 'issued', codesFileId: doc.id, codesAvailableUntil: expect.any(String) });
    expect(doc).toMatchObject({ purpose: 'gift_card_codes', ttlHours: 24, fileName: `gift-cards-${res.body.batchId}.csv` });
    expect(Math.abs(new Date(res.body.codesAvailableUntil).getTime() - until.getTime())).toBeLessThan(5_000);

    // the batch row holds the codes only sealed
    const sealed = pick(await table('gift_card_batches').get(res.body.batchId), ['codes_ciphertext', 'status', 'count', 'amount', 'codes_delivered_at']);
    expect(sealed).toMatchObject({ status: 'issued', count: 3, amount: 2500, codes_delivered_at: null, codes_ciphertext: expect.any(String) });

    const file = await download(res.body.batchId);
    expect(file.status, JSON.stringify(file.body)).toBe(200);
    expect(file.body).toEqual({ batchId: res.body.batchId, codes: expect.any(Array), count: 3, deliveredAt: expect.any(String) });
    const codes = file.body.codes as string[];
    expect(new Set(codes).size).toBe(3);
    expect(codes[0]).toMatch(/^[A-Z2-9]{4}-[A-Z2-9]{4}-[A-Z2-9]{4}-[A-Z2-9]{4}$/);
    const plain = codes.map((c) => c.replace(/-/g, ''));
    for (const c of [...codes, ...plain]) expect(sealed!.codes_ciphertext as string).not.toContain(c);
    expect(doc.text).toBe(['code', ...codes].join('\n') + '\n');

    // downloadable once: the sealed copy is deleted
    const again = await download(res.body.batchId);
    expect(again.status).toBe(410);
    expect(again.body.error.code).toBe('GIFT_CARD_CODES_UNAVAILABLE');
    const after = pick(await table('gift_card_batches').get(res.body.batchId), ['codes_ciphertext', 'codes_delivered_at']);
    expect(after).toMatchObject({ codes_ciphertext: null, codes_delivered_at: expect.any(Date) });

    // a retry is the same batch (no new cards, no new codes)
    const retry = { body: await h.service.giftCards.issue({ count: 3, amount: USD(2500), purpose: 'customer_service', reason: 'Service recovery' }, { actor: { kind: 'staff', id: ISSUER } }, key['idempotency-key']) };
    expect(retry.body).toEqual({ batchId: res.body.batchId, count: 3, total: USD(7500), status: 'issued', codesFileId: doc.id, codesAvailableUntil: null });

    const raw = await table('gift_cards').find({ batch_id: res.body.batchId });
    expect(raw).toHaveLength(3);
    for (const r of raw) {
      expect(plain).not.toContain(r.code_hash);
      expect(r.code_hash).toMatch(/^[0-9a-f]{64}$/);
      expect(r.state).toBe('active');
    }
    const last4 = plain[0]!.slice(-4);
    const listed = await h.call('GET', `${ADMIN}/gift-cards?last4=${last4}&batchId=${res.body.batchId}`, manager());
    expect(listed.body.items).toEqual([expect.objectContaining({ codeLast4: last4, initial: USD(2500), remaining: USD(2500), state: 'active', purpose: 'customer_service', createdBy: expect.objectContaining({ kind: 'staff' }) })]);
    expect(h.named('wallet.gift_card.issued')).toContainEqual({ batchId: res.body.batchId, count: 3, total: USD(7500), purpose: 'customer_service' });
    expect(h.audits.find((a) => a.action === 'wallet.gift_cards.issue')).toMatchObject({ category: 'financial', after: expect.not.objectContaining({ codes: expect.anything() }) });
    expect(h.audits.find((a) => a.action === 'wallet.gift_cards.download_codes' && a.target.id === res.body.batchId)).toMatchObject({ category: 'financial', after: { batchId: res.body.batchId, count: 3 } });
    for (const c of [...codes, ...plain]) expect(JSON.stringify(h.audits)).not.toContain(c);

    // the downloaded codes really work
    const customer = h.customer();
    const redeemed = await h.call('POST', `${STORE}/gift-cards/redeem`, customer.token, { code: codes[2] }, idem());
    expect(redeemed.status, JSON.stringify(redeemed.body)).toBe(200);
    expect(redeemed.body.balance.available).toEqual(USD(2500));
  });

  it('only the issuer downloads the codes; another staff member is FORBIDDEN and an unknown batch NOT_FOUND', async () => {
    const res = await h.call('POST', `${ADMIN}/gift-cards`, manager(), { count: 1, amount: USD(1000), purpose: 'promotional', reason: 'Raffle' }, idem());
    const other = await download(res.body.batchId, manager(newId()));
    expect(other.status).toBe(403);
    expect((await download(newId())).status).toBe(404);
    // the issuer still gets them (the refused call deleted nothing)
    expect((await download(res.body.batchId)).body.codes).toHaveLength(1);
  });

  it('undelivered codes expire after giftCardCodesTtlHours (410) and the sweep deletes them', async () => {
    h.settings['wallet.giftCardCodesTtlHours'] = 2;
    try {
      const res = await h.call('POST', `${ADMIN}/gift-cards`, manager(), { count: 2, amount: USD(500), purpose: 'promotional', reason: 'Fair' }, idem());
      expect(Math.abs(new Date(res.body.codesAvailableUntil).getTime() - (h.clock.now().getTime() + 2 * 3_600_000))).toBeLessThan(5_000);
      h.clock.advance(2 * 3_600_000 + 1_000);
      const late = await download(res.body.batchId);
      expect(late.status).toBe(410);
      expect(late.body.error.code).toBe('GIFT_CARD_CODES_UNAVAILABLE');
      await h.app.kernel.jobs.runNow('wallet.release-stale-holds');
      const row = pick(await table('gift_card_batches').get(res.body.batchId), ['codes_ciphertext', 'codes_delivered_at']);
      expect(row).toEqual({ codes_ciphertext: null, codes_delivered_at: null });
    } finally {
      delete h.settings['wallet.giftCardCodesTtlHours'];
    }
  });

  it('a batch above the caller\'s limit is saved pending approval (201), has no codes until Finance approves, then the issuer downloads them', async () => {
    h.authority['wallet.gift-cards.issue'] = 'approval_required';
    const res = await h.call('POST', `${ADMIN}/gift-cards`, manager(), { count: 200, amount: USD(5000), purpose: 'sold', reason: 'Retail partner', costCenter: null }, idem());
    expect(res.status, JSON.stringify(res.body)).toBe(201);
    expect(res.body).toEqual({ batchId: expect.any(String), count: 200, total: USD(1_000_000), status: 'pending_approval', codesFileId: null, codesAvailableUntil: null });
    const { batchId } = res.body;
    const req = h.approvals.find((a) => a.target.id === batchId)!;
    expect(req).toMatchObject({ action: 'wallet.gift-cards.issue', amount: USD(1_000_000) });
    expect((await h.call('GET', `${ADMIN}/gift-cards?batchId=${batchId}`, manager())).body.items).toHaveLength(0);
    expect((await download(batchId)).status).toBe(410); // not issued yet

    await h.decide(req.id, 'approved');
    await h.decide(req.id, 'approved'); // redelivered: nothing more
    const listed = await h.call('GET', `${ADMIN}/gift-cards?batchId=${batchId}&limit=100`, manager());
    expect(listed.body.items).toHaveLength(100);
    expect(await table('gift_cards').count({ batch_id: batchId })).toBe(200);
    expect(h.named('wallet.gift_card.issued')).toContainEqual({ batchId, count: 200, total: USD(1_000_000), purpose: 'sold' });
    const file = await download(batchId);
    expect(file.status).toBe(200);
    expect(file.body.codes).toHaveLength(200);
  });

  it('a rejected batch is never issued', async () => {
    h.authority['wallet.gift-cards.issue'] = 'approval_required';
    const key = idem();
    const res = await h.call('POST', `${ADMIN}/gift-cards`, manager(), { count: 5, amount: USD(5000), purpose: 'sold', reason: 'Retail partner' }, key);
    const req = h.approvals.find((a) => a.target.id === res.body.batchId)!;
    await h.decide(req.id, 'rejected');
    expect((await table('gift_card_batches').get(res.body.batchId))!.status).toBe('rejected');
    expect((await h.call('GET', `${ADMIN}/gift-cards?batchId=${res.body.batchId}`, manager())).body.items).toHaveLength(0);
    expect((await download(res.body.batchId)).status).toBe(410);
  });

  it('validates the batch', async () => {
    const bad = await h.call('POST', `${ADMIN}/gift-cards`, manager(), { count: 0, amount: USD(-5), purpose: 'promotional', reason: '', expiresAt: '2020-01-01T00:00:00Z' }, idem());
    expect(bad.body.error.details.issues.map((i: { path: string }) => i.path).sort()).toEqual(['amount', 'count', 'expiresAt', 'reason']);
  });
});

describe('checking and redeeming', () => {
  it('checks a balance and redeems the full value into store credit, once', async () => {
    const { codes } = await batch(2, 3000, { expiresAt: new Date(h.clock.now().getTime() + 400 * DAY).toISOString() });
    const visitor = callers.visitor();
    const checked = await h.call('POST', `${STORE}/gift-cards/check`, visitor, { code: codes[0]!.toLowerCase().replace(/-/g, ' ') });
    expect(checked.status, JSON.stringify(checked.body)).toBe(200);
    expect(checked.body).toMatchObject({ remaining: USD(3000), state: 'active', expiresAt: expect.any(String) });

    const c = h.customer();
    const key = idem();
    const redeemed = await h.call('POST', `${STORE}/gift-cards/redeem`, c.token, { code: codes[0] }, key);
    expect(redeemed.status, JSON.stringify(redeemed.body)).toBe(200);
    expect(redeemed.body.balance.available).toEqual(USD(3000));
    expect(redeemed.body.lots[0]).toMatchObject({ source: 'gift_card', remaining: USD(3000), reference: `gift card â€¢â€¢â€¢â€¢${codes[0]!.slice(-4)}` });
    expect(redeemed.body.recent[0]).toMatchObject({ kind: 'gift_card_redeemed', label: `Gift card â€¢â€¢â€¢â€¢${codes[0]!.slice(-4)} added` });
    const card = h.named('wallet.gift_card.redeemed').find((e) => e.customerId === c.id);
    expect(card).toMatchObject({ customerId: c.id, amount: USD(3000) });
    expect(h.named('wallet.credit.granted').find((e) => e.customerId === c.id)).toMatchObject({ kind: 'gift_card_redeemed', amount: USD(3000) });

    // the same customer again: nothing more; another customer: invalid
    const again = await h.call('POST', `${STORE}/gift-cards/redeem`, c.token, { code: codes[0] }, idem());
    expect(again.body.balance.available).toEqual(USD(3000));
    const other = h.customer();
    const taken = await h.call('POST', `${STORE}/gift-cards/redeem`, other.token, { code: codes[0] }, idem());
    expect(taken.status).toBe(422);
    expect(taken.body.error.code).toBe('GIFT_CARD_INVALID');
    expect((await h.call('POST', `${STORE}/gift-cards/check`, visitor, { code: codes[0] })).body).toMatchObject({ state: 'redeemed', remaining: USD(0) });
    const row = (await h.call('GET', `${ADMIN}/gift-cards?last4=${codes[0]!.slice(-4)}`, manager())).body.items[0];
    expect(row).toMatchObject({ state: 'redeemed', redeemedBy: c.id, remaining: USD(0) });
  });

  it('voids lost cards; voided, redeemed and expired cards cannot be used', async () => {
    const { codes, batchId } = await batch(2, 1000, { expiresAt: new Date(h.clock.now().getTime() + 5 * DAY).toISOString() });
    const cards = (await h.call('GET', `${ADMIN}/gift-cards?batchId=${batchId}`, manager())).body.items as { id: string; codeLast4: string }[];
    const lost = cards.find((x) => codes[0]!.endsWith(x.codeLast4))!;
    const voided = await h.call('POST', `${ADMIN}/gift-cards/${lost.id}/void`, manager(), { reason: 'Reported lost' }, idem());
    expect(voided.status).toBe(200);
    expect(voided.body.state).toBe('voided');
    expect(h.audits.find((a) => a.action === 'wallet.gift_cards.void' && a.target.id === lost.id)).toMatchObject({ reason: 'Reported lost' });
    const c = h.customer();
    expect((await h.call('POST', `${STORE}/gift-cards/redeem`, c.token, { code: codes[0] }, idem())).body.error.code).toBe('GIFT_CARD_INVALID');
    expect((await h.call('POST', `${ADMIN}/gift-cards/${newId()}/void`, manager(), { reason: 'x' }, idem())).status).toBe(404);

    h.clock.advance(6 * DAY);
    expect((await h.call('POST', `${STORE}/gift-cards/check`, c.token, { code: codes[1] })).body.state).toBe('expired');
    expect((await h.call('POST', `${STORE}/gift-cards/redeem`, c.token, { code: codes[1] }, idem())).body.error.code).toBe('GIFT_CARD_INVALID');
    await h.app.kernel.jobs.runNow('wallet.expire-lots');
    const expired = cards.find((x) => codes[1]!.endsWith(x.codeLast4))!;
    expect((await h.call('GET', `${ADMIN}/gift-cards?state=expired&batchId=${batchId}`, manager())).body.items.map((x: { id: string }) => x.id)).toEqual([expired.id]);
    const cannot = await h.call('POST', `${ADMIN}/gift-cards/${expired.id}/void`, manager(), { reason: 'x' }, idem());
    expect(cannot.body.error.code).toBe('ILLEGAL_TRANSITION');
  });

  it('pauses lookups after repeated wrong codes (RATE_LIMITED)', async () => {
    const c = h.customer();
    for (let i = 0; i < 5; i++) {
      const wrong = await h.call('POST', `${STORE}/gift-cards/check`, c.token, { code: `AAAA-BBBB-CCCC-DD${i}${i}` });
      expect(wrong.body.error.code).toBe('GIFT_CARD_INVALID');
    }
    const paused = await h.call('POST', `${STORE}/gift-cards/redeem`, c.token, { code: 'AAAA-BBBB-CCCC-DDDD' }, idem());
    expect(paused.status).toBe(429);
    expect(paused.body.error).toMatchObject({ code: 'RATE_LIMITED', details: { retryAfterSeconds: expect.any(Number) } });
    // another caller is not affected
    expect((await h.call('POST', `${STORE}/gift-cards/check`, callers.visitor(), { code: 'nope' })).body.error.code).toBe('GIFT_CARD_INVALID');
    h.clock.advance(16 * 60_000);
    expect((await h.call('POST', `${STORE}/gift-cards/check`, c.token, { code: 'AAAA-BBBB-CCCC-DDDD' })).body.error.code).toBe('GIFT_CARD_INVALID');
  });

  it('answers GIFT_CARD_INVALID while gift cards are switched off', async () => {
    h.settings['wallet.giftCardsEnabled'] = false;
    try {
      const c = h.customer();
      const res = await h.call('POST', `${STORE}/gift-cards/check`, c.token, { code: 'AAAA-BBBB-CCCC-DDDD' });
      expect(res.body.error).toMatchObject({ code: 'GIFT_CARD_INVALID' });
      expect((await h.call('GET', `${STORE}/credit`, c.token)).body.giftCardsEnabled).toBe(false);
    } finally {
      h.settings['wallet.giftCardsEnabled'] = true;
    }
  });
});

describe('loyalty (phase 4 experiment)', () => {
  it('answers NOT_IMPLEMENTED until a program is defined, then the points', async () => {
    const c = h.customer();
    const off = await h.call('GET', `${STORE}/loyalty`, c.token);
    expect(off.status).toBe(501);
    expect(off.body.error.code).toBe('NOT_IMPLEMENTED');
    h.settings['wallet.loyaltyEnabled'] = true;
    await table('loyalty_entries').insert({ id: newId(), customer_id: c.id, points: 120, kind: 'earned', order_id: null, at: h.clock.now() });
    const on = await h.call('GET', `${STORE}/loyalty`, c.token);
    expect(on.body).toEqual({ customerId: c.id, points: 120, tier: null, pendingPoints: 0, programTerms: null });
  });
});
