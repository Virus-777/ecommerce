/**
 * Return policies: the platform baseline with versions and effective dates, category exceptions (with
 * Business Owner approval when a window gets shorter), seller terms (never below the baseline) and the
 * effective terms resolved for an offer.
 */
import { AppError } from '../../../kernel/errors/index.js';
import type { EventPayload } from '../../../kernel/events/index.js';
import { isUuid, newId } from '../../../kernel/lib/ids.js';
import { OFFICIAL_STORE_ID } from '../../../spec/common.js';
import type * as common from '../../../spec/common.js';
import type * as catalog from '../../../spec/catalog.js';
import type * as settings from '../../../spec/settings.js';
import type {
  CategoryException,
  CategoryExceptionInput,
  EffectiveTerms,
  PolicyImpactInput,
  PolicyVersion,
  PolicyVersionInput,
  PublicPolicy,
  ReturnPolicyAdmin,
  SellerReturnTerms,
  SellerReturnTermsInput,
  ShippingResponsibility,
} from '../../../spec/returns.js';
import { categoryExceptionMachine, policyVersionMachine } from '../domain/state-machines.js';
import { actorFrom, actorText, isEmail, isFault, nextVersion, reasonGroupOf, responsibilityFor, shortDate, shortensWindow, termsSummary, type WindowFacts } from '../domain/rules.js';
import type { CategoryExceptionRec, TermsRec } from '../ports.js';
import type { ReturnsRepository } from '../repository.js';
import { invalid, invalidField, notFound, SYSTEM, type Baseline, type By, type Core } from './core.js';

export const BASELINE_ACTION = 'returns.baseline.change';
export const SHORTEN_ACTION = 'returns.policies.shorten-window';
const FAULT_GROUPS = ['damaged', 'incorrect', 'defective', 'not_as_described', 'missing_parts', 'lost_in_transit'];

type PolicyStatus = PolicyVersion['status'];
type ExceptionStatus = CategoryException['status'];

/** Without catalog the category is shown by id */
export const categoryName = (id: string) => `Category ${id.slice(0, 8)}`;

export class Policies {
  constructor(private readonly core: Core) {}

  private get repo() {
    return this.core.repo;
  }

  /* ---------------------------------------------------------------- categories (catalog, optional) */

  /** Category paths from catalog (names and ancestors); empty without catalog */
  async categoryPaths(categoryIds: string[]): Promise<Record<string, catalog.CategoryPath>> {
    const ids = [...new Set(categoryIds.filter(isUuid))];
    if (!ids.length) return {};
    return (await this.core.soft('catalog', 'category paths', (c) => c.getCategoryPaths(ids))) ?? {};
  }

  /** The category's name (its path from catalog, e.g. Electronics › Audio › Headphones), or a short id without catalog */
  async categoryLabel(categoryId: string): Promise<string> {
    const path = (await this.categoryPaths([categoryId]))[categoryId];
    return path?.names.length ? path.names.join(' › ') : categoryName(categoryId);
  }

  /* ---------------------------------------------------------------- effective terms */

  /**
   * The active exception of a category now. With catalog an exception set on a parent category applies to
   * its subcategories (nearest exception wins); without catalog only the exact category matches.
   */
  async activeException(categoryId: string | null, at: Date = this.core.now()): Promise<CategoryExceptionRec | null> {
    if (!categoryId) return null;
    const path = (await this.categoryPaths([categoryId]))[categoryId];
    const chain = path?.ids.length ? [...path.ids].reverse() : [categoryId];
    if (!chain.includes(categoryId)) chain.unshift(categoryId);
    const rows = await this.repo.find('category_exceptions', { category_id: chain, status: 'active', effective_from: { op: '<=', value: at } }, { orderBy: [['effective_from', 'desc']] });
    const live = rows.filter((r) => !r.effective_to || r.effective_to.getTime() > at.getTime());
    for (const id of chain) {
      const hit = live.find((r) => r.category_id === id);
      if (hit) return hit;
    }
    return null;
  }

  /** Who pays return shipping per reason group, for a seller (null = Official Store) and its terms */
  responsibilities(base: ShippingResponsibility[], sellerId: string | null, terms: TermsRec | null): ShippingResponsibility[] {
    return base.map((r) => {
      if (!sellerId) return { ...r, paidBy: 'platform', customerFee: null, officialStoreRule: r.officialStoreRule ?? 'Free for every reason' };
      if (r.reasonGroup === 'change_of_mind' && terms && (terms.free_returns || terms.change_of_mind_paid_by === 'seller')) return { ...r, paidBy: 'seller', customerFee: null, note: 'Free returns from this seller' };
      return r;
    });
  }

  async resolveTerms(sellerIdIn: string | null, categoryId: string | null, condition: string | null, o: { baseline?: Baseline; terms?: TermsRec | null; at?: Date } = {}): Promise<EffectiveTerms> {
    void condition; // the offer's condition does not change the platform rules; category conditions come from the exception
    // OFFICIAL_STORE_ID is the Official Store like null: its terms are the baseline and category exceptions, never seller_terms
    const sellerId = sellerIdIn === OFFICIAL_STORE_ID ? null : sellerIdIn;
    if (!sellerId) o = { ...o, terms: null };
    const at = o.at ?? this.core.now();
    const [baseline, exception, terms] = await Promise.all([
      o.baseline ?? this.core.baseline(),
      this.activeException(categoryId, at),
      o.terms !== undefined ? Promise.resolve(o.terms) : sellerId ? this.core.sellerTerms(sellerId, o.at) : Promise.resolve(null),
    ]);
    const changeOfMindAllowed = exception ? exception.change_of_mind_allowed && (exception.window_days ?? 0) > 0 : true;
    let windowDays = exception ? (changeOfMindAllowed ? exception.window_days! : 0) : baseline.windowDays;
    if (changeOfMindAllowed && terms) windowDays = Math.max(windowDays, terms.window_days);
    const remedies: EffectiveTerms['remedies'] = sellerId ? ([...new Set(['refund', ...(terms?.remedies ?? ['replacement'])])] as EffectiveTerms['remedies']) : ['refund', 'replacement', 'exchange'];
    if (this.core.walletOn()) remedies.push('store_credit');
    const responsibilities = this.responsibilities(baseline.responsibilities, sellerId, terms);
    const free = !sellerId || responsibilities.find((r) => r.reasonGroup === 'change_of_mind')?.paidBy !== 'customer';
    return {
      sellerId: sellerId ?? OFFICIAL_STORE_ID,
      categoryId: categoryId ?? null,
      windowDays,
      changeOfMindAllowed,
      condition: exception?.condition ?? null,
      responsibilities,
      remedies,
      responseTargetBusinessDays: sellerId && terms ? Math.min(terms.response_target_business_days, baseline.sellerResponseBusinessDays) : baseline.sellerResponseBusinessDays,
      summary: termsSummary(windowDays, changeOfMindAllowed, free),
      policyVersion: baseline.version,
      policyVersionId: baseline.rec?.id ?? null,
      sellerTermsVersion: terms?.version ?? null,
      source: exception ? 'category_exception' : terms ? 'seller_terms' : 'baseline',
    };
  }

  /** Baseline window in force now: the active version, else the baselineWindowDays fallback (policyVersion null) */
  async defaultWindowDays(): Promise<{ windowDays: number; policyVersion: string | null }> {
    const b = await this.core.baseline();
    return { windowDays: b.windowDays, policyVersion: b.rec ? b.version : null };
  }

  async sellerReturnTermsFor(sellerIds: string[]): Promise<Record<string, EffectiveTerms>> {
    const baseline = await this.core.baseline();
    const out: Record<string, EffectiveTerms> = {};
    for (const id of [...new Set(sellerIds)]) out[id] = await this.resolveTerms(id, null, null, { baseline });
    return out;
  }

  /* ---------------------------------------------------------------- views */

  async approvalOf(requestId: string | null, fallbackReason: string): Promise<common.ApprovalInfo | null> {
    if (!requestId) return null;
    const info = await this.core.soft('access', 'approval info', (a) => a.approvalInfo(requestId));
    return info ?? { required: true, reason: fallbackReason, approvalRequestId: requestId, approvers: ['Business Owner'] };
  }

  async exceptionView(r: CategoryExceptionRec): Promise<CategoryException> {
    return {
      id: r.id,
      categoryId: r.category_id,
      categoryName: await this.categoryLabel(r.category_id),
      windowDays: r.window_days,
      changeOfMindAllowed: r.change_of_mind_allowed,
      condition: r.condition,
      faultReturnsWindowDays: r.fault_returns_window_days,
      shownOn: r.shown_on as CategoryException['shownOn'],
      effectiveFrom: r.effective_from.toISOString(),
      effectiveTo: r.effective_to?.toISOString() ?? null,
      applyScope: r.apply_scope as CategoryException['applyScope'],
      status: r.status as ExceptionStatus,
      approval: r.status === 'pending_approval' ? await this.approvalOf(r.approval_request_id, 'Shortens a return window') : null,
      reason: r.reason,
      createdBy: actorFrom(r.created_by),
    };
  }

  async policyView(b: Baseline, exceptions: CategoryException[] = []): Promise<PolicyVersion> {
    const r = b.rec;
    const effectiveFrom = b.effectiveFrom?.toISOString() ?? null;
    return {
      id: b.id,
      version: b.version,
      status: b.status as PolicyStatus,
      windowDays: b.windowDays,
      sellerResponseBusinessDays: b.sellerResponseBusinessDays,
      infoReplyDays: b.infoReplyDays,
      dropOffDays: b.dropOffDays,
      inspectionTargetBusinessDays: b.inspectionTargetBusinessDays,
      refundTargetBusinessDays: b.refundTargetBusinessDays,
      responsibilities: b.responsibilities,
      categoryExceptions: exceptions,
      effectiveFrom,
      changeReason: r?.change_reason ?? null,
      impact: effectiveFrom ? `Orders placed before ${shortDate(effectiveFrom, this.core.tz)} keep the return terms accepted at purchase` : null,
      approval: r && b.status === 'pending_approval' ? await this.approvalOf(r.approval_request_id, 'Baseline changes need Business Owner approval') : null,
      createdBy: actorFrom(r?.created_by) ?? SYSTEM,
      createdAt: (r?.created_at ?? new Date(0)).toISOString(),
    };
  }

  private async liveExceptions(): Promise<CategoryException[]> {
    const rows = await this.repo.find('category_exceptions', { status: ['active', 'scheduled', 'pending_approval'] }, { orderBy: [['effective_from', 'asc']] });
    return Promise.all(rows.map((r) => this.exceptionView(r)));
  }

  async publicPolicy(): Promise<PublicPolicy> {
    const b = await this.core.baseline();
    const active = await this.repo.find('category_exceptions', { status: 'active' }, { orderBy: [['effective_from', 'asc']] });
    const now = this.core.now();
    const views = await Promise.all(active.filter((r) => !r.effective_to || r.effective_to.getTime() > now.getTime()).map((r) => this.exceptionView(r)));
    const nextException = (await this.repo.find('category_exceptions', { status: 'scheduled' }, { orderBy: [['effective_from', 'asc']], limit: 1 }))[0];
    const nextBaseline = (await this.repo.find('policy_versions', { status: 'scheduled' }, { orderBy: [['effective_from', 'asc']], limit: 1 }))[0];
    const upcoming = [
      nextBaseline?.effective_from && { at: nextBaseline.effective_from, text: `${nextBaseline.window_days}-day returns from ${shortDate(nextBaseline.effective_from, this.core.tz)}` },
      nextException && {
        at: nextException.effective_from,
        text: `${await this.categoryLabel(nextException.category_id)} ${nextException.change_of_mind_allowed && nextException.window_days ? `${nextException.window_days} days` : 'final sale'} from ${shortDate(nextException.effective_from, this.core.tz)}`,
      },
    ].filter(Boolean) as { at: Date; text: string }[];
    upcoming.sort((a, c) => a.at.getTime() - c.at.getTime());
    return {
      version: b.version,
      effectiveFrom: (b.effectiveFrom ?? new Date(0)).toISOString(),
      windowDays: b.windowDays,
      responsibilities: b.responsibilities,
      categoryExceptions: views,
      refundStatuses: ['Requested', 'Under review', 'Approved (the money has not been sent yet)', 'Processing', 'Sent'],
      platformStepsIn: [
        `The seller does not respond within ${b.sellerResponseBusinessDays} business days`,
        'The seller rejects a return you think is covered',
        'The seller does not inspect or refund on time',
        'The refund is late',
      ],
      upcomingChange: upcoming[0]?.text ?? null,
    };
  }

  async policyAdmin(): Promise<ReturnPolicyAdmin> {
    const [current, exceptions, rows] = await Promise.all([this.core.baseline(), this.liveExceptions(), this.repo.find('policy_versions', {}, { orderBy: [['created_at', 'desc']] })]);
    const upcoming = rows.filter((r) => ['draft', 'pending_approval', 'scheduled'].includes(r.status));
    const history = rows.filter((r) => ['superseded', 'withdrawn'].includes(r.status));
    return {
      active: await this.policyView(current, exceptions),
      upcoming: await Promise.all(upcoming.map((r) => this.policyView(this.core.baselineOf(r)))),
      history: await Promise.all(history.map((r) => this.policyView(this.core.baselineOf(r)))),
    };
  }

  /* ---------------------------------------------------------------- baseline versions */

  private validateBaseline(i: PolicyVersionInput) {
    const issues: { path: string; message: string }[] = [];
    const days = (k: keyof PolicyVersionInput, min: number) => {
      const v = i[k] as number;
      if (!Number.isInteger(v) || v < min || v > 365) issues.push({ path: k, message: `Enter ${min} to 365 days` });
    };
    days('windowDays', 1);
    days('sellerResponseBusinessDays', 1);
    days('infoReplyDays', 1);
    days('dropOffDays', 1);
    days('inspectionTargetBusinessDays', 1);
    days('refundTargetBusinessDays', 1);
    const seen = new Set<string>();
    i.responsibilities.forEach((r, n) => {
      if (seen.has(r.reasonGroup)) issues.push({ path: `responsibilities.${n}.reasonGroup`, message: 'Each reason group once' });
      seen.add(r.reasonGroup);
      if (FAULT_GROUPS.includes(r.reasonGroup) && r.paidBy === 'customer') issues.push({ path: `responsibilities.${n}.paidBy`, message: 'Customers never pay return shipping for damaged, wrong or defective items' });
    });
    if (Number.isNaN(new Date(i.effectiveFrom).getTime())) issues.push({ path: 'effectiveFrom', message: 'Enter a valid date' });
    if (!i.reason?.trim()) issues.push({ path: 'reason', message: 'Say why the baseline changes' });
    if (issues.length) throw invalid(issues);
  }

  async proposeBaseline(input: PolicyVersionInput, by: By): Promise<PolicyVersion> {
    this.validateBaseline(input);
    const id = newId();
    const versions = (await this.repo.find('policy_versions', {})).map((r) => r.version);
    const version = nextVersion(versions);
    const effectiveFrom = new Date(input.effectiveFrom);
    const decision = await this.authority(BASELINE_ACTION, by, {
      target: { type: 'return_policy', id, ref: `Returns baseline ${version}`, label: `Returns baseline ${version}`, screen: 'admin/returns-policy' },
      summary: `Returns baseline ${version}: ${input.windowDays}-day window from ${shortDate(effectiveFrom, this.core.tz)}`,
      reason: input.reason,
      details: { ...input },
      dueAt: effectiveFrom.toISOString(),
    });
    let status: PolicyStatus = policyVersionMachine.next('draft', 'submit');
    if (decision.allowed) status = policyVersionMachine.next(status, 'approve');
    const row = await this.repo
      .insert('policy_versions', {
        id,
        version,
        status,
        window_days: input.windowDays,
        seller_response_business_days: input.sellerResponseBusinessDays,
        info_reply_days: input.infoReplyDays,
        drop_off_days: input.dropOffDays,
        inspection_target_business_days: input.inspectionTargetBusinessDays,
        refund_target_business_days: input.refundTargetBusinessDays,
        responsibilities: input.responsibilities,
        effective_from: effectiveFrom,
        change_reason: input.reason.trim(),
        approval_request_id: decision.requestId,
        created_by: actorText(by.actor),
        created_at: this.core.now(),
      })
      .catch(async (err) => {
        if (decision.requestId) await this.core.soft('access', 'cancel approval', (a) => a.cancelApproval(decision.requestId!, by.actor, 'The baseline could not be saved'));
        throw err;
      });
    this.core.publish('returns.policy.proposed', { policyVersionId: id, categoryExceptionId: null, effectiveFrom: effectiveFrom.toISOString() }, by);
    await this.core.audit(
      {
        action: 'returns.baseline.propose',
        actionLabel: decision.allowed ? `Scheduled returns baseline ${version}` : `Proposed returns baseline ${version} for Business Owner approval`,
        category: 'settings',
        target: { type: 'return_policy', id, ref: version, label: `Returns baseline ${version}`, screen: 'admin/returns-policy' },
        after: input,
        reason: input.reason,
        approvalRequestId: decision.requestId,
        approvalNote: decision.allowed ? decision.note : null,
      },
      by,
    );
    if (status === 'scheduled' && effectiveFrom.getTime() <= this.core.now().getTime()) await this.activateDue();
    return this.policyView(this.core.baselineOf((await this.repo.get('policy_versions', row.id))!));
  }

  async withdrawBaseline(id: string, reason: string, by: By): Promise<PolicyVersion> {
    if (!reason?.trim()) throw invalidField('reason', 'Say why the baseline is withdrawn');
    const { before, after } = await this.repo.transaction(async (tx) => {
      const before = await tx.get('policy_versions', id, { forUpdate: true });
      if (!before) throw notFound('Baseline version');
      const status = policyVersionMachine.next(before.status as PolicyStatus, 'withdraw');
      return { before, after: await tx.update('policy_versions', id, { status }) };
    });
    if (before.approval_request_id) await this.core.soft('access', 'cancel approval', (a) => a.cancelApproval(before.approval_request_id!, by.actor, 'Baseline withdrawn'));
    await this.core.audit(
      { action: 'returns.baseline.withdraw', actionLabel: `Withdrew returns baseline ${before.version}`, category: 'settings', target: { type: 'return_policy', id, ref: before.version, label: `Returns baseline ${before.version}` }, before: { status: before.status }, after: { status: after.status }, reason },
      by,
    );
    return this.policyView(this.core.baselineOf(after));
  }

  /* ---------------------------------------------------------------- category exceptions */

  /** The windows customers get in a category today (its active exception, else the baseline) */
  private async currentWindows(categoryId: string, baseline: Baseline, excludeId?: string): Promise<WindowFacts> {
    const ex = await this.activeException(categoryId);
    if (ex && ex.id !== excludeId) return { windowDays: ex.window_days, changeOfMindAllowed: ex.change_of_mind_allowed, faultReturnsWindowDays: ex.fault_returns_window_days };
    return { windowDays: baseline.windowDays, changeOfMindAllowed: true, faultReturnsWindowDays: baseline.windowDays };
  }

  private validateException(i: CategoryExceptionInput, baseline: Baseline) {
    const issues: { path: string; message: string }[] = [];
    if (i.changeOfMindAllowed && (!Number.isInteger(i.windowDays) || (i.windowDays ?? 0) < 1 || (i.windowDays ?? 0) > 365)) issues.push({ path: 'windowDays', message: 'Enter the change-of-mind window (1 to 365 days)' });
    if (!Number.isInteger(i.faultReturnsWindowDays) || i.faultReturnsWindowDays < baseline.windowDays) issues.push({ path: 'faultReturnsWindowDays', message: `Damaged, wrong or defective items keep at least the ${baseline.windowDays}-day baseline` });
    if (!i.condition?.trim()) issues.push({ path: 'condition', message: 'Describe the condition, e.g. Unopened and sealed' });
    if (!i.shownOn?.length) issues.push({ path: 'shownOn', message: 'Choose where the exception is shown' });
    const from = new Date(i.effectiveFrom);
    if (Number.isNaN(from.getTime())) issues.push({ path: 'effectiveFrom', message: 'Enter a valid date' });
    if (i.effectiveTo && new Date(i.effectiveTo).getTime() <= from.getTime()) issues.push({ path: 'effectiveTo', message: 'The end must be after the start' });
    if (!i.reason?.trim()) issues.push({ path: 'reason', message: 'Say why the exception changes' });
    if (issues.length) throw invalid(issues);
  }

  private facts(i: CategoryExceptionInput): WindowFacts {
    return { windowDays: i.changeOfMindAllowed ? (i.windowDays ?? null) : null, changeOfMindAllowed: i.changeOfMindAllowed, faultReturnsWindowDays: i.faultReturnsWindowDays };
  }

  /**
   * allowed: the caller may make the change now; otherwise an access approval request (when access is on).
   * Without access the change waits for approval with no request (approvals fall back to "needs approval").
   */
  private async authority(
    action: string,
    by: By,
    req: { target: { type: string; id: string; ref?: string; label?: string; screen?: string }; summary: string; reason: string; details?: unknown; dueAt?: string },
  ): Promise<{ allowed: boolean; requestId: string | null; note: string | null }> {
    const access = this.core.ctx.tryUse('access');
    if (!access || !by.principal) return { allowed: false, requestId: null, note: null };
    const check = await access.check(by.principal, action);
    if (check.decision === 'allowed') return { allowed: true, requestId: null, note: check.reason };
    const request = await access.requestApproval({ action, target: req.target, summary: req.summary, reason: req.reason, details: req.details ?? null, requestedBy: by.principal, dueAt: req.dueAt ?? null });
    return { allowed: false, requestId: request.id, note: null };
  }

  async createCategoryException(input: CategoryExceptionInput, by: By): Promise<CategoryException> {
    const baseline = await this.core.baseline();
    this.validateException(input, baseline);
    const shortens = shortensWindow(await this.currentWindows(input.categoryId, baseline), this.facts(input));
    const scope = input.applyScope ?? 'new_orders';
    if (shortens && scope === 'undelivered_orders') throw invalidField('applyScope', 'A change that shortens a window applies to new orders only; open orders keep what they accepted');
    const id = newId();
    const from = new Date(input.effectiveFrom);
    const decision = shortens
      ? await this.authority(SHORTEN_ACTION, by, {
          target: { type: 'category_exception', id, label: `${await this.categoryLabel(input.categoryId)} return exception`, screen: 'admin/returns-policy' },
          summary: `${await this.categoryLabel(input.categoryId)}: ${input.changeOfMindAllowed ? `${input.windowDays}-day returns` : 'final sale'} from ${shortDate(from, this.core.tz)}`,
          reason: input.reason,
          details: { ...input },
          dueAt: from.toISOString(),
        })
      : { allowed: true, requestId: null, note: 'Does not shorten a window' };
    const status: ExceptionStatus = decision.allowed ? 'scheduled' : 'pending_approval';
    await this.repo.insert('category_exceptions', {
      id,
      category_id: input.categoryId,
      window_days: input.changeOfMindAllowed ? (input.windowDays ?? null) : null,
      change_of_mind_allowed: input.changeOfMindAllowed,
      condition: input.condition.trim(),
      fault_returns_window_days: input.faultReturnsWindowDays,
      shown_on: input.shownOn,
      effective_from: from,
      effective_to: input.effectiveTo ? new Date(input.effectiveTo) : null,
      apply_scope: scope,
      status,
      approval_request_id: decision.requestId,
      reason: input.reason.trim(),
      created_by: actorText(by.actor),
      created_at: this.core.now(),
    });
    this.core.publish('returns.policy.proposed', { policyVersionId: null, categoryExceptionId: id, effectiveFrom: from.toISOString() }, by);
    await this.core.audit(
      {
        action: 'returns.category_exception.create',
        actionLabel: status === 'pending_approval' ? `Sent a ${await this.categoryLabel(input.categoryId)} return exception for approval` : `Scheduled a ${await this.categoryLabel(input.categoryId)} return exception`,
        category: 'settings',
        target: { type: 'category_exception', id, label: `${await this.categoryLabel(input.categoryId)} return exception`, screen: 'admin/returns-policy' },
        after: input,
        reason: input.reason,
        approvalRequestId: decision.requestId,
        approvalNote: decision.allowed ? decision.note : null,
      },
      by,
    );
    if (status === 'scheduled' && from.getTime() <= this.core.now().getTime()) await this.activateDue();
    return this.exceptionView((await this.repo.get('category_exceptions', id))!);
  }

  /**
   * Change or retire an exception. Not yet live (pending, scheduled, rejected): changed in place. Live: the
   * change starts from its effective date as a new exception and the current one ends then (a shortening
   * change only after approval). An effectiveTo with otherwise unchanged values retires it from that date.
   */
  async updateCategoryException(id: string, input: CategoryExceptionInput, by: By): Promise<CategoryException> {
    const current = await this.repo.get('category_exceptions', id);
    if (!current) throw notFound('Category exception');
    if (current.status === 'retired') throw new AppError('ILLEGAL_TRANSITION', 'This exception is retired; add a new one instead', { from: 'retired' });
    if (input.categoryId !== current.category_id) throw invalidField('categoryId', 'The category of an exception cannot change');
    const baseline = await this.core.baseline();
    this.validateException(input, baseline);
    const scope = input.applyScope ?? 'new_orders';
    const from = new Date(input.effectiveFrom);
    const to = input.effectiveTo ? new Date(input.effectiveTo) : null;
    const before = await this.exceptionView(current);

    if (current.status === 'active') {
      const same =
        input.changeOfMindAllowed === current.change_of_mind_allowed &&
        (input.changeOfMindAllowed ? input.windowDays : null) === current.window_days &&
        input.faultReturnsWindowDays === current.fault_returns_window_days &&
        input.condition.trim() === current.condition;
      if (same) {
        // retire from a date (or move the end date)
        const after = await this.repo.update('category_exceptions', id, { effective_to: to, shown_on: input.shownOn, reason: input.reason.trim() });
        if (to && to.getTime() <= this.core.now().getTime()) await this.retireDue();
        await this.core.audit(
          { action: 'returns.category_exception.update', actionLabel: to ? `Retires the ${await this.categoryLabel(current.category_id)} return exception` : `Changed the ${await this.categoryLabel(current.category_id)} return exception`, category: 'settings', target: { type: 'category_exception', id, label: `${await this.categoryLabel(current.category_id)} return exception` }, before, after: input, reason: input.reason },
          by,
        );
        return this.exceptionView((await this.repo.get('category_exceptions', after.id))!);
      }
      const replacement = await this.createCategoryException({ ...input, applyScope: scope }, by);
      if (replacement.status === 'scheduled' || replacement.status === 'active') {
        const end = new Date(Math.max(from.getTime(), this.core.now().getTime()));
        const live = await this.repo.get('category_exceptions', id);
        if (live && live.status === 'active' && (!live.effective_to || live.effective_to.getTime() > end.getTime())) await this.repo.update('category_exceptions', id, { effective_to: end });
        if (end.getTime() <= this.core.now().getTime()) await this.retireDue();
      }
      return replacement;
    }

    const shortens = shortensWindow(await this.currentWindows(current.category_id, baseline, id), this.facts(input));
    if (shortens && scope === 'undelivered_orders') throw invalidField('applyScope', 'A change that shortens a window applies to new orders only; open orders keep what they accepted');
    const decision = shortens
      ? await this.authority(SHORTEN_ACTION, by, {
          target: { type: 'category_exception', id, label: `${await this.categoryLabel(current.category_id)} return exception`, screen: 'admin/returns-policy' },
          summary: `${await this.categoryLabel(current.category_id)}: ${input.changeOfMindAllowed ? `${input.windowDays}-day returns` : 'final sale'} from ${shortDate(from, this.core.tz)}`,
          reason: input.reason,
          details: { ...input },
          dueAt: from.toISOString(),
        })
      : { allowed: true, requestId: null, note: 'Does not shorten a window' };
    if (current.approval_request_id && current.approval_request_id !== decision.requestId) await this.core.soft('access', 'cancel approval', (a) => a.cancelApproval(current.approval_request_id!, by.actor, 'Replaced by a new change'));
    const status: ExceptionStatus = decision.allowed ? 'scheduled' : 'pending_approval';
    await this.repo.update('category_exceptions', id, {
      window_days: input.changeOfMindAllowed ? (input.windowDays ?? null) : null,
      change_of_mind_allowed: input.changeOfMindAllowed,
      condition: input.condition.trim(),
      fault_returns_window_days: input.faultReturnsWindowDays,
      shown_on: input.shownOn,
      effective_from: from,
      effective_to: to,
      apply_scope: scope,
      status,
      approval_request_id: decision.requestId,
      reason: input.reason.trim(),
    });
    this.core.publish('returns.policy.proposed', { policyVersionId: null, categoryExceptionId: id, effectiveFrom: from.toISOString() }, by);
    await this.core.audit(
      { action: 'returns.category_exception.update', actionLabel: `Changed the ${await this.categoryLabel(current.category_id)} return exception`, category: 'settings', target: { type: 'category_exception', id, label: `${await this.categoryLabel(current.category_id)} return exception` }, before, after: input, reason: input.reason, approvalRequestId: decision.requestId },
      by,
    );
    if (status === 'scheduled' && from.getTime() <= this.core.now().getTime()) await this.activateDue();
    return this.exceptionView((await this.repo.get('category_exceptions', id))!);
  }

  async previewCategoryException(input: PolicyImpactInput, by: By): Promise<settings.ImpactPreview> {
    const e = input.exception;
    const baseline = await this.core.baseline();
    this.validateException(e, baseline);
    const from = new Date(e.effectiveFrom);
    const scope = e.applyScope ?? 'new_orders';
    const shortens = shortensWindow(await this.currentWindows(e.categoryId, baseline, input.exceptionId ?? undefined), this.facts(e));
    const name = await this.categoryLabel(e.categoryId);
    const items: settings.ImpactItem[] = [];
    const open = await this.core.quiet('open orders in category', () => this.core.ctx.use('orders').countOpenOrdersInCategory(e.categoryId, from.toISOString()));
    if (open) {
      items.push({
        module: 'orders',
        kind: 'orders',
        count: open.orders,
        message: scope === 'undelivered_orders' && !shortens ? `${open.orders.toLocaleString('en-US')} open ${name} orders move to the new terms` : `${open.orders.toLocaleString('en-US')} open ${name} orders keep their current return terms`,
        severity: 'info',
      });
    }
    items.push({ module: 'sellers', kind: 'sellers', message: `Sellers with offers in ${name} are notified before ${shortDate(from, this.core.tz)}`, severity: 'info', owner: 'Seller Support' });
    const help = await this.core.soft('content', 'help articles', (c) => c.countHelpArticlesForPolicy('returns'));
    if (help) items.push({ module: 'content', kind: 'content', count: help.count, message: `${help.count} Help article${help.count === 1 ? '' : 's'} mention the returns policy and may need an update`, severity: help.count ? 'warning' : 'info', owner: 'Content Manager', screen: 'admin/content' });
    items.push({ module: 'content', kind: 'content', message: `Update the Returns policy page before ${shortDate(from, this.core.tz)}; product pages and checkout change on that date`, severity: 'info', owner: 'Content Manager', screen: 'admin/content' });
    const blocking: string[] = [];
    if (shortens && scope === 'undelivered_orders') blocking.push('A change that shortens a window applies to new orders only');
    if (from.getTime() < this.core.now().getTime() - 60_000) blocking.push('The effective date has passed');
    let approvers: string[] = shortens ? ['Business Owner'] : [];
    if (shortens && by.principal) {
      const check = await this.core.soft('access', 'approvers', (a) => a.check(by.principal!, SHORTEN_ACTION));
      if (check?.eligibleApprovers?.length) approvers = check.eligibleApprovers.map((s) => s.name);
    }
    return { computedAt: this.core.now().toISOString(), items, blocking, needsApproval: shortens, approvalRule: shortens ? 'business_owner' : 'none', approvers };
  }

  /* ---------------------------------------------------------------- activation (job and inline) */

  /** Activates scheduled versions and exceptions whose time has come, retires ended exceptions */
  async activateDue(): Promise<void> {
    const now = this.core.now();
    const due = await this.repo.find('policy_versions', { status: 'scheduled', effective_from: { op: '<=', value: now } }, { orderBy: [['effective_from', 'asc']], limit: 50 });
    for (const v of due) {
      const done = await this.repo.transaction(async (tx) => {
        const locked = await tx.get('policy_versions', v.id, { forUpdate: true });
        if (!locked || locked.status !== 'scheduled') return false;
        for (const a of await tx.find('policy_versions', { status: 'active' }, { forUpdate: true })) await tx.update('policy_versions', a.id, { status: policyVersionMachine.next('active', 'supersede') });
        await tx.update('policy_versions', v.id, { status: policyVersionMachine.next('scheduled', 'activate') });
        return true;
      });
      if (done) this.core.publish('returns.policy.changed', { policyVersionId: v.id, categoryId: null, effectiveFrom: (v.effective_from ?? now).toISOString() });
    }
    const exceptions = await this.repo.find('category_exceptions', { status: 'scheduled', effective_from: { op: '<=', value: now } }, { orderBy: [['effective_from', 'asc']], limit: 100 });
    for (const x of exceptions) {
      const done = await this.repo.transaction(async (tx) => {
        const locked = await tx.get('category_exceptions', x.id, { forUpdate: true });
        if (!locked || locked.status !== 'scheduled') return false;
        for (const a of await tx.find('category_exceptions', { category_id: x.category_id, status: 'active' }, { forUpdate: true })) {
          await tx.update('category_exceptions', a.id, { status: categoryExceptionMachine.next('active', 'retire'), effective_to: a.effective_to && a.effective_to.getTime() < x.effective_from.getTime() ? a.effective_to : x.effective_from });
        }
        await tx.update('category_exceptions', x.id, { status: categoryExceptionMachine.next('scheduled', 'activate') });
        return true;
      });
      if (done) this.core.publish('returns.policy.changed', { policyVersionId: null, categoryId: x.category_id, effectiveFrom: x.effective_from.toISOString() });
    }
    await this.retireDue();
  }

  async retireDue(): Promise<void> {
    const now = this.core.now();
    const ended = await this.repo.find('category_exceptions', { status: ['active', 'scheduled'], effective_to: { op: '<=', value: now } }, { limit: 100 });
    for (const x of ended) await this.repo.update('category_exceptions', x.id, { status: categoryExceptionMachine.next(x.status as ExceptionStatus, 'retire') });
  }

  /** access.approval.decided for a baseline version or category exception */
  async onApprovalDecided(e: EventPayload<'access.approval.decided'>): Promise<boolean> {
    if ((e.actionKey === BASELINE_ACTION || e.actionKey === SHORTEN_ACTION) && !isUuid(e.target.id)) return true;
    if (e.actionKey === BASELINE_ACTION) {
      const v = await this.repo.get('policy_versions', e.target.id);
      if (!v || v.status !== 'pending_approval' || (v.approval_request_id && v.approval_request_id !== e.requestId)) return true;
      if (e.outcome === 'approved') await this.repo.update('policy_versions', v.id, { status: policyVersionMachine.next('pending_approval', 'approve') });
      else await this.repo.update('policy_versions', v.id, { status: policyVersionMachine.next('pending_approval', 'reject'), approval_request_id: null });
      if (e.outcome === 'approved') await this.activateDue();
      return true;
    }
    if (e.actionKey === SHORTEN_ACTION) {
      const x = await this.repo.get('category_exceptions', e.target.id);
      if (!x || x.status !== 'pending_approval' || (x.approval_request_id && x.approval_request_id !== e.requestId)) return true;
      if (e.outcome === 'approved') {
        await this.repo.update('category_exceptions', x.id, { status: categoryExceptionMachine.next('pending_approval', 'approve') });
        await this.activateDue();
      } else if (e.outcome === 'rejected') await this.repo.update('category_exceptions', x.id, { status: categoryExceptionMachine.next('pending_approval', 'reject') });
      else await this.repo.update('category_exceptions', x.id, { approval_request_id: null });
      return true;
    }
    return false;
  }

  /* ---------------------------------------------------------------- seller terms */

  private termsView(sellerId: string, t: TermsRec | null, baseline: PolicyVersion, b: Baseline): SellerReturnTerms {
    if (!t) {
      return {
        sellerId,
        version: 0,
        windowDays: b.windowDays,
        changeOfMindPaidBy: 'customer',
        freeReturns: false,
        remedies: ['refund', 'replacement'],
        returnAddress: { name: '', line1: '', city: '', region: '', postalCode: '', country: 'US' },
        returnContactEmail: null,
        receivingHours: null,
        responseTargetBusinessDays: b.sellerResponseBusinessDays,
        refundTargetDays: b.refundTargetBusinessDays,
        baseline,
        effectiveFrom: (b.effectiveFrom ?? new Date(0)).toISOString(),
        updatedAt: (b.effectiveFrom ?? new Date(0)).toISOString(),
      };
    }
    return {
      sellerId,
      version: t.version,
      windowDays: t.window_days,
      changeOfMindPaidBy: t.change_of_mind_paid_by as SellerReturnTerms['changeOfMindPaidBy'],
      freeReturns: t.free_returns,
      remedies: t.remedies as SellerReturnTerms['remedies'],
      returnAddress: t.return_address,
      returnContactEmail: t.return_contact_email,
      receivingHours: t.receiving_hours,
      responseTargetBusinessDays: t.response_target_business_days,
      refundTargetDays: t.refund_target_days,
      baseline,
      effectiveFrom: t.effective_from.toISOString(),
      updatedAt: t.effective_from.toISOString(),
    };
  }

  async getSellerTerms(sellerId: string): Promise<SellerReturnTerms> {
    const [b, t] = await Promise.all([this.core.baseline(), this.core.sellerTerms(sellerId)]);
    return this.termsView(sellerId, t, await this.policyView(b), b);
  }

  async updateSellerTerms(sellerId: string, input: SellerReturnTermsInput, by: By): Promise<SellerReturnTerms> {
    const b = await this.core.baseline();
    const below: { field: string; baseline: number; value: number }[] = [];
    if (input.windowDays < b.windowDays) below.push({ field: 'windowDays', baseline: b.windowDays, value: input.windowDays });
    if (input.responseTargetBusinessDays > b.sellerResponseBusinessDays) below.push({ field: 'responseTargetBusinessDays', baseline: b.sellerResponseBusinessDays, value: input.responseTargetBusinessDays });
    if (input.refundTargetDays > b.refundTargetBusinessDays) below.push({ field: 'refundTargetDays', baseline: b.refundTargetBusinessDays, value: input.refundTargetDays });
    if (below.length) throw this.core.error('POLICY_BELOW_BASELINE', `Your terms must be at least as generous as the Marketly baseline (${b.windowDays}-day returns)`, { fields: below });
    const issues: { path: string; message: string }[] = [];
    if (!input.remedies.includes('refund')) issues.push({ path: 'remedies', message: 'Refunds are always offered' });
    if (input.windowDays > 365) issues.push({ path: 'windowDays', message: 'At most 365 days' });
    if (input.responseTargetBusinessDays < 1) issues.push({ path: 'responseTargetBusinessDays', message: 'At least 1 business day' });
    if (input.refundTargetDays < 1) issues.push({ path: 'refundTargetDays', message: 'At least 1 day' });
    for (const k of ['name', 'line1', 'city', 'region', 'postalCode', 'country'] as const) if (!input.returnAddress[k]?.trim()) issues.push({ path: `returnAddress.${k}`, message: 'Required for return labels' });
    if (issues.length) throw invalid(issues);
    const now = this.core.now();
    const { before, after } = await this.repo.transaction(async (tx: ReturnsRepository) => {
      const current = (await tx.find('seller_terms', { seller_id: sellerId, superseded_at: null }, { orderBy: [['version', 'desc']], forUpdate: true }))[0] ?? null;
      const latest = (await tx.find('seller_terms', { seller_id: sellerId }, { orderBy: [['version', 'desc']], limit: 1 }))[0];
      if (current) await tx.update('seller_terms', current.id, { superseded_at: now });
      const after = await tx.insert('seller_terms', {
        id: newId(),
        seller_id: sellerId,
        version: (latest?.version ?? 0) + 1,
        window_days: input.windowDays,
        change_of_mind_paid_by: input.freeReturns ? 'seller' : input.changeOfMindPaidBy,
        free_returns: input.freeReturns,
        remedies: [...new Set(input.remedies)],
        return_address: input.returnAddress,
        return_contact_email: input.returnContactEmail ?? null,
        receiving_hours: input.receivingHours ?? null,
        response_target_business_days: input.responseTargetBusinessDays,
        refund_target_days: input.refundTargetDays,
        effective_from: now,
        superseded_at: null,
        created_by: actorText(by.actor),
      });
      return { before: current, after };
    });
    this.core.publish('returns.seller_terms.changed', { sellerId, version: after.version }, by);
    await this.core.audit(
      {
        action: 'returns.seller_terms.update',
        actionLabel: `Changed return terms (version ${after.version})`,
        target: { type: 'seller_return_terms', id: after.id, ref: `v${after.version}`, label: 'Return terms', screen: 'seller/returns-settings' },
        before: before ? { windowDays: before.window_days, freeReturns: before.free_returns, remedies: before.remedies, returnAddress: before.return_address } : null,
        after: input,
        visibleToSeller: true,
      },
      by,
    );
    return this.termsView(sellerId, after, await this.policyView(b), b);
  }

  /** sellers.seller.approved: version 1 of the seller's terms from the baseline and the application */
  async onSellerApproved(e: EventPayload<'sellers.seller.approved'>): Promise<void> {
    if (await this.repo.count('seller_terms', { seller_id: e.sellerId })) return;
    const b = await this.core.baseline();
    await this.repo.insert('seller_terms', {
      id: newId(),
      seller_id: e.sellerId,
      version: 1,
      window_days: b.windowDays,
      change_of_mind_paid_by: 'customer',
      free_returns: false,
      remedies: ['refund', 'replacement'],
      return_address: e.returnAddress,
      return_contact_email: isEmail(e.returnContact) ? e.returnContact : null,
      receiving_hours: null,
      response_target_business_days: b.sellerResponseBusinessDays,
      refund_target_days: b.refundTargetBusinessDays,
      effective_from: this.core.now(),
      superseded_at: null,
      created_by: actorText(SYSTEM),
    });
  }

  /** Who pays return shipping for a reason under these terms, and the fee deducted when the customer pays */
  payerFor(terms: EffectiveTerms, reason: string, ownerType: 'official' | 'seller', fee: common.Money): { paidBy: 'seller' | 'customer' | 'platform'; customerFee: number; originalShippingRefunded: boolean } {
    const r = responsibilityFor(terms.responsibilities, reasonGroupOf(reason));
    if (ownerType === 'official') return { paidBy: 'platform', customerFee: 0, originalShippingRefunded: r.originalShippingRefunded };
    // platform rule: customers never pay for damaged, wrong or defective items
    if (isFault(reason)) return { paidBy: r.paidBy === 'customer' ? 'seller' : r.paidBy, customerFee: 0, originalShippingRefunded: r.originalShippingRefunded };
    if (r.paidBy !== 'customer') return { paidBy: r.paidBy, customerFee: 0, originalShippingRefunded: r.originalShippingRefunded };
    return { paidBy: 'customer', customerFee: r.customerFee?.amount ?? fee.amount, originalShippingRefunded: r.originalShippingRefunded };
  }
}
