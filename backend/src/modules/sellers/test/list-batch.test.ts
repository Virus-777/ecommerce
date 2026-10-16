/**
 * The admin seller list asks reviews, support and finance once per list for all its rows (their batch public API
 * functions), never once per seller; a module that cannot answer leaves its columns empty. New agreement versions
 * reach every selling seller, however many there are (keyset batches of 500).
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { newId } from '../../../kernel/lib/ids.js';
import { ADMIN, approvedSeller, boot, staff, type Kit } from './helpers.js';

const USD = (amount: number) => ({ amount, currency: 'USD' });

let kit: Kit;
/** What the other modules answer per seller id */
const figures = new Map<string, { open: number; available: number; positivePct: number }>();
/** Ids each batch function was asked for, per call */
const asked: Record<'feedback' | 'cases' | 'balances', string[][]> = { feedback: [], cases: [], balances: [] };
/** Per-seller calls (the list must not make any) */
const perSeller: string[] = [];
let supportDown = false;

beforeAll(async () => {
  kit = await boot({
    apiStubs: {
      reviews: {
        feedbackSummariesForSellers: async (ids: string[], opts?: { dispatch?: boolean }) => {
          asked.feedback.push(ids);
          expect(opts).toEqual({ dispatch: false });
          return new Map(ids.map((id) => [id, { sellerId: id, count: 12, positivePct: figures.get(id)?.positivePct ?? null } as never]));
        },
        getSellerFeedbackSummary: async (id: string) => (perSeller.push(`reviews:${id}`), { sellerId: id, count: 0, positivePct: null } as never),
      },
      support: {
        caseStatsForSellers: async (ids: string[]) => {
          asked.cases.push(ids);
          if (supportDown) throw new Error('support is down');
          return new Map(ids.map((id) => [id, { open: figures.get(id)?.open ?? 0, unresolved: 0, decidedAgainstSeller: 0, medianReplyMinutes: 0 }]));
        },
        sellerCaseStats: async (id: string) => (perSeller.push(`support:${id}`), { open: 0, unresolved: 0, decidedAgainstSeller: 0, medianReplyMinutes: 0 }),
      },
      finance: {
        balancesForSellers: async (ids: string[]) => {
          asked.balances.push(ids);
          return new Map(ids.map((id) => [id, { available: USD(figures.get(id)?.available ?? 0), held: USD(0), negative: (figures.get(id)?.available ?? 0) < 0 } as never]));
        },
        getSellerBalances: async (id: string) => (perSeller.push(`finance:${id}`), { available: USD(0), held: USD(0), negative: false } as never),
      },
    },
  });
});
afterAll(async () => {
  await kit?.close();
});
beforeEach(() => {
  for (const k of Object.keys(asked) as (keyof typeof asked)[]) asked[k] = [];
  perSeller.length = 0;
  supportDown = false;
});

describe('admin seller list', () => {
  let ids: string[] = [];

  it('sorts and filters on other modules\' figures asked once for all rows', async () => {
    const [a, b, c] = [await approvedSeller(kit), await approvedSeller(kit), await approvedSeller(kit)];
    ids = [a.sellerId, b.sellerId, c.sellerId];
    figures.set(a.sellerId, { open: 1, available: 900, positivePct: 99 });
    figures.set(b.sellerId, { open: 5, available: -100, positivePct: 80 });
    figures.set(c.sellerId, { open: 3, available: 500, positivePct: 95 });
    perSeller.length = 0;

    const byCases = await kit.call('GET', `${ADMIN}/sellers?sort=cases&limit=10`, staff());
    expect(byCases.status, JSON.stringify(byCases.body)).toBe(200);
    expect(byCases.body.items.map((r: any) => r.id)).toEqual([b.sellerId, c.sellerId, a.sellerId]);
    expect(byCases.body.items[0]).toMatchObject({ openCases: 5, feedback: { positivePct: 80, ratingCount: 12 }, balance: USD(-100), negativeBalance: true });

    const byBalance = await kit.call('GET', `${ADMIN}/sellers?sort=balance&limit=10`, staff());
    expect(byBalance.body.items.map((r: any) => r.id)).toEqual([a.sellerId, c.sellerId, b.sellerId]);
    const negative = await kit.call('GET', `${ADMIN}/sellers?balance=negative&limit=10`, staff());
    expect(negative.body.items.map((r: any) => r.id)).toEqual([b.sellerId]);

    // one batched call per module and list, with every seller; no per-seller calls
    expect(asked.feedback).toHaveLength(3);
    expect(asked.cases).toHaveLength(3);
    expect(asked.balances).toHaveLength(3);
    for (const call of [...asked.feedback, ...asked.cases, ...asked.balances]) expect([...call].sort()).toEqual([...ids].sort());
    expect(perSeller).toEqual([]);
  });

  it('a module that cannot answer leaves its column empty for every row; the list still answers', async () => {
    supportDown = true;
    const list = await kit.call('GET', `${ADMIN}/sellers?sort=cases&limit=10`, staff());
    expect(list.status).toBe(200);
    expect(list.body.items).toHaveLength(3);
    expect(list.body.items.every((r: any) => r.openCases === 0)).toBe(true);
    expect(list.body.items.find((r: any) => r.id === ids[0])).toMatchObject({ feedback: { positivePct: 99 }, balance: USD(900) });
    expect(perSeller).toEqual([]);
  });
});

describe('content.policy.effective', () => {
  it('reaches every selling seller past one batch of 500, once', async () => {
    // 501 more selling sellers and a closed one, as stored rows (copies of a real seller)
    const [first] = await kit.svc.core.repo.find('sellers', { status: 'approved' }, { limit: 1 });
    const copy = (status: string, i: number) => kit.svc.core.repo.insert('sellers', { ...first!, id: newId(), ref: `SL-B${i}`, slug: `batch-${i}-${newId().slice(0, 8)}`, status });
    await Promise.all(Array.from({ length: 501 }, (_, i) => copy(i % 2 ? 'restricted' : 'approved', i)));
    const closed = await copy('closed', 999);
    const selling = await kit.svc.core.repo.count('sellers', { status: ['approved', 'restricted', 'suspended'] });
    expect(selling).toBe(504);

    const policyVersionId = newId();
    const told = async () => kit.svc.core.repo.find('account_events', { kind: 'agreement_pending', ref: policyVersionId });
    await kit.emit('content', 'content.policy.effective', { policyVersionId, policyKey: 'seller_agreement', version: 'v2.0' });
    const events = await told();
    expect(events).toHaveLength(504);
    expect(new Set(events.map((e) => e.seller_id)).size).toBe(504);
    expect(events.some((e) => e.seller_id === closed.id)).toBe(false);
    // a redelivered event tells nobody twice
    await kit.emit('content', 'content.policy.effective', { policyVersionId, policyKey: 'seller_agreement', version: 'v2.0' });
    expect(await told()).toHaveLength(504);
  });
});
