/**
 * Payout runs and payouts: the run calculated at the cutoff from the statements it issues, approval by
 * one or two Finance reviewers (access limits; "access is not financial authority"), release to the
 * payout provider, paid / failed / returned results by webhook or polling, and failed-payout recovery.
 */
import { AppError } from '../../../kernel/errors/index.js';
import { isUuid, newId } from '../../../kernel/lib/ids.js';
import type { PageRequest } from '../../../kernel/lib/pagination.js';
import { pageOf } from '../../../kernel/lib/pagination.js';
import type * as common from '../../../spec/common.js';
import type { DestinationReview, Payout, PayoutRun, PayoutWebhook, RunApproval, RunCheck, RunPayoutRow, RunStatementRow } from '../../../spec/finance.js';
import { addDays, fmt, lastSlot, marketDate, shortDate, SYSTEM } from '../domain/rules.js';
import { payoutMachine, payoutRunMachine } from '../domain/state-machines.js';
import { toPayout } from '../mappers.js';
import type { PayoutRec, ProviderResult, RunRec } from '../ports.js';
import type { Where } from '../../../kernel/mongo/index.js';
import { invalid, notFound, Outbox, Part, type By } from './core.js';

const RELEASE_ACTION = 'finance.payouts.release';

export class PayoutsPart extends Part {
  /* ---------------------------------------------------------------- views */

  async payoutViews(rows: PayoutRec[]): Promise<Payout[]> {
    const names = await this.core.sellerInfo(rows.map((r) => r.seller_id));
    const dests = await this.core.destinationStatuses(rows.map((r) => r.seller_id));
    const statements = new Map((await this.repo.getMany('statements', rows.map((r) => r.statement_id).filter((x): x is string => Boolean(x)))).map((s) => [s.id, s]));
    const retryOf = new Map((await this.repo.getMany('payouts', rows.map((r) => r.retry_of).filter((x): x is string => Boolean(x)))).map((p) => [p.id, p.ref]));
    const retried = rows.length ? await this.repo.find('payouts', { retry_of: rows.map((r) => r.id) }) : [];
    return rows.map((r) =>
      toPayout(r, {
        sellerName: names.get(r.seller_id)?.name ?? 'Seller',
        destination: dests.get(r.seller_id)!,
        statement: r.statement_id ? statements.get(r.statement_id) : null,
        retryOfRef: r.retry_of ? (retryOf.get(r.retry_of) ?? null) : null,
        retriedBy: retried.find((x) => x.retry_of === r.id)?.id ?? null,
      }),
    );
  }

  async payoutView(id: string): Promise<Payout> {
    const row = await this.repo.get('payouts', id);
    if (!row) throw notFound('Payout');
    return (await this.payoutViews([row]))[0]!;
  }

  async listPayouts(f: { status?: string | null; sellerId?: string | null; runId?: string | null }, page: PageRequest): Promise<common.Page<Payout>> {
    const where: Where<PayoutRec> = {};
    if (f.status) where.status = f.status;
    if (f.sellerId) where.seller_id = f.sellerId;
    if (f.runId) where.run_id = f.runId;
    const res = await this.repo.page('payouts', where, page, { column: 'requested_on', direction: 'desc' });
    return { ...res, items: await this.payoutViews(res.items) };
  }

  /** A seller's own payout (another seller's → 404) */
  async sellerPayout(sellerId: string, id: string): Promise<Payout> {
    const row = isUuid(id) ? await this.repo.get('payouts', id) : undefined;
    if (!row || row.seller_id !== sellerId) throw notFound('Payout');
    return (await this.payoutViews([row]))[0]!;
  }

  async runView(run: RunRec, by?: By | null): Promise<PayoutRun> {
    const rows = await this.repo.find('payouts', { run_id: run.id });
    const cur = run.currency;
    const days = await this.core.num('availableAfterDeliveryDays', 7);
    const prev = await this.repo.findOne('payout_runs', { created_at: { op: '<', value: run.created_at }, status: { op: '<>', value: 'cancelled' } }, { orderBy: [['created_at', 'desc']] });
    const prevFailed = prev ? await this.repo.find('payouts', { run_id: prev.id, status: 'failed' }) : [];
    const retries = rows.filter((r) => r.retry_of);
    const onHold = rows.filter((r) => r.status === 'on_hold');
    const reviews = rows.length ? await this.repo.find('destination_reviews', { seller_id: [...new Set(rows.map((r) => r.seller_id))], status: 'under_review' }) : [];
    const negatives = rows.length ? await this.repo.find('seller_accounts', { seller_id: [...new Set(rows.map((r) => r.seller_id))], available: { op: '<', value: 0 } }) : [];
    const checks: RunCheck[] = [];
    checks.push(onHold.length ? { level: 'info', title: `${onHold.length} payout${onHold.length === 1 ? '' : 's'} on hold`, detail: 'Holds, restrictions or payout account reviews; the money stays in the balance' } : { level: 'ok', title: 'No payouts on hold' });
    if (reviews.length) checks.push({ level: 'warn', title: `${reviews.length} payout account change${reviews.length === 1 ? '' : 's'} under review`, detail: 'These sellers keep being paid to their current verified account' });
    if (negatives.length) checks.push({ level: 'info', title: `${negatives.length} seller${negatives.length === 1 ? '' : 's'} with a negative balance`, detail: 'Refunds after payout are deducted from these payouts' });
    const unretried = prevFailed.length ? (await this.repo.find('payouts', { retry_of: prevFailed.map((p) => p.id) })).length : 0;
    if (prevFailed.length) checks.push({ level: unretried < prevFailed.length ? 'warn' : 'ok', title: `${prevFailed.length} failed payout${prevFailed.length === 1 ? '' : 's'} in the last run`, detail: `${unretried} retried` });
    // limits come from access only (decision F-D1): one approval within the approver's payout limit, a second different reviewer above it
    checks.push(run.approval_request_id ? { level: 'info', title: 'Second Finance reviewer needed', detail: "The run is above the first approver's payout limit" } : { level: 'ok', title: 'Finance approval needed', detail: "Above the approver's payout limit a second, different Finance reviewer approves" });
    const approval = run.approval_request_id
      ? ((await this.core.approvalInfo(run.approval_request_id)) ?? { required: true, approvalRequestId: run.approval_request_id, approvers: [] })
      : { required: true, reason: "Finance approval within the approver's payout limit; a second Finance reviewer above it", approvalRequestId: null, approvers: ['Finance Manager'] };
    const approvals = (Array.isArray(run.approvals) ? run.approvals : []) as unknown as RunApproval[];
    const cutoffDay = marketDate(run.cutoff_at, this.core.tz());
    return {
      id: run.id,
      ref: run.ref,
      status: run.status as PayoutRun['status'],
      scheduledRelease: run.scheduled_release.toISOString(),
      cutoffAt: run.cutoff_at.toISOString(),
      rule: `Earnings from items delivered by ${shortDate(addDays(cutoffDay, -days))} and past the ${days}-day hold`,
      total: this.money(run.total),
      payingNow: this.money(run.paying_now),
      held: this.money(run.held),
      negativeOffset: this.money(run.negative_offset),
      sellerCount: new Set(rows.map((r) => r.seller_id)).size,
      readyCount: rows.filter((r) => r.status === 'pending' || r.status === 'processing' || r.status === 'paid').length,
      heldCount: onHold.length,
      retriesIncluded: retries.length,
      retriesAmount: this.money(retries.reduce((s, r) => s + r.amount, 0)),
      failedLastRun: prevFailed.length,
      failedLastRunAmount: this.money(prevFailed.reduce((s, r) => s + r.amount, 0)),
      approvals,
      approval,
      checks,
      viewerCanApprove: by ? await this.viewerCanApprove(run, approvals, by) : false,
      createdAt: run.created_at.toISOString(),
    };
  }

  async viewerCanApprove(run: RunRec, approvals: RunApproval[], by: By): Promise<boolean> {
    if (run.status !== 'pending_approval' || by.actor.kind !== 'staff') return false;
    if (approvals.some((a) => a.status === 'approved' && a.approver?.id && a.approver.id === by.actor.id)) return false;
    if (by.can && !(await by.can('finance.payouts.approve'))) return false;
    try {
      const check = await this.ctx.use('access').check(this.core.principalOf(by), RELEASE_ACTION, { money: this.money(run.total) });
      return check.decision !== 'denied';
    } catch {
      return false;
    }
  }

  async run(id: string): Promise<RunRec> {
    const run = isUuid(id) ? await this.repo.get('payout_runs', id) : undefined;
    if (!run) throw notFound('Payout run');
    return run;
  }

  async listRuns(filter: { status?: string | null }, page: PageRequest, by?: By | null): Promise<common.Page<PayoutRun>> {
    const res = await this.repo.page('payout_runs', filter.status ? { status: filter.status as RunRec['status'] } : {}, page, { column: 'created_at', direction: 'desc' });
    return { ...res, items: await Promise.all(res.items.map((r) => this.runView(r, by))) };
  }

  async runRows(run: RunRec): Promise<RunPayoutRow[]> {
    const rows = await this.repo.find('payouts', { run_id: run.id });
    const sellers = [...new Set(rows.map((r) => r.seller_id))];
    const names = await this.core.sellerInfo(sellers);
    const dests = await this.core.destinationStatuses(sellers);
    const accounts = new Map((sellers.length ? await this.repo.find('seller_accounts', { seller_id: sellers }) : []).map((a) => [a.seller_id, a]));
    const holds = sellers.length ? await this.repo.find('holds', { seller_id: sellers, status: 'active' }) : [];
    const holdViews = await this.parts.holds.holdViews(holds.filter((h) => h.amount > 0));
    const out = rows.map((r): RunPayoutRow => {
      const acct = accounts.get(r.seller_id);
      return {
        payoutId: r.id,
        sellerId: r.seller_id,
        sellerName: names.get(r.seller_id)?.name ?? 'Seller',
        available: this.money(acct?.available ?? 0),
        holds: holdViews.filter((h) => h.sellerId === r.seller_id),
        negativeBalance: acct && acct.available < 0 ? this.money(acct.available) : null,
        destination: dests.get(r.seller_id)!,
        payout: this.money(r.amount),
        status: r.status as RunPayoutRow['status'],
        isRetry: Boolean(r.retry_of),
      };
    });
    const rank = (r: RunPayoutRow) => (r.status === 'on_hold' || r.holds.length ? 0 : r.destination.status === 'change_under_review' ? 1 : 2);
    return out.sort((a, b) => rank(a) - rank(b) || a.sellerName.localeCompare(b.sellerName));
  }

  async listRunPayouts(id: string, f: { q?: string | null; status?: string | null; filter?: string | null }, page: PageRequest): Promise<common.Page<RunPayoutRow>> {
    const run = await this.run(id);
    let rows = await this.runRows(run);
    if (f.q?.trim()) rows = rows.filter((r) => r.sellerName.toLowerCase().includes(f.q!.trim().toLowerCase()));
    if (f.status) rows = rows.filter((r) => r.status === f.status);
    const filter = f.filter?.toLowerCase();
    if (filter === 'held') rows = rows.filter((r) => r.status === 'on_hold' || r.holds.length);
    else if (filter === 'changed_destination') rows = rows.filter((r) => r.destination.status === 'change_under_review');
    else if (filter === 'negative') rows = rows.filter((r) => r.negativeBalance);
    else if (filter === 'retries') rows = rows.filter((r) => r.isRetry);
    return pageOf(rows, page);
  }

  async listRunStatements(id: string, f: { q?: string | null }, page: PageRequest): Promise<common.Page<RunStatementRow>> {
    const run = await this.run(id);
    const payouts = await this.repo.find('payouts', { run_id: run.id });
    const stIds = [...new Set(payouts.map((p) => p.statement_id).filter((x): x is string => Boolean(x)))];
    const statements = await this.repo.getMany('statements', stIds);
    const names = await this.core.sellerInfo(statements.map((s) => s.seller_id));
    let rows = statements.map((s): RunStatementRow => {
      const mine = payouts.filter((p) => p.statement_id === s.id);
      const main = mine.find((p) => !p.retry_of) ?? mine[0];
      return { statementId: s.id, statementRef: s.ref, sellerId: s.seller_id, sellerName: names.get(s.seller_id)?.name ?? 'Seller', period: { from: s.period_from, to: s.period_to }, status: s.status as RunStatementRow['status'], payoutId: main?.id ?? null, payoutRef: main?.ref ?? null, amount: this.money(mine.reduce((x, p) => x + p.amount, 0)) };
    });
    if (f.q?.trim()) {
      const q = f.q.trim().toLowerCase();
      rows = rows.filter((r) => r.sellerName.toLowerCase().includes(q) || r.statementRef.toLowerCase().includes(q));
    }
    return pageOf(rows.sort((a, b) => a.sellerName.localeCompare(b.sellerName)), page);
  }

  /** Run with seller rows, the last run's failed payouts and destination reviews (GraphQL payoutRun) */
  async runDetail(ref: string, by?: By | null): Promise<(PayoutRun & { sellers: common.Page<RunPayoutRow>; failedPayouts: Payout[]; destinationReviews: DestinationReview[] }) | null> {
    const run = isUuid(ref) ? await this.repo.get('payout_runs', ref) : await this.repo.findOne('payout_runs', { ref });
    if (!run) return null;
    const view = await this.runView(run, by);
    const rows = await this.runRows(run);
    const prev = await this.repo.findOne('payout_runs', { created_at: { op: '<', value: run.created_at }, status: { op: '<>', value: 'cancelled' } }, { orderBy: [['created_at', 'desc']] });
    const failed = prev ? await this.repo.find('payouts', { run_id: prev.id, status: 'failed' }) : [];
    const sellers = [...new Set(rows.map((r) => r.sellerId))];
    const reviews = sellers.length ? await this.repo.find('destination_reviews', { seller_id: sellers, status: 'under_review' }) : [];
    return { ...view, sellers: pageOf(rows, { mode: 'cursor', cursor: null, limit: 100 }), failedPayouts: await this.payoutViews(failed), destinationReviews: await this.parts.destinations.reviewViews(reviews) };
  }

  async nextRun(by?: By | null): Promise<PayoutRun | null> {
    const run = await this.repo.findOne('payout_runs', { status: ['draft', 'pending_approval', 'approved'] }, { orderBy: [['scheduled_release', 'asc']] });
    return run ? this.runView(run, by) : null;
  }

  /* ---------------------------------------------------------------- creating a run */

  async createRun(body: { cutoffAt: string; scheduledRelease: string }, by: By): Promise<PayoutRun> {
    const cutoff = new Date(body.cutoffAt);
    const release = new Date(body.scheduledRelease);
    const issues: { path: string; message: string }[] = [];
    if (Number.isNaN(cutoff.getTime())) issues.push({ path: 'cutoffAt', message: 'A date and time' });
    if (Number.isNaN(release.getTime()) || release.getTime() < cutoff.getTime()) issues.push({ path: 'scheduledRelease', message: 'After the cutoff' });
    if (cutoff.getTime() > this.now().getTime() + 60_000) issues.push({ path: 'cutoffAt', message: 'The cutoff has not passed yet' });
    if (issues.length) throw invalid(issues, 'The payout run is not valid');
    const existing = await this.repo.findOne('payout_runs', { cutoff_at: cutoff, status: { op: '<>', value: 'cancelled' } });
    if (existing) throw this.ctx.error('RUN_ALREADY_EXISTS', 'A payout run already exists for this cutoff', { runId: existing.id });
    await this.parts.ledger.releasePending();
    const id = newId();
    const day = marketDate(release, this.core.tz()).replace(/-/g, '').slice(2);
    let ref = `PO-RUN-${day}`;
    for (let n = 2; await this.repo.findOne('payout_runs', { ref }); n++) ref = `PO-RUN-${day}-${n}`;
    // one live run per cutoff (unique index): a concurrent create loses here instead of adding a second run
    const created = await this.repo.insertIfAbsent('payout_runs', { id, ref, status: payoutRunMachine.initial, scheduled_release: release, cutoff_at: cutoff, total: 0, paying_now: 0, held: 0, negative_offset: 0, currency: this.core.currency(), approvals: [] as never, approval_request_id: null, created_at: this.now(), released_at: null, completed_at: null });
    if (!created) {
      const other = await this.repo.findOne('payout_runs', { cutoff_at: cutoff, status: { op: '<>', value: 'cancelled' } });
      throw this.ctx.error('RUN_ALREADY_EXISTS', 'A payout run already exists for this cutoff', { runId: other?.id ?? null });
    }
    const retrySellers = (await this.repo.find('payouts', { status: 'pending', run_id: null, retry_of: { op: 'is not', value: null } })).map((p) => p.seller_id);
    const sellers = [...new Set([...(await this.repo.sellersForRun(cutoff)), ...retrySellers])];
    for (const sellerId of sellers) await this.addSeller(id, sellerId, cutoff);
    await this.refreshTotals(id);
    const run = (await this.repo.get('payout_runs', id))!;
    await this.core.audit({ action: 'finance.payout_run.create', actionLabel: 'Calculated a payout run', category: 'financial', target: { type: 'payout_run', id, ref, screen: 'admin/payouts' }, after: { cutoffAt: cutoff.toISOString(), scheduledRelease: release.toISOString(), total: run.total, sellers: sellers.length } }, by);
    return this.runView(run, by);
  }

  /** Issues the seller's statement for the period and adds its payout (and pending retries) to the run */
  async addSeller(runId: string, sellerId: string, cutoff: Date) {
    const minimum = await this.core.num('minimumPayout', 2500);
    const retries = await this.repo.find('payouts', { seller_id: sellerId, status: 'pending', run_id: null, retry_of: { op: 'is not', value: null } });
    const prepared = await this.parts.statements.prepare(sellerId, cutoff, { final: retries.length > 0 });
    if (!prepared && !retries.length) return;
    const acct = await this.repo.findOne('seller_accounts', { seller_id: sellerId });
    const block = await this.parts.ledger.payoutBlock(sellerId);
    const dest = await this.core.destinationOf(sellerId);
    const destination = dest.active ?? dest.latest;
    const unposted = (await this.repo.find('payouts', { seller_id: sellerId, status: ['pending', 'on_hold'], run_id: { op: 'is not', value: null } })).filter((p) => p.run_id !== runId).reduce((s, p) => s + p.amount, 0);
    const retrySum = retries.reduce((s, p) => s + p.amount, 0);
    const base = prepared ? prepared.opening + prepared.net : 0;
    const regular = Math.max(0, base - retrySum - unposted);
    const pays = regular > 0 && regular >= minimum && Boolean(destination);
    const out = new Outbox();
    const payoutRef = pays ? await this.ctx.refs.next('PO', { digits: 4 }) : null;
    const payoutIdOut = await this.repo.transaction(async (tx) => {
      let payoutId: string | null = null;
      const statementId = prepared ? prepared.id : null;
      if (pays) {
        payoutId = newId();
        await tx.insert('payouts', {
          id: payoutId,
          ref: payoutRef!,
          seller_id: sellerId,
          run_id: runId,
          amount: regular,
          currency: this.core.currency(),
          status: block.blocked ? this.core.step(payoutMachine, 'pending', 'hold') : 'pending',
          destination_id: destination!.id,
          requested_on: this.core.today(),
          released_at: null,
          paid_at: null,
          failed_at: null,
          failure_code: null,
          failure_reason: null,
          retry_of: null,
          provider_payout_id: null,
          bank_reference: null,
          statement_id: statementId,
          holds_withheld: Math.max(0, acct?.held ?? 0),
          negative_offset: prepared && prepared.opening < 0 ? Math.min(-prepared.opening, Math.max(0, prepared.net)) : 0,
          idempotency_key: null,
        });
        const lots = await tx.find('earnings_lots', { seller_id: sellerId, state: 'available', available_at: { op: '<=', value: cutoff } }, { forUpdate: true });
        for (const l of lots) await this.core.moveLot(tx, l, 'addToPayout', out, { payout_id: payoutId });
      }
      for (const r of retries) await tx.update('payouts', r.id, { run_id: runId, statement_id: statementId });
      if (prepared) await this.parts.statements.write(tx, prepared, { payoutId: payoutId ?? retries[0]?.id ?? null, payout: (pays ? regular : 0) + retrySum, unposted });
      return payoutId ?? retries[0]?.id ?? null;
    });
    this.core.flush(out);
    if (prepared) {
      this.core.publish('finance.statement.issued', { statementId: prepared.id, sellerId, period: prepared.period, payoutId: payoutIdOut });
      await this.parts.statements.openStatement(sellerId); // the next period's statement opens at issue
    }
  }

  async refreshTotals(runId: string) {
    const rows = await this.repo.find('payouts', { run_id: runId });
    const held = rows.reduce((s, r) => s + (r.status === 'on_hold' ? r.amount : 0), 0) + [...new Map(rows.map((r) => [r.seller_id, r.holds_withheld])).values()].reduce((s, v) => s + v, 0);
    await this.repo.update('payout_runs', runId, {
      total: rows.filter((r) => r.status !== 'cancelled').reduce((s, r) => s + r.amount, 0),
      paying_now: rows.filter((r) => ['pending', 'processing', 'paid'].includes(r.status)).reduce((s, r) => s + r.amount, 0),
      held,
      negative_offset: rows.reduce((s, r) => s + r.negative_offset, 0),
    });
  }

  async recalculate(id: string, by: By): Promise<PayoutRun> {
    const run = await this.run(id);
    this.core.step(payoutRunMachine, run.status, 'recalculate');
    for (const p of await this.repo.find('payouts', { run_id: id, status: ['pending', 'on_hold'] })) {
      const block = await this.parts.ledger.payoutBlock(p.seller_id);
      const acct = await this.repo.findOne('seller_accounts', { seller_id: p.seller_id });
      const status = block.blocked ? (p.status === 'pending' ? this.core.step(payoutMachine, p.status, 'hold') : p.status) : p.status === 'on_hold' ? this.core.step(payoutMachine, p.status, 'unhold') : p.status;
      const dest = await this.core.destinationOf(p.seller_id);
      await this.repo.update('payouts', p.id, { status, holds_withheld: Math.max(0, acct?.held ?? 0), destination_id: (dest.active ?? dest.latest)?.id ?? p.destination_id });
    }
    const retries = await this.repo.find('payouts', { status: 'pending', run_id: null, retry_of: { op: 'is not', value: null } });
    for (const r of retries) {
      const st = (await this.repo.find('payouts', { run_id: id, seller_id: r.seller_id })).find((p) => p.statement_id)?.statement_id ?? null;
      await this.repo.update('payouts', r.id, { run_id: id, statement_id: st });
    }
    await this.refreshTotals(id);
    await this.core.audit({ action: 'finance.payout_run.recalculate', actionLabel: 'Recalculated a payout run', category: 'financial', target: { type: 'payout_run', id, ref: run.ref, screen: 'admin/payouts' } }, by);
    return this.runView((await this.repo.get('payout_runs', id))!, by);
  }

  /* ---------------------------------------------------------------- approval */

  async submit(id: string, by: By): Promise<PayoutRun> {
    const run = await this.run(id);
    const status = this.core.step<RunRec['status']>(payoutRunMachine, run.status, 'submit');
    // the second reviewer slot is added when the first approver's limit (access) is below the run total
    const approvals: RunApproval[] = [{ order: 1, approver: null, role: 'Finance Manager', status: 'pending', at: null, dueAt: run.scheduled_release.toISOString(), note: null }];
    await this.repo.update('payout_runs', id, { status, approvals: approvals as never, approval_request_id: null });
    await this.core.audit({ action: 'finance.payout_run.submit', actionLabel: 'Submitted a payout run for approval', category: 'financial', target: { type: 'payout_run', id, ref: run.ref, screen: 'admin/payouts' }, after: { total: run.total } }, by);
    return this.runView((await this.repo.get('payout_runs', id))!, by);
  }

  async approve(id: string, body: { confirmedReview: boolean; note?: string | null; stepUpCode?: string | null }, by: By): Promise<PayoutRun> {
    const run = await this.run(id);
    if (run.status !== 'pending_approval') this.core.step(payoutRunMachine, run.status, 'approve');
    if (!body.confirmedReview) throw invalid([{ path: 'confirmedReview', message: 'Confirm you reviewed held, failed and changed-destination payouts' }]);
    const me = by.actor.id ?? null;
    const approvals = ((Array.isArray(run.approvals) ? run.approvals : []) as unknown as RunApproval[]).map((a) => ({ ...a }));
    if (me && approvals.some((a) => a.status === 'approved' && a.approver?.id === me)) throw this.ctx.error('SAME_APPROVER', 'The second approval must come from a different person');
    const mine = (role: string, order: number): RunApproval => ({ order, approver: by.actor, role, status: 'approved', at: this.now().toISOString(), dueAt: null, note: body.note ?? null });
    const access = this.ctx.use('access');
    const check = await this.core.authority(by, RELEASE_ACTION, run.total);

    if (run.approval_request_id) {
      // second reviewer: decided through access (limits, step-up, not the requester)
      const req = await access.getApproval(run.approval_request_id);
      if (req && me && req.requestedBy.id === me) throw this.ctx.error('SAME_APPROVER', 'You requested this approval; a different Finance reviewer approves it');
      const decided = await access.decide(run.approval_request_id, this.core.principalOf(by), { kind: 'approve', ...(body.note ? { note: body.note } : {}), ...(body.stepUpCode ? { stepUpCode: body.stepUpCode } : {}) });
      const slot = approvals.find((a) => a.status === 'pending') ?? { order: approvals.length + 1, role: 'Finance · second reviewer', status: 'pending' as const };
      Object.assign(slot, mine(slot.role, slot.order));
      if (!approvals.includes(slot as RunApproval)) approvals.push(slot as RunApproval);
      await this.repo.update('payout_runs', id, { approvals: approvals as never });
      if (decided.status === 'approved') await this.finishApproval(id, by);
      await this.core.audit({ action: 'finance.payout_run.approve', actionLabel: 'Approved a payout run (second reviewer)', category: 'financial', target: { type: 'payout_run', id, ref: run.ref, screen: 'admin/payouts' }, reason: body.note ?? null, approvalRequestId: run.approval_request_id }, by);
      return this.runView((await this.repo.get('payout_runs', id))!, by);
    }

    if (check.decision === 'allowed') {
      // within the approver's payout limit (access): one approval releases the run
      const slot = approvals.find((a) => a.status === 'pending');
      if (slot) Object.assign(slot, mine(slot.role, slot.order));
      else approvals.push(mine('Finance Manager', approvals.length + 1));
      await this.repo.update('payout_runs', id, { approvals: approvals as never });
      await this.finishApproval(id, by);
      await this.core.audit({ action: 'finance.payout_run.approve', actionLabel: 'Approved a payout run', category: 'financial', target: { type: 'payout_run', id, ref: run.ref, screen: 'admin/payouts' }, reason: body.note ?? null, approvalNote: check.reason }, by);
      return this.runView((await this.repo.get('payout_runs', id))!, by);
    }

    // above the caller's payout limit: a second, different Finance reviewer (or someone whose limit covers it) approves through access
    const req = await this.core.requestApproval(by, {
      action: RELEASE_ACTION,
      target: { type: 'payout_run', id, ref: run.ref, label: `Payout run ${run.ref}`, screen: 'admin/payouts' },
      amount: this.money(run.total),
      summary: `Payout run of ${fmt(run.total, run.currency)} (${run.ref})`,
      details: { scheduledRelease: run.scheduled_release.toISOString(), cutoffAt: run.cutoff_at.toISOString() },
      reason: body.note || 'Payout run approval',
    });
    const countsAsFirst = req.requesterCountsAsFirst;
    if (countsAsFirst) {
      const slot = approvals.find((a) => a.status === 'pending');
      if (slot) Object.assign(slot, mine(slot.role, slot.order));
      else approvals.push(mine('Finance Manager', approvals.length + 1));
      if (!approvals.some((a) => a.status === 'pending')) approvals.push({ order: approvals.length + 1, approver: null, role: 'Finance · second reviewer', status: 'pending', at: null, dueAt: run.scheduled_release.toISOString(), note: null });
    }
    await this.repo.update('payout_runs', id, { approvals: approvals as never, approval_request_id: req.id });
    if (req.status === 'approved') await this.finishApproval(id, by);
    await this.core.audit({ action: 'finance.payout_run.approve', actionLabel: countsAsFirst ? 'First approval of a payout run; second reviewer requested' : 'Requested approval of a payout run above my limit', category: 'financial', target: { type: 'payout_run', id, ref: run.ref, screen: 'admin/payouts' }, reason: body.note ?? null, approvalRequestId: req.id }, by);
    // above the caller's limit the run waits for approval and answers with it (FORMAT.md, Approval responses)
    return this.runView((await this.repo.get('payout_runs', id))!, by);
  }

  /** pending_approval → approved (idempotent; also from access.approval.decided) */
  async finishApproval(id: string, by: By) {
    const run = await this.repo.transaction(async (tx) => {
      const r = await tx.get('payout_runs', id, { forUpdate: true });
      if (!r || r.status !== 'pending_approval') return null;
      await tx.update('payout_runs', id, { status: this.core.step(payoutRunMachine, r.status, 'approve') });
      return r;
    });
    if (run) this.core.publish('finance.payout_run.approved', { runId: id, total: this.money(run.total), scheduledRelease: run.scheduled_release.toISOString() }, by);
  }

  async sendBack(id: string, reason: string, by: By): Promise<PayoutRun> {
    if (!reason?.trim()) throw invalid([{ path: 'reason', message: 'Say what needs to change' }]);
    const run = await this.run(id);
    const status = this.core.step<RunRec['status']>(payoutRunMachine, run.status, 'sendBack');
    const approvals = ((Array.isArray(run.approvals) ? run.approvals : []) as unknown as RunApproval[]).map((a) => (a.status === 'pending' ? { ...a, status: 'sent_back' as const, approver: by.actor, at: this.now().toISOString(), note: reason } : a));
    if (run.approval_request_id) await this.core.optionalDep(() => this.ctx.use('access').cancelApproval(run.approval_request_id!, by.actor, reason));
    await this.repo.update('payout_runs', id, { status, approvals: approvals as never, approval_request_id: null });
    await this.core.audit({ action: 'finance.payout_run.send_back', actionLabel: 'Sent a payout run back to draft', category: 'financial', target: { type: 'payout_run', id, ref: run.ref, screen: 'admin/payouts' }, reason }, by);
    return this.runView((await this.repo.get('payout_runs', id))!, by);
  }

  async onApprovalDecided(e: { requestId: string; target: { id: string }; outcome: string; decidedBy?: common.Actor | null; reason?: string | null }) {
    const run = isUuid(e.target.id) ? await this.repo.get('payout_runs', e.target.id) : undefined;
    if (!run || run.approval_request_id !== e.requestId || run.status !== 'pending_approval') return;
    const by: By = { actor: e.decidedBy ?? SYSTEM };
    if (e.outcome === 'approved') return this.finishApproval(run.id, by);
    if (e.outcome === 'rejected') {
      const approvals = ((Array.isArray(run.approvals) ? run.approvals : []) as unknown as RunApproval[]).map((a) => (a.status === 'pending' ? { ...a, status: 'sent_back' as const, approver: by.actor, at: this.now().toISOString(), note: e.reason ?? 'Rejected' } : a));
      await this.repo.update('payout_runs', run.id, { status: this.core.step(payoutRunMachine, run.status, 'sendBack'), approvals: approvals as never, approval_request_id: null });
      return;
    }
    await this.repo.update('payout_runs', run.id, { approval_request_id: null });
  }

  /* ---------------------------------------------------------------- release and results */

  async release(id: string, by: By): Promise<PayoutRun> {
    const run = await this.run(id);
    if (run.status === 'releasing' || run.status === 'completed') return this.runView(run, by);
    const status = this.core.step<RunRec['status']>(payoutRunMachine, run.status, 'release');
    const moved = await this.repo.transaction(async (tx) => {
      const r = await tx.get('payout_runs', id, { forUpdate: true });
      if (r?.status !== 'approved') return false;
      await tx.update('payout_runs', id, { status, released_at: this.now() });
      return true;
    });
    if (!moved) return this.runView((await this.repo.get('payout_runs', id))!, by);
    const rows = await this.repo.find('payouts', { run_id: id, status: ['pending', 'on_hold'] });
    let sent = 0;
    for (const p of rows) {
      const block = await this.parts.ledger.payoutBlock(p.seller_id);
      if (p.status === 'on_hold' || block.blocked) await this.cancelPayout(p.id, block.reasons.join('; ') || 'On hold at release');
      else if (await this.send(p.id, by)) sent++;
    }
    await this.refreshTotals(id);
    const fresh = (await this.repo.get('payout_runs', id))!;
    this.core.publish('finance.payout_run.released', { runId: id, payoutCount: sent, total: this.money(fresh.paying_now) }, by);
    await this.completeIfDone(id);
    await this.core.audit({ action: 'finance.payout_run.release', actionLabel: 'Released a payout run', category: 'financial', target: { type: 'payout_run', id, ref: run.ref, screen: 'admin/payouts' }, after: { payouts: sent, total: fresh.paying_now } }, by);
    return this.runView((await this.repo.get('payout_runs', id))!, by);
  }

  async cancelPayout(id: string, reason: string) {
    const out = new Outbox();
    await this.repo.transaction(async (tx) => {
      const p = await tx.get('payouts', id, { forUpdate: true });
      if (!p || (p.status !== 'pending' && p.status !== 'on_hold')) return;
      await tx.update('payouts', id, { status: this.core.step(payoutMachine, p.status, 'cancel'), failure_reason: reason });
      for (const l of await tx.find('earnings_lots', { payout_id: id, state: 'in_payout' }, { forUpdate: true })) await this.core.moveLot(tx, l, 'returnToAvailable', out, { payout_id: null });
    });
    this.core.flush(out);
  }

  /** pending → processing: the payout entry leaves the balance, then the provider is asked to send */
  async send(id: string, by: By): Promise<boolean> {
    const out = new Outbox();
    const current = await this.repo.get('payouts', id);
    if (!current) return false;
    const active = (await this.core.destinationOf(current.seller_id)).active;
    if (!active) return false;
    const p = await this.repo.transaction(async (tx) => {
      const row = await tx.get('payouts', id, { forUpdate: true });
      if (!row || row.status !== 'pending') return null;
      const dest = await tx.get('payout_destinations', active.id);
      if (!dest?.active || dest.status !== 'verified') return null;
      await tx.update('payouts', id, { status: this.core.step(payoutMachine, row.status, 'release'), released_at: this.now(), destination_id: dest.id });
      await this.core.post(tx, row.seller_id, [{ key: `payout:${row.id}`, type: 'payout', amount: -row.amount, bucket: 'available', ref: { kind: 'payout', id: row.id, label: row.ref }, description: `To ${dest.label}`, statementId: row.run_id ? row.statement_id : null }], out);
      return { row, providerDestinationId: dest.provider_destination_id };
    });
    this.core.flush(out, by);
    if (!p) return false;
    this.core.publish('finance.payout.processing', { payoutId: id, sellerId: p.row.seller_id, amount: { amount: p.row.amount, currency: p.row.currency } }, by);
    try {
      const sent = await this.core.provider.send({ payoutId: id, amount: { amount: p.row.amount, currency: p.row.currency }, providerDestinationId: p.providerDestinationId, reference: p.row.ref });
      await this.repo.update('payouts', id, { provider_payout_id: sent.providerPayoutId });
    } catch (err) {
      this.ctx.log.warn({ err, payoutId: id }, 'finance: payout provider did not accept the payout yet; the status poll retries');
    }
    return true;
  }

  async onWebhook(body: PayoutWebhook) {
    const p = await this.repo.findOne('payouts', { provider_payout_id: body.providerPayoutId });
    if (!p) return void this.ctx.log.info({ providerPayoutId: body.providerPayoutId }, 'finance: webhook for an unknown payout');
    await this.applyResult(p.id, { status: body.event, at: new Date(body.at), failureCode: body.failureCode ?? null, failureReason: body.failureReason ?? null, bankReference: body.bankReference ?? null });
  }

  async applyResult(id: string, r: ProviderResult) {
    if (r.status === 'processing') return;
    const out = new Outbox();
    const done = await this.repo.transaction(async (tx) => {
      const p = await tx.get('payouts', id, { forUpdate: true });
      if (!p) return null;
      const at = r.at && !Number.isNaN(r.at.getTime()) ? r.at : this.now();
      if (r.status === 'paid') {
        if (p.status !== 'processing') return null;
        await tx.update('payouts', id, { status: this.core.step(payoutMachine, p.status, 'confirmPaid'), paid_at: at, bank_reference: r.bankReference ?? p.bank_reference });
        for (const l of await tx.find('earnings_lots', { payout_id: id, state: 'in_payout' }, { forUpdate: true })) await this.core.moveLot(tx, l, 'markPaid', out);
        return { p, kind: 'paid' as const, at };
      }
      if (p.status !== 'processing' && p.status !== 'paid') return null;
      const event = p.status === 'paid' ? 'bankReturn' : 'fail';
      await tx.update('payouts', id, { status: this.core.step(payoutMachine, p.status, event), failed_at: at, failure_code: r.failureCode ?? null, failure_reason: r.failureReason ?? (r.status === 'returned' ? 'Returned by the bank' : 'Rejected by the bank') });
      await this.core.post(tx, p.seller_id, [{ key: `payout_returned:${p.id}`, type: 'payout_returned', amount: p.amount, bucket: 'available', ref: { kind: 'payout', id: p.id, label: p.ref }, description: `${p.ref} returned by the bank${r.failureCode ? ` (${r.failureCode})` : ''}: ${r.failureReason ?? 'payout failed'}. Funds kept in your balance` }], out);
      for (const l of await tx.find('earnings_lots', { payout_id: id, state: 'in_payout' }, { forUpdate: true })) await this.core.moveLot(tx, l, 'returnToAvailable', out, { payout_id: null });
      return { p, kind: 'failed' as const, at };
    });
    this.core.flush(out);
    if (!done) return;
    const { p } = done;
    if (done.kind === 'paid') this.core.publish('finance.payout.paid', { payoutId: p.id, ref: p.ref, sellerId: p.seller_id, amount: { amount: p.amount, currency: p.currency }, paidAt: done.at.toISOString() });
    else this.core.publish('finance.payout.failed', { payoutId: p.id, ref: p.ref, sellerId: p.seller_id, amount: { amount: p.amount, currency: p.currency }, failureCode: r.failureCode ?? null, failureReason: r.failureReason ?? 'The bank rejected the payout' });
    if (p.run_id) await this.completeIfDone(p.run_id);
  }

  async completeIfDone(runId: string) {
    const rows = await this.repo.find('payouts', { run_id: runId });
    if (rows.some((r) => !['paid', 'failed', 'cancelled'].includes(r.status))) return;
    await this.repo.transaction(async (tx) => {
      const r = await tx.get('payout_runs', runId, { forUpdate: true });
      if (r?.status === 'releasing') await tx.update('payout_runs', runId, { status: this.core.step(payoutRunMachine, r.status, 'complete'), completed_at: this.now() });
    });
  }

  async retry(id: string, body: { now: boolean; reason: string }, by: By): Promise<Payout> {
    const p = isUuid(id) ? await this.repo.get('payouts', id) : undefined;
    if (!p) throw notFound('Payout');
    if (p.status !== 'failed' || (await this.repo.findOne('payouts', { retry_of: id, status: { op: '<>', value: 'cancelled' } }))) throw this.ctx.error('PAYOUT_NOT_RETRYABLE', 'Only failed payouts without an open retry can be retried', { status: p.status });
    if (!body.reason?.trim()) throw invalid([{ path: 'reason', message: 'Give a reason' }]);
    const dest = await this.core.destinationOf(p.seller_id);
    if (!dest.active || (dest.active.pause_until && dest.active.pause_until > this.now())) throw this.ctx.error('DESTINATION_NOT_VERIFIED', 'The seller has no verified payout destination; the money stays in the balance');
    await this.core.authority(by, RELEASE_ACTION, p.amount);
    const newIdValue = newId();
    await this.repo.insert('payouts', {
      id: newIdValue,
      ref: await this.ctx.refs.next('PO', { digits: 4 }),
      seller_id: p.seller_id,
      run_id: null,
      amount: p.amount,
      currency: p.currency,
      status: 'pending',
      destination_id: dest.active.id,
      requested_on: this.core.today(),
      released_at: null,
      paid_at: null,
      failed_at: null,
      failure_code: null,
      failure_reason: null,
      retry_of: p.id,
      provider_payout_id: null,
      bank_reference: null,
      statement_id: null,
      holds_withheld: 0,
      negative_offset: 0,
      idempotency_key: null,
    });
    if (body.now) await this.send(newIdValue, by);
    await this.core.audit({ action: 'finance.payout.retry', actionLabel: body.now ? 'Retried a failed payout now' : 'Scheduled a retry of a failed payout in the next run', category: 'financial', target: { type: 'payout', id: p.id, ref: p.ref, sellerId: p.seller_id, screen: 'admin/payouts' }, after: { retryId: newIdValue, now: body.now }, reason: body.reason, visibleToSeller: true }, by);
    return this.payoutView(newIdValue);
  }

  /** Pending payouts of a suspended seller wait (on hold) */
  async holdPendingPayouts(sellerId: string, reason: string) {
    for (const p of await this.repo.find('payouts', { seller_id: sellerId, status: 'pending' })) await this.repo.update('payouts', p.id, { status: this.core.step(payoutMachine, p.status, 'hold'), failure_reason: reason });
  }

  /* ---------------------------------------------------------------- jobs */

  /**
   * Job finance.payout-run.create (every 15 min): checks the payoutSchedule cutoff itself. Once the latest cutoff
   * has passed and no run exists for it, issues the statements and calculates the draft run. Idempotent per
   * cutoff: any run for it (even one staff cancelled) means the job is done for that cutoff, and the unique index
   * on live runs per cutoff turns a concurrent run into RUN_ALREADY_EXISTS.
   */
  async createDue() {
    const slot = lastSlot(this.now(), String(await this.core.setting('payoutSchedule')), String(await this.core.setting('payoutReleaseTime')), this.core.tz());
    if (await this.repo.findOne('payout_runs', { cutoff_at: slot.cutoffAt })) return this.openMissingStatements(false);
    try {
      await this.createRun({ cutoffAt: slot.cutoffAt.toISOString(), scheduledRelease: slot.releaseAt.toISOString() }, { actor: SYSTEM });
    } catch (err) {
      if (!(err instanceof AppError && err.code === 'RUN_ALREADY_EXISTS')) throw err;
    }
    await this.openMissingStatements(true);
  }

  #statementsSwept = false;
  /** Seller accounts without an open statement get one: on the first run of the job in this process and after each new run */
  private async openMissingStatements(afterRun: boolean) {
    if (this.#statementsSwept && !afterRun) return;
    this.#statementsSwept = true;
    const opened = await this.parts.statements.openMissing();
    if (opened) this.ctx.log.info({ opened }, 'finance: opened statements for the current period');
  }

  /** Job finance.payout-run.release: approved runs go out at their scheduled time */
  async releaseDue() {
    for (const run of await this.repo.find('payout_runs', { status: 'approved', scheduled_release: { op: '<=', value: this.now() } })) await this.release(run.id, { actor: SYSTEM });
  }

  /** Job finance.payout-status.poll: processing payouts without a webhook result */
  async poll() {
    const rows = await this.repo.find('payouts', { status: 'processing', released_at: { op: '<=', value: new Date(this.now().getTime() - 60_000) } }, { limit: 200 });
    for (const p of rows) {
      if (!p.provider_payout_id) {
        const dest = await this.repo.get('payout_destinations', p.destination_id);
        try {
          const sent = await this.core.provider.send({ payoutId: p.id, amount: { amount: p.amount, currency: p.currency }, providerDestinationId: dest?.provider_destination_id ?? null, reference: p.ref });
          await this.repo.update('payouts', p.id, { provider_payout_id: sent.providerPayoutId });
        } catch (err) {
          this.ctx.log.warn({ err, payoutId: p.id }, 'finance: payout still not accepted by the provider');
        }
        continue;
      }
      await this.applyResult(p.id, await this.core.provider.status(p.provider_payout_id));
    }
  }

  async payoutsForSeller(sellerId: string, status: string | null | undefined, page: PageRequest): Promise<common.Page<Payout>> {
    return this.listPayouts({ sellerId, status }, page);
  }
}
