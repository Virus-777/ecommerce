/**
 * Reports, the moderation queue and decisions, referrals to Trust and Risk, appeals and removals named in
 * trust enforcement. Reporter and author both see the outcome; reporters are never named to authors.
 */
import { AppError } from '../../../kernel/errors/index.js';
import { isUuid, newId } from '../../../kernel/lib/ids.js';
import { pageOf, type PageRequest } from '../../../kernel/lib/pagination.js';
import type * as common from '../../../spec/common.js';
import type {
  AppealInput,
  AppealRow,
  AppealView,
  Author,
  ContentParty,
  ModerationDecisionInput,
  ModerationDetail,
  ModerationItem,
  ModerationOutcome,
  ModerationReason,
  ModerationSummary,
  MyReport,
  Report,
  ReportInput,
  RuleCheck,
} from '../../../spec/reviews.js';
import {
  ADVERSE,
  addDays,
  ageLabel,
  AUTHOR_TEXT,
  CONTENT_NOUN,
  type CheckFailure,
  type ContentType,
  excerpt,
  mentionsSellerService,
  MODERATION_REASONS,
  OUTCOME_OF,
  qaChecks,
  reasonLabel,
  REPORT_REASON_LABEL,
  reporterOutcomeText,
  reviewChecks,
  SYSTEM_MODERATOR_ID,
} from '../domain/rules.js';
import { appealMachine, moderationItemMachine } from '../domain/state-machines.js';
import { MODERATION_EVENTS, RESPONSE_MODERATION_EVENTS, RESTORE_EVENTS } from '../domain/transitions.js';
import type { AppealRec, DecisionRec, ItemRec, ReferralRec, ReportRec } from '../ports.js';
import type { ReviewsRepository } from '../repository.js';
import { authorOf, type Content, findContent, isPublic, loadContent, machineOf, moveContent, productOf } from './content.js';
import { type By, type Core, Effects, invalid, notFound, TRUST_ACTOR } from './core.js';
import { appealView, type Views } from './views.js';

export type Reporter = { kind: 'customer' | 'seller'; id: string } & By;

const QUEUE_OF: Record<ContentType, string> = {
  product_review: 'auto_held',
  seller_feedback: 'auto_held',
  question: 'qa_check',
  answer: 'qa_check',
  seller_response: 'response_check',
};

/** Target state of a decision per content type (undefined: the decision does not apply) */
const TARGET: Record<ContentType, Partial<Record<ModerationDecisionInput['decision'], string>>> = {
  product_review: { keep: 'published', publish: 'published', remove: 'removed', request_edit: 'edit_requested' },
  seller_feedback: { keep: 'published', publish: 'published', remove: 'removed' },
  question: { keep: 'published', publish: 'published', remove: 'removed' },
  answer: { keep: 'published', publish: 'published', remove: 'removed', request_edit: 'edit_requested' },
  seller_response: { keep: 'published', publish: 'published', remove: 'rejected', reject_response: 'rejected' },
};

const REMOVED_STATE: Record<ContentType, string> = {
  product_review: 'removed',
  seller_feedback: 'removed',
  question: 'removed',
  answer: 'removed',
  seller_response: 'rejected',
};

const actorId = (a: common.Actor) => (a.id && isUuid(a.id) ? a.id : SYSTEM_MODERATOR_ID);

/** The author as the event names them (staff answers have no party to tell) */
const partyOf = (c: Content): ContentParty | null => {
  const a = authorOf(c);
  return a.kind === 'staff' || !isUuid(a.id) ? null : { kind: a.kind, id: a.id };
};

/** Customers and sellers whose reports a decision answers, once each (system and Trust reports have no one to tell) */
const reportersOf = (reports: readonly ReportRec[]): ContentParty[] => {
  const seen = new Map<string, ContentParty>();
  for (const r of reports) {
    if ((r.reporter_kind === 'customer' || r.reporter_kind === 'seller') && r.reporter_id && isUuid(r.reporter_id)) seen.set(`${r.reporter_kind}:${r.reporter_id}`, { kind: r.reporter_kind, id: r.reporter_id });
  }
  return [...seen.values()];
};

export class ModerationPart {
  constructor(
    private readonly core: Core,
    private readonly views: Views,
  ) {}

  /* ================================================================ holds (inside transactions) */

  /**
   * Content failing automatic checks (or needing a second look) waits in a queue, hidden, with a
   * system report listing why. One open item per content: an open one gets the new report.
   */
  async hold(tx: ReviewsRepository, c: { type: ContentType; id: string }, failures: CheckFailure[], o: { note?: string; queue?: string } = {}): Promise<ItemRec> {
    const now = this.core.now();
    const reasons = [...new Set(failures.map((f) => f.reason))];
    if (!reasons.length) reasons.push('other');
    const note = o.note ?? failures.map((f) => f.label).join('; ');
    let item = await tx.findOne('moderation_items', { content_type: c.type, content_id: c.id, status: 'open' }, { forUpdate: true });
    if (item) {
      item = await tx.update('moderation_items', item.id, {
        reasons: [...new Set([...((item.reasons as string[]) ?? []), ...reasons])],
        report_count: item.report_count + 1,
        visibility: 'hidden',
      });
    } else {
      item = await tx.insert('moderation_items', {
        id: newId(),
        content_type: c.type,
        content_id: c.id,
        queue: o.queue ?? QUEUE_OF[c.type],
        status: 'open',
        visibility: 'hidden',
        reasons,
        report_count: 1,
        first_reported_at: now,
        decided_at: null,
      });
    }
    await tx.insert('reports', {
      id: newId(),
      target_type: c.type,
      target_id: c.id,
      moderation_item_id: item.id,
      reporter_kind: 'system',
      reporter_id: null,
      reason: reasons[0]!,
      note: note || null,
      status: 'open',
      outcome_text: null,
      created_at: now,
      decided_at: null,
    });
    return item;
  }

  /** The author deleted the content: open items close and reporters are told */
  async closeForDeleted(tx: ReviewsRepository, type: ContentType, id: string) {
    const now = this.core.now();
    for (const item of await tx.find('moderation_items', { content_type: type, content_id: id, status: 'open' })) {
      await tx.update('moderation_items', item.id, { status: moderationItemMachine.next('open', 'decide'), decided_at: now });
      await tx.updateWhere('reports', { moderation_item_id: item.id, status: 'open' }, { status: 'decided', outcome_text: `The author deleted this ${CONTENT_NOUN[type]}.`, decided_at: now });
    }
  }

  /* ================================================================ reports */

  async report(by: Reporter, input: ReportInput): Promise<MyReport> {
    const content = await loadContent(this.core.repo, input.targetType, input.targetId);
    if (!content || !isPublic(content)) throw notFound('Content');
    const author = authorOf(content);
    if (author.kind === by.kind && author.id === by.id) throw invalid([{ path: 'targetId', message: "You can't report your own content" }]);
    const open = await this.core.repo.findOne('reports', { target_type: input.targetType, target_id: input.targetId, reporter_kind: by.kind, reporter_id: by.id, status: 'open' });
    if (open) throw this.core.ctx.error('ALREADY_REPORTED', 'You already reported this. We will let you know the outcome.', { reportId: open.id });
    const note = input.note?.trim() || null;
    if (note && note.length > 1000) throw invalid([{ path: 'note', message: 'The note is too long (1,000 characters at most)' }]);

    const hideReasons: readonly string[] = (await this.core.setting('hideOnReportReasons')) ?? [];
    const cooldownDays = await this.core.num('reportCooldownDays');
    const fx = await this.core.prepare(new Effects());
    const now = this.core.now();
    const hide = hideReasons.includes(input.reason);

    const report = await this.core.repo.transaction(async (tx) => {
      let c = (await loadContent(tx, content.type, content.row.id, { forUpdate: true }))!;
      let item = await tx.findOne('moderation_items', { content_type: c.type, content_id: c.row.id, status: 'open' }, { forUpdate: true });
      let reportStatus = 'open';
      let outcome: string | null = null;
      if (item) {
        item = await tx.update('moderation_items', item.id, {
          reasons: [...new Set([...((item.reasons as string[]) ?? []), input.reason])],
          report_count: item.report_count + 1,
          ...(hide ? { visibility: 'hidden' } : {}),
        });
      } else {
        const last = (await tx.find('moderation_items', { content_type: c.type, content_id: c.row.id, status: 'decided' }, { orderBy: [['decided_at', 'desc']], limit: 1 }))[0];
        const recent = last?.decided_at && last.decided_at >= addDays(now, -cooldownDays);
        if (last && recent && ((last.reasons as string[]) ?? []).includes(input.reason)) {
          // same complaint about content we decided recently: attach without reopening
          item = await tx.update('moderation_items', last.id, { report_count: last.report_count + 1 });
          const d = (await tx.find('moderation_decisions', { moderation_item_id: last.id }, { orderBy: [['decided_at', 'desc']] }))[0];
          reportStatus = 'decided';
          outcome = d ? `We already reviewed this ${CONTENT_NOUN[c.type]}. ${d.message_to_reporter ?? reporterOutcomeText(d.decision, d.reason_code, CONTENT_NOUN[c.type])}` : `We already reviewed this ${CONTENT_NOUN[c.type]}.`;
        } else if (last && recent) {
          item = await tx.update('moderation_items', last.id, {
            status: moderationItemMachine.next('decided', 'reopen'),
            queue: 'reported',
            reasons: [...new Set([...((last.reasons as string[]) ?? []), input.reason])],
            report_count: last.report_count + 1,
            visibility: hide ? 'hidden' : 'visible',
            first_reported_at: now,
            decided_at: null,
          });
        } else {
          item = await tx.insert('moderation_items', {
            id: newId(),
            content_type: c.type,
            content_id: c.row.id,
            queue: 'reported',
            status: 'open',
            visibility: hide ? 'hidden' : 'visible',
            reasons: [input.reason],
            report_count: 1,
            first_reported_at: now,
            decided_at: null,
          });
        }
      }
      // reported reviews and feedback stay visible unless the reason hides them
      if (reportStatus === 'open' && hide && (c.type === 'product_review' || c.type === 'seller_feedback') && c.row.status === 'published') {
        c = await moveContent(this.core, tx, fx, c, 'held', ['hide'], { byModeration: true });
      }
      return tx.insert('reports', {
        id: newId(),
        target_type: c.type,
        target_id: c.row.id,
        moderation_item_id: item.id,
        reporter_kind: by.kind,
        reporter_id: by.id,
        reason: input.reason,
        note,
        status: reportStatus,
        outcome_text: outcome,
        created_at: now,
        decided_at: reportStatus === 'decided' ? now : null,
      });
    });
    fx.emit('reviews.report.created', { reportId: report.id, targetType: report.target_type, targetId: report.target_id, reason: report.reason, reporterKind: report.reporter_kind });
    await this.core.flush(fx, by);
    return (await this.myReports([report]))[0]!;
  }

  async listReports(reporter: { kind: 'customer' | 'seller'; id: string | null }, page: PageRequest): Promise<common.Page<MyReport>> {
    if (!reporter.id) return pageOf([], page);
    const rows = await this.core.repo.page('reports', { reporter_kind: reporter.kind, reporter_id: reporter.id }, page, { column: 'created_at', direction: 'desc' });
    return { ...rows, items: await this.myReports(rows.items) };
  }

  async myReports(rows: readonly ReportRec[]): Promise<MyReport[]> {
    const summaries = await this.summaries(rows.map((r) => ({ type: r.target_type as ContentType, id: r.target_id })));
    return rows.map((r) => ({
      id: r.id,
      targetType: r.target_type,
      targetSummary: summaries.get(`${r.target_type}:${r.target_id}`) ?? CONTENT_NOUN[r.target_type as ContentType] ?? r.target_type,
      reason: r.reason,
      note: r.note,
      reportedAt: r.created_at.toISOString(),
      status: r.status as MyReport['status'],
      statusLabel: r.status === 'open' ? 'Under review' : 'Decided',
      outcome: r.outcome_text,
      decidedAt: r.decided_at?.toISOString() ?? null,
    }));
  }

  /** 'Review of Kestrel 27" monitor by "Sam R."' per content */
  private async summaries(targets: readonly { type: ContentType; id: string }[]): Promise<Map<string, string>> {
    const contents = await this.loadMany(targets);
    const productIds: string[] = [];
    const sellerIds: string[] = [];
    const questionIds = contents.flatMap((c) => (c.type === 'answer' ? [c.row.question_id] : []));
    const questions = new Map((await this.core.repo.getMany('questions', questionIds)).map((q) => [q.id, q]));
    for (const c of contents) {
      if (c.type === 'product_review' || c.type === 'question') productIds.push(c.row.product_id);
      if (c.type === 'answer') productIds.push(questions.get(c.row.question_id)?.product_id ?? '');
      if (c.type === 'seller_feedback' || c.type === 'seller_response') sellerIds.push(c.row.seller_id);
    }
    const [products, names] = await Promise.all([this.core.products(productIds), this.core.sellerNames(sellerIds)]);
    const title = (id: string | undefined) => (id ? products.get(id)?.title : undefined) ?? 'a product';
    const out = new Map<string, string>();
    for (const c of contents) {
      const key = `${c.type}:${c.row.id}`;
      switch (c.type) {
        case 'product_review':
          out.set(key, `Review of ${title(c.row.product_id)} by "${this.views.reviewAuthor(c.row).displayName}"`);
          break;
        case 'seller_feedback':
          out.set(key, `Feedback for ${this.core.sellerName(names, c.row.seller_id)} by "${c.row.display_name}"`);
          break;
        case 'question':
          out.set(key, `Question about ${title(c.row.product_id)}`);
          break;
        case 'answer':
          out.set(key, `Answer to a question about ${title(questions.get(c.row.question_id)?.product_id)}`);
          break;
        case 'seller_response':
          out.set(key, `Response from ${this.core.sellerName(names, c.row.seller_id)}`);
          break;
      }
    }
    return out;
  }

  private async loadMany(targets: readonly { type: ContentType; id: string }[]): Promise<Content[]> {
    const repo = this.core.repo;
    const ids = (t: ContentType) => [...new Set(targets.filter((x) => x.type === t).map((x) => x.id).filter(isUuid))];
    const [reviews, feedback, questions, answers, responses] = await Promise.all([
      repo.getMany('product_reviews', ids('product_review')),
      repo.getMany('seller_feedback', ids('seller_feedback')),
      repo.getMany('questions', ids('question')),
      repo.getMany('answers', ids('answer')),
      repo.getMany('seller_responses', ids('seller_response')),
    ]);
    return [
      ...reviews.map((row) => ({ type: 'product_review' as const, row })),
      ...feedback.map((row) => ({ type: 'seller_feedback' as const, row })),
      ...questions.map((row) => ({ type: 'question' as const, row })),
      ...answers.map((row) => ({ type: 'answer' as const, row })),
      ...responses.map((row) => ({ type: 'seller_response' as const, row })),
    ];
  }

  /* ================================================================ queue */

  async queue(filter: { queue?: string; contentType?: string; status?: string; reason?: string }, page: PageRequest): Promise<common.Page<ModerationItem>> {
    const rows = await this.core.repo.listModerationItems({ ...filter, status: filter.status ?? 'open' }, page);
    return { ...rows, items: await this.items(rows.items) };
  }

  async summary(): Promise<ModerationSummary> {
    const hours = await this.core.num('moderationTargetHours');
    const c = await this.core.repo.moderationCounts(new Date(this.core.now().getTime() - hours * 3_600_000));
    return { open: c.open, byQueue: c.byQueue, byContentType: c.byContentType, overdue: c.overdue, oldestOpenAt: c.oldestOpenAt?.toISOString() ?? null };
  }

  reasons(): ModerationReason[] {
    return MODERATION_REASONS;
  }

  /** Queue rows with titles, excerpts, authors and reporters, looked up once per page */
  async items(rows: readonly ItemRec[]): Promise<ModerationItem[]> {
    if (!rows.length) return [];
    const repo = this.core.repo;
    const contents = await this.loadMany(rows.map((r) => ({ type: r.content_type as ContentType, id: r.content_id })));
    const byKey = new Map(contents.map((c) => [`${c.type}:${c.row.id}`, c]));
    const questions = new Map((await repo.getMany('questions', contents.flatMap((c) => (c.type === 'answer' ? [c.row.question_id] : [])))).map((q) => [q.id, q]));
    const responseTargets = contents.flatMap((c) => (c.type === 'seller_response' ? [{ type: c.row.target_type as ContentType, id: c.row.target_id }] : []));
    const targets = new Map((await this.loadMany(responseTargets)).map((c) => [c.row.id, c]));
    const productIds: string[] = [];
    const sellerIds: string[] = [];
    const visit = (c: Content) => {
      if (c.type === 'product_review' || c.type === 'question') productIds.push(c.row.product_id);
      if (c.type === 'answer') productIds.push(questions.get(c.row.question_id)?.product_id ?? '');
      if (c.type === 'seller_feedback' || c.type === 'seller_response') sellerIds.push(c.row.seller_id);
      if (c.type === 'answer' && c.row.seller_id) sellerIds.push(c.row.seller_id);
    };
    contents.forEach(visit);
    targets.forEach(visit);
    const reportRows = await repo.find('reports', { moderation_item_id: rows.map((r) => r.id) }, { orderBy: [['created_at', 'asc']] });
    sellerIds.push(...reportRows.flatMap((r) => (r.reporter_kind === 'seller' && r.reporter_id ? [r.reporter_id] : [])));
    const [products, names] = await Promise.all([this.core.products(productIds), this.core.sellerNames(sellerIds)]);
    const reports = reportRows;
    const now = this.core.now();
    const out: ModerationItem[] = [];
    for (const item of rows) {
      const c = byKey.get(`${item.content_type}:${item.content_id}`);
      const own = reports.filter((r) => r.moderation_item_id === item.id);
      const base = {
        id: item.id,
        contentType: item.content_type as ModerationItem['contentType'],
        contentId: item.content_id,
        queue: item.queue as ModerationItem['queue'],
        reasons: (item.reasons as string[]) ?? [],
        reportCount: item.report_count,
        reportersLabel: this.reportersLabel(own, names),
        visibility: item.visibility as ModerationItem['visibility'],
        firstReportedAt: item.first_reported_at.toISOString(),
        age: ageLabel(item.first_reported_at, now),
        status: item.status as ModerationItem['status'],
      };
      if (!c) {
        out.push({ ...base, title: 'Content no longer available', subjectImage: null, excerpt: '', contextText: null, respondingTo: null, rating: null, author: { kind: 'customer', displayName: 'Unknown', sellerId: null, verifiedPurchase: false }, ruleCheck: null });
        continue;
      }
      const productId = c.type === 'answer' ? questions.get(c.row.question_id)?.product_id : c.type === 'product_review' || c.type === 'question' ? c.row.product_id : undefined;
      const target = c.type === 'seller_response' ? targets.get(c.row.target_id) : undefined;
      const targetProductId = target?.type === 'product_review' ? target.row.product_id : undefined;
      const p = products.get(productId ?? targetProductId ?? '');
      const title =
        c.type === 'seller_feedback'
          ? this.core.sellerName(names, c.row.seller_id)
          : c.type === 'seller_response' && target?.type === 'seller_feedback'
            ? this.core.sellerName(names, target.row.seller_id)
            : (p?.title ?? 'Product');
      out.push({
        ...base,
        title,
        subjectImage: c.type === 'seller_feedback' || (c.type === 'seller_response' && target?.type !== 'product_review') ? null : this.core.productImage(p),
        excerpt: this.excerptOf(c),
        contextText: c.type === 'answer' ? (questions.get(c.row.question_id)?.text ?? null) : null,
        respondingTo:
          target && (target.type === 'product_review' || target.type === 'seller_feedback')
            ? {
                contentType: target.type,
                rating: target.type === 'product_review' ? target.row.rating : target.row.overall,
                excerpt: this.excerptOf(target),
                title: target.type === 'product_review' ? (products.get(target.row.product_id)?.title ?? 'Product') : this.core.sellerName(names, target.row.seller_id),
              }
            : null,
        rating: c.type === 'product_review' ? c.row.rating : c.type === 'seller_feedback' ? c.row.overall : null,
        author: this.authorView(c, names),
        ruleCheck: this.ruleCheckOf(c),
      });
    }
    return out;
  }

  excerptOf(c: Content): string {
    switch (c.type) {
      case 'product_review':
        return excerpt(`${c.row.headline}. ${c.row.body}`);
      case 'seller_feedback':
        return excerpt(c.row.comment ?? `${c.row.as_described ? 'As described' : 'Not as described'} · dispatch ${c.row.dispatch_rating}/5`);
      default:
        return excerpt(c.row.text);
    }
  }

  authorView(c: Content, names: Map<string, string>): Author {
    switch (c.type) {
      case 'product_review':
        // staff see the name the author chose to show
        return { kind: 'customer', displayName: c.row.display_name, sellerId: null, verifiedPurchase: c.row.verified };
      case 'seller_feedback':
        return this.views.feedbackAuthor(c.row);
      case 'question':
        return { kind: 'customer', displayName: c.row.display_name, sellerId: null, verifiedPurchase: false };
      case 'answer':
        return this.views.answerAuthor(c.row);
      case 'seller_response':
        return { kind: 'seller', displayName: this.core.sellerName(names, c.row.seller_id), sellerId: c.row.seller_id, verifiedPurchase: false };
    }
  }

  ruleCheckOf(c: Content): RuleCheck | null {
    const stored = (r: unknown) => {
      const x = r as { passed?: boolean; failures?: string[] } | null;
      return x ? { passed: Boolean(x.passed), failures: x.failures ?? [] } : null;
    };
    switch (c.type) {
      case 'answer':
      case 'seller_response':
        return stored(c.row.rule_check);
      case 'question': {
        const f = qaChecks(c.row.text);
        return { passed: !f.length, failures: f.map((x) => x.label) };
      }
      case 'product_review': {
        const f = reviewChecks(c.row.headline, c.row.body);
        return { passed: !f.length, failures: f.map((x) => x.label) };
      }
      case 'seller_feedback': {
        const f = reviewChecks(c.row.comment);
        return { passed: !f.length, failures: f.map((x) => x.label) };
      }
    }
  }

  /** "3 customers, Gadget Grove (seller), system" */
  reportersLabel(reports: readonly ReportRec[], names: Map<string, string>): string {
    const customers = new Set(reports.filter((r) => r.reporter_kind === 'customer').map((r) => r.reporter_id)).size;
    const sellers = [...new Set(reports.filter((r) => r.reporter_kind === 'seller').map((r) => r.reporter_id ?? ''))].map((id) => `${names.get(id) ?? 'A seller'} (seller)`);
    const parts = [
      ...(customers ? [`${customers} customer${customers === 1 ? '' : 's'}`] : []),
      ...sellers,
      ...(reports.some((r) => r.reporter_kind === 'system') ? ['system'] : []),
      ...(reports.some((r) => r.reporter_kind === 'trust') ? ['Trust and Risk'] : []),
    ];
    return parts.join(', ') || 'system';
  }

  /* ================================================================ detail */

  async detail(id: string): Promise<ModerationDetail> {
    const repo = this.core.repo;
    const item = isUuid(id) ? await repo.get('moderation_items', id) : undefined;
    if (!item) throw notFound('Moderation item');
    const c = await loadContent(repo, item.content_type, item.content_id);
    const reportRows = await repo.find('reports', { moderation_item_id: item.id }, { orderBy: [['created_at', 'asc']] });
    const sellerReporters = reportRows.filter((r) => r.reporter_kind === 'seller').map((r) => r.reporter_id ?? '');
    const customerReporters = reportRows.filter((r) => r.reporter_kind === 'customer').map((r) => r.reporter_id ?? '');
    const [view, names, customerNames] = await Promise.all([this.items([item]), this.core.sellerNames(sellerReporters), this.core.customerNames(customerReporters)]);
    const reports: Report[] = reportRows.map((r) => ({
      id: r.id,
      reporter: this.reporterActor(r, names, customerNames),
      reporterLabel: r.reporter_kind === 'seller' ? `${names.get(r.reporter_id ?? '') ?? 'A seller'} (seller)` : r.reporter_kind === 'customer' ? 'Customer' : r.reporter_kind === 'trust' ? 'Trust and Risk' : 'system',
      reason: r.reason,
      note: r.note,
      at: r.created_at.toISOString(),
    }));
    const allItems = c ? await repo.find('moderation_items', { content_type: item.content_type, content_id: item.content_id }) : [item];
    const decisions = await repo.find('moderation_decisions', { moderation_item_id: allItems.map((i) => i.id) }, { orderBy: [['decided_at', 'desc']] });
    const appeals = await repo.find('appeals', { content_type: item.content_type, content_id: item.content_id }, { orderBy: [['submitted_at', 'desc']] });
    const latest = decisions[0];
    const detail: ModerationDetail = {
      item: view[0]!,
      review: null,
      feedback: null,
      question: null,
      answer: null,
      response: null,
      respondingTo: null,
      purchase: null,
      reports,
      otherReportsOnAuthor: c ? await this.otherReportsOnAuthor(c) : 0,
      helpfulVotes: c?.type === 'product_review' || c?.type === 'answer' ? c.row.helpful_count : 0,
      separationNote: null,
      previousDecision: latest ? this.outcomeOf(latest, appeals, c?.row.status ?? '') : null,
      appeal: appeals[0] ? appealView(appeals[0]) : null,
      history: this.history(allItems, await repo.find('reports', { moderation_item_id: allItems.map((i) => i.id) }), decisions, appeals, await repo.find('referrals', { moderation_item_id: allItems.map((i) => i.id) })),
    };
    if (!c) return detail;
    switch (c.type) {
      case 'product_review': {
        detail.review = (await this.views.reviews([c.row], { internal: true }))[0]!;
        detail.purchase = await this.purchaseOf(c.row.order_id, c.row.order_item_id, c.row.seller_id, c.row.verified);
        if (mentionsSellerService(`${c.row.headline} ${c.row.body}`)) {
          detail.separationNote = 'This review mentions delivery or seller service. Slow service described in a product review is an honest experience and stays; feedback about the seller belongs in seller feedback.';
        }
        break;
      }
      case 'seller_feedback':
        detail.feedback = (await this.views.feedback([c.row], { internal: true }))[0]!;
        detail.purchase = await this.purchaseOf(c.row.order_id, null, c.row.seller_id, true);
        break;
      case 'question':
        detail.question = (await this.views.questions([c.row], { publicOnly: false }))[0]!;
        break;
      case 'answer':
        detail.answer = this.views.answerOut(c.row);
        break;
      case 'seller_response': {
        const names2 = await this.core.sellerNames([c.row.seller_id]);
        detail.response = this.views.responseOut(c.row, this.core.sellerName(names2, c.row.seller_id), true);
        const target = await loadContent(repo, c.row.target_type, c.row.target_id);
        detail.respondingTo = target ? this.excerptOf(target) : null;
        break;
      }
    }
    return detail;
  }

  private reporterActor(r: ReportRec, sellers: Map<string, string>, customers: Map<string, string>): common.Actor {
    switch (r.reporter_kind) {
      case 'customer':
        return { kind: 'customer', id: r.reporter_id, name: customers.get(r.reporter_id ?? '') ?? null };
      case 'seller':
        return { kind: 'seller', id: r.reporter_id, name: sellers.get(r.reporter_id ?? '') ?? null };
      case 'trust':
        return TRUST_ACTOR;
      default:
        return { kind: 'system', id: null, name: 'Automatic checks' };
    }
  }

  private async purchaseOf(orderId: string, orderItemId: string | null, sellerId: string, verified: boolean) {
    const order = (await this.core.orders([orderId])).get(orderId);
    const names = await this.core.sellerNames([sellerId]);
    const item = order ? this.core.purchasesOf(order).find((p) => p.orderItemId === orderItemId) : undefined;
    const pkg = this.core.packageFor(order, sellerId);
    return {
      orderRef: order?.ref ?? '',
      deliveredAt: (item?.deliveredAt ?? pkg?.deliveredAt)?.toISOString() ?? null,
      verified,
      soldBy: this.core.sellerName(names, sellerId),
      condition: item?.condition ?? null,
    };
  }

  /** Reports on the author's other content */
  private async otherReportsOnAuthor(c: Content): Promise<number> {
    const repo = this.core.repo;
    const a = authorOf(c);
    const ids: string[] = [];
    if (a.kind === 'customer') {
      const [r, f, q, an] = await Promise.all([
        repo.find('product_reviews', { customer_id: a.id }, { limit: 500 }),
        repo.find('seller_feedback', { customer_id: a.id }, { limit: 500 }),
        repo.find('questions', { customer_id: a.id }, { limit: 500 }),
        repo.find('answers', { author_kind: 'customer', author_id: a.id }, { limit: 500 }),
      ]);
      ids.push(...r.map((x) => x.id), ...f.map((x) => x.id), ...q.map((x) => x.id), ...an.map((x) => x.id));
    } else if (a.kind === 'seller') {
      const [an, rs] = await Promise.all([repo.find('answers', { seller_id: a.id }, { limit: 500 }), repo.find('seller_responses', { seller_id: a.id }, { limit: 500 })]);
      ids.push(...an.map((x) => x.id), ...rs.map((x) => x.id));
    } else {
      ids.push(...(await repo.find('answers', { author_kind: 'staff', author_id: a.id }, { limit: 500 })).map((x) => x.id));
    }
    const others = ids.filter((id) => id !== c.row.id);
    if (!others.length) return 0;
    return repo.count('reports', { target_id: others, reporter_kind: ['customer', 'seller', 'trust'] });
  }

  private history(items: ItemRec[], reports: ReportRec[], decisions: DecisionRec[], appeals: AppealRec[], referrals: ReferralRec[]): common.TimelineEvent[] {
    const out: common.TimelineEvent[] = [];
    for (const r of reports) {
      out.push({
        at: r.created_at.toISOString(),
        label: r.reporter_kind === 'system' ? 'Held by automatic checks' : `Reported: ${REPORT_REASON_LABEL[r.reason] ?? r.reason}`,
        detail: r.note,
        actor: r.reporter_kind === 'system' ? { kind: 'system', id: null, name: 'Automatic checks' } : r.reporter_kind === 'trust' ? TRUST_ACTOR : { kind: r.reporter_kind as common.Actor['kind'], id: r.reporter_id },
      });
    }
    for (const d of decisions) {
      const staff: common.Actor = d.moderator_id === SYSTEM_MODERATOR_ID ? { kind: 'system', id: null } : { kind: 'staff', id: d.moderator_id };
      out.push({ at: d.decided_at.toISOString(), label: `Decision: ${OUTCOME_OF[d.decision] ?? d.decision} (${reasonLabel(d.reason_code)})`, detail: d.edit_request ?? d.message_to_author, actor: staff });
    }
    for (const r of referrals) out.push({ at: r.referred_at.toISOString(), label: 'Referred to Trust and Risk', detail: r.note, actor: r.referred_by === SYSTEM_MODERATOR_ID ? { kind: 'system', id: null } : { kind: 'staff', id: r.referred_by } });
    for (const a of appeals) {
      out.push({ at: a.submitted_at.toISOString(), label: 'Appeal submitted', detail: a.reason, actor: { kind: a.by_kind as common.Actor['kind'], id: a.by_id } });
      if (a.decided_at) out.push({ at: a.decided_at.toISOString(), label: a.status === 'overturned' ? 'Appeal: decision overturned' : 'Appeal: decision stands', detail: a.outcome, actor: { kind: 'staff', id: a.reviewer_id } });
    }
    void items;
    return out.sort((x, y) => x.at.localeCompare(y.at));
  }

  outcomeOf(d: DecisionRec, appeals: readonly AppealRec[], status: string): ModerationOutcome {
    const appealable = ADVERSE.has(d.decision) && Boolean(d.appeal_by) && this.core.now() <= d.appeal_by! && !appeals.some((a) => a.decision_id === d.id) && ['removed', 'edit_requested', 'rejected'].includes(status);
    return {
      decision: OUTCOME_OF[d.decision] ?? 'kept',
      reasonCode: d.reason_code,
      reasonText: d.message_to_author ?? AUTHOR_TEXT[d.reason_code] ?? reasonLabel(d.reason_code),
      decidedAt: d.decided_at.toISOString(),
      expectedBy: null,
      appealBy: d.appeal_by?.toISOString() ?? null,
      appealable,
    };
  }

  /* ================================================================ decisions */

  async decide(id: string, input: ModerationDecisionInput, by: By): Promise<ModerationDetail> {
    const repo = this.core.repo;
    const item = isUuid(id) ? await repo.get('moderation_items', id) : undefined;
    if (!item) throw notFound('Moderation item');
    moderationItemMachine.next(item.status as 'open' | 'decided', 'decide');
    if (item.queue === 'appeal') throw new AppError('ILLEGAL_TRANSITION', 'This item is under appeal: decide the appeal instead', { machine: 'Moderation item', from: 'open', event: 'decide', queue: 'appeal' });
    const type = item.content_type as ContentType;
    const target = TARGET[type]?.[input.decision];
    // a decision the content's machine does not allow (e.g. an edit request on seller feedback) is an illegal move
    if (!target) throw new AppError('ILLEGAL_TRANSITION', `"${input.decision}" does not apply to ${CONTENT_NOUN[type]}s`, { machine: type, event: input.decision });
    if (ADVERSE.has(input.decision) && input.reasonCode === 'legitimate_experience') {
      throw this.core.ctx.error('INVALID_REMOVAL_REASON', 'A legitimate experience is kept: removal needs a policy reason. Unfavourable content or harm to sales is not one.');
    }
    if (input.decision === 'request_edit' && !input.editRequest?.trim()) throw invalid([{ path: 'editRequest', message: 'Say what the author should change' }]);
    const appealDays = await this.core.num('appealWindowDays');
    const fx = await this.core.prepare(new Effects());
    const now = this.core.now();
    const noun = CONTENT_NOUN[type];
    const before = await loadContent(repo, type, item.content_id);
    if (!before) throw notFound('Content');

    const after = await repo.transaction(async (tx) => {
      const locked = (await tx.get('moderation_items', item.id, { forUpdate: true }))!;
      const status = moderationItemMachine.next(locked.status as 'open' | 'decided', 'decide');
      const c = (await loadContent(tx, type, item.content_id, { forUpdate: true }))!;
      const events = type === 'seller_response' ? RESPONSE_MODERATION_EVENTS : MODERATION_EVENTS;
      // one state move from the content's current state (spec decideModeration)
      const moved = await moveContent(this.core, tx, fx, c, target, events, { byModeration: true, reasonCode: input.reasonCode, takedown: input.decision === 'remove', oneStep: true });
      const decision = await tx.insert('moderation_decisions', {
        id: newId(),
        moderation_item_id: item.id,
        decision: input.decision,
        reason_code: input.reasonCode,
        message_to_reporter: input.messageToReporter?.trim() || null,
        message_to_author: input.messageToAuthor?.trim() || null,
        edit_request: input.editRequest?.trim() || null,
        moderator_id: actorId(by.actor),
        decided_at: now,
        appeal_by: ADVERSE.has(input.decision) ? addDays(now, appealDays) : null,
        trust_enforcement_id: null,
      });
      await tx.update('moderation_items', item.id, { status, decided_at: now });
      const answered = await tx.find('reports', { moderation_item_id: item.id, status: 'open' });
      const reporterOutcome = decision.message_to_reporter ?? reporterOutcomeText(input.decision, input.reasonCode, noun);
      await tx.updateWhere('reports', { moderation_item_id: item.id, status: 'open' }, { status: 'decided', outcome_text: reporterOutcome, decided_at: now });
      fx.emit('reviews.moderation.decided', {
        moderationItemId: item.id,
        contentType: type,
        contentId: item.content_id,
        decision: input.decision,
        reasonCode: input.reasonCode,
        author: partyOf(c),
        reporters: reportersOf(answered),
        reporterOutcome,
        appealUntil: decision.appeal_by?.toISOString() ?? null,
      });
      return moved;
    });
    fx.takedownReason = `Review removed: ${reasonLabel(input.reasonCode)}`;
    await this.core.flush(fx, by);
    await this.resolveOverdue(item.id);
    await this.core.audit(
      {
        action: 'reviews.moderation.decide',
        actionLabel: `Moderation: ${OUTCOME_OF[input.decision]} ${noun}`,
        category: 'content',
        target: { type, id: item.content_id, label: this.excerptOf(after).slice(0, 80) },
        relatedTargets: [{ type: 'moderation_item', id: item.id }],
        reason: reasonLabel(input.reasonCode),
        before: { status: before.row.status },
        after: { status: after.row.status, decision: input.decision, reasonCode: input.reasonCode },
      },
      by,
    );
    return this.detail(item.id);
  }

  async refer(id: string, note: string, by: By): Promise<ModerationDetail> {
    const repo = this.core.repo;
    const item = isUuid(id) ? await repo.get('moderation_items', id) : undefined;
    if (!item) throw notFound('Moderation item');
    if (!note?.trim()) throw invalid([{ path: 'note', message: 'Say why Trust and Risk should look at this' }]);
    const c = await loadContent(repo, item.content_type, item.content_id);
    if (!c) throw notFound('Content');
    const author = authorOf(c);
    // a referral, not a decision: the item stays open for keep / remove
    await repo.insert('referrals', {
      id: newId(),
      moderation_item_id: item.id,
      content_type: item.content_type,
      content_id: item.content_id,
      author_id: author.id,
      note: note.trim(),
      referred_by: actorId(by.actor),
      referred_at: this.core.now(),
    });
    this.core.publish('reviews.content.referred', { moderationItemId: item.id, contentType: item.content_type, contentId: item.content_id, authorId: author.id, note: note.trim() }, by);
    await this.core.audit(
      {
        action: 'reviews.moderation.refer',
        actionLabel: `Referred ${CONTENT_NOUN[c.type]} to Trust and Risk`,
        category: 'content',
        target: { type: c.type, id: c.row.id, label: this.excerptOf(c).slice(0, 80) },
        relatedTargets: [{ type: 'moderation_item', id: item.id }],
        reason: note.trim(),
      },
      by,
    );
    return this.detail(item.id);
  }

  /* ================================================================ appeals */

  async submitAppeal(by: { kind: 'customer' | 'seller'; id: string | null } & By, input: AppealInput): Promise<AppealView> {
    const repo = this.core.repo;
    if (!by.id) throw notFound('Content');
    const c = await loadContent(repo, input.targetType, input.targetId);
    if (!c) throw notFound('Content');
    const author = authorOf(c);
    if (author.kind !== by.kind || author.id !== by.id) throw notFound('Content');
    const reason = input.reason?.trim();
    if (!reason) throw invalid([{ path: 'reason', message: 'Tell us why the decision should change' }]);
    const items = await repo.find('moderation_items', { content_type: c.type, content_id: c.row.id });
    const decisions = await repo.find('moderation_decisions', { moderation_item_id: items.map((i) => i.id) }, { orderBy: [['decided_at', 'desc']] });
    const decision = decisions[0];
    if (!decision || !ADVERSE.has(decision.decision) || !decision.appeal_by) throw new AppError('ILLEGAL_TRANSITION', 'There is no decision to appeal on this content', { machine: 'Appeal' });
    if (await repo.findOne('appeals', { decision_id: decision.id })) throw new AppError('ILLEGAL_TRANSITION', 'This decision has already been appealed', { machine: 'Appeal' });
    if (this.core.now() > decision.appeal_by) throw this.core.ctx.error('APPEAL_WINDOW_CLOSED', 'The deadline to appeal this decision has passed.', { appealBy: decision.appeal_by.toISOString() });
    const now = this.core.now();
    const appeal = await repo.transaction(async (tx) => {
      const item = (await tx.get('moderation_items', decision.moderation_item_id, { forUpdate: true }))!;
      await tx.update('moderation_items', item.id, {
        ...(item.status === 'decided' ? { status: moderationItemMachine.next('decided', 'reopen'), decided_at: null } : {}),
        queue: 'appeal',
      });
      return tx.insert('appeals', {
        id: newId(),
        decision_id: decision.id,
        content_type: c.type,
        content_id: c.row.id,
        by_kind: by.kind,
        by_id: by.id!,
        reason,
        status: appealMachine.initial,
        reviewer_id: null,
        outcome: null,
        submitted_at: now,
        decided_at: null,
      });
    });
    this.core.publish('reviews.appeal.submitted', { appealId: appeal.id, contentType: c.type, contentId: c.row.id }, by);
    return appealView(appeal);
  }

  async listAppeals(filter: { status?: string }, page: PageRequest): Promise<common.Page<AppealRow>> {
    const rows = await this.core.repo.page('appeals', { ...(filter.status ? { status: filter.status } : {}) }, page, { column: 'submitted_at', direction: filter.status && filter.status !== 'submitted' ? 'desc' : 'asc' });
    return { ...rows, items: await this.appealRows(rows.items) };
  }

  async appealRows(rows: readonly AppealRec[]): Promise<AppealRow[]> {
    if (!rows.length) return [];
    const repo = this.core.repo;
    const decisions = new Map((await repo.getMany('moderation_decisions', rows.map((a) => a.decision_id))).map((d) => [d.id, d]));
    const contents = await this.loadMany(rows.map((a) => ({ type: a.content_type as ContentType, id: a.content_id })));
    const byKey = new Map(contents.map((c) => [`${c.type}:${c.row.id}`, c]));
    const names = await this.core.sellerNames(contents.flatMap((c) => (c.type === 'seller_response' ? [c.row.seller_id] : c.type === 'answer' && c.row.seller_id ? [c.row.seller_id] : [])));
    const moderators = await this.staffNames([...decisions.values()].map((d) => d.moderator_id));
    const allAppeals = await repo.find('appeals', { decision_id: rows.map((a) => a.decision_id) });
    return rows.map((a) => {
      const d = decisions.get(a.decision_id)!;
      const c = byKey.get(`${a.content_type}:${a.content_id}`);
      return {
        id: a.id,
        contentType: a.content_type,
        contentId: a.content_id,
        excerpt: c ? this.excerptOf(c) : '',
        author: c ? this.authorView(c, names) : { kind: a.by_kind as Author['kind'], displayName: 'Unknown', sellerId: null, verifiedPurchase: false },
        reason: a.reason,
        submittedAt: a.submitted_at.toISOString(),
        originalDecision: this.outcomeOf(d, allAppeals, c?.row.status ?? ''),
        originalModerator: d.moderator_id === SYSTEM_MODERATOR_ID ? { kind: 'system', id: null } : { kind: 'staff', id: d.moderator_id, name: moderators.get(d.moderator_id) ?? null },
        status: a.status as AppealRow['status'],
      };
    });
  }

  private async staffNames(ids: readonly string[]): Promise<Map<string, string>> {
    const out = new Map<string, string>();
    const unique = [...new Set(ids.filter((id) => isUuid(id) && id !== SYSTEM_MODERATOR_ID))];
    await this.core.optional('access', async (api) => {
      await Promise.all(
        unique.map(async (id) => {
          const ref = await api.getStaffRef(id).catch(() => null);
          if (ref) out.set(id, ref.name);
        }),
      );
    });
    return out;
  }

  async decideAppeal(id: string, input: { overturn: boolean; reason: string }, by: By): Promise<AppealRow> {
    const repo = this.core.repo;
    const appeal = isUuid(id) ? await repo.get('appeals', id) : undefined;
    if (!appeal) throw notFound('Appeal');
    const status = appealMachine.next(appeal.status as 'submitted', input.overturn ? 'overturn' : 'keepDecision');
    const decision = (await repo.get('moderation_decisions', appeal.decision_id))!;
    if (by.actor.id && decision.moderator_id === by.actor.id) throw this.core.ctx.error('SAME_MODERATOR', 'You made the original decision: another moderator must decide this appeal.');
    const reason = input.reason?.trim();
    if (!reason) throw invalid([{ path: 'reason', message: 'Explain the outcome to the author' }]);
    const fx = await this.core.prepare(new Effects());
    const now = this.core.now();
    const type = appeal.content_type as ContentType;
    await repo.transaction(async (tx) => {
      const locked = (await tx.get('appeals', appeal.id, { forUpdate: true }))!;
      appealMachine.next(locked.status as 'submitted', input.overturn ? 'overturn' : 'keepDecision');
      await tx.update('appeals', appeal.id, { status, reviewer_id: isUuid(by.actor.id) ? by.actor.id : null, outcome: reason, decided_at: now });
      const item = (await tx.get('moderation_items', decision.moderation_item_id, { forUpdate: true }))!;
      if (item.status === 'open') await tx.update('moderation_items', item.id, { status: moderationItemMachine.next('open', 'decide'), decided_at: now });
      if (input.overturn) {
        const c = await loadContent(tx, type, appeal.content_id, { forUpdate: true });
        if (c && c.row.status !== 'deleted') await moveContent(this.core, tx, fx, c, 'published', RESTORE_EVENTS, { byModeration: true });
        await tx.updateWhere('reports', { moderation_item_id: item.id }, { status: 'decided', outcome_text: `After an appeal, this ${CONTENT_NOUN[type]} was restored.`, decided_at: now });
      } else {
        await tx.updateWhere('reports', { moderation_item_id: item.id, status: 'open' }, { status: 'decided', outcome_text: reporterOutcomeText(decision.decision, decision.reason_code, CONTENT_NOUN[type]), decided_at: now });
      }
    });
    // the author who appealed is told the outcome
    const appellant = (appeal.by_kind === 'customer' || appeal.by_kind === 'seller') && isUuid(appeal.by_id) ? { kind: appeal.by_kind as ContentParty['kind'], id: appeal.by_id } : null;
    fx.emit('reviews.appeal.decided', { appealId: appeal.id, overturned: input.overturn, contentType: appeal.content_type, contentId: appeal.content_id, author: appellant, outcome: reason });
    await this.core.flush(fx, by);
    await this.resolveOverdue(decision.moderation_item_id);
    await this.core.audit(
      {
        action: 'reviews.appeal.decide',
        actionLabel: input.overturn ? `Appeal upheld: ${CONTENT_NOUN[type]} restored` : 'Appeal: decision stands',
        category: 'content',
        target: { type, id: appeal.content_id },
        relatedTargets: [{ type: 'appeal', id: appeal.id }],
        reason,
        before: { status: appeal.status },
        after: { status },
      },
      by,
    );
    return (await this.appealRows([(await repo.get('appeals', appeal.id))!]))[0]!;
  }

  /* ================================================================ trust enforcement */

  /** Closes the review_moderation_overdue work item of a decided moderation item (workqueues, optional) */
  async resolveOverdue(itemId: string) {
    await this.core.optional('workqueues', (w) => w.resolveBySource(`review_moderation_overdue:${itemId}`, { note: 'Moderation item decided', by: { kind: 'system', id: null, name: 'Reviews' } }));
  }

  /**
   * remove_reviews: removes the reviews, questions and answers named in the enforcement with a moderation decision
   * (reason proven_fake, trust_enforcement_id recorded), tells the authors and publishes reviews.moderation.decided
   * with trustEnforcementId so trust confirms execution. Content already removed (e.g. by moderation) is confirmed
   * without a new decision, so a reversal never reinstates what moderation removed. Each content is handled once per
   * enforcement (inbox). Returns how many were removed now.
   */
  async removeForEnforcement(contentIds: readonly string[], enforcementId: string, reason: string): Promise<number> {
    let removed = 0;
    const by: By = { actor: TRUST_ACTOR };
    for (const id of new Set(contentIds)) {
      if (!isUuid(id)) continue;
      const c = await findContent(this.core.repo, id);
      if (!c) {
        this.core.ctx.log.info({ id, enforcementId }, 'reviews: enforcement names content this module does not know');
        continue;
      }
      const target = REMOVED_STATE[c.type];
      const fx = await this.core.prepare(new Effects());
      fx.takedownReason = 'Removed after a Trust and Risk investigation';
      const now = this.core.now();
      const closed: string[] = [];
      const done = await this.core.repo.transaction(async (tx) => {
        if (!(await tx.claim(`trust-remove:${enforcementId}:${c.row.id}`))) return false;
        const locked = await loadContent(tx, c.type, c.row.id, { forUpdate: true });
        if (!locked) return false;
        if (locked.row.status === target || locked.row.status === 'deleted') {
          // already gone: confirm to trust (the latest decided item names it), no decision of this enforcement
          const last = (await tx.find('moderation_items', { content_type: c.type, content_id: c.row.id }, { orderBy: [['first_reported_at', 'desc']], limit: 1 }))[0];
          if (last) {
            fx.emit('reviews.moderation.decided', { moderationItemId: last.id, contentType: c.type, contentId: c.row.id, decision: 'remove', reasonCode: 'proven_fake', author: partyOf(locked), reporters: [], reporterOutcome: null, appealUntil: null, trustEnforcementId: enforcementId });
          }
          return false;
        }
        const outcome = `We removed this ${CONTENT_NOUN[c.type]} after a Trust and Risk investigation.`;
        const answered: ReportRec[] = [];
        for (const open of await tx.find('moderation_items', { content_type: c.type, content_id: c.row.id, status: 'open' })) {
          answered.push(...(await tx.find('reports', { moderation_item_id: open.id, status: 'open' })));
          await tx.update('moderation_items', open.id, { status: 'decided', decided_at: now });
          await tx.updateWhere('reports', { moderation_item_id: open.id, status: 'open' }, { status: 'decided', outcome_text: outcome, decided_at: now });
          closed.push(open.id);
        }
        const item = await tx.insert('moderation_items', {
          id: newId(),
          content_type: c.type,
          content_id: c.row.id,
          queue: 'reported',
          status: 'decided',
          visibility: 'hidden',
          reasons: ['fake_or_paid'],
          report_count: 1,
          first_reported_at: now,
          decided_at: now,
        });
        await tx.insert('reports', {
          id: newId(),
          target_type: c.type,
          target_id: c.row.id,
          moderation_item_id: item.id,
          reporter_kind: 'trust',
          reporter_id: null,
          reason: 'fake_or_paid',
          note: `Enforcement ${enforcementId}: ${reason}`,
          status: 'decided',
          outcome_text: outcome,
          created_at: now,
          decided_at: now,
        });
        await tx.insert('moderation_decisions', {
          id: newId(),
          moderation_item_id: item.id,
          decision: 'remove',
          reason_code: 'proven_fake',
          message_to_reporter: null,
          message_to_author: 'Removed after a Trust and Risk investigation found it was not a genuine review. Appeals go through Trust and Risk.',
          edit_request: null,
          moderator_id: SYSTEM_MODERATOR_ID,
          decided_at: now,
          appeal_by: null,
          trust_enforcement_id: enforcementId,
        });
        const events = c.type === 'seller_response' ? RESPONSE_MODERATION_EVENTS : MODERATION_EVENTS;
        await moveContent(this.core, tx, fx, locked, target, events, { byModeration: true, reasonCode: 'proven_fake', takedown: true, trustEnforcementId: enforcementId });
        fx.emit('reviews.moderation.decided', {
          moderationItemId: item.id,
          contentType: c.type,
          contentId: c.row.id,
          decision: 'remove',
          reasonCode: 'proven_fake',
          author: partyOf(locked),
          reporters: reportersOf(answered),
          reporterOutcome: outcome,
          // an enforcement is appealed through Trust and Risk, not the moderation appeal
          appealUntil: null,
          trustEnforcementId: enforcementId,
        });
        return true;
      });
      await this.core.flush(fx, by);
      for (const itemId of closed) await this.resolveOverdue(itemId);
      if (done) removed++;
    }
    return removed;
  }

  /**
   * keep_reviews: the open moderation items on the named content are decided as kept (reason legitimate_experience,
   * trust_enforcement_id recorded), so held content is published again. Once per content and enforcement.
   */
  async keepForEnforcement(contentIds: readonly string[], enforcementId: string, reason: string): Promise<number> {
    let kept = 0;
    const by: By = { actor: TRUST_ACTOR };
    for (const id of new Set(contentIds)) {
      if (!isUuid(id)) continue;
      const c = await findContent(this.core.repo, id);
      if (!c) continue;
      const fx = await this.core.prepare(new Effects());
      const now = this.core.now();
      const closed: string[] = [];
      await this.core.repo.transaction(async (tx) => {
        if (!(await tx.claim(`trust-keep:${enforcementId}:${c.row.id}`))) return;
        let locked = await loadContent(tx, c.type, c.row.id, { forUpdate: true });
        if (!locked) return;
        for (const item of await tx.find('moderation_items', { content_type: c.type, content_id: c.row.id, status: 'open' }, { forUpdate: true })) {
          if (item.queue === 'appeal') continue;
          const answered = await tx.find('reports', { moderation_item_id: item.id, status: 'open' });
          const outcome = `We checked this ${CONTENT_NOUN[c.type]} with Trust and Risk and kept it.`;
          await tx.insert('moderation_decisions', {
            id: newId(),
            moderation_item_id: item.id,
            decision: 'keep',
            reason_code: 'legitimate_experience',
            message_to_reporter: null,
            message_to_author: null,
            edit_request: null,
            moderator_id: SYSTEM_MODERATOR_ID,
            decided_at: now,
            appeal_by: null,
            trust_enforcement_id: enforcementId,
          });
          await tx.update('moderation_items', item.id, { status: moderationItemMachine.next('open', 'decide'), decided_at: now, visibility: 'visible' });
          await tx.updateWhere('reports', { moderation_item_id: item.id, status: 'open' }, { status: 'decided', outcome_text: outcome, decided_at: now });
          if (['held', 'pending', 'pending_review'].includes(locked.row.status)) {
            const events = locked.type === 'seller_response' ? RESPONSE_MODERATION_EVENTS : MODERATION_EVENTS;
            locked = await moveContent(this.core, tx, fx, locked, 'published', events, { byModeration: true, reasonCode: 'legitimate_experience' });
          }
          fx.emit('reviews.moderation.decided', { moderationItemId: item.id, contentType: c.type, contentId: c.row.id, decision: 'keep', reasonCode: 'legitimate_experience', author: partyOf(locked), reporters: reportersOf(answered), reporterOutcome: outcome, appealUntil: null, trustEnforcementId: enforcementId });
          closed.push(item.id);
          kept++;
        }
      });
      await this.core.flush(fx, by);
      for (const itemId of closed) await this.resolveOverdue(itemId);
      void reason;
    }
    return kept;
  }

  /**
   * trust.enforcement.reversed (remove_reviews): content that enforcement removed (decisions with its
   * trust_enforcement_id) is reinstated unless the author deleted it since; ratings are recalculated and the
   * authors told (reviews.moderation.decided, decision reinstate). Once per content and enforcement.
   */
  async reinstateForEnforcement(enforcementId: string, reason: string): Promise<number> {
    if (!isUuid(enforcementId)) return 0;
    const decisions = await this.core.repo.find('moderation_decisions', { trust_enforcement_id: enforcementId, decision: 'remove' });
    let reinstated = 0;
    const by: By = { actor: TRUST_ACTOR };
    for (const d of decisions) {
      const item = await this.core.repo.get('moderation_items', d.moderation_item_id);
      if (!item) continue;
      const fx = await this.core.prepare(new Effects());
      const now = this.core.now();
      const done = await this.core.repo.transaction(async (tx) => {
        if (!(await tx.claim(`trust-reinstate:${enforcementId}:${item.content_id}`))) return false;
        const c = await loadContent(tx, item.content_type, item.content_id, { forUpdate: true });
        if (!c || c.row.status === 'deleted' || c.row.status !== REMOVED_STATE[c.type]) return false;
        await moveContent(this.core, tx, fx, c, 'published', RESTORE_EVENTS, { byModeration: true, trustEnforcementId: enforcementId });
        await tx.insert('moderation_decisions', {
          id: newId(),
          moderation_item_id: item.id,
          decision: 'reinstate',
          reason_code: 'enforcement_reversed',
          message_to_reporter: null,
          message_to_author: `Restored: Trust and Risk reversed its decision. ${reason}`.trim(),
          edit_request: null,
          moderator_id: SYSTEM_MODERATOR_ID,
          decided_at: now,
          appeal_by: null,
          trust_enforcement_id: enforcementId,
        });
        fx.emit('reviews.moderation.decided', { moderationItemId: item.id, contentType: c.type, contentId: c.row.id, decision: 'reinstate', reasonCode: 'enforcement_reversed', author: partyOf(c), reporters: [], reporterOutcome: null, appealUntil: null, trustEnforcementId: enforcementId });
        return true;
      });
      await this.core.flush(fx, by);
      if (done) reinstated++;
    }
    return reinstated;
  }

  /** The product behind content (for summaries in other parts) */
  productOf(c: Content) {
    return productOf(this.core.repo, c);
  }

  machineOf = machineOf;
}
