/**
 * Goodwill credit remedies through wallet: a grant waiting for approval keeps the remedy pending;
 * wallet.goodwill.decided marks it granted (completed) or rejected (cancelled) and puts the case back in its
 * owner's queue, once per grant (inbox).
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { newId } from '../../../kernel/lib/ids.js';
import { harness, idem, reportProblem, sellerOrder, tokens, USD, type Harness } from './helpers.js';

let h: Harness;
beforeAll(async () => {
  h = await harness({ wallet: true });
});
afterAll(async () => {
  await h?.app.close();
});

async function goodwillCase(amount: number) {
  const order = await sellerOrder(h, { price: 4900 });
  const opened = await reportProblem(h, { customerId: order.customerId, orderId: order.order.id, itemIds: [order.itemId] });
  expect(opened.status, JSON.stringify(opened.body)).toBe(201);
  const caseId = opened.body.id as string;
  expect((await h.call('POST', `/api/admin/support/cases/${caseId}/escalate`, tokens.staff(), { to: 'support_lead', reason: 'Late delivery', convertToDispute: true })).status).toBe(200);
  const decided = await h.call('POST', `/api/admin/support/cases/${caseId}/decide`, tokens.staff(), { outcome: 'customer_favored', remedies: [{ kind: 'goodwill_credit', amount: USD(amount) }], reason: 'Sorry for the delay', notifyParties: true }, idem());
  expect(decided.status, JSON.stringify(decided.body)).toBe(200);
  expect(decided.body.case.remedies[0]).toMatchObject({ kind: 'goodwill_credit', status: 'pending_approval' });
  const grant = h.calls.goodwill.at(-1)!;
  expect(grant).toMatchObject({ customerId: order.customerId, amount: USD(amount), state: 'pending_approval' });
  return { ...order, caseId, grant };
}

const decided = (g: Harness['calls']['goodwill'][number], caseId: string | null, status: 'granted' | 'rejected') => ({ grantId: g.id, customerId: g.customerId, status, amount: g.amount, caseId });

const caseRow = (id: string) => h.service.core.repo.get('cases', id);

describe('wallet.goodwill.decided', () => {
  it('granted: the remedy completes and the case goes back to the owner; a redelivery changes nothing', async () => {
    const x = await goodwillCase(1500);
    const before = h.clock.now().getTime();
    await h.publish('wallet', 'wallet.goodwill.decided', decided(x.grant, x.caseId, 'granted'));
    let detail = await h.call('GET', `/api/admin/support/cases/${x.caseId}`, tokens.staff());
    expect(detail.body.case.remedies[0]).toMatchObject({ kind: 'goodwill_credit', status: 'completed' });
    expect(detail.body.history.filter((e: { label: string }) => e.label === 'Goodwill credit added')).toHaveLength(1);
    const row = (await caseRow(x.caseId))!;
    expect(row.waiting_on).toBe('marketplace');
    expect(row.next_response_due_at!.getTime()).toBeGreaterThanOrEqual(before - 1000);
    expect(row.next_response_due_at!.getTime()).toBeLessThanOrEqual(h.clock.now().getTime());

    await h.publish('wallet', 'wallet.goodwill.decided', decided(x.grant, x.caseId, 'granted'));
    detail = await h.call('GET', `/api/admin/support/cases/${x.caseId}`, tokens.staff());
    expect(detail.body.history.filter((e: { label: string }) => e.label === 'Goodwill credit added')).toHaveLength(1);
    // the remedy is done: the case can be resolved
    expect((await h.call('POST', `/api/admin/support/cases/${x.caseId}/resolve`, tokens.staff(), { summary: 'Credit added' })).status).toBe(200);
  });

  it('rejected: the remedy is cancelled and the owner picks another remedy', async () => {
    const x = await goodwillCase(2500);
    await h.publish('wallet', 'wallet.goodwill.decided', decided(x.grant, x.caseId, 'rejected'));
    const detail = await h.call('GET', `/api/admin/support/cases/${x.caseId}`, tokens.staff());
    expect(detail.body.case.remedies[0]).toMatchObject({ kind: 'goodwill_credit', status: 'cancelled' });
    expect(detail.body.history.some((e: { label: string }) => e.label === 'Goodwill credit not approved')).toBe(true);
    expect((await caseRow(x.caseId))!.waiting_on).toBe('marketplace');
    // the customer does not see the internal rejection note
    const store = await h.call('GET', `/api/store/support/cases/${x.caseId}`, tokens.customer(x.customerId));
    expect(JSON.stringify(store.body)).not.toContain('Goodwill credit not approved');
  });

  it('ignores grants without a case and unknown cases', async () => {
    const grant = { ...h.calls.goodwill[0]!, id: newId() };
    await h.publish('wallet', 'wallet.goodwill.decided', decided(grant, null, 'granted'));
    await h.publish('wallet', 'wallet.goodwill.decided', decided(grant, newId(), 'granted'));
    expect(h.calls.goodwill.length).toBeGreaterThan(0);
  });
});
