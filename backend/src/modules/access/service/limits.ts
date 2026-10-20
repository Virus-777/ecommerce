/**
 * Approval limits: the limits in force per role and action, effective-dated limit changes (proposed, approved,
 * applied) and the authority check screen.
 */
import { SYSTEM_ACTOR } from '../../../kernel/auth/index.js';
import { AppError } from '../../../kernel/errors/index.js';
import { newId } from '../../../kernel/lib/ids.js';
import type { PageRequest } from '../../../kernel/lib/pagination.js';
import type * as common from '../../../spec/common.js';
import type * as identity from '../../../spec/identity.js';
import type {
  ApprovalLimit,
  AuthorityCheck,
  AmountInput,
  LimitChange,
  LimitDiff,
  LimitInput,
  LimitValue,
  MyActionLimit,
} from '../../../spec/access.js';
import { loadDirectory, type Directory } from '../directory.js';
import {
  compareSize,
  limitSummary,
  normalizeLimit,
  NOT_PERMITTED,
  strongest,
  validateLimit,
  type Issue,
  type LimitKind,
  type SecondMode,
} from '../domain/limits.js';
import { BUSINESS_OWNER } from '../domain/seed.js';
import { limitChangeMachine } from '../domain/state-machines.js';
import type { LimitChangeRow, LimitRow } from '../ports.js';
import {
  type Core,
  type Caller,
  LIMITS_CHANGE,
  FINAL,
  iso,
  uniq,
  roleRef,
  moneyOf,
  num,
  validation,
  notFound,
  KIND_ORDER,
} from './core.js';
import type { Roles } from './roles.js';
import type { Approvals } from './approvals.js';

export class Limits {
  constructor(readonly core: Core) {}

  private get roles(): Roles {
    return this.core.parts.roles;
  }

  private get approvals(): Approvals {
    return this.core.parts.approvals;
  }

  /** The caller's own authority, limit, second-review rule and approval route for one action (decision panels) */
  async myLimitFor(principal: identity.Principal, actionKey: string): Promise<MyActionLimit> {
    await this.core.ready();
    const act = await this.core.requireAction(actionKey);
    const dir = await loadDirectory(this.core.repo, this.core.now());
    const kind = act.limit_kind as LimitKind;
    const mode = act.second_reviewer as SecondMode;
    const limits = await this.core.repo.limitsInForce(this.core.now(), { actionKey });
    const mine = this.limitsOfPerson(principal.accountId ?? '', dir, limits, kind);
    const best = strongest(kind, mine)?.value ?? NOT_PERMITTED;
    const value = principal.accountId && dir.blocked.has(principal.accountId) ? this.blockedValue(best) : best;
    const myRoleIds = new Set(dir.rolesOf(principal.accountId ?? '').map((r) => r.id));
    const above = limits
      .filter((l) => !myRoleIds.has(l.role_id) && dir.roleById.get(l.role_id) && !dir.roleById.get(l.role_id)!.archived_at)
      .map((l) => ({ role: dir.roleById.get(l.role_id)!, value: this.limitValue(l) }))
      .filter((x) => x.value.authority === 'permitted' || x.value.authority === 'permitted_with_second_review')
      .filter((x) => kind === 'none' || value.authority === 'not_permitted' || value.authority === 'recommend_only' || compareSize(kind, x.value, value) > 0)
      .sort((a, b) => compareSize(kind, a.value, b.value) || (KIND_ORDER[b.role.kind] ?? 9) - (KIND_ORDER[a.role.kind] ?? 9));
    return {
      action: this.roles.actionView(act),
      value,
      needsSecondReviewer: mode === 'always' || value.authority === 'permitted_with_second_review' || Boolean(value.secondReviewerAboveMoney || value.secondReviewerAboveNumber != null),
      route: uniq(above.map((x) => x.role.name)),
      summary: limitSummary(kind, mode, value),
    };
  }

  async listLimits(query: { roleId?: string; actionKey?: string }): Promise<ApprovalLimit[]> {
    await this.core.ready();
    const dir = await loadDirectory(this.core.repo, this.core.now());
    const rows = await this.core.repo.limitsInForce(this.core.now(), { ...(query.roleId ? { roleIds: [query.roleId] } : {}), ...(query.actionKey ? { actionKey: query.actionKey } : {}) });
    return this.limitViews(rows, dir);
  }

  async proposeLimitChange(caller: Caller, input: { roleId: string; changes: LimitInput[]; reason: string; effectiveFrom: string }): Promise<LimitChange> {
    await this.core.ready();
    const dir = await loadDirectory(this.core.repo, this.core.now());
    const role = dir.roleById.get(input.roleId);
    if (!role) throw notFound('Role');
    if (role.archived_at) throw new AppError('CONFLICT', `${role.name} is archived`);
    const actions = new Map((await this.core.repo.listActions()).map((a) => [a.key, a]));
    const unknown = input.changes.map((c) => c.actionKey).filter((k) => !actions.get(k) || actions.get(k)!.unavailable_since);
    if (unknown.length) throw new AppError('UNKNOWN_APPROVAL_ACTION', `Not registered by any enabled module: ${uniq(unknown).join(', ')}`, { keys: uniq(unknown) });
    const issues: Issue[] = [];
    if (!input.changes.length) issues.push({ path: 'changes', message: 'Change at least one limit' });
    input.changes.forEach((c, i) => {
      if (input.changes.findIndex((x) => x.actionKey === c.actionKey) !== i) issues.push({ path: `changes.${i}.actionKey`, message: 'Listed twice' });
      issues.push(...validateLimit(actions.get(c.actionKey)!.limit_kind as LimitKind, normalizeLimit(c.value), `changes.${i}.value`, this.core.ctx.config.market.currency));
      c.value.secondReviewerRoleKeys.forEach((k, j) => {
        if (!dir.roleByKey.get(k)) issues.push({ path: `changes.${i}.value.secondReviewerRoleKeys.${j}`, message: 'Unknown role' });
      });
    });
    if (issues.length) throw validation('The limit change is not valid', issues);

    const now = this.core.now();
    const inForce = await this.core.repo.limitsInForce(now, { roleIds: [role.id] });
    const diffs: LimitDiff[] = input.changes.map((c) => {
      const before = inForce.find((l) => l.action_key === c.actionKey);
      return { actionKey: c.actionKey, actionLabel: actions.get(c.actionKey)!.label, before: before ? this.limitValue(before) : null, after: normalizeLimit(c.value) };
    });
    const me = caller.principal.accountId ?? '';
    const bo = dir.roleByKey.get(BUSINESS_OWNER);
    const otherOwners = bo ? dir.membersOf(bo.id).filter((acc) => acc !== me) : [];
    const autoApprove = dir.isBusinessOwner(me) && (!dir.holds(me, role.id) || !otherOwners.length);
    const id = newId();
    let approvalRequestId: string | null = null;
    if (!autoApprove) {
      const req = await this.approvals.openRequest(
        {
          action: LIMITS_CHANGE,
          target: { type: 'limit_change', id, ref: role.key, label: `Approval limits of ${role.name}`, screen: 'admin/staff' },
          summary: `Change ${diffs.length} approval limit${diffs.length === 1 ? '' : 's'} of ${role.name}`,
          details: { roleId: role.id, roleKey: role.key, changes: diffs, effectiveFrom: iso(input.effectiveFrom) },
          reason: input.reason,
          requestedBy: caller.principal,
        },
        { restrictToBusinessOwner: true, requestedByActor: caller.actor, requestId: caller.requestId },
      );
      approvalRequestId = req.id;
    }
    const row = await this.core.repo.insertLimitChange({
      id,
      role_id: role.id,
      changes: diffs as never,
      reason: input.reason,
      effective_from: new Date(input.effectiveFrom),
      status: autoApprove ? 'scheduled' : 'pending_approval',
      proposed_by_kind: caller.actor.kind,
      proposed_by_id: caller.actor.id ?? '',
      approval_request_id: approvalRequestId,
      created_at: now,
      applied_at: null,
      cancel_reason: null,
    });
    await this.core.audit(
      {
        action: 'access.limits.propose',
        actionLabel: 'Proposed approval limits',
        target: this.roles.roleTarget(role),
        relatedTargets: [{ type: 'limit_change', id }],
        before: diffs.map((d) => ({ actionKey: d.actionKey, value: d.before })),
        after: diffs.map((d) => ({ actionKey: d.actionKey, value: d.after })),
        reason: input.reason,
        approvalRequestId,
        approvalNote: autoApprove ? 'Approved on creation by the Business Owner' : null,
      },
      caller,
    );
    if (autoApprove && row.effective_from <= now) await this.applyLimitChange(id);
    const fresh = await this.core.repo.getLimitChange(id);
    return (await this.limitChangeViews([fresh!], dir))[0]!;
  }

  async listLimitChanges(query: { status?: LimitChange['status']; roleId?: string }, page: PageRequest): Promise<common.Page<LimitChange>> {
    await this.core.ready();
    const dir = await loadDirectory(this.core.repo, this.core.now());
    const rows = await this.core.repo.listLimitChanges(query, page);
    return { ...rows, items: await this.limitChangeViews(rows.items, dir) };
  }

  async cancelLimitChange(caller: Caller, id: string, reason: string): Promise<LimitChange> {
    await this.core.ready();
    const { before, after } = await this.core.repo.transaction(async (tx) => {
      const before = await tx.getLimitChange(id, { forUpdate: true });
      if (!before) throw notFound('Limit change');
      const status = limitChangeMachine.next(before.status as never, 'cancel');
      const after = await tx.updateLimitChange(id, { status, cancel_reason: reason });
      return { before, after };
    });
    if (after.approval_request_id) {
      const req = await this.core.repo.getRequest(after.approval_request_id);
      if (req && !FINAL.has(req.status)) await this.approvals.closeRequest(req.id, 'cancel', caller.actor, reason);
    }
    const dir = await loadDirectory(this.core.repo, this.core.now());
    const role = dir.roleById.get(after.role_id);
    await this.core.audit(
      { action: 'access.limits.cancel', actionLabel: 'Withdrew a limit change', target: role ? this.roles.roleTarget(role) : { type: 'role', id: after.role_id }, relatedTargets: [{ type: 'limit_change', id }], before: { status: before.status }, after: { status: after.status }, reason, approvalRequestId: after.approval_request_id },
      caller,
    );
    return (await this.limitChangeViews([after], dir))[0]!;
  }

  async checkAuthority(caller: Caller, input: { action: string; amount?: AmountInput | null }): Promise<AuthorityCheck> {
    return this.approvals.check(caller.principal, input.action, input.amount ?? undefined);
  }

  /** A person's limits for one action: own roles plus roles covered with delegated authority (never above the away person's) */
  limitsOfPerson(accountId: string, dir: Directory, limits: LimitRow[], _kind: LimitKind): { roleKey: string; value: LimitValue }[] {
    const roleIds = new Set([...dir.rolesOf(accountId).map((r) => r.id), ...dir.covering(accountId).filter((c) => c.delegated).map((c) => c.roleId)]);
    const out: { roleKey: string; value: LimitValue }[] = [];
    for (const l of limits) {
      const role = dir.roleById.get(l.role_id);
      if (role && roleIds.has(l.role_id) && !out.some((o) => o.roleKey === role.key)) out.push({ roleKey: role.key, value: this.limitValue(l) });
    }
    return out;
  }

  /** While the Business Owner reviews a new member's limits they may prepare requests but not approve */
  blockedValue(v: LimitValue): LimitValue {
    return v.authority === 'not_permitted' ? v : { ...NOT_PERMITTED, authority: 'recommend_only' };
  }

  limitValue(l: LimitRow): LimitValue {
    return {
      authority: l.authority as LimitValue['authority'],
      limitMoney: moneyOf(l.limit_amount_minor, l.limit_currency),
      limitNumber: num(l.limit_number),
      secondReviewerAboveMoney: moneyOf(l.second_above_amount_minor, l.limit_currency),
      secondReviewerAboveNumber: num(l.second_above_number),
      secondReviewerRoleKeys: (l.second_reviewer_role_keys as string[]) ?? [],
    };
  }

  limitRow(roleId: string, actionKey: string, v: LimitValue, from: Date, limitChangeId: string | null): LimitRow {
    return {
      id: newId(),
      role_id: roleId,
      action_key: actionKey,
      authority: v.authority,
      limit_amount_minor: v.limitMoney?.amount ?? null,
      limit_currency: v.limitMoney?.currency ?? v.secondReviewerAboveMoney?.currency ?? null,
      limit_number: v.limitNumber != null ? String(v.limitNumber) : null,
      second_above_amount_minor: v.secondReviewerAboveMoney?.amount ?? null,
      second_above_number: v.secondReviewerAboveNumber != null ? String(v.secondReviewerAboveNumber) : null,
      second_reviewer_role_keys: v.secondReviewerRoleKeys as never,
      effective_from: from,
      effective_to: null,
      limit_change_id: limitChangeId,
    };
  }

  async limitViews(rows: LimitRow[], dir: Directory): Promise<ApprovalLimit[]> {
    const actions = new Map((await this.core.repo.listActions()).map((a) => [a.key, a]));
    const changes = await this.core.repo.limitChangesByIds(uniq(rows.map((r) => r.limit_change_id).filter((x): x is string => Boolean(x))));
    const requests = await this.core.repo.findRequests({ ids: uniq(changes.map((c) => c.approval_request_id).filter((x): x is string => Boolean(x))) });
    const decisions = await this.core.repo.decisionsOf(requests.map((r) => r.id));
    const approverOf = (lcId: string | null): common.Actor | null => {
      const lc = changes.find((c) => c.id === lcId);
      if (!lc) return null;
      if (!lc.approval_request_id) return { kind: lc.proposed_by_kind as common.Actor['kind'], id: lc.proposed_by_id || null };
      const last = decisions.filter((d) => d.request_id === lc.approval_request_id && d.decision === 'approved').at(-1);
      return last ? { kind: 'staff', id: last.by_account_id } : null;
    };
    return rows
      .filter((r) => dir.roleById.get(r.role_id) && actions.get(r.action_key))
      .map((r) => {
        const act = actions.get(r.action_key)!;
        const value = this.limitValue(r);
        return {
          id: r.id,
          role: roleRef(dir.roleById.get(r.role_id)!),
          action: this.roles.actionView(act),
          value,
          summary: limitSummary(act.limit_kind as LimitKind, act.second_reviewer as SecondMode, value),
          effectiveFrom: iso(r.effective_from),
          approvedBy: approverOf(r.limit_change_id),
        };
      })
      .sort((a, b) => a.role.name.localeCompare(b.role.name) || a.action.key.localeCompare(b.action.key));
  }

  async limitChangeViews(rows: LimitChangeRow[], dir: Directory): Promise<LimitChange[]> {
    const requests = await this.core.repo.findRequests({ ids: uniq(rows.map((r) => r.approval_request_id).filter((x): x is string => Boolean(x))) });
    const infos = new Map((await this.approvals.approvalInfos(requests, dir)).map((i) => [i.approvalRequestId!, i]));
    return rows.map((r) => {
      const role = dir.roleById.get(r.role_id);
      return {
        id: r.id,
        role: role ? roleRef(role) : { id: r.role_id, key: 'unknown', name: 'Unknown role' },
        changes: (r.changes as unknown as LimitDiff[]) ?? [],
        reason: r.reason,
        effectiveFrom: iso(r.effective_from),
        status: r.status as LimitChange['status'],
        proposedBy: { kind: r.proposed_by_kind as common.Actor['kind'], id: r.proposed_by_id || null },
        approval: (r.approval_request_id && infos.get(r.approval_request_id)) || { required: false, reason: 'Approved on creation by the Business Owner', approvalRequestId: null, approvers: [] },
        createdAt: iso(r.created_at),
        appliedAt: r.applied_at ? iso(r.applied_at) : null,
      };
    });
  }

  async applyLimitChange(id: string) {
    const now = this.core.now();
    const done = await this.core.repo.transaction(async (tx) => {
      const lc = await tx.getLimitChange(id, { forUpdate: true });
      if (!lc || lc.status !== 'scheduled' || lc.effective_from > now) return null;
      const changes = (lc.changes as unknown as LimitDiff[]) ?? [];
      for (const c of changes) {
        await tx.closeLimits(lc.role_id, c.actionKey, lc.effective_from);
        await tx.insertLimits([this.limitRow(lc.role_id, c.actionKey, normalizeLimit(c.after), lc.effective_from, lc.id)]);
      }
      return tx.updateLimitChange(id, { status: limitChangeMachine.next('scheduled', 'apply'), applied_at: now });
    });
    if (!done) return;
    const role = await this.core.repo.getRole(done.role_id);
    const diffs = (done.changes as unknown as LimitDiff[]) ?? [];
    this.core.ctx.events.publish(
      'access.limits.changed',
      { roleId: done.role_id, roleKey: role?.key ?? '', actionKeys: diffs.map((c) => c.actionKey), limitChangeId: done.id, effectiveFrom: iso(done.effective_from) },
      { actor: SYSTEM_ACTOR },
    );
    await this.core.audit(
      {
        action: 'access.limits.apply',
        actionLabel: 'Approval limits took effect',
        target: role ? this.roles.roleTarget(role) : { type: 'role', id: done.role_id },
        relatedTargets: [{ type: 'limit_change', id: done.id }],
        before: diffs.map((d) => ({ actionKey: d.actionKey, value: d.before })),
        after: diffs.map((d) => ({ actionKey: d.actionKey, value: d.after })),
        reason: done.reason,
        approvalRequestId: done.approval_request_id,
      },
      { actor: SYSTEM_ACTOR },
    );
  }
}
