/**
 * Shared plumbing of the trust use cases: time, settings, events, audit, optional modules, references, the report
 * aggregate, timelines and the risk score. The use cases live in the part classes (reports, actions, appeals,
 * detection).
 */
import type { Principal } from '../../../kernel/auth/index.js';
import { AppError, isAppError, isNotImplemented } from '../../../kernel/errors/index.js';
import type { EventMap } from '../../../kernel/events/index.js';
import { isUuid, newId } from '../../../kernel/lib/ids.js';
import type { ModuleContext, PublicApiMap } from '../../../kernel/module-system/index.js';
import type * as audit from '../../../spec/audit.js';
import type * as common from '../../../spec/common.js';
import type { StaffRef, TrustSubject } from '../../../spec/trust.js';
import { ACTIVE, riskLevel, riskScore, thresholdsOf, type Thresholds } from '../domain/rules.js';
import type { AppealRec, EnforcementRec, EventRec, EvidenceRec, NoteRec, RecommendationRec, ReportRec, RequestRec, SubjectRec } from '../ports.js';
import type { TrustRepository } from '../repository.js';

export interface TrustServiceDeps {
  repo: TrustRepository;
  ctx: ModuleContext<'trust'>;
}

/** Who acts, as the HTTP layer (or an event) knows it */
export interface By {
  actor: common.Actor;
  requestId?: string;
  principal?: Principal | null;
  /** Whether the caller holds a permission (REST handlers) */
  can?: (permission: string) => Promise<boolean>;
}

/** One report with everything a view needs */
export interface Agg {
  report: ReportRec;
  subjects: SubjectRec[];
  evidence: EvidenceRec[];
  requests: RequestRec[];
  recommendations: RecommendationRec[];
  enforcements: EnforcementRec[];
  notes: NoteRec[];
  events: EventRec[];
  mergedIds: string[];
}

type OwnEvent = keyof EventMap & `trust.${string}`;
type Optional = Parameters<ModuleContext<'trust'>['tryUse']>[0];

/** Events collected inside a transaction and published after the commit */
export class Batch {
  readonly events: { name: OwnEvent; payload: unknown }[] = [];
  constructor(readonly by: By) {}
  push<N extends OwnEvent>(name: N, payload: EventMap[N]) {
    this.events.push({ name, payload });
  }
}

export const invalid = (issues: { path: string; message: string }[], message = 'Some details need fixing') => new AppError('VALIDATION_FAILED', message, { issues });
export const invalidField = (path: string, message: string) => invalid([{ path, message }], message);
export const notFound = (what = 'Report') => new AppError('NOT_FOUND', `${what} not found`);
export const illegal = (machine: string, from: string, event: string, message?: string) => new AppError('ILLEGAL_TRANSITION', message ?? `Cannot ${event} when the ${machine.toLowerCase()} is ${from.replace(/_/g, ' ')}`, { machine, from, event });

export interface TimelineEntry {
  kind: string;
  label: string;
  text?: string | null;
  actor?: common.Actor;
  /** Extra fields kept in detail (recommendationId, enforcementId, key…) */
  meta?: Record<string, unknown>;
}

export const actorText = (a: common.Actor) => JSON.stringify({ kind: a.kind, id: a.id ?? null, ...(a.name ? { name: a.name } : {}) });
export function actorOf(text: string | null | undefined): common.Actor {
  if (!text) return { kind: 'system', id: null };
  try {
    const a = JSON.parse(text) as common.Actor;
    if (a && typeof a === 'object' && typeof a.kind === 'string') return { kind: a.kind, id: a.id ?? null, ...(a.name ? { name: a.name } : {}) };
  } catch {
    /* a bare staff id */
  }
  return { kind: 'staff', id: text };
}

export class Core {
  readonly repo: TrustRepository;
  readonly ctx: ModuleContext<'trust'>;

  constructor(deps: TrustServiceDeps) {
    this.repo = deps.repo;
    this.ctx = deps.ctx;
  }

  now = () => this.ctx.clock.now();
  error = (code: string, message?: string, details?: unknown) => this.ctx.error(code, message, details);

  publish<N extends OwnEvent>(name: N, payload: EventMap[N], by: { actor?: common.Actor; requestId?: string } = {}) {
    this.ctx.events.publish(name as never, payload as never, { actor: by.actor ?? { kind: 'system', id: null }, ...(by.requestId ? { requestId: by.requestId } : {}) });
  }

  /** Publishes what a transaction collected (after the commit) */
  flush(batch: Batch) {
    for (const e of batch.events.splice(0)) this.publish(e.name, e.payload as never, batch.by);
  }

  async audit(entry: Omit<audit.RecordInput, 'actor' | 'module' | 'requestId' | 'category'> & { category?: audit.RecordInput['category'] }, by: By) {
    try {
      await this.ctx.tryUse('audit')?.record({ category: 'other', ...entry, actor: by.actor, module: this.ctx.name, requestId: by.requestId ?? null });
    } catch (err) {
      // the change is committed; a missing audit entry is logged, never turned into a failed request
      this.ctx.log[isNotImplemented(err) ? 'debug' : 'error']({ err, action: entry.action }, 'audit entry not recorded');
    }
  }

  /** An optional module's answer; off, not built or failing → undefined (the caller degrades) */
  async soft<M extends Optional, R>(module: M, what: string, fn: (api: PublicApiMap[M & keyof PublicApiMap]) => Promise<R>): Promise<R | undefined> {
    const api = this.ctx.tryUse(module) as PublicApiMap[M & keyof PublicApiMap] | undefined;
    if (!api) return undefined;
    try {
      return await fn(api);
    } catch (err) {
      if (!isAppError(err)) this.ctx.log.warn({ err, module, what }, 'trust: optional call failed');
      return undefined;
    }
  }

  /* ---------------------------------------------------------------- settings and references */

  async thresholds(): Promise<Thresholds> {
    return thresholdsOf(await this.ctx.settings.get('riskThresholds'));
  }
  async setting(key: 'highRiskDeadlineHours' | 'defaultDeadlineHours' | 'appealWindowDays' | 'appealDecisionDays' | 'evidenceRequestDays' | 'executionGraceMinutes' | 'reporterRateLimitPerDay' | 'evidenceRetentionDays', fallback: number): Promise<number> {
    const v = Number(await this.ctx.settings.get(key));
    return Number.isFinite(v) && v > 0 ? v : fallback;
  }
  reportRef = () => this.ctx.refs.next('TR', { daily: false, digits: 4 });
  enforcementRef = () => this.ctx.refs.next('EN', { digits: 4 });
  appealRef = () => this.ctx.refs.next('TA', { digits: 4 });

  /** Investigation deadline for a score */
  async dueAt(score: number, from: Date = this.now()): Promise<Date> {
    const t = await this.thresholds();
    const hours = riskLevel(score, t) === 'high' ? await this.setting('highRiskDeadlineHours', 24) : await this.setting('defaultDeadlineHours', 72);
    return new Date(from.getTime() + hours * 3_600_000);
  }

  /* ---------------------------------------------------------------- people */

  /** Staff references (name and role label from access) */
  async staffRefs(ids: (string | null | undefined)[]): Promise<Map<string, StaffRef>> {
    const access = this.ctx.use('access');
    const unique = [...new Set(ids.filter((x): x is string => !!x && isUuid(x)))];
    const refs = await Promise.all(
      unique.map(async (id) => {
        try {
          return await access.getStaffRef(id);
        } catch (err) {
          if (!isAppError(err)) this.ctx.log.warn({ err, id }, 'trust: staff reference failed');
          return null;
        }
      }),
    );
    return new Map(unique.map((id, n): [string, StaffRef] => [id, { staffId: id, name: refs[n]?.name ?? 'Staff member', role: refs[n]?.roleLabel ?? null }]));
  }

  /** Media references (empty when media is off) */
  async mediaRefs(ids: string[]): Promise<Map<string, common.MediaRef>> {
    const uniq = [...new Set(ids.filter(isUuid))];
    const out = new Map<string, common.MediaRef>();
    if (!uniq.length) return out;
    const refs = await this.soft('media', 'refs', (m) => m.refs(uniq, 'medium'));
    for (const r of refs ?? []) out.set(r.id, r);
    return out;
  }

  /** Records files a report uses (media usage, owner checked by media); media off → the ids are kept as given */
  async attach(ids: string[] | null | undefined, refId: string, refLabel: string, owner: { kind: 'seller' | 'staff' | 'customer' | 'guest' | 'platform'; id?: string | null }) {
    const media = this.ctx.tryUse('media');
    if (!media || !ids?.length) return;
    for (const id of [...new Set(ids)]) {
      try {
        await media.attach(id, { module: 'trust', kind: 'trust_evidence', refId, refLabel }, owner);
      } catch (err) {
        if (isAppError(err) && err.code === 'NOT_FOUND') throw invalidField('mediaIds', 'A file was not found; upload it again');
        throw err;
      }
    }
  }

  /* ---------------------------------------------------------------- loading */

  async loadMany(reportIds: readonly string[], repo: TrustRepository = this.repo): Promise<Map<string, Agg>> {
    const ids = [...new Set(reportIds)].filter(isUuid);
    const out = new Map<string, Agg>();
    if (!ids.length) return out;
    const [reports, subjects, evidence, requests, recs, enfs, notes, events, merged] = await repo.reads(
      () => repo.find('reports', { id: ids }),
      () => repo.find('report_subjects', { report_id: ids }),
      () => repo.find('evidence', { report_id: ids }, { orderBy: [['added_at', 'asc'], ['id', 'asc']] }),
      () => repo.find('evidence_requests', { report_id: ids }, { orderBy: [['due_at', 'asc'], ['id', 'asc']] }),
      () => repo.find('recommendations', { report_id: ids }, { orderBy: [['id', 'asc']] }),
      () => repo.find('enforcements', { report_id: ids }, { orderBy: [['recorded_at', 'asc'], ['id', 'asc']] }),
      () => repo.find('report_notes', { report_id: ids }, { orderBy: [['at', 'asc'], ['id', 'asc']] }),
      () => repo.find('report_events', { report_id: ids }, { orderBy: [['at', 'asc'], ['id', 'asc']] }),
      () => repo.find('reports', { merged_into_id: ids }),
    );
    for (const r of reports) out.set(r.id, { report: r, subjects: [], evidence: [], requests: [], recommendations: [], enforcements: [], notes: [], events: [], mergedIds: [] });
    for (const x of subjects) out.get(x.report_id)?.subjects.push(x);
    for (const x of evidence) out.get(x.report_id)?.evidence.push(x);
    for (const x of requests) out.get(x.report_id)?.requests.push(x);
    for (const x of recs) out.get(x.report_id)?.recommendations.push(x);
    for (const x of enfs) out.get(x.report_id)?.enforcements.push(x);
    for (const x of notes) out.get(x.report_id)?.notes.push(x);
    for (const x of events) out.get(x.report_id)?.events.push(x);
    for (const x of merged) if (x.merged_into_id) out.get(x.merged_into_id)?.mergedIds.push(x.id);
    return out;
  }

  async load(reportId: string, repo: TrustRepository = this.repo): Promise<Agg | undefined> {
    return (await this.loadMany([reportId], repo)).get(reportId);
  }

  async required(reportId: string): Promise<Agg> {
    const agg = await this.load(reportId);
    if (!agg) throw notFound();
    return agg;
  }

  /** Runs a write on one report: lock, change, commit, then publish */
  async write<T>(reportId: string, by: By, fn: (tx: TrustRepository, agg: Agg, batch: Batch) => Promise<T>): Promise<T> {
    const batch = new Batch(by);
    const result = await this.repo.transaction(async (tx) => {
      const locked = isUuid(reportId) ? await tx.get('reports', reportId, { forUpdate: true }) : undefined;
      if (!locked) throw notFound();
      return fn(tx, (await this.load(reportId, tx))!, batch);
    });
    this.flush(batch);
    return result;
  }

  /** Adds timeline entries to a report (inside the transaction) */
  async timeline(tx: TrustRepository, reportId: string, entries: TimelineEntry[]) {
    const at = this.now();
    for (const [i, e] of entries.entries()) {
      await tx.insert('report_events', {
        id: newId(),
        report_id: reportId,
        kind: e.kind,
        detail: { label: e.label, ...(e.text ? { text: e.text } : {}), ...(e.actor?.name ? { actorName: e.actor.name } : {}), ...(e.meta ?? {}) },
        actor_kind: e.actor?.kind ?? 'system',
        actor_id: e.actor?.id ?? null,
        at: new Date(at.getTime() + i),
      });
    }
  }

  /* ---------------------------------------------------------------- risk */

  /** Recomputes the explainable score of a report from its evidence and history (an override keeps its score) */
  async score(repo: TrustRepository, report: ReportRec, subjects: SubjectRec[], evidence: EvidenceRec[]): Promise<{ score: number; factors: ReportRec['risk_factors']; effective: number }> {
    const targets = subjects.map((s) => ({ type: s.subject_type, id: s.subject_id }));
    const enfIds = await repo.enforcementIdsFor(targets);
    const prior = enfIds.length ? (await repo.find('enforcements', { id: enfIds, execution_state: { op: '<>', value: 'reversed' } })).filter((e) => e.report_id !== report.id).length : 0;
    const recentSignals = await repo.signalsAbout(targets, new Date(this.now().getTime() - 30 * 86_400_000));
    const signal = report.risk_factors.find((f) => f.factor === 'signal');
    const missing = (e: EvidenceRec) => e.source === 'automated' && e.kind === 'note' && e.text.startsWith('No proof received');
    const { score, factors } = riskScore({
      type: report.type,
      source: report.source,
      reporterCount: report.reporter_count,
      signalScore: signal ? signal.weight : null,
      evidence: evidence.filter((e) => !missing(e)).map((e) => ({ kind: e.kind, result: e.result, source: e.source })),
      priorEnforcements: prior,
      recentSignals,
      missingProof: evidence.filter(missing).length,
    });
    return { score, factors, effective: report.risk_override ? report.risk_override.score : score };
  }

  /** Rescores a report inside a write; returns whether the score changed */
  async rescoreIn(tx: TrustRepository, reportId: string): Promise<boolean> {
    const agg = (await this.load(reportId, tx))!;
    const r = await this.score(tx, agg.report, agg.subjects, agg.evidence);
    if (r.effective === agg.report.risk_score && JSON.stringify(r.factors) === JSON.stringify(agg.report.risk_factors)) return false;
    await tx.update('reports', reportId, { risk_score: r.effective, risk_factors: r.factors });
    return true;
  }

  isActive = (status: string) => (ACTIVE as readonly string[]).includes(status);

  /** Subject rows from TrustSubjects (deduplicated) */
  subjectRows(reportId: string, subjects: TrustSubject[]): SubjectRec[] {
    const seen = new Set<string>();
    const out: SubjectRec[] = [];
    for (const s of subjects) {
      const k = `${s.type}:${s.id}`;
      if (seen.has(k)) continue;
      seen.add(k);
      out.push({ report_id: reportId, subject_type: s.type, subject_id: s.id, ref: s.ref ?? null, label: s.label || s.type });
    }
    return out;
  }

  /** Who drafted and who last routed a recommendation (separate duties): recommendations.created_by / routed_by */
  async recommendationPeople(recommendationId: string): Promise<{ drafter: string | null; router: string | null }> {
    const r = await this.repo.get('recommendations', recommendationId);
    return { drafter: r?.created_by ?? null, router: r?.routed_by ?? null };
  }
}

export type { AppealRec, EnforcementRec, RecommendationRec, ReportRec };
