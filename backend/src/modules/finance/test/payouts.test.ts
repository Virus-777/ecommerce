/**
 * Payout destinations (micro-deposits, recorded review by someone other than the requester, pause before
 * paying a new account), payout run approval by one or two Finance reviewers, release, failed payouts and
 * their recovery, the status poll, statement files and the scheduled jobs.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { newId } from '../../../kernel/lib/ids.js';
import { callers, signWebhook } from '../../../testing/app.js';
import { nextSlot } from '../domain/rules.js';
import { ADMIN, boot, expectLedgerMatches, SELLER, USD, type Kit } from './helpers.js';

const DAY = 86_400_000;
let k: Kit;
const idem = () => ({ 'idempotency-key': newId() });

async function initialDestination(sellerId: string) {
  const providerDestinationId = `dest_${newId().slice(0, 8)}`;
  await k.emit('sellers.payout_account.changed', { sellerId, changeId: newId(), providerDestinationId, label: 'First Bank •••• 1111', accountHolderName: 'Store LLC', accountType: 'business_checking', previousLabel: null, isInitial: true, requestedBy: { kind: 'seller', id: newId() } });
  const [a, b] = k.provider.testDepositsFor(providerDestinationId);
  const r = await k.call('POST', `${SELLER}/payout-destination/confirm-deposits`, k.sellerToken(sellerId), { amounts: [USD(a), USD(b)] });
  expect(r.status, JSON.stringify(r.body)).toBe(200);
}

async function credit(sellerId: string, amount: number) {
  const r = await k.call('POST', `${ADMIN}/adjustments`, k.staff, { sellerId, direction: 'credit', amount: USD(amount), reasonCode: 'goodwill', reason: 'Balance for the test' }, idem());
  expect(r.status, JSON.stringify(r.body)).toBe(201);
}

async function newRun() {
  k.clock.advance(60_000);
  const res = await k.call('POST', `${ADMIN}/payout-runs`, k.staff, { cutoffAt: k.clock.now().toISOString(), scheduledRelease: new Date(k.clock.now().getTime() + 3_600_000).toISOString() }, idem());
  expect(res.status, JSON.stringify(res.body)).toBe(201);
  return res.body;
}

beforeAll(async () => {
  k = await boot();
});
afterAll(async () => {
  await k?.close();
});
beforeEach(() => {
  k.authority.clear();
  k.countsAsFirst.value = false;
});

describe('payout destinations', () => {
  const S = newId();
  const requester = newId();
  let providerDestinationId: string;
  let reviewId: string;

  it('verifies a first account once the owner confirms the two test deposits', async () => {
    await initialDestination(S);
    expect(k.of('finance.destination.verified').some((e) => e.sellerId === S)).toBe(true);
    expect((await k.svc.hasPayoutBlock(S)).blocked).toBe(false);
  });

  it('opens a review for a change and keeps paying the current verified account', async () => {
    providerDestinationId = `dest_${newId().slice(0, 8)}`;
    await k.emit('sellers.payout_account.changed', { sellerId: S, changeId: newId(), providerDestinationId, label: 'Pacific Coast CU •••• 6620', accountHolderName: 'Store LLC', accountType: 'business_checking', previousLabel: 'First Bank •••• 1111', isInitial: false, requestedBy: { kind: 'staff', id: requester } });
    const d = await k.call('GET', `${SELLER}/payout-destination`, k.sellerToken(S));
    expect(d.body.destination).toMatchObject({ status: 'change_under_review', label: 'First Bank •••• 1111', pendingChange: { label: 'Pacific Coast CU •••• 6620', paysCurrentUntilApproved: true }, depositAttemptsLeft: 3 });
    reviewId = d.body.destination.pendingChange.reviewId;
    expect(d.body.review).toMatchObject({ id: reviewId, status: 'under_review', fromLabel: 'First Bank •••• 1111' });
    expect((await k.svc.hasPayoutBlock(S)).blocked).toBe(false);
    const list = await k.call('GET', `${ADMIN}/destination-reviews?status=under_review`, k.staff);
    expect(list.body.items.map((r: any) => r.id)).toContain(reviewId);
  });

  it('needs the micro-deposits before Finance can verify the change', async () => {
    const res = await k.call('POST', `${ADMIN}/destination-reviews/${reviewId}/approve`, k.staff, { reason: 'Called the owner', callbackConfirmed: true, reauthToken: 'dev-reauth.payout-destination' });
    expect(res.status).toBe(409);
    expect(res.body.error).toMatchObject({ code: 'CHECKS_INCOMPLETE', details: { pending: ['Micro-deposits confirmed'] } });
  });

  it('counts wrong deposit amounts and sends new deposits after the last try', async () => {
    const token = k.sellerToken(S);
    for (const left of [2, 1, 0]) {
      const r = await k.call('POST', `${SELLER}/payout-destination/confirm-deposits`, token, { amounts: [USD(1), USD(2)] });
      expect(r.status).toBe(422);
      expect(r.body.error).toMatchObject({ code: 'DEPOSIT_AMOUNTS_INCORRECT', details: { attemptsLeft: left } });
    }
    const exceeded = await k.call('POST', `${SELLER}/payout-destination/confirm-deposits`, token, { amounts: [USD(1), USD(2)] });
    expect(exceeded.status).toBe(409);
    expect(exceeded.body.error.code).toBe('DEPOSIT_ATTEMPTS_EXCEEDED');
    expect((await k.call('GET', `${SELLER}/payout-destination`, token)).body.destination.depositAttemptsLeft).toBe(3);
    // only the owner confirms deposits
    const member = await k.call('POST', `${SELLER}/payout-destination/confirm-deposits`, k.sellerToken(S, { permissions: ['finance.balances.view'] }), { amounts: [USD(1), USD(2)] });
    expect(member.status).toBe(403);
    // not delegable: a member granted the permission is still refused
    const granted = await k.call('POST', `${SELLER}/payout-destination/confirm-deposits`, k.sellerToken(S, { permissions: ['finance.destinations.confirm'] }), { amounts: [USD(1), USD(2)] });
    expect(granted.status).toBe(403);
    expect(granted.body.error.code).toBe('OWNER_ONLY');
    const [a, b] = k.provider.testDepositsFor(providerDestinationId);
    const ok = await k.call('POST', `${SELLER}/payout-destination/confirm-deposits`, token, { amounts: [USD(b), USD(a)] });
    expect(ok.status).toBe(200);
    expect(ok.body.destination.status).toBe('change_under_review');
    expect(ok.body.review.checks.find((c: any) => c.label === 'Micro-deposits confirmed').result).toBe('passed');
  });

  it('refuses the requester as reviewer, then verifies with a pause before paying the new account', async () => {
    const same = await k.call('POST', `${ADMIN}/destination-reviews/${reviewId}/approve`, callers.staff(undefined, { sub: requester }), { reason: 'Mine', callbackConfirmed: true, reauthToken: 'dev-reauth.payout-destination' });
    expect(same.status).toBe(409);
    expect(same.body.error.code).toBe('SAME_APPROVER');
    // the callback to the phone on file is the third check: not confirmed, the change is not verified
    const noCallback = await k.call('POST', `${ADMIN}/destination-reviews/${reviewId}/approve`, k.staff, { reason: 'Owner did not answer', callbackConfirmed: false, callbackNote: 'Voicemail', reauthToken: 'dev-reauth.payout-destination' });
    expect(noCallback.status, JSON.stringify(noCallback.body)).toBe(200);
    expect(noCallback.body.status).toBe('under_review');
    expect(noCallback.body.checks).toEqual([
      { label: 'Micro-deposits confirmed', result: 'passed' },
      { label: 'Owner re-authenticated', result: 'passed' },
      { label: 'Callback to the registered phone', result: 'failed' },
    ]);
    expect(k.of('finance.destination.verified').filter((e) => e.reviewId === reviewId)).toEqual([]);
    expect((await k.call('GET', `${SELLER}/payout-destination`, k.sellerToken(S))).body.destination).toMatchObject({ status: 'change_under_review', label: 'First Bank •••• 1111' });
    const ok = await k.call('POST', `${ADMIN}/destination-reviews/${reviewId}/approve`, k.staff, { reason: 'Callback to the registered phone done', callbackConfirmed: true, callbackNote: 'Owner confirmed', reauthToken: 'dev-reauth.payout-destination' });
    expect(ok.status, JSON.stringify(ok.body)).toBe(200);
    expect(ok.body.status).toBe('verified');
    expect(ok.body.checks.every((c: any) => c.result === 'passed')).toBe(true);
    expect(ok.body.pauseUntil).toBeTruthy();
    expect(k.of('finance.destination.verified').filter((e) => e.sellerId === S).at(-1)).toEqual({ sellerId: S, reviewId });
    const d = await k.call('GET', `${SELLER}/payout-destination`, k.sellerToken(S));
    expect(d.body.destination).toMatchObject({ status: 'verified', label: 'Pacific Coast CU •••• 6620' });
    const block = await k.svc.hasPayoutBlock(S);
    expect(block.blocked).toBe(true);
    expect(block.reasons[0]).toContain('New payout account');
    expect((await k.call('POST', `${ADMIN}/destination-reviews/${reviewId}/approve`, k.staff, { reason: 'again', callbackConfirmed: true, reauthToken: 'dev-reauth.payout-destination' })).status).toBe(409);
  });

  it('rejects a change: the current account keeps being paid', async () => {
    await k.emit('sellers.payout_account.changed', { sellerId: S, changeId: newId(), providerDestinationId: 'dest_x', label: 'Shady Bank •••• 0001', accountHolderName: 'Someone else', accountType: 'checking', previousLabel: 'Pacific Coast CU •••• 6620', isInitial: false, requestedBy: { kind: 'seller', id: newId() } });
    const id = (await k.call('GET', `${SELLER}/payout-destination`, k.sellerToken(S))).body.destination.pendingChange.reviewId;
    const res = await k.call('POST', `${ADMIN}/destination-reviews/${id}/reject`, k.staff, { reason: 'Account holder name does not match', reauthToken: 'dev-reauth.payout-destination' });
    expect(res.body.status).toBe('rejected');
    expect(k.of('finance.destination.rejected').at(-1)).toEqual({ sellerId: S, reviewId: id, reason: 'Account holder name does not match' });
    expect((await k.call('GET', `${SELLER}/payout-destination`, k.sellerToken(S))).body.destination).toMatchObject({ status: 'verified', label: 'Pacific Coast CU •••• 6620' });
  });

  it('holds the payout to a new account during the pause and leaves the money in the balance', async () => {
    await credit(S, 9_000);
    const run = await newRun();
    const rows = await k.call('GET', `${ADMIN}/payout-runs/${run.id}/payouts`, k.staff);
    const row = rows.body.items.find((r: any) => r.sellerId === S);
    expect(row).toMatchObject({ status: 'on_hold', payout: USD(9_000) });
    expect(run.heldCount).toBeGreaterThanOrEqual(1);
    await k.call('POST', `${ADMIN}/payout-runs/${run.id}/submit`, k.staff);
    await k.call('POST', `${ADMIN}/payout-runs/${run.id}/approve`, k.staff, { confirmedReview: true }, idem());
    await k.call('POST', `${ADMIN}/payout-runs/${run.id}/release`, k.staff, undefined, idem());
    expect((await k.svc.core.repo.get('payouts', row.payoutId))?.status).toBe('cancelled');
    expect((await expectLedgerMatches(k, S)).available).toBe(9_000);
    k.clock.advance(4 * DAY);
    expect((await k.svc.hasPayoutBlock(S)).blocked).toBe(false);
  });
});

describe('payout run approval', () => {
  const S = newId();
  let run: any;

  beforeAll(async () => {
    await initialDestination(S);
  });

  it('a Finance approver within the limit approves alone', async () => {
    await credit(S, 12_345);
    run = await newRun();
    expect((await k.call('POST', `${ADMIN}/payout-runs/${run.id}/approve`, k.staff, { confirmedReview: true }, idem())).status).toBe(409); // still a draft
    expect((await k.call('POST', `${ADMIN}/payout-runs/${run.id}/submit`, k.staff)).body).toMatchObject({ status: 'pending_approval', viewerCanApprove: true });
    const noConfirm = await k.call('POST', `${ADMIN}/payout-runs/${run.id}/approve`, k.staff, { confirmedReview: false }, idem());
    expect(noConfirm.status).toBe(400);
    const sent = await k.call('POST', `${ADMIN}/payout-runs/${run.id}/send-back`, k.staff, { reason: 'Recheck the held sellers' });
    expect(sent.body.status).toBe('draft');
    expect(sent.body.approvals.every((a: any) => a.status === 'sent_back')).toBe(true);
    expect((await k.call('POST', `${ADMIN}/payout-runs/${run.id}/recalculate`, k.staff)).body.status).toBe('draft');
    await k.call('POST', `${ADMIN}/payout-runs/${run.id}/submit`, k.staff);
    const ok = await k.call('POST', `${ADMIN}/payout-runs/${run.id}/approve`, k.staff, { confirmedReview: true }, idem());
    expect(ok.body.status).toBe('approved');
  });

  it('denies staff without payout authority (access is not financial authority)', async () => {
    await credit(S, 5_000);
    const r = await newRun();
    await k.call('POST', `${ADMIN}/payout-runs/${r.id}/submit`, k.staff);
    k.authority.set('finance.payouts.release', 'denied');
    const res = await k.call('POST', `${ADMIN}/payout-runs/${r.id}/approve`, k.staff, { confirmedReview: true }, idem());
    expect(res.status).toBe(403);
    expect((await k.call('GET', `${ADMIN}/payout-runs/${r.id}`, k.staff)).body.viewerCanApprove).toBe(false);
    k.authority.clear();
    await k.call('POST', `${ADMIN}/payout-runs/${r.id}/send-back`, k.staff, { reason: 'Later' });
  });

  it("within the approver's own limit but above stepUpAbove: the password again (reauthToken, purpose approval)", async () => {
    await credit(S, 2_000_000);
    const r = await newRun();
    await k.call('POST', `${ADMIN}/payout-runs/${r.id}/submit`, k.staff);
    k.stepUp.value = true;
    try {
      const missing = await k.call('POST', `${ADMIN}/payout-runs/${r.id}/approve`, k.staff, { confirmedReview: true }, idem());
      expect(missing.status).toBe(403);
      expect(missing.body.error).toMatchObject({ code: 'STEP_UP_REQUIRED', details: { kind: 'reauth', purpose: 'approval' } });
      const wrongPurpose = await k.call('POST', `${ADMIN}/payout-runs/${r.id}/approve`, k.staff, { confirmedReview: true, reauthToken: 'dev-reauth.payout-destination' }, idem());
      expect(wrongPurpose.body.error.code).toBe('STEP_UP_REQUIRED');
      // nothing recorded without it
      expect((await k.call('GET', `${ADMIN}/payout-runs/${r.id}`, k.staff)).body).toMatchObject({ status: 'pending_approval', approvals: [{ status: 'pending' }] });
      const ok = await k.call('POST', `${ADMIN}/payout-runs/${r.id}/approve`, k.staff, { confirmedReview: true, reauthToken: 'dev-reauth.approval' }, idem());
      expect(ok.status, JSON.stringify(ok.body)).toBe(200);
      expect(ok.body.status).toBe('approved');
    } finally {
      k.stepUp.value = false;
    }
  });

  it("a run within the approver's payout limit (access) is approved by one person, whatever its size (no threshold setting)", async () => {
    await credit(S, 6_000_000);
    const big = await newRun();
    expect(big.total).toEqual(USD(6_000_000));
    expect(big.checks.some((c: any) => c.title === 'Second Finance reviewer needed')).toBe(false);
    await k.call('POST', `${ADMIN}/payout-runs/${big.id}/submit`, k.staff);
    const ok = await k.call('POST', `${ADMIN}/payout-runs/${big.id}/approve`, k.staff, { confirmedReview: true }, idem());
    expect(ok.status, JSON.stringify(ok.body)).toBe(200);
    expect(ok.body.status).toBe('approved');
    expect(ok.body.approvals.map((a: any) => a.status)).toEqual(['approved']);
  });

  it("above the first approver's payout limit needs a second, different Finance approver (through access)", async () => {
    await credit(S, 6_000_000);
    const big = await newRun();
    await k.call('POST', `${ADMIN}/payout-runs/${big.id}/submit`, k.staff);
    k.authority.set('finance.payouts.release', 'approval_required');
    k.countsAsFirst.value = true;
    const firstId = newId();
    const first = await k.call('POST', `${ADMIN}/payout-runs/${big.id}/approve`, callers.staff(undefined, { sub: firstId }), { confirmedReview: true, note: 'Reviewed held rows' }, idem());
    expect(first.status, JSON.stringify(first.body)).toBe(200);
    expect(first.body.status).toBe('pending_approval');
    expect(first.body.approvals.map((a: any) => a.status)).toEqual(['approved', 'pending']);
    expect(first.body.checks.some((c: any) => c.title === 'Second Finance reviewer needed')).toBe(true);
    expect(first.body.viewerCanApprove).toBe(false);
    const again = await k.call('POST', `${ADMIN}/payout-runs/${big.id}/approve`, callers.staff(undefined, { sub: firstId }), { confirmedReview: true }, idem());
    expect(again.status).toBe(409);
    expect(again.body.error.code).toBe('SAME_APPROVER');
    const second = await k.call('POST', `${ADMIN}/payout-runs/${big.id}/approve`, k.staff, { confirmedReview: true, reauthToken: 'dev-reauth.approval' }, idem());
    expect(second.status, JSON.stringify(second.body)).toBe(200);
    expect(second.body.status).toBe('approved');
    expect(second.body.approvals.map((a: any) => a.status)).toEqual(['approved', 'approved']);
    expect(k.of('finance.payout_run.approved').some((e) => e.runId === big.id)).toBe(true);
  });

  it('above the caller limit the run waits for approval and finishes on access.approval.decided', async () => {
    await credit(S, 3_000);
    const r = await newRun();
    await k.call('POST', `${ADMIN}/payout-runs/${r.id}/submit`, k.staff);
    k.authority.set('finance.payouts.release', 'approval_required');
    k.countsAsFirst.value = false;
    const res = await k.call('POST', `${ADMIN}/payout-runs/${r.id}/approve`, k.staff, { confirmedReview: true }, idem());
    // the run waits for approval: normal status with the approval in the body (FORMAT.md, Approval responses)
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    expect(res.body).toMatchObject({ status: 'pending_approval', approval: { approvalRequestId: expect.any(String) } });
    await k.decide(res.body.approval.approvalRequestId, 'approved');
    expect((await k.call('GET', `${ADMIN}/payout-runs/${r.id}`, k.staff)).body.status).toBe('approved');
    const runs = await k.call('GET', `${ADMIN}/payout-runs?status=approved`, k.staff);
    expect(runs.body.items.map((x: any) => x.id)).toContain(r.id);
  });
});

describe('failed payouts and recovery', () => {
  const S = newId();
  let failedId: string;

  beforeAll(async () => {
    await initialDestination(S);
  });

  it('a payout the bank rejects returns its money to the available balance', async () => {
    await credit(S, 7_702); // the dev provider fails amounts ending in 02
    const run = await newRun();
    await k.call('POST', `${ADMIN}/payout-runs/${run.id}/submit`, k.staff);
    await k.call('POST', `${ADMIN}/payout-runs/${run.id}/approve`, k.staff, { confirmedReview: true }, idem());
    await k.call('POST', `${ADMIN}/payout-runs/${run.id}/release`, k.staff, undefined, idem());
    expect((await expectLedgerMatches(k, S)).available).toBe(0);
    k.clock.advance(31 * 60_000);
    await k.app.kernel.jobs.runNow('finance.payout-status.poll');
    await k.app.kernel.events.drain();
    const p = (await k.svc.core.repo.find('payouts', { seller_id: S }))[0]!;
    failedId = p.id;
    expect(p).toMatchObject({ status: 'failed', failure_code: 'R02' });
    expect(k.of('finance.payout.failed').at(-1)).toMatchObject({ payoutId: p.id, sellerId: S, failureCode: 'R02' });
    expect((await expectLedgerMatches(k, S)).available).toBe(7_702);
    const listed = await k.call('GET', `${ADMIN}/payouts?status=failed&sellerId=${S}`, k.staff);
    expect(listed.body.items[0]).toMatchObject({ id: p.id, status: 'failed', failureReason: 'Account closed' });
    const seller = await k.call('GET', `${SELLER}/payouts`, k.sellerToken(S));
    expect(seller.body.items[0].resultNote).toContain('Funds kept safe');
    expect((await k.call('GET', `${ADMIN}/payout-runs/${run.id}`, k.staff)).body.status).toBe('completed');
  });

  it('retries a failed payout now to the verified destination, once', async () => {
    const res = await k.call('POST', `${ADMIN}/payouts/${failedId}/retry`, k.staff, { now: true, reason: 'Seller confirmed the account' }, idem());
    expect(res.status, JSON.stringify(res.body)).toBe(201);
    expect(res.body).toMatchObject({ status: 'processing', retryOf: failedId, amount: USD(7_702) });
    const twice = await k.call('POST', `${ADMIN}/payouts/${failedId}/retry`, k.staff, { now: true, reason: 'again' }, idem());
    expect(twice.status).toBe(409);
    expect(twice.body.error.code).toBe('PAYOUT_NOT_RETRYABLE');
    expect((await expectLedgerMatches(k, S)).available).toBe(0);
  });

  it('a paid payout the bank returns later is failed again and the money is back', async () => {
    const retry = (await k.svc.core.repo.findOne('payouts', { retry_of: failedId }))!;
    const send = async (event: string, extra: object = {}) => {
      const raw = JSON.stringify({ providerPayoutId: retry.provider_payout_id, event, at: k.clock.now().toISOString(), ...extra });
      const res = await k.app.inject({ method: 'POST', url: '/webhooks/finance/payouts', headers: { 'content-type': 'application/json', 'x-event-id': newId(), ...signWebhook('dev-webhook-secret', raw, Math.floor(k.clock.now().getTime() / 1000)) }, payload: raw });
      await k.app.kernel.events.drain();
      return res.statusCode;
    };
    expect(await send('paid', { bankReference: 'ACH123' })).toBe(204);
    expect((await k.svc.core.repo.get('payouts', retry.id))?.status).toBe('paid');
    expect(await send('returned', { failureCode: 'R03', failureReason: 'No account' })).toBe(204);
    expect((await k.svc.core.repo.get('payouts', retry.id))).toMatchObject({ status: 'failed', failure_code: 'R03' });
    expect((await expectLedgerMatches(k, S)).available).toBe(7_702);
  });

  it('refuses a retry while the destination is not verified', async () => {
    const retry = (await k.svc.core.repo.findOne('payouts', { retry_of: failedId }))!;
    await k.emit('sellers.payout_account.changed', { sellerId: S, changeId: newId(), providerDestinationId: 'dest_new', label: 'New Bank •••• 2222', accountHolderName: 'Store LLC', accountType: 'checking', previousLabel: 'First Bank •••• 1111', isInitial: false, requestedBy: { kind: 'seller', id: newId() } });
    const [a, b] = k.provider.testDepositsFor('dest_new');
    await k.call('POST', `${SELLER}/payout-destination/confirm-deposits`, k.sellerToken(S), { amounts: [USD(a), USD(b)] });
    const reviewId = (await k.call('GET', `${SELLER}/payout-destination`, k.sellerToken(S))).body.destination.pendingChange.reviewId;
    const approved = await k.call('POST', `${ADMIN}/destination-reviews/${reviewId}/approve`, k.staff, { reason: 'ok', callbackConfirmed: true, reauthToken: 'dev-reauth.payout-destination' });
    expect(approved.body.status).toBe('verified');
    const res = await k.call('POST', `${ADMIN}/payouts/${retry.id}/retry`, k.staff, { now: false, reason: 'Retry to the new account' }, idem());
    expect(res.status).toBe(409);
    expect(res.body.error.code).toBe('DESTINATION_NOT_VERIFIED');
  });
});

describe('statements and scheduled jobs', () => {
  const S = newId();

  it('downloads an issued statement as PDF or CSV; the open period is not ready', async () => {
    await initialDestination(S);
    await credit(S, 4_000);
    // reading never creates a statement: the open one exists from the seller's approval (or the job's sweep)
    const before = await k.call('GET', `${SELLER}/statements`, k.sellerToken(S));
    expect(before.body.items.filter((s: any) => s.status === 'open')).toEqual([]);
    expect(await k.svc.core.repo.findOne('statements', { seller_id: S, status: 'open' })).toBeUndefined();
    await k.emit('sellers.seller.approved', { sellerId: S, applicationId: newId(), storeName: 'Store', ownerAccountId: newId(), categoryIds: [], returnAddress: { name: 'Store', line1: '1 Main St', city: 'Portland', region: 'OR', postalCode: '97204', country: 'US' }, returnContact: 'Ana', recommendedHoldDays: 0 });
    const list = await k.call('GET', `${SELLER}/statements`, k.sellerToken(S));
    const open = list.body.items.find((s: any) => s.status === 'open');
    expect(open).toBeTruthy();
    const notReady = await k.call('GET', `${SELLER}/statements/${open.id}/download?format=pdf`, k.sellerToken(S));
    expect(notReady.status).toBe(409);
    expect(notReady.body.error.code).toBe('STATEMENT_NOT_READY');
    const openView = await k.call('GET', `${SELLER}/statements/${open.id}`, k.sellerToken(S));
    expect(openView.body).toMatchObject({ status: 'open', reconciliation: { closingAvailable: USD(4_000) } });
    await newRun();
    const issued = (await k.call('GET', `${SELLER}/statements`, k.sellerToken(S))).body.items.find((s: any) => s.status === 'issued');
    expect(issued.id).toBe(open.id); // the open statement is the one issued at the cutoff
    // and the next period's statement opens at issue
    expect(await k.svc.core.repo.findOne('statements', { seller_id: S, status: 'open' })).toMatchObject({ seller_id: S });
    for (const format of ['pdf', 'csv']) {
      const file = await k.call('GET', `${SELLER}/statements/${issued.id}/download?format=${format}`, k.sellerToken(S));
      expect(file.status, JSON.stringify(file.body)).toBe(200);
      expect(file.body.url).toBeTruthy();
    }
    expect((await k.call('GET', `${SELLER}/statements/${issued.id}/download?format=pdf`, k.sellerToken(newId()))).status).toBe(404);
    const admin = await k.call('GET', `${ADMIN}/statements/${issued.id}`, k.staff);
    expect(admin.body.ref).toMatch(/^ST-\d{4}-/);
    expect((await k.svc.getStatement(admin.body.ref))?.id).toBe(issued.id);
    expect(await k.svc.getStatementForSeller(newId(), admin.body.ref)).toBeNull();
  });

  it('creates the run at the scheduled cutoff and releases approved runs at their time', async () => {
    const S2 = newId();
    await initialDestination(S2);
    await credit(S2, 8_000);
    k.clock.advance(8 * DAY);
    await k.app.kernel.jobs.runNow('finance.payout-run.create');
    await k.app.kernel.jobs.runNow('finance.payout-run.create');
    expect(await k.svc.getNextPayoutRun()).toBeTruthy();
    const latest = (await k.svc.core.repo.findOne('payout_runs', {}, { orderBy: [['created_at', 'desc']] }))!;
    const next = await k.svc.getPayoutRun(latest.ref);
    expect(next?.sellers.items.map((r) => r.sellerId)).toContain(S2);
    expect(await k.svc.core.repo.count('payout_runs', { cutoff_at: new Date(next!.cutoffAt) })).toBe(1);
    await k.call('POST', `${ADMIN}/payout-runs/${next!.id}/submit`, k.staff);
    await k.call('POST', `${ADMIN}/payout-runs/${next!.id}/approve`, k.staff, { confirmedReview: true }, idem());
    k.clock.set(new Date(Date.parse(next!.scheduledRelease) + 60_000));
    await k.app.kernel.jobs.runNow('finance.payout-run.release');
    await k.app.kernel.events.drain();
    expect((await k.svc.core.repo.get('payout_runs', next!.id))?.status).toMatch(/releasing|completed/);
    expect(k.of('finance.payout_run.released').some((e) => e.runId === next!.id)).toBe(true);
    k.clock.advance(5 * 60_000);
    await k.app.kernel.jobs.runNow('finance.payout-status.poll');
    expect((await k.svc.core.repo.find('payouts', { seller_id: S2 }))[0]?.status).toBe('paid');
  });
});

describe('finance.payout-run.create (every 15 min, checks its own cutoff)', () => {
  it('creates exactly one run per cutoff: none before it, one however often the job runs after it, none again after a cancellation, one when two runs race', async () => {
    const tz = k.svc.core.tz();
    const schedule = String(await k.svc.core.setting('payoutSchedule'));
    const releaseTime = String(await k.svc.core.setting('payoutReleaseTime'));
    const runsFor = (cutoff: Date) => k.svc.core.repo.count('payout_runs', { cutoff_at: cutoff });
    const job = () => k.app.kernel.jobs.runNow('finance.payout-run.create');

    const next = nextSlot(k.clock.now(), schedule, releaseTime, tz);
    k.clock.set(new Date(next.cutoffAt.getTime() - 45 * 60_000));
    for (let i = 0; i < 3; i++) {
      await job();
      k.clock.advance(15 * 60_000 - 1_000);
    }
    expect(k.clock.now().getTime()).toBeLessThan(next.cutoffAt.getTime());
    expect(await runsFor(next.cutoffAt)).toBe(0);

    k.clock.set(new Date(next.cutoffAt.getTime() + 60_000));
    for (let i = 0; i < 4; i++) {
      await job();
      k.clock.advance(15 * 60_000);
    }
    expect(await runsFor(next.cutoffAt)).toBe(1);
    const run = (await k.svc.core.repo.findOne('payout_runs', { cutoff_at: next.cutoffAt }))!;
    expect(run).toMatchObject({ status: 'draft', scheduled_release: next.releaseAt });

    // staff cancelled the run: the job is done with that cutoff
    await k.svc.core.repo.update('payout_runs', run.id, { status: 'cancelled' });
    await job();
    expect(await runsFor(next.cutoffAt)).toBe(1);

    // the following cutoff, with two job runs at once (two instances): still one run
    const following = nextSlot(k.clock.now(), schedule, releaseTime, tz);
    expect(following.cutoffAt.getTime()).toBeGreaterThan(next.cutoffAt.getTime());
    k.clock.set(new Date(following.cutoffAt.getTime() + 60_000));
    await Promise.all([job(), job()]);
    await job();
    expect(await runsFor(following.cutoffAt)).toBe(1);
  });
});
