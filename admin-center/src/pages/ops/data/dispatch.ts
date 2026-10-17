import type { IconName } from '@marketly/web-shared/ui';

// Tab and action definitions for pages/ops/Dispatch.tsx (design: pages/ops/ops-dispatch*.html).
// The rows come from GET /api/admin/shipping/exceptions.

export type DispatchView = '' | 'seller-cannot-fulfill' | 'missing-tracking' | 'lost-or-damaged' | 'delivery-failed';
export type ExceptionKind = 'seller_cannot_fulfill' | 'late_dispatch' | 'missing_tracking' | 'lost_or_damaged' | 'failed_delivery';
export type ActionKey = 'contact' | 'notify' | 'escalate' | 'cancel' | 'track' | 'claim';

export const ACTIONS: Record<ActionKey, { label: string; icon: IconName }> = {
  contact: { label: 'Contact customer', icon: 'message-square' },
  notify: { label: 'Notify seller', icon: 'bell' },
  escalate: { label: 'Escalate to Seller Manager', icon: 'arrow-up-right' },
  cancel: { label: 'Cancel item and refund', icon: 'circle-x' },
  track: { label: 'Request tracking', icon: 'scan-line' },
  claim: { label: 'Open carrier claim', icon: 'file-plus' },
};

export interface DispatchTab {
  view: DispatchView;
  kind: ExceptionKind;
  /** Key in GET shipping/exceptions/counts. */
  countKey: 'sellerCannotFulfill' | 'lateDispatch' | 'missingTracking' | 'lostOrDamaged' | 'failedDelivery';
  label: string;
  icon: IconName;
  response: string;
}

export const TABS: DispatchTab[] = [
  { view: 'seller-cannot-fulfill', kind: 'seller_cannot_fulfill', countKey: 'sellerCannotFulfill', label: 'Seller cannot fulfill', icon: 'package-x', response: 'Flag the affected items, notify the customer and apply the cancellation and refund policy.' },
  { view: '', kind: 'late_dispatch', countKey: 'lateDispatch', label: 'Late dispatch', icon: 'alarm-clock', response: 'Create an overdue task, notify the seller and offer customer support escalation.' },
  { view: 'missing-tracking', kind: 'missing_tracking', countKey: 'missingTracking', label: 'Missing tracking', icon: 'scan-line', response: 'Request valid details and avoid implying the package has been delivered.' },
  { view: 'lost-or-damaged', kind: 'lost_or_damaged', countKey: 'lostOrDamaged', label: 'Lost or damaged', icon: 'package-minus', response: 'Open a case with the item, carrier information and agreed customer remedy.' },
  { view: 'delivery-failed', kind: 'failed_delivery', countKey: 'failedDelivery', label: 'Delivery failed', icon: 'house', response: 'Show next delivery, pickup or return steps and any applicable costs.' },
];

/** Resolution kinds (POST shipping/exceptions/{id}/resolve), the ones that fit each exception kind first. */
export const RESOLUTIONS: Record<ExceptionKind, Array<{ value: string; label: string }>> = {
  seller_cannot_fulfill: [
    { value: 'cancelled_refunded', label: 'Cancelled and refunded' },
    { value: 'shipped', label: 'Seller shipped after all' },
    { value: 'no_action', label: 'No action needed' },
  ],
  late_dispatch: [
    { value: 'shipped', label: 'Shipped' },
    { value: 'cancelled_refunded', label: 'Cancelled and refunded' },
    { value: 'no_action', label: 'No action needed' },
  ],
  missing_tracking: [
    { value: 'tracking_provided', label: 'Valid tracking provided' },
    { value: 'cancelled_refunded', label: 'Cancelled and refunded' },
    { value: 'no_action', label: 'No action needed' },
  ],
  lost_or_damaged: [
    { value: 'replacement_sent', label: 'Replacement sent' },
    { value: 'cancelled_refunded', label: 'Refunded' },
    { value: 'claim_filed', label: 'Carrier claim filed' },
    { value: 'no_action', label: 'No action needed' },
  ],
  failed_delivery: [
    { value: 'redelivered', label: 'Redelivered' },
    { value: 'picked_up', label: 'Picked up by the customer' },
    { value: 'returned_to_seller', label: 'Returned to the seller' },
    { value: 'cancelled_refunded', label: 'Refunded' },
    { value: 'no_action', label: 'No action needed' },
  ],
};

export const SELLER_FILTERS = [
  { value: 'all', label: 'All sellers' },
  { value: 'official', label: 'Official Store' },
  { value: 'marketplace', label: 'Marketplace sellers' },
];

/** Carrier claim statuses as the design labels them. */
export const CLAIM_STATUS: Record<string, string> = {
  draft: 'Pending',
  submitted: 'Submitted',
  under_review: 'Under review',
  paid: 'Paid',
  rejected: 'Rejected',
  withdrawn: 'Withdrawn',
};

/** The seller's answer to an exception (shipping.SellerResponse.action) as staff read it. */
export const SELLER_RESPONSE: Record<string, string> = {
  tracking_provided: 'Tracking provided',
  will_ship_by: 'Will ship by',
  cannot_fulfill: 'Cannot fulfill',
  replacement_sent: 'Replacement sent',
  other: 'Replied',
};
