/**
 * Policies with numbered versions and effective dates: drafts, the policy owner's approval and the
 * Business Owner's final approval (through access), scheduling with notice (short notice needs
 * approval), taking effect, the version in force at any moment, and the Help admin overview.
 */
import { AppError } from '../../../kernel/errors/index.js';
import type { EventPayload } from '../../../kernel/events/index.js';
import { newId } from '../../../kernel/lib/ids.js';
import { pageOf, type PageRequest } from '../../../kernel/lib/pagination.js';
import type * as common from '../../../spec/common.js';
import type { ContentListItem, HelpSummary, LinkRef, PolicyApproval, PolicyDiff, PolicySummary, PolicyVersion, PolicyVersionInput, PolicyVersionRef, StorePolicy } from '../../../spec/content.js';
import { contentTables, diffHtml, isValidVersionLabel, nextMinorVersion, sanitizeHtml } from '../domain/rules.js';
import { policyVersionMachine } from '../domain/state-machines.js';
import type { PolicyApprovalRow, PolicyRow, PolicyVersionRow } from '../ports.js';
import { actorFromKey, actorKey, invalid, iso, notFound, requireText, SYSTEM, type By } from './base.js';
import { ContentHelp, HELPFUL_WINDOW_DAYS } from './help.js';

type State = PolicyVersion['state'];
type PolicyKind = PolicySummary['kind'];

export const POLICY_KINDS: readonly PolicyKind[] = ['returns', 'shipping', 'privacy', 'purchase_terms', 'seller_rules', 'advertising', 'cookies', 'other'];
/** A policy key is the URL slug: lowercase letters, digits, - and _ */
const POLICY_KEY = /^[a-z0-9](?:[a-z0-9_-]{0,58}[a-z0-9])?$/;
const APPROVE_ACTION = 'content.policies.approve';
const SHORT_NOTICE_ACTION = 'content.policies.short-notice';
const SHORT_NOTICE_NOTE = 'Short notice';
/** States of versions that are or were published (orders may reference them) */
const PUBLISHED: readonly string[] = ['scheduled', 'current', 'superseded'];
const OPEN: readonly string[] = ['draft', 'in_review', 'approved'];
const ORDERS_NOTE = 'Orders keep the terms accepted at purchase: your order details link to the version that applied when you ordered.';

export interface PolicyBy extends By {
  can?: (permission: string) => Promise<boolean>;
}

export class ContentPolicies extends ContentHelp {
  /* ---------------------------------------------------------------- reads */

  private async policyOrThrow(id: string): Promise<PolicyRow> {
    const p = await this.repo.getPolicy(id);
    if (!p) throw notFound('Policy');
    return p;
  }

  private async versionOrThrow(id: string): Promise<PolicyVersionRow> {
    const v = await this.repo.getPolicyVersion(id);
    if (!v) throw notFound('Policy version');
    return v;
  }

  protected refOf(key: string, v: PolicyVersionRow): PolicyVersionRef {
    return { policyKey: key, versionId: v.id, version: v.version, effectiveAt: (v.effective_at ?? v.created_at).toISOString() };
  }

  /** The version in force at a moment: published, effective at or before it, the latest such */
  protected inForce(versions: PolicyVersionRow[], at: Date): PolicyVersionRow | undefined {
    return versions
      .filter((v) => PUBLISHED.includes(v.state) && v.effective_at && v.effective_at <= at)
      .sort((a, b) => b.effective_at!.getTime() - a.effective_at!.getTime() || b.created_at.getTime() - a.created_at.getTime())[0];
  }

  private upcomingOf(versions: PolicyVersionRow[], now: Date): PolicyVersionRow | undefined {
    return versions.filter((v) => v.state === 'scheduled' && v.effective_at && v.effective_at > now).sort((a, b) => a.effective_at!.getTime() - b.effective_at!.getTime())[0];
  }

  private openOf(versions: PolicyVersionRow[]): PolicyVersionRow | undefined {
    return versions.filter((v) => OPEN.includes(v.state)).sort((a, b) => b.created_at.getTime() - a.created_at.getTime())[0];
  }

  /** The version this one replaces (for diffs and "previous version" links) */
  private previousOf(versions: PolicyVersionRow[], v: PolicyVersionRow): PolicyVersionRow | undefined {
    if (v.effective_at && PUBLISHED.includes(v.state)) {
      const before = versions.filter((x) => x.id !== v.id && PUBLISHED.includes(x.state) && x.effective_at && x.effective_at < v.effective_at!);
      return before.sort((a, b) => b.effective_at!.getTime() - a.effective_at!.getTime())[0];
    }
    return this.inForce(versions, this.now()) ?? versions.filter((x) => x.id !== v.id && x.state !== 'withdrawn' && x.created_at <= v.created_at).at(-1);
  }

  private async policySummaries(policies: PolicyRow[], opts: { store?: boolean } = {}): Promise<PolicySummary[]> {
    const versions = await this.repo.policyVersionsOf(policies.map((p) => p.id));
    const now = this.now();
    const owners = opts.store ? [] : await this.owners(policies.flatMap((p) => [{ staffId: p.owner_staff_id, role: 'Policy owner' }, { staffId: p.editor_staff_id, role: 'Editor' }]));
    return policies.map((p, i) => {
      const mine = versions.filter((v) => v.policy_id === p.id);
      const current = this.inForce(mine, now);
      const scheduled = this.upcomingOf(mine, now);
      const draft = opts.store ? undefined : this.openOf(mine);
      return {
        id: p.id,
        key: p.key,
        kind: p.kind as PolicyKind,
        title: p.title,
        owner: opts.store ? { staffId: null, name: 'Marketly', role: 'Policy owner' } : owners[i * 2]!,
        editor: opts.store || !p.editor_staff_id ? null : owners[i * 2 + 1]!,
        current: current ? this.refOf(p.key, current) : null,
        scheduled: scheduled ? this.refOf(p.key, scheduled) : null,
        draft: draft ? this.refOf(p.key, draft) : null,
      };
    });
  }

  protected async policyVersionOut(v: PolicyVersionRow, policy?: PolicyRow): Promise<PolicyVersion> {
    const p = policy ?? (await this.repo.getPolicy(v.policy_id))!;
    const approvals = await this.repo.approvalsOf([v.id]);
    const access = this.ctx.use('access');
    const approval = v.approval_request_id
      ? await this.soft('access.approvalInfo', () => access.approvalInfo(v.approval_request_id!), { required: true, reason: null, approvalRequestId: v.approval_request_id, approvers: ['Business Owner'] } as common.ApprovalInfo)
      : null;
    return {
      id: v.id,
      policyId: p.id,
      policyKey: p.key,
      title: v.title,
      version: v.version,
      state: v.state as State,
      body: v.body,
      tables: v.tables ? contentTables(v.tables) : null,
      effectiveAt: iso(v.effective_at),
      changeSummary: v.change_summary,
      impact: v.impact as PolicyVersion['impact'],
      notifyCustomers: v.notify_customers,
      notifySellers: v.notify_sellers,
      approvals: approvals.map(
        (a): PolicyApproval => ({ role: a.role as PolicyApproval['role'], reviewer: a.reviewer_id ? actorFromKey(a.reviewer_id) : null, state: a.state as PolicyApproval['state'], at: iso(a.at), note: a.note }),
      ),
      approval,
      createdBy: actorFromKey(v.created_by),
      createdAt: v.created_at.toISOString(),
      publishedAt: iso(v.published_at),
    };
  }

  async listPoliciesAdmin(): Promise<PolicySummary[]> {
    return this.policySummaries(await this.repo.listPolicies());
  }

  async listPolicyVersionsAdmin(policyId: string): Promise<PolicyVersion[]> {
    const p = await this.policyOrThrow(policyId);
    const versions = await this.repo.policyVersionsOf([p.id]);
    return Promise.all([...versions].reverse().map((v) => this.policyVersionOut(v, p)));
  }

  async getPolicyVersionAdmin(id: string): Promise<PolicyVersion> {
    return this.policyVersionOut(await this.versionOrThrow(id));
  }

  /** Exact text of a version, e.g. for order details and disputes */
  async getPolicyVersion(versionId: string): Promise<PolicyVersion> {
    return this.policyVersionOut(await this.versionOrThrow(versionId));
  }

  /** Policy versions in effect at a moment (checkout and orders store these ids) */
  async currentPolicyVersions(keys: string[], at?: string): Promise<PolicyVersionRef[]> {
    const when = at ? new Date(at) : this.now();
    const policies = (await this.repo.listPolicies()).filter((p) => keys.includes(p.key));
    const versions = await this.repo.policyVersionsOf(policies.map((p) => p.id));
    const out: PolicyVersionRef[] = [];
    for (const key of keys) {
      const p = policies.find((x) => x.key === key);
      const v = p && this.inForce(versions.filter((x) => x.policy_id === p.id), when);
      if (p && v) out.push(this.refOf(key, v));
    }
    return out;
  }

  async diffPolicyVersion(id: string): Promise<PolicyDiff> {
    const v = await this.versionOrThrow(id);
    const versions = await this.repo.policyVersionsOf([v.policy_id]);
    const prev = this.previousOf(versions, v);
    return { fromVersion: prev?.version ?? '', toVersion: v.version, html: diffHtml(prev?.body ?? '', v.body), changeSummary: v.change_summary };
  }

  /* ---------------------------------------------------------------- store */

  async listPublicPolicies(): Promise<PolicySummary[]> {
    const all = await this.policySummaries(await this.repo.listPolicies(), { store: true });
    return all.filter((p) => p.current || p.scheduled);
  }

  private async storePolicy(p: PolicyRow, v: PolicyVersionRow, versions: PolicyVersionRow[]): Promise<StorePolicy> {
    const now = this.now();
    const prev = this.previousOf(versions, v);
    const isNow = this.inForce(versions, now)?.id === v.id;
    const upcoming = isNow ? this.upcomingOf(versions, now) : undefined;
    const owner = await this.soft('access.getStaffRef', () => this.ctx.use('access').getStaffRef(p.owner_staff_id), null);
    const others = await this.policySummaries((await this.repo.listPolicies()).filter((x) => x.id !== p.id), { store: true });
    return {
      key: p.key,
      title: v.title,
      version: v.version,
      effectiveAt: (v.effective_at ?? v.created_at).toISOString(),
      body: sanitizeHtml(v.body),
      tables: v.tables ? contentTables(v.tables) : null,
      previousVersion: prev && PUBLISHED.includes(prev.state) ? this.refOf(p.key, prev) : null,
      upcoming: upcoming ? this.refOf(p.key, upcoming) : null,
      upcomingSummary: upcoming?.change_summary ?? null,
      ordersNote: ORDERS_NOTE,
      owner: owner?.roleLabel ?? 'Marketly',
      siblings: others.filter((o) => o.current).map((o): LinkRef => ({ label: o.title, url: `/policies/${o.key}`, kind: 'policy' })),
    };
  }

  async getPublicPolicy(key: string, at?: string | null): Promise<StorePolicy> {
    const p = await this.repo.policyByKey(key);
    if (!p) throw notFound('Policy');
    const versions = await this.repo.policyVersionsOf([p.id]);
    const v = this.inForce(versions, at ? new Date(at) : this.now());
    if (!v) throw notFound('Policy version');
    return this.storePolicy(p, v, versions);
  }

  async listPublicPolicyVersions(key: string): Promise<PolicyVersionRef[]> {
    const p = await this.repo.policyByKey(key);
    if (!p) return [];
    const now = this.now();
    return (await this.repo.policyVersionsOf([p.id]))
      .filter((v) => PUBLISHED.includes(v.state) && v.effective_at && v.effective_at <= now)
      .sort((a, b) => b.effective_at!.getTime() - a.effective_at!.getTime())
      .map((v) => this.refOf(p.key, v));
  }

  async getPublicPolicyVersion(id: string): Promise<StorePolicy> {
    const v = await this.repo.getPolicyVersion(id);
    if (!v || !PUBLISHED.includes(v.state)) throw notFound('Policy version');
    const p = (await this.repo.getPolicy(v.policy_id))!;
    return this.storePolicy(p, v, await this.repo.policyVersionsOf([p.id]));
  }

  /* ---------------------------------------------------------------- writes */

  async createPolicy(body: { key: string; kind?: PolicyKind | null; title: string; ownerStaffId: string; editorStaffId?: string | null; audience: 'customer' | 'seller' | 'both' }, by: By): Promise<PolicySummary> {
    const key = body.key?.trim() ?? '';
    if (key.length < 2 || !POLICY_KEY.test(key)) throw invalid('key', 'Use 2–60 lowercase letters, digits, - or _ (it is the policy URL)');
    if (body.kind != null && !POLICY_KINDS.includes(body.kind)) throw invalid('kind', `Use one of ${POLICY_KINDS.join(', ')}`);
    const kind: PolicyKind = body.kind ?? (POLICY_KINDS.includes(key as PolicyKind) ? (key as PolicyKind) : 'other');
    const title = requireText(body.title, 'title', 'A policy needs a title');
    if (await this.repo.policyByKey(key)) throw new AppError('CONFLICT', `The ${key} policy already exists`);
    const row = await this.repo.insertPolicy({ id: newId(), key, kind, title, owner_staff_id: body.ownerStaffId, editor_staff_id: body.editorStaffId ?? null, audience: body.audience });
    await this.audit({ action: 'content.policy.create', actionLabel: 'Created policy', target: { type: 'policy', id: row.id, ref: key, label: title }, after: row }, by);
    return (await this.policySummaries([row]))[0]!;
  }

  async createPolicyVersion(policyId: string, body: { version?: string | null }, by: By): Promise<PolicyVersion> {
    const p = await this.policyOrThrow(policyId);
    const versions = await this.repo.policyVersionsOf([p.id]);
    const open = this.openOf(versions);
    if (open) throw this.ctx.error('DRAFT_EXISTS', `Version ${open.version} is still open (${open.state.replace('_', ' ')})`, { versionId: open.id });
    let label = body.version?.trim();
    if (label) {
      if (!isValidVersionLabel(label)) throw invalid('version', 'Use a version number such as 3.1');
      if (versions.some((v) => v.version === label)) throw new AppError('CONFLICT', `Version ${label} already exists`);
    } else label = nextMinorVersion(versions.map((v) => v.version));
    const source = this.inForce(versions, this.now()) ?? versions.filter((v) => v.state !== 'withdrawn').at(-1);
    const row = await this.repo.insertPolicyVersion({
      id: newId(),
      policy_id: p.id,
      version: label,
      state: policyVersionMachine.initial,
      title: source?.title ?? p.title,
      body: source?.body ?? '',
      tables: (source?.tables ?? null) as never,
      effective_at: null,
      change_summary: null,
      impact: 'new_orders_only',
      notify_customers: false,
      notify_sellers: false,
      approval_request_id: null,
      created_by: actorKey(by.actor),
      created_at: this.now(),
      published_at: null,
    });
    await this.audit({ action: 'content.policy.version.create', actionLabel: `Started ${p.title} version ${label}`, target: { type: 'policy_version', id: row.id, ref: `${p.key} ${label}`, label: p.title } }, by);
    return this.policyVersionOut(row, p);
  }

  async updatePolicyVersion(id: string, input: PolicyVersionInput, by: By): Promise<PolicyVersion> {
    const v = await this.versionOrThrow(id);
    if (v.state !== 'draft') throw new AppError('ILLEGAL_TRANSITION', 'Only a draft version can be edited; approved versions are never changed', { from: v.state, event: 'edit' });
    const body = sanitizeHtml(requireText(input.body, 'body', 'The policy needs its text'));
    if (input.impact === 'extend_open_orders' && !(input.changeSummary ?? v.change_summary)?.trim()) throw invalid('changeSummary', 'Explain how the change favors customers before extending it to open orders');
    const after = await this.repo.transaction(async (tx) => {
      const locked = await tx.getPolicyVersion(id, { forUpdate: true });
      if (!locked || locked.state !== 'draft') throw new AppError('CONFLICT', 'The version changed while you were editing it');
      return tx.updatePolicyVersion(id, {
        title: input.title?.trim() || locked.title,
        body,
        tables: (input.tables ? contentTables(input.tables) : input.tables === null ? null : locked.tables) as never,
        effective_at: input.effectiveAt ? new Date(input.effectiveAt) : input.effectiveAt === null ? null : locked.effective_at,
        change_summary: input.changeSummary !== undefined ? input.changeSummary?.trim() || null : locked.change_summary,
        impact: input.impact ?? locked.impact,
        notify_customers: input.notifyCustomers ?? locked.notify_customers,
        notify_sellers: input.notifySellers ?? locked.notify_sellers,
      });
    });
    const p = (await this.repo.getPolicy(v.policy_id))!;
    await this.audit({ action: 'content.policy.version.update', actionLabel: `Edited ${p.title} version ${v.version}`, target: { type: 'policy_version', id, ref: `${p.key} ${v.version}`, label: p.title }, before: { ...v, body: undefined }, after: { ...after, body: undefined }, beforeText: v.body, afterText: after.body }, by);
    return this.policyVersionOut(after, p);
  }

  async submitPolicyVersion(id: string, by: By): Promise<PolicyVersion> {
    const v = await this.versionOrThrow(id);
    const state = policyVersionMachine.next(v.state as State, 'submit');
    const p = (await this.repo.getPolicy(v.policy_id))!;
    if (!v.body.trim()) throw invalid('body', 'The policy needs its text');
    const versions = await this.repo.policyVersionsOf([p.id]);
    const hasPublished = versions.some((x) => x.id !== v.id && PUBLISHED.includes(x.state));
    if (hasPublished && !v.change_summary?.trim()) throw invalid('changeSummary', 'Summarize what changes from the current version');
    const after = await this.repo.transaction(async (tx) => {
      await tx.deleteApprovals(id);
      for (const role of ['policy_owner', 'business_owner']) await tx.insertApproval({ id: newId(), policy_version_id: id, role, reviewer_id: null, state: 'waiting', note: null, at: null });
      return tx.updatePolicyVersion(id, { state, approval_request_id: null });
    });
    this.ctx.events.publish('content.policy.submitted', { policyVersionId: id, policyKey: p.key }, { actor: by.actor, requestId: by.requestId });
    await this.audit({ action: 'content.policy.version.submit', actionLabel: `Sent ${p.title} version ${v.version} for approval`, target: { type: 'policy_version', id, ref: `${p.key} ${v.version}`, label: p.title } }, by);
    return this.policyVersionOut(after, p);
  }

  private approvalTarget(p: PolicyRow, v: PolicyVersionRow) {
    return { type: 'policy_version', id: v.id, ref: `${p.key} v${v.version}`, label: `${p.title} ${v.version}`, screen: 'admin/help-content' };
  }

  /** Policy owner approval; the Business Owner's final approval is an access approval request */
  async approvePolicyVersion(id: string, body: { approve: boolean; note?: string | null }, by: PolicyBy): Promise<PolicyVersion> {
    const v = await this.versionOrThrow(id);
    const p = (await this.repo.getPolicy(v.policy_id))!;
    policyVersionMachine.next(v.state as State, body.approve ? 'approve' : 'requestChanges');
    const callerId = this.staffIdOf(by);
    if (callerId !== p.owner_staff_id && !(await by.can?.('content.policies.manage'))) throw new AppError('FORBIDDEN', 'Only the policy owner approves this policy', { permission: 'content.policies.approve' });
    const approvals = await this.repo.approvalsOf([id]);
    const ownerRow = approvals.find((a) => a.role === 'policy_owner');
    const boRow = approvals.find((a) => a.role === 'business_owner');
    if (body.approve && ownerRow?.state === 'approved') throw new AppError('ILLEGAL_TRANSITION', 'The policy owner already approved; waiting for the Business Owner', { from: v.state, event: 'approve' });
    const now = this.now();
    const access = this.ctx.use('access');

    if (!body.approve) {
      const note = requireText(body.note, 'note', 'Say what needs to change');
      if (v.approval_request_id) await this.soft('access.cancelApproval', () => access.cancelApproval(v.approval_request_id!, by.actor, 'Changes requested by the policy owner'), undefined);
      const after = await this.repo.transaction(async (tx) => {
        await this.upsertApproval(tx, id, ownerRow, 'policy_owner', { reviewer_id: actorKey(by.actor), state: 'changes_requested', note, at: now });
        await this.upsertApproval(tx, id, boRow, 'business_owner', { reviewer_id: null, state: 'waiting', note: null, at: null });
        return tx.updatePolicyVersion(id, { state: policyVersionMachine.next(v.state as State, 'requestChanges'), approval_request_id: null });
      });
      await this.audit({ action: 'content.policy.version.request-changes', actionLabel: `Requested changes to ${p.title} ${v.version}`, target: this.approvalTarget(p, v), reason: note }, by);
      return this.policyVersionOut(after, p);
    }

    if (!by.principal) throw new AppError('FORBIDDEN', 'Sign in as staff to approve');
    // the owner step was decided above (permission + ownership); access only says whether the caller also
    // finishes the Business Owner step: allowed → one step, approval_required or denied → an approval request.
    // An owner is never refused here because of access limits (a Content Manager owner has none).
    const check = await access.check(by.principal, APPROVE_ACTION);
    let requestId: string | null = null;
    if (check.decision !== 'allowed') {
      const req = await access.requestApproval({
        action: APPROVE_ACTION,
        target: this.approvalTarget(p, v),
        summary: `${p.title} version ${v.version}`,
        details: { policyKey: p.key, version: v.version, changeSummary: v.change_summary, impact: v.impact, effectiveAt: iso(v.effective_at) },
        reason: v.change_summary || `New version ${v.version} of ${p.title}`,
        requestedBy: by.principal,
      });
      requestId = req.id;
    }
    let after: PolicyVersionRow;
    try {
      after = await this.repo.transaction(async (tx) => {
        const locked = await tx.getPolicyVersion(id, { forUpdate: true });
        if (!locked || locked.state !== 'in_review') throw new AppError('CONFLICT', 'The version changed while it was being approved');
        await this.upsertApproval(tx, id, ownerRow, 'policy_owner', { reviewer_id: actorKey(by.actor), state: 'approved', note: body.note?.trim() || null, at: now });
        if (!requestId) {
          await this.upsertApproval(tx, id, boRow, 'business_owner', { reviewer_id: actorKey(by.actor), state: 'approved', note: check.reason || 'Within authority', at: now });
          return tx.updatePolicyVersion(id, { state: policyVersionMachine.next(locked.state as State, 'approve') });
        }
        return tx.updatePolicyVersion(id, { approval_request_id: requestId });
      });
    } catch (err) {
      if (requestId) await this.soft('access.cancelApproval', () => access.cancelApproval(requestId!, by.actor, 'The policy version could not be approved'), undefined);
      throw err;
    }
    await this.audit(
      { action: 'content.policy.version.approve', actionLabel: requestId ? `Policy owner approved ${p.title} ${v.version}; sent to the Business Owner` : `Approved ${p.title} ${v.version}`, target: this.approvalTarget(p, v), approvalRequestId: requestId, approvalNote: requestId ? null : check.reason, reason: body.note ?? null },
      by,
    );
    return this.policyVersionOut(after, p);
  }

  private async upsertApproval(tx: { insertApproval(r: PolicyApprovalRow): Promise<void>; updateApproval(id: string, p: Partial<PolicyApprovalRow>): Promise<void> }, versionId: string, existing: PolicyApprovalRow | undefined, role: string, patch: Partial<PolicyApprovalRow>) {
    if (existing) await tx.updateApproval(existing.id, patch);
    else await tx.insertApproval({ id: newId(), policy_version_id: versionId, role, reviewer_id: null, state: 'waiting', note: null, at: null, ...patch });
  }

  /** Publishes an approved version with its effective date; short notice for customers needs the Business Owner */
  async schedulePolicyVersion(id: string, body: { effectiveAt: string }, by: By): Promise<PolicyVersion> {
    const v = await this.versionOrThrow(id);
    const p = (await this.repo.getPolicy(v.policy_id))!;
    policyVersionMachine.next(v.state as State, 'schedule');
    const effectiveAt = new Date(body.effectiveAt);
    const now = this.now();
    if (effectiveAt.getTime() < now.getTime() - 60_000) throw invalid('effectiveAt', 'The effective date has passed');
    const versions = await this.repo.policyVersionsOf([p.id]);
    const isChange = versions.some((x) => x.id !== v.id && PUBLISHED.includes(x.state));
    const noticeDays = await this.ctx.settings.get('policyNoticeDays');
    const customerFacing = p.audience !== 'seller';
    const shortNotice = customerFacing && isChange && effectiveAt.getTime() < now.getTime() + noticeDays * 86_400_000;
    const access = this.ctx.use('access');
    if (shortNotice) {
      if (!by.principal) throw new AppError('FORBIDDEN', 'Sign in as staff to schedule');
      const check = await access.check(by.principal, SHORT_NOTICE_ACTION);
      if (check.decision === 'denied') throw new AppError('FORBIDDEN', check.reason || 'You cannot schedule a policy change on short notice');
      if (check.decision === 'approval_required') {
        if (v.approval_request_id) await this.soft('access.cancelApproval', () => access.cancelApproval(v.approval_request_id!, by.actor, 'Replaced by a new effective date'), undefined);
        const req = await access.requestApproval({
          action: SHORT_NOTICE_ACTION,
          target: this.approvalTarget(p, v),
          summary: `${p.title} ${v.version} effective ${effectiveAt.toISOString().slice(0, 10)} (less than ${noticeDays} days notice)`,
          details: { policyKey: p.key, version: v.version, effectiveAt: effectiveAt.toISOString(), noticeDays },
          reason: v.change_summary || `Short-notice change to ${p.title}`,
          requestedBy: by.principal,
          dueAt: effectiveAt.toISOString(),
        });
        const after = await this.repo.transaction(async (tx) => {
          const existing = (await tx.approvalsOf([id])).find((a) => a.role === 'business_owner' && a.note?.startsWith(SHORT_NOTICE_NOTE));
          await this.upsertApproval(tx, id, existing, 'business_owner', { reviewer_id: null, state: 'waiting', note: `${SHORT_NOTICE_NOTE}: effective ${effectiveAt.toISOString()}`, at: null });
          return tx.updatePolicyVersion(id, { approval_request_id: req.id, effective_at: effectiveAt });
        });
        await this.audit({ action: 'content.policy.version.schedule', actionLabel: `Asked the Business Owner to approve short notice for ${p.title} ${v.version}`, target: this.approvalTarget(p, v), approvalRequestId: req.id, after: { effectiveAt: effectiveAt.toISOString() } }, by);
        return this.policyVersionOut(after, p);
      }
    }
    return this.policyVersionOut(await this.scheduleNow(v, p, effectiveAt, by), p);
  }

  private async scheduleNow(v: PolicyVersionRow, p: PolicyRow, effectiveAt: Date, by: By): Promise<PolicyVersionRow> {
    const now = this.now();
    const after = await this.repo.transaction(async (tx) => {
      const locked = (await tx.getPolicyVersion(v.id, { forUpdate: true }))!;
      return tx.updatePolicyVersion(v.id, { state: policyVersionMachine.next(locked.state as State, 'schedule'), effective_at: effectiveAt, published_at: now });
    });
    this.ctx.events.publish(
      'content.policy.scheduled',
      { policyVersionId: v.id, policyKey: p.key, version: v.version, effectiveAt: effectiveAt.toISOString(), changeSummary: v.change_summary, notifyCustomers: v.notify_customers, notifySellers: v.notify_sellers },
      { actor: by.actor, requestId: by.requestId },
    );
    await this.logAction('policy_version', v.id, 'schedule', by, effectiveAt.toISOString());
    await this.audit({ action: 'content.policy.version.schedule', actionLabel: `Scheduled ${p.title} ${v.version}`, target: this.approvalTarget(p, v), before: { state: v.state }, after: { state: after.state, effectiveAt: effectiveAt.toISOString() } }, by);
    if (effectiveAt <= now) await this.policyEffective();
    return (await this.repo.getPolicyVersion(v.id))!;
  }

  async withdrawPolicyVersion(id: string, body: { reason: string }, by: By): Promise<PolicyVersion> {
    const reason = requireText(body.reason, 'reason', 'Say why the version is withdrawn');
    const v = await this.versionOrThrow(id);
    const state = policyVersionMachine.next(v.state as State, 'withdraw');
    const p = (await this.repo.getPolicy(v.policy_id))!;
    if (v.approval_request_id && (v.state === 'in_review' || v.state === 'approved')) {
      await this.soft('access.cancelApproval', () => this.ctx.use('access').cancelApproval(v.approval_request_id!, by.actor, reason), undefined);
    }
    const after = await this.repo.updatePolicyVersion(id, { state });
    await this.logAction('policy_version', id, 'withdraw', by, reason);
    await this.audit({ action: 'content.policy.version.withdraw', actionLabel: `Withdrew ${p.title} ${v.version}`, target: this.approvalTarget(p, v), reason, before: { state: v.state }, after: { state } }, by);
    return this.policyVersionOut(after, p);
  }

  /* ---------------------------------------------------------------- approvals and the effective-date job */

  /** access.approval.decided: the Business Owner's final approval, or a short-notice schedule */
  async onApprovalDecidedFromAccess(event: EventPayload<'access.approval.decided'>): Promise<void> {
    if (event.actionKey !== APPROVE_ACTION && event.actionKey !== SHORT_NOTICE_ACTION) return;
    const v = await this.repo.policyVersionByApproval(event.requestId);
    if (!v) {
      this.ctx.log.info({ requestId: event.requestId }, 'content: approval decision for an unknown policy version');
      return;
    }
    const p = (await this.repo.getPolicy(v.policy_id))!;
    const by: By = { actor: event.decidedBy ?? SYSTEM.actor };
    const reviewer = event.decidedBy ? actorKey(event.decidedBy) : null;
    const now = this.now();
    const approvals = await this.repo.approvalsOf([v.id]);
    if (event.actionKey === APPROVE_ACTION) {
      if (v.state !== 'in_review') return; // already handled
      const bo = approvals.find((a) => a.role === 'business_owner' && !a.note?.startsWith(SHORT_NOTICE_NOTE));
      const approved = event.outcome === 'approved';
      await this.repo.transaction(async (tx) => {
        await this.upsertApproval(tx, v.id, bo, 'business_owner', { reviewer_id: reviewer, state: approved ? 'approved' : 'changes_requested', note: event.reason ?? (approved ? null : `Approval ${event.outcome}`), at: now });
        await tx.updatePolicyVersion(v.id, { state: policyVersionMachine.next('in_review', approved ? 'approve' : 'requestChanges'), ...(approved ? {} : { approval_request_id: null }) });
      });
      await this.audit({ action: `content.policy.version.${approved ? 'final-approval' : 'final-approval-declined'}`, actionLabel: approved ? `Business Owner approved ${p.title} ${v.version}` : `Business Owner did not approve ${p.title} ${v.version}`, target: this.approvalTarget(p, v), approvalRequestId: event.requestId, reason: event.reason ?? null }, by);
      return;
    }
    // short notice
    if (v.state !== 'approved') return;
    const row = approvals.find((a) => a.role === 'business_owner' && a.note?.startsWith(SHORT_NOTICE_NOTE));
    if (event.outcome === 'approved' && v.effective_at) {
      if (row) await this.repo.updateApproval(row.id, { reviewer_id: reviewer, state: 'approved', at: now });
      await this.scheduleNow(v, p, v.effective_at, by);
    } else {
      if (row) await this.repo.updateApproval(row.id, { reviewer_id: reviewer, state: 'changes_requested', at: now, note: `${SHORT_NOTICE_NOTE}: ${event.reason ?? event.outcome}` });
      await this.repo.updatePolicyVersion(v.id, { approval_request_id: null });
      await this.audit({ action: 'content.policy.version.short-notice-declined', actionLabel: `Short notice not approved for ${p.title} ${v.version}`, target: this.approvalTarget(p, v), approvalRequestId: event.requestId, reason: event.reason ?? null }, by);
    }
  }

  /** Job content.policy-effective: scheduled versions past their effective date become current; the previous one is superseded */
  async policyEffective(): Promise<void> {
    const now = this.now();
    for (const due of await this.repo.policyVersionsDue(now, 100)) {
      const res = await this.repo.transaction(async (tx) => {
        const v = await tx.getPolicyVersion(due.id, { forUpdate: true });
        if (!v || v.state !== 'scheduled' || !v.effective_at || v.effective_at > now) return null;
        const siblings = await tx.policyVersionsOf([v.policy_id]);
        const previous = siblings.filter((x) => x.state === 'current' && x.id !== v.id);
        for (const x of previous) await tx.updatePolicyVersion(x.id, { state: policyVersionMachine.next('current', 'supersede') });
        await tx.updatePolicyVersion(v.id, { state: policyVersionMachine.next('scheduled', 'takeEffect') });
        return { v, superseded: previous.at(-1) ?? null };
      });
      if (!res) continue;
      const p = (await this.repo.getPolicy(res.v.policy_id))!;
      this.ctx.events.publish('content.policy.effective', { policyVersionId: res.v.id, policyKey: p.key, version: res.v.version, supersededVersionId: res.superseded?.id ?? null }, { actor: SYSTEM.actor });
      await this.logAction('policy_version', res.v.id, 'take_effect', SYSTEM);
    }
  }

  /* ---------------------------------------------------------------- Help admin overview */

  async helpSummary(): Promise<HelpSummary> {
    const now = this.now();
    const [articles, categories, policies] = await Promise.all([this.repo.listArticles({}), this.repo.listCategories(), this.repo.listPolicies()]);
    const versions = await this.repo.policyVersionsOf(policies.map((p) => p.id));
    const published = articles.filter((a) => a.status === 'published');
    const needsReview = published.filter((a) => a.review_due_at && a.review_due_at <= now).length;
    const stats = await this.helpfulStats(null, new Date(now.getTime() - HELPFUL_WINDOW_DAYS * 86_400_000));
    return {
      publishedArticles: published.length,
      categories: categories.length,
      policies: policies.length,
      policiesScheduled: versions.filter((v) => v.state === 'scheduled').length,
      policiesDraft: versions.filter((v) => OPEN.includes(v.state)).length,
      articlesNeedingReview: needsReview,
      helpfulPct: stats.pct ?? 0,
      helpfulWindowDays: HELPFUL_WINDOW_DAYS,
      tabs: { all: articles.length + policies.length, articles: articles.length, policies: policies.length, needsReview },
    };
  }

  async listHelpContent(q: { type?: 'policy' | 'article'; categoryId?: string; status?: string; q?: string; needsReview?: boolean }, page: PageRequest): Promise<common.Page<ContentListItem>> {
    const now = this.now();
    const text = q.q?.trim().toLowerCase();
    const items: (ContentListItem & { sort: number })[] = [];
    if (q.type !== 'article' && !q.categoryId && !q.needsReview) {
      const policies = await this.repo.listPolicies();
      const versions = await this.repo.policyVersionsOf(policies.map((p) => p.id));
      const owners = await this.owners(policies.map((p) => ({ staffId: p.owner_staff_id, role: 'Policy owner' })));
      policies.forEach((p, i) => {
        const mine = versions.filter((v) => v.policy_id === p.id);
        const v = this.openOf(mine) ?? this.upcomingOf(mine, now) ?? this.inForce(mine, now) ?? mine.at(-1);
        items.push({ id: p.id, title: p.title, type: 'policy', category: 'Policies', owner: owners[i]!, status: v?.state ?? 'no_version', effectiveAt: iso(v?.effective_at), version: v?.version ?? '', editUrl: `/admin/help-content/policies/${p.id}`, sort: (v?.created_at ?? now).getTime() });
      });
    }
    if (q.type !== 'policy') {
      const [articles, cats] = await Promise.all([this.repo.listArticles({ categoryId: q.categoryId, reviewDueBefore: q.needsReview ? now : undefined, statuses: q.needsReview ? ['published'] : undefined }), this.repo.listCategories()]);
      const names = new Map(cats.map((c) => [c.id, c.name]));
      const versions = new Map((await this.repo.getVersions(articles.flatMap((a) => [a.draft_version_id, a.live_version_id].filter((x): x is string => Boolean(x))))).map((v) => [v.id, v]));
      const owners = await this.owners(articles.map((a) => ({ staffId: a.owner_staff_id })));
      articles.forEach((a, i) => {
        const v = versions.get(a.draft_version_id ?? '') ?? versions.get(a.live_version_id ?? '');
        items.push({ id: a.id, title: a.title, type: 'article', category: names.get(a.category_id) ?? '', owner: owners[i]!, status: a.status, effectiveAt: iso(a.effective_at), version: v ? `v${v.number}` : '', editUrl: `/admin/help-content/articles/${a.id}`, sort: a.updated_at.getTime() });
      });
    }
    const statuses = q.status ? q.status.split(',').map((s) => s.trim()) : null;
    const filtered = items.filter((it) => (!statuses || statuses.includes(it.status)) && (!text || it.title.toLowerCase().includes(text))).sort((a, b) => b.sort - a.sort);
    const res = pageOf(filtered, page);
    return { ...res, items: res.items.map(({ sort, ...it }) => (void sort, it)) };
  }
}
