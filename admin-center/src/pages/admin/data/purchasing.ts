import type { components } from '@marketly/web-shared/api';

// Admin Suppliers and purchasing (design: pages/admin/admin-purchasing*.html), fed by
// GET /api/admin/purchasing/summary, /suppliers, /purchase-orders, /reorder-suggestions.

export type Supplier = components['schemas']['purchasing.Supplier'];
export type SupplierItem = components['schemas']['purchasing.SupplierItem'];
export type PurchaseOrder = components['schemas']['purchasing.PurchaseOrder'];
export type PurchaseOrderRow = components['schemas']['purchasing.PurchaseOrderRow'];
export type ReorderSuggestion = components['schemas']['purchasing.ReorderSuggestion'];
export type PoStatusKey = PurchaseOrder['status'];

export const PO_STATUS_LABEL: Record<PoStatusKey, string> = {
  draft: 'Draft',
  sent: 'Sent',
  partly_received: 'Partly received',
  received: 'Received',
  cancelled: 'Cancelled',
};
export const STATUS_FILTERS: Array<{ value: '' | PoStatusKey; label: string }> = [
  { value: '', label: 'All statuses' },
  { value: 'draft', label: 'Draft' },
  { value: 'sent', label: 'Sent' },
  { value: 'partly_received', label: 'Partly received' },
  { value: 'received', label: 'Received' },
];

/** A draft waiting for the approver shows "In review". */
export const poStatusLabel = (status: PoStatusKey, approval?: { required: boolean; approvalRequestId?: string | null } | null) =>
  status === 'draft' && approval?.required && approval.approvalRequestId ? 'In review' : PO_STATUS_LABEL[status];

/** On-time % below this is shown in warning colour. */
export const ON_TIME_WARN = 90;

/** The PO send limit (minor units) of the staff member's roles: null = no limit, 0 = not permitted. */
export function poLimit(limits: Array<{ action: { key: string }; value: { authority: string; limitMoney?: { amount: number } | null } }> | undefined): number | null {
  const mine = (limits ?? []).filter((l) => l.action.key === 'purchasing.orders.send' && l.value.authority === 'permitted');
  if (!mine.length) return 0;
  if (mine.some((l) => l.value.limitMoney == null)) return null;
  return Math.max(...mine.map((l) => l.value.limitMoney?.amount ?? 0));
}
