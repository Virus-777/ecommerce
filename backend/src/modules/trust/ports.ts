/**
 * What the trust service needs from the outside world, database-agnostic.
 * The Postgres adapter lives in infra/postgres/; a MongoDB switch would add infra/mongo/.
 */
import type * as common from '../../spec/common.js';
import type { RiskFactor, TrustDb, TrustSubject } from '../../spec/trust.js';

type Db = TrustDb;

export interface RiskOverride {
  score: number;
  reason: string;
  by: common.Actor;
  at: string;
}
export interface Resolution {
  outcome: string;
  summary: string;
  decidedBy: common.Actor;
  decidedAt: string;
}
export interface Assessment {
  level: 'low' | 'medium' | 'high';
  flags: { severity?: string; text: string }[];
  recommendation: string;
  recommendedHoldDays?: number | null;
  /** seller_application | seller | customer, as requestAssessment named it (trust.assessment.completed subjectType) */
  subjectType?: string;
  subjectId?: string;
  requestedBy?: common.Actor;
  question?: string;
  /** Asked through requestAssessment, not recorded yet */
  pending?: boolean;
}

export interface ReportRec extends Omit<Db['reports'], 'risk_factors' | 'risk_override' | 'resolution' | 'assessment'> {
  risk_factors: RiskFactor[];
  risk_override: RiskOverride | null;
  resolution: Resolution | null;
  assessment: Assessment | null;
}
export type SubjectRec = Db['report_subjects'];
export interface EvidenceRec extends Omit<Db['evidence'], 'media_ids'> {
  media_ids: string[];
}
export interface RequestRec extends Omit<Db['evidence_requests'], 'answer_media_ids'> {
  answer_media_ids: string[];
}
export interface RecommendationRec extends Omit<Db['recommendations'], 'targets' | 'params'> {
  targets: TrustSubject[];
  params: Record<string, unknown>;
}
export interface EnforcementRec extends Omit<Db['enforcements'], 'targets' | 'params' | 'effects'> {
  targets: TrustSubject[];
  params: Record<string, unknown>;
  effects: string[];
}
export type TargetRec = Db['enforcement_targets'];
export interface AppealRec extends Omit<Db['appeals'], 'evidence_media_ids' | 'decision'> {
  evidence_media_ids: string[];
  decision: Record<string, unknown> | null;
}
export type NoteRec = Db['report_notes'];
export interface EventRec extends Omit<Db['report_events'], 'detail'> {
  detail: Record<string, unknown>;
}
export interface RuleRec extends Omit<Db['detection_rules'], 'thresholds'> {
  thresholds: Record<string, unknown>;
}
export interface SignalRow extends Omit<Db['risk_signals'], 'features'> {
  features: Record<string, unknown>;
}

export interface Recs {
  reports: ReportRec;
  report_subjects: SubjectRec;
  evidence: EvidenceRec;
  evidence_requests: RequestRec;
  recommendations: RecommendationRec;
  enforcements: EnforcementRec;
  enforcement_targets: TargetRec;
  appeals: AppealRec;
  report_notes: NoteRec;
  report_events: EventRec;
  detection_rules: RuleRec;
  risk_signals: SignalRow;
}
export type Table = keyof Recs;

/** A column condition: a value (=), a list (in), null (is null) or an operator */
export type Cond<V> = V | readonly V[] | { op: '<' | '<=' | '>' | '>=' | '<>' | 'is not' | 'not in'; value: V | null | readonly V[] };
export type Where<R> = { [K in keyof R]?: Cond<R[K]> };

export interface FindOptions<R> {
  orderBy?: [keyof R & string, 'asc' | 'desc'][];
  limit?: number;
  offset?: number;
  forUpdate?: boolean;
}

/** Filters of the admin trust queue (and its export) */
export interface ReportFilter {
  statuses?: string[];
  type?: string;
  source?: string;
  assigneeId?: string;
  /** Score range from riskLevel and the thresholds in force */
  minScore?: number;
  maxScore?: number;
  subjectType?: string;
  subjectId?: string;
  q?: string;
  ids?: string[];
  /** Reports whose reporter is one of these (kind, ids) */
  reporter?: { kind: string; ids: string[] };
  /** Reports about one of these subjects */
  about?: { types: string[]; id: string };
  sort?: 'risk' | 'newest' | 'oldest' | 'deadline';
}

/** Persistence for this module's own tables: trust.reports, trust.report_subjects, trust.evidence, trust.evidence_requests, trust.recommendations, trust.enforcements, trust.enforcement_targets, trust.appeals, trust.report_notes, trust.report_events, trust.detection_rules, trust.risk_signals. */
export interface TrustRepository {
  /** Runs fn in one transaction (nested calls join the outer one) */
  transaction<T>(fn: (tx: TrustRepository) => Promise<T>): Promise<T>;
  /** Inbox (ctx.inbox): true the first time this key is claimed; commits with the transaction it runs in */
  claim(key: string): Promise<boolean>;

  /* generic table access (jsonb columns are mapped at this boundary) */
  get<T extends Table>(table: T, id: string, o?: { forUpdate?: boolean }): Promise<Recs[T] | undefined>;
  find<T extends Table>(table: T, where: Where<Recs[T]>, o?: FindOptions<Recs[T]>): Promise<Recs[T][]>;
  count<T extends Table>(table: T, where: Where<Recs[T]>): Promise<number>;
  insert<T extends Table>(table: T, row: Recs[T]): Promise<Recs[T]>;
  /** Inserts rows, skipping those that hit a unique constraint; returns how many were inserted */
  insertIgnore<T extends Table>(table: T, rows: Recs[T][]): Promise<number>;
  update<T extends Table>(table: T, id: string, patch: Partial<Recs[T]>): Promise<Recs[T]>;
  updateWhere<T extends Table>(table: T, where: Where<Recs[T]>, patch: Partial<Recs[T]>): Promise<number>;

  /** Admin queue: offset paging over the filtered reports */
  listReports(f: ReportFilter, page: { offset: number; limit: number }): Promise<{ items: ReportRec[]; total: number }>;
  countReports(f: ReportFilter): Promise<number>;
  /** Distinct subject ids of a type named by reports (not merged), optionally only in these statuses / among these ids */
  subjectIdsAbout(type: string, o: { statuses?: string[]; ids?: string[] }): Promise<string[]>;
  /** Distinct reporter ids of a kind with reports filed (not merged), optionally only in these statuses / among these ids */
  reporterIdsFiling(kind: string, o: { statuses?: string[]; ids?: string[] }): Promise<string[]>;
  /** Report ids that name any of the subjects */
  reportIdsAbout(types: string[], id: string): Promise<string[]>;
  /** Enforcement ids recorded against any of these targets (lookup table) */
  enforcementIdsFor(targets: { type: string; id: string }[]): Promise<string[]>;
  /** Timeline entries with detail.key = key (consumer idempotency) */
  eventsByKey(key: string): Promise<EventRec[]>;
  /** Timeline entries of these kinds whose detail names the record (recommendation, enforcement, appeal) */
  eventsFor(field: string, value: string, kinds: string[]): Promise<EventRec[]>;
  /** Raw signals about any of the subjects since a time */
  signalsAbout(subjects: { type: string; id: string }[], since: Date): Promise<number>;
  /** Open reports by type, high-risk count, and the counts behind the overview */
  overview(highFrom: number): Promise<{ open: number; highRisk: number; byType: Record<string, number>; highByType: Record<string, number>; ordersInSuspicious: number }>;
}
