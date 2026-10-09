/**
 * Development card processor: deterministic, in memory, no network. Development and tests use it behind the
 * PaymentProvider port; a real processor adapter (hosted card fields, tokens, webhooks) replaces it later.
 * Card numbers never reach Marketly: the store's card fields (or a wallet sheet) give a single-use token.
 *
 * Single-use card tokens (new card at checkout, refund destinations):
 *   tok_<brand>[_<last4>]       a card that approves: visa (4242), mastercard (4444), amex (0005), discover (1117);
 *                               unionpay is a real card of a brand Marketly does not accept
 *   tok_applepay[_<brand>] · tok_googlepay[_<brand>]   digital wallet tokens (Visa •••• 4242 by default)
 *   tok_declined                bank declines, code 05 (card_declined)
 *   tok_insufficient            code 51 (insufficient_funds)
 *   tok_expired                 code 54 (expired_card)
 *   tok_cvc                     code N7 (incorrect_details)
 *   tok_fraud                   code 59 (fraud_suspected)
 *   tok_3ds                     needs a bank challenge (requires_action); completeAction with 3ds_ok approves,
 *                               any other result token fails authentication (code 1A)
 *   tok_timeout                 the authorization times out but went through: retrieve says authorized
 *   tok_timeout_declined        times out, retrieve says declined (05)
 *   tok_timeout_lost            times out and the processor has no record (retrieve: not_found)
 *   tok_unavailable             the processor cannot be reached; nothing is processed
 *   tok_closed                  approves, but refunds to this card fail: card closed by the issuer (not retryable)
 *   anything else               not a token (PAYMENT_METHOD_INVALID)
 *
 * Amounts (minor units, last two digits) on any approving card, as in BUILDING-MODULES §9:
 *   …02 declined 05 · …03 timeout then authorized · …04 bank challenge · …05 insufficient funds (51)
 *   …06 timeout then declined · …07 timeout then captured (the processor captured automatically)
 *   capture …22 fails · capture …23 times out, then retrieve says succeeded
 *   refund …12 fails, card closed (not retryable) · …13 times out, then retrieve says succeeded
 *   refund …14 fails once with a processing error (retryable), the next attempt succeeds
 *   refund …15 pending at the bank, retrieve says succeeded
 *
 * Saved methods: setup tokens seti_<brand>_<last4>[_<MMYY>] confirm to a saved card pm_…; seti_<brand>_<last4>_renew
 * gets a new expiry from the card updater; seti_unavailable fails with the processor unavailable; any other
 * setup token is invalid. Dispute case ids starting with dp_unavailable make evidence and concession calls fail.
 *
 * Webhooks the processor sends (POST /webhooks/payments/providers/card-processor/events, HMAC signed with
 * X-Signature, X-Timestamp and X-Event-Id; see devWebhook below for the body):
 *   payment.authorized | payment.captured | payment.failed | payment.canceled   data: { paymentRef, intentId }
 *   refund.succeeded | refund.failed                                             data: { refundRef, refundId, paymentRef }
 *   dispute.created   data: { caseId, paymentRef, kind: chargeback|inquiry|wallet_dispute, amount, currency, reasonCode, reason, evidenceDueBy }
 *   dispute.updated   data: { caseId, status: under_review }
 *   dispute.closed    data: { caseId, outcome: won|lost }
 *   method.updated    data: { methodRef, expMonth, expYear, last4? } (card updater)
 * Payment and refund events carry references only: payments retrieves the object, so out-of-order events
 * cannot move a record backwards.
 */
import { randomBytes } from 'node:crypto';
import type * as common from '../../../../spec/common.js';
import { ProviderError, type CardDetails, type DeclineCategory, type PaymentProvider, type ProviderCapture, type ProviderPayment, type ProviderRefund, type RefundDestination } from '../../ports.js';

export const DEV_PROVIDER = 'card-processor';

const LAST4: Record<string, string> = { visa: '4242', mastercard: '4444', amex: '0005', discover: '1117', unionpay: '0005' };
const BRANDS = Object.keys(LAST4);

const DECLINES: Record<string, { code: string; category: DeclineCategory }> = {
  tok_declined: { code: '05', category: 'card_declined' },
  tok_insufficient: { code: '51', category: 'insufficient_funds' },
  tok_expired: { code: '54', category: 'expired_card' },
  tok_cvc: { code: 'N7', category: 'incorrect_details' },
  tok_fraud: { code: '59', category: 'fraud_suspected' },
};

const rand = (n = 12) => randomBytes(n).toString('base64url').replace(/[-_]/g, 'x').slice(0, n);

/** Body of a processor webhook (tests and local tools sign it with signWebhook) */
export function devWebhook(type: string, data: Record<string, unknown>, id = `evt_${rand(16)}`) {
  return { id, type, created: Math.floor(Date.now() / 1000), data };
}

interface DevPayment {
  ref: string;
  key: string;
  token: string;
  card: CardDetails;
  amount: number;
  currency: string;
  status: ProviderPayment['status'];
  decline?: { code: string; category: DeclineCategory } | null;
  captured: number;
}

interface DevRefund {
  ref: string;
  status: ProviderRefund['status'];
  failure?: ProviderRefund['failure'];
}

const nextYear = () => new Date().getUTCFullYear() + 3;

function cardOf(token: string): CardDetails | null {
  const t = token.trim();
  if (!t.startsWith('tok_')) return null;
  if (DECLINES[t] || ['tok_3ds', 'tok_timeout', 'tok_timeout_declined', 'tok_timeout_lost', 'tok_unavailable', 'tok_closed'].includes(t)) {
    return { kind: 'card', brand: 'visa', last4: t === 'tok_closed' ? '0341' : '0002', expMonth: 12, expYear: nextYear() };
  }
  const [, first, second, third] = t.split('_');
  if (first === 'applepay' || first === 'googlepay') {
    const brand = second && BRANDS.includes(second) ? second : 'visa';
    return { kind: 'digital_wallet', brand, last4: LAST4[brand]!, expMonth: 12, expYear: nextYear(), wallet: first === 'applepay' ? 'apple_pay' : 'google_pay' };
  }
  if (!first || !BRANDS.includes(first)) return null;
  const last4 = second && /^\d{4}$/.test(second) ? second : LAST4[first]!;
  void third;
  return { kind: 'card', brand: first, last4, expMonth: 12, expYear: nextYear() };
}

export function createDevCardProcessor(): PaymentProvider {
  const payments = new Map<string, DevPayment>(); // by idempotency key
  const byRef = new Map<string, DevPayment>();
  const captures = new Map<string, ProviderCapture>();
  const refunds = new Map<string, DevRefund>();
  const refundAttempts = new Map<string, number>(); // by refund id
  const methods = new Map<string, { card: CardDetails; renew: boolean; token: string }>();
  const pending3ds = new Map<string, string>(); // payment ref → completion key

  const timeout = (what: string) => new ProviderError(`${what}: the processor did not answer in time`, true);
  const unavailable = (what: string) => new ProviderError(`${what}: the processor is unavailable`, false);
  const view = (p: DevPayment): ProviderPayment => ({
    status: p.status,
    providerRef: p.ref,
    decline: p.decline ?? null,
    nextAction: p.status === 'requires_action' ? { kind: 'three_ds_challenge', url: `https://processor.example/3ds/${p.ref}`, clientSecret: `${p.ref}_secret` } : null,
    authorizedAmount: ['authorized', 'captured'].includes(p.status) ? p.amount : 0,
    capturedAmount: p.captured,
    card: p.card,
  });

  return {
    code: DEV_PROVIDER,
    publishableKey: 'pk_dev_marketly',

    async describeToken(token) {
      if (token.startsWith('pm_')) return methods.get(token)?.card ?? null;
      return cardOf(token);
    },

    async createSetup() {
      return { clientSecret: `seti_${rand(16)}_secret_${rand(8)}`, expiresAt: new Date(Date.now() + 30 * 60_000) };
    },

    async confirmSetup(setupToken) {
      if (setupToken === 'seti_unavailable') throw unavailable('setup');
      const m = /^seti_([a-z]+)_(\d{4})(?:_(\d{4}))?(_renew)?$/.exec(setupToken.trim());
      if (!m || !BRANDS.includes(m[1]!)) return null;
      const expiry = m[3];
      const card: CardDetails = { kind: 'card', brand: m[1]!, last4: m[2]!, expMonth: expiry ? Number(expiry.slice(0, 2)) : 12, expYear: expiry ? 2000 + Number(expiry.slice(2)) : nextYear() };
      const methodId = `pm_${rand(14)}`;
      methods.set(methodId, { card, renew: Boolean(m[4]), token: `tok_${card.brand}_${card.last4}` });
      return { methodId, card };
    },

    async attachToken(token) {
      const card = cardOf(token);
      if (!card) return null;
      const methodId = `pm_${rand(14)}`;
      methods.set(methodId, { card, renew: false, token });
      return { methodId, card };
    },

    async detach(methodId) {
      methods.delete(methodId);
    },

    async cardUpdates(methodIds) {
      return methodIds.flatMap((id) => {
        const m = methods.get(id);
        if (!m?.renew) return [];
        m.renew = false;
        m.card = { ...m.card, expMonth: 12, expYear: nextYear() + 1 };
        return [{ methodId: id, expMonth: m.card.expMonth, expYear: m.card.expYear }];
      });
    },

    async authorize(o) {
      const known = payments.get(o.idempotencyKey);
      if (known) return view(known);
      const token = o.source.methodId ? (methods.get(o.source.methodId)?.token ?? '') : (o.source.token ?? '');
      const card = o.source.methodId ? (methods.get(o.source.methodId)?.card ?? cardOf(token)) : cardOf(token);
      if (token === 'tok_unavailable') throw unavailable('authorize');
      if (!card) return { status: 'declined', decline: { code: '14', category: 'incorrect_details' } };
      const cents = o.amount.amount % 100;
      const p: DevPayment = { ref: `ch_${rand(14)}`, key: o.idempotencyKey, token, card, amount: o.amount.amount, currency: o.amount.currency, status: 'authorized', captured: 0 };
      const decline = DECLINES[token] ?? (cents === 2 ? DECLINES.tok_declined : cents === 5 ? DECLINES.tok_insufficient : undefined);
      if (decline) {
        p.status = 'declined';
        p.decline = decline;
      } else if (token === 'tok_3ds' || cents === 4) {
        p.status = 'requires_action';
        pending3ds.set(p.ref, o.idempotencyKey);
      }
      const uncertain = token === 'tok_timeout' || token === 'tok_timeout_declined' || token === 'tok_timeout_lost' || cents === 3 || cents === 6 || cents === 7;
      if (token === 'tok_timeout_declined' || cents === 6) {
        p.status = 'declined';
        p.decline = DECLINES.tok_declined;
      }
      if (cents === 7 && !decline) {
        p.status = 'captured';
        p.captured = p.amount;
      }
      if (token !== 'tok_timeout_lost') {
        payments.set(o.idempotencyKey, p);
        byRef.set(p.ref, p);
      }
      if (uncertain) throw timeout('authorize');
      return view(p);
    },

    async completeAction(o) {
      const p = byRef.get(o.providerRef);
      if (!p) return { status: 'not_found' };
      if (p.status === 'requires_action') {
        if (o.resultToken === '3ds_ok') p.status = 'authorized';
        else {
          p.status = 'declined';
          p.decline = { code: '1A', category: 'authentication_failed' };
        }
      }
      return view(p);
    },

    async retrievePayment(o) {
      const p = (o.providerRef ? byRef.get(o.providerRef) : undefined) ?? payments.get(o.idempotencyKey);
      return p ? view(p) : { status: 'not_found' };
    },

    async capture(o) {
      const known = captures.get(o.idempotencyKey);
      if (known) return known;
      const p = byRef.get(o.providerRef);
      if (!p || !['authorized', 'captured'].includes(p.status)) return { status: 'failed', message: 'No authorization to capture' };
      const cents = o.amount.amount % 100;
      if (cents === 22) {
        const r: ProviderCapture = { status: 'failed', message: 'The processor refused the capture' };
        captures.set(o.idempotencyKey, r);
        return r;
      }
      if (p.captured + o.amount.amount > p.amount) return { status: 'failed', message: 'Capture is more than the authorization' };
      p.captured += o.amount.amount;
      p.status = 'captured';
      const r: ProviderCapture = { status: 'succeeded', providerRef: `cap_${rand(12)}` };
      captures.set(o.idempotencyKey, r);
      if (cents === 23) throw timeout('capture');
      return r;
    },

    async retrieveCapture(o) {
      return captures.get(o.idempotencyKey) ?? { status: 'not_found' };
    },

    async void(o) {
      const p = byRef.get(o.providerRef);
      if (p && p.status === 'authorized') p.status = 'voided';
    },

    async refund(o: { providerRef: string; amount: common.Money; idempotencyKey: string; destination?: RefundDestination | null; refundId: string }) {
      const known = refunds.get(o.idempotencyKey);
      if (known) return { status: known.status, providerRef: known.ref, failure: known.failure ?? null };
      const p = byRef.get(o.providerRef);
      const destToken = o.destination?.methodId ? methods.get(o.destination.methodId)?.token : o.destination?.token;
      const cents = o.amount.amount % 100;
      const attempt = (refundAttempts.get(o.refundId) ?? 0) + 1;
      refundAttempts.set(o.refundId, attempt);
      const r: DevRefund = { ref: `re_${rand(14)}`, status: 'succeeded' };
      const target = o.destination ? destToken : p?.token;
      if (!o.destination && !p) {
        r.status = 'failed';
        r.failure = { code: 'no_payment', reason: 'The original payment was not found', retryable: false };
      } else if (target === 'tok_closed' || (cents === 12 && !o.destination)) {
        r.status = 'failed';
        r.failure = { code: 'card_closed', reason: 'Card closed by the issuer', retryable: false };
      } else if (cents === 14 && attempt === 1) {
        r.status = 'failed';
        r.failure = { code: 'processing_error', reason: 'The processor could not send the refund', retryable: true };
      } else if (cents === 15) {
        r.status = 'pending';
      }
      refunds.set(o.idempotencyKey, r);
      if (cents === 13) {
        throw timeout('refund');
      }
      const out = { status: r.status, providerRef: r.ref, failure: r.failure ?? null };
      if (r.status === 'pending') r.status = 'succeeded'; // the bank confirms by the next retrieve
      return out;
    },

    async retrieveRefund(o) {
      const r = refunds.get(o.idempotencyKey);
      return r ? { status: r.status, providerRef: r.ref, failure: r.failure ?? null } : { status: 'not_found' };
    },

    async submitDisputeEvidence(o) {
      if (o.caseId.startsWith('dp_unavailable')) throw unavailable('dispute evidence');
    },

    async acceptDispute(o) {
      if (o.caseId.startsWith('dp_unavailable')) throw unavailable('dispute concession');
    },
  };
}
