/**
 * Delivery exceptions (plan ch. 12): the required response per kind, the default next step and who acts.
 */
export type ExceptionKind = 'seller_cannot_fulfill' | 'late_dispatch' | 'missing_tracking' | 'lost_or_damaged' | 'failed_delivery';
export const EXCEPTION_KINDS: ExceptionKind[] = ['seller_cannot_fulfill', 'late_dispatch', 'missing_tracking', 'lost_or_damaged', 'failed_delivery'];
export const OPEN_STATUSES = ['open', 'in_progress', 'escalated'];

export const REQUIRED_RESPONSE: Record<ExceptionKind, string> = {
  seller_cannot_fulfill: 'Flag the items, notify the customer and apply the cancellation and refund policy',
  late_dispatch: 'Overdue task: notify the seller and offer the customer support escalation',
  missing_tracking: 'Request valid tracking details; never imply delivery',
  lost_or_damaged: 'Open a case with the item, carrier details and the agreed remedy (a carrier claim may follow)',
  failed_delivery: 'Show the customer redelivery, pickup or return steps and their costs',
};

export const KIND_LABEL: Record<ExceptionKind, string> = {
  seller_cannot_fulfill: 'Seller cannot fulfill',
  late_dispatch: 'Late dispatch',
  missing_tracking: 'Missing tracking',
  lost_or_damaged: 'Lost or damaged',
  failed_delivery: 'Failed delivery',
};

export const DEFAULT_NEXT_STEP: Record<ExceptionKind, string> = {
  seller_cannot_fulfill: 'Cancel the items and refund the customer',
  late_dispatch: 'Remind the seller; offer the customer to wait or cancel',
  missing_tracking: 'Ask the seller for valid tracking',
  lost_or_damaged: 'Agree a remedy with the customer (replacement or refund)',
  failed_delivery: 'Wait for the customer to choose redelivery, pickup or return',
};

/**
 * Fulfilled by Marketly packages: Marketly's warehouse ships them, so the Shipping Manager owns the exception and the
 * seller is never asked to act (no seller notice, no seller response). Kinds not listed keep DEFAULT_NEXT_STEP.
 */
export const MARKETLY_NEXT_STEP: Partial<Record<ExceptionKind, string>> = {
  late_dispatch: 'Fulfilled by Marketly (warehouse): ship the package; offer the customer to wait or cancel',
  missing_tracking: 'Fulfilled by Marketly (warehouse): check the label and carrier hand-over',
};

export const MARKETLY_REQUIRED_RESPONSE: Partial<Record<ExceptionKind, string>> = {
  late_dispatch: 'Overdue task for the Marketly warehouse: dispatch it and offer the customer support escalation',
  missing_tracking: 'The Marketly warehouse confirms valid tracking; never imply delivery',
};

/** What the customer may do, for the shipping.shipment.exception event (null: nothing asked of them) */
export const CUSTOMER_ACTION: Record<ExceptionKind, string | null> = {
  seller_cannot_fulfill: null,
  late_dispatch: 'Wait, cancel the items or contact support',
  missing_tracking: null,
  lost_or_damaged: 'Tell us whether you want a replacement or a refund',
  failed_delivery: 'Choose redelivery, pickup or return to the seller',
};

export const ESCALATION_LABEL: Record<string, string> = {
  seller_manager: 'Seller Manager',
  support: 'Customer Support',
  finance: 'Finance',
  returns: 'Returns',
};

export const RESOLUTION_LABEL: Record<string, string> = {
  shipped: 'Shipped',
  tracking_provided: 'Tracking provided',
  cancelled_refunded: 'Cancelled and refunded',
  replacement_sent: 'Replacement sent',
  redelivered: 'Redelivered',
  picked_up: 'Picked up',
  returned_to_seller: 'Returned to seller',
  claim_filed: 'Carrier claim filed',
  no_action: 'No action needed',
};

export const RESPONSE_LABEL: Record<string, string> = {
  tracking_provided: 'Seller provided tracking',
  will_ship_by: 'Seller promised a ship-by date',
  cannot_fulfill: 'Seller cannot fulfill',
  replacement_sent: 'Seller sent a replacement',
  other: 'Seller replied',
};

/** Customer-facing hours for each exception kind's first deadline */
export const FIRST_DEADLINE_HOURS: Record<ExceptionKind, number> = {
  seller_cannot_fulfill: 24,
  late_dispatch: 24,
  missing_tracking: 24,
  lost_or_damaged: 48,
  failed_delivery: 24 * 14,
};
