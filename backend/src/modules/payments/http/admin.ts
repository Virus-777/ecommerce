import { notImplemented, routes } from '../../../kernel/http/index.js';
import { endpoints } from '../../../spec/payments.js';
import type { PaymentsService } from '../service.js';

/**
 * Admin API: /api/admin/payments/…  (docs/api/modules/payments.md)
 * One handler per endpoint of this area in the spec; the compiler rejects missing or extra ones.
 */
export const adminRoutes = (service: PaymentsService) =>
  routes(endpoints, 'admin', {
    /** GET /payments: Payments with status and flags (pending check, orphan, capture failed, chargeback) */
    listPaymentsAdmin: notImplemented,
    /** GET /payments/{id}: Payment with tenders, allocations, captures, refunds, disputes, provider calls and webhooks */
    getPaymentAdmin: notImplemented,
    /** GET /orders/{orderId}/summary: Payment panel of an order (method, authorized, captured, processor ref, refunded, attempts) */
    getOrderPayments: notImplemented,
    /** GET /orders/{orderId}/refundable: Remaining refundable amount per item (the cap shown in refund dialogs) */
    getOrderRefundable: notImplemented,
    /** POST /payments/{id}/check: Ask the provider for the current result */
    checkPaymentAdmin: notImplemented,
    /** POST /payments/{id}/capture: Capture an authorization manually (e.g. after a capture failure) */
    capturePaymentAdmin: notImplemented,
    /** POST /payments/{id}/void: Void an authorization that should not be captured */
    voidPaymentAdmin: notImplemented,
    /** POST /payments/{id}/resolve-orphan: Refund or link a payment that has no order */
    resolveOrphanPayment: notImplemented,
    /** GET /refunds: Refund executions, e.g. failing refunds */
    listRefundsAdmin: notImplemented,
    /** GET /refunds/{id}: One refund with items, attempts and history */
    getRefundAdmin: notImplemented,
    /** POST /refunds/{id}/check: Ask the provider for the refund's outcome */
    checkRefund: notImplemented,
    /** POST /refunds/{id}/retry: Retry a failed refund (checks the provider first) */
    retryRefund: notImplemented,
    /** POST /refunds/{id}/request-destination: Ask the customer for a new payment method for a failed refund */
    requestNewRefundDestination: notImplemented,
    /** POST /refunds/{id}/cancel: Cancel a requested or failed refund with a reason */
    cancelRefund: notImplemented,
    /** GET /disputes: Chargebacks and payment disputes, evidence due first */
    listDisputes: notImplemented,
    /** GET /disputes/{id}: One dispute with order, evidence and seller balance effect */
    getDispute: notImplemented,
    /** POST /disputes/{id}/assign: Set the owner */
    assignDispute: notImplemented,
    /** POST /disputes/{id}/evidence: Save or submit evidence (tracking, delivery proof, messages, receipts) */
    submitDisputeEvidence: notImplemented,
    /** POST /disputes/{id}/accept: Concede the dispute (the provider keeps the money) */
    acceptDispute: notImplemented,
  });
