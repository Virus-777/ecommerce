/**
 * Rows → API types, in one place per type: PaymentDetail, PaymentRow, PaymentStatusView, Refund, RefundView,
 * Dispute and SavedPaymentMethod. Lookups in other modules go through a Lookup (memoized per operation).
 */
import type * as common from '../../../spec/common.js';
import type { Capture, Dispute, MethodSnapshot, PaymentDetail, PaymentRow, PaymentStatusView, ProviderCall, Refund, RefundItem, RefundView, SavedPaymentMethod, WebhookLog } from '../../../spec/payments.js';
import {
  ACCEPTED,
  CUSTOMER_STATE_LABEL,
  DISPUTE_STATUS_LABEL,
  REFUND_STATUS_LABEL,
  STATUS_LABEL,
  customerState,
  deadlineOf,
  fmt,
  is,
  isExpired,
  money,
  refundExplanation,
  refundFailureAction,
  refundSteps,
  retryableRefundFailure,
  sellerBalanceEffect,
  type DisputeStatus,
  type RefundStatus,
} from '../domain/rules.js';
import type { DisputeRec, IntentRec, RefundItemRec, RefundLogRec, RefundRec, SavedMethodRec } from '../ports.js';
import type { Cfg, Core, Lookup } from './core.js';

const iso = (d: Date | null | undefined) => (d ? d.toISOString() : null);

/** The MethodSnapshot of the API (internal keys stripped) */
export function snapshotOf(i: IntentRec): MethodSnapshot {
  const { pendingAction: _p, ...m } = i.method;
  return m;
}

export class Views {
  constructor(private readonly core: Core) {}

  m = (amount: number, currency: string) => money(amount, currency);

  /* ---------------------------------------------------------------- payments */

  async paymentRows(intents: IntentRec[], lookup: Lookup): Promise<PaymentRow[]> {
    const ids = intents.map((i) => i.id);
    const [disputes, failedCaptures] = await Promise.all([
      ids.length ? this.core.repo.find('disputes', { intent_id: ids }) : [],
      ids.length ? this.core.repo.find('captures', { intent_id: ids, status: 'failed' }) : [],
    ]);
    return Promise.all(
      intents.map(async (i) => {
        const order = await lookup.order(i.order_id);
        const flags: PaymentRow['flags'] = [];
        if (i.orphan) flags.push('orphan');
        if (i.status === 'pending_check') flags.push('pending_check');
        if (failedCaptures.some((c) => c.intent_id === i.id) && (i.status === 'authorized' || i.status === 'partially_captured')) flags.push('capture_failed');
        if (disputes.some((d) => d.intent_id === i.id)) flags.push('chargeback');
        if (i.captured_amount > 0 && i.refunded_amount >= i.captured_amount) flags.push('refunded');
        else if (i.refunded_amount > 0) flags.push('partly_refunded');
        return {
          id: i.id,
          ref: i.ref,
          orderId: i.order_id,
          orderRef: order?.ref ?? null,
          checkoutSessionId: i.checkout_session_id,
          customerName: await lookup.customerName(i),
          amount: this.m(i.amount, i.currency),
          methodLabel: i.method.label,
          status: i.status,
          statusLabel: STATUS_LABEL[i.status as keyof typeof STATUS_LABEL] ?? i.status,
          provider: i.provider,
          flags,
          createdAt: i.created_at.toISOString(),
        };
      }),
    );
  }

  async paymentDetail(i: IntentRec, lookup: Lookup, cfg: Cfg): Promise<PaymentDetail> {
    const repo = this.core.repo;
    const [allocations, captures, refunds, disputes, calls, order] = await Promise.all([
      repo.find('allocations', { intent_id: i.id }),
      repo.find('captures', { intent_id: i.id }, { orderBy: [['at', 'asc']] }),
      repo.find('refunds', { intent_id: i.id }, { orderBy: [['created_at', 'desc']] }),
      repo.find('disputes', { intent_id: i.id }, { orderBy: [['opened_at', 'desc']] }),
      repo.find('provider_calls', { intent_id: i.id }, { orderBy: [['at', 'asc']] }),
      lookup.order(i.order_id),
    ]);
    const webhooks = await repo.webhooksFor(i.provider, [i.provider_ref ?? '', i.id]);
    return {
      id: i.id,
      ref: i.ref,
      checkoutSessionId: i.checkout_session_id,
      attemptNo: i.attempt_no,
      orderId: i.order_id,
      orderRef: order?.ref ?? null,
      customerId: i.customer_id,
      guestEmail: i.guest_email,
      amount: this.m(i.amount, i.currency),
      tenders: i.tenders.map(({ creditReturns: _returns, captureCredits: _shares, ...t }) => t),
      method: snapshotOf(i),
      provider: i.provider,
      providerRef: i.provider_ref,
      status: i.status as PaymentDetail['status'],
      customerState: customerState(i),
      decline: i.decline,
      allocations: allocations.map((a) => ({ groupId: a.group_id, ownerType: a.owner_type as 'official' | 'seller', sellerId: a.seller_id, amount: this.m(a.amount, i.currency) })),
      authorizedAmount: this.m(i.authorized_amount, i.currency),
      capturedAmount: this.m(i.captured_amount, i.currency),
      refundedAmount: this.m(i.refunded_amount, i.currency),
      authorizedAt: iso(i.authorized_at),
      capturedAt: iso(i.captured_at),
      authorizationExpiresAt: iso(i.authorization_expires_at),
      lastCheckedAt: iso(i.last_checked_at),
      orphan: i.orphan,
      captures: captures.map(
        (c): Capture => ({ id: c.id, groupId: c.group_id, amount: this.m(c.amount, i.currency), status: c.status as Capture['status'], providerRef: c.provider_ref, at: c.at.toISOString() }),
      ),
      refunds: await this.refunds(refunds, lookup, cfg),
      disputes: await Promise.all(disputes.map((d) => this.dispute(d, lookup))),
      calls: calls.map(
        (c): ProviderCall => ({ at: c.at.toISOString(), operation: c.operation as ProviderCall['operation'], outcome: c.outcome as ProviderCall['outcome'], providerRef: c.provider_ref, message: c.message }),
      ),
      webhooks: webhooks.map((w): WebhookLog => ({ id: w.id, type: w.type, receivedAt: w.received_at.toISOString(), processedAt: iso(w.processed_at), outcome: w.outcome ?? 'received' })),
      createdAt: i.created_at.toISOString(),
    };
  }

  /** Customer-facing result of one payment attempt */
  async statusView(i: IntentRec, lookup: Lookup): Promise<PaymentStatusView> {
    const now = this.core.now();
    const amount = this.m(i.amount, i.currency);
    const label = i.method.label;
    const order = await lookup.order(i.order_id);
    const base = { intentId: i.id, checkoutSessionId: i.checkout_session_id, methodLabel: label, amount, orderId: i.order_id, orderRef: order?.ref ?? null, lastCheckedAt: iso(i.last_checked_at) };
    if (is(ACCEPTED, i.status) || (i.status === 'voided' && i.order_id)) {
      return { ...base, state: 'accepted', title: 'Payment accepted', message: `${label} was accepted. Your card is charged once, when the order is accepted.`, retryAllowed: false, decline: null, nextCheckInSeconds: null, holdNote: null, nextAction: null };
    }
    if (i.status === 'requires_action') {
      return {
        ...base,
        state: 'requires_action',
        title: 'Confirm with your bank',
        message: `Your bank needs you to confirm this payment with ${label}. Nothing is charged until you do.`,
        retryAllowed: false,
        decline: null,
        nextCheckInSeconds: null,
        holdNote: null,
        nextAction: i.method.pendingAction ?? null,
      };
    }
    if (i.status === 'failed' || i.status === 'voided' || i.status === 'expired') {
      return {
        ...base,
        state: 'failed',
        title: 'Payment not accepted',
        message: i.decline?.message ?? `${label} was not charged.`,
        decline: i.decline,
        retryAllowed: true,
        nextCheckInSeconds: null,
        holdNote: null,
        nextAction: null,
      };
    }
    const next = i.next_check_at ? Math.max(0, Math.ceil((i.next_check_at.getTime() - now.getTime()) / 1000)) : null;
    return {
      ...base,
      state: 'pending',
      title: "We're checking your payment",
      message: "We're confirming your payment with your bank. Don't pay again.",
      decline: null,
      retryAllowed: false,
      nextCheckInSeconds: next,
      holdNote: `Your bank may show a temporary hold for ${fmt(amount)}. Placing the order again could create a second hold.`,
      nextAction: null,
    };
  }

  /* ---------------------------------------------------------------- refunds */

  async refunds(rows: RefundRec[], lookup: Lookup, cfg: Cfg): Promise<Refund[]> {
    if (!rows.length) return [];
    const ids = rows.map((r) => r.id);
    const [items, logs, intents] = await Promise.all([
      this.core.repo.find('refund_items', { refund_id: ids }),
      this.core.repo.find('refund_log', { refund_id: ids }, { orderBy: [['at', 'asc']] }),
      this.core.repo.find('intents', { id: [...new Set(rows.map((r) => r.intent_id))] }),
    ]);
    return Promise.all(
      rows.map((r) =>
        this.refund(
          r,
          items.filter((i) => i.refund_id === r.id),
          logs.filter((l) => l.refund_id === r.id),
          intents.find((i) => i.id === r.intent_id)!,
          lookup,
          cfg,
        ),
      ),
    );
  }

  async refundItems(r: RefundRec, items: RefundItemRec[], lookup: Lookup): Promise<RefundItem[]> {
    const order = await lookup.order(r.order_id);
    return items.map((i) => ({ orderItemId: i.order_item_id, title: order?.items.get(i.order_item_id)?.title ?? 'Item', groupId: i.group_id, sellerId: i.seller_id, amount: this.m(i.amount, r.currency) }));
  }

  async refund(r: RefundRec, items: RefundItemRec[], logs: RefundLogRec[], intent: IntentRec, lookup: Lookup, cfg: Cfg): Promise<Refund> {
    const order = await lookup.order(r.order_id);
    const status = r.status as RefundStatus;
    return {
      id: r.id,
      ref: r.ref,
      orderId: r.order_id,
      orderRef: order?.ref ?? intent.ref,
      paymentIntentId: r.intent_id,
      customerName: await lookup.customerName(intent),
      origin: r.origin as Refund['origin'],
      originId: r.origin_id,
      originRef: r.origin_ref,
      items: await this.refundItems(r, items, lookup),
      amount: this.m(r.amount, r.currency),
      destination: r.destination as Refund['destination'],
      destinationLabel: r.destination_label,
      status,
      statusLabel: r.outcome_unknown && status === 'processing' ? 'Processing (checking with the bank)' : REFUND_STATUS_LABEL[status],
      attempts: r.attempts,
      maxAttempts: cfg.refundMaxAttempts,
      lastAttemptAt: iso(r.last_attempt_at),
      outcomeUnknown: r.outcome_unknown,
      failureCode: r.failure_code,
      failureReason: r.failure_reason,
      nextStep: this.nextStep(r, cfg),
      arrivalNote: r.destination === 'store_credit' ? 'Store credit is available as soon as the refund is sent.' : cfg.refundArrivalNote,
      sentAt: iso(r.sent_at),
      providerRef: r.provider_ref,
      reason: r.reason,
      requestedBy: r.requested_by,
      createdAt: r.created_at.toISOString(),
      history: logs.map((l) => ({ at: l.at.toISOString(), label: l.from_status === l.to_status ? REFUND_STATUS_LABEL[l.to_status as RefundStatus] : `${REFUND_STATUS_LABEL[l.to_status as RefundStatus] ?? l.to_status}`, detail: l.detail, actor: l.actor })),
    };
  }

  nextStep(r: RefundRec, cfg: Cfg): string | null {
    switch (r.status) {
      case 'requested':
        return 'Sent to the provider by the next refund run';
      case 'processing':
        return r.outcome_unknown ? 'Check the status with the provider; never resend' : 'Waiting for the provider to confirm';
      case 'failed':
        if (r.failure_code === 'destination_requested') return 'Waiting for the customer to choose a new destination';
        if (retryableRefundFailure(r.failure_code) && r.attempts < cfg.refundMaxAttempts) return 'Retried automatically after a provider check';
        return 'Ask the customer for a new destination, or cancel with a reason';
      default:
        return null;
    }
  }

  async refundView(r: RefundRec, items: RefundItemRec[], lookup: Lookup, cfg: Cfg, intent: IntentRec): Promise<RefundView> {
    const order = await lookup.order(r.order_id);
    const status = r.status as RefundStatus;
    const { steps, currentStep } = refundSteps(status);
    const failure = refundFailureAction({ ...r, status }, retryableRefundFailure(r.failure_code) && r.next_attempt_at !== null, cfg.refundMaxAttempts);
    return {
      id: r.id,
      ref: r.ref,
      orderId: r.order_id,
      orderRef: order?.ref ?? intent.ref,
      status,
      statusLabel: REFUND_STATUS_LABEL[status],
      steps,
      currentStep,
      amount: this.m(r.amount, r.currency),
      destinationLabel: r.destination_label,
      items: await this.refundItems(r, items, lookup),
      sentAt: iso(r.sent_at),
      arrivalNote: r.destination === 'store_credit' ? 'Store credit is available as soon as the refund is sent.' : cfg.refundArrivalNote,
      failure: failure ? { ...failure, reason: r.failure_reason ? `We could not send your refund to ${r.destination_label}: ${r.failure_reason.charAt(0).toLowerCase()}${r.failure_reason.slice(1)}.` : failure.reason } : null,
      explanation: refundExplanation(status, r.destination === 'store_credit'),
    };
  }

  async refundViews(rows: RefundRec[], lookup: Lookup, cfg: Cfg): Promise<RefundView[]> {
    if (!rows.length) return [];
    const ids = rows.map((r) => r.id);
    const [items, intents] = await Promise.all([this.core.repo.find('refund_items', { refund_id: ids }), this.core.repo.find('intents', { id: [...new Set(rows.map((r) => r.intent_id))] })]);
    return Promise.all(
      rows.map((r) =>
        this.refundView(
          r,
          items.filter((i) => i.refund_id === r.id),
          lookup,
          cfg,
          intents.find((i) => i.id === r.intent_id)!,
        ),
      ),
    );
  }

  /* ---------------------------------------------------------------- disputes */

  async dispute(d: DisputeRec, lookup: Lookup): Promise<Dispute> {
    const [order, intent] = await Promise.all([lookup.order(d.order_id), this.core.repo.get('intents', d.intent_id)]);
    const group = d.group_id ? order?.groups.get(d.group_id) : undefined;
    const ownerType = group?.ownerType ?? null;
    const status = d.status as DisputeStatus;
    const e = d.evidence;
    return {
      id: d.id,
      ref: d.ref,
      kind: d.kind as Dispute['kind'],
      provider: d.provider,
      providerCaseId: d.provider_case_id,
      paymentIntentId: d.intent_id,
      orderId: d.order_id,
      orderRef: order?.ref ?? intent?.ref ?? '',
      groupId: d.group_id,
      ownerType,
      sellerId: d.seller_id,
      sellerName: group?.sellerName ?? null,
      customerName: intent ? await lookup.customerName(intent) : 'Customer',
      reasonCode: d.reason_code,
      reason: d.reason,
      amount: this.m(d.amount, d.currency),
      evidenceDue: status === 'opened' ? deadlineOf(d.evidence_due_at, this.core.now()) : d.evidence_due_at ? { dueAt: d.evidence_due_at.toISOString(), state: 'on_time' } : null,
      status,
      statusLabel: e.pendingConcession && status === 'opened' ? 'Concession waiting for approval' : DISPUTE_STATUS_LABEL[status],
      sellerBalanceEffect: sellerBalanceEffect(d, ownerType),
      evidence: { text: e.text ?? null, files: e.files ?? [], submittedAt: e.submittedAt ?? null, submittedBy: e.submittedBy ?? null },
      owner: await lookup.staffName(d.owner_staff_id),
      history: e.history ?? [],
      openedAt: d.opened_at.toISOString(),
      decidedAt: iso(d.decided_at),
    };
  }

  /* ---------------------------------------------------------------- saved methods */

  savedMethod(m: SavedMethodRec, today: string): SavedPaymentMethod {
    const a = m.billing_address ?? {};
    const place = [a.city, a.postalCode].filter(Boolean).join(' ');
    const summary = [a.label ?? null, place || null].filter(Boolean).join(', ');
    return {
      id: m.id,
      kind: m.kind as SavedPaymentMethod['kind'],
      brand: m.brand,
      label: m.label,
      last4: m.last4,
      expMonth: m.exp_month,
      expYear: m.exp_year,
      expired: isExpired(m.exp_month, m.exp_year, today),
      isDefault: m.is_default,
      billingSummary: summary || 'No billing address',
      createdAt: m.created_at.toISOString(),
    };
  }
}

export const customerStateLabel = (s: PaymentDetail['customerState']) => CUSTOMER_STATE_LABEL[s];
export type { common };
