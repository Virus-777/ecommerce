/**
 * Away periods and coverage: who receives a role's work while its lead is away, away periods (with delegated
 * approvals) and the coverage screen.
 */
import { SYSTEM_ACTOR } from '../../../kernel/auth/index.js';
import { zonedDayRange } from '../../../kernel/lib/clock.js';
import { AppError } from '../../../kernel/errors/index.js';
import { newId } from '../../../kernel/lib/ids.js';
import type { PageRequest } from '../../../kernel/lib/pagination.js';
import type * as common from '../../../spec/common.js';
import type {
  AwayInput,
  AwayPeriod,
  Coverage,
  CoverageGap,
  RecipientResolution,
  RoleCoverage,
} from '../../../spec/access.js';
import { loadDirectory, loadStaffDirectory, type Directory, type StaffDirectory } from '../directory.js';
import type { Issue } from '../domain/limits.js';
import { awayPeriodMachine } from '../domain/state-machines.js';
import type { AwayRow, RoleRow } from '../ports.js';
import { type Core, type Caller, DELEGATIONS, FINAL, iso, uniq, roleRef, validation, notFound } from './core.js';
import type { Approvals } from './approvals.js';
import type { Members } from './members.js';

export class AwayPeriods {
  constructor(readonly core: Core) {}

  private get approvals(): Approvals {
    return this.core.parts.approvals;
  }

  private get members(): Members {
    return this.core.parts.members;
  }

  /** Who receives a role's work and notices right now: lead, or the covering backup while the lead is away (the lead keeps a copy) */
  async resolveRecipients(roleKey: string): Promise<RecipientResolution> {
    await this.core.ready();
    const dir = await loadStaffDirectory(this.core.repo, this.core.now());
    const role = dir.roleByKey.get(roleKey);
    if (!role) return { roleKey, leadAccountId: null, accountIds: [], ccAccountIds: [], viaBackup: false, escalationRoleKey: null };
    const unavailable = await this.unavailableAccounts(this.routingCandidates(role.id, dir));
    const r = this.route(role, dir, unavailable);
    return {
      roleKey,
      leadAccountId: r.lead,
      accountIds: r.receiving,
      ccAccountIds: r.viaBackup && r.lead ? [r.lead] : [],
      viaBackup: r.viaBackup,
      escalationRoleKey: role.escalation_role_id ? (dir.roleById.get(role.escalation_role_id)?.key ?? null) : null,
    };
  }

  /** Leads, backups and who receives each role's work today (GET /coverage without gaps), for the admin dashboard */
  async coverageNow(filter: { workArea?: string }): Promise<RoleCoverage[]> {
    await this.core.ready();
    const dir = await loadStaffDirectory(this.core.repo, this.core.now());
    return (await this.coverageOfRoles(dir)).roles.filter((r) => !filter?.workArea || r.workArea === filter.workArea);
  }

  async listAwayPeriods(query: { accountId?: string; status?: AwayPeriod['status']; from?: string; to?: string }, page: PageRequest): Promise<common.Page<AwayPeriod>> {
    await this.core.ready();
    const now = this.core.now();
    const rows = await this.core.repo.pageAway(
      {
        ...(query.accountId ? { accountId: query.accountId } : {}),
        ...(query.status ? { statuses: [query.status] } : !query.from && !query.to ? { statuses: ['pending_approval', 'scheduled', 'active'], endsAfter: now } : {}),
        ...(query.from ? { from: zonedDayRange(query, this.core.ctx.config.market.timeZone).start } : {}),
        ...(query.to ? { to: zonedDayRange(query, this.core.ctx.config.market.timeZone).end } : {}),
      },
      page,
    );
    const dir = await loadDirectory(this.core.repo, now);
    return { ...rows, items: await this.awayViews(rows.items, dir) };
  }

  async createAwayPeriod(caller: Caller, input: AwayInput): Promise<AwayPeriod> {
    await this.core.ready();
    const me = caller.principal.accountId ?? '';
    const accountId = input.accountId ?? me;
    if (accountId !== me && !(await this.core.can(caller, 'access.away.manage'))) throw new AppError('FORBIDDEN', 'Planning time away for someone else needs access.away.manage', { permission: 'access.away.manage' });
    const now = this.core.now();
    const from = new Date(input.from);
    const to = new Date(input.to);
    const issues: Issue[] = [];
    if (!(to > from)) issues.push({ path: 'to', message: 'Must be after the start' });
    if (to <= now) issues.push({ path: 'to', message: 'Must be in the future' });
    if (issues.length) throw validation('The away period is not valid', issues);

    const dir = await loadDirectory(this.core.repo, now);
    const coverIssues: Issue[] = [];
    const heldRoles = dir.rolesOf(accountId);
    const leads = (rid: string) => dir.coverage.get(rid)?.lead === accountId;
    input.coverage.forEach((c, i) => {
      const role = dir.roleById.get(c.roleId);
      if (!role || !heldRoles.some((r) => r.id === c.roleId)) coverIssues.push({ path: `coverage.${i}.roleId`, message: 'Not a role of the person who is away' });
      else if (c.coveredByAccountId === accountId) coverIssues.push({ path: `coverage.${i}.coveredByAccountId`, message: 'Someone else must cover' });
      else if (leads(c.roleId) && !dir.holds(c.coveredByAccountId, c.roleId) && !dir.isBusinessOwner(c.coveredByAccountId)) coverIssues.push({ path: `coverage.${i}.coveredByAccountId`, message: `The lead's cover must hold ${role.name} (or be Business Owner)` });
      else if (!dir.rolesOf(c.coveredByAccountId).length) coverIssues.push({ path: `coverage.${i}.coveredByAccountId`, message: 'Must be a staff member with a role' });
      if (input.coverage.findIndex((x) => x.roleId === c.roleId) !== i) coverIssues.push({ path: `coverage.${i}.roleId`, message: 'Listed twice' });
    });
    for (const [roleId, cov] of dir.coverage) {
      if (cov.lead === accountId && !input.coverage.some((c) => c.roleId === roleId)) {
        coverIssues.push({ path: 'coverage', message: `${dir.roleById.get(roleId)?.name ?? 'A role'} is led by this person and needs cover` });
      }
    }
    if (coverIssues.length) throw new AppError('COVERAGE_INVALID', 'Every role this person leads needs cover by someone holding it', { issues: coverIssues });
    const overlapping = await this.core.repo.findAway({ accountId, statuses: ['pending_approval', 'scheduled', 'active'], from, to });
    if (overlapping.length) throw new AppError('AWAY_OVERLAP', 'This person already has an away period in that time', { awayPeriodId: overlapping[0]!.id });

    const id = newId();
    let approvalRequestId: string | null = null;
    const name = (await this.core.accounts([accountId])).get(accountId)?.displayName ?? 'staff member';
    if (input.delegateApprovals) {
      const req = await this.approvals.openRequest(
        {
          action: DELEGATIONS,
          target: { type: 'away_period', id, label: `Time away of ${name}`, screen: 'admin/staff' },
          summary: `Delegate approval authority while ${name} is away (${input.from.slice(0, 10)} to ${input.to.slice(0, 10)})`,
          details: { accountId, from: iso(from), to: iso(to), coverage: input.coverage },
          reason: input.reason ?? 'Time away',
          requestedBy: caller.principal,
          dueAt: from > now ? iso(from) : null,
        },
        { restrictToBusinessOwner: true, requestedByActor: caller.actor, requestId: caller.requestId },
      );
      approvalRequestId = req.id;
    }
    let row = await this.core.repo.insertAway(
      {
        id,
        account_id: accountId,
        starts_at: from,
        ends_at: to,
        status: input.delegateApprovals ? 'pending_approval' : awayPeriodMachine.initial,
        delegate_approvals: input.delegateApprovals,
        reason: input.reason ?? null,
        approval_request_id: approvalRequestId,
        created_by_kind: caller.actor.kind,
        created_by_id: caller.actor.id ?? '',
        created_at: now,
        ended_at: null,
      },
      input.coverage.map((c) => ({ away_period_id: id, role_id: c.roleId, covered_by_account_id: c.coveredByAccountId })),
    );
    if (row.status === 'scheduled' && from <= now) row = (await this.startAway(id)) ?? row;
    await this.core.audit(
      { action: 'access.away.create', actionLabel: 'Planned time away', target: { type: 'away_period', id, label: `Time away of ${name}` }, relatedTargets: [{ type: 'staff', id: accountId, label: name }], after: { from: iso(from), to: iso(to), coverage: input.coverage, delegateApprovals: input.delegateApprovals }, reason: input.reason ?? null, approvalRequestId },
      caller,
    );
    return (await this.awayViews([row], await loadDirectory(this.core.repo, this.core.now())))[0]!;
  }

  async endAwayPeriod(caller: Caller, id: string): Promise<AwayPeriod> {
    await this.core.ready();
    const row = await this.core.repo.getAway(id);
    if (!row) throw notFound('Away period');
    await this.members.requireOwnOrManage(caller, row);
    if (row.status === 'scheduled' && row.starts_at <= this.core.now()) await this.startAway(id);
    const current = (await this.core.repo.getAway(id))!;
    awayPeriodMachine.next(current.status as never, 'end');
    const after = (await this.finishAway(id))!;
    await this.core.audit({ action: 'access.away.end', actionLabel: 'Ended time away early', target: { type: 'away_period', id }, before: { status: row.status }, after: { status: after.status } }, caller);
    return (await this.awayViews([after], await loadDirectory(this.core.repo, this.core.now())))[0]!;
  }

  async cancelAwayPeriod(caller: Caller, id: string, reason: string | null | undefined): Promise<AwayPeriod> {
    await this.core.ready();
    const row = await this.core.repo.getAway(id);
    if (!row) throw notFound('Away period');
    await this.members.requireOwnOrManage(caller, row);
    const after = await this.core.repo.transaction(async (tx) => {
      const locked = await tx.getAway(id, { forUpdate: true });
      const status = awayPeriodMachine.next(locked!.status as never, 'cancel');
      return tx.updateAway(id, { status, ...(reason ? { reason } : {}) });
    });
    if (after.approval_request_id) {
      const req = await this.core.repo.getRequest(after.approval_request_id);
      if (req && !FINAL.has(req.status)) await this.approvals.closeRequest(req.id, 'cancel', caller.actor, reason ?? 'Away period cancelled');
    }
    await this.core.audit({ action: 'access.away.cancel', actionLabel: 'Cancelled time away', target: { type: 'away_period', id }, before: { status: row.status }, after: { status: after.status }, reason: reason ?? null }, caller);
    return (await this.awayViews([after], await loadDirectory(this.core.repo, this.core.now())))[0]!;
  }

  async getCoverage(): Promise<Coverage> {
    await this.core.ready();
    return this.coverageOfRoles(await loadStaffDirectory(this.core.repo, this.core.now()));
  }

  async awayViews(rows: AwayRow[], dir: Directory): Promise<AwayPeriod[]> {
    if (!rows.length) return [];
    const coverage = await this.core.repo.awayCoverage(rows.map((r) => r.id));
    const refs = await this.core.staffRefs(uniq([...rows.map((r) => r.account_id), ...coverage.map((c) => c.covered_by_account_id)]), dir);
    const requests = await this.core.repo.findRequests({ ids: uniq(rows.map((r) => r.approval_request_id).filter((x): x is string => Boolean(x))) });
    const infos = new Map((await this.approvals.approvalInfos(requests, dir)).map((i) => [i.approvalRequestId!, i]));
    return rows.map((r) => ({
      id: r.id,
      account: refs.get(r.account_id)!,
      from: iso(r.starts_at),
      to: iso(r.ends_at),
      status: r.status as AwayPeriod['status'],
      coverage: coverage
        .filter((c) => c.away_period_id === r.id)
        .map((c) => ({ role: dir.roleById.get(c.role_id) ? roleRef(dir.roleById.get(c.role_id)!) : { id: c.role_id, key: 'unknown', name: 'Unknown role' }, coveredBy: refs.get(c.covered_by_account_id)! })),
      delegateApprovals: r.delegate_approvals,
      approval: r.approval_request_id ? (infos.get(r.approval_request_id) ?? null) : null,
      reason: r.reason,
      createdBy: { kind: r.created_by_kind as common.Actor['kind'], id: r.created_by_id || null },
      createdAt: iso(r.created_at),
    }));
  }

  private routingCandidates(roleId: string, dir: StaffDirectory): string[] {
    const cov = dir.coverage.get(roleId);
    return uniq([...(cov?.lead ? [cov.lead] : []), ...(cov?.backups ?? []), ...dir.membersOf(roleId), ...dir.away.flatMap((a) => a.coverage.filter((c) => c.role_id === roleId).map((c) => c.covered_by_account_id))]);
  }

  /** Who receives a role's work now: the lead, else (lead away or locked) the person covering the role, the first available backup, or any available member */
  private route(role: RoleRow, dir: StaffDirectory, unavailable: Set<string>): { lead: string | null; receiving: string[]; viaBackup: boolean; leadAwayUntil: Date | null } {
    const cov = dir.coverage.get(role.id);
    const lead = cov?.lead ?? null;
    const available = (acc: string) => !unavailable.has(acc) && !dir.awayOf(acc);
    const members = dir.membersOf(role.id).filter(available);
    if (lead && available(lead)) return { lead, receiving: [lead], viaBackup: false, leadAwayUntil: null };
    const leadAway = lead ? dir.awayOf(lead) : undefined;
    if (lead) {
      const covering = dir.away.find((a) => a.period.account_id === lead)?.coverage.find((c) => c.role_id === role.id)?.covered_by_account_id;
      const next = (covering && available(covering) ? covering : undefined) ?? (cov?.backups ?? []).find(available) ?? members.find((m) => m !== lead);
      return { lead, receiving: next ? [next] : [], viaBackup: true, leadAwayUntil: leadAway?.ends_at ?? null };
    }
    const backup = (cov?.backups ?? []).find(available);
    return { lead: null, receiving: backup ? [backup] : members, viaBackup: false, leadAwayUntil: null };
  }

  async coverageOfRoles(dir: StaffDirectory, only?: string[]): Promise<Coverage> {
    const roles = this.core.sortRoles(dir.roles.filter((r) => !r.archived_at && (!only || only.includes(r.id))));
    const candidates = uniq(roles.flatMap((r) => this.routingCandidates(r.id, dir)));
    const accounts = await this.core.accounts(candidates);
    const unavailable = new Set([...accounts.values()].filter((a) => a.status === 'locked' || a.status === 'disabled' || a.status === 'closed').map((a) => a.id));
    const refs = await this.core.staffRefs(candidates, dir, accounts);
    const out: RoleCoverage[] = [];
    const gaps: CoverageGap[] = [];
    for (const role of roles) {
      const cov = dir.coverage.get(role.id) ?? { lead: null, backups: [] };
      const r = this.route(role, dir, unavailable);
      const esc = role.escalation_role_id ? dir.roleById.get(role.escalation_role_id) : undefined;
      out.push({
        role: roleRef(role),
        workArea: role.work_area,
        lead: cov.lead ? (refs.get(cov.lead) ?? null) : null,
        backups: cov.backups.map((id) => refs.get(id)!).filter(Boolean),
        receivingNow: r.receiving.map((id) => refs.get(id)!).filter(Boolean),
        viaBackup: r.viaBackup,
        leadAwayUntil: r.leadAwayUntil ? iso(r.leadAwayUntil) : null,
        escalationRole: esc ? roleRef(esc) : null,
      });
      const ref = (id: string) => refs.get(id)!;
      const holds = (acc: string) => dir.holds(acc, role.id) || dir.isBusinessOwner(acc);
      if (!cov.lead && dir.membersOf(role.id).length) gaps.push({ kind: 'no_lead', roles: [roleRef(role)], people: [], message: `${role.name} has no lead`, severity: 'review' });
      if (cov.lead && !cov.backups.length) gaps.push({ kind: 'no_backup', roles: [roleRef(role)], people: [ref(cov.lead)].filter(Boolean), message: `${role.name} has no backup`, severity: 'review' });
      const outside = [...(cov.lead ? [cov.lead] : []), ...cov.backups].filter((acc) => !holds(acc));
      if (outside.length) gaps.push({ kind: 'backup_not_in_role', roles: [roleRef(role)], people: outside.map(ref).filter(Boolean), message: `${outside.length === 1 ? 'Someone' : `${outside.length} people`} named as lead or backup no longer hold${outside.length === 1 ? 's' : ''} ${role.name}`, severity: 'critical' });
      if (cov.lead && !r.receiving.length) gaps.push({ kind: 'lead_and_backups_away', roles: [roleRef(role)], people: [cov.lead, ...cov.backups].map(ref).filter(Boolean), message: `Nobody receives ${role.name} work: the lead and backups are away or unavailable`, severity: 'critical' });
    }
    const backupOf = new Map<string, RoleRow[]>();
    const leadOf = new Map<string, RoleRow[]>();
    for (const role of roles) {
      const cov = dir.coverage.get(role.id);
      for (const b of cov?.backups ?? []) backupOf.set(b, [...(backupOf.get(b) ?? []), role]);
      if (cov?.lead) leadOf.set(cov.lead, [...(leadOf.get(cov.lead) ?? []), role]);
    }
    for (const [acc, rs] of backupOf) {
      if (rs.length > 1) gaps.push({ kind: 'shared_backup', roles: rs.map(roleRef), people: [refs.get(acc)!].filter(Boolean), message: `${refs.get(acc)?.name ?? 'One person'} is the backup for ${rs.length} roles`, severity: 'review' });
    }
    for (const [acc, rs] of leadOf) {
      if (rs.length > 2) gaps.push({ kind: 'one_person_leads_several', roles: rs.map(roleRef), people: [refs.get(acc)!].filter(Boolean), message: `${refs.get(acc)?.name ?? 'One person'} leads ${rs.length} roles`, severity: 'review' });
    }
    return { roles: out, gaps };
  }

  async rolesRoutedTo(accountId: string): Promise<string[]> {
    const coverage = await this.core.repo.listCoverage();
    return coverage.filter((c) => c.lead_account_id === accountId || ((c.backup_account_ids as string[]) ?? []).includes(accountId)).map((c) => c.role_id);
  }

  /** Announces who receives each role's work now (identity statuses may lag behind the event that triggered this) */
  async publishCoverageFor(roleIds: string[], forceUnavailable?: Set<string>, forceAvailable?: Set<string>) {
    if (!roleIds.length) return;
    const dir = await loadStaffDirectory(this.core.repo, this.core.now());
    for (const roleId of uniq(roleIds)) {
      const role = dir.roleById.get(roleId);
      if (!role) continue;
      const unavailable = await this.unavailableAccounts(this.routingCandidates(roleId, dir));
      for (const a of forceUnavailable ?? []) unavailable.add(a);
      for (const a of forceAvailable ?? []) unavailable.delete(a);
      const r = this.route(role, dir, unavailable);
      this.core.ctx.events.publish('access.coverage.changed', { roleId, roleKey: role.key, leadAccountId: r.lead, receivingAccountIds: r.receiving, viaBackup: r.viaBackup }, { actor: SYSTEM_ACTOR });
    }
  }

  publishCoverage(cov: RoleCoverage) {
    this.core.ctx.events.publish(
      'access.coverage.changed',
      { roleId: cov.role.id, roleKey: cov.role.key, leadAccountId: cov.lead?.accountId ?? null, receivingAccountIds: cov.receivingNow.map((s) => s.accountId), viaBackup: cov.viaBackup },
      { actor: SYSTEM_ACTOR },
    );
  }

  private async unavailableAccounts(ids: string[]): Promise<Set<string>> {
    const accounts = await this.core.accounts(ids);
    return new Set([...accounts.values()].filter((a) => a.status === 'locked' || a.status === 'disabled' || a.status === 'closed').map((a) => a.id));
  }

  async startAway(id: string): Promise<AwayRow | null> {
    const now = this.core.now();
    const row = await this.core.repo.transaction(async (tx) => {
      const p = await tx.getAway(id, { forUpdate: true });
      if (p?.status !== 'scheduled' || p.starts_at > now) return null;
      return tx.updateAway(id, { status: awayPeriodMachine.next('scheduled', 'start') });
    });
    if (!row) return null;
    const coverage = await this.core.repo.awayCoverage([id]);
    this.core.ctx.events.publish(
      'access.away.started',
      { awayPeriodId: id, accountId: row.account_id, until: iso(row.ends_at), coverage: coverage.map((c) => ({ roleId: c.role_id, coveredByAccountId: c.covered_by_account_id })), delegateApprovals: row.delegate_approvals },
      { actor: SYSTEM_ACTOR },
    );
    await this.publishCoverageFor(uniq([...(await this.rolesRoutedTo(row.account_id)), ...coverage.map((c) => c.role_id)]));
    if (row.ends_at <= now) return this.finishAway(id);
    return row;
  }

  async finishAway(id: string): Promise<AwayRow | null> {
    const row = await this.core.repo.transaction(async (tx) => {
      const p = await tx.getAway(id, { forUpdate: true });
      if (p?.status !== 'active') return null;
      return tx.updateAway(id, { status: awayPeriodMachine.next('active', 'end'), ended_at: this.core.now() });
    });
    if (!row) return null;
    const coverage = await this.core.repo.awayCoverage([id]);
    this.core.ctx.events.publish('access.away.ended', { awayPeriodId: id, accountId: row.account_id }, { actor: SYSTEM_ACTOR });
    await this.publishCoverageFor(uniq([...(await this.rolesRoutedTo(row.account_id)), ...coverage.map((c) => c.role_id)]));
    return row;
  }
}
