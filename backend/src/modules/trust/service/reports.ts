/**
 * Reports: intake from customers, sellers, staff, brand owners, other modules and detectors; the investigation
 * workflow (assign, escalate, evidence, proof requests, links, risk override, notes, assessment, resolve, dismiss,
 * reopen, merge); and every read of reports (queue, case file, reporter views, 360 summaries, exports).
 */
import { AppError, isAppError } from '../../../kernel/errors/index.js';
import { isUuid, newId } from '../../../kernel/lib/ids.js';
import { decodeCursor, encodeCursor, toPageRequest, type PageRequest } from '../../../kernel/lib/pagination.js';
import type * as common from '../../../spec/common.js';
import type * as identity from '../../../spec/identity.js';
import type * as reports from '../../../spec/reports.js';
import type { EvidenceInput, EvidenceItem, EvidenceRequest, MyReport, ReportReporter, ReportRow, StoreReportInput, TrustOverview, TrustReport, TrustSubject } from '../../../spec/trust.js';
import { trustReportMachine, evidenceRequestMachine } from '../domain/state-machines.js';
import { ACTIVE, FORM_TYPES, humanize, OUTCOMES, REPORT_TYPES, riskLevel, SUBJECT_TYPES, TYPE_LABELS, type ReportStatus, type SubjectType } from '../domain/rules.js';
import type { Assessment, EvidenceRec, ReportFilter, ReportRec, TrustRepository } from '../ports.js';
import { Batch, illegal, invalid, invalidField, notFound, type Agg, type By, type Core } from './core.js';
import type { Views } from './views.js';

export const DATASET = 'trust.admin.reports';

/** Who files a report from the store or Seller Center */
export interface Reporter {
  kind: 'customer' | 'seller';
  /** Stored reporter id (customer id when known, else the account id; the seller id) */
  id: string;
  /** Every id this reporter may have been stored under */
  ids: string[];
  name: string | null;
  mediaOwner: { kind: 'customer' | 'seller'; id: string | null };
  /** For order and conversation ownership checks */
  customerId?: string | null;
  sellerId?: string | null;
  /** The signed-in account (its email is stored as the reporter contact so the outcome reaches them) */
  accountId?: string | null;
  actor: common.Actor;
}

export interface OpenInput {
  id?: string;
  type: string;
  title: string;
  description: string;
  source: TrustReport['source'];
  reporter: { kind: string; id: string | null; name?: string | null; org?: string | null; contact?: string | null };
  detector?: string | null;
  dedupeKey?: string | null;
  subjects: TrustSubject[];
  evidence: EvidenceRec[];
  signalScore?: number | null;
  assessment?: Assessment | null;
  caseRefs?: string[];
  /** Intake key (consumer idempotency), kept on the created timeline entry */
  key?: string | null;
  createdLabel?: string;
}

type Page<T> = common.Page<T>;

export function offsetOf(req: PageRequest): number {
  if (req.mode === 'page') return (req.page - 1) * req.limit;
  if (!req.cursor) return 0;
  const n = Number(decodeCursor(req.cursor)[0]);
  return Number.isFinite(n) && n >= 0 ? n : 0;
}

export function pageFrom<T>(items: T[], total: number, req: PageRequest): Page<T> {
  const offset = offsetOf(req);
  const more = offset + items.length < total;
  if (req.mode === 'page') return { items, nextCursor: more ? encodeCursor([offset + req.limit]) : null, page: req.page, totalPages: Math.max(1, Math.ceil(total / req.limit)), total };
  return { items, nextCursor: more ? encodeCursor([offset + items.length]) : null, total };
}

const text = (s: unknown) => (typeof s === 'string' ? s.trim() : '');
const STORE_SUBJECTS: SubjectType[] = ['offer', 'product', 'seller', 'order', 'message', 'conversation'];
const SELLER_SUBJECTS: SubjectType[] = [...STORE_SUBJECTS, 'customer'];
const EVIDENCE_KINDS = ['check', 'document', 'photo', 'note', 'record_link', 'signal', 'statement'];
const RESULTS = ['fail', 'warn', 'info', 'ok'];

export class Reports {
  constructor(
    private readonly core: Core,
    private readonly views: Views,
  ) {}

  /* ================================================================ building blocks */

  evidenceRow(reportId: string, e: EvidenceInput, source: EvidenceItem['source'], actor: common.Actor, at = this.core.now()): EvidenceRec {
    return {
      id: newId(),
      report_id: reportId,
      kind: e.kind,
      result: e.result ?? null,
      text: e.text,
      media_ids: [...new Set(e.mediaIds ?? [])],
      source,
      visibility: e.visibility ?? 'internal',
      added_by_kind: actor.kind,
      added_by_id: actor.id ?? null,
      added_at: at,
    };
  }

  checkEvidence(list: EvidenceInput[] | null | undefined, path = 'evidence'): { path: string; message: string }[] {
    const issues: { path: string; message: string }[] = [];
    (list ?? []).forEach((e, i) => {
      if (!EVIDENCE_KINDS.includes(e.kind)) issues.push({ path: `${path}[${i}].kind`, message: `One of ${EVIDENCE_KINDS.join(', ')}` });
      if (e.result && !RESULTS.includes(e.result)) issues.push({ path: `${path}[${i}].result`, message: 'fail, warn, info or ok' });
      if (!text(e.text)) issues.push({ path: `${path}[${i}].text`, message: 'Describe the evidence' });
    });
    return issues;
  }

  checkSubjects(list: TrustSubject[] | null | undefined, path = 'subjects'): { path: string; message: string }[] {
    const issues: { path: string; message: string }[] = [];
    (list ?? []).forEach((s, i) => {
      if (!(SUBJECT_TYPES as readonly string[]).includes(s.type)) issues.push({ path: `${path}[${i}].type`, message: `One of ${SUBJECT_TYPES.join(', ')}` });
      if (!isUuid(s.id)) issues.push({ path: `${path}[${i}].id`, message: 'A record id' });
    });
    return issues;
  }

  /** Opens a report (score, deadline, subjects, evidence, timeline) and announces it */
  async open(input: OpenInput, by: By, repo?: TrustRepository): Promise<Agg> {
    const id = input.id ?? newId();
    const ref = await this.core.reportRef();
    const t = await this.core.thresholds();
    const [high, normal] = await Promise.all([this.core.setting('highRiskDeadlineHours', 24), this.core.setting('defaultDeadlineHours', 72)]);
    const batch = new Batch(by);
    const run = async (tx: TrustRepository) => {
      const now = this.core.now();
      const initialFactors = input.signalScore !== null && input.signalScore !== undefined ? [{ factor: 'signal', weight: Math.max(0, Math.min(100, Math.round(input.signalScore))), detail: 'Detector score' }] : [];
      const row: ReportRec = {
        id,
        ref,
        type: (REPORT_TYPES as readonly string[]).includes(input.type) ? input.type : 'other',
        title: input.title.slice(0, 300),
        description: input.description,
        source: input.source,
        reporter_kind: input.reporter.kind,
        reporter_id: input.reporter.id,
        reporter_name: input.reporter.name ?? null,
        reporter_org: input.reporter.org ?? null,
        reporter_contact: input.reporter.contact ?? null,
        reporter_count: 1,
        detector: input.detector ?? null,
        dedupe_key: input.dedupeKey ?? null,
        status: 'open',
        risk_score: 0,
        risk_factors: initialFactors,
        risk_override: null,
        assignee_staff_id: null,
        due_at: null,
        resolution: null,
        reporter_outcome: null,
        assessment: input.assessment ?? null,
        merged_into_id: null,
        created_at: now,
        updated_at: now,
      };
      await tx.insert('reports', row);
      const subjects = this.core.subjectRows(id, input.subjects);
      await tx.insertIgnore('report_subjects', subjects);
      const evidence = input.evidence.map((e) => ({ ...e, report_id: id }));
      for (const e of evidence) await tx.insert('evidence', e);
      const s = await this.core.score(tx, row, subjects, evidence);
      const due = new Date(now.getTime() + (riskLevel(s.effective, t) === 'high' ? high : normal) * 3_600_000);
      const saved = await tx.update('reports', id, { risk_score: s.effective, risk_factors: s.factors.length ? s.factors : initialFactors, due_at: due });
      await this.core.timeline(tx, id, [
        { kind: 'created', label: input.createdLabel ?? `Report opened (${humanize(input.source)})`, actor: by.actor, meta: input.key ? { key: input.key } : {} },
        ...(input.caseRefs ?? []).map((caseRef) => ({ kind: 'case_linked', label: `Support case ${caseRef} linked`, actor: by.actor, meta: { caseRef } })),
      ]);
      batch.push('trust.report.created', {
        reportId: id,
        ref,
        type: saved.type,
        source: saved.source,
        riskScore: saved.risk_score,
        subjects: input.subjects.map((x) => ({ type: x.type, id: x.id, ref: x.ref ?? null, label: x.label })),
      });
      return (await this.core.load(id, tx))!;
    };
    const agg = repo ? await run(repo) : await this.core.repo.transaction(run);
    this.core.flush(batch);
    return agg;
  }

  /** Adds subjects and evidence to an existing report (de-duplicated signals, repeat reports) */
  async extend(tx: TrustRepository, agg: Agg, o: { subjects?: TrustSubject[]; evidence?: EvidenceRec[]; label: string; actor: common.Actor; key?: string | null; signalScore?: number | null; countReporter?: boolean }) {
    const id = agg.report.id;
    if (o.countReporter) await tx.update('reports', id, { reporter_count: agg.report.reporter_count + 1 });
    if (o.subjects?.length) await tx.insertIgnore('report_subjects', this.core.subjectRows(id, o.subjects));
    for (const e of o.evidence ?? []) await tx.insert('evidence', { ...e, report_id: id });
    if (o.signalScore !== null && o.signalScore !== undefined) {
      const factors = agg.report.risk_factors.filter((f) => f.factor !== 'signal');
      const prev = agg.report.risk_factors.find((f) => f.factor === 'signal')?.weight ?? 0;
      const weight = Math.max(prev, Math.max(0, Math.min(100, Math.round(o.signalScore))));
      await tx.update('reports', id, { risk_factors: [{ factor: 'signal', weight, detail: 'Detector score' }, ...factors] });
    }
    await this.core.timeline(tx, id, [{ kind: 'signal', label: o.label, actor: o.actor, meta: o.key ? { key: o.key } : {} }]);
    await this.core.rescoreIn(tx, id);
    await tx.update('reports', id, { updated_at: this.core.now() });
  }

  /** De-duplicated intake: adds to the active report with the same key, else opens one */
  async signal(input: OpenInput & { dedupeKey: string; extendLabel: string; countReporter?: boolean }, by: By): Promise<Agg> {
    for (let attempt = 0; attempt < 2; attempt++) {
      const existing = (await this.core.repo.find('reports', { dedupe_key: input.dedupeKey, status: [...ACTIVE] }, { limit: 1 }))[0];
      if (existing) {
        await this.core.write(existing.id, by, async (tx, agg) => {
          await this.extend(tx, agg, { subjects: input.subjects, evidence: input.evidence.map((e) => ({ ...e, report_id: existing.id })), label: input.extendLabel, actor: by.actor, key: input.key, signalScore: input.signalScore, countReporter: input.countReporter });
        });
        return (await this.core.load(existing.id))!;
      }
      try {
        return await this.open(input, by);
      } catch (err) {
        // another delivery opened it first (unique dedupe_key among active reports): add to that one
        if (attempt === 0 && /duplicate key|unique/i.test(String((err as Error)?.message ?? ''))) continue;
        throw err;
      }
    }
    throw new AppError('CONFLICT', 'The report changed while it was being opened; try again');
  }

  /** Whether a consumed event was already taken in (timeline key) */
  async seen(key: string): Promise<boolean> {
    return (await this.core.repo.eventsByKey(key)).length > 0;
  }

  /* ================================================================ intake: in-process callers */

  async raiseSignal(input: { type: string; detector: string; title: string; subjects: TrustSubject[]; evidence: EvidenceInput[]; score?: number; dedupeKey: string }): Promise<TrustReport> {
    const issues = [...this.checkSubjects(input.subjects), ...this.checkEvidence(input.evidence)];
    if (!text(input.dedupeKey)) issues.push({ path: 'dedupeKey', message: 'Required' });
    if (!text(input.title)) issues.push({ path: 'title', message: 'Required' });
    if (issues.length) throw invalid(issues);
    const actor: common.Actor = { kind: 'system', id: null, name: input.detector };
    const at = this.core.now();
    const agg = await this.signal(
      {
        type: input.type,
        title: input.title,
        description: input.evidence.map((e) => e.text).join('\n') || input.title,
        source: 'automated',
        reporter: { kind: 'system', id: null, name: input.detector },
        detector: input.detector,
        dedupeKey: input.dedupeKey,
        subjects: input.subjects.map((s) => ({ ...s, label: s.label || humanize(s.type) })),
        evidence: input.evidence.map((e) => this.evidenceRow('', e, 'other_module', actor, at)),
        signalScore: input.score ?? null,
        createdLabel: `Raised by ${input.detector}`,
        extendLabel: `New signal from ${input.detector}`,
      },
      { actor },
    );
    return this.views.report(agg, await this.views.context([agg]));
  }

  async requestAssessment(input: { subjectType: 'seller_application' | 'seller' | 'customer'; subjectId: string; sellerId?: string; question: string; requestedBy: common.Actor }): Promise<{ reportId: string; ref: string }> {
    const issues: { path: string; message: string }[] = [];
    if (!['seller_application', 'seller', 'customer'].includes(input.subjectType)) issues.push({ path: 'subjectType', message: 'seller_application, seller or customer' });
    if (!isUuid(input.subjectId)) issues.push({ path: 'subjectId', message: 'A record id' });
    if (input.sellerId && !isUuid(input.sellerId)) issues.push({ path: 'sellerId', message: 'A seller id' });
    if (!text(input.question)) issues.push({ path: 'question', message: 'What should Trust and Risk look at?' });
    if (issues.length) throw invalid(issues);
    const sellerId = input.subjectType === 'seller' ? input.subjectId : (input.sellerId ?? null);
    const seller = sellerId ? await this.core.soft('sellers', 'getSeller', (s) => s.getSeller(sellerId)) : undefined;
    const customer = input.subjectType === 'customer' ? await this.core.soft('customers', 'getCustomer', (c) => c.getCustomer(input.subjectId)) : undefined;
    const subjects: TrustSubject[] = [
      ...(input.subjectType === 'seller_application' ? [{ type: 'application' as const, id: input.subjectId, label: `Seller application${seller ? ` of ${seller.storeName}` : ''}` }] : []),
      ...(sellerId ? [{ type: 'seller' as const, id: sellerId, ref: seller?.ref ?? null, label: seller?.storeName ?? 'Seller' }] : []),
      ...(input.subjectType === 'customer' ? [{ type: 'customer' as const, id: input.subjectId, ref: customer?.ref ?? null, label: customer?.displayName ?? 'Customer' }] : []),
    ];
    const type = input.subjectType === 'seller_application' ? 'seller_application' : 'account_risk';
    const by: By = { actor: input.requestedBy };
    const agg = await this.signal(
      {
        type,
        title: `${TYPE_LABELS[type]}: ${subjects[0]?.label ?? humanize(input.subjectType)}`,
        description: input.question.trim(),
        source: 'referral',
        reporter: { kind: input.requestedBy.kind, id: input.requestedBy.id ?? null, name: input.requestedBy.name ?? 'Seller Manager' },
        detector: 'sellers.assessment',
        dedupeKey: `assessment:${input.subjectType}:${input.subjectId}`,
        subjects,
        evidence: [this.evidenceRow('', { kind: 'statement', text: input.question.trim() }, 'other_module', input.requestedBy)],
        assessment: null,
        createdLabel: 'Assessment requested',
        extendLabel: 'Assessment requested again',
      },
      by,
    );
    // remember what was asked, so trust.assessment.completed names the requester's subject
    if (!agg.report.assessment?.subjectType) {
      await this.core.repo.update('reports', agg.report.id, { assessment: { level: 'low', flags: [], recommendation: '', subjectType: input.subjectType, subjectId: input.subjectId, requestedBy: input.requestedBy, question: input.question.trim(), pending: true } });
    }
    return { reportId: agg.report.id, ref: agg.report.ref };
  }

  /* ================================================================ intake: store and Seller Center */

  /** The report form's subject, checked against the owning module (another customer's order is not found) */
  private async resolveSubject(type: SubjectType, id: string, who: Reporter): Promise<TrustSubject[]> {
    const notThere = () => invalidField('subject.id', 'We could not find what you reported');
    switch (type) {
      case 'offer': {
        const o = await this.core.soft('offers', 'getOfferAdmin', (m) => m.getOfferAdmin(id));
        if (o === null) throw notThere();
        if (!o) return [{ type, id, label: 'Listing' }];
        if (who.kind === 'seller' && o.sellerId === who.id) throw invalidField('subject.id', 'You cannot report your own offer');
        const p = await this.core.soft('catalog', 'getProduct', (m) => m.getProduct(o.productId));
        return [
          { type, id, label: p?.title ?? 'Listing' },
          ...(o.sellerId ? [{ type: 'seller' as const, id: o.sellerId, label: o.sellerName }] : []),
        ];
      }
      case 'product': {
        const p = await this.core.soft('catalog', 'getProduct', (m) => m.getProduct(id));
        if (p === null) throw notThere();
        return [{ type, id, ref: p?.ref ?? null, label: p?.title ?? 'Product' }];
      }
      case 'seller': {
        if (who.kind === 'seller' && id === who.id) throw invalidField('subject.id', 'You cannot report your own store');
        const s = await this.core.soft('sellers', 'getSeller', (m) => m.getSeller(id));
        if (s === null) throw notThere();
        return [{ type, id, ref: s?.ref ?? null, label: s?.storeName ?? 'Seller' }];
      }
      case 'order': {
        const viewer = who.kind === 'seller' ? { area: 'seller' as const, sellerId: who.id } : who.customerId ? { area: 'store' as const, customerId: who.customerId } : null;
        if (!viewer) return [{ type, id, label: 'Order' }];
        const found = await this.core.soft('orders', 'getOrdersByIds', (m) => m.getOrdersByIds(viewer, [id]));
        if (found === undefined) return [{ type, id, label: 'Order' }];
        const o = found[id] as { ref?: string; order?: { ref?: string } } | null | undefined;
        if (!o) throw notThere();
        const ref = o.ref ?? o.order?.ref ?? null;
        return [{ type, id, ref, label: ref ? `Order ${ref}` : 'Order' }];
      }
      case 'conversation': {
        const c = await this.core.soft('messaging', 'getConversation', (m) => m.getConversation(who.actor, id));
        if (c === null) throw notThere();
        return [{ type, id, label: 'Conversation' }];
      }
      case 'customer': {
        const c = await this.core.soft('customers', 'getCustomer', (m) => m.getCustomer(id));
        if (c === null) throw notThere();
        return [{ type, id, ref: c?.ref ?? null, label: c?.displayName ?? 'Customer' }];
      }
      default:
        return [{ type, id, label: humanize(type) }];
    }
  }

  /** Report from the store or Seller Center; the same reporter and subject within 24 h updates the earlier report */
  async file(input: StoreReportInput, who: Reporter, by: By): Promise<MyReport> {
    const area = who.kind === 'seller' ? SELLER_SUBJECTS : STORE_SUBJECTS;
    const subj = (input.subject && typeof input.subject === 'object' ? input.subject : {}) as { type?: string; id?: string };
    const issues: { path: string; message: string }[] = [];
    const type = FORM_TYPES[input.type];
    if (!type) issues.push({ path: 'type', message: 'Choose what is wrong' });
    if (!subj.type || !area.includes(subj.type as SubjectType)) issues.push({ path: 'subject.type', message: `One of ${area.join(', ')}` });
    if (!isUuid(subj.id)) issues.push({ path: 'subject.id', message: 'The record you are reporting' });
    if (!text(input.reason)) issues.push({ path: 'reason', message: 'Choose a reason' });
    if (input.details && input.details.length > 5000) issues.push({ path: 'details', message: 'At most 5,000 characters' });
    if (issues.length) throw invalid(issues);
    const now = this.core.now();
    const since = new Date(now.getTime() - 86_400_000);

    // same subject + same reporter within 24 h: add to that report
    const recent = await this.core.repo.find('reports', { reporter_kind: who.kind, reporter_id: who.ids, created_at: { op: '>=', value: since } });
    if (recent.length) {
      const hits = await this.core.repo.find('report_subjects', { report_id: recent.map((r) => r.id), subject_type: subj.type!, subject_id: subj.id! });
      const dup = recent.find((r) => hits.some((h) => h.report_id === r.id) && r.status !== 'merged');
      if (dup) {
        await this.core.attach(input.evidenceIds, dup.id, `Report ${dup.ref}`, who.mediaOwner);
        await this.core.write(dup.id, by, async (tx, agg) => {
          const e = this.evidenceRow(dup.id, { kind: 'statement', text: this.said(input), mediaIds: input.evidenceIds ?? [] }, 'reporter', who.actor);
          await this.extend(tx, agg, { evidence: [e], label: 'The reporter added to the report', actor: who.actor });
        });
        return this.mine(dup.id, who);
      }
      const limit = await this.core.setting('reporterRateLimitPerDay', 20);
      if (recent.length >= limit) throw new AppError('RATE_LIMITED', `You can send up to ${limit} reports a day. Please try again tomorrow.`);
    }

    const subjects = await this.resolveSubject(subj.type as SubjectType, subj.id!, who);
    if (input.orderId && !(subj.type === 'order' && subj.id === input.orderId)) {
      const order = await this.resolveSubject('order', input.orderId, who).catch((err) => {
        if (isAppError(err) && err.code === 'VALIDATION_FAILED') throw invalidField('orderId', 'We could not find that order');
        throw err;
      });
      subjects.push(...order);
    }
    const id = newId();
    await this.core.attach(input.evidenceIds, id, 'Trust report', who.mediaOwner);
    const contact = await this.accountEmail(who.accountId);
    const main = subjects[0]!;
    const agg = await this.open(
      {
        id,
        type: type!,
        title: `${TYPE_LABELS[input.type] ?? humanize(input.type)}: ${main.label}`,
        description: text(input.details) || humanize(input.reason),
        source: who.kind,
        reporter: { kind: who.kind, id: who.id, name: who.name, contact },
        subjects,
        evidence: [this.evidenceRow(id, { kind: 'statement', text: this.said(input), mediaIds: input.evidenceIds ?? [] }, 'reporter', who.actor)],
        createdLabel: who.kind === 'seller' ? 'Reported by a seller' : 'Reported by a customer',
      },
      by,
    );
    return this.views.myReport(agg, null, who.ids);
  }

  /** The signed-in account's email (identity), kept with the report so the outcome reaches the reporter later */
  private async accountEmail(accountId: string | null | undefined): Promise<string | null> {
    if (!accountId || !isUuid(accountId)) return null;
    const account = await this.core.soft('identity', 'getAccount', (m) => m.getAccount(accountId));
    return account?.email?.toLowerCase() ?? null;
  }

  private said(input: StoreReportInput) {
    const details = text(input.details);
    return `${humanize(input.reason)}${details ? `: ${details}` : ''}`;
  }

  /** Staff open a report */
  async createStaff(body: { type: string; title: string; description: string; subjects: TrustSubject[]; evidence?: EvidenceInput[] | null; caseRef?: string | null }, by: By): Promise<TrustReport> {
    const issues = [...this.checkSubjects(body.subjects), ...this.checkEvidence(body.evidence)];
    if (!(REPORT_TYPES as readonly string[]).includes(body.type)) issues.push({ path: 'type', message: `One of ${REPORT_TYPES.join(', ')}` });
    if (!text(body.title)) issues.push({ path: 'title', message: 'Give the report a title' });
    if (!text(body.description)) issues.push({ path: 'description', message: 'Describe the concern' });
    if (!body.subjects?.length) issues.push({ path: 'subjects', message: 'Name at least one subject' });
    if (issues.length) throw invalid(issues);
    const id = newId();
    for (const e of body.evidence ?? []) await this.core.attach(e.mediaIds, id, 'Trust report', { kind: 'staff', id: by.actor.id ?? null });
    const me = (await this.core.staffRefs([by.actor.id])).get(by.actor.id ?? '');
    const agg = await this.open(
      {
        id,
        type: body.type,
        title: body.title.trim(),
        description: body.description.trim(),
        source: 'staff',
        reporter: { kind: 'staff', id: by.actor.id ?? null, name: me?.name ?? by.actor.name ?? null },
        subjects: body.subjects.map((s) => ({ ...s, label: s.label || humanize(s.type) })),
        evidence: (body.evidence ?? []).map((e) => this.evidenceRow(id, e, 'staff', by.actor)),
        caseRefs: text(body.caseRef) ? [body.caseRef!.trim()] : [],
        createdLabel: 'Opened by staff',
      },
      by,
    );
    return this.full(agg);
  }

  /** Brand or rights owner report from the public form (phase 2) */
  async rightsOwner(body: { brandName: string; contactName: string; contactEmail: string; offerOrProductIds: string[]; details: string; proofMediaIds: string[] }, by: By & { sessionId?: string | null }): Promise<{ ref: string; confirmationSent: boolean }> {
    const issues: { path: string; message: string }[] = [];
    if (!text(body.brandName)) issues.push({ path: 'brandName', message: 'The brand you own or represent' });
    if (!text(body.contactName)) issues.push({ path: 'contactName', message: 'Who we contact' });
    if (!body.offerOrProductIds?.length) issues.push({ path: 'offerOrProductIds', message: 'Name at least one listing' });
    if (!body.proofMediaIds?.length) issues.push({ path: 'proofMediaIds', message: 'Proof of rights is required' });
    if (!text(body.details)) issues.push({ path: 'details', message: 'Tell us what is wrong with the listings' });
    if (issues.length) throw invalid(issues);
    const email = body.contactEmail.trim().toLowerCase();
    const limit = await this.core.setting('reporterRateLimitPerDay', 20);
    const recent = await this.core.repo.count('reports', { reporter_kind: 'brand_owner', reporter_contact: email, created_at: { op: '>=', value: new Date(this.core.now().getTime() - 86_400_000) } });
    if (recent >= limit) throw new AppError('RATE_LIMITED', `Up to ${limit} reports a day can be sent from one address.`);
    const subjects: TrustSubject[] = [];
    for (const id of [...new Set(body.offerOrProductIds)].slice(0, 50)) {
      const offer = await this.core.soft('offers', 'getOfferAdmin', (m) => m.getOfferAdmin(id));
      if (offer) {
        const p = await this.core.soft('catalog', 'getProduct', (m) => m.getProduct(offer.productId));
        subjects.push({ type: 'offer', id, label: p?.title ?? 'Listing' });
        if (offer.sellerId) subjects.push({ type: 'seller', id: offer.sellerId, label: offer.sellerName });
        continue;
      }
      const product = await this.core.soft('catalog', 'getProduct', (m) => m.getProduct(id));
      subjects.push(product ? { type: 'product', id, ref: product.ref, label: product.title } : { type: offer === null ? 'product' : 'offer', id, label: 'Listing' });
    }
    const id = newId();
    await this.core.attach(body.proofMediaIds, id, `Rights owner report (${body.brandName.trim()})`, { kind: 'guest', id: by.sessionId ?? null });
    const actor: common.Actor = { kind: 'visitor', id: by.actor.id ?? null, name: body.contactName.trim() };
    const agg = await this.open(
      {
        id,
        type: 'counterfeit',
        title: `Rights owner report: ${body.brandName.trim()}`,
        description: body.details.trim(),
        source: 'brand_owner',
        reporter: { kind: 'brand_owner', id: by.actor.id ?? null, name: body.contactName.trim(), org: body.brandName.trim(), contact: email },
        subjects,
        evidence: [this.evidenceRow(id, { kind: 'document', text: `Proof of rights from ${body.brandName.trim()}: ${body.details.trim()}`, mediaIds: body.proofMediaIds }, 'brand_owner', actor)],
        createdLabel: 'Reported by a brand or rights owner',
      },
      by,
    );
    // the receipt with the TR reference: notifications emails it to the contact address
    this.core.publish('trust.rights_report.received', { reportId: id, ref: agg.report.ref, brandName: body.brandName.trim(), contactName: body.contactName.trim(), contactEmail: email }, by);
    return { ref: agg.report.ref, confirmationSent: (this.core.ctx.modules as readonly string[]).includes('notifications') };
  }

  /**
   * Who is told the outcome of a report: the customers, sellers and rights owners who filed it or a duplicate merged
   * into it, once each (staff, detectors and other modules are not told). Customers stored under their account id
   * are named by their customer id when the customers module knows them.
   */
  async reportersOf(reportId: string): Promise<ReportReporter[]> {
    const rows: ReportRec[] = [];
    const first = await this.core.repo.get('reports', reportId);
    if (first) rows.push(first);
    const seen = new Set([reportId]);
    for (let frontier = [reportId]; frontier.length; ) {
      const merged = (await this.core.repo.find('reports', { merged_into_id: frontier })).filter((r) => !seen.has(r.id));
      merged.forEach((r) => seen.add(r.id));
      rows.push(...merged);
      frontier = merged.map((r) => r.id);
    }
    const out = new Map<string, ReportReporter>();
    for (const r of rows) {
      const name = r.reporter_name?.trim() || null;
      if (r.reporter_kind === 'seller' && r.reporter_id && isUuid(r.reporter_id)) {
        if (!out.has(`seller:${r.reporter_id}`)) out.set(`seller:${r.reporter_id}`, { kind: 'seller', sellerId: r.reporter_id, contactName: name, contactEmail: r.reporter_contact ?? null });
      } else if (r.reporter_kind === 'customer' && r.reporter_id && isUuid(r.reporter_id)) {
        const customerId = await this.customerIdOf(r.reporter_id);
        const key = customerId ? `customer:${customerId}` : `customer-contact:${r.reporter_contact ?? ''}`;
        if ((customerId || r.reporter_contact) && !out.has(key)) out.set(key, { kind: 'customer', customerId, contactName: name, contactEmail: r.reporter_contact });
      } else if (r.reporter_kind === 'brand_owner' && r.reporter_contact) {
        // reporter_name is the contact person, reporter_org the brand they report for
        if (!out.has(`rights_owner:${r.reporter_contact}`)) out.set(`rights_owner:${r.reporter_contact}`, { kind: 'rights_owner', contactName: name, contactEmail: r.reporter_contact });
      }
    }
    return [...out.values()];
  }

  /** The customer id of a stored customer reporter (stored under the account id when customers did not know them) */
  /** The customers-module id for a stored customer or account id */
  async customerIdOf(storedId: string): Promise<string | null> {
    if (!isUuid(storedId)) return null;
    const c = await this.core.soft('customers', 'getCustomer', (m) => m.getCustomer(storedId));
    if (c) return c.id;
    if (c === undefined) return storedId; // customers is off or failing: the stored id is the best we have
    const byAccount = await this.core.soft('customers', 'getCustomerByUserId', (m) => m.getCustomerByUserId(storedId));
    return byAccount?.id ?? null;
  }

  /* ================================================================ reporter views */

  private async keptOf(aggs: Agg[]): Promise<Map<string, Agg>> {
    const keptIds = aggs.map((a) => a.report.merged_into_id).filter((x): x is string => !!x);
    return this.core.loadMany(keptIds);
  }

  async mine(id: string, who: Pick<Reporter, 'kind' | 'ids'>): Promise<MyReport> {
    const agg = isUuid(id) ? await this.core.load(id) : undefined;
    if (!agg || agg.report.reporter_kind !== who.kind || !agg.report.reporter_id || !who.ids.includes(agg.report.reporter_id)) throw notFound();
    const kept = await this.keptOf([agg]);
    return this.views.myReport(agg, agg.report.merged_into_id ? (kept.get(agg.report.merged_into_id) ?? null) : null, who.ids);
  }

  async listMine(who: Pick<Reporter, 'kind' | 'ids'>, page: PageRequest): Promise<Page<MyReport>> {
    const res = await this.core.repo.listReports({ reporter: { kind: who.kind, ids: who.ids }, sort: 'newest' }, { offset: offsetOf(page), limit: page.limit });
    const aggs = await this.core.loadMany(res.items.map((r) => r.id));
    const list = res.items.map((r) => aggs.get(r.id)!);
    const kept = await this.keptOf(list);
    return pageFrom(
      list.map((a) => this.views.myReport(a, a.report.merged_into_id ? (kept.get(a.report.merged_into_id) ?? null) : null, who.ids)),
      res.total,
      page,
    );
  }

  /** The reporter adds photos or details to an open report */
  async addMine(id: string, body: { text: string; mediaIds?: string[] | null }, who: Reporter, by: By): Promise<MyReport> {
    await this.mine(id, who);
    if (!text(body.text)) throw invalidField('text', 'Add some details');
    const agg = (await this.core.load(id))!;
    const target = agg.report.merged_into_id ?? id;
    const live = target === id ? agg : await this.core.required(target);
    if (!this.core.isActive(live.report.status)) throw illegal('Trust report', live.report.status, 'addDetails', 'This report is closed; send a new report if something changed');
    await this.core.attach(body.mediaIds, target, `Report ${live.report.ref}`, who.mediaOwner);
    await this.core.write(target, by, async (tx, a) => {
      const e = this.evidenceRow(target, { kind: 'statement', text: body.text.trim(), mediaIds: body.mediaIds ?? [] }, 'reporter', who.actor);
      await this.extend(tx, a, { evidence: [e], label: 'The reporter added details', actor: who.actor });
    });
    return this.mine(id, who);
  }

  /* ================================================================ staff reads */

  async full(agg: Agg, o: { labels?: boolean } = {}): Promise<TrustReport> {
    const c = await this.views.context([agg]);
    if (o.labels) c.statusLabels = await this.statusLabels(agg);
    return this.views.report(agg, c);
  }

  async get(id: string): Promise<TrustReport> {
    const agg = isUuid(id) ? await this.core.load(id) : undefined;
    if (!agg) throw notFound();
    return this.full(agg, { labels: true });
  }

  /** Current status of each subject in its owning module (best effort) */
  private async statusLabels(agg: Agg): Promise<Map<string, string>> {
    const out = new Map<string, string>();
    const subjects = agg.subjects.slice(0, 25);
    const of = (t: string) => subjects.filter((s) => s.subject_type === t).map((s) => s.subject_id);
    const sellers = of('seller');
    if (sellers.length) for (const s of (await this.core.soft('sellers', 'getSellers', (m) => m.getSellers(sellers))) ?? []) out.set(`seller:${s.id}`, humanize(s.status));
    await Promise.all([
      ...of('offer').map(async (id) => {
        const o = await this.core.soft('offers', 'getOfferAdmin', (m) => m.getOfferAdmin(id));
        if (o) out.set(`offer:${id}`, humanize(o.status));
      }),
      ...of('product').map(async (id) => {
        const p = await this.core.soft('catalog', 'getProductAdmin', (m) => m.getProductAdmin(id));
        if (p) out.set(`product:${id}`, humanize(p.publication));
      }),
      ...of('customer').map(async (id) => {
        const c = await this.core.soft('customers', 'getCustomer', (m) => m.getCustomer(id));
        if (c) out.set(`customer:${id}`, humanize(c.accountStatus));
      }),
      ...of('order').map(async (id) => {
        const o = await this.core.soft('orders', 'getOrder', (m) => m.getOrder(id));
        if (o) out.set(`order:${id}`, o.statusLabel);
      }),
    ]);
    return out;
  }

  async filterOf(q: { status?: string; type?: string; riskLevel?: string; source?: string; assigneeId?: string; subjectType?: string; subjectId?: string; q?: string; sort?: string }): Promise<ReportFilter> {
    const t = await this.core.thresholds();
    const f: ReportFilter = { sort: (['risk', 'newest', 'oldest', 'deadline'].includes(q.sort ?? '') ? q.sort : 'risk') as ReportFilter['sort'] };
    if (q.status) f.statuses = q.status === 'active' ? [...ACTIVE] : [q.status];
    if (q.type) f.type = q.type;
    if (q.source) f.source = q.source;
    if (q.assigneeId) f.assigneeId = q.assigneeId;
    if (q.subjectType) f.subjectType = q.subjectType;
    if (q.subjectId) f.subjectId = q.subjectId;
    if (q.q) f.q = q.q;
    if (q.riskLevel === 'high') f.minScore = t.high;
    else if (q.riskLevel === 'medium') Object.assign(f, { minScore: t.medium, maxScore: t.high });
    else if (q.riskLevel === 'low') f.maxScore = t.medium;
    return f;
  }

  async list(q: Parameters<Reports['filterOf']>[0], page: PageRequest): Promise<Page<ReportRow>> {
    const res = await this.core.repo.listReports(await this.filterOf(q), { offset: offsetOf(page), limit: page.limit });
    const aggs = await this.core.loadMany(res.items.map((r) => r.id));
    const list = res.items.map((r) => aggs.get(r.id)!);
    const c = await this.views.context(list, { media: false });
    return pageFrom(
      list.map((a) => this.views.row(a, c)),
      res.total,
      page,
    );
  }

  async overview(): Promise<TrustOverview> {
    const t = await this.core.thresholds();
    const o = await this.core.repo.overview(t.high);
    const typeNotes: Record<string, string> = {};
    for (const [type, n] of Object.entries(o.byType)) {
      const high = o.highByType[type] ?? 0;
      typeNotes[type] = type === 'suspicious_orders' && o.ordersInSuspicious ? `${o.ordersInSuspicious} order${o.ordersInSuspicious === 1 ? '' : 's'} under review` : high ? `${high} high risk` : `${n} open`;
    }
    const waiting = await this.core.repo.find('appeals', { state: ['open', 'under_review'] }, { orderBy: [['decide_by', 'asc']] });
    const recs = await this.core.repo.count('recommendations', { state: 'sent_to_owner' });
    const owner = await this.core.ctx
      .use('access')
      .membersOfRole('trust_and_risk_manager')
      .catch(() => []);
    const lead = owner[0];
    return {
      open: o.open,
      highRisk: o.highRisk,
      byType: o.byType,
      typeNotes,
      appealsWaiting: waiting.length,
      nextAppealDecideBy: waiting[0]?.decide_by.toISOString() ?? null,
      recommendationsWaitingOnOwners: recs,
      queueOwner: lead ? { staffId: lead.accountId, name: lead.name, role: lead.roleLabel ?? 'Trust and Risk Manager' } : null,
    };
  }

  /* ================================================================ investigation */

  private ensure(status: string, event: string) {
    return trustReportMachine.next(status as ReportStatus, event as never);
  }

  async assign(id: string, body: { staffId: string; dueAt?: string | null }, by: By): Promise<TrustReport> {
    const ref = await this.core.ctx.use('access').getStaffRef(body.staffId).catch(() => null);
    if (!ref) throw invalidField('staffId', 'Choose a staff member');
    if (body.dueAt && Date.parse(body.dueAt) <= this.core.now().getTime()) throw invalidField('dueAt', 'A deadline in the future');
    const { before, after } = await this.core.write(id, by, async (tx, agg) => {
      const r = agg.report;
      const status = r.status === 'open' ? this.ensure(r.status, 'assign') : this.core.isActive(r.status) ? r.status : this.ensure(r.status, 'assign');
      const after = await tx.update('reports', id, { status, assignee_staff_id: body.staffId, ...(body.dueAt ? { due_at: new Date(body.dueAt) } : {}), updated_at: this.core.now() });
      await this.core.timeline(tx, id, [{ kind: 'assigned', label: `Assigned to ${ref.name}`, actor: by.actor, meta: { staffId: body.staffId } }]);
      return { before: r, after };
    });
    await this.core.audit({ action: 'trust.report.assign', actionLabel: 'Assigned a trust report', target: this.target(after), before: { status: before.status, assignee: before.assignee_staff_id }, after: { status: after.status, assignee: after.assignee_staff_id, dueAt: after.due_at } }, by);
    return this.get(id);
  }

  async escalate(id: string, body: { reason: string }, by: By): Promise<TrustReport> {
    if (!text(body.reason)) throw invalidField('reason', 'Why does it need escalating?');
    const { before, after } = await this.core.write(id, by, async (tx, agg, batch) => {
      const status = this.ensure(agg.report.status, 'escalate');
      const after = await tx.update('reports', id, { status, updated_at: this.core.now() });
      await this.core.timeline(tx, id, [{ kind: 'escalated', label: 'Escalated to the Trust and Risk Manager', text: body.reason.trim(), actor: by.actor }]);
      batch.push('trust.report.escalated', { reportId: id, reason: body.reason.trim() });
      return { before: agg.report, after };
    });
    await this.core.audit({ action: 'trust.report.escalate', actionLabel: 'Escalated a trust report', target: this.target(after), reason: body.reason, before: { status: before.status }, after: { status: after.status } }, by);
    return this.get(id);
  }

  async addEvidence(id: string, body: EvidenceInput, by: By): Promise<EvidenceItem> {
    const issues = this.checkEvidence([body], 'body');
    if (issues.length) throw invalid(issues.map((i) => ({ ...i, path: i.path.replace(/^body\[0\]\./, '') })));
    const agg = await this.core.required(id);
    if (agg.report.status === 'merged') throw illegal('Trust report', 'merged', 'addEvidence', 'This report was merged; add evidence to the kept report');
    await this.core.attach(body.mediaIds, id, `Report ${agg.report.ref}`, { kind: 'staff', id: by.actor.id ?? null });
    const row = this.evidenceRow(id, body, 'staff', by.actor);
    await this.core.write(id, by, async (tx, a) => {
      await tx.insert('evidence', row);
      await this.core.timeline(tx, id, [{ kind: 'evidence_added', label: `Evidence added: ${humanize(body.kind)}${body.result ? ` (${body.result})` : ''}`, text: body.text, actor: by.actor, meta: { evidenceId: row.id } }]);
      await this.core.rescoreIn(tx, id);
      await tx.update('reports', id, { updated_at: this.core.now() });
      void a;
    });
    await this.core.audit({ action: 'trust.evidence.add', actionLabel: 'Added evidence to a trust report', target: this.target(agg.report), after: { kind: row.kind, result: row.result, text: row.text, mediaIds: row.media_ids } }, by);
    return this.views.evidence(row, await this.core.mediaRefs(row.media_ids));
  }

  async requestEvidence(id: string, body: { to: TrustSubject; question: string; dueAt: string }, by: By): Promise<EvidenceRequest> {
    const issues: { path: string; message: string }[] = [];
    if (!['seller', 'customer'].includes(body.to?.type)) issues.push({ path: 'to.type', message: 'Ask a seller or a customer' });
    if (!isUuid(body.to?.id)) issues.push({ path: 'to.id', message: 'Who to ask' });
    if (!text(body.question)) issues.push({ path: 'question', message: 'What proof is needed?' });
    if (!(Date.parse(body.dueAt) > this.core.now().getTime())) issues.push({ path: 'dueAt', message: 'A deadline in the future' });
    if (issues.length) throw invalid(issues);
    // the customers-module id when proof is asked from a customer (requests may name the account id)
    const customerId = body.to.type === 'customer' ? await this.customerIdOf(body.to.id) : null;
    const row = await this.core.write(id, by, async (tx, agg, batch) => {
      if (!this.core.isActive(agg.report.status)) throw illegal('Trust report', agg.report.status, 'requestEvidence', 'Reopen the report before asking for proof');
      await tx.insertIgnore('report_subjects', this.core.subjectRows(id, [{ ...body.to, label: body.to.label || humanize(body.to.type) }]));
      const row = await tx.insert('evidence_requests', {
        id: newId(),
        report_id: id,
        to_type: body.to.type,
        to_id: body.to.id,
        question: body.question.trim(),
        due_at: new Date(body.dueAt),
        state: 'open',
        answer: null,
        answer_media_ids: [],
        answered_at: null,
      });
      await this.core.timeline(tx, id, [{ kind: 'evidence_requested', label: `Proof requested from the ${body.to.type}`, text: row.question, actor: by.actor, meta: { requestId: row.id } }]);
      await tx.update('reports', id, { updated_at: this.core.now() });
      batch.push('trust.evidence.requested', {
        requestId: row.id,
        reportId: id,
        reportRef: agg.report.ref,
        toType: row.to_type,
        toId: row.to_id,
        customerId: row.to_type === 'customer' ? customerId : null,
        sellerId: row.to_type === 'seller' ? row.to_id : null,
        question: row.question,
        dueAt: row.due_at.toISOString(),
      });
      return row;
    });
    const agg = (await this.core.load(id))!;
    await this.core.audit({ action: 'trust.evidence.request', actionLabel: 'Asked for proof', target: this.target(agg.report), after: { to: body.to, question: row.question, dueAt: row.due_at } }, by);
    return this.views.request(row, agg.subjects, new Map(), this.core.now(), agg.report.ref);
  }

  /**
   * The seller or customer sends the requested proof (only while open and before dueAt); the files are attached
   * to the report as evidence from the reported party (media usage trust_evidence).
   */
  async answerRequest(requestId: string, body: { answer: string; mediaIds?: string[] | null }, who: { type: 'seller' | 'customer'; ids: string[]; actor: common.Actor; mediaOwner: Reporter['mediaOwner'] }, by: By): Promise<EvidenceRequest> {
    const req = isUuid(requestId) ? await this.core.repo.get('evidence_requests', requestId) : undefined;
    if (!req || req.to_type !== who.type || !who.ids.includes(req.to_id)) throw notFound('Evidence request');
    if (req.state === 'open' && req.due_at.getTime() < this.core.now().getTime()) throw illegal('Evidence request', 'expired', 'answer', `The deadline for this proof was ${req.due_at.toISOString().slice(0, 10)}`);
    if (!text(body.answer)) throw invalidField('answer', 'Answer the question');
    evidenceRequestMachine.next(req.state as 'open', 'answer');
    await this.core.attach(body.mediaIds, req.report_id, 'Proof for Trust and Risk', who.mediaOwner);
    const row = await this.core.write(req.report_id, by, async (tx, agg, batch) => {
      const cur = (await tx.get('evidence_requests', requestId, { forUpdate: true }))!;
      const state = evidenceRequestMachine.next(cur.state as 'open', 'answer');
      const now = this.core.now();
      const row = await tx.update('evidence_requests', requestId, { state, answer: body.answer.trim(), answer_media_ids: [...new Set(body.mediaIds ?? [])], answered_at: now });
      const e = this.evidenceRow(req.report_id, { kind: 'document', text: `Answer to “${cur.question}”: ${body.answer.trim()}`, mediaIds: body.mediaIds, visibility: 'shared_with_subject' }, 'reported_party', who.actor, now);
      await this.extend(tx, agg, { evidence: [e], label: `Proof received from the ${who.type}`, actor: who.actor });
      batch.push('trust.evidence.received', { requestId, reportId: req.report_id });
      return row;
    });
    // the "send proof" action notice notifications raised for trust.evidence.requested closes once answered
    await this.core.soft('notifications', 'resolve evidence notice', (n) => n.resolve(`trust-evidence:${requestId}`, 'Proof sent'));
    const agg = (await this.core.load(req.report_id))!;
    return this.views.request(row, agg.subjects, await this.core.mediaRefs(row.answer_media_ids), this.core.now(), agg.report.ref);
  }

  /** Requests addressed to a seller or customer (any id it may be stored under); the reporter is never named */
  async listRequestsFor(type: 'seller' | 'customer', ids: string | string[], state?: string): Promise<EvidenceRequest[]> {
    const list = (Array.isArray(ids) ? ids : [ids]).filter(isUuid);
    if (!list.length) return [];
    const rows = await this.core.repo.find('evidence_requests', { to_type: type, to_id: list, ...(state ? { state } : {}) }, { orderBy: [['due_at', 'desc']], limit: 200 });
    const aggs = await this.core.loadMany(rows.map((r) => r.report_id));
    const media = await this.core.mediaRefs(rows.flatMap((r) => r.answer_media_ids));
    const now = this.core.now();
    return rows.map((r) => this.views.request(r, aggs.get(r.report_id)?.subjects ?? [], media, now, aggs.get(r.report_id)?.report.ref ?? null));
  }

  async link(id: string, body: { subjects?: TrustSubject[] | null; caseRefs?: string[] | null }, by: By): Promise<TrustReport> {
    const issues = this.checkSubjects(body.subjects);
    if (!body.subjects?.length && !body.caseRefs?.length) issues.push({ path: 'subjects', message: 'Link at least one subject or case' });
    if (issues.length) throw invalid(issues);
    await this.core.write(id, by, async (tx, agg) => {
      if (agg.report.status === 'merged') throw illegal('Trust report', 'merged', 'link');
      const existing = new Set(agg.events.filter((e) => e.kind === 'case_linked').map((e) => String(e.detail.caseRef)));
      const added = await tx.insertIgnore('report_subjects', this.core.subjectRows(id, (body.subjects ?? []).map((s) => ({ ...s, label: s.label || humanize(s.type) }))));
      const cases = [...new Set((body.caseRefs ?? []).map((c) => c.trim()).filter((c) => c && !existing.has(c)))];
      await this.core.timeline(tx, id, [
        ...(added ? [{ kind: 'linked', label: `${added} subject${added === 1 ? '' : 's'} linked`, actor: by.actor }] : []),
        ...cases.map((caseRef) => ({ kind: 'case_linked', label: `Support case ${caseRef} linked`, actor: by.actor, meta: { caseRef } })),
      ]);
      if (added) await this.core.rescoreIn(tx, id);
      await tx.update('reports', id, { updated_at: this.core.now() });
    });
    return this.get(id);
  }

  async overrideRisk(id: string, body: { score: number; reason: string }, by: By): Promise<TrustReport> {
    if (!Number.isInteger(body.score) || body.score < 0 || body.score > 100) throw invalidField('score', 'A score from 0 to 100');
    if (!text(body.reason)) throw invalidField('reason', 'Why does the score change?');
    const { before, after } = await this.core.write(id, by, async (tx, agg) => {
      const override = { score: body.score, reason: body.reason.trim(), by: by.actor, at: this.core.now().toISOString() };
      const after = await tx.update('reports', id, { risk_score: body.score, risk_override: override, updated_at: this.core.now() });
      await this.core.timeline(tx, id, [{ kind: 'risk_override', label: `Risk score set to ${body.score} (was ${agg.report.risk_score})`, text: body.reason.trim(), actor: by.actor }]);
      return { before: agg.report, after };
    });
    await this.core.audit({ action: 'trust.report.risk_override', actionLabel: 'Overrode a risk score', target: this.target(after), reason: body.reason, before: { riskScore: before.risk_score }, after: { riskScore: after.risk_score } }, by);
    return this.get(id);
  }

  async note(id: string, body: { body: string }, by: By): Promise<TrustReport> {
    if (!text(body.body)) throw invalidField('body', 'Write the note');
    const me = (await this.core.staffRefs([by.actor.id])).get(by.actor.id ?? '');
    await this.core.write(id, by, async (tx) => {
      await tx.insert('report_notes', { id: newId(), report_id: id, body: body.body.trim(), author_id: by.actor.id ?? 'system', author_name: me?.name ?? by.actor.name ?? 'Staff member', at: this.core.now() });
      await tx.update('reports', id, { updated_at: this.core.now() });
    });
    return this.get(id);
  }

  /** Records the assessment of a seller application or account and answers the requester (resolves the report) */
  async assess(id: string, body: { level: 'low' | 'medium' | 'high'; flags: unknown[]; recommendation: string; recommendedHoldDays?: number | null }, by: By): Promise<TrustReport> {
    const issues: { path: string; message: string }[] = [];
    if (!['low', 'medium', 'high'].includes(body.level)) issues.push({ path: 'level', message: 'low, medium or high' });
    const flags = (body.flags ?? []).map((f) => (f && typeof f === 'object' ? (f as Record<string, unknown>) : { text: String(f ?? '') }));
    flags.forEach((f, i) => {
      if (!text(f.text)) issues.push({ path: `flags[${i}].text`, message: 'Describe the flag' });
    });
    if (!text(body.recommendation)) issues.push({ path: 'recommendation', message: 'What do you recommend?' });
    if (body.recommendedHoldDays !== undefined && body.recommendedHoldDays !== null && (!Number.isInteger(body.recommendedHoldDays) || body.recommendedHoldDays < 0)) issues.push({ path: 'recommendedHoldDays', message: 'Whole days' });
    if (issues.length) throw invalid(issues);
    const pre = await this.core.required(id);
    if (!['seller_application', 'account_risk'].includes(pre.report.type)) throw invalidField('type', 'Assessments are recorded on seller application and account risk reports');
    const reporters = await this.reportersOf(id);
    const { after, payload } = await this.core.write(id, by, async (tx, agg, batch) => {
      const r = agg.report;
      let status = r.status;
      if (status === 'open') status = this.ensure(status, 'assign');
      status = this.ensure(status, 'resolve');
      const now = this.core.now();
      const asked = r.assessment ?? null;
      const main = agg.subjects.find((s) => s.subject_type === 'application') ?? agg.subjects.find((s) => s.subject_type === 'seller') ?? agg.subjects.find((s) => s.subject_type === 'customer') ?? agg.subjects[0];
      const subjectType = asked?.subjectType ?? (main?.subject_type === 'application' ? 'seller_application' : (main?.subject_type ?? 'seller'));
      const subjectId = asked?.subjectId ?? main?.subject_id ?? id;
      const assessment: Assessment = {
        level: body.level,
        flags: flags.map((f) => ({ severity: typeof f.severity === 'string' ? f.severity : 'info', text: String(f.text).trim() })),
        recommendation: body.recommendation.trim(),
        recommendedHoldDays: body.recommendedHoldDays ?? null,
        subjectType,
        subjectId,
        ...(asked?.requestedBy ? { requestedBy: asked.requestedBy } : {}),
        ...(asked?.question ? { question: asked.question } : {}),
      };
      const resolution = { outcome: 'referred', summary: `Assessment: ${body.level} risk. ${assessment.recommendation}`, decidedBy: by.actor, decidedAt: now.toISOString() };
      const after = await tx.update('reports', id, { status, assessment, resolution, assignee_staff_id: r.assignee_staff_id ?? (by.actor.id && isUuid(by.actor.id) ? by.actor.id : null), updated_at: now });
      await this.cancelOpenRequests(tx, agg, 'The report was resolved');
      await this.core.timeline(tx, id, [{ kind: 'assessed', label: `Assessment recorded: ${body.level} risk`, text: assessment.recommendation, actor: by.actor }]);
      const payload = { reportId: id, subjectType, subjectId, level: body.level, flags: assessment.flags, recommendation: assessment.recommendation, recommendedHoldDays: assessment.recommendedHoldDays ?? null };
      batch.push('trust.assessment.completed', payload);
      batch.push('trust.report.resolved', { reportId: id, ref: r.ref, outcome: 'referred', reporterOutcome: null, reporters });
      return { after, payload };
    });
    await this.core.audit({ action: 'trust.assessment.record', actionLabel: 'Recorded a risk assessment', target: this.target(after), after: payload }, by);
    return this.get(id);
  }

  private async cancelOpenRequests(tx: TrustRepository, agg: Agg, why: string) {
    for (const r of agg.requests.filter((x) => x.state === 'open')) {
      await tx.update('evidence_requests', r.id, { state: evidenceRequestMachine.next('open', 'cancel') });
      await this.core.timeline(tx, agg.report.id, [{ kind: 'evidence_request_cancelled', label: 'Proof request cancelled', text: why, meta: { requestId: r.id } }]);
    }
  }

  async resolve(id: string, body: { outcome: (typeof OUTCOMES)[number]; summary: string; reporterOutcome: string }, by: By): Promise<TrustReport> {
    const issues: { path: string; message: string }[] = [];
    if (!(OUTCOMES as readonly string[]).includes(body.outcome)) issues.push({ path: 'outcome', message: OUTCOMES.join(', ') });
    if (!text(body.summary)) issues.push({ path: 'summary', message: 'Summarise the decision' });
    if (!text(body.reporterOutcome)) issues.push({ path: 'reporterOutcome', message: 'What the reporter is told' });
    if (issues.length) throw invalid(issues);
    const reporters = isUuid(id) ? await this.reportersOf(id) : [];
    const { before, after } = await this.core.write(id, by, async (tx, agg, batch) => {
      const status = this.ensure(agg.report.status, 'resolve');
      const open = agg.recommendations.filter((r) => r.state === 'sent_to_owner');
      if (open.length && body.outcome !== 'referred') throw this.core.error('RECOMMENDATIONS_OPEN', `${open.length} recommendation${open.length === 1 ? ' is' : 's are'} still with the owner team${open.length === 1 ? '' : 's'}`, { recommendationIds: open.map((r) => r.id) });
      const now = this.core.now();
      const after = await tx.update('reports', id, {
        status,
        resolution: { outcome: body.outcome, summary: body.summary.trim(), decidedBy: by.actor, decidedAt: now.toISOString() },
        reporter_outcome: body.reporterOutcome.trim(),
        updated_at: now,
      });
      await this.cancelOpenRequests(tx, agg, 'The report was resolved');
      await this.core.timeline(tx, id, [{ kind: 'resolved', label: `Resolved: ${humanize(body.outcome)}`, text: body.summary.trim(), actor: by.actor }]);
      batch.push('trust.report.resolved', { reportId: id, ref: agg.report.ref, outcome: body.outcome, reporterOutcome: body.reporterOutcome.trim(), reporters });
      return { before: agg.report, after };
    });
    await this.core.audit({ action: 'trust.report.resolve', actionLabel: 'Resolved a trust report', target: this.target(after), reason: body.summary, before: { status: before.status }, after: { status: after.status, outcome: body.outcome, reporterOutcome: body.reporterOutcome } }, by);
    return this.get(id);
  }

  async dismiss(id: string, body: { reason: string; reporterOutcome: string }, by: By): Promise<TrustReport> {
    const issues: { path: string; message: string }[] = [];
    if (!text(body.reason)) issues.push({ path: 'reason', message: 'Why is it dismissed?' });
    if (!text(body.reporterOutcome)) issues.push({ path: 'reporterOutcome', message: 'What the reporter is told' });
    if (issues.length) throw invalid(issues);
    const reporters = isUuid(id) ? await this.reportersOf(id) : [];
    const { before, after } = await this.core.write(id, by, async (tx, agg, batch) => {
      const status = this.ensure(agg.report.status, 'dismiss');
      const now = this.core.now();
      const after = await tx.update('reports', id, {
        status,
        resolution: { outcome: 'dismissed', summary: body.reason.trim(), decidedBy: by.actor, decidedAt: now.toISOString() },
        reporter_outcome: body.reporterOutcome.trim(),
        updated_at: now,
      });
      await this.cancelOpenRequests(tx, agg, 'The report was dismissed');
      await this.core.timeline(tx, id, [{ kind: 'dismissed', label: 'Dismissed', text: body.reason.trim(), actor: by.actor }]);
      batch.push('trust.report.resolved', { reportId: id, ref: agg.report.ref, outcome: 'dismissed', reporterOutcome: body.reporterOutcome.trim(), reporters });
      return { before: agg.report, after };
    });
    await this.core.audit({ action: 'trust.report.dismiss', actionLabel: 'Dismissed a trust report', target: this.target(after), reason: body.reason, before: { status: before.status }, after: { status: after.status, reporterOutcome: body.reporterOutcome } }, by);
    return this.get(id);
  }

  async reopen(id: string, body: { reason: string }, by: By): Promise<TrustReport> {
    if (!text(body.reason)) throw invalidField('reason', 'What changed?');
    const pre = await this.core.required(id);
    const due = await this.core.dueAt(pre.report.risk_score);
    const { before, after } = await this.core.write(id, by, async (tx, agg) => {
      const status = this.ensure(agg.report.status, 'reopen');
      const after = await tx.update('reports', id, { status, resolution: null, due_at: due, updated_at: this.core.now() });
      await this.core.timeline(tx, id, [{ kind: 'reopened', label: 'Reopened', text: body.reason.trim(), actor: by.actor, meta: { previousResolution: agg.report.resolution } }]);
      return { before: agg.report, after };
    });
    await this.core.audit({ action: 'trust.report.reopen', actionLabel: 'Reopened a trust report', target: this.target(after), reason: body.reason, before: { status: before.status, resolution: before.resolution }, after: { status: after.status } }, by);
    return this.get(id);
  }

  /** Merges a duplicate into the kept report: subjects, evidence, reporters, open proof requests and linked cases move */
  async merge(id: string, body: { intoReportId: string; reason: string }, by: By): Promise<TrustReport> {
    if (!text(body.reason)) throw invalidField('reason', 'Why is it a duplicate?');
    if (!isUuid(body.intoReportId) || body.intoReportId === id) throw invalidField('intoReportId', 'Choose another report to keep');
    const batch = new Batch(by);
    const { before, after, kept } = await this.core.repo.transaction(async (tx) => {
      const [first, second] = [id, body.intoReportId].sort();
      await tx.get('reports', first!, { forUpdate: true });
      await tx.get('reports', second!, { forUpdate: true });
      const agg = await this.core.load(id, tx);
      if (!agg) throw notFound();
      const into = await this.core.load(body.intoReportId, tx);
      if (!into) throw invalidField('intoReportId', 'That report was not found');
      if (!this.core.isActive(into.report.status)) throw invalidField('intoReportId', 'Merge into an open report');
      const status = this.ensure(agg.report.status, 'merge');
      const now = this.core.now();
      await tx.insertIgnore('report_subjects', agg.subjects.map((s) => ({ ...s, report_id: into.report.id })));
      await tx.updateWhere('evidence', { report_id: id }, { report_id: into.report.id });
      await tx.updateWhere('evidence_requests', { report_id: id, state: 'open' }, { report_id: into.report.id });
      const kept = await tx.update('reports', into.report.id, { reporter_count: into.report.reporter_count + agg.report.reporter_count, updated_at: now });
      const after = await tx.update('reports', id, {
        status,
        merged_into_id: into.report.id,
        resolution: { outcome: 'duplicate', summary: body.reason.trim(), decidedBy: by.actor, decidedAt: now.toISOString() },
        updated_at: now,
      });
      const cases = agg.events.filter((e) => e.kind === 'case_linked').map((e) => String(e.detail.caseRef));
      const keptCases = new Set(into.events.filter((e) => e.kind === 'case_linked').map((e) => String(e.detail.caseRef)));
      await this.core.timeline(tx, into.report.id, [
        { kind: 'merged_in', label: `Report ${agg.report.ref} merged into this one`, text: body.reason.trim(), actor: by.actor, meta: { reportId: id } },
        ...cases.filter((c) => !keptCases.has(c)).map((caseRef) => ({ kind: 'case_linked', label: `Support case ${caseRef} linked`, actor: by.actor, meta: { caseRef } })),
      ]);
      await this.core.timeline(tx, id, [{ kind: 'merged', label: `Merged into ${into.report.ref}`, text: body.reason.trim(), actor: by.actor, meta: { intoReportId: into.report.id } }]);
      await this.core.rescoreIn(tx, into.report.id);
      return { before: agg.report, after, kept };
    });
    this.core.flush(batch);
    await this.core.audit({ action: 'trust.report.merge', actionLabel: 'Merged a duplicate trust report', target: this.target(after), relatedTargets: [this.target(kept)], reason: body.reason, before: { status: before.status }, after: { status: after.status, mergedInto: kept.ref } }, by);
    return this.get(id);
  }

  target(r: ReportRec) {
    return { type: 'trust_report', id: r.id, ref: r.ref, label: r.title, screen: 'admin/trust' };
  }

  /* ================================================================ other modules and GraphQL */

  /** Ids a customer or seller may be stored under as reporter (customer id and account id) */
  private async reporterIdsOf(subjectType: string, subjectId: string): Promise<string[]> {
    if (subjectType !== 'customer') return [subjectId];
    const c = await this.core.soft('customers', 'getCustomer', (m) => m.getCustomer(subjectId));
    return [...new Set([subjectId, ...(c?.userId ? [c.userId] : [])])];
  }

  async reportsAbout(subjectType: string, subjectId: string): Promise<{ filedBy: number; against: number; open: number; reportIds: string[] }> {
    if (!isUuid(subjectId)) return { filedBy: 0, against: 0, open: 0, reportIds: [] };
    const against = await this.core.repo.reportIdsAbout([subjectType], subjectId);
    const againstRows = against.length ? await this.core.repo.find('reports', { id: against, status: { op: '<>', value: 'merged' } }) : [];
    const filed = ['customer', 'seller'].includes(subjectType) ? await this.core.repo.find('reports', { reporter_kind: subjectType, reporter_id: await this.reporterIdsOf(subjectType, subjectId), status: { op: '<>', value: 'merged' } }) : [];
    const all = [...new Map([...againstRows, ...filed].map((r) => [r.id, r])).values()].sort((a, b) => b.created_at.getTime() - a.created_at.getTime());
    return { filedBy: filed.length, against: againstRows.length, open: againstRows.filter((r) => this.core.isActive(r.status)).length, reportIds: all.map((r) => r.id) };
  }

  /**
   * Ids of customers or sellers with reports filed by them or about them (their offers and products name the seller
   * as a subject too); openOnly keeps open, under review and escalated reports. Used by the customer and seller lists
   * to filter hasAbuseReports before paging. Customer reporters stored under their account id (customers did not
   * know them when they reported) are mapped to their customer id.
   */
  async subjectIdsWithReports(subjectType: 'customer' | 'seller', filter: { role?: 'filed_by' | 'against'; openOnly?: boolean; ids?: string[] }): Promise<string[]> {
    if (subjectType !== 'customer' && subjectType !== 'seller') return [];
    const ids = filter.ids ? filter.ids.filter(isUuid) : undefined;
    if (ids && !ids.length) return [];
    const o = { ...(filter.openOnly ? { statuses: [...ACTIVE] } : {}), ...(ids ? { ids } : {}) };
    const out = new Set<string>();
    if (filter.role !== 'filed_by') for (const id of await this.core.repo.subjectIdsAbout(subjectType, o)) out.add(id);
    if (filter.role !== 'against') {
      // customer reporters may be stored under their account id: with an id list, look for both ids of each customer
      const byAccount = new Map<string, string>();
      if (subjectType === 'customer' && ids) {
        for (const id of ids) {
          const c = await this.core.soft('customers', 'getCustomer', (m) => m.getCustomer(id));
          if (c?.userId && c.userId !== id) byAccount.set(c.userId, id);
        }
      }
      const filers = await this.core.repo.reporterIdsFiling(subjectType, byAccount.size ? { ...o, ids: [...ids!, ...byAccount.keys()] } : o);
      for (const stored of filers) {
        if (subjectType === 'seller' || out.has(stored) || ids?.includes(stored)) {
          out.add(stored);
          continue;
        }
        const customerId = byAccount.get(stored) ?? (await this.customerIdOf(stored));
        if (customerId) out.add(customerId);
      }
    }
    return [...out].filter((id) => !ids || ids.includes(id));
  }

  async listAbout(subjectType: 'customer' | 'seller', subjectId: string, filter: { role?: 'filed_by' | 'against'; statuses?: string[] }, pageInput: common.PageInput): Promise<Page<TrustReport>> {
    const page = toPageRequest(pageInput);
    if (!isUuid(subjectId)) return pageFrom([], 0, page);
    const ids = new Set<string>();
    if (filter.role !== 'filed_by') for (const id of await this.core.repo.reportIdsAbout([subjectType], subjectId)) ids.add(id);
    if (filter.role !== 'against') for (const r of await this.core.repo.find('reports', { reporter_kind: subjectType, reporter_id: await this.reporterIdsOf(subjectType, subjectId) })) ids.add(r.id);
    const statuses = filter.statuses?.length ? filter.statuses : undefined;
    const res = await this.core.repo.listReports({ ids: [...ids], ...(statuses ? { statuses } : {}), sort: 'newest' }, { offset: offsetOf(page), limit: page.limit });
    const aggs = await this.core.loadMany(res.items.map((r) => r.id));
    const list = res.items.map((r) => aggs.get(r.id)!);
    const c = await this.views.context(list, { media: false });
    return pageFrom(
      list.map((a) => this.views.report(a, c, { summary: true })),
      res.total,
      page,
    );
  }

  async summaries(reportIds: string[]): Promise<TrustReport[]> {
    const ids = [...new Set(reportIds)].filter(isUuid);
    if (!ids.length) return [];
    const aggs = await this.core.loadMany(ids);
    const list = ids.map((id) => aggs.get(id)).filter((a): a is Agg => !!a);
    const c = await this.views.context(list, { media: false });
    return list.map((a) => this.views.report(a, c, { summary: true }));
  }

  /* ================================================================ exports */

  #registered: Promise<void> | null = null;

  registerDataset(): Promise<void> {
    const api = this.core.ctx.tryUse('reports');
    if (!api) return Promise.resolve();
    this.#registered ??= api
      .registerDataset({
        key: DATASET,
        owner: 'trust',
        title: 'Trust and Risk queue',
        permission: 'trust.reports.export',
        audience: 'staff',
        screens: ['admin/trust'],
        available: true,
        phase: 1,
        columns: [
          { key: 'ref', label: 'Report' },
          { key: 'type', label: 'Type' },
          { key: 'title', label: 'Title' },
          { key: 'status', label: 'Status' },
          { key: 'riskScore', label: 'Risk score' },
          { key: 'riskLevel', label: 'Risk level' },
          { key: 'source', label: 'Source' },
          { key: 'reporterCount', label: 'Reporters' },
          { key: 'reporter', label: 'Reporter', permission: 'trust.reports.export-identities' },
          { key: 'reporterContact', label: 'Reporter contact', permission: 'trust.reports.export-identities' },
          { key: 'subjects', label: 'Subjects' },
          { key: 'assignee', label: 'Assignee' },
          { key: 'deadline', label: 'Deadline' },
          { key: 'outcome', label: 'Outcome' },
          { key: 'createdAt', label: 'Opened at' },
        ],
      })
      .catch((err) => {
        this.#registered = null;
        if (!isAppError(err)) this.core.ctx.log.warn({ err }, 'trust: dataset registration failed');
      });
    return this.#registered;
  }

  async requestExport(body: { filters: unknown; format?: 'csv' | 'xlsx' | null }, principal: identity.Principal, by: By): Promise<reports.ExportJob> {
    const api = this.core.ctx.tryUse('reports');
    // reports off: the dataset cannot be exported (same code reports answers when it refuses the dataset)
    if (!api) throw this.core.ctx.error('DATASET_UNAVAILABLE', 'The trust queue cannot be exported while reports is switched off', { dataset: DATASET });
    await this.registerDataset();
    const filters = body.filters && typeof body.filters === 'object' && !Array.isArray(body.filters) ? body.filters : {};
    const job = await api.requestExport({ dataset: DATASET, filters, format: body.format ?? 'csv', principal });
    const identities = by.can ? await by.can('trust.reports.export-identities') : false;
    await this.core.audit({ action: 'trust.reports.export', actionLabel: 'Exported the trust queue', target: { type: 'export', id: job.id, ref: job.ref, label: 'Trust queue export', screen: 'admin/trust' }, after: { dataset: DATASET, filters, format: body.format ?? 'csv', reporterIdentities: identities } }, by);
    return job;
  }

  async exportRows(dataset: string, filters: unknown, principal: identity.Principal, cursor?: string): Promise<{ rows: unknown[]; nextCursor?: string }> {
    if (dataset !== DATASET) throw notFound('Dataset');
    if (principal?.kind !== 'staff') throw new AppError('FORBIDDEN', 'Staff only');
    const f = (filters && typeof filters === 'object' ? filters : {}) as Record<string, unknown>;
    const str = (k: string) => (typeof f[k] === 'string' && f[k] ? (f[k] as string) : undefined);
    const filter = await this.filterOf({ status: str('status'), type: str('type'), riskLevel: str('riskLevel'), source: str('source'), assigneeId: str('assigneeId'), subjectType: str('subjectType'), subjectId: str('subjectId'), q: str('q'), sort: str('sort') });
    const access = this.core.ctx.use('access');
    const identities = await access.hasPermission(principal, 'trust.reports.export-identities').catch(() => false);
    const offset = cursor ? Number(decodeCursor(cursor)[0]) || 0 : 0;
    const limit = 200;
    const res = await this.core.repo.listReports(filter, { offset, limit });
    const aggs = await this.core.loadMany(res.items.map((r) => r.id));
    const list = res.items.map((r) => aggs.get(r.id)!);
    const c = await this.views.context(list, { media: false });
    const rows = list.map((a) => {
      const r = a.report;
      return {
        ref: r.ref,
        type: r.type,
        title: r.title,
        status: r.status,
        riskScore: r.risk_score,
        riskLevel: riskLevel(r.risk_score, c.thresholds),
        source: r.source,
        reporterCount: r.reporter_count,
        ...(identities ? { reporter: (r.reporter_name ? `${r.reporter_name}${r.reporter_org ? ` (${r.reporter_org})` : ''}` : null) ?? `${r.reporter_kind}${r.reporter_id ? ` ${r.reporter_id}` : ''}`, reporterContact: r.reporter_contact ?? '' } : {}),
        subjects: a.subjects.map((s) => `${s.subject_type}: ${s.label}`).join('; '),
        assignee: r.assignee_staff_id ? (c.staff.get(r.assignee_staff_id)?.name ?? '') : '',
        deadline: r.due_at && this.core.isActive(r.status) ? r.due_at.toISOString() : '',
        outcome: r.resolution?.outcome ?? '',
        createdAt: r.created_at.toISOString(),
      };
    });
    return offset + rows.length < res.total ? { rows, nextCursor: encodeCursor([offset + rows.length]) } : { rows };
  }
}
