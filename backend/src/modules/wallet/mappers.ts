/** Rows (snake_case, minor units) → API types (camelCase, Money). One place per type. */
import type * as common from '../../spec/common.js';
import type { CreditCorrection, CreditHold, CreditLot, GiftCard, GoodwillGrant, LedgerEntry } from '../../spec/wallet.js';
import { actorFrom, allocated, caseRefOf, entryLabel, m, SYSTEM, type EntryKind, type LotSource } from './domain/rules.js';
import type { CorrectionRow, EntryRow, GiftCardRow, GrantRow, HoldRow, LotAllocation, LotRow } from './ports.js';

export const iso = (d: Date | null | undefined) => (d ? new Date(d).toISOString() : null);

export const toHold = (h: HoldRow, currency: string): CreditHold => ({
  id: h.id,
  customerId: h.customer_id,
  quoteId: h.quote_id,
  orderId: h.order_id,
  amount: m(h.amount, currency),
  state: h.state as CreditHold['state'],
  expiresAt: iso(h.expires_at)!,
});

export const toLot = (l: LotRow, currency: string): CreditLot => ({
  id: l.id,
  source: l.source as LotSource,
  original: m(l.original, currency),
  remaining: m(l.remaining, currency),
  expiresAt: iso(l.expires_at),
  createdAt: iso(l.created_at)!,
  reference: l.reference,
});

export const allocationsOf = (e: EntryRow): LotAllocation[] => (Array.isArray(e.lot_allocations) ? (e.lot_allocations as unknown as LotAllocation[]) : []);

export const entryActor = (e: EntryRow): common.Actor | null => (e.actor_kind === 'system' && !e.actor_id ? null : { kind: e.actor_kind as common.Actor['kind'], id: e.actor_id });

/** What labels need beyond the row: refs from other modules and the lot/grant behind a credit */
export interface EntryFacts {
  orderRefs: Map<string, string>;
  /** lot id → reference ("case CS-…", "gift card ••••7KQ2") */
  lotRefs: Map<string, string | null>;
  /** ledger entry id → goodwill reason code */
  reasonCodes: Map<string, string>;
  /** case id → case reference */
  caseRefs: Map<string, string>;
}

export function toEntry(e: EntryRow, currency: string, facts: EntryFacts, o: { staff: boolean }): LedgerEntry {
  const allocations = allocationsOf(e);
  const reference = allocations[0] ? (facts.lotRefs.get(allocations[0].lotId) ?? null) : null;
  const orderRef = e.order_id ? (facts.orderRefs.get(e.order_id) ?? null) : null;
  const caseRef = (e.case_id ? facts.caseRefs.get(e.case_id) : undefined) ?? caseRefOf(reference);
  const kind = e.kind as EntryKind;
  const shown = kind === 'hold' || kind === 'release' ? allocated(allocations) : e.amount;
  return {
    id: e.id,
    at: iso(e.at)!,
    kind,
    amount: m(e.amount, currency),
    balanceAfter: m(e.balance_after, currency),
    label: entryLabel({ kind, amount: m(shown, currency), orderRef, caseRef, reference, reasonCode: facts.reasonCodes.get(e.id) ?? null }),
    orderId: e.order_id,
    orderRef,
    caseRef,
    refundId: e.refund_id,
    actor: o.staff ? entryActor(e) : null,
    reason: o.staff ? e.reason : null,
  };
}

export interface GrantFacts {
  names: Map<string, string>;
  orderRefs: Map<string, string>;
  caseRefs: Map<string, string>;
  approvals: Map<string, common.ApprovalInfo>;
  /** ledger entry id → when the credit was added */
  grantedAt: Map<string, Date>;
}

export const toGrant = (g: GrantRow, f: GrantFacts): GoodwillGrant => ({
  id: g.id,
  customerId: g.customer_id,
  customerName: f.names.get(g.customer_id) ?? null,
  amount: m(g.amount, g.currency),
  reason: g.reason,
  reasonCode: g.reason_code,
  caseRef: g.case_id ? (f.caseRefs.get(g.case_id) ?? null) : null,
  orderRef: g.order_id ? (f.orderRefs.get(g.order_id) ?? null) : null,
  chargedTo: g.charged_to as GoodwillGrant['chargedTo'],
  sellerId: g.seller_id,
  state: g.state as GoodwillGrant['state'],
  approval: g.approval_request_id ? (f.approvals.get(g.approval_request_id) ?? { required: true, approvalRequestId: g.approval_request_id, approvers: [] }) : null,
  requestedBy: actorFrom(g.requested_by) ?? SYSTEM,
  decidedBy: actorFrom(g.decided_by),
  createdAt: iso(g.created_at)!,
  grantedAt: g.ledger_entry_id ? iso(f.grantedAt.get(g.ledger_entry_id)) : null,
  ledgerEntryId: g.ledger_entry_id,
});

export const toCorrection = (c: CorrectionRow, f: { approvals: Map<string, common.ApprovalInfo>; entries: Map<string, LedgerEntry> }): CreditCorrection => ({
  id: c.id,
  customerId: c.customer_id,
  amount: m(c.amount, c.currency),
  reason: c.reason,
  reference: c.reference,
  state: c.state,
  approval: c.approval_request_id ? (f.approvals.get(c.approval_request_id) ?? { required: true, approvalRequestId: c.approval_request_id, approvers: [] }) : null,
  entry: c.ledger_entry_id ? (f.entries.get(c.ledger_entry_id) ?? null) : null,
  failure: c.failure,
  requestedBy: actorFrom(c.requested_by) ?? SYSTEM,
  decidedBy: actorFrom(c.decided_by),
  createdAt: iso(c.created_at)!,
  decidedAt: iso(c.decided_at),
});

export const toGiftCard =(c: GiftCardRow): GiftCard => ({
  id: c.id,
  codeLast4: c.code_last4,
  batchId: c.batch_id,
  initial: m(c.initial, c.currency),
  remaining: m(c.remaining, c.currency),
  state: c.state as GiftCard['state'],
  purpose: c.purpose as GiftCard['purpose'],
  expiresAt: iso(c.expires_at),
  redeemedBy: c.redeemed_by,
  redeemedAt: iso(c.redeemed_at),
  createdBy: actorFrom(c.created_by) ?? SYSTEM,
  createdAt: iso(c.created_at)!,
});
