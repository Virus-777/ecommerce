/**
 * Recommendations and enforcement: Trust drafts and routes recommendations; the owner team accepts (recording an
 * Enforcement that the owning module executes) or declines; owning modules' events confirm execution; Trust
 * reverses enforcement (with authority from access) and the execution-check job flags what never got confirmed.
 */
import type { Principal } from '../../../kernel/auth/index.js';
import { AppError } from '../../../kernel/errors/index.js';
import type { EventPayload } from '../../../kernel/events/index.js';
import { isUuid, newId } from '../../../kernel/lib/ids.js';
import type { PageRequest } from '../../../kernel/lib/pagination.js';
import type * as common from '../../../spec/common.js';
import type { Enforcement, MyEnforcement, Recommendation, RecommendationInput, TrustSubject } from '../../../spec/trust.js';
import { enforcementExecutionMachine, recommendationMachine } from '../domain/state-machines.js';
import { ACTIONS, amountOf, humanize, isAction, isTeam, normalizeParams, OWNER_TEAMS, SUBJECT_TYPES, TEAM_QUEUES, TEAM_ROLES, type Action, type OwnerTeam } from '../domain/rules.js';
import type { EnforcementRec, RecommendationRec, TargetRec } from '../ports.js';
import type { TrustRepository } from '../repository.js';
import { actorText, illegal, invalid, invalidField, notFound, type By, type Core } from './core.js';
import { offsetOf, pageFrom } from './reports.js';
import type { Views } from './views.js';

const text = (s: unknown) => (typeof s === 'string' ? s.trim() : '');
type Page<T> = common.Page<T>;
type ExecState = 'pending' | 'applied' | 'failed' | 'reversed';
/** States trust.recommendation.decided reports */
type Decided = 'completed' | 'declined' | 'withdrawn';
/** Approval request targets trust opens (access.approval.decided is filtered on them) */
const REC_TARGET = 'trust_recommendation';
const ENF_TARGET = 'trust_enforcement';
const REVERSE_ACTION = 'trust.enforcements.reverse';

export class Actions {
  constructor(
    private readonly core: Core,
    private readonly views: Views,
  ) {}

  private async recWithStaff(r: RecommendationRec): Promise<Recommendation> {
    return this.views.recommendation(r, await this.core.staffRefs([r.owner_staff_id, r.decided_by, r.created_by, r.routed_by]));
  }

  private async loadRec(id: string): Promise<RecommendationRec> {
    const r = isUuid(id) ? await this.core.repo.get('recommendations', id) : undefined;
    if (!r) throw notFound('Recommendation');
    return r;
  }

  private principalOf(by: By): Principal {
    return by.principal ?? ({ kind: 'staff', accountId: by.actor.id ?? null } as Principal);
  }

  private async can(by: By, permission: string): Promise<boolean> {
    if (by.can) return by.can(permission);
    return this.core.ctx
      .use('access')
      .hasPermission(this.principalOf(by), permission)
      .catch(() => false);
  }

  /* ================================================================ recommendations */

  async add(reportId: string, body: RecommendationInput, by: By): Promise<Recommendation> {
    const issues: { path: string; message: string }[] = [];
    if (!isAction(body.action)) issues.push({ path: 'action', message: 'Choose an enforcement action' });
    if (body.ownerTeam !== undefined && body.ownerTeam !== null && !isTeam(body.ownerTeam)) issues.push({ path: 'ownerTeam', message: `One of ${OWNER_TEAMS.join(', ')}` });
    if (!text(body.label)) issues.push({ path: 'label', message: 'Name the action, e.g. Suspend the offer for BRL-S2' });
    if (!text(body.rationale)) issues.push({ path: 'rationale', message: 'Why do you recommend it?' });
    if (!body.targets?.length) issues.push({ path: 'targets', message: 'Name what the action applies to' });
    (body.targets ?? []).forEach((t, i) => {
      if (!(SUBJECT_TYPES as readonly string[]).includes(t.type)) issues.push({ path: `targets[${i}].type`, message: `One of ${SUBJECT_TYPES.join(', ')}` });
      if (!isUuid(t.id)) issues.push({ path: `targets[${i}].id`, message: 'A record id' });
    });
    if (body.ownerStaffId && !isUuid(body.ownerStaffId)) issues.push({ path: 'ownerStaffId', message: 'A staff member' });
    let params: Record<string, unknown> = {};
    if (isAction(body.action)) {
      const def = ACTIONS[body.action];
      if (def.targets.length && (body.targets ?? []).some((t) => !def.targets.includes(t.type))) issues.push({ path: 'targets', message: `${humanize(body.action)} applies to ${def.targets.join(' or ')} records` });
      if (body.action === 'other' && (body.targets ?? []).some((t) => t.type === 'offer')) issues.push({ path: 'targets', message: 'Use suspend_offer for offers (offers acts on every enforcement that names an offer)' });
      if (body.params !== undefined && body.params !== null && (typeof body.params !== 'object' || Array.isArray(body.params))) issues.push({ path: 'params', message: 'An object' });
      const n = normalizeParams(body.action, body.params, { now: this.core.now(), rationale: text(body.rationale), appealWindowDays: await this.core.setting('appealWindowDays', 14) });
      issues.push(...n.issues);
      params = (body.params && typeof body.params === 'object' ? body.params : {}) as Record<string, unknown>;
    }
    if (issues.length) throw invalid(issues);
    const action = body.action as Action;
    // default: the action's owner team (suspend_offer and suspend_product belong to catalog, decision D8)
    const team = (body.ownerTeam ?? ACTIONS[action].team) as OwnerTeam;
    const role = text(body.ownerRole) || (ACTIONS[action].team === team ? ACTIONS[action].role : TEAM_ROLES[team]);
    const row = await this.core.write(reportId, by, async (tx, agg) => {
      if (!this.core.isActive(agg.report.status)) throw invalidField('reportId', 'Reopen the report before recommending an action');
      const row = await tx.insert('recommendations', {
        id: newId(),
        report_id: reportId,
        action,
        label: body.label.trim(),
        owner_team: team,
        owner_role: role,
        owner_staff_id: body.ownerStaffId ?? null,
        targets: body.targets.map((t) => ({ type: t.type, id: t.id, ref: t.ref ?? null, label: t.label || humanize(t.type) })),
        params,
        rationale: body.rationale.trim(),
        state: recommendationMachine.initial,
        created_by: by.actor.id ?? null,
        routed_at: null,
        routed_by: null,
        decided_at: null,
        decided_by: null,
        decision_reason: null,
        enforcement_id: null,
        approval_request_id: null,
      });
      await this.core.timeline(tx, reportId, [{ kind: 'recommendation_drafted', label: `Recommendation drafted: ${row.label}`, text: row.rationale, actor: by.actor, meta: { recommendationId: row.id } }]);
      await tx.update('reports', reportId, { updated_at: this.core.now() });
      return row;
    });
    const report = (await this.core.repo.get('reports', reportId))!;
    await this.core.audit({ action: 'trust.recommendation.add', actionLabel: 'Drafted an enforcement recommendation', target: this.recTarget(row, report.ref), after: { action, ownerTeam: team, ownerRole: role, targets: row.targets, params } }, by);
    return this.recWithStaff(row);
  }

  private recTarget(r: RecommendationRec, reportRef: string) {
    return { type: 'trust_recommendation', id: r.id, ref: reportRef, label: r.label, screen: 'admin/trust' };
  }

  async route(id: string, by: By): Promise<Recommendation> {
    const pre = await this.loadRec(id);
    const { before, after, ref } = await this.core.write(pre.report_id, by, async (tx, agg, batch) => {
      const cur = (await tx.get('recommendations', id, { forUpdate: true }))!;
      if (!this.core.isActive(agg.report.status)) throw illegal('Recommendation', cur.state, 'route', 'Reopen the report before routing');
      const state = recommendationMachine.next(cur.state as 'pending', 'route');
      const after = await tx.update('recommendations', id, { state, routed_at: this.core.now(), routed_by: by.actor.id ?? null });
      await this.core.timeline(tx, cur.report_id, [{ kind: 'recommendation_routed', label: `Sent to ${humanize(cur.owner_team)}: ${cur.label}`, actor: by.actor, meta: { recommendationId: id } }]);
      batch.push('trust.recommendation.routed', { recommendationId: id, reportId: cur.report_id, action: (isAction(cur.action) ? cur.action : 'other') as Action, ownerTeam: (isTeam(cur.owner_team) ? cur.owner_team : 'support') as OwnerTeam, ownerRole: cur.owner_role, targets: cur.targets });
      return { before: cur, after, ref: agg.report.ref };
    });
    await this.core.audit({ action: 'trust.recommendation.route', actionLabel: 'Routed a recommendation to its owner team', target: this.recTarget(after, ref), before: { state: before.state }, after: { state: after.state, ownerTeam: after.owner_team } }, by);
    return this.recWithStaff(after);
  }

  async withdraw(id: string, body: { reason: string }, by: By): Promise<Recommendation> {
    if (!text(body.reason)) throw invalidField('reason', 'Why is it withdrawn?');
    const pre = await this.loadRec(id);
    const { before, after, ref } = await this.core.write(pre.report_id, by, async (tx, agg, batch) => {
      const cur = (await tx.get('recommendations', id, { forUpdate: true }))!;
      const state = recommendationMachine.next(cur.state as 'pending', 'withdraw');
      const after = await tx.update('recommendations', id, { state, decided_at: this.core.now(), decided_by: by.actor.id ?? null, decision_reason: body.reason.trim() });
      await this.core.timeline(tx, cur.report_id, [{ kind: 'recommendation_withdrawn', label: `Recommendation withdrawn: ${cur.label}`, text: body.reason.trim(), actor: by.actor, meta: { recommendationId: id } }]);
      batch.push('trust.recommendation.decided', { recommendationId: id, reportId: cur.report_id, state: state as Decided, reason: body.reason.trim() });
      return { before: cur, after, ref: agg.report.ref };
    });
    await this.core.audit({ action: 'trust.recommendation.withdraw', actionLabel: 'Withdrew a recommendation', target: this.recTarget(after, ref), reason: body.reason, before: { state: before.state }, after: { state: after.state } }, by);
    return this.recWithStaff(after);
  }

  /** Teams whose actions the caller may decide (their own permissions) */
  private async myTeams(by: By): Promise<OwnerTeam[]> {
    const cache = new Map<string, Promise<boolean>>();
    const has = (p: string) => {
      if (!cache.has(p)) cache.set(p, this.can(by, p));
      return cache.get(p)!;
    };
    const out: OwnerTeam[] = [];
    for (const team of OWNER_TEAMS) {
      const perms = [...new Set(Object.values(ACTIONS).filter((d) => d.team === team).flatMap((d) => d.permissions))];
      for (const p of perms) {
        if (await has(p)) {
          out.push(team);
          break;
        }
      }
    }
    return out;
  }

  async listForOwner(q: { ownerTeam?: string; state?: string }, page: PageRequest, by: By): Promise<Page<Recommendation>> {
    const teams = q.ownerTeam ? [q.ownerTeam] : await this.myTeams(by);
    const where = { owner_team: teams, state: q.state ?? 'sent_to_owner' };
    const [rows, total] = await Promise.all([this.core.repo.find('recommendations', where, { orderBy: [['routed_at', 'asc'], ['id', 'asc']], offset: offsetOf(page), limit: page.limit }), this.core.repo.count('recommendations', where)]);
    const staff = await this.core.staffRefs(rows.flatMap((r) => [r.owner_staff_id, r.decided_by, r.created_by, r.routed_by]));
    return pageFrom(
      rows.map((r) => this.views.recommendation(r, staff)),
      total,
      page,
    );
  }

  /**
   * The owner team accepts (records an Enforcement the owning module executes) or declines. Separate duties: the
   * person who drafted or routed it cannot decide it; the decider needs the owner's own permission for the action
   * and, for actions with an approval limit, authority from access (above it: APPROVAL_REQUIRED with the request).
   */
  async decide(id: string, body: { accept: boolean; reason: string; params?: unknown; externalRef?: string | null }, by: By): Promise<{ recommendation: Recommendation; enforcement?: Enforcement | null; approval?: common.ApprovalInfo | null }> {
    const rec = await this.loadRec(id);
    recommendationMachine.next(rec.state as 'sent_to_owner', body.accept ? 'accept' : 'decline');
    if (!text(body.reason)) throw invalidField('reason', body.accept ? 'Record the reason for the action' : 'Why is it declined?');
    const people = await this.core.recommendationPeople(id);
    if (by.actor.id && (by.actor.id === people.drafter || by.actor.id === people.router)) throw this.core.error('SEPARATE_DUTIES', 'You drafted or routed this recommendation; the owner team decides it');
    const action = (isAction(rec.action) ? rec.action : 'other') as Action;
    const def = ACTIONS[action];
    if (def.permissions.length) {
      let allowed = false;
      for (const p of def.permissions) if (await this.can(by, p)) allowed = true;
      if (!allowed) throw new AppError('FORBIDDEN', `Deciding ${humanize(action).toLowerCase()} needs the owner team’s permission`, { permission: def.permissions[0], ownerTeam: rec.owner_team });
    }
    const report = (await this.core.repo.get('reports', rec.report_id))!;
    if (!body.accept) return this.decline(rec, report.ref, body.reason.trim(), by);

    const now = this.core.now();
    const windowDays = await this.core.setting('appealWindowDays', 14);
    const merged = { ...(rec.params ?? {}), ...(body.params && typeof body.params === 'object' && !Array.isArray(body.params) ? (body.params as Record<string, unknown>) : {}) };
    const n = normalizeParams(action, merged, { now, rationale: body.reason.trim(), appealWindowDays: windowDays });
    if (n.issues.length) throw invalid(n.issues);
    const params = n.params;
    if (action === 'suspend_seller' && params.secondReviewerId && params.secondReviewerId === by.actor.id) throw invalidField('params.secondReviewerId', 'The second reviewer must be someone else');
    const externalRef = text(body.externalRef) || null;
    // no module executes it: the owner does it in its own screen first and names the record it created (decision D4)
    if (def.externalRefRequired && !externalRef)
      throw this.core.error('EXTERNAL_REF_REQUIRED', `Nobody executes ${humanize(action).toLowerCase()} automatically: do it in your own screen first, then accept with its reference (hold, case, claim or approval)`, { action });

    // authority (access): denied → FORBIDDEN; above the limit the accept is sent for approval: the recommendation
    // stays with the owner (sent_to_owner) with approval_request_id, and the call answers 200 with `approval`
    // (FORMAT.md, Approval responses). Approved: accepted by onApprovalDecided; otherwise the request id is cleared.
    let approvalNote: string | null = null;
    if (def.authority) {
      const access = this.core.ctx.use('access');
      const principal = this.principalOf(by);
      const amount = amountOf(params);
      const check = await access.check(principal, def.authority, amount ? { money: amount } : undefined);
      if (check.decision === 'denied') throw new AppError('FORBIDDEN', check.reason, { action: def.authority });
      if (check.decision === 'approval_required') {
        const authority = check.callerLimit?.authority;
        const ownerReview = def.ownerSecondReview && (authority === 'permitted' || authority === 'permitted_with_second_review');
        if (!ownerReview) {
          const req = await access.requestApproval({
            action: def.authority,
            target: { type: REC_TARGET, id, ref: report.ref, label: rec.label, screen: 'admin/trust', ...(this.sellerOf(rec.targets) ? { sellerId: this.sellerOf(rec.targets) } : {}) },
            ...(amount ? { amount } : {}),
            summary: `${rec.label} (Trust and Risk recommendation on ${report.ref})`,
            details: { recommendationId: id, reportId: rec.report_id, action, targets: rec.targets, params, externalRef },
            reason: body.reason.trim(),
            requestedBy: principal,
          });
          const pending = await this.core.write(rec.report_id, by, async (tx) => {
            const cur = (await tx.get('recommendations', id, { forUpdate: true }))!;
            recommendationMachine.next(cur.state as 'sent_to_owner', 'accept');
            const saved = await tx.update('recommendations', id, { approval_request_id: req.id });
            await this.core.timeline(tx, rec.report_id, [{ kind: 'approval_requested', label: `Approval requested to accept: ${rec.label}`, text: check.reason, actor: by.actor, meta: { recommendationId: id, approvalRequestId: req.id } }]);
            return saved;
          });
          await this.core.audit({ action: 'trust.recommendation.request_approval', actionLabel: 'Sent the accept of a Trust and Risk recommendation for approval', target: this.recTarget(pending, report.ref), reason: body.reason.trim(), after: { action, params, externalRef }, approvalRequestId: req.id }, by);
          return { recommendation: await this.recWithStaff(pending), enforcement: null, approval: await this.approvalInfo(req.id, check) };
        } else approvalNote = 'Second reviewer requested by the owning module';
      } else approvalNote = check.reason;
    }
    const out = await this.accept(rec, report.ref, { action, params, reason: body.reason.trim(), externalRef }, by, { approvalNote, approvedRequest: null });
    return out!;
  }

  /**
   * Records the enforcement for an accepted recommendation (directly, or when its approval request is approved).
   * `o.claim`: inbox key claimed with the change; null when it was already handled.
   */
  private async accept(
    rec: RecommendationRec,
    reportRef: string,
    input: { action: Action; params: Record<string, unknown>; reason: string; externalRef: string | null },
    by: By,
    o: { approvalNote: string | null; approvedRequest: string | null; claim?: string },
  ): Promise<{ recommendation: Recommendation; enforcement: Enforcement } | null> {
    const id = rec.id;
    const { action, params, externalRef } = input;
    const def = ACTIONS[action];
    const now = this.core.now();
    const windowDays = await this.core.setting('appealWindowDays', 14);
    const body = { reason: input.reason };
    const { approvalNote, approvedRequest } = o;
    const parties = await this.affectedParties(rec.targets);
    const ref = await this.core.enforcementRef();
    const done = await this.core.write(rec.report_id, by, async (tx, _agg, batch) => {
      if (o.claim && !(await tx.claim(o.claim))) return null; // already handled
      const cur = (await tx.get('recommendations', id, { forUpdate: true }))!;
      const state = recommendationMachine.next(cur.state as 'sent_to_owner', 'accept');
      const enforcementId = newId();
      const appealable = def.appeal !== null;
      const appealDeadline = appealable ? new Date(now.getTime() + windowDays * 86_400_000) : null;
      // event-confirmed actions stay pending until the owning module's event arrives, even with externalRef
      let exec: ExecState = enforcementExecutionMachine.initial as ExecState;
      if (def.confirmation === 'on_record') exec = enforcementExecutionMachine.next('pending', 'confirm') as ExecState;
      const enforcement = await tx.insert('enforcements', {
        id: enforcementId,
        ref,
        report_id: cur.report_id,
        recommendation_id: id,
        action,
        owner_team: cur.owner_team,
        targets: cur.targets,
        reason: body.reason.trim(),
        params,
        effects: def.effects,
        recorded_by: actorText(by.actor),
        recorded_at: now,
        execution_state: exec,
        applied_ref: externalRef,
        applied_at: exec === 'applied' ? now : null,
        failure: null,
        appealable,
        appeal_deadline: appealDeadline,
        reversed_at: null,
        reversal_reason: null,
        reversal_request_id: null,
      });
      const lookup: TargetRec[] = [...cur.targets.map((t) => ({ enforcement_id: enforcementId, target_type: t.type, target_id: t.id })), ...parties.map((p) => ({ enforcement_id: enforcementId, target_type: p.type, target_id: p.id }))];
      const seen = new Set<string>();
      for (const l of lookup) {
        const k = `${l.target_type}:${l.target_id}`;
        if (seen.has(k)) continue;
        seen.add(k);
        await tx.insert('enforcement_targets', l);
      }
      const recommendation = await tx.update('recommendations', id, { state, decided_at: now, decided_by: by.actor.id ?? null, decision_reason: body.reason.trim(), enforcement_id: enforcementId, params, approval_request_id: null });
      await this.core.timeline(tx, cur.report_id, [
        { kind: 'recommendation_decided', label: `${humanize(cur.owner_team)} accepted: ${cur.label}`, text: body.reason.trim(), actor: by.actor, meta: { recommendationId: id, enforcementId } },
        { kind: 'enforcement_recorded', label: `Enforcement ${ref} recorded${exec === 'applied' ? ' and applied' : ''}`, text: externalRef ? `Done in the owning module: ${externalRef}` : null, actor: by.actor, meta: { enforcementId } },
      ]);
      await tx.update('reports', cur.report_id, { updated_at: now });
      batch.push('trust.recommendation.decided', { recommendationId: id, reportId: cur.report_id, state: state as Decided, reason: body.reason.trim() });
      const recorded = {
        enforcementId,
        reportId: cur.report_id,
        action,
        ownerTeam: cur.owner_team as OwnerTeam,
        targets: cur.targets,
        reason: body.reason.trim(),
        params,
        appealDeadline: appealDeadline?.toISOString() ?? null,
        alreadyApplied: !!externalRef,
      };
      return { recommendation, enforcement, recorded };
    });
    if (!done) return null;
    const { recommendation, enforcement, recorded } = done;
    // authority already granted through an approved access request: owners that re-check the event's actor (sellers)
    // must not ask for a second approval, so the event carries Trust and Risk with the request reference
    this.core.publish('trust.enforcement.recorded', recorded, { actor: approvedRequest ? { kind: 'system', id: null, name: `Trust and Risk (approval ${approvedRequest})` } : by.actor, ...(by.requestId ? { requestId: by.requestId } : {}) });
    await this.core.audit(
      {
        action: 'trust.recommendation.accept',
        actionLabel: 'Accepted a Trust and Risk recommendation',
        category: ['restrict_seller', 'suspend_seller', 'warn_seller', 'revoke_claim'].includes(action) ? 'seller_enforcement' : ['hold_payout', 'refund_buyers', 'review_payments'].includes(action) ? 'financial' : ['suspend_product', 'suspend_offer'].includes(action) ? 'catalog' : ['restrict_customer_messaging', 'restrict_customer_account'].includes(action) ? 'customers' : 'other',
        target: this.recTarget(recommendation, reportRef),
        relatedTargets: [{ type: 'trust_enforcement', id: enforcement.id, ref: enforcement.ref, label: def.title, screen: 'admin/trust' }, ...rec.targets.map((t) => ({ type: t.type, id: t.id, ref: t.ref ?? null, label: t.label }))],
        reason: body.reason,
        before: { state: rec.state },
        after: { state: recommendation.state, enforcement: { ref: enforcement.ref, action, params, executionState: enforcement.execution_state, appliedRef: externalRef } },
        approvalNote,
        ...(approvedRequest ? { approvalRequestId: approvedRequest } : {}),
      },
      by,
    );
    return { recommendation: await this.recWithStaff(recommendation), enforcement: this.views.enforcement(enforcement, reportRef) };
  }

  private async decline(rec: RecommendationRec, reportRef: string, reason: string, by: By) {
    const after = await this.core.write(rec.report_id, by, async (tx, _agg, batch) => {
      const cur = (await tx.get('recommendations', rec.id, { forUpdate: true }))!;
      const state = recommendationMachine.next(cur.state as 'sent_to_owner', 'decline');
      const after = await tx.update('recommendations', rec.id, { state, decided_at: this.core.now(), decided_by: by.actor.id ?? null, decision_reason: reason });
      await this.core.timeline(tx, cur.report_id, [{ kind: 'recommendation_decided', label: `${humanize(cur.owner_team)} declined: ${cur.label}`, text: reason, actor: by.actor, meta: { recommendationId: rec.id } }]);
      await tx.update('reports', cur.report_id, { updated_at: this.core.now() });
      batch.push('trust.recommendation.decided', { recommendationId: rec.id, reportId: cur.report_id, state: state as Decided, reason });
      return after;
    });
    await this.core.audit({ action: 'trust.recommendation.decline', actionLabel: 'Declined a Trust and Risk recommendation', target: this.recTarget(after, reportRef), reason, before: { state: rec.state }, after: { state: after.state } }, by);
    return { recommendation: await this.recWithStaff(after), enforcement: null };
  }

  /** The pending approval as the caller sees it (access.approvalInfo; the check's own answer when access cannot tell) */
  private async approvalInfo(requestId: string, check: { reason: string; eligibleApproverRoles?: { name: string }[] | null }): Promise<common.ApprovalInfo> {
    const info = await this.core.ctx
      .use('access')
      .approvalInfo(requestId)
      .catch(() => null);
    return info ?? { required: true, reason: check.reason, approvalRequestId: requestId, approvers: (check.eligibleApproverRoles ?? []).map((r) => r.name) };
  }

  private sellerOf(targets: TrustSubject[]): string | null {
    return targets.find((t) => t.type === 'seller')?.id ?? null;
  }

  /** Sellers and customers affected by an enforcement on their offers or products (for their own lists and appeals) */
  private async affectedParties(targets: TrustSubject[]): Promise<{ type: string; id: string }[]> {
    const out: { type: string; id: string }[] = [];
    for (const t of targets.slice(0, 50)) {
      if (t.type === 'offer') {
        const o = await this.core.soft('offers', 'getOfferAdmin', (m) => m.getOfferAdmin(t.id));
        if (o?.sellerId) out.push({ type: 'affected_seller', id: o.sellerId });
      } else if (t.type === 'product') {
        const p = await this.core.soft('catalog', 'getProductAdmin', (m) => m.getProductAdmin(t.id));
        if (p?.ownerSellerId) out.push({ type: 'affected_seller', id: p.ownerSellerId });
      }
    }
    return out;
  }

  /* ================================================================ enforcement */

  async list(q: { action?: string; ownerTeam?: string; executionState?: string; targetType?: string; targetId?: string }, page: PageRequest): Promise<Page<Enforcement>> {
    let ids: string[] | undefined;
    if (q.targetId) ids = await this.core.repo.enforcementIdsFor(q.targetType ? [{ type: q.targetType, id: q.targetId }] : SUBJECT_TYPES.map((type) => ({ type, id: q.targetId! })));
    else if (q.targetType) ids = [...new Set((await this.core.repo.find('enforcement_targets', { target_type: q.targetType })).map((t) => t.enforcement_id))];
    const where = { ...(ids ? { id: ids } : {}), ...(q.action ? { action: q.action } : {}), ...(q.ownerTeam ? { owner_team: q.ownerTeam } : {}), ...(q.executionState ? { execution_state: q.executionState } : {}) };
    const [rows, total] = await Promise.all([this.core.repo.find('enforcements', where, { orderBy: [['recorded_at', 'desc'], ['id', 'desc']], offset: offsetOf(page), limit: page.limit }), this.core.repo.count('enforcements', where)]);
    const refs = await this.reportRefs(rows);
    return pageFrom(
      rows.map((e) => this.views.enforcement(e, refs.get(e.report_id) ?? '')),
      total,
      page,
    );
  }

  async reportRefs(rows: { report_id: string | null }[]): Promise<Map<string, string>> {
    const ids = [...new Set(rows.map((r) => r.report_id).filter((x): x is string => !!x))];
    const reports = ids.length ? await this.core.repo.find('reports', { id: ids }) : [];
    return new Map(reports.map((r) => [r.id, r.ref]));
  }

  /** Active enforcement (pending or applied) recorded against a subject */
  async enforcementsFor(subjectType: string, subjectId: string): Promise<Enforcement[]> {
    if (!isUuid(subjectId)) return [];
    const ids = await this.core.repo.enforcementIdsFor([{ type: subjectType, id: subjectId }]);
    const rows = ids.length ? await this.core.repo.find('enforcements', { id: ids, execution_state: ['pending', 'applied'] }, { orderBy: [['recorded_at', 'desc']] }) : [];
    const refs = await this.reportRefs(rows);
    return rows.map((e) => this.views.enforcement(e, refs.get(e.report_id) ?? ''));
  }

  /** Enforcement that affects a customer or seller (on the account itself, or its offers and products) */
  async forParty(kind: 'customer' | 'seller', ids: string[]): Promise<EnforcementRec[]> {
    const targets = ids.filter(isUuid).flatMap((id) => [
      { type: kind, id },
      { type: `affected_${kind}`, id },
    ]);
    const found = await this.core.repo.enforcementIdsFor(targets);
    return found.length ? this.core.repo.find('enforcements', { id: found }, { orderBy: [['recorded_at', 'desc']] }) : [];
  }

  async myEnforcements(kind: 'customer' | 'seller', ids: string[], appellantIds: string[]): Promise<MyEnforcement[]> {
    const rows = (await this.forParty(kind, ids)).filter((e) => e.execution_state === 'pending' || e.execution_state === 'applied');
    const appeals = rows.length ? await this.core.repo.find('appeals', { enforcement_id: rows.map((e) => e.id), appellant_kind: kind, appellant_id: appellantIds }, { orderBy: [['filed_at', 'desc']] }) : [];
    return rows.map((e) => this.views.myEnforcement(e, appeals.find((a) => a.enforcement_id === e.id)?.id ?? null));
  }

  /** Reverse (overturned appeal or error): applied → reversed; publishes trust.enforcement.reversed so the owner undoes it */
  async reverse(id: string, body: { reason: string }, by: By): Promise<Enforcement> {
    if (!text(body.reason)) throw invalidField('reason', 'Why is it reversed?');
    const e = isUuid(id) ? await this.core.repo.get('enforcements', id) : undefined;
    if (!e) throw notFound('Enforcement');
    enforcementExecutionMachine.next(e.execution_state as 'applied', 'reverse');
    const access = this.core.ctx.use('access');
    const principal = this.principalOf(by);
    const check = await access.check(principal, 'trust.enforcements.reverse');
    if (check.decision === 'denied') throw new AppError('FORBIDDEN', check.reason, { action: 'trust.enforcements.reverse' });
    if (check.decision === 'approval_required') {
      // stays applied until the request is decided (approved: reversed by onApprovalDecided)
      const report = (await this.core.repo.get('reports', e.report_id))!;
      const req = await access.requestApproval({
        action: REVERSE_ACTION,
        target: { type: ENF_TARGET, id, ref: e.ref, label: `${humanize(e.action)} (${report.ref})`, screen: 'admin/trust' },
        summary: `Reverse enforcement ${e.ref}: ${humanize(e.action)}`,
        details: { enforcementId: id, reportId: e.report_id, action: e.action, targets: e.targets },
        reason: body.reason.trim(),
        requestedBy: principal,
      });
      const pending = await this.core.write(e.report_id, by, async (tx) => {
        const cur = (await tx.get('enforcements', id, { forUpdate: true }))!;
        enforcementExecutionMachine.next(cur.execution_state as 'applied', 'reverse');
        const saved = await tx.update('enforcements', id, { reversal_request_id: req.id });
        await this.core.timeline(tx, e.report_id, [{ kind: 'approval_requested', label: `Approval requested to reverse ${e.ref}`, text: check.reason, actor: by.actor, meta: { enforcementId: id, approvalRequestId: req.id } }]);
        return saved;
      });
      await this.core.audit({ action: 'trust.enforcement.request_reversal', actionLabel: 'Sent the reversal of a trust enforcement for approval', target: { type: ENF_TARGET, id, ref: e.ref, label: humanize(e.action), screen: 'admin/trust' }, reason: body.reason.trim(), approvalRequestId: req.id }, by);
      return { ...this.views.enforcement(pending, report.ref), approval: await this.approvalInfo(req.id, check) };
    }
    const after = await this.reverseNow(id, body.reason.trim(), by);
    const reportRef = (await this.core.repo.get('reports', e.report_id))!.ref;
    await this.raiseReversal(after, reportRef, body.reason.trim());
    await this.reverseAudit(e, after, body.reason, by, { approvalRequestId: null, approvalNote: check.reason });
    return this.views.enforcement(after, reportRef);
  }

  /**
   * Stopgap until every owner confirms its undo (decision D9): an enforcement_reversal work item in the owner team's
   * queue so a person checks the undo, especially for actions done in the owner's own screen. Closed by hand.
   */
  async raiseReversal(e: EnforcementRec, reportRef: string, reason: string) {
    const team = (isTeam(e.owner_team) ? e.owner_team : 'support') as OwnerTeam;
    const sellerId = e.targets.find((t) => t.type === 'seller')?.id;
    const customerId = e.targets.find((t) => t.type === 'customer')?.id;
    await this.core.soft('workqueues', 'raise', (w) =>
      w.raise({
        queueKey: TEAM_QUEUES[team],
        kind: 'enforcement_reversal',
        sourceModule: 'trust',
        title: `Undo enforcement ${e.ref}: ${humanize(e.action)}`,
        summary: `Trust and Risk reversed ${e.ref} (${reportRef}): ${reason}. Check that the action is undone${e.applied_ref ? ` (record ${e.applied_ref})` : ''}.`,
        subject: { type: 'trust_report', id: e.report_id, ref: reportRef, label: humanize(e.action) },
        ...(sellerId ? { sellerId } : {}),
        ...(customerId ? { customerId } : {}),
        priority: 'high',
        dedupeKey: `trust_reversal:${e.id}`,
        links: [{ label: 'Open report', screen: 'admin/trust', id: e.report_id }],
      }),
    );
  }

  private async reverseAudit(e: EnforcementRec, after: EnforcementRec, reason: string, by: By, o: { approvalRequestId: string | null; approvalNote: string | null }) {
    await this.core.audit(
      {
        action: 'trust.enforcement.reverse',
        actionLabel: 'Reversed a trust enforcement',
        target: { type: ENF_TARGET, id: e.id, ref: e.ref, label: humanize(e.action), screen: 'admin/trust' },
        relatedTargets: e.targets.map((t) => ({ type: t.type, id: t.id, ref: t.ref ?? null, label: t.label })),
        reason,
        before: { executionState: e.execution_state },
        after: { executionState: after.execution_state },
        approvalRequestId: o.approvalRequestId,
        approvalNote: o.approvalRequestId ? null : o.approvalNote,
      },
      by,
    );
  }

  /* ================================================================ approvals (access.approval.decided) */

  /**
   * Finishes an accept or reversal that waited for an approval request. Only the request trust last opened for the
   * record counts. Approved: the recommendation is accepted (or the enforcement reversed) as the requester, and
   * trust.enforcement.recorded carries Trust and Risk with the request reference (authority already granted, so the
   * owning module does not ask again). Rejected, cancelled or expired: the record stays where it was (sent_to_owner,
   * or applied), with a timeline entry.
   */
  async onApprovalDecided(e: EventPayload<'access.approval.decided'>, eventId?: string): Promise<void> {
    const kind = e.target?.type === REC_TARGET ? 'recommendation' : e.target?.type === ENF_TARGET && e.actionKey === REVERSE_ACTION ? 'enforcement' : null;
    if (!kind || !isUuid(e.target.id)) return;
    const key = `approval-decided:${e.requestId}`;
    const rec = kind === 'recommendation' ? await this.core.repo.get('recommendations', e.target.id) : undefined;
    const enf = kind === 'enforcement' ? await this.core.repo.get('enforcements', e.target.id) : undefined;
    const reportId = rec?.report_id ?? enf?.report_id;
    if (!reportId) {
      this.core.ctx.log.info({ target: e.target, approvalRequestId: e.requestId, eventId }, 'trust: approval decided for an unknown record; ignored');
      return;
    }
    const system: By = { actor: { kind: 'system', id: null, name: 'Trust and Risk' } };
    // only the request trust last opened for the record counts (approval_request_id / reversal_request_id)
    const latest = rec ? rec.approval_request_id : (enf?.reversal_request_id ?? null);
    const applies =
      latest === e.requestId && (rec ? recommendationMachine.can(rec.state as 'sent_to_owner', 'accept') : enforcementExecutionMachine.can(enf!.execution_state as 'applied', 'reverse'));
    if (e.outcome !== 'approved' || !applies) {
      if (e.outcome === 'approved') this.core.ctx.log.info({ target: e.target, approvalRequestId: e.requestId }, 'trust: approved request no longer applies');
      const what = rec ? `accept: ${rec.label}` : `reverse ${enf!.ref}`;
      await this.core.write(reportId, system, async (tx) => {
        if (!(await tx.claim(key))) return;
        if (e.outcome !== 'approved' && latest === e.requestId) {
          if (rec) await tx.update('recommendations', rec.id, { approval_request_id: null });
          else await tx.update('enforcements', enf!.id, { reversal_request_id: null });
          await this.core.timeline(tx, reportId, [
            {
              kind: 'approval_decided',
              label: `Approval ${e.outcome} to ${what}${rec ? '; it stays with the owner team' : '; the enforcement stays in place'}`,
              text: e.reason ?? null,
              actor: e.decidedBy ?? system.actor,
              meta: { ...(rec ? { recommendationId: rec.id } : { enforcementId: enf!.id }), approvalRequestId: e.requestId, outcome: e.outcome },
            },
          ]);
        }
      });
      return;
    }
    const request = await this.core.ctx
      .use('access')
      .getApproval(e.requestId)
      .catch(() => null);
    const by: By = { actor: request?.requestedBy ?? { kind: 'staff', id: e.requestedById } };
    const reason = request?.reason?.trim() || e.reason?.trim() || 'Approved through access';
    const reportRef = (await this.core.repo.get('reports', reportId))?.ref ?? '';
    if (rec) {
      const details = (request?.details ?? {}) as { params?: Record<string, unknown>; externalRef?: string | null };
      const action = (isAction(rec.action) ? rec.action : 'other') as Action;
      const params = details.params && typeof details.params === 'object' ? details.params : ((rec.params ?? {}) as Record<string, unknown>);
      await this.accept(rec, reportRef, { action, params, reason, externalRef: text(details.externalRef) || null }, by, { approvalNote: 'Approved through access', approvedRequest: e.requestId, claim: key });
      return;
    }
    const after = await this.core.write(reportId, by, async (tx, _agg, batch) => {
      if (!(await tx.claim(key))) return null;
      return this.reverseNow(enf!.id, reason, by, tx, batch);
    });
    if (after) {
      await this.raiseReversal(after, reportRef, reason);
      await this.reverseAudit(enf!, after, reason, by, { approvalRequestId: e.requestId, approvalNote: null });
    }
  }

  /**
   * The reversal itself (also used when an appeal is overturned). trust.enforcement.reversed carries everything the
   * executing module needs to undo exactly what it did (action, typed params, targets, appliedRef, the state before).
   * The caller raises the owner's work item (raiseReversal) after the commit.
   */
  async reverseNow(id: string, reason: string, by: By, tx?: TrustRepository, batch?: { push: (name: 'trust.enforcement.reversed', p: EventPayload<'trust.enforcement.reversed'>) => void }, appealId?: string | null): Promise<EnforcementRec> {
    const run = async (t: TrustRepository, b: NonNullable<typeof batch>) => {
      const cur = (await t.get('enforcements', id, { forUpdate: true }))!;
      const before = cur.execution_state as 'pending' | 'applied' | 'failed';
      const state = enforcementExecutionMachine.next(cur.execution_state as 'applied', 'reverse');
      const now = this.core.now();
      const report = (await t.get('reports', cur.report_id))!;
      const after = await t.update('enforcements', id, { execution_state: state, reversed_at: now, reversal_reason: reason, reversal_request_id: null });
      await this.core.timeline(t, cur.report_id, [{ kind: 'enforcement_reversed', label: `Enforcement ${cur.ref} reversed`, text: reason, actor: by.actor, meta: { enforcementId: id, ...(appealId ? { appealId } : {}) } }]);
      b.push('trust.enforcement.reversed', {
        enforcementId: id,
        ref: cur.ref,
        reportId: cur.report_id,
        reportRef: report.ref,
        action: (isAction(cur.action) ? cur.action : 'other') as Action,
        ownerTeam: (isTeam(cur.owner_team) ? cur.owner_team : 'support') as OwnerTeam,
        targets: cur.targets,
        params: cur.params ?? {},
        appliedRef: cur.applied_ref ?? null,
        executionState: before,
        reason,
        appealId: appealId ?? null,
        reversedBy: by.actor,
        reversedAt: now.toISOString(),
      });
      return after;
    };
    if (tx && batch) return run(tx, batch);
    const e = (await this.core.repo.get('enforcements', id))!;
    return this.core.write(e.report_id, by, (t, _agg, b) => run(t, b));
  }

  /* ================================================================ execution confirmations (owning modules' events) */

  /** pending (or failed: retried) → applied */
  async confirm(enforcementId: string, appliedRef: string | null, label: string) {
    const e = await this.core.repo.get('enforcements', enforcementId);
    if (!e || (e.execution_state !== 'pending' && e.execution_state !== 'failed')) return;
    const by: By = { actor: { kind: 'system', id: null, name: humanize(e.owner_team) } };
    await this.core.write(e.report_id, by, async (tx) => {
      const cur = (await tx.get('enforcements', enforcementId, { forUpdate: true }))!;
      let state = cur.execution_state as ExecState;
      if (state === 'failed') state = enforcementExecutionMachine.next(state, 'retry') as ExecState;
      if (state !== 'pending') return;
      state = enforcementExecutionMachine.next(state, 'confirm') as ExecState;
      await tx.update('enforcements', enforcementId, { execution_state: state, applied_ref: appliedRef ?? cur.applied_ref, applied_at: this.core.now(), failure: null });
      await this.core.timeline(tx, cur.report_id, [{ kind: 'enforcement_applied', label: `Enforcement ${cur.ref} applied`, text: label, actor: by.actor, meta: { enforcementId } }]);
    });
    if (e.execution_state === 'failed') await this.core.soft('workqueues', 'resolveBySource', (w) => w.resolveBySource(`trust_enforcement:${enforcementId}:unconfirmed`, { note: 'Confirmed by the owning module', by: by.actor }));
  }

  /** Waiting enforcements of an action against a target (optionally on one report) */
  private async waiting(actions: string[], target: { type: string; id: string } | null, reportId?: string | null): Promise<EnforcementRec[]> {
    const ids = target ? await this.core.repo.enforcementIdsFor([target]) : undefined;
    if (ids && !ids.length) return [];
    return this.core.repo.find('enforcements', { ...(ids ? { id: ids } : {}), action: actions, execution_state: ['pending', 'failed'], ...(reportId ? { report_id: reportId } : {}) });
  }

  /** A note on the report's timeline from another module's event, once per key */
  private async note(reportId: string, key: string, label: string, text: string | null) {
    const report = isUuid(reportId) ? await this.core.repo.get('reports', reportId) : undefined;
    if (!report || (await this.core.repo.eventsByKey(key)).length) return;
    await this.core.write(reportId, { actor: { kind: 'system', id: null } }, async (tx) => {
      await this.core.timeline(tx, reportId, [{ kind: 'owner_action', label, text, meta: { key } }]);
    });
  }

  /** An event names the enforcement it executed: confirm it when it is of the expected action */
  private async confirmNamed(enforcementId: string | null | undefined, actions: string[], appliedRef: string | null, label: string): Promise<boolean> {
    if (!enforcementId || !isUuid(enforcementId)) return false;
    const x = await this.core.repo.get('enforcements', enforcementId);
    if (!x || !actions.includes(x.action)) return false;
    await this.confirm(x.id, appliedRef, label);
    return true;
  }

  async onProductPublicationChanged(e: EventPayload<'catalog.product.publication_changed'>) {
    if (e.to !== 'suspended') return;
    if (await this.confirmNamed(e.trustEnforcementId, ['suspend_product'], e.productId, `Catalog suspended the product: ${e.reason}`)) return;
    const list =(await this.waiting(['suspend_product'], { type: 'product', id: e.productId }, e.trustReportId ?? null)).filter((x) => e.trustReportId || e.reason.includes(x.ref) || e.reason.includes(x.reason));
    for (const x of list) if (await this.allApplied(x)) await this.confirm(x.id, e.productId, `Catalog suspended the product: ${e.reason}`);
  }

  async onOfferStatusChanged(e: EventPayload<'offers.offer.status_changed'>) {
    // a reversal reinstating the offer also carries the enforcement id: only removed / held confirms
    if (!['removed', 'ineligible'].includes(e.to)) return;
    if (await this.confirmNamed(e.trustEnforcementId, ['suspend_offer'], e.offerId, `Offer ${e.to === 'removed' ? 'removed' : 'held'} by offers`)) return;
    if (e.reasonCode !== 'enforcement') return;
    for (const x of await this.waiting(['suspend_offer'], { type: 'offer', id: e.offerId })) if (await this.allApplied(x)) await this.confirm(x.id, e.offerId, `Offer ${e.to === 'removed' ? 'removed' : 'held'} by offers`);
  }

  /** Every product or offer target is in its enforced state (when the owning module answers) */
  private async allApplied(x: EnforcementRec): Promise<boolean> {
    for (const t of x.targets) {
      if (x.action === 'suspend_product' && t.type === 'product') {
        const p = await this.core.soft('catalog', 'getProductAdmin', (m) => m.getProductAdmin(t.id));
        if (p && p.publication !== 'suspended') return false;
      }
      if (x.action === 'suspend_offer' && t.type === 'offer') {
        const o = await this.core.soft('offers', 'getOfferAdmin', (m) => m.getOfferAdmin(t.id));
        if (o && !['removed', 'ineligible'].includes(o.status)) return false;
      }
    }
    return true;
  }

  async onSellerRestricted(e: EventPayload<'sellers.seller.restricted'>) {
    if (e.trustEnforcementId) return this.confirm(e.trustEnforcementId, e.restrictionId, `Seller Manager restriction active: ${e.reason}`);
    if (!e.trustReportId) return;
    for (const x of await this.waiting(['restrict_seller'], { type: 'seller', id: e.sellerId }, e.trustReportId)) await this.confirm(x.id, e.restrictionId, `Seller Manager restriction active: ${e.reason}`);
  }

  async onSellerSuspended(e: EventPayload<'sellers.seller.suspended'>) {
    if (await this.confirmNamed(e.trustEnforcementId, ['suspend_seller'], e.suspensionId, `Suspension in effect after second review: ${e.reason}`)) return;
    if (!e.trustReportId) return;
    for (const x of await this.waiting(['suspend_seller'], { type: 'seller', id: e.sellerId }, e.trustReportId)) await this.confirm(x.id, e.suspensionId, `Suspension in effect after second review: ${e.reason}`);
  }

  async onAccountRestricted(e: EventPayload<'customers.account.restricted'>) {
    if (e.trustEnforcementId) return this.confirm(e.trustEnforcementId, e.restrictionId, `Customer ${e.scope} restriction active`);
    if (!e.trustReportId) return;
    const action = e.scope === 'messaging' ? 'restrict_customer_messaging' : 'restrict_customer_account';
    for (const x of await this.waiting([action], { type: 'customer', id: e.customerId }, e.trustReportId)) await this.confirm(x.id, e.restrictionId, `Customer ${e.scope} restriction active`);
  }

  async onAccountRestrictionLifted(e: EventPayload<'customers.account.restriction_lifted'>) {
    if (!e.trustEnforcementId) return;
    const x = await this.core.repo.get('enforcements', e.trustEnforcementId);
    if (!x) return;
    await this.note(x.report_id, `customers.restriction_lifted:${e.restrictionId}`, `Customer ${e.scope} restriction from ${x.ref} ended`, 'Lifted or expired in customers');
  }

  async onHoldPlaced(e: EventPayload<'finance.hold.placed'>) {
    if (!e.trustReportId) return;
    const list = await this.waiting(['hold_payout'], null, e.trustReportId);
    // the report's hold_payout for the same seller (also holds placed after an approval)
    const mine = list.filter((x) => x.targets.some((t) => t.type === 'seller' && t.id === e.sellerId));
    for (const x of mine) await this.confirm(x.id, e.holdId, `Finance placed a hold: ${e.reason}`);
    if (!mine.length) await this.note(e.trustReportId, `finance.hold:${e.holdId}`, 'Finance placed a payout hold', e.reason);
  }

  async onItemCancelled(e: EventPayload<'orders.item.cancelled'>) {
    if (!e.trustReportId) return;
    await this.note(e.trustReportId, `orders.cancel:${e.cancellationId}:${e.itemId}`, `Order ${e.ref}: item cancelled by ${e.initiatedBy}`, `Reason: ${humanize(e.reasonCode)}`);
    const list = await this.waiting(['hold_dispatch', 'review_payments', 'other'], null, e.trustReportId);
    for (const x of list) {
      const orders = x.targets.filter((t) => t.type === 'order');
      if (orders.length && !orders.some((t) => t.id === e.orderId)) continue;
      await this.confirm(x.id, e.cancellationId, `Order ${e.ref} cancelled before dispatch`);
    }
  }

  async onRefundApproved(e: EventPayload<'returns.refund.approved'>) {
    if (!e.trustReportId) return;
    for (const x of await this.waiting(['refund_buyers'], null, e.trustReportId)) {
      const orders = x.targets.filter((t) => t.type === 'order');
      if (orders.length && !orders.some((t) => t.id === e.orderId)) continue;
      await this.confirm(x.id, e.refundRequestId, 'Refund approved by Finance');
    }
  }

  /**
   * support.case.opened confirms the inform_customers enforcements of the report named by trustReportId (for the
   * case's customer or order when the enforcement names any); cases without trustReportId never confirm anything.
   */
  async onCaseOpened(e: EventPayload<'support.case.opened'>) {
    if (!e.trustReportId || !isUuid(e.trustReportId)) return;
    for (const x of await this.waiting(['inform_customers'], null, e.trustReportId)) {
      const named = x.targets.filter((t) => t.type === 'customer' || t.type === 'order');
      if (named.length && !named.some((t) => (t.type === 'customer' && t.id === e.customerId) || (t.type === 'order' && t.id === e.orderId))) continue;
      await this.confirm(x.id, e.ref, `Support opened case ${e.ref}`);
      const report = await this.core.repo.get('reports', x.report_id);
      const linked = report ? await this.core.repo.eventsFor('caseRef', e.ref, ['case_linked']) : [];
      if (report && !linked.some((l) => l.report_id === report.id)) {
        await this.core.write(report.id, { actor: { kind: 'system', id: null } }, async (tx) => {
          await this.core.timeline(tx, report.id, [{ kind: 'case_linked', label: `Support case ${e.ref} linked`, meta: { caseRef: e.ref } }]);
        });
      }
    }
  }

  /** sellers.warning.issued: confirms the warn_seller enforcement it executed */
  async onWarningIssued(e: EventPayload<'sellers.warning.issued'>) {
    await this.confirmNamed(e.trustEnforcementId, ['warn_seller'], e.warningId, `Seller Manager issued the warning: ${e.title}`);
  }

  /** messaging.conversation.locked: confirms the lock_conversation enforcement it executed */
  async onConversationLocked(e: EventPayload<'messaging.conversation.locked'>) {
    await this.confirmNamed(e.trustEnforcementId, ['lock_conversation'], e.conversationId, 'Messaging locked the conversation');
  }

  /**
   * reviews.moderation.decided: a removal that executes a remove_reviews enforcement is noted on the report; the
   * enforcement is applied once every named review, question or answer is removed.
   */
  async onModerationDecided(e: EventPayload<'reviews.moderation.decided'>) {
    if (!e.trustEnforcementId || !isUuid(e.trustEnforcementId) || e.decision !== 'remove') return;
    const x = await this.core.repo.get('enforcements', e.trustEnforcementId);
    if (!x || x.action !== 'remove_reviews') return;
    const keyOf = (contentId: string) => `reviews.removed:${x.id}:${contentId}`;
    await this.note(x.report_id, keyOf(e.contentId), `Reviews removed the ${humanize(e.contentType).toLowerCase()} named by ${x.ref}`, null);
    const content = x.targets.filter((t) => ['review', 'question', 'answer'].includes(t.type));
    for (const t of content) if (t.id !== e.contentId && !(await this.core.repo.eventsByKey(keyOf(t.id))).length) return;
    await this.confirm(x.id, e.moderationItemId, `Reviews removed ${content.length === 1 ? 'the named content' : `all ${content.length} named items`}`);
  }

  /* ================================================================ job */

  /** trust.execution-check: enforcement still pending after executionGraceMinutes → failed, with a work item for the owner team */
  async executionCheck() {
    const grace = await this.core.setting('executionGraceMinutes', 60);
    const before = new Date(this.core.now().getTime() - grace * 60_000);
    const rows = await this.core.repo.find('enforcements', { execution_state: 'pending', recorded_at: { op: '<', value: before } }, { orderBy: [['recorded_at', 'asc']], limit: 200 });
    for (const e of rows) {
      const failure = `No confirmation from ${humanize(e.owner_team)} within ${grace} minutes`;
      const done = await this.core.write(e.report_id, { actor: { kind: 'system', id: null } }, async (tx, agg) => {
        const cur = (await tx.get('enforcements', e.id, { forUpdate: true }))!;
        if (cur.execution_state !== 'pending') return null;
        await tx.update('enforcements', e.id, { execution_state: enforcementExecutionMachine.next('pending', 'fail'), failure });
        await this.core.timeline(tx, e.report_id, [{ kind: 'enforcement_failed', label: `Enforcement ${e.ref} not confirmed`, text: failure, meta: { enforcementId: e.id } }]);
        return agg.report;
      });
      if (!done) continue;
      const team = (isTeam(e.owner_team) ? e.owner_team : 'support') as OwnerTeam;
      await this.core.soft('workqueues', 'raise', (w) =>
        w.raise({
          queueKey: TEAM_QUEUES[team],
          kind: 'trust_recommendation',
          sourceModule: 'trust',
          title: `Confirm enforcement ${e.ref}: ${humanize(e.action)}`,
          summary: `${failure}. Apply it in your screen, or record the reference on the recommendation.`,
          subject: { type: 'trust_report', id: e.report_id, ref: done.ref, label: humanize(e.action) },
          ...(e.targets.find((t) => t.type === 'seller') ? { sellerId: e.targets.find((t) => t.type === 'seller')!.id } : {}),
          priority: 'high',
          dedupeKey: `trust_enforcement:${e.id}:unconfirmed`,
          links: [{ label: 'Open report', screen: 'admin/trust', id: e.report_id }],
        }),
      );
    }
  }
}

