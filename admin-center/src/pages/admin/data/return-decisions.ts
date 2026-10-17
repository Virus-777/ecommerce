// Staff decisions on one return in the Admin › Returns drawer (review §2a #7). Which ones a return offers comes from
// its `allowedActions` (backend returns/service/views.ts allowedActions, admin area); this file maps each to the
// permission it needs, its button and the wording shown after it is done.
// Endpoints: POST /api/admin/returns/requests/{id}/approve | reject | take-over | overturn | assign | receive |
// request-info | approve-without-return, and POST /api/admin/returns/replacements/{id}/cancel.
import type { IconName } from '@marketly/web-shared/ui';
import { REFUND_LABEL } from './returns';

/** The drawer's forms. 'exception' is the refund-without-return form (allowed action "approve-without-return"). */
export type DecisionAction = 'approve' | 'reject' | 'request-info' | 'take-over' | 'overturn' | 'assign' | 'receive' | 'cancel-replacement' | 'exception';

interface ActionMeta {
  /** The allowedActions entry that turns it on (cancel-replacement is decided from the replacement's status). */
  allowed: string | null;
  permission: string;
  label: string;
  icon: IconName;
  /** Button on the form that sends it. */
  confirm: string;
  variant: 'primary' | 'secondary' | 'danger';
}

export const DECISION_ACTIONS: Record<DecisionAction, ActionMeta> = {
  approve: { allowed: 'approve', permission: 'returns.requests.manage', label: 'Approve return', icon: 'check', confirm: 'Approve and issue label', variant: 'primary' },
  reject: { allowed: 'reject', permission: 'returns.requests.manage', label: 'Reject', icon: 'x', confirm: 'Reject return', variant: 'danger' },
  'request-info': { allowed: 'request-info', permission: 'returns.requests.manage', label: 'Ask the customer', icon: 'message-square', confirm: 'Send question', variant: 'primary' },
  'take-over': { allowed: 'take-over', permission: 'returns.requests.manage', label: 'Take over from seller', icon: 'shield', confirm: 'Take over', variant: 'primary' },
  overturn: { allowed: 'overturn', permission: 'returns.requests.manage', label: 'Overturn rejection', icon: 'undo-2', confirm: 'Overturn and approve', variant: 'primary' },
  assign: { allowed: 'assign', permission: 'returns.requests.manage', label: 'Assign', icon: 'user-round', confirm: 'Assign', variant: 'primary' },
  receive: { allowed: 'receive', permission: 'returns.inspections.record', label: 'Mark received', icon: 'package', confirm: 'Record receipt', variant: 'primary' },
  'cancel-replacement': { allowed: null, permission: 'returns.requests.manage', label: 'Cancel replacement', icon: 'circle-x', confirm: 'Cancel replacement', variant: 'danger' },
  exception: { allowed: 'approve-without-return', permission: 'returns.exceptions.propose', label: 'Refund without return', icon: 'send', confirm: 'Send to Finance', variant: 'primary' },
};

/** Order of the buttons in the drawer. */
export const ACTION_ORDER: DecisionAction[] = ['approve', 'reject', 'request-info', 'overturn', 'take-over', 'receive', 'exception', 'cancel-replacement', 'assign'];

export type LabelMethod = 'prepaid_qr' | 'prepaid_label' | 'customer_arranged';
export const LABEL_METHODS: Array<{ value: LabelMethod; label: string }> = [
  { value: 'prepaid_qr', label: 'Prepaid QR code (drop-off)' },
  { value: 'prepaid_label', label: 'Prepaid printable label' },
  { value: 'customer_arranged', label: 'Customer arranges and pays shipping' },
];

export type RejectCode = 'outside_window' | 'item_not_eligible' | 'damaged_by_customer' | 'other';
export const REJECT_REASONS: Array<{ value: RejectCode; label: string }> = [
  { value: 'outside_window', label: 'Outside the return window' },
  { value: 'item_not_eligible', label: 'Item not eligible for return' },
  { value: 'damaged_by_customer', label: 'Damaged by the customer' },
  { value: 'other', label: 'Other' },
];

export type TakeOverReason = 'seller_no_response' | 'seller_missed_inspection' | 'customer_disagrees' | 'refund_late' | 'other';
export const TAKE_OVER_REASONS: Array<{ value: TakeOverReason; label: string }> = [
  { value: 'seller_no_response', label: 'Seller did not respond' },
  { value: 'seller_missed_inspection', label: 'Seller missed the inspection deadline' },
  { value: 'customer_disagrees', label: 'Customer disagrees with the seller' },
  { value: 'refund_late', label: 'Refund is late' },
  { value: 'other', label: 'Other' },
];

/** Replacements not shipped yet can still be cancelled (backend replacement machine: pending|reserved → cancelled). */
export const CANCELLABLE_REPLACEMENT = new Set(['pending', 'reserved']);

/** Allowed actions that live on the Return inspection screen, not in this drawer. */
export const INSPECTION_ACTIONS = ['start-inspection', 'inspection', 'remedy'];

/** Success line after each decision (the refund-without-return line comes from refundOutcome). */
export const DONE: Record<Exclude<DecisionAction, 'exception'>, (ref: string) => string> = {
  approve: (r) => `${r} approved. The customer gets the return label and drop-off details.`,
  reject: (r) => `${r} rejected. The customer sees the reason.`,
  'request-info': (r) => `Asked the customer for more information on ${r}.`,
  'take-over': (r) => `Marketly now handles ${r}. The seller and the customer see the change.`,
  overturn: (r) => `The rejection of ${r} is overturned and the return approved.`,
  assign: (r) => `${r} assigned.`,
  receive: (r) => `${r} recorded as received. It can be inspected now.`,
  'cancel-replacement': (r) => `Replacement on ${r} cancelled. The return waits for a refund instead.`,
};

interface RefundLike {
  ref?: string;
  status: string;
  approval?: { required?: boolean; reason?: string | null; approvers?: string[] | string | null } | null;
}

/**
 * What happened to the money after refund without return, from the refund the API answered with. Staff refunds
 * usually stay "Under review" until Finance approves them; a replacement remedy creates no refund.
 */
export function refundOutcome(ref: string, rr: RefundLike | null | undefined): string {
  if (!rr) return `${ref}: approved without return. No refund was created.`;
  const refund = rr.ref ? `Refund ${rr.ref}` : 'The refund';
  const approvers = Array.isArray(rr.approval?.approvers) ? rr.approval.approvers.join(' or ') : rr.approval?.approvers;
  const why = rr.approval?.reason ? ` ${rr.approval.reason}.` : '';
  switch (rr.status) {
    case 'under_review':
    case 'requested':
      return `${ref}: approved without return. ${refund} is ${REFUND_LABEL[rr.status].toLowerCase()} and waits for Finance approval.${why}${approvers ? ` Approver: ${approvers}.` : ''} The customer sees "Refund requested" until the money is sent.`;
    case 'approved':
    case 'processing':
      return `${ref}: approved without return. ${refund} is approved and handed to payments.`;
    case 'sent':
      return `${ref}: approved without return. ${refund} is sent.`;
    default:
      return `${ref}: approved without return. ${refund} is ${(REFUND_LABEL[rr.status] ?? rr.status).toLowerCase()}.`;
  }
}
