/**
 * Fee rules: versions with effective dates, Business Owner approval (finance.fees.change), activation,
 * the fee calculator and the published fee schedule.
 */
import type { EventPayload } from '../../../kernel/events/index.js';
import { isUuid, newId } from '../../../kernel/lib/ids.js';
import type * as common from '../../../spec/common.js';
import type { EarningsPreview, FeeCalcInput, FeeCalculation, FeeRuleSet, FeeRuleSetInput, FeeRulesAdmin, FeeSchedule } from '../../../spec/finance.js';
import { calculate, encodeActor, feeBasisNote, fmt, pct, rateFor, SYSTEM } from '../domain/rules.js';
import { feeRuleSetMachine } from '../domain/state-machines.js';
import { toRuleSet } from '../mappers.js';
import type { RuleSetRec } from '../ports.js';
import { invalid, notFound, Part, type By } from './core.js';

export class FeesPart extends Part {
  async view(row: RuleSetRec): Promise<FeeRuleSet> {
    const rates = await this.repo.find('fee_category_rates', { rule_set_id: row.id });
    return toRuleSet(row, rates, await this.core.approvalInfo(row.approval_request_id));
  }

  async admin(): Promise<FeeRulesAdmin> {
    const active = await this.core.activeRule();
    const upcoming = await this.repo.find('fee_rule_sets', { status: ['draft', 'pending_approval', 'scheduled'] }, { orderBy: [['effective_from', 'asc']] });
    const history = await this.repo.find('fee_rule_sets', { status: ['superseded', 'withdrawn'] }, { orderBy: [['created_at', 'desc']], limit: 50 });
    return { active: await this.view(active), upcoming: await Promise.all(upcoming.map((r) => this.view(r))), history: await Promise.all(history.map((r) => this.view(r))) };
  }

  async propose(input: FeeRuleSetInput, by: By): Promise<FeeRuleSet> {
    const issues: { path: string; message: string }[] = [];
    const bps = (v: number, path: string) => {
      if (!Number.isInteger(v) || v < 0 || v > 10_000) issues.push({ path, message: 'A rate in basis points from 0 to 10000' });
    };
    bps(input.defaultRateBps, 'defaultRateBps');
    const seen = new Set<string>();
    input.categoryRates.forEach((c, i) => {
      bps(c.rateBps, `categoryRates.${i}.rateBps`);
      if (seen.has(c.categoryId)) issues.push({ path: `categoryRates.${i}.categoryId`, message: 'Each category once' });
      seen.add(c.categoryId);
    });
    const effectiveFrom = new Date(input.effectiveFrom);
    if (Number.isNaN(effectiveFrom.getTime())) issues.push({ path: 'effectiveFrom', message: 'A date and time' });
    if (!input.reason?.trim()) issues.push({ path: 'reason', message: 'Give a reason' });
    if (!input.agreementVersion?.trim()) issues.push({ path: 'agreementVersion', message: 'Name the seller agreement version' });
    if (issues.length) throw invalid(issues, 'The fee rules are not valid');
    await this.core.ensureRules();
    const id = newId();
    const version = `v${(await this.repo.count('fee_rule_sets', {})) + 1}`;
    const categoryNames = Object.fromEntries(input.categoryRates.map((c) => [c.categoryId, c.categoryName]));
    await this.repo.transaction(async (tx) => {
      await tx.insert('fee_rule_sets', {
        id,
        version,
        status: feeRuleSetMachine.initial,
        basis: input.basis,
        include_shipping: input.includeShipping,
        platform_discounts_reduce_fee: input.platformDiscountsReduceFee,
        default_rate_bps: input.defaultRateBps,
        treatment: { ...input.treatment, categoryNames } as never,
        agreement_version: input.agreementVersion,
        effective_from: effectiveFrom,
        reason: input.reason,
        approval_request_id: null,
        created_by: encodeActor(by.actor)!,
        created_at: this.now(),
      });
      for (const c of input.categoryRates) await tx.insert('fee_category_rates', { rule_set_id: id, category_id: c.categoryId, rate_bps: c.rateBps });
    });
    // activation always needs the Business Owner (finance.fees.change: no limit, second person always)
    const req = await this.core.requestApproval(by, {
      action: 'finance.fees.change',
      target: { type: 'fee_rule_set', id, ref: version, label: `Fee rules ${version}`, screen: 'admin/settings' },
      summary: `Fee rules ${version}: ${pct(input.defaultRateBps)} default from ${effectiveFrom.toISOString().slice(0, 10)}`,
      details: { basis: input.basis, includeShipping: input.includeShipping, platformDiscountsReduceFee: input.platformDiscountsReduceFee, defaultRateBps: input.defaultRateBps, categoryRates: input.categoryRates, treatment: input.treatment },
      reason: input.reason,
    });
    await this.repo.update('fee_rule_sets', id, { status: this.core.step(feeRuleSetMachine, 'draft', 'submit'), approval_request_id: req.id });
    this.core.publish('finance.fee_rules.proposed', { ruleSetId: id, effectiveFrom: effectiveFrom.toISOString() }, by);
    const view = await this.view((await this.repo.get('fee_rule_sets', id))!);
    await this.core.audit({ action: 'finance.fee_rules.propose', actionLabel: 'Proposed new fee rules', category: 'financial', target: { type: 'fee_rule_set', id, ref: version, label: `Fee rules ${version}`, screen: 'admin/settings' }, after: { defaultRateBps: input.defaultRateBps, basis: input.basis, effectiveFrom: input.effectiveFrom }, reason: input.reason, approvalRequestId: req.id }, by);
    return view;
  }

  async withdraw(id: string, reason: string, by: By): Promise<FeeRuleSet> {
    if (!isUuid(id)) throw notFound('Fee rule set');
    const before = await this.repo.transaction(async (tx) => {
      const row = await tx.get('fee_rule_sets', id, { forUpdate: true });
      if (!row) throw notFound('Fee rule set');
      const status = this.core.step(feeRuleSetMachine, row.status, 'withdraw');
      await tx.update('fee_rule_sets', id, { status, reason: reason ? `${row.reason ?? ''}${row.reason ? ' · ' : ''}Withdrawn: ${reason}` : row.reason });
      return row;
    });
    const view = await this.view((await this.repo.get('fee_rule_sets', id))!);
    await this.core.audit({ action: 'finance.fee_rules.withdraw', actionLabel: 'Withdrew fee rules', category: 'financial', target: { type: 'fee_rule_set', id, ref: before.version, label: `Fee rules ${before.version}`, screen: 'admin/settings' }, before: { status: before.status }, after: { status: view.status }, reason }, by);
    return view;
  }

  /** access.approval.decided for finance.fees.change */
  async onApprovalDecided(e: EventPayload<'access.approval.decided'>) {
    const row = isUuid(e.target.id) ? await this.repo.get('fee_rule_sets', e.target.id) : undefined;
    if (!row || row.status !== 'pending_approval' || row.approval_request_id !== e.requestId) return;
    const event = e.outcome === 'approved' ? 'approve' : 'reject';
    await this.repo.update('fee_rule_sets', row.id, { status: this.core.step(feeRuleSetMachine, row.status, event) });
    await this.core.audit({ action: `finance.fee_rules.${event}`, actionLabel: e.outcome === 'approved' ? 'Fee rules approved and scheduled' : `Fee rules returned to draft (${e.outcome})`, category: 'financial', target: { type: 'fee_rule_set', id: row.id, ref: row.version, label: `Fee rules ${row.version}` }, reason: e.reason ?? null, approvalRequestId: e.requestId }, { actor: e.decidedBy ?? SYSTEM });
    if (e.outcome === 'approved') await this.activateDue();
  }

  /** Job finance.fee-rules.activate: scheduled versions become active at their effective time */
  async activateDue() {
    const due = await this.repo.find('fee_rule_sets', { status: 'scheduled', effective_from: { op: '<=', value: this.now() } }, { orderBy: [['effective_from', 'asc']] });
    for (const row of due) {
      await this.repo.transaction(async (tx) => {
        const fresh = await tx.get('fee_rule_sets', row.id, { forUpdate: true });
        if (fresh?.status !== 'scheduled') return;
        for (const a of await tx.find('fee_rule_sets', { status: 'active' }, { forUpdate: true })) await tx.update('fee_rule_sets', a.id, { status: this.core.step(feeRuleSetMachine, a.status, 'supersede') });
        await tx.update('fee_rule_sets', row.id, { status: this.core.step(feeRuleSetMachine, fresh.status, 'activate') });
      });
      this.core.publish('finance.fee_rules.changed', { ruleSetId: row.id, version: row.version, effectiveFrom: (row.effective_from ?? this.now()).toISOString() });
    }
  }

  async calculate(input: FeeCalcInput, ruleSetId?: string | null): Promise<FeeCalculation> {
    const issues: { path: string; message: string }[] = [];
    for (const k of ['itemPrice', 'sellerDiscount', 'platformDiscount', 'shippingCharged'] as const) {
      const v = input[k];
      if (v && (!Number.isSafeInteger(v.amount) || v.amount < 0)) issues.push({ path: `input.${k}`, message: 'Whole minor units, zero or more' });
    }
    if (issues.length) throw invalid(issues);
    let row: RuleSetRec | undefined;
    if (ruleSetId) {
      row = isUuid(ruleSetId) ? await this.repo.get('fee_rule_sets', ruleSetId) : undefined;
      if (!row) throw notFound('Fee rule set');
    } else row = await this.core.activeRule();
    const rule = await this.core.ruleModel(row);
    return calculate(rule, { categoryId: input.categoryId ?? null, itemPrice: input.itemPrice.amount, sellerDiscount: input.sellerDiscount?.amount, platformDiscount: input.platformDiscount?.amount, shippingCharged: input.shippingCharged?.amount }, input.itemPrice.currency || this.core.currency());
  }

  async schedule(): Promise<FeeSchedule> {
    const active = await this.core.activeRule();
    const rule = await this.core.ruleModel(active);
    const scheduled = await this.repo.findOne('fee_rule_sets', { status: 'scheduled' }, { orderBy: [['effective_from', 'asc']] });
    const cur = this.core.currency();
    const examples = [calculate(rule, { itemPrice: 10_000 }, cur), calculate(rule, { itemPrice: 18_400, sellerDiscount: 0, shippingCharged: 699 }, cur)];
    for (const [categoryId] of rule.categoryRates) examples.push(calculate(rule, { categoryId, itemPrice: 10_000 }, cur));
    const fee = examples[0]!.fee.amount;
    return {
      current: await this.view(active),
      scheduled: scheduled ? await this.view(scheduled) : null,
      examples,
      illustration: `${fmt(10_000, cur)} sale with a ${pct(rule.defaultRateBps)} fee: ${fmt(fee, cur)} fee income, ${fmt(10_000 - fee, cur)} seller earnings`,
    };
  }

  async previewOfferEarnings(items: { offerId: string; sellerId: string; categoryId: string | null; price: common.Money }[]): Promise<Record<string, EarningsPreview>> {
    const out: Record<string, EarningsPreview> = {};
    if (!items.length) return out;
    const rule = await this.core.ruleModel(await this.core.activeRule());
    for (const i of items) {
      const cur = i.price.currency || this.core.currency();
      const c = calculate(rule, { categoryId: i.categoryId, itemPrice: i.price.amount }, cur);
      out[i.offerId] = {
        price: c.itemPrice,
        feeBasis: c.feeBasis,
        rateBps: c.rateBps,
        fee: c.fee,
        earnings: { amount: i.price.amount - c.fee.amount, currency: cur },
        feeBasisNote: feeBasisNote(rule, rateFor(rule, i.categoryId)),
        exampleLabel: `Example: at ${fmt(i.price.amount, cur)} you earn ${fmt(i.price.amount - c.fee.amount, cur)} after a ${fmt(c.fee.amount, cur)} fee`,
        ruleVersion: rule.version,
      };
    }
    return out;
  }
}
