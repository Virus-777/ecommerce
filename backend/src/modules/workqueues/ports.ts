/** Row types and query shapes the workqueues repository and service share. */
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
  /** true: only archived items; false: only items not archived; absent: both (internal counts) */
  archived?: boolean;
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

