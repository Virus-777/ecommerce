/**
 * Appeals against trust enforcement (customers and sellers), reviewed by someone other than the people who
 * recommended or accepted the action; plus the read-only mirror of seller restriction appeals that came from a
 * trust report (decided in sellers).
 */
import { isUuid, newId } from '../../../kernel/lib/ids.js';
import type { EventPayload } from '../../../kernel/events/index.js';
import type { PageRequest } from '../../../kernel/lib/pagination.js';
import type * as common from '../../../spec/common.js';
import type { TrustAppeal } from '../../../spec/trust.js';
import { trustAppealMachine } from '../domain/state-machines.js';
import { ACTIONS, humanize, isAction, OPEN_APPEAL, TEAM_QUEUES, isTeam } from '../domain/rules.js';
import type { AppealRec, EnforcementRec } from '../ports.js';
import type { Actions } from './actions.js';
import { actorOf, invalidField, notFound, type By, type Core } from './core.js';
import { offsetOf, pageFrom } from './reports.js';
import type { Views } from './views.js';

const text = (s: unknown) => (typeof s === 'string' ? s.trim() : '');
type Appellant = { kind: 'customer' | 'seller'; ids: string[]; id: string; name: string; actor: common.Actor; mediaOwner: { kind: 'customer' | 'seller'; id: string | null } };

export class Appeals {
  constructor(
    private readonly core: Core,
    private readonly views: Views,
    private readonly actions: Actions,
  ) {}

  async view(rows: AppealRec[]): Promise<TrustAppeal[]> {
    const staff = await this.core.staffRefs(rows.flatMap((a) => [a.reviewer_staff_id, a.original_decider_id]));
    const media = await this.core.mediaRefs(rows.flatMap((a) => a.evidence_media_ids));
    const refs = await this.actions.reportRefs(rows);
    const now = this.core.now();
    return rows.map((a) => this.views.appeal(a, { staff, media, reportRef: a.report_id ? (refs.get(a.report_id) ?? null) : null, now }));
  }

  /** The people who may not review an appeal: who recommended, routed and accepted the action */
  private async conflicted(e: EnforcementRec | undefined): Promise<Set<string>> {
    const out = new Set<string>();
    if (!e) return out;
    const recorded = actorOf(e.recorded_by);
    if (recorded.id) out.add(recorded.id);
    if (e.recommendation_id) {
      const p = await this.core.recommendationPeople(e.recommendation_id);
      if (p.drafter) out.add(p.drafter);
      if (p.router) out.add(p.router);
    }
    return out;
  }

  /** A customer or seller appeals an enforcement that affects them, before the deadline */
  async submit(body: { enforcementId: string; argument: string; evidenceIds?: string[] | null }, who: Appellant, by: By): Promise<TrustAppeal> {
    const mine = isUuid(body.enforcementId) ? (await this.actions.forParty(who.kind, who.ids)).find((e) => e.id === body.enforcementId) : undefined;
    if (!mine) throw notFound('Enforcement');
    const def = isAction(mine.action) ? ACTIONS[mine.action] : ACTIONS.other;
    if (who.kind === 'seller' && def.appeal === 'sellers') throw this.core.error('APPEAL_IN_SELLERS', 'Restrictions, suspensions and warnings on your seller account are appealed in Account health');
    if (!mine.appealable || def.appeal === null || mine.execution_state === 'reversed') throw this.core.error('NOT_APPEALABLE', mine.execution_state === 'reversed' ? 'This action was already reversed' : 'This action cannot be appealed');
    if (mine.appeal_deadline && mine.appeal_deadline.getTime() < this.core.now().getTime()) throw this.core.error('APPEAL_WINDOW_CLOSED', `The appeal deadline was ${mine.appeal_deadline.toISOString().slice(0, 10)}`);
    if (!text(body.argument)) throw invalidField('argument', 'Explain why the decision should change');
    const open = await this.core.repo.find('appeals', { enforcement_id: mine.id, state: OPEN_APPEAL });
    if (open.length) throw this.core.error('APPEAL_ALREADY_OPEN', 'An appeal for this action is already open', { appealId: open[0]!.id });
    await this.core.attach(body.evidenceIds, mine.report_id, `Appeal against ${mine.ref}`, who.mediaOwner);
    const ref = await this.core.appealRef();
    const days = await this.core.setting('appealDecisionDays', 7);
    const row = await this.core.write(mine.report_id, by, async (tx, _agg, batch) => {
      const again = await tx.find('appeals', { enforcement_id: mine.id, state: OPEN_APPEAL });
      if (again.length) throw this.core.error('APPEAL_ALREADY_OPEN', 'An appeal for this action is already open', { appealId: again[0]!.id });
      const now = this.core.now();
      const row = await tx.insert('appeals', {
        id: newId(),
        ref,
        source: 'trust',
        external_appeal_id: null,
        report_id: mine.report_id,
        enforcement_id: mine.id,
        appellant_kind: who.kind,
        appellant_id: who.id,
        appellant_name: who.name,
        decision_appealed: `${def.title} (${mine.ref})`,
        argument: body.argument.trim(),
        evidence_media_ids: [...new Set(body.evidenceIds ?? [])],
        reviewer_staff_id: null,
        original_decider_id: actorOf(mine.recorded_by).id ?? 'unknown',
        decide_by: new Date(now.getTime() + days * 86_400_000),
        state: trustAppealMachine.initial,
        decision: null,
        filed_at: now,
      });
      await this.core.timeline(tx, mine.report_id, [{ kind: 'appeal_submitted', label: `Appeal ${ref} filed against ${mine.ref}`, actor: who.actor, meta: { appealId: row.id, enforcementId: mine.id } }]);
      batch.push('trust.appeal.submitted', { appealId: row.id, enforcementId: mine.id, decideBy: row.decide_by.toISOString() });
      return row;
    });
    return (await this.view([row]))[0]!;
  }

  async listMine(kind: 'customer' | 'seller', ids: string[]): Promise<TrustAppeal[]> {
    const rows = await this.core.repo.find('appeals', { appellant_kind: kind, appellant_id: ids }, { orderBy: [['filed_at', 'desc']], limit: 200 });
    return this.view(rows);
  }

  async list(q: { state?: string; source?: string; reviewerId?: string }, page: PageRequest): Promise<common.Page<TrustAppeal>> {
    const where = {
      ...(q.state ? { state: q.state === 'active' ? OPEN_APPEAL : q.state } : {}),
      ...(q.source ? { source: q.source as 'trust' | 'sellers' } : {}),
      ...(q.reviewerId ? { reviewer_staff_id: q.reviewerId } : {}),
    };
    const [rows, total] = await Promise.all([this.core.repo.find('appeals', where, { orderBy: [['decide_by', 'asc'], ['id', 'asc']], offset: offsetOf(page), limit: page.limit }), this.core.repo.count('appeals', where)]);
    return pageFrom(await this.view(rows), total, page);
  }

  private async load(id: string): Promise<AppealRec> {
    const a = isUuid(id) ? await this.core.repo.get('appeals', id) : undefined;
    if (!a) throw notFound('Appeal');
    if (a.source === 'sellers') throw this.core.error('APPEAL_IN_SELLERS', 'This appeal is decided in sellers (Account health); trust shows it read-only');
    return a;
  }

  async assign(id: string, body: { reviewerId: string }, by: By): Promise<TrustAppeal> {
    const a = await this.load(id);
    if (!isUuid(body.reviewerId)) throw invalidField('reviewerId', 'Choose a reviewer');
    const enforcement = a.enforcement_id ? await this.core.repo.get('enforcements', a.enforcement_id) : undefined;
    const conflicted = await this.conflicted(enforcement);
    if (conflicted.has(body.reviewerId) || body.reviewerId === a.original_decider_id) throw this.core.error('SAME_REVIEWER_NOT_ALLOWED', 'The reviewer recommended or accepted the original action; choose someone else');
    const ref = await this.core.ctx.use('access').getStaffRef(body.reviewerId).catch(() => null);
    if (!ref) throw invalidField('reviewerId', 'Choose a staff member');
    const { before, after } = await this.core.write(a.report_id!, by, async (tx) => {
      const cur = (await tx.get('appeals', id, { forUpdate: true }))!;
      const state = cur.state === 'under_review' ? cur.state : trustAppealMachine.next(cur.state as 'open', 'assign');
      const after = await tx.update('appeals', id, { state, reviewer_staff_id: body.reviewerId });
      await this.core.timeline(tx, cur.report_id!, [{ kind: 'appeal_assigned', label: `Appeal ${cur.ref} assigned to ${ref.name}`, actor: by.actor, meta: { appealId: id } }]);
      return { before: cur, after };
    });
    await this.core.audit({ action: 'trust.appeal.assign', actionLabel: 'Assigned an appeal reviewer', target: this.target(after), before: { state: before.state, reviewer: before.reviewer_staff_id }, after: { state: after.state, reviewer: after.reviewer_staff_id } }, by);
    return (await this.view([after]))[0]!;
  }

  /** Uphold, overturn (reverses the enforcement) or partly overturn (the owner team applies the changes) */
  async decide(id: string, body: { outcome: 'uphold' | 'overturn' | 'partly_overturn'; explanation: string; changes?: unknown }, by: By): Promise<TrustAppeal> {
    const a = await this.load(id);
    if (!['uphold', 'overturn', 'partly_overturn'].includes(body.outcome)) throw invalidField('outcome', 'uphold, overturn or partly_overturn');
    if (!text(body.explanation)) throw invalidField('explanation', 'Explain the decision to the appellant');
    const event = body.outcome === 'partly_overturn' ? 'partlyOverturn' : body.outcome;
    trustAppealMachine.next(a.state as 'under_review', event as 'uphold');
    const enforcement = a.enforcement_id ? await this.core.repo.get('enforcements', a.enforcement_id) : undefined;
    const conflicted = await this.conflicted(enforcement);
    if (by.actor.id && (conflicted.has(by.actor.id) || by.actor.id === a.original_decider_id)) throw this.core.error('SAME_REVIEWER_NOT_ALLOWED', 'You recommended or accepted the original action; another reviewer decides the appeal');
    const { after, reversed } = await this.core.write(a.report_id!, by, async (tx, _agg, b) => {
      const cur = (await tx.get('appeals', id, { forUpdate: true }))!;
      const state = trustAppealMachine.next(cur.state as 'under_review', event as 'uphold');
      const now = this.core.now();
      const decision = { outcome: state, explanation: body.explanation.trim(), decidedBy: by.actor, decidedAt: now.toISOString(), changes: body.changes ?? null };
      const after = await tx.update('appeals', id, { state, decision });
      await this.core.timeline(tx, cur.report_id!, [{ kind: 'appeal_decided', label: `Appeal ${cur.ref} ${humanize(state).toLowerCase()}`, text: body.explanation.trim(), actor: by.actor, meta: { appealId: id, enforcementId: cur.enforcement_id } }]);
      let reversed = false;
      if (state === 'overturned' && cur.enforcement_id) {
        const e = (await tx.get('enforcements', cur.enforcement_id, { forUpdate: true }))!;
        if (e.execution_state === 'applied') {
          await this.actions.reverseNow(e.id, `Appeal ${cur.ref} overturned: ${body.explanation.trim()}`, by, tx, b);
          reversed = true;
        } else {
          await this.core.timeline(tx, cur.report_id!, [{ kind: 'appeal_reversal_pending', label: `${e.ref} is ${e.execution_state}; the owner team is asked to stop it`, meta: { enforcementId: e.id } }]);
        }
      }
      b.push('trust.appeal.decided', { appealId: id, enforcementId: cur.enforcement_id ?? '', outcome: state });
      return { after, reversed };
    });
    // overturned before it was applied, or partly overturned: the owner team applies the change
    if (enforcement && ((after.state === 'overturned' && !reversed) || after.state === 'partly_overturned')) {
      const team = isTeam(enforcement.owner_team) ? enforcement.owner_team : 'support';
      await this.core.soft('workqueues', 'raise', (w) =>
        w.raise({
          queueKey: TEAM_QUEUES[team],
          kind: 'trust_recommendation',
          title: `Apply appeal ${after.ref}: ${humanize(after.state)} (${enforcement.ref})`,
          summary: body.explanation.trim(),
          subject: { type: 'appeal', id: after.id, ref: after.ref, label: after.decision_appealed },
          priority: 'high',
          dedupeKey: `trust_appeal:${after.id}:change`,
          links: [{ label: 'Open report', screen: 'admin/trust', id: after.report_id }],
        }),
      );
    }
    await this.core.audit({ action: 'trust.appeal.decide', actionLabel: 'Decided an appeal on trust enforcement', target: this.target(after), reason: body.explanation, before: { state: a.state }, after: { state: after.state, changes: body.changes ?? null, enforcementReversed: reversed } }, by);
    return (await this.view([after]))[0]!;
  }

  target(a: AppealRec) {
    return { type: 'trust_appeal', id: a.id, ref: a.ref, label: a.decision_appealed, screen: 'admin/trust' };
  }

  /* ---------------------------------------------------------------- mirror of seller appeals */

  async onSellerAppealSubmitted(e: EventPayload<'sellers.appeal.submitted'>) {
    if (!e.trustReportId) return;
    const report = isUuid(e.trustReportId) ? await this.core.repo.get('reports', e.trustReportId) : undefined;
    if (!report) {
      this.core.ctx.log.info({ appealId: e.appealId, trustReportId: e.trustReportId }, 'trust: seller appeal names an unknown report (ignored)');
      return;
    }
    if ((await this.core.repo.find('appeals', { source: 'sellers', external_appeal_id: e.appealId })).length) return;
    const enforcement = (await this.core.repo.find('enforcements', { report_id: report.id, action: ['restrict_seller', 'suspend_seller', 'warn_seller'] }, { orderBy: [['recorded_at', 'desc']] })).find((x) => x.targets.some((t) => t.type === 'seller' && t.id === e.sellerId));
    const seller = await this.core.soft('sellers', 'getSeller', (s) => s.getSeller(e.sellerId));
    const ref = await this.core.appealRef();
    await this.core.write(report.id, { actor: { kind: 'seller', id: e.sellerId } }, async (tx) => {
      if ((await tx.find('appeals', { source: 'sellers', external_appeal_id: e.appealId })).length) return;
      await tx.insert('appeals', {
        id: newId(),
        ref,
        source: 'sellers',
        external_appeal_id: e.appealId,
        report_id: report.id,
        enforcement_id: enforcement?.id ?? null,
        appellant_kind: 'seller',
        appellant_id: e.sellerId,
        appellant_name: seller?.storeName ?? 'Seller',
        decision_appealed: `${humanize(e.subject)}${enforcement ? ` (${enforcement.ref})` : ''}${e.level > 1 ? `, appeal level ${e.level}` : ''}`,
        argument: 'Filed in sellers (Account health); the argument and evidence are in the seller appeal',
        evidence_media_ids: [],
        reviewer_staff_id: null,
        original_decider_id: enforcement ? (actorOf(enforcement.recorded_by).id ?? 'sellers') : 'sellers',
        decide_by: new Date(e.decideBy),
        state: 'open',
        decision: null,
        filed_at: this.core.now(),
      });
      await this.core.timeline(tx, report.id, [{ kind: 'seller_appeal_mirrored', label: `The seller appealed the ${humanize(e.subject).toLowerCase()} in sellers`, meta: { externalAppealId: e.appealId } }]);
    });
  }

  async onSellerAppealDecided(e: EventPayload<'sellers.appeal.decided'>) {
    const row = (await this.core.repo.find('appeals', { source: 'sellers', external_appeal_id: e.appealId }))[0];
    if (!row || row.state === e.outcome) return;
    await this.core.write(row.report_id!, { actor: { kind: 'system', id: null, name: 'Seller Manager' } }, async (tx) => {
      await tx.update('appeals', row.id, { state: e.outcome, decision: { outcome: e.outcome, explanation: 'Decided in sellers', decidedBy: { kind: 'system', id: null, name: 'Seller Manager' }, decidedAt: this.core.now().toISOString(), changes: null } });
      await this.core.timeline(tx, row.report_id!, [{ kind: 'seller_appeal_decided', label: `Seller appeal ${humanize(e.outcome).toLowerCase()} in sellers`, meta: { appealId: row.id } }]);
    });
  }

  /* ---------------------------------------------------------------- job */

  /** trust.appeal-deadlines: work items for trust appeals within a day of decideBy or past it */
  async deadlines() {
    const now = this.core.now();
    const soon = new Date(now.getTime() + 86_400_000);
    const rows = await this.core.repo.find('appeals', { source: 'trust', state: OPEN_APPEAL, decide_by: { op: '<=', value: soon } }, { orderBy: [['decide_by', 'asc']], limit: 500 });
    for (const a of rows) {
      const overdue = a.decide_by.getTime() < now.getTime();
      await this.core.soft('workqueues', 'raise', (w) =>
        w.raise({
          queueKey: 'trust.reports',
          // appeal_due belongs to sellers.appeals; trust appeals stay in trust.reports
          kind: 'trust_report',
          title: `Appeal ${a.ref} ${overdue ? 'is past its decision target' : 'is due within a day'}`,
          summary: a.decision_appealed,
          subject: { type: 'appeal', id: a.id, ref: a.ref, label: a.appellant_name },
          ...(a.appellant_kind === 'seller' ? { sellerId: a.appellant_id } : {}),
          dueAt: a.decide_by.toISOString(),
          priority: overdue ? 'high' : 'normal',
          // one item per appeal, refreshed to high priority once overdue
          dedupeKey: `trust_appeal:${a.id}`,
          links: [{ label: 'Open appeal', screen: 'admin/trust', id: a.id }],
        }),
      );
    }
  }
}
