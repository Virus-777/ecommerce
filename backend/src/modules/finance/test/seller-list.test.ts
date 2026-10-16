/**
 * The admin seller list (GET /api/admin/finance/sellers) is filtered, sorted and paged in the database. These tests
 * page through it with each filter and compare with the list worked out in memory, the way the list was built
 * before: every account, most recently changed first (ties by seller id, newest first), then the filter.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { newId } from '../../../kernel/lib/ids.js';
import { encodeCursor } from '../../../kernel/lib/pagination.js';
import type { AccountRec } from '../ports.js';
import { ADMIN, boot, type Kit } from './helpers.js';

let k: Kit;
const FILTERS = [undefined, 'negative', 'held', 'owed', 'destination_issue'] as const;

beforeAll(async () => {
  k = await boot();
  const repo = k.svc.core.repo;
  const base = Date.parse('2026-10-01T00:00:00Z');
  // 14 accounts; every third shares its updated_at with the one before (ties are ordered by seller id)
  for (let i = 0; i < 14; i++) {
    const sellerId = newId();
    const at = new Date(base + (i - (i % 3 === 2 ? 1 : 0)) * 60_000);
    await repo.insert('seller_accounts', { seller_id: sellerId, pending: 100 * i, available: i % 4 === 0 ? -50 * (i + 1) : 300 * i, held: i % 3 === 0 ? 0 : 40 * i, currency: 'USD', negative_since: null, payouts_blocked_reason: null, fee_override_set_id: null, new_seller_until: null, new_seller_extra_days: null, updated_at: at } as AccountRec);
    // open amounts owed for every other seller; a settled one for some that has no open one
    if (i % 2 === 0) await owe(sellerId, 'open', 500 + i);
    else if (i % 5 === 0) await owe(sellerId, 'settled', 900);
    // destinations: verified (most), verified with a change under review, pending verification, none
    const kind = i % 5;
    if (kind !== 4) {
      const destId = newId();
      await repo.insert('payout_destinations', { id: destId, seller_id: sellerId, sellers_account_id: newId(), label: `Bank ${i}`, provider_destination_id: null, status: kind === 3 ? 'verification_pending' : 'verified', verified_at: kind === 3 ? null : at, active: kind !== 3, pause_until: null, deposits_sent_at: null, deposit_attempts: 0 });
      if (kind === 2) await repo.insert('destination_reviews', { id: newId(), seller_id: sellerId, destination_id: destId, from_label: `Bank ${i}`, to_label: 'New bank', requested_by: 'seller', requested_at: at, status: 'under_review', checks: {}, decided_by: null, decided_at: null, reason: null });
    }
  }
});
afterAll(async () => {
  await k?.close();
});

async function owe(sellerId: string, status: string, amount: number) {
  await k.svc.core.repo.insert('amounts_owed', { id: newId(), seller_id: sellerId, amount, remaining: amount, currency: 'USD', since: '2026-10-01', due_by: null, status, origin: {}, note: null, write_off_amount: null, write_off_reason: null, approval_request_id: null });
}

/** The list as the old in-memory code built it: every account sorted, then filtered */
async function expected(filter?: string): Promise<string[]> {
  const repo = k.svc.core.repo;
  const all = (await repo.find('seller_accounts', {})).sort((a, b) => b.updated_at.getTime() - a.updated_at.getTime() || (a.seller_id < b.seller_id ? 1 : -1));
  const owed = new Set((await repo.find('amounts_owed', { status: 'open' })).map((o) => o.seller_id));
  const dests = await k.svc.core.destinationStatuses(all.map((a) => a.seller_id));
  return all
    .filter((a) => (filter === 'negative' ? a.available < 0 : filter === 'held' ? a.held > 0 : filter === 'owed' ? owed.has(a.seller_id) : filter === 'destination_issue' ? dests.get(a.seller_id)!.status !== 'verified' : true))
    .map((a) => a.seller_id);
}

const list = (query: string) => k.call('GET', `${ADMIN}/sellers?${query}`, k.staff);

describe('admin seller list paged in the database', () => {
  it('pages by cursor across several pages with each filter, in the full expected order, with the total', async () => {
    for (const filter of FILTERS) {
      const want = await expected(filter);
      expect(want.length).toBeGreaterThan(3); // several pages of 2
      const got: string[] = [];
      let cursor: string | null = null;
      let pages = 0;
      do {
        const res = await list(`limit=2${filter ? `&filter=${filter}` : ''}${cursor ? `&cursor=${encodeURIComponent(cursor)}` : ''}`);
        expect(res.status).toBe(200);
        expect(res.body.total).toBe(want.length);
        got.push(...res.body.items.map((r: { sellerId: string }) => r.sellerId));
        cursor = res.body.nextCursor;
        pages++;
      } while (cursor && pages < 20);
      expect({ filter, got }).toEqual({ filter, got: want });
    }
  });

  it('numbered pages give the same order, the total and the page count', async () => {
    const want = await expected('owed');
    const totalPages = Math.ceil(want.length / 3);
    const got: string[] = [];
    for (let page = 1; page <= totalPages + 1; page++) {
      const res = await list(`filter=owed&limit=3&page=${page}`);
      expect(res.status).toBe(200);
      expect(res.body).toMatchObject({ page, totalPages, total: want.length });
      expect(res.body.nextCursor === null).toBe(page >= totalPages);
      got.push(...res.body.items.map((r: { sellerId: string }) => r.sellerId));
    }
    expect(got).toEqual(want);
  });

  it('rows carry the balances, the open amount owed and the destination status', async () => {
    const [first] = (await list('filter=destination_issue&limit=50')).body.items as { sellerId: string; owed: unknown; destination: { status: string }; negative: boolean; available: { amount: number } }[];
    const owed = await k.svc.core.repo.find('amounts_owed', { seller_id: first!.sellerId, status: 'open' });
    expect(first!.owed).toEqual(owed.length ? { amount: owed.reduce((s, o) => s + o.remaining, 0), currency: 'USD' } : null);
    expect(first!.destination.status).not.toBe('verified');
    expect(first!.negative).toBe(first!.available.amount < 0);
  });

  it('the search lists the seller whose id was searched', async () => {
    const [id] = await expected('held');
    const res = await list(`q=${id}`);
    expect(res.body.items.map((r: { sellerId: string }) => r.sellerId)).toEqual([id]);
    expect(res.body.total).toBe(1);
  });

  it('a cursor that is not one of this list is refused, as an unreadable cursor always was', async () => {
    for (const cursor of ['not-a-cursor', encodeCursor([2]), encodeCursor(['x', 'y']), encodeCursor([{ $date: 'nope' }, newId()])]) {
      const res = await list(`limit=2&cursor=${encodeURIComponent(cursor)}`);
      expect(res.status).toBe(400);
      expect(res.body.error?.code ?? res.body.code).toBe('VALIDATION_FAILED');
    }
  });
});
