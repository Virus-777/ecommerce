/**
 * What the workqueues service needs from the outside world, database-agnostic.
 * The Postgres adapter lives in infra/postgres/; a MongoDB switch would add infra/mongo/.
 */
import type { PageRequest } from '../../kernel/lib/pagination.js';
import type { Page } from '../../spec/common.js';
import type { WorkqueuesDb } from '../../spec/workqueues.js';

export type QueueRow = WorkqueuesDb['queues'];
export type IntakeRuleRow = WorkqueuesDb['intake_rules'];
export type ItemRow = WorkqueuesDb['items'];
export type ItemEventRow = WorkqueuesDb['item_events'];
export type ItemNoteRow = WorkqueuesDb['item_notes'];
export type SavedFilterRow = WorkqueuesDb['saved_filters'];
export type DayEndReviewRow = WorkqueuesDb['day_end_reviews'];
export type RoutineTemplateRow = WorkqueuesDb['routine_templates'];
export type RoutineCheckRow = WorkqueuesDb['routine_checks'];
export type DailyCountRow = WorkqueuesDb['daily_counts'];

export type ItemSort = 'deadline' | 'oldest' | 'priority' | 'amount';

/** Which items a caller reaches: null = every item (workqueues.items.view-all) */
export interface ItemVisibility {
  queueKeys: string[];
  roles: string[];
  staffId: string;
}

export interface ItemQuery {
  visibility?: ItemVisibility | null;
  queueKeys?: string[];
  kinds?: string[];
  states?: string[];
  deadlineStates?: string[];
  /** Overdue by more than this many minutes at `now` */
  overdueOverMinutes?: number;
  now?: Date;
  assignee?: { kind: 'unassigned' } | { kind: 'staff'; id: string };
  sellerId?: string;
  sellerKind?: 'official' | 'marketplace';
  subjectRef?: string;
  search?: string;
  visibleToSeller?: boolean;
}

export interface QueueCountRow {
  queue_key: string;
  open: number;
  overdue: number;
  due_soon: number;
}

export interface OldestRow {
  queue_key: string;
  id: string;
  ref: string;
  subject_ref: string | null;
  opened_at: Date;
}

export interface Match {
  type: string;
  id: string;
}

/** Persistence for this module's own tables: workqueues.queues, workqueues.intake_rules, workqueues.items, workqueues.item_events, workqueues.item_notes, workqueues.saved_filters, workqueues.day_end_reviews, workqueues.routine_templates, workqueues.routine_checks, workqueues.daily_counts. */
export interface WorkqueuesRepository {
  transaction<T>(fn: (repo: WorkqueuesRepository) => Promise<T>): Promise<T>;

  /* queues */
  listQueues(): Promise<QueueRow[]>;
  getQueue(key: string, opts?: { forUpdate?: boolean }): Promise<QueueRow | null>;
  /** Insert unless the key exists; true when inserted */
  insertQueue(row: QueueRow): Promise<boolean>;
  updateQueue(key: string, patch: Partial<QueueRow>): Promise<QueueRow>;

  /* intake rules */
  upsertIntakeRules(rows: IntakeRuleRow[]): Promise<void>;
  listIntakeRules(filter?: { queueKey?: string }): Promise<IntakeRuleRow[]>;

  /* items */
  getItem(id: string, opts?: { forUpdate?: boolean }): Promise<ItemRow | null>;
  activeByDedupe(dedupeKey: string, opts?: { forUpdate?: boolean }): Promise<ItemRow | null>;
  latestClosedByDedupe(dedupeKey: string): Promise<ItemRow | null>;
  insertItem(row: ItemRow): Promise<ItemRow>;
  updateItem(id: string, patch: Partial<ItemRow>): Promise<ItemRow>;
  listItems(query: ItemQuery, page: PageRequest, sort: ItemSort): Promise<Page<ItemRow>>;
  /** Rows for exports: keyset on (opened_at, id) */
  scanItems(query: ItemQuery, after: { openedAt: string; id: string } | null, limit: number): Promise<ItemRow[]>;
  countItems(query: ItemQuery): Promise<number>;
  /** Active items of these kinds whose subject or a related subject is one of `matches` */
  activeMatching(kinds: string[], matches: Match[]): Promise<ItemRow[]>;
  /** Items about a subject (subject or related subject; for sellers also seller_id) */
  itemsAbout(type: string, id: string, opts: { activeOnly: boolean }): Promise<ItemRow[]>;
  /** Active items with due_at at or before `until`, or whose stored deadline state is no longer on_time, oldest deadline first */
  sweepBatch(until: Date, afterDue: { dueAt: Date; id: string } | null, limit: number): Promise<ItemRow[]>;
  /** Active items marked due_soon/overdue whose deadline moved past `until` */
  staleDeadlineStates(until: Date): Promise<ItemRow[]>;
  queueCounts(now: Date, dueSoonMinutes: number): Promise<QueueCountRow[]>;
  oldestOpen(): Promise<OldestRow[]>;
  /** Active items assigned to the staff member, per queue */
  assignedCounts(staffId: string): Promise<{ queue_key: string; n: number }[]>;
  sellerTaskCounts(sellerId: string): Promise<{ kind: string; n: number }[]>;
  /** Items opened / resolved in a time range, per queue (daily counts) */
  openedBetween(from: Date, to: Date): Promise<{ queue_key: string; n: number }[]>;
  resolvedBetween(from: Date, to: Date): Promise<{ queue_key: string; opened_at: Date; resolved_at: Date }[]>;
  /** Closed items resolved before `before` (archive), oldest first */
  closedBefore(before: Date, limit: number): Promise<ItemRow[]>;
  deleteItems(ids: string[]): Promise<void>;

  /* history and notes */
  insertEvent(row: ItemEventRow): Promise<void>;
  eventsOf(itemId: string): Promise<ItemEventRow[]>;
  eventsOfItems(itemIds: string[]): Promise<ItemEventRow[]>;
  hasEvent(itemId: string, kind: string): Promise<boolean>;
  insertNote(row: ItemNoteRow): Promise<void>;
  notesOf(itemId: string): Promise<ItemNoteRow[]>;
  notesOfItems(itemIds: string[]): Promise<ItemNoteRow[]>;

  /* saved filters */
  getSavedFilter(id: string): Promise<SavedFilterRow | null>;
  listSavedFilters(staffId: string): Promise<SavedFilterRow[]>;
  insertSavedFilter(row: SavedFilterRow): Promise<void>;
  updateSavedFilter(id: string, patch: Partial<SavedFilterRow>): Promise<SavedFilterRow>;
  deleteSavedFilter(id: string): Promise<void>;

  /* day-end reviews */
  reviewByDate(date: string, opts?: { forUpdate?: boolean }): Promise<DayEndReviewRow | null>;
  getReview(id: string, opts?: { forUpdate?: boolean }): Promise<DayEndReviewRow | null>;
  /** Insert unless the date exists; returns the row for the date */
  insertReview(row: DayEndReviewRow): Promise<DayEndReviewRow>;
  updateReview(id: string, patch: Partial<DayEndReviewRow>): Promise<DayEndReviewRow>;
  listReviews(filter: { from?: string; to?: string; state?: string }, page: PageRequest): Promise<Page<DayEndReviewRow>>;

  /* routines */
  listTemplates(opts?: { activeOnly?: boolean }): Promise<RoutineTemplateRow[]>;
  countTemplates(): Promise<number>;
  upsertTemplate(row: RoutineTemplateRow): Promise<void>;
  deactivateTemplatesExcept(ids: string[]): Promise<void>;
  checksOn(date: string): Promise<RoutineCheckRow[]>;
  getCheck(id: string, opts?: { forUpdate?: boolean }): Promise<RoutineCheckRow | null>;
  /** Insert unless (template, date) exists */
  insertCheck(row: RoutineCheckRow): Promise<void>;
  updateCheck(id: string, patch: Partial<RoutineCheckRow>): Promise<RoutineCheckRow>;
  /** not_done/in_progress checks of earlier dates, or due before `dueBefore` → late; returns how many */
  markChecksLate(opts: { beforeDate?: string; dueBefore?: Date }): Promise<number>;

  /* daily counts */
  upsertDailyCounts(rows: DailyCountRow[]): Promise<void>;
  dailyCounts(date: string): Promise<DailyCountRow[]>;
}

/** Cold storage for archived work items (the archive job): rows leave the online tables after itemRetentionDays */
export interface ArchiveStore {
  put(batch: { at: string; items: unknown[] }): Promise<void>;
}
