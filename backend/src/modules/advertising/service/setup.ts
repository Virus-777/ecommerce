/**
 * Placements (pages, formats, caps, rotation, dismissal, on/off) and the versioned global rules. A rules
 * change always becomes a Business Owner approval request (advertising.rules.change) and takes effect at
 * its effective time once approved.
 */
import { AppError } from '../../../kernel/errors/index.js';
import { isUuid } from '../../../kernel/lib/ids.js';
import type { EventPayload } from '../../../kernel/events/index.js';
import type { GlobalRules, GlobalRulesInput, Placement, PlacementPatch } from '../../../spec/advertising.js';
import { blockedPagesOf, DEFAULT_RULES, dismissalLabel, frequencyLabel, isPageType, OVERLAY_KEYS, rotationLabel, type RuleValues } from '../domain/rules.js';
import { encodeActor, invalid, notFound, Part, SYSTEM, type By } from './core.js';

export const RULES_ACTION = 'advertising.rules.change';
export const RULES_TARGET = 'advertising_rules';

export class SetupPart extends Part {
  /* ---------------------------------------------------------------- placements */

  async listPlacements(): Promise<Placement[]> {
    const rows = await this.core.placementRows();
    const live = await this.repo.find('campaigns', { status: 'live' });
    return rows.map((p) => this.core.placementView(p, live.filter((c) => c.placement_id === p.id).length));
  }

  async updatePlacement(id: string, patch: PlacementPatch, by: By): Promise<Placement> {
    const row = isUuid(id) ? await this.repo.get('placements', id) : undefined;
    if (!row) throw notFound('Placement');
    if (row.version !== patch.version) throw new AppError('CONFLICT', 'The placement changed since you opened it; reload and try again', { version: row.version });
    const reason = patch.reason?.trim();
    const issues: { path: string; message: string }[] = [];
    if (!reason) issues.push({ path: 'reason', message: 'Say why the rules change' });
    if (patch.enabled === true && !row.enabled && row.availability === 'later' && this.ctx.config.launchPhase < 3) {
      throw new AppError('NOT_IMPLEMENTED', `${row.name} belongs to a later phase; turn on its phase first.`, { operation: 'advertising.updatePlacement', reason: 'later_phase' });
    }
    const rules = await this.core.rules();
    if (patch.eligiblePages) {
      const bad = patch.eligiblePages.filter((p) => !isPageType(p) || rules.blockedPages.includes(p));
      if (bad.length) throw this.ctx.error('PAGE_NOT_ELIGIBLE', `Ads can't show on ${bad.join(', ')}.`, { issues: bad.map((p) => ({ path: 'eligiblePages', message: isPageType(p) ? `${p} is blocked for all ads` : `${p} is not a page type` })) });
      if (!patch.eligiblePages.length) issues.push({ path: 'eligiblePages', message: 'Choose at least one page' });
    }
    for (const [i, f] of (patch.formats ?? []).entries()) {
      if (!(f.width > 0 && f.height > 0)) issues.push({ path: `formats.${i}`, message: 'Width and height are required' });
      if (!(f.maxBytes > 0)) issues.push({ path: `formats.${i}.maxBytes`, message: 'Set the size limit' });
      if (!f.mimeTypes?.length) issues.push({ path: `formats.${i}.mimeTypes`, message: 'List the accepted file types' });
    }
    if (patch.formats && !patch.formats.length) issues.push({ path: 'formats', message: 'Keep at least one format' });
    const cap = patch.frequencyCap;
    if (cap?.perWindow && (cap.perWindow.count < 1 || cap.perWindow.days < 1 || cap.perWindow.days > 30)) issues.push({ path: 'frequencyCap.perWindow', message: 'A count of 1 or more within 1 to 30 days' });
    if (patch.dismissal?.mode === 'not_dismissible' && OVERLAY_KEYS.includes(row.key)) issues.push({ path: 'dismissal.mode', message: 'Overlays always have a visible close control' });
    if (patch.dismissal?.mode === 'days' && !(Number(patch.dismissal.days) >= 1)) issues.push({ path: 'dismissal.days', message: 'How many days a dismissal hides the campaign' });
    if (patch.maxPerPage !== undefined && patch.maxPerPage !== null && patch.maxPerPage < 1) issues.push({ path: 'maxPerPage', message: '1 or more' });
    if (patch.positions?.some((p) => !Number.isInteger(p) || p < 1)) issues.push({ path: 'positions', message: 'Positions are 1 or more' });
    if (issues.length) throw invalid(issues);

    const values = {
      ...(patch.enabled !== undefined && patch.enabled !== null ? { enabled: patch.enabled } : {}),
      ...(patch.eligiblePages ? { eligible_pages: [...new Set(patch.eligiblePages)] as never } : {}),
      ...(patch.formats ? { formats: patch.formats as never } : {}),
      ...(patch.frequencyCap !== undefined ? { frequency_cap: (patch.frequencyCap ? { ...patch.frequencyCap, label: frequencyLabel(patch.frequencyCap) } : null) as never } : {}),
      ...(patch.trigger !== undefined ? { trigger: (patch.trigger ?? null) as never } : {}),
      ...(patch.rotation ? { rotation: { ...patch.rotation, label: rotationLabel(patch.rotation) } as never } : {}),
      ...(patch.dismissal ? { dismissal: { ...patch.dismissal, label: dismissalLabel(patch.dismissal) } as never } : {}),
      ...(patch.maxPerPage !== undefined ? { max_per_page: patch.maxPerPage ?? null } : {}),
      ...(patch.positions !== undefined ? { positions: (patch.positions ?? null) as never } : {}),
    };
    const after = await this.repo.transaction(async (tx) => {
      const locked = await tx.get('placements', id, { forUpdate: true });
      if (!locked || locked.version !== patch.version) throw new AppError('CONFLICT', 'The placement changed since you opened it; reload and try again');
      return tx.update('placements', id, { ...values, version: locked.version + 1, updated_by: encodeActor(by.actor), updated_at: this.now() });
    });
    this.core.invalidate();
    this.core.publish('advertising.placement.updated', { placementKey: after.key, enabled: after.enabled, version: after.version }, by);
    await this.core.audit(
      {
        action: 'advertising.placement.update',
        actionLabel: `Changed ${row.name} rules${patch.enabled !== undefined && patch.enabled !== null && patch.enabled !== row.enabled ? (patch.enabled ? ' (turned on)' : ' (turned off)') : ''}`,
        category: 'settings',
        target: { type: 'ad_placement', id, ref: row.key, label: row.name, screen: 'admin/ad-placements' },
        reason: reason ?? null,
        before: { enabled: row.enabled, eligiblePages: row.eligible_pages, formats: row.formats, frequencyCap: row.frequency_cap, rotation: row.rotation, dismissal: row.dismissal, maxPerPage: row.max_per_page, positions: row.positions },
        after: { enabled: after.enabled, eligiblePages: after.eligible_pages, formats: after.formats, frequencyCap: after.frequency_cap, rotation: after.rotation, dismissal: after.dismissal, maxPerPage: after.max_per_page, positions: after.positions },
      },
      by,
    );
    return this.core.placementView(after, await this.parts.views.liveCount(id));
  }

  /* ---------------------------------------------------------------- global rules */

  /** Rules in force, with the approval of a pending change when there is one */
  async getRules(): Promise<GlobalRules> {
    const current = await this.core.rules();
    const pending = (await this.repo.find('global_rules', { version: { op: '>', value: current.version } }, { orderBy: [['version', 'desc']], limit: 10 })).find((r) => (r.rules as { state?: string }).state === 'pending');
    if (!pending?.approval_request_id) return current;
    const approval = await this.approvalInfo(pending.approval_request_id);
    return { ...current, approval };
  }

  private async approvalInfo(requestId: string) {
    try {
      return await this.ctx.use('access').approvalInfo(requestId);
    } catch {
      return { required: true, approvalRequestId: requestId, approvers: ['Business Owner'], reason: 'Waiting for the Business Owner' };
    }
  }

  /** Always an approval request; the new version takes effect at effectiveAt after approval */
  async proposeRules(input: GlobalRulesInput, by: By): Promise<GlobalRules> {
    const reason = input.reason?.trim();
    const issues: { path: string; message: string }[] = [];
    if (!reason) issues.push({ path: 'reason', message: 'Say why the rules change' });
    if (input.overlaysPerPageView !== undefined && input.overlaysPerPageView !== null && (input.overlaysPerPageView < 0 || input.overlaysPerPageView > 2)) issues.push({ path: 'overlaysPerPageView', message: 'At most 2 overlays per page view' });
    if (input.closeControlMinPx !== undefined && input.closeControlMinPx !== null && input.closeControlMinPx < 24) issues.push({ path: 'closeControlMinPx', message: 'The close control is at least 24 px' });
    if (input.attributionDays !== undefined && input.attributionDays !== null && (input.attributionDays < 1 || input.attributionDays > 30)) issues.push({ path: 'attributionDays', message: 'Between 1 and 30 days' });
    const badPages = (input.extraBlockedPages ?? []).filter((p) => !isPageType(p));
    if (badPages.length) issues.push({ path: 'extraBlockedPages', message: `Unknown page types: ${badPages.join(', ')}` });
    const effectiveAt = input.effectiveAt ? new Date(input.effectiveAt) : this.now();
    if (Number.isNaN(effectiveAt.getTime())) issues.push({ path: 'effectiveAt', message: 'Not a date' });
    if (issues.length) throw invalid(issues);

    const current = await this.core.rules();
    const values: RuleValues = {
      ...DEFAULT_RULES,
      blockedPages: input.extraBlockedPages ? blockedPagesOf(input.extraBlockedPages) : current.blockedPages,
      overlaysPerPageView: input.overlaysPerPageView ?? current.overlaysPerPageView,
      labelRequired: true,
      closeControlMinPx: input.closeControlMinPx ?? current.closeControlMinPx,
      removeUnavailable: current.removeUnavailable,
      sellerNamedOnPromotedOffers: current.sellerNamedOnPromotedOffers,
      dismissStopsForSession: input.dismissStopsForSession ?? current.dismissStopsForSession,
      paidSellerAdsEnabled: input.paidSellerAdsEnabled ?? current.paidSellerAdsEnabled,
      attributionDays: input.attributionDays ?? current.attributionDays,
      attributionBasis: 'click',
    };
    // always a Business Owner approval (no limit, second person always): the proposer needs only advertising.rules.manage
    const access = this.ctx.use('access');
    const principal = this.core.principalOf(by);
    const version = (await this.repo.maxRulesVersion()) + 1;
    const changes = Object.entries(values).filter(([k, v]) => JSON.stringify(v) !== JSON.stringify((current as unknown as Record<string, unknown>)[k])).map(([k]) => k);
    const req = await access.requestApproval({
      action: RULES_ACTION,
      target: { type: RULES_TARGET, id: String(version), ref: `Rules v${version}`, label: `Advertising rules version ${version}`, screen: 'admin/ad-placements' },
      summary: `Advertising rules v${version}${changes.length ? `: ${changes.join(', ')}` : ''} from ${effectiveAt.toISOString().slice(0, 10)}`,
      details: { before: current, after: values, effectiveAt: effectiveAt.toISOString() },
      reason: reason!,
      requestedBy: principal,
    });
    const row = await this.repo.insert('global_rules', { version, rules: { ...values, state: 'pending' } as never, effective_at: effectiveAt, approval_request_id: req.id, created_by: encodeActor(by.actor), created_at: this.now() });
    await this.core.audit(
      { action: 'advertising.rules.propose', actionLabel: `Proposed advertising rules v${version}`, category: 'settings', target: { type: RULES_TARGET, id: String(version), ref: `Rules v${version}`, label: 'Advertising rules', screen: 'admin/ad-placements' }, reason, before: current, after: values, approvalRequestId: req.id },
      by,
    );
    return { ...this.core.rulesOf(row), approval: await this.approvalInfo(req.id) };
  }

  /** access.approval.decided for advertising.rules.change */
  async onRulesDecided(e: EventPayload<'access.approval.decided'>, eventId?: string) {
    const version = Number(e.target.id);
    if (!Number.isInteger(version)) return;
    const state = e.outcome === 'approved' ? 'approved' : 'rejected';
    // the inbox claim (per event, else per request) and the state change commit together: a redelivered or
    // concurrent decision applies once and writes one audit entry
    const applied = await this.repo.transaction(async (tx) => {
      if (!(await tx.claim(`rules-decided:${eventId ?? e.requestId}`))) return false;
      const row = await tx.findOne('global_rules', { version });
      if (!row || row.approval_request_id !== e.requestId) return false;
      const rules = row.rules as Record<string, unknown>;
      if (rules.state !== 'pending') return false;
      await tx.updateWhere('global_rules', { version }, { rules: { ...rules, state } as never });
      return true;
    });
    if (!applied) return;
    this.core.invalidate();
    await this.core.audit(
      { action: `advertising.rules.${state === 'approved' ? 'approve' : 'reject'}`, actionLabel: state === 'approved' ? `Advertising rules v${version} approved` : `Advertising rules v${version} not approved (${e.outcome})`, category: 'settings', target: { type: RULES_TARGET, id: String(version), ref: `Rules v${version}`, label: 'Advertising rules' }, reason: e.reason ?? null, approvalRequestId: e.requestId },
      { actor: e.decidedBy ?? SYSTEM },
    );
  }
}
