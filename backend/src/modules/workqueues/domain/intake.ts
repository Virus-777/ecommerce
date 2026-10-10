/**
 * Intake table: one entry per consumed event (spec events.consumes), saying which work items the
 * event opens (queue, kind, dedupe key, deadline, priority) and which open items it closes
 * (matched on the item's subject or one of its related subjects). The service runs it
 * (app/intake.ts); GET /intake-rules shows it, with each kind's resolvesOn derived from the closes.
 *
 * Dedupe keys (other modules may close the same items with resolveBySource):
 *   overdue_dispatch:<orderItemId>      missing_tracking:<orderItemId>     exception:<exceptionId>
 *   low_stock:<stockItemId>             approval:<requestId>               case_past_target:<caseId>
 *   case_escalated:<caseId>             return_decision:<returnId>         payout_failed:<payoutId>
 *   payment_mismatch:<checkItemId>      payment_check:<intentId>           chargeback:<disputeId>
 *   product_review:<productId>          application:<applicationId>        launch_review:<sellerId>
 *   appeal:<appealId>                   restriction_evidence:<restrictionId> seller_performance:<sellerId>
 *   change_request:<changeRequestId>    trust_report:<reportId>            trust_recommendation:<recommendationId>
 *   reply_overdue:<conversationId>      data_request:<requestId>
 * Raised by warehouse (raise()): return_parcel:<parcelId> (unexpected), return_parcel_overdue:<parcelId>,
 * both with the parcel as subject (return_parcel; 'other' before pass 3); queues per kind are in
 * domain/catalog.ts KIND_QUEUES. Raised by reviews: review_moderation_overdue:<moderationItemId>, closed
 * here on reviews.moderation.decided by that dedupe key. Raised and closed by their modules with
 * resolveBySource: seller_owner_missing (sellers), official_store_reply (messaging), enforcement_reversal (trust).
 *
 * Subjects typed in pass 3 (product, dispute, conversation, return_parcel) were 'other' before: closes
 * match both, so items opened before the upgrade still close.
 */
import type { EventName, EventPayload } from '../../../kernel/events/index.js';
import type { Money } from '../../../spec/common.js';
import type { spec, WorkSubject } from '../../../spec/workqueues.js';
import { SUBJECT_TYPES, type Kind, type Priority } from './catalog.js';

export type SubjectType = WorkSubject['type'];

export interface Link {
  label: string;
  screen: string;
  state?: string | null;
}

/** A work item an event raises (RaiseInput plus intake-only switches) */
export interface Opening {
  queueKey: string;
  /** Item owner role when it differs from the queue's (approvers' role, trust owner team) */
  ownerRole?: string | null;
  title: string;
  summary?: string | null;
  subject: WorkSubject;
  related?: WorkSubject[];
  sellerId?: string | null;
  customerId?: string | null;
  amount?: Money | null;
  /** Absent: now + the queue's default deadline */
  dueAt?: string | null;
  priority?: Priority;
  dedupeKey: string;
  links?: Link[];
  visibleToSeller?: boolean;
  /** An open item is refreshed one priority step higher (support.case.escalated) */
  bumpPriority?: boolean;
  /** A waiting item goes back to work with a fresh deadline (sellers.application.information_provided) */
  wake?: boolean;
}

export interface OpenDecl<P> {
  kind: Kind;
  /** Queues the item may land in (first = usual); GET /intake-rules lists one rule per queue */
  queues: string[];
  title: string;
  dedupe: string;
  deadline: string;
  priority: string;
  build: (p: P) => (Opening | null | undefined | false)[];
}

export interface Match {
  type: SubjectType;
  id: string;
}

export interface CloseDecl<P> {
  kinds: Kind[];
  subjects: (p: P) => (Match | null | undefined | false)[];
  /** Close the active item of these dedupe keys too (items another module raised with raise()) */
  dedupeKeys?: (p: P) => (string | null | undefined | false)[];
  note: (p: P) => string;
}

export type Effect = 'awayStarted' | 'awayEnded' | 'coverageChanged';

export interface IntakeEntry<P> {
  opens?: OpenDecl<P>[];
  closes?: CloseDecl<P>[];
  effect?: Effect;
}

export type Consumed = keyof (typeof spec)['events']['consumes'] & EventName;
export type IntakeTable = { [N in Consumed]: IntakeEntry<EventPayload<N>> };

/* ------------------------------------------------------------------ helpers */

const human = (s: string | null | undefined) => (s ?? '').replace(/[_.-]+/g, ' ').trim();
const S = (type: SubjectType, id: string | null | undefined, ref?: string | null, label?: string | null): WorkSubject | null =>
  id ? { type, id, ...(ref ? { ref } : {}), ...(label ? { label } : {}) } : null;
const list = (...s: (WorkSubject | null)[]) => s.filter((x): x is WorkSubject => Boolean(x));
const M = (type: SubjectType, id: string | null | undefined): Match | null => (id ? { type, id } : null);
const L = (label: string, screen: string, state?: string | null): Link => ({ label, screen, ...(state ? { state } : {}) });

const SUBJECT_TYPE_SET = new Set<string>(SUBJECT_TYPES);
const subjectTypeOf = (t: string | null | undefined): SubjectType => (t && SUBJECT_TYPE_SET.has(t) ? (t as SubjectType) : 'other');

/** support.case.escalated `to` → owner role of the escalated case item */
export const CASE_TEAM_ROLES: Record<string, string> = {
  returns: 'returns_manager',
  finance: 'finance_manager',
  trust: 'trust_and_risk_manager',
  seller_management: 'seller_manager',
  support_lead: 'customer_support_manager',
};

/** trust.recommendation.routed ownerTeam → queue of the owning team */
export const TRUST_TEAM_QUEUES: Record<string, string> = {
  catalog: 'catalog.product_review',
  sellers: 'sellers.performance',
  support: 'support.cases_waiting',
  customers: 'support.cases_waiting',
  messaging: 'support.cases_waiting',
  orders: 'support.cases_waiting',
  finance: 'finance.daily_checks',
};
const TRUST_QUEUES = ['trust.reports', ...new Set(Object.values(TRUST_TEAM_QUEUES))];

/** trust risk score (0–100) → item priority */
export const riskPriority = (score: number): Priority => (score >= 80 ? 'urgent' : score >= 60 ? 'high' : score >= 30 ? 'normal' : 'low');

/** returns.return.escalated reasons that mean the seller missed a deadline */
const SELLER_MISSED = new Set(['seller_no_response', 'seller_missed_inspection', 'response_deadline_missed', 'seller_missed_deadline']);

const DISPATCH_KINDS: Kind[] = ['overdue_dispatch', 'missing_tracking', 'seller_cannot_fulfill'];

/** Fulfilled by Marketly: Marketly's warehouse ships the package, so its dispatch and delivery items are never the seller's */
const marketly = (p: { fulfilledBy?: string | null }) => p.fulfilledBy === 'marketly_service';
export const FBM_SUMMARY = 'Fulfilled by Marketly (warehouse)';

/** A product subject (typed since pass 3; 'other' before) */
const product = (id: string) => [M('product', id), M('other', id)];

/* ------------------------------------------------------------------ the table */

export const INTAKE: IntakeTable = {
  /* ---------------------------------------------------------------- shipping, orders */
  'shipping.dispatch.overdue': {
    opens: [
      {
        kind: 'overdue_dispatch',
        queues: ['shipping.overdue_dispatch', 'warehouse.pick_pack'],
        title: 'Overdue dispatch {orderRef}',
        dedupe: 'overdue_dispatch:{orderItemId}',
        deadline: 'now + queue default',
        priority: 'high',
        build: (p) =>
          p.orderItemIds.map((itemId) =>
            // Fulfilled by Marketly: the Marketly warehouse is late, not the seller (pick and pack team; not seller-visible)
            marketly(p)
              ? {
                  queueKey: 'warehouse.pick_pack',
                  title: `Overdue dispatch ${p.orderRef}`,
                  summary: FBM_SUMMARY,
                  subject: { type: 'order', id: p.orderId, ref: p.orderRef },
                  related: list(S('order_item', itemId), S('delivery_exception', p.exceptionId, null, 'Late dispatch')),
                  sellerId: p.sellerId ?? null,
                  priority: 'high',
                  dedupeKey: `overdue_dispatch:${itemId}`,
                  links: [L('Open order', 'admin/order', p.orderId), L('Open pick and pack', 'ops/pick-pack')],
                  visibleToSeller: false,
                }
              : {
                  queueKey: 'shipping.overdue_dispatch',
                  title: `Overdue dispatch ${p.orderRef}`,
                  summary: `${p.ownerType === 'seller' ? 'Marketplace seller' : 'Official Store'} missed the dispatch deadline of ${p.dueAt}`,
                  subject: { type: 'order', id: p.orderId, ref: p.orderRef },
                  related: list(S('order_item', itemId), S('delivery_exception', p.exceptionId, null, 'Late dispatch')),
                  sellerId: p.sellerId ?? null,
                  priority: 'high',
                  dedupeKey: `overdue_dispatch:${itemId}`,
                  links: [L('Open order', 'admin/order', p.orderId), L('Open dispatch queue', 'ops/dispatch', 'overdue')],
                  visibleToSeller: p.ownerType === 'seller' && Boolean(p.sellerId),
                },
          ),
      },
    ],
  },
  'shipping.shipment.dispatched': {
    closes: [
      { kinds: ['overdue_dispatch', 'seller_cannot_fulfill'], subjects: (p) => p.lines.map((l) => M('order_item', l.orderItemId)), note: (p) => `Dispatched${p.onTime === false ? ' late' : ''} at ${p.shippedAt}` },
      { kinds: ['missing_tracking'], subjects: (p) => (p.trackingValid ? p.lines.map((l) => M('order_item', l.orderItemId)) : []), note: () => 'Dispatched with valid tracking' },
    ],
  },
  'shipping.shipment.exception': {
    opens: [
      {
        kind: 'missing_tracking',
        queues: ['shipping.missing_tracking'],
        title: 'Missing tracking on an order',
        dedupe: 'missing_tracking:{orderItemId}',
        deadline: 'event.dueAt',
        priority: 'normal',
        build: (p) =>
          p.kind !== 'missing_tracking'
            ? []
            : p.orderItemIds.map((itemId) => ({
                queueKey: 'shipping.missing_tracking',
                title: 'Missing tracking on an order',
                summary: marketly(p) ? `${FBM_SUMMARY}: the package has no valid tracking number` : 'The package has no valid tracking number',
                subject: { type: 'order', id: p.orderId },
                related: list(S('order_item', itemId), S('delivery_exception', p.exceptionId, null, 'Missing tracking'), S('shipment', p.shipmentId)),
                sellerId: p.sellerId ?? null,
                dueAt: p.dueAt,
                dedupeKey: `missing_tracking:${itemId}`,
                links: [L('Open order', 'admin/order', p.orderId), L('Open dispatch queue', 'ops/dispatch', 'missing_tracking')],
                visibleToSeller: Boolean(p.sellerId) && !marketly(p),
              })),
      },
      {
        kind: 'seller_cannot_fulfill',
        queues: ['orders.seller_cannot_fulfill'],
        title: 'Seller cannot fulfill an order',
        dedupe: 'exception:{exceptionId}',
        deadline: 'event.dueAt',
        priority: 'high',
        build: (p) => [
          p.kind === 'seller_cannot_fulfill' && {
            queueKey: 'orders.seller_cannot_fulfill',
            title: 'Seller cannot fulfill an order',
            summary: `${marketly(p) ? `${FBM_SUMMARY}: ` : ''}${p.orderItemIds.length} item${p.orderItemIds.length === 1 ? '' : 's'} cannot be fulfilled; cancel, replace or refund`,
            subject: { type: 'delivery_exception', id: p.exceptionId, label: 'Seller cannot fulfill' },
            related: list(S('order', p.orderId), ...p.orderItemIds.map((id) => S('order_item', id))),
            sellerId: p.sellerId ?? null,
            dueAt: p.dueAt,
            priority: 'high',
            dedupeKey: `exception:${p.exceptionId}`,
            links: [L('Open order', 'admin/order', p.orderId)],
            visibleToSeller: Boolean(p.sellerId) && !marketly(p),
          },
        ],
      },
      {
        kind: 'delivery_exception',
        queues: ['shipping.delivery_exceptions'],
        title: 'Delivery exception: {kind}',
        dedupe: 'exception:{exceptionId}',
        deadline: 'event.dueAt',
        priority: 'high (lost or damaged), normal',
        build: (p) => [
          (p.kind === 'lost_or_damaged' || p.kind === 'failed_delivery') && {
            queueKey: 'shipping.delivery_exceptions',
            title: `Delivery exception: ${human(p.kind)}`,
            summary: marketly(p) ? (p.customerAction ? `${FBM_SUMMARY}. Customer action: ${p.customerAction}` : FBM_SUMMARY) : p.customerAction ? `Customer action: ${p.customerAction}` : null,
            subject: { type: 'delivery_exception', id: p.exceptionId, label: human(p.kind) },
            related: list(S('order', p.orderId), S('shipment', p.shipmentId), ...p.orderItemIds.map((id) => S('order_item', id))),
            sellerId: p.sellerId ?? null,
            dueAt: p.dueAt,
            priority: p.kind === 'lost_or_damaged' ? 'high' : 'normal',
            dedupeKey: `exception:${p.exceptionId}`,
            links: [L('Open order', 'admin/order', p.orderId), L('Open exceptions', 'ops/dispatch', 'exceptions')],
          },
        ],
      },
    ],
  },
  'shipping.shipment.delivered': {
    closes: [{ kinds: ['delivery_exception'], subjects: (p) => [M('shipment', p.shipmentId)], note: (p) => `Delivered at ${p.deliveredAt}` }],
  },
  'orders.item.cancelled': {
    closes: [{ kinds: DISPATCH_KINDS, subjects: (p) => [M('order_item', p.itemId)], note: (p) => `Item cancelled (${human(p.reasonCode)})` }],
  },

  /* ---------------------------------------------------------------- inventory */
  'inventory.stock.low': {
    opens: [
      {
        kind: 'low_stock',
        queues: ['inventory.low_stock'],
        title: 'Low stock: {label}',
        dedupe: 'low_stock:{stockItemId}',
        deadline: 'now + queue default (business hours)',
        priority: 'high when nothing is available, else normal',
        build: (p) => [
          p.ownerType === 'official' && {
            queueKey: 'inventory.low_stock',
            title: `Low stock: ${p.label}`,
            summary: `${p.available} available, reorder point ${p.threshold} (SKU ${p.sku})`,
            subject: { type: 'stock_item', id: p.stockItemId, ref: p.sku, label: p.label },
            related: list(S('offer', p.offerId)),
            priority: p.available <= 0 ? 'high' : 'normal',
            dedupeKey: `low_stock:${p.stockItemId}`,
            links: [L('Open stock', 'ops/inventory', 'low_stock'), L('Create purchase order', 'admin/purchasing')],
          },
        ],
      },
    ],
  },
  'inventory.stock.changed': {
    closes: [{ kinds: ['low_stock'], subjects: (p) => (p.state === 'in_stock' ? [M('stock_item', p.stockItemId)] : []), note: (p) => `Back in stock: ${p.available} available` }],
  },

  /* ---------------------------------------------------------------- access */
  'access.approval.requested': {
    opens: [
      {
        kind: 'approval_waiting',
        queues: ['access.approvals'],
        title: 'Approval waiting: {ref}',
        dedupe: 'approval:{requestId}',
        deadline: 'event.dueAt, else queue default',
        priority: 'normal',
        build: (p) => [
          {
            queueKey: 'access.approvals',
            ownerRole: p.eligibleRoleKeys[0] ?? null,
            title: `Approval waiting: ${p.ref}`,
            summary: p.summary,
            subject: { type: 'approval_request', id: p.requestId, ref: p.ref, label: human(p.actionKey) },
            related: list(S(subjectTypeOf(p.target.type), p.target.id, p.target.ref, p.target.label)),
            sellerId: p.target.sellerId ?? null,
            amount: p.amount ?? null,
            dueAt: p.dueAt ?? null,
            dedupeKey: `approval:${p.requestId}`,
            links: [L('Review request', 'admin/staff', 'approvals'), ...(p.target.screen ? [L('Open record', p.target.screen, p.target.id)] : [])],
          },
        ],
      },
    ],
  },
  'access.approval.decided': {
    closes: [{ kinds: ['approval_waiting'], subjects: (p) => [M('approval_request', p.requestId)], note: (p) => `Request ${p.outcome}` }],
  },
  'access.away.started': { effect: 'awayStarted' },
  'access.away.ended': { effect: 'awayEnded' },
  'access.coverage.changed': { effect: 'coverageChanged' },

  /* ---------------------------------------------------------------- support */
  'support.case.overdue': {
    opens: [
      {
        kind: 'case_past_target',
        queues: ['support.cases_waiting'],
        title: 'Case past target ({whoMustAct} to act)',
        dedupe: 'case_past_target:{caseId}',
        deadline: 'now + queue default',
        priority: 'high when Marketly must act, else normal',
        build: (p) => [
          p.whoMustAct !== 'none' && {
            queueKey: 'support.cases_waiting',
            title: `Case past target (${human(p.whoMustAct)} to act)`,
            summary: `The response deadline ${p.dueAt} passed`,
            subject: { type: 'case', id: p.caseId },
            priority: p.whoMustAct === 'marketplace' ? 'high' : 'normal',
            dedupeKey: `case_past_target:${p.caseId}`,
            links: [L('Open case', 'admin/case', p.caseId)],
          },
        ],
      },
    ],
  },
  'support.case.escalated': {
    opens: [
      {
        kind: 'case_escalated',
        queues: ['support.cases_waiting'],
        title: 'Case {ref} escalated to {to}',
        dedupe: 'case_escalated:{caseId}',
        deadline: 'now + queue default',
        priority: 'high; one step higher when escalated again',
        build: (p) => [
          {
            queueKey: 'support.cases_waiting',
            ownerRole: CASE_TEAM_ROLES[p.to] ?? null,
            title: `Case ${p.ref} escalated to ${human(p.to)}`,
            summary: p.reason,
            subject: { type: 'case', id: p.caseId, ref: p.ref },
            related: list(S('order', p.orderId), S('seller', p.sellerId)),
            sellerId: p.sellerId ?? null,
            priority: 'high',
            bumpPriority: true,
            dedupeKey: `case_escalated:${p.caseId}`,
            links: [L('Open case', 'admin/case', p.caseId)],
          },
        ],
      },
    ],
  },
  'support.case.resolved': {
    closes: [{ kinds: ['case_past_target', 'case_escalated'], subjects: (p) => [M('case', p.caseId)], note: (p) => `Case ${p.ref} resolved` }],
  },

  /* ---------------------------------------------------------------- returns */
  'returns.return.escalated': {
    opens: [
      {
        kind: 'return_decision',
        queues: ['returns.decisions'],
        title: 'Return decision needed (seller missed the deadline)',
        dedupe: 'return_decision:{returnId}',
        deadline: 'now + queue default',
        priority: 'high',
        build: (p) => [
          (SELLER_MISSED.has(p.reason) || p.by.kind === 'system') && {
            queueKey: 'returns.decisions',
            title: 'Return decision needed (seller missed the deadline)',
            summary: `Escalated: ${human(p.reason)}`,
            subject: { type: 'return', id: p.returnId },
            related: list(S('order', p.orderId), S('seller', p.sellerId)),
            sellerId: p.sellerId ?? null,
            priority: 'high',
            dedupeKey: `return_decision:${p.returnId}`,
            links: [L('Open return', 'admin/returns', p.returnId)],
          },
        ],
      },
    ],
  },
  'returns.refund.approved': {
    closes: [{ kinds: ['return_decision'], subjects: (p) => [M('return', p.returnId)], note: () => 'Refund approved' }],
  },

  /* ---------------------------------------------------------------- finance, payments */
  'finance.payout.failed': {
    opens: [
      {
        kind: 'payout_failed',
        queues: ['finance.payout_failures'],
        title: 'Payout {ref} failed',
        dedupe: 'payout_failed:{payoutId}',
        deadline: 'now + queue default (business hours)',
        priority: 'high',
        build: (p) => [
          {
            queueKey: 'finance.payout_failures',
            title: `Payout ${p.ref} failed`,
            summary: p.failureReason + (p.failureCode ? ` (${p.failureCode})` : ''),
            subject: { type: 'payout', id: p.payoutId, ref: p.ref },
            related: list(S('seller', p.sellerId)),
            sellerId: p.sellerId,
            amount: p.amount,
            priority: 'high',
            dedupeKey: `payout_failed:${p.payoutId}`,
            links: [L('Open payouts', 'admin/payouts', 'failed')],
          },
        ],
      },
    ],
  },
  'finance.payout.paid': {
    closes: [{ kinds: ['payout_failed'], subjects: (p) => [M('payout', p.payoutId)], note: (p) => `Payout ${p.ref} paid at ${p.paidAt}` }],
  },
  'finance.reconciliation.mismatch_found': {
    opens: [
      {
        kind: 'payment_mismatch',
        queues: ['finance.payment_checks'],
        title: 'Reconciliation mismatch: {check}',
        dedupe: 'payment_mismatch:{itemId}',
        deadline: 'now + queue default (business hours)',
        priority: 'high over $1,000, else normal',
        build: (p) => [
          {
            queueKey: 'finance.payment_checks',
            title: `Reconciliation mismatch: ${human(p.check)}`,
            summary: `Difference of ${(p.difference.amount / 100).toFixed(2)} ${p.difference.currency}`,
            subject: { type: 'reconciliation_check', id: p.itemId, label: human(p.check) },
            amount: { amount: Math.abs(p.difference.amount), currency: p.difference.currency },
            priority: Math.abs(p.difference.amount) > 100_000 ? 'high' : 'normal',
            dedupeKey: `payment_mismatch:${p.itemId}`,
            links: [L('Open finance checks', 'ops/finance-checks')],
          },
        ],
      },
    ],
  },
  'finance.reconciliation.item_closed': {
    closes: [{ kinds: ['payment_mismatch'], subjects: (p) => [M('reconciliation_check', p.itemId)], note: (p) => `Reconciliation item ${p.outcome} (${human(p.check)}, ${p.date})` }],
  },
  'payments.payment.pending_check': {
    opens: [
      {
        kind: 'payment_check',
        queues: ['finance.payment_checks'],
        title: 'Payment status uncertain',
        dedupe: 'payment_check:{intentId}',
        deadline: 'now + queue default (business hours)',
        priority: 'normal',
        build: (p) => [
          {
            queueKey: 'finance.payment_checks',
            title: 'Payment status uncertain',
            summary: `The provider's answer is uncertain since ${p.since}; the status check is running`,
            subject: { type: 'payment', id: p.intentId, label: 'Payment' },
            related: list(S('order', p.orderId)),
            amount: p.amount,
            dedupeKey: `payment_check:${p.intentId}`,
            links: [L('Open finance checks', 'ops/finance-checks')],
          },
        ],
      },
    ],
  },
  'payments.payment.captured': {
    closes: [{ kinds: ['payment_check'], subjects: (p) => [M('payment', p.intentId)], note: () => 'Payment captured' }],
  },
  'payments.payment.failed': {
    closes: [{ kinds: ['payment_check'], subjects: (p) => [M('payment', p.intentId)], note: (p) => `Payment failed (${human(p.declineCategory)}); the customer is told by payments` }],
  },
  'payments.payment.authorized': {
    closes: [{ kinds: ['payment_check'], subjects: (p) => [M('payment', p.intentId)], note: () => 'Payment authorized; capture follows with the order' }],
  },
  'payments.chargeback.opened': {
    opens: [
      {
        kind: 'chargeback',
        queues: ['finance.chargebacks'],
        title: 'Chargeback {ref}',
        dedupe: 'chargeback:{disputeId}',
        deadline: 'event.evidenceDueAt, else queue default',
        priority: 'high',
        build: (p) => [
          {
            queueKey: 'finance.chargebacks',
            title: `Chargeback ${p.ref}`,
            summary: `${human(p.kind)} opened by the provider`,
            subject: { type: 'dispute', id: p.disputeId, ref: p.ref, label: 'Chargeback' },
            related: list(S('order', p.orderId), S('seller', p.sellerId)),
            sellerId: p.sellerId ?? null,
            amount: p.amount,
            dueAt: p.evidenceDueAt ?? null,
            priority: 'high',
            dedupeKey: `chargeback:${p.disputeId}`,
            links: [L('Open order', 'admin/order', p.orderId), L('Open finance', 'admin/finance')],
          },
        ],
      },
    ],
  },

  'payments.chargeback.decided': {
    closes: [{ kinds: ['chargeback'], subjects: (p) => [M('dispute', p.disputeId), M('other', p.disputeId)], note: (p) => `Chargeback ${p.outcome}` }],
  },

  /* ---------------------------------------------------------------- catalog */
  'catalog.product.submitted': {
    opens: [
      {
        kind: 'product_review',
        queues: ['catalog.product_review'],
        title: 'Product to review',
        dedupe: 'product_review:{productId}',
        deadline: 'event.reviewDueAt (catalog review target, business hours), else queue default',
        priority: 'normal',
        build: (p) => [
          {
            queueKey: 'catalog.product_review',
            title: p.ownerSellerId ? 'Seller product to review' : 'Official Store product to review',
            summary: [p.ref, p.kind ? human(p.kind) : null].filter(Boolean).join(', ') || null,
            subject: { type: 'product', id: p.productId, label: p.title || 'Product' },
            related: list(S('seller', p.ownerSellerId)),
            sellerId: p.ownerSellerId ?? null,
            dueAt: p.reviewDueAt ?? null,
            dedupeKey: `product_review:${p.productId}`,
            links: [L('Review product', 'admin/product-review', p.productId)],
          },
        ],
      },
    ],
  },
  'catalog.product.approved': { closes: [{ kinds: ['product_review'], subjects: (p) => product(p.productId), note: () => 'Product approved' }] },
  'catalog.product.changes_requested': { closes: [{ kinds: ['product_review'], subjects: (p) => product(p.productId), note: (p) => `Changes requested: ${p.reason}` }] },
  'catalog.product.rejected': { closes: [{ kinds: ['product_review'], subjects: (p) => product(p.productId), note: (p) => `Product rejected: ${p.reason}` }] },

  /* ---------------------------------------------------------------- sellers */
  'sellers.application.submitted': {
    opens: [
      {
        kind: 'application_waiting',
        queues: ['sellers.applications'],
        title: 'Seller application to review',
        dedupe: 'application:{applicationId}',
        deadline: 'event.decisionTargetAt (the decision target), else queue default (business hours)',
        priority: 'normal (high when invited)',
        build: (p) => [
          {
            queueKey: 'sellers.applications',
            title: 'Seller application to review',
            summary: `${human(p.sellerType)} seller, ${p.categoryIds.length} categor${p.categoryIds.length === 1 ? 'y' : 'ies'}${p.invited ? ', invited' : ''}${p.duplicateCount ? `, ${p.duplicateCount} possible duplicate${p.duplicateCount === 1 ? '' : 's'}` : ''}`,
            subject: { type: 'application', id: p.applicationId, ...(p.ref ? { ref: p.ref } : {}) },
            related: list(S('seller', p.sellerId)),
            sellerId: p.sellerId,
            dueAt: p.decisionTargetAt ?? null,
            priority: p.invited ? 'high' : 'normal',
            dedupeKey: `application:${p.applicationId}`,
            links: [L('Review application', 'admin/seller-application', p.applicationId)],
          },
        ],
      },
    ],
  },
  'sellers.application.information_provided': {
    opens: [
      {
        kind: 'application_waiting',
        queues: ['sellers.applications'],
        title: 'Seller application to review (information provided)',
        dedupe: 'application:{applicationId}',
        deadline: 'now + queue default (business hours)',
        priority: 'normal',
        build: (p) => [
          {
            queueKey: 'sellers.applications',
            title: 'Seller application to review (information provided)',
            summary: 'The applicant answered the information request',
            subject: { type: 'application', id: p.applicationId },
            related: list(S('seller', p.sellerId)),
            sellerId: p.sellerId,
            dedupeKey: `application:${p.applicationId}`,
            wake: true,
            links: [L('Review application', 'admin/seller-application', p.applicationId)],
          },
        ],
      },
    ],
  },
  'sellers.application.decided': {
    closes: [{ kinds: ['application_waiting'], subjects: (p) => [M('application', p.applicationId)], note: (p) => `Application ${p.outcome}` }],
  },
  'sellers.launch_review.requested': {
    opens: [
      {
        kind: 'launch_review',
        queues: ['sellers.launch_reviews'],
        title: 'Launch readiness review',
        dedupe: 'launch_review:{sellerId}',
        deadline: 'now + queue default (business hours)',
        priority: 'normal',
        build: (p) => [
          {
            queueKey: 'sellers.launch_reviews',
            title: 'Launch readiness review',
            subject: { type: 'seller', id: p.sellerId },
            sellerId: p.sellerId,
            dedupeKey: `launch_review:${p.sellerId}`,
            links: [L('Open seller', 'admin/seller', p.sellerId)],
          },
        ],
      },
    ],
  },
  'sellers.launch_review.decided': {
    closes: [{ kinds: ['launch_review'], subjects: (p) => [M('seller', p.sellerId)], note: (p) => `Launch review ${human(p.outcome)}` }],
  },
  'sellers.appeal.submitted': {
    opens: [
      {
        kind: 'appeal_due',
        queues: ['sellers.appeals'],
        title: 'Appeal to decide ({subject})',
        dedupe: 'appeal:{appealId}',
        deadline: 'event.decideBy',
        priority: 'high for a second-level appeal, else normal',
        build: (p) => [
          {
            queueKey: 'sellers.appeals',
            title: `Appeal to decide (${human(p.subject)})`,
            summary: p.level > 1 ? `Level ${p.level} appeal` : null,
            subject: { type: 'appeal', id: p.appealId },
            related: list(S(subjectTypeOf(p.subject), p.subjectId, null, human(p.subject)), S('seller', p.sellerId), S('trust_report', p.trustReportId)),
            sellerId: p.sellerId,
            dueAt: p.decideBy,
            priority: p.level > 1 ? 'high' : 'normal',
            dedupeKey: `appeal:${p.appealId}`,
            links: [L('Open seller', 'admin/seller', p.sellerId)],
          },
        ],
      },
    ],
  },
  'sellers.appeal.decided': {
    closes: [{ kinds: ['appeal_due'], subjects: (p) => [M('appeal', p.appealId)], note: (p) => `Appeal ${human(p.outcome)}` }],
  },
  'sellers.restriction.evidence_submitted': {
    opens: [
      {
        kind: 'restriction_evidence',
        queues: ['sellers.restrictions'],
        title: 'Restriction evidence to review',
        dedupe: 'restriction_evidence:{restrictionId}',
        deadline: 'now + queue default (business hours)',
        priority: 'normal',
        build: (p) => [
          {
            queueKey: 'sellers.restrictions',
            title: 'Restriction evidence to review',
            summary: 'The seller uploaded documents to lift a restriction',
            subject: { type: 'restriction', id: p.restrictionId },
            related: list(S('seller', p.sellerId)),
            sellerId: p.sellerId,
            dedupeKey: `restriction_evidence:${p.restrictionId}`,
            links: [L('Open seller', 'admin/seller', p.sellerId)],
          },
        ],
      },
    ],
  },
  'sellers.restriction.lifted': {
    closes: [{ kinds: ['restriction_evidence', 'restriction_review'], subjects: (p) => [M('restriction', p.restrictionId)], note: (p) => `Restriction lifted: ${p.reason}` }],
  },
  'sellers.restriction.updated': {
    closes: [{ kinds: ['restriction_evidence'], subjects: (p) => [M('restriction', p.restrictionId)], note: (p) => `Evidence reviewed; the restriction was changed (review date ${p.reviewDate})` }],
  },
  /** seller_performance is closed by hand: sellers publishes no back-on-target event */
  'sellers.performance.below_target': {
    opens: [
      {
        kind: 'seller_performance',
        queues: ['sellers.performance'],
        title: 'Seller performance below target',
        dedupe: 'seller_performance:{sellerId}',
        deadline: 'now + queue default (business hours)',
        priority: 'high when overall is poor, else normal',
        build: (p) => [
          {
            queueKey: 'sellers.performance',
            title: 'Seller performance below target',
            summary: `Below target: ${p.metrics.map(human).join(', ')} (overall ${human(p.overall)})`,
            subject: { type: 'seller', id: p.sellerId },
            sellerId: p.sellerId,
            priority: /poor|critical|at_risk/i.test(p.overall) ? 'high' : 'normal',
            dedupeKey: `seller_performance:${p.sellerId}`,
            links: [L('Open seller', 'admin/seller', p.sellerId)],
          },
        ],
      },
    ],
  },
  'sellers.change_request.submitted': {
    opens: [
      {
        kind: 'storefront_review',
        queues: ['sellers.launch_reviews'],
        title: 'Store change to review ({kind})',
        dedupe: 'change_request:{changeRequestId}',
        deadline: 'now + queue default (business hours)',
        priority: 'normal',
        build: (p) => [
          {
            queueKey: 'sellers.launch_reviews',
            title: `Store change to review (${human(p.kind)})`,
            subject: { type: 'change_request', id: p.changeRequestId, label: human(p.kind) },
            related: list(S('seller', p.sellerId)),
            sellerId: p.sellerId,
            dedupeKey: `change_request:${p.changeRequestId}`,
            links: [L('Open seller', 'admin/seller', p.sellerId)],
          },
        ],
      },
    ],
  },
  'sellers.change_request.decided': {
    closes: [{ kinds: ['storefront_review'], subjects: (p) => [M('change_request', p.changeRequestId)], note: (p) => (p.approved ? 'Change approved' : 'Change rejected') }],
  },

  /* ---------------------------------------------------------------- trust */
  'trust.report.created': {
    opens: [
      {
        kind: 'trust_report',
        queues: ['trust.reports'],
        title: 'Trust report {ref}: {type}',
        dedupe: 'trust_report:{reportId}',
        deadline: 'now + queue default',
        priority: 'from risk score: 80+ urgent, 60+ high, 30+ normal, else low',
        build: (p) => [
          {
            queueKey: 'trust.reports',
            title: `Trust report ${p.ref}: ${human(p.type)}`,
            summary: `Source ${human(p.source)}, risk score ${p.riskScore}`,
            subject: { type: 'trust_report', id: p.reportId, ref: p.ref, label: human(p.type) },
            priority: riskPriority(p.riskScore),
            dedupeKey: `trust_report:${p.reportId}`,
            links: [L('Open report', 'admin/trust', p.reportId)],
          },
        ],
      },
    ],
  },
  'trust.report.resolved': {
    closes: [{ kinds: ['trust_report'], subjects: (p) => [M('trust_report', p.reportId)], note: (p) => `Report ${human(p.outcome)}` }],
  },
  'trust.recommendation.routed': {
    opens: [
      {
        kind: 'trust_recommendation',
        queues: TRUST_QUEUES,
        title: 'Trust recommendation: {action}',
        dedupe: 'trust_recommendation:{recommendationId}',
        deadline: 'now + queue default',
        priority: 'high',
        build: (p) => [
          {
            queueKey: TRUST_TEAM_QUEUES[p.ownerTeam] ?? 'trust.reports',
            ownerRole: p.ownerRole || null,
            title: `Trust recommendation: ${human(p.action)}`,
            summary: `Routed to ${human(p.ownerTeam)} to accept or decline`,
            subject: { type: 'recommendation', id: p.recommendationId, label: human(p.action) },
            related: list(S('trust_report', p.reportId)),
            priority: 'high',
            dedupeKey: `trust_recommendation:${p.recommendationId}`,
            links: [L('Open report', 'admin/trust', p.reportId)],
          },
        ],
      },
    ],
  },
  'trust.recommendation.decided': {
    closes: [{ kinds: ['trust_recommendation'], subjects: (p) => [M('recommendation', p.recommendationId)], note: (p) => `Recommendation ${human(p.state)}` }],
  },

  /* ---------------------------------------------------------------- messaging, customers */
  'messaging.reply.overdue': {
    opens: [
      {
        kind: 'seller_reply_overdue',
        queues: ['sellers.performance'],
        title: 'Seller reply overdue (skipped for the Official Store: messaging raises official_store_reply)',
        dedupe: 'reply_overdue:{conversationId}',
        deadline: 'now + queue default',
        priority: 'normal',
        build: (p) => [
          !p.officialStore && {
            queueKey: 'sellers.performance',
            title: 'Reply to the customer message',
            summary: `The reply target ${p.dueAt} passed`,
            subject: { type: 'conversation', id: p.conversationId, label: 'Conversation' },
            related: list(S('order', p.orderId), S('seller', p.sellerId)),
            sellerId: p.sellerId,
            dedupeKey: `reply_overdue:${p.conversationId}`,
            visibleToSeller: true,
            links: [L('Open seller', 'admin/seller', p.sellerId)],
          },
        ],
      },
    ],
  },
  'messaging.message.sent': {
    closes: [{ kinds: ['seller_reply_overdue'], subjects: (p) => (p.authorKind === 'seller' ? [M('conversation', p.conversationId), M('other', p.conversationId)] : []), note: () => 'The seller replied' }],
  },
  'customers.data_export.requested': {
    opens: [
      {
        kind: 'data_request',
        queues: ['customers.data_requests'],
        title: 'Customer data export requested',
        dedupe: 'data_request:{requestId}',
        deadline: 'now + queue default (the promised delivery time)',
        priority: 'normal',
        build: (p) => [
          {
            queueKey: 'customers.data_requests',
            title: 'Customer data export requested',
            subject: { type: 'data_request', id: p.requestId },
            related: list(S('customer', p.customerId)),
            customerId: p.customerId,
            dedupeKey: `data_request:${p.requestId}`,
            links: [L('Open customer', 'admin/customers', p.customerId)],
          },
        ],
      },
    ],
  },
  'customers.data_export.ready': {
    closes: [{ kinds: ['data_request'], subjects: (p) => [M('data_request', p.requestId)], note: () => 'Export ready and sent to the customer' }],
  },

  /* ---------------------------------------------------------------- warehouse (raise() opens; unexpected_return_parcel is closed by hand) */
  'warehouse.return_parcel.received': {
    closes: [{ kinds: ['return_parcel_overdue'], subjects: (p) => [M('return_parcel', p.parcelId), M('other', p.parcelId), M('return', p.returnId)], note: (p) => `Parcel received at ${p.receivedAt} (${human(p.parcelCondition)})` }],
  },

  /* ---------------------------------------------------------------- reviews (raise() opens review_moderation_overdue) */
  'reviews.moderation.decided': {
    closes: [
      {
        kinds: ['review_moderation_overdue'],
        subjects: (p) => [M('moderation_item', p.moderationItemId)],
        dedupeKeys: (p) => [`review_moderation_overdue:${p.moderationItemId}`],
        note: (p) => `Moderation decided: ${human(p.decision)}`,
      },
    ],
  },
};

/* ------------------------------------------------------------------ rules for GET /intake-rules */

export interface IntakeRuleDoc {
  event: string;
  queueKey: string;
  kind: Kind;
  titleTemplate: string;
  dedupeKeyTemplate: string;
  deadline: string;
  priority: string;
  resolvesOn: string[];
}

/** Events that close items of each kind (derived from the closes of the table) */
export function resolvesOnByKind(): Map<Kind, string[]> {
  const out = new Map<Kind, string[]>();
  for (const [event, entry] of Object.entries(INTAKE) as [string, IntakeEntry<unknown>][]) {
    for (const c of entry.closes ?? []) for (const k of c.kinds) out.set(k, [...new Set([...(out.get(k) ?? []), event])]);
  }
  return out;
}

export function intakeRuleDocs(): IntakeRuleDoc[] {
  const resolves = resolvesOnByKind();
  const docs: IntakeRuleDoc[] = [];
  for (const [event, entry] of Object.entries(INTAKE) as [string, IntakeEntry<unknown>][]) {
    for (const o of entry.opens ?? []) {
      for (const queueKey of o.queues) {
        docs.push({ event, queueKey, kind: o.kind, titleTemplate: o.title, dedupeKeyTemplate: o.dedupe, deadline: o.deadline, priority: o.priority, resolvesOn: resolves.get(o.kind) ?? [] });
      }
    }
  }
  return docs;
}

/** Every queue an intake rule may raise into (installed with the seed queues) */
export const intakeQueueKeys = () => [...new Set(intakeRuleDocs().map((r) => r.queueKey))];
