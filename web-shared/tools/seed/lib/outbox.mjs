// Development routes of the backend (served only while DEV_TOKENS is on; any valid token):
//   GET /api/dev/notifications/outbox?to&channel&since&limit   what the dev email/SMS/push providers "sent" (R1)
//   GET /api/dev/finance/test-deposits?sellerId=                the payout test deposits waiting for confirmation (G11)
// The seed reads emailed codes and test deposits there. Only when a route answers 404 (an older backend without
// it) does it fall back to computing the value (lib/codes.mjs).
import { ApiError, poll } from './http.mjs';

/** True when the error is a 404 (route missing on an older backend, or nothing to show) */
export const isNotFound = (err) => err instanceof ApiError && err.status === 404;

/**
 * The newest outbox item sent to `to` since `since` that matches `pick(item)`, waiting up to `timeoutMs` for it
 * (notifications deliver from a job). Returns the item, or null when the outbox has none in time.
 * Throws the 404 ApiError when the backend has no outbox route.
 */
export async function outboxItem(ctx, { to, since, pick = () => true, timeoutMs = 60_000 }) {
  const qs = new URLSearchParams({ to, channel: 'email', limit: '50', ...(since ? { since: new Date(since).toISOString() } : {}) });
  const read = async () => {
    const r = await ctx.api.get(`/api/dev/notifications/outbox?${qs}`, ctx.staff);
    return (r.items ?? []).find(pick) ?? null;
  };
  // the first read surfaces a missing route (404) to the caller; later reads wait for the delivery job
  const first = await read();
  if (first) return first;
  return poll(`an email to ${to} in the dev outbox`, read, { timeoutMs, intervalMs: 2000, quiet: true });
}

/**
 * The code of the seller invitation email to `email` (topic seller.application.invitation, data.invite.code).
 * Returns null when the outbox has no such email (the backend restarted since it was sent: the outbox lives in
 * memory) and the 404 ApiError when the route is missing.
 */
export async function invitationCodeFromOutbox(ctx, email, since, timeoutMs = 60_000) {
  const item = await outboxItem(ctx, { to: email, since, timeoutMs, pick: (i) => i.topic === 'seller.application.invitation' && i.data?.invite?.code });
  return item?.data?.invite?.code ?? null;
}

/**
 * The two test-deposit amounts (Money[]) of the seller's payout account waiting for confirmation. Throws the
 * 404 ApiError when the route is missing or nothing waits for confirmation.
 */
export async function testDepositsFromDev(ctx, sellerId) {
  const r = await ctx.api.get(`/api/dev/finance/test-deposits?sellerId=${encodeURIComponent(sellerId)}`, ctx.staff);
  return r.amounts;
}
