/**
 * Rows → API shapes, in one place per type. Staff views carry the whole case file; summaries (other modules,
 * GraphQL) leave out reporter identity, evidence and notes; reporters and affected parties get their own shapes
 * that never name the reporter.
 */
import type * as common from '../../../spec/common.js';
import type { DetectionRule, Enforcement, EvidenceItem, EvidenceRequest, MyEnforcement, MyReport, Recommendation, ReportRow, StaffRef, TrustAppeal, TrustReport, TrustSubject } from '../../../spec/trust.js';
import { ACTIONS, appealRoute, deadline, humanize, isAction, reporterStatus, riskLevel, SCREENS, WHAT, type SubjectType, type Thresholds } from '../domain/rules.js';
import type { AppealRec, EnforcementRec, EvidenceRec, RecommendationRec, RequestRec, RuleRec, SubjectRec } from '../ports.js';
import { actorOf, type Agg, type Core } from './core.js';

const iso = (d: Date | null | undefined) => (d ? d.toISOString() : null);

export interface ViewCtx {
  staff: Map<string, StaffRef>;
  media: Map<string, common.MediaRef>;
  thresholds: Thresholds;
  now: Date;
  /** Current status labels from the owning modules (getReport) */
  statusLabels?: Map<string, string>;
}

export class Views {
  constructor(private readonly core: Core) {}

  /** Staff refs and media for a set of aggregates */
  async context(aggs: Agg[], o: { media?: boolean; extraStaff?: string[]; extraMedia?: string[] } = {}): Promise<ViewCtx> {
    const staffIds = [
      ...(o.extraStaff ?? []),
      ...aggs.flatMap((a) => [a.report.assignee_staff_id, ...a.recommendations.flatMap((r) => [r.owner_staff_id, r.decided_by, r.created_by, r.routed_by])]),
    ];
    const mediaIds = o.media === false ? [] : [...(o.extraMedia ?? []), ...aggs.flatMap((a) => [...a.evidence.flatMap((e) => e.media_ids), ...a.requests.flatMap((r) => r.answer_media_ids)])];
    const [staff, media, thresholds] = await Promise.all([this.core.staffRefs(staffIds), this.core.mediaRefs(mediaIds), this.core.thresholds()]);
    return { staff, media, thresholds, now: this.core.now() };
  }

  subject(s: SubjectRec, statusLabels?: Map<string, string>): TrustSubject {
    return {
      type: s.subject_type as SubjectType,
      id: s.subject_id,
      ref: s.ref ?? null,
      label: s.label,
      statusLabel: statusLabels?.get(`${s.subject_type}:${s.subject_id}`) ?? null,
      screen: SCREENS[s.subject_type as SubjectType] ?? null,
    };
  }

  evidence(e: EvidenceRec, media: Map<string, common.MediaRef>): EvidenceItem {
    return {
      id: e.id,
      kind: e.kind as EvidenceItem['kind'],
      result: (e.result as EvidenceItem['result']) ?? null,
      text: e.text,
      media: e.media_ids.map((id) => media.get(id)).filter((m): m is common.MediaRef => !!m),
      source: e.source as EvidenceItem['source'],
      addedBy: { kind: e.added_by_kind as common.Actor['kind'], id: e.added_by_id ?? null },
      addedAt: e.added_at.toISOString(),
      visibility: e.visibility as EvidenceItem['visibility'],
    };
  }

  request(r: RequestRec, subjects: SubjectRec[], media: Map<string, common.MediaRef>, now: Date, reportRef: string | null = null): EvidenceRequest {
    const s = subjects.find((x) => x.subject_type === r.to_type && x.subject_id === r.to_id);
    return {
      id: r.id,
      reportId: r.report_id,
      to: s ? this.subject(s) : { type: r.to_type as SubjectType, id: r.to_id, ref: null, label: humanize(r.to_type), statusLabel: null, screen: SCREENS[r.to_type as SubjectType] ?? null },
      question: r.question,
      dueAt: r.due_at.toISOString(),
      deadline: deadline(r.due_at, r.state === 'open' ? now : (r.answered_at ?? r.due_at), 5 * 86_400_000),
      state: r.state as EvidenceRequest['state'],
      answer: r.answer ?? null,
      answerMedia: r.answer_media_ids.map((id) => media.get(id)).filter((m): m is common.MediaRef => !!m),
      answeredAt: iso(r.answered_at),
      reportRef,
    };
  }

  recommendation(r: RecommendationRec, staff: Map<string, StaffRef>): Recommendation {
    return {
      id: r.id,
      reportId: r.report_id,
      action: r.action as Recommendation['action'],
      label: r.label,
      ownerTeam: r.owner_team as Recommendation['ownerTeam'],
      ownerRole: r.owner_role,
      owner: r.owner_staff_id ? (staff.get(r.owner_staff_id) ?? { staffId: r.owner_staff_id, name: 'Staff member' }) : null,
      targets: r.targets,
      params: r.params ?? {},
      rationale: r.rationale,
      state: r.state as Recommendation['state'],
      createdBy: r.created_by ? (staff.get(r.created_by) ?? { staffId: r.created_by, name: 'Staff member' }) : null,
      routedAt: iso(r.routed_at),
      routedBy: r.routed_by ? (staff.get(r.routed_by) ?? { staffId: r.routed_by, name: 'Staff member' }) : null,
      decidedAt: iso(r.decided_at),
      decidedBy: r.decided_by ? (staff.get(r.decided_by) ?? { staffId: r.decided_by, name: 'Staff member' }) : null,
      decisionReason: r.decision_reason ?? null,
      enforcementId: r.enforcement_id ?? null,
      approvalRequestId: r.approval_request_id ?? null,
    };
  }

  enforcement(e: EnforcementRec, reportRef: string): Enforcement {
    return {
      id: e.id,
      ref: e.ref,
      reportId: e.report_id,
      reportRef,
      recommendationId: e.recommendation_id ?? null,
      action: e.action as Enforcement['action'],
      ownerTeam: e.owner_team as Enforcement['ownerTeam'],
      targets: e.targets,
      reason: e.reason,
      params: e.params ?? {},
      effects: e.effects,
      recordedBy: actorOf(e.recorded_by),
      recordedAt: e.recorded_at.toISOString(),
      executionState: e.execution_state as Enforcement['executionState'],
      appliedRef: e.applied_ref ?? null,
      appliedAt: iso(e.applied_at),
      failure: e.failure ?? null,
      appealable: e.appealable,
      appealDeadline: iso(e.appeal_deadline),
      reversedAt: iso(e.reversed_at),
      reversalReason: e.reversal_reason ?? null,
      reversalRequestId: e.reversal_request_id ?? null,
      approval: null,
    };
  }

  appeal(a: AppealRec, c: { staff: Map<string, StaffRef>; media: Map<string, common.MediaRef>; reportRef: string | null; now: Date }): TrustAppeal {
    const decider = a.original_decider_id;
    const open = a.state === 'open' || a.state === 'under_review';
    return {
      id: a.id,
      ref: a.ref,
      source: a.source,
      externalAppealId: a.external_appeal_id ?? null,
      reportId: a.report_id ?? null,
      reportRef: c.reportRef,
      enforcementId: a.enforcement_id ?? null,
      appellant: { kind: a.appellant_kind as common.Actor['kind'], id: a.appellant_id },
      appellantName: a.appellant_name,
      decisionAppealed: a.decision_appealed,
      argument: a.argument,
      evidence: a.evidence_media_ids.map((id) => c.media.get(id)).filter((m): m is common.MediaRef => !!m),
      reviewer: a.reviewer_staff_id ? (c.staff.get(a.reviewer_staff_id) ?? { staffId: a.reviewer_staff_id, name: 'Staff member' }) : null,
      originalDecider: c.staff.get(decider) ?? { staffId: decider, name: a.source === 'sellers' ? 'Seller Manager' : 'Owner team', role: null },
      decideBy: deadline(a.decide_by, open ? c.now : a.decide_by, 7 * 86_400_000),
      state: a.state as TrustAppeal['state'],
      decision: a.decision ?? null,
      filedAt: a.filed_at.toISOString(),
    };
  }

  /** The staff case file; `summary` leaves out reporter identity, evidence, requests, notes and the timeline */
  report(agg: Agg, c: ViewCtx, o: { summary?: boolean } = {}): TrustReport {
    const r = agg.report;
    const summary = !!o.summary;
    const casesLinked = agg.events.filter((e) => e.kind === 'case_linked').map((e) => String(e.detail.caseRef ?? '')).filter(Boolean);
    return {
      id: r.id,
      ref: r.ref,
      type: r.type as TrustReport['type'],
      title: r.title,
      description: r.description,
      source: r.source as TrustReport['source'],
      reporter: summary ? null : { actor: { kind: r.reporter_kind, id: r.reporter_id ?? null }, name: r.reporter_name ?? null, organization: r.reporter_org ?? null, contactEmail: r.reporter_contact ?? null },
      reporterCount: r.reporter_count,
      detector: r.detector ?? null,
      subjects: agg.subjects.map((s) => this.subject(s, c.statusLabels)),
      status: r.status as TrustReport['status'],
      riskScore: r.risk_score,
      riskLevel: riskLevel(r.risk_score, c.thresholds),
      riskFactors: r.risk_factors,
      riskOverride: r.risk_override ?? null,
      assignee: r.assignee_staff_id ? (c.staff.get(r.assignee_staff_id) ?? { staffId: r.assignee_staff_id, name: 'Staff member' }) : null,
      deadline: r.due_at && this.core.isActive(r.status) ? deadline(r.due_at, c.now, Math.max(3_600_000, r.due_at.getTime() - r.created_at.getTime())) : null,
      evidence: summary ? [] : agg.evidence.map((e) => this.evidence(e, c.media)),
      evidenceRequests: summary ? [] : agg.requests.map((x) => this.request(x, agg.subjects, c.media, c.now, r.ref)),
      recommendations: agg.recommendations.map((x) => this.recommendation(x, c.staff)),
      enforcements: agg.enforcements.map((x) => this.enforcement(x, r.ref)),
      linkedCaseRefs: [...new Set(casesLinked)],
      mergedReportIds: agg.mergedIds,
      notes: summary ? [] : agg.notes.map((n) => ({ id: n.id, body: n.body, author: { staffId: n.author_id, name: n.author_name }, at: n.at.toISOString() })),
      timeline: summary
        ? []
        : agg.events.map((e) => ({
            at: e.at.toISOString(),
            label: String(e.detail.label ?? humanize(e.kind)),
            detail: typeof e.detail.text === 'string' ? e.detail.text : null,
            actor: { kind: e.actor_kind as common.Actor['kind'], id: e.actor_id ?? null, ...(typeof e.detail.actorName === 'string' ? { name: e.detail.actorName } : {}) },
          })),
      resolution: r.resolution ?? null,
      reporterOutcome: r.reporter_outcome ?? null,
      assessment: r.assessment && !r.assessment.pending ? { level: r.assessment.level, flags: r.assessment.flags, recommendation: r.assessment.recommendation, recommendedHoldDays: r.assessment.recommendedHoldDays ?? null } : null,
      createdAt: r.created_at.toISOString(),
      updatedAt: r.updated_at.toISOString(),
    };
  }

  reporterLabel(agg: Agg): string {
    const r = agg.report;
    const more = r.reporter_count > 1 ? ` + ${r.reporter_count - 1} more` : '';
    switch (r.source) {
      case 'automated':
        return `Automated: ${r.detector ?? 'detector'}`;
      case 'brand_owner':
        return `Brand owner: ${r.reporter_org ? `${r.reporter_org}${r.reporter_name ? ` (${r.reporter_name})` : ''}` : (r.reporter_name ?? 'rights owner')}${more}`;
      case 'seller':
        return `Seller${r.reporter_name ? `: ${r.reporter_name}` : ''}${more}`;
      case 'customer':
        return `Customer${r.reporter_name ? `: ${r.reporter_name}` : ''}${more}`;
      case 'referral':
        return `Referral${r.detector ? `: ${r.detector}` : ''}`;
      default:
        return `Staff${r.reporter_name ? `: ${r.reporter_name}` : ''}`;
    }
  }

  counts(recs: RecommendationRec[]) {
    return {
      total: recs.length,
      pending: recs.filter((x) => x.state === 'pending').length,
      sentToOwner: recs.filter((x) => x.state === 'sent_to_owner').length,
      completed: recs.filter((x) => x.state === 'completed').length,
      declined: recs.filter((x) => x.state === 'declined').length,
    };
  }

  row(agg: Agg, c: ViewCtx): ReportRow {
    const r = agg.report;
    return {
      id: r.id,
      ref: r.ref,
      type: r.type,
      title: r.title,
      status: r.status,
      riskScore: r.risk_score,
      riskLevel: riskLevel(r.risk_score, c.thresholds),
      source: r.source,
      reporterLabel: this.reporterLabel(agg),
      subjects: agg.subjects.map((s) => this.subject(s)),
      assignee: r.assignee_staff_id ? (c.staff.get(r.assignee_staff_id) ?? { staffId: r.assignee_staff_id, name: 'Staff member' }) : null,
      recommendations: this.counts(agg.recommendations),
      deadline: r.due_at && this.core.isActive(r.status) ? deadline(r.due_at, c.now, Math.max(3_600_000, r.due_at.getTime() - r.created_at.getTime())) : null,
      createdAt: r.created_at.toISOString(),
    };
  }

  /**
   * What a reporter sees: the subject, their own words, the status and the outcome; never who else reported or what
   * the investigation found. A merged report shows the kept report's status and outcome.
   */
  myReport(agg: Agg, kept: Agg | null, reporterIds: string[]): MyReport {
    const r = agg.report;
    const shown = kept ?? agg;
    const main = agg.subjects.find((s) => s.subject_type !== 'seller') ?? agg.subjects[0];
    const seller = agg.subjects.find((s) => s.subject_type === 'seller' && s !== main);
    const statement = agg.evidence.find((e) => e.kind === 'statement' && e.source === 'reporter' && e.added_by_id && reporterIds.includes(e.added_by_id));
    const status = shown.report.status;
    const caseRef = shown.events.find((e) => e.kind === 'case_linked')?.detail.caseRef;
    return {
      id: r.id,
      ref: r.ref,
      what: WHAT[main?.subject_type ?? ''] ?? 'Report',
      about: main ? `${main.label}${seller ? ` from ${seller.label}` : ''}` : r.title,
      youSaid: statement?.text ?? r.description,
      reportedAt: r.created_at.toISOString(),
      statusLabel: reporterStatus(status, shown.report.resolution?.outcome),
      outcome: shown.report.reporter_outcome ?? null,
      expectedBy: this.core.isActive(status) && shown.report.due_at ? shown.report.due_at.toISOString().slice(0, 10) : null,
      caseRef: typeof caseRef === 'string' ? caseRef : null,
    };
  }

  myEnforcement(e: EnforcementRec, appealId: string | null): MyEnforcement {
    const def = isAction(e.action) ? ACTIONS[e.action] : ACTIONS.other;
    const hold = e.action === 'suspend_offer' && e.params?.mode === 'hold';
    return {
      id: e.id,
      ref: e.ref,
      title: hold ? 'Offer held for review' : def.title,
      reason: e.reason,
      effects: e.effects,
      targets: e.targets,
      recordedAt: e.recorded_at.toISOString(),
      appealable: e.appealable && e.execution_state !== 'reversed',
      appealDeadline: iso(e.appeal_deadline),
      appealId,
      appealRoute: appealRoute(def, e.appeal_deadline),
    };
  }

  rule(r: RuleRec, hits: number): DetectionRule {
    return {
      key: r.key,
      description: r.description,
      type: r.type,
      active: r.active,
      thresholds: r.thresholds ?? {},
      baseScore: r.base_score,
      lastRunAt: iso(r.last_run_at),
      hitsLast30Days: hits,
    };
  }
}
