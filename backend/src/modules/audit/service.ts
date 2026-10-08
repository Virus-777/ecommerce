import { notImplemented } from '../../kernel/errors/index.js';
import type { EventPayload } from '../../kernel/events/index.js';
import type { ModuleContext } from '../../kernel/module-system/index.js';
import type * as common from '../../spec/common.js';
import type * as identity from '../../spec/identity.js';
import type { AuditPublicApi, AuditEntry, RecordInput, AuditFilters } from '../../spec/audit.js';
import type { AuditRepository } from './ports.js';

export interface AuditServiceDeps {
  repo: AuditRepository;
  ctx: ModuleContext<'audit'>;
}

/**
 * Action history use cases. Depends only on ports, the event bus, the clock and other modules' public APIs.
 * Each method maps to a publicApi function, a consumed event or a job in docs/api/spec/modules/audit.json.
 */
export class AuditService implements AuditPublicApi {
  readonly #deps: AuditServiceDeps;

  constructor(deps: AuditServiceDeps) {
    this.#deps = deps;
  }

  protected get deps(): AuditServiceDeps {
    return this.#deps;
  }

  /* ---------------- public API (in-process) */

  /** Append one entry. Call it inside the same transaction as the change (outbox once introduced), so a change is never saved without its history. Roles are resolved through access.rolesOf when the actor is staff and actorRoles is omitted. */
  async record(entry: RecordInput): Promise<string> {
    throw notImplemented('audit.record');
  }

  /** Bulk actions (bulk catalog edit, payout run items) in one call */
  async recordMany(entries: RecordInput[]): Promise<string[]> {
    throw notImplemented('audit.recordMany');
  }

  /** Staff history for a record, embedded in other modules' admin detail responses (order, seller, payout) */
  async historyOf(targetType: string, targetId: string, limit?: number): Promise<AuditEntry[]> {
    throw notImplemented('audit.historyOf');
  }

  /** Batched, paged history per record for the Action history card on admin 360 views (order, seller, customer, payout run). includeRelated also matches entries where the record is one of relatedTargets. Newest first. */
  async trailOf(targetType: string, targetIds: string[], opts: { includeRelated?: boolean, category?: string, page?: common.PageInput }): Promise<Map<string, common.Page<AuditEntry>>> {
    throw notImplemented('audit.trailOf');
  }

  /** The action history with filters, newest first (same as GET /entries) */
  async searchEntries(filters: AuditFilters, page: common.PageInput): Promise<common.Page<AuditEntry>> {
    throw notImplemented('audit.searchEntries');
  }

  /** One entry with before/after and approval */
  async getEntry(entryId: string): Promise<AuditEntry | null> {
    throw notImplemented('audit.getEntry');
  }

  /** Export rows for reports dataset audit.admin.entries (filters are AuditFilters; values are already redacted at record time) */
  async exportRows(dataset: string, filters: unknown, principal: identity.Principal, cursor?: string): Promise<{ rows: unknown[], nextCursor?: string }> {
    throw notImplemented('audit.exportRows');
  }

  /* ---------------- events consumed */

  /** access.approval.requested: Create or reset the approval_states row (pending, awaiting the eligible reviewers) */
  async onApprovalRequestedFromAccess(event: EventPayload<"access.approval.requested">): Promise<void> {
    void event;
    throw notImplemented('audit consumer of access.approval.requested');
  }

  /** access.approval.partially_approved: Add the first approval to approval_states (still pending a second reviewer) */
  async onApprovalPartiallyApprovedFromAccess(event: EventPayload<"access.approval.partially_approved">): Promise<void> {
    void event;
    throw notImplemented('audit consumer of access.approval.partially_approved');
  }

  /** access.approval.returned: Mark the approval state returned with the comment */
  async onApprovalReturnedFromAccess(event: EventPayload<"access.approval.returned">): Promise<void> {
    void event;
    throw notImplemented('audit consumer of access.approval.returned');
  }

  /** access.approval.decided: Set the final approval state and decision time; for audit.retention.change apply or drop the pending retention change */
  async onApprovalDecidedFromAccess(event: EventPayload<"access.approval.decided">): Promise<void> {
    void event;
    throw notImplemented('audit consumer of access.approval.decided');
  }

  /* ---------------- jobs */

  /** Job audit.verify-chain (daily 03:00 market time): Recompute hashes from the last verified seq; on mismatch publish audit.integrity.failed (Platform Administrator and Business Owner are notified) */
  async verifyChain(): Promise<void> {
    throw notImplemented('job audit.verify-chain');
  }

  /** Job audit.purge-expired (monthly): Drop month partitions entirely older than retainYears (never below minimumRetentionYears), keep a signed checkpoint hash so the chain still verifies, record the purge as an entry */
  async purgeExpired(): Promise<void> {
    throw notImplemented('job audit.purge-expired');
  }
}
