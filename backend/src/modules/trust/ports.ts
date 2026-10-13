/**
 * Row types of the trust collections (typed json fields) and the admin-queue filter the repository
 * (repository.ts) takes.
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
/** The trust collections (spec tables) */
export type TableName = keyof Recs;

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
