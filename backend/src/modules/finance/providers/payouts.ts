/**
 * Deterministic development payout provider: no network. Behaviour follows the payout amount and the
 * destination id so tests can steer it:
 *   - amounts ending in 02 cents fail (R02 account closed), ending in 03 stay processing (no result yet);
 *     every other payout is paid when the status is asked for;
 *   - the two test deposits of a destination are derived from its provider id (testDepositsFor);
 *   - settlement reports answer what setDeposit stored for a day, else null (report not available).
 */
import { createHash } from 'node:crypto';
import type * as common from '../../../spec/common.js';
import type { PayoutProvider, ProviderResult } from '../ports.js';

export interface DevPayoutProvider extends PayoutProvider {
  /** The two micro-deposit amounts (minor units) the dev provider sends to a destination */
  testDepositsFor(providerDestinationId: string): [number, number];
  /** Sets the provider deposit total of a market day (settlement report) */
  setDeposit(date: string, amount: common.Money | null): void;
  /** Payouts sent so far, by provider payout id */
  readonly sent: Map<string, { payoutId: string; amount: common.Money; providerDestinationId: string | null }>;
}

export function createDevPayoutProvider(clock: { now(): Date }): DevPayoutProvider {
  const sent = new Map<string, { payoutId: string; amount: common.Money; providerDestinationId: string | null }>();
  const deposits = new Map<string, common.Money | null>();
  const testDepositsFor = (id: string): [number, number] => {
    const h = createHash('sha256').update(`deposits:${id}`).digest();
    return [1 + (h[0]! % 98), 1 + (h[1]! % 98)];
  };
  return {
    sent,
    testDepositsFor,
    setDeposit(date, amount) {
      deposits.set(date, amount);
    },
    async send(input) {
      const providerPayoutId = `devpo_${input.payoutId.replace(/-/g, '')}`;
      if (!sent.has(providerPayoutId)) sent.set(providerPayoutId, { payoutId: input.payoutId, amount: input.amount, providerDestinationId: input.providerDestinationId });
      return { providerPayoutId };
    },
    async status(providerPayoutId): Promise<ProviderResult> {
      const p = sent.get(providerPayoutId);
      if (!p) return { status: 'processing' };
      const cents = Math.abs(p.amount.amount) % 100;
      if (cents === 2) return { status: 'failed', at: clock.now(), failureCode: 'R02', failureReason: 'Account closed' };
      if (cents === 3) return { status: 'processing' };
      return { status: 'paid', at: clock.now(), bankReference: `DEV${providerPayoutId.slice(-10).toUpperCase()}` };
    },
    async sendTestDeposits() {
      return { sentAt: clock.now() };
    },
    async checkTestDeposits(providerDestinationId, amounts) {
      const want = testDepositsFor(providerDestinationId).slice().sort((a, b) => a - b);
      const got = amounts.slice().sort((a, b) => a - b);
      return got.length === 2 && got[0] === want[0] && got[1] === want[1];
    },
    async settlementReport(date) {
      return deposits.get(date) ?? null;
    },
  };
}
