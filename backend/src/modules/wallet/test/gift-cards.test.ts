/**
 * Gift cards: batches within approval limits, codes stored only as hashes, check and redemption into store
 * credit (rate-limited), void and expiry; and the loyalty placeholder.
 */
import { sql } from 'kysely';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { newId } from '../../../kernel/lib/ids.js';
import { callers } from '../../../testing/app.js';
import { detId } from '../domain/rules.js';
import { DAY, harness, idem, USD, type Harness } from './helpers.js';

let h: Harness;
beforeAll(async () => {
  h = await harness();
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
const manager = () => h.staff(['wallet.gift_cards.manage']);

async function batch(count: number, amount: number, extra: Record<string, unknown> = {}) {
  const res = await h.call('POST', `${ADMIN}/gift-cards`, manager(), { count, amount: USD(amount), purpose: 'promotional', reason: 'Launch giveaway', costCenter: 'MKT-01', ...extra }, idem());
  expect(res.status, JSON.stringify(res.body)).toBe(201);
  const file = h.service.giftCards.takeCodes(res.body.codesFileId);
  return { ...res.body, codes: file?.codes ?? [] } as { batchId: string; count: number; total: { amount: number }; codesFileId: string; codes: string[] };
}

describe('issuing', () => {
  it('issues a batch: codes once, stored only as hashes, listed by last 4 and batch', async () => {
    const key = idem();
    const res = await h.call('POST', `${ADMIN}/gift-cards`, manager(), { count: 3, amount: USD(2500), purpose: 'customer_service', reason: 'Service recovery', costCenter: null }, key);
    expect(res.status, JSON.stringify(res.body)).toBe(201);
    expect(res.body).toMatchObject({ count: 3, total: USD(7500), batchId: expect.any(String), codesFileId: expect.any(String) });
    const file = h.service.giftCards.takeCodes(res.body.codesFileId)!;
    expect(file.codes).toHaveLength(3);
    expect(file.codes[0]).toMatch(/^[A-Z2-9]{4}-[A-Z2-9]{4}-[A-Z2-9]{4}-[A-Z2-9]{4}$/);
    expect(h.service.giftCards.takeCodes(res.body.codesFileId)).toBeNull(); // downloadable once
    // a retry is the same batch
    expect((await h.call('POST', `${ADMIN}/gift-cards`, manager(), { count: 3, amount: USD(2500), purpose: 'customer_service', reason: 'Service recovery' }, key)).body.batchId).toBe(res.body.batchId);

    const raw = await sql<{ code_hash: string; code_last4: string; state: string }>`select code_hash, code_last4, state from wallet.gift_cards where batch_id = ${res.body.batchId}`.execute(h.app.kernel.database.kysely);
    const plain = file.codes.map((c) => c.replace(/-/g, ''));
    expect(raw.rows).toHaveLength(3);
    for (const r of raw.rows) {
      expect(plain).not.toContain(r.code_hash);
      expect(r.code_hash).toMatch(/^[0-9a-f]{64}$/);
      expect(r.state).toBe('active');
    }
    const last4 = plain[0]!.slice(-4);
    const listed = await h.call('GET', `${ADMIN}/gift-cards?last4=${last4}&batchId=${res.body.batchId}`, manager());
    expect(listed.body.items).toEqual([expect.objectContaining({ codeLast4: last4, initial: USD(2500), remaining: USD(2500), state: 'active', purpose: 'customer_service', createdBy: expect.objectContaining({ kind: 'staff' }) })]);
    expect(h.named('wallet.gift_card.issued')).toContainEqual({ batchId: res.body.batchId, count: 3, total: USD(7500), purpose: 'customer_service' });
    expect(h.audits.find((a) => a.action === 'wallet.gift_cards.issue')).toMatchObject({ category: 'financial', after: expect.not.objectContaining({ codes: expect.anything() }) });
    expect(JSON.stringify(h.audits)).not.toContain(plain[0]!);
  });

  it('a batch above the caller\'s limit is issued once Finance approves', async () => {
    h.authority['wallet.gift-cards.issue'] = 'approval_required';
    const res = await h.call('POST', `${ADMIN}/gift-cards`, manager(), { count: 200, amount: USD(5000), purpose: 'sold', reason: 'Retail partner', costCenter: null }, idem());
    expect(res.status).toBe(409);
    expect(res.body.error).toMatchObject({ code: 'APPROVAL_REQUIRED', details: { batchId: expect.any(String) } });
    const { batchId, approvalRequestId } = res.body.error.details;
    expect(h.approvals.find((a) => a.id === approvalRequestId)).toMatchObject({ action: 'wallet.gift-cards.issue', amount: USD(1_000_000) });
    expect((await h.call('GET', `${ADMIN}/gift-cards?batchId=${batchId}`, manager())).body.items).toHaveLength(0);
    await h.decide(approvalRequestId, 'approved');
    await h.decide(approvalRequestId, 'approved');
    const listed = await h.call('GET', `${ADMIN}/gift-cards?batchId=${batchId}&limit=100`, manager());
    expect(listed.body.items).toHaveLength(100);
    // the codes file of an approved batch (its id is in the audit entry; spec gap: no route hands it to the requester)
    const codes = h.service.giftCards.takeCodes(detId(`wallet:gift-card-codes:${batchId}`));
    expect(codes?.codes).toHaveLength(200);
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
    expect(redeemed.body.lots[0]).toMatchObject({ source: 'gift_card', remaining: USD(3000), reference: `gift card ••••${codes[0]!.slice(-4)}` });
    expect(redeemed.body.recent[0]).toMatchObject({ kind: 'gift_card_redeemed', label: `Gift card ••••${codes[0]!.slice(-4)} added` });
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
    await sql`insert into wallet.loyalty_entries (id, customer_id, points, kind, order_id, at) values (${newId()}, ${c.id}, 120, 'earned', null, now())`.execute(h.app.kernel.database.kysely);
    const on = await h.call('GET', `${STORE}/loyalty`, c.token);
    expect(on.body).toEqual({ customerId: c.id, points: 120, tier: null, pendingPoints: 0, programTerms: null });
  });
});
