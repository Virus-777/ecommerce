/**
 * Automated detection: raw signals from consumed events (risk_signals), the detection rules that turn signal
 * windows into reports, intake from other modules' referrals, and the background jobs (run-detection, rescore,
 * evidence deadlines).
 */
import type { EventPayload } from '../../../kernel/events/index.js';
import { isUuid } from '../../../kernel/lib/ids.js';
import type * as common from '../../../spec/common.js';
import type { DetectionRule, TrustSubject } from '../../../spec/trust.js';
import { evaluate, RULES, ruleSeed, windowMs, type SignalRec } from '../domain/detection.js';
import { evidenceRequestMachine } from '../domain/state-machines.js';
import { addressKey, detId, humanize, SYSTEM } from '../domain/rules.js';
import type { RuleRec } from '../ports.js';
import { actorText, invalid, notFound, type By, type Core } from './core.js';
import type { Reports } from './reports.js';
import type { Views } from './views.js';

/** Median of amounts (null when there are none) */
export function median(xs: number[]): number | null {
  const s = xs.filter((x) => Number.isFinite(x) && x > 0).sort((a, b) => a - b);
  if (!s.length) return null;
  const m = Math.floor(s.length / 2);
  return s.length % 2 ? s[m]! : Math.round((s[m - 1]! + s[m]!) / 2);
}

const REVIEW_CONTENT: Record<string, TrustSubject['type']> = { review: 'review', question: 'question', answer: 'answer', response: 'review', feedback: 'review' };

export class Detection {
  #seeded: Promise<void> | null = null;

  constructor(
    private readonly core: Core,
    private readonly views: Views,
    private readonly reports: Reports,
  ) {}

  /** The built-in rules exist (staff change their thresholds; never overwritten) */
  ensureRules(): Promise<void> {
    this.#seeded ??= (async () => {
      const now = this.core.now();
      await this.core.repo.insertIgnore(
        'detection_rules',
        RULES.map((r) => ({ key: r.key, description: r.description, type: r.type, active: r.active, thresholds: r.thresholds, base_score: r.baseScore, updated_by: actorText(SYSTEM), updated_at: now, last_run_at: null })),
      );
    })().catch((err) => {
      this.#seeded = null;
      throw err;
    });
    return this.#seeded;
  }

  /* ---------------------------------------------------------------- signals */

  /** Records a raw signal once (stable id from its key) */
  async record(key: string, kind: string, subject: { type: string; id: string }, features: Record<string, unknown>, at?: string | Date | null) {
    if (!isUuid(subject.id)) return;
    const when = at ? new Date(at) : this.core.now();
    await this.core.repo.insertIgnore('risk_signals', [{ id: detId(`${kind}:${key}`), kind, subject_type: subject.type, subject_id: subject.id, features, at: Number.isNaN(when.getTime()) ? this.core.now() : when }]);
  }

  async onReviewPublished(e: EventPayload<'reviews.review.published'>) {
    await this.record(e.reviewId, 'review_published', { type: 'product', id: e.productId }, { reviewId: e.reviewId, sellerId: e.sellerId, rating: e.rating, verified: e.verified });
  }

  async onOrderPlaced(e: EventPayload<'orders.order.placed'>) {
    const order = await this.core.soft('orders', 'getOrder', (o) => o.getOrder(e.orderId));
    await this.record(
      e.orderId,
      'order_placed',
      { type: 'order', id: e.orderId },
      {
        orderId: e.orderId,
        orderRef: e.ref,
        customerId: e.customerId ?? null,
        guestEmail: e.guestEmail?.toLowerCase() ?? null,
        paymentIntentId: e.paymentIntentId,
        addressKey: addressKey(order?.deliveryAddress),
        total: e.total,
        sellerIds: e.groups.map((g) => g.sellerId).filter(Boolean),
      },
      e.placedAt,
    );
  }

  async onPaymentFailed(e: EventPayload<'payments.payment.failed'>) {
    await this.record(`${e.intentId}:${e.at}`, 'payment_failed', { type: 'payment', id: e.intentId }, { checkoutSessionId: e.checkoutSessionId, declineCategory: e.declineCategory, orderId: e.orderId ?? null, afterPendingCheck: e.afterPendingCheck }, e.at);
  }

  /** A chargeback signal; repeated chargebacks on one seller open a report right away */
  async onChargebackOpened(e: EventPayload<'payments.chargeback.opened'>) {
    const subject = e.sellerId ? { type: 'seller', id: e.sellerId } : { type: 'order', id: e.orderId };
    await this.record(e.disputeId, 'chargeback', subject, { disputeId: e.disputeId, ref: e.ref, kind: e.kind, orderId: e.orderId, amount: e.amount });
    if (e.sellerId) await this.runRuleKey('payments.repeated_chargebacks');
  }

  async onOfferCreated(e: EventPayload<'offers.offer.created'>) {
    if (e.ownerType === 'official') return;
    const offer = await this.core.soft('offers', 'getOfferAdmin', (o) => o.getOfferAdmin(e.offerId));
    const product = await this.core.soft('catalog', 'getProduct', (c) => c.getProduct(e.productId));
    // reference price: the median of the other active offers on the product (decision D7), not an authorised price list
    const peers = (await this.core.soft('offers', 'listActiveOffersForProduct', (o) => o.listActiveOffersForProduct(e.productId))) ?? [];
    const reference = median(peers.filter((p) => p.id !== e.offerId && p.price.currency === (offer?.price.currency ?? p.price.currency)).map((p) => p.price.amount));
    await this.record(
      e.offerId,
      'offer_created',
      { type: 'offer', id: e.offerId },
      {
        productId: e.productId,
        productTitle: product?.title ?? null,
        sellerId: e.sellerId ?? null,
        sellerName: offer?.sellerName ?? null,
        price: offer?.price.amount ?? null,
        reference,
        brandId: product?.brand?.id ?? null,
        brandName: product?.brand?.name ?? null,
        condition: e.condition,
      },
    );
  }

  /** Application rules, and the submission noted on any open assessment of the seller */
  async onApplicationSubmitted(e: EventPayload<'sellers.application.submitted'>) {
    await this.record(e.applicationId, 'application_submitted', { type: 'application', id: e.applicationId }, {
      applicationId: e.applicationId,
      sellerId: e.sellerId,
      sellerType: e.sellerType,
      categoryIds: e.categoryIds,
      invited: e.invited,
      // hashes only (sellers never sends the tax id, bank token or address itself)
      taxIdHash: e.taxIdHash ?? null,
      bankTokenHash: e.bankTokenHash ?? null,
      addressKey: e.addressKey ?? null,
    });
    const key = `sellers.application.submitted:${e.applicationId}`;
    if (!(await this.reports.seen(key))) {
      const ids = [...new Set([...(await this.core.repo.reportIdsAbout(['application'], e.applicationId)), ...(await this.core.repo.reportIdsAbout(['seller'], e.sellerId))])];
      const open = ids.length ? await this.core.repo.find('reports', { id: ids, type: ['seller_application', 'account_risk'], status: ['open', 'under_review', 'escalated'] }) : [];
      for (const r of open) {
        await this.core.write(r.id, { actor: SYSTEM }, async (tx, agg) => {
          const ev = this.reports.evidenceRow(r.id, { kind: 'signal', result: 'info', text: `Application submitted (${humanize(e.sellerType)}, ${e.categoryIds.length} categor${e.categoryIds.length === 1 ? 'y' : 'ies'}${e.invited ? ', invited' : ''})` }, 'automated', SYSTEM);
          await this.reports.extend(tx, agg, { evidence: [ev], label: 'Seller application submitted', actor: SYSTEM, key });
        });
      }
    }
    await this.runRuleKey('sellers.application_duplicates');
  }

  /* ---------------------------------------------------------------- referrals from other modules */

  /** reviews.content.referred: open or extend a fake_reviews report about the author's content */
  async onContentReferred(e: EventPayload<'reviews.content.referred'>) {
    const key = `reviews.content.referred:${e.moderationItemId}`;
    if (await this.reports.seen(key)) return;
    const type = REVIEW_CONTENT[e.contentType] ?? 'review';
    const subjects: TrustSubject[] = [
      ...(isUuid(e.contentId) ? [{ type, id: e.contentId, label: `Referred ${humanize(e.contentType).toLowerCase()}` }] : []),
      ...(isUuid(e.authorId) ? [{ type: 'customer' as const, id: e.authorId, label: 'Author' }] : []),
    ];
    if (!subjects.length) return;
    const actor: common.Actor = { kind: 'system', id: null, name: 'Review moderation' };
    await this.reports.signal(
      {
        type: 'fake_reviews',
        title: 'Reviews referred by moderation',
        description: e.note || 'Review moderation referred content to Trust and Risk',
        source: 'referral',
        reporter: { kind: 'system', id: null, name: 'reviews' },
        detector: 'reviews.content.referred',
        dedupeKey: `reviews.referred:${isUuid(e.authorId) ? e.authorId : e.contentId}`,
        subjects,
        evidence: [this.reports.evidenceRow('', { kind: 'record_link', text: `Moderation item ${e.moderationItemId}: ${e.note || 'referred'}` }, 'other_module', actor)],
        key,
        createdLabel: 'Referred by review moderation',
        extendLabel: 'More content referred by review moderation',
      },
      { actor },
    );
  }

  /** messaging.message.reported: an abuse report about the message (repeat reports of a message add reporters) */
  async onMessageReported(e: EventPayload<'messaging.message.reported'>) {
    const key = `messaging.message.reported:${e.reportId}`;
    if (!isUuid(e.messageId) || (await this.reports.seen(key))) return;
    const actor: common.Actor = { kind: 'system', id: null, name: 'Messaging' };
    await this.reports.signal(
      {
        type: 'abuse',
        title: `Reported message: ${humanize(e.reason).toLowerCase()}`,
        description: `A participant reported a message (${humanize(e.reason).toLowerCase()})`,
        source: 'referral',
        reporter: { kind: 'system', id: null, name: 'messaging' },
        detector: 'messaging.message.reported',
        dedupeKey: `messaging:report:${e.messageId}`,
        subjects: [{ type: 'message', id: e.messageId, label: 'Reported message' }],
        evidence: [this.reports.evidenceRow('', { kind: 'record_link', text: `Message report ${e.reportId}: ${humanize(e.reason)}` }, 'other_module', actor)],
        key,
        countReporter: true,
        createdLabel: 'Message reported in messaging',
        extendLabel: 'The message was reported again',
      },
      { actor },
    );
  }

  /* ---------------------------------------------------------------- rules */

  async hits(key: string): Promise<number> {
    const since = this.core.now().getTime() - 30 * 86_400_000;
    return (await this.core.repo.eventsFor('rule', key, ['detection_hit'])).filter((e) => e.at.getTime() >= since).length;
  }

  async listRules(): Promise<DetectionRule[]> {
    await this.ensureRules();
    const rows = await this.core.repo.find('detection_rules', {}, { orderBy: [['key', 'asc']] });
    return Promise.all(rows.map(async (r) => this.views.rule(r, await this.hits(r.key))));
  }

  async updateRule(key: string, body: { active?: boolean | null; thresholds?: unknown; baseScore?: number | null; reason: string }, by: By): Promise<DetectionRule> {
    await this.ensureRules();
    const before = await this.core.repo.get('detection_rules', key);
    if (!before) throw notFound('Detection rule');
    const issues: { path: string; message: string }[] = [];
    if (!body.reason?.trim()) issues.push({ path: 'reason', message: 'Why does the rule change?' });
    if (body.baseScore !== undefined && body.baseScore !== null && (!Number.isInteger(body.baseScore) || body.baseScore < 0 || body.baseScore > 100)) issues.push({ path: 'baseScore', message: 'A score from 0 to 100' });
    if (body.thresholds !== undefined && body.thresholds !== null && (typeof body.thresholds !== 'object' || Array.isArray(body.thresholds))) issues.push({ path: 'thresholds', message: 'An object of threshold values' });
    if (issues.length) throw invalid(issues);
    const after = await this.core.repo.update('detection_rules', key, {
      ...(typeof body.active === 'boolean' ? { active: body.active } : {}),
      ...(body.thresholds && typeof body.thresholds === 'object' ? { thresholds: { ...before.thresholds, ...(body.thresholds as Record<string, unknown>) } } : {}),
      ...(Number.isInteger(body.baseScore) ? { base_score: body.baseScore! } : {}),
      updated_by: actorText(by.actor),
      updated_at: this.core.now(),
    });
    await this.core.audit(
      {
        action: 'trust.rule.update',
        actionLabel: 'Changed a detection rule',
        category: 'settings',
        target: { type: 'detection_rule', id: key, ref: key, label: before.description, screen: 'admin/trust' },
        reason: body.reason,
        before: { active: before.active, thresholds: before.thresholds, baseScore: before.base_score },
        after: { active: after.active, thresholds: after.thresholds, baseScore: after.base_score },
      },
      by,
    );
    return this.views.rule(after, await this.hits(key));
  }

  private async runRuleKey(key: string) {
    await this.ensureRules();
    const rule = await this.core.repo.get('detection_rules', key);
    if (rule?.active) await this.runRule(rule);
  }

  /** Evaluates one rule; a hit opens or extends its report when it carries signals not seen in an earlier hit */
  async runRule(rule: RuleRec) {
    const seed = ruleSeed(rule.key);
    if (!seed) return;
    const now = this.core.now();
    const since = new Date(now.getTime() - windowMs(seed, rule.thresholds ?? {}));
    const signals = (await this.core.repo.find('risk_signals', { kind: seed.signal, at: { op: '>=', value: since } }, { orderBy: [['at', 'asc']], limit: 5000 })) as SignalRec[];
    for (const hit of evaluate(rule.key, rule.thresholds ?? {}, signals)) {
      const dedupeKey = `rule:${hit.dedupeKey}`;
      const earlier = new Set((await this.core.repo.eventsFor('dedupeKey', dedupeKey, ['detection_hit'])).flatMap((e) => (Array.isArray(e.detail.signals) ? (e.detail.signals as string[]) : [])));
      if (hit.signalIds.every((id) => earlier.has(id))) continue;
      const actor: common.Actor = { kind: 'system', id: null, name: `Rule ${rule.key}` };
      const agg = await this.reports.signal(
        {
          type: rule.type,
          title: hit.title,
          description: `${rule.description}. ${hit.evidence}`,
          source: 'automated',
          reporter: { kind: 'system', id: null, name: rule.key },
          detector: rule.key,
          dedupeKey,
          subjects: hit.subjects.map((s) => ({ ...s, ref: s.ref ?? null })),
          evidence: [this.reports.evidenceRow('', { kind: 'signal', result: 'warn', text: hit.evidence }, 'automated', actor)],
          signalScore: rule.base_score,
          createdLabel: `Raised by detection rule ${rule.key}`,
          extendLabel: `Detection rule ${rule.key} matched again`,
        },
        { actor },
      );
      await this.core.write(agg.report.id, { actor }, async (tx) => {
        await this.core.timeline(tx, agg.report.id, [{ kind: 'detection_hit', label: `Rule ${rule.key}: ${hit.signalIds.length} signal${hit.signalIds.length === 1 ? '' : 's'}`, meta: { rule: rule.key, dedupeKey, signals: hit.signalIds } }]);
      });
    }
    await this.core.repo.update('detection_rules', rule.key, { last_run_at: now });
  }

  /* ---------------------------------------------------------------- jobs */

  /** trust.run-detection */
  async runDetection() {
    await this.ensureRules();
    for (const rule of await this.core.repo.find('detection_rules', { active: true }, { orderBy: [['key', 'asc']] })) {
      try {
        await this.runRule(rule);
      } catch (err) {
        this.core.ctx.log.warn({ err, rule: rule.key }, 'trust: detection rule failed (the next run retries)');
      }
    }
  }

  /** trust.rescore: recompute open reports' scores (overrides keep their score; factors still update) */
  async rescore() {
    let offset = 0;
    for (let round = 0; round < 20; round++) {
      const rows = await this.core.repo.find('reports', { status: ['open', 'under_review', 'escalated'] }, { orderBy: [['updated_at', 'asc'], ['id', 'asc']], limit: 200, offset });
      for (const r of rows) {
        await this.core.repo.transaction(async (tx) => {
          const locked = await tx.get('reports', r.id, { forUpdate: true });
          if (locked && this.core.isActive(locked.status)) await this.core.rescoreIn(tx, r.id);
        });
      }
      if (rows.length < 200) break;
      offset += rows.length;
    }
  }

  /** trust.evidence-deadlines: expire open requests past due and note the missing proof on the report */
  async evidenceDeadlines() {
    const now = this.core.now();
    for (const req of await this.core.repo.find('evidence_requests', { state: 'open', due_at: { op: '<', value: now } }, { orderBy: [['due_at', 'asc']], limit: 200 })) {
      await this.core.write(req.report_id, { actor: SYSTEM }, async (tx) => {
        const cur = (await tx.get('evidence_requests', req.id, { forUpdate: true }))!;
        if (cur.state !== 'open') return;
        await tx.update('evidence_requests', req.id, { state: evidenceRequestMachine.next('open', 'expire') });
        await tx.insert('evidence', this.reports.evidenceRow(req.report_id, { kind: 'note', result: 'warn', text: `No proof received from the ${req.to_type} by ${req.due_at.toISOString().slice(0, 10)}: “${req.question}”` }, 'automated', SYSTEM));
        await this.core.timeline(tx, req.report_id, [{ kind: 'evidence_request_expired', label: `Proof not received from the ${req.to_type} by the deadline`, text: 'Missing proof is noted; it is not a decision by itself', meta: { requestId: req.id } }]);
        await this.core.rescoreIn(tx, req.report_id);
      });
    }
  }
}
