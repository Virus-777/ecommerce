/**
 * Enforcement: restrictions, suspensions, reinstatement, warnings, appeals, canSell, approvals for
 * enforcement actions (access) and trust enforcements.
 */
import { AppError } from '../../../kernel/errors/index.js';
import type { EventEnvelope, EventPayload } from '../../../kernel/events/index.js';
import { isUuid, newId } from '../../../kernel/lib/ids.js';
import { pageOf, type PageRequest } from '../../../kernel/lib/pagination.js';
import type * as common from '../../../spec/common.js';
import type { Appeal, AppealInput, AppealRoute, Restriction, RestrictionInput, RestrictionScope, SellerWarning, SuspensionImpact, SuspensionInput } from '../../../spec/sellers.js';
import {
  type Activity,
  addBusinessDays,
  addDays,
  affectedSummary,
  DEFAULT_STILL_WORKS,
  isoDate,
  normalizeScope,
  restrictionBlocks,
} from '../domain/rules.js';
import { appealMachine, restrictionMachine, sellerAccountStatusMachine, sellerWarningMachine, suspensionMachine } from '../domain/state-machines.js';
import * as map from '../mappers.js';
import type { AppealRec, PendingChangeRec, RestrictionRec, SellerRec, SellersRepository, SuspensionRec } from '../ports.js';
import { invalid, notFound, Part, SYSTEM, TRUST_TEAM, type By } from './core.js';

const ALL_SALES: Activity[] = ['new_listings', 'product_submissions', 'new_offers', 'offer_reactivation', 'sales', 'advertising', 'promotions'];
const SUSPENSION_REASON: Record<string, Restriction['reasonCode']> = {
  repeated_late_dispatch: 'performance',
  counterfeit_or_unsafe: 'counterfeit_risk',
  fraud_or_abuse: 'fraud_risk',
  unresolved_cases: 'unresolved_cases',
  policy_violation: 'policy_violation',
  other: 'other',
};
const SUSPENSION_STATE: Record<string, Restriction['state']> = { pending_approval: 'pending_approval', active: 'active', ended: 'lifted', cancelled: 'cancelled' };
const OPEN_APPEAL = ['submitted', 'under_review'];
const SELLING = ['approved', 'restricted', 'suspended'];
const NIL = '00000000-0000-0000-0000-000000000000';

type StoredRoute = AppealRoute & { windowDays?: number };

export class EnforcementPart extends Part {
  /* ---------------------------------------------------------------- shared */

  async appealRoute(days: number | null | undefined, from: Date = this.now()): Promise<StoredRoute> {
    const window = days ?? (await this.core.setting('appealWindowDays'));
    return {
      deadline: addDays(from, window).toISOString(),
      howTo: `Appeal in Account health within ${window} days. Explain what happened and add documents that support your case.`,
      reviewer: 'A Seller Manager who did not make this decision',
      secondAppealTo: 'Business Owner',
      windowDays: window,
    };
  }

  private route(r: unknown): AppealRoute {
    const x = (r ?? {}) as StoredRoute;
    return { deadline: x.deadline, howTo: x.howTo, reviewer: x.reviewer, secondAppealTo: x.secondAppealTo ?? null };
  }

  /** Restriction views with their appeals (and, for staff, the approval state) */
  async restrictionViews(rows: RestrictionRec[], o: { staff?: boolean } = {}): Promise<Restriction[]> {
    if (!rows.length) return [];
    const appeals = await this.repo.find('appeals', { subject: 'restriction', subject_id: rows.map((r) => r.id) }, { orderBy: [['submitted_at', 'desc']] });
    const sellers = new Map((await this.repo.getMany('sellers', [...new Set(rows.map((r) => r.seller_id))])).map((s) => [s.id, s]));
    const evidence = rows.flatMap((r) => ((r.resolution_evidence ?? []) as { mediaId?: string }[]).map((e) => e.mediaId));
    const refs = await this.core.mediaRefs([...evidence, ...appeals.flatMap((a) => map.strings(a.evidence_media_ids))]);
    const appealViews = await this.appealViews(appeals, { refs, sellers, restrictions: rows });
    // staff see a change waiting for a second reviewer, and its approval in place of the restriction's own
    const changes = o.staff ? await this.core.pendingChangesFor('restriction_change', rows.map((r) => r.id)) : new Map<string, PendingChangeRec>();
    const out: Restriction[] = [];
    for (const r of rows) {
      const change = changes.get(r.id);
      const approval = o.staff ? await this.approvalInfo(change?.approval_request_id ?? r.approval_request_id) : null;
      const v = map.restriction(r, { appeals: appealViews.filter((a) => a.subjectId === r.id), refs, approval });
      out.push({ ...v, appealRoute: this.route(r.appeal_route), pendingChange: change ? map.pendingStaffChange(change) : null });
    }
    return out;
  }

  private approvalInfo(id: string | null): Promise<common.ApprovalInfo | null> {
    return this.core.approvalInfo(id);
  }

  private async restrictionView(r: RestrictionRec, o: { staff?: boolean } = {}) {
    return (await this.restrictionViews([r], o))[0]!;
  }

  /** A suspension shown in the restriction list (sellers appeal both from there) */
  private async suspensionView(s: SuspensionRec, seller: SellerRec, o: { staff?: boolean } = {}): Promise<Restriction> {
    const appeals = await this.repo.find('appeals', { subject: 'suspension', subject_id: s.id }, { orderBy: [['submitted_at', 'desc']] });
    const refs = await this.core.mediaRefs(appeals.flatMap((a) => map.strings(a.evidence_media_ids)));
    const approval = o.staff ? await this.approvalInfo(s.approval_request_id) : null;
    return {
      id: s.id,
      ref: s.ref,
      sellerId: s.seller_id,
      state: SUSPENSION_STATE[s.state] ?? 'cancelled',
      title: 'All new sales suspended',
      reasonCode: SUSPENSION_REASON[s.reason_code] ?? 'other',
      reason: s.reason,
      ruleRef: null,
      affectedActivities: ALL_SALES,
      scope: normalizeScope(null),
      affectedSummary: s.open_orders === 'cancel_unshipped_and_refund' ? 'No new sales; unshipped orders are cancelled and refunded' : 'No new sales; you keep fulfilling open orders',
      stillWorks: DEFAULT_STILL_WORKS,
      toResolve: 'Your Seller Manager reviews the suspension on the review date. You can appeal before the deadline.',
      appealRoute: this.route(s.appeal_route),
      reviewDate: s.review_date,
      startedAt: map.iso(s.started_at),
      endsAt: map.iso(s.ended_at),
      setBy: map.actorReq(s.requested_by),
      recommendedBy: s.trust_report_id ? TRUST_TEAM : null,
      trustReportId: s.trust_report_id,
      trustEnforcementId: null,
      approval,
      appeals: await this.appealViews(appeals, { refs, sellers: new Map([[seller.id, seller]]), suspensions: [s] }),
      resolutionEvidence: [],
      liftedAt: map.iso(s.ended_at),
      liftReason: s.end_reason,
    };
  }

  async activeRestrictions(sellerId: string, repo: SellersRepository = this.repo) {
    return repo.find('restrictions', { seller_id: sellerId, state: 'active' }, { orderBy: [['started_at', 'desc']] });
  }

  /* ---------------------------------------------------------------- restrictions */

  private validateInput(input: RestrictionInput) {
    const issues: { path: string; message: string }[] = [];
    if (!input.title?.trim()) issues.push({ path: 'title', message: 'Give the restriction a short title' });
    if (!input.reason?.trim()) issues.push({ path: 'reason', message: 'State the facts and the rule' });
    if (!input.toResolve?.trim()) issues.push({ path: 'toResolve', message: 'Tell the seller how to resolve it' });
    if (!input.affectedActivities?.length) issues.push({ path: 'affectedActivities', message: 'Choose at least one affected activity' });
    if (input.reviewDate < this.core.today()) issues.push({ path: 'reviewDate', message: 'The review date cannot be in the past' });
    if (input.endsAt && new Date(input.endsAt) <= this.now()) issues.push({ path: 'endsAt', message: 'The end must be in the future' });
    if (input.appealDays !== undefined && input.appealDays !== null && (input.appealDays < 1 || input.appealDays > 90)) issues.push({ path: 'appealDays', message: 'Between 1 and 90 days' });
    if (issues.length) throw invalid(issues);
  }

  private async newRestrictionRow(seller: SellerRec, input: RestrictionInput, by: By, recommendedBy: common.Actor | null): Promise<RestrictionRec> {
    const scope = normalizeScope(input.scope);
    return {
      id: newId(),
      ref: await this.ctx.refs.next('RS', { digits: 4 }),
      seller_id: seller.id,
      state: restrictionMachine.initial,
      title: input.title.trim(),
      reason_code: input.reasonCode,
      reason: input.reason.trim(),
      rule_ref: input.ruleRef ?? null,
      affected_activities: input.affectedActivities as never,
      scope: scope as never,
      affected_summary: affectedSummary(input.affectedActivities, scope),
      still_works: (input.stillWorks?.length ? input.stillWorks : DEFAULT_STILL_WORKS) as never,
      to_resolve: input.toResolve.trim(),
      appeal_route: (await this.appealRoute(input.appealDays)) as never,
      review_date: input.reviewDate,
      started_at: null,
      ends_at: input.endsAt ? new Date(input.endsAt) : null,
      set_by: map.actorText(by.actor),
      recommended_by: recommendedBy ? map.actorText(recommendedBy) : null,
      trust_report_id: input.trustReportId ?? null,
      trust_enforcement_id: input.trustEnforcementId ?? null,
      approval_request_id: null,
      resolution_evidence: [] as never,
      lifted_at: null,
      lift_reason: null,
    };
  }

  /**
   * Restrict a seller under the caller's authority (access): active at once when allowed, otherwise
   * pending_approval with an approval request. The pending restriction is saved, so the answer is the
   * normal one with `approval` filled (FORMAT.md, Approval responses), never APPROVAL_REQUIRED.
   */
  async createRestriction(sellerId: string, input: RestrictionInput, by: By, o: { recommendedBy?: common.Actor | null; skipAuthority?: boolean } = {}): Promise<Restriction> {
    const seller = await this.core.seller(sellerId);
    if (!SELLING.includes(seller.status)) throw new AppError('ILLEGAL_TRANSITION', `A ${seller.status.replace(/_/g, ' ')} seller cannot be restricted`, { from: seller.status, event: 'restrict' });
    this.validateInput(input);
    const row = await this.repo.insert('restrictions', await this.newRestrictionRow(seller, input, by, o.recommendedBy ?? null));

    let decision: 'allowed' | 'approval_required' | 'denied' = 'allowed';
    let reason = '';
    if (!o.skipAuthority) {
      const check = await this.ctx.use('access').check(this.core.principalOf(by), 'sellers.sellers.restrict');
      decision = check.decision;
      reason = check.reason;
    }
    if (decision === 'denied') {
      await this.repo.remove('restrictions', row.id);
      throw new AppError('FORBIDDEN', reason || 'Your role cannot restrict sellers', { action: 'sellers.sellers.restrict' });
    }
    if (decision === 'approval_required') {
      const req = await this.ctx.use('access').requestApproval({
        action: 'sellers.sellers.restrict',
        target: { type: 'restriction', id: row.id, ref: row.ref, label: `${seller.store_name} · ${row.title}`, sellerId: seller.id, screen: 'admin/seller' },
        summary: `Restrict ${seller.store_name}: ${row.title}`,
        details: { title: row.title, affectedActivities: row.affected_activities, scope: row.scope, reviewDate: row.review_date },
        reason: row.reason,
        requestedBy: this.core.principalOf(by),
      });
      const pending = await this.repo.update('restrictions', row.id, { approval_request_id: req.id });
      await this.core.timeline(this.repo, seller.id, { kind: 'restriction_requested', title: `Restriction proposed: ${row.title}`, visibility: 'staff', actor: by.actor, ref: row.ref });
      await this.core.audit(
        {
          action: 'sellers.restriction.request',
          actionLabel: 'Proposed a seller restriction',
          category: 'seller_enforcement',
          target: this.target(seller, pending),
          reason: row.reason,
          after: { state: pending.state, affectedActivities: row.affected_activities, scope: row.scope },
          approvalRequestId: req.id,
        },
        by,
      );
      return this.restrictionView(pending, { staff: true });
    }
    const active = await this.activateRestriction(row.id, by, { approvalNote: 'Within your authority' });
    return this.restrictionView(active ?? row, { staff: true });
  }

  /** pending_approval → active: seller status, events, audit */
  async activateRestriction(id: string, by: By, o: { approvalRequestId?: string | null; approvalNote?: string; silentAudit?: boolean } = {}): Promise<RestrictionRec | undefined> {
    const pending = await this.repo.get('restrictions', id);
    const now = this.now();
    // the appeal window starts now (settings are read before the transaction)
    const fresh = await this.appealRoute((pending?.appeal_route as unknown as StoredRoute | undefined)?.windowDays, now);
    const result = await this.repo.transaction(async (tx) => {
      const r = await tx.get('restrictions', id, { forUpdate: true });
      if (!r || r.state !== 'pending_approval') return undefined;
      const seller = await this.core.seller(r.seller_id, { repo: tx, forUpdate: true });
      const after = await tx.update('restrictions', id, { state: this.core.step(restrictionMachine, r.state, 'approve'), started_at: now, appeal_route: fresh as never });
      let status = seller.status;
      if (seller.status === 'approved') {
        status = this.core.step(sellerAccountStatusMachine, seller.status, 'restrict');
        await tx.update('sellers', seller.id, { status, status_since: now, updated_at: now });
      }
      await this.core.timeline(tx, seller.id, { kind: 'restricted', title: `Restricted: ${after.title}`, detail: after.affected_summary, actor: by.actor, ref: after.ref });
      return { r: after, seller, statusBefore: seller.status, status };
    });
    if (!result) return undefined;
    const { r, seller } = result;
    const scope = normalizeScope(r.scope as RestrictionScope);
    const route = r.appeal_route as unknown as StoredRoute;
    this.core.publish(
      'sellers.seller.restricted',
      {
        sellerId: seller.id,
        restrictionId: r.id,
        reasonCode: r.reason_code,
        reason: r.reason,
        affectedActivities: map.strings(r.affected_activities) as Activity[],
        scope,
        categoryIds: scope.categoryIds ?? [],
        appealRoute: route.howTo,
        appealDeadline: route.deadline,
        reviewDate: r.review_date,
        trustReportId: r.trust_report_id,
        trustEnforcementId: r.trust_enforcement_id,
      },
      by,
    );
    if (!o.silentAudit) {
      await this.core.audit(
        {
          action: 'sellers.restriction.create',
          actionLabel: 'Restricted a seller',
          category: 'seller_enforcement',
          target: this.target(seller, r),
          reason: r.reason,
          before: { status: result.statusBefore },
          after: { status: result.status, state: r.state, affectedActivities: r.affected_activities, scope, reviewDate: r.review_date },
          approvalRequestId: o.approvalRequestId ?? r.approval_request_id,
          approvalNote: o.approvalNote ?? null,
          visibleToSeller: true,
        },
        by,
      );
    }
    return r;
  }

  private target(seller: SellerRec, r: { id: string; ref: string; title: string }) {
    return { type: 'restriction', id: r.id, ref: r.ref, label: `${seller.store_name} · ${r.title}`, sellerId: seller.id, screen: 'admin/seller' };
  }

  private async restrictionOf(id: string, sellerId?: string, forUpdate = false, repo: SellersRepository = this.repo) {
    const r = isUuid(id) ? await repo.get('restrictions', id, { forUpdate }) : undefined;
    if (!r || (sellerId && r.seller_id !== sellerId)) throw notFound('Restriction');
    return r;
  }

  async updateRestriction(
    id: string,
    body: { reason?: string | null; affectedActivities?: Activity[] | null; scope?: RestrictionScope | null; toResolve?: string | null; reviewDate?: string | null; changeReason: string },
    by: By,
  ): Promise<Restriction> {
    const r = await this.restrictionOf(id);
    if (r.state !== 'active') throw new AppError('ILLEGAL_TRANSITION', 'Only active restrictions can be edited', { from: r.state, event: 'update' });
    const issues: { path: string; message: string }[] = [];
    if (!body.changeReason?.trim()) issues.push({ path: 'changeReason', message: 'Say why the restriction changes' });
    if (body.affectedActivities && !body.affectedActivities.length) issues.push({ path: 'affectedActivities', message: 'Keep at least one affected activity' });
    if (body.reviewDate && body.reviewDate < this.core.today()) issues.push({ path: 'reviewDate', message: 'The review date cannot be in the past' });
    if (body.reason !== undefined && body.reason !== null && !body.reason.trim()) issues.push({ path: 'reason', message: 'The reason cannot be empty' });
    if (issues.length) throw invalid(issues);
    const patch = {
      ...(body.reason ? { reason: body.reason.trim() } : {}),
      ...(body.affectedActivities ? { affectedActivities: body.affectedActivities } : {}),
      ...(body.scope ? { scope: normalizeScope(body.scope) } : {}),
      ...(body.toResolve ? { toResolve: body.toResolve.trim() } : {}),
      ...(body.reviewDate ? { reviewDate: body.reviewDate } : {}),
    };
    const check = await this.ctx.use('access').check(this.core.principalOf(by), 'sellers.sellers.restrict');
    if (check.decision === 'denied') throw new AppError('FORBIDDEN', check.reason, { action: 'sellers.sellers.restrict' });
    if (check.decision === 'approval_required') {
      const seller = await this.core.seller(r.seller_id);
      const req = await this.ctx.use('access').requestApproval({
        action: 'sellers.sellers.restrict',
        target: { type: 'restriction_change', id: r.id, ref: r.ref, label: `${seller.store_name} · ${r.title}`, sellerId: seller.id, screen: 'admin/seller' },
        summary: `Change restriction ${r.ref} of ${seller.store_name}`,
        details: { patch, changeReason: body.changeReason },
        reason: body.changeReason,
        requestedBy: this.core.principalOf(by),
      });
      await this.core.savePendingChange({ kind: 'restriction_change', sellerId: seller.id, targetId: r.id, approvalRequestId: req.id, payload: { patch, changeReason: body.changeReason }, reason: body.changeReason, actor: by.actor });
      await this.core.audit(
        {
          action: 'sellers.restriction.update_request',
          actionLabel: 'Proposed a change to a seller restriction',
          category: 'seller_enforcement',
          target: this.target(seller, r),
          reason: body.changeReason,
          after: patch,
          approvalRequestId: req.id,
        },
        by,
      );
      // saved, pending approval: the restriction unchanged with the change and its approval (FORMAT.md, Approval responses)
      return this.restrictionView(r, { staff: true });
    }
    return this.restrictionView(await this.applyRestrictionChange(r.id, patch, body.changeReason, by), { staff: true });
  }

  private async applyRestrictionChange(
    id: string,
    patch: { reason?: string; affectedActivities?: Activity[]; scope?: RestrictionScope; toResolve?: string; reviewDate?: string },
    changeReason: string,
    by: By,
    approvalRequestId?: string,
  ): Promise<RestrictionRec> {
    const before = await this.restrictionOf(id);
    if (before.state !== 'active') return before;
    const activities = patch.affectedActivities ?? (map.strings(before.affected_activities) as Activity[]);
    const scope = patch.scope ?? normalizeScope(before.scope as RestrictionScope);
    const after = await this.repo.update('restrictions', id, {
      ...(patch.reason ? { reason: patch.reason } : {}),
      ...(patch.toResolve ? { to_resolve: patch.toResolve } : {}),
      ...(patch.reviewDate ? { review_date: patch.reviewDate } : {}),
      affected_activities: activities as never,
      scope: scope as never,
      affected_summary: affectedSummary(activities, scope),
    });
    const seller = await this.core.seller(after.seller_id);
    this.core.publish('sellers.restriction.updated', { sellerId: seller.id, restrictionId: id, affectedActivities: activities, scope, reviewDate: after.review_date }, by);
    await this.core.timeline(this.repo, seller.id, { kind: 'restriction_updated', title: `Restriction changed: ${after.title}`, detail: after.affected_summary, actor: by.actor, ref: after.ref });
    await this.core.audit(
      {
        action: 'sellers.restriction.update',
        actionLabel: 'Changed a seller restriction',
        category: 'seller_enforcement',
        target: this.target(seller, after),
        reason: changeReason,
        before: { reason: before.reason, affectedActivities: before.affected_activities, scope: before.scope, toResolve: before.to_resolve, reviewDate: before.review_date },
        after: { reason: after.reason, affectedActivities: after.affected_activities, scope: after.scope, toResolve: after.to_resolve, reviewDate: after.review_date },
        approvalRequestId: approvalRequestId ?? null,
        visibleToSeller: true,
      },
      by,
    );
    return after;
  }

  async liftRestriction(id: string, reason: string, by: By): Promise<Restriction> {
    if (!reason?.trim()) throw invalid([{ path: 'reason', message: 'Say why the restriction is lifted' }]);
    const r = await this.restrictionOf(id);
    const after = await this.endRestriction(r.id, 'lift', reason.trim(), by);
    return this.restrictionView(after, { staff: true });
  }

  /** active → lifted | expired, with the account status and events that follow */
  async endRestriction(id: string, event: 'lift' | 'expire', reason: string, by: By): Promise<RestrictionRec> {
    const res = await this.repo.transaction(async (tx) => {
      const r = await this.restrictionOf(id, undefined, true, tx);
      const state = this.core.step(restrictionMachine, r.state, event);
      const now = this.now();
      const after = await tx.update('restrictions', id, { state, lifted_at: now, lift_reason: reason });
      const seller = await this.core.seller(r.seller_id, { repo: tx, forUpdate: true });
      const remaining = (await this.activeRestrictions(seller.id, tx)).map((x) => x.id);
      let reinstated = false;
      if (seller.status === 'restricted' && !remaining.length) {
        await tx.update('sellers', seller.id, { status: this.core.step(sellerAccountStatusMachine, seller.status, 'liftLastRestriction'), status_since: now, updated_at: now });
        reinstated = true;
      }
      await this.core.timeline(tx, seller.id, { kind: event === 'lift' ? 'restriction_lifted' : 'restriction_expired', title: `${event === 'lift' ? 'Lifted' : 'Ended'}: ${r.title}`, detail: reason, actor: by.actor, ref: r.ref });
      return { after, seller, remaining, reinstated };
    });
    const { after, seller, remaining, reinstated } = res;
    this.core.publish('sellers.restriction.lifted', { sellerId: seller.id, restrictionId: id, reason, trustEnforcementId: after.trust_enforcement_id }, by);
    if (reinstated) this.core.publish('sellers.seller.reinstated', { sellerId: seller.id, from: 'restricted', to: 'approved', liftedRestrictionId: id, endedSuspensionId: null, remainingRestrictionIds: remaining }, by);
    await this.core.audit(
      {
        action: event === 'lift' ? 'sellers.restriction.lift' : 'sellers.restriction.expire',
        actionLabel: event === 'lift' ? 'Lifted a seller restriction' : 'Restriction ended',
        category: 'seller_enforcement',
        target: this.target(seller, after),
        reason,
        before: { state: 'active', status: seller.status },
        after: { state: after.state, status: reinstated ? 'approved' : seller.status },
        visibleToSeller: true,
      },
      by,
    );
    return after;
  }

  /* ---------------------------------------------------------------- seller area */

  async listOwnRestrictions(sellerId: string, state: 'active' | 'lifted' | 'expired' | undefined, page: PageRequest): Promise<common.Page<Restriction>> {
    const seller = await this.core.seller(sellerId);
    const rs = await this.repo.find('restrictions', { seller_id: sellerId, state: state ? [state] : ['active', 'lifted', 'expired'] });
    const ss = await this.repo.find('suspensions', { seller_id: sellerId, state: state === 'active' ? ['active'] : state === 'lifted' ? ['ended'] : state ? [] : ['active', 'ended'] });
    const views = [...(await this.restrictionViews(rs)), ...(await Promise.all(ss.map((s) => this.suspensionView(s, seller))))];
    views.sort((a, b) => (b.startedAt ?? '').localeCompare(a.startedAt ?? ''));
    return pageOf(views, page);
  }

  async getOwnRestriction(sellerId: string, id: string): Promise<Restriction> {
    const seller = await this.core.seller(sellerId);
    if (!isUuid(id)) throw notFound('Restriction');
    const r = await this.repo.get('restrictions', id);
    if (r && r.seller_id === sellerId && r.state !== 'pending_approval' && r.state !== 'cancelled') return this.restrictionView(r);
    const s = await this.repo.get('suspensions', id);
    if (s && s.seller_id === sellerId && (s.state === 'active' || s.state === 'ended')) return this.suspensionView(s, seller);
    throw notFound('Restriction');
  }

  async submitResolutionEvidence(sellerId: string, id: string, body: { evidenceIds: string[]; note?: string | null }, by: By): Promise<Restriction> {
    const r = await this.restrictionOf(id, sellerId);
    if (r.state !== 'active') throw new AppError('ILLEGAL_TRANSITION', 'Evidence can only be sent for an active restriction', { from: r.state, event: 'submitEvidence' });
    if (!body.evidenceIds?.length) throw invalid([{ path: 'evidenceIds', message: 'Add at least one document' }]);
    await this.attachEvidence(body.evidenceIds, { kind: 'seller', id: sellerId }, r.id, r.ref);
    const at = this.now().toISOString();
    const evidence = [...((r.resolution_evidence ?? []) as object[]), ...body.evidenceIds.map((mediaId) => ({ mediaId, note: body.note ?? null, at }))];
    const after = await this.repo.update('restrictions', r.id, { resolution_evidence: evidence as never });
    await this.core.timeline(this.repo, sellerId, { kind: 'restriction_evidence', title: `Documents sent for ${r.title}`, detail: body.note ?? null, actor: by.actor, ref: r.ref });
    this.core.publish('sellers.restriction.evidence_submitted', { sellerId, restrictionId: r.id }, by);
    return this.restrictionView(after);
  }

  async attachEvidence(ids: readonly string[], owner: { kind: 'seller' | 'customer'; id: string }, refId: string, label: string) {
    const media = this.ctx.use('media');
    for (const id of new Set(ids)) await media.attach(id, { module: 'sellers', kind: 'verification_document', refId, refLabel: label }, owner);
  }

  /* ---------------------------------------------------------------- appeals */

  async appealViews(rows: AppealRec[], ctx: { refs?: map.Refs; sellers?: Map<string, SellerRec>; restrictions?: RestrictionRec[]; suspensions?: SuspensionRec[] } = {}): Promise<Appeal[]> {
    if (!rows.length) return [];
    const now = this.now();
    const sellers = ctx.sellers ?? new Map();
    const missingSellers = rows.map((a) => a.seller_id).filter((id) => !sellers.has(id));
    for (const s of await this.repo.getMany('sellers', missingSellers)) sellers.set(s.id, s);
    const refs = ctx.refs ?? (await this.core.mediaRefs(rows.flatMap((a) => map.strings(a.evidence_media_ids))));
    const restrictionRefs = new Map((ctx.restrictions ?? []).map((r) => [r.id, r.ref]));
    const needR = rows.filter((a) => a.subject === 'restriction' && !restrictionRefs.has(a.subject_id)).map((a) => a.subject_id);
    for (const r of await this.repo.getMany('restrictions', needR)) restrictionRefs.set(r.id, r.ref);
    const needA = rows.filter((a) => a.subject === 'application_rejection').map((a) => a.subject_id);
    const appRefs = new Map((await this.repo.getMany('applications', needA)).map((a) => [a.id, a.ref]));
    const suspensionRefs = new Map((ctx.suspensions ?? []).map((s) => [s.id, s.ref]));
    const needS = rows.filter((a) => a.subject === 'suspension' && !suspensionRefs.has(a.subject_id)).map((a) => a.subject_id);
    for (const s of await this.repo.getMany('suspensions', needS)) suspensionRefs.set(s.id, s.ref);
    const names = new Map<string, string | null>();
    for (const id of new Set(rows.map((a) => a.reviewer_id).filter((x): x is string => Boolean(x)))) names.set(id, await this.core.staffName(id));
    return rows.map((a) =>
      map.appeal(a, {
        storeName: sellers.get(a.seller_id)?.store_name ?? '',
        subjectRef:
          a.subject === 'restriction'
            ? (restrictionRefs.get(a.subject_id) ?? a.subject_id)
            : a.subject === 'application_rejection'
              ? (appRefs.get(a.subject_id) ?? a.subject_id)
              : a.subject === 'suspension'
                ? (suspensionRefs.get(a.subject_id) ?? a.subject_id)
                : a.subject_id,
        refs,
        now,
        reviewerName: a.reviewer_id ? (names.get(a.reviewer_id) ?? null) : null,
      }),
    );
  }

  /**
   * File an appeal (level 1, or level 2 after an upheld level 1) before the deadline.
   * `deadline` is the route's deadline for level 1; level 2 runs appealWindowDays from the level-1 decision.
   */
  async fileAppeal(
    input: { sellerId: string; subject: Appeal['subject']; subjectId: string; deadline: string; originalDeciderId: string; trustReportId?: string | null; argument: string; evidenceIds?: string[] | null; owner: { kind: 'seller' | 'customer'; id: string } },
    by: By,
  ): Promise<Appeal> {
    if (!input.argument?.trim()) throw invalid([{ path: 'argument', message: 'Explain why the decision should change' }]);
    const previous = await this.repo.find('appeals', { subject: input.subject, subject_id: input.subjectId }, { orderBy: [['level', 'asc']] });
    if (previous.some((p) => OPEN_APPEAL.includes(p.state))) throw new AppError('APPEAL_ALREADY_OPEN', 'An appeal for this decision is already open');
    const now = this.now();
    let level = 1;
    let deadline = new Date(input.deadline);
    if (previous.length) {
      const last = previous.at(-1)!;
      if (last.state !== 'upheld' || last.level >= 2) throw new AppError('APPEAL_ALREADY_OPEN', 'This decision has already been appealed');
      level = 2;
      const decidedAt = (last.decision as { decidedAt?: string } | null)?.decidedAt;
      deadline = addDays(decidedAt ? new Date(decidedAt) : last.submitted_at, await this.core.setting('appealWindowDays'));
    }
    if (deadline.getTime() < now.getTime()) throw new AppError('APPEAL_WINDOW_CLOSED', 'The appeal deadline has passed', { deadline: deadline.toISOString() });
    const evidence = [...new Set(input.evidenceIds ?? [])];
    const id = newId();
    if (evidence.length) await this.attachEvidence(evidence, input.owner, id, `Appeal ${input.subject}`);
    const decideBy = addBusinessDays(now, await this.core.setting('appealDecisionBusinessDays'));
    let row: AppealRec;
    try {
      row = await this.repo.insert('appeals', {
        id,
        ref: await this.ctx.refs.next('SAP', { digits: 3 }),
        seller_id: input.sellerId,
        subject: input.subject,
        subject_id: input.subjectId,
        level,
        argument: input.argument.trim(),
        evidence_media_ids: evidence as never,
        state: appealMachine.initial,
        reviewer_id: null,
        original_decider_id: input.originalDeciderId,
        decide_by: decideBy,
        decision: null,
        trust_report_id: input.trustReportId ?? null,
        submitted_at: now,
      });
    } catch (err) {
      if (await this.repo.findOne('appeals', { subject: input.subject, subject_id: input.subjectId, level })) throw new AppError('APPEAL_ALREADY_OPEN', 'An appeal for this decision and level already exists');
      throw err;
    }
    await this.core.timeline(this.repo, input.sellerId, { kind: 'appeal_submitted', title: `Appeal ${row.ref} submitted${level === 2 ? ' (second appeal)' : ''}`, actor: by.actor, ref: row.ref });
    this.core.publish(
      'sellers.appeal.submitted',
      { appealId: row.id, sellerId: input.sellerId, subject: input.subject, subjectId: input.subjectId, level, decideBy: decideBy.toISOString(), trustReportId: row.trust_report_id },
      by,
    );
    return (await this.appealViews([row]))[0]!;
  }

  async appealRestriction(sellerId: string, id: string, input: AppealInput, by: By): Promise<Appeal> {
    if (!isUuid(id)) throw notFound('Restriction');
    const r = await this.repo.get('restrictions', id);
    if (r && r.seller_id === sellerId && (r.state === 'active' || r.state === 'lifted' || r.state === 'expired')) {
      if (r.state !== 'active') throw new AppError('APPEAL_WINDOW_CLOSED', 'This restriction has ended');
      const route = r.appeal_route as unknown as StoredRoute;
      return this.fileAppeal(
        { sellerId, subject: 'restriction', subjectId: r.id, deadline: route.deadline, originalDeciderId: map.actorIdOf(r.set_by) ?? 'system', trustReportId: r.trust_report_id, argument: input.argument, evidenceIds: input.evidenceIds, owner: { kind: 'seller', id: sellerId } },
        by,
      );
    }
    const s = await this.repo.get('suspensions', id);
    if (s && s.seller_id === sellerId && (s.state === 'active' || s.state === 'ended')) {
      if (s.state !== 'active') throw new AppError('APPEAL_WINDOW_CLOSED', 'This suspension has ended');
      const route = s.appeal_route as unknown as StoredRoute;
      return this.fileAppeal(
        { sellerId, subject: 'suspension', subjectId: s.id, deadline: route.deadline, originalDeciderId: map.actorIdOf(s.requested_by) ?? 'system', trustReportId: s.trust_report_id, argument: input.argument, evidenceIds: input.evidenceIds, owner: { kind: 'seller', id: sellerId } },
        by,
      );
    }
    throw notFound('Restriction');
  }

  async listOwnAppeals(sellerId: string, page: PageRequest): Promise<common.Page<Appeal>> {
    await this.core.seller(sellerId);
    const p = await this.repo.page('appeals', { seller_id: sellerId }, page, { column: 'submitted_at', direction: 'desc' });
    return { ...p, items: await this.appealViews(p.items) };
  }

  private async appealOf(id: string, sellerId?: string, repo: SellersRepository = this.repo, forUpdate = false) {
    const a = isUuid(id) ? await repo.get('appeals', id, { forUpdate }) : undefined;
    if (!a || (sellerId && a.seller_id !== sellerId)) throw notFound('Appeal');
    return a;
  }

  async withdrawOwnAppeal(sellerId: string, id: string, by: By): Promise<Appeal> {
    const a = await this.appealOf(id, sellerId);
    const after = await this.repo.update('appeals', a.id, { state: this.core.step(appealMachine, a.state, 'withdraw') });
    await this.core.timeline(this.repo, sellerId, { kind: 'appeal_withdrawn', title: `Appeal ${a.ref} withdrawn`, actor: by.actor, ref: a.ref });
    await this.core.resolveWork(`appeal:${a.id}`, 'Appeal withdrawn by the seller', by.actor);
    return (await this.appealViews([after]))[0]!;
  }

  async listAppealsAdmin(
    f: { state?: Appeal['state']; reviewerId?: string; subject?: Appeal['subject']; trustLinked?: boolean },
    page: PageRequest,
  ): Promise<common.Page<Appeal>> {
    const where: Parameters<SellersRepository['page']>[1] = {
      ...(f.state ? { state: f.state } : { state: OPEN_APPEAL }),
      ...(f.reviewerId ? { reviewer_id: f.reviewerId } : {}),
      ...(f.subject ? { subject: f.subject } : {}),
      ...(f.trustLinked === true ? { trust_report_id: { op: 'is not', value: null } } : f.trustLinked === false ? { trust_report_id: null } : {}),
    } as never;
    const p = await this.repo.page('appeals', where as never, page, { column: 'decide_by', direction: 'asc' });
    return { ...p, items: await this.appealViews(p.items) };
  }

  /** Who may never decide this appeal: the original decider, a suspension's second reviewer, the level-1 reviewer */
  private async excludedDeciders(a: AppealRec): Promise<Set<string>> {
    const out = new Set<string>([a.original_decider_id]);
    if (a.subject === 'suspension') {
      const s = await this.repo.get('suspensions', a.subject_id);
      if (s) out.add(s.second_reviewer_id);
    }
    if (a.level > 1) {
      const first = await this.repo.findOne('appeals', { subject: a.subject, subject_id: a.subject_id, level: 1 });
      if (first?.reviewer_id) out.add(first.reviewer_id);
    }
    return out;
  }

  async assignAppeal(id: string, reviewerId: string, by: By): Promise<Appeal> {
    const a = await this.appealOf(id);
    if ((await this.excludedDeciders(a)).has(reviewerId)) throw new AppError('SAME_REVIEWER_NOT_ALLOWED', 'The reviewer made the original decision; choose someone else');
    const state = a.state === 'under_review' ? a.state : this.core.step(appealMachine, a.state, 'assign');
    const after = await this.repo.update('appeals', a.id, { state, reviewer_id: reviewerId });
    const seller = await this.core.seller(a.seller_id);
    await this.core.audit(
      { action: 'sellers.appeal.assign', actionLabel: 'Assigned an appeal reviewer', category: 'seller_enforcement', target: { type: 'appeal', id: a.id, ref: a.ref, label: seller.store_name, sellerId: seller.id, screen: 'admin/appeals' }, after: { reviewerId } },
      by,
    );
    return (await this.appealViews([after]))[0]!;
  }

  async decideAppeal(id: string, body: { outcome: 'uphold' | 'overturn' | 'partly_overturn'; explanation: string; changes?: unknown }, by: By): Promise<Appeal> {
    if (!body.explanation?.trim()) throw invalid([{ path: 'explanation', message: 'Explain the decision to the seller' }]);
    const a = await this.appealOf(id);
    const deciderId = by.actor.id ?? '';
    if ((await this.excludedDeciders(a)).has(deciderId)) throw new AppError('SAME_REVIEWER_NOT_ALLOWED', 'You made the original decision; another reviewer must decide this appeal');
    // any eligible reviewer may decide (the assignment routes the work); never the original decider
    const event = body.outcome === 'uphold' ? 'uphold' : body.outcome === 'overturn' ? 'overturn' : 'partlyOverturn';
    const from = a.state === 'submitted' ? this.core.step(appealMachine, a.state, 'assign') : a.state;
    const state = this.core.step(appealMachine, from, event);
    const changes = await this.applyAppealOutcome(a, body.outcome, body.changes, body.explanation.trim(), by);
    const decision = { outcome: state, explanation: body.explanation.trim(), changes, decidedBy: by.actor, decidedAt: this.now().toISOString() };
    const after = await this.repo.update('appeals', a.id, { state, reviewer_id: a.reviewer_id ?? (deciderId || null), decision: decision as never });
    const seller = await this.core.seller(a.seller_id);
    await this.core.timeline(this.repo, seller.id, { kind: 'appeal_decided', title: `Appeal ${a.ref}: ${state.replace(/_/g, ' ')}`, detail: body.explanation.trim(), actor: by.actor, ref: a.ref });
    this.core.publish(
      'sellers.appeal.decided',
      { appealId: a.id, sellerId: seller.id, outcome: state as 'upheld' | 'overturned' | 'partly_overturned', subject: a.subject, subjectId: a.subject_id, trustReportId: a.trust_report_id },
      by,
    );
    await this.core.audit(
      {
        action: 'sellers.appeal.decide',
        actionLabel: 'Decided a seller appeal',
        category: 'seller_enforcement',
        target: { type: 'appeal', id: a.id, ref: a.ref, label: seller.store_name, sellerId: seller.id, screen: 'admin/appeals' },
        reason: body.explanation,
        before: { state: a.state },
        after: { state, changes },
        visibleToSeller: true,
      },
      by,
    );
    return (await this.appealViews([after]))[0]!;
  }

  /** What an overturned or partly overturned appeal changes */
  private async applyAppealOutcome(a: AppealRec, outcome: 'uphold' | 'overturn' | 'partly_overturn', changes: unknown, explanation: string, by: By): Promise<string[]> {
    if (outcome === 'uphold') return [];
    const reason = `Appeal ${a.ref} ${outcome === 'overturn' ? 'overturned' : 'partly overturned'}: ${explanation}`;
    if (a.subject === 'restriction') {
      const r = await this.repo.get('restrictions', a.subject_id);
      if (!r || r.state !== 'active') return [];
      if (outcome === 'overturn') {
        await this.endRestriction(r.id, 'lift', reason, by);
        return [`Restriction ${r.ref} lifted`];
      }
      const c = (changes ?? {}) as { scope?: RestrictionScope; affectedActivities?: Activity[]; reviewDate?: string };
      const patch = { ...(c.scope ? { scope: normalizeScope(c.scope) } : {}), ...(c.affectedActivities?.length ? { affectedActivities: c.affectedActivities } : {}), ...(c.reviewDate ? { reviewDate: c.reviewDate } : {}) };
      if (!Object.keys(patch).length) throw invalid([{ path: 'changes', message: 'Say how the restriction is narrowed (scope, affected activities or review date)' }]);
      const after = await this.applyRestrictionChange(r.id, patch, reason, by);
      return [`Restriction ${r.ref} narrowed: ${after.affected_summary}`];
    }
    if (a.subject === 'suspension') {
      const s = await this.repo.get('suspensions', a.subject_id);
      if (!s || s.state !== 'active') return [];
      const seller = await this.core.seller(s.seller_id);
      await this.reinstateSeller(seller.id, { reason }, by);
      return ['Suspension ended'];
    }
    if (a.subject === 'application_rejection') {
      await this.parts.applications.reopenOnAppeal(a.subject_id, by);
      return ['Application reopened for review'];
    }
    if (a.subject === 'warning') {
      const w = await this.repo.get('warnings', a.subject_id);
      if (w?.state === 'open') await this.repo.update('warnings', w.id, { state: 'resolved', resolved_at: this.now(), resolution_note: reason });
      return ['Warning withdrawn'];
    }
    return [];
  }

  /* ---------------------------------------------------------------- suspensions */

  async previewSuspension(sellerId: string): Promise<SuspensionImpact> {
    await this.core.seller(sellerId);
    const unavailable: string[] = [];
    const currency = this.ctx.config.market.currency;
    const offers = await this.core.optional('offers', 'offers', unavailable, async (o) => (await o.listOffersAdmin({ sellerId, status: ['active'] }, { page: 1, limit: 1 })).total ?? 0);
    const orders = await this.core.optional('orders', 'orders', unavailable, async (o) => (await o.countOrdersForSellers([sellerId]))[sellerId]);
    const returns = await this.core.optional('returns', 'returns', unavailable, (r) => r.sellerQueueCounts(sellerId));
    const range = { from: isoDate(addDays(this.now(), -365)), to: this.core.today() };
    const cases = await this.core.optional('support', 'cases', unavailable, (s) => s.sellerCaseStats(sellerId, range));
    const balances = await this.core.optional('finance', 'balances', unavailable, (f) => f.getSellerBalances(sellerId));
    const openOrders = orders?.open ?? 0;
    const openReturns = returns ? returns.tabs.requests + returns.tabs.toInspect : 0;
    return {
      offersRemoved: offers ?? 0,
      openOrders,
      openOrdersWithinDeadline: Math.max(0, openOrders - (orders?.overdueDispatch ?? 0)),
      unshippedValue: { amount: 0, currency },
      openReturns,
      openCases: cases?.open ?? 0,
      balances: balances ? { available: balances.available, pending: balances.pending } : null,
      effects: [
        { area: 'Offers', effect: `${offers ?? 'All'} active offers are removed from sale` },
        { area: 'Open orders', effect: 'The seller keeps fulfilling them, or unshipped orders are cancelled and refunded, as you choose' },
        { area: 'Returns and cases', effect: 'Stay open and must still be handled' },
        { area: 'Payouts', effect: 'Finance moves available and pending balances to Held until the review date' },
        { area: 'Storefront', effect: 'Shows that the store is not selling right now' },
      ],
      unavailable,
    };
  }

  async suspendSeller(sellerId: string, input: SuspensionInput, by: By) {
    const seller = await this.core.seller(sellerId);
    if (!sellerAccountStatusMachine.can(seller.status as never, 'suspend' as never)) throw new AppError('ILLEGAL_TRANSITION', `A ${seller.status.replace(/_/g, ' ')} seller cannot be suspended`, { from: seller.status, event: 'suspend' });
    if (input.secondReviewerId === by.actor.id) throw new AppError('SAME_REVIEWER_NOT_ALLOWED', 'The second reviewer must be someone else');
    const issues: { path: string; message: string }[] = [];
    if (!input.reason?.trim()) issues.push({ path: 'reason', message: 'State the facts and what the seller can do' });
    if (input.reviewDate < this.core.today()) issues.push({ path: 'reviewDate', message: 'The review date cannot be in the past' });
    if (issues.length) throw invalid(issues);
    if (await this.repo.findOne('suspensions', { seller_id: sellerId, state: ['pending_approval', 'active'] })) {
      throw new AppError('ILLEGAL_TRANSITION', 'A suspension is already pending or active for this seller', { from: seller.status, event: 'suspend' });
    }
    const check = await this.ctx.use('access').check(this.core.principalOf(by), 'sellers.sellers.suspend');
    if (check.decision === 'denied') throw new AppError('FORBIDDEN', check.reason, { action: 'sellers.sellers.suspend' });
    const impact = await this.previewSuspension(sellerId);
    const row = await this.newSuspension(seller, input, by);
    const req = await this.ctx.use('access').requestApproval({
      action: 'sellers.sellers.suspend',
      target: { type: 'suspension', id: row.id, ref: row.ref, label: seller.store_name, sellerId, screen: 'admin/seller' },
      summary: `Suspend all new sales of ${seller.store_name}`,
      details: { reasonCode: input.reasonCode, reviewDate: input.reviewDate, openOrders: input.openOrders, impact },
      reason: input.reason,
      requestedBy: this.core.principalOf(by),
      nominatedReviewerId: input.secondReviewerId,
    });
    await this.repo.update('suspensions', row.id, { approval_request_id: req.id });
    await this.core.timeline(this.repo, sellerId, { kind: 'suspension_requested', title: 'Suspension proposed, waiting for the second reviewer', detail: input.reason, visibility: 'staff', actor: by.actor });
    await this.core.audit(
      {
        action: 'sellers.suspension.request',
        actionLabel: 'Requested a seller suspension',
        category: 'seller_enforcement',
        target: { type: 'seller', id: sellerId, ref: seller.ref, label: seller.store_name, sellerId, screen: 'admin/seller' },
        reason: input.reason,
        after: { suspensionId: row.id, state: 'pending_approval', reasonCode: input.reasonCode, reviewDate: input.reviewDate, openOrders: input.openOrders },
        approvalRequestId: req.id,
      },
      by,
    );
    const approval = await this.ctx.use('access').approvalInfo(req.id);
    return { suspensionId: row.id, state: 'pending_approval' as const, approval, impact };
  }

  private async newSuspension(seller: SellerRec, input: SuspensionInput, by: By): Promise<SuspensionRec> {
    return this.repo.insert('suspensions', {
      id: newId(),
      ref: await this.ctx.refs.next('SU', { digits: 4 }),
      seller_id: seller.id,
      state: 'pending_approval',
      reason_code: input.reasonCode,
      reason: input.reason.trim(),
      review_date: input.reviewDate,
      open_orders: input.openOrders,
      requested_by: map.actorText(by.actor),
      second_reviewer_id: isUuid(input.secondReviewerId) ? input.secondReviewerId : NIL,
      approval_request_id: null,
      trust_report_id: input.trustReportId ?? null,
      trust_enforcement_id: input.trustEnforcementId ?? null,
      appeal_route: (await this.appealRoute(null)) as never,
      started_at: null,
      ended_at: null,
      end_reason: null,
    });
  }

  /** Second reviewer approved: the suspension takes effect */
  async activateSuspension(id: string, by: By, approvalRequestId: string) {
    const now = this.now();
    const route = await this.appealRoute(null, now);
    const res = await this.repo.transaction(async (tx) => {
      const s = await tx.get('suspensions', id, { forUpdate: true });
      if (!s || s.state !== 'pending_approval') return undefined;
      const seller = await this.core.seller(s.seller_id, { repo: tx, forUpdate: true });
      if (!sellerAccountStatusMachine.can(seller.status as never, 'suspend' as never)) {
        await tx.update('suspensions', id, { state: 'cancelled', end_reason: `Seller is ${seller.status}` });
        return undefined;
      }
      const after = await tx.update('suspensions', id, { state: this.core.step(suspensionMachine, s.state, 'approve'), started_at: now, appeal_route: route as never });
      await tx.update('sellers', seller.id, { status: this.core.step(sellerAccountStatusMachine, seller.status, 'suspend'), status_since: now, updated_at: now });
      await this.core.timeline(tx, seller.id, { kind: 'suspended', title: 'All new sales suspended', detail: s.reason, actor: by.actor });
      return { after, seller, route };
    });
    if (!res) return;
    const { after, seller } = res;
    this.core.publish(
      'sellers.seller.suspended',
      {
        sellerId: seller.id,
        suspensionId: after.id,
        reasonCode: after.reason_code,
        reason: after.reason,
        reviewDate: after.review_date,
        openOrders: after.open_orders as 'seller_keeps_fulfilling' | 'cancel_unshipped_and_refund',
        appealDeadline: route.deadline,
        trustReportId: after.trust_report_id,
        trustEnforcementId: after.trust_enforcement_id,
      },
      by,
    );
    await this.core.audit(
      {
        action: 'sellers.suspension.activate',
        actionLabel: 'Suspended a seller',
        category: 'seller_enforcement',
        target: { type: 'seller', id: seller.id, ref: seller.ref, label: seller.store_name, sellerId: seller.id, screen: 'admin/seller' },
        reason: after.reason,
        before: { status: seller.status },
        after: { status: 'suspended', suspensionId: after.id, reviewDate: after.review_date },
        approvalRequestId,
        visibleToSeller: true,
      },
      by,
    );
  }

  async reinstateSeller(sellerId: string, body: { reason: string; keepRestrictionIds?: string[] | null }, by: By) {
    if (!body.reason?.trim()) throw invalid([{ path: 'reason', message: 'Say why the suspension ends' }]);
    const seller = await this.core.seller(sellerId);
    if (seller.status !== 'suspended') throw new AppError('ILLEGAL_TRANSITION', 'The seller is not suspended', { from: seller.status, event: 'reinstate' });
    const active = await this.activeRestrictions(sellerId);
    const keep = body.keepRestrictionIds ?? active.map((r) => r.id);
    const unknown = keep.filter((k) => !active.some((r) => r.id === k));
    if (unknown.length) throw invalid(unknown.map((k) => ({ path: 'keepRestrictionIds', message: `${k} is not an active restriction of this seller` })));
    for (const r of active.filter((x) => !keep.includes(x.id))) await this.endRestriction(r.id, 'lift', `Lifted at reinstatement: ${body.reason.trim()}`, by);
    const res = await this.repo.transaction(async (tx) => {
      const s = await this.core.seller(sellerId, { repo: tx, forUpdate: true });
      const susp = await tx.findOne('suspensions', { seller_id: sellerId, state: 'active' }, { forUpdate: true });
      const now = this.now();
      if (susp) await tx.update('suspensions', susp.id, { state: this.core.step(suspensionMachine, susp.state, 'end'), ended_at: now, end_reason: body.reason.trim() });
      const remaining = (await this.activeRestrictions(sellerId, tx)).map((r) => r.id);
      const to = this.core.step(sellerAccountStatusMachine, s.status, remaining.length ? 'reinstateWithRestrictions' : 'reinstate');
      const after = await tx.update('sellers', sellerId, { status: to, status_since: now, updated_at: now });
      await this.core.timeline(tx, sellerId, { kind: 'reinstated', title: remaining.length ? 'Suspension ended; restrictions remain' : 'Suspension ended', detail: body.reason.trim(), actor: by.actor });
      return { after, susp, remaining, to };
    });
    this.core.publish(
      'sellers.seller.reinstated',
      { sellerId, from: 'suspended', to: res.to as 'approved' | 'restricted', liftedRestrictionId: null, endedSuspensionId: res.susp?.id ?? null, remainingRestrictionIds: res.remaining },
      by,
    );
    await this.core.audit(
      {
        action: 'sellers.seller.reinstate',
        actionLabel: 'Reinstated a seller',
        category: 'seller_enforcement',
        target: { type: 'seller', id: sellerId, ref: seller.ref, label: seller.store_name, sellerId, screen: 'admin/seller' },
        reason: body.reason,
        before: { status: 'suspended' },
        after: { status: res.to, remainingRestrictionIds: res.remaining },
        visibleToSeller: true,
      },
      by,
    );
    return res.after;
  }

  /** Open suspensions end when the account closes */
  async cancelOpenSuspensions(tx: SellersRepository, sellerId: string, reason: string) {
    for (const s of await tx.find('suspensions', { seller_id: sellerId, state: ['pending_approval', 'active'] })) {
      await tx.update('suspensions', s.id, s.state === 'active' ? { state: 'ended', ended_at: this.now(), end_reason: reason } : { state: 'cancelled', end_reason: reason });
    }
  }

  /* ---------------------------------------------------------------- warnings */

  async issueWarning(sellerId: string, body: { kind: SellerWarning['kind']; title: string; detail: string }, by: By, o: { ref?: string; trustEnforcementId?: string | null } = {}): Promise<SellerWarning> {
    const seller = await this.core.seller(sellerId);
    if (!SELLING.includes(seller.status) && seller.status !== 'closed') throw new AppError('ILLEGAL_TRANSITION', 'Warnings are for approved sellers', { from: seller.status, event: 'warn' });
    const issues: { path: string; message: string }[] = [];
    if (!body.title?.trim()) issues.push({ path: 'title', message: 'Give the warning a title' });
    if (!body.detail?.trim()) issues.push({ path: 'detail', message: 'Explain the warning' });
    if (issues.length) throw invalid(issues);
    const row = await this.repo.insert('warnings', {
      id: newId(),
      seller_id: sellerId,
      kind: body.kind,
      title: body.title.trim(),
      detail: body.detail.trim(),
      state: sellerWarningMachine.initial,
      issued_by: map.actorText(by.actor),
      issued_at: this.now(),
      resolved_at: null,
      resolution_note: null,
      trust_enforcement_id: o.trustEnforcementId ?? null,
    });
    await this.core.timeline(this.repo, sellerId, { kind: 'warning', title: `Warning: ${row.title}`, detail: row.detail, actor: by.actor, ref: o.ref ?? row.id });
    this.core.publish('sellers.warning.issued', { sellerId, warningId: row.id, kind: row.kind, title: row.title, trustEnforcementId: row.trust_enforcement_id }, by);
    await this.core.audit(
      {
        action: 'sellers.warning.issue',
        actionLabel: 'Sent a seller warning',
        category: 'seller_enforcement',
        target: { type: 'seller', id: sellerId, ref: seller.ref, label: seller.store_name, sellerId, screen: 'admin/seller' },
        after: { warningId: row.id, kind: row.kind, title: row.title },
        visibleToSeller: true,
      },
      by,
    );
    return map.warning(row);
  }

  async resolveWarning(id: string, note: string, by: By): Promise<SellerWarning> {
    if (!note?.trim()) throw invalid([{ path: 'note', message: 'Add a resolution note' }]);
    const w = isUuid(id) ? await this.repo.get('warnings', id) : undefined;
    if (!w) throw notFound('Warning');
    const after = await this.repo.update('warnings', id, { state: this.core.step(sellerWarningMachine, w.state, 'resolve'), resolved_at: this.now(), resolution_note: note.trim() });
    const seller = await this.core.seller(w.seller_id);
    await this.core.timeline(this.repo, seller.id, { kind: 'warning_resolved', title: `Warning resolved: ${w.title}`, detail: note.trim(), actor: by.actor });
    this.core.publish('sellers.warning.resolved', { sellerId: seller.id, warningId: w.id, note: note.trim(), trustEnforcementId: w.trust_enforcement_id }, by);
    await this.core.audit(
      {
        action: 'sellers.warning.resolve',
        actionLabel: 'Resolved a seller warning',
        category: 'seller_enforcement',
        target: { type: 'seller', id: seller.id, ref: seller.ref, label: seller.store_name, sellerId: seller.id, screen: 'admin/seller' },
        reason: note,
        before: { state: w.state },
        after: { state: after.state },
        visibleToSeller: true,
      },
      by,
    );
    return map.warning(after);
  }

  /* ---------------------------------------------------------------- canSell */

  async canSell(
    sellerId: string,
    check: { activity: 'new_offers' | 'new_listings' | 'product_submissions' | 'offer_reactivation' | 'sales' | 'advertising' | 'promotions'; categoryId?: string; condition?: string; offerId?: string },
  ): Promise<{ allowed: boolean; restrictionId?: string; reason?: string; appealRoute?: string }> {
    const seller = isUuid(sellerId) ? await this.repo.get('sellers', sellerId) : undefined;
    if (!seller) return { allowed: false, reason: 'Unknown seller' };
    if (seller.status === 'suspended') {
      const s = await this.repo.findOne('suspensions', { seller_id: sellerId, state: 'active' });
      return { allowed: false, reason: 'The seller account is suspended', ...(s ? { restrictionId: s.id, appealRoute: (s.appeal_route as unknown as StoredRoute).howTo } : {}) };
    }
    if (seller.status === 'closed') return { allowed: false, reason: 'The seller account is closed' };
    if (seller.status !== 'approved' && seller.status !== 'restricted') return { allowed: false, reason: 'The seller is not approved yet' };
    if (['sales', 'advertising', 'promotions'].includes(check.activity) && map.storedLaunch(seller).state !== 'passed') {
      return { allowed: false, reason: 'The launch readiness review has not passed yet' };
    }
    for (const r of await this.activeRestrictions(sellerId)) {
      if (restrictionBlocks({ affectedActivities: map.strings(r.affected_activities), scope: normalizeScope(r.scope as RestrictionScope) }, check)) {
        return { allowed: false, restrictionId: r.id, reason: r.title, appealRoute: (r.appeal_route as unknown as StoredRoute).howTo };
      }
    }
    return { allowed: true };
  }

  /* ---------------------------------------------------------------- approvals and trust */

  /** access.approval.decided for sellers' actions */
  async onApprovalDecided(e: EventPayload<'access.approval.decided'>, envelopeActor?: common.Actor) {
    if (e.module !== 'sellers') return;
    const by: By = { actor: e.decidedBy ?? envelopeActor ?? SYSTEM };
    const approved = e.outcome === 'approved';
    const t = e.target;
    if (e.actionKey === 'sellers.sellers.restrict' && t.type === 'restriction') {
      if (approved) await this.activateRestriction(t.id, by, { approvalRequestId: e.requestId });
      else {
        const r = isUuid(t.id) ? await this.repo.get('restrictions', t.id) : undefined;
        if (r?.state === 'pending_approval') {
          await this.repo.update('restrictions', r.id, { state: this.core.step(restrictionMachine, r.state, 'decline') });
          await this.core.timeline(this.repo, r.seller_id, { kind: 'restriction_declined', title: `Proposed restriction not approved: ${r.title}`, detail: e.reason ?? null, visibility: 'staff', actor: by.actor, ref: r.ref });
        }
      }
      return;
    }
    if (e.actionKey === 'sellers.sellers.restrict' && t.type === 'restriction_change') {
      const kept = await this.core.decidePendingChange(e.requestId, approved);
      if (!approved || kept === null) return;
      const req = kept ? null : await this.ctx.use('access').getApproval(e.requestId);
      const d = ((kept ? kept.payload : req?.details) ?? {}) as { patch?: Parameters<EnforcementPart['applyRestrictionChange']>[1]; changeReason?: string };
      if (d.patch) await this.applyRestrictionChange(t.id, d.patch, d.changeReason ?? kept?.reason ?? req?.reason ?? 'Approved change', by, e.requestId);
      return;
    }
    if (e.actionKey === 'sellers.sellers.suspend' && t.type === 'suspension') {
      if (approved) await this.activateSuspension(t.id, by, e.requestId);
      else {
        const s = isUuid(t.id) ? await this.repo.get('suspensions', t.id) : undefined;
        if (s?.state === 'pending_approval') {
          await this.repo.update('suspensions', s.id, { state: this.core.step(suspensionMachine, s.state, 'decline'), end_reason: e.reason ?? `Approval ${e.outcome}` });
          await this.core.timeline(this.repo, s.seller_id, { kind: 'suspension_declined', title: 'Proposed suspension not approved', detail: e.reason ?? null, visibility: 'staff', actor: by.actor });
        }
      }
      return;
    }
    if (e.actionKey === 'sellers.sellers.close' && t.type === 'seller') {
      const kept = await this.core.decidePendingChange(e.requestId, approved);
      if (!approved || kept === null) return;
      const req = kept ? null : await this.ctx.use('access').getApproval(e.requestId);
      const d = ((kept ? kept.payload : req?.details) ?? {}) as { reason?: string; reasonCode?: string };
      await this.parts.accounts.closeNow(t.id, { reason: d.reason ?? kept?.reason ?? req?.reason ?? 'Closed', reasonCode: d.reasonCode ?? 'other' }, by, e.requestId);
      return;
    }
    if (e.actionKey === 'sellers.performance.targets') {
      const kept = await this.core.decidePendingChange(e.requestId, approved);
      if (!approved || kept === null) return;
      const req = kept ? null : await this.ctx.use('access').getApproval(e.requestId);
      const d = ((kept ? kept.payload : req?.details) ?? {}) as { targets?: never[]; reason?: string; setBy?: common.Actor };
      if (d.targets) await this.parts.performance.applyTargets(d.targets, d.reason ?? kept?.reason ?? req?.reason ?? '', { actor: d.setBy ?? by.actor }, e.requestId);
    }
  }

  /** trust.enforcement.recorded: restrict, warn or start a suspension that still needs its second reviewer */
  async onEnforcementRecorded(e: EventPayload<'trust.enforcement.recorded'>, envelope?: Pick<EventEnvelope, 'actor'>) {
    if (!['restrict_seller', 'warn_seller', 'suspend_seller'].includes(e.action) || e.alreadyApplied) return;
    const sellerIds = (e.targets as { type?: string; id?: string }[]).filter((t) => t?.type === 'seller' && isUuid(t.id)).map((t) => t.id!);
    const p = (e.params ?? {}) as Record<string, any>;
    const actor: common.Actor = envelope?.actor && envelope.actor.kind === 'staff' ? envelope.actor : { ...TRUST_TEAM };
    const by: By = { actor };
    for (const sellerId of sellerIds) {
      const seller = await this.repo.get('sellers', sellerId);
      if (!seller) {
        this.ctx.log.info({ sellerId, enforcementId: e.enforcementId }, 'sellers: trust enforcement for an unknown seller (ignored)');
        continue;
      }
      if (e.action === 'restrict_seller') {
        if (await this.repo.findOne('restrictions', { trust_enforcement_id: e.enforcementId, seller_id: sellerId })) continue;
        const input: RestrictionInput = {
          title: p.title ?? 'Selling restricted after a Trust and Risk review',
          reasonCode: p.reasonCode ?? 'policy_violation',
          reason: p.reason ?? e.reason,
          ruleRef: p.ruleRef ?? null,
          affectedActivities: Array.isArray(p.affectedActivities) && p.affectedActivities.length ? p.affectedActivities : ['new_offers', 'new_listings'],
          scope: p.scope ?? null,
          stillWorks: p.stillWorks ?? null,
          toResolve: p.toResolve ?? 'Contact your Seller Manager or appeal with documents that answer the findings.',
          appealDays: p.appealDays ?? null,
          reviewDate: typeof p.reviewDate === 'string' && p.reviewDate >= this.core.today() ? p.reviewDate : isoDate(addDays(this.now(), 30)),
          endsAt: p.endsAt ?? null,
          trustReportId: e.reportId,
          trustEnforcementId: e.enforcementId,
        };
        try {
          await this.createRestriction(sellerId, input, by, { recommendedBy: TRUST_TEAM, skipAuthority: actor.kind !== 'staff' || !actor.id });
        } catch (err) {
          this.ctx.log.warn({ err, sellerId, enforcementId: e.enforcementId }, 'sellers: could not apply a trust restriction');
        }
      } else if (e.action === 'warn_seller') {
        if (await this.repo.findOne('account_events', { seller_id: sellerId, kind: 'warning', ref: e.enforcementId })) continue;
        await this.issueWarning(sellerId, { kind: p.kind ?? 'policy', title: p.title ?? 'Policy warning after a Trust and Risk review', detail: p.detail ?? e.reason }, by, { ref: e.enforcementId, trustEnforcementId: e.enforcementId });
      } else {
        if (await this.repo.findOne('account_events', { seller_id: sellerId, kind: 'suspension_requested', ref: e.enforcementId })) continue;
        if (!sellerAccountStatusMachine.can(seller.status as never, 'suspend' as never)) continue;
        const row = await this.newSuspension(
          seller,
          {
            reasonCode: p.reasonCode ?? 'policy_violation',
            reason: p.reason ?? e.reason,
            reviewDate: typeof p.reviewDate === 'string' ? p.reviewDate : isoDate(addDays(this.now(), 30)),
            openOrders: p.openOrders ?? 'seller_keeps_fulfilling',
            secondReviewerId: p.secondReviewerId ?? NIL,
            trustReportId: e.reportId,
            trustEnforcementId: e.enforcementId,
          },
          by,
        );
        try {
          const req = await this.ctx.use('access').requestApproval({
            action: 'sellers.sellers.suspend',
            target: { type: 'suspension', id: row.id, ref: row.ref, label: seller.store_name, sellerId, screen: 'admin/seller' },
            summary: `Suspend all new sales of ${seller.store_name} (Trust and Risk)`,
            details: { reasonCode: row.reason_code, reviewDate: row.review_date, enforcementId: e.enforcementId },
            reason: row.reason,
            requestedBy: this.core.principalOf(by),
            nominatedReviewerId: isUuid(p.secondReviewerId) && p.secondReviewerId !== actor.id ? p.secondReviewerId : null,
          });
          await this.repo.update('suspensions', row.id, { approval_request_id: req.id });
        } catch (err) {
          this.ctx.log.warn({ err, sellerId }, 'sellers: suspension from trust is waiting without an approval request');
        }
        await this.core.timeline(this.repo, sellerId, { kind: 'suspension_requested', title: 'Suspension proposed by Trust and Risk, waiting for the second reviewer', detail: row.reason, visibility: 'staff', actor, ref: e.enforcementId });
      }
    }
  }

  /**
   * trust.enforcement.reversed (decision D9): undo exactly what the enforcement created. restrict_seller
   * lifts the active restriction (or cancels one still pending second review); suspend_seller reinstates
   * (other restrictions stay) or cancels a pending suspension; warn_seller resolves the open warning. No
   * approval: the reversal was approved in trust. Nothing found is a no-op; other actions are ignored.
   * Idempotent: every step checks the record's state, and the envelope id is claimed once done.
   */
  async onEnforcementReversed(e: EventPayload<'trust.enforcement.reversed'>, eventId?: string) {
    if (!['restrict_seller', 'warn_seller', 'suspend_seller'].includes(e.action)) return;
    const key = `trust-enforcement-reversed:${eventId ?? e.enforcementId}`;
    if (await this.ctx.mongo.seen(key)) return;
    const by: By = { actor: e.reversedBy?.kind === 'staff' ? e.reversedBy : { ...TRUST_TEAM } };
    const reason = `Reversed by Trust and Risk (${e.ref}): ${e.reason}`;
    const sellerIds = new Set((e.targets ?? []).filter((t) => t?.type === 'seller' && isUuid(t.id)).map((t) => t.id));
    const mine = <T extends { seller_id: string }>(rows: T[]) => rows.filter((r) => !sellerIds.size || sellerIds.has(r.seller_id));
    const byRef = async <K extends 'restrictions' | 'suspensions' | 'warnings'>(table: K) =>
      // records created before pass 3 have no trust_enforcement_id: trust's appliedRef names them
      e.appliedRef && isUuid(e.appliedRef) ? await this.repo.get(table, e.appliedRef) : undefined;

    if (e.action === 'restrict_seller') {
      const rows = mine(await this.repo.find('restrictions', { trust_enforcement_id: e.enforcementId, state: ['active', 'pending_approval'] }));
      const legacy = await byRef('restrictions');
      if (legacy && ['active', 'pending_approval'].includes(legacy.state) && !rows.some((r) => r.id === legacy.id) && mine([legacy]).length) rows.push(legacy);
      for (const r of rows) {
        if (r.state === 'active') await this.endRestriction(r.id, 'lift', reason, by);
        else {
          await this.repo.update('restrictions', r.id, { state: this.core.step(restrictionMachine, r.state, 'decline'), lift_reason: reason });
          await this.core.timeline(this.repo, r.seller_id, { kind: 'restriction_declined', title: `Proposed restriction withdrawn: ${r.title}`, detail: reason, visibility: 'staff', actor: by.actor, ref: r.ref });
        }
      }
    } else if (e.action === 'suspend_seller') {
      const rows = mine(await this.repo.find('suspensions', { trust_enforcement_id: e.enforcementId, state: ['active', 'pending_approval'] }));
      const legacy = await byRef('suspensions');
      if (legacy && ['active', 'pending_approval'].includes(legacy.state) && !rows.some((r) => r.id === legacy.id) && mine([legacy]).length) rows.push(legacy);
      for (const s of rows) {
        if (s.state === 'active') {
          const seller = await this.repo.get('sellers', s.seller_id);
          // reinstate keeping every other restriction (keepRestrictionIds absent = keep all)
          if (seller?.status === 'suspended') await this.reinstateSeller(s.seller_id, { reason }, by);
          else await this.repo.update('suspensions', s.id, { state: this.core.step(suspensionMachine, s.state, 'end'), ended_at: this.now(), end_reason: reason });
        } else {
          await this.repo.update('suspensions', s.id, { state: this.core.step(suspensionMachine, s.state, 'decline'), end_reason: reason });
          await this.core.timeline(this.repo, s.seller_id, { kind: 'suspension_declined', title: 'Proposed suspension withdrawn', detail: reason, visibility: 'staff', actor: by.actor });
        }
      }
    } else {
      const rows = mine(await this.repo.find('warnings', { trust_enforcement_id: e.enforcementId, state: 'open' }));
      const legacy = await byRef('warnings');
      if (legacy?.state === 'open' && !rows.some((r) => r.id === legacy.id) && mine([legacy]).length) rows.push(legacy);
      for (const w of rows) await this.resolveWarning(w.id, reason, by);
    }
    await this.ctx.mongo.claim(key);
  }

  /* ---------------------------------------------------------------- jobs */

  /** sellers.restriction-reviews: expire past endsAt; work items at review dates */
  async restrictionReviews() {
    const now = this.now();
    const today = this.core.today(now);
    for (const r of await this.repo.find('restrictions', { state: 'active', ends_at: { op: '<=', value: now } }, { limit: 200 })) {
      await this.endRestriction(r.id, 'expire', 'The restriction reached its end date', { actor: SYSTEM });
    }
    for (const r of await this.repo.find('restrictions', { state: 'active', review_date: { op: '<=', value: today } }, { limit: 500 })) {
      const seller = await this.repo.get('sellers', r.seller_id);
      await this.core.raise({
        queueKey: 'sellers.restrictions',
        kind: 'restriction_review',
        title: `Review restriction ${r.ref}: ${r.title}`,
        summary: `${seller?.store_name ?? ''}: review date ${r.review_date}`,
        subject: { type: 'restriction', id: r.id, ref: r.ref, label: r.title },
        sellerId: r.seller_id,
        sellerName: seller?.store_name ?? null,
        dedupeKey: `restriction_review:${r.id}:${r.review_date}`,
      });
    }
    for (const s of await this.repo.find('suspensions', { state: 'active', review_date: { op: '<=', value: today } }, { limit: 500 })) {
      const seller = await this.repo.get('sellers', s.seller_id);
      await this.core.raise({
        // workqueues has no suspension kind: a suspension's review date is a restriction review
        queueKey: 'sellers.restrictions',
        kind: 'restriction_review',
        title: `Review suspension of ${seller?.store_name ?? s.seller_id}`,
        subject: { type: 'seller', id: s.seller_id, ref: seller?.ref ?? null, label: seller?.store_name ?? null },
        sellerId: s.seller_id,
        sellerName: seller?.store_name ?? null,
        priority: 'high',
        dedupeKey: `suspension_review:${s.id}:${s.review_date}`,
      });
    }
  }

  /** sellers.appeal-deadlines: work items for appeals near or past decideBy */
  async appealDeadlines() {
    const soon = new Date(this.now().getTime() + 86_400_000);
    for (const a of await this.repo.find('appeals', { state: OPEN_APPEAL, decide_by: { op: '<=', value: soon } }, { limit: 500 })) {
      const seller = await this.repo.get('sellers', a.seller_id);
      const overdue = a.decide_by.getTime() < this.now().getTime();
      await this.core.raise({
        queueKey: 'sellers.appeals',
        kind: 'appeal_due',
        title: `Appeal ${a.ref} ${overdue ? 'is past its decision target' : 'is due within a day'}`,
        subject: { type: 'appeal', id: a.id, ref: a.ref, label: seller?.store_name ?? null },
        sellerId: a.seller_id,
        sellerName: seller?.store_name ?? null,
        dueAt: a.decide_by.toISOString(),
        priority: overdue ? 'high' : 'normal',
        // the item workqueues opened on sellers.appeal.submitted: refreshed, and high priority once overdue
        dedupeKey: `appeal:${a.id}`,
      });
    }
  }

  /* ---------------------------------------------------------------- staff views */

  async restrictionsFor(sellerId: string, states?: string[]) {
    const rows = await this.repo.find('restrictions', { seller_id: sellerId, ...(states ? { state: states } : {}) }, { orderBy: [['review_date', 'desc']] });
    return this.restrictionViews(rows, { staff: true });
  }

  async appealsFor(sellerId: string, states?: string[]) {
    const rows = await this.repo.find('appeals', { seller_id: sellerId, ...(states ? { state: states } : {}) }, { orderBy: [['submitted_at', 'desc']] });
    return this.appealViews(rows);
  }
}


