import { AppError } from '../../../kernel/errors/index.js';
import { routes } from '../../../kernel/http/index.js';
import { endpoints } from '../../../spec/payments.js';
import type { PaymentsService } from '../service.js';

const refundNotFound = () => new AppError('NOT_FOUND', 'Refund not found');

/**
 * Admin API: /api/admin/payments/…  (docs/api/modules/payments.md)
 * One handler per endpoint of this area in the spec; the compiler rejects missing or extra ones.
 */
export const adminRoutes = (service: PaymentsService) =>
  routes(endpoints, 'admin', {
    /** GET /payments: Payments with status and flags (pending check, orphan, capture failed, chargeback) */
    listPaymentsAdmin: ({ query, page }) => service.listPayments(query, page),
    /** GET /payments/{id}: Payment with tenders, allocations, captures, refunds, disputes, provider calls and webhooks */
    getPaymentAdmin: ({ params }) => service.paymentAdmin(params.id),
    /** GET /orders/{orderId}/summary: Payment panel of an order (method, authorized, captured, processor ref, refunded, attempts) */
    getOrderPayments: ({ params }) => service.orderSummary(params.orderId),
    /** GET /orders/{orderId}/refundable: Remaining refundable amount per item (the cap shown in refund dialogs) */
    getOrderRefundable: ({ params }) => service.remainingRefundable(params.orderId),
    /** POST /payments/{id}/check: Ask the provider for the current result */
    checkPaymentAdmin: ({ params, actor, requestId, principal }) => service.checkPayment(params.id, { actor, requestId, principal }),
    /** POST /payments/{id}/capture: Capture an authorization manually (e.g. after a capture failure) */
    capturePaymentAdmin: ({ params, body, actor, requestId, principal, idempotencyKey }) => service.intents.adminCapture(params.id, body, { actor, requestId, principal, idempotencyKey }),
    /** POST /payments/{id}/void: Void an authorization that should not be captured */
    voidPaymentAdmin: ({ params, body, actor, requestId, principal }) => service.intents.adminVoid(params.id, body.reason, { actor, requestId, principal }),
    /** POST /payments/{id}/resolve-orphan: Refund or link a payment that has no order */
    resolveOrphanPayment: ({ params, body, actor, requestId, principal }) => service.intents.resolveOrphan(params.id, body, { actor, requestId, principal }),
    /** GET /refunds: Refund executions, e.g. failing refunds */
    listRefundsAdmin: ({ query, page }) => service.refunds.listAdmin(query, page),
    /** GET /refunds/{id}: One refund with items, attempts and history */
    getRefundAdmin: async ({ params }) => (await service.getRefund(params.id)) ?? Promise.reject(refundNotFound()),
    /** POST /refunds/{id}/check: Ask the provider for the refund's outcome */
    checkRefund: ({ params, actor, requestId, principal }) => service.refunds.adminCheck(params.id, { actor, requestId, principal }),
    /** POST /refunds/{id}/retry: Retry a failed refund (checks the provider first) */
    retryRefund: ({ params, body, actor, requestId, principal }) => service.refunds.adminRetry(params.id, body.reason, { actor, requestId, principal }),
    /** POST /refunds/{id}/request-destination: Ask the customer for a new payment method for a failed refund */
    requestNewRefundDestination: ({ params, body, actor, requestId, principal }) => service.refunds.requestDestination(params.id, body.message, { actor, requestId, principal }),
    /** POST /refunds/{id}/cancel: Cancel a requested or failed refund with a reason */
    cancelRefund: ({ params, body, actor, requestId, principal }) => service.refunds.cancel(params.id, body.reason, { actor, requestId, principal }),
    /** GET /disputes: Chargebacks and payment disputes, evidence due first */
    listDisputes: ({ query, page }) => service.disputes.list(query, page),
    /** GET /disputes/{id}: One dispute with order, evidence and seller balance effect */
    getDispute: async ({ params }) => service.disputes.toApi(await service.disputes.get(params.id)),
    /** POST /disputes/{id}/assign: Set the owner */
    assignDispute: ({ params, body, actor, requestId, principal }) => service.disputes.assign(params.id, body.ownerStaffId, { actor, requestId, principal }),
    /** POST /disputes/{id}/evidence: Save or submit evidence (tracking, delivery proof, messages, receipts) */
    submitDisputeEvidence: ({ params, body, actor, requestId, principal }) => service.disputes.evidence(params.id, body, { actor, requestId, principal }),
    /** POST /disputes/{id}/accept: Concede the dispute (the provider keeps the money) */
    acceptDispute: ({ params, body, actor, requestId, principal }) => service.disputes.accept(params.id, body.reason, { actor, requestId, principal }),
  });
