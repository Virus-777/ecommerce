/**
 * Flow 7, money:
 *   - payments captured what each order charged (less what was cancelled), seen in the Admin Center;
 *   - refunds: the payments job submits them, then the card processor (this simulator) reports each one with a
 *     signed webhook, as it reports captures;
 *   - finance: sellers see their ledger and balances; the release job moves delivered earnings on; a Finance
 *     Manager prepares, submits, approves and releases a payout run.
 */
import { devWebhook } from '../../../src/modules/payments/providers/card-processor.js';
import type { Sim } from '../sim.js';

const PROCESSOR_HOOK = '/webhooks/payments/providers/card-processor/events';

export async function paymentsFlow(sim: Sim): Promise<void> {
  const { api, run, world: w } = sim;
  const fin = w.staff.finance!.session;
  await sim.job('payments.process-refunds');
  for (const o of w.orders) {
    const sum = await api.call(fin, 'GET', `/api/admin/payments/orders/${o.orderId}/summary`);
    run.check(`${o.ref}: payment captured`, sum.captured.amount > 0, sum);
    const payment = (sum.attempts as { id: string; status: string }[]).find((a) => a.status !== 'failed') ?? sum.attempts[0];
    if (!payment) continue;
    // the processor's own notice of the capture (payments only re-reads the payment; a replay changes nothing)
    const detail = await api.call(fin, 'GET', `/api/admin/payments/payments/${payment.id}`);
    const evt = devWebhook('payment.captured', { intentId: detail.id, paymentRef: detail.providerRef });
    await api.webhook(PROCESSOR_HOOK, evt, sim.webhookSecret('card-processor'), evt.id);
  }
  // refunds: each one the processor reports as succeeded
  const refunds = await api.call(fin, 'GET', '/api/admin/payments/refunds?limit=100');
  const ours = (refunds.items as { id: string; orderId: string; status: string; providerRef: string | null; ref: string }[]).filter((r) => w.orders.some((o) => o.orderId === r.orderId));
  run.check('the cancellation and the return were refunded', ours.length >= [w.orders.some((o) => o.cancelled), w.orders.some((o) => o.returned)].filter(Boolean).length, ours);
  for (const r of ours) {
    const evt = devWebhook('refund.succeeded', { refundId: r.id, refundRef: r.providerRef, paymentRef: null });
    await api.webhook(PROCESSOR_HOOK, evt, sim.webhookSecret('card-processor'), evt.id);
    const after = await api.call(fin, 'GET', `/api/admin/payments/refunds/${r.id}`);
    run.check(`${r.ref}: sent`, after.status === 'sent', { status: after.status, failure: after.failureReason });
  }
}

export async function financeFlow(sim: Sim): Promise<void> {
  const { api, run, world: w, people } = sim;
  const fin = w.staff.finance!;
  // earnings of delivered items move from pending once their hold window passes (a scheduled job)
  await sim.job('finance.release-pending');
  for (const s of w.sellers) {
    const balances = await api.call(s.session, 'GET', '/api/seller/finance/balances');
    w.balances.set(s.sellerId, { pending: balances.pending.amount, available: balances.available.amount, held: balances.held.amount });
    const ledger = await api.call(s.session, 'GET', '/api/seller/finance/ledger?limit=100');
    const sold = w.orders.filter((o) => o.groups.some((g) => g.sellerId === s.sellerId) && !o.cancelled);
    for (const o of sold) run.check(`${s.name}: ${o.ref} on the ledger`, JSON.stringify(ledger.items).includes(o.orderId) || JSON.stringify(ledger.items).includes(o.ref), undefined);
    run.check(`${s.name}: sales proceeds`, sold.length === 0 || balances.salesProceeds.amount > 0, balances);
    const admin = await api.call(fin.session, 'GET', `/api/admin/finance/sellers/${s.sellerId}`);
    run.check(`${s.name}: Finance sees the same balance`, JSON.stringify(admin).includes(String(balances.pending.amount)), { seller: balances.pending, admin: admin.balance?.pending ?? admin.balances?.pending });
  }
  const today = new Date().toISOString().slice(0, 10);
  await api.call(fin.session, 'GET', `/api/admin/finance/overview?from=${today.slice(0, 8)}01&to=${today}`);
  await api.call(fin.session, 'GET', `/api/admin/finance/marketplace-income?from=${today.slice(0, 8)}01&to=${today}`);

  // a payout run: prepared and submitted by Finance Staff, approved by the Finance Manager, then released
  const prep = w.staff.financeStaff!.session;
  const run0 = await api.call(prep, 'POST', '/api/admin/finance/payout-runs', { cutoffAt: new Date().toISOString(), scheduledRelease: new Date(Date.now() + 3_600_000).toISOString() });
  await api.call(prep, 'GET', `/api/admin/finance/payout-runs/${run0.id}/payouts`);
  const submitted = await api.call(prep, 'POST', `/api/admin/finance/payout-runs/${run0.id}/submit`);
  run.check('the payout run waits for approval', ['pending_approval', 'approved'].includes(submitted.status), submitted.status);
  if (submitted.status === 'pending_approval') {
    const approved = await api.call(fin.session, 'POST', `/api/admin/finance/payout-runs/${run0.id}/approve`, { confirmedReview: true, note: 'Checked the holds and destinations', stepUpCode: await people.code(fin) });
    run.check('the payout run is approved', ['approved', 'releasing', 'completed'].includes(approved.status), approved.status);
  }
  const released = await api.call(fin.session, 'POST', `/api/admin/finance/payout-runs/${run0.id}/release`);
  run.check('the payout run is released', ['releasing', 'completed'].includes(released.status), released.status);
  await sim.job('finance.payout-status.poll');
  const done = await api.call(fin.session, 'GET', `/api/admin/finance/payout-runs/${run0.id}`);
  run.check('the payout run finished', ['releasing', 'completed'].includes(done.status), done.status);
}
